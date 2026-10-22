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

/**
 * 卡片动作接口。
 *
 * 与宿主侧 `actions.ts` 的三个常量**必须逐字一致**——这里不 import 那边，是因为
 * 浏览器半边不该把宿主模块（含 node:http）拉进 bundle。有单测钉住两侧相等。
 */
export const MINIMAX_SIGNIN_CLAIM_PATH = '/plugins/dsh-connect-minmax/signin/claim'
export const MINIMAX_ACCOUNT_REMOVE_PATH = '/plugins/dsh-connect-minmax/account/remove'
export const MINIMAX_MODEL_TEST_PATH = '/plugins/dsh-connect-minmax/model/test'
/** 把池里某个账号设为当前账号。 */
export const MINIMAX_ACCOUNT_SELECT_PATH = '/plugins/dsh-connect-minmax/account/select'

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
  // bundle 级：包标识（scoped 名与裸名都注册，宿主用哪个都能命中）
  '@dmh2002/dsh-connect-minmax',
  'dsh-connect-minmax',
  // 宿主实测用的是带 include: 前缀的行 id，两种包名各留一份
  'include:dsh-connect-minmax',
  'include:@dmh2002/dsh-connect-minmax',
  // row 级：`<包标识>#<行 id>`
  '@dmh2002/dsh-connect-minmax#dsh-connect-minmax',
  '@dmh2002/dsh-connect-minmax#include:dsh-connect-minmax',
  'dsh-connect-minmax#dsh-connect-minmax',
  'dsh-connect-minmax#include:dsh-connect-minmax',
]

/** 卡片要展示的登录态分类。 */
export type MiniMaxLoginState = 'ready' | 'authorizing' | 'anonymous' | 'missing' | 'expired' | 'error'

/** 凭据来源。 */
export type MiniMaxLoginSource = 'lease' | 'file' | 'none'

/** 卡片要展示的登录态。**不含任何 token 材料。** */
export interface MiniMaxLoginView {
  state: MiniMaxLoginState
  source: MiniMaxLoginSource
  generation?: number
  expiresAtMs?: number
  detail?: string
  /** 设备码登录的用户码（`authorizing` 时可用）。 */
  userCode?: string
  /** 设备码登录的授权地址（`authorizing` 时可用）。 */
  verificationUri?: string
}

/** 卡片要展示的模型行。 */
export interface MiniMaxModelView {
  id: string
  name: string
  /** 角标（如「订阅限免」）；缺省不显示。 */
  badge?: string
  contextWindow: number
  /**
   * 上游为该模型提供的上下文档位（含当前值）。
   *
   * 空数组 = 旧版本应答没有这个字段，卡片此时**只读显示**当前窗口，不猜一个
   * 档位列表出来——给用户一个改了不生效的下拉框比没有下拉框更糟。
   */
  contextWindowOptions: number[]
  /**
   * 上游**真实**支持的模态（未经 `modelImages` 掩码）。
   *
   * 空数组 = 旧版本应答没有这个字段，卡片按"`input` 即上游能力"处理。
   */
  upstreamInput: string[]
  maxTokens: number
  input: string[]
  reasoning: boolean
  /** 思考形态；旧版本响应没有这个字段时按 `switchable` 处理。 */
  thinkingMode: 'switchable' | 'forced'
}

/** 一条路由的积分概览（账户接口读来的，读不到就整段缺席）。 */
export interface MiniMaxCreditsView {
  /** 这份积分数据实际读取时间；缓存最多 60s 旧，所以它不等于 `checkedAt`。 */
  atMs?: number
  balance?: { totalRemaining: number, freeRemaining: number, purchasedRemaining: number }
  lotCount?: number
  expiringIn7d?: number
  expiringIn30d?: number
  earliestExpiryMs?: number
  error?: string
}

/** 一条路由的签到进度。 */
export interface MiniMaxSigninView {
  ok: boolean
  claimableToday: boolean
  days: { dayNo: number, points: number, status: number, isToday: boolean }[]
  error?: string
}

/** 一条供应商路由（一个区域）的状态。 */
/** 池里的一个账号（卡片展示用）。 */
export interface MiniMaxPoolEntryView {
  /** 稳定标识：`live` 或副本 id。 */
  id: string
  /** 展示名。 */
  label: string
  /** 是否本机登录。 */
  live: boolean
  /** 是否当前生效账号。 */
  active: boolean
  /** 最近读到的剩余积分；`undefined` = 还没读到。 */
  balance?: number
  /** 是否被判定为积分耗尽。 */
  drained: boolean
}

/** 一个区域的账号池快照。 */
export interface MiniMaxPoolView {
  accounts: MiniMaxPoolEntryView[]
  active?: string
}

/** 池里的一个账号（卡片展示用）。 */
export interface MiniMaxPoolEntryView {
  /** 稳定标识：`live` 或副本 id。 */
  id: string
  /** 展示名。 */
  label: string
  /** 是否本机登录。 */
  live: boolean
  /** 是否当前生效账号。 */
  active: boolean
  /** 最近读到的剩余积分；`undefined` = 还没读到。 */
  balance?: number
  /** 是否被判定为积分耗尽（短时间内不会再被选中）。 */
  drained: boolean
}

/** 一个区域的账号池快照。 */
export interface MiniMaxPoolView {
  accounts: MiniMaxPoolEntryView[]
  active?: string
}

export interface MiniMaxRouteView {
  route: string
  region: 'cn' | 'global'
  regionLabel: string
  baseUrl: string
  login: MiniMaxLoginView
  /** 来自账号副本时的副本 id（`cn-cfd703e1` 这种）；本机登录没有。 */
  accountId?: string
  /** 该区域的账号池；旧版本应答没有这个字段。 */
  pool?: MiniMaxPoolView
  credits?: MiniMaxCreditsView
  signin?: MiniMaxSigninView
}

/** 状态路由的应答文档。 */
export interface MiniMaxStatusView {
  ok: boolean
  route: 'minimax'
  region: 'cn' | 'global'
  regionLabel: string
  baseUrl: string
  /** 主路由的登录态（保留给只认识单区域字段的旧卡片）。 */
  login: MiniMaxLoginView
  /** 每个区域一条：国内 `minimax`、国际 `minimax-global`。 */
  routes: MiniMaxRouteView[]
  models: MiniMaxModelView[]
  /**
   * 完整目录（含未启用的模型）。
   *
   * `models` 只包含**注册出去**的那些；卡片做"勾选启用哪些模型"时必须看全目录，
   * 否则用户想启用一个当前没启用的模型时，那个模型压根不在列表里。
   * 旧版本插件不带这个字段 → 回退成 `models` 的副本。
   */
  catalog: MiniMaxModelView[]
  /** 当前启用的区域；缺省（旧版本）按"注册了的就是启用的"推断。 */
  enabledRegions: string[]
  /** 1M 长上下文档。 */
  longContext: boolean
  /** provider 级默认思考档位；旧版本应答没有时按 `medium` 处理。 */
  reasoningEffort: string
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
    || value === 'authorizing'
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

  const models = parseModels(raw['models'])
  // 旧版本不带 catalog：把 models 当全目录用，勾选框退化成"当前全部启用"。
  const catalog = Array.isArray(raw['catalog']) && (raw['catalog'] as unknown[]).length > 0
    ? parseModels(raw['catalog'])
    : [...models]

  const pendingCode = stringOf(rawLogin['userCode'])
  const pendingUri = stringOf(rawLogin['verificationUri'])
  const generation = finiteNumberOf(rawLogin['generation'])
  const expiresAtMs = finiteNumberOf(rawLogin['expiresAtMs'])
  const detail = stringOf(rawLogin['detail'])

  const routes = parseRoutes(raw['routes'])

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
      ...(pendingCode === undefined ? {} : { userCode: pendingCode }),
      ...(pendingUri === undefined ? {} : { verificationUri: pendingUri }),
    },
    routes,
    models,
    catalog,
    enabledRegions: Array.isArray(raw['enabledRegions'])
      ? raw['enabledRegions'].filter((item): item is string => item === 'cn' || item === 'global')
      // 没这个字段时从已注册路由反推，至少卡片上的开关不会全灭。
      : [...new Set(routes.map(route => route.region))],
    longContext: raw['longContext'] === true,
    reasoningEffort: stringOf(raw['reasoningEffort']) ?? 'medium',
    pluginVersion: stringOf(raw['pluginVersion']) ?? 'dev',
    checkedAt: finiteNumberOf(raw['checkedAt']) ?? 0,
  }
}

/** 收窄一份模型数组；坏行丢弃。 */
function parseModels(value: unknown): MiniMaxModelView[] {
  const models: MiniMaxModelView[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const id = stringOf(row['id'])
    if (id === undefined) continue
    const badge = stringOf(row['badge'])
    models.push({
      id,
      name: stringOf(row['name']) ?? id,
      ...badge === undefined ? {} : { badge },
      contextWindow: finiteNumberOf(row['contextWindow']) ?? 0,
      contextWindowOptions: Array.isArray(row['contextWindowOptions'])
        ? row['contextWindowOptions'].filter((item): item is number => typeof item === 'number')
        : [],
      upstreamInput: Array.isArray(row['upstreamInput'])
        ? row['upstreamInput'].filter((item): item is string => typeof item === 'string')
        : [],
      maxTokens: finiteNumberOf(row['maxTokens']) ?? 0,
      input: Array.isArray(row['input'])
        ? row['input'].filter((item): item is string => typeof item === 'string')
        : [],
      reasoning: row['reasoning'] === true,
      thinkingMode: row['thinkingMode'] === 'forced' ? 'forced' : 'switchable',
    })
  }
  return models
}

/**
 * 解析 `routes`：每行独立收窄，坏行丢弃、好行保留。
 *
 * 缺省（旧版本插件）返回空数组 —— 卡片此时退回只看顶层 `login`。
 */
function parseRoutes(value: unknown): MiniMaxRouteView[] {
  if (!Array.isArray(value)) return []
  const routes: MiniMaxRouteView[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const route = stringOf(row['route'])
    if (route === undefined) continue
    const loginRaw = (typeof row['login'] === 'object' && row['login'] !== null && !Array.isArray(row['login']))
      ? row['login'] as Record<string, unknown>
      : {}
    const userCode = stringOf(loginRaw['userCode'])
    const verificationUri = stringOf(loginRaw['verificationUri'])
    const generation = finiteNumberOf(loginRaw['generation'])
    const expiresAtMs = finiteNumberOf(loginRaw['expiresAtMs'])
    const detail = stringOf(loginRaw['detail'])
    const accountId = stringOf(row['accountId'])
    const credits = parseCredits(row['credits'])
    const signin = parseSignin(row['signin'])
    const pool = parsePool(row['pool'])
    routes.push({
      route,
      ...accountId === undefined ? {} : { accountId },
      ...pool === undefined ? {} : { pool },
      ...credits === undefined ? {} : { credits },
      ...signin === undefined ? {} : { signin },
      region: row['region'] === 'global' ? 'global' : 'cn',
      regionLabel: stringOf(row['regionLabel']) ?? (row['region'] === 'global' ? '国际版' : '国内版'),
      baseUrl: stringOf(row['baseUrl']) ?? '',
      login: {
        state: loginStateOf(loginRaw['state']),
        source: loginSourceOf(loginRaw['source']),
        ...(generation === undefined ? {} : { generation }),
        ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
        ...(detail === undefined ? {} : { detail }),
        ...(userCode === undefined ? {} : { userCode }),
        ...(verificationUri === undefined ? {} : { verificationUri }),
      },
    })
  }
  return routes
}

/**
 * 解析账号池段。
 *
 * 解析不出任何账号时返回 `undefined`：旧版本宿主不返回这个字段，卡片那时按
 * "只有一个账号"处理，而不是显示一个空池子。
 */
function parsePool(value: unknown): MiniMaxPoolView | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!Array.isArray(row['accounts'])) return undefined
  const accounts: MiniMaxPoolEntryView[] = []
  for (const item of row['accounts']) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const id = stringOf(entry['id'])
    if (id === undefined) continue
    const balance = finiteNumberOf(entry['balance'])
    accounts.push({
      id,
      label: stringOf(entry['label']) ?? id,
      live: entry['live'] === true,
      active: entry['active'] === true,
      ...balance === undefined ? {} : { balance },
      drained: finiteNumberOf(entry['drainedUntilMs']) !== undefined,
    })
  }
  if (accounts.length === 0) return undefined
  const active = stringOf(row['active'])
  return { accounts, ...active === undefined ? {} : { active } }
}

/** 解析积分概览：任何形状不符就整段丢弃（宁可不显示，也不显示半个数字）。 */
function parseCredits(value: unknown): MiniMaxCreditsView | undefined {
  const row = (typeof value === 'object' && value !== null && !Array.isArray(value))
    ? value as Record<string, unknown>
    : undefined
  if (row === undefined) return undefined
  const balanceRaw = (typeof row['balance'] === 'object' && row['balance'] !== null && !Array.isArray(row['balance']))
    ? row['balance'] as Record<string, unknown>
    : undefined
  const error = stringOf(row['error'])
  if (balanceRaw === undefined && error === undefined) return undefined
  const atMs = finiteNumberOf(row['atMs'])
  return {
    ...atMs === undefined ? {} : { atMs },
    ...balanceRaw === undefined ? {} : {
      balance: {
        totalRemaining: finiteNumberOf(balanceRaw['totalRemaining']) ?? 0,
        freeRemaining: finiteNumberOf(balanceRaw['freeRemaining']) ?? 0,
        purchasedRemaining: finiteNumberOf(balanceRaw['purchasedRemaining']) ?? 0,
      },
    },
    ...finiteNumberOf(row['lotCount']) === undefined ? {} : { lotCount: finiteNumberOf(row['lotCount'])! },
    ...finiteNumberOf(row['expiringIn7d']) === undefined ? {} : { expiringIn7d: finiteNumberOf(row['expiringIn7d'])! },
    ...finiteNumberOf(row['expiringIn30d']) === undefined ? {} : { expiringIn30d: finiteNumberOf(row['expiringIn30d'])! },
    ...finiteNumberOf(row['earliestExpiryMs']) === undefined ? {} : { earliestExpiryMs: finiteNumberOf(row['earliestExpiryMs'])! },
    ...error === undefined ? {} : { error },
  }
}

/** 解析签到进度；缺 `days` 数组时回一份空进度。 */
function parseSignin(value: unknown): MiniMaxSigninView | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const rawDays = Array.isArray(row['days']) ? row['days'] : undefined
  if (rawDays === undefined) return undefined
  const days: MiniMaxSigninView['days'] = []
  for (const entry of rawDays) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const day = entry as Record<string, unknown>
    days.push({
      dayNo: finiteNumberOf(day['dayNo']) ?? 0,
      points: finiteNumberOf(day['points']) ?? 0,
      status: finiteNumberOf(day['status']) ?? 0,
      isToday: day['isToday'] === true,
    })
  }
  const error = stringOf(row['error'])
  return {
    ok: row['ok'] === true,
    claimableToday: row['claimableToday'] === true,
    days,
    ...error === undefined ? {} : { error },
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
