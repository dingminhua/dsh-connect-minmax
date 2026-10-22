import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { writeAccounts, readAccounts, syncLiveAccount } from '../src/accounts.ts'
import { MiniMaxAccountSource, MiniMaxAccountUnavailableError, resetAccountInflight } from '../src/account-source.ts'

/** 每个用例一个临时 DSH_HOME；用例结束后恢复，绝不留下真实路径。 */
const homes: string[] = []
const originalHome = process.env['DSH_HOME']

async function isolateHome(): Promise<string> {
  const fs = await import('node:fs/promises')
  const dir = await fs.mkdtemp('/tmp/mm-acct-')
  homes.push(dir)
  process.env['DSH_HOME'] = dir
  return dir
}

/** 写一条可控副本进库。 */
async function seed(overrides: Record<string, unknown> = {}): Promise<void> {
  const base = {
    schemaVersion: 1,
    accounts: [{
      id: 'cn-cfd703e1',
      region: 'cn',
      label: '副本 1',
      loginEpoch: 'cfd703e1-ae75-4060-8244-a998d1b6af4b',
      accessToken: 'mmoat_valid',
      refreshToken: 'mmort_old',
      expiresAtMs: Date.now() + 600_000,
      owned: true,
      createdAtMs: 0,
      ...overrides,
    }],
  }
  const fs = await import('node:fs/promises')
  await fs.writeFile(`${process.env['DSH_HOME']}/.minimax-accounts.json`, JSON.stringify(base))
}

afterAll(async () => {
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
  const fs = await import('node:fs/promises')
  await Promise.all(homes.map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('MiniMaxAccountSource', () => {
  beforeEach(() => {
    resetAccountInflight()
    vi.restoreAllMocks()
  })

  it('token 有效时直接返回，不联网', async () => {
    await isolateHome()
    await seed()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const source = new MiniMaxAccountSource('cn-cfd703e1', 'cn')
    expect(await source.token()).toBe('mmoat_valid')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('token 过期时用副本自己的 RT 续期，并把新 RT 落盘（一次性 RT 的唯一凭据）', async () => {
    await isolateHome()
    await seed({ expiresAtMs: Date.now() - 1_000 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'mmoat_fresh',
      refresh_token: 'mmort_fresh',
      expires_in: 3600,
    }), { status: 200 }))

    const source = new MiniMaxAccountSource('cn-cfd703e1', 'cn')
    expect(await source.token()).toBe('mmoat_fresh')

    const stored = await readAccounts()
    expect(stored[0]?.accessToken).toBe('mmoat_fresh')
    expect(stored[0]?.refreshToken).toBe('mmort_fresh')
    expect(stored[0]?.lastRefreshAtMs).toBeGreaterThan(0)
  })

  it('并发请求只刷新一次（否则第二次用旧 RT 会 invalid_grant，把整条链毁掉）', async () => {
    await isolateHome()
    await seed({ expiresAtMs: Date.now() - 1_000 })
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(JSON.stringify({
        access_token: 'mmoat_fresh',
        refresh_token: 'mmort_fresh',
        expires_in: 3600,
      }), { status: 200 })
    })

    const source = new MiniMaxAccountSource('cn-cfd703e1', 'cn')
    const tokens = await Promise.all([source.token(), source.token(), source.token()])
    expect(calls).toBe(1)
    expect(new Set(tokens)).toEqual(new Set(['mmoat_fresh']))
  })

  it('RT 作废时抛可读错误，并把原因记进副本库（卡片据此提示重新登录）', async () => {
    await isolateHome()
    await seed({ expiresAtMs: Date.now() - 1_000 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'this refresh token can no longer be used' }),
      { status: 400 },
    ))

    const source = new MiniMaxAccountSource('cn-cfd703e1', 'cn')
    await expect(source.token()).rejects.toBeInstanceOf(MiniMaxAccountUnavailableError)
    const stored = await readAccounts()
    expect(stored[0]?.lastError).toContain('invalid_grant')
  })

  it('副本已被删除时给出明确错误', async () => {
    await isolateHome()
    const source = new MiniMaxAccountSource('cn-missing', 'cn')
    await expect(source.token()).rejects.toThrow('副本已不存在')
  })

  it('status() 把副本状态投影成卡片可用的只读结构', async () => {
    await isolateHome()
    await seed()
    const source = new MiniMaxAccountSource('cn-cfd703e1', 'cn')
    const status = await source.status()
    expect(status?.state).toBe('owned')
    expect(status?.regionLabel).toBe('国内版')
    expect(status?.expiresAtMs).toBeGreaterThan(Date.now())
  })

  it('baseUrl 可按配置覆盖（国际版副本走 .io）', async () => {
    await isolateHome()
    const source = new MiniMaxAccountSource('global-058de9a6', 'global')
    expect(source.baseUrl).toBe('https://agent.minimax.io/mavis/api/v1/llm')
    expect(source.regionLabel).toBe('国际版')
  })
})

describe('镜像后接管（端到端）', () => {
  it('换账号后旧副本被接管，旧账号的 token 由插件自己续期', async () => {
    const home = await isolateHome()
    // 第一次：账号 A 是当前登录（跟随态）
    const a = syncLiveAccount([], {
      loginEpoch: 'aaaaaaa1-0000-0000-0000-000000000000',
      accessToken: 'mmoat_a',
      refreshToken: 'mmort_a',
      expiresAtMs: Date.now() + 3_600_000,
    }, 'cn').accounts
    await writeAccounts(a)
    // 第二次：mcode 换成了账号 B → A 被接管
    const b = syncLiveAccount(await readAccounts(), {
      loginEpoch: 'bbbbbbb2-0000-0000-0000-000000000000',
      accessToken: 'mmoat_b',
      refreshToken: 'mmort_b',
      expiresAtMs: Date.now() + 3_600_000,
    }, 'cn').accounts
    await writeAccounts(b)

    const stored = await readAccounts()
    expect(stored.find(account => account.id === 'cn-aaaaaaa1')?.owned).toBe(true)
    expect(stored.find(account => account.id === 'cn-bbbbbbb2')?.owned).toBe(false)
    expect(home).toContain('mm-acct-')

    // A 过期后由插件续期（mcode 已经没有它了，不会有人抢这条链）
    await writeAccounts(stored.map(account =>
      account.id === 'cn-aaaaaaa1' ? { ...account, expiresAtMs: Date.now() - 1_000 } : account))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'mmoat_a2',
      refresh_token: 'mmort_a2',
      expires_in: 3600,
    }), { status: 200 }))
    const source = new MiniMaxAccountSource('cn-aaaaaaa1', 'cn')
    expect(await source.token()).toBe('mmoat_a2')
  })
})
