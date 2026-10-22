/**
 * 设置写入面的**懒解析**。
 *
 * 这是"模型勾选存不进去"的回归测试。原来的实现只在 apply 时解析一次：卡片
 * 挂载那一刻 describe 镜像通常还是 idle，解析失败后退化成猜的命名空间，
 * 之后即使镜像就绪也不会重试——界面能点、一条也写不进去。
 */

import { describe, expect, it, vi } from 'vitest'

import { createLazySettingsScope } from '../src/client/scope.ts'

/** 我们的配置长什么样（`modelContextWindows` 是独有字段）。 */
const OUR_VALUE = {
  models: [],
  regions: ['cn'],
  longContext: false,
  modelContextWindows: {},
}

/** 造一个假 client 上下文：`get('configForms')` 返回给定服务。 */
function ctxWith(forms: unknown): Parameters<typeof createLazySettingsScope>[0] {
  return { get: (name: string) => (name === 'configForms' ? forms : undefined) }
}

/** 造一个 configForms 替身；`ready` 可以事后翻转，模拟镜像晚就绪。 */
function fakeForms(options: { namespace: string, ready: boolean, setNameResult?: boolean }) {
  const store: Record<string, unknown> = { ...OUR_VALUE }
  const set = vi.fn(async (field: string, value: unknown) => {
    if (options.setNameResult === false) return false
    store[field] = value
    return true
  })
  const form = {
    getSnapshot: () => ({ value: store }),
    set,
  }
  const state = { ready: options.ready }
  return {
    state,
    set,
    store,
    describe: () => ({
      getSnapshot: () => ({
        status: state.ready ? 'ready' : 'idle',
        view: state.ready ? { namespaces: [{ ns: options.namespace, value: OUR_VALUE }] } : undefined,
      }),
      subscribe: () => () => undefined,
    }),
    get: (ns: string) => (ns === options.namespace ? form : undefined),
  }
}

describe('createLazySettingsScope', () => {
  it('服务不存在 → undefined（卡片退化为只读）', () => {
    expect(createLazySettingsScope(ctxWith(undefined))).toBeUndefined()
  })

  it('镜像还没就绪时也能拿到作用域，但写入明确返回 false', async () => {
    const forms = fakeForms({ namespace: 'include:dsh-connect-minmax', ready: false })
    const scope = createLazySettingsScope(ctxWith(forms))
    expect(scope).toBeDefined()
    // 不假装成功：回读校验会把它变成一条可见的报错，而不是"打了勾却没存"。
    await expect(scope?.set('models', ['MiniMax-M3'])).resolves.toBe(false)
    expect(forms.set).not.toHaveBeenCalled()
  })

  it('镜像晚就绪 → 同一个作用域对象随后就能写（这是修掉的真 bug）', async () => {
    const forms = fakeForms({ namespace: 'include:dsh-connect-minmax', ready: false })
    const scope = createLazySettingsScope(ctxWith(forms))
    await expect(scope?.set('models', ['MiniMax-M3'])).resolves.toBe(false)

    forms.state.ready = true
    await expect(scope?.set('models', ['MiniMax-M3'])).resolves.toBe(true)
    expect(forms.set).toHaveBeenCalledWith('models', ['MiniMax-M3'])
  })

  it('按配置字段认命名空间，不靠名字（部署方可以改安装行名）', async () => {
    const forms = fakeForms({ namespace: 'any-row-name-at-all', ready: true })
    const scope = createLazySettingsScope(ctxWith(forms))
    await expect(scope?.set('regions', ['cn', 'global'])).resolves.toBe(true)
    expect(forms.set).toHaveBeenCalledWith('regions', ['cn', 'global'])
  })

  it('getSnapshot 反映当前值；未就绪时给空对象（不抛）', () => {
    const forms = fakeForms({ namespace: 'x', ready: false })
    const scope = createLazySettingsScope(ctxWith(forms))
    expect(scope?.getSnapshot()).toEqual({})
    forms.state.ready = true
    expect(scope?.getSnapshot()).toMatchObject({ value: expect.objectContaining({ longContext: false }) as unknown })
  })

  it('宿主拒绝时如实返回 false，不吞掉', async () => {
    const forms = fakeForms({ namespace: 'x', ready: true, setNameResult: false })
    const scope = createLazySettingsScope(ctxWith(forms))
    await expect(scope?.set('models', [])).resolves.toBe(false)
  })
})
