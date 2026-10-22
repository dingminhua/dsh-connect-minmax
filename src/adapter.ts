/**
 * MiniMax 的 pi-ai `Provider` 与 `PiAiAdapter` 包装。
 *
 * 为什么需要这一层：`PiAiAdapter` 只负责把 pi-ai 的事件翻成 Harness 的
 * `StreamChunk`，它不认识"本机登录凭据"这种凭据来源，也不会在 401 之后
 * 换一个 token 重试。这里补三件事：
 *
 *   1. provider 的 `auth.apiKey.resolve()` 每次请求都执行，因此现读本机
 *      登录态就是"按请求刷新"，不需要重启、也不需要重建 adapter；
 *   2. 请求前预检凭据，缺失时给 `MISSING_CREDENTIAL`，而不是让 pi-ai 的
 *      `ModelsError` 到宿主那边退化成 `UNKNOWN`；
 *   3. 终态错误映射成 Harness 的稳定 code，并在 401 且尚未输出任何 chunk
 *      时失效缓存、重取 token、重试一次（同一请求体，只此一次）。
 *
 * 鉴权形态是 `Authorization: Bearer <token>`，因此 provider auth 只返回
 * `headers`、**不设 `apiKey`**：设了 `apiKey` 会走 Anthropic SDK 的
 * `x-api-key`，MiniMax 网关会把它当成"token 不是 token"并报 401。
 *
 * @module dsh-connect-minmax/adapter
 */

import type { Api, Model, Provider, ProviderAuth, ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import {
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import type { MiniMaxCredentialSource } from './auth.ts'
import { ROUTE, displayNameForRegion, toPiModel } from './catalog.ts'
import type { MiniMaxModelSpec } from './catalog.ts'

/** 选择器里显示的分组名（国内版）；也是 `ResolvedPiAiProviderProfile.displayName` 的来源。 */
export const PROVIDER_DISPLAY_NAME = displayNameForRegion('cn')

/** 凭据来源标记，随 pi-ai 的 `AuthResult` 一起回传，便于诊断时区分租约与文件。 */
const CREDENTIAL_SOURCE = 'minimax-local-login'

/**
 * 惰性的 pi-ai auth 平面。
 *
 * pi-ai 的集合会在每个请求上询问一次 `auth`：`credentials.read()` 取持久凭据、
 * `authContext.env()/fileExists()` 做环境探测。本插件的凭据只来自 MiniMax 本机
 * 登录态（`auth.ts`），因此这里必须是一个"永远什么也没有"的平面 —— 否则 pi-ai
 * 会走它自己的 API Key / OAuth 生命周期（读写 `~/.pi-ai` 之类），既无用又越权。
 *
 * 唯一放宽的是 `delete()` 与 `list()`：空操作/空列表，避免登录流程里的清理动作抛错。
 */
export const INERT_AUTH: PiAiAdapterOptions['auth'] = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-connect-minmax: it does not own a pi-ai credential lifecycle')
    },
    async delete() {
      return undefined
    },
  },
  authContext: {
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  },
}

/** `createMiniMaxProvider` 的可选覆盖项。 */
export interface MiniMaxProviderOptions {
  /**
   * 覆盖 `auth.baseUrl`（来自插件配置）。**模型描述必须用同一个值**：
   * pi-ai 把 `baseUrl` 写进每个 `Model`，请求时用的是模型上的那个，
   * 所以 provider 与模型的 baseUrl 不一致等于配置没生效。
   */
  baseUrl?: string
  /** 这条 provider 服务的路由名（`minimax` / `minimax-global`）。 */
  route?: string
}

/**
 * 构造 MiniMax 的 pi-ai provider。
 *
 * 结构与 `@deepseek-ai/dsh-llm-pi-ai` 自建的静态 provider 同形：一个协议、
 * 一份模型表、一个 provider 级 auth 解析器。
 *
 * @param auth - 本机登录凭据来源；`token()` 在每次请求时被调用一次。
 * @param models - 启用的模型目录（与 GUI 里显示的必须同源）。
 * @param options - 可选的 baseUrl 覆盖。
 * @returns 可直接放进 `Models.setProvider()` 的 provider。
 */
export function createMiniMaxProvider(
  auth: MiniMaxCredentialSource,
  models: readonly MiniMaxModelSpec[],
  options: MiniMaxProviderOptions = {},
): Provider {
  const baseUrl = options.baseUrl ?? auth.baseUrl
  const route = options.route ?? ROUTE
  const piModels: Model<Api>[] = models.map(spec => toPiModel(spec, baseUrl, route))
  const api: ProviderStreams = anthropicMessagesApi()
  const providerAuth: ProviderAuth = {
    apiKey: {
      name: 'MiniMax 本机登录凭据',
      // 每次请求执行一次：token 轮换、过期、重新登录都在这里自然生效。
      resolve: async () => ({
        // 只给 headers：给了 apiKey 会变成 x-api-key，MiniMax 网关不认。
        auth: { headers: { authorization: `Bearer ${await auth.token()}` } },
        source: CREDENTIAL_SOURCE,
      }),
    },
  }
  return {
    id: route,
    name: displayNameForRegion(auth.region),
    baseUrl,
    auth: providerAuth,
    getModels: () => piModels,
    stream: (model, context, streamOptions) => api.stream(model, context, streamOptions),
    streamSimple: (model, context, streamOptions) => api.streamSimple(model, context, streamOptions),
  }
}

/**
 * 渲染一个错误及其 `cause` 链，用于诊断文本与错误分类。
 *
 * 只做展示与分类，**不要**解析它的结果来决定控制流 —— 控制流只认 `code`。
 *
 * @param error - 任意抛出值。
 * @returns 单行文本，最多展开 4 层 cause。
 */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const name = current.name.length > 0 && current.name !== 'Error' ? `${current.name}: ` : ''
    if (current.message.length > 0) parts.push(`${name}${current.message}`)
    current = (current as { cause?: unknown }).cause
  }
  if (parts.length === 0) parts.push(error.name)
  return parts.join(': ')
}

/** 从 SDK 错误上取 HTTP 状态码；只有落在合法区间才保留。 */
function statusOf(error: unknown): { status?: number } {
  const status = (error as { status?: unknown }).status
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return {}
  return { status }
}

/** 401 的两种走法：状态码，或 MiniMax 网关的 `{"error":"invalid access token"}` 文本。 */
const AUTH_DETAIL = /\b(?:401|403)\b|invalid[\s_-]+access[\s_-]+token|unauthorized/i

/**
 * 把 provider 错误文本映射成 Harness 的稳定 code。
 *
 * 顺序有意为之：上下文超限与配额用的都是 "exceeded" 这类词，必须先让宿主的
 * 结构化分类器（`isContextWindowExceededError` / `isQuotaExceededError`）判，
 * 再落到自己写的正则上。
 *
 * @param detail - 错误 code/type/message 拼成的文本。
 * @returns `AUTH`、`RATE_LIMIT`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED` 等稳定 code。
 */
export function classifyMessage(detail: string): string {
  if (isContextWindowExceededError(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (isQuotaExceededError(detail)) return 'QUOTA'
  // 凭据在预检之后、请求之前消失（或 pi-ai 把我们的 auth 失败包成 ModelsError）：
  // 报"凭据缺失"比笼统的 UNKNOWN 有用，且不该触发 401 重试。
  if (/MiniMaxAuthUnavailableError|本机登录凭据不可用|no usable token/i.test(detail)) return 'MISSING_CREDENTIAL'
  if (AUTH_DETAIL.test(detail)) return 'AUTH'
  if (/\b429\b|rate[\s_-]?limit/i.test(detail)) return 'RATE_LIMIT'
  if (/\b(?:400|413)\b|invalid[\s_-]+request|request[\s_-]+too[\s_-]+large/i.test(detail)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b|internal[\s_-]+server[\s_-]+error|overloaded/i.test(detail)) return 'SERVER'
  if (/timed?[\s_-]*out|timeout/i.test(detail)) return 'TIMEOUT'
  return 'UNKNOWN'
}

/** 一次请求失败后要抛给宿主的错误；已经是 `LlmError` 的原样返回。 */
function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  const detail = errorText(error)
  return new LlmError(`MiniMax 请求失败：${detail}`, classifyMessage(detail), {
    cause: error,
    ...statusOf(error),
  })
}

/** `guardStream` 只需要这两件事，因此单测可以完全脱离网络与真实凭据。 */
export interface GuardStreamContext {
  /** 预检/刷新凭据；抛错即视为凭据不可用。 */
  readonly acquire: () => Promise<unknown>
  /** 丢弃缓存，让下一次 `acquire` 重新取（401 之后使用）。 */
  readonly invalidate: () => void
  /**
   * 当前账号积分耗尽时，换到池里另一个账号。
   *
   * @returns 换成了返回 `true`（可以重试）；池里没有别的账号返回 `false`。
   */
  readonly switchAccount?: () => boolean
}

/** 预检凭据：失败时给 `MISSING_CREDENTIAL`，而不是让它退化成 UNKNOWN。 */
async function acquireCredential(guard: GuardStreamContext, signal?: AbortSignal): Promise<void> {
  try {
    await guard.acquire()
  } catch (error) {
    if (signal?.aborted === true) throw new LlmError('MiniMax 请求已取消', 'ABORTED', { cause: error })
    throw new LlmError(`MiniMax 本机登录凭据不可用：${errorText(error)}`, 'MISSING_CREDENTIAL', {
      cause: error,
    })
  }
}

/** 给 AUTH 失败补一句用户能照做的动作（MiniMax Code 重新登录），不改变 code。 */
function authFailure(error: LlmError, cause: unknown): LlmError {
  return new LlmError(
    `${error.message}。请在 MiniMax Code 中重新登录后再试：本机登录凭据已被服务端撤销或已过期。`,
    'AUTH',
    { cause, ...statusOf(cause) },
  )
}

/**
 * 把一次 provider 尝试包成"预检 + 401 重试一次 + 错误分类"的流。
 *
 * 四条不变量：
 *   - 重试只在**尚未输出任何 chunk**时发生：已经流出去的内容不能撤回；
 *   - `AUTH` 重试最多一次；`QUOTA` 在池里还有别的账号时再重试一次；
 *   - 每次重试都必须真的"换了个东西"（换凭据、换账号），否则就是无意义的忙等；
 *   - 用户取消（`signal.aborted`）优先于一切分类，永远报 `ABORTED`。
 *
 * @param run - 发起一次完整 provider 尝试；401 重试时会被再次调用。
 * @param guard - 凭据预检与失效钩子。
 * @param signal - 调用方取消信号。
 * @returns 与 `run()` 相同的事件流，只多出重试与错误归一化。
 */
export async function* guardStream(
  run: () => AsyncIterable<StreamChunk>,
  guard: GuardStreamContext,
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  await acquireCredential(guard, signal)
  let emitted = false
  let retried = false
  let switched = false
  for (;;) {
    try {
      for await (const chunk of run()) {
        emitted = true
        yield chunk
      }
      return
    } catch (error) {
      if (signal?.aborted === true) throw new LlmError('MiniMax 请求已取消', 'ABORTED', { cause: error })
      const failure = toLlmError(error)
      if (failure.code === 'AUTH') {
        if (!retried && !emitted) {
          retried = true
          guard.invalidate()
          await acquireCredential(guard, signal)
          continue
        }
        throw authFailure(failure, error)
      }
      // 积分耗尽：池里有别的账号就换一个重试。用户要的正是这个——一个号的积分
      // 用完了，请求不该直接失败，而应该接着用另一个号。只在未输出任何 chunk 时
      // 重试（已经流出去的内容撤不回来），且只换一次，避免多账号互相失败时空转。
      if (failure.code === 'QUOTA' && !switched && !emitted && guard.switchAccount?.() === true) {
        switched = true
        await acquireCredential(guard, signal)
        continue
      }
      throw failure
    }
  }
}

/**
 * `PiAiAdapter` 的 MiniMax 包装。
 *
 * **`prepareCall` 与 `stream` 都要覆盖**：`PiAiAdapter.prepareCall()` 捕获的是
 * 它自己的私有 `streamWithSnapshot()`，宿主 agent loop 走的是 `prepareCall`
 * 返回的那条流，只覆盖 `stream()` 会让预检与 401 重试在真正的请求路径上失效。
 */
export class MiniMaxAdapter extends PiAiAdapter {
  constructor(
    options: PiAiAdapterOptions,
    private readonly auth: MiniMaxCredentialSource,
  ) {
    super(options)
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const call = await super.prepareCall(provider, model, signal)
    return {
      model: call.model,
      // 重试要拿到"新的一次尝试"，所以传工厂而不是已创建的流。
      stream: (options: GenerateOptions) =>
        guardStream(() => call.stream(options), this.guard(), options.signal),
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return guardStream(() => super.stream(options), this.guard(), options.signal)
  }

  /** 每次调用现建：`super.stream()` 每次都会取自己的快照，重试即新快照。 */
  private guard(): GuardStreamContext {
    return {
      acquire: () => this.auth.token(),
      invalidate: () => {
        this.auth.invalidate()
      },
    }
  }
}
