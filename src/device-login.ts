/**
 * 设备码登录：让插件**自己**得到一个账号，不依赖 MiniMax Code 桌面客户端。
 *
 * # 为什么这是多账号的正路
 *
 * 副本的凭据必须从出生起就**只归插件**（`owned: true`、独立刷新链）。把当前
 * 活凭据的 refresh token 抄一份出来做不到这一点：RT 一次性轮换，两个持有者
 * 抢同一个 token，第二个被服务端当重放、整族作废。设备码登录拿到的是一条
 * **全新的授权**，没有外部持有者，所以可以安全自续。
 *
 * # 与正在运行的 MiniMax Code 不冲突
 *
 * 上游文档警告"不要自己实现 device flow 去抢登录"，指的是和 mcode **正在进行**
 * 的登录抢同一个 namespace 租约。这里发起的是一条独立授权（独立 device_code /
 * 独立 token 族），不读也不写 `~/.minimax`，所以与 mcode 的任何状态都无交集。
 *
 * # 协议（docs/research/upstream.md §3.3，已实测）
 *
 *  1. `POST {account}/oauth2/device/code`，PKCE S256 **必填**：
 *     `code_verifier = base64url(randomBytes(32))`，
 *     `code_challenge = base64url(sha256(verifier))`。
 *  2. 应答给 `user_code` / `verification_uri` / `interval`（实测 3 秒）/
 *     `expires_in`（实测 300 秒）。用户开链接输码授权。
 *  3. 轮询 `POST {account}/oauth2/token`，
 *     `grant_type=urn:ietf:params:oauth:grant-type:device_code` + `code_verifier`。
 *     服务端在 body 里回 `status`：`pending` 继续等、`slow_down` 间隔 +5s、
 *     `denied`/`expired` 终止；也兼容标准 OAuth 错误码。
 *
 * 轮询由宿主后台按 interval 自转；卡片只读状态，不自己计时。
 *
 * @module dsh-connect-minmax/device-login
 */
import { createHash, randomBytes } from 'node:crypto'

import { accountOriginOf } from './accounts.ts'
import type { MiniMaxRegion } from './catalog.ts'

const CLIENT_ID = 'mcode-public'
const SCOPE = 'agent.default'
const AUDIENCE = 'agent-backend'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
/** slow_down 时按规范加 5 秒。 */
const SLOW_DOWN_EXTRA_MS = 5_000
/** 会话在终态后保留多久供卡片展示结果。 */
const TERMINAL_RETAIN_MS = 5 * 60_000

/** 一次设备码登录的对外状态。 */
export interface DeviceSessionView {
  id: string
  region: MiniMaxRegion
  state: 'pending' | 'authorized' | 'denied' | 'expired' | 'failed'
  /** 用户要在网页上输入的码。 */
  userCode?: string
  verificationUri?: string
  /** 会话过期时刻（超过就只能重新发起）。 */
  expiresAtMs: number
  /** 授权成功后落库的账号 id。 */
  accountId?: string
  reason?: string
}

interface DeviceSession extends DeviceSessionView {
  deviceCode: string
  codeVerifier: string
  intervalMs: number
  finishedAtMs?: number
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

/** 生成一对 PKCE 值；S256 是上游的硬性要求。 */
export function createPkcePair(): { verifier: string, challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier, 'ascii').digest())
  return { verifier, challenge }
}

/**
 * 设备码登录的会话管理器。
 *
 * 一个区域同时只允许一个 pending 会话（重复发起会替换旧的，避免两张 user_code
 * 同时摆在用户面前不知道该输哪个）。
 */
export class DeviceLoginManager {
  private readonly sessions = new Map<string, DeviceSession>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly onAuthorized: (region: MiniMaxRegion, credential: {
    accessToken: string
    refreshToken: string
    expiresAtMs: number
    loginEpoch: string
  }) => Promise<string | undefined>

  /**
   * @param onAuthorized - 授权成功后的落库回调；返回新账号 id（落库失败返回
   *   `undefined`，会话记为 failed）。由 index.ts 提供，避免这里反向依赖账号库。
   */
  constructor(onAuthorized: (region: MiniMaxRegion, credential: {
    accessToken: string
    refreshToken: string
    expiresAtMs: number
    loginEpoch: string
  }) => Promise<string | undefined>) {
    this.onAuthorized = onAuthorized
  }

  /** 发起一次设备码登录；同区域替换旧的 pending 会话。 */
  async start(region: MiniMaxRegion): Promise<DeviceSessionView> {
    for (const [id, session] of [...this.sessions]) {
      if (session.region === region && session.state === 'pending') this.cancel(id)
    }
    const { verifier, challenge } = createPkcePair()
    const response = await fetch(`${accountOriginOf(region)}/oauth2/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        scope: SCOPE,
        audience: AUDIENCE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    })
    if (!response.ok) {
      throw new Error(`设备码请求被拒：HTTP ${response.status}`)
    }
    const body = await response.json() as Record<string, unknown>
    const deviceCode = typeof body['device_code'] === 'string' ? body['device_code'] : undefined
    const userCode = typeof body['user_code'] === 'string' ? body['user_code'] : undefined
    const verificationUri = typeof body['verification_uri'] === 'string'
      ? body['verification_uri']
      : typeof body['verification_uri_complete'] === 'string' ? body['verification_uri_complete'] : undefined
    if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
      throw new Error('设备码应答缺少 device_code / user_code / verification_uri。')
    }
    const expiresIn = Number(body['expires_in'])
    const interval = Number(body['interval'])
    const session: DeviceSession = {
      id: base64url(randomBytes(9)),
      region,
      state: 'pending',
      userCode,
      verificationUri,
      expiresAtMs: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300) * 1000,
      deviceCode,
      codeVerifier: verifier,
      intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 3) * 1000,
    }
    this.sessions.set(session.id, session)
    this.schedule(session.id, session.intervalMs)
    return this.view(session)
  }

  /** 取消一个会话（用户点"取消"或发起新的）。 */
  cancel(id: string): void {
    const timer = this.timers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(id)
    this.sessions.delete(id)
  }

  /** 当前所有会话（含终态，供卡片展示最近一次结果）。 */
  list(): DeviceSessionView[] {
    const now = Date.now()
    for (const [id, session] of [...this.sessions]) {
      const terminal = session.state !== 'pending'
      if (terminal && session.finishedAtMs !== undefined && now - session.finishedAtMs > TERMINAL_RETAIN_MS) {
        this.sessions.delete(id)
      }
    }
    return [...this.sessions.values()].map(session => this.view(session))
  }

  /** 停掉所有定时器（插件 fiber 拆除时）。 */
  stopAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private view(session: DeviceSession): DeviceSessionView {
    const { deviceCode: _dc, codeVerifier: _cv, intervalMs: _iv, finishedAtMs: _fa, ...rest } = session
    void _dc
    void _cv
    void _iv
    void _fa
    return rest
  }

  private schedule(id: string, delayMs: number): void {
    const timer = setTimeout(() => { void this.poll(id) }, delayMs)
    this.timers.set(id, timer)
  }

  private finish(session: DeviceSession, state: DeviceSession['state'], reason?: string, accountId?: string): void {
    session.state = state
    session.finishedAtMs = Date.now()
    if (reason !== undefined) session.reason = reason
    if (accountId !== undefined) session.accountId = accountId
    const timer = this.timers.get(session.id)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(session.id)
  }

  private async poll(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (session === undefined || session.state !== 'pending') return
    if (Date.now() > session.expiresAtMs) {
      this.finish(session, 'expired')
      return
    }
    let response: Response
    try {
      response = await fetch(`${accountOriginOf(session.region)}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          device_code: session.deviceCode,
          client_id: CLIENT_ID,
          code_verifier: session.codeVerifier,
        }),
      })
    } catch (error: unknown) {
      // 网络抖动不是终态：按原间隔再试，直到会话过期。
      this.schedule(id, session.intervalMs)
      void error
      return
    }
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(text) as Record<string, unknown> } catch { body = {} }
    const status = typeof body['status'] === 'string' ? body['status'] : typeof body['error'] === 'string' ? body['error'] : ''

    if (response.ok && typeof body['access_token'] === 'string') {
      const expiresIn = Number(body['expires_in'])
      const accountId = await this.onAuthorized(session.region, {
        accessToken: body['access_token'] as string,
        refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : '',
        expiresAtMs: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
        loginEpoch: base64url(randomBytes(16)),
      }).catch((error: unknown) => {
        void error
        return undefined
      })
      if (accountId === undefined) {
        this.finish(session, 'failed', '授权成功但落库失败。')
        return
      }
      this.finish(session, 'authorized', undefined, accountId)
      return
    }

    if (status === 'pending' || status === 'authorization_pending') {
      this.schedule(id, session.intervalMs)
      return
    }
    if (status === 'slow_down') {
      this.schedule(id, session.intervalMs + SLOW_DOWN_EXTRA_MS)
      return
    }
    if (status === 'denied' || status === 'access_denied') {
      this.finish(session, 'denied')
      return
    }
    if (status === 'expired' || status === 'expired_token') {
      this.finish(session, 'expired')
      return
    }
    // 其它拒绝：记原因并终止（不拿同一个 device_code 反复打）。
    this.finish(session, 'failed', text.slice(0, 200))
  }
}
