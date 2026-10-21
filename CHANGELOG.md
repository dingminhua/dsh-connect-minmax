# Changelog

## 0.3.0

双区域支持，并按产品名收拢标识与图标。

- **国内 + 国际两条路由**：`minimax`（显示名「MiniMax（本机登录）」）与
  `minimax-global`（「MiniMax Global（本机登录）」），各读自己区域的凭据
  （`~/.minimax/auth/prod/cn` / `.../en`）。配置项 `region` 换成 `regions: ["cn","global"]`。
- 新增 `globalBaseUrl`，用于覆盖国际版托管地址（`baseUrl` 仍管国内版）。
- **包名收拢到 scope**：`@dmh2002/dsh-connect-minmax`；插件行 id 仍是 `dsh-connect-minmax`，
  设置命名空间与状态路由 `/plugins/dsh-connect-minmax/status` 不变。
- **图标换成 MiniMax Code 的应用图标**（`icons/*.png`），不再用自绘字形。
- 设置卡片：顶部徽标改为跨区域聚合；新增「路由」表（供应商 / 区域 / 登录态 / 到期），
  未就绪的区域逐条给出去哪儿登录的建议。
- 设备码登录等待期（broker `authorizing`）单独成一档状态，卡片显示验证码与授权链接；
  `logout_pending` 归入"需要登录"而不是报错。
- 卡片同时注册 scoped 与裸包名的槽位 key，避免改名后卡片注册不上。

## 0.2.0

对齐 MiniMax Code 自己的模型目录与线上协议（依据：`~/.minimax/config.yaml` 的远端快照、
随包的 `@mavis/config` 目录源码、以及逐模型实测）。

- 模型顺序改为 `M3.1-Flash` → `M3` → `M2.7` → `M2.7-highspeed`（即 mcode 的 `model_order`）。
- 显示名对齐 mcode：`M3.1-Flash（订阅限免）`、`M3`、`M2.7`、`M2.7-highspeed`，并带「订阅限免」角标。
- `M2.7` / `M2.7-highspeed` 打开图片输入（实测可收 base64 图片）。
- 新增 `longContext` 开关：`M3` / `M3.1-Flash` 可切 1M 上下文档（mcode 的 `contextWindowOptions`）。
- 思考档位只发网关真正接受的 `low` / `medium` / `high` / `xhigh` / `max`；去掉 `minimal`
  （MiniMax 没有这一档），也不再使用 mcode 里那套会被 400 的 `on` / `off` 拼写。
- `M2.7-highspeed` 不再提供「关闭思考」（上游忽略 `disabled`，开关名不副实）。
- `verify-upstream.mjs` 新增 `--matrix`：逐模型核对 thinking 的线上形态。

## 0.1.0

首个版本：把本机已登录的 MiniMax（MiniMax Code / mcode）账号接入 DeepSeek Harness。

- 注册 `minimax` 模型供应商（显示名「MiniMax（本机登录）」），不提供任何 API Key 输入。
- 凭据优先向 MiniMax Code 的 Auth Lease Broker（本机 unix socket / Windows 命名管道）租用；
  MiniMax Code 未运行时退化为只读本地凭据文件；对 `~/.minimax` 全程只读。
- 401 自愈：失效缓存 → 重新租约 → 重试一次；绝不主动让 MiniMax Code 登出。
- 模型：`MiniMax-M3`、`MiniMax-M3.1-Flash`、`MiniMax-M2.7`、`MiniMax-M2.7-highspeed`；
  支持图片输入、工具调用、流式思考块。
- 思考档位映射到 MiniMax 原生 `thinking:adaptive` + `output_config.effort`
  （`off/minimal/low/medium/high/xhigh/max`）；强制思考模型不提供 `off`。
- 设置卡片：登录来源、区域、到期时间、模型目录、最近错误，10 秒轮询。
- 状态接口：`GET /plugins/dsh-connect-minmax/status`。
- 排障脚本：`node scripts/verify-upstream.mjs [--full]`。
