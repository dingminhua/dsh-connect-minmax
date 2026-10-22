/**
 * 客户端卡片的**渲染**冒烟测试（jsdom）。
 *
 * 渲染的是**真实的**卡片组件（`src/client/MiniMaxCard.tsx`），不是一份手抄
 * 的镜像。本插件族在这件事上栽过跟头：某个仓库里的组件测试渲染的是一份
 * 手抄的副本，它与真实组件悄悄漂移，于是一个坏掉的复选框就发布出去了。
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// React 18 的 `act` 需要这个标志才会认为测试环境已配置好；没有它，
// 每次挂载都会打印一句 "The current testing environment is not configured
// to support act(...)" 的警告，把真正有意义的警告淹掉。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { MiniMaxCard } from '../src/client/MiniMaxCard.tsx'
import type { MiniMaxTranslate } from '../src/client/MiniMaxCard.tsx'

/**
 * 一个把 key 原样返回的翻译函数，便于断言文案键。
 *
 * 带参数的键（验证码、副本短 id 等）把参数拼在后面，这样断言才能看见**参数本身**——
 * 真实 locale 会做同样的插值。
 */
const t: MiniMaxTranslate = (key, params) => {
  const code = params?.['code']
  const label = params?.['label']
  if (code !== undefined) return `${key}:${String(code)}`
  return label === undefined ? key : `${key}:${String(label)}`
}

const MODELS = [
  { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 512_000, maxTokens: 128_000, input: ['text', 'image'], reasoning: true },
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextWindow: 204_800, maxTokens: 131_072, input: ['text'], reasoning: false },
]

/** 一份完整的状态文档：两条路由（国内就绪、国际未就绪）。 */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    route: 'minimax',
    region: 'cn',
    regionLabel: '国内版',
    baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm',
    login: { state: 'ready', source: 'lease', generation: 3, expiresAtMs: Date.now() + 3_600_000 },
    routes: [
      {
        route: 'minimax',
        region: 'cn',
        regionLabel: '国内版',
        baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm',
        login: { state: 'ready', source: 'lease', generation: 3, expiresAtMs: Date.now() + 3_600_000 },
      },
      {
        route: 'minimax-global',
        region: 'global',
        regionLabel: '国际版',
        baseUrl: 'https://api.minimax.io/v1/llm',
        login: { state: 'missing', source: 'none' },
      },
    ],
    models: MODELS,
    pluginVersion: '0.1.0',
    checkedAt: Date.now(),
    ...overrides,
  }
}

/** 旧版本应答：没有 `routes` 字段。 */
function legacyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return payload({ routes: [], ...overrides })
}

/** 从一份 payload 里取出 routes，便于"两条本机登录 + 若干副本"地拼路由。 */
function routesOf(body: Record<string, unknown>): Record<string, unknown>[] {
  return (body['routes'] as Record<string, unknown>[]).map(route => ({ ...route }))
}

/** 造一条**本机登录**路由（不带 `accountId`，这是副本判据的另一半）。 */
function routeOfState(
  route: string,
  region: 'cn' | 'global',
  login: Record<string, unknown>,
): Record<string, unknown> {
  return {
    route,
    region,
    regionLabel: region === 'global' ? '国际版' : '国内版',
    baseUrl: region === 'global'
      ? 'https://api.minimax.io/v1/llm'
      : 'https://agent.minimax.cn/mavis/api/v1/llm',
    login,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

/** 挂载卡片并让 effect 里的 fetch 结算。 */
async function mount(): Promise<void> {
  await act(async () => {
    root.render(<MiniMaxCard t={t} />)
  })
}

/**
 * 新卡片的 DOM 定位工具。
 *
 * 一律**按文本内容**定位，不按 class 下标：卡片里有好几组结构相同的行
 * （账号行、模型行），靠下标取会在有人调整区块顺序时静默测到另一组。
 */

/** 某个区域的 tab（含区域名与开关）。 */
function regionTab(region: 'cn' | 'global'): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('.dsm-minimax-tab'))
    .find(tab => tab.textContent?.includes(`region.${region}`))
}

/** 切到某个区域。 */
async function clickRegion(region: 'cn' | 'global'): Promise<void> {
  const button = regionTab(region)?.querySelector('button')
  expect(button, `区域 tab ${region}`).toBeDefined()
  await act(async () => {
    (button as HTMLElement).click()
  })
}

/** 切到某个子页（`t` 把键原样返回，所以文本就是 `panel.models`）。 */
async function clickPanel(panel: 'account' | 'models' | 'diagnostics'): Promise<void> {
  const button = Array.from(container.querySelectorAll('.dsm-minimax-subtab'))
    .find(tab => tab.textContent?.includes(`panel.${panel}`))
  expect(button, `子页 ${panel}`).toBeDefined()
  await act(async () => {
    (button as HTMLElement).click()
  })
}

/** 某个路由/模型的整行。 */
function cardRowOf(name: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('.dsm-minimax-row'))
    .find(row => row.querySelector('.dsm-minimax-model-id')?.textContent?.includes(name))
}

/** 行左侧主体（供应商名、副本角标、建议语）。 */
function rowMain(name: string): string {
  const row = cardRowOf(name)
  expect(row, `应当有一行 ${name}`).toBeDefined()
  return row?.querySelector('.dsm-minimax-row-main')?.textContent ?? ''
}

/** 行右侧（登录态徽标、到期、凭据来源、按钮）。 */
function rowSide(name: string): string {
  const row = cardRowOf(name)
  expect(row, `应当有一行 ${name}`).toBeDefined()
  return row?.querySelector('.dsm-minimax-row-side')?.textContent ?? ''
}

/** 账号页里某个路由的行；不存在时返回 undefined（供"不该出现"的断言用）。 */
function accountRowOf(name: string): HTMLElement | undefined {
  return cardRowOf(name)
}

/** 账号页底部那句副本说明（只在真有副本时出现）。 */
function copyHintText(): string {
  const hints = Array.from(container.querySelectorAll('.dsm-minimax-panel > .dsm-minimax-hint'))
  return hints.map(hint => hint.textContent ?? '').find(text => text.includes('routes.copyHint')) ?? ''
}

/** 让 fetch 回一份指定文档。 */
function mockFetch(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })))
}

describe('MiniMaxCard 渲染', () => {
  it('读到状态后渲染出登录态；模型页切过去才有模型', async () => {
    mockFetch(payload())
    await mount()
    const html = container.innerHTML
    expect(html).toContain('login.ready')
    expect(html).toContain('promise.noApiKey')
    // 账号页不该顺手把模型清单也画出来（那是另一个子页的职责）。
    expect(html).not.toContain('MiniMax-M3')
    await clickPanel('models')
    const models = container.innerHTML
    expect(models).toContain('MiniMax-M3')
    expect(models).toContain('MiniMax-M2.7')
  })

  it('未登录时给出"去 MiniMax Code 登录"的建议', async () => {
    mockFetch(payload({
      login: { state: 'anonymous', source: 'none' },
      routes: [
        {
          route: 'minimax',
          region: 'cn',
          regionLabel: '国内版',
          baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm',
          login: { state: 'anonymous', source: 'none' },
        },
      ],
    }))
    await mount()
    expect(container.innerHTML).toContain('login.anonymous')
    expect(container.innerHTML).toContain('advice.cn.signInRequired')
  })

  it('HTTP 失败时显示"无法读取状态"而不是崩掉', async () => {
    mockFetch(undefined, false, 500)
    await mount()
    expect(container.innerHTML).toContain('row.unreachable')
    // 卡片仍然渲染出骨架，而不是白屏。
    expect(container.innerHTML).toContain('dsm-minimax-card')
  })

  it('JSON 解析失败时显示"无法读取状态"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json') },
    })))
    await mount()
    expect(container.innerHTML).toContain('row.unreachable')
  })

  it('网络异常时显示"无法读取状态"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await mount()
    expect(container.innerHTML).toContain('row.unreachable')
  })

  it('坏文档被降级成骨架而不是抛错', async () => {
    mockFetch({ nonsense: true })
    await mount()
    expect(container.innerHTML).toContain('dsm-minimax-card')
    expect(container.innerHTML).toContain('login.error')
  })

  it('样式表被注入到 document.head', async () => {
    mockFetch(payload())
    await mount()
    const styles = Array.from(document.head.querySelectorAll('style[data-plugin-css]'))
    expect(styles.length).toBeGreaterThan(0)
    expect(styles[0]?.textContent).toContain('dsm-minimax-card')
  })
})

describe('MiniMaxCard 多路由渲染', () => {
  it('两个区域各自成 tab；切过去才渲染那一侧的行', async () => {
    mockFetch(payload())
    await mount()
    // 两个 tab 都在（即使某侧未登录），区域名与就绪状态一眼可辨。
    expect(regionTab('cn')?.textContent ?? '').toContain('region.cn')
    expect(regionTab('global')?.textContent ?? '').toContain('region.global')
    expect(rowMain('minimax')).toContain('provider.minimax')
    expect(rowSide('minimax')).toContain('login.ready')
    expect(rowSide('minimax')).toContain('routes.expires')
    // 默认只看国内版：国际版那一行不该混进来。
    expect(accountRowOf('minimax-global')).toBeUndefined()
    await clickRegion('global')
    expect(rowMain('minimax-global')).toContain('provider.minimaxGlobal')
    expect(rowSide('minimax-global')).toContain('login.missing')
  })

  it('汇总徽标：任一路由就绪就是绿色（routes.anyReady）', async () => {
    mockFetch(payload())
    await mount()
    expect(container.innerHTML).toContain('dsm-minimax-badge-ready')
    expect(container.innerHTML).toContain('routes.anyReady')
  })

  it('汇总徽标：全未就绪时取最严重的那条', async () => {
    mockFetch(payload({
      login: { state: 'expired', source: 'file' },
      routes: [
        {
          route: 'minimax',
          region: 'cn',
          regionLabel: '国内版',
          baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm',
          login: { state: 'expired', source: 'file' },
        },
        {
          route: 'minimax-global',
          region: 'global',
          regionLabel: '国际版',
          baseUrl: 'https://api.minimax.io/v1/llm',
          login: { state: 'anonymous', source: 'none' },
        },
      ],
    }))
    await mount()
    const html = container.innerHTML
    expect(html).toContain('dsm-minimax-badge-warn')
    expect(html).toContain('login.expired')
    // 每条未就绪的路由各给一句建议，且区分区域。
    expect(html).toContain('advice.cn.expired')
    expect(html).toContain('advice.global.signInRequired')
  })

  it('全部就绪时给出就绪建议', async () => {
    mockFetch(payload({
      login: { state: 'ready', source: 'lease' },
      routes: [
        {
          route: 'minimax',
          region: 'cn',
          regionLabel: '国内版',
          baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm',
          login: { state: 'ready', source: 'lease' },
        },
        {
          route: 'minimax-global',
          region: 'global',
          regionLabel: '国际版',
          baseUrl: 'https://api.minimax.io/v1/llm',
          login: { state: 'ready', source: 'lease' },
        },
      ],
    }))
    await mount()
    const html = container.innerHTML
    expect(html).toContain('routes.allReady')
    expect(html).toContain('advice.readyLease')
  })

  it('authorizing 的路由行显示验证码与授权链接', async () => {
    mockFetch(payload({
      login: { state: 'authorizing', source: 'none', userCode: 'ABCD-1234', verificationUri: 'https://example.test/device' },
      routes: [
        {
          route: 'minimax-global',
          region: 'global',
          regionLabel: '国际版',
          baseUrl: 'https://api.minimax.io/v1/llm',
          login: {
            state: 'authorizing',
            source: 'none',
            userCode: 'ABCD-1234',
            verificationUri: 'https://example.test/device',
          },
        },
      ],
    }))
    await mount()
    // 这条 authorizing 路由是国际版的，默认页看不到——先切区域。
    await clickRegion('global')
    const html = container.innerHTML
    expect(html).toContain('login.authorizing')
    expect(html).toContain('advice.authorizingCode')
    expect(html).toContain('ABCD-1234')
    expect(html).toContain('https://example.test/device')
    expect(html).toContain('advice.global.authorizing')
  })

  it('routes 为空（旧应答）退化成单路由渲染，不白屏', async () => {
    mockFetch(legacyPayload())
    await mount()
    const html = container.innerHTML
    expect(html).toContain('dsm-minimax-card')
    // 合成出来的那一条路由：国内版 / minimax。
    expect(html).toContain('provider.minimax')
    expect(html).toContain('region.cn')
    expect(html).toContain('login.ready')
    // 国际版没有可合成的路由：tab 还在，但那一侧没有任何行。
    await clickRegion('global')
    expect(accountRowOf('minimax-global')).toBeUndefined()
    expect(container.innerHTML).toContain('account.noneRegistered')
  })

  it('routes 为空且未登录时，仍给出建议而不是白屏', async () => {
    mockFetch(legacyPayload({ login: { state: 'anonymous', source: 'none' } }))
    await mount()
    const html = container.innerHTML
    expect(html).toContain('dsm-minimax-card')
    expect(html).toContain('login.anonymous')
    expect(html).toContain('advice.cn.signInRequired')
    // 旧应答下积分/签到读不到，页面仍要完整画出来而不是崩。
    expect(html).toContain('credits.unavailable')
  })
})

/**
 * 账号副本。
 *
 * 宿主那边副本是一条**独立注册**的 provider 路由：路由名 `minimax-<区域>-<短 id>`、
 * 带 `accountId`、续期由插件自己负责（所以 `source` 是 `file`，不是 `lease`）。
 * 测试用这份形状，而不是随手编一个能渲染的物件。
 */
function copyRoute(options: {
  short: string
  region: 'cn' | 'global'
  login: Record<string, unknown>
}): Record<string, unknown> {
  const route = `minimax-${options.region}-${options.short}`
  return {
    route,
    accountId: `${options.region}-${options.short}`,
    region: options.region,
    regionLabel: options.region === 'global' ? '国际版' : '国内版',
    baseUrl: options.region === 'global'
      ? 'https://api.minimax.io/v1/llm'
      : 'https://agent.minimax.cn/mavis/api/v1/llm',
    login: options.login,
  }
}

describe('MiniMaxCard 账号副本渲染', () => {
  it('副本行：供应商名带短 id，区域列后面有「副本」角标', async () => {
    mockFetch(payload({
      routes: [
        ...routesOf(payload()),
        copyRoute({ short: 'cfd703e1', region: 'cn', login: { state: 'ready', source: 'file', expiresAtMs: Date.now() + 3_600_000 } }),
      ],
    }))
    await mount()
    // 副本行：供应商名带短 id（t 把 label 拼在键后面），并挂「副本」角标。
    const copyMain = rowMain('minimax-cn-cfd703e1')
    expect(copyMain).toContain('provider.minimaxCopy:cfd703e1')
    expect(copyMain).toContain('routes.copy')
    // 本机登录那行不受影响：沿用普通供应商名，也没有副本角标。
    const localMain = rowMain('minimax')
    expect(localMain).toContain('provider.minimax')
    expect(localMain).not.toContain('provider.minimaxCopy')
    expect(localMain).not.toContain('routes.copy')
  })

  it('本机登录行没有「副本」角标，也没有副本供应商名', async () => {
    mockFetch(payload())
    await mount()
    expect(rowMain('minimax')).not.toContain('routes.copy')
    await clickRegion('global')
    expect(rowMain('minimax-global')).not.toContain('routes.copy')
    const html = container.innerHTML
    expect(html).not.toContain('provider.minimaxCopy')
    expect(html).not.toContain('provider.minimaxGlobalCopy')
  })

  it('有副本时，路由表下方给出说明；没有副本时不给（免得让人以为漏配）', async () => {
    mockFetch(payload({ routes: [copyRoute({ short: 'cfd703e1', region: 'cn', login: { state: 'ready', source: 'file' } })] }))
    await mount()
    // 说明语挂在**路由表下方**，而不是别处的 hint 段落里。
    expect(copyHintText()).toContain('routes.copyHint')

    // 换一份"没有副本"的应答：重新挂载同一棵树，说明语应当消失。
    act(() => { root.unmount() })
    root = createRoot(container)
    mockFetch(payload())
    await mount()
    expect(container.innerHTML).not.toContain('routes.copyHint')
    expect(copyHintText()).toBe('')
  })

  it('国际版副本用国际版那份供应商文案', async () => {
    mockFetch(payload({
      routes: [copyRoute({
        short: '058de9a6',
        region: 'global',
        login: { state: 'ready', source: 'file' },
      })],
    }))
    await mount()
    await clickRegion('global')
    const html = container.innerHTML
    expect(html).toContain('provider.minimaxGlobalCopy:058de9a6')
    expect(html).not.toContain('provider.minimaxCopy:')
    expect(html).toContain('region.global')
    expect(html).toContain('routes.copy')
  })

  it('副本 expired 且带 detail → 建议语说明刷新凭据已失效、要重新登录让插件重新镜像', async () => {
    mockFetch(payload({
      routes: [
        routeOfState('minimax', 'cn', { state: 'ready', source: 'lease' }),
        copyRoute({
          short: 'cfd703e1',
          region: 'cn',
          login: {
            state: 'expired',
            source: 'file',
            expiresAtMs: Date.now() - 1_000,
            detail: 'refresh token 已作废（invalid_grant）',
          },
        }),
      ],
    }))
    await mount()
    const html = container.innerHTML
    expect(html).toContain('advice.copy.expiredDead:cfd703e1')
    expect(html).toContain('login.expired')
    // 不该把用户支去"去 MiniMax Code 重新登录国内版"那条通用建议上。
    expect(html).not.toContain('advice.cn.expired')
    // 聚合徽标逻辑不变：另有一条 ready 路由 → 仍是绿色。
    expect(html).toContain('dsm-minimax-badge-ready')
    expect(html).toContain('routes.anyReady')
  })

  it('副本 expired 但没 detail → 用"还能续、刷新卡片"那条建议', async () => {
    mockFetch(payload({
      routes: [
        routeOfState('minimax', 'cn', { state: 'ready', source: 'lease' }),
        copyRoute({
          short: 'cfd703e1',
          region: 'cn',
          login: { state: 'expired', source: 'file', expiresAtMs: Date.now() - 1_000 },
        }),
      ],
    }))
    await mount()
    const html = container.innerHTML
    expect(html).toContain('advice.copy.expired:cfd703e1')
    expect(html).not.toContain('advice.copy.expiredDead')
    expect(html).not.toContain('advice.cn.expired')
  })

  it('副本就绪时不额外画建议行（只有未就绪的路由才有）', async () => {
    mockFetch(payload({
      routes: [
        routeOfState('minimax', 'cn', { state: 'ready', source: 'lease' }),
        copyRoute({ short: 'cfd703e1', region: 'cn', login: { state: 'ready', source: 'file' } }),
      ],
    }))
    await mount()
    const html = container.innerHTML
    expect(html).toContain('routes.allReady')
    expect(html).not.toContain('advice.copy')
    // 就绪副本的 ready 徽标只出现在路由表里，整张卡没有多余的建议段落。
    expect(html).toContain('dsm-minimax-badge-ready')
  })

  it('两条同区域副本各自显示自己的短 id，不互相覆盖', async () => {
    mockFetch(payload({
      routes: [
        routeOfState('minimax', 'cn', { state: 'ready', source: 'lease' }),
        copyRoute({ short: 'cfd703e1', region: 'cn', login: { state: 'ready', source: 'file' } }),
        copyRoute({ short: 'aa11bb22', region: 'cn', login: { state: 'ready', source: 'file' } }),
      ],
    }))
    await mount()
    const html = container.innerHTML
    expect(html).toContain('provider.minimaxCopy:cfd703e1')
    expect(html).toContain('provider.minimaxCopy:aa11bb22')
  })
})
