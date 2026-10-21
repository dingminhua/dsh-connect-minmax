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

/** 本插件注册的 LLM 路由名。 */
export const ROUTE = 'minimax'

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
  /** 宿主未显式配置 effort 时建议的默认档位。 */
  defaultEffort?: string
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
  defaultEffort: 'medium',
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
    defaultEffort: 'medium',
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
    defaultEffort: 'medium',
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
    defaultEffort: 'medium',
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
    defaultEffort: 'medium',
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
export function toPiModel(spec: MiniMaxModelSpec, baseUrl: string): Model<Api> {
  const model: Model<Api> = {
    id: spec.id,
    name: spec.name,
    api: 'anthropic-messages' as const,
    provider: ROUTE,
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

/** 按 id 取目录项；未知名返回 `undefined`（不做模糊匹配）。 */
export function findModelSpec(id: string): MiniMaxModelSpec | undefined {
  const wanted = id.trim()
  return MINIMAX_MODELS.find((spec) => spec.id === wanted)
}

/** 目录 id 列表，保持声明顺序。 */
export function modelIds(): string[] {
  return MINIMAX_MODELS.map((spec) => spec.id)
}
