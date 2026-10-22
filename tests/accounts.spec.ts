import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  accountDisplayNameOf,
  accountIdOf,
  accountOriginOf,
  accountRouteOf,
  accountStateOf,
  buildTransferFile,
  importTransferFile,
  previewTransferFile,
  readAccounts,
  readActiveSelections,
  refreshAccountCredential,
  syncLiveAccount,
  type MiniMaxLiveCredential,
  type MiniMaxStoredAccount,
  writeAccounts,
  writeActiveSelection,
} from '../src/accounts.ts'

/** 一条"本机登录"快照。 */
function live(overrides: Partial<MiniMaxLiveCredential> = {}): MiniMaxLiveCredential {
  return {
    loginEpoch: 'cfd703e1-ae75-4060-8244-a998d1b6af4b',
    accessToken: 'mmoat_live',
    refreshToken: 'mmort_live',
    expiresAtMs: Date.now() + 3_600_000,
    generation: 8,
    ...overrides,
  }
}

describe('accountIdOf / accountRouteOf / accountDisplayNameOf', () => {
  it('id 取区域 + loginEpoch 前 8 位，干净可读', () => {
    expect(accountIdOf('cn', 'cfd703e1-ae75-4060-8244-a998d1b6af4b')).toBe('cn-cfd703e1')
    expect(accountIdOf('global', '058de9a6-ad3c-4edb-bc8c-eeb6aca1a6bd')).toBe('global-058de9a6')
  })

  it('路由名与显示名带区域，模型选择器里分得清', () => {
    const account = { id: 'cn-cfd703e1', region: 'cn' as const, label: '副本 2' }
    expect(accountRouteOf(account)).toBe('minimax-cn-cfd703e1')
    expect(accountDisplayNameOf(account)).toBe('MiniMax 副本 · 副本 2')
    expect(accountDisplayNameOf({ ...account, region: 'global' })).toBe('MiniMax Global 副本 · 副本 2')
  })

  it('OAuth 端点跟着区域走', () => {
    expect(accountOriginOf('cn')).toBe('https://account.minimax.cn')
    expect(accountOriginOf('global')).toBe('https://account.minimax.io')
  })
})

describe('syncLiveAccount', () => {
  it('首次镜像：生成一条跟随态副本，不接管', () => {
    const { accounts, changed } = syncLiveAccount([], live(), 'cn')
    expect(changed).toBe(true)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.owned).toBe(false)
    expect(accounts[0]?.label).toBe('副本 1')
    expect(accounts[0]?.id).toBe('cn-cfd703e1')
  })

  it('同一次登录再镜像：只更新凭据，ownership 不变（绝不能接管 mcode 正在用的账号）', () => {
    const first = syncLiveAccount([], live(), 'cn').accounts
    const { accounts, changed } = syncLiveAccount(
      first,
      live({ accessToken: 'mmoat_new', refreshToken: 'mmort_new', expiresAtMs: Date.now() + 1_000 }),
      'cn',
    )
    expect(changed).toBe(true)
    expect(accounts[0]?.owned).toBe(false)
    expect(accounts[0]?.accessToken).toBe('mmoat_new')
    expect(accounts[0]?.refreshToken).toBe('mmort_new')
  })

  it('同一区域换账号：旧副本被接管，新账号进入跟随态', () => {
    const first = syncLiveAccount([], live(), 'cn').accounts
    const { accounts } = syncLiveAccount(
      first,
      live({ loginEpoch: 'aaaaaaaa-1111-2222-3333-444444444444', accessToken: 'mmoat_b' }),
      'cn',
    )
    expect(accounts).toHaveLength(2)
    const old = accounts.find(account => account.id === 'cn-cfd703e1')
    const fresh = accounts.find(account => account.id === 'cn-aaaaaaaa')
    expect(old?.owned).toBe(true)
    expect(fresh?.owned).toBe(false)
    expect(fresh?.label).toBe('副本 2')
  })

  it('换的是另一个区域：不影响国内副本的跟随态', () => {
    const first = syncLiveAccount([], live(), 'cn').accounts
    const { accounts } = syncLiveAccount(
      first,
      live({ loginEpoch: 'bbbbbbbb-1111-2222-3333-444444444444' }),
      'global',
    )
    expect(accounts.find(account => account.id === 'cn-cfd703e1')?.owned).toBe(false)
    expect(accounts.find(account => account.id === 'global-bbbbbbbb')?.owned).toBe(false)
  })

  it('凭据没变就不写盘（changed=false，避免每 60s 空写一次）', () => {
    const first = syncLiveAccount([], live(), 'cn').accounts
    const { changed } = syncLiveAccount(first, live(), 'cn')
    expect(changed).toBe(false)
  })
})

describe('accountStateOf', () => {
  const base: MiniMaxStoredAccount = {
    id: 'cn-cfd703e1',
    region: 'cn',
    label: '副本 1',
    loginEpoch: 'cfd703e1-ae75-4060-8244-a998d1b6af4b',
    accessToken: 'mmoat_x',
    refreshToken: 'mmort_x',
    expiresAtMs: 1_000,
    owned: true,
    createdAtMs: 0,
  }

  it('未过期 = owned（可用）', () => {
    expect(accountStateOf({ ...base, expiresAtMs: Date.now() + 60_000 })).toBe('owned')
  })

  it('过期 = expired', () => {
    expect(accountStateOf(base)).toBe('expired')
  })

  it('提示过 invalid_grant = dead（刷新链已废，必须重新登录）', () => {
    expect(accountStateOf({ ...base, lastError: 'HTTP 400：{"error":"invalid_grant"}' })).toBe('dead')
  })
})

describe('refreshAccountCredential', () => {
  const account = { region: 'cn' as const, refreshToken: 'mmort_old' }

  it('用一次性 RT 换新凭据，并原样返回服务端给的新 RT', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'mmoat_new',
      refresh_token: 'mmort_new',
      expires_in: 3600,
      token_type: 'Bearer',
    }), { status: 200 }))
    const outcome = await refreshAccountCredential(account, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(outcome).toEqual({
      ok: true,
      accessToken: 'mmoat_new',
      refreshToken: 'mmort_new',
      expiresAtMs: expect.any(Number),
    })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://account.minimax.cn/oauth2/token')
    const body = new URLSearchParams(String(init.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_id')).toBe('mcode-public')
    expect(body.get('refresh_token')).toBe('mmort_old')
    expect(body.get('scope')).toBe('agent.default')
  })

  it('RT 已用过时把服务端原话带给用户（invalid_grant）', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'this refresh token can no longer be used' }),
      { status: 400 },
    ))
    const outcome = await refreshAccountCredential(account, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toContain('invalid_grant')
  })

  it('网络异常不抛，返回可读原因', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') })
    const outcome = await refreshAccountCredential(account, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toContain('ECONNRESET')
  })

  it('响应缺 refresh_token 时判失败（新 RT 是下一次续期的唯一凭据）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'mmoat_new',
      expires_in: 3600,
    }), { status: 200 }))
    const outcome = await refreshAccountCredential(account, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(outcome.ok).toBe(false)
  })
})

describe('readAccounts / writeAccounts', () => {
  it('写进去能读回来，且文件权限是 0600', async () => {
    const dir = await import('node:fs/promises').then(fs => fs.mkdtemp('/tmp/mm-accounts-'))
    const path = `${dir}/.minimax-accounts.json`
    const { accounts } = syncLiveAccount([], live(), 'cn')
    await writeAccounts(accounts, path)
    const read = await readAccounts(path)
    expect(read).toHaveLength(1)
    expect(read[0]?.refreshToken).toBe('mmort_live')
    const { stat } = await import('node:fs/promises')
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('坏文件 / 版本不符 / 坏条目都不会让整库失效', async () => {
    const fs = await import('node:fs/promises')
    const dir = await fs.mkdtemp('/tmp/mm-accounts-')
    const path = `${dir}/.minimax-accounts.json`

    await fs.writeFile(path, 'not json')
    expect(await readAccounts(path)).toEqual([])

    await fs.writeFile(path, JSON.stringify({ schemaVersion: 99, accounts: [] }))
    expect(await readAccounts(path)).toEqual([])

    await fs.writeFile(path, JSON.stringify({
      schemaVersion: 1,
      accounts: [{ id: 'x' }, { id: 'cn-cfd703e1', region: 'cn', loginEpoch: 'e', accessToken: 'a', refreshToken: 'r', expiresAtMs: 1, owned: true, createdAtMs: 0 }],
    }))
    const read = await readAccounts(path)
    expect(read).toHaveLength(1)
    expect(read[0]?.id).toBe('cn-cfd703e1')
  })
})

describe('当前选中的账号（池的持久化选择）', () => {
  it('写进去能读回来', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-accounts-'))
    const path = join(dir, '.minimax-accounts.json')
    await writeActiveSelection('cn', 'cn-aaaa1111', path)
    expect(readActiveSelections(path)).toEqual({ cn: 'cn-aaaa1111' })
  })

  it('两个区域各记各的，互不覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-accounts-'))
    const path = join(dir, '.minimax-accounts.json')
    await writeActiveSelection('cn', 'cn-a', path)
    await writeActiveSelection('global', 'global-b', path)
    expect(readActiveSelections(path)).toEqual({ cn: 'cn-a', global: 'global-b' })
  })

  it('重写账号列表不会把选择顺手清掉', async () => {
    // 这条是真实的丢数据路径：换一次账号就 writeAccounts 一次，
    // 如果它不带上 activeByRegion，用户手动做的切换就白做了。
    const dir = await mkdtemp(join(tmpdir(), 'mm-accounts-'))
    const path = join(dir, '.minimax-accounts.json')
    await writeActiveSelection('cn', 'cn-aaaa1111', path)
    await writeAccounts([], path)
    expect(readActiveSelections(path)).toEqual({ cn: 'cn-aaaa1111' })
  })

  it('文件不存在时返回空对象（不抛）', () => {
    expect(readActiveSelections('/nonexistent/definitely/missing.json')).toEqual({})
  })

  it('只认 cn / global 两个键，别的键丢弃', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-accounts-'))
    const path = join(dir, '.minimax-accounts.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, accounts: [], activeByRegion: { cn: 'cn-a', bogus: 'x' } }), 'utf8')
    expect(readActiveSelections(path)).toEqual({ cn: 'cn-a' })
  })
})

describe('账号传输：导出 / 预览 / 导入', () => {
  const account = (over: Partial<MiniMaxStoredAccount> = {}): MiniMaxStoredAccount => ({
    id: 'cn-abcdef01',
    region: 'cn',
    label: '副本 1',
    loginEpoch: 'abcdef01-xxxx',
    accessToken: 'mmoat_a',
    refreshToken: 'mmor_a',
    expiresAtMs: Date.now() + 3_600_000,
    owned: true,
    createdAtMs: Date.now(),
    ...over,
  })

  it('导出只含勾选的账号，且带凭据（文件本身就是敏感物）', () => {
    const file = buildTransferFile([account(), account({ id: 'cn-22222222', loginEpoch: '22222222-x' })], ['cn-abcdef01'])
    expect(file?.accounts).toHaveLength(1)
    expect(file?.accounts[0]?.accessToken).toBe('mmoat_a')
    expect(file?.kind).toBe('dsh-connect-minmax-accounts')
  })

  it('空勾选 = 一个都不导（不是"全部"）', () => {
    expect(buildTransferFile([account()], [])).toBeUndefined()
  })

  it('预览不含 token：只有展示字段与 hasToken 布尔量', () => {
    const file = buildTransferFile([account()], ['cn-abcdef01'])
    const preview = previewTransferFile(JSON.stringify(file), [])
    expect(preview).toHaveLength(1)
    expect(JSON.stringify(preview)).not.toContain('mmoat_a')
    expect(preview?.[0]?.hasToken).toBe(true)
    expect(preview?.[0]?.duplicate).toBe(false)
  })

  it('库里已有的同一次登录在预览里标重复', () => {
    const file = buildTransferFile([account()], ['cn-abcdef01'])
    const preview = previewTransferFile(JSON.stringify(file), [account()])
    expect(preview?.[0]?.duplicate).toBe(true)
  })

  it('不是传输文件 / 版本不符 → 预览 undefined（不猜）', () => {
    expect(previewTransferFile('{"kind":"other","version":1,"accounts":[]}', [])).toBeUndefined()
    expect(previewTransferFile('not json', [])).toBeUndefined()
  })

  it('导入写进库且 owned=true（刷新链归插件）；重复跳过不覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minmax-transfer-'))
    const path = join(dir, 'accounts.json')
    const file = buildTransferFile([account()], ['cn-abcdef01'])
    const first = await importTransferFile(JSON.stringify(file), ['cn-abcdef01'], path)
    expect(first.added).toEqual(['cn-abcdef01'])
    const stored = await readAccounts(path)
    expect(stored[0]?.owned).toBe(true)
    // 再导一次：同一次登录已在库里 → 跳过，绝不覆盖正在用的凭据。
    const second = await importTransferFile(JSON.stringify(file), ['cn-abcdef01'], path)
    expect(second.added).toEqual([])
    expect(second.skipped).toEqual(['cn-abcdef01'])
  })
})
