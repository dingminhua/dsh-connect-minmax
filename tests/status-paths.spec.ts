/**
 * 状态路径与卡片视图的纯函数测试（不碰 DOM）。
 *
 * 这些函数是**浏览器半边与宿主半边共享**的收窄层：路由的应答是 JSON，可能
 * 来自旧版本，也可能被别的插件截胡。所以每个字段都要独立校验——**一个坏字段
 * 不能让整份文档作废**，否则一次字段改名就能让卡片变成空白。
 */

import { describe, expect, it } from 'vitest'

import {
  durationPartsOf,
  expiryBucketOf,
  formatContextWindow,
  loginSourceOf,
  loginStateOf,
  MINIMAX_CARD_KEYS,
  MINIMAX_DISPLAY_NAME,
  MINIMAX_ROUTE,
  MINIMAX_STATUS_PATH,
  remainingMsOf,
  toStatusView,
} from '../src/status-paths.ts'

describe('常量', () => {
  it('状态路径与插件身份', () => {
    expect(MINIMAX_STATUS_PATH).toBe('/plugins/dsh-connect-minmax/status')
    expect(MINIMAX_ROUTE).toBe('minimax')
    expect(MINIMAX_DISPLAY_NAME).toBe('MiniMax（本机登录）')
  })

  it('卡片 key 至少含裸包名与 include: 前缀两种拼法', () => {
    // 插件页按**精确相等**在 Set 里查 key，部署方可能用任何拼法。
    expect(MINIMAX_CARD_KEYS).toContain('dsh-connect-minmax')
    expect(MINIMAX_CARD_KEYS).toContain('include:dsh-connect-minmax')
  })
})

describe('loginStateOf', () => {
  it('认识五种状态', () => {
    expect(loginStateOf('ready')).toBe('ready')
    expect(loginStateOf('anonymous')).toBe('anonymous')
    expect(loginStateOf('missing')).toBe('missing')
    expect(loginStateOf('expired')).toBe('expired')
    expect(loginStateOf('error')).toBe('error')
  })

  it('未知值降级成 error 而不是抛错', () => {
    expect(loginStateOf('weird')).toBe('error')
    expect(loginStateOf(undefined)).toBe('error')
    expect(loginStateOf(42)).toBe('error')
  })
})

describe('loginSourceOf', () => {
  it('认识三种来源', () => {
    expect(loginSourceOf('lease')).toBe('lease')
    expect(loginSourceOf('file')).toBe('file')
    expect(loginSourceOf('none')).toBe('none')
  })

  it('未知值降级成 none', () => {
    expect(loginSourceOf('elsewhere')).toBe('none')
    expect(loginSourceOf(null)).toBe('none')
  })
})

describe('toStatusView', () => {
  it('完整文档原样通过', () => {
    const view = toStatusView({
      ok: true,
      route: 'minimax',
      region: 'global',
      regionLabel: '国际版',
      baseUrl: 'https://agent.minimax.io/mavis/api/v1/llm',
      login: { state: 'ready', source: 'lease', generation: 3, expiresAtMs: 123 },
      models: [{ id: 'm1', name: 'M1', contextWindow: 512_000, maxTokens: 128_000, input: ['text', 'image'], reasoning: true }],
      pluginVersion: '0.1.0',
      checkedAt: 999,
    })
    expect(view.ok).toBe(true)
    expect(view.region).toBe('global')
    expect(view.regionLabel).toBe('国际版')
    expect(view.login.state).toBe('ready')
    expect(view.login.generation).toBe(3)
    expect(view.login.expiresAtMs).toBe(123)
    expect(view.models).toHaveLength(1)
    expect(view.models[0]?.input).toEqual(['text', 'image'])
    expect(view.pluginVersion).toBe('0.1.0')
    expect(view.checkedAt).toBe(999)
  })

  it('空/垃圾输入降级成一份可渲染的骨架而不是抛错', () => {
    for (const input of [undefined, null, 42, 'nope', [], {}]) {
      const view = toStatusView(input)
      expect(view.route).toBe('minimax')
      expect(view.models).toEqual([])
      expect(view.login.state).toBe('error')
      expect(view.pluginVersion).toBe('dev')
    }
  })

  it('一个坏字段不让整份文档作废', () => {
    const view = toStatusView({
      login: { state: 'not-a-state', source: 'not-a-source', generation: 'x' },
      models: [{ id: 'good', name: 'G', contextWindow: 10, maxTokens: 5, input: ['text'], reasoning: true }],
    })
    // login 的坏字段各自降级，但 models 仍然读得出来。
    expect(view.login.state).toBe('error')
    expect(view.login.source).toBe('none')
    expect(view.login.generation).toBeUndefined()
    expect(view.models).toHaveLength(1)
    expect(view.models[0]?.id).toBe('good')
  })

  it('缺 id 的模型行被丢掉，其余照常', () => {
    const view = toStatusView({
      models: [
        { name: 'no id' },
        { id: 'ok', name: 'OK', contextWindow: 1, maxTokens: 1, input: 'not-an-array', reasoning: 'yes' },
        'not-an-object',
      ],
    })
    expect(view.models).toHaveLength(1)
    expect(view.models[0]?.id).toBe('ok')
    expect(view.models[0]?.name).toBe('OK')
    expect(view.models[0]?.input).toEqual([])
    expect(view.models[0]?.reasoning).toBe(false)
  })

  it('region 只认 cn / global，其余按 cn', () => {
    expect(toStatusView({ region: 'cn' }).region).toBe('cn')
    expect(toStatusView({ region: 'global' }).region).toBe('global')
    expect(toStatusView({ region: 'mars' }).region).toBe('cn')
  })
})

describe('到期时间', () => {
  it('没有到期时间时返回 undefined', () => {
    expect(remainingMsOf(undefined, 1_000)).toBeUndefined()
    expect(expiryBucketOf(undefined)).toBe('unknown')
  })

  it('已过期 / 分钟 / 小时 / 天四档', () => {
    expect(expiryBucketOf(-1)).toBe('expired')
    expect(expiryBucketOf(0)).toBe('expired')
    expect(expiryBucketOf(5 * 60 * 1000)).toBe('minutes')
    expect(expiryBucketOf(5 * 60 * 60 * 1000)).toBe('hours')
    expect(expiryBucketOf(5 * 24 * 60 * 60 * 1000)).toBe('days')
  })

  it('时长被拆成数值与单位', () => {
    expect(durationPartsOf(90 * 1000)).toEqual({ value: 2, unit: 'minutes' })
    expect(durationPartsOf(2 * 60 * 60 * 1000)).toEqual({ value: 2, unit: 'hours' })
    expect(durationPartsOf(3 * 24 * 60 * 60 * 1000)).toEqual({ value: 3, unit: 'days' })
  })
})

describe('formatContextWindow', () => {
  it('千 / 百万的紧凑写法', () => {
    expect(formatContextWindow(512_000)).toBe('512K')
    expect(formatContextWindow(204_800)).toBe('204.8K')
    expect(formatContextWindow(1_000_000)).toBe('1M')
    expect(formatContextWindow(2_048_000)).toBe('2.048M')
  })

  it('无效值显示为破折号', () => {
    expect(formatContextWindow(0)).toBe('—')
    expect(formatContextWindow(Number.NaN)).toBe('—')
  })
})

describe('authorizing 登录态', () => {
  it('保留等待授权状态，并透出验证码与授权地址', () => {
    const view = toStatusView({
      ok: true,
      login: {
        state: 'authorizing',
        source: 'lease',
        generation: 6,
        userCode: 'KQZR-R2M7',
        verificationUri: 'https://account.minimax.cn/oauth-authorize?user_code=KQZR-R2M7',
      },
      models: [],
    })
    expect(view.login.state).toBe('authorizing')
    expect(view.login.userCode).toBe('KQZR-R2M7')
    expect(view.login.verificationUri).toContain('user_code=KQZR-R2M7')
  })

  it('缺字段时退化成空，不把整份文档弄坏', () => {
    const view = toStatusView({ ok: true, login: { state: 'authorizing', source: 'file' }, models: [] })
    expect(view.login.state).toBe('authorizing')
    expect(view.login.userCode).toBeUndefined()
  })
})

describe('MINIMAX_CARD_KEYS', () => {
  it('同时覆盖 scoped 与裸包名，bundle 级与 row 级都要有', () => {
    expect(MINIMAX_CARD_KEYS).toContain('@dmh2002/dsh-connect-minmax')
    expect(MINIMAX_CARD_KEYS).toContain('dsh-connect-minmax')
    expect(MINIMAX_CARD_KEYS).toContain('@dmh2002/dsh-connect-minmax#dsh-connect-minmax')
    expect(new Set(MINIMAX_CARD_KEYS).size).toBe(MINIMAX_CARD_KEYS.length)
  })
})

describe('账号池投影', () => {
  const base = { ok: true, route: 'minimax', region: 'cn', regionLabel: '国内版', baseUrl: 'https://x', login: { state: 'ready', source: 'lease' }, models: [], catalog: [], enabledRegions: ['cn'], longContext: false, pluginVersion: '1', checkedAt: 1 }

  it('把池解析成视图：谁在用、谁没钱、谁积分已用尽', () => {
    const view = toStatusView({
      ...base,
      routes: [{
        route: 'minimax', region: 'cn', regionLabel: '国内版', baseUrl: 'https://x',
        login: { state: 'ready', source: 'lease' },
        pool: {
          active: 'live',
          accounts: [
            { id: 'live', label: '本机登录', live: true, active: true, balance: 0 },
            { id: 'cn-aaaa1111', label: '副本 1', live: false, active: false, drainedUntilMs: 999 },
          ],
        },
      }],
    })
    expect(view?.routes[0]?.pool?.active).toBe('live')
    expect(view?.routes[0]?.pool?.accounts).toHaveLength(2)
    expect(view?.routes[0]?.pool?.accounts[0]).toMatchObject({ id: 'live', live: true, active: true, balance: 0, drained: false })
    expect(view?.routes[0]?.pool?.accounts[1]).toMatchObject({ id: 'cn-aaaa1111', drained: true })
  })

  it('旧版本应答没有 pool 字段时留空（卡片按单账号处理，不画空池）', () => {
    const view = toStatusView({ ...base, routes: [{ route: 'minimax', region: 'cn', regionLabel: '国内版', baseUrl: 'https://x', login: { state: 'ready', source: 'lease' } }] })
    expect(view?.routes[0]?.pool).toBeUndefined()
  })

  it('accounts 为空数组时也留空（不画一个没有任何账号的池）', () => {
    const view = toStatusView({ ...base, routes: [{ route: 'minimax', region: 'cn', regionLabel: '国内版', baseUrl: 'https://x', login: { state: 'ready', source: 'lease' }, pool: { accounts: [] } }] })
    expect(view?.routes[0]?.pool).toBeUndefined()
  })
})
