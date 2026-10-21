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
 * 带参数的键（验证码等）把参数拼在后面，这样断言才能看见**参数本身**——
 * 真实 locale 会做同样的插值。
 */
const t: MiniMaxTranslate = (key, params) => {
  const code = params?.['code']
  return code === undefined ? key : `${key}:${String(code)}`
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

/** 让 fetch 回一份指定文档。 */
function mockFetch(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })))
}

describe('MiniMaxCard 渲染', () => {
  it('读到状态后渲染出模型表与登录态', async () => {
    mockFetch(payload())
    await mount()
    const html = container.innerHTML
    expect(html).toContain('MiniMax-M3')
    expect(html).toContain('MiniMax-M2.7')
    expect(html).toContain('login.ready')
    expect(html).toContain('promise.noApiKey')
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
  it('每条路由渲染一行：路由名、供应商、区域、登录态、到期', async () => {
    mockFetch(payload())
    await mount()
    const html = container.innerHTML
    expect(html).toContain('routes.label')
    expect(html).toContain('minimax-global')
    expect(html).toContain('provider.minimax')
    expect(html).toContain('provider.minimaxGlobal')
    expect(html).toContain('region.cn')
    expect(html).toContain('region.global')
    expect(html).toContain('routes.state')
    expect(html).toContain('routes.expires')
    // 国内就绪、国际未就绪：两行的登录态徽标不同。
    expect(html).toContain('login.ready')
    expect(html).toContain('login.missing')
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
    expect(html).toContain('routes.label')
    expect(html).toContain('provider.minimax')
    expect(html).toContain('region.cn')
    expect(html).toContain('login.ready')
    // 国际版那一行**不该**出现。
    expect(html).not.toContain('minimax-global')
  })

  it('routes 为空且未登录时，仍给出建议而不是白屏', async () => {
    mockFetch(legacyPayload({ login: { state: 'anonymous', source: 'none' } }))
    await mount()
    const html = container.innerHTML
    expect(html).toContain('dsm-minimax-card')
    expect(html).toContain('login.anonymous')
    expect(html).toContain('advice.cn.signInRequired')
  })
})
