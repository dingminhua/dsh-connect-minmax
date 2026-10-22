/**
 * MiniMax 模型目录与 pi-ai 模型描述。
 *
 * 这里是 base URL、模型表与 pi-ai `Model` 描述的唯一来源（设计 §3「同源」）。
 * 目录写死，不做网络发现：网关的 `GET /models` 返回 503 `direct_route_not_configured`，
 * 模型清单只能以本机配置与实测为准（详见 docs/research/upstream.md §4）。
 *
 * ## 与 MiniMax Code 的对照（本目录的事实来源）
 *
 * 模型名、顺序、上下文档位、思考形态，全部对齐本机 MiniMax Code 自己用的目录：
 * `~/.minimax/config.yaml`（远端下发的快照）与随包的
 * `node_modules/@mavis/config/src/minimax-model-catalog.ts`。要点：
 *
 * | 模型 | 显示名 | 上下文 | 输出 | 输入 | 思考 |
 * | --- | --- | --- | --- | --- | --- |
 * | MiniMax-M3.1-Flash | M3.1-Flash（订阅限免） | 512K（可选 1M） | 128K | 文本/图片/视频 | 强制开启 |
 * | MiniMax-M3 | M3 | 512K（可选 1M） | 128K | 文本/图片/视频 | 可开关 |
 * | MiniMax-M2.7 | M2.7 | 204.8K | 131K | 文本/图片 | 可开关 |
 * | MiniMax-M2.7-highspeed | M2.7-highspeed | 204.8K | 131K | 文本/图片 | 开关无效 |
 *
 * 宿主（DSH）只有 text/image 两种输入模态，**视频**这一档本插件表达不了，
 * 因此目录只声明 text/image，差异写在 README 的兼容性说明里。
 *
 * ## thinking 档位（实测，见 `node scripts/verify-upstream.mjs --matrix`）
 *
 *  - `output_config.effort` 的合法取值是 `low` / `medium` / `high` / `xhigh` / `max`；
 *    `on` / `off` 会被 400 拒绝（`invalid reasoning_effort`）。MiniMax Code 的
 *    M3 开关在它自己的代码里拼成 `effort: 'on'`，这套取值**在当前托管网关上不成立**，
 *    所以这里只发合法档位。
 *  - `MiniMax-M3.1-Flash` 是强制思考（`forced_on`）：发 `thinking:{type:'disabled'}`
 *    会 400，所以它的 `off` 必须是 `null` —— pi-ai 的 `getSupportedThinkingLevels()`
 *    见到 `null` 就完全不提供该档，而不是"提供了但发 disabled"。
 *  - `MiniMax-M2.7-highspeed` 忽略 `thinking:{type:'disabled'}`（照样输出思考），
 *    因此它也不提供 `off`，免得给用户一个名不副实的开关。
 *  - 其余模型 `off` 映射成 `'disabled'`：pi-ai 在 `thinkingLevelMap.off !== null` 时
 *    会发 `thinking:{type:'disabled'}`；`off` 为 `null` 时连 `thinking` 字段都不发。
 *  - `minimal` 没有对应的上游档位（MiniMax Code 的 `effortOptions` 从 `low` 起），
 *    因此置 `null` 隐藏，而不是悄悄压到 `low`。
 *
 * 思考档位走 **adaptive + `output_config.effort`**（MiniMax 原生形态），因此
 * `compat.forceAdaptiveThinking` 必须为 `true`：pi-ai 见到它为真就发
 * `thinking:{type:'adaptive',display:'summarized'}` + `output_config:{effort}`，
 * 而不是 Anthropic 老式的 `budget_tokens`。
 */

import type { Api, Model } from '@earendil-works/pi-ai'

/** 国内版路由名（也是默认路由）。 */
export const ROUTE = 'minimax'
/** 国际版路由名。 */
export const ROUTE_GLOBAL = 'minimax-global'

/**
 * 每个区域一条供应商路由。
 *
 * 为什么是两条路由而不是一条：两个区域是**两套凭据**（`~/.minimax/auth/prod/cn`
 * 与 `.../en`），一个 token 只在它自己的区域有效。合成一条路由就没法同时表达
 * "国内版已登录、国际版没登录"。
 */
export const MINIMAX_ROUTES: Readonly<Record<MiniMaxRegion, string>> = {
  cn: ROUTE,
  global: ROUTE_GLOBAL,
}

/** 区域 → 路由名。 */
export function routeForRegion(region: MiniMaxRegion): string {
  return MINIMAX_ROUTES[region]
}

/** 区域 → 中文区域名（卡片与错误文案用）。 */
export function regionLabelOf(region: MiniMaxRegion): string {
  return region === 'global' ? '国际版' : '国内版'
}

/** 区域 → 模型选择器里的供应商显示名。 */
export function displayNameForRegion(region: MiniMaxRegion): string {
  return region === 'global' ? 'MiniMax Global（本机登录）' : 'MiniMax（本机登录）'
}

/** 国内版（cn）托管 LLM base URL。**少写一段 `/v1`**：pi-ai 自己拼 `/v1/messages`。 */
export const DEFAULT_BASE_URL_CN = 'https://agent.minimax.cn/mavis/api/v1/llm'
/** 国际版（global / en）托管 LLM base URL。 */
export const DEFAULT_BASE_URL_GLOBAL = 'https://agent.minimax.io/mavis/api/v1/llm'

/** 上游区域。`en` 在凭据里等价于 `global`。 */
export type MiniMaxRegion = 'cn' | 'global'

/** 按区域取默认 base URL。 */
export function regionBaseUrl(region: MiniMaxRegion): string {
  return region === 'global' ? DEFAULT_BASE_URL_GLOBAL : DEFAULT_BASE_URL_CN
}

/**
 * 宿主思考档位 → MiniMax `output_config.effort` 的线程值。
 *
 * 值取自 MiniMax Code 的 `thinking.effortOptions`（`default/low/medium/high/xhigh/max`）
 * 与网关实测结果：`low`…`max` 全部 200，宿主多出来的 `minimal` 没有落点，置 `null` 隐藏。
 */
export const MINIMAX_EFFORT_LEVELS: Readonly<Record<string, string | null>> = {
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/** 1M 长上下文档（上游 `contextWindowOptions` 的第二档，按更高用量计费）。 */
export const MINIMAX_LONG_CONTEXT_WINDOW = 1_000_000

/**
 * 模型目录项（pi-ai 之外的最小事实集）。
 *
 * `badge` 与 `thinkingMode` 只服务设置卡片，不参与请求；把它们放在目录里，
 * 卡片和请求就永远描述同一个模型，不会出现"卡片写着强制思考、请求却发了 disabled"。
 */
export interface MiniMaxModelSpec {
  id: string
  /** 选择器与卡片里的显示名，对齐 MiniMax Code（不带 `MiniMax-` 前缀）。 */
  name: string
  /** 卡片上的角标，例如「订阅限免」。 */
  badge?: string
  description?: string
  contextWindow: number
  /** 上游可选上下文档位；第二档即 1M。 */
  contextWindowOptions?: readonly number[]
  /**
   * 上游**真实**支持的模态。目录项的 `input` 会被 `modelImages` 掩码改写，
   * 而这个字段永远是原值——卡片要靠它区分"上游不支持"与"用户关掉了"。
   */
  upstreamInput?: readonly string[]
  maxTokens: number
  input: readonly ('text' | 'image')[]
  reasoning: boolean
  /**
   * 思考档位 → wire 值的映射，语义与 pi-ai 的 `thinkingLevelMap` 一致：
   *  - `null`：该档不支持（GUI 不展示，请求也不会发）
   *  - 字符串：该档的 wire 拼写
   *  - 缺失：五个基础档视为支持，`xhigh` / `max` 视为不支持
   */
  thinkingLevelMap?: Readonly<Record<string, string | null>>
  // 这里**没有** `defaultEffort`：曾经声明过 5 次，但没有任何地方读它。
  // 实测（把目录里 M3 的 defaultEffort 改成 xhigh）`resolveModel()` 仍回 medium，
  // 因为默认档位来自 provider 级的 `profile.reasoning`，而 pi-ai 的模型级只有
  // `reasoningEfforts`（**可选档位集合**），没有"这一模型的默认档"这个概念。
  // 声明一个没人读、看起来却像"每模型默认档"的字段，比没有这个字段更糟。
  /** 思考形态：`switchable` 可关，`forced` 关不掉（卡片展示用）。 */
  thinkingMode: 'switchable' | 'forced'
}

/**
 * `MiniMax-M3.1-Flash` 的可选预览版：与正式版同能力，默认不进目录。
 * 需要时由 config 打开（设计 §4 允许，保持默认清单干净）。
 */
export const MINIMAX_M3_1_FLASH_PREVIEW: MiniMaxModelSpec = {
  id: 'MiniMax-M3.1-Flash-Preview',
  name: 'M3.1-Flash-Preview',
  badge: '预览',
  description: 'M3.1 Flash 预览版，能力与正式版一致。',
  contextWindow: 512_000,
  contextWindowOptions: [512_000, MINIMAX_LONG_CONTEXT_WINDOW],
  maxTokens: 128_000,
  input: ['text', 'image'],
  reasoning: true,
  thinkingLevelMap: { ...MINIMAX_EFFORT_LEVELS, off: null },
  thinkingMode: 'forced',
}

/** 可切换思考的模型：关掉时发 `thinking:{type:'disabled'}`。 */
const SWITCHABLE = { ...MINIMAX_EFFORT_LEVELS, off: 'disabled' } as const
/** 强制思考的模型：`off` 为 `null`，GUI 不提供关闭档。 */
const FORCED = { ...MINIMAX_EFFORT_LEVELS, off: null } as const

/**
 * 默认模型目录，顺序即 MiniMax Code 的 `model_order`：
 * `MiniMax-M3.1-Flash` 在前（它也是 MiniMax Code 的默认模型），`MiniMax-M3` 次之。
 */
export const MINIMAX_MODELS: readonly MiniMaxModelSpec[] = [
  {
    id: 'MiniMax-M3.1-Flash',
    name: 'M3.1-Flash（订阅限免）',
    badge: '订阅限免',
    description: '订阅期内不计费；强制思考，不提供“关闭思考”档。',
    contextWindow: 512_000,
    contextWindowOptions: [512_000, MINIMAX_LONG_CONTEXT_WINDOW],
    maxTokens: 128_000,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: FORCED,
    thinkingMode: 'forced',
  },
  {
    id: 'MiniMax-M3',
    name: 'M3',
    description: '512K 上下文，支持图片输入与可切换思考。',
    contextWindow: 512_000,
    contextWindowOptions: [512_000, MINIMAX_LONG_CONTEXT_WINDOW],
    maxTokens: 128_000,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: SWITCHABLE,
    thinkingMode: 'switchable',
  },
  {
    id: 'MiniMax-M2.7',
    name: 'M2.7',
    description: '204.8K 上下文，支持图片输入与可切换思考。',
    contextWindow: 204_800,
    maxTokens: 131_072,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: SWITCHABLE,
    thinkingMode: 'switchable',
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'M2.7-highspeed',
    description: 'M2.7 的高速版本；上游忽略“关闭思考”，因此只提供开启档。',
    contextWindow: 204_800,
    maxTokens: 131_072,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: FORCED,
    thinkingMode: 'forced',
  },
]

/** 本机登录态不含计费信息，成本一律 0（避免宿主把订阅额度算成美元花费）。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * 把目录项翻译成 pi-ai 的 `Model`。
 *
 * `compat` 四个开关的理由：
 *  - `supportsCacheControlOnTools: false`：MiniMax 不认工具上的 `cache_control`
 *  - `supportsEagerToolInputStreaming: false`：无 eager tool streaming
 *  - `supportsTemperature: true`：接受 `temperature`（但 adapter 在开思考时不发）
 *  - `forceAdaptiveThinking: true`：MiniMax 的原生思考形态是 adaptive + effort，
 *    实测各模型都接受 `thinking:{type:'adaptive',display:'summarized'}` +
 *    `output_config:{effort}`；同时它会关掉 Anthropic 的 interleaved-thinking beta 头，
 *    避免把 Claude 专有 beta 发给 MiniMax。
 */
export function toPiModel(spec: MiniMaxModelSpec, baseUrl: string, route: string = ROUTE): Model<Api> {
  const model: Model<Api> = {
    id: spec.id,
    name: spec.name,
    api: 'anthropic-messages' as const,
    provider: route,
    baseUrl,
    reasoning: spec.reasoning,
    input: [...spec.input],
    cost: { ...NO_COST },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    ...(spec.thinkingLevelMap ? { thinkingLevelMap: { ...spec.thinkingLevelMap } } : {}),
    compat: {
      supportsCacheControlOnTools: false,
      supportsEagerToolInputStreaming: false,
      supportsTemperature: true,
      // MiniMax 用 adaptive + output_config.effort，不是 budget_tokens。
      forceAdaptiveThinking: true,
    },
  }
  return model
}

/**
 * 按「长上下文」开关调整目录项的上下文窗口。
 *
 * MiniMax Code 把 1M 作为**用户可选档**（`contextWindowOptions` + `higher_usage`
 * 提示），DSH 每个模型只有一个 `contextWindow`，所以这里把它做成插件开关：
 * 打开时对支持 1M 的模型用 1M，否则保持默认档。上游按更高用量计费，默认关。
 *
 * @param spec - 目录项。
 * @param longContext - 是否启用 1M 档。
 * @returns 调整后的目录项（不支持 1M 的模型原样返回）。
 */
export function withContextWindow(spec: MiniMaxModelSpec, longContext: boolean): MiniMaxModelSpec {
  if (!longContext) return spec
  const options = spec.contextWindowOptions
  if (options === undefined || !options.includes(MINIMAX_LONG_CONTEXT_WINDOW)) return spec
  return { ...spec, contextWindow: MINIMAX_LONG_CONTEXT_WINDOW }
}

/**
 * 按"每模型上下文档位"覆盖目录项。
 *
 * MiniMax Code 把 1M 做成**每模型可选档**（`contextWindowOptions` + `higher_usage`
 * 计费提示），而 DSH 每个模型只有一个 `contextWindow`，所以档位必须在插件侧选定。
 *
 * 只接受该模型**确实提供**的档位：写一个目录里没有的数字（比如给 M2.7 写 1M）会被
 * 忽略并回落到 `fallback` 的结果，而不是把窗口报成一个上游根本不受理的值——
 * 那会让宿主按错误的窗口做上下文压缩，直到请求被拒才发现。
 *
 * @param spec - 目录项。
 * @param requested - 用户为该模型选的窗口；`undefined` 表示没选。
 * @param fallback - 没选时用的结果（通常是 `withContextWindow` 的全局档）。
 * @returns 调整后的目录项。
 */
export function withModelContextWindow(
  spec: MiniMaxModelSpec,
  requested: number | undefined,
  fallback: MiniMaxModelSpec,
): MiniMaxModelSpec {
  if (requested === undefined) return fallback
  const options = spec.contextWindowOptions ?? [spec.contextWindow]
  if (!options.includes(requested)) return fallback
  return { ...fallback, contextWindow: requested }
}

/** 某个模型可选的上下文档位（卡片用它渲染下拉框）。 */
export function contextWindowOptionsOf(spec: MiniMaxModelSpec): readonly number[] {
  return spec.contextWindowOptions ?? [spec.contextWindow]
}

/**
 * 按"每模型图片输入"开关调整目录项。
 *
 * 这是一个**不对称**的操作，而这个不对称正是它的正确性所在：
 *
 *  - 上游支持图片、用户关掉 → 允许。这是真实的能力掩码：宿主不再往这个模型发图，
 *    用户可能因此省积分，或绕开上游视觉解析的不稳定。
 *  - 上游不支持图片、用户开启 → 忽略并回落。声明一个上游不受理的模态，会让宿主
 *    把图片塞进请求、然后在线上收到一个 4xx —— 那是把用户的显式操作变成一个 bug。
 *
 * @param spec - 目录项。
 * @param requested - 用户为该模型设置的图片开关；`undefined` 表示没动过。
 * @param fallback - 需要回落时返回的结果。
 * @returns 调整后的目录项。
 */
export function withModelImages(
  spec: MiniMaxModelSpec,
  requested: boolean | undefined,
  fallback: MiniMaxModelSpec,
): MiniMaxModelSpec {
  if (requested === undefined) return fallback
  const upstream = spec.input.includes('image')
  // 上游不支持时无论用户要开还是要关，都保持目录里的事实。
  if (!upstream) return fallback
  if (requested) return fallback
  return {
    ...fallback,
    input: fallback.input.filter(entry => entry !== 'image'),
    // 掩码只改 `input`；`upstreamInput` 必须留住原值，否则卡片会把
    // "用户关掉了"渲染成"上游不支持"，那个复选框就再也勾不回来了。
    upstreamInput: [...spec.input],
  }
}

/** 按 id 取目录项；未知名返回 `undefined`（不做模糊匹配）。 */
export function findModelSpec(id: string): MiniMaxModelSpec | undefined {
  const wanted = id.trim()
  return MINIMAX_MODELS.find((spec) => spec.id === wanted)
}

/** 目录 id 列表，保持声明顺序。 */
export function modelIds(): string[] {
  return MINIMAX_MODELS.map((spec) => spec.id)
}
