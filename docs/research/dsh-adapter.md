# DSH LLM Adapter 接口研究报告 —— 为本机 MiniMax 登录账号注册 `minimax` 路由

> 研究对象：`@deepseek-ai/dsh-llm` 的 `LlmAdapter` 契约、`@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter`
> 上游协议：Anthropic 兼容 `POST {baseURL}/messages`（SSE，含 thinking / tool_use / usage），`baseURL = https://agent.minimax.cn/mavis/api/v1/llm/v1`
> 约束：不走 API Key 配置；凭据由插件自己从本地文件读取，且能在**不重启**的情况下换 token。
> 本文只做研究，不含插件实现；骨架代码是研究结论的载体。

**一句话结论：走 B（`PiAiAdapter` + pi-ai 的 `anthropic-messages` 实现），把"每次请求都重新读本地 token"放在 pi-ai 的 provider 级 `auth.apiKey.resolve()` 里，`PiAiAdapterOptions.resolveApiKey` 返回 `undefined`。**

理由不是"少写代码"，而是：pi-ai 的 provider `auth.resolve()` 在**每一次** `Models.streamSimple()` 都会被调用（`dist/auth/resolve.js:14-38` → `dist/models.js:421-441`），返回值支持 `{ auth: { apiKey?, headers?, baseUrl? } }`，因此轮换 token（甚至轮换 baseURL）天然是"按请求"的，不需要重建 adapter 快照、不需要重启。这一点是本次研究最关键的新发现，它把 B 最大的疑点（token 刷新）消掉了。

---

## 0. 证据来源与版本

| 来源 | 路径 | 说明 |
| --- | --- | --- |
| 运行时服务签名 | `cordis_inspect_query(platform=host, provider=Service, method=listService, input={"service":"llm"})` | 本机实际运行的 `llm` 服务方法表 + 类型声明，逐字引用 |
| DSH 源码树 | `/Users/dmh2002/DshProject/deepseek-harness/packages/llm/**` | `llm` / `llm-pi-ai` / `llm-deepseek` 的 TS 源码与 README |
| 设计文档 | `deepseek-harness/docs/subsystems/llm-streaming.md` | adapter 契约的权威表述（1129 行） |
| 架构决策 | `deepseek-harness/.agents/notes/implemented/architecture/2026-07-14-provider-routed-llm-adapters.md` | 为什么 provider 是注册键、为什么 pi-ai 拒绝 `stop` |
| 安装包（asar） | `…/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm{,-pi-ai}/package.json` | 版本 **0.2.1-rc.2** |
| pi-ai（asar） | `…/app.asar/dsh/node_modules/@earendil-works/pi-ai/` | 版本 **1.1.0**，`dist/` 只有 JS（**asar 内不带任何 `.d.ts`**，见坑 #7） |
| 参考实现 | `dsh-connect-workbuddy/src/adapter.ts`、`src/index.ts`、`dsh-connect-trae/src/adapter.ts` | `PiAiAdapter` + 自建 provider + 本地凭据的既有做法 |

> 读取 asar 的方法：`read` 工具可直接读 `*.md` / `package.json`；但 `bash` / `grep` / `glob` 会报 `Not a directory`。本文的 pi-ai `dist/*.js` 证据是把 asar 头（`16 + headerSize + padding`）解析出来后按 `offset/size` 取出的，`padding = (4 - headerSize % 4) % 4`（本机 headerSize=4780386，pad=2；漏掉 pad 会让所有文件前面多两个字节）。

---

## 1. `llm` 服务与 `LlmAdapter` 契约

### 1.1 服务方法（运行时实测签名，逐字）

```ts
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
listProviders(): LlmProviderInfo[]
registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle
listConfigurableProviders(): LlmConfigurableProvider[]
registerModelDiscovery(settingsNs: string, discover: (request, signal?) => Promise<readonly LlmDiscoveredModel[]>): () => void
listModels(provider: string): Promise<LlmModelInfo[]>
resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
prepareCall(config: LlmCallConfig, signal?: AbortSignal, configure?: ConfigureCall): Promise<PreparedLlmCall>
stream(options: GenerateOptions): AsyncIterable<StreamChunk>
providerRetryPolicy(provider: string): ResolvedRetryPolicy
imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined
imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef): ImageRequestTarget
fileRequestText(ref: FileAttachmentRef): string
```

`registerAdapter` 的运行时语义（`packages/llm/llm/src/index.ts:396-471`）：

- 整批校验后才改动注册表（all-or-nothing）：空列表 → `INVALID_ADAPTER`；路由已存在 → `DUPLICATE_ADAPTER`（`index.ts:437-439`）。
- 会调用 `adapter.providerInfo(provider)` 并强制 `info.id === provider` 且 `name` 非空，否则 `INVALID_ADAPTER`（`index.ts:440-443`）。**这就是"名字显示错了"的唯一入口。**
- `providerRetryPolicy(provider)` 在注册时被**快照**，之后改动无效（要改必须 `replace` 重新注册）。
- 整个注册是**一个 effect**，随 fiber 释放（`index.ts:403-412`）；释放后再 `replace()` → `REGISTRATION_DISPOSED`（`index.ts:416-423`）。

### 1.2 自定义 adapter 必须/可选实现的方法

```ts
export abstract class LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo            // 默认 { id: provider, name: provider }
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined   // 默认 undefined
  imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined
  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget
  listModels(_provider: string): Promise<readonly LlmModelInfo[]>          // 默认 []
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>    // 唯一必须实现
}
```

（`packages/llm/llm/src/index.ts:208-291`；`preparedAdapterCall = { model: LlmResolvedModelInfo, stream(options) }`。）

宿主在 `adapterStream()` 里对每次请求做的事（`index.ts:1033-1122`）——这段决定了 adapter 会把什么交给你：

1. `prepareCall()` → `normalizeModelInfo()` → 用 `resolveCallWithInfo()` 校验 `reasoningEffort` / 补 `defaultMaxTokens`；
2. `FileBlock` 一律投影成 handle 文本（`projectFilesToText`，`index.ts:1066-1069`）——**任何 adapter 都收不到文件字节**；
3. 若 `modelInfo.inputModalities` 不含 `image` 但有图片 → 投影成占位文本（`index.ts:1070-1074`）；
4. `projectToolUpdates(..., modelInfo.toolUpdate, toolHistory)`：`toolUpdate` 缺省时**剥掉所有 `developer` 消息并去掉 `deferLoading`**（`content.ts:424-437`）；
5. 仅当历史消息的 `source.provider` 归属**同一个 adapter 实例**时才保留 `replayState`，否则剥掉（`index.ts:991-1005`）；
6. adapter 抛错 → 归一化成一条终态 `finish`（`index.ts:1089-1107`，`adapter-failure.ts:16-28`）。

### 1.3 `StreamChunk` 的严格语义

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
```

（`types.ts:452-466`；`docs/subsystems/llm-streaming.md:196-215`。）

必须遵守（`llm-streaming.md:296-306`）：

- **`usage` 在 `finish` 之前，`finish` 之后什么都不能有**；要等 provider 自己的流结束标记再发，避免尾随的 usage-only 帧破坏顺序。
- `tool-call-delta.argumentsDelta` 与 `ToolCallBlock.arguments` **始终是原始 JSON 字符串**；provider 给对象就在 `block-end` 处 `JSON.stringify`。
- `index` 是块序号（从 0 起，按流顺序），`block-start` 与 `block-end` 的 index 必须配对；`block-end` 携带**组装完成的整块**。
- 两条合法错误路径：`throw`（传输/协议错误）**或**发 `finish{kind:'error'|'aborted', failure}`（provider 的带内错误）。
- 一次 `stream()` = 一次 provider 尝试，adapter 必须禁用库级重试（重试归 `dsh-llm-retry`）。
- 每个 HTTP 请求必须带 `attributionHeaders()`（`attribution.ts:64-68`，当前只有 `user-agent: deepseek-harness/<ver> (+url)`）。
- `BlockAssembler` 能容忍"只有 delta 没有 block-start/end"的协议；已被 `block-end` 关闭的 index 再来的 delta 会被忽略。

### 1.4 `FinishReason` / `LlmFailure` code 约定

```ts
interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}
interface LlmFailure {
  message: string; code: string; status?: number
  providerRetryAfterMs?: number; requestId?: ProviderRequestId; offloadImages?: number
}
```

稳定 code（`error.ts`、`llm/README.md:74`、`llm-streaming.md:298-306`）：

| code | 语义 | 出处 |
| --- | --- | --- |
| `NO_ADAPTER` | provider 没有 adapter | `index.ts:985-988` |
| `DUPLICATE_ADAPTER` | 路由已被注册 | `index.ts:437-439` |
| `INVALID_ADAPTER` | 空路由 / `providerInfo` 不合规 | `index.ts:436,442` |
| `REGISTRATION_DISPOSED` | 已释放的 handle 再 `replace` | `index.ts:419-421` |
| `AUTH` | 401/403 | `llm-pi-ai/src/stream.ts:43` |
| `RATE_LIMIT` | 429 | 同上 |
| `QUOTA` / `ACCOUNT_QUOTA` | 余额/配额耗尽（`ACCOUNT_QUOTA` 仅第一方可充值余额） | `error.ts:27-31` |
| `CONTEXT_WINDOW_EXCEEDED` | 上下文超限（用 `isContextWindowExceededError()` 判定，**不要**自己写正则） | `error.ts:25,83-89` |
| `EMPTY_RESPONSE` | 正常 stop 但零块 → 应当报错，不是成功 | `error.ts:42` |
| `INVALID_CREDENTIAL` | 凭据格式错（不是缺失） | `error.ts:51` |
| `MISSING_CREDENTIAL` | 凭据缺失 | `llm-pi-ai/src/index.ts:200-205` |
| `IMAGE_OFFLOAD_REQUIRED` | 图片字节超预算，`offloadImages` 指出还要卸载几张 | `error.ts:175` |
| `UNSUPPORTED_REASONING_EFFORT` | 宿主在发请求前就以这个 code 拒绝 | `index.ts:904-917` |
| `UNSUPPORTED_OPTION` | pi-ai 路线拒绝 `stop` | `llm-pi-ai/src/adapter.ts:334-336` |

`normalizeLlmFailure()` 只信 `HarnessError` 子类自带且自洽的 `failure` 快照，其它 Error 一律 `code: 'UNKNOWN'`（`adapter-failure.ts:16-28,105-107`）。**推论：想把 401 映射成 `AUTH`，必须自己抛 `LlmError(msg, 'AUTH', {status:401})`；SDK 原生错误不会自动变成自己的 code。**

### 1.5 `ReplayEnvelope.replayState` 是否必须？——**不是必须，但对 thinking 是事实上必须**

`finish.replayState` 是可选字段（`types.ts:459-464`）。缺省时：
- 什么都没坏：历史 assistant 消息退化成"provider-neutral 内容"再发给 provider（`llm-pi-ai/src/replay.ts:150-183`）；
- 但**thinking 块会失去 signature**（Anthropic 的原生 thinking 块在后续回合必须原样回传 signature），并且 toolCall 会丢 `thoughtSignature`。

pi-ai 路线的 replay 口径（`llm-pi-ai/src/replay.ts:77-109`）：`response: { kind:'pi-ai', version:2, api, provider, model, responseId?, stopReason }` + `blocks[]`（与流出块**逐位对齐**，只存 signature 之类元数据，不重复正文）。自写 adapter（路线 A）若想支持"多轮 + thinking"，必须自己做同样的事，否则第二轮会被上游拒或静默丢思考。

---

## 2. 请求侧数据结构与 Anthropic 翻译要点

### 2.1 `GenerateOptions`

```ts
interface GenerateOptions {
  provider: string; model: string
  reasoningEffort?: ReasoningEffortId
  messages: RequestMessage[]
  system?: string
  tools?: ToolSchema[]
  toolHistory?: ToolHistory
  temperature?: number; maxTokens?: number; stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>
  purpose?: 'compaction' | 'session-title'
}
```

（`types.ts:511-553`。**只有** `temperature` / `maxTokens` / `stop` 三个采样旋钮，没有 `top_p` / `tool_choice` / penalty —— `llm/README.md:158`。）

### 2.2 消息与块

```ts
type Message = SystemMessage | DeveloperMessage | UserMessage | AssistantMessage | ToolResultMessage
interface ToolResultMessage { role:'tool'; toolCallId: ToolCallId; content: readonly ContentBlock[]; isError?: boolean; ... }
interface UserMessage      { role:'user'; content: readonly ContentBlock[]; ... }
interface AssistantMessage { role:'assistant'; content: readonly ContentBlock[]; source: ModelMessageSource; ... }
type ContentBlock = TextBlock | ReasoningBlock | ImageBlock | FileBlock | ToolCallBlock | ToolAdditionBlock | ToolRemovalBlock
```

（`message.ts:139-180`、`types.ts:61-150`。）

- `UserMessage.content` 可含 `text` / `image`（`ImageBlock.attachment: { attachmentId, mediaType, bytes, width, height, name? }`）/ `file`（**永远不到 provider**，已被宿主换成 handle 文本）。
- **工具结果不是 block，是 `role:'tool'` 消息**，靠 `toolCallId` 关联（`llm-streaming.md:34`）。
- `image.offloaded === true` 表示这张图已被日志决策卸载，任何路线都只发占位文本（`llm-streaming.md:127`）。

### 2.3 翻译成 Anthropic Messages 的硬约束

| 约束 | 证据 / 做法 |
| --- | --- |
| `system` 单独成字段 | `GenerateOptions.system` 优先；否则取 `messages[0]` 的 system 消息（`llm-pi-ai/src/context.ts:152-164`）。中间的 system 消息要折叠成 user 文本（`context.ts:193-202`） |
| `tool_result` 必须紧跟带 `tool_use` 的 assistant | pi-ai 的注释直说："Anthropic requires `tool_result` blocks to immediately follow their `tool_use`, so a system message between them is rejected"，因此中间夹的 system 消息被**推迟**到下一个 assistant 之前发出（`dist/api/anthropic-messages.js:1008-1012`） |
| 图片是 base64 + media_type | `{type:'image', source:{type:'base64', media_type, data}}`（`anthropic-messages.js:95-102`）；图片字节必须通过 attachment 服务取，见 §2.4 |
| thinking 块要回传 signature | 见 §1.5；pi-ai 走 `redacted_thinking` / `thinking.signature` 原样回传（`anthropic-messages.js:1100-1130`） |
| `tool_call id` 需符合 Anthropic 字符集 | pi-ai 会规范化：`id.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,64)`（`anthropic-messages.js:994-999`） |
| `max_tokens` 必填 | Anthropic 协议必需；pi-ai 用 `options.maxTokens ?? model.maxTokens` 并 clamp 到上下文（`api/simple-options.js:18-42`） |
| `temperature` 与 thinking 互斥 | 开了 thinking 就不发 `temperature`（`anthropic-messages.js:912-918`） |

### 2.4 图片字节怎么拿（两条路线相同）

```ts
const attachments = ctx.get('attachments')          // AttachmentStore | undefined
const img = await attachments.readImageRequest(ref, { width, height, maxBytes }, signal)
// img: { data: Uint8Array, mediaType, bytes, ... } —— base64 化后进请求
```

（`packages/attachment/attachment/src/index.ts:249-265`，`readImageRequest(ref, target: ImageRequestTarget, signal?)`。`ImageRequestTarget = { width, height, maxBytes }`，`packages/attachment/attachment/src/types.ts:136-143`。）

pi-ai 路线的预算默认值（`llm-pi-ai/src/config.ts:58-62`）：

- `DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 MiB`（**base64 后**的请求总预算）
- `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048`（每张请求版的像素预算）
- `DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1 MiB`（每张请求版的原始字节目标）

超预算不是静默截断：`requiredImageOffload()` 算出还要卸几张，抛 `IMAGE_OFFLOAD_REQUIRED` 并带 `offloadImages`（`content.ts:318`，`llm-pi-ai/src/context.ts:307-320`）。

---

## 3. 两条路线评估

### 3.1 事实核查：pi-ai 1.1.0 **内置 MiniMax provider**

```js
// dist/providers/minimax.js
export function minimaxProvider() {
  return createProvider({
    id: 'minimax', name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    auth: { apiKey: envApiKeyAuth('MiniMax API key', ['MINIMAX_API_KEY']) },
    models: Object.values(MINIMAX_MODELS),
    api: anthropicMessagesApi(),
  })
}
// dist/providers/minimax-cn.js
id: 'minimax-cn', name: 'MiniMax CN', baseUrl: 'https://api.minimaxi.com/anthropic',
auth: envApiKeyAuth('MiniMax CN API key', ['MINIMAX_CN_API_KEY'])
```

- 两个内置 id：`minimax`（国际，`api.minimax.io/anthropic`）与 `minimax-cn`（中国，`api.minimaxi.com/anthropic`）；README 第 84 行写的是 "MiniMax (with separate China provider)"。
- 协议都是 **`anthropic-messages`**（`anthropicMessagesApi()`）。
- 内置目录（`dist/providers/data/minimax-cn.json`，字段逐字）：

| id | reasoning | input | contextWindow | maxTokens |
| --- | --- | --- | --- | --- |
| `MiniMax-M2.7` | true | `["text"]` | 204800 | 131072 |
| `MiniMax-M2.7-highspeed` | true | `["text"]` | 204800 | 131072 |
| `MiniMax-M3` | true | `["text","image"]` | 1000000 | 512000 |

（`MiniMax-M3` 还带 `inputLimits.images.resize = { maxWidth:2000, maxHeight:2000, maxBytes:4718592, jpegQuality:80 }`，`cost.tiers` 在 512k 输入以上翻倍。）

**但这些内置 provider 不会自动注册成路由。** `dsh-llm-pi-ai` 的 `createModels()` 建完集合立刻 `clearProviders()`（`llm-pi-ai/src/models.ts:31-35`），路由集合完全来自 profile 的 key（`llm-pi-ai/src/index.ts:294-307`）。因此：

- `minimax` **当前不是已注册路由**（本机 profile 的 `llm-pi-ai.providers` key 实测为：`xiaomi-token-plan-cn, huoshan, api, glm, glm2, yue`，`~/.dsh/profiles/desktop/cordis.patch.yml:2401-2470`）；
- 但 `minimax` **已经在"可配置供应商目录"里**：`directoryEntries()` 把 `catalogProviderIds()`（= `getBuiltinProviders()`）全量登记（`llm-pi-ai/src/index.ts:124-150`）。

⚠️ 因此：**不要**为 `minimax` 调用 `ctx.llm.registerConfigurableProviders()` —— 会撞 `DUPLICATE_DIRECTORY`（`llm/src/index.ts:510-512`）。反过来，若用户哪天在 pi-ai 的 Models 页把 `minimax` 真的填成 profile，那一刻 `registerAdapter(['minimax'])` 会撞 `DUPLICATE_ADAPTER`。

结论：路由名 `minimax` 目前空闲且与"内置目录条目"不冲突（registration 与 directory 是两套表），但存在"用户日后自建同名 route"的长期风险。建议：默认用 `minimax`（符合需求），并在 `apply()` 里做一次预检 + 明确诊断（见 §4.7），或者退一步用 `minimax-local` 这类不易撞的名字。

### 3.2 baseURL 拼接：确定结论（**必须少写一段 `/v1`**）

pi-ai 的 anthropic 实现把 `model.baseUrl` 原样交给 `@anthropic-ai/sdk`（`dist/api/anthropic-messages.js:751-816`：`baseURL: model.baseUrl`），而 SDK 的请求路径是硬编码的 `'/v1/messages'`：

```js
// @anthropic-ai/sdk/resources/messages/messages.mjs:41
return this._client.post('/v1/messages', {...})
// @anthropic-ai/sdk/client.mjs:386-391
buildURL(path, query, defaultBaseURL) {
  return path.startsWith('http') ? new URL(path)
    : new URL(baseURL + (baseURL.endsWith('/') && path.startsWith('/') ? path.slice(1) : path))
}
```

即：`baseURL` 与 `/v1/messages` 是**字符串拼接**，不是 URL 相对解析。

| 路线 | 应配置的 baseURL | 实际请求 URL |
| --- | --- | --- |
| 路线 A（自己 fetch） | `https://agent.minimax.cn/mavis/api/v1/llm/v1` + 自拼 `/messages` | `…/mavis/api/v1/llm/v1/messages` |
| **路线 B（pi-ai）** | **`https://agent.minimax.cn/mavis/api/v1/llm`** | `…/mavis/api/v1/llm` + `/v1/messages` = `…/mavis/api/v1/llm/v1/messages` ✅ |

若路线 B 里错填成 `…/llm/v1`，得到的是 `…/llm/v1/v1/messages`（必然 404）。这是本任务最容易踩的坑，写进 §7 第 1 条。

### 3.3 路线 B 的能力核查：token 刷新真的能做到"按请求"

`PiAiAdapterOptions`（`llm-pi-ai/src/adapter.ts:74-104`，0.2.1-rc.2）：

```ts
export interface PiAiAdapterOptions {
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  auth: PiAiAuthInjection                       // 必填：{ credentials: CredentialStore; authContext: AuthContext }
  resolveAttachments?: () => AttachmentStore | undefined
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}
```

- **`resolveApiKey` 确有其字段，签名如上，且在每次 stream 调用时被 await**：`const apiKey = await this.config.resolveApiKey(options.provider, profile)`（`adapter.ts:348`）。workbuddy 的用法是 `resolveApiKey: async () => shim.token()`（`dsh-connect-workbuddy/src/adapter.ts:967-971`），即"每次请求现取"。返回 `undefined` 合法（`profileOptions` 只是不带 `apiKey`，`adapter.ts:115-132`）。
- 更关键的第二条通道：pi-ai 的 **provider 级 `auth.apiKey.resolve()` 每次请求都会执行**（`dist/models.js:421-441` → `dist/auth/resolve.js:14-38`），返回 `AuthResult = { auth: { apiKey?, headers?, baseUrl? }, source?, env? }`（可用字段见 pi-ai `auth/types.d.ts` 的 `ModelAuth`：`apiKey?` / `headers?` / `baseUrl?`）。`applyAuth` 会把 `auth.headers` 合并进本次请求头、把 `auth.baseUrl` 覆盖到 `model.baseUrl`。**所以"Bearer 轮换 token"和"baseURL 也跟着本地文件变"都能按请求生效，不用重建快照。**
- Anthropic SDK 的鉴权形态：`apiKey` → `x-api-key`；只有形如 `sk-ant-oat…` 的 token 才走 `Authorization: Bearer`（`anthropic-messages.js:748-780`）。因此 Mavis 网关若要求 `Authorization: Bearer <token>`，正确做法是**不设 `apiKey`**，改在 `resolve()` 里返回 `headers: { authorization: 'Bearer ' + token }`；`assertRequestAuth` 认 `authorization`/`x-api-key` 头，所以不会报"未配置"（`anthropic-messages.js:174-184`）。
- 凭据缺失要报 `MISSING_CREDENTIAL` 需要自己抛：pi-ai 会把 auth 失败包成 `ModelsError('auth', …)`，到 `normalizeLlmFailure()` 只剩 `UNKNOWN`（`adapter-failure.ts:105-107`）。做法：子类 `stream()` / `prepareCall()` 先 await 一次 token（见 §4.6）。

**思考档位（effort）从哪来**：不是我们手写的。`PiAiAdapter.resolveModel()` → `reasoningInfo()`（`llm-pi-ai/src/adapter.ts:187-202`）：`model.reasoning` 为假 → 完全不暴露 `reasoning`（GUI 无思考控件）；为真 → `efforts = getSupportedThinkingLevels(model)`（`llm-pi-ai/src/models.ts:59-67`），即 `off / minimal / low / medium / high`，外加 `xhigh`、`max`（**仅当 `model.thinkingLevelMap` 显式映射到这两个档**）。`off` 的语义是"不发 reasoning 字段"（`adapter.ts:171-186`）。请求里显式带一个模型不支持的 effort → `UNSUPPORTED_REASONING_EFFORT`（`adapter.ts:158-169`），宿主也会在发请求前用同一个 code 拒绝（`llm/src/index.ts:902-917`）。`defaultEffort` 只有在 `profile.reasoning` 显式配置时才出现。

**目录必须与 piProvider 一致**：`listModels()` 直接读 `snapshot.models.getModels(provider)`（`adapter.ts:276-287`，即 `piProvider.getModels()`），而 `resolveModel()` 走 `modelOf()`，模型不在 piProvider 里就抛 `UNKNOWN_MODEL`（`adapter.ts:253-262`）。所以 §4.4 的 `MINIMAX_MODELS` 与 `toPiModel()` 的输出必须是同一份数据的两种视图 —— 不要在两处各写一遍模型 id。

**profile 是手搓的**：不必走 settings。workbuddy 直接构造 `ResolvedPiAiProviderProfile` 字面量（`dsh-connect-workbuddy/src/adapter.ts:903-940`：`displayName:914` / `streamIdleTimeoutMs:915` / `configuredMaxTokens:917` / `modelErrors:923` / `piProvider:939`），必填字段为：

```ts
{
  provider, displayName, streamIdleTimeoutMs, retryPolicy,
  configuredMaxTokens: ReadonlyMap<string, number>,
  modelErrors: ReadonlyMap<string, string>,
  requestImagePixelBudget, requestImageMaxBytes, maxRequestImageBytes,
  piProvider,                        // 可选，但必须有它才会进 Models 集合
}
```

⚠️ `Models.setProvider()` 以 **`piProvider.id`** 为键，不是 `profile.provider`（`llm-pi-ai/src/adapter.ts:236-238`）。workbuddy 专门用注释记了这个坑并给出解法（`dsh-connect-workbuddy/src/adapter.ts:903-910`）："`Models.setProvider` keys that map on `piProvider.id` … NOT on the profile's `provider` field"。它注册两条路由时用 `{ ...provider, id: key }` 复制一份（`:939`）——**同一份 provider 对象不能同时挂在两个 id 下**，否则会注册两次。

### 3.4 路线 A：自己写 `LlmAdapter`

真正要自己写的部分（可照 `packages/llm/llm-deepseek/src/` 抄结构，那里正好是"直连 Anthropic 风格 Messages API"的完整实现）：

| 文件 | 职责 |
| --- | --- |
| `serialize.ts` | DSH 消息 → Anthropic `messages`（system 分离、tool_use/tool_result 邻接、图片 base64） |
| `sse.ts` | SSE 帧解析：`eventsource-parser/stream` + `TextDecoderStream`，非 JSON → `MALFORMED_RESPONSE`（`llm-deepseek/src/sse.ts:15-31`） |
| `translate.ts` | SSE 事件 → `StreamChunk`（block-start/delta/block-end/usage/finish） |
| `transport.ts` | HTTP、`attributionHeaders()`、状态码 → `LlmError` code |
| `replay.ts` | thinking signature / tool id 的 replay envelope |
| `adapter.ts` | `using watchdog = idleWatchdog(signal, streamIdleTimeoutMs, '…')`、超时 → `TIMEOUT`、abort → `ABORTED`（`llm-deepseek/src/adapter.ts:54-66`） |

`llm-deepseek` 全部 17 个源文件、约 2800 行（`wc -l src/*.ts`），扣掉 DeepSeek 特有的文件上传/定价，剩下的核心仍是 600～900 行量级。**这是 B 的净收益：这部分 pi-ai 已经写好并且被宿主自己的路径天天验证。**

### 3.5 推荐

**推荐 B。** 触发改用 A 的条件（都属"上游不兼容 Anthropic 假设"）：

1. Mavis 网关要求 Anthropic 客户端做不到的 URL 形态（例如路径不是 `…/v1/messages`）；
2. 网关拒绝 pi-ai 必发的 Anthropic 专有字段（`thinking.display`、`cache_control`、`tools[].eager_input_streaming`），且 compat 开关关不掉；
3. 网关的 SSE 事件名不是标准 Anthropic（`content_block_start/delta/stop`、`message_delta`、`message_stop`）；
4. 需要 `stop`（B 直接拒绝，见 §7.5）。

第 2 条的 compat 开关清单（pi-ai `AnthropicMessagesCompat`）：`supportsTemperature`、`supportsEagerToolInputStreaming`、`supportsCacheControlOnTools`、`forceAdaptiveThinking`、`supportsLongCacheRetention`、`sendSessionAffinityHeaders`、`supportsStrictTools`、`allowEmptySignature`、`supportsMidConvoEffort`、`allowedFallbackModels`。

**A 的兜底骨架（不展开，只给形状）**：

```ts
export class MiniMaxAnthropicAdapter extends LlmAdapter {
  override providerInfo(provider: string) { return { id: provider, name: 'MiniMax' } }
  override listModels(provider: string) { return Promise.resolve(MINIMAX_MODELS.map(toModelInfo(provider))) }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { /* catalog 查表 */ }
  override async prepareCall(provider, model) {
    const info = await this.resolveModel(provider, model)
    return { model: info, stream: (options) => this.streamWith(info, options) }
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const token = await tokens.token()                       // 每次请求现读，天然可刷新
    const body = serializeAnthropic(options)                 // system / messages / tools
    const response = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}`, ...attributionHeaders() },
      body: JSON.stringify(body), signal: options.signal,
    })
    if (!response.ok) throw await anthropicFailure(response)  // 401→AUTH, 429→RATE_LIMIT, 529/5xx→SERVER
    yield* translateSse(response.body!, options.model)        // 产出 block-start/…/usage/finish
  }
}
```

---

## 4. 推荐方案的骨架代码（路线 B）

> 目标：能编译、能跑通，不写业务细节（模型 id、token 文件解析按实测补）。
> 目录约定沿用 `docs/research/scaffold.md` 的包骨架，这里只给 LLM 相关文件。

### 4.1 `package.json`（关键片段）

```jsonc
{
  "name": "dsh-connect-minmax",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {},                       // 宿主包一律不进 dependencies
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.1-rc.1 <5.0.0",
    "@deepseek-ai/dsh-attachment": ">=0.1.7-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-llm": ">=0.2.1-rc.2 <0.3.0-0",
    "@deepseek-ai/dsh-llm-pi-ai": ">=0.2.1-rc.2 <0.3.0-0",
    "@earendil-works/pi-ai": ">=1.1.0 <2.0.0"
  },
  "devDependencies": {                       // 只为 typecheck / 构建；asar 内没有 .d.ts
    "@deepseek-ai/cordis": "4.0.5",
    "@deepseek-ai/dsh-attachment": "0.2.1-rc.2",
    "@deepseek-ai/dsh-llm": "0.2.1-rc.2",
    "@deepseek-ai/dsh-llm-pi-ai": "0.2.1-rc.2",
    "@earendil-works/pi-ai": "1.1.0",
    "tsdown": "^0.22.2",
    "typescript": "^5.9.3"
  }
}
```

> 为什么是 peer 而不是 dependencies：workbuddy 的实测清单里，宿主包全部是 peer + dev，真正装进 `dependencies` 的只有 `@deepseek-ai/schemastery`（`dsh-connect-workbuddy/package.json`）。`@earendil-works/pi-ai` 的 peer 范围必须同时容纳 `1.x`，并且**绝不能在插件里再装一份自己的 pi-ai**——`PiAiAdapter` 与模型对象必须来自同一个 pi-ai 实例（`dsh-connect-workbuddy/src/pi-ai-runtime.ts` 就是为这个"generation 门"存在的）。

### 4.2 `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-connect-minmax
      name: dsh-connect-minmax
```

（与 `dsh-connect-workbuddy/cordis.patch.yml` 同形；Host-only bundle 不需要 `platform` 字段，靠 `dsh.bundle.patch` 声明自己是 bundle，见 skill `cordis-plugin-development/references/host-plugin.md:5-27`。参考实现刻意没有改默认模型，因为 `id` 就是设置命名空间（`llm-pi-ai/src/index.ts:151`：`ctx.fiber.entry?.options.id ?? NS`）。）

### 4.3 `src/token.ts` —— 本地凭据（按 mtime 缓存，天然支持中途刷新）

```ts
import { readFile, stat } from 'node:fs/promises'

export interface TokenSnapshot { token: string; mtimeMs: number }

/** 读本机 MiniMax 登录凭据；每次调用都先 stat，文件变了就重读。 */
export class LocalTokenSource {
  #cache: TokenSnapshot | undefined

  constructor(private readonly path: string) {}

  /** @throws Error 当文件读不到或解析不出 token（调用方负责翻成 LlmError）。 */
  async snapshot(): Promise<TokenSnapshot> {
    const info = await stat(this.path)
    if (this.#cache !== undefined && this.#cache.mtimeMs === info.mtimeMs) return this.#cache
    const raw = await readFile(this.path, 'utf8')
    const token = extractToken(raw)
    if (token.length === 0) throw new Error(`no usable token in ${this.path}`)
    this.#cache = { token, mtimeMs: info.mtimeMs }
    return this.#cache
  }

  /** 供 auth.resolve 用的同步快路径：已缓存就用缓存，否则读文件（auth 是 async 的，直接 await snapshot()）。 */
  async token(): Promise<string> {
    return (await this.snapshot()).token
  }
}

function extractToken(raw: string): string {
  const text = raw.trim()
  if (text.startsWith('{')) {
    const parsed = JSON.parse(text) as Record<string, unknown>
    for (const key of ['access_token', 'accessToken', 'token', 'id_token']) {
      const value = parsed[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return ''
  }
  return text
}
```

### 4.4 `src/models.ts` —— 模型目录 + pi-ai 模型描述

```ts
import type { Api, Model } from '@earendil-works/pi-ai'

export const ROUTE = 'minimax'
/** pi-ai 的 anthropic 实现会拼 `/v1/messages`，所以这里少写一段 `/v1`。 */
export const DEFAULT_BASE_URL = 'https://agent.minimax.cn/mavis/api/v1/llm'

export interface MiniMaxModelSpec {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  input: readonly ('text' | 'image')[]
  reasoning: boolean
}

/** 目录以网关真实返回为准；下面三点来自 pi-ai 内置 minimax-cn 目录，可作起点。 */
export const MINIMAX_MODELS: readonly MiniMaxModelSpec[] = [
  { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 1_000_000, maxTokens: 512_000, input: ['text', 'image'], reasoning: true },
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextWindow: 204_800, maxTokens: 131_072, input: ['text'], reasoning: true },
]

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** 把目录项翻译成 pi-ai 的 Model（字段与内置目录 JSON 逐一对齐）。 */
export function toPiModel(spec: MiniMaxModelSpec, baseUrl: string): Model<Api> {
  return {
    id: spec.id,
    name: spec.name,
    api: 'anthropic-messages',
    provider: ROUTE,
    baseUrl,
    reasoning: spec.reasoning,
    input: [...spec.input],
    cost: { ...NO_COST },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    // MiniMax 不是 Anthropic：不确定的开关一律显式关掉，别让自动探测猜。
    compat: {
      supportsCacheControlOnTools: false,
      supportsEagerToolInputStreaming: false,
      supportsTemperature: true,
    },
  }
}
```

### 4.5 `src/provider.ts` —— 自建 provider（auth 每次请求现读 token）

```ts
import type { Api, AuthContext, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { ROUTE } from './models.ts'
import type { LocalTokenSource } from './token.ts'

/**
 * 惰性 auth 平面：本插件只认本地文件，pi-ai 自己的凭据生命周期与 OAuth 刷新必须永远拿不到东西。
 * 形状照 dsh-connect-workbuddy/src/adapter.ts:164-177 的 INERT_AUTH。
 */
export const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() { throw new Error('dsh-connect-minmax: no pi-ai credential lifecycle') },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** 每请求解析一次：Models.applyAuth() 会在每次 streamSimple 前调用它。 */
export async function resolveLocalAuth(tokens: LocalTokenSource): Promise<
  { auth: { headers: Record<string, string> }; source: string } | undefined
> {
  try {
    const token = await tokens.token()
    // 若网关用 x-api-key，改成 return { auth: { apiKey: token }, source: 'minimax-local' }
    return { auth: { headers: { authorization: `Bearer ${token}` } }, source: 'minimax-local-file' }
  } catch {
    return undefined    // 交给上层抛 MISSING_CREDENTIAL（见 adapter.ts 的 guard）
  }
}

/** 结构与 dsh-llm-pi-ai/src/models.ts:42-52 一致：单协议静态 provider。 */
export function buildProvider(
  models: readonly Model<Api>[],
  baseUrl: string,
  tokens: LocalTokenSource,
): Provider {
  const api = anthropicMessagesApi()
  return {
    id: ROUTE,               // 必须等于 profile.provider 与 registerAdapter 的路由名（Models 以 piProvider.id 为键）
    name: 'MiniMax',
    baseUrl,
    auth: { apiKey: { name: 'MiniMax 本机登录凭据', resolve: () => resolveLocalAuth(tokens) } },
    getModels: () => [...models],
    stream: (model, context, options) => api.stream(model, context, options),
    streamSimple: (model, context, options) => api.streamSimple(model, context, options),
  }
}
```

### 4.6 `src/adapter.ts` —— 包一层 `PiAiAdapter`：凭据预检 + 错误分类

```ts
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import type { LocalTokenSource } from './token.ts'

/** pi-ai 会把 SDK 错误拍平成 message，只能按文本分类（同 dsh-llm-pi-ai/src/stream.ts:42-68）。 */
function classify(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b(?:insufficient[\s_-]*(?:quota|balance|credits?)|out[\s_-]+of[\s_-]+credits?)\b/i.test(message)) return 'QUOTA'
  if (/\b(?:400|invalid.?request)\b/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b/i.test(message)) return 'TIMEOUT'
  return 'PROVIDER_ERROR'
}

export class MiniMaxAdapter extends PiAiAdapter {
  constructor(config: PiAiAdapterOptions, private readonly tokens: LocalTokenSource) {
    super(config)
  }

  /**
   * ⚠️ 必须同时覆盖 prepareCall：PiAiAdapter.prepareCall 捕获的是私有 streamWithSnapshot
   * （dsh-llm-pi-ai/src/adapter.ts:318-324），只覆盖 stream() 会被它绕过。
   * workbuddy 同样两个都覆盖（dsh-connect-workbuddy/src/adapter.ts:818-830）。
   */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const call = await super.prepareCall(provider, model, signal)
    return {
      model: call.model,
      stream: (options: GenerateOptions) => this.guard(options, () => call.stream(options)),
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.guard(options, () => super.stream(options))
  }

  /** 先确认凭据在（否则 MISSING_CREDENTIAL），再把终端失败翻成 Harness code。 */
  private async * guard(
    options: GenerateOptions,
    run: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    try {
      await this.tokens.token()
    } catch (error: unknown) {
      throw new LlmError(
        `MiniMax 本机登录凭据不可用：${error instanceof Error ? error.message : String(error)}`,
        'MISSING_CREDENTIAL',
        { cause: error },
      )
    }
    try {
      yield* run()
    } catch (error: unknown) {
      if (options.signal?.aborted) throw new LlmError('MiniMax 请求被取消', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new LlmError(`MiniMax 请求失败：${message}`, classify(message), { cause: error })
    }
  }
}
```

### 4.7 `src/index.ts` —— 插件入口（注册路由 / 模型 / 图片能力）

```ts
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import type { Context } from '@deepseek-ai/cordis'
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { MiniMaxAdapter } from './adapter.ts'
import { buildProvider, INERT_AUTH } from './provider.ts'
import { DEFAULT_BASE_URL, MINIMAX_MODELS, ROUTE, toPiModel } from './models.ts'
import { LocalTokenSource } from './token.ts'

export const name = 'dsh-connect-minmax'
export const inject = ['llm']            // 硬依赖：apply() 里要直接用 ctx.llm

const STREAM_IDLE_TIMEOUT_MS = 300_000   // 与 pi-ai 路线默认值一致（config.ts:47）
const TOKEN_PATH = `${process.env.HOME ?? ''}/.minimax/credentials.json`   // 按实测改

export function apply(ctx: Context): void {
  // 路由被占用时不要 throw：apply 抛错会让整个插件激活失败，还会掩盖真正原因。
  const taken = ctx.llm.listProviders().some(provider => provider.id === ROUTE)
  if (taken) {
    ctx.logger.warn(`dsh-connect-minmax: 路由 "${ROUTE}" 已被其它 adapter 占用，本插件不注册`)
    return
  }

  const tokens = new LocalTokenSource(TOKEN_PATH)
  const models = MINIMAX_MODELS.map(spec => toPiModel(spec, DEFAULT_BASE_URL))
  const provider = buildProvider(models, DEFAULT_BASE_URL, tokens)

  const profile: ResolvedPiAiProviderProfile = {
    provider: ROUTE,
    displayName: 'MiniMax（本机登录）',
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-minmax retryPolicy'),
    configuredMaxTokens: new Map(),      // 目录里的 maxTokens 只用来 sizing，不当请求默认值
    modelErrors: new Map(),
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    piProvider: provider,
  }

  // profiles() 必须同步；返回同一个 Map 引用才能命中 PiAiAdapter 的快照缓存
  // （换了 Map 就等于换一代配置：adapter.ts:231-243 按 Map 身份判新旧）。
  // token 不在这里读 —— 它走 provider 的 auth.resolve（每请求）。
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => new Map([[ROUTE, profile]])

  const options: PiAiAdapterOptions = {
    profiles,
    // 凭据走 provider 的 auth.resolve（每请求），所以这里交回 undefined：
    // PiAiAdapter 只是不带 apiKey 选项，不会因此报错（adapter.ts:115-132, 348）。
    resolveApiKey: async () => undefined,
    auth: INERT_AUTH,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    onReplayDegrade: ({ provider, model, reason }) =>
      ctx.logger.warn(`dsh-connect-minmax: ${provider}/${model} 的 replay state 不可用（${reason}）`),
  }

  const adapter = new MiniMaxAdapter(options, tokens)

  // 注册即绑定 fiber：HMR / 卸载时自动释放路由（llm/src/index.ts:403-412）。
  ctx.llm.registerAdapter([ROUTE], adapter)

  ctx.logger.info(`dsh-connect-minmax: 已注册 provider "${ROUTE}"（${models.length} 个模型）`)
}
```

> 说明：`MiniMaxAdapter` 继承了`MiniMaxAdapter` 继承了 `PiAiAdapter` 的 `providerInfo`（用 `profile.displayName`，`adapter.ts:265-270`）、`listModels`（把 `model.input` 映射成 `inputModalities`，`adapter.ts:276-287`）、`resolveModel`（`context.contextWindow` + `defaultMaxTokens` + `reasoning`，`adapter.ts:289-316`），所以**只有 `stream` 是必须自己写的**——而这里连 `stream` 的主要工作也只是包装。

---

## 5. GUI 模型选择器：可见性条件与默认模型

GUI 的模型目录构建代码（`packages/api/session-controller/src/catalog.ts:20-72`）逐条规定：

| 条件 | 代码 | 不满足会怎样 |
| --- | --- | --- |
| 路由已注册 | `ctx.llm.listProviders()` 遍历 | 不出现（provider 整组消失） |
| 组名 = `provider.name` | `{ id: provider.id, name: provider.name }` | —— 即 `PiAiAdapter.providerInfo()` 返回的 `displayName`；想改显示名改它 |
| `listModels(provider)` 非空 | `await ctx.llm.listModels(provider.id)` | `groups.filter(g => g.models.length > 0)` 把空组丢掉（`:64-65`） |
| 每个模型 `resolveModelInfo()` 必须成功 | `:29` | 抛错 → 该 **provider 整体**进 `failures`，一个模型都选不到（`:53-62`） |
| 选择校验 | `modelAvailable()`：`listProviders` + `listModels` 都命中（`:80-89`） | 选中后提交会 remote error `session/model-unavailable` |
| `reasoning.efforts` 决定思考档位下拉 | `:30-41` | 没 `reasoning` 就只显示"默认" |

结论：

1. **`listModels` 足够（且必需）**；`registerConfigurableProviders` 只服务"新增/编辑供应商端点"的配置页，对模型选择器**没有**贡献——而且对 `minimax` 调它还会撞 `DUPLICATE_DIRECTORY`（§3.1）。本插件不需要 `settingsNs`、不需要声明可配置供应商。
2. `providerInfo().name` 就是选择器里的分组名。`PiAiAdapter` 已经用 `profile.displayName` 实现（`adapter.ts:265-270`），所以 `displayName: 'MiniMax（本机登录）'` 直接生效；注意 run-time 校验：`providerInfo().id` 必须等于路由名，`name` 非空（`index.ts:441-442`）。
3. **默认模型不在 adapter 里**：由 `agentDefaultModel` 服务持有（`packages/core/agent-default-model/src/index.ts:48-73`，配置字段 `provider` / `model` / `reasoningEffort`，都是 volatile）。GUI 的 Models 页通过 `saveSelection()` 写回 profile（`configEditor.edit`）。本插件要做的只是"启动时就把 `minimax` 注册上"，否则默认选择校验失败、页面显示不可用。
4. 模型目录来自 `piProvider.getModels()`（`adapter.ts:280-286`），所以 §4.4 的数组就是 GUI 里看到的东西；`contextWindow` / `inputModalities` / `reasoning` 都从这里流出去。

---

## 6. 宿主插件声明、注入与延迟注入

- **是不是 host 插件**：`package.json` 里 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` + patch 里 `- insert:` 一行（见 §4.2）。Host-only bundle 不需要 dependencies/构建链（skill `host-plugin.md:5-27`）。
- **`inject: ['llm']`**：`export const inject = ['llm']` 让 Cordis 等 `llm` 服务就绪后再 `apply()`，并且 `ctx.llm` 直接可用（`llm` 服务的 `access.hardDependency` 就是 `inject:['llm']`，见 `cordis_inspect_query` 的输出）。workbuddy 用的是 `export const inject = ['llm', 'settings']`（`dsh-connect-workbuddy/src/index.ts:270-271`）。
- **可选服务必须 `ctx.inject`，不能 apply 期 `ctx.get()` 采样**。workbuddy 的教训原文（`src/index.ts:1170-1176`）：

  > "用 `ctx.inject` 等它出现再注册，而不是 apply 期间 `ctx.get()` 采样一次：采样会静默丢掉工具（同 webServer 的注释）。"

  对我们而言这是 `attachments`（图片能力）与 `settings`：`attachments` 可能晚于本插件挂载，用 `ctx.get('attachments')` 在**请求时**读（§4.7 的 `resolveAttachments`）就是正确姿势；若要在 `apply` 期用它做别的，必须 `ctx.inject(['attachments'], …)`。
- **`ctx.effect` 归属**：任何 disposer 都要挂到发起它的 fiber 上。`registerAdapter` 内部已经 `ctx.effect(...)`（`llm/src/index.ts:403`），不需要你再包一层。
- **pin 住 Loader 条目 id**：设置命名空间 = Loader 条目 id（`llm-pi-ai/src/index.ts:151`；`dsh-connect-workbuddy/src/index.ts:295-299` 的函数 `settingsNamespaceOf`）。我们不注册 settings，但若以后加配置卡片，命名空间必须用 `ctx.fiber.entry?.options.id` 探测，不能写死。

---

## 7. 坑清单（按杀伤力排序）

1. **baseURL 多/少一段 `/v1`**（§3.2）。pi-ai 永远拼 `/v1/messages`。正确值 `https://agent.minimax.cn/mavis/api/v1/llm`；写成需求原文的 `…/llm/v1` → `…/llm/v1/v1/messages`。路线 A 才用 `…/llm/v1` + `/messages`。
2. **路由名 `minimax` 的双重身份**。运行时没有占用（`llm-pi-ai.providers` 无 `minimax` 键），但 pi-ai 目录里 `minimax` / `minimax-cn` 已被 `dsh-llm-pi-ai` 登记为**可配置供应商**（`llm-pi-ai/src/index.ts:124-150`）。→ 别 `registerConfigurableProviders(['minimax'])`（`DUPLICATE_DIRECTORY`，`llm/src/index.ts:510-512`）；用户日后自建同名 pi-ai profile 会撞 `DUPLICATE_ADAPTER`。预检见 §4.7。
3. **鉴权头形态**。Anthropic SDK：`apiKey` → `x-api-key`；只有 `sk-ant-oat…` 才 Bearer（`anthropic-messages.js:748-780`）。要 Bearer 就**别设 apiKey**，在 provider `auth.resolve()` 返回 `headers.authorization`；`assertRequestAuth` 认这个头（`:174-184`）。同时这也解决了"中途换 token"：`resolve()` 每请求执行一次（`models.js:421-441`）。
4. **`prepareCall` 绕过 `stream()` 覆写**。`PiAiAdapter.prepareCall` 直接捕获私有 `streamWithSnapshot`（`adapter.ts:318-324`）。只覆盖 `stream()` 的话，agent loop 走 `prepareCall` 的路径完全不受你的 guard 影响。必须两个都覆盖（workbuddy `adapter.ts:818-830` 的写法）。
5. **`stop` 不支持**。`dsh-llm-pi-ai` 直接 `throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')`（`adapter.ts:334-336`，决策见 `2026-07-14-provider-routed-llm-adapters.md`）。若某个生产者在请求里带 `stop`，这条路由会整条失败。路线 A 可以映射到 `stop_sequences`。
6. **思考参数是 Anthropic 的形状**。`reasoning:true` + 未设 `forceAdaptiveThinking` → 发 `thinking: { type:'enabled', budget_tokens, display:'summarized' }`（`anthropic-messages.js:933-955`）；预算表 `{minimal:1024, low:2048, medium:8192, high:16384}`（`simple-options.js:45-50`）。`reasoning:false` 且 `thinkingLevelMap.off !== null` 时会发 `thinking:{type:'disabled'}`（`:955-957`）。想"完全不发 thinking 字段"，只能让 `model.reasoning` 为假。**MiniMax Mavis 是否接受 `display` 未验证**（见 §8）。另：宿主在发请求前就会用 `UNSUPPORTED_REASONING_EFFORT` 拒绝"模型没声明 effort 却显式要 effort"（`index.ts:902-917`）。
7. **asar 内没有任何 `.d.ts`**（实测 `*.d.ts` 条目数 = 0）。插件 typecheck 只能靠 devDependencies 装 npm 包；运行时裸导入由宿主解析（workbuddy 把宿主包全列 peer、并写了 `pi-ai-runtime.ts` 检测实际解析到哪一份 pi-ai）。范围上必须允许 `>=1.1.0 <2.0.0`，否则宿主升级会挡安装。
8. **能力元数据不完整会毁掉整个分组**。`resolveModelInfo` 抛错 → 整组进 `failures`（`catalog.ts:29,53-62`）；`listModels` 里出现重复 id / `provider` 不匹配 / 空 name → `INVALID_CATALOG`（`llm/src/index.ts:702-720`，抛点 717）。模型目录宁可少列，也不要列一个算不出 `contextWindow` 的条目。
9. **图片预算与投影**。`inputModalities` 不含 `image` 的模型收到的是**占位文本**而不是图（`index.ts:1070-1074`）；含 image 的模型由 adapter 自己走 attachment 服务取字节，超过 `maxRequestImageBytes` 会抛 `IMAGE_OFFLOAD_REQUIRED`（不是静默降级）。M3 支持图片、M2.7 只有文本——目录里必须如实声明，否则用户发图会得到"模型不支持"或上游 400。
10. **`developer` 消息 / 延迟工具**。`toolUpdate` 缺省（pi-ai 路线就是缺省）时宿主剥掉 `developer` 消息并去掉 `deferLoading`（`content.ts:424-437`）；而 pi-ai 的 context 转换里 developer 消息是直接抛 `UNSUPPORTED_CONTENT` 的（`llm-pi-ai/src/context.ts:50-63`）。正常 loop 请求因此安全，但如果哪天有人给这条路由声明 `toolUpdate`，会踩这个雷。
11. **错误 code 不会自动对**。SDK/pi-ai 的错误到 `normalizeLlmFailure()` 只剩 `UNKNOWN`（`adapter-failure.ts:105-107`）。必须像 §4.6 那样自己分类：`401/403 → AUTH`、`429 → RATE_LIMIT`、配额文案用 `isQuotaExceededError()`、上下文用 `isContextWindowExceededError()`（不要自己写正则，`error.ts:83-103`）。
12. **HMR / 热重载生命周期**。注册随 fiber 释放（`index.ts:403-412`）；释放后再 `replace()` → `REGISTRATION_DISPOSED`（`:416-423`）。安装新 bundle 可能经 HMR 直接生效，但**替换已安装包需要重启**（skill `host-plugin.md:70`）——`docs/research/scaffold.md` 也记了"重启 DSH Desktop（无 HMR）"。若旧实例尚未 dispose 而新实例先 apply，`registerAdapter` 会 `DUPLICATE_ADAPTER` 并把新插件激活打挂：因此 §4.7 里先 `listProviders()` 预检 + 记日志，而不是无条件注册。
13. **replay 只在同一 adapter 实例内有效**。换了实现（A↔B）或换了插件实例，历史 thinking 的 signature 会退化成 neutral 内容（`index.ts:991-1005`，`replay.ts:245-257`）。切路线时旧会话的思考块会"降级"，不会崩。
15. **模型目录必须与 `piProvider` 同源**。`listModels` 来自 `piProvider.getModels()`，而 `resolveModel` 对不在其中的模型抛 `UNKNOWN_MODEL`（`adapter.ts:253-262,276-287`）。两处模型 id 各写一遍 → GUI 里能看见、点下去就报错，或反过来（组内一个模型解析失败 → **整组 provider 变成 failure**，见 §5）。
16. **`reasoning` 元数据不是我们写的**。`model.reasoning` 为假 → GUI 不显示思考档位、请求里的 effort 会被宿主以 `UNSUPPORTED_REASONING_EFFORT` 拒绝（`llm/src/index.ts:902-917`）；为真 → 档位固定是 `off/minimal/low/medium/high`（`xhigh/max` 需显式 `thinkingLevelMap`）（`llm-pi-ai/src/models.ts:59-67`、`adapter.ts:187-202`）。`defaultEffort` 只有显式配 `profile.reasoning` 才有。
14. **`attributionHeaders()` 是硬要求**。pi-ai 路线由 `requestHeaders()` 自动合并且宿主保留保留字段（`llm-pi-ai/src/adapter.ts:205-212`）；自写 HTTP 必须自己带 `user-agent`（`attribution.ts:64-68`）。

---

## 8. 尚未验证、实施前必须实测的点

| # | 问题 | 怎么验 |
| --- | --- | --- |
| 1 | Mavis 网关到底要 `Authorization: Bearer` 还是 `x-api-key`，是否需要额外头（agent/session id） | 用最小 `curl` 打 `POST …/mavis/api/v1/llm/v1/messages`，两种头各试一次 |
| 2 | 网关真实模型 id 与 `contextWindow` / `maxTokens` / 是否收图 | 抓本机 MiniMax 客户端请求，或列目录接口；**不要**直接照抄 pi-ai 的 `MiniMax-M3`（那是官方 API 的 id） |
| 3 | 是否接受 Anthropic 的 `thinking:{type:'enabled',budget_tokens,display}`、`cache_control`、`eager_input_streaming` | 发一次带 thinking 的请求；若 400，先用 §3.5 的 compat 开关关字段，再不行改 `reasoning:false` |
| 4 | SSE 是否为标准 Anthropic 事件名（`content_block_delta` 的 `thinking_delta` / `input_json_delta`、`message_delta`、`message_stop`） | 看原始响应流；不一致则路线 B 作废，转 A |
| 5 | token 文件的实际路径/格式/有效期，刷新后 mtime 是否变化 | `stat` + 解析；变更后立刻再请求一次，确认 200 |
| 6 | 网关是否对 `tool_result` 邻接、`system` 单独字段有额外要求 | 用一次带工具的多轮回放（assistant tool_use → tool result）验证 |

---

## 9. 路径索引（复查用）

| 想确认什么 | 打开哪里 |
| --- | --- |
| `LlmAdapter` 全部默认实现 | `deepseek-harness/packages/llm/llm/src/index.ts:208-291` |
| 注册/替换/释放语义 | 同文件 `:396-471` |
| 请求分发与投影 | 同文件 `:1033-1122`、`content.ts:369-437` |
| 服务方法权威签名 | `cordis_inspect_query(Service, listService, {"service":"llm"})` |
| adapter 契约散文版 | `deepseek-harness/docs/subsystems/llm-streaming.md:294-306` |
| `PiAiAdapter` 全貌 | `deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts` |
| pi-ai profile 与默认预算 | `…/llm-pi-ai/src/config.ts:46-68,186-219` |
| DSH 消息 → pi-ai Context | `…/llm-pi-ai/src/context.ts` |
| pi-ai 事件 → StreamChunk | `…/llm-pi-ai/src/stream.ts` |
| replay 口径 | `…/llm-pi-ai/src/replay.ts` |
| 直连 HTTP+SSE 的写法 | `…/llm-deepseek/src/{adapter,sse,translate,transport}.ts` |
| pi-ai 内置 minimax | `app.asar/dsh/node_modules/@earendil-works/pi-ai/dist/providers/{minimax,minimax-cn}.js` + `providers/data/minimax-cn.json` |
| baseURL 拼接 | `@anthropic-ai/sdk/client.mjs:386-391`、`resources/messages/messages.mjs:41` |
| 参考插件（同作者） | `dsh-connect-workbuddy/src/{adapter,index}.ts`、`dsh-connect-trae/src/adapter.ts` |
| 包骨架/清单/构建 | `docs/research/scaffold.md`（本仓库） |
