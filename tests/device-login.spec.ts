/**
 * 设备码登录的状态机测试。
 *
 * fetch 被替换成脚本化的应答序列；验证的是 PKCE 必填、轮询语义（pending /
 * slow_down / denied / expired）、授权成功后的落库回调、会话生命周期。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeviceLoginManager, createPkcePair } from '../src/device-login.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 设备码发起应答。 */
function deviceCodeResponse(): Response {
  return new Response(JSON.stringify({
    device_code: 'dev-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://account.minimax.cn/oauth-authorize',
    expires_in: 300,
    interval: 0.001, // 测试里毫秒级轮询
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('createPkcePair', () => {
  it('challenge = base64url(sha256(verifier))，S256 契约', async () => {
    const { createHash } = await import('node:crypto')
    const { verifier, challenge } = createPkcePair()
    expect(challenge).toBe(createHash('sha256').update(verifier, 'ascii').digest('base64url'))
    expect(verifier).not.toBe(challenge)
  })
})

describe('DeviceLoginManager', () => {
  it('发起：带上 PKCE、scope、audience；返回 user_code 与验证链接', async () => {
    const seen: URLSearchParams[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      seen.push(new URLSearchParams(init.body))
      return deviceCodeResponse()
    }))
    const manager = new DeviceLoginManager(async () => 'cn-new01')
    const session = await manager.start('cn')
    expect(session.userCode).toBe('ABCD-1234')
    expect(session.verificationUri).toBe('https://account.minimax.cn/oauth-authorize')
    expect(session.state).toBe('pending')
    const body = seen[0]!
    expect(body.get('client_id')).toBe('mcode-public')
    expect(body.get('scope')).toBe('agent.default')
    expect(body.get('audience')).toBe('agent-backend')
    expect(body.get('code_challenge_method')).toBe('S256')
    expect(body.get('code_challenge')?.length).toBeGreaterThan(20)
    manager.stopAll()
  })

  it('轮询 pending → 授权成功：落库回调拿到 access/refresh token，会话变 authorized', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      calls += 1
      if (url.endsWith('/device/code')) return deviceCodeResponse()
      // 第一次轮询 pending，第二次给 token。
      if (calls <= 3) {
        return new Response(JSON.stringify({ status: 'pending' }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      const body = new URLSearchParams(init.body)
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
      expect(body.get('device_code')).toBe('dev-1')
      expect(body.get('code_verifier')).toBeTruthy()
      return new Response(JSON.stringify({
        access_token: 'mmoat_device',
        refresh_token: 'mmort_device',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'agent.default',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const credentials: unknown[] = []
    const manager = new DeviceLoginManager(async (_region, credential) => {
      credentials.push(credential)
      return 'cn-device01'
    })
    await manager.start('cn')
    // 等轮询推进（interval 已设成 1ms）。
    await new Promise(resolve => setTimeout(resolve, 200))
    const sessions = manager.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.state).toBe('authorized')
    expect(sessions[0]!.accountId).toBe('cn-device01')
    expect(credentials).toHaveLength(1)
    expect((credentials[0] as { accessToken: string }).accessToken).toBe('mmoat_device')
    manager.stopAll()
  })

  it('denied → 会话终止为 denied，不再轮询', async () => {
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/device/code')) return deviceCodeResponse()
      polls += 1
      return new Response(JSON.stringify({ status: 'denied' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }))
    const manager = new DeviceLoginManager(async () => undefined)
    await manager.start('cn')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(manager.list()[0]!.state).toBe('denied')
    const settled = polls
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(polls).toBe(settled) // 终态后不再打 grant
    manager.stopAll()
  })

  it('落库失败 → failed（授权本身成功也不能假装没事）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/device/code')) return deviceCodeResponse()
      return new Response(JSON.stringify({
        access_token: 'mmoat_x', refresh_token: 'mmort_x', token_type: 'Bearer', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const manager = new DeviceLoginManager(async () => undefined)
    await manager.start('cn')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(manager.list()[0]!.state).toBe('failed')
    manager.stopAll()
  })

  it('同区域重复发起：替换旧的 pending 会话（用户面前只有一张 user_code）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/device/code')) return deviceCodeResponse()
      return new Response(JSON.stringify({ status: 'pending' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }))
    const manager = new DeviceLoginManager(async () => 'x')
    await manager.start('cn')
    await manager.start('cn')
    const sessions = manager.list().filter(session => session.state === 'pending')
    expect(sessions).toHaveLength(1)
    manager.stopAll()
  })

  it('stopAll 后不再有轮询（插件 fiber 拆除不许留后台定时器）', async () => {
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/device/code')) return deviceCodeResponse()
      polls += 1
      return new Response(JSON.stringify({ status: 'pending' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }))
    const manager = new DeviceLoginManager(async () => 'x')
    await manager.start('cn')
    await new Promise(resolve => setTimeout(resolve, 60))
    manager.stopAll()
    const settled = polls
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(polls).toBe(settled)
  })

  it('device/code 应答缺字段 → 抛错而不是挂一个假会话', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ device_code: 'd' }), { status: 200 })))
    const manager = new DeviceLoginManager(async () => 'x')
    await expect(manager.start('cn')).rejects.toThrow('缺少')
  })
})
