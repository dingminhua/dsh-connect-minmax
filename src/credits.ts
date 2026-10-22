/**
 * MiniMax Code 的账户接口：积分余额、批次到期、每日签到进度。
 *
 * # 为什么这些接口能做，而"模型清单刷新"不能
 *
 * 推理网关**没有** `GET /v1/models`（实测 `503 direct_route_not_configured`），所以模型目录只能来自
 * 本地 `~/.minimax/config.yaml` 的快照；但**账户域**是另一套接口，挂在 `matrix` 与 `minimax-cloud`
 * 两个前缀下，实测只带 `Authorization: Bearer <mmoat_…>` 就能通，**不需要**客户端那条 Matrix
 * 签名头（`yy` / `x-timestamp` / `x-signature`）。依据与真实响应见
 * `docs/research/upstream.md` §6.3。
 *
 * # 三条实测踩到的坑（都写进了实现）
 *
 *  1. 台账接口 `page_size` 太小会回 `50001 internal error`（`3` 失败、`20/100` 正常）→ 固定 100；
 *     翻页参数是 `page_number`，不是 `page`（`page` 会被接受然后忽略）。
 *  2. 余额必须读 `op_credit_summary.total_remaining_amount`：同响应里的 `total_remains_credit`
 *     与 `opcredit_balance` 在已迁移积分池的账号上恒为 `0`。
 *  3. `timezone_id` 是必需参数，且必须是 IANA 名字；缺失或传偏移量回 `1406010011`。
 *
 * # 单位
 *
 * 上游把金额类字段发成**字符串**（`"400.00"`），所以统一走 `amountOf()` 转换；不要用
 * `parseInt`——"400.00" 会被截成 400 是运气好，"0.5" 就变 0 了。
 */
import type { MiniMaxRegion } from './catalog.ts'

/** 账户接口所在的 host（与推理网关同一个域，路径前缀不同）。 */
export function creditsOriginOf(region: MiniMaxRegion): string {
  return region === 'global' ? 'https://agent.minimax.io' : 'https://agent.minimax.cn'
}

/** 签到进度要求的时区参数：IANA 名字，实测偏移量会被拒。 */
export const SIGNIN_TIMEZONE_ID = 'Asia/Shanghai'

/** 台账一次取多少笔：小于 ~20 会让上游回 50001，见文件头。 */
export const CREDIT_PAGE_SIZE = 100

/** 积分余额（单位：积分，不是钱）。 */
export interface MiniMaxCreditBalance {
  totalRemaining: number
  freeRemaining: number
  purchasedRemaining: number
}

/** 一笔按发放批次计的积分；每批有自己的到期日。 */
export interface MiniMaxCreditLot {
  /** 上游 `credit_type`：实测 1 = 购买、2 = 签到赠送。 */
  creditType: number
  grantedAmount: number
  remainingAmount: number
  consumedAmount: number
  grantedAtMs: number
  expireAtMs: number
}

/** 积分快照：余额 + 到期分布。 */
export interface MiniMaxCreditSnapshot {
  ok: boolean
  balance?: MiniMaxCreditBalance
  lots?: MiniMaxCreditLot[]
  /** 7 / 30 天内到期且**仍有余额**的积分合计。 */
  expiringIn7d?: number
  expiringIn30d?: number
  /** 最早一笔仍有余额的批次到期时间；"还剩多少"与"什么时候没了"是两个问题。 */
  earliestExpiryMs?: number
  /** 已用光批次的余额残留（实测过期批次会留下 -0.31 这类负值），仅诊断用。 */
  atMs: number
  error?: string
}

/**
 * 签到格子的状态（上游 `days[].status`）。
 *
 * 这是**四值**枚举，不是"已领 / 未领"两态：用 `status !== 3` 判可领会把"还没轮到"
 * （upcoming）和"这一天不发积分"（disabled）都当成可领，于是对着一格根本不能领的
 * 日子发 claim。取值依据：同类实现 `dsh-connect-minimaxcode/src/signin.ts` 的
 * `SIGNIN_DAY_STATUS`，并与本机实测响应对照（今天那格是 3 = 已领）。
 */
export const SIGNIN_DAY_STATUS = {
  /** 还没轮到这一天。 */
  upcoming: 1,
  /** 就是今天，且可以领。 */
  claimable: 2,
  /** 已领过。 */
  claimed: 3,
  /** 这一天不发积分。 */
  disabled: 4,
} as const

/** 领取结果（上游 `data.claim_result`）。 */
export const SIGNIN_CLAIM_RESULT = {
  /** 这次真的发了。 */
  credited: 1,
  /** 今天已经领过，什么都没发。 */
  alreadyClaimed: 2,
} as const

/** 七天一轮签到里的一天。 */
export interface MiniMaxSigninDay {
  dayNo: number
  points: number
  /** 见 {@link SIGNIN_DAY_STATUS}：1 未到 / 2 可领 / 3 已领 / 4 不发。 */
  status: number
  isToday: boolean
  bonusPoints: number
}

/** 签到进度。 */
export interface MiniMaxSigninStatus {
  ok: boolean
  scene?: number
  days: MiniMaxSigninDay[]
  /** 今天能不能领（上游说可领才允许发 claim）。 */
  claimableToday: boolean
  atMs: number
  error?: string
}

/** 可注入的依赖，便于单测与限流。 */
export interface MiniMaxCreditsDeps {
  fetchImpl?: typeof fetch
  nowMs?: number
  timeoutMs?: number
}

/** 一次账户接口调用的结果。 */
type FetchJson = { ok: true, body: Record<string, unknown> } | { ok: false, error: string }

/**
 * 打一次 MiniMax 的账户接口。
 *
 * 所有失败都收成 `{ok:false, error}`：账户接口是**附加信息**，它挂了不能影响模型通路，
 * 更不能把异常抛到状态路由外面。
 */
async function fetchJson(
  url: string,
  init: RequestInit,
  token: string,
  deps: MiniMaxCreditsDeps,
): Promise<FetchJson> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 8_000)
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined ?? {}),
      },
    })
    const text = await response.text()
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}：${text.slice(0, 160)}` }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, error: '响应不是 JSON。' }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: '响应不是对象。' }
    }
    const body = parsed as Record<string, unknown>
    // Matrix 系接口即使 HTTP 200 也可能在 body 里报错，必须看 base_resp.status_code。
    const baseResp = typeof body['base_resp'] === 'object' && body['base_resp'] !== null
      ? body['base_resp'] as Record<string, unknown>
      : undefined
    const statusCode = typeof baseResp?.['status_code'] === 'number' ? baseResp['status_code'] : 0
    if (statusCode !== 0) {
      return { ok: false, error: `status_code=${statusCode} ${String(baseResp?.['status_msg'] ?? '')}`.trim() }
    }
    return { ok: true, body }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 上游把金额发成字符串；`Number` 而不是 `parseInt`（"0.5" 会被截成 0）。 */
function amountOf(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value !== 'string') return 0
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 同上，但保留"没有这个字段"与"字段是 0"的区别。 */
function numberOfOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * 读积分余额。
 *
 * `body` 传 `{}` 就够——不需要 `workspace_id`（实测）；字段取 `op_credit_summary`，
 * 理由见文件头第 2 条。
 */
export async function fetchCreditBalance(
  region: MiniMaxRegion,
  token: string,
  deps: MiniMaxCreditsDeps = {},
): Promise<{ ok: boolean, balance?: MiniMaxCreditBalance, error?: string }> {
  const result = await fetchJson(
    `${creditsOriginOf(region)}/matrix/api/v1/commerce/get_membership_info`,
    { method: 'POST', body: '{}' },
    token,
    deps,
  )
  if (!result.ok) return { ok: false, error: result.error }
  const record = result.body
  const summary = recordOf(record['op_credit_summary'])
  const total = summary === undefined ? undefined : numberOfOrUndefined(summary['total_remaining_amount'])
  if (summary !== undefined && total !== undefined) {
    // 免费/购买这一拆在上游是可选的：全是赠送的账号就没有购买那一半。
    const purchased = numberOfOrUndefined(summary['purchased_remaining_amount']) ?? 0
    return {
      ok: true,
      balance: {
        totalRemaining: total,
        purchasedRemaining: purchased,
        freeRemaining: numberOfOrUndefined(summary['free_remaining_amount']) ?? total - purchased,
      },
    }
  }
  // 扁平字段是旧账号视图：已迁移到积分池的账号上它恒为 0，所以**只在 summary 缺席时**才用。
  const flat = numberOfOrUndefined(record['opcredit_balance']) ?? numberOfOrUndefined(record['total_remains_credit'])
  if (flat === undefined) return { ok: false, error: '响应里没有可用的余额字段。' }
  return { ok: true, balance: { totalRemaining: flat, freeRemaining: flat, purchasedRemaining: 0 } }
}

/**
 * 读积分台账（按笔发放的批次）。
 *
 * 只取第一页：批次数量级是几十笔，一页 100 条足够覆盖，且 `page_size` 过小会让上游 500。
 */
export async function fetchCreditLots(
  region: MiniMaxRegion,
  token: string,
  deps: MiniMaxCreditsDeps = {},
): Promise<{ ok: boolean, lots?: MiniMaxCreditLot[], error?: string }> {
  const result = await fetchJson(
    `${creditsOriginOf(region)}/minimax-cloud/api/v1/credit/details`
    + `?page_number=1&page_size=${CREDIT_PAGE_SIZE}`,
    { method: 'GET' },
    token,
    deps,
  )
  if (!result.ok) return { ok: false, error: result.error }
  const raw = result.body['details']
  if (!Array.isArray(raw)) return { ok: false, error: '响应里没有 details 数组。' }
  const lots: MiniMaxCreditLot[] = []
  for (const entry of raw) {
    const lot = recordOf(entry)
    if (lot === undefined) continue
    lots.push({
      creditType: numberOf(lot['credit_type']),
      grantedAmount: amountOf(lot['granted_amount']),
      remainingAmount: amountOf(lot['remaining_amount']),
      consumedAmount: amountOf(lot['consumed_amount']),
      grantedAtMs: numberOf(lot['granted_at_ms']),
      expireAtMs: numberOf(lot['expire_at_ms']),
    })
  }
  return { ok: true, lots }
}

/**
 * 把余额与台账合成一份快照。
 *
 * 到期统计**只算仍有余额的批次**：已发放但用光的批次到期时并没有东西可损失，把它们算进去
 * 会让每个账号都看起来"快过期了"。同时给出最早到期时间——积分近似先进先出，所以
 * "7 天内到期"的金额常常是 0，那才是真正有意义的信号。
 */
export function buildCreditSnapshot(
  balance: MiniMaxCreditBalance | undefined,
  lots: readonly MiniMaxCreditLot[] | undefined,
  nowMs: number = Date.now(),
): MiniMaxCreditSnapshot {
  const dayMs = 86_400_000
  const live = (lots ?? []).filter(lot => lot.remainingAmount > 0)
  let expiringIn7d = 0
  let expiringIn30d = 0
  let earliestExpiryMs: number | undefined
  for (const lot of live) {
    if (lot.expireAtMs <= nowMs) continue
    if (lot.expireAtMs <= nowMs + 7 * dayMs) expiringIn7d += lot.remainingAmount
    if (lot.expireAtMs <= nowMs + 30 * dayMs) expiringIn30d += lot.remainingAmount
    if (earliestExpiryMs === undefined || lot.expireAtMs < earliestExpiryMs) earliestExpiryMs = lot.expireAtMs
  }
  return {
    ok: balance !== undefined,
    ...balance === undefined ? {} : { balance },
    ...lots === undefined ? {} : { lots: [...lots] },
    expiringIn7d: round2(expiringIn7d),
    expiringIn30d: round2(expiringIn30d),
    ...earliestExpiryMs === undefined ? {} : { earliestExpiryMs },
    atMs: nowMs,
    ...(balance === undefined ? { error: '积分余额读取失败。' } : {}),
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 读七天一签的进度。 */
export async function fetchSigninStatus(
  region: MiniMaxRegion,
  token: string,
  deps: MiniMaxCreditsDeps = {},
): Promise<MiniMaxSigninStatus> {
  const atMs = deps.nowMs ?? Date.now()
  const result = await fetchJson(
    `${creditsOriginOf(region)}/minimax-cloud/api/v1/signin/status?timezone_id=${SIGNIN_TIMEZONE_ID}`,
    { method: 'GET' },
    token,
    deps,
  )
  if (!result.ok) return { ok: false, days: [], claimableToday: false, atMs, error: result.error }
  const data = recordOf(result.body['data'])
  const rawDays = Array.isArray(data?.['days']) ? data?.['days'] : []
  const days: MiniMaxSigninDay[] = []
  for (const entry of rawDays) {
    const day = recordOf(entry)
    if (day === undefined) continue
    days.push({
      dayNo: numberOf(day['day_no']),
      points: numberOf(day['points']),
      status: numberOf(day['status']),
      isToday: day['is_today'] === true,
      bonusPoints: numberOf(day['bonus_points']),
    })
  }
  const today = days.find(day => day.isToday)
  return {
    ok: true,
    ...typeof data?.['scene'] === 'number' ? { scene: data['scene'] } : {},
    days,
    // 只有上游明确说"今天这一格可以领"才允许发 claim：status 是四值枚举，
    // 用"不是已领"来判会把还没轮到 / 不发积分的日子也判成可领。
    claimableToday: today?.status === SIGNIN_DAY_STATUS.claimable,
    atMs,
  }
}

/**
 * 领取当天的签到额度。
 *
 * 这是本模块**唯一**会改变账户状态的调用，因此：
 *  - 只在调用方明确要求时执行（卡片上的按钮），绝不自动发；
 *  - 必须先 `fetchSigninStatus` 确认 `claimableToday`，服务端说不可以领就不发请求；
 *  - 按天幂等：当天重复领上游回 `claim_result: 2`（今日已领），不会重复发放。
 */
export async function claimSignin(
  region: MiniMaxRegion,
  token: string,
  deps: MiniMaxCreditsDeps = {},
): Promise<{ ok: boolean, claimed: boolean, message?: string }> {
  const result = await fetchJson(
    `${creditsOriginOf(region)}/minimax-cloud/api/v1/signin/claim?timezone_id=${SIGNIN_TIMEZONE_ID}`,
    { method: 'POST', body: '{}' },
    token,
    deps,
  )
  if (!result.ok) return { ok: false, claimed: false, message: result.error }
  const data = recordOf(result.body['data'])
  const claimResult = numberOf(data?.['claim_result'])
  const points = numberOf(data?.['points'])
  // 上游用 claim_result 区分"这次真的发了"与"今天早就领过了"。
  if (claimResult === SIGNIN_CLAIM_RESULT.alreadyClaimed) {
    return { ok: true, claimed: false, message: '今天已经领过了。' }
  }
  return { ok: true, claimed: true, ...points > 0 ? { message: `已领取 ${points} 积分。` } : {} }
}
