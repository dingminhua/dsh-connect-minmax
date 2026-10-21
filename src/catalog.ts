/**
 * MiniMax 模型目录与 pi-ai 模型描述。
 *
 * 这里是 base URL、模型表与 pi-ai `Model` 描述的唯一来源（设计 §3「同源」）。
 * 目录写死，不做网络发现：网关的 `GET /models` 返回 503 `direct_route_not_configured`，
 * 模型清单只能以本机配置与实测为准（详见 docs/research/upstream.md §4）。
 *
 * thinking 档位的两个关键事实（实测）：
 *  - `MiniMax-M3.1-Flash` 是强制思考（forced_on），发 `thinking:{type:'disabled'}` 会 400，
 *    所以它的 `off` 必须是 `null` —— pi-ai 的 `getSupportedThinkingLevels()` 见到 `null`
 *    就完全不提供该档，而不是"提供了但发 disabled"。
 *  - 其余模型 `off` 映射成 `'disabled'`：pi-ai 在 `thinkingLevelMap.off !== null` 时
 *    会发 `thinking:{type:'disabled'}`；`off` 为 `null` 时连 `thinking` 字段都不发，
 *    交给服务端默认（MiniMax-M3.1-Flash 正需要这个）。
 *
 * 思考档位走 **adaptive + `output_config.effort`**（MiniMax 原生形态，实测 low/medium/
 * high/xhigh/max 全部 200），因此 `compat.forceAdaptiveThinking` 必须为 `true`：
 * pi-ai 见到它为真就发 `thinking:{type:'adaptive',display:'summarized'}` +
 * `output_config:{effort}`，而不是 Anthropic 老式的 `budget_tokens`。
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
 * MiniMax 自己的档位是 default/low/medium/high/xhigh/max（见本机 mcode 的
 * `config.yaml` 里 M3.1-Flash 的 `thinking.effortOptions`）；宿主多出来的
 * `minimal` 没有更低的落点，压到 `low`。显式写出 `xhigh` / `max` 这两个键，
 * pi-ai 才会把它们暴露给 GUI（取值缺失视为不支持该档）。
 */
export const MINIMAX_EFFORT_LEVELS: Readonly<Record<string, string>> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/** 模型目录项（pi-ai 之外的最小事实集）。 */
export interface MiniMaxModelSpec {
  id: string
  name: string
  description?: string
  contextWindow: number
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
}

/**
 * `MiniMax-M3.1-Flash` 的可选预览版：与正式版同能力，默认不进目录。
 * 需要时由 config 打开（设计 §4 允许，保持默认清单干净）。
 */
export const MINIMAX_M3_1_FLASH_PREVIEW: MiniMaxModelSpec = {
  id: 'MiniMax-M3.1-Flash-Preview',
  name: 'MiniMax M3.1 Flash Preview',
  description: 'M3.1 Flash 预览版，能力与正式版一致。',
  contextWindow: 512_000,
  maxTokens: 128_000,
  input: ['text', 'image'],
  reasoning: true,
  thinkingLevelMap: { ...MINIMAX_EFFORT_LEVELS, off: null },
}

/**
 * 默认模型目录。
 *
 * | id | context | maxOutput | input | off |
 * | --- | --- | --- | --- | --- |
 * | MiniMax-M3 | 512000 | 128000 | text,image | `'disabled'` |
 * | MiniMax-M3.1-Flash | 512000 | 128000 | text,image | `null`（强制思考） |
 * | MiniMax-M2.7 | 204800 | 131072 | text | `'disabled'` |
 * | MiniMax-M2.7-highspeed | 204800 | 131072 | text | `'disabled'` |
 */
export const MINIMAX_MODELS: readonly MiniMaxModelSpec[] = [
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    description: '512K 上下文，支持图片输入与可切换思考。',
    contextWindow: 512_000,
    maxTokens: 128_000,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: { ...MINIMAX_EFFORT_LEVELS, off: 'disabled' },
  },
  {
    id: 'MiniMax-M3.1-Flash',
    name: 'MiniMax M3.1 Flash',
    description: '订阅限免；强制思考，不提供“关闭思考”档。',
    contextWindow: 512_000,
    maxTokens: 128_000,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: { ...MINIMAX_EFFORT_LEVELS, off: null },
  },
  {
    id: 'MiniMax-M2.7',
    name: 'MiniMax M2.7',
    description: '204K 上下文，纯文本输入。',
    contextWindow: 204_800,
    maxTokens: 131_072,
    input: ['text'],
    reasoning: true,
    thinkingLevelMap: { ...MINIMAX_EFFORT_LEVELS, off: 'disabled' },
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'MiniMax M2.7 Highspeed',
    description: '204K 上下文的高速版本，纯文本输入。',
    contextWindow: 204_800,
    maxTokens: 131_072,
    input: ['text'],
    reasoning: true,
    thinkingLevelMap: { ...MINIMAX_EFFORT_LEVELS, off: 'disabled' },
  },
]

/** 本机登录态不含计费信息，成本一律 0（避免宿主把订阅额度算成美元花费）。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * 把目录项翻译成 pi-ai 的 `Model`。
 *
 * `compat` 三个开关的理由：
 *  - `supportsCacheControlOnTools: false`：MiniMax 不认工具上的 `cache_control`
 *  - `supportsEagerToolInputStreaming: false`：无 eagar tool streaming
 *  - `supportsTemperature: true`：接受 `temperature`（但 adapter 在开思考时不发）
 *  - `forceAdaptiveThinking: true`：MiniMax 的原生思考形态是 adaptive + effort，
 *    实测三种模型都接受 `thinking:{type:'adaptive',display:'summarized'}` +
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

/** 按 id 取目录项；未知名返回 `undefined`（不做模糊匹配）。 */
export function findModelSpec(id: string): MiniMaxModelSpec | undefined {
  const wanted = id.trim()
  return MINIMAX_MODELS.find((spec) => spec.id === wanted)
}

/** 目录 id 列表，保持声明顺序。 */
export function modelIds(): string[] {
  return MINIMAX_MODELS.map((spec) => spec.id)
}
