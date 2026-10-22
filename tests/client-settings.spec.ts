/**
 * 卡片写配置的逻辑。
 *
 * 重点不是"能不能调用 set"，而是**调用之后到底有没有落地**：设置面板可能
 * 返回 `false`（拒绝）、可能返回 `undefined`（旧宿主没有返回值）、也可能
 * "返回成功但值没变"。最后一种最危险——复选框会打上勾，配置纹丝不动。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  MiniMaxSettingsWriteError,
  readField,
  toggleRegion,
  writeLongContext,
  writeModels,
  writeRegions,
} from '../src/client/settings.ts'
import type { MiniMaxSettingsScope } from '../src/client/settings.ts'

/** 一个可脚本化的设置作用域。 */
function scopeOf(
  initial: Record<string, unknown> = {},
  options: {
    /** set 的返回值：模拟新宿主（true）、旧宿主（undefined）与拒绝（false）。 */
    returns?: boolean | void
    /** set 是否真的写进快照。设成 false 模拟"返回成功但没落地"。 */
    persists?: boolean
    /** set 抛错。 */
    throws?: boolean
  } = {},
): MiniMaxSettingsScope & { value: Record<string, unknown> } {
  const state: { value: Record<string, unknown> } = { value: { ...initial } }
  return {
    get value() { return state.value },
    getSnapshot: () => ({ value: state.value }),
    set: vi.fn(async (field: string, value: unknown) => {
      if (options.throws === true) throw new Error('settings service is down')
      if (options.persists !== false) state.value = { ...state.value, [field]: value }
      return options.returns
    }),
  }
}

describe('readField', () => {
  it('读出顶层字段', () => {
    expect(readField(scopeOf({ models: ['MiniMax-M3'] }), 'models')).toEqual(['MiniMax-M3'])
  })

  it('字段不存在时回 undefined', () => {
    expect(readField(scopeOf({}), 'regions')).toBeUndefined()
  })

  it('快照整体缺失也不抛', () => {
    expect(readField({ getSnapshot: () => ({}), set: async () => undefined }, 'models')).toBeUndefined()
  })

  it('解开 volatile 包装（宿主的响应式配置带 .get()）', () => {
    const volatile = { get: () => ['MiniMax-M3'], reset: undefined }
    expect(readField({ getSnapshot: () => ({ value: { models: volatile } }), set: async () => undefined }, 'models'))
      .toEqual(['MiniMax-M3'])
  })
})

describe('writeModels', () => {
  it('写入并落地', async () => {
    const scope = scopeOf({ models: [] })
    await writeModels(scope, ['MiniMax-M3', 'MiniMax-M2.7'])
    expect(scope.value['models']).toEqual(['MiniMax-M3', 'MiniMax-M2.7'])
  })

  it('宿主返回 undefined（旧版本）也算成功，只要值真的落地', async () => {
    const scope = scopeOf({ models: [] })
    await expect(writeModels(scope, ['MiniMax-M3'])).resolves.toBeUndefined()
  })

  it('宿主明确拒绝（返回 false）时抛错', async () => {
    const scope = scopeOf({ models: [] }, { returns: false })
    await expect(writeModels(scope, ['MiniMax-M3'])).rejects.toThrow(MiniMaxSettingsWriteError)
  })

  it('set 抛错时转成同一个错误类型，而不是把异常原样抛给点击事件', async () => {
    const scope = scopeOf({}, { throws: true })
    await expect(writeModels(scope, ['MiniMax-M3'])).rejects.toThrow(MiniMaxSettingsWriteError)
  })

  it('返回成功但值没落地 → 仍然报错（这是最危险的假成功）', async () => {
    const scope = scopeOf({ models: ['old'] }, { persists: false })
    await expect(writeModels(scope, ['new'])).rejects.toThrow(/回读/)
  })

  it('错误里带上是哪个字段，便于排查', async () => {
    const scope = scopeOf({}, { returns: false })
    const caught: unknown = await writeRegions(scope, ['cn']).then(() => undefined, error => error)
    expect(caught).toBeInstanceOf(MiniMaxSettingsWriteError)
    expect((caught as MiniMaxSettingsWriteError).field).toBe('regions')
  })
})

describe('writeLongContext', () => {
  it('布尔开关按值比对（不是按存在性）', async () => {
    const scope = scopeOf({ longContext: true })
    await writeLongContext(scope, false)
    expect(scope.value['longContext']).toBe(false)
  })

  it('写入 false 且真的落成 false 时不算失败', async () => {
    const scope = scopeOf({})
    await expect(writeLongContext(scope, false)).resolves.toBeUndefined()
  })
})

describe('toggleRegion', () => {
  it('关掉一个、留着另一个', () => {
    expect(toggleRegion(['cn', 'global'], 'global')).toEqual({ next: ['cn'], accepted: true })
  })

  it('打开一个已关的，并按固定顺序落盘', () => {
    expect(toggleRegion(['global'], 'cn')).toEqual({ next: ['cn', 'global'], accepted: true })
  })

  it('拒绝关掉最后一个区域：那等于让插件一条路由都不注册', () => {
    const outcome = toggleRegion(['cn'], 'cn')
    expect(outcome.accepted).toBe(false)
    expect(outcome.next).toEqual(['cn'])
  })

  it('落盘顺序是规范化的：同一集合不因输入顺序抖动而产生两份不同配置', () => {
    // 输入顺序不同、动作相同 → 输出必须相同，否则宿主会因为数组换了个顺序
    // 而重注册一遍 provider（会话里正在跑的模型选择跟着抖）。
    expect(toggleRegion(['global', 'cn'], 'global').next).toEqual(toggleRegion(['cn', 'global'], 'global').next)
    expect(toggleRegion(['global'], 'cn').next).toEqual(['cn', 'global'])
  })
})
