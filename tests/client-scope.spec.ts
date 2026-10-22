/**
 * 设置写入面的**懒解析**。
 *
 * 这是"模型勾选存不进去"的回归测试。原来的实现只在 apply 时解析一次：卡片
 * 挂载那一刻 describe 镜像通常还是 idle，解析失败后退化成猜的命名空间，
 * 之后即使镜像就绪也不会重试——界面能点、一条也写不进去。
 */

import { describe, expect, it, vi } from 'vitest'

import { createLazySettingsScope } from '../src/client/scope.ts'
import { MINIMAX_SETTINGS_NAMESPACE_CANDIDATES, MINIMAX_SETTINGS_NS } from '../src/status-paths.ts'

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

describe('命名空间兜底', () => {
  it('镜像 value 还没来时，用 include:<短名> 找到（本宿主的真实命名法）', () => {
    // 宿主里条目 id 实测全是 `include:<moduleName 短名>` 形状；裸包名匹配不上，
    // 这正是原来"能点但一条也存不进去"的机制。
    const forms = {
      describe: () => ({
        getSnapshot: () => ({ view: { namespaces: [{ ns: 'include:dsh-connect-minmax' }, { ns: 'include:settings' }] } }),
        subscribe: () => () => undefined,
      }),
      get: (ns: string) => (ns === 'include:dsh-connect-minmax'
        ? { getSnapshot: () => ({ value: OUR_VALUE }), set: async () => true }
        : undefined),
    }
    const scope = createLazySettingsScope(ctxWith(forms))
    expect(scope).toBeDefined()
    expect(scope?.getSnapshot()).toMatchObject({ value: expect.anything() as unknown })
  })

  it('命名空间完全不存在时返回 undefined 的作用域行为（写入 false）', async () => {
    const forms = {
      describe: () => ({
        getSnapshot: () => ({ view: { namespaces: [{ ns: 'include:something-else' }] } }),
        subscribe: () => () => undefined,
      }),
      get: () => undefined,
    }
    const scope = createLazySettingsScope(ctxWith(forms))
    await expect(scope?.set('models', [])).resolves.toBe(false)
    expect(scope?.getSnapshot()).toEqual({})
  })
})

describe('命名空间候选（workbuddy 同款做法）', () => {
  it('候选表按优先级排列，且覆盖宿主的 include: 拼法', () => {
    // 宿主把 Loader 条目命名成 `include:<短名>`（profile 实测全是这种形状），
    // 裸包名永远匹配不上——这就是"能点但存不进去"的机制。
    expect(MINIMAX_SETTINGS_NAMESPACE_CANDIDATES[0]).toBe('dsh-connect-minmax')
    expect(MINIMAX_SETTINGS_NAMESPACE_CANDIDATES).toContain('include:dsh-connect-minmax')
  })

  it('短名兜底存在（旧宿主 / 声明名场景）', () => {
    expect(MINIMAX_SETTINGS_NAMESPACE_CANDIDATES).toContain(MINIMAX_SETTINGS_NS)
  })
})
