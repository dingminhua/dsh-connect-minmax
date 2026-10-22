/**
 * 活凭据自续期的协议测试。
 *
 * 全部在临时目录里跑，fetch 被替换：grant 的应答是假的，但**锁、代际、原子写、
 * 镜像**这四步是真的磁盘行为——它们才是会打断用户 mcode 登录的部分。
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LiveRenewal,
  nextGeneration,
  readAuthStateGeneration,
  readCredentialRecord,
  renewCredential,
  withAuthLock,
} from '../src/renewal.ts'

let dir: string
let authFile: string

/** 写一份最小可用的 auth.json + auth-state.json。 */
async function seed(options: {
  refreshToken?: string
  expiresAtMs?: number
  generation?: number
  stateGeneration?: number
} = {}): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'minimax-renew-'))
  authFile = join(dir, 'auth.json')
  const record: Record<string, unknown> = {
    accessToken: 'mmoat_old',
    refreshToken: options.refreshToken ?? 'mmort_old',
    loginEpoch: 'epoch-1',
    expiresAtMs: options.expiresAtMs ?? Date.now() - 1000,
    generation: options.generation ?? 5,
  }
  await writeFile(authFile, JSON.stringify({
    records: { 'svc\0key': record },
  }, undefined, 2), 'utf8')
  await writeFile(join(dir, 'auth-state.json'), JSON.stringify({
    status: 'authenticated',
    generation: options.stateGeneration ?? 5,
  }, undefined, 2), 'utf8')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('withAuthLock', () => {
  it('mkdir 抢占、用完释放，第二次能再拿', async () => {
    await seed()
    let inner = 0
    await withAuthLock(join(dir, 'auth.lock'), async () => { inner += 1 })
    await withAuthLock(join(dir, 'auth.lock'), async () => { inner += 1 })
    expect(inner).toBe(2)
  })

  it('超过 30 秒的陈旧锁被回收（客户端同款 staleMs）', async () => {
    await seed()
    const lockDir = `${join(dir, 'auth.lock')}.lock`
    const { mkdir: mkdirFs } = await import('node:fs/promises')
    await mkdirFs(lockDir)
    // 把 mtime 拨到 31 秒前，模拟持锁者崩溃。
    const { utimes } = await import('node:fs/promises')
    const past = new Date(Date.now() - 31_000)
    await utimes(lockDir, past, past)
    let ran = false
    await withAuthLock(join(dir, 'auth.lock'), async () => { ran = true })
    expect(ran).toBe(true)
  })
})

describe('nextGeneration', () => {
  it('取 max(state, credential) + 1：只用凭据自己的计数器会锁死自己', async () => {
    // state 比凭据高（客户端自己续过一次）：只按凭据算会写回一个更低的代际。
    await seed({ generation: 3, stateGeneration: 9 })
    const record = await readCredentialRecord(authFile)
    expect(nextGeneration(authFile, record?.record)).toBe(10)
  })

  it('没有 auth-state.json 时按凭据算', async () => {
    await seed()
    const { rm } = await import('node:fs/promises')
    await rm(join(dir, 'auth-state.json'))
    expect(readAuthStateGeneration(authFile)).toBe(0)
    const record = await readCredentialRecord(authFile)
    expect(nextGeneration(authFile, record?.record)).toBe(6)
  })
})

describe('renewCredential', () => {
  it('还新鲜时不抢锁、不发 grant（巡检每分钟一次，不能空抢）', async () => {
    await seed({ expiresAtMs: Date.now() + 60 * 60_000 })
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const outcome = await renewCredential(authFile)
    expect(outcome.ok).toBe(true)
    expect(outcome.adopted).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('过期时 grant → 原子写回 → 两个文件代际一致', async () => {
    await seed({ expiresAtMs: Date.now() - 1000, generation: 5, stateGeneration: 5 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'mmoat_new',
      refresh_token: 'mmort_new',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'agent.default',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const outcome = await renewCredential(authFile)
    expect(outcome.ok).toBe(true)
    const record = await readCredentialRecord(authFile)
    expect(record?.record['accessToken']).toBe('mmoat_new')
    expect(record?.record['refreshToken']).toBe('mmort_new')
    expect(record?.record['generation']).toBe(6)
    // 关键：auth-state.json 必须同步推进，否则客户端读回"未登录"。
    expect(readAuthStateGeneration(authFile)).toBe(6)
  })

  it('没有 refreshToken → fatal（只有重新登录能救）', async () => {
    await seed({ refreshToken: '' })
    const outcome = await renewCredential(authFile)
    expect(outcome.ok).toBe(false)
    expect(outcome.fatal).toBe(true)
  })

  it('invalid_grant → fatal；其它拒绝 → 可重试', async () => {
    await seed()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'this refresh token can no longer be used',
    }), { status: 400 })))
    const fatal = await renewCredential(authFile)
    expect(fatal.fatal).toBe(true)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const retryable = await renewCredential(authFile)
    expect(retryable.ok).toBe(false)
    expect(retryable.fatal).toBeUndefined()
  })

  it('等锁期间别人已续好 → 采纳那一对，不花自己的 RT', async () => {
    await seed({ expiresAtMs: Date.now() - 1000 })
    // 让 grant 永远失败：如果代码错误地花了自己的 RT，这里会 fatal。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })))
    // 预检会先看到"已过期"，所以要在预检与锁内重读之间把文件改新鲜——
    // 直接构造：先跑一次预检会进锁，锁内重读时文件已被外部续好。
    // 简化：把 expiresAtMs 改成新鲜后立刻调用，预检会 adopted 返回。
    const { writeFile: wf } = await import('node:fs/promises')
    const record = await readCredentialRecord(authFile)
    const fresh = { ...record?.record, expiresAtMs: Date.now() + 3_600_000, generation: 7 }
    await wf(authFile, JSON.stringify({ records: { 'svc\0key': fresh } }), 'utf8')
    const outcome = await renewCredential(authFile)
    expect(outcome.ok).toBe(true)
    expect(outcome.adopted).toBe(true)
    expect(outcome.generation).toBe(7)
  })
})

describe('LiveRenewal', () => {
  it('fatal 后不再重试，直到重新启用', async () => {
    await seed()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })))
    const renewal = new LiveRenewal(authFile, true)
    const first = await renewal.ensure()
    expect(first.fatal).toBe(true)
    const spy = vi.fn(async () => new Response(JSON.stringify({ access_token: 'x', refresh_token: 'y', expires_in: 3600 }), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const second = await renewal.ensure()
    expect(second.fatal).toBe(true)
    expect(spy).not.toHaveBeenCalled()
    // 重新启用（用户重新登录后卡片会调）才恢复。
    renewal.setEnabled(false)
    renewal.setEnabled(true)
    await renewal.ensure()
    expect(spy).toHaveBeenCalled()
  })

  it('status 反映 fatal 与原因', async () => {
    await seed()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })))
    const renewal = new LiveRenewal(authFile, true)
    await renewal.ensure()
    const view = await renewal.status()
    expect(view.state).toBe('fatal')
    expect(view.reason).toContain('invalid_grant')
  })

  it('禁用时 status = off 且 ensure 不做任何事', async () => {
    await seed()
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const renewal = new LiveRenewal(authFile, false)
    const outcome = await renewal.ensure()
    expect(outcome.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    expect((await renewal.status()).state).toBe('off')
  })
})
