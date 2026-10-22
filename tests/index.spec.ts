import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { MiniMaxAdapter, PROVIDER_DISPLAY_NAME } from '../src/adapter.ts'
import { MINIMAX_MODELS, ROUTE, regionBaseUrl } from '../src/catalog.ts'
import { Config, apply, effectiveBaseUrl, normalizeRegions, selectModels } from '../src/index.ts'
import { PLUGIN_VERSION } from '../src/version.ts'

/**
 * 入口测试只验证"接线"：注册了什么、过滤成什么、可选服务怎么挂。
 * 不联网、不读真实凭据（vitest.config.ts 已把 HOME 与
 * `DSH_MINIMAX_DATA_DIR` 隔离到临时目录）。
 */

interface FakeLlm {
  listProviders: () => readonly LlmProviderInfo[]
  registerAdapter: (routes: readonly string[], adapter: unknown) => unknown
}

interface Harness {
  ctx: Context
  registered: { routes: string[], adapter: unknown }[]
  warnings: string[]
  infos: string[]
  injections: string[][]
  /** `ctx.effect` 注册的清理函数（测试里手动触发，模拟 fiber 释放）。​ */
  disposers: (() => void)[]
}

/** 假宿主上下文：只实现 `apply()` 真正会碰的面。 */
function harness(options: { providers?: readonly LlmProviderInfo[] } = {}): Harness {
  const registered: { routes: string[], adapter: unknown }[] = []
  const warnings: string[] = []
  const infos: string[] = []
  const injections: string[][] = []
  const disposers: (() => void)[] = []
  const llm: FakeLlm = {
    listProviders: () => options.providers ?? [],
    registerAdapter: (routes, adapter) => {
      registered.push({ routes: [...routes], adapter })
      return { replace: () => undefined, dispose: () => undefined }
    },
  }
  const ctx = {
    llm,
    logger: {
      warn: (message: string) => warnings.push(message),
      info: (message: string) => infos.push(message),
    },
    get: () => undefined,
    effect: (setup: () => (() => void) | void) => {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject: (names: readonly string[], _callback: (inner: unknown) => void) => {
      injections.push([...names])
    },
  }
  return { ctx: ctx as unknown as Context, registered, warnings, infos, injections, disposers }
}

/** 取出唯一一次注册的 adapter，并断言它确实是 MiniMax 的包装。 */
function registeredAdapter(result: Harness): MiniMaxAdapter {
  expect(result.registered).toHaveLength(1)
  const entry = result.registered[0]!
  expect(entry.routes).toEqual([ROUTE])
  expect(entry.adapter).toBeInstanceOf(MiniMaxAdapter)
  return entry.adapter as MiniMaxAdapter
}

describe('Config', () => {
  it('给未配置字段补默认值', () => {
    const resolved = Config({})
    expect(resolved.models).toEqual([])
    expect(resolved.regions).toEqual(['cn', 'global'])
    expect(resolved.streamIdleTimeoutMs).toBe(300_000)
    expect(resolved.baseUrl).toBe('')
    expect(resolved.globalBaseUrl).toBe('')
    expect(resolved.longContext).toBe(false)
  })
})

describe('selectModels', () => {
  it('空配置表示目录全部', () => {
    expect(selectModels([], () => undefined)).toHaveLength(MINIMAX_MODELS.length)
    expect(selectModels(undefined, () => undefined)).toHaveLength(MINIMAX_MODELS.length)
  })

  it('按配置顺序去重挑选', () => {
    const selected = selectModels(['MiniMax-M2.7', ' MiniMax-M3 ', 'MiniMax-M2.7'], () => undefined)
    expect(selected.map(spec => spec.id)).toEqual(['MiniMax-M2.7', 'MiniMax-M3'])
  })

  it('未知 id 只 warn 并忽略，其余照常注册', () => {
    const warnings: string[] = []
    const selected = selectModels(['MiniMax-M3', 'MiniMax-Nope'], message => warnings.push(message))
    expect(selected.map(spec => spec.id)).toEqual(['MiniMax-M3'])
    expect(warnings.join('\n')).toContain('MiniMax-Nope')
  })

  it('全部未知时退回完整目录，而不是注册一个空 provider', () => {
    const warnings: string[] = []
    const selected = selectModels(['nope'], message => warnings.push(message))
    expect(selected).toHaveLength(MINIMAX_MODELS.length)
    expect(warnings.join('\n')).toContain('全部未知')
  })
})

describe('effectiveBaseUrl', () => {
  it('空配置回落到区域默认值', () => {
    expect(effectiveBaseUrl('', regionBaseUrl('cn'))).toBe('https://agent.minimax.cn/mavis/api/v1/llm')
    expect(effectiveBaseUrl('   ', regionBaseUrl('global'))).toBe('https://agent.minimax.io/mavis/api/v1/llm')
  })

  it('去掉结尾斜杠：SDK 是字符串拼接，双斜杠会拼出 //v1/messages', () => {
    expect(effectiveBaseUrl('https://example.test/mavis/api/v1/llm/', 'fallback'))
      .toBe('https://example.test/mavis/api/v1/llm')
  })
})

describe('PLUGIN_VERSION', () => {
  it('构建期注入或回落到 dev，绝不抛 ReferenceError', () => {
    expect(typeof PLUGIN_VERSION).toBe('string')
    expect(PLUGIN_VERSION.length).toBeGreaterThan(0)
  })
})

describe('apply', () => {
  it('注册 minimax 路由，并让 GUI 拿到目录与默认思考档位', async () => {
    const result = harness()
    apply(result.ctx, { regions: ['cn'] })

    const adapter = registeredAdapter(result)
    expect(adapter.providerInfo(ROUTE).name).toBe(PROVIDER_DISPLAY_NAME)

    const models = await adapter.listModels(ROUTE)
    expect(models.map(model => model.id)).toEqual(MINIMAX_MODELS.map(spec => spec.id))
    expect(models[0]!.inputModalities).toEqual(['text', 'image'])

    // 宿主未指定档位时必须落到有效档位：M3.1-Flash 不可关思考。
    const flash = await adapter.resolveModel(ROUTE, 'MiniMax-M3.1-Flash')
    expect(flash.reasoning?.defaultEffort).toBe('medium')
    expect(flash.reasoning?.efforts.map(effort => effort.id)).toContain('medium')
    expect(flash.reasoning?.efforts.map(effort => effort.id)).not.toContain('off')
    expect(flash.context?.contextWindow).toBe(512_000)

    // M3 允许关思考，因此 off 出现在档位里。
    const m3 = await adapter.resolveModel(ROUTE, 'MiniMax-M3')
    expect(m3.reasoning?.efforts.map(effort => effort.id)).toContain('off')

    expect(result.infos.join('\n')).toContain(ROUTE)
  })

  it('longContext 打开后，只有支持 1M 的模型换档', async () => {
    const result = harness()
    apply(result.ctx, { longContext: true, regions: ['cn'] })

    const adapter = registeredAdapter(result)
    const flash = await adapter.resolveModel(ROUTE, 'MiniMax-M3.1-Flash')
    const m3 = await adapter.resolveModel(ROUTE, 'MiniMax-M3')
    const m27 = await adapter.resolveModel(ROUTE, 'MiniMax-M2.7')
    expect(flash.context?.contextWindow).toBe(1_000_000)
    expect(m3.context?.contextWindow).toBe(1_000_000)
    expect(m27.context?.contextWindow).toBe(204_800)
  })

  it('路由已被占用时只 warn，不 throw、不注册', () => {
    const result = harness({ providers: [{ id: ROUTE, name: '占位' }] })
    expect(() => apply(result.ctx, { regions: ['cn'] })).not.toThrow()
    expect(result.registered).toHaveLength(0)
    expect(result.warnings.join('\n')).toContain('已被其它 provider 注册')
  })

  it('按配置只注册选中的模型', async () => {
    const result = harness()
    apply(result.ctx, { models: ['MiniMax-M2.7'], regions: ['cn'] })
    const models = await registeredAdapter(result).listModels(ROUTE)
    expect(models.map(model => model.id)).toEqual(['MiniMax-M2.7'])
  })

  it('baseUrl 写成带 /v1 的形式时给出可操作的 warn', () => {
    const result = harness()
    apply(result.ctx, { baseUrl: 'https://example.test/mavis/api/v1/llm/v1', regions: ['cn'] })
    expect(result.warnings.join('\n')).toContain('不应包含 "/v1"')
  })

  it('状态路由走 ctx.inject 等可选服务，而不是 apply 期采样', () => {
    const result = harness()
    apply(result.ctx, {})
    expect(result.injections).toEqual([['webServer']])
  })

  it('默认同时注册国内与国际两条路由，显示名与 baseUrl 各自独立', async () => {
    const result = harness()
    apply(result.ctx, {})

    expect(result.registered.map(entry => entry.routes[0])).toEqual(['minimax', 'minimax-global'])
    const cn = result.registered[0]!.adapter as MiniMaxAdapter
    const global = result.registered[1]!.adapter as MiniMaxAdapter
    expect(cn.providerInfo(ROUTE).name).toBe('MiniMax（本机登录）')
    expect(global.providerInfo('minimax-global').name).toBe('MiniMax Global（本机登录）')
    const globalModels = await global.listModels('minimax-global')
    expect(globalModels.length).toBe(MINIMAX_MODELS.length)
    expect(globalModels[0]!.id).toBe(MINIMAX_MODELS[0]!.id)
  })

  it('regions 只留国际版时，只注册一条国际路由', () => {
    const result = harness()
    apply(result.ctx, { regions: ['global'] })
    expect(result.registered).toHaveLength(1)
    expect(result.registered[0]!.routes).toEqual(['minimax-global'])
  })

  it('未知区域被忽略并 warn，不静默消失', () => {
    const result = harness()
    const normalize = (value: readonly string[] | undefined): readonly string[] =>
      normalizeRegions(value, message => result.warnings.push(message))
    expect(normalize(['cn', 'mars', 'cn'])).toEqual(['cn'])
    expect(normalize(undefined)).toEqual(['cn', 'global'])
    expect(normalize([])).toEqual(['cn', 'global'])
    expect(result.warnings.join('\n')).toContain('未知区域 "mars"')
  })

  it('owned 的账号副本注册成独立路由，跟随态副本不出路由', async () => {
    const fs = await import('node:fs/promises')
    const home = await fs.mkdtemp('/tmp/mm-index-')
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    try {
      await fs.writeFile(`${home}/.minimax-accounts.json`, JSON.stringify({
        schemaVersion: 1,
        accounts: [
          // 跟随态（mcode 正在用）：不注册
          { id: 'cn-follow01', region: 'cn', label: '副本 1', loginEpoch: 'follow01-x', accessToken: 'a', refreshToken: 'r', expiresAtMs: 1, owned: false, createdAtMs: 0 },
          // 已接管：注册成 minimax-cn-owned001
          { id: 'cn-owned001', region: 'cn', label: '副本 2', loginEpoch: 'owned001-x', accessToken: 'a', refreshToken: 'r', expiresAtMs: Date.now() + 3_600_000, owned: true, createdAtMs: 0 },
        ],
      }))

      const result = harness()
      apply(result.ctx, { regions: ['cn'] })
      expect(result.registered.map(entry => entry.routes[0])).toEqual(['minimax', 'minimax-cn-owned001'])
      const copy = result.registered[1]!.adapter as MiniMaxAdapter
      expect(copy.providerInfo('minimax-cn-owned001').name).toBe('MiniMax 副本 · 副本 2')
      expect(await copy.listModels('minimax-cn-owned001')).toHaveLength(MINIMAX_MODELS.length)
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })

  it('不注册可配置供应商（minimax 已在 pi-ai 目录里，会 DUPLICATE_DIRECTORY）', () => {
    const result = harness()
    apply(result.ctx, {})
    const llm = (result.ctx as unknown as { llm: Record<string, unknown> }).llm
    expect(llm.registerConfigurableProviders).toBeUndefined()
  })
})
