/**
 * MiniMax 登录态读取（**只读，绝不写 `~/.minimax`**）。
 *
 * 两条通路，按优先级（设计 §2）：
 *  1. Auth Lease Broker —— mcode 运行时提供的租约服务。由 mcode 负责刷新，
 *     插件零维护、零副作用；`minValidityMs: 60000` 让 broker 在快过期时自己换新的。
 *  2. 本地凭据文件兜底 —— 直接读 `auth/<buildEnv>/<region>/mcode-public/auth.json`
 *     第一条 record 的 `accessToken`/`expiresAtMs`/`generation`，配合 `auth-state.json`
 *     的 `region`/`status`。**不刷新、不回写**（refreshToken 严格一次性轮换，
 *     乱刷会毁掉用户的 MiniMax Code 登录，见 docs/research/upstream.md §3.2）。
 *
 * token 缓存：内存 + 提前 60s 失效；401 时由 adapter 调 `invalidate()` 再取。
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { regionBaseUrl, type MiniMaxRegion } from './catalog.ts'
import { AuthLeaseClient, AuthLeaseError } from './lease.ts'

/** 凭据目录常量（与 mcode 的命名空间一致）。 */
const BUILD_ENV = 'prod'
const CLIENT_ID = 'mcode-public'
/** 区域目录名：cn 用 `cn`，国际版在凭据布局里用 `en`。 */
const REGION_DIR: Readonly<Record<MiniMaxRegion, string>> = { cn: 'cn', global: 'en' }

/** token 提前失效的余量。 */
const TOKEN_SKEW_MS = 60_000
/** 向 broker 索取租约时要求的最小剩余寿命。 */
const LEASE_MIN_VALIDITY_MS = 60_000

const BROKER_AUTHENTICATED = 'authenticated'
const BROKER_REFRESHING = 'refreshing'
const BROKER_ANONYMOUS = 'anonymous'
const BROKER_EXPIRED = 'expired'

/** 登录态分类。 */
export type MiniMaxLoginState = 'ready' | 'anonymous' | 'missing' | 'expired' | 'error'

/** 给状态卡片 / adapter 的登录态快照。 */
export interface MiniMaxLoginStatus {
  state: MiniMaxLoginState
  source: 'lease' | 'file' | 'none'
  generation?: number
  expiresAtMs?: number
  region: MiniMaxRegion
  detail?: string
}

/** 取不到可用凭据。`status` 附带当次探测结果，便于卡片直接展示。 */
export class MiniMaxAuthUnavailableError extends Error {
  readonly status: MiniMaxLoginStatus

  constructor(message: string, status: MiniMaxLoginStatus) {
    super(message)
    this.name = 'MiniMaxAuthUnavailableError'
    this.status = status
  }
}

/** 构造参数。`region` 为 `auto`/缺省时按磁盘上的 `auth-state.json` 判定。 */
export interface MiniMaxAuthOptions {
  dataDir?: string
  env?: NodeJS.ProcessEnv
  region?: 'auto' | MiniMaxRegion
}

interface CachedToken {
  accessToken: string
  expiresAtMs: number
  source: 'lease' | 'file'
}

/** 本地凭据文件里的第一条 record。 */
interface FileCredential {
  accessToken: string
  expiresAtMs: number
  generation?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readFiniteNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readInteger(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** `auth-state.json` 的 `region` 取值（历史上有 `en` / `global` 两种写法）。 */
function parseRegionValue(value: unknown): MiniMaxRegion | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'cn') return 'cn'
  if (normalized === 'en' || normalized === 'global') return 'global'
  return undefined
}

function homeDirFromEnv(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim()
  return home && home.length > 0 ? home : homedir()
}

/** 解析 dataDir：显式参数 > `DSH_MINIMAX_DATA_DIR` > `<home>/.minimax`。 */
function resolveDataDir(options: MiniMaxAuthOptions): string {
  const explicit = options.dataDir?.trim()
  if (explicit) return explicit
  const env = options.env ?? process.env
  const overridden = env.DSH_MINIMAX_DATA_DIR?.trim()
  if (overridden) return overridden
  return join(homeDirFromEnv(env), '.minimax')
}

/**
 * MiniMax 登录态。
 *
 * `region` / `baseUrl` / `regionLabel` 是同步只读属性，所以在构造时读一次
 * `auth-state.json`（mcode 只在登录/登出时改它，不会影响运行期）。
 */
export class MiniMaxAuth {
  /** 凭据根目录（默认 `~/.minimax`）。 */
  readonly dataDir: string
  /** 上游区域。 */
  readonly region: MiniMaxRegion
  /** 对应区域的托管 LLM base URL。 */
  readonly baseUrl: string
  /** 给 UI 的中文区域名。 */
  readonly regionLabel: string
  /** `auth.json` 路径（兜底通路）。 */
  readonly authJsonPath: string
  /** `auth-state.json` 路径。 */
  readonly authStatePath: string

  private readonly leaseClient: AuthLeaseClient
  private cached: CachedToken | undefined
  private lastError: string | undefined

  constructor(options: MiniMaxAuthOptions = {}) {
    this.dataDir = resolveDataDir(options)
    const layout = resolveLayout(this.dataDir, options.region ?? 'auto')
    this.region = layout.region
    this.baseUrl = regionBaseUrl(this.region)
    this.regionLabel = this.region === 'global' ? '国际版' : '国内版'
    this.authJsonPath = join(layout.dir, 'auth.json')
    this.authStatePath = join(layout.dir, 'auth-state.json')
    this.leaseClient = new AuthLeaseClient(this.dataDir)
  }

  /** 最近一次取凭据失败的描述（状态卡片用），成功后清空。 */
  get lastFailure(): string | undefined {
    return this.lastError
  }

  /**
   * 取一个可用 access token。
   *
   * 顺序：内存缓存 → broker 租约 → 本地文件（仅未过期）。全部失败抛
   * `MiniMaxAuthUnavailableError`，其 `status` 里带可展示的原因。
   */
  async token(signal?: AbortSignal): Promise<string> {
    const cached = this.readCache()
    if (cached) return cached.accessToken

    // 1) 首选：broker 租约（由 mcode 刷新，零副作用）。
    try {
      const lease = await this.leaseClient.lease(LEASE_MIN_VALIDITY_MS, signal)
      if (this.isUsable(lease.expiresAtMs)) {
        this.cached = {
          accessToken: lease.accessToken,
          expiresAtMs: lease.expiresAtMs,
          source: 'lease',
        }
        this.lastError = undefined
        return lease.accessToken
      }
      this.lastError = 'MiniMax Code 返回的登录态即将过期。'
    } catch (error) {
      this.lastError = describeError(error)
    }

    // 2) 兜底：只读本地凭据文件，且必须尚未过期。
    const credential = await this.readFileCredential()
    if (credential && this.isUsable(credential.expiresAtMs)) {
      this.cached = {
        accessToken: credential.accessToken,
        expiresAtMs: credential.expiresAtMs,
        source: 'file',
      }
      return credential.accessToken
    }

    const status = await this.inspect(signal)
    throw new MiniMaxAuthUnavailableError(unavailableMessage(status), status)
  }

  /**
   * 探测登录态。**不抛异常**：所有失败都折算成 `state: 'error' | 'missing'`，
   * 因为它服务于状态卡片（探测本身不该 500）。
   */
  async inspect(signal?: AbortSignal): Promise<MiniMaxLoginStatus> {
    try {
      if (await this.leaseClient.available()) {
        const status = await this.leaseClient.status(signal)
        return this.fromBrokerStatus(status)
      }
    } catch (error) {
      // broker 在但会话不可用 → 继续看文件；记录原因供 detail 使用。
      const reason = describeError(error)
      const fileStatus = await this.fromFile(reason)
      return fileStatus
    }
    return this.fromFile(undefined)
  }

  /** 清空缓存（401 后由 adapter 调用，下一次 `token()` 会重新 lease）。 */
  invalidate(): void {
    this.cached = undefined
    this.leaseClient.close()
  }

  private fromBrokerStatus(status: { status: string; generation: number; expiresAtMs?: number }): MiniMaxLoginStatus {
    const base: MiniMaxLoginStatus = {
      state: 'ready',
      source: 'lease',
      generation: status.generation,
      region: this.region,
      ...(status.expiresAtMs === undefined ? {} : { expiresAtMs: status.expiresAtMs }),
    }
    if (status.status === BROKER_AUTHENTICATED || status.status === BROKER_REFRESHING) {
      return base
    }
    if (status.status === BROKER_ANONYMOUS) {
      return { ...base, state: 'anonymous', detail: 'MiniMax Code 尚未登录。' }
    }
    if (status.status === BROKER_EXPIRED) {
      return { ...base, state: 'expired', detail: 'MiniMax Code 登录态已过期，请重新登录。' }
    }
    return { ...base, state: 'error', detail: `MiniMax Code 登录态为 ${status.status}。` }
  }

  /** 本地文件兜底探测；`brokerReason` 只在 broker 已尝试但失败时传入。 */
  private async fromFile(brokerReason: string | undefined): Promise<MiniMaxLoginStatus> {
    const state = this.readAuthStateSync()
    const credential = await this.readFileCredential()
    const region = this.region
    const withBroker = (status: MiniMaxLoginStatus): MiniMaxLoginStatus =>
      // 已经能用的凭据不该被 broker 的失败原因污染成告警；只在「不可用」时补充原因。
      brokerReason === undefined || status.detail !== undefined || status.state === 'ready'
        ? status
        : { ...status, detail: brokerReason }

    if (state === undefined && credential === undefined) {
      return withBroker({
        state: 'missing',
        source: 'none',
        region,
        detail: '未找到 MiniMax Code 登录态，请先打开 MiniMax Code 并登录。',
      })
    }
    if (state?.status === BROKER_ANONYMOUS) {
      return withBroker({
        state: 'anonymous',
        source: 'file',
        region,
        detail: 'MiniMax Code 当前处于未登录状态。',
      })
    }
    if (credential === undefined) {
      return withBroker({
        state: 'missing',
        source: 'none',
        region,
        detail: '本地凭据文件里没有可用的访问令牌。',
      })
    }
    const base: MiniMaxLoginStatus = {
      state: 'ready',
      source: 'file',
      region,
      expiresAtMs: credential.expiresAtMs,
      ...(credential.generation === undefined ? {} : { generation: credential.generation }),
    }
    if (!this.isUsable(credential.expiresAtMs)) {
      return withBroker({
        ...base,
        state: 'expired',
        detail: '本地访问令牌已过期，请在 MiniMax Code 中重新登录。',
      })
    }
    return withBroker(base)
  }

  /** `auth-state.json` 的同步读取（构造期判区域 + inspect 用）。 */
  private readAuthStateSync(): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.authStatePath, 'utf8'))
      return isRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /** 读 `auth.json` 第一条 record；任何结构问题都返回 `undefined`。 */
  private async readFileCredential(): Promise<FileCredential | undefined> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.authJsonPath, 'utf8'))
    } catch {
      return undefined
    }
    if (!isRecord(parsed)) return undefined
    const records = parsed['records']
    if (!isRecord(records)) return undefined
    const first = Object.values(records).find((entry) => isRecord(entry))
    if (!isRecord(first)) return undefined
    const accessToken = readString(first, 'accessToken')
    const expiresAtMs = readFiniteNumber(first, 'expiresAtMs')
    if (!accessToken || expiresAtMs === undefined) return undefined
    const generation = readInteger(first, 'generation')
    return generation === undefined ? { accessToken, expiresAtMs } : { accessToken, expiresAtMs, generation }
  }

  private readCache(): CachedToken | undefined {
    if (this.cached && this.isUsable(this.cached.expiresAtMs)) return this.cached
    this.cached = undefined
    return undefined
  }

  /** 剩余寿命必须严格大于提前量。 */
  private isUsable(expiresAtMs: number): boolean {
    return expiresAtMs - TOKEN_SKEW_MS > Date.now()
  }
}

function describeError(error: unknown): string {
  if (error instanceof AuthLeaseError) {
    switch (error.code) {
      case 'AUTH_REQUIRED':
        return 'MiniMax Code 需要重新登录。'
      case 'BROKER_UNAVAILABLE':
        return 'MiniMax Code 未运行或认证租约服务不可用。'
      case 'CAPABILITY_REJECTED':
        return 'MiniMax Code 认证凭据被拒绝，请重启 MiniMax Code。'
      default:
        return error.message
    }
  }
  return error instanceof Error ? error.message : String(error)
}

function unavailableMessage(status: MiniMaxLoginStatus): string {
  const detail = status.detail?.trim()
  const head = '取不到可用的 MiniMax 登录态'
  return detail ? `${head}：${detail}` : head
}

/**
 * 判定区域与凭据目录。
 *
 * 区域优先取 `auth-state.json.region`；没有状态文件时用目录名（`cn` / `en`）兜底。
 * mcode 不允许同时登录两个区域（`AUTH_DOMAIN_CONFLICT`），所以这里「先找到先用」。
 */
function resolveLayout(
  dataDir: string,
  requested: 'auto' | MiniMaxRegion,
): { region: MiniMaxRegion; dir: string } {
  const regionDir = (region: MiniMaxRegion): string =>
    join(dataDir, 'auth', BUILD_ENV, REGION_DIR[region], CLIENT_ID)

  if (requested !== 'auto') {
    return { region: requested, dir: regionDir(requested) }
  }

  const candidates: readonly MiniMaxRegion[] = ['cn', 'global']
  for (const candidate of candidates) {
    const dir = regionDir(candidate)
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, 'auth-state.json'), 'utf8'))
      const state = isRecord(raw) ? raw : undefined
      const region = parseRegionValue(state?.['region']) ?? candidate
      return { region, dir: regionDir(region) }
    } catch {
      // 这个区域没有状态文件，试下一个。
    }
  }
  return { region: 'cn', dir: regionDir('cn') }
}
