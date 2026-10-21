/**
 * 客户端卡片的**纯函数**测试（不碰 DOM）。
 *
 * 这些函数承载了卡片上"用户看到什么"的判断：徽标分档、"你需要做什么"、
 * 到期文案。它们的映射错了，卡片就会把"没登录"显示成红色故障，或者在
 * 已登录时叫用户去登录——所以每一档都要钉死。
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest'

import {
  aggregateBadgeToneOf,
  aggregateLabelKeyOf,
  badgeToneOf,
  effectiveRoutesOf,
  expiryTextOf,
  loginAdviceOf,
  providerLabelOf,
  routeAdviceOf,
  sourceLabelKeyOf,
  worstLoginStateOf,
} from '../src/client/MiniMaxCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { MiniMaxSettingsKey } from '../src/client/locales.ts'
import type { MiniMaxLoginView, MiniMaxRouteView } from '../src/status-paths.ts'

/** 一个把 key 映射成 "zh:<key>" 的假翻译函数，便于断言用了哪个键。 */
const t = (key: string): string => `zh:${key}`

describe('双语案', () => {
  it('中英两份字典的键完全一致', () => {
    // 这个约束由 `zh: Record<MiniMaxSettingsKey, string>` 在编译期强制；
    // 这里再断言一次，是为了让"有人把 zh 改成了 `Partial<>`"这件事在测试
    // 里也立刻暴露。
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('每条文案都非空', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.length, `en.${key}`).toBeGreaterThan(0)
    }
    for (const [key, value] of Object.entries(zh)) {
      expect(value.length, `zh.${key}`).toBeGreaterThan(0)
    }
  })

  it('参数占位符在中英两侧成对出现', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort()
    for (const key of Object.keys(en) as MiniMaxSettingsKey[]) {
      expect(placeholders(zh[key]), `zh.${key}`).toEqual(placeholders(en[key]))
    }
  })

  it('明确写出了"不读 API Key"这条产品承诺', () => {
    expect(en['promise.noApiKey']).toMatch(/API key/i)
    expect(zh['promise.noApiKey']).toContain('API Key')
  })
})

describe('badgeToneOf', () => {
  it('ready 是绿色', () => {
    expect(badgeToneOf('ready')).toBe('ready')
  })

  it('需要用户去做点什么的状态是琥珀色（不是红色）', () => {
    // "没登录"不是一个故障：用户打开 MiniMax Code 登录就好了。用红色会
    // 让人以为插件坏了。
    expect(badgeToneOf('anonymous')).toBe('warn')
    expect(badgeToneOf('missing')).toBe('warn')
    expect(badgeToneOf('expired')).toBe('warn')
  })

  it('error 是红色', () => {
    expect(badgeToneOf('error')).toBe('error')
  })
})

describe('loginAdviceOf', () => {
  it('ready + lease → 说清是 MiniMax Code 供的凭据且自动续期', () => {
    const login: MiniMaxLoginView = { state: 'ready', source: 'lease' }
    expect(loginAdviceOf(login, t)).toBe('zh:advice.readyLease')
  })

  it('ready + file → 说清 MiniMax Code 没在运行', () => {
    const login: MiniMaxLoginView = { state: 'ready', source: 'file' }
    expect(loginAdviceOf(login, t)).toBe('zh:advice.readyFile')
  })

  it('anonymous / missing → 告诉用户去 MiniMax Code 登录', () => {
    expect(loginAdviceOf({ state: 'anonymous', source: 'none' }, t)).toBe('zh:advice.signInRequired')
    expect(loginAdviceOf({ state: 'missing', source: 'none' }, t)).toBe('zh:advice.signInRequired')
  })

  it('expired → 告诉用户重新登录', () => {
    expect(loginAdviceOf({ state: 'expired', source: 'file' }, t)).toBe('zh:advice.expired')
  })

  it('error → 显示宿主给的 detail', () => {
    expect(loginAdviceOf({ state: 'error', source: 'none', detail: 'boom' }, t)).toBe('boom')
  })

  it('error 且没有 detail → 回落到通用的错误文案', () => {
    expect(loginAdviceOf({ state: 'error', source: 'none' }, t)).toBe('zh:login.error')
  })
})

describe('sourceLabelKeyOf', () => {
  it('三种来源各自一个键', () => {
    expect(sourceLabelKeyOf('lease')).toBe('login.sourceLease')
    expect(sourceLabelKeyOf('file')).toBe('login.sourceFile')
    expect(sourceLabelKeyOf('none')).toBe('login.sourceNone')
  })
})

describe('expiryTextOf', () => {
  const now = 1_700_000_000_000

  it('没有到期时间 → 未知', () => {
    expect(expiryTextOf({ state: 'ready', source: 'lease' }, now, t)).toBe('zh:login.expiresUnknown')
  })

  it('已过期', () => {
    expect(expiryTextOf({ state: 'expired', source: 'lease', expiresAtMs: now - 1 }, now, t)).toBe('zh:login.expiredAgo')
  })

  it('分钟 / 小时 / 天三档', () => {
    expect(expiryTextOf({ state: 'ready', source: 'lease', expiresAtMs: now + 5 * 60_000 }, now, t)).toBe('zh:login.inMinutes')
    expect(expiryTextOf({ state: 'ready', source: 'lease', expiresAtMs: now + 5 * 3_600_000 }, now, t)).toBe('zh:login.inHours')
    expect(expiryTextOf({ state: 'ready', source: 'lease', expiresAtMs: now + 5 * 86_400_000 }, now, t)).toBe('zh:login.inDays')
  })
})

/** 造一条路由。 */
function routeOf(
  route: string,
  region: 'cn' | 'global',
  login: MiniMaxLoginView,
): MiniMaxRouteView {
  return {
    route,
    region,
    regionLabel: region === 'global' ? '国际版' : '国内版',
    baseUrl: `https://${route}.example/api`,
    login,
  }
}

describe('worstLoginStateOf', () => {
  it('空数组 → undefined', () => {
    expect(worstLoginStateOf([])).toBeUndefined()
  })

  it('取最严重的那个（error > expired > missing/anonymous > authorizing）', () => {
    expect(worstLoginStateOf(['ready', 'error', 'expired'])).toBe('error')
    expect(worstLoginStateOf(['ready', 'expired', 'missing'])).toBe('expired')
    expect(worstLoginStateOf(['ready', 'anonymous', 'authorizing'])).toBe('anonymous')
    expect(worstLoginStateOf(['ready', 'missing', 'authorizing'])).toBe('missing')
    expect(worstLoginStateOf(['ready', 'authorizing'])).toBe('authorizing')
  })
})

describe('aggregateBadgeToneOf', () => {
  it('没有路由 → 未知色调', () => {
    expect(aggregateBadgeToneOf([])).toBe('unknown')
  })

  it('任一路由就绪 → 绿色', () => {
    expect(aggregateBadgeToneOf([
      routeOf('minimax', 'cn', { state: 'ready', source: 'lease' }),
      routeOf('minimax-global', 'global', { state: 'missing', source: 'none' }),
    ])).toBe('ready')
  })

  it('全未就绪 → 取最严重的那条（琥珀 / 红色）', () => {
    expect(aggregateBadgeToneOf([
      routeOf('minimax', 'cn', { state: 'expired', source: 'file' }),
      routeOf('minimax-global', 'global', { state: 'anonymous', source: 'none' }),
    ])).toBe('warn')
    expect(aggregateBadgeToneOf([
      routeOf('minimax', 'cn', { state: 'anonymous', source: 'none' }),
      routeOf('minimax-global', 'global', { state: 'error', source: 'none' }),
    ])).toBe('error')
  })
})

describe('aggregateLabelKeyOf', () => {
  const ready = routeOf('minimax', 'cn', { state: 'ready', source: 'lease' })
  const missing = routeOf('minimax-global', 'global', { state: 'missing', source: 'none' })

  it('读取中 → row.loading', () => {
    expect(aggregateLabelKeyOf([], true)).toBe('row.loading')
  })

  it('全部就绪 → routes.allReady', () => {
    expect(aggregateLabelKeyOf([ready], false)).toBe('routes.allReady')
  })

  it('部分就绪 → routes.anyReady', () => {
    expect(aggregateLabelKeyOf([ready, missing], false)).toBe('routes.anyReady')
  })

  it('全未就绪 → 最严重那条的状态名', () => {
    expect(aggregateLabelKeyOf([missing], false)).toBe('login.missing')
    expect(aggregateLabelKeyOf([
      routeOf('minimax', 'cn', { state: 'error', source: 'none' }),
      missing,
    ], false)).toBe('login.error')
  })
})

describe('effectiveRoutesOf', () => {
  const base = {
    ok: true,
    route: 'minimax' as const,
    region: 'cn' as const,
    regionLabel: '国内版',
    baseUrl: 'https://cn.example/api',
    login: { state: 'ready' as const, source: 'lease' as const },
    models: [],
    pluginVersion: '0.1.0',
    checkedAt: 0,
  }

  it('routes 有内容时原样返回', () => {
    const routes = [routeOf('minimax', 'cn', { state: 'ready', source: 'lease' })]
    expect(effectiveRoutesOf({ ...base, routes })).toBe(routes)
  })

  it('routes 为空（旧应答）→ 用顶层字段合成一条 minimax 路由', () => {
    const routes = effectiveRoutesOf({ ...base, routes: [] })
    expect(routes.length).toBe(1)
    expect(routes[0]?.route).toBe('minimax')
    expect(routes[0]?.region).toBe('cn')
    expect(routes[0]?.login.state).toBe('ready')
  })
})

describe('routeAdviceOf', () => {
  it('未就绪的国内版与国际版给出不同的建议', () => {
    const cn = routeOf('minimax', 'cn', { state: 'anonymous', source: 'none' })
    const global = routeOf('minimax-global', 'global', { state: 'missing', source: 'none' })
    expect(routeAdviceOf(cn, t)).toBe('zh:advice.cn.signInRequired')
    expect(routeAdviceOf(global, t)).toBe('zh:advice.global.signInRequired')
    expect(routeAdviceOf(cn, t)).not.toBe(routeAdviceOf(global, t))
  })

  it('expired 也分区域', () => {
    expect(routeAdviceOf(
      routeOf('minimax-global', 'global', { state: 'expired', source: 'file' }),
      t,
    )).toBe('zh:advice.global.expired')
  })

  it('authorizing 分区域', () => {
    expect(routeAdviceOf(
      routeOf('minimax-global', 'global', { state: 'authorizing', source: 'none' }),
      t,
    )).toBe('zh:advice.global.authorizing')
  })

  it('ready 沿用就绪建议', () => {
    expect(routeAdviceOf(
      routeOf('minimax', 'cn', { state: 'ready', source: 'lease' }),
      t,
    )).toBe('zh:advice.readyLease')
  })

  it('error 显示宿主给的 detail', () => {
    expect(routeAdviceOf(
      routeOf('minimax', 'cn', { state: 'error', source: 'none', detail: 'boom' }),
      t,
    )).toBe('boom')
  })
})

describe('providerLabelOf', () => {
  it('两条路由各有各的供应商显示名', () => {
    expect(providerLabelOf('minimax', t)).toBe('zh:provider.minimax')
    expect(providerLabelOf('minimax-global', t)).toBe('zh:provider.minimaxGlobal')
  })

  it('不认识的路由名原样显示，不编名字', () => {
    expect(providerLabelOf('minimax-future', t)).toBe('minimax-future')
  })
})
