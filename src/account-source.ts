/**
 * 账号副本的凭据来源：一个「mcode 已经不再持有」的账号，由插件自己续期。
 *
 * 与 `MiniMaxAuth` 的区别只有一个：token 不是从 broker/本机凭据文件现取的，
 * 而是从插件自己的副本库读、过期就用副本自己的 refresh token 换新的。
 *
 * **并发安全很重要**：refresh token 是一次性的，两个并发请求同时去刷新，
 * 一个成功、另一个必然 `invalid_grant`，而失败的这次会把新 RT 覆盖成旧的，
 * 直接毁掉整条刷新链。所以同一个账号的刷新必须串行：本模块用一张
 * "进行中的 promise 表"做进程内互斥，并把刷新结果落盘后才返回。
 */
import {
  accountStateOf,
  readAccounts,
  refreshAccountCredential,
  writeAccounts,
  type MiniMaxAccountState,
  type MiniMaxStoredAccount,
} from './accounts.ts'
import type { MiniMaxCredentialSource } from './auth.ts'
import { regionBaseUrl, regionLabelOf, type MiniMaxRegion } from './catalog.ts'

/** 提前多久续期（和 `MiniMaxAuth` 的 TOKEN_SKEW_MS 保持一致）。 */
const REFRESH_SKEW_MS = 60_000

/** 进行中的刷新：同一账号的并发请求共用同一个 promise。 */
const inflight = new Map<string, Promise<string>>()

/** 一次刷新失败（RT 作废、网络失败），带上可读原因。 */
export class MiniMaxAccountUnavailableError extends Error {
  constructor(readonly accountId: string, readonly reason: string) {
    super(`MiniMax 账号副本 ${accountId} 不可用：${reason}`)
    this.name = 'MiniMaxAccountUnavailableError'
  }
}

/** 副本的只读状态，供状态路由投影。 */
export interface MiniMaxAccountStatus {
  id: string
  region: MiniMaxRegion
  regionLabel: string
  label: string
  state: MiniMaxAccountState
  expiresAtMs: number
  detail?: string
}

/**
 * 一个账号副本的凭据来源。
 *
 * 实现 `MiniMaxCredentialSource`，因此可以原样喂给 `createMiniMaxProvider` /
 * `MiniMaxAdapter`——适配器不需要知道 token 是"本机登录"还是"插件副本"。
 */
export class MiniMaxAccountSource implements MiniMaxCredentialSource {
  readonly region: MiniMaxRegion
  readonly regionLabel: string
  readonly baseUrl: string

  constructor(
    readonly accountId: string,
    region: MiniMaxRegion,
    options: { baseUrl?: string } = {},
  ) {
    this.region = region
    this.regionLabel = regionLabelOf(region)
    this.baseUrl = options.baseUrl ?? regionBaseUrl(region)
  }

  /** 当前 token；过期则用副本自己的 RT 续期（同账号并发只刷新一次）。 */
  async token(signal?: AbortSignal): Promise<string> {
    const account = await this.entry()
    if (account === undefined) {
      throw new MiniMaxAccountUnavailableError(this.accountId, '副本已不存在（可能被删除）。')
    }
    if (account.expiresAtMs - REFRESH_SKEW_MS > Date.now()) return account.accessToken
    return this.refresh(account, signal)
  }

  /** 401 之后由适配器调用：丢掉仍在有效期内的旧 token，下次请求强制续期。 */
  invalidate(): void {
    // 副本没有内存缓存：每次都从库里读最新值，所以这里只需要作废"还能用"的判断。
    inflight.delete(this.accountId)
  }

  /** 状态投影用的只读快照。 */
  async status(): Promise<MiniMaxAccountStatus | undefined> {
    const account = await this.entry()
    if (account === undefined) return undefined
    const state = accountStateOf(account)
    return {
      id: account.id,
      region: account.region,
      regionLabel: this.regionLabel,
      label: account.label,
      state,
      expiresAtMs: account.expiresAtMs,
      ...account.lastError === undefined || state !== 'dead' ? {} : { detail: account.lastError },
    }
  }

  private async entry(): Promise<MiniMaxStoredAccount | undefined> {
    const accounts = await readAccounts()
    return accounts.find(account => account.id === this.accountId)
  }

  private async refresh(account: MiniMaxStoredAccount, signal?: AbortSignal): Promise<string> {
    const existing = inflight.get(this.accountId)
    if (existing !== undefined) return existing

    const task = (async (): Promise<string> => {
      signal?.throwIfAborted()
      // 进锁后再读一次库：另一个进程（或上一次刷新）可能已经写过新 RT。
      const fresh = await this.entry() ?? account
      if (fresh.expiresAtMs - REFRESH_SKEW_MS > Date.now()) return fresh.accessToken

      const outcome = await refreshAccountCredential(fresh)
      if (!outcome.ok) {
        await this.markError(fresh, outcome.reason)
        throw new MiniMaxAccountUnavailableError(this.accountId, outcome.reason)
      }
      await this.commit(fresh, outcome)
      return outcome.accessToken
    })()

    inflight.set(this.accountId, task)
    try {
      return await task
    } finally {
      inflight.delete(this.accountId)
    }
  }

  /** 把新凭据写回库（新 RT 必须落盘，否则下一次续期就废了）。 */
  private async commit(
    account: MiniMaxStoredAccount,
    outcome: { accessToken: string, refreshToken: string, expiresAtMs: number },
  ): Promise<void> {
    const accounts = await readAccounts()
    const next: MiniMaxStoredAccount[] = accounts.map((entry) => {
      if (entry.id !== account.id) return entry
      // 刷新成功即清空上一次的失败原因：`lastError` 是"可选"，删掉就是清空。
      const { lastError: _dropped, ...rest } = entry
      void _dropped
      return {
        ...rest,
        accessToken: outcome.accessToken,
        refreshToken: outcome.refreshToken,
        expiresAtMs: outcome.expiresAtMs,
        lastRefreshAtMs: Date.now(),
      }
    })
    await writeAccounts(next)
  }

  /** 记下失败原因，让卡片能说清楚"为什么要重新登录"。 */
  private async markError(account: MiniMaxStoredAccount, reason: string): Promise<void> {
    const accounts = await readAccounts()
    const next = accounts.map((entry): MiniMaxStoredAccount =>
      entry.id === account.id ? { ...entry, lastError: reason } : entry)
    await writeAccounts(next)
  }
}

/** 测试用：清掉进程内的刷新互斥表。 */
export function resetAccountInflight(): void {
  inflight.clear()
}

/** 读副本库里的全部副本（供 `apply()` 与状态路由使用）。 */
export async function listStoredAccounts(): Promise<MiniMaxStoredAccount[]> {
  return readAccounts()
}
