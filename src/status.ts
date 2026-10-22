/**
 * 状态路由：给设置卡片一份**只读**的插件状态快照。
 *
 * 路由固定为 `GET /plugins/dsh-connect-minmax/status`，前缀与 Loader 条目 id
 * 一致（`cordis.patch.yml` 的 `id:`）——这是本插件族约定的一贯做法：条目 id
 * 同时是设置命名空间与 `/plugins/<id>/…` 路由前缀。
 *
 * 三条硬约束：
 *
 *  1. **绝不抛。** handler 捕获一切异常，永远回一份 JSON。状态路由 500 一次，
 *     卡片就只能显示"无法读取状态"，用户看不到任何可操作的信息。
 *  2. **不阻塞。** `auth.inspect()` 要走 broker 的 unix socket 或读本地凭据
 *     文件，可能卡住（broker 在但不响应）。所以给它 3 秒上限：超时就降级成
 *     `state: 'error'`，而不是让整张卡片转圈。
 *  3. **不泄露凭据。** 响应里只有登录态、区域、模型目录与版本号，**没有
 *     accessToken**，也没有任何可还原 token 的字段。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 路由的注册方式（`ctx.webServer.register({kind:'exact', path, handler})`）、
 *     回环来源校验与 `safeMessage` 的脱敏规则均来自该项目。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { PoolSnapshot } from './pool.ts'

import {
  buildCreditSnapshot,
  fetchCreditBalance,
  fetchCreditLots,
  fetchSigninStatus,
  type MiniMaxSigninDay,
} from './credits.ts'

import {
  MINIMAX_ROUTE as MINIMAX_STATUS_ROUTE,
  MINIMAX_STATUS_PATH,
} from './status-paths.ts'

export { MINIMAX_STATUS_PATH } from './status-paths.ts'

/** `auth.inspect()` 的上限时长（毫秒）。超时即降级，绝不无限等待。 */
export const MINIMAX_STATUS_TIMEOUT_MS = 3_000

/** 上游区域。 */
export type MiniMaxStatusRegion = 'cn' | 'global'

/** 登录态分类。与 `auth.ts` 的 `MiniMaxLoginState` 一一对应。 */
export type MiniMaxStatusLoginState = 'ready' | 'authorizing' | 'anonymous' | 'missing' | 'expired' | 'error'

/** 凭据来源。 */
export type MiniMaxStatusLoginSource = 'lease' | 'file' | 'none'

/** 卡片要展示的登录态。**不含任何 token 材料。** */
export interface MiniMaxStatusLogin {
  state: MiniMaxStatusLoginState
  source: MiniMaxStatusLoginSource
  generation?: number
  expiresAtMs?: number
  detail?: string
  /** 设备码登录的用户码（`authorizing` 时可用）。 */
  userCode?: string
  /** 设备码登录的授权地址（`authorizing` 时可用）。 */
  verificationUri?: string
}

/** 卡片要展示的模型行。 */
export interface MiniMaxStatusModel {
  id: string
  name: string
  /** 卡片角标，例如「订阅限免」。 */
  badge?: string
  contextWindow: number
  /** 该模型可选的上下文档位（含当前值）。 */
  contextWindowOptions?: number[]
  /**
   * 上游**真实**支持的输入模态，与 `input` 分开给。
   *
   * `input` 是投影后的结果（可能被 `modelImages` 掩码过）。卡片只看 `input`
   * 的话，用户一旦关掉图片，控件就会退化成"不支持"的样子，再也勾不回来——
   * 所以必须同时知道上游本来支持什么。
   */
  upstreamInput?: string[]
  maxTokens: number
  input: string[]
  reasoning: boolean
  /** 思考形态：可关闭 / 强制开启。卡片据此显示"思考"一列。 */
  thinkingMode: 'switchable' | 'forced'
}

/** 一条路由附带的账户信息（积分与签到）。 */
export interface MiniMaxStatusCredits {
  /** 这份数据实际是什么时候读的（缓存最多 60s 旧，卡片要显示真实读取时间）。 */
  atMs?: number
  balance?: { totalRemaining: number, freeRemaining: number, purchasedRemaining: number }
  lotCount?: number
  expiringIn7d?: number
  expiringIn30d?: number
  earliestExpiryMs?: number
  error?: string
}

/** 一条路由附带的签到进度。 */
export interface MiniMaxStatusSignin {
  ok: boolean
  claimableToday: boolean
  days: { dayNo: number, points: number, status: number, isToday: boolean }[]
  error?: string
}

/** 一条路由（一个区域、或一个账号副本）的状态。 */
export interface MiniMaxStatusRoute {
  route: string
  region: MiniMaxStatusRegion
  regionLabel: string
  baseUrl: string
  login: MiniMaxStatusLogin
  /** 该路由来自账号副本时的副本 id；本机登录没有这个字段。 */
  accountId?: string
  /** 账户接口读到的积分概览；读不到就没有这个字段。 */
  credits?: MiniMaxStatusCredits
  /** 七天一签的进度；读不到就没有这个字段。 */
  signin?: MiniMaxStatusSignin
}

/** 状态路由的应答文档。 */
export interface MiniMaxStatusPayload {
  /** 请求是否被完整回答。降级也算 answered，只有"路由本身坏了"才是 false。 */
  ok: boolean
  /** 主路由名（`minimax`，或只启用国际版时的 `minimax-global`）。 */
  route: string
  region: MiniMaxStatusRegion
  regionLabel: string
  baseUrl: string
  login: MiniMaxStatusLogin
  /** 每个区域一条；顺序与注册顺序一致。 */
  routes: MiniMaxStatusRoute[]
  models: MiniMaxStatusModel[]
  /**
   * **完整目录**（含未启用的模型）。
   *
   * `models` 是"当前注册出去"的那份，卡片拿它没法做勾选——用户想启用一个当前
   * 没启用的模型时，那个模型根本不在列表里。所以另给一份全目录，卡片自己比对。
   */
  catalog?: MiniMaxStatusModel[]
  /** 当前注册了哪些区域；未列出的区域在卡片上是"关"。 */
  enabledRegions?: string[]
  /**
   * **已保存**的逐模型覆盖值（图片 / 可关闭思考 / 上下文档位）。
   *
   * 卡片靠它给草稿一个正确基线：草稿要能区分"用户还没动过"与"用户把它设成了
   * 这个值"。没有这一段，草稿就只能靠"当前请求里生效的值"反推——那已经是
   * 投影后的结果（掩码过的），拿它当基线会把"未设置"和"显式设为 false"混成
   * 一件事，放弃修改也还原不回去。
   */
  modelOverrides?: MiniMaxModelOverrides
  /** 是否启用 1M 长上下文档。 */
  longContext?: boolean
  /** provider 级默认思考档位（宿主未指定档位时用）。 */
  reasoningEffort?: string
  pluginVersion: string
  /** 本次探测的时间戳（epoch ms）。 */
  checkedAt: number
}

/**
 * 状态路由依赖的凭据读取面。
 *
 * **刻意用结构化最小接口**，而不是 import `MiniMaxAuth` 具体类：这样单测可以
 * 注入一个替身，不必造真的凭据目录与 broker。
 *
 * 每个可选字段都显式写成 `?: T | undefined`：`exactOptionalPropertyTypes` 下
 * 「属性缺失」与「属性存在但值是 undefined」是**不同的类型**，而
 * `MiniMaxAuth.lastFailure` 是一个返回 `string | undefined` 的 **getter**
 * （必选属性 + 值可空）。只写 `?: string` 时两者不可直接赋值。
 */
export interface MiniMaxStatusAuth {
  inspect(signal?: AbortSignal): Promise<{
    state: MiniMaxStatusLoginState
    source: MiniMaxStatusLoginSource
    generation?: number | undefined
    expiresAtMs?: number | undefined
    region?: MiniMaxStatusRegion | undefined
    detail?: string | undefined
    userCode?: string | undefined
    verificationUri?: string | undefined
  }>
  readonly region: MiniMaxStatusRegion
  readonly regionLabel: string
  readonly baseUrl: string
  /**
   * 最近一次取凭据失败的描述（宿主侧记录的）。
   *
   * 可选：不是每个凭据读取面都有它。有的话，当 `inspect()` 没能给出更具体的
   * `detail` 时用它兜底——用户看到的"最近错误"才有内容，而不是一句空的
   * "登录出错"。
   */
  readonly lastFailure?: string | undefined
}

/** 已保存的逐模型覆盖值。 */
export interface MiniMaxModelOverrides {
  /** 模型 id → 是否发送图片。 */
  images?: Record<string, boolean>
  /** 模型 id → 是否提供「关闭思考」档。 */
  thinkingOff?: Record<string, boolean>
  /** 模型 id → 上下文档位。 */
  contextWindows?: Record<string, number>
}

/** 状态路由依赖的模型目录（只取卡片要展示的字段）。 */
export interface MiniMaxStatusModelSpec {
  id: string
  name: string
  badge?: string
  contextWindow: number
  /** 上游为该模型提供的档位；卡片据此渲染下拉框，而不是猜一个列表。 */
  contextWindowOptions?: readonly number[]
  /** 上游真实支持的模态（未经掩码）。 */
  upstreamInput?: readonly string[]
  /** 是否提供「关闭思考」档位。 */
  thinkingOff?: boolean
  /** 可选推理档位（不含 off）。 */
  efforts?: readonly string[]
  maxTokens: number
  input: readonly string[]
  reasoning: boolean
  thinkingMode: 'switchable' | 'forced'
}

/** 一条已注册路由的凭据面与元数据。 */
export interface MiniMaxStatusRouteDeps {
  route: string
  /** 该路由若来自"账号副本"，这里是副本 id；本机登录没有这个字段。 */
  accountId?: string
  /**
   * 取一个可用 token 去读账户接口（积分 / 签到）。
   *
   * 可选：不是每条路由都值得花一次网络往返（副本路由的 token 可能是快照）。
   * 抛错或超时都只让 `credits` 缺席，不影响登录态与模型通路。
   */
  accountToken?: (signal?: AbortSignal) => Promise<string>
  /**
   * 这个区域的账号池快照。
   *
   * 卡片要靠它回答"池里有几个号、现在用哪个、谁积分用完了"——这三件事在只看
   * `auth.inspect()`（本机登录）时完全不可见。
   */
  pool?: () => PoolSnapshot
  /**
   * 把读到的最新余额回灌给账号池。
   *
   * 这是"积分没了自动切"的**主动**触发点：请求前就知道当前号没钱，直接跳过，
   * 不必先发一次注定失败的请求。读不到余额时不调用，池就按"未知即可用"处理。
   */
  reportCredits?: (totalRemaining: number) => void
  region: MiniMaxStatusRegion
  regionLabel: string
  baseUrl: string
  auth: MiniMaxStatusAuth
}

/** 注册状态路由所需的依赖。 */
export interface MiniMaxStatusDeps {
  /** 已注册的路由；至少一条。 */
  routes: readonly MiniMaxStatusRouteDeps[]
  models: readonly MiniMaxStatusModelSpec[]
  /** 完整目录（含未启用项）；缺省时卡片只能把 `models` 当全目录用。 */
  catalog?: readonly MiniMaxStatusModelSpec[]
  /** 配置里启用的区域。 */
  enabledRegions?: readonly string[]
  /** 已保存的逐模型覆盖值（给卡片的草稿一个正确基线）。 */
  modelOverrides?: MiniMaxModelOverrides
  /** 长上下文档位。 */
  longContext?: boolean
  /** 默认思考档位。 */
  reasoningEffort?: string
  version: string
}

/** 宿主 webServer 的注册面（只声明用到的部分，便于测试替身）。 */
export interface MiniMaxStatusWebServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 宿主上下文里本路由用到的部分。 */
export interface MiniMaxStatusContext {
  webServer: MiniMaxStatusWebServer
}

/**
 * 只接受回环来源。
 *
 * 状态文档本身不含机密，但它泄露"这台机器上 MiniMax 是不是登录了"以及
 * 账号区域。限制到回环，与本插件族其余路由的做法一致。
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket?.remoteAddress
  if (remote === undefined || remote === '') return false
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true
  // unix socket 与 in-process 测试的 remoteAddress 可能是 undefined / 'socket'
  return remote === '::ffff:0.0.0.0'
}

/**
 * 错误信息脱敏：先截断到 300 字符，再剥掉可能出现的 token 片段。
 *
 * **顺序很重要**：先遮蔽会把一整段 500 个 `x` 当成一个"长 token"整体换成
 * `<redacted>`，结果是消息从 500 字符缩成 10 字符——截断的效果被吞掉了。
 * 先截断再遮蔽，两条规则各自生效。
 *
 * 上游/本机路径里的报错偶尔会带上凭据片段（路径里带 hash、broker 的错误消息
 * 带 capability）。卡片是给人看的，不该把这类内容原样搬上去。
 */
export function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .slice(0, 300)
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>')
}

/** 把模型目录投影成卡片要展示的形状（`input` 变成可变数组，便于 JSON 序列化）。 */
export function toStatusModels(models: readonly MiniMaxStatusModelSpec[]): MiniMaxStatusModel[] {
  return models.map(model => ({
    id: model.id,
    name: model.name,
    ...model.badge === undefined ? {} : { badge: model.badge },
    contextWindow: model.contextWindow,
    ...model.contextWindowOptions === undefined
      ? {}
      : { contextWindowOptions: [...model.contextWindowOptions] },
    ...model.upstreamInput === undefined
      ? {}
      : { upstreamInput: [...model.upstreamInput] },
    ...model.thinkingOff === undefined ? {} : { thinkingOff: model.thinkingOff },
    ...model.efforts === undefined ? {} : { efforts: [...model.efforts] },
    maxTokens: model.maxTokens,
    thinkingMode: model.thinkingMode,
    input: [...model.input],
    reasoning: model.reasoning,
  }))
}

/**
 * 探测登录态，并给它 3 秒上限。
 *
 * 超时不是一个罕见分支：broker 的 socket 在 MiniMax Code 挂起而没退出的
 * 情况下会**连上但不应答**，此时没有超时就是一条永久挂起的请求——卡片会永远
 * 显示"加载中"，而宿主这边多了一个挂住的 handler。
 *
 * **超时靠"竞速"实现，不是靠 abort。** 只 `controller.abort()` 是不够的：
 * `AbortController` 只是**通知**对方可以放弃了，对方**是否真的停下来**取决于
 * 它有没有把 signal 传下去、传下去之后有没有真的用它。凭据读取面的文件兜底
 * 通路就完全不看 signal——于是"abort 了但 Promise 永不 settle"，竞速失败，
 * 请求照样挂死。
 *
 * 所以这里同时做两件事：abort（让对方**有机会**提前收工，省掉后面的工作）
 * 与竞速（保证**无论对方怎么表现**，这个函数都在上限内返回）。竞速的落败方
 * 的 rejection 也要吃掉，否则它会在之后变成一个 unhandled rejection。
 *
 * `detail` 的取值顺序：`inspect()` 自带的 > 凭据面记录的 `lastFailure` >
 * 无。`inspect()` 自带的更具体（它知道是"未登录"还是"已过期"），所以优先。
 */
export async function inspectWithTimeout(
  auth: MiniMaxStatusAuth,
  timeoutMs: number = MINIMAX_STATUS_TIMEOUT_MS,
): Promise<MiniMaxStatusLogin> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, timeoutMs)
  })

  try {
    const settled = await Promise.race([
      auth.inspect(controller.signal).then(
        status => ({ kind: 'status' as const, status }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      timeout,
    ])

    if (settled === 'timeout') {
      return {
        state: 'error',
        source: 'none',
        detail: `登录态探测超时（${timeoutMs} ms）。`,
      }
    }
    if (settled.kind === 'error') {
      return {
        state: 'error',
        source: 'none',
        detail: safeMessage(settled.error),
      }
    }
    const status = settled.status
    const detail = status.detail ?? auth.lastFailure
    return {
      state: status.state,
      source: status.source,
      ...(status.generation === undefined ? {} : { generation: status.generation }),
      ...(status.expiresAtMs === undefined ? {} : { expiresAtMs: status.expiresAtMs }),
      ...(detail === undefined ? {} : { detail }),
      // 设备码登录等待期：验证码与授权地址必须一路透传到卡片，
      // 否则用户只看到"正在等你完成授权"，却不知道去哪里、填哪个码。
      ...(status.userCode === undefined ? {} : { userCode: status.userCode }),
      ...(status.verificationUri === undefined ? {} : { verificationUri: status.verificationUri }),
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 账户信息缓存有效期：卡片 10s 轮询，每条路由每 60s 才真打一次上游。 */
export const ACCOUNT_CACHE_MS = 60_000

/** 一次账户读取的结果。 */
interface AccountRead {
  atMs: number
  credits?: MiniMaxStatusCredits
  signin?: MiniMaxStatusSignin
}

/**
 * 按路由缓存账户读取。
 *
 * 积分与签到是**附加信息**，代价却是每条路由三次上游请求；卡片每 10 秒轮询一次，
 * 不缓存就是每 10 秒打上游 6 次。这里用"过期即重读、读失败也记时间戳"的策略：
 * 失败同样占住缓存窗口，否则上游一挂每次轮询都重试，把故障放大成持续压力。
 */
const accountCache = new Map<string, AccountRead>()

/** 清空全部账户缓存（测试用）。 */
export function resetAccountCache(): void {
  accountCache.clear()
}

/**
 * 只清一条路由的账户缓存。
 *
 * 领取签到、删除副本这类**写动作**之后必须清：卡片会立刻重读状态，而缓存窗口
 * 是 60 秒——不清的话用户点了"领取今天"，按钮继续亮着、余额纹丝不动，看起来
 * 像没生效。而且这条陈旧余额还会回灌给账号池，让一个其实有钱的账号被当成没钱。
 *
 * @param route - 路由名。
 */
export function invalidateAccountCache(route: string): void {
  accountCache.delete(route)
}

/**
 * 读一条路由的积分与签到进度。
 *
 * 整段是 best-effort：token 取不到、上游报错、超时，都只让对应字段缺席，
 * 绝不让状态文档失败——模型通路不依赖这些接口。
 */
async function readAccountInfo(
  entry: MiniMaxStatusRouteDeps,
  nowMs: number,
): Promise<AccountRead | undefined> {
  if (entry.accountToken === undefined) return undefined
  const cached = accountCache.get(entry.route)
  if (cached !== undefined && nowMs - cached.atMs < ACCOUNT_CACHE_MS) {
    // 缓存命中也要回灌：池的"够不够用"判断不该因为缓存而停在旧值上。
    if (entry.reportCredits !== undefined && cached.credits?.balance !== undefined) {
      entry.reportCredits(cached.credits.balance.totalRemaining)
    }
    return cached
  }

  const token = await entry.accountToken().catch(() => undefined)
  if (token === undefined) return undefined

  const [balance, lots, signin] = await Promise.all([
    fetchCreditBalance(entry.region, token).catch(() => ({ ok: false as const, error: '读取失败' })),
    fetchCreditLots(entry.region, token).catch(() => ({ ok: false as const, error: '读取失败' })),
    fetchSigninStatus(entry.region, token).catch(() => ({ ok: false as const, days: [], claimableToday: false, atMs: nowMs, error: '读取失败' })),
  ])

  const snapshot = buildCreditSnapshot(
    balance.ok ? balance.balance : undefined,
    lots.ok ? lots.lots : undefined,
    nowMs,
  )
  // 把底层原因带上来：只说"读取失败"的话，卡片上那个空档位永远查不出为什么空。
  const creditError = balance.ok
    ? (lots.ok ? undefined : lots.error)
    : (balance.error ?? '积分余额读取失败。')
  // 回灌给账号池：读到余额就立刻影响"下次用哪个号"的判断。
  if (entry.reportCredits !== undefined && snapshot.balance !== undefined) {
    entry.reportCredits(snapshot.balance.totalRemaining)
  }
  const read: AccountRead = {
    atMs: nowMs,
    credits: {
      atMs: snapshot.atMs,
      ...snapshot.balance === undefined ? {} : { balance: snapshot.balance },
      ...snapshot.lots === undefined ? {} : { lotCount: snapshot.lots.length },
      ...snapshot.expiringIn7d === undefined ? {} : { expiringIn7d: snapshot.expiringIn7d },
      ...snapshot.expiringIn30d === undefined ? {} : { expiringIn30d: snapshot.expiringIn30d },
      ...snapshot.earliestExpiryMs === undefined ? {} : { earliestExpiryMs: snapshot.earliestExpiryMs },
      ...((creditError ?? snapshot.error) === undefined ? {} : { error: creditError ?? snapshot.error }),
    },
    signin: {
      ok: signin.ok,
      claimableToday: signin.ok && signin.claimableToday,
      days: signin.days.map((day: MiniMaxSigninDay) => ({
        dayNo: day.dayNo,
        points: day.points,
        status: day.status,
        isToday: day.isToday,
      })),
      ...signin.error === undefined ? {} : { error: signin.error },
    },
  }
  accountCache.set(entry.route, read)
  return read
}

/**
 * 组装状态文档（不含 HTTP）。
 *
 * 拆出来是为了让测试不必起一个 HTTP 服务器就能断言文档形状。
 */
export async function buildMiniMaxStatus(
  deps: MiniMaxStatusDeps,
  nowMs: number = Date.now(),
): Promise<MiniMaxStatusPayload> {
  const routes = await Promise.all(deps.routes.map(async entry => {
    const login = await inspectWithTimeout(entry.auth)
    // 只有登录态可用时才去读账户接口：没登录时那三条必然一起失败。
    const account = login.state === 'ready' ? await readAccountInfo(entry, nowMs) : undefined
    return {
      route: entry.route,
      region: entry.region,
      regionLabel: entry.regionLabel,
      baseUrl: entry.baseUrl,
      login,
      ...entry.accountId === undefined ? {} : { accountId: entry.accountId },
      ...account?.credits === undefined ? {} : { credits: account.credits },
      ...account?.signin === undefined ? {} : { signin: account.signin },
      ...entry.pool === undefined ? {} : { pool: entry.pool() },
    }
  }))
  const primary = routes[0] ?? {
    route: MINIMAX_STATUS_ROUTE,
    region: 'cn' as const,
    regionLabel: '国内版',
    baseUrl: '',
    login: { state: 'error' as const, source: 'none' as const, detail: '没有已注册的路由。' },
  }
  return {
    ok: true,
    route: primary.route,
    region: primary.region,
    regionLabel: primary.regionLabel,
    baseUrl: primary.baseUrl,
    login: primary.login,
    routes,
    models: toStatusModels(deps.models),
    ...deps.catalog === undefined ? {} : { catalog: toStatusModels(deps.catalog) },
    ...deps.enabledRegions === undefined ? {} : { enabledRegions: [...deps.enabledRegions] },
    ...deps.modelOverrides === undefined ? {} : { modelOverrides: deps.modelOverrides },
    ...deps.longContext === undefined ? {} : { longContext: deps.longContext },
    ...deps.reasoningEffort === undefined ? {} : { reasoningEffort: deps.reasoningEffort },
    pluginVersion: deps.version,
    checkedAt: nowMs,
  }
}

/** 回一份 JSON。 */
/** 回一份 JSON（动作路由共用）。 */
export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 注册状态路由。
 *
 * 返回一个 disposer，让调用方（`src/index.ts`）能随 fiber 释放而撤销注册。
 */
export function registerMiniMaxStatusRoute(
  ctx: MiniMaxStatusContext,
  deps: MiniMaxStatusDeps,
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: MINIMAX_STATUS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!isLoopbackRequest(req)) {
        json(res, 403, { error: 'origin-not-trusted' })
        return
      }
      try {
        json(res, 200, await buildMiniMaxStatus(deps))
      } catch (error: unknown) {
        // 兜底：这一层不该被走到（buildMiniMaxStatus 自己已经兜住了），
        // 但"状态路由 500"会让卡片什么都看不到，所以这里回一份**可读**的
        // 降级文档而不是错误体。
        const fallback = deps.routes[0]
        json(res, 200, {
          ok: false,
          route: fallback?.route ?? MINIMAX_STATUS_ROUTE,
          region: fallback?.region ?? 'cn',
          regionLabel: fallback?.regionLabel ?? '国内版',
          baseUrl: fallback?.baseUrl ?? '',
          login: { state: 'error', source: 'none', detail: safeMessage(error) },
          routes: [],
          models: toStatusModels(deps.models),
          ...deps.catalog === undefined ? {} : { catalog: toStatusModels(deps.catalog) },
          ...deps.enabledRegions === undefined ? {} : { enabledRegions: [...deps.enabledRegions] },
          ...deps.modelOverrides === undefined ? {} : { modelOverrides: deps.modelOverrides },
          ...deps.longContext === undefined ? {} : { longContext: deps.longContext },
          ...deps.reasoningEffort === undefined ? {} : { reasoningEffort: deps.reasoningEffort },
          pluginVersion: deps.version,
          checkedAt: Date.now(),
        } satisfies MiniMaxStatusPayload)
      }
    },
  })
}
