# Changelog

## Unreleased

- 插件页标题改成包名 `@dmh2002/dsh-connect-minmax`（与 qoder / trae / workbuddy 一致）：
  这一列由 `locale/*.json` 的 `meta.title` 决定，一旦填了就覆盖包名，之前填的是
  「MiniMax（本机登录）」，所以在列表里与兄弟插件长得不一样。

## 0.5.0

设置卡片对齐同族插件的形态，并接上 MiniMax Code 的**积分与每日签到**。

### 修复

- **租约令牌跨区泄漏**（严重）：认证租约协议没有区域参数，broker 只发「当前活跃账号」
  的令牌。同时登录国内版与国际版时（本插件的默认形态），`token()` 无条件优先采用租约，
  于是国内版路由拿到国际版的令牌 —— 网关与账户接口一起 `401 invalid access token`，
  整条国内版通路挂掉。现在用 `generation` 判别租约是否属于本区域，不属于就改用本区域
  盘上凭据；盘上没有可比对的 generation 时保持旧行为（那种情况下本区域也没有别的凭据）。
- 「全部启用」的反向语义：按钮在已全部启用时显示「全部关闭」，但处理端把 `enabled=true`
  写成空列表 —— 空列表在宿主语义里恰恰是**全部启用**，点一下反而变成全选。

### 新增

- **卡片重构**：顶部两个区域 tab（国内版 / 国际版，各自独立供应商、可单独注册或注销），
  下面是「账号 / 模型 / 诊断」三个子页。
- **积分与签到**：余额、按批次的到期分布、七天一签进度，以及「领取今天」按钮。
  三条账户接口实测**不需要** Matrix 签名头，只带 `Authorization: Bearer` 即可
  （依据与真实响应见 `docs/research/upstream.md` §6.3）。
- **模型页可勾选启用**、长上下文档位开关、逐模型测试（走 `prepareCall → stream` 真实通路）。
- **账号页**：本机登录与已接管副本分列，副本可删除。
- **诊断页**：把只读事实归位（区域、上游域名、凭据来源、积分读取时间、目录与启用模型数、
  账号池、最近一次失败）。
- 卡片写配置（`models` / `regions` / `longContext`）并**回读校验**：`scope.set()` 返回
  `false` 是「被拒」而不是「抛错」，不校验就会出现「复选框打上勾、配置纹丝不动」的假成功。

### 刻意不做

- 逐模型的「支持图片」「可关思考」开关：那是上游决定的**事实**（M2.7 就是不能输入图片），
  不是用户偏好；做成可勾的复选框等于给用户一个改了也不生效的控件。
- 积分倍率、签到周期天数之类的写死数字：一律读接口字段。

## 0.4.0

多账号：**账号副本**（MiniMax Code 每区域只能留一个登录，换了账号旧的那个还在）。

- 新增 `src/accounts.ts`：把本机登录镜像成插件自有副本（`$DSH_HOME/.minimax-accounts.json`，0600），
  按 `region + loginEpoch` 分键；同一区域换账号时把旧副本标记成 `owned`（刷新链归插件）。
- 新增 `src/account-source.ts`：副本自己的凭据来源，用副本的 refresh token 续期，
  同账号并发刷新只发一次请求（RT 一次性，重复刷新会毁掉整条链）。
- `owned` 副本注册成独立 provider 路由（`minimax-cn-<id>` / `minimax-global-<id>`），
  模型选择器里是独立分组；跟随态副本不出路由（否则会把 MiniMax Code 挤下线）。
- 镜像与路由对账在 apply 期跑一次，之后每 60s 一次；新增副本自动注册、被删副本自动撤销。
- 状态接口的 `routes[]` 每条新增可选 `accountId`；卡片新增「副本」标记与说明。
- 调研结论写进 `docs/design.md`：refresh token 一次性轮换、mcode 凭据按机器分键、
  以及为什么"复制当前正在用的账号"会打断 MiniMax Code 的续期。

## 0.3.0

双区域支持，并按产品名收拢标识与图标。

- **国内 + 国际两条路由**：`minimax`（显示名「MiniMax（本机登录）」）与
  `minimax-global`（「MiniMax Global（本机登录）」），各读自己区域的凭据
  （`~/.minimax/auth/prod/cn` / `.../en`）。配置项 `region` 换成 `regions: ["cn","global"]`。
- 新增 `globalBaseUrl`，用于覆盖国际版托管地址（`baseUrl` 仍管国内版）。
- **包名收拢到 scope**：`@dmh2002/dsh-connect-minmax`；插件行 id 仍是 `dsh-connect-minmax`，
  设置命名空间与状态路由 `/plugins/dsh-connect-minmax/status` 不变。
- **图标改用 `dsh-connect-*` 家族统一图标**（与 workbuddy / trae / qoder 同一份文件），
  不再用自绘字形，也不用厂商 logo。
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
