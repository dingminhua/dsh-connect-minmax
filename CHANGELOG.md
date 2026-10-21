# Changelog

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
