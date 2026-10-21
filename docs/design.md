# dsh-connect-minmax 设计说明（v1）

把**本机已登录的 MiniMax（MiniMax Code / mcode）账号**接入 DeepSeek Harness，注册一个名为
`minimax` 的模型供应商路由。**不提供任何 API Key 输入**：凭据只从本机登录态读取，
优先走 mcode 的 Auth Lease Broker，允许中途刷新，且**绝不写用户凭据文件**。

## 1. 已实测确认的事实（证据见 docs/research/upstream.md）

| 事项 | 结论 |
| --- | --- |
| 上游协议 | Anthropic Messages 兼容：`POST {base}/messages`，SSE 事件名与 Anthropic 标准一致（`message_start`/`content_block_start`/`content_block_delta`（`thinking_delta`/`text_delta`/`input_json_delta`）/`message_stop`） |
| base（pi-ai 路线） | `https://agent.minimax.cn/mavis/api/v1/llm`（**少写一段 `/v1`**，SDK 自己拼 `/v1/messages`）；global 为 `https://agent.minimax.io/mavis/api/v1/llm` |
| 鉴权头 | `Authorization: Bearer <accessToken>` + `anthropic-version: 2023-06-01`。`x-api-key` 不是必需（`x-api-key` 只放 token 反而 401 `token is required`） |
| 模型 | `MiniMax-M3`、`MiniMax-M3.1-Flash`、`MiniMax-M2.7`、`MiniMax-M2.7-highspeed`、`MiniMax-M3.1-Flash-Preview` 均 200 |
| thinking | 接受 `{"type":"adaptive"}`、`{"type":"enabled","budget_tokens":N}`、`{"type":"disabled"}`；`output_config.effort` 亦可。**`MiniMax-M3.1-Flash` 必须 adaptive：发 `disabled` → 400 `requires adaptive thinking`** |
| 图片 | base64 `image` block 可用（M3 / M3.1-Flash / M2.7 / M2.7-highspeed 实测均 200） |
| effort 取值 | `output_config.effort` 只接受 `low` / `medium` / `high` / `xhigh` / `max`；`on` / `off` → 400 `invalid reasoning_effort`（MiniMax Code 的 M3 开关拼的就是 `on`/`off`，那套在当前网关不成立） |
| 文档结构 | 模型名/顺序/上下文档位/思考形态以 `~/.minimax/config.yaml`（远端快照）与随包 `@mavis/config/src/minimax-model-catalog.ts` 为准；`M3`/`M3.1-Flash` 有 512K 与 1M 两档（1M 标 `higher_usage`） |
| 工具 | `tool_use` / `tool_result` 多轮回放均可用 |
| usage | Anthropic 字段名：`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`，另有 `output_tokens_details.thinking_tokens` |
| 401 语义 | `{"error":"invalid access token"}`；token 可能被服务端提前撤销（实测有效期短于 `expiresAtMs`） |

## 2. 凭据获取（核心设计）

**只读，不写凭据文件。** 两条通路，按优先级：

1. **Auth Lease Broker（首选）**：mcode 运行时在
   `~/.minimax/run/mcode-auth-lease-v1.sock`（Windows 命名管道）提供租约服务，
   能力文件 `~/.minimax/run/mcode-auth-lease-v1.cap`（43 字符 base64url，0600）。
   - 帧：4 字节大端长度 + UTF-8 JSON（≤64KiB）。
   - 请求 `{"version":1,"requestId","capability","method":"lease","minValidityMs":60000}`
     → `{"ok":true,"result":{"method":"lease","accessToken","expiresAtMs","generation","audience":"agent-backend","scopes":["agent.default"]}}`。
   - `status` 可查登录态（`authenticated`/`anonymous`/`expired`/…）。
   - **禁止主动发 `unauthorized`**：broker 刷新失败时会直接登出用户（实测已踩）。
     401 时只做「重新 lease 取新 token + 重试一次」，仍失败则以 `AUTH` 失败上报并提示重新登录。
   - 由 mcode 自己负责刷新 → 插件零维护、零副作用。
2. **本地凭据文件（兜底，只读）**：`~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`
   （`records` 第一条的 `accessToken` / `expiresAtMs` / `generation`），配合 `auth-state.json`
   的 `region`/`status`。**不刷新、不回写**（refreshToken 严格一次性轮换，乱刷会毁掉用户登录）。

token 缓存策略：内存缓存 + `expiresAtMs - 60s` 提前失效；401 时 `invalidate()` 后重新取。

## 3. 技术路线：pi-ai + `PiAiAdapter`（路线 B）

- 复用 `@earendil-works/pi-ai` 的 `anthropicMessagesApi()`（Anthropic 兼容实现，
  已被宿主自身验证）+ `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter`（StreamChunk 翻译、
  图片、工具、replay、快照）。
- 自建 `Provider`：`auth.apiKey.resolve()` **每次请求执行**，返回
  `{ auth: { headers: { authorization: 'Bearer ' + token } }, source }`；
  不设 `apiKey`（那会走 `x-api-key`）。
- `MiniMaxAdapter extends PiAiAdapter`：`prepareCall` 与 `stream` **都要**覆盖
  （`prepareCall` 捕获的是私有 `streamWithSnapshot`），做三件事：
  1. 请求前预检凭据 → 失败抛 `LlmError('…','MISSING_CREDENTIAL')`；
  2. 401 → 失效缓存、重取 token、重试一次（用同一请求体）；
  3. 终态错误 → Harness failure code（`AUTH`/`RATE_LIMIT`/`QUOTA`/`CONTEXT_WINDOW_EXCEEDED`/`TIMEOUT`/`SERVER`）。
- 模型能力：`reasoning: true` + `thinkingLevelMap`，`minimal` 一律 `null`（上游无此档），
  `M3.1-Flash` / `M2.7-highspeed` 的 `off` 为 `null`（关不掉）；`MiniMax-M3.1-Flash` 的
  `off` 映射为 `null`（不提供"关闭思考"档，避免 400）。
- base URL、模型表与 pi-ai `Model` 描述**同源**（`catalog.ts` 一处定义）。

## 4. 模块与接口契约

```
src/
  index.ts       插件入口：Config、inject、apply()、注册 adapter、可选状态路由
  catalog.ts     模型目录 + toPiModel()（pi-ai Model）
  auth.ts        MiniMaxAuth：token()/inspect()/invalidate()/region/baseUrl
  lease.ts       AuthLeaseClient：socket 帧协议、status/lease、错误码
  adapter.ts     MiniMaxAdapter + createMiniMaxProvider()
  status.ts      /plugins/dsh-connect-minmax/status 路由（给设置卡片）
  client/        Web 设置卡片（React）
locale/{zh,en}.json
cordis.patch.yml, package.json, tsdown.config.ts, tsconfig*.json, vitest.config.ts
```

对外契约（实现必须一致）：

```ts
// catalog.ts
export const ROUTE = 'minimax'
export interface MiniMaxModelSpec {
  id: string; name: string; description?: string
  contextWindow: number; maxTokens: number
  input: readonly ('text' | 'image')[]
  reasoning: boolean
  thinkingLevelMap?: Readonly<Record<string, string | null>>
  defaultEffort?: string
}
export const MINIMAX_MODELS: readonly MiniMaxModelSpec[]
export function toPiModel(spec: MiniMaxModelSpec, baseUrl: string): Model<Api>

// lease.ts
export class AuthLeaseClient {
  constructor(dataDir: string)
  available(): Promise<boolean>
  status(signal?: AbortSignal): Promise<{ status: string; generation: number; expiresAtMs?: number }>
  lease(minValidityMs?: number, signal?: AbortSignal): Promise<{ accessToken: string; expiresAtMs: number; generation: number }>
  close(): void
}

// auth.ts
export interface MiniMaxLoginStatus {
  state: 'ready' | 'anonymous' | 'missing' | 'expired' | 'error'
  source: 'lease' | 'file' | 'none'
  generation?: number
  expiresAtMs?: number
  region: 'cn' | 'global'
  detail?: string
}
export class MiniMaxAuth {
  constructor(options?: { dataDir?: string; env?: NodeJS.ProcessEnv })
  token(signal?: AbortSignal): Promise<string>   // 抛 MiniMaxAuthUnavailableError
  inspect(signal?: AbortSignal): Promise<MiniMaxLoginStatus>
  invalidate(): void
  readonly region: 'cn' | 'global'
  readonly baseUrl: string
  readonly regionLabel: string   // '国内版' | '国际版'
}

// adapter.ts
export function createMiniMaxProvider(auth: MiniMaxAuth, models: readonly MiniMaxModelSpec[]): Provider
export class MiniMaxAdapter extends PiAiAdapter { constructor(options: PiAiAdapterOptions, auth: MiniMaxAuth) }
```

## 5. 宿主接线

- `export const name = 'dsh-connect-minmax'`；`export const inject = ['llm']`。
- `apply(ctx, config)`：
  1. 路由预检：`ctx.llm.listProviders()` 已有 `minimax` → 记 warn 并跳过（不 throw）；
  2. 构造 `MiniMaxAuth`、模型表、Provider、`ResolvedPiAiProviderProfile`
     （`provider`、`displayName: 'MiniMax（本机登录）'`、`streamIdleTimeoutMs`、`retryPolicy`、
     `configuredMaxTokens: new Map()`、`modelErrors: new Map()`、图片预算、`piProvider`）；
  3. `ctx.llm.registerAdapter([ROUTE], adapter)`（fiber 释放自动注销）；
  4. `ctx.inject(['webServer'], …)` 注册状态路由（可选服务，不能 apply 期 `ctx.get()` 采样）。
- `Config`（schemastery）：`models`（可空 = 全部）、`region`（`auto|cn|global`）、
  `streamIdleTimeoutMs`、`baseUrl`（空 = 按 region 默认）。
- 不注册 `registerConfigurableProviders`（`minimax` 在 pi-ai 目录里已被登记，避免 `DUPLICATE_DIRECTORY`）。
- 不写 profile 的默认模型（用户自己在 Models 页选）。

## 6. 设置卡片（client）

- 槽位：`plugins.bundle.config`（key = 包名）。
- 展示：登录态（已登录/需登录）、来源（mcode 租约 / 本地文件）、generation、到期时间、
  区域、模型数量与清单、最近一次错误。
- 数据：宿主 `webServer` 路由 `/plugins/dsh-connect-minmax/status` 返回 JSON；
  客户端 10s 轮询（页面可见时）。
- 文案：`ctx.locale.register` 中文/英文；插件管理器用 `locale/*.json`。

## 7. 验收标准

1. `pnpm typecheck && pnpm test && pnpm build` 全绿。
2. 安装到 desktop profile 后：Models 页出现分组「MiniMax（本机登录）」，含 M3 / M3.1-Flash / M2.7 / M2.7-highspeed。
3. 选 `MiniMax-M3.1-Flash` 真跑一轮：流式文本、思考块、工具调用（bash/read 等）均正常。
4. 设置卡片显示登录态与来源；关掉 MiniMax Code 后卡片提示「本地文件兜底 / 需登录」。
5. 无任何 API Key 输入项；插件不写 `~/.minimax` 下任何文件。

## 8. 非目标（v1）

- 官方 API Key / 平台账号（api.minimaxi.com）路线。
- 额度/积分查询（需 md5 签名，见 upstream.md §9）。
- 图片生成、账号池、签到。
- 自己发起 OAuth 设备码登录（协议已摸清，留作 v1.1 的「登录恢复」按钮）。
