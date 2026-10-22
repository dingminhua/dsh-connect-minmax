/**
 * 浏览器半边：把 MiniMax 状态卡片注册到 Harness 的插件配置页。
 *
 * 注册形态沿用本插件族的一致做法（workbuddy / trae / qoder 三家同源）：
 *  - `inject` 只声明 `['slots', 'locale']`——这两个服务在 0.1.7 线上**必然**
 *    存在；
 *  - `configForms` **不**进 `inject`，而是用 `ctx.get()` 软探测：Cordis 的
 *    依赖门禁是硬的，写进 `inject` 的服务如果当前宿主不提供，`apply` 就一次
 *    都不会跑；
 *  - 整个 `apply` 体包 try/catch，槽位 API 变更时降级为 `console.error`，
 *    而不是把异常抛进 loader 触发 "Failed to load plugins" 红色横幅
 *    （宿主那半边的模型供应不受影响）。
 *
 * @module dsh-connect-minmax/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

import { MiniMaxCard } from './MiniMaxCard.tsx'
import { createLazySettingsScope } from './scope.ts'
import type { MiniMaxSettingsScope } from './settings.ts'
import type { MiniMaxCardInjected } from './MiniMaxCard.tsx'
import { en, zh } from './locales.ts'
import type { MiniMaxSettingsKey } from './locales.ts'
import {
  MINIMAX_CARD_KEYS,
  MINIMAX_SETTINGS_NAMESPACE_CANDIDATES,
  MINIMAX_SETTINGS_NS,
} from '../status-paths.ts'

/** 浏览器插件上下文。`slots` 与 `locale` 由上面的类型增强声明。 */
export type MiniMaxClientContext = ClientContext & {
  slots: ClientContext['slots']
  locale: ClientContext['locale']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MiniMax 插件卡片文案。 */
    'settings.minmax': MiniMaxSettingsKey
  }
}

/** 浏览器插件名。 */
export const name = 'dsh-connect-minmax-client'

/**
 * 客户端所需的服务。
 *
 * 只有 `slots` 与 `locale`：它们是 0.1.7 线上无条件提供的两个。设置表单
 * （`configForms`）是**软探测**的，不在这里声明。
 */
export const inject = ['slots', 'locale']

/** 注册卡片文案与 MiniMax 状态卡片。 */
export function apply(ctx: MiniMaxClientContext): void {
  try {
    const namespace = 'settings.minmax'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-connect-minmax: settings copy')
    const t = ctx.locale.bind(namespace) as MiniMaxCardInjected['t']

    /**
     * 设置写入面 + 槽位重绑。
     *
     * 这里照 workbuddy 的实测做法（它的 4.3.0 缺陷 issue #46 踩过同一个坑），
     * 因为**两个问题必须同时解决**，只解一个等于没解：
     *
     *  1. **镜像晚就绪**。`configForms` 的 describe 由异步 `remote.settings.
     *     describe()` 填充，`apply` 时 `view` 通常还不存在。此时按声明的名字
     *     去 `get()`，`ConfigFormController.derive()` 是**精确匹配**命名空间的，
     *     猜错的名字会让那个 form 永远 unavailable —— `set()` 恒为 false，
     *     界面能点、一条也存不进去。
     *  2. **注入结果被按对象身份缓存**。渲染器（`dsh-client-ui-renderer` 的
     *     `rootInjectCache`）对每个条目只跑一次 `inject()`；条目早于镜像出现
     *     注册的话，后面即使 scope 绑好了也不会重新求值。所以晚绑定**必须**
     *     销毁旧注册、重新注册，光换内部变量没用。
     *
     * `whileServed(candidates, register)` 是宿主自己的做法：它在 unserved→served
     * 的**边沿**触发，把"宿主实际在服务的命名空间集合"交给我们，而不是让我们
     * 拿一个启动时抓的快照去猜。
     */
    const liveDisposers: Array<() => void> = []
    /**
     * 设置写入面。
     *
     * 用**惰性对象**而不是"绑一次就固定的 form"：它每次读/写都现查当前服务的
     * 命名空间，所以晚就绪、或宿主换了条目名都能自己救回来，不会因为启动时
     * 猜错一次就永久失效。
     */
    const settingsScope: MiniMaxSettingsScope | undefined = createLazySettingsScope(ctx)

    /**
     * 注册一张卡片；失败返回 `undefined`。
     *
     * `ctx.slots.inject(seat, factory)` 是**声明式**的：槽位还没被声明时先
     * 排队，等声明了再执行 factory，所以页面没挂载时注册不会丢。
     */
    const registerCard = (slotName: string, key: string): (() => void) | undefined => {
      try {
        return ctx.slots.inject(slotName as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string, key: string, priority: number, inject: () => MiniMaxCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: slotName,
          key,
          priority: 30,
          inject: () => settingsScope === undefined ? { t } : { t, settingsScope },
        }, MiniMaxCard))
      } catch (error: unknown) {
        // 每个槽位单独隔离：一个失败不许把其他槽位一起带下去。
        console.error(
          `[dsh-connect-minmax] card slot "${slotName}/${key}" failed to register (host provider unaffected):`,
          error,
        )
        return undefined
      }
    }

    /** 注册全部槽位；返回可用来撤销的 disposer 列表。 */
    const registerAllSlots = (): Array<() => void> => {
      const disposers: Array<() => void> = []
      for (const key of MINIMAX_CARD_KEYS) {
        for (const [slotName, slotKey] of [
          ['plugins.bundle.config', key],
          ['plugins.row.config', `${key}#${key}`],
        ] as const) {
          const dispose = registerCard(slotName, slotKey)
          if (dispose !== undefined) disposers.push(dispose)
        }
      }
      return disposers
    }

    /**
     * 换一批注册。
     *
     * 顺序是有意的：**先撤销再注册**。keyed 槽位同一个 key 重复注册会抛
     * `already has an entry for key …`，所以不能先注册后撤。
     */
    const rebindSlots = (): void => {
      for (const dispose of liveDisposers) {
        try { dispose() } catch { /* 槽位服务可能已经撤掉了 */ }
      }
      liveDisposers.length = 0
      liveDisposers.push(...registerAllSlots())
    }

    /**
     * 把 `settingsScope` 绑到宿主真正在服务的命名空间上，并在答案变化时重绑槽位。
     */
    const bindSettingsScope = (): void => {
      const forms = (ctx as unknown as { get?(name: string): unknown }).get?.('configForms') as
        | (ConfigFormsFace & {
          whileServed?(
            namespaces: readonly string[],
            register: (served: ReadonlySet<string>) => () => void,
          ): () => void
        })
        | undefined

      if (forms === undefined) {
        // 宿主没提供设置面：卡片退化成只读，这是文档写明的降级。
        rebindSlots()
        return
      }

      const whileServed = forms.whileServed
      if (typeof whileServed !== 'function') {
        // 旧版本宿主没有边沿通知：惰性作用域仍然可用，只是要自己重绑一次。
        rebindSlots()
        return
      }

      ctx.effect(() => whileServed.call(forms, MINIMAX_SETTINGS_NAMESPACE_CANDIDATES, served => {
        // 候选表是**有序**的：宿主实际服务的第一个拼法胜出。最后的正则扫描是
        // 兜底——部署方可能用我们没预料到的包装前缀给这个条目命名。
        // 惰性作用域自己会解析命名空间；这里只负责让渲染器**重新求值** inject
        // （它按对象身份缓存结果，不重绑的话新的 settingsScope 永远不会被看到）。
        rebindSlots()
        return () => {
          for (const dispose of liveDisposers) {
            try { dispose() } catch { /* 已经撤过 */ }
          }
          liveDisposers.length = 0
        }
      }), 'dsh-connect-minmax: settings namespace binding')

      // 不等边沿：首次镜像若已经包含我们的命名空间，边沿会在 whileServed 内部
      // 同步触发；但镜像可能先给出一个不含我们的答案，那也要先把卡片画出来
      // （只读），而不是等一个可能永远不来的第二次答案。
      if (liveDisposers.length === 0) rebindSlots()
    }

    bindSettingsScope()
  } catch (error: unknown) {
    // 页面上静默降级：宿主那半边照样供模型。开发者能在浏览器控制台看到原因。
    console.error('[dsh-connect-minmax] client card failed to load (host provider unaffected):', error)
  }
}

/** `configForms` 服务的形状（只取本插件用到的部分）。 */
interface ConfigFormsFace {
  describe(): {
    getSnapshot(): { view?: { namespaces?: readonly { ns: string, value?: unknown }[] } }
    subscribe?(listener: () => void): () => void
  }
  get(ns: string): MiniMaxSettingsScope | undefined
}
