/**
 * `dsh-connect-minmax` 宿主插件入口：把本机已登录的 MiniMax 账号注册成
 * 一个名为 `minimax` 的 LLM 路由（无 API Key 输入、无凭据回写）。
 *
 * 装配顺序（对应 docs/design.md §5）：
 *   1. 路由预检 —— 已被别的 adapter 占用时记 warn 并跳过，**不抛**：
 *      `apply()` 抛错会让整个插件激活失败，还会把真正原因埋在激活日志里；
 *   2. 构造 `MiniMaxAuth`（只读登录态）与启用模型目录；
 *   3. 构造 pi-ai provider 与 `ResolvedPiAiProviderProfile`，包成
 *      `MiniMaxAdapter` 后 `registerAdapter`（随 fiber 释放自动注销）；
 *   4. 可选的状态路由用 `ctx.inject(['webServer'], …)` 挂载 —— apply 期间
 *      `ctx.get('webServer')` 采样会静默丢掉晚挂载的服务。
 *
 * 刻意不做的事：
 *   - 不调 `registerConfigurableProviders`：`minimax` 已存在于 llm-pi-ai 的
 *     可配置目录里，再注册会撞 `DUPLICATE_DIRECTORY`；
 *   - 不写默认模型：默认模型属于宿主的 `agentDefaultModel` 配置行；
 *   - 不改 `auth` 内部状态来应用配置：baseUrl 覆盖只体现在传给 provider 的
 *     变量上，`MiniMaxAuth` 保持只读。
 *
 * @module dsh-connect-minmax
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { INERT_AUTH, MiniMaxAdapter, PROVIDER_DISPLAY_NAME, createMiniMaxProvider } from './adapter.ts'
import { MiniMaxAuth } from './auth.ts'
import {
  MINIMAX_MODELS,
  displayNameForRegion,
  regionBaseUrl,
  routeForRegion,
  withContextWindow,
} from './catalog.ts'
import type { MiniMaxModelSpec, MiniMaxRegion } from './catalog.ts'
import type { MiniMaxCredentialSource } from './auth.ts'
import { registerMiniMaxStatusRoute } from './status.ts'
import type { MiniMaxStatusAuth, MiniMaxStatusContext, MiniMaxStatusRouteDeps } from './status.ts'
import {
  accountDisplayNameOf,
  accountRouteOf,
  readAccounts,
  readAccountsSync,
  syncLiveAccount,
  writeAccounts,
} from './accounts.ts'
import { MiniMaxAccountSource } from './account-source.ts'
import { PLUGIN_VERSION } from './version.ts'

/** 插件名：同时是 Loader 条目 id 与设置命名空间。 */
export const name = 'dsh-connect-minmax'

/** 硬依赖：`apply()` 里直接用 `ctx.llm`。 */
export const inject = ['llm']

/** 空闲超时默认值；与 llm-pi-ai 路线的默认值一致。 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** 请求图片总预算（base64 之后的字节数）。 */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** 每张请求图片的像素预算。 */
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** 每张请求图片的原始字节目标。 */
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/**
 * 默认思考档位。
 *
 * 宿主未显式请求档位时，`llm-pi-ai` 会退回 `profile.reasoning`
 * （`adapter.ts:348-352` 的 `options.reasoningEffort ?? profile.reasoning`）。
 * 这里必须给一个有效档位：`MiniMax-M3.1-Flash` 是强制思考模型，落到
 * "不发 thinking / 发 disabled" 的路径会被上游 400。`medium` 在本目录的
 * 每个模型上都存在（`thinkingLevelMap` 覆盖 low/medium/high/xhigh/max）。
 */
const DEFAULT_REASONING_EFFORT = 'medium'

/** 插件配置。 */
export interface MiniMaxConfig {
  /** 启用的模型 id；留空表示目录全部。 */
  models?: string[]
  /**
   * 注册哪些区域的路由，默认两个都注册。
   *
   * 国内与国际是两套凭据（`~/.minimax/auth/prod/cn` / `.../en`），因此各注册一条
   * 供应商路由：`minimax` 与 `minimax-global`。只想要一个区域时把它缩小成 `['cn']`。
   */
  regions?: MiniMaxRegion[]
  /** 上游空闲超时（毫秒）。 */
  streamIdleTimeoutMs?: number
  /** 覆盖国内版的托管 LLM base URL；留空表示用区域默认值。 */
  baseUrl?: string
  /** 覆盖国际版的托管 LLM base URL；留空表示用区域默认值。 */
  globalBaseUrl?: string
  /**
   * 使用 1M 长上下文档（仅 `M3` / `M3.1-Flash` 支持）。
   *
   * MiniMax Code 把它做成用户在模型菜单里可选的档位，并在 1M 档标注
   * "higher_usage"；DSH 每个模型只有一个 `contextWindow`，所以这里做成插件开关。
   * 默认关：1M 档在上游按更高用量计费。
   */
  longContext?: boolean
}

/** 配置 schema：值经过 schemastery 校验/补默认后才进 `apply()`。 */
export const Config: z<MiniMaxConfig> = z.object({
  models: z.array(z.string()).default([]).description('启用的模型 id（空 = 目录全部）。'),
  regions: z
    .array(z.union(['cn', 'global']))
    .default(['cn', 'global'])
    .description('注册哪些区域：默认国内 + 国际两条路由；只填一个则只注册该区域。'),
  streamIdleTimeoutMs: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    .description('上游空闲超时（毫秒）；超时按 TIMEOUT 失败并交由宿主重试策略处理。'),
  baseUrl: z
    .string()
    .default('')
    .description('覆盖国内版托管 base URL（形如 https://agent.minimax.cn/mavis/api/v1/llm，不要带 /v1）。'),
  globalBaseUrl: z
    .string()
    .default('')
    .description('覆盖国际版托管 base URL（形如 https://agent.minimax.io/mavis/api/v1/llm，不要带 /v1）。'),
  longContext: z
    .boolean()
    .default(false)
    .description('用 1M 长上下文（M3 / M3.1-Flash）；上游按更高用量计费，默认关。'),
}) as unknown as z<MiniMaxConfig>

/**
 * 按配置挑选模型目录。
 *
 * 空配置 = 全部；未知 id 只记 warn 并忽略（插件照常注册，不因一个拼错的
 * id 整个沉默）。全部 id 都未知时退回完整目录，同样记 warn。
 *
 * @param configured - 用户配置的模型 id 列表。
 * @param warn - 诊断出口，便于单测注入。
 * @returns 启用的模型目录（顺序保持配置顺序，去重）。
 */
export function selectModels(
  configured: readonly string[] | undefined,
  warn: (message: string) => void,
): readonly MiniMaxModelSpec[] {
  const wanted: string[] = []
  for (const raw of configured ?? []) {
    const id = raw.trim()
    if (id.length > 0 && !wanted.includes(id)) wanted.push(id)
  }
  if (wanted.length === 0) return MINIMAX_MODELS

  const known = new Map<string, MiniMaxModelSpec>(MINIMAX_MODELS.map(spec => [spec.id, spec]))
  const selected: MiniMaxModelSpec[] = []
  for (const id of wanted) {
    const spec = known.get(id)
    if (spec === undefined) {
      warn(`配置里的模型 "${id}" 不在本插件目录中，已忽略（可用：${[...known.keys()].join('、')}）`)
      continue
    }
    selected.push(spec)
  }
  if (selected.length === 0) {
    warn('配置的模型全部未知，暂按目录全部注册')
    return MINIMAX_MODELS
  }
  return selected
}

/**
 * 解析实际使用的 base URL。
 *
 * 空配置回落到区域默认值；非空配置去掉结尾的斜杠（`@anthropic-ai/sdk`
 * 把 baseURL 与 `/v1/messages` 字符串拼接，多一个斜杠会拼出双斜杠）。
 *
 * @param configured - 配置里的 baseUrl。
 * @param fallback - 区域默认值。
 * @returns 可用于 pi-ai `Model.baseUrl` 的地址。
 */
export function effectiveBaseUrl(configured: string | undefined, fallback: string): string {
  const trimmed = (configured ?? '').trim().replace(/\/+$/, '')
  return trimmed.length === 0 ? fallback.replace(/\/+$/, '') : trimmed
}

/**
 * 插件激活。
 *
 * @param ctx - Cordis 上下文；`llm` 服务由 `inject` 保证就绪。
 * @param config - 已校验的插件配置。
 */
export function apply(ctx: Context, config: MiniMaxConfig): void {
  const warn = (message: string): void => {
    ctx.logger?.warn(`dsh-connect-minmax: ${message}`)
  }

  const requestedRegions = normalizeRegions(config.regions, warn)
  const longContext = config.longContext ?? false
  const models = selectModels(config.models, warn).map(spec => withContextWindow(spec, longContext))

  /** 每个区域一条路由；装配方式完全相同，只有凭据面与 baseUrl 不同。 */
  const registeredRoutes: MiniMaxStatusRouteDeps[] = []

  // 附件解析等宿主能力两个区域共用，抽出来避免为第二条路由复制一遍。
  const adapterOptions = (
    profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  ): PiAiAdapterOptions => ({
    profiles: () => profiles,
    // 凭据走 provider 的 auth.apiKey.resolve（每次请求执行），这里不接管。
    resolveApiKey: async () => undefined,
    auth: INERT_AUTH,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => {
        // dsh-llm 不依赖文件系统包，只结构化地消费这一个映射方法；插件侧照做，
        // 免得为一个可选能力把 dsh-fs 拉成硬依赖。
        const fs = ctx.get('fs') as { processPathFromHostPath(hostPath: string): string | undefined } | undefined
        return fs?.processPathFromHostPath(hostPath)
      },
      ref,
    ),
    onReplayDegrade: ({ model, reason }) => {
      warn(`模型 ${model} 的历史 replay state 不可用（${reason}），已退化为 provider-neutral 转换`)
    },
  })

  /**
   * 注册一条路由；已被占用时只 warn。
   *
   * @returns 成功时给出可用来注销的 disposer，失败给出 `undefined`。
   */
  const registerRoute = (
    route: string,
    source: MiniMaxCredentialSource,
    displayName: string,
  ): { dispose: () => void } | undefined => {
    const occupied = ctx.llm.listProviders().find(entry => entry.id === route)
    if (occupied !== undefined) {
      warn(
        `路由 "${route}" 已被其它 provider 注册（显示名 "${occupied.name}"），跳过。`
        + '请在插件管理器里停用冲突项后重试。',
      )
      return undefined
    }

    const piProvider = createMiniMaxProvider(source, models, { baseUrl: source.baseUrl, route })
    const profile: ResolvedPiAiProviderProfile = {
      provider: route,
      displayName,
      // 宿主未指定档位时的默认值，见 DEFAULT_REASONING_EFFORT 的说明。
      reasoning: DEFAULT_REASONING_EFFORT,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-minmax retryPolicy'),
      // 目录里的 maxTokens 只用于 sizing，不能当请求默认输出上限。
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
      requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
      requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
      piProvider,
    }

    // 同一个 Map 引用：PiAiAdapter 按引用判断"配置有没有换代"，每次新建 Map
    // 会让它每个请求都重建一次 pi-ai 集合（快照缓存永不命中）。
    const profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map([[route, profile]])
    const adapter = new MiniMaxAdapter(adapterOptions(profiles), source)
    const registration = ctx.llm.registerAdapter([route], adapter) as {
      replace?: (adapter: unknown) => void
      dispose?: () => void
    } | undefined
    return { dispose: () => registration?.dispose?.() }
  }

  /** 本机登录（每个区域一条），也是镜像"当前账号"的来源。 */
  const liveAuths = new Map<MiniMaxRegion, MiniMaxAuth>()

  for (const region of requestedRegions) {
    const route = routeForRegion(region)
    const auth = new MiniMaxAuth({ region })
    const configured = region === 'global' ? config.globalBaseUrl : config.baseUrl
    const baseUrl = effectiveBaseUrl(configured, regionBaseUrl(region))

    // 常见写法错误：把 SDK 自己要拼的路径写进了 baseUrl，结果是 .../v1/v1/messages。
    if (baseUrl !== auth.baseUrl && /\/(?:v1|v1\/messages)$/.test(baseUrl)) {
      warn(`baseUrl 末尾不应包含 "/v1" 或 "/v1/messages"（SDK 会自己拼 /v1/messages），当前为 "${baseUrl}"`)
    }

    // 用配置里的 baseUrl 覆盖：`MiniMaxAuth.baseUrl` 是只读的，所以包一层。
    const source: MiniMaxCredentialSource = baseUrl === auth.baseUrl ? auth : {
      region: auth.region,
      regionLabel: auth.regionLabel,
      baseUrl,
      token: signal => auth.token(signal),
      invalidate: () => auth.invalidate(),
    }

    const registration = registerRoute(route, source, displayNameForRegion(region))
    if (registration === undefined) continue

    liveAuths.set(region, auth)
    ctx.logger?.info(
      `dsh-connect-minmax: 已注册 provider "${route}"（${displayNameForRegion(region)}，`
      + `${models.length} 个模型，区域 ${auth.regionLabel}，baseUrl ${baseUrl}）`,
    )
    registeredRoutes.push({
      route,
      region,
      regionLabel: auth.regionLabel,
      baseUrl,
      auth: statusAuthOf(auth),
    })
  }

  /**
   * 账号副本 → 各自的 provider 路由。
   *
   * 只注册 `owned`（mcode 已不再持有的账号）：跟随态副本与 mcode 共用同一条
   * 刷新链，交给插件刷新会把 mcode 挤下线，所以它们只是"镜像"、不出路由。
   */
  const copyDisposers = new Map<string, () => void>()
  const registeredCopyRoutes = new Set<string>()

  const reconcileAccounts = (): void => {
    const owned = readAccountsSync().filter(account => account.owned)

    for (const [id, dispose] of [...copyDisposers]) {
      if (owned.some(account => account.id === id)) continue
      // 副本被删除或不再是 owned：撤掉它的路由，选择器里不留死项。
      dispose()
      copyDisposers.delete(id)
      registeredCopyRoutes.delete(id)
      const index = registeredRoutes.findIndex(entry => entry.accountId === id)
      if (index >= 0) registeredRoutes.splice(index, 1)
    }

    for (const account of owned) {
      if (copyDisposers.has(account.id)) continue
      const route = accountRouteOf(account)
      const source = new MiniMaxAccountSource(account.id, account.region, {
        baseUrl: effectiveBaseUrl(
          account.region === 'global' ? config.globalBaseUrl : config.baseUrl,
          regionBaseUrl(account.region),
        ),
      })
      const registration = registerRoute(route, source, accountDisplayNameOf(account))
      if (registration === undefined) continue
      copyDisposers.set(account.id, registration.dispose)
      registeredCopyRoutes.add(account.id)
      registeredRoutes.push({
        route,
        region: account.region,
        regionLabel: source.regionLabel,
        baseUrl: source.baseUrl,
        auth: accountStatusAuthOf(source),
        accountId: account.id,
      })
      ctx.logger?.info(
        `dsh-connect-minmax: 已接管账号副本 "${account.label}"（${route}，区域 ${source.regionLabel}）`,
      )
    }
  }

  /**
   * 把本机登录镜像进副本库。
   *
   * 关键规则在 `syncLiveAccount`：同一区域换了账号，旧副本才被标记成 `owned`
   * （可以接管）；同一次登录只更新凭据，不动 ownership。
   */
  const mirrorLive = async (): Promise<void> => {
    for (const [region, auth] of liveAuths) {
      const live = await auth.snapshot()
      if (live === undefined) continue
      const { accounts, changed } = syncLiveAccount(await readAccounts(), live, region)
      if (changed) await writeAccounts(accounts)
    }
  }

  reconcileAccounts()

  // 镜像 + 对账：先跑一次，之后每 60s 一次。`void` 是因为 apply 是同步的，
  // 这里不能让启动路径等网络/磁盘。
  const sync = (): void => {
    void mirrorLive()
      .then(() => { reconcileAccounts() })
      .catch((error: unknown) => { warn(`账号镜像失败：${error instanceof Error ? error.message : String(error)}`) })
  }
  sync()
  ctx.effect(() => {
    const timer = setInterval(sync, 60_000)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, 'dsh-connect-minmax: 账号副本镜像')

  if (registeredRoutes.length === 0) {
    warn('没有注册任何路由（全部被占用或全部被禁用），插件未生效。')
    return
  }

  // 状态卡片是可选能力：等 webServer 出现再挂，不能 apply 期采样。
  ctx.inject(['webServer'], webCtx => {
    // status.ts 只声明它真正用到的 webServer 面（便于测试替身），注入回调给的
    // 是完整 Context；`webServer` 由这次注入保证存在，所以这里做一次收窄。
    registerMiniMaxStatusRoute(webCtx as unknown as MiniMaxStatusContext, {
      routes: registeredRoutes,
      models,
      version: PLUGIN_VERSION,
    })
  })
}

/**
 * 账号副本的"只读凭据面"投影：把 `MiniMaxAccountSource.status()` 映射成与
 * 本机登录同构的 `MiniMaxStatusAuth`，卡片就不用区分两种来源。
 */
function accountStatusAuthOf(source: MiniMaxAccountSource): MiniMaxStatusAuth {
  return {
    region: source.region,
    regionLabel: source.regionLabel,
    baseUrl: source.baseUrl,
    inspect: async () => {
      const status = await source.status()
      if (status === undefined) {
        return { state: 'missing', source: 'none', detail: '账号副本已不存在（可能被删除）。' }
      }
      return {
        state: status.state === 'owned' ? 'ready' : 'expired',
        source: 'file',
        expiresAtMs: status.expiresAtMs,
        ...status.detail === undefined ? {} : { detail: status.detail },
      }
    },
  }
}

/**
 * 把状态路由要的"只读凭据面"从 `MiniMaxAuth` 上投影出来。
 *
 * `MiniMaxAuth.lastFailure` 是返回 `string | undefined` 的 getter，而
 * `MiniMaxStatusAuth` 在 `exactOptionalPropertyTypes` 下声明的是
 * `readonly lastFailure?: string`；两者不可直接赋值，所以逐字段投影。
 */
function statusAuthOf(auth: MiniMaxAuth): MiniMaxStatusAuth {
  return {
    region: auth.region,
    regionLabel: auth.regionLabel,
    baseUrl: auth.baseUrl,
    inspect: signal => auth.inspect(signal),
    ...auth.lastFailure === undefined ? {} : { lastFailure: auth.lastFailure },
  }
}

/**
 * 归一化 `regions` 配置。
 *
 * 空数组/未配置 = 两个区域都注册；未知取值丢 warn 并忽略；去重保持声明顺序。
 */
export function normalizeRegions(
  configured: readonly string[] | undefined,
  warn: (message: string) => void,
): readonly MiniMaxRegion[] {
  const regions: MiniMaxRegion[] = []
  for (const raw of configured ?? []) {
    if (raw !== 'cn' && raw !== 'global') {
      warn(`未知区域 "${raw}"，已忽略（可用：cn、global）`)
      continue
    }
    if (!regions.includes(raw)) regions.push(raw)
  }
  return regions.length === 0 ? ['cn', 'global'] : regions
}
