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

/** 一个把 key 原样返回的翻译函数，便于断言文案键。 */
const t: MiniMaxTranslate = key => key

const MODELS = [
  { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 512_000, maxTokens: 128_000, input: ['text', 'image'], reasoning: true },
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextWindow: 204_800, maxTokens: 131_072, input: ['text'], reasoning: false },
]

/** 一份完整的状态文档。 */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    route: 'minimax',
    region: 'cn',
    regionLabel: '国内版',
    baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm',
    login: { state: 'ready', source: 'lease', generation: 3, expiresAtMs: Date.now() + 3_600_000 },
    models: MODELS,
    pluginVersion: '0.1.0',
    checkedAt: Date.now(),
    ...overrides,
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
    mockFetch(payload({ login: { state: 'anonymous', source: 'none' } }))
    await mount()
    expect(container.innerHTML).toContain('login.anonymous')
    expect(container.innerHTML).toContain('advice.signInRequired')
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
