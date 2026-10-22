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
  copyLabelOf,
  effectiveRoutesOf,
  expiryTextOf,
  isCopyRoute,
  isRegionEnabled,
  creditsTextOf,
  creditsFactOf,
  formatCredits,
  loginAdviceOf,
  nextModelSelection,
  routesForRegion,
  providerLabelOf,
  routeAdviceOf,
  routeProviderLabelOf,
  sourceLabelKeyOf,
  signinDayToneOf,
  worstLoginStateOf,
} from '../src/client/MiniMaxCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { MiniMaxSettingsKey } from '../src/client/locales.ts'
import type { MiniMaxLoginView, MiniMaxModelView, MiniMaxRouteView, MiniMaxStatusView } from '../src/status-paths.ts'

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
    catalog: [],
    enabledRegions: ['cn', 'global'],
    longContext: false,
    reasoningEffort: 'medium',
    modelOverrides: { images: {}, thinkingOff: {}, contextWindows: {} },
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

/**
 * 造一条**账号副本**路由。
 *
 * 宿主那边副本的路由名是 `minimax-<region>-<短 id>`（`accountRouteOf`），
 * 并且带 `accountId`；本机登录没有 `accountId`。测试要跟这份契约对齐，
 * 否则卡片会对着一个宿主永远不会发出的形状变绿。
 */
function copyRouteOf(
  route: string,
  region: 'cn' | 'global',
  login: MiniMaxLoginView,
  accountId: string,
): MiniMaxRouteView {
  return { ...routeOf(route, region, login), accountId }
}

/**
 * 带参数插值的假翻译函数。
 *
 * 副本的供应商名与建议语都靠 `{label}` 带出短 id，用忽略参数的 `t` 断言
 * 就看不见**参数本身**——而"显示成整条路由名"恰恰是最容易错的地方。
 */
const tp = (key: string, params?: Record<string, unknown>): string => {
  const label = params?.['label']
  return label === undefined ? `zh:${key}` : `zh:${key}:${String(label)}`
}

describe('isCopyRoute', () => {
  it('判据是 accountId，不是路由名的形状', () => {
    // 本机登录：没有 accountId，即便路由名里带得出一样的后缀也不算副本。
    expect(isCopyRoute(routeOf('minimax', 'cn', { state: 'ready', source: 'lease' }))).toBe(false)
    expect(isCopyRoute(copyRouteOf(
      'minimax-cn-cfd703e1',
      'cn',
      { state: 'ready', source: 'file' },
      'cn-cfd703e1',
    ))).toBe(true)
  })
})

describe('copyLabelOf', () => {
  it('本机登录 → undefined（不显示副本相关的一切）', () => {
    expect(copyLabelOf(routeOf('minimax', 'cn', { state: 'ready', source: 'lease' }))).toBeUndefined()
    expect(copyLabelOf(routeOf('minimax-global', 'global', { state: 'ready', source: 'lease' }))).toBeUndefined()
  })

  it('副本 → 取 id 最后一段当短 id', () => {
    expect(copyLabelOf(copyRouteOf(
      'minimax-cn-cfd703e1', 'cn', { state: 'ready', source: 'file' }, 'cn-cfd703e1',
    ))).toBe('cfd703e1')
    expect(copyLabelOf(copyRouteOf(
      'minimax-global-058de9a6', 'global', { state: 'ready', source: 'file' }, 'global-058de9a6',
    ))).toBe('058de9a6')
  })

  it('短 id 退化成像区域名时显示整个 id，不显示和区域列重复的东西', () => {
    expect(copyLabelOf(copyRouteOf(
      'minimax-cn', 'cn', { state: 'expired', source: 'file' }, 'cn',
    ))).toBe('cn')
    expect(copyLabelOf(copyRouteOf(
      'minimax-global', 'global', { state: 'expired', source: 'file' }, 'global',
    ))).toBe('global')
  })

  it('accountId 存在但为空串时回落到路由名的最后一段', () => {
    // 收窄函数只接受非空字符串，所以真实宿主发不出空串；这条钉的是**函数自己**
    // 别在这种情况下返回一个空 label（渲染出 "MiniMax 副本 · " 这种半截话）。
    expect(copyLabelOf(copyRouteOf(
      'minimax-cn-abc12345', 'cn', { state: 'ready', source: 'file' }, '',
    ))).toBe('abc12345')
  })
})

describe('routeProviderLabelOf', () => {
  it('本机登录沿用原来的供应商名', () => {
    expect(routeProviderLabelOf(
      routeOf('minimax', 'cn', { state: 'ready', source: 'lease' }), tp,
    )).toBe('zh:provider.minimax')
    expect(routeProviderLabelOf(
      routeOf('minimax-global', 'global', { state: 'ready', source: 'lease' }), tp,
    )).toBe('zh:provider.minimaxGlobal')
  })

  it('副本的供应商名是 MiniMax 副本 · <短 id>', () => {
    expect(routeProviderLabelOf(
      copyRouteOf('minimax-cn-cfd703e1', 'cn', { state: 'ready', source: 'file' }, 'cn-cfd703e1'), tp,
    )).toBe('zh:provider.minimaxCopy:cfd703e1')
  })

  it('国际版的副本用国际版那份文案，不混进国内版分组名', () => {
    expect(routeProviderLabelOf(
      copyRouteOf('minimax-global-058de9a6', 'global', { state: 'ready', source: 'file' }, 'global-058de9a6'), tp,
    )).toBe('zh:provider.minimaxGlobalCopy:058de9a6')
  })
})

describe('routeAdviceOf 账号副本', () => {
  const dead = { state: 'expired' as const, source: 'file' as const, detail: 'refresh token 已作废（invalid_grant）' }
  const alive = { state: 'expired' as const, source: 'file' as const }

  it('副本过期且带 detail → 说清刷新凭据失效、要重新登录让插件重新镜像', () => {
    expect(routeAdviceOf(
      copyRouteOf('minimax-cn-cfd703e1', 'cn', dead, 'cn-cfd703e1'), tp,
    )).toBe('zh:advice.copy.expiredDead:cfd703e1')
    expect(routeAdviceOf(
      copyRouteOf('minimax-global-058de9a6', 'global', dead, 'global-058de9a6'), tp,
    )).toBe('zh:advice.copy.expiredDead:058de9a6')
  })

  it('副本过期但没 detail → 还能续，不许把用户支去重新登录', () => {
    expect(routeAdviceOf(
      copyRouteOf('minimax-cn-cfd703e1', 'cn', alive, 'cn-cfd703e1'), tp,
    )).toBe('zh:advice.copy.expired:cfd703e1')
  })

  it('副本就绪不给建议语（卡片只为未就绪的路由画建议行）', () => {
    // 走到通用分支：ready + file → 沿用 readyFile，不引入无人消费的副本文案。
    expect(routeAdviceOf(
      copyRouteOf('minimax-cn-cfd703e1', 'cn', { state: 'ready', source: 'file' }, 'cn-cfd703e1'), tp,
    )).toBe('zh:advice.readyFile')
  })

  it('本机登录的过期建议不受副本分支影响', () => {
    expect(routeAdviceOf(routeOf('minimax', 'cn', alive), tp)).toBe('zh:advice.cn.expired')
    expect(routeAdviceOf(routeOf('minimax-global', 'global', alive), tp)).toBe('zh:advice.global.expired')
  })
})

// ---------------------------------------------------------------------------
// 模型勾选：算出"下一个启用列表"
// ---------------------------------------------------------------------------

/** 造一份带目录与启用列表的状态视图。 */
function statusOf(options: {
  catalog: string[]
  enabled: string[]
  regions?: string[]
}): MiniMaxStatusView {
  const model = (id: string): MiniMaxModelView => ({
    id,
    name: id,
    contextWindow: 512_000,
    contextWindowOptions: [512_000, 1_000_000],
    upstreamInput: ['text', 'image'],
    thinkingOff: true,
    efforts: ['low', 'medium', 'high'],
    maxTokens: 128_000,
    input: ['text'],
    reasoning: true,
    thinkingMode: 'switchable',
  })
  return {
    ok: true,
    route: 'minimax',
    region: 'cn',
    regionLabel: '国内版',
    baseUrl: 'https://cn.example/api',
    login: { state: 'ready', source: 'lease' },
    routes: [],
    models: options.enabled.map(model),
    catalog: options.catalog.map(model),
    enabledRegions: options.regions ?? ['cn', 'global'],
    longContext: false,
    reasoningEffort: 'medium',
    modelOverrides: { images: {}, thinkingOff: {}, contextWindows: {} },
    pluginVersion: '0.1.0',
    checkedAt: 0,
  }
}

describe('nextModelSelection', () => {
  const CATALOG = ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7']

  it('空配置=全部启用：关掉其中一个时，从目录而不是空的 models 起算', () => {
    // models 是空的（宿主按"全部"注册），若误从 models 取当前集合，
    // 关一个之后会剩零个 —— 用户点一下就把插件关没了。
    const next = nextModelSelection(statusOf({ catalog: CATALOG, enabled: [] }), 'MiniMax-M3', false)
    expect(next).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M2.7'])
  })

  it('勾上一个未启用的模型', () => {
    const next = nextModelSelection(statusOf({ catalog: CATALOG, enabled: ['MiniMax-M3'] }), 'MiniMax-M2.7', true)
    expect(next).toEqual(['MiniMax-M3', 'MiniMax-M2.7'])
  })

  it('落盘顺序按目录，不按点击顺序', () => {
    // 先勾后面的、再勾前面的：配置里仍是目录顺序，模型选择器不会因点击顺序抖动。
    const status = statusOf({ catalog: CATALOG, enabled: ['MiniMax-M2.7'] })
    expect(nextModelSelection(status, 'MiniMax-M3.1-Flash', true)).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M2.7'])
  })

  it('选满全部时归一成空列表，让上游以后新增的模型自动可见', () => {
    const next = nextModelSelection(statusOf({ catalog: CATALOG, enabled: ['MiniMax-M3'] }), 'MiniMax-M3.1-Flash', true)
    // 还差 M2.7，不该是空；顺序按目录（M3.1-Flash 在 M3 之前）。
    expect(next).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3'])
    const full = nextModelSelection(
      statusOf({ catalog: CATALOG, enabled: ['MiniMax-M3', 'MiniMax-M2.7'] }),
      'MiniMax-M3.1-Flash',
      true,
    )
    expect(full).toEqual([])
  })

  it('拒绝关到零个：返回 null 让调用方给提示', () => {
    const next = nextModelSelection(statusOf({ catalog: CATALOG, enabled: ['MiniMax-M3'] }), 'MiniMax-M3', false)
    expect(next).toBeNull()
  })

  it('空配置下关掉倒数第二个仍然合法（此刻实际启用着三个）', () => {
    const next = nextModelSelection(statusOf({ catalog: CATALOG, enabled: [] }), 'MiniMax-M3.1-Flash', false)
    expect(next).toEqual(['MiniMax-M3', 'MiniMax-M2.7'])
  })
})

describe('isRegionEnabled / routesForRegion', () => {
  const live = routeOf('minimax', 'cn', { state: 'ready', source: 'lease' })
  const copy = { ...routeOf('minimax-cn-aaa', 'cn', { state: 'ready', source: 'file' }), accountId: 'cn-aaa' }
  const globalLive = routeOf('minimax-global', 'global', { state: 'missing', source: 'none' })

  it('未列出的区域算关闭', () => {
    expect(isRegionEnabled(statusOf({ catalog: [], enabled: [], regions: ['cn'] }), 'global')).toBe(false)
    expect(isRegionEnabled(statusOf({ catalog: [], enabled: [], regions: ['cn'] }), 'cn')).toBe(true)
  })

  it('同一区域里本机登录在前、副本在后', () => {
    const ordered = routesForRegion([copy, globalLive, live], 'cn')
    expect(ordered.map(route => route.route)).toEqual(['minimax', 'minimax-cn-aaa'])
  })

  it('另一侧的区域不会混进来', () => {
    expect(routesForRegion([copy, live, globalLive], 'global').map(route => route.route)).toEqual(['minimax-global'])
  })
})

describe('积分与签到的展示换算', () => {
  it('整数不显示成 400.00，小数才保留', () => {
    expect(formatCredits(400)).toBe('400')
    expect(formatCredits(399.989)).toBe('399.99')
  })

  it('余额读不到时用上游原因，而不是显示 0', () => {
    const tp = (key: string) => `zh:${key}`
    expect(creditsTextOf({ error: 'HTTP 401' }, tp)).toBe('HTTP 401')
    expect(creditsTextOf(undefined, tp)).toBe('zh:credits.unavailable')
    expect(creditsTextOf({ balance: { totalRemaining: 400, freeRemaining: 400, purchasedRemaining: 0 } }, tp))
      .toBe('400 zh:credits.unit')
  })

  it('诊断页的"积分读取于"给出真实读取时间', () => {
    const tp = (key: string, params?: Record<string, unknown>) => `zh:${key}${params?.['at'] === undefined ? '' : `@${String(params['at'])}`}`
    const line = creditsFactOf(
      { balance: { totalRemaining: 400, freeRemaining: 400, purchasedRemaining: 0 }, atMs: 1_700_000_000_000 },
      0,
      tp,
    )
    expect(line).toContain('zh:diagnostics.readAt@')
    // 没有 atMs 时退回状态读取时间，不能显示 1970。
    expect(creditsFactOf({ balance: { totalRemaining: 1, freeRemaining: 1, purchasedRemaining: 0 } }, 1_700_000_000_000, tp))
      .toContain('zh:diagnostics.readAt@')
  })

  it('签到状态四值：只有 2 是"今天可以领"', () => {
    expect(signinDayToneOf({ status: 3 })).toBe('claimed')
    expect(signinDayToneOf({ status: 2 })).toBe('claimable')
    expect(signinDayToneOf({ status: 1 })).toBe('upcoming')
    expect(signinDayToneOf({ status: 4 })).toBe('upcoming')
  })
})
