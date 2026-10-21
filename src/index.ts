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
import { MINIMAX_MODELS, ROUTE, regionBaseUrl, withContextWindow } from './catalog.ts'
import type { MiniMaxModelSpec, MiniMaxRegion } from './catalog.ts'
import { registerMiniMaxStatusRoute } from './status.ts'
import type { MiniMaxStatusAuth, MiniMaxStatusContext } from './status.ts'
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
  /** 登录区域；`auto` 跟随本机登录态（`auth-state.json`）。 */
  region?: 'auto' | MiniMaxRegion
  /** 上游空闲超时（毫秒）。 */
  streamIdleTimeoutMs?: number
  /** 覆盖托管 LLM base URL；留空表示按区域默认值。 */
  baseUrl?: string
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
  region: z.union(['auto', 'cn', 'global']).default('auto').description('登录区域；auto 跟随本机登录态。'),
  streamIdleTimeoutMs: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    .description('上游空闲超时（毫秒）；超时按 TIMEOUT 失败并交由宿主重试策略处理。'),
  baseUrl: z
    .string()
    .default('')
    .description('覆盖托管 LLM base URL（形如 https://agent.minimax.cn/mavis/api/v1/llm，不要带 /v1）。'),
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
  const provider = ctx.llm.listProviders().find(entry => entry.id === ROUTE)
  if (provider !== undefined) {
    ctx.logger?.warn(
      `dsh-connect-minmax: 路由 "${ROUTE}" 已被其它 provider 注册（显示名 "${provider.name}"），`
      + '本插件跳过注册。请在插件管理器里停用冲突项后重试。',
    )
    return
  }

  const warn = (message: string): void => {
    ctx.logger?.warn(`dsh-connect-minmax: ${message}`)
  }

  const requestedRegion = config.region ?? 'auto'
  const auth = new MiniMaxAuth({ region: requestedRegion })
  const longContext = config.longContext ?? false
  const models = selectModels(config.models, warn).map(spec => withContextWindow(spec, longContext))
  const baseUrl = effectiveBaseUrl(config.baseUrl, regionBaseUrl(auth.region))

  // 常见写法错误：把 SDK 自己要拼的路径写进了 baseUrl，结果是 .../v1/v1/messages。
  if (baseUrl !== auth.baseUrl && /\/(?:v1|v1\/messages)$/.test(baseUrl)) {
    warn(`baseUrl 末尾不应包含 "/v1" 或 "/v1/messages"（SDK 会自己拼 /v1/messages），当前为 "${baseUrl}"`)
  }
  if (requestedRegion !== 'auto' && requestedRegion !== auth.region) {
    warn(`配置区域为 ${requestedRegion}，但登录态解析为 ${auth.region}；token 可能不被对端接受`)
  }

  const piProvider = createMiniMaxProvider(auth, models, { baseUrl })
  const profile: ResolvedPiAiProviderProfile = {
    provider: ROUTE,
    displayName: PROVIDER_DISPLAY_NAME,
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
  const profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map([[ROUTE, profile]])
  const options: PiAiAdapterOptions = {
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
  }

  const adapter = new MiniMaxAdapter(options, auth)
  ctx.llm.registerAdapter([ROUTE], adapter)
  ctx.logger?.info(
    `dsh-connect-minmax: 已注册 provider "${ROUTE}"（${models.length} 个模型，区域 ${auth.regionLabel}，`
    + `baseUrl ${baseUrl}）`,
  )

  // 状态路由要一个"只读凭据面"。`MiniMaxAuth.lastFailure` 是 getter，静态类型是
  // `string | undefined`（必选属性 + 含 undefined），而 `MiniMaxStatusAuth` 把它声明
  // 成 `readonly lastFailure?: string`；在 `exactOptionalPropertyTypes` 下这两者不
  // 可直接赋值，所以显式投影一份，而不是用 as 把整个对象硬转过去。
  const statusAuth: MiniMaxStatusAuth = {
    region: auth.region,
    regionLabel: auth.regionLabel,
    baseUrl: auth.baseUrl,
    inspect: signal => auth.inspect(signal),
    ...auth.lastFailure === undefined ? {} : { lastFailure: auth.lastFailure },
  }

  // 状态卡片是可选能力：等 webServer 出现再挂，不能 apply 期采样。
  ctx.inject(['webServer'], webCtx => {
    // status.ts 只声明它真正用到的 webServer 面（便于测试替身），注入回调给的
    // 是完整 Context；`webServer` 由这次注入保证存在，所以这里做一次收窄。
    registerMiniMaxStatusRoute(webCtx as unknown as MiniMaxStatusContext, {
      auth: statusAuth,
      models,
      version: PLUGIN_VERSION,
    })
  })
}
