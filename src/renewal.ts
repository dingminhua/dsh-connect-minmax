/**
 * 活凭据自续期：MiniMax Code 关着时，插件自己执行 refresh_token grant。
 *
 * # 为什么必须有这个模块
 *
 * access token 只活 1 小时，而**没有任何其他东西**会在 mcode 之外续它：关掉
 * 桌面客户端后，过期的第一个请求就是 401，记录里躺着一个完全可用的
 * refreshToken 无人问津（VICqiufeeng/dsh-minimax-connect 的实测结论，本仓库
 * 沿用同一套协议并逐条注释了原因）。
 *
 * # 为什么写回 ~/.minimax 是必须的，而不是存插件自己的库
 *
 * refresh token 一次性轮换：插件刷一次，mcode 文件里那个旧 RT 立刻作废。只把
 * 新凭据存插件库里、不回写，用户下次打开 MiniMax Code 就会拿死 RT 去续 →
 * invalid_grant → 登录当场被打断。所以新的一对**必须**落回原文件。
 *
 * # 与官方客户端共存的协议（四步，缺一即事故）
 *
 *  1. **抢官方同款磁盘锁**。客户端用 proper-lockfile 在 `auth.lock` 上串行化
 *     续期；插件解析不到那个模块，就复刻同一套 on-disk 约定：锁是名为
 *     `auth.lock.lock` 的**目录**，`mkdir` 原子抢占，超过 30 秒按陈旧回收
 *     （与客户端的 staleMs 一致，互不偷锁）。两个进程抢同一个一次性 RT 时，
 *     第二个会被服务端当重放、**整族 token 作废**——实测过，代价是重新登录。
 *  2. **锁内重读，采纳更新的代际**。等锁期间别人可能已经轮换过了；那时采纳
 *     那对更新的，而不是花掉自己手里已经死掉的 RT。
 *  3. **原子写回**。临时文件 + rename，客户端不会读到写了一半的记录。
 *  4. **同步推进 auth-state.json 的 generation**。客户端 readUsableCredential
 *     要求 `credential.generation === state.generation`，不一致就当未登录。
 *     新代际取 `max(state, credential) + 1`——只用凭据自己的计数器，可能写回
 *     一个**低于** state 的值，把账号锁在自己的新 token 外面（off-by-one）。
 *
 * # 失败语义
 *
 * 一律回 `{ ok: false, reason, fatal? }`，**不抛异常**：调用方继续用盘上已有
 * 的 token。`fatal` 只标一种永久失败：`invalid_grant`（RT 本身没了），此时只有
 * 重新登录能把这个号救回来。
 *
 * @module dsh-connect-minmax/renewal
 */
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { accountOriginOf } from './accounts.ts'
import type { MiniMaxRegion } from './catalog.ts'

/** 提前多久续期：不让任何一条流开在一个正在死掉的 token 上。 */
export const RENEW_MARGIN_MS = 5 * 60_000
/** 巡检间隔：除按需触发外的第二道保险。 */
export const RENEW_PATROL_MS = 60_000
/** 被拒后的退避：不拿死 RT 反复打 grant。 */
export const RENEW_BACKOFF_MS = 5 * 60_000
/** 与客户端一致的陈旧锁回收窗口。 */
const AUTH_LOCK_STALE_MS = 30_000
/** 宁可放弃也不把请求永远堵在一个卡死的持锁者后面。 */
const AUTH_LOCK_WAIT_MS = 20_000
const AUTH_LOCK_POLL_MS = 60

const OAUTH_CLIENT_ID = 'mcode-public'
const OAUTH_SCOPE = 'agent.default'
const OAUTH_AUDIENCE = 'agent-backend'

/** 一次续期的结果。`adopted` = 等锁期间别人已续好，采纳了那一对。 */
export interface RenewOutcome {
  ok: boolean
  adopted?: boolean
  expiresAtMs?: number
  generation?: number
  reason?: string
  fatal?: boolean
  contended?: boolean
}

/** 卡片要展示的续期状态。 */
export interface RenewalStatusView {
  state: 'enabled' | 'renewing' | 'paused' | 'fatal' | 'off'
  /** paused 时：下次尝试的时刻。 */
  retryAtMs?: number
  /** 最近一次失败的描述（fatal/paused 时给）。 */
  reason?: string
  /** 当前盘上凭据的到期时刻。 */
  expiresAtMs?: number
}

/** `auth.json` 里的一条记录连同它的键（写回必须用原键）。 */
interface CredentialRecord {
  file: string
  key: string
  record: Record<string, unknown>
  parsed: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** 客户端的 namespace 把 `auth.lock` 放在 `auth.json` 旁边。 */
export function authLockPath(authFile: string): string {
  return join(dirname(authFile), 'auth.lock')
}

/**
 * 复刻官方客户端的跨进程锁。
 *
 * 锁是目录 `<lockPath>.lock`：`mkdir` 是原子抢占；目录年龄超过
 * {@link AUTH_LOCK_STALE_MS} 视为被遗弃、回收后重试；等待超过
 * {@link AUTH_LOCK_WAIT_MS} 就放弃（带 `contended`），绝不无限堵。
 */
export async function withAuthLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const directory = `${lockPath}.lock`
  const deadline = Date.now() + AUTH_LOCK_WAIT_MS
  let held = false
  while (!held) {
    try {
      await mkdir(directory)
      held = true
    } catch (error: unknown) {
      const code = (error as { code?: string }).code
      if (code !== 'EEXIST') throw error
      let ageMs = 0
      try {
        const info = await stat(directory)
        ageMs = Date.now() - info.mtimeMs
      } catch {
        continue // 在 mkdir 与 stat 之间被释放了：立刻重试
      }
      if (ageMs > AUTH_LOCK_STALE_MS) {
        try { await rmdir(directory) } catch { /* 别人先回收了 */ }
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`held by another process for ${Math.round(ageMs)}ms`)
      }
      await delay(AUTH_LOCK_POLL_MS)
    }
  }
  try {
    return await operation()
  } finally {
    try { await rmdir(directory) } catch { /* 已被按陈旧回收 */ }
  }
}

/** 读 `auth.json` 的第一条记录，连同它的键与整份文档。 */
export async function readCredentialRecord(authFile: string): Promise<CredentialRecord | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(authFile, 'utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed['records'])) return undefined
  for (const [key, entry] of Object.entries(parsed['records'])) {
    if (isRecord(entry)) return { file: authFile, key, record: entry, parsed }
  }
  return undefined
}

/** `auth-state.json` 当前宣告的代际；没有就是 0。 */
export function readAuthStateGeneration(authFile: string): number {
  try {
    // 同步读：续期路径在锁内，generation 必须在写回前一刻取，不能引入 await 间隙。
    const state = JSON.parse(readFileSync(join(dirname(authFile), 'auth-state.json'), 'utf8')) as unknown
    if (!isRecord(state)) return 0
    const generation = state['generation']
    return typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0 ? generation : 0
  } catch {
    return 0
  }
}

/**
 * 替换凭据该用的代际。
 *
 * 客户端算 `max(state.generation, credential.generation) + 1` 且拒绝两个文件
 * 不一致的对，所以只用凭据自己的计数器可能落在 state **之下**，把账号锁在
 * 自己的新 token 外面。
 */
export function nextGeneration(authFile: string, record: Record<string, unknown> | undefined): number {
  const fromState = readAuthStateGeneration(authFile)
  const raw = record?.['generation']
  const fromRecord = typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : 0
  return Math.max(fromState, fromRecord) + 1
}

/**
 * 让 `auth-state.json` 跟上刚写回的记录。
 *
 * 不是可选项：客户端要求两个文件的 generation 相等，否则读回"未登录"，把用户
 * 送去重新登录。
 */
export async function mirrorAuthState(authFile: string, record: Record<string, unknown>): Promise<void> {
  const stateFile = join(dirname(authFile), 'auth-state.json')
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as unknown
    if (!isRecord(state)) return
    await writeJsonAtomic(stateFile, {
      ...state,
      status: 'authenticated',
      generation: record['generation'],
      expiresAtMs: record['expiresAtMs'],
    })
  } catch {
    /* 没有伴随文件，或没有可改写的内容 */
  }
}

/** 原子写：临时文件 + rename，任何读者都不会看到写了一半的文档。 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * 用盘上的 refresh token 换一对新的，并按四步协议写回。
 *
 * 读、grant、写全部发生在客户端自己的锁内；记录在锁内**再读一次**（等锁期间
 * 别人可能已轮换，那就采纳更新的而不是花掉死 RT）。不抛异常。
 */
export async function renewCredential(authFile: string, nowMs: number = Date.now()): Promise<RenewOutcome> {
  const initial = await readCredentialRecord(authFile)
  if (initial === undefined) return { ok: false, reason: 'no credential record on disk' }
  const initialToken = initial.record['refreshToken']
  if (typeof initialToken !== 'string' || initialToken === '') {
    return { ok: false, reason: 'record carries no refreshToken', fatal: true }
  }
  // 锁外预检：还新鲜就直接返回，**不抢官方的锁**。巡检每 60 秒一次，若每次都
  // 进锁，等于每分钟和 mcode 抢一次锁——无谓的争用。
  const freshUntil = initial.record['expiresAtMs']
  if (typeof freshUntil === 'number' && freshUntil - nowMs > RENEW_MARGIN_MS) {
    const generation = initial.record['generation']
    return {
      ok: true,
      adopted: true,
      expiresAtMs: freshUntil,
      ...(typeof generation === 'number' ? { generation } : {}),
    }
  }
  try {
    return await withAuthLock(authLockPath(authFile), async () => {
      const current = await readCredentialRecord(authFile)
      if (current === undefined) return { ok: false, reason: 'credential record vanished while waiting for the lock' }
      const previous = current.record
      const expiresAt = previous['expiresAtMs']
      if (typeof expiresAt === 'number' && expiresAt - nowMs > RENEW_MARGIN_MS) {
        // 等锁期间别人已经续好了：采纳，不花自己的 RT。
        const generation = previous['generation']
        return {
          ok: true,
          adopted: true,
          expiresAtMs: expiresAt,
          ...(typeof generation === 'number' ? { generation } : {}),
        }
      }
      const refreshToken = previous['refreshToken']
      if (typeof refreshToken !== 'string' || refreshToken === '') {
        return { ok: false, reason: 'record carries no refreshToken', fatal: true }
      }
      let response: Response
      try {
        response = await fetch(`${accountOriginOf(regionOfAuthFile(authFile))}/oauth2/token`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: OAUTH_CLIENT_ID,
            scope: OAUTH_SCOPE,
            audience: OAUTH_AUDIENCE,
          }),
        })
      } catch (error: unknown) {
        return { ok: false, reason: `endpoint unreachable: ${String((error as { message?: string }).message ?? error)}` }
      }
      const text = await response.text()
      let grant: unknown
      try { grant = JSON.parse(text) } catch { grant = undefined }
      if (!response.ok || !isRecord(grant) || typeof grant['access_token'] !== 'string') {
        // fatal 只在 invalid_grant 时出现：其余拒绝（5xx、网络）是**可重试**的，
        // 显式带 fatal:false 会让调用方的 `fatal === undefined` 判断失效。
        const isFatal = isRecord(grant) && grant['error'] === 'invalid_grant'
        return {
          ok: false,
          reason: `grant refused: HTTP ${response.status} ${text.slice(0, 200)}`,
          ...(isFatal ? { fatal: true } : {}),
        }
      }
      const expiresIn = Number(grant['expires_in'])
      const record: Record<string, unknown> = {
        ...previous,
        accessToken: grant['access_token'],
        refreshToken: typeof grant['refresh_token'] === 'string' ? grant['refresh_token'] : refreshToken,
        tokenType: 'Bearer',
        clientId: OAUTH_CLIENT_ID,
        scopes: [OAUTH_SCOPE],
        audience: OAUTH_AUDIENCE,
        expiresAtMs: nowMs + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
        generation: nextGeneration(current.file, previous),
      }
      const payload: Record<string, unknown> = { ...current.parsed, records: { ...(isRecord(current.parsed['records']) ? current.parsed['records'] : {}), [current.key]: record } }
      try {
        await writeJsonAtomic(current.file, payload)
      } catch (error: unknown) {
        return { ok: false, reason: `renewed but could not be stored: ${String((error as { message?: string }).message ?? error)}` }
      }
      await mirrorAuthState(current.file, record)
      return { ok: true, expiresAtMs: record['expiresAtMs'] as number, generation: record['generation'] as number }
    })
  } catch (error: unknown) {
    return { ok: false, reason: `could not take the credential lock: ${String((error as { message?: string }).message ?? error)}`, contended: true }
  }
}

/**
 * 从路径判区域：`.../prod/cn/...` = 国内，`.../prod/en/...` = 国际。
 * 只用于选 token 端点的域；判不出时按国内（与默认布局一致）。
 */
function regionOfAuthFile(authFile: string): MiniMaxRegion {
  return authFile.includes(`${'prod'}/en/`) ? 'global' : 'cn'
}

/**
 * 活凭据的续期调度器：提前 5 分钟续 + 60 秒巡检；被拒退避 5 分钟。
 *
 * 一个区域一个实例。`start()` 之后巡检自转，`stop()` 随插件 fiber 拆除。
 */
export class LiveRenewal {
  private readonly authFile: string
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<RenewOutcome> | undefined
  private retryAtMs: number | undefined
  private lastReason: string | undefined
  private fatal = false
  private enabled: boolean

  constructor(authFile: string, enabled: boolean) {
    this.authFile = authFile
    this.enabled = enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.fatal = false
      this.lastReason = undefined
      this.retryAtMs = undefined
    }
  }

  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => { void this.ensure() }, RENEW_PATROL_MS)
  }

  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** 需要时续一次；并发调用共享同一次 grant。 */
  async ensure(): Promise<RenewOutcome> {
    if (!this.enabled) return { ok: false, reason: 'self renewal disabled' }
    if (this.fatal) return { ok: false, ...(this.lastReason === undefined ? {} : { reason: this.lastReason }), fatal: true }
    if (this.retryAtMs !== undefined && Date.now() < this.retryAtMs) {
      return { ok: false, ...(this.lastReason === undefined ? {} : { reason: this.lastReason }), contended: true }
    }
    if (this.inFlight !== undefined) return this.inFlight
    const attempt = renewCredential(this.authFile).then(result => {
      this.inFlight = undefined
      if (result.ok) {
        this.retryAtMs = undefined
        this.lastReason = undefined
        this.fatal = false
      } else if (result.fatal === true) {
        this.fatal = true
        this.lastReason = result.reason
      } else {
        this.retryAtMs = Date.now() + RENEW_BACKOFF_MS
        this.lastReason = result.reason
      }
      return result
    }, (error: unknown) => {
      this.inFlight = undefined
      this.retryAtMs = Date.now() + RENEW_BACKOFF_MS
      this.lastReason = String((error as { message?: string }).message ?? error)
      return { ok: false, reason: this.lastReason }
    })
    this.inFlight = attempt
    return attempt
  }

  /** 卡片展示用的状态。 */
  async status(): Promise<RenewalStatusView> {
    const record = await readCredentialRecord(this.authFile)
    const expiresAt = typeof record?.record['expiresAtMs'] === 'number'
      ? record.record['expiresAtMs'] as number
      : undefined
    if (!this.enabled) return { state: 'off', ...expiresAt === undefined ? {} : { expiresAtMs: expiresAt } }
    if (this.fatal) {
      return { state: 'fatal', ...this.lastReason === undefined ? {} : { reason: this.lastReason }, ...expiresAt === undefined ? {} : { expiresAtMs: expiresAt } }
    }
    if (this.inFlight !== undefined) {
      return { state: 'renewing', ...expiresAt === undefined ? {} : { expiresAtMs: expiresAt } }
    }
    if (this.retryAtMs !== undefined) {
      return { state: 'paused', retryAtMs: this.retryAtMs, ...this.lastReason === undefined ? {} : { reason: this.lastReason }, ...expiresAt === undefined ? {} : { expiresAtMs: expiresAt } }
    }
    return { state: 'enabled', ...expiresAt === undefined ? {} : { expiresAtMs: expiresAt } }
  }
}
