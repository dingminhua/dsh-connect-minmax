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
import { MINIMAX_CARD_KEYS } from '../status-paths.ts'

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
     * 设置写入面（惰性解析）。
     *
     * `configForms` **不进 `inject`**：Cordis 的依赖门禁是硬的，写进去就会
     * 让"宿主不提供该服务"变成"整个客户端插件一次都不跑"。拿不到时
     * `settingsScope` 是 undefined，卡片自动退化成只读——保存是唯一需要它的功能。
     *
     * 之前是"apply 时解析一次就定下来"，那是模型勾选存不进去的真因：卡片挂载
     * 那一刻 `configForms` 的 describe 镜像通常还是 `idle`（`view` 为空），于是
     * 退化成猜的命名空间 `dsh-connect-minmax`；宿主的真实 entry id 不是它，
     * `get()` 拿到的是一个不存在的条目，`set()` 自然永远是 false——界面看起来
     * 能点，实际一条都没写进去。
     *
     * 现在每次用的时候现解析，并订阅 describe 镜像：命名空间晚出现也能拿到。
     * 认哪个命名空间**看 schema 里的字段**而不是猜名字最稳妥——我们的配置里
     * `modelContextWindows` / `reasoningEffort` 是独有的，部署方把安装行改叫
     * 什么都不会认错。
     */
    const settingsScope = createLazySettingsScope(ctx)
    /**
     * 注册一张卡片。
     *
     * `ctx.slots.inject(seat, factory)` 是**声明式**的：槽位还没被声明时先
     * 排队，等声明了再执行 factory。所以页面没挂载时注册**不会丢**。
     *
     * `ctx.slots.register(...)` 返回 disposer；keyed 槽位里同一个 key 重复
     * 注册会抛（`already has an entry for key …`），所以这里每个 key 只注册
     * 一次。
     */
    const registerCard = (slotName: string, key: string): void => {
      try {
        ctx.slots.inject(slotName as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; key: string; priority: number; inject: () => MiniMaxCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: slotName,
          key,
          priority: 30,
          inject: () => settingsScope === undefined ? { t } : { t, settingsScope },
        }, MiniMaxCard))
      } catch (error: unknown) {
        // 每个槽位单独隔离：一个槽位注册失败不许把其他槽位一起带下去。
        console.error(
          `[dsh-connect-minmax] card slot "${slotName}" failed to register (host provider unaffected):`,
          error,
        )
      }
    }

    /**
     * 插件页按**包标识**给配置槽位打 key，不是按本插件的设置命名空间：
     *  - `plugins.bundle.config` 用**裸包名**；
     *  - `plugins.row.config` 用 **`<包名>#<行 id>`**。
     *
     * 插件页是按**精确相等**在 `Set` 里查 key 的，而部署方可以把安装行命名
     * 成任何样子（宿主实测用的是 `include:dsh-connect-minmax` 这种带前缀的
     * id）。只注册一种拼法而部署用的是另一种时，卡片**渲染不出任何东西、
     * 也不报任何错**——插件照常显示为 running、有描述有行，只是没有配置体。
     *
     * 所以每种拼法都注册一遍：keyed 槽位里各 key 彼此独立，不存在冲突。
     */
    for (const key of MINIMAX_CARD_KEYS) {
      registerCard('plugins.bundle.config', key)
      registerCard('plugins.row.config', `${key}#${key}`)
    }
  } catch (error: unknown) {
    // 页面上静默降级：宿主那半边照样供模型。开发者能在浏览器控制台看到原因。
    console.error('[dsh-connect-minmax] client card failed to load (host provider unaffected):', error)
  }
}
