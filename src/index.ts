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
  contextWindowOptionsOf,
  displayNameForRegion,
  effortsOf,
  thinkingOffOf,
  regionBaseUrl,
  routeForRegion,
  withContextWindow,
  withModelContextWindow,
  withModelImages,
  withModelThinkingOff,
} from './catalog.ts'
import type { MiniMaxModelSpec, MiniMaxRegion } from './catalog.ts'
import type { MiniMaxCredentialSource } from './auth.ts'
import { invalidateAccountCache, registerMiniMaxStatusRoute } from './status.ts'
import { LiveRenewal } from './renewal.ts'
import { DeviceLoginManager } from './device-login.ts'
import { looksLikeOurNamespace, unwrapVolatileDeep } from './status-paths.ts'
import type { MiniMaxStatusAuth, MiniMaxStatusContext, MiniMaxStatusRouteDeps } from './status.ts'
import {
  accountIdOf,
  accountDisplayNameOf,
  accountRouteOf,
  buildTransferFile,
  importTransferFile,
  readAccounts,
  readAccountsSync,
  readActiveSelections,
  writeActiveSelection,
  syncLiveAccount,
  writeAccounts,
} from './accounts.ts'
import type { MiniMaxStoredAccount } from './accounts.ts'
import { MiniMaxAccountSource } from './account-source.ts'
import { MiniMaxAccountPool, type PoolAccount } from './pool.ts'
import { registerMiniMaxActionRoutes } from './actions.ts'
import type { MiniMaxActionContext, MiniMaxModelTestResult } from './actions.ts'
import { PLUGIN_VERSION } from './version.ts'

/** 池里"本机登录"那一项的 id；副本用各自的 account id，不会撞。 */
const LIVE_ACCOUNT_ID = 'live'

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
 * 宿主未显式请求档位时，`llm-pi-ai` 会退回 `profile.reasoning`
 * （`adapter.ts` 的 `options.reasoningEffort ?? profile.reasoning`），所以这里
 * 必须给一个**每个模型都有效**的档位：`medium` 在本目录每个模型的
 * `thinkingLevelMap` 里都存在。
 */
/**
 * 可配的默认思考档位取值。
 *
 * **不含 `off`**：`MiniMax-M3.1-Flash` 是强制思考模型，把 `off` 设成 provider 级
 * 默认值会让宿主在选中它时直接失败。
 */
export const MINIMAX_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 上面那个联合的类型。 */
export type MiniMaxReasoningEffort = typeof MINIMAX_REASONING_EFFORTS[number]

/** 配置缺省时使用的档位。 */
export const DEFAULT_REASONING_EFFORT: MiniMaxReasoningEffort = 'medium'

/**
 * 把配置里的思考档位收成有效值。
 *
 * 非法取值退回默认档并 warn：provider 拿到一个上游不认的档位，比配置写错一行
 * 难查得多——症状是"选了某个模型就报错"，而不是"你的配置有问题"。
 */
export function resolveReasoningEffort(
  configured: string | undefined,
  warn: (message: string) => void,
): MiniMaxReasoningEffort {
  if (configured === undefined || configured === '') return DEFAULT_REASONING_EFFORT
  if ((MINIMAX_REASONING_EFFORTS as readonly string[]).includes(configured)) {
    return configured as MiniMaxReasoningEffort
  }
  warn(
    `思考档位 "${configured}" 无效（可用：${MINIMAX_REASONING_EFFORTS.join(' / ')}），`
    + `已用 ${DEFAULT_REASONING_EFFORT}。`,
  )
  return DEFAULT_REASONING_EFFORT
}

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
  modelContextWindows?: Record<string, number>
  modelImages?: Record<string, boolean>
  modelThinkingOff?: Record<string, boolean>
  poolDisabled?: string[]
  selfRenewal?: boolean
  reasoningEffort?: string
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
  modelContextWindows: z
    .dict(z.number().step(1).min(1))
    .default({})
    .description('逐模型上下文档位（id → 窗口）；只接受该模型确实提供的档位，其余忽略。'),
  reasoningEffort: z
    .union(MINIMAX_REASONING_EFFORTS.map(level => z.const(level)))
    .default('medium')
    .description('宿主未指定档位时的默认思考强度（provider 级：pi-ai 没有"每模型默认档"这个概念）。'),
  selfRenewal: z
    .boolean()
    .default(true)
    .description('MiniMax Code 关闭时由插件自续活凭据（按官方客户端的锁/代际协议写回 ~/.minimax）；关闭则本机登录号依赖 MiniMax Code 在线续期。'),
  poolDisabled: z
    .array(z.string())
    .default([])
    .description('不参与自动换号/批量签到/批量测试的账号 id；默认全部参与。'),
  modelThinkingOff: z
    .dict(z.boolean())
    .default({})
    .description('逐模型"是否提供关闭思考档"（id → 布尔）；只能关掉模型自己声明可关的，开启强制思考的模型会被忽略。'),
  modelImages: z
    .dict(z.boolean())
    .default({})
    .description('逐模型图片输入开关（id → 是否发图）；只允许关掉上游支持的模型，开启一个上游不支持的会被忽略。'),
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
/**
 * 一条主路由的凭据源：**池优先，池空回落到本机登录**。
 *
 * 池只含副本（`owned: true`）；一个副本都没有时，这条路由用的就是本机登录的
 * 活凭据——由 renewal 模块自续，所以"不开 MiniMax Code 也能用"对单账号用户
 * 同样成立，不需要先有副本。池非空时完全交给池：换号、排空、顺序都在池里。
 */
export function createRouteSource(
  pool: MiniMaxAccountPool,
  live: MiniMaxCredentialSource,
  region: MiniMaxRegion,
  regionLabel: string,
  baseUrl: string,
): MiniMaxCredentialSource & { switchAway?(nowMs?: number): boolean } {
  return {
    region,
    regionLabel,
    baseUrl,
    token: signal => pool.list().length === 0 ? live.token(signal) : pool.token(signal),
    invalidate: () => {
      pool.invalidate()
      live.invalidate()
    },
    switchAway: (nowMs?: number) => pool.switchAway(nowMs),
  }
}

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
 * 把一个目录项投影成"用户设置下真正生效"的那一份。
 *
 * 两层：先按全局 `longContext` 决定默认档，再按 `modelContextWindows` 覆盖单个模型。
 * 覆盖只接受该模型**确实提供**的档位——给 M2.7 写 1M 会被忽略并 warn，而不是把窗口
 * 报成一个上游根本不受理的值（那会让宿主按错误的窗口做上下文压缩，直到请求被拒才发现）。
 */
export function projectModel(
  spec: MiniMaxModelSpec,
  longContext: boolean,
  contextOverrides: Record<string, number | undefined> | undefined,
  imageOverrides: Record<string, boolean | undefined> | undefined,
  thinkingOffOverrides: Record<string, boolean | undefined> | undefined,
  warn: (message: string) => void,
): MiniMaxModelSpec {
  // `upstreamInput` 永远是掩码前的原值：卡片要靠它区分"上游不支持"与"用户关掉了"。
  const base: MiniMaxModelSpec = {
    ...withContextWindow(spec, longContext),
    upstreamInput: [...spec.input],
  }

  // 先定上下文档位。
  let result = base
  const requestedWindow = contextOverrides?.[spec.id]
  if (requestedWindow !== undefined) {
    const options = contextWindowOptionsOf(spec)
    if (options.includes(requestedWindow)) {
      result = withModelContextWindow(spec, requestedWindow, base)
    } else {
      warn(`模型 "${spec.id}" 的上下文被设成 ${requestedWindow}，但它只提供 ${options.join(' / ')}，已忽略。`)
    }
  }

  // 再定图片输入：开启一个上游不支持的模态会被忽略并 warn（见 withModelImages）。
  const wantsImages = imageOverrides?.[spec.id]
  if (wantsImages === true && !spec.input.includes('image')) {
    warn(`模型 "${spec.id}" 上游不支持图片输入，开启已被忽略。`)
  }

  // 「可关闭思考」同样只能关不能开：给强制思考的模型加 off 档会让上游 400。
  const allowOff = thinkingOffOverrides?.[spec.id]
  if (allowOff === true && !thinkingOffOf(spec)) {
    warn(`模型 "${spec.id}" 强制思考，无法提供"关闭思考"档，开启已被忽略。`)
  }
  const withOff = withModelThinkingOff(spec, allowOff, withModelImages(spec, wantsImages, result))
  return {
    ...withOff,
    thinkingOff: thinkingOffOf(withOff),
    efforts: effortsOf(withOff),
  }
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
  /**
   * 默认思考档位。
   *
   * 必须是本目录里**每个模型都有**的档位：`MiniMax-M3.1-Flash` 强制思考，拿到
   * 一个它没有的档位会让宿主在选它时直接失败，所以 `off` 不在可选项里。
   * 非法取值退回默认档并 warn——provider 拿到一个无效值比配置写错更难查。
   */
  const reasoningEffort = resolveReasoningEffort(config.reasoningEffort, warn)
  const models = selectModels(config.models, warn).map(spec => projectModel(spec, longContext, config.modelContextWindows, config.modelImages, config.modelThinkingOff, warn))

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

  /** 取（或建）某个副本的凭据来源；同一账号永远共用一个实例。 */
  const accountSourceOf = (account: { id: string, region: MiniMaxRegion }): MiniMaxAccountSource => {
    const cached = accountSources.get(account.id)
    if (cached !== undefined) return cached
    const created = new MiniMaxAccountSource(account.id, account.region, {
      baseUrl: effectiveBaseUrl(
        account.region === 'global' ? config.globalBaseUrl : config.baseUrl,
        regionBaseUrl(account.region),
      ),
    })
    accountSources.set(account.id, created)
    return created
  }

  /**
   * 把"当前已接管的副本"同步进各区域的账号池。
   *
   * **池里只有副本**（用户定下的语义）：本机登录的活凭据归 mcode 续期，不进池、
   * 不参与轮换排序；它由 `routeSource` 在池空时兜底（见下）。顺序就是优先级：
   * 存储顺序 = 用户的手动顺序，自动换号按顺序取第一个可用的。
   */
  const refreshPools = (): void => {
    const accounts = readAccountsSync()
    for (const [region, pool] of regionPools) {
      const copies: PoolAccount[] = accounts
        .filter(account => account.owned && account.region === region)
        .map(account => ({
          id: account.id,
          label: accountDisplayNameOf(account),
          live: false,
          source: accountSourceOf(account),
          route: accountRouteOf(account),
        }))
      pool.setAccounts(copies)
      pool.setDisabled(config.poolDisabled ?? [])
      if (!restoredRegions.has(region)) {
        restoredRegions.add(region)
        const remembered = readActiveSelections()[region]
        // 记住的账号可能已被删除：`select()` 自己会拒绝，不用先判断。
        if (remembered !== undefined) pool.select(remembered)
      }
    }
  }

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
      reasoning: reasoningEffort,
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
    // 卡片的 /model/test 要用它打真实通路；没有这张表，测试动作只能报"未知路由"。
    adaptersByRoute.set(route, adapter)
    const registration = ctx.llm.registerAdapter([route], adapter) as {
      replace?: (adapter: unknown) => void
      dispose?: () => void
    } | undefined
    return { dispose: () => registration?.dispose?.() }
  }

  /** 本机登录（每个区域一条），也是镜像"当前账号"的来源。 */
  const liveAuths = new Map<MiniMaxRegion, MiniMaxAuth>()
  const renewals = new Map<MiniMaxRegion, LiveRenewal>()
  // 设备码登录：插件自己得到一个账号（凭据从出生起只归插件）。
  const deviceLogins = new DeviceLoginManager(async (region, credential) => {
    const accounts = await readAccounts()
    const id = accountIdOf(region, credential.loginEpoch)
    if (accounts.some(account => account.id === id)) return id
    await writeAccounts([...accounts, {
      id,
      region,
      label: `设备码登录 ${new Date().toLocaleDateString()}`,
      loginEpoch: credential.loginEpoch,
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAtMs: credential.expiresAtMs,
      // 设备码登录的凭据只归插件：刷新链从出生起就是插件的。
      owned: true,
      createdAtMs: Date.now(),
    }])
    reconcileAccounts()
    return id
  })
  /** 每个区域的账号池；区域路由的凭据面就是它。 */
  const regionPools = new Map<MiniMaxRegion, MiniMaxAccountPool>()
  /** 每个区域的本机登录候选（池里的第一个）。 */
  /**
   * 已经恢复过"上次选中的账号"的区域。
   *
   * 只能在副本真正装进池之后恢复一次：建池那一刻池里只有本机登录，
   * `select()` 会因为 id 不存在被拒。而"每次都恢复"又会跟运行时的自动换号
   * 打架——自动切换不写存储，下一次重算账号列表就会把用户/系统刚切过去的
   * 账号又拨回去。
   */
  const restoredRegions = new Set<MiniMaxRegion>()
  /**
   * 副本凭据来源按账号 id 缓存。
   *
   * 必须共用同一个实例：同一个账号若被"副本路由"和"区域池"各持一份 source，
   * 两边会并发用同一条一次性 refresh token 去刷新，后刷的那边必然 `invalid_grant`。
   */
  const accountSources = new Map<string, MiniMaxAccountSource>()
  /** 每条路由的适配器；`/model/test` 要用它打真实通路，而不是另造一条请求。 */
  const adaptersByRoute = new Map<string, MiniMaxAdapter>()

  for (const region of requestedRegions) {
    const route = routeForRegion(region)
    const auth = new MiniMaxAuth({ region })
    // 活凭据自续期：mcode 关着时由插件按官方协议续。每区域一个调度器。
    const renewal = new LiveRenewal(auth.authJsonPath, config.selfRenewal !== false)
    renewals.set(region, renewal)
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

    // 池只含副本；本机登录的活凭据不进池，由下面的 routeSource 在池空时兜底。
    const pool = new MiniMaxAccountPool(region, { regionLabel: auth.regionLabel, baseUrl })
    regionPools.set(region, pool)

    // 路由的凭据源：池优先，池空回落到本机登录（工厂导出以便单测）。
    const routeSource = createRouteSource(pool, source, auth.region, auth.regionLabel, baseUrl)

    const registration = registerRoute(route, routeSource, displayNameForRegion(region))
    if (registration === undefined) continue

    liveAuths.set(region, auth)
    renewal.start()
    // 巡检随插件 fiber 拆除：插件停转后不许再有后台定时器碰用户的凭据文件。
    ctx.effect(() => () => { renewal.stop() }, `dsh-connect-minmax: renewal patrol (${region})`)
    ctx.effect(() => () => { deviceLogins.stopAll() }, 'dsh-connect-minmax: device login timers')
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
      // 积分/签到走同一个 Bearer；池空时读的是本机登录的账，否则是当前生效副本的账。
      accountToken: signal => routeSource.token(signal),
      pool: () => pool.describe(),
      renewal: () => renewal.status(),
      // 只报本区域的会话：cn 页不该看见 global 的 user_code。
      deviceSessions: () => deviceLogins.list().filter(session => session.region === region),
      // 余额回灌：读到就把"当前账号还有没有钱"告诉池，下一次选号立刻用上。
      reportCredits: (totalRemaining) => {
        const active = pool.active
        if (active !== undefined) pool.reportBalance(active, totalRemaining)
      },
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
      const source = accountSourceOf(account)
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
        accountToken: signal => source.token(signal),
      })
      ctx.logger?.info(
        `dsh-connect-minmax: 已接管账号副本 "${account.label}"（${route}，区域 ${source.regionLabel}）`,
      )
    }

    // 路由表变了，池里的候选也要跟着变；否则"接管了却永远不会被自动切到"。
    refreshPools()
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

  /**
   * 卡片动作接口：代领签到、删除副本、测试模型。
   *
   * 与状态路由一样挂在 `webServer` 上（可选服务，apply 期不能采样）。
   */
  const registerActions = (webCtx: MiniMaxActionContext): void => {
    registerMiniMaxActionRoutes(webCtx, {
      tokenForRegion: async (region, signal) => {
        const auth = liveAuths.get(region)
        if (auth === undefined) throw new Error(`本机没有注册${region === 'global' ? '国际版' : '国内版'}的登录路由。`)
        return auth.token(signal)
      },
      tokenForAccount: async (region, id, signal) => {
        // 本机登录走活凭据；副本走它自己的源（不碰 mcode 的续期链）。
        if (id === LIVE_ACCOUNT_ID) {
          const auth = liveAuths.get(region)
          if (auth === undefined) throw new Error('本机登录路由不存在。')
          return auth.token(signal)
        }
        const pool = regionPools.get(region)
        const account = pool?.list().find(entry => entry.id === id)
        if (account === undefined) throw new Error(`池里没有账号 ${id}。`)
        return account.source.token(signal)
      },
      saveField: async (field, value) => {
        // 真写入：在宿主进程里 settings.mutate。浏览器侧 ConfigForm.set 在这台
        // 宿主上会静默不落盘（workbuddy 0.1.7 缺陷同款），所以保存必须走这里。
        const settings = (ctx as unknown as { get?(name: string): unknown }).get?.('settings') as
          | {
            describe(): Array<{ ns: string, value?: unknown }>
            mutate(ns: string, ops: Array<{ op: string, path: string[], value: unknown }>, expected?: number): Promise<unknown>
          }
          | undefined
        if (settings === undefined) throw new Error('settings 服务不可用。')
        const row = settings.describe().find(entry => looksLikeOurNamespace(entry.value))
        if (row === undefined) throw new Error('describe() 里没有本插件的命名空间。')
        // 易变字段在 describe() 的 value 里是 {get():T} 活引用：直接展开会把函数
        // 漏进 mutate 载荷，被严格 JSON 检查拒绝。先深度解包再合并。
        const current = unwrapVolatileDeep((row.value as Record<string, unknown> | undefined)?.[field] ?? {})
        const incoming = (typeof value === 'object' && value !== null && !Array.isArray(value))
          ? unwrapVolatileDeep(value as Record<string, unknown>)
          : value
        const merged = Array.isArray(incoming) || typeof incoming !== 'object' || incoming === null
          ? incoming
          : { ...(current as Record<string, unknown>), ...(incoming as Record<string, unknown>) }
        await settings.mutate(row.ns, [{ op: 'set', path: [field], value: merged }], undefined)
        // 回读真正落盘的值，让卡片镜像真相而不是它自己那份可能过期的镜像。
        const after = settings.describe().find(entry => entry.ns === row.ns)
        const stored = unwrapVolatileDeep((after?.value as Record<string, unknown> | undefined)?.[field])
        return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
          ? stored as Record<string, unknown>
          : undefined
      },
      exportAccounts: async (ids) => buildTransferFile(readAccountsSync(), ids),
      importAccounts: async (raw, ids) => {
        const result = await importTransferFile(raw, ids)
        // 导入后立刻重算池：否则新账号要等下一次 60s 对账才出现，
        // 用户看到的就是"导入了但列表里没有"。
        if (result.added.length > 0) reconcileAccounts()
        return result
      },
      startDeviceLogin: region => deviceLogins.start(region),
      cancelDeviceLogin: id => { deviceLogins.cancel(id) },
      moveAccount: async (region, id, direction) => {
        const pool = regionPools.get(region)
        if (pool === undefined) return false
        const order = pool.list().map(entry => entry.id)
        const index = order.indexOf(id)
        if (index < 0) return false
        const target = direction === 'up' ? index - 1 : index + 1
        if (target < 0 || target >= order.length) return false
        const swapped = [...order]
        const from = swapped[index]
        const to = swapped[target]
        if (from === undefined || to === undefined) return false
        swapped[index] = to
        swapped[target] = from
        // 池顺序来自库里的副本顺序：把新顺序写回库，重启后也保持。
        const accounts = readAccountsSync()
        const copies = accounts.filter(account => account.region === region && account.owned)
        const byId = new Map(copies.map(account => [account.id, account]))
        const live = order.find(entry => !byId.has(entry))
        const reordered = swapped
          .filter(entry => byId.has(entry))
          .map(entry => byId.get(entry) as MiniMaxStoredAccount)
        const others = accounts.filter(account => !byId.has(account.id))
        await writeAccounts([...others, ...reordered])
        reconcileAccounts()
        void live
        return true
      },
      refreshAccount: async (region) => {
        // 刷新要真的重新读一遍，而不是让浏览器端重拉缓存：
        //  - 丢掉本机凭据的缓存（它 1 小时才过期，用户刚在 mcode 里换了登录）
        //  - 丢掉积分/签到的 60 秒缓存
        //  - 重新镜像本机登录、重算账号池
        const auth = liveAuths.get(region)
        auth?.invalidate()
        invalidateAccountCache(routeForRegion(region))
        for (const account of readAccountsSync()) {
          invalidateAccountCache(accountRouteOf(account))
        }
        await mirrorLive()
        reconcileAccounts()
      },
      selectAccount: async (region, id) => {
        const pool = regionPools.get(region)
        if (pool === undefined) return false
        if (!pool.select(id)) return false
        // 立刻落盘：切换是用户显式动作，不能等下次重启才发现没记住。
        await writeActiveSelection(region, id)
        return true
      },
      testModel: async (route, model, signal): Promise<MiniMaxModelTestResult> => {
        const adapter = adaptersByRoute.get(route)
        if (adapter === undefined) return { ok: false, latencyMs: 0, error: `未知路由 "${route}"。` }
        const started = Date.now()
        try {
          // 走 prepareCall → stream 这条**真实**通路：鉴权头、baseUrl、思考档位都与
          // 对话一致。在这里另造一条裸 fetch 就等于测了个假链路，测过不代表能用。
          const call = await adapter.prepareCall(route, model, signal)
          let text = ''
          let failure: string | undefined
          for await (const chunk of call.stream({
            provider: route,
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：你好' }] }],
            maxTokens: 64,
            ...signal === undefined ? {} : { signal },
          })) {
            const event = chunk as {
              type?: string
              text?: string
              // finish 的 reason 是**对象**（`{kind:'stop'}` / `{kind:'error',failure:{…}}`），
              // 按字符串比会得到 "[object Object]"，于是每次测试都"失败"。
              reason?: { kind?: string, failure?: { message?: string } }
              error?: unknown
            }
            if (event.type === 'text-delta') text += event.text ?? ''
            if (event.type === 'error') failure = String(event.error ?? '上游返回错误')
            if (event.type === 'finish') {
              const kind = event.reason?.kind
              // stop / tool-calls 是正常收尾；其余（error、length…）算失败并带上原因。
              if (kind !== undefined && kind !== 'stop' && kind !== 'tool-calls') {
                failure ??= event.reason?.failure?.message ?? `finish=${kind}`
              }
            }
            if (text.length > 24) break
          }
          if (failure !== undefined) return { ok: false, latencyMs: Date.now() - started, error: failure }
          return {
            ok: true,
            latencyMs: Date.now() - started,
            ...text === '' ? {} : { sample: text.slice(0, 24) },
          }
        } catch (error: unknown) {
          return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
        }
      },
      log: message => ctx.logger?.info(`dsh-connect-minmax: ${message}`),
    })
  }

  // 状态卡片是可选能力：等 webServer 出现再挂，不能 apply 期采样。
  ctx.inject(['webServer'], webCtx => {
    // status.ts 只声明它真正用到的 webServer 面（便于测试替身），注入回调给的
    // 是完整 Context；`webServer` 由这次注入保证存在，所以这里做一次收窄。
    const context = webCtx as unknown as MiniMaxStatusContext & MiniMaxActionContext
    registerMiniMaxStatusRoute(context, {
      routes: registeredRoutes,
      models,
      // 全目录同样过一遍长上下文档位：卡片要展示的"上下文窗口"必须是用户
      // 当前设置下的真实值，否则勾了 longContext 卡片还显示 512K。
      catalog: MINIMAX_MODELS.map(spec => projectModel(spec, longContext, config.modelContextWindows, config.modelImages, config.modelThinkingOff, warn)),
      enabledRegions: requestedRegions,
      longContext,
      reasoningEffort,
      // 已保存的逐模型覆盖：卡片靠它给草稿一个正确基线（"没动过"与"显式设成
      // 这个值"必须分得开，否则放弃修改还原不回去）。
      modelOverrides: {
        ...config.modelImages === undefined ? {} : { images: config.modelImages },
        ...config.modelThinkingOff === undefined ? {} : { thinkingOff: config.modelThinkingOff },
        ...config.modelContextWindows === undefined ? {} : { contextWindows: config.modelContextWindows },
      },
      version: PLUGIN_VERSION,
    })
    registerActions(context)
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
