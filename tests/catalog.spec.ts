/**
 * 模型目录测试：目录本身的约束 + `toPiModel()` 的字段完整性。
 *
 * 重点是把「M3.1-Flash 不能关思考」这条实测结论钉死（`off: null`），
 * 因为它一旦退化成 `'disabled'`，选该模型并关思考就会被上游 400。
 */

import type { Model } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'

import { DEFAULT_BASE_URL_CN, DEFAULT_BASE_URL_GLOBAL, MINIMAX_EFFORT_LEVELS, MINIMAX_M3_1_FLASH_PREVIEW, MINIMAX_MODELS, ROUTE, contextWindowOptionsOf, findModelSpec, modelIds, regionBaseUrl, toPiModel, withContextWindow, withModelContextWindow, withModelImages, type MiniMaxModelSpec } from '../src/catalog.ts'

const byId = (id: string): MiniMaxModelSpec => {
  const spec = findModelSpec(id)
  if (!spec) throw new Error(`缺少模型 ${id}`)
  return spec
}

describe('MINIMAX_MODELS', () => {
  it('模型 id 唯一', () => {
    const ids = MINIMAX_MODELS.map((spec) => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('四个模型顺序对齐 MiniMax Code 的 model_order（Flash 在前）', () => {
    expect(modelIds()).toEqual([
      'MiniMax-M3.1-Flash',
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
    ])
  })

  it('显示名对齐 MiniMax Code（不带 MiniMax- 前缀，订阅限免带角标）', () => {
    expect(byId('MiniMax-M3.1-Flash').name).toBe('M3.1-Flash（订阅限免）')
    expect(byId('MiniMax-M3.1-Flash').badge).toBe('订阅限免')
    expect(byId('MiniMax-M3').name).toBe('M3')
    expect(byId('MiniMax-M2.7').name).toBe('M2.7')
    expect(byId('MiniMax-M2.7-highspeed').name).toBe('M2.7-highspeed')
  })

  it('MiniMax-M3：512K / 128K / 支持图片 / 可关思考', () => {
    const spec = byId('MiniMax-M3')
    expect(spec.name).toBe('M3')
    expect(spec.contextWindow).toBe(512_000)
    expect(spec.maxTokens).toBe(128_000)
    expect([...spec.input]).toEqual(['text', 'image'])
    expect(spec.reasoning).toBe(true)
    expect(spec.thinkingLevelMap?.off).toBe('disabled')
  })

  it('MiniMax-M3.1-Flash：off 必须是 null（强制思考，不能发 disabled）', () => {
    const spec = byId('MiniMax-M3.1-Flash')
    expect(spec.contextWindow).toBe(512_000)
    expect(spec.maxTokens).toBe(128_000)
    expect([...spec.input]).toEqual(['text', 'image'])
    expect(spec.reasoning).toBe(true)
    expect(spec.thinkingLevelMap).toBeDefined()
    expect(spec.thinkingLevelMap?.off).toBeNull()
  })

  it('MiniMax-M2.7 / M2.7-highspeed：204K / 131072 / 支持图片', () => {
    for (const id of ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed']) {
      const spec = byId(id)
      expect(spec.contextWindow).toBe(204_800)
      expect(spec.maxTokens).toBe(131_072)
      // 实测：M2.7 与 highspeed 都接受 base64 图片输入（HTTP 200）。
      expect([...spec.input]).toEqual(['text', 'image'])
      expect(spec.reasoning).toBe(true)
    }
  })

  it('M2.7 可关思考；highspeed 忽略 disabled，因此不提供 off', () => {
    expect(byId('MiniMax-M2.7').thinkingLevelMap?.off).toBe('disabled')
    expect(byId('MiniMax-M2.7-highspeed').thinkingLevelMap?.off).toBeNull()
  })

  it('M3 / M3.1-Flash 声明 1M 上下文档，M2.7 没有', () => {
    expect(byId('MiniMax-M3').contextWindowOptions).toEqual([512_000, 1_000_000])
    expect(byId('MiniMax-M3.1-Flash').contextWindowOptions).toEqual([512_000, 1_000_000])
    expect(byId('MiniMax-M2.7').contextWindowOptions).toBeUndefined()
  })

  it('每个模型都显式给出 effort 档位：minimal 隐藏，low…max 全部可见', () => {
    for (const spec of MINIMAX_MODELS) {
      const levels = spec.thinkingLevelMap ?? {}
      // 上游 effortOptions 从 low 起，宿主多出的 minimal 没有落点 → 隐藏。
      expect(levels.minimal).toBeNull()
      expect(levels.low).toBe('low')
      expect(levels.medium).toBe('medium')
      expect(levels.high).toBe('high')
      expect(levels.xhigh).toBe('xhigh')
      expect(levels.max).toBe('max')
      expect(Object.keys(levels).sort()).toEqual(
        ['high', 'low', 'max', 'medium', 'minimal', 'off', 'xhigh'],
      )
    }
  })

  it('M3.1-Flash-Preview 默认不进目录，且同样是 off: null', () => {
    expect(modelIds()).not.toContain(MINIMAX_M3_1_FLASH_PREVIEW.id)
    expect(MINIMAX_M3_1_FLASH_PREVIEW.id).toBe('MiniMax-M3.1-Flash-Preview')
    expect(MINIMAX_M3_1_FLASH_PREVIEW.thinkingLevelMap?.off).toBeNull()
  })

  it('findModelSpec 只做精确匹配', () => {
    expect(findModelSpec('MiniMax-M3')?.id).toBe('MiniMax-M3')
    expect(findModelSpec('  MiniMax-M3  ')?.id).toBe('MiniMax-M3')
    expect(findModelSpec('minimax-m3')).toBeUndefined()
    expect(findModelSpec('MiniMax-M9')).toBeUndefined()
  })
})

describe('withContextWindow', () => {
  it('关闭时原样返回（同一个对象，不多做分配）', () => {
    const spec = byId('MiniMax-M3')
    expect(withContextWindow(spec, false)).toBe(spec)
  })

  it('打开时把支持 1M 的模型换成 1M 档', () => {
    expect(withContextWindow(byId('MiniMax-M3'), true).contextWindow).toBe(1_000_000)
    expect(withContextWindow(byId('MiniMax-M3.1-Flash'), true).contextWindow).toBe(1_000_000)
  })

  it('不支持 1M 的模型保持默认档', () => {
    expect(withContextWindow(byId('MiniMax-M2.7'), true).contextWindow).toBe(204_800)
  })

  it('不修改目录本身', () => {
    withContextWindow(byId('MiniMax-M3'), true)
    expect(byId('MiniMax-M3').contextWindow).toBe(512_000)
  })
})

describe('regionBaseUrl', () => {
  it('cn 与 global 各自对应的托管 base URL', () => {
    expect(regionBaseUrl('cn')).toBe(DEFAULT_BASE_URL_CN)
    expect(regionBaseUrl('global')).toBe(DEFAULT_BASE_URL_GLOBAL)
    expect(DEFAULT_BASE_URL_CN).toBe('https://agent.minimax.cn/mavis/api/v1/llm')
    expect(DEFAULT_BASE_URL_GLOBAL).toBe('https://agent.minimax.io/mavis/api/v1/llm')
  })

  it('base URL 不带 /v1 后缀（pi-ai 自己拼 /v1/messages）', () => {
    expect(DEFAULT_BASE_URL_CN.endsWith('/v1')).toBe(false)
    expect(DEFAULT_BASE_URL_CN.endsWith('/llm')).toBe(true)
  })
})

describe('toPiModel', () => {
  it('字段与 pi-ai Model 描述逐项对齐', () => {
    const spec = byId('MiniMax-M3')
    const model = toPiModel(spec, DEFAULT_BASE_URL_CN)

    expect(model.id).toBe('MiniMax-M3')
    expect(model.name).toBe('M3')
    expect(model.api).toBe('anthropic-messages')
    expect(model.provider).toBe(ROUTE)
    expect(model.baseUrl).toBe(DEFAULT_BASE_URL_CN)
    expect(model.reasoning).toBe(true)
    expect(model.input).toEqual(['text', 'image'])
    expect(model.contextWindow).toBe(512_000)
    expect(model.maxTokens).toBe(128_000)
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(model.compat).toEqual({
      supportsCacheControlOnTools: false,
      supportsEagerToolInputStreaming: false,
      supportsTemperature: true,
      // MiniMax 走 adaptive + output_config.effort，不是 budget_tokens。
      forceAdaptiveThinking: true,
    })
  })

  it('baseUrl 用传入值（区域由调用方决定）', () => {
    const model = toPiModel(byId('MiniMax-M3'), DEFAULT_BASE_URL_GLOBAL)
    expect(model.baseUrl).toBe(DEFAULT_BASE_URL_GLOBAL)
  })

  it('thinkingLevelMap 原样透传，null 不被吃掉', () => {
    const flash = toPiModel(byId('MiniMax-M3.1-Flash'), DEFAULT_BASE_URL_CN)
    expect(flash.thinkingLevelMap).toEqual({ ...MINIMAX_EFFORT_LEVELS, off: null })
    expect(flash.thinkingLevelMap?.['off']).toBeNull()

    const m3 = toPiModel(byId('MiniMax-M3'), DEFAULT_BASE_URL_CN)
    expect(m3.thinkingLevelMap).toEqual({ ...MINIMAX_EFFORT_LEVELS, off: 'disabled' })
  })

  it('每个模型都带 forceAdaptiveThinking（否则 pi-ai 会发 budget_tokens 而不是 effort）', () => {
    for (const spec of MINIMAX_MODELS) {
      const model = toPiModel(spec, DEFAULT_BASE_URL_CN) as Model<'anthropic-messages'>
      expect(model.compat?.forceAdaptiveThinking).toBe(true)
    }
  })

  it('input 是副本，改返回值不会污染目录', () => {
    const spec = byId('MiniMax-M3')
    const model = toPiModel(spec, DEFAULT_BASE_URL_CN)
    ;(model.input as string[]).push('text')
    expect([...spec.input]).toEqual(['text', 'image'])
  })

  it('预览版也能转成 pi-ai Model', () => {
    const model = toPiModel(MINIMAX_M3_1_FLASH_PREVIEW, DEFAULT_BASE_URL_GLOBAL)
    expect(model.id).toBe('MiniMax-M3.1-Flash-Preview')
    expect(model.baseUrl).toBe(DEFAULT_BASE_URL_GLOBAL)
    expect(model.thinkingLevelMap).toEqual({ ...MINIMAX_EFFORT_LEVELS, off: null })
  })
})

describe('withModelContextWindow / contextWindowOptionsOf', () => {
  it('接受该模型确实提供的档位', () => {
    const spec = byId('MiniMax-M3')
    const result = withModelContextWindow(spec, 1_000_000, spec)
    expect(result.contextWindow).toBe(1_000_000)
  })

  it('上游没提供的档位不改写窗口（否则宿主会按错误的窗口做压缩）', () => {
    const spec = byId('MiniMax-M2.7')
    // M2.7 只有 204800 一档。
    expect(contextWindowOptionsOf(spec)).toEqual([204_800])
    const fallback = { ...spec, contextWindow: 999 }
    expect(withModelContextWindow(spec, 1_000_000, fallback).contextWindow).toBe(999)
  })

  it('没声明 contextWindowOptions 的模型只认自己那一档', () => {
    const bare: MiniMaxModelSpec = {
      id: 'X',
      name: 'X',
      contextWindow: 1234,
      maxTokens: 56,
      input: ['text'],
      reasoning: false,
      thinkingMode: 'switchable',
      thinkingLevelMap: { ...MINIMAX_EFFORT_LEVELS, off: 'disabled' },
    }
    expect(contextWindowOptionsOf(bare)).toEqual([1234])
    expect(withModelContextWindow(bare, 1234, bare).contextWindow).toBe(1234)
  })
})

describe('withModelImages（不对称的能力掩码）', () => {
  // 当前目录里四个模型**都**支持图片（`input: ['text','image']`），所以下面两例
  // 用合成 spec：真实目录里暂时没有"纯文本"模型可断言，但那条拒绝路径必须被测到，
  // 否则以后加一个纯文本模型时它会静默变成"用户能勾、上游不认"。
  const IMAGE_MODEL = byId('MiniMax-M3')
  const TEXT_ONLY: MiniMaxModelSpec = {
    ...IMAGE_MODEL,
    id: 'MiniMax-TextOnly',
    input: ['text'],
  }

  it('上游支持图片时允许关掉：宿主不再往这个模型发图', () => {
    expect(IMAGE_MODEL.input).toContain('image')
    const result = withModelImages(IMAGE_MODEL, false, IMAGE_MODEL)
    expect(result.input).not.toContain('image')
    expect(result.input).toContain('text')
  })

  it('上游支持时 requested=true 不改任何东西', () => {
    expect(withModelImages(IMAGE_MODEL, true, IMAGE_MODEL).input).toContain('image')
  })

  it('上游不支持图片时开启被忽略：声明一个上游不受理的模态会把用户的显式操作变成线上 4xx', () => {
    expect(withModelImages(TEXT_ONLY, true, TEXT_ONLY).input).toEqual(['text'])
    // 关掉一个本来就没有的能力同样不该凭空造出 image。
    expect(withModelImages(TEXT_ONLY, false, TEXT_ONLY).input).toEqual(['text'])
  })

  it('没动过开关时原样返回 fallback（fallback 才是当前生效值）', () => {
    const fallback = { ...IMAGE_MODEL, input: ['text'] as ('text' | 'image')[] }
    expect(withModelImages(IMAGE_MODEL, undefined, fallback).input).toEqual(['text'])
  })

  it('掩码只改 input，upstreamInput 留住原值（否则关掉的复选框再也勾不回来）', () => {
    const masked = withModelImages(IMAGE_MODEL, false, { ...IMAGE_MODEL, upstreamInput: [...IMAGE_MODEL.input] })
    expect(masked.input).toEqual(['text'])
    expect(masked.upstreamInput).toEqual(['text', 'image'])
  })
})
