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
export const ROUTE_GLOBAL = 'minimax-global'
export const MINIMAX_ROUTES = { cn: ROUTE, global: ROUTE_GLOBAL }
export function routeForRegion(region: MiniMaxRegion): string
export function displayNameForRegion(region: MiniMaxRegion): string
export function toPiModel(spec: MiniMaxModelSpec, baseUrl: string, route?: string): Model  // route 默认 ROUTE
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
export function createMiniMaxProvider(
  auth: MiniMaxAuth,
  models: readonly MiniMaxModelSpec[],
  options?: { baseUrl?: string, route?: string },
): Provider
export class MiniMaxAdapter extends PiAiAdapter { constructor(options: PiAiAdapterOptions, auth: MiniMaxAuth) }
```

## 5. 宿主接线

- `export const name = 'dsh-connect-minmax'`；`export const inject = ['llm']`。
- `apply(ctx, config)`：对 `regions` 里的每个区域**各做一遍**下面 1–3 步：
  1. 路由预检：`ctx.llm.listProviders()` 已有该路由名（`minimax` / `minimax-global`）→ 记 warn 并跳过（不 throw）；
  2. 构造该区域的 `MiniMaxAuth`、模型表、Provider、`ResolvedPiAiProviderProfile`
     （`provider: route`、`displayName: displayNameForRegion(region)`、`streamIdleTimeoutMs`、`retryPolicy`、
     `configuredMaxTokens: new Map()`、`modelErrors: new Map()`、图片预算、`piProvider`）；
  3. `ctx.llm.registerAdapter([route], adapter)`（fiber 释放自动注销）；
  4. 全部区域处理完后 `ctx.inject(['webServer'], …)` 注册一条状态路由，文档里带 `routes[]`
     （可选服务，不能 apply 期 `ctx.get()` 采样）。
- 两区域为何是两条路由：国内与国际是两套凭据（`~/.minimax/auth/prod/{cn,en}`），
  一个 token 只在它自己的区域有效；合成一条路由没法表达"国内已登录、国际没登录"。
- `Config`（schemastery）：`models`（可空 = 全部）、`regions`（默认 `["cn","global"]`）、
  `streamIdleTimeoutMs`、`baseUrl`（国内版覆盖）、`globalBaseUrl`（国际版覆盖）、`longContext`。
- 包名 `@dmh2002/dsh-connect-minmax`，但**插件行 id 与状态路由仍是裸名**
  `dsh-connect-minmax`（改名会让已装用户的配置、设置命名空间、状态路由一起失效）。
- 不注册 `registerConfigurableProviders`（`minimax` 在 pi-ai 目录里已被登记，避免 `DUPLICATE_DIRECTORY`）。
- 不写 profile 的默认模型（用户自己在 Models 页选）。

## 6. 设置卡片（client）

- 槽位：`plugins.bundle.config` / `plugins.row.config`；key 同时注册 scoped 与裸包名两种拼法
  （宿主可能按 `@dmh2002/dsh-connect-minmax`、`dsh-connect-minmax`、`include:…` 或 `<包名>#<行 id>` 查）。
- 形态（0.5.0，对齐同族）：顶部两个**区域 tab**（每个是独立供应商，绿点=可用性、复选框=是否注册），
  下面**账号 / 模型 / 诊断**三个子页。参考图存在 `docs/reference/qoder-*.webp`。
- 展示：聚合登录徽标（任一路由「已登录」即为 ready）、账号与模型各成行、未就绪区域各一句"去哪儿登录"、
  积分余额与批次到期、七天一签、最近一次错误。
- 数据：宿主 `webServer` 路由 `/plugins/dsh-connect-minmax/status` 返回 JSON；
  客户端 10s 轮询（页面可见时）。
- 写入：只写 `models` / `regions` / `longContext` 三个既有配置字段，经 `configForms` 软探测拿到的
  `settingsScope` 落盘，并**回读校验**（`set()` 返回 `false` 是"被拒"不是"抛错"）。
  `configForms` **不进 `inject`**：Cordis 的依赖门禁是硬的，写进去会让"宿主不提供该服务"变成
  "整个客户端插件一次都不跑"。
- 文案：`ctx.locale.register` 中文/英文；插件管理器用 `locale/*.json`。中英键 1:1 由
  `Record<MiniMaxSettingsKey, string>` 在编译期强制。

## 7. 验收标准

1. `pnpm typecheck && pnpm test && pnpm build` 全绿。
2. 安装到 desktop profile 后：Models 页出现分组「MiniMax（本机登录）」，含 M3 / M3.1-Flash / M2.7 / M2.7-highspeed。
3. 选 `MiniMax-M3.1-Flash` 真跑一轮：流式文本、思考块、工具调用（bash/read 等）均正常。
4. 设置卡片显示登录态与来源；关掉 MiniMax Code 后卡片提示「本地文件兜底 / 需登录」。
5. 无任何 API Key 输入项；插件不写 `~/.minimax` 下任何文件。

## 8. 非目标与已撤销的判断

仍然不做：

- 官方 API Key / 平台账号（api.minimaxi.com）路线——本插件只做"复用本机登录态"这一件事。
- 图片生成 / 视频输入（DSH 只有 `text` / `image` 两种模态，视频无法表达）。
- 自己发起 OAuth 设备码登录（协议已摸清，见 §9 与 upstream.md，留作后续「登录恢复」按钮）。

**曾经判断错、已被实测撤销的**（0.5.0）：

- ~~"额度/积分查询需要 md5 签名，优先级低，v1 不做"~~ → **不需要签名**。三条账户接口只带
  `Authorization: Bearer <mmoat_…>` 即可，实测通过，见 upstream.md §6.3。
- ~~"MiniMax Code 没有签到机制"~~ → 有，七天一轮，`/minimax-cloud/api/v1/signin/*`。

这两条记在这里是因为它们**曾经以"上游没有这个能力"的形式写进设计文档**，而真实原因是
当时没测。以后要否掉一个功能，必须给出"测过、返回什么"，不能只给推断。

## 9. 多账号：账号副本（0.4.0）

MiniMax Code 的凭据存储按**机器**分键，不按账号：

```ts
// mcode: node_modules/@mavis/oauth-core/dist/namespace.js
account = sha256(`${authHome}\0${clientId}`)          // base64url
service = `com.minimax.mcode.oauth.${buildEnv}.${region}`
credentialKey = { service, account }                    // auth.json 的 records 键
```

`authHome` 与 `clientId` 都是常量，所以**同一区域换账号是覆盖同一条记录**：
mcode 每区域只能留一个账号（国内 + 国际各一个）。

### 刷新语义（实测）

- access token 有效期 `expires_in=3600`（1 小时），且是不透明字符串（不是 JWT，没有 `sub`）。
- 续期是标准 OAuth：`POST https://account.minimax.cn|io/oauth2/token`，
  `grant_type=refresh_token&refresh_token=…&client_id=mcode-public&scope=agent.default&audience=agent-backend`。
  **没有设备签名、没有 client secret**，所以插件可以自己续期。
- **refresh token 一次性轮换**：刷新会换发新 RT，旧 RT 立即失效
  （实测第二次使用同一个 RT → `400 invalid_grant: this refresh token can no longer be used`）。
- mcode 登出会 `POST /oauth2/revoke` 吊销 RT → 该账号所有副本一起失效。

### 由此得到的所有权规则

| 情形 | 处理 |
| --- | --- |
| 副本对应账号 = mcode **当前**登录账号 | 只镜像，`owned=false`，**绝不刷新**（否则 mcode 下一轮续期 invalid_grant） |
| 同一区域换了账号（旧副本不再被 mcode 持有） | 旧副本 `owned=true`，插件自持刷新链，注册成独立路由 |
| 副本刷新拿到 invalid_grant | 标记 `dead`，提示用户在 mcode 里重新登录该账号以重新镜像 |

实现对应 `src/accounts.ts`（镜像与所有权状态机）与 `src/account-source.ts`
（副本 token 来源 + 同账号刷新串行化）。

### 已知限制

- 副本是"那一刻"的 RT：若 mcode 在换账号前又刷新过一次，镜像到的 RT 已作废 → 领取时 400，
  需要重新登录该账号再镜像一次。
- 副本的账号身份只由 `loginEpoch`（每次登录的 UUID）标识，服务端 token 里没有账号 id，
  所以展示名只能叫「副本 1/2」。


## 10. 认证租约的区域归属（0.5.0，严重）

`~/.minimax/run/mcode-auth-lease-v1.sock` 这个 broker **没有区域参数**：`lease` 只接受
`minValidityMs`，返回的是"当前活跃账号"的令牌。本机同时登录国内版与国际版时（本插件默认
就是两条路由），`token()` 若无条件优先采用租约，国内版路由就会拿到国际版的令牌，实测：

```
disk  (cn, generation 15) → gateway 200 · account 200
lease (broker, generation 11 = en 的) → gateway 401 · account 401
```

即整条国内版通路挂掉，不是"积分读不到"这种附加信息缺失。

判别字段只有 `generation`：mcode 按账号单调递增它，broker 的 `generation` 与本区域
`auth.json` record 的 `generation` 相等，才说明两边说的是同一个账号。

规则：

| 情形 | 处理 |
| --- | --- |
| 租约 `generation` == 本区域盘上 `generation` | 采用租约（mcode 负责刷新，零副作用） |
| 不等 | 跳过租约，改用本区域盘上凭据，并把原因写进 `lastFailure`（措辞是"另一个区域"，不是"租约坏了"） |
| 盘上没有可比对的 `generation` | 保持旧行为采用租约：那种情况下本区域也没有别的凭据，拒绝只会把"可能能用"变成"一定不能用" |

**为什么不能反过来"总是用盘上凭据"**：mcode 续期后先更新内存里的 broker，文件可能滞后；
只读文件会在 broker 刚续完的那一刻用一个已过期的令牌。两边都要用，用 `generation` 决定用哪个。

回归测试在 `tests/auth.spec.ts`（4 条，已验证：去掉修复即红）。假 broker 与盘上 fixture 的
`generation` 默认值都是 2，所以**跨区场景在加这 4 条之前完全没有覆盖**——这也是这个 bug
能活到 0.5.0 的原因。


## 11. 默认思考档位为什么是 provider 级（0.5.0）

目录里曾经给每个模型声明 `defaultEffort: 'medium'`，看上去像"每模型一个默认档"。
**它从来没被读过**：把 `MiniMax-M3` 的该字段改成 `xhigh` 后重新构建，
`resolveModel('minimax','MiniMax-M3').reasoning.defaultEffort` 仍然是 `medium`。

真实来源是 `llm-pi-ai` 的 `options.reasoningEffort ?? profile.reasoning` —— 后者是
**provider 级的单个值**。而 pi-ai 的模型级描述（`PiAiModelProfile`）只有
`reasoningEfforts?: false | Partial<Record<ModelThinkingLevel, string | null>>`，
即"这个模型**可以选**哪些档"，没有"这个模型**默认**哪档"。

所以：

- 删掉 `MiniMaxModelSpec.defaultEffort`（声明 5 次、读取 0 次的死字段，比没有更糟：
  它会让后来人以为改它能生效）。
- 把默认档位提成真实配置 `reasoningEffort`（provider 级），卡片上是一个下拉框。
- 可选值**不含 `off`**：`MiniMax-M3.1-Flash` 强制思考，默认值设成 `off` 会让宿主
  在选中该模型时直接失败。非法取值退回 `medium` 并 warn。

实测：`{reasoningEffort:'high'}` → `defaultEffort=high`；`{reasoningEffort:'off'}` →
`medium` 并 warn「思考档位 "off" 无效」。

## 12. 账号池与自动换号（0.6.0）

用户的原话是"一个账号积分没有了，自动切换到另外一个账号"。这不是"轮换刷新链"，
而是**请求级的故障转移**——触发点明确（余额没了 / 上游回配额错误），所以不需要
先解决"插件自己登录多账号"就能做。

### 选择策略

`pickPoolAccount(candidates, activeId, nowMs)` 的顺序是有意的：

1. **当前账号可用就继续用它**，不按余额排序。每次按余额排序会让同一会话在多个
   账号之间来回跳，额度、账单、日志都跟着漂。
2. 当前账号不可用（余额 ≤ 0，或处于耗尽态）→ 取第一个可用的。
3. **全都不可用时回落当前账号**，照常发请求。池里一个都用不了时不编造"无可用
   账号"——让上游给出真实原因（可能余额刚到账，也可能是别的问题）。插件不替
   服务端下结论。

`balance === undefined` 视为**可用**：没读到不等于没钱，排掉它只会让用户在一个
本来能用的账号上看到错误的"无可用账号"。

### 两条触发路径

- **主动**：状态路由读到余额就 `reportCredits` 回灌给池。请求前就知道哪个号没钱。
  `balance > 0` 会立刻清除耗尽标记（钱到了不该等 TTL）。
- **被动**：`guardStream` 收到 `QUOTA` 且尚未输出任何 chunk 时 `switchAccount()`。
  与 401 重试共用同一个插槽，语义也一致：**只在没有内容流出时重试**，因为已经
  发给用户的内容撤不回来。只换一次，避免多账号互相失败时空转。

### 换号能力靠能力探测而不是构造参数

`switchAccountOf(source)` 检测来源上有没有 `switchAway`。凭据来源本来就是按接口
注入的，多一个能力不该逼所有调用点改签名；单账号来源拿到 `undefined`，
`guardStream` 那条重试就永远不会执行——老行为逐字不变。

### 两条踩过的坑

1. **恢复"上次选中的账号"的时机**。建池那一刻池里只有本机登录，`select(remembered)`
   会因 id 不存在被拒；而"每次重算账号列表都恢复"又会跟运行时自动换号打架——
   自动切换不写存储，下一次重算就把刚切过去的号拨回去。所以：**首次把副本装进
   池之后恢复一次**（`restoredRegions`）。
2. **`writeAccounts` 必须携带 `activeByRegion`**。换一次账号就 `writeAccounts` 一次，
   不带的话用户手动做的切换会被顺手清掉——这是一条真实会丢选择的路径，有测试钉住。

### 尚未做

插件自己发起登录（卡片「添加账号」→ 设备码）。设备码流程已实测可行
（`/oauth2/device/code` 返回 `user_code` + `verification_uri`，PKCE S256 必填），
但它是独立的一块：要处理授权轮询、与 mcode 的 `authorizing` 租约互斥、以及新账号
落进自有存储的原子写。本轮没做，README 里如实写了"进池路径仍是先在 mcode 登录"。
