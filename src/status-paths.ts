/**
 * 宿主与浏览器两半共用的**无 node 依赖**的桥：路由路径、卡片要展示的类型、
 * 以及把宿主那份设置值读成布尔/枚举的小助手。
 *
 * 为什么要单独一个模块：浏览器半边（`src/client/**`）不能 import 任何带
 * `node:` 的模块，而 `src/status.ts` 要用 `node:http` 的类型。所以两半
 * 共享的常量与纯函数住在这里，两边各自 import。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— `status-paths.ts` 的角色与命名沿用该项目的做法：它既是路由路径的
 *     唯一来源，也是浏览器半边读设置值的地方。
 */

/** 状态路由的路径。前缀 = Loader 条目 id（`cordis.patch.yml` 的 `id:`）。 */
export const MINIMAX_STATUS_PATH = '/plugins/dsh-connect-minmax/status'

/** 本插件注册的 LLM 路由名。 */
export const MINIMAX_ROUTE = 'minimax'

/** 插件显示名（设置卡片标题与模型分组名）。 */
export const MINIMAX_DISPLAY_NAME = 'MiniMax（本机登录）'

/** 插件的 GitHub 仓库（卡片里的链接）。 */
export const MINIMAX_GITHUB_URL = 'https://github.com/dingminhua/dsh-connect-minmax'

/**
 * 卡片注册用的槽位 key 集合。
 *
 * 插件管理器按**包标识**给配置槽位打 key，不是按本插件自己的设置命名空间：
 *  - `plugins.bundle.config` —— 用**裸包名**；
 *  - `plugins.row.config` —— 用 **`<包名>#<行 id>`**。
 *
 * 这里把每种可能的拼法都列出来，是因为插件页是按**精确相等**在 `Set` 里查
 * key 的，而部署方可以把安装行命名成任何样子（宿主实测用的是
 * `include:dsh-connect-minmax` 这种带前缀的 id）。只注册一种拼法而部署用的
 * 是另一种时，卡片**渲染不出任何东西、也不报任何错**——插件照常显示为
 * running、有描述有行，只是没有配置体。
 *
 * 注册多种拼法是安全的：keyed 槽位里每个 key 各自独立，不存在冲突。
 */
export const MINIMAX_CARD_KEYS: readonly string[] = [
  'dsh-connect-minmax',
  'include:dsh-connect-minmax',
]

/** 卡片要展示的登录态分类。 */
export type MiniMaxLoginState = 'ready' | 'anonymous' | 'missing' | 'expired' | 'error'

/** 凭据来源。 */
export type MiniMaxLoginSource = 'lease' | 'file' | 'none'

/** 卡片要展示的登录态。**不含任何 token 材料。** */
export interface MiniMaxLoginView {
  state: MiniMaxLoginState
  source: MiniMaxLoginSource
  generation?: number
  expiresAtMs?: number
  detail?: string
}

/** 卡片要展示的模型行。 */
export interface MiniMaxModelView {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  input: string[]
  reasoning: boolean
}

/** 状态路由的应答文档。 */
export interface MiniMaxStatusView {
  ok: boolean
  route: 'minimax'
  region: 'cn' | 'global'
  regionLabel: string
  baseUrl: string
  login: MiniMaxLoginView
  models: MiniMaxModelView[]
  pluginVersion: string
  checkedAt: number
}

/**
 * 把一个未知值收窄成登录态分类。
 *
 * 路由的应答是 JSON，可能来自旧版本、也可能被别的插件截胡，所以每个字段都
 * 要独立校验——**一个坏字段不能让整份文档作废**（否则一张字段改名就能让卡片
 * 变成空白）。
 */
export function loginStateOf(value: unknown): MiniMaxLoginState {
  return value === 'ready'
    || value === 'anonymous'
    || value === 'missing'
    || value === 'expired'
    || value === 'error'
    ? value
    : 'error'
}

/** 把一个未知值收窄成凭据来源。 */
export function loginSourceOf(value: unknown): MiniMaxLoginSource {
  return value === 'lease' || value === 'file' || value === 'none' ? value : 'none'
}

/** 读一个可选的有限数值（`generation` / `expiresAtMs` / `contextWindow` …）。 */
export function finiteNumberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 读一个可选的非空字符串。 */
export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 把路由的原始 JSON 收窄成 {@link MiniMaxStatusView}。
 *
 * 收窄是**逐字段**的：`login` 与 `models` 各自独立处理，一个字段坏掉只让
 * 那一个字段变成默认值，而不是让整份文档变成 undefined。卡片因此总能画出
 * 骨架，而不是白屏。
 *
 * `models` 里的每一行也独立收窄：坏行被丢掉，好行照常显示。
 */
export function toStatusView(value: unknown): MiniMaxStatusView {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {}

  const rawLogin = (typeof raw['login'] === 'object' && raw['login'] !== null && !Array.isArray(raw['login']))
    ? raw['login'] as Record<string, unknown>
    : {}

  const rawModels = Array.isArray(raw['models']) ? raw['models'] : []
  const models: MiniMaxModelView[] = []
  for (const entry of rawModels) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const id = stringOf(row['id'])
    if (id === undefined) continue
    const contextWindow = finiteNumberOf(row['contextWindow']) ?? 0
    const maxTokens = finiteNumberOf(row['maxTokens']) ?? 0
    models.push({
      id,
      name: stringOf(row['name']) ?? id,
      contextWindow,
      maxTokens,
      input: Array.isArray(row['input'])
        ? row['input'].filter((item): item is string => typeof item === 'string')
        : [],
      reasoning: row['reasoning'] === true,
    })
  }

  const generation = finiteNumberOf(rawLogin['generation'])
  const expiresAtMs = finiteNumberOf(rawLogin['expiresAtMs'])
  const detail = stringOf(rawLogin['detail'])

  return {
    ok: raw['ok'] === true,
    route: 'minimax',
    region: raw['region'] === 'global' ? 'global' : 'cn',
    regionLabel: stringOf(raw['regionLabel']) ?? (raw['region'] === 'global' ? '国际版' : '国内版'),
    baseUrl: stringOf(raw['baseUrl']) ?? '',
    login: {
      state: loginStateOf(rawLogin['state']),
      source: loginSourceOf(rawLogin['source']),
      ...(generation === undefined ? {} : { generation }),
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      ...(detail === undefined ? {} : { detail }),
    },
    models,
    pluginVersion: stringOf(raw['pluginVersion']) ?? 'dev',
    checkedAt: finiteNumberOf(raw['checkedAt']) ?? 0,
  }
}

/**
 * 到期时间的**相对**描述（宿主侧不知道浏览器时区，也不需要知道）。
 *
 * 刻意不返回"还有 3 小时"这种硬编码的英文——展示层要的是"多久之后过期"这
 * 个时长，措辞由 locale 决定。所以这里只算出**剩余毫秒数**，由卡片按 locale
 * 拼句子。
 *
 * 返回 `undefined` 表示"没有到期时间"（登录态不带 expiresAtMs），此时卡片
 * 不显示这一行，而不是显示"未知"。
 */
export function remainingMsOf(expiresAtMs: number | undefined, nowMs: number): number | undefined {
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) return undefined
  return expiresAtMs - nowMs
}

/** 把剩余毫秒数分档，供文案层挑一个合适的说法。 */
export type MiniMaxExpiryBucket = 'expired' | 'minutes' | 'hours' | 'days' | 'unknown'

/** 把剩余毫秒数分档。 */
export function expiryBucketOf(remainingMs: number | undefined): MiniMaxExpiryBucket {
  if (remainingMs === undefined) return 'unknown'
  if (remainingMs <= 0) return 'expired'
  if (remainingMs < 60 * 60 * 1000) return 'minutes'
  if (remainingMs < 24 * 60 * 60 * 1000) return 'hours'
  return 'days'
}

/** 把毫秒数格式化成"2 小时 5 分"式的紧凑时长（不带单位文案，单位由 locale 拼）。 */
export function durationPartsOf(remainingMs: number): { value: number, unit: 'minutes' | 'hours' | 'days' } {
  if (remainingMs < 60 * 60 * 1000) {
    return { value: Math.max(1, Math.round(remainingMs / (60 * 1000))), unit: 'minutes' }
  }
  if (remainingMs < 24 * 60 * 60 * 1000) {
    return { value: Math.round(remainingMs / (60 * 60 * 1000)), unit: 'hours' }
  }
  return { value: Math.round(remainingMs / (24 * 60 * 60 * 1000)), unit: 'days' }
}

/**
 * 把上下文窗口格式化成 "512K" / "2.048M" 这样的紧凑写法。
 *
 * **不丢精度。** 先用 `toFixed(3)` 保留三位小数，再去掉末尾的零——所以
 * `2_048_000` 是 "2.048M" 而不是 "2M"（后者把 2048000 说成 2000000，
 * 差了 2.4%），而 `512_000` 是 "512K"（去掉末尾零之后没有小数点）。
 *
 * 用「先补足再裁掉」的写法而不是 `toPrecision`，是因为 `toPrecision` 会在
 * 整数值上给出 "512.000K" 这种带尾零的形状。
 */
export function formatContextWindow(contextWindow: number): string {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return '—'
  if (contextWindow >= 1_000_000) {
    return `${trimZeros((contextWindow / 1_000_000).toFixed(3))}M`
  }
  if (contextWindow >= 1_000) {
    return `${trimZeros((contextWindow / 1_000).toFixed(3))}K`
  }
  return String(contextWindow)
}

/** 去掉数值文本末尾的零与随之而来的小数点。 */
function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}
