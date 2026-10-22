/**
 * 设置写入面：把宿主的 `configForms` 包成卡片能用的 `MiniMaxSettingsScope`。
 *
 * 单独一个 `.ts` 文件而不是写在 `index.tsx` 里：这里是**纯逻辑**（解析命名空间、
 * 转发写入、订阅变化），注册插槽那部分才是浏览器侧的活。分开之后它能在普通
 * tsconfig 下被测试，而不是只有 jsx 环境才能碰。
 */

import type { MiniMaxSettingsScope } from './settings.ts'

/** `configForms` 服务的形状（只取本插件用到的部分）。 */
interface ConfigFormsFace {
  describe(): {
    getSnapshot(): { view?: { namespaces?: readonly { ns: string, value?: unknown }[] } }
    subscribe?(listener: () => void): () => void
  }
  get(ns: string): MiniMaxSettingsScope | undefined
}

/**
 * 兜底候选 id。
 *
 * 只作为"镜像里还没带 value"时的后备；正常路径是按配置字段认，那样部署方
 * 把安装行改成什么名字都不会认错。
 */
const NAMESPACE_CANDIDATES = [
  'include:dsh-connect-minmax',
  'dsh-connect-minmax',
] as const

/** 我们的配置里独有的字段，用来认出"哪个命名空间是这个插件"。 */
// 命名空间识别在 status-paths.ts：宿主侧保存端点与浏览器侧共用同一份判据。
import { looksLikeOurNamespace } from '../status-paths.ts'

/**
 * 做一个"用时才解析"的设置写入面。
 *
 * 拿不到 `configForms` 服务时返回 `undefined`（卡片退化为只读，保存是唯一需要
 * 它的功能）。服务在但命名空间还没进镜像时，返回的对象仍然可用：下一次
 * `getSnapshot()` / `set()` 会重新解析，所以晚就绪也能救回来。
 *
 * @param ctx - 浏览器插件上下文。
 * @returns 设置写入面；服务不存在时 `undefined`。
 */
export function createLazySettingsScope(ctx: {
  get?(name: string): unknown
}): MiniMaxSettingsScope | undefined {
  const forms = ctx.get?.('configForms') as ConfigFormsFace | undefined
  if (forms === undefined) return undefined

  const resolve = (): MiniMaxSettingsScope | undefined => {
    try {
      const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
      // 先按配置字段认（唯一可靠）；镜像还没给出 value 时退回到候选 id。
      const byShape = namespaces.find(entry => looksLikeOurNamespace(entry.value))
      if (byShape !== undefined) return forms.get(byShape.ns)
      // 本宿主把 Loader 条目命名成 `include:<短名>`（实测 profile 里全是这种形状），
      // 所以裸包名永远匹配不上——这是原来写入静默失败的机制。
      for (const candidate of NAMESPACE_CANDIDATES) {
        if (!namespaces.some(entry => entry.ns === candidate)) continue
        return forms.get(candidate)
      }
      return undefined
    } catch {
      return undefined
    }
  }

  return {
    getSnapshot: () => resolve()?.getSnapshot() ?? {},
    set: async (field, value) => {
      const form = resolve()
      // 解析不出来就明确说"没写"，不要假装成功——回读校验会把它变成一条可见的报错。
      if (form === undefined) return false
      return form.set(field, value)
    },
    subscribe: (listener) => {
      const disposers: Array<() => void> = []
      // 订阅 describe：命名空间晚出现时会触发，卡片随之重渲染并重新解析。
      try {
        const face = forms.describe()
        if (typeof face.subscribe === 'function') disposers.push(face.subscribe(listener))
      } catch { /* 镜像不可订阅时退化为轮询重渲染，不影响写入 */ }
      const form = resolve()
      if (form?.subscribe !== undefined) {
        try { disposers.push(form.subscribe(listener)) } catch { /* 同上 */ }
      }
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* 释放失败不影响其它 */ }
        }
      }
    },
  }
}
