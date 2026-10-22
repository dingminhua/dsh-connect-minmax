/**
 * 卡片**交互**测试：点下去到底写了什么。
 *
 * 渲染冒烟测试（`client-card-render.spec.tsx`）只证明"画得出来"；这一份证明
 * "点了以后写对了"。分开放是因为这两类断言失效方式不同：结构变了渲染测试会红，
 * 而写入语义错了（比如把"全部启用"写成关闭全部）只有这里能抓到。
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { MiniMaxCard } from '../src/client/MiniMaxCard.tsx'
import type { MiniMaxTranslate } from '../src/client/MiniMaxCard.tsx'
import {
  MINIMAX_ACCOUNT_REMOVE_PATH,
  MINIMAX_ACCOUNT_SELECT_PATH,
  MINIMAX_SIGNIN_CLAIM_PATH,
  MINIMAX_STATUS_PATH,
} from '../src/status-paths.ts'
import type { MiniMaxSettingsScope } from '../src/client/settings.ts'

const t: MiniMaxTranslate = (key, params) => {
  const code = params?.['code']
  const label = params?.['label']
  const amount = params?.['amount']
  if (code !== undefined) return `${key}:${String(code)}`
  if (amount !== undefined) return `${key}:${String(amount)}`
  return label === undefined ? key : `${key}:${String(label)}`
}

const CATALOG = [
  { id: 'MiniMax-M3.1-Flash', name: 'M3.1-Flash', contextWindow: 512_000, contextWindowOptions: [512_000, 1_000_000], upstreamInput: ['text', 'image'], maxTokens: 128_000, input: ['text', 'image'], reasoning: true, thinkingMode: 'forced' },
  { id: 'MiniMax-M3', name: 'M3', contextWindow: 512_000, contextWindowOptions: [512_000, 1_000_000], upstreamInput: ['text', 'image'], maxTokens: 128_000, input: ['text', 'image'], reasoning: true, thinkingMode: 'switchable' },
  { id: 'MiniMax-M2.7', name: 'M2.7', contextWindow: 204_800, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, thinkingMode: 'switchable' },
]

/** 一条就绪的国内版路由，带积分与"今天可领"的签到。 */
function liveRoute(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route: 'minimax',
    region: 'cn',
    regionLabel: '国内版',
    baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm',
    login: { state: 'ready', source: 'lease', generation: 15, expiresAtMs: Date.now() + 3_600_000 },
    credits: {
      atMs: Date.now(),
      balance: { totalRemaining: 400, freeRemaining: 400, purchasedRemaining: 0 },
      lotCount: 1,
      expiringIn30d: 400,
      earliestExpiryMs: Date.now() + 20 * 86_400_000,
    },
    signin: {
      ok: true,
      claimableToday: true,
      days: [
        { dayNo: 1, points: 400, status: 3, isToday: false },
        { dayNo: 2, points: 400, status: 2, isToday: true },
      ],
    },
    ...overrides,
  }
}

function statusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    route: 'minimax',
    region: 'cn',
    regionLabel: '国内版',
    baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm',
    login: { state: 'ready', source: 'lease' },
    routes: [
      liveRoute(),
      {
        route: 'minimax-global',
        region: 'global',
        regionLabel: '国际版',
        baseUrl: 'https://agent.minimax.io/mavis/api/v1/llm',
        login: { state: 'ready', source: 'lease', expiresAtMs: Date.now() + 3_600_000 },
      },
    ],
    models: CATALOG,
    catalog: CATALOG,
    enabledRegions: ['cn', 'global'],
    longContext: false,
    reasoningEffort: 'medium',
    pluginVersion: '0.5.0',
    checkedAt: Date.now(),
    ...overrides,
  }
}

/** 记录写入的设置作用域。 */
function recordingScope(payload: () => Record<string, unknown>): MiniMaxSettingsScope & {
  writes: Array<{ field: string, value: unknown }>
} {
  const writes: Array<{ field: string, value: unknown }> = []
  return {
    writes,
    getSnapshot: () => ({ value: payload() }),
    set: async (field, value) => {
      writes.push({ field, value })
      return true
    },
  }
}

let container: HTMLDivElement
let root: Root
let posted: Array<{ path: string, body: Record<string, unknown> }>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  posted = []
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * 让 fetch 按 URL/方法分流。
 *
 * 状态是 GET、三个动作是 POST；`status()` 可以随测试推进变化，因为写配置后
 * 卡片会重读一次——断言"点了以后界面跟着变"必须靠这个。
 */
function mockRoutes(options: {
  status: () => Record<string, unknown>
  claimResult?: { ok: boolean, claimed: boolean, message?: string }
}): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string, body?: string }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'POST') {
      posted.push({ path: url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      const body = url === MINIMAX_SIGNIN_CLAIM_PATH
        ? options.claimResult ?? { ok: true, claimed: true, message: '已领取 400 积分。' }
        : { ok: true, removed: 'cn-x' }
      return { ok: true, status: 200, json: async () => body }
    }
    if (url === MINIMAX_STATUS_PATH) {
      return { ok: true, status: 200, json: async () => options.status() }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
  }))
}

async function mount(scope?: MiniMaxSettingsScope): Promise<void> {
  await act(async () => {
    root.render(<MiniMaxCard t={t} {...(scope === undefined ? {} : { settingsScope: scope })} />)
  })
}

async function clickText(selector: string, text: string): Promise<void> {
  const node = Array.from(container.querySelectorAll(selector)).find(el => el.textContent?.includes(text))
  expect(node, `找不到 ${selector} 里含「${text}」的元素`).toBeDefined()
  await act(async () => {
    (node as HTMLElement).click()
  })
}

/** 写入是异步的，且卡片会等 400ms 再重读；把这两段都放过去。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 600))
  })
}

describe('模型页勾选写入', () => {
  it('关掉一个模型 → 写 models，且落盘的是目录顺序的补集', async () => {
    let payload = statusPayload()
    mockRoutes({ status: () => payload })
    const scope = recordingScope(() => payload)
    await mount(scope)
    await clickText('.dsm-minimax-subtab', 'panel.models')
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-minimax-row input[type=checkbox]'))
    // 第一个模型行：[0] 是"启用模型"。
    await act(async () => {
      boxes[0]?.click()
    })
    await settle()
    const write = scope.writes.find(entry => entry.field === 'models')
    expect(write?.value).toEqual(['MiniMax-M3', 'MiniMax-M2.7'])
  })

  it('关到只剩最后一个时拒绝写入并给提示', async () => {
    let payload = statusPayload({ models: [CATALOG[0]] })
    mockRoutes({ status: () => payload })
    const scope = recordingScope(() => payload)
    await mount(scope)
    await clickText('.dsm-minimax-subtab', 'panel.models')
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-minimax-row input[type=checkbox]'))
    await act(async () => {
      boxes[0]?.click()
    })
    await settle()
    expect(scope.writes.some(entry => entry.field === 'models')).toBe(false)
    expect(container.innerHTML).toContain('models.lastEnabled')
  })

  it('「全部启用」写空列表（宿主语义：空 = 目录全部）', async () => {
    let payload = statusPayload({ models: [CATALOG[0]] })
    mockRoutes({ status: () => payload })
    const scope = recordingScope(() => payload)
    await mount(scope)
    await clickText('.dsm-minimax-subtab', 'panel.models')
    await clickText('button', 'models.selectAll')
    await settle()
    expect(scope.writes.find(entry => entry.field === 'models')?.value).toEqual([])
  })

  it('已全部启用时不出现「全部启用」按钮（那是一次无操作）', async () => {
    mockRoutes({ status: () => statusPayload() })
    await mount(recordingScope(() => statusPayload()))
    await clickText('.dsm-minimax-subtab', 'panel.models')
    expect(container.innerHTML).not.toContain('models.selectAll')
  })

  it('上下文档位 radio：改档位写 modelContextWindows', async () => {
    let payload = statusPayload()
    mockRoutes({ status: () => payload })
    const scope = recordingScope(() => payload)
    await mount(scope)
    await clickText('.dsm-minimax-subtab', 'panel.models')
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-minimax-row input[type=radio]'))
    expect(radios.length).toBeGreaterThanOrEqual(2)
    // 第二个 radio 是 1M 档（workbuddy 同款：逐档 radio 而不是下拉框）。
    await act(async () => { radios[1]?.click() })
    await settle()
    const write = scope.writes.find(entry => entry.field === 'modelContextWindows')
    expect(write?.value).toMatchObject({ 'MiniMax-M3.1-Flash': 1_000_000 })
  })

  it('只有单档的模型只画一个（禁用）档，用户看得出没有别的选择', async () => {
    mockRoutes({ status: () => statusPayload() })
    await mount(recordingScope(() => statusPayload()))
    await clickText('.dsm-minimax-subtab', 'panel.models')
    const rows = Array.from(container.querySelectorAll('.dsm-minimax-row'))
    const m27 = rows.find(row => row.textContent?.includes('MiniMax-M2.7'))
    const radios = Array.from(m27?.querySelectorAll<HTMLInputElement>('input[type=radio]') ?? [])
    expect(radios).toHaveLength(1)
    expect(radios[0]?.disabled).toBe(true)
  })
})

describe('区域开关写入', () => {
  it('关掉国际版 → regions 只剩 cn', async () => {
    let payload = statusPayload()
    mockRoutes({ status: () => payload })
    const scope = recordingScope(() => payload)
    await mount(scope)
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-minimax-tab input[type=checkbox]'))
    expect(boxes.length).toBe(2)
    await act(async () => {
      boxes[1]?.click()
    })
    await settle()
    expect(scope.writes.find(entry => entry.field === 'regions')?.value).toEqual(['cn'])
  })

  it('拒绝关掉最后一个区域，且不写入', async () => {
    let payload = statusPayload({ enabledRegions: ['cn'], routes: [liveRoute()] })
    mockRoutes({ status: () => payload })
    const scope = recordingScope(() => payload)
    await mount(scope)
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('.dsm-minimax-tab input[type=checkbox]'))
    await act(async () => {
      boxes[0]?.click()
    })
    await settle()
    expect(scope.writes.some(entry => entry.field === 'regions')).toBe(false)
    expect(container.innerHTML).toContain('region.lastOne')
  })
})

describe('账号页动作', () => {
  it('删除副本 → POST 带 accountId', async () => {
    let payload = statusPayload({
      routes: [
        liveRoute(),
        {
          route: 'minimax-cn-cfd703e1',
          accountId: 'cn-cfd703e1',
          region: 'cn',
          regionLabel: '国内版',
          baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm',
          login: { state: 'ready', source: 'file', expiresAtMs: Date.now() + 3_600_000 },
        },
      ],
    })
    mockRoutes({ status: () => payload })
    await mount(recordingScope(() => payload))
    const buttons = Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'account.delete')
    expect(buttons.length).toBe(1)
    await act(async () => {
      buttons[0]?.click()
    })
    await settle()
    const call = posted.find(entry => entry.path === MINIMAX_ACCOUNT_REMOVE_PATH)
    expect(call?.body).toEqual({ id: 'cn-cfd703e1' })
  })

  it('本机登录行不给删除按钮（它不是插件的副本，删了也删不掉登录态）', async () => {
    mockRoutes({ status: () => statusPayload() })
    await mount(recordingScope(() => statusPayload()))
    expect(container.querySelectorAll('button').length === 0
      || Array.from(container.querySelectorAll('button')).every(b => b.textContent !== 'account.delete')).toBe(true)
  })

  it('今天可领时按钮可用，点击后 POST claim', async () => {
    let payload = statusPayload()
    mockRoutes({ status: () => payload })
    await mount(recordingScope(() => payload))
    const claim = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'signin.claim')
    expect(claim).toBeDefined()
    expect(claim?.disabled).toBe(false)
    await act(async () => {
      claim?.click()
    })
    await settle()
    expect(posted.some(entry => entry.path === MINIMAX_SIGNIN_CLAIM_PATH)).toBe(true)
  })

  it('上游说今天不能领时按钮禁用（绝不自动发写请求）', async () => {
    const payload = statusPayload({
      routes: [liveRoute({ signin: { ok: true, claimableToday: false, days: [{ dayNo: 1, points: 400, status: 3, isToday: true }] } })],
    })
    mockRoutes({ status: () => payload })
    await mount(recordingScope(() => payload))
    const claim = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'signin.claim')
    expect(claim?.disabled).toBe(true)
    expect(posted).toEqual([])
  })

  it('积分余额与到期显示在账号页', async () => {
    mockRoutes({ status: () => statusPayload() })
    await mount(recordingScope(() => statusPayload()))
    const html = container.innerHTML
    expect(html).toContain('credits.balance')
    expect(html).toContain('400')
    expect(html).toContain('credits.lots')
  })
})

describe('账号池', () => {
  const withPool = (): Record<string, unknown> => statusPayload({
    routes: [
      liveRoute({
        pool: {
          active: 'live',
          accounts: [
            { id: 'live', label: '本机登录', live: true, active: true, balance: 0 },
            { id: 'cn-aaaa1111', label: '副本 1', live: false, active: false, balance: 320 },
          ],
        },
      }),
    ],
  })

  it('池里有两个号时列出它们，标出谁在用、各自多少积分', async () => {
    mockRoutes({ status: withPool })
    await mount(recordingScope(withPool))
    const html = container.innerHTML
    expect(html).toContain('pool.title')
    expect(html).toContain('本机登录')
    expect(html).toContain('pool.active')
    expect(html).toContain('320')
  })

  it('点「用这个号」→ POST account/select 带 region 与 id', async () => {
    mockRoutes({ status: withPool })
    await mount(recordingScope(withPool))
    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'pool.setActive')
    expect(button).toBeDefined()
    await act(async () => { button?.click() })
    await settle()
    const call = posted.find(entry => entry.path === MINIMAX_ACCOUNT_SELECT_PATH)
    expect(call?.body).toEqual({ region: 'cn', id: 'cn-aaaa1111' })
  })

  it('只有一个账号时不画池区块（那只是一个账号，谈不上"池"）', async () => {
    const single = statusPayload({
      routes: [liveRoute({ pool: { active: 'live', accounts: [{ id: 'live', label: '本机登录', live: true, active: true }] } })],
    })
    mockRoutes({ status: () => single })
    await mount(recordingScope(() => single))
    expect(container.innerHTML).not.toContain('pool.title')
  })

  it('积分已用尽的号带标记（用户能看出为什么换了号）', async () => {
    const drained = statusPayload({
      routes: [liveRoute({
        pool: {
          active: 'cn-aaaa1111',
          accounts: [
            { id: 'live', label: '本机登录', live: true, active: false, drainedUntilMs: Date.now() + 600000 },
            { id: 'cn-aaaa1111', label: '副本 1', live: false, active: true, balance: 12 },
          ],
        },
      })],
    })
    mockRoutes({ status: () => drained })
    await mount(recordingScope(() => drained))
    expect(container.innerHTML).toContain('pool.drained')
  })
})

describe('诊断页', () => {
  it('展示只读事实，且不含任何写入控件', async () => {
    mockRoutes({ status: () => statusPayload() })
    await mount(recordingScope(() => statusPayload()))
    await clickText('.dsm-minimax-subtab', 'panel.diagnostics')
    const html = container.innerHTML
    expect(html).toContain('diagnostics.catalog')
    expect(html).toContain('diagnostics.enabledModels')
    expect(html).toContain('diagnostics.copies')
    expect(html).toContain('diagnostics.note')
    // 这一页不该有任何能改配置的东西。**只看面板内部**：区域 tab 的开关是卡片
    // 外壳层的控件，本来就画在所有子页之上，把它算进来会得到一个假红。
    const panel = container.querySelector('.dsm-minimax-panel')
    expect(panel?.querySelectorAll('input[type=checkbox], select').length).toBe(0)
  })

  it('ready 但走了跨区回落时，诊断页仍显示这条事实', async () => {
    // 真实机器形态：broker 服务国际版，cn 路由每次都用盘上凭据。显示成
    // source=lease + 别区 generation 会把排查方向整个带错。
    const payload = statusPayload({
      routes: [
        liveRoute({
          login: {
            state: 'ready', source: 'file', generation: 16,
            expiresAtMs: Date.now() + 3_600_000,
            detail: 'MiniMax Code 的认证租约当前服务的是另一个区域的账号（generation 12，本区域 16），已改用本区域凭据。',
          },
        }),
      ],
    })
    mockRoutes({ status: () => payload })
    await mount(recordingScope(() => payload))
    await clickText('.dsm-minimax-subtab', 'panel.diagnostics')
    const html = container.innerHTML
    expect(html).toContain('diagnostics.credentialNote')
    expect(html).toContain('另一个区域')
  })

  it('「最近一次失败」在全就绪时显示"没有报错"', async () => {
    mockRoutes({ status: () => statusPayload() })
    await mount(recordingScope(() => statusPayload()))
    await clickText('.dsm-minimax-subtab', 'panel.diagnostics')
    expect(container.innerHTML).toContain('diagnostics.noError')
  })
})

describe('没有设置作用域时', () => {
  it('所有写入控件禁用，并说明原因', async () => {
    mockRoutes({ status: () => statusPayload() })
    await mount()
    await clickText('.dsm-minimax-subtab', 'panel.models')
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))
    expect(boxes.length).toBeGreaterThan(0)
    expect(boxes.every(box => box.disabled)).toBe(true)
    expect(container.innerHTML).toContain('settings.readOnly')
  })
})
