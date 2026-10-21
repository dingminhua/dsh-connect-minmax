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
| 支持哪些模型 | `MiniMax-M3`、`MiniMax-M3.1-Flash`、`MiniMax-M2.7`、`MiniMax-M2.7-highspeed`（可在配置里裁剪） |

## 安装

在 Harness 的**插件管理器**里选择「安装本地目录」，指向本仓库根目录即可
（等价于 `plugin_manager` 的 `install_bundle`，`target` 传本目录绝对路径）。

安装后模型选择器里会出现分组 **MiniMax（本机登录）**。如果没出现，重启一次 Harness Desktop。

> 安装是"链接"式的：本仓库就是安装体，改动代码后重新 `pnpm build` 即可生效（新 JS 模块需要重启宿主）。

## 使用

1. 确保 **MiniMax Code 已打开并处于登录状态**（插件本身不提供登录界面）。
2. 在 Harness 里把模型切到 `MiniMax-M3.1-Flash`（订阅限免、强制思考）或 `MiniMax-M3`。
3. 思考档位按模型提供：`off / minimal / low / medium / high / xhigh / max`。
   `MiniMax-M3.1-Flash` **没有 `off`**——上游要求它必须思考，发"关闭思考"会被 400 拒绝。
4. 打开 **设置 → 插件 → MiniMax（本机登录）** 可以看到登录来源、区域、到期时间与模型目录。

### 思考档位怎么映射

MiniMax 的原生控制是 `thinking: {type:'adaptive'}` + `output_config.effort`，插件按这个走：

| Harness 档位 | 上游 effort |
| --- | --- |
| `off` | 不发 `thinking`（M3.1-Flash 不提供此档） |
| `minimal` / `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

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

## 配置

插件行 `dsh-connect-minmax` 的 `config`（都可留空）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `models` | `[]` | 启用哪些模型 id；空 = 目录全部 |
| `region` | `auto` | `auto` / `cn` / `global`；`auto` 跟随本机登录态 |
| `streamIdleTimeoutMs` | `300000` | 上游空闲超时 |
| `baseUrl` | 空 | 覆盖托管 base URL（**不要**带 `/v1`，SDK 会自己拼 `/v1/messages`） |

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 选不到模型 / 分组不出现 | 插件没激活：插件管理器里看该行是否 `failed`；或 `minimax` 已被别的 provider 占用（插件会 warn 并跳过） |
| 卡片显示"未登录" | MiniMax Code 没登录。打开它登录后点卡片上的刷新 |
| 卡片显示"仅本地文件凭据" | MiniMax Code 没运行。token 未过期前可用，过期后请启动它 |
| 对话报 `AUTH` | token 被服务端撤销。在 MiniMax Code 里重新登录（必要时退出再登录） |
| 报 `CONTEXT_WINDOW_EXCEEDED` | 上下文超了，用 `/compact` 或换新会话 |
| 卡在思考很久 | M3 系列默认思考；把档位调低，或换 `MiniMax-M3` 并选 `off` |

想确认上游是否通（不经 Harness）：

```bash
node scripts/verify-upstream.mjs          # 登录态 + 最小请求
node scripts/verify-upstream.mjs --full   # 再加 thinking / 工具 / 流式
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
