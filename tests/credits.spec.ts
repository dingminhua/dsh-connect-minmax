import { describe, expect, it, vi } from 'vitest'

import {
  buildCreditSnapshot,
  claimSignin,
  CREDIT_PAGE_SIZE,
  creditsOriginOf,
  fetchCreditBalance,
  fetchCreditLots,
  fetchSigninStatus,
  SIGNIN_DAY_STATUS,
  SIGNIN_TIMEZONE_ID,
} from '../src/credits.ts'

/** 造一个 fetch：回给定 JSON。 */
function responding(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

function requestedUrl(fetchImpl: unknown): string {
  const call = (fetchImpl as { mock: { calls: unknown[][] } }).mock.calls[0]
  return String((call as [string])[0])
}

describe('creditsOriginOf', () => {
  it('两个区域各自的账户 host', () => {
    expect(creditsOriginOf('cn')).toBe('https://agent.minimax.cn')
    expect(creditsOriginOf('global')).toBe('https://agent.minimax.io')
  })
})

describe('fetchCreditBalance', () => {
  it('读 op_credit_summary 的三个字段（不是恒为 0 的扁平字段）', async () => {
    const fetchImpl = responding(200, {
      op_credit_summary: {
        total_remaining_amount: '400',
        free_remaining_amount: '400',
        purchased_remaining_amount: '0',
      },
      total_remains_credit: 0,
      opcredit_balance: 0,
      base_resp: { status_code: 0, status_msg: 'success' },
    })
    const outcome = await fetchCreditBalance('cn', 'mmoat_x', { fetchImpl })
    expect(outcome.ok).toBe(true)
    expect(outcome.balance).toEqual({ totalRemaining: 400, freeRemaining: 400, purchasedRemaining: 0 })
    expect(requestedUrl(fetchImpl)).toContain('/matrix/api/v1/commerce/get_membership_info')
  })

  it('免费/购买拆分缺席时用 total - purchased 兜底', async () => {
    const outcome = await fetchCreditBalance('cn', 't', {
      fetchImpl: responding(200, {
        op_credit_summary: { total_remaining_amount: '300' },
        base_resp: { status_code: 0 },
      }),
    })
    expect(outcome.balance).toEqual({ totalRemaining: 300, purchasedRemaining: 0, freeRemaining: 300 })
  })

  it('summary 完全缺席时才回退到扁平字段', async () => {
    const outcome = await fetchCreditBalance('cn', 't', {
      fetchImpl: responding(200, { opcredit_balance: 77, base_resp: { status_code: 0 } }),
    })
    expect(outcome.balance?.totalRemaining).toBe(77)
  })

  it('HTTP 200 但 base_resp 报错也算失败（上游两条错误通道）', async () => {
    const outcome = await fetchCreditBalance('cn', 't', {
      fetchImpl: responding(200, { base_resp: { status_code: 1406010011, status_msg: 'invalid timezone_id' } }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('1406010011')
  })

  it('网络异常不抛，收成 ok:false', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ETIMEDOUT') }) as unknown as typeof fetch
    const outcome = await fetchCreditBalance('cn', 't', { fetchImpl })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('ETIMEDOUT')
  })
})

describe('fetchCreditLots', () => {
  it('固定 page_number=1 与足够大的 page_size（page_size 过小上游会 500）', async () => {
    const fetchImpl = responding(200, { details: [], base_resp: { status_code: 0 } })
    await fetchCreditLots('cn', 't', { fetchImpl })
    const url = requestedUrl(fetchImpl)
    expect(url).toContain('page_number=1')
    expect(url).toContain(`page_size=${CREDIT_PAGE_SIZE}`)
    expect(url).toContain('/minimax-cloud/api/v1/credit/details')
  })

  it('金额是字符串，必须按数值解析（不能用 parseInt 截断）', async () => {
    const fetchImpl = responding(200, {
      details: [{
        credit_type: 2,
        granted_amount: '400.00',
        remaining_amount: '0.50',
        consumed_amount: '399.50',
        granted_at_ms: 1792678633938,
        expire_at_ms: 1795190400000,
      }],
      base_resp: { status_code: 0 },
    })
    const outcome = await fetchCreditLots('cn', 't', { fetchImpl })
    expect(outcome.lots?.[0]?.remainingAmount).toBe(0.5)
    expect(outcome.lots?.[0]?.expireAtMs).toBe(1795190400000)
  })
})

describe('buildCreditSnapshot', () => {
  const now = 1_800_000_000_000
  const day = 86_400_000

  it('到期统计只算仍有余额的批次', () => {
    const snapshot = buildCreditSnapshot({ totalRemaining: 400, freeRemaining: 400, purchasedRemaining: 0 }, [
      { creditType: 2, grantedAmount: 400, remainingAmount: 0, consumedAmount: 400, grantedAtMs: 0, expireAtMs: now + day },
      { creditType: 2, grantedAmount: 400, remainingAmount: 400, consumedAmount: 0, grantedAtMs: 0, expireAtMs: now + 30 * day },
    ], now)
    expect(snapshot.expiringIn7d).toBe(0)
    expect(snapshot.expiringIn30d).toBe(400)
    expect(snapshot.earliestExpiryMs).toBe(now + 30 * day)
  })

  it('已过期批次不计入最早到期时间', () => {
    const snapshot = buildCreditSnapshot(undefined, [
      { creditType: 2, grantedAmount: 1, remainingAmount: 1, consumedAmount: 0, grantedAtMs: 0, expireAtMs: now - day },
      { creditType: 2, grantedAmount: 1, remainingAmount: 1, consumedAmount: 0, grantedAtMs: 0, expireAtMs: now + 5 * day },
    ], now)
    expect(snapshot.earliestExpiryMs).toBe(now + 5 * day)
    expect(snapshot.ok).toBe(false)
    expect(snapshot.error).toBeDefined()
  })
})

describe('fetchSigninStatus', () => {
  it('带 IANA 时区参数（偏移量会被上游拒）', async () => {
    const fetchImpl = responding(200, { data: { scene: 2, days: [] }, base_resp: { status_code: 0 } })
    await fetchSigninStatus('cn', 't', { fetchImpl })
    expect(requestedUrl(fetchImpl)).toContain(`timezone_id=${SIGNIN_TIMEZONE_ID}`)
  })

  it('今天 status=2 才算可领', async () => {
    const status = await fetchSigninStatus('cn', 't', {
      fetchImpl: responding(200, {
        data: { scene: 2, days: [{ day_no: 1, points: 400, status: SIGNIN_DAY_STATUS.claimable, is_today: true, bonus_points: 0 }] },
        base_resp: { status_code: 0 },
      }),
    })
    expect(status.ok).toBe(true)
    expect(status.claimableToday).toBe(true)
  })

  it('四态里其余三种都不允许领（用 !=3 判会把"还没轮到"当成可领）', async () => {
    for (const dayStatus of [SIGNIN_DAY_STATUS.upcoming, SIGNIN_DAY_STATUS.claimed, SIGNIN_DAY_STATUS.disabled]) {
      const status = await fetchSigninStatus('cn', 't', {
        fetchImpl: responding(200, {
          data: { scene: 2, days: [{ day_no: 3, points: 400, status: dayStatus, is_today: true, bonus_points: 0 }] },
          base_resp: { status_code: 0 },
        }),
      })
      expect(status.claimableToday, `status=${dayStatus}`).toBe(false)
    }
  })

  it('读取失败回一份空进度而不是抛', async () => {
    const status = await fetchSigninStatus('cn', 't', { fetchImpl: responding(500, { error: 'boom' }) })
    expect(status.ok).toBe(false)
    expect(status.days).toEqual([])
    expect(status.claimableToday).toBe(false)
  })
})

describe('claimSignin', () => {
  it('claim_result=1 算这次真发了', async () => {
    const outcome = await claimSignin('cn', 't', {
      fetchImpl: responding(200, { data: { claim_result: 1, points: 400 }, base_resp: { status_code: 0 } }),
    })
    expect(outcome).toEqual({ ok: true, claimed: true, message: '已领取 400 积分。' })
  })

  it('claim_result=2 是"今天已领"，不算失败也不算发了', async () => {
    const outcome = await claimSignin('cn', 't', {
      fetchImpl: responding(200, { data: { claim_result: 2 }, base_resp: { status_code: 0 } }),
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.claimed).toBe(false)
  })

  it('走 claim 路由且带时区参数', async () => {
    const fetchImpl = responding(200, { data: { claim_result: 1, points: 1 }, base_resp: { status_code: 0 } })
    await claimSignin('global', 't', { fetchImpl })
    const url = requestedUrl(fetchImpl)
    expect(url).toContain('https://agent.minimax.io/minimax-cloud/api/v1/signin/claim')
    expect(url).toContain('timezone_id=Asia/Shanghai')
  })
})
