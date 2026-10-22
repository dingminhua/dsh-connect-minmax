/**
 * 账号池：同一区域里同时持有多个账号，并在**当前账号积分耗尽**时自动换一个。
 *
 * # 它解决什么
 *
 * MiniMax Code 的凭据库按机器分键（`sha256(authHome + clientId)`），所以客户端
 * 每区域只能留一个账号——换号登录会覆盖同一条记录。本插件把每次登录过的账号
 * 镜像成自有副本（见 `accounts.ts`），于是"池"本身是可能存在的；这里解决的是
 * **怎么在它们之间选**，而不是怎么存。
 *
 * # 两条判定，一条优先于另一条
 *
 *  1. **主动**：余额是我们自己读得到的（`credits.ts` 的 `op_credit_summary`，
 *     实测可用）。请求前就知道哪个号没钱，直接跳过——不浪费一次失败的请求。
 *  2. **被动**：上游回了配额类错误（`QUOTA`）时，把当前账号标记成耗尽并换号重试。
 *     这是兜底：余额读取会失败（网络、缓存过期），而且"余额够但请求被拒"也可能
 *     发生（并发消耗）。
 *
 * 被动那条只在**尚未输出任何 chunk** 时重试——已经流给用户的内容撤不回来。
 *
 * # 为什么"当前账号"优先而不是"余额最多的"
 *
 * 稳定优先。每次请求都按余额排序会让同一个会话在多个账号之间来回跳，用户看到的
 * 额度、账单、日志都跟着漂。只有当当前账号不可用时才换，换完就钉在那里。
 */

import type { MiniMaxCredentialSource } from './auth.ts'
import type { MiniMaxRegion } from './catalog.ts'

/** 判定一个账号"已耗尽"后保持多久不再选它；到期自动重新可用，不需要额外干预。 */
export const DRAIN_TTL_MS = 10 * 60 * 1000

/** 池里一个候选账号的选择态（纯数据，便于单测）。 */
export interface PoolCandidate {
  /** 稳定标识：`live` 或副本 id。 */
  id: string
  /** 最近一次读到的剩余积分；`undefined` = 还没读到，不做判断。 */
  balance?: number
  /** 判定为耗尽的时间点；`undefined` = 不处于耗尽态。 */
  drainedUntilMs?: number
}

/**
 * 这个候选现在能不能用。
 *
 * 余额为 `undefined` 时**视为可用**：没读到不等于没钱，把它排掉只会让用户
 * 在一个本来能用的账号上看到"无可用账号"。
 *
 * @param candidate - 候选账号状态。
 * @param nowMs - 当前时间。
 * @returns 可用返回 `true`。
 */
export function isPoolAccountUsable(candidate: PoolCandidate, nowMs: number): boolean {
  if (candidate.drainedUntilMs !== undefined && candidate.drainedUntilMs > nowMs) return false
  if (candidate.balance !== undefined && candidate.balance <= 0) return false
  return true
}

/**
 * 选出这次请求该用哪个账号。
 *
 * 顺序：当前账号（可用就用，保持稳定）→ 第一个可用的 → 全都不可用时回落当前账号。
 *
 * 最后的回落是有意的：池里一个可用的都没有时，我们**不编造**一个"无可用账号"
 * 错误，而是让请求照常发出去，由上游给出真实原因（可能余额刚好到账，也可能
 * 是别的问题）。插件不该替服务端下结论。
 *
 * @param candidates - 按优先级排列的候选。
 * @param activeId - 当前选中的账号 id。
 * @param nowMs - 当前时间。
 * @returns 选中的候选；候选为空时返回 `undefined`。
 */
export function pickPoolAccount(
  candidates: readonly PoolCandidate[],
  activeId: string | undefined,
  nowMs: number,
): PoolCandidate | undefined {
  if (candidates.length === 0) return undefined
  const active = candidates.find(candidate => candidate.id === activeId)
  if (active !== undefined && isPoolAccountUsable(active, nowMs)) return active
  const usable = candidates.find(candidate => isPoolAccountUsable(candidate, nowMs))
  return usable ?? active ?? candidates[0]
}

/** 状态卡片要展示的一个池内账号。 */
export interface PoolSnapshotEntry {
  /** 稳定标识。 */
  id: string
  /** 展示名。 */
  label: string
  /** 是否本机登录。 */
  live: boolean
  /** 是否当前生效账号。 */
  active: boolean
  /** 最近读到的剩余积分；`undefined` = 还没读到。 */
  balance?: number
  /** 判定为积分耗尽的时间点；`undefined` = 不处于耗尽态。 */
  drainedUntilMs?: number
}

/** 池的快照：卡片据此展示"池里有哪些号、现在用哪个、谁没钱了"。 */
export interface PoolSnapshot {
  /** 按优先级排列。 */
  accounts: PoolSnapshotEntry[]
  /** 当前生效账号 id。 */
  active?: string
}

/** 池里一个账号：既是凭据来源，也带展示用的元信息。 */
export interface PoolAccount {
  /** 稳定标识：`live` 表示本机登录，其余是副本 id。 */
  id: string
  /** 展示名。 */
  label: string
  /** 凭据来源（本机登录或副本）。 */
  source: MiniMaxCredentialSource
  /** 是否本机登录（不是副本）。 */
  live: boolean
}

/**
 * 一个区域的账号池，本身也是一条 `MiniMaxCredentialSource`。
 *
 * 做成同形实现的意思是：路由、适配器、状态卡片都不需要知道背后是"一个账号"
 * 还是"一池账号"——它们看到的仍然是一个能产出 token 的东西。
 */
export class MiniMaxAccountPool implements MiniMaxCredentialSource {
  readonly region: MiniMaxRegion
  readonly regionLabel: string
  readonly baseUrl: string

  private accounts: PoolAccount[] = []
  private activeId: string | undefined
  private readonly states = new Map<string, PoolCandidate>()

  constructor(region: MiniMaxRegion, options: { regionLabel: string, baseUrl: string }) {
    this.region = region
    this.regionLabel = options.regionLabel
    this.baseUrl = options.baseUrl
  }

  /**
   * 替换池内账号（宿主重算账号列表时调用）。
   *
   * 保留已有账号的余额与耗尽态：换一批账号列表不代表余额变了，重算一次就要
   * 重新读一遍余额是浪费。被移除的账号状态一并丢弃，否则同名 id 复用时会把
   * 旧账算到新号头上。
   */
  setAccounts(accounts: readonly PoolAccount[]): void {
    this.accounts = [...accounts]
    const alive = new Set(accounts.map(account => account.id))
    for (const id of [...this.states.keys()]) {
      if (!alive.has(id)) this.states.delete(id)
    }
    if (this.activeId !== undefined && !alive.has(this.activeId)) this.activeId = undefined
    if (this.activeId === undefined) this.activeId = this.preferredFirst(accounts)
  }

  /** 池内账号（按优先级）。 */
  list(): readonly PoolAccount[] {
    return this.accounts
  }

  /** 当前选中的账号 id。 */
  get active(): string | undefined {
    return this.activeId
  }

  /** 每个账号的选择态（余额、耗尽时间），给状态卡片用。 */
  snapshot(): ReadonlyMap<string, PoolCandidate> {
    return new Map(this.states)
  }

  /**
   * 手动切换当前账号。
   *
   * @param id - 目标账号 id。
   * @returns 切换成功返回 `true`；池里没有这个 id 返回 `false`（不改状态）。
   */
  select(id: string): boolean {
    if (!this.accounts.some(account => account.id === id)) return false
    this.activeId = id
    return true
  }

  /**
   * 记录某账号最近一次读到的余额。
   *
   * 余额 > 0 时顺带清掉耗尽标记：钱到了就该立刻可用，不该等 TTL 到期。
   */
  reportBalance(id: string, balance: number, nowMs: number = Date.now()): void {
    const current = this.states.get(id) ?? { id }
    const next: PoolCandidate = { ...current, id, balance }
    if (balance > 0) delete next.drainedUntilMs
    this.states.set(id, next)
    void nowMs
  }

  /** 把某账号标记成耗尽（上游回了配额错误时调用）。 */
  markDrained(id: string, nowMs: number = Date.now()): void {
    const current = this.states.get(id) ?? { id }
    this.states.set(id, { ...current, id, drainedUntilMs: nowMs + DRAIN_TTL_MS })
  }

  /**
   * 换到池里另一个可用账号。
   *
   * @param nowMs - 当前时间。
   * @returns 换成了返回 `true`；没有别的不处于耗尽态的账号则返回 `false`。
   */
  switchAway(nowMs: number = Date.now()): boolean {
    const currentId = this.activeId
    if (currentId !== undefined) this.markDrained(currentId, nowMs)
    const next = this.accounts.find(account => account.id !== currentId
      && isPoolAccountUsable(this.candidateOf(account.id), nowMs))
    if (next === undefined) return false
    this.activeId = next.id
    return true
  }

  /**
   * 取一个能用的 token：先试当前账号，失败再顺次试其它账号。
   *
   * 这里的"失败"指**凭据层**失败（副本的 RT 已作废、本机登录过期），不是上游
   * 配额失败——配额只在上游请求时才知道，由 `guardStream` 处理。
   */
  async token(signal?: AbortSignal): Promise<string> {
    const picked = pickPoolAccount(
      this.accounts.map(account => this.candidateOf(account.id)),
      this.activeId,
      Date.now(),
    )
    if (picked === undefined) throw new Error('账号池为空：没有可用的 MiniMax 账号。')

    // 先试选中的那个，再按池内顺序试其余——凭据层失败常常是单账号的（RT 作废）。
    const order = [
      picked.id,
      ...this.accounts.map(account => account.id).filter(id => id !== picked.id),
    ]
    let lastError: unknown
    for (const id of order) {
      const account = this.accounts.find(entry => entry.id === id)
      if (account === undefined) continue
      try {
        const token = await account.source.token(signal)
        // 谁真的产出了 token，谁就是当前账号——下次请求直接用它。
        this.activeId = id
        return token
      } catch (error) {
        if (signal?.aborted === true) throw error
        lastError = error
      }
    }
    throw lastError ?? new Error('账号池里没有能产出 token 的账号。')
  }

  /** 生成状态卡片用的快照。 */
  describe(nowMs: number = Date.now()): PoolSnapshot {
    return {
      accounts: this.accounts.map((account) => {
        const state = this.candidateOf(account.id)
        const drained = state.drainedUntilMs !== undefined && state.drainedUntilMs > nowMs
        return {
          id: account.id,
          label: account.label,
          live: account.live,
          active: account.id === this.activeId,
          ...state.balance === undefined ? {} : { balance: state.balance },
          ...drained ? { drainedUntilMs: state.drainedUntilMs } : {},
        }
      }),
      ...this.activeId === undefined ? {} : { active: this.activeId },
    }
  }

  /** 清空当前账号的缓存（401 之后由适配器调用）。 */
  invalidate(): void {
    for (const account of this.accounts) account.source.invalidate()
  }

  private candidateOf(id: string): PoolCandidate {
    return this.states.get(id) ?? { id }
  }

  private preferredFirst(accounts: readonly PoolAccount[]): string | undefined {
    // 本机登录优先：它由 mcode 负责续期，最省事；副本是兜底。
    return accounts.find(account => account.live)?.id ?? accounts[0]?.id
  }
}
