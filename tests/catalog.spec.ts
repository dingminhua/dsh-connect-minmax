/**
 * 模型目录测试：目录本身的约束 + `toPiModel()` 的字段完整性。
 *
 * 重点是把「M3.1-Flash 不能关思考」这条实测结论钉死（`off: null`），
 * 因为它一旦退化成 `'disabled'`，选该模型并关思考就会被上游 400。
 */

import type { Model } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'

import { DEFAULT_BASE_URL_CN, DEFAULT_BASE_URL_GLOBAL, MINIMAX_EFFORT_LEVELS, MINIMAX_M3_1_FLASH_PREVIEW, MINIMAX_MODELS, ROUTE, findModelSpec, modelIds, regionBaseUrl, toPiModel, type MiniMaxModelSpec } from '../src/catalog.ts'

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

  it('包含设计要求的四个模型，顺序稳定', () => {
    expect(modelIds()).toEqual([
      'MiniMax-M3',
      'MiniMax-M3.1-Flash',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
    ])
  })

  it('MiniMax-M3：512K / 128K / 支持图片 / 可关思考', () => {
    const spec = byId('MiniMax-M3')
    expect(spec.name).toBe('MiniMax M3')
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

  it('MiniMax-M2.7 / M2.7-highspeed：204K / 131072 / 纯文本 / 可关思考', () => {
    for (const id of ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed']) {
      const spec = byId(id)
      expect(spec.contextWindow).toBe(204_800)
      expect(spec.maxTokens).toBe(131_072)
      expect([...spec.input]).toEqual(['text'])
      expect(spec.reasoning).toBe(true)
      expect(spec.thinkingLevelMap?.off).toBe('disabled')
    }
  })

  it('每个模型都显式给出六档 effort（含 xhigh / max，否则 GUI 不展示）', () => {
    for (const spec of MINIMAX_MODELS) {
      const levels = spec.thinkingLevelMap ?? {}
      expect(levels.minimal).toBe('low')
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
    expect(model.name).toBe('MiniMax M3')
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
