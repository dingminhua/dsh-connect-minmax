# dsh-connect-minmax

把**本机已登录的 MiniMax 账号**（MiniMax Code / mcode 桌面端）接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，在模型选择器里多出一个
**MiniMax（本机登录）** 供应商：文本、图片、工具调用、思考档位全部可用。

**不需要、也不接受 API Key。** 插件只读取本机已经存在的登录态——你在 MiniMax Code 里登录过，
这里就能直接用；你退出登录，这里立刻失效。

## 它是什么

| 你关心的 | 实现 |
| --- | --- |
| 凭据从哪来 | 优先向 MiniMax Code 的 **Auth Lease Broker**（本机 unix socket）租一个短期 token；MiniMax Code 不在运行时，退化为只读本地凭据文件 |
| 会不会过期 | 会。租约拿到的 token 由 MiniMax Code 负责续期；插件在 401 时自动重新租一次并重试一次 |
| 要不要填 API Key | 不要。插件没有 Key 输入框，配置里也没有这个字段 |
| 会不会偷写文件 | 不会。插件对 `~/.minimax` **只读**，不写凭据、不建锁、不刷新 refresh token |
| 支持哪些模型 | `MiniMax-M3.1-Flash`（订阅限免）、`MiniMax-M3`、`MiniMax-M2.7`、`MiniMax-M2.7-highspeed`（可在配置里裁剪） |
| 和 MiniMax Code 一致吗 | 模型名、顺序、上下文档位、思考形态都对齐它的目录；差异见下面的[对照表](#和-minimax-code-的对照) |

## 安装

在 Harness 的**插件管理器**里选择「安装本地目录」，指向本仓库根目录即可
（等价于 `plugin_manager` 的 `install_bundle`，`target` 传本目录绝对路径）。

安装后模型选择器里会出现分组 **MiniMax（本机登录）**。如果没出现，重启一次 Harness Desktop。

> 安装是"链接"式的：本仓库就是安装体，改动代码后重新 `pnpm build` 即可生效（新 JS 模块需要重启宿主）。

## 使用

1. 确保 **MiniMax Code 已打开并处于登录状态**（插件本身不提供登录界面）。
2. 在 Harness 里把模型切到 `M3.1-Flash（订阅限免）`（强制思考、订阅期内不计费）或 `M3`。
3. 思考档位按模型提供：`off / low / medium / high / xhigh / max`。
   - `M3.1-Flash` 与 `M2.7-highspeed` **没有 `off`**：前者上游要求必须思考（发 disabled 会 400），
     后者会忽略 disabled 照样思考，给一个关不掉的开关只会误导。
   - `minimal` 也不提供：MiniMax 的档位从 `low` 起，宿主多出来的这一档没有落点。
4. 打开 **设置 → 插件 → MiniMax（本机登录）** 可以看到登录来源、区域、到期时间与模型目录。

### 思考档位怎么映射

MiniMax 的原生控制是 `thinking: {type:'adaptive'}` + `output_config.effort`，插件按这个走：

| Harness 档位 | 上游 `output_config.effort` |
| --- | --- |
| `off` | 不发 `output_config`，只发 `thinking:{type:'disabled'}`（强制思考模型不提供此档） |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

MiniMax Code 自己的 M3 是一个"开/关"开关，它在代码里拼出的 `effort: 'on'/'off'`
**在当前托管网关上会被 400 拒绝**（`invalid reasoning_effort`，合法值只有
`low/medium/high/xhigh/max`）。插件按网关实际接受的取值来发，这也是为什么
档位表里没有 `on`/`off` 这两个拼写。

### 和 MiniMax Code 的对照

模型名、顺序、上下文档位与思考形态，来自 MiniMax Code 自己用的目录
（`~/.minimax/config.yaml` 的远端快照 + 随包的 `@mavis/config` 目录）：

| 模型 | 显示名 | 上下文 | 最大输出 | 输入 | 思考 | 关得掉吗 |
| --- | --- | --- | --- | --- | --- | --- |
| `MiniMax-M3.1-Flash` | M3.1-Flash（订阅限免） | 512K（可切 1M） | 128K | 文本 / 图片 / 视频 | 强制 | 否 |
| `MiniMax-M3` | M3 | 512K（可切 1M） | 128K | 文本 / 图片 / 视频 | 可切换 | 是 |
| `MiniMax-M2.7` | M2.7 | 204.8K | 131K | 文本 / 图片 | 可切换 | 是 |
| `MiniMax-M2.7-highspeed` | M2.7-highspeed | 204.8K | 131K | 文本 / 图片 | 强制 | 否（上游忽略关闭） |

**已知差异**：宿主只有「文本 / 图片」两种输入模态，**视频输入表达不了**；
1M 上下文在 MiniMax Code 里是模型菜单里的可选档位，在宿主里做成了插件开关
`longContext`（默认关，上游对 1M 档按更高用量计费）。

## 工作原理

```
Harness  ──pi-ai anthropic-messages──▶  https://agent.minimax.cn/mavis/api/v1/llm/v1/messages
   │                                        Authorization: Bearer <短期 token>
   │
   └─ MiniMaxAuth ──▶ Auth Lease Broker（~/.minimax/run/mcode-auth-lease-v1.sock）
                    └▶ ~/.minimax/auth/<env>/<region>/mcode-public/auth.json（只读兜底）
```

- **协议**：MiniMax 的托管网关兼容 Anthropic Messages（SSE 事件、`tool_use`、图片 block、thinking 块）。
  插件复用宿主自带的 pi-ai Anthropic 实现，不自己写翻译层。
- **凭据**：`Authorization: Bearer` + `anthropic-version: 2023-06-01`；**不用 `x-api-key`**。
- **区域**：跟随本机登录态，国内版 `agent.minimax.cn`，国际版 `agent.minimax.io`。
- **401 自愈**：先失效本地 token 缓存 → 重新向 broker 要一个 → 只重试一次；
  仍失败则报 `AUTH` 并提示「请在 MiniMax Code 中重新登录」。
  **插件从不主动让 MiniMax Code 登出**（那会毁掉用户的登录态）。

## 多账号（账号副本）

MiniMax Code 每个区域只能留一个登录账号（国内 + 国际各一个）。插件会把本机登录**镜像**成
自己的副本（`$DSH_HOME/.minimax-accounts.json`）：当你在 MiniMax Code 里换成另一个账号后，
旧账号的刷新链由插件接管，于是两个账号可以同时用，各自在模型选择器里是一个分组
（`MiniMax 副本 · …`）。

- 跟着 MiniMax Code 的那个账号永远**只读不刷新**——插件一旦去刷新它，MiniMax Code 下一轮
  续期就会 `invalid_grant`，被迫重新登录。
- 如果你在 MiniMax Code 里**登出**，该账号的 refresh token 会被吊销，对应副本失效，
  卡片会提示重新登录该账号以重新镜像。

细节与实测依据见 `docs/design.md` 第 9 节。

## 图标

`icons/*.png` 用 `dsh-connect-*` 插件家族的统一图标（与 workbuddy / trae / qoder 同一份
文件），不使用 MiniMax 的品牌标识——本插件读的是你自己的本机登录态，不冒充官方客户端。

## 配置

插件行 `dsh-connect-minmax` 的 `config`（都可留空）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `models` | `[]` | 启用哪些模型 id；空 = 目录全部 |
| `regions` | `["cn","global"]` | 注册哪些区域的路由：`cn` → `minimax`，`global` → `minimax-global`；只填一个则只注册该区域 |
| `streamIdleTimeoutMs` | `300000` | 上游空闲超时 |
| `baseUrl` | 空 | 覆盖**国内版**托管 base URL（**不要**带 `/v1`，SDK 会自己拼 `/v1/messages`） |
| `globalBaseUrl` | 空 | 覆盖**国际版**托管 base URL（规则同上） |
| `longContext` | `false` | 用 1M 上下文档（仅 `M3` / `M3.1-Flash`）；上游按更高用量计费 |

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 选不到模型 / 分组不出现 | 插件没激活：插件管理器里看该行是否 `failed`；或 `minimax` / `minimax-global` 已被别的 provider 占用（插件会 warn 并跳过） |
| 国际版分组报"未登录" | 只登录了国内版。两个区域是两套凭据，在 MiniMax Code 里切到国际版登录才能用 `minimax-global` |
| 卡片显示"未登录" | MiniMax Code 没登录。打开它登录后点卡片上的刷新 |
| 卡片显示"仅本地文件凭据" | MiniMax Code 没运行。token 未过期前可用，过期后请启动它 |
| 对话报 `AUTH` | token 被服务端撤销。在 MiniMax Code 里重新登录（必要时退出再登录） |
| 报 `CONTEXT_WINDOW_EXCEEDED` | 上下文超了，用 `/compact` 或换新会话 |
| 卡在思考很久 | M3 系列默认思考；把档位调低，或换 `MiniMax-M3` 并选 `off` |

想确认上游是否通（不经 Harness）：

```bash
node scripts/verify-upstream.mjs          # 登录态 + 最小请求（直连上游）
node scripts/verify-upstream.mjs --full   # 再加 thinking / 工具 / 流式

pnpm build && node scripts/e2e-plugin.mjs              # 走插件自己的适配器跑一轮真实对话
node scripts/e2e-plugin.mjs MiniMax-M3 --tools         # 带工具调用
node scripts/verify-upstream.mjs --matrix             # 逐模型核对 thinking 的线上形态
```

## 开发

```bash
pnpm install
pnpm run typecheck   # 宿主 + 客户端两套 tsconfig
pnpm test            # vitest（无网络、无真实凭据）
pnpm run build       # tsdown：lib/index.js + lib/client.js
pnpm run check       # 上面三个一起
```

目录：

```
src/index.ts    插件入口：Config、注册 adapter、挂状态路由
src/adapter.ts  MiniMaxAdapter（401 重试 / 错误分类）+ pi-ai provider
src/auth.ts     凭据：broker 租约 → 文件兜底 → 状态探测
src/lease.ts    Auth Lease Broker 的 socket 帧协议
src/catalog.ts  模型目录 + base URL + pi-ai Model 描述
src/status.ts   GET /plugins/dsh-connect-minmax/status（卡片数据源）
src/client/     设置卡片（React）
docs/design.md  设计与验收标准
docs/research/  协议/适配器/脚手架的调研笔记（含实测证据）
```

## 隐私

- 不收集、不上报任何数据；除了你发起的模型请求，插件不主动联网。
- 凭据只存在于进程内存里（token 缓存），不落盘、不写日志。
- 卡片只展示"来源 / 区域 / 到期时间"，不展示 token 内容。

## 许可

MIT。第三方组件声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
