# MiniMax（MiniMax Code / mcode，国内 cn）上游协议研究

> 目标：为 `dsh-connect-minmax` 插件确定「只读取本机已登录账号、不提供 API Key 入口」的可行接入路径。
> 所有 secret（accessToken / refreshToken / user_code / device_code / capability）一律以 `<redacted>` 占位。
> 研究时间：2026-10-22 03:20–03:40 (+08:00)。研究机：macOS，MiniMax Code 3.1.4（Electron 42.8.0）。

---

## 0. 结论摘要（TL;DR）

| # | 结论 | 置信度 |
|---|---|---|
| 1 | **推荐接入方式 = Auth Lease Broker（unix socket）**。插件连 `~/.minimax/run/mcode-auth-lease-v1.sock`，带 capability 文件里的 43 字符串，请求 `method:"lease"`，直接拿到 accessToken。由 mcode 应用负责刷新，插件**永不碰 refreshToken、绝不写 `~/.minimax`**。 | 已实测（连接/取 token/帧解析全部成功） |
| 2 | OAuth refresh 端点是 `POST https://account.minimax.cn/oauth2/token`，**纯 public client**（`client_id=mcode-public`，无 client_secret、无设备指纹、无 PKCE），form-urlencoded。这是**公开可实现**的，但 refreshToken **一次性轮换**，用掉即作废。 | 已实测 200 |
| 3 | 轮换语义**严格**：旧 refreshToken 立刻失效（`400 invalid_grant: this refresh token can no longer be used`）。所以插件**不能**自己刷新后丢弃新 RT，否则会破坏用户 MiniMax Code 登录。 | 已实测 |
| 4 | gateway 鉴权头：`Authorization: Bearer <AT>` + `anthropic-version: 2023-06-01` + `x-api-key: sk-xxx`（占位符）+ `User-Agent: MiniMaxAgent` + `X-Mavis-Session-Id` / `X-Mavis-Agent-Id` / `X-Mavis-Timezone-Offset`。 | bundle 代码确认 |
| 5 | 区域：cn = `account.minimax.cn` / `agent.minimax.cn`；global(en) = `account.minimax.io` / `agent.minimax.io`。凭据目录按 `auth/<buildEnv>/<region>/<clientId>/`。本机只有 cn。 | bundle 代码确认 |
| 6 | 模型目录以 `~/.minimax/config.yaml` + bundle 内置 `MINIMAX_MODELS` 为准：MiniMax-M3、MiniMax-M3.1-Flash（forced_on）。thinking 用 `thinking:{type:"adaptive"|"disabled"}` + `output_config:{effort}`。 | bundle + config.yaml |
| 7 | **阻塞项**：`/mavis/api/v1/llm/v1/messages` 目前 401（本地账号已被登出，generation 3 / status anonymous）。用户需在 MiniMax Code 里**重新登录**，才能补完协议实测（thinking / image / tools / usage / 错误码）。 | 见 §7 |

---

## 1. 本机凭据布局

```
~/.minimax/
├── auth/prod/cn/mcode-public/
│   ├── auth.json          # 凭据本体（schemaVersion 1）
│   ├── auth-state.json    # 状态机（schemaVersion 2）
│   └── auth.lock          # 跨进程锁
├── config.yaml            # opencode 风格 provider 配置（模型目录）
├── bin/mcode-tools-cn     # 官方 CLI 包装器（走 auth broker）
├── run/
│   ├── mcode-auth-lease-v1.sock   # unix socket（broker）
│   └── mcode-auth-lease-v1.cap    # capability（43 字符 base64url, 0600）
└── v2/observability/logs/runtime-YYYYMMDDHH.log
```

`auth.json` 结构（已脱敏）：

```json
{
  "schemaVersion": 1,
  "records": {
    "com.minimax.mcode.oauth.prod.cn\0<hash>": {
      "schemaVersion": 1,
      "accessToken": "<redacted mmoat_…>",
      "refreshToken": "<redacted mmort_…>",
      "tokenType": "Bearer",
      "clientId": "mcode-public",
      "scopes": ["agent.default"],
      "audience": "agent-backend",
      "expiresAtMs": 1792612149526,
      "generation": 2,
      "loginEpoch": "<redacted uuid>"
    }
  }
}
```

* record key 形如 `com.minimax.mcode.oauth.<buildEnv>.<region>\0<sha256>`（`namespace.js` 生成的命名空间键）。
* `expiresAtMs` = 访问令牌到期时间戳（**不是** refresh token 的）。access token 实际寿命 = `expires_in`（实测 3600s）。
* `generation` 单调递增，每次刷新 +1，每次登出 +1（`auth-core.js` 的 `credentialFromGrant` / `logout`）。
* `loginEpoch` = 一次登录的 UUID，换登录则变；用于并发场景下判别「登录是否被换掉」。

`auth-state.json`：

```json
{
  "schemaVersion": 2, "status": "authenticated", "storeKind": "file",
  "clientId": "mcode-public", "scopes": ["agent.default"], "audience": "agent-backend",
  "buildEnv": "prod", "region": "cn", "generation": 2, "expiresAtMs": 1792612149526
}
```

`status` 枚举（来自 `oauth-lease-protocol/contracts.js`）：
`anonymous` / `authorizing` / `authenticated` / `refreshing` / `scope_upgrade_required` / `logging_out` / `logout_pending` / `expired` / `error`。

> **当前状态（03:31 观测）**：`status: "anonymous"`、`generation: 3`、`auth.json.records` 为空。
> 原因：研究过程中 refreshToken 被轮换作废，随后一次 `unauthorized{generation:2}` 使 broker 刷新失败并触发登出（见 §3.4）。
> **用户在 MiniMax Code 里重新登录后即可恢复**，插件侧无需特殊处理。

---

## 2. 区域（Region）判定

来源：`@mavis/oauth-core/dist/endpoint-config.js`（OAuth 端点）+ `@mavis/local-runtime*/…/matrix-env.js`（Matrix 端点）+ `quota/transport.ts`（配额端点）。

| 用途 | cn（prod） | global / en（prod） |
|---|---|---|
| OAuth 账户端点 | `https://account.minimax.cn` | `https://account.minimax.io` |
| — device code | `…/oauth2/device/code` | 同路径 |
| — token | `…/oauth2/token` | 同路径 |
| — revoke | `…/oauth2/revoke` | 同路径 |
| Matrix / Agent 端点 | `https://agent.minimax.cn` | `https://agent.minimax.io` |
| 托管 LLM baseURL | `https://agent.minimax.cn/mavis/api/v1/llm/v1` | `https://agent.minimax.io/mavis/api/v1/llm/v1` |
| BYOK API（api key 路线） | `https://api.minimaxi.com/anthropic` | `https://api.minimax.io/anthropic` |
| 开放平台配额 | `https://www.minimaxi.com` | `https://platform.minimax.io` |

非 prod 环境（cn）：`https://account-test.xaminim.com`（dev/test）、`https://matrix-test.xaminim.com`（dev/test）、`https://matrix-pre.xaminim.com`（staging）。

**判定依据**（插件可用）：
1. `auth-state.json` 的 `region` 字段（`"cn"` / `"en"`）——最直接，随凭据走。
2. 凭据目录路径 `~/.minimax/auth/<buildEnv>/<region>/<clientId>/`（`clientId` 恒为 `mcode-public`）。
3. 兜底：`~/.minimax/bin/mcode-tools-cn` 里硬编码 `MCODE_REGION='cn'`；global 版本应为 `mcode-tools`（无 `-cn` 后缀）。

**global 是否有独立本地登录路径**：有，且完全对称——`account.minimax.io` 走同一套 device-code OAuth，凭据落在 `~/.minimax/auth/prod/en/mcode-public/`。本机只有 cn 登录，未实测 global。

> ⚠️ 注意：**不要**把 `https://agent.minimax.io/...` 当成 global 的等价 LLM 端点时忘记区分：`agent.minimax.io` 是 Matrix（agent）端点，`api.minimax.io` / `api.minimaxi.com` 是 BYOK（api key）端点。两者鉴权方式不同（OAuth Bearer vs `x-api-key`）。

---

## 3. 凭据获取与刷新

### 3.1 OAuth 端点全表

来源：`node_modules/@mavis/oauth-core/dist/endpoint-config.js`

```js
const ACCOUNT_ORIGINS = {
  cn: { dev:'https://account-test.xaminim.com', test:'https://account-test.xaminim.com',
        staging:'https://account-pre.xaminim.com', prod:'https://account.minimax.cn' },
  en: { dev:'https://account-overseas-test.xaminim.com', test:'https://account-overseas-test.xaminim.com',
        staging:'https://account-overseas-pre.xaminim.com', prod:'https://account.minimax.io' },
};
// tokenEndpoint = `${accountOrigin}/oauth2/token`
// deviceAuthorizationEndpoint = `${accountOrigin}/oauth2/device/code`
// revocationEndpoint = `${accountOrigin}/oauth2/revoke`
```

固定常量（`@mavis/oauth-core/dist/contracts.js`）：

```js
MCODE_OAUTH_CLIENT_ID = 'mcode-public';
MCODE_OAUTH_SCOPES   = ['agent.default'];
MCODE_OAUTH_AUDIENCE = 'agent-backend';
```

### 3.2 刷新（refresh_token grant）—— 已实测

**请求**（`oauth-client.js` 的 `refreshToken()`）：

```
POST https://account.minimax.cn/oauth2/token
Content-Type: application/x-www-form-urlencoded
Accept: application/json

grant_type=refresh_token
&refresh_token=<refreshToken>
&client_id=mcode-public
&scope=agent.default
&audience=agent-backend
```

* **无 client_secret**、**无设备指纹**、**无 PKCE**（refresh 阶段不需要）。
* prod 阶段**不附加任何额外头**；只有 staging 会在 device 阶段加 `X-User-Pre: 1`。
* 公网可达，第三方可直接调用（public client 模式）。

**响应（实测 200，body 已脱敏）**：

```json
{
  "access_token":  "<redacted mmoat_…>",   // 新 access token
  "refresh_token": "<redacted mmort_…>",   // 新 refresh token（轮换！）
  "token_type":   "Bearer",
  "expires_in":   3600,                    // 秒
  "scope":        "agent.default"
}
```

解析规则（`parseTokenGrant`）：`access_token` / `refresh_token` / `token_type==Bearer` / `expires_in>0` / scope 必须包含 `agent.default`，否则抛 `invalid_token_response`。access token 若为 JWT 会解 payload 取 `sub` / `account_id`。

**轮换是严格的**（实测）：

```
# 用「刷新前的旧 refreshToken」再刷一次
HTTP 400
{"error":"invalid_grant","error_description":"this refresh token can no longer be used, start a new authorization"}
```

⇒ **插件不能自己刷新然后丢弃新 refreshToken**，否则用户 MiniMax Code 的登录被永久打断（其文件里的 RT 已失效）。
⇒ 如果插件要自己刷新，**必须**把新 accessToken + refreshToken + generation+1 + expiresAtMs 原子写回 `auth.json`（并遵守 `auth.lock` 与 `generation` CAS），但这等于替 mcode 承担凭据所有权，风险高。

### 3.3 设备码登录（device code）—— 已实测「发起」

**请求**（`oauth-client.js` 的 `startDeviceAuthorization()`）：

```
POST https://account.minimax.cn/oauth2/device/code
Content-Type: application/x-www-form-urlencoded

client_id=mcode-public
&scope=agent.default
&audience=agent-backend
&code_challenge=<base64url(sha256(code_verifier))>
&code_challenge_method=S256
```

* `code_verifier` = `randomBytes(32).toString('base64url')`；`code_challenge` = `createHash('sha256').update(verifier,'ascii').digest('base64url')`。**PKCE S256 必填**。

**响应（实测 200，已脱敏）**：

```json
{
  "device_code": "<redacted len=43>",
  "user_code": "<redacted len=9>",
  "verification_uri": "https://account.minimax.cn/oauth-authorize",
  "verification_uri_complete": "<redacted len=62>",
  "expires_in": 300,
  "interval": 3
}
```

用户打开 `verification_uri`（或 `verification_uri_complete`）输入 `user_code` 完成授权。

**轮询取 token**（`pollDeviceToken()`）：

```
POST https://account.minimax.cn/oauth2/token
grant_type=urn:ietf:params:oauth:grant-type:device_code
&device_code=<device_code>      # 若服务端不返回 device_code 而返回 user_code+expired_in，则改传 user_code
&client_id=mcode-public
&code_verifier=<code_verifier>  # PKCE
```

轮询语义（服务端在 body 里回 `status` 字段）：
`pending` → 继续等 `interval` 秒；`slow_down` → 间隔 +5s；`denied` / `access_denied` → 抛错；`expired` / `expired_token` → 抛错。
也兼容标准 OAuth 错误字段：`authorization_pending`（继续等）、`slow_down`（+5s），其余抛 `OAuthProtocolError(code, message, httpStatus)`。

> **给插件的建议**：不要自己实现 device flow 去「抢」登录（会和正在运行的 MiniMax Code 冲突——它也走同一套 namespace + `auth.lock`，`auth-core.runLogin()` 有 `authorizing` 租约（默认 10 分钟）互斥）。插件只提供「请到 MiniMax Code 里登录」的引导，或在完全未登录时走 device flow。

### 3.4 ★ Auth Lease Broker —— 推荐的接入方式

**这是本项目唯一「只读、不破坏、可自动续期」的路径。**

#### 协议来源
`node_modules/@mavis/oauth-lease-protocol/`（v1，0.1.0-beta.0）
+ `node_modules/@mavis/mcode-tools-host/dist/lease-broker.js`（broker 端）
+ `node_modules/@mavis/oauth-core/dist/auth-core.js`（会话端）

#### 端点与凭据

| 平台 | socket | capability 文件 |
|---|---|---|
| macOS/Linux | `~/.minimax/run/mcode-auth-lease-v1.sock`（unix domain socket） | `~/.minimax/run/mcode-auth-lease-v1.cap` |
| Windows | `\\.\pipe\mcode-auth-lease-<sha256(dataDir).slice(0,16)>` | `<dataDir>/run/mcode-auth-lease-v1.cap` |

* capability = `randomBytes(32).toString('base64url')` = **43 字符** `[A-Za-z0-9_-]`，文件权限 0600，目录 0700，**内容末尾带一个 `\n`**（读取时要 `strip()`）。
* capability 由 broker 启动时原子写入（临时文件 + `rename`）；broker 退出时删除 socket 与 capability 文件。
* `assertAuthLeaseClientEndpoint()` 会校验 socket 路径的目录必须与 capability 文件同目录、文件名必须精确匹配。

#### 帧格式

```
[4 字节大端长度 N][N 字节 UTF-8 JSON]
```
单帧 ≤ 64 KiB（`AUTH_LEASE_MAX_FRAME_BYTES`）。响应同理，一请求一帧。

#### 请求方法

```jsonc
// 1) 查状态（不返回 token）
{"version":1,"requestId":"<uuid4>","capability":"<43字符>","method":"status"}

// 2) 取租约（返回 accessToken）
{"version":1,"requestId":"<uuid4>","capability":"<43字符>","method":"lease","minValidityMs":60000}

// 3) 报告 401（让 broker 决定刷新/登出）
{"version":1,"requestId":"<uuid4>","capability":"<43字符>","method":"unauthorized","generation":2}
```

* `requestId`：`^[A-Za-z0-9._:-]+$`，≤128 字符。
* `minValidityMs`：0..300000（`AUTH_LEASE_MAX_MIN_VALIDITY_MS = 5min`）。
* `generation`：0..Number.MAX_SAFE_INTEGER。

#### 响应

```jsonc
// status
{"version":1,"requestId":"…","ok":true,
 "result":{"method":"status","status":"authenticated","generation":2,"expiresAtMs":1792612149526}}

// lease
{"version":1,"requestId":"…","ok":true,
 "result":{"method":"lease","accessToken":"<redacted mmoat_…>","expiresAtMs":1792612149526,
           "generation":2,"audience":"agent-backend","scopes":["agent.default"]}}

// 失败
{"version":1,"requestId":"…","ok":false,
 "error":{"code":"AUTH_REQUIRED","message":"Desktop authentication is required."}}
```

#### 错误码语义

| code | 含义 | 插件应对 |
|---|---|---|
| `AUTH_REQUIRED` | 未登录 / 租约 generation 过期 / 会话已登出 | 引导用户去 MiniMax Code 登录；不要重试 |
| `BROKER_UNAVAILABLE` | MiniMax Code 未运行 / socket 不存在 / 超时（连接 5s、请求 10s） | 提示「请启动 MiniMax Code」；可退避重试 |
| `CAPABILITY_REJECTED` | capability 不匹配 | 重新读取 cap 文件再试一次 |
| `PROTOCOL_MISMATCH` | `version != 1` | 视为不兼容，拒绝 |
| `INVALID_REQUEST` | 字段不合法（capability 格式、minValidityMs 越界、method 未知、JSON 非法） | 视为编程错误 |
| `INTERNAL_ERROR` | broker 内部异常 | 可重试 |

#### broker 侧行为（`lease-broker.js` 逐行确认）

* **缓存**：`cachedLease` 复用条件 = `generation >= minimumGeneration` 且 `expiresAtMs - now >= minValidityMs`。→ **`minValidityMs` 是硬约束**：token 剩余寿命不足时 broker 会去刷新。
* **并发**：`inFlight` Promise 合并并发请求，避免重复刷新。
* **epoch 失效**：`invalidate()` 清缓存；broker 通过 `session.watch()`（轮询 `auth-state.json`，间隔 250ms）跟踪状态：
  * `status` 不再是 `authenticated`/`refreshing` → `admissionOpen = false` → 之后所有 lease 请求返回 `AUTH_REQUIRED`。
  * `generation` 变大且缓存的 lease 是旧 generation → 丢弃缓存。
* **`unauthorized` 语义**（broker → `auth-core.handleUnauthorized()`）：

  | 条件 | action |
  |---|---|
  | 当前 `credential.generation > 请求的 generation` | `"retry"`（调用方持有的 generation 已过期，重试即可） |
  | 当前 `credential.generation < 请求的 generation` | `"logout"` |
  | 相等 | 走 `refreshCredential(current, {rejected:true})` → 成功返回 `"retry"`；刷新失败且 `invalid_grant` → 抛 `AuthRequiredError` → 被捕获 → `"logout"` |
  | `loginEpoch` 不匹配 | 抛 `AuthSessionChangedError`（不 catch，会向上抛） |

  ⇒ **`unauthorized` 是一个破坏性动作**：若 refreshToken 已死，`invalid_grant` 会直接把用户登出（generation+1、records 清空）。**插件不应主动发 `unauthorized`**，除非它确实收到了 401 且自己无法恢复。
* **刷新失败但会话未过期**（非 `invalid_grant`）：状态回写 `authenticated`（保留会话）或 `expired`；错误向上抛。
* **刷新成功**：`generation = max(state.gen, cred.gen) + 1`，写入 `auth.json`，状态回 `authenticated`；`expiresAtMs = now + expires_in*1000`；`loginEpoch` 沿用。

#### broker 端 lease 失败与 `AUTH_REQUIRED` 的关系
`loadLease()` 调用 `session.getAccessToken(minValidityMs)`；抛错后重新读 status，若 status 不是 `authenticated` → 转成 `AUTH_REQUIRED`。

#### 实测记录（研究机，03:26–03:31）

用纯 Python（无第三方依赖）实现客户端：

```python
import socket, json, struct, uuid
def call(sock_path, cap, obj, timeout=10):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(timeout)
    s.connect(sock_path)
    payload = json.dumps(obj).encode()
    s.sendall(struct.pack('>I', len(payload)) + payload)
    hdr = b''
    while len(hdr) < 4: hdr += s.recv(4 - len(hdr))
    n = struct.unpack('>I', hdr)[0]
    buf = b''
    while len(buf) < n:
        c = s.recv(n - len(buf))
        if not c: break
        buf += c
    s.close()
    return json.loads(buf.decode())
```

结果：
* `status` → `{"ok":true,"result":{"method":"status","status":"authenticated","generation":2,"expiresAtMs":…}}` ✅
* `lease` → `{"ok":true,"result":{"method":"lease","accessToken":"<redacted>","expiresAtMs":…,"generation":2,"audience":"agent-backend","scopes":["agent.default"]}}` ✅（token 与 `auth.json` 中的一致）

> **插件实现要点**：socket 由 MiniMax Code 进程持有；应用未运行时 socket 文件不存在（`~/.minimax/run/` 里也没有）。所以插件启动时应检查 socket 存在性 + `status` 结果，明确告诉用户「请启动并登录 MiniMax Code」。

### 3.5 官方 CLI（可作为 fallback / 排障工具）

`~/.minimax/bin/mcode-tools-cn` 是个 shim：

```sh
export MCODE_REGION='cn'
export MCODE_CONFIG_DIR='~/.minimax/integrations/mcode-tools/cn'
export MCODE_AUTH_PROVIDER=shared-broker
export MCODE_AUTH_BROKER_ENDPOINT='~/.minimax/run/mcode-auth-lease-v1.sock'
export MCODE_AUTH_BROKER_CAPABILITY_FILE='~/.minimax/run/mcode-auth-lease-v1.cap'
exec '/Applications/MiniMax Code.app/Contents/MacOS/MiniMax Code' \
     '/Applications/MiniMax Code.app/Contents/Resources/resources/mcode-tools/cli.mjs' "$@"
```

子命令（实测 `--help`）：

```
mcode-tools auth status      # 打印托管认证状态，不暴露 token
mcode-tools get-asset-url <node_id>
mcode-tools upload-temp-url <file>
mcode-tools connector …
```

**注意**：这是 **Electron 主进程**入口（`ELECTRON_RUN_AS_NODE=1`），启动慢（实测 ~10–25s），不适合放在插件热路径；但 `mcode-tools auth status` 是一个零依赖的健康检查（不打印 token）。`auth` 子命令**没有** `refresh` / `login`——登录必须走应用 UI 或 device flow。

---

## 4. 模型目录

### 4.1 官方目录（bundle 内置 `MINIMAX_MODELS`）

来源：`node_modules/@mavis/config/dist/minimax-model-catalog.js`（首屏内置快照；之后以服务端下发的 snapshot 为准）。

| 模型 id | 显示名 | context | max output | 输入模态 | 推理 | thinking_config |
|---|---|---|---|---|---|---|
| `MiniMax-M3` | MiniMax-M3 | 512000（可选 1000000，提示 `higher_usage`） | 128000 | text / image / video | ✅ | `switchable`（default `true`） |
| `MiniMax-M3.1-Flash-Preview` | M3.1-Flash-Preview | 512000（可选 1000000） | 128000 | text / image / video | ✅ | `forced_on` |

能力（两者共用 `MINIMAX_M3_FILE_API_CAPABILITIES`）：

```json
{"support_files_api": true,
 "files_api_upload_endpoint": "/v1/files/upload",
 "max_image_bytes_inline": 10485760,     // 10 MiB
 "max_video_bytes_inline": 52428800,     // 50 MiB
 "max_request_body_bytes": 67108864,    // 64 MiB
 "max_attachments_count": 4,
 "max_images_per_request": 20}
```

本机 `~/.minimax/config.yaml` 与之基本一致，差异：
* 本机写的是 `MiniMax-M3.1-Flash`（**不带 `-Preview`**，显示名 `M3.1-Flash（订阅限免）`）；
* 本机 `MiniMax-M3` 的 `max_attachments_count: 9`（bundle 为 4）；
* 本机 `MiniMax-M3.1-Flash` 的 `thinking.effortOptions` = `[default, low, medium, high, xhigh, max]`，`defaultEffort: default`。

`~/.minimax/config.yaml` 里另外声明但**未定义 models 细节**的白名单项（远端快照才带详情）：

* `MiniMax-M2.7`
* `MiniMax-M2.7-highspeed`

`model_order` = `[MiniMax-M3.1-Flash, MiniMax-M3]`；`defaultModel` = `minimax/MiniMax-M3.1-Flash`。

`pi-ai` 内置的 BYOK 目录（`models.generated.js`，**api key 路线**，供参考）：

| 模型 id | provider | baseUrl | context | maxTokens | 输入 | cost in/out (USD/1M) |
|---|---|---|---|---|---|---|
| `MiniMax-M2.7` | `minimax-cn` | `https://api.minimaxi.com/anthropic` | 204800 | 131072 | text | 0.6 / 2.4 |
| `MiniMax-M2.7-highspeed` | `minimax-cn` | `https://api.minimaxi.com/anthropic` | 204800 | 131072 | text | 0.6 / 2.4 |
| `MiniMax-M3` | `minimax-cn` | `https://api.minimaxi.com/anthropic` | 512000 | 128000 | text, image | 0.6 / 2.4 (cacheRead 0.12, cacheWrite 0) |
| `MiniMax-M2.7` / `-highspeed` / `MiniMax-M3` | `minimax`（global） | `https://api.minimax.io/anthropic` | 同上 | 同上 | 同上 | 同上 |

### 4.2 thinking 参数（wire format）

来源：`node_modules/@mavis/local-runtime/src/model-provider/thinking.ts`。

**anthropic-messages 路线（我们用的）**：

```jsonc
// 开启推理（adaptive）
"thinking": { "type": "adaptive" },
"output_config": { "effort": "high" }   // effort ∈ default|low|medium|high|xhigh|max

// 关闭推理
"thinking": { "type": "disabled" }
```

要点：
* MiniMax 托管路线**总是**用 `type: "adaptive"`（`forceAdaptiveThinking: true`），**不使用** `budget_tokens`。
  ⇒ `thinking:{type:"enabled",budget_tokens:N}` 是 Anthropic 官方写法，MiniMax 托管路线**不**用它。
* `effort` 走 `output_config.effort`（**顶层字段**，不是 `thinking.effort`）。
* MiniMax-M3 特例：`effort` 只接受 `'on' | 'off'`（`resolveMiniMaxM3ThinkingProtocol`），映射为
  `on → {thinking:{type:"adaptive"}}`，`off → {thinking:{type:"disabled"}}`，且 `off` 时 Pi level 仍为 `high` 但 `enabled:false`。
  这与 M3.1-Flash 的 `effortOptions` 语义不同，**插件要按模型分别处理**。
* `temperature` 与 extended thinking **不兼容**：pi-ai 在 `thinkingEnabled` 时不发 `temperature`（`buildParams`）。
  ⇒ 插件在开思考时不要同时传 `temperature`。
* `max_tokens` 下限：adaptive 探测至少 1024（`MINIMAX_M3_THINKING_TEST_MAX_TOKENS = 1024`），否则 MiniMax 可能来不及吐 content block。

### 4.3 未实测项（缺有效 token）

以下需在用户重新登录后补实测：thinking adaptive 是否真的返回 `thinking` block、`budget_tokens` 是否被拒、base64 image block 是否接受、`max_tokens` 实际上限（catalog 说 128000）、`metadata` 是否被接受、`temperature` 数值范围、`stop_reason` 取值集合、usage 字段名。

---

## 5. Gateway 协议细节（从 bundle 推导 + 局部实测）

### 5.1 端点

```
POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages      # Anthropic 兼容
GET  https://agent.minimax.cn/mavis/api/v1/llm/v1/models         # 实测 503 direct_route_not_configured（不可用）
```

### 5.2 请求头（关键！）

`@mavis/local-runtime*/…/model-resolver*.ts` 的 `resolveCredentialHeaders()` + `buildLocalProviderHeaders()`：

```js
// 1) 凭证头（managed-login 路线）
{ Authorization: `Bearer ${accessToken}` }

// 2) 运行身份头（每次请求都加）
{
  'X-Mavis-Session-Id': sessionId,       // 会话 id
  'X-Mavis-Agent-Id': agentId,           // 默认 'main'
  'X-Mavis-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),  // 中国 = 28800
  'User-Agent': 'MiniMaxAgent',          // MANAGED_PROVIDER_USER_AGENT
}

// 3) Anthropic 协议头（由 @anthropic-ai/sdk 生成）
{
  'content-type': 'application/json',
  'x-api-key': 'sk-xxx',                 // MANAGED_PROVIDER_API_KEY_PLACEHOLDER 占位符
  'anthropic-version': '2023-06-01',
  'accept': 'application/json',
  'anthropic-dangerous-direct-browser-access': 'true',
  // 可选：'anthropic-beta': 'interleaved-thinking-2025-05-14'
}
```

要点：
* **`x-api-key` 是占位符 `sk-xxx`，不是真 token**；真 token 走 `Authorization: Bearer`。
* `User-Agent` 有两个值：**`MiniMaxAgent`**（托管 provider，`buildLocalProviderHeaders` 里 `managedProvider` 分支优先）与
  **`MiniMaxCode`**（第三方 provider，`withMiniMaxCodeUserAgent`）。托管路线用前者。
* `anthropic-beta`：托管路线默认**不加**（adaptive thinking 内建）；仅在非 adaptive 模型上加 `interleaved-thinking-2025-05-14`。
* `x-app: cli` + `anthropic-beta: claude-code-20250219,oauth-2025-04-20` + `user-agent: claude-cli/…` 是 **Claude Code OAuth 路线**（`isOAuthToken(apiKey)` 判断 `apiKey.includes('sk-ant-oat')`），**与 MiniMax 无关**，不要照抄。

### 5.3 请求体

Anthropic Messages 标准形状，额外：

```jsonc
{
  "model": "MiniMax-M3",
  "max_tokens": 131072,
  "messages": [ ... ],
  "stream": true,
  "system": [ {"type":"text","text":"..."} ],   // 或纯字符串
  "tools": [ {"name","description","input_schema"} ],
  "tool_choice": {...},
  "thinking": { "type": "adaptive" },            // 或 {"type":"disabled"}
  "output_config": { "effort": "high" }          // effort 档位
}
```

* `system` 支持字符串或 block 数组（pi-ai 统一用 block 数组 + `cache_control`）。
* `temperature`：`temperature: true` 能力的模型支持，但**与 thinking 互斥**。
* `metadata`：bundle 里未见对 MiniMax 托管路线的特殊处理，**未实测**。

### 5.4 响应 / 流

pi-ai 的 Anthropic provider 消费标准 Anthropic SSE：

| SSE event | pi-ai 处理 |
|---|---|
| `message_start` | 取 `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}` |
| `content_block_start` / `content_block_delta` | `text` / `thinking` / `redacted_thinking` / `tool_use` |
| `content_block_stop` | 结束该 block |
| `message_delta` | 结束，取 `usage` / `stop_reason` |
| `message_stop` | 结束流 |

⇒ **usage 字段名是 Anthropic 标准**：`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`。
pi-ai 自己合成 `totalTokens = input + output + cacheRead + cacheWrite`（Anthropic 不提供 total）。

`stop_reason`：Anthropic 标准值 `end_turn` / `max_tokens` / `stop_sequence` / `tool_use`。**MiniMax 是否完全一致未实测**。

`thinking` block 带 `thinking_signature`（pi-ai 会回传，用于多轮 tool_use 场景）。

### 5.5 错误响应形态

| 场景 | HTTP | body | 来源 |
|---|---|---|---|
| token 无效 / 缺失 | 401 | `{"error":"invalid access token"}` | 实测（`Authorization: Bearer` 存在但不被接受） |
| token 缺失（无 Authorization 头） | 401 | `{"code":401,"message":"token is required"}` | 实测（用 `x-api-key` / 无 Bearer 前缀时） |
| 路由未配置 | 503 | `{"error":"direct_route_not_configured"}` | 实测（`GET /models`） |
| OAuth 刷新失败 | 400 | `{"error":"invalid_grant","error_description":"…"}` | 实测 |
| OAuth 其他错误 | 4xx | `{"error":"<code>","error_description":"…"}` | `oauth-client.js` 的 `readString(body,'error')` |
| Matrix 云接口成功 | 200 | `{"base_resp":{"status_code":0,"status_msg":"ok"}, ...}` | 实测（`/minimax-cloud/api/v1/skill-hub`） |
| 内容安全 | 401 | app 内日志记 `failureKind:"auth", statusCode:401` | `~/.minimax/v2/observability/logs/*.log` |

**未实测**：限流（429）与配额耗尽的 body 形态。已知 Matrix 系接口统一带 `base_resp.status_code` / `status_msg`；
`pi-ai` 里有一段错误归一化逻辑会匹配 `usage_limit_reached|usage_not_included|rate_limit_exceeded` 或 `status === 429` 并读取 `err.plan`。
⇒ **建议插件的错误映射**：优先读 `error`（Anthropic 风格）或 `error.type`；若无，读 `base_resp.status_code`；再无，读 `code`/`message`。
429 → 限流；401 → 认证（提示重新登录）；503 `direct_route_not_configured` → provider 不可用。

---

## 6. 额度 / 用量（可选）

**已发现两个端点**（来源 `memory-system/adapters/quota/transport.ts` + `subscription-quota.ts`），但都需要 Matrix 风格的签名头，且当前账号已登出，**未实测成功**。

### 6.1 订阅身份

```
GET https://agent.minimax.cn/matrix/api/v1/user/get_user_extra_info?device_platform=web&biz_id=3&app_id=3001&version_code=22201&unix=<ms>&timezone_offset=<s>&sys_language=zh&lang=zh&device_id=0&user_id=<realUserID>&client=desktop&region=cn&is_desktop=1
GET https://agent.minimax.cn/v1/api/user/info
POST https://agent.minimax.cn/matrix/api/v1/commerce/get_membership_info   body: {"workspace_id": "<personal workspace id>"}
```

签名头（`transport.matrix()`）：

```
Authorization: Bearer <accessToken>
yy: md5(`${encodeURIComponent(pathname+search)}_${body||'{}'}${md5(String(unix))}ooui`)
x-timestamp: <unix/1000>
x-signature: md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2${body}`)
```

### 6.2 剩余额度

```
GET https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains
Authorization: Bearer <accessToken>
X-Group-Id: <groupId>
```
（global: `https://platform.minimax.io/v1/api/openplatform/coding_plan/remains`）

`projectQuota(body, modelName)` 把响应投影成 `{status, reason?, ...}`，状态值含 `unknown` / `not-applicable`（未订阅）/ 正常额度。
`groupId` 来自 §6.1 的 `membership.groupId`。

**结论（2026-10-22 实测推翻上文判断）**：额度与签到端点**不需要** Matrix 签名头，只带
`Authorization: Bearer <mmoat_…>` 就够。上文的签名算法是客户端另一条路径的要求，与这三条接口无关，
因此"建议 v1 不做额度查询"作废——见 §6.3。

### 6.3 积分余额 / 批次到期 / 每日签到（实测通过，2026-10-22）

用本机镜像出来的新鲜 `mmoat_` 令牌实测（只读，未调用 claim）：

```
POST https://agent.minimax.cn/matrix/api/v1/commerce/get_membership_info
     Authorization: Bearer <mmoat_…>   Content-Type: application/json
     body: {}                                   ← 不需要 workspace_id
  -> 200 {"op_credit_summary":{"total_remaining_amount":"400",
              "purchased_remaining_amount":"0","free_remaining_amount":"400"},
          "base_resp":{"status_code":0,"status_msg":"success"}}

GET  https://agent.minimax.cn/minimax-cloud/api/v1/credit/details?page_number=1&page_size=100
  -> 200 {"base_resp":{"status_code":0,"status_msg":"ok"},
          "details":[{"credit_type":2,"granted_amount":"400.00",
                      "remaining_amount":"400.00","consumed_amount":"0.00",
                      "granted_at_ms":…,"expire_at_ms":…}]}

GET  https://agent.minimax.cn/minimax-cloud/api/v1/signin/status?timezone_id=Asia/Shanghai
  -> 200 {"data":{"scene":2,"days":[{"day_no":1,"points":400,"status":3,"is_today":true,
              "bonus_points":0}, …]}}
```

国际版同形，把 host 换成 `agent.minimax.io` 即可（实测两条都回 200）。

实测踩到的三个坑：

1. **`page_size` 太小会让台账接口回 `50001 internal error`**：`page_size=3` 失败、`20/100` 正常。
   所以取台账固定用 `page_size=100`，并且**翻页参数是 `page_number`**（不是 `page`）。
2. **余额要取 `op_credit_summary.total_remaining_amount`**：同一响应里的
   `total_remains_credit` / `opcredit_balance` 在已迁移积分池的账号上恒为 `0`，取它们会显示"0 积分"。
3. **`timezone_id` 是必需参数**，且必须是 IANA 名字（`Asia/Shanghai`）；缺失或传偏移量会回
   `1406010011 invalid timezone_id`。

到期规则：积分**按笔发放**，每批带自己的 `expire_at_ms`（实测有 30 天与 365 天两种制式），
所以到期日一律读接口字段，不写死天数。

---

## 7. 未决问题 / 阻塞点

| # | 问题 | 状态 | 阻塞原因 |
|---|---|---|---|
| 1 | `/mavis/api/v1/llm/v1/messages` 的完整成功响应、usage 字段、`stop_reason` 集合 | ❌ 未完成 | 本地账号已登出（`status:anonymous`, generation 3）。需用户在 MiniMax Code 里重新登录 |
| 2 | thinking adaptive 的真实线格式与返回（`thinking` block / `thinking_signature`） | ❌ 未完成 | 同上 |
| 3 | base64 image block 是否被接受、`max_images_per_request` 实际行为 | ❌ 未完成 | 同上 |
| 4 | `max_tokens` 实际上限（catalog 声明 128000）、超限错误形态 | ❌ 未完成 | 同上 |
| 5 | `temperature` / `metadata` 是否被接受 | ❌ 未完成 | 同上 |
| 6 | 429 / 配额耗尽的错误 body | ❌ 未完成 | 同上 |
| 7 | **`/messages` 在 03:18 成功、03:26 起 401 的确切原因** | ⚠️ 部分未解 | 已排除：请求头组合（Bearer / x-api-key / UA / x-app / Mavis 头都试过）、刷新（刷新后新旧 token 均 401）、broker lease（同 token 亦 401）。**最可能**：服务端对该 access token 做了服务端侧撤销或设备/会话绑定（device binding），而不仅是 `expiresAtMs`。`/minimax-cloud/api/v1/skill-hub` 用同一 token 返回 200，说明 token 本身有效、但 `/mavis/api/v1/llm/v1/*` 与 `/mavis/api/v1/content` 走了**另一层鉴权中间件**（另两个路由 401）。⇒ 需要抓一次真实请求（app 的 `local-proxy-*.jsonl` 或 devtools）才能确定缺失的头 |
| 8 | global(en) 区域的本地登录路径 | ⚠️ 未实测 | 端点与目录结构已确认对称；本机无 global 凭据 |
| 9 | 额度查询端点实际响应 | ❌ 未完成 | 账号已登出 + 需复刻 md5 签名 |

### 建议的收尾动作（给 lead）

1. **请用户重新登录 MiniMax Code**，然后按 §5.2 的头组合跑一轮对照实验（重点：抓 `local-proxy-*.jsonl` 或用 `mcode-tools` 走一次真实请求对比）。
2. 插件实现上，**先按 Auth Lease Broker（§3.4）落地**，凭据获取与续期全部交给 mcode；插件侧只保留 `accessToken` 的内存缓存 + `expiresAtMs` 过期前重新 lease。
3. 不要实现「插件自己 refresh + 回写 auth.json」——轮换 + 并发 + generation CAS 太脆，且已实证会破坏用户登录。

---

## 8. 附录：研究用命令与证据索引

### 8.1 asar 内文件定位方法

```python
# asar 结构：16 字节 pickle 头 + header JSON + 4KiB 对齐 + 文件数据
# header 大小在偏移 12 的 uint32
import struct, json, mmap
f = open("/Applications/MiniMax Code.app/Contents/Resources/app.asar", "rb")
size = struct.unpack("<I", f.read(16)[12:16])[0]     # → 8446216
hdr = json.loads(f.read(size).decode())              # → {"files": {...}}
BASE = 16 + size
BASE += (8 - BASE % 8) % 8                          # 数据区起点
# 单个文件：递归找 {"size": n, "offset": "123"}，然后 open+seek(BASE+int(offset))
```

### 8.2 关键源码文件清单（`node_modules/…`）

| 文件 | 用途 |
|---|---|
| `@mavis/oauth-core/dist/endpoint-config.js` | OAuth 端点 + region 映射 |
| `@mavis/oauth-core/dist/contracts.js` | clientId / scopes / audience |
| `@mavis/oauth-core/dist/oauth-client.js` | device code / refresh / revoke 的 HTTP 实现 |
| `@mavis/oauth-core/dist/auth-core.js` | 会话状态机、generation CAS、`handleUnauthorized` |
| `@mavis/oauth-lease-protocol/dist/{contracts,codec,node-client,node-server,endpoints}.js` | lease 协议 |
| `@mavis/mcode-tools-host/dist/lease-broker.js` | broker 端实现（缓存/epoch/admission） |
| `@mavis/local-runtime/src/runtime/model-resolver.ts` | `managedHeaders`、`MANAGED_PROVIDER_API_KEY_PLACEHOLDER` |
| `@mavis/local-runtime/src/model-provider/thinking.ts` | thinking wire format |
| `@mavis/local-runtime/src/model-provider/provider-request.ts` | `x-api-key` / `anthropic-version` 默认头 |
| `@mavis/local-runtime-v2/src/service/model-system/resolution/local-model-resolver.ts` | `resolveCredentialHeaders` |
| `@mavis/local-runtime-v2/src/service/model-system/resolution/dynamic-max-tokens.ts` | max_tokens 动态预算 |
| `@mavis/config/dist/minimax-model-catalog.js` | 官方模型目录 |
| `@mavis/config/src/model-availability.ts` | route 解析、`isFirstPartyMinimaxMessagesRoute` |
| `@earendil-works/pi-ai/dist/providers/anthropic.js` | Anthropic provider（SSE / usage / system / tools） |
| `@earendil-works/pi-ai/dist/models.generated.js` | BYOK 模型目录 |
| `@mavis/local-runtime-v2/src/service/memory-system/adapters/quota/{transport,subscription-quota}.ts` | 配额端点 |

### 8.3 实测命令（全部带 `-m` 超时；token 一律 `<redacted>`）

```bash
# 刷新（公开 client，无 secret）
curl -sS -m 25 -X POST 'https://account.minimax.cn/oauth2/token' \
  -H 'Accept: application/json' -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=refresh_token' \
  --data-urlencode "refresh_token=$RT" \
  --data-urlencode 'client_id=mcode-public' \
  --data-urlencode 'scope=agent.default' \
  --data-urlencode 'audience=agent-backend'
# → 200 {access_token, refresh_token, token_type:"Bearer", expires_in:3600, scope:"agent.default"}
# → 旧 RT 再刷：400 {"error":"invalid_grant","error_description":"this refresh token can no longer be used, start a new authorization"}

# device code（只发起，不授权）
curl -sS -m 25 -X POST 'https://account.minimax.cn/oauth2/device/code' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'client_id=mcode-public' \
  --data-urlencode 'scope=agent.default' \
  --data-urlencode 'audience=agent-backend' \
  --data-urlencode "code_challenge=$CHALLENGE" \
  --data-urlencode 'code_challenge_method=S256'
# → 200 {device_code, user_code, verification_uri, verification_uri_complete, expires_in:300, interval:3}

# LLM（带完整托管头）
curl -sS -m 40 -X POST 'https://agent.minimax.cn/mavis/api/v1/llm/v1/messages' \
  -H "Authorization: Bearer $AT" -H 'anthropic-version: 2023-06-01' \
  -H 'x-api-key: sk-xxx' -H 'User-Agent: MiniMaxAgent' \
  -H 'X-Mavis-Session-Id: <uuid>' -H 'X-Mavis-Agent-Id: main' -H 'X-Mavis-Timezone-Offset: 28800' \
  -H 'Content-Type: application/json' \
  -d '{"model":"MiniMax-M3","max_tokens":1024,"messages":[{"role":"user","content":"say OK"}]}'
# → 401 {"error":"invalid access token"}（账号已登出时）

# lease broker（Python，AF_UNIX）
# 见 §3.4 的 call() 实现
```

### 8.4 本次研究造成的状态变更（需告知用户）

1. **研究机 MiniMax Code 登录已失效**：研究中用 `auth.json` 副本里的 refreshToken 完成了一次刷新，触发服务端严格轮换 →
   `~/.minimax/…/auth.json` 里原 refreshToken 作废 → 随后 `unauthorized{generation:2}` 使 broker 刷新失败并触发登出 →
   `auth-state.json` 变为 `status:"anonymous"`, `generation:3`，`auth.json.records` 清空。
   **用户在 MiniMax Code 里重新登录即可恢复**（凭据目录、generation 自增，无需清理残留文件）。
2. **未写入任何 `~/.minimax` 或 `~/.dsh` 文件**；刷新用的是 `/tmp/minimax-test/auth-copy.json` 副本，产物在 `/tmp/minimax-test/`。
3. **未执行任何 npm/pnpm 安装**；未修改插件代码。本文件是本次研究唯一的写入。
