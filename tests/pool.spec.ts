/**
 * 账号池测试：选谁、什么时候换、换不动时怎么办。
 *
 * 这一份只测"选择语义"，不碰网络与真实凭据——池的价值全在这里：
 * 一个号积分用完之后，请求应该悄无声息地落到另一个号上。
 */

import { describe, expect, it } from 'vitest'

import {
  DRAIN_TTL_MS,
  MiniMaxAccountPool,
  isPoolAccountUsable,
  pickPoolAccount,
  type PoolAccount,
} from '../src/pool.ts'
import type { MiniMaxCredentialSource } from '../src/auth.ts'

/** 一个只返回固定 token 的假凭据来源。 */
function fakeSource(token = 'mmoat_x', failWith?: Error): MiniMaxCredentialSource {
  return {
    region: 'cn',
    regionLabel: '国内版',
    baseUrl: 'https://example.invalid',
    token: async () => {
      if (failWith !== undefined) throw failWith
      return token
    },
    invalidate: () => undefined,
  }
}

function poolAccount(id: string, options: { live?: boolean, token?: string, failWith?: Error } = {}): PoolAccount {
  return {
    id,
    label: id,
    live: options.live ?? false,
    source: fakeSource(options.token ?? `mmoat_${id}`, options.failWith),
  }
}

describe('isPoolAccountUsable', () => {
  it('没读到余额时视为可用（没读到不等于没钱）', () => {
    expect(isPoolAccountUsable({ id: 'a' }, 1000)).toBe(true)
  })

  it('余额为 0 或负数时不可用', () => {
    expect(isPoolAccountUsable({ id: 'a', balance: 0 }, 1000)).toBe(false)
    expect(isPoolAccountUsable({ id: 'a', balance: -1 }, 1000)).toBe(false)
  })

  it('余额 > 0 时可用', () => {
    expect(isPoolAccountUsable({ id: 'a', balance: 0.5 }, 1000)).toBe(true)
  })

  it('耗尽标记未到期时不可用，到期后自动恢复', () => {
    const candidate = { id: 'a', drainedUntilMs: 2000 }
    expect(isPoolAccountUsable(candidate, 1999)).toBe(false)
    expect(isPoolAccountUsable(candidate, 2000)).toBe(true)
  })
})

describe('pickPoolAccount', () => {
  it('当前账号可用就继续用它（稳定优先，不按余额排序）', () => {
    const picked = pickPoolAccount(
      [{ id: 'a', balance: 1 }, { id: 'b', balance: 999 }],
      'a',
      1000,
    )
    expect(picked?.id).toBe('a')
  })

  it('当前账号余额为 0 时换成有余额的那个——这就是"积分没了自动切"', () => {
    const picked = pickPoolAccount(
      [{ id: 'a', balance: 0 }, { id: 'b', balance: 12 }],
      'a',
      1000,
    )
    expect(picked?.id).toBe('b')
  })

  it('全都不可用时回落当前账号，不编造"无可用账号"', () => {
    // 让上游给出真实原因，比插件替服务端下结论更有用。
    const picked = pickPoolAccount(
      [{ id: 'a', balance: 0 }, { id: 'b', balance: 0 }],
      'a',
      1000,
    )
    expect(picked?.id).toBe('a')
  })

  it('没有当前账号时取第一个可用的', () => {
    const picked = pickPoolAccount(
      [{ id: 'a', balance: 0 }, { id: 'b', balance: 3 }],
      undefined,
      1000,
    )
    expect(picked?.id).toBe('b')
  })

  it('空池返回 undefined', () => {
    expect(pickPoolAccount([], 'a', 1000)).toBeUndefined()
  })
})

describe('MiniMaxAccountPool', () => {
  it('默认优先本机登录（它由 mcode 续期，最省事）', () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('copy-1'), poolAccount('live', { live: true })])
    expect(pool.active).toBe('live')
  })

  it('没有本机登录时取第一个副本', () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('copy-1'), poolAccount('copy-2')])
    expect(pool.active).toBe('copy-1')
  })

  it('token() 用当前账号，并把它钉成当前账号', async () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('a', { token: 'mmoat_a' }), poolAccount('b', { token: 'mmoat_b' })])
    pool.select('b')
    await expect(pool.token()).resolves.toBe('mmoat_b')
    expect(pool.active).toBe('b')
  })

  it('当前账号凭据失效时自动用下一个（RT 作废常常只影响一个号）', async () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([
      poolAccount('dead', { failWith: new Error('invalid_grant') }),
      poolAccount('ok', { token: 'mmoat_ok' }),
    ])
    pool.select('dead')
    await expect(pool.token()).resolves.toBe('mmoat_ok')
    // 谁真的产出了 token，谁就成为当前账号——下次不用再白试一遍。
    expect(pool.active).toBe('ok')
  })

  it('全部凭据都失效时抛出最后一个错误（不吞掉原因）', async () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('a', { failWith: new Error('first') }), poolAccount('b', { failWith: new Error('second') })])
    await expect(pool.token()).rejects.toThrow('second')
  })

  it('switchAway 把当前账号标记耗尽并换到下一个', () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('a'), poolAccount('b')])
    expect(pool.active).toBe('a')
    expect(pool.switchAway()).toBe(true)
    expect(pool.active).toBe('b')
    // a 进入耗尽态，短时间内不会再被选中。
    expect(pool.snapshot().get('a')?.drainedUntilMs).toBeGreaterThan(Date.now())
  })

  it('池里只有一个账号时 switchAway 返回 false（没得换就别假称换了）', () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('a')])
    expect(pool.switchAway()).toBe(false)
    expect(pool.active).toBe('a')
  })

  it('两个账号都耗尽后不再来回换（避免无意义重试）', () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('a'), poolAccount('b')])
    expect(pool.switchAway()).toBe(true)
    expect(pool.switchAway()).toBe(false)
  })

  it('余额回到正数就立刻清除耗尽态（钱到了不该等 TTL）', () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('a'), poolAccount('b')])
    pool.switchAway()
    expect(pool.snapshot().get('a')?.drainedUntilMs).toBeDefined()
    pool.reportBalance('a', 100)
    expect(pool.snapshot().get('a')?.drainedUntilMs).toBeUndefined()
  })

  it('余额为 0 的账号在选号时被跳过', async () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('a', { token: 'mmoat_a' }), poolAccount('b', { token: 'mmoat_b' })])
    pool.reportBalance('a', 0)
    await expect(pool.token()).resolves.toBe('mmoat_b')
  })

  it('select 一个不存在的 id 返回 false 且不改当前账号', () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('a')])
    expect(pool.select('nope')).toBe(false)
    expect(pool.active).toBe('a')
  })

  it('重设账号列表时保留余额，丢弃已移除账号的状态', () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('a'), poolAccount('b')])
    pool.reportBalance('a', 7)
    pool.setAccounts([poolAccount('a')])
    expect(pool.snapshot().get('a')?.balance).toBe(7)
    expect(pool.snapshot().get('b')).toBeUndefined()
  })

  it('当前账号被移出池后重新选一个（不能指向不存在的号）', () => {
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([poolAccount('a'), poolAccount('b')])
    pool.select('a')
    pool.setAccounts([poolAccount('b')])
    expect(pool.active).toBe('b')
  })

  it('耗尽 TTL 是 10 分钟（够撑过一轮余额刷新）', () => {
    expect(DRAIN_TTL_MS).toBe(10 * 60 * 1000)
  })
})
