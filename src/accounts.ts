/**
 * 账号副本：把"本机登录过的账号"镜像成插件自有的一份凭据，并在它不再是
 * MiniMax Code 的当前登录账号后，由插件自己续期。
 *
 * # 为什么需要它
 *
 * mcode 的凭据存储按**机器**而不是按账号分键：
 * `account = sha256(authHome + "\0" + clientId)`（见 mcode 的 `oauth-core/namespace.js`），
 * 所以同一区域里换一个账号登录，是**覆盖同一条记录**。也就是说 mcode 每区域
 * 只能留一个账号（国内 + 国际各一个）。
 *
 * # 为什么不能简单复制文件
 *
 * MiniMax 的 refresh token 是**一次性轮换**的：刷新会换发新的 RT，旧 RT 立刻失效
 * （实测：同一个 RT 再刷一次 → `400 invalid_grant`）。所以"复制一份凭据"等价于
 * **接管这个账号的刷新链**：
 *
 *  - 若副本对应的账号**已经不是** mcode 当前登录的账号 → 接管是安全的：
 *    mcode 不再持有它，不会有人跟插件抢这条链；
 *  - 若副本就是 mcode **正在用**的账号 → 插件一旦刷新，mcode 下一轮续期就会
 *    `invalid_grant`，用户被迫重新登录。所以这种情况**绝不接管**，只做镜像。
 *
 * 这条规则就是本模块的核心：镜像永远更新"跟随态"凭据，只有在该账号被换掉之后
 * 才把它标记成 `owned`（插件自持刷新链）。
 *
 * # 失效场景（诚实写在前面）
 *
 * mcode 自己一小时刷一次；插件镜像到的 RT 是"那一刻"的 RT。若 mcode 在切账号前
 * 又刷新过一次，而我们没来得及重新镜像，副本的 RT 就已经作废，接管时会拿到
 * `invalid_grant`。此时副本标记为 `dead` 并提示用户：在 mcode 里重新登录该账号，
 * 插件会自动镜像出新的副本。
 */
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { MiniMaxRegion } from './catalog.ts'

/** 存储文件版本；结构变化时递增并在读取时丢弃旧结构。 */
const STORE_VERSION = 1

/** 插件自有账号副本的存储文件名（放在 DSH home 下，和 trae 的 `.trae-auth.*` 同级）。 */
export const MINIMAX_ACCOUNTS_FILENAME = '.minimax-accounts.json'

/** 副本状态。`owned` = 插件自持刷新链；`expired` = access token 过期且尚未刷新；`dead` = RT 已作废。 */
export type MiniMaxAccountState = 'owned' | 'expired' | 'dead'

/** 一条账号副本。 */
export interface MiniMaxStoredAccount {
  /** 稳定 id：`<region>-<loginEpoch 前 8 位>`，路由名与存储键都用它。 */
  id: string
  region: MiniMaxRegion
  /** 展示名，例如 `副本 1`。 */
  label: string
  /** mcode 每次登录生成的 UUID；同一次登录的凭据共享它，换账号就换。 */
  loginEpoch: string
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  generation?: number
  /**
   * `false` = 仍在跟随 mcode（**不得**由插件刷新，否则会打断 mcode 的续期）；
   * `true` = mcode 已不持有该账号，刷新链归插件所有。
   */
  owned: boolean
  createdAtMs: number
  lastRefreshAtMs?: number
  /** 最近一次失败原因（`invalid_grant` 等），用于卡片提示。 */
  lastError?: string
}

/** 从 mcode 凭据文件里读出来的一次登录快照。 */
export interface MiniMaxLiveCredential {
  loginEpoch: string
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  generation?: number
}

/** 账号副本库的路径：`$DSH_HOME/.minimax-accounts.json`（缺省 `~/.dsh`）。 */
export function minimaxAccountsPath(): string {
  const home = process.env['DSH_HOME']?.trim()
  return join(home === undefined || home === '' ? join(homedir(), '.dsh') : home, MINIMAX_ACCOUNTS_FILENAME)
}

/** 读副本库；文件缺失、损坏、版本不符都当成空库（并丢弃不可用的条目）。 */
export async function readAccounts(path: string = minimaxAccountsPath()): Promise<MiniMaxStoredAccount[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const store = parsed as Record<string, unknown>
  if (store['schemaVersion'] !== STORE_VERSION) return []
  const list = store['accounts']
  if (!Array.isArray(list)) return []
  const accounts: MiniMaxStoredAccount[] = []
  for (const entry of list) {
    const account = normalizeAccount(entry)
    if (account !== undefined) accounts.push(account)
  }
  return accounts
}

/**
 * 同步读副本库（`apply()` 期用）。
 *
 * `apply()` 在 Cordis 里是同步的，而"要注册哪些副本路由"必须在那一刻定下来，
 * 所以这里补一个同步读。读失败一律当空库，绝不让插件因为一个坏文件起不来。
 */
export function readAccountsSync(path: string = minimaxAccountsPath()): MiniMaxStoredAccount[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const store = parsed as Record<string, unknown>
  if (store['schemaVersion'] !== STORE_VERSION) return []
  const list = store['accounts']
  if (!Array.isArray(list)) return []
  const accounts: MiniMaxStoredAccount[] = []
  for (const entry of list) {
    const account = normalizeAccount(entry)
    if (account !== undefined) accounts.push(account)
  }
  return accounts
}

/** 原子写入副本库（0600）；写失败不抛给调用方之外的地方 —— 它只影响"下次能不能续期"。 */
export async function writeAccounts(
  accounts: readonly MiniMaxStoredAccount[],
  path: string = minimaxAccountsPath(),
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  const payload = `${JSON.stringify({ schemaVersion: STORE_VERSION, accounts }, null, 2)}\n`
  await writeFile(temporary, payload, 'utf8')
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

/** 逐字段收窄，坏条目丢弃而不是让整个库失效。 */
function normalizeAccount(value: unknown): MiniMaxStoredAccount | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const id = stringOf(row['id'])
  const loginEpoch = stringOf(row['loginEpoch'])
  const accessToken = stringOf(row['accessToken'])
  const refreshToken = stringOf(row['refreshToken'])
  const region = row['region'] === 'global' ? 'global' : row['region'] === 'cn' ? 'cn' : undefined
  const expiresAtMs = numberOrUndefined(row['expiresAtMs'])
  if (id === undefined || loginEpoch === undefined || accessToken === undefined || refreshToken === undefined) return undefined
  if (region === undefined || expiresAtMs === undefined) return undefined
  return {
    id,
    region,
    label: stringOf(row['label']) ?? id,
    loginEpoch,
    accessToken,
    refreshToken,
    expiresAtMs,
    ...numberOrUndefined(row['generation']) === undefined ? {} : { generation: numberOrUndefined(row['generation'])! },
    owned: row['owned'] === true,
    createdAtMs: numberOrUndefined(row['createdAtMs']) ?? Date.now(),
    ...numberOrUndefined(row['lastRefreshAtMs']) === undefined
      ? {}
      : { lastRefreshAtMs: numberOrUndefined(row['lastRefreshAtMs'])! },
    ...stringOf(row['lastError']) === undefined ? {} : { lastError: stringOf(row['lastError'])! },
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 副本 id：区域 + loginEpoch 前 8 位（同一次登录稳定，换账号就换）。 */
export function accountIdOf(region: MiniMaxRegion, loginEpoch: string): string {
  return `${region}-${loginEpoch.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`
}

/** 副本的路由名：`minimax-cn-cfd703e1` 这种，稳定且可读。 */
export function accountRouteOf(account: Pick<MiniMaxStoredAccount, 'id'>): string {
  return `minimax-${account.id}`
}

/** 副本的显示名：模型选择器里的分组名。 */
export function accountDisplayNameOf(account: Pick<MiniMaxStoredAccount, 'id' | 'region' | 'label'>): string {
  return `${account.region === 'global' ? 'MiniMax Global' : 'MiniMax'} 副本 · ${account.label}`
}

/**
 * 把一次本机登录同步进副本库，并处理"换账号 → 旧副本接管"。
 *
 * @param accounts 现有副本（不会被就地修改，返回值是新数组）
 * @param live 刚从 mcode 凭据文件读到的当前登录
 * @param region 这次读的是哪个区域的登录态
 * @returns 同步后的副本列表与是否发生变化
 */
export function syncLiveAccount(
  accounts: readonly MiniMaxStoredAccount[],
  live: MiniMaxLiveCredential,
  region: MiniMaxRegion,
  nowMs: number = Date.now(),
): { accounts: MiniMaxStoredAccount[], changed: boolean } {
  const id = accountIdOf(region, live.loginEpoch)
  const next: MiniMaxStoredAccount[] = []
  let changed = false

  for (const account of accounts) {
    if (account.id !== id) {
      // 同一区域里、仍在跟随 mcode 的旧副本：这次登录换了账号 → 接管它的刷新链。
      const takeover = account.region === region && !account.owned && account.loginEpoch !== live.loginEpoch
      if (takeover) {
        changed = true
        next.push({ ...account, owned: true })
        continue
      }
      next.push(account)
      continue
    }
    // 同一次登录：只更新凭据本身，ownership 保持不变（mcode 仍持有它时绝不接管）。
    const updated: MiniMaxStoredAccount = {
      ...account,
      accessToken: live.accessToken,
      refreshToken: live.refreshToken,
      expiresAtMs: live.expiresAtMs,
      ...live.generation === undefined ? {} : { generation: live.generation },
    }
    if (
      updated.accessToken !== account.accessToken
      || updated.refreshToken !== account.refreshToken
      || updated.expiresAtMs !== account.expiresAtMs
      || updated.generation !== account.generation
    ) {
      changed = true
    }
    next.push(updated)
  }

  if (!accounts.some(account => account.id === id)) {
    const sameRegion = accounts.filter(account => account.region === region).length
    changed = true
    next.push({
      id,
      region,
      label: `副本 ${sameRegion + 1}`,
      loginEpoch: live.loginEpoch,
      accessToken: live.accessToken,
      refreshToken: live.refreshToken,
      expiresAtMs: live.expiresAtMs,
      ...live.generation === undefined ? {} : { generation: live.generation },
      owned: false,
      createdAtMs: nowMs,
    })
  }

  return { accounts: next, changed }
}

/** 一个区域的 OAuth 端点（与 mcode 的 `endpoint-config.js` 同一套）。 */
export function accountOriginOf(region: MiniMaxRegion): string {
  return region === 'global' ? 'https://account.minimax.io' : 'https://account.minimax.cn'
}

/** 副本当前状态（由凭据本身推导，不额外存字段）。 */
export function accountStateOf(account: MiniMaxStoredAccount, nowMs: number = Date.now()): MiniMaxAccountState {
  if (account.lastError !== undefined && /invalid_grant/.test(account.lastError)) return 'dead'
  return account.expiresAtMs > nowMs ? 'owned' : 'expired'
}

/** 刷新结果：成功给出新凭据，失败给出可读原因。 */
export type RefreshOutcome =
  | { ok: true, accessToken: string, refreshToken: string, expiresAtMs: number }
  | { ok: false, reason: string }

/**
 * 用副本自己的 refresh token 换一对新凭据。
 *
 * 这是 mcode 自己用的同一个授权：`grant_type=refresh_token` + `client_id=mcode-public`，
 * 没有设备签名也没有 client secret，所以插件可以独立完成。**注意 RT 是一次性的**：
 * 成功后必须把新 RT 写回副本库，否则下次续期就废了。
 */
export async function refreshAccountCredential(
  account: Pick<MiniMaxStoredAccount, 'region' | 'refreshToken'>,
  options: { fetchImpl?: typeof fetch, nowMs?: number } = {},
): Promise<RefreshOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch
  const nowMs = options.nowMs ?? Date.now()
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
    client_id: 'mcode-public',
    scope: 'agent.default',
    audience: 'agent-backend',
  })
  let response: Response
  try {
    response = await fetchImpl(`${accountOriginOf(account.region)}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    })
  } catch (error: unknown) {
    return { ok: false, reason: `网络错误：${error instanceof Error ? error.message : String(error)}` }
  }
  const text = await response.text()
  if (!response.ok) {
    // 服务端把"这条 RT 已经用过"也放在 400 里，原因字符串要原样带给用户看。
    return { ok: false, reason: `HTTP ${response.status}：${text.slice(0, 200)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: '刷新响应不是 JSON。' }
  }
  const payload = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  const accessToken = stringOf(payload['access_token'])
  const refreshToken = stringOf(payload['refresh_token'])
  const expiresInSec = typeof payload['expires_in'] === 'number' ? payload['expires_in'] : undefined
  if (accessToken === undefined || refreshToken === undefined || expiresInSec === undefined) {
    return { ok: false, reason: '刷新响应缺少 access_token / refresh_token / expires_in。' }
  }
  return { ok: true, accessToken, refreshToken, expiresAtMs: nowMs + expiresInSec * 1000 }
}
