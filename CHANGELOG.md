# Changelog

## Unreleased

- **模型页改成草稿式交互**（与 Qoder / workbuddy 同款）：改动先落在草稿里，
  底部「保存」才写回配置、「放弃修改」丢弃，标题旁显示「未保存」徽章。
  批量改多个模型只写一次，中途失败不会留下半套配置。
  - 状态新增 `modelOverrides` 段（已保存的逐模型覆盖值）：草稿的基线必须来自
    **已保存的值**而不是当前生效的投影——投影已被掩码过（`modelImages:false`
    会让 `input` 少一个 image），拿它当基线分不清"没动过"和"显式关掉了"。
  - 写入失败时**草稿不清**，并给一句人话提示：改一次丢一次是不能接受的。
  - dirty 判定拿"已保存基线快照"比对，不是每次从 status 现算：保存后宿主要
    重新激活插件才会反映新值，那几百毫秒里现算会又显示"未保存"。
- 底部操作条补「鼓励一下 ★」（指向仓库）、放弃修改、保存。

### 修复（用户反馈）

- **领取签到后不刷新**：状态路由对积分/签到有 60 秒缓存，领取后卡片立刻重读
  拿到的仍是旧读数——按钮继续亮着、余额不动，看起来像没生效。现在领取成功后
  清掉该路由的账户缓存（删除副本同理）。附带修掉一个更隐蔽的副作用：陈旧的
  余额会回灌给账号池，让一个其实有钱的账号被当成"积分已用尽"。
- **模型勾选保存不了**：设置写入面原来只在 `apply()` 时解析一次。卡片挂载那一刻
  `configForms` 的 describe 镜像通常还是 `idle`（`view` 为空），解析失败后
  退化成猜的命名空间 `dsh-connect-minmax`；宿主的真实 entry id 不是它，
  `get()` 拿到的是不存在的条目，`set()` 永远返回 false——界面能点，一条也
  没写进去。现在改为**惰性解析**：每次读/写时现找命名空间，并订阅 describe
  镜像，晚就绪也能救回来；认命名空间的方式也从"猜名字"改成"看配置里的独有
  字段"（`modelContextWindows` 等），部署方改安装行名也不会认错。

- 插件页标题改成包名 `@dmh2002/dsh-connect-minmax`（与 qoder / trae / workbuddy 一致）：
  这一列由 `locale/*.json` 的 `meta.title` 决定，一旦填了就覆盖包名，之前填的是
  「MiniMax（本机登录）」，所以在列表里与兄弟插件长得不一样。

## 0.6.0

**账号池**：同一区域可以同时持有多个账号，当前账号积分用完后自动换下一个。

### 新增

- **池化路由**：每个区域那条 provider 的凭据面变成 `MiniMaxAccountPool`，候选是
  「本机登录 + 同区域已接管副本」。单账号时池里只有本机登录，行为与 0.5.0 一致。
- **自动换号**（用户要的就是这个）：当前账号积分耗尽时，请求**在同一次调用内**
  换到池里另一个账号继续，用户看到的是正常回复，不是"积分不足"。
  两条触发路径：
  - 主动——状态路由读到余额就回灌给池，请求前即可跳过没钱的号，不浪费一次失败；
  - 被动——上游回配额类错误（`QUOTA`）且**尚未输出任何 chunk** 时换号重试。
    已经流出去的内容撤不回来，所以那种情况不重试；只换一次，避免多账号互相
    失败时空转。
- **手动切换**：`POST /account/select` 把池里某个号设为当前，立刻落盘到账号存储
  的 `activeByRegion`，重启后仍然生效。
- **卡片账号页新增「账号池」区块**：每个账号的余额、「使用中」/「积分已用尽」
  标记、「用这个号」按钮；只有一个账号时不画这块（那不叫池）。

### 修正

- 动作路径常量去重：`actions.ts` 曾经另写一份与 `status-paths.ts` 相同的字符串，
  改一处忘另一处会让卡片 POST 到一个不存在的路径，而两边"都有常量"、都不报错。
- 恢复"上次选中的账号"必须等副本真正装进池之后、且只恢复一次：建池那一刻池里
  只有本机登录，`select()` 会因 id 不存在被拒；而每次都恢复又会跟运行时自动换号
  打架（自动切换不写存储，下一次重算账号列表就把刚切过去的号拨回去）。

### 不是这次做的

- **插件自己发起登录**（卡片上"添加账号"→ 设备码授权）：这样新账号不必先在
  MiniMax Code 里登一次。设备码流程本身已实测可行（`/oauth2/device/code` 返回
  user_code），但它是独立的一块功能，本轮没做。当前进池路径仍是"在 mcode 里
  登录过 → 插件镜像成副本"。

### 测试

- 全量 390 条（此前 348）。新增：池的选择语义 23、`guardStream` 换号重试 9、
  池视图投影 3、卡片池区块与切换 4、选择持久化 5、适配器能力探测 2。

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
- **模型页可勾选启用**、逐模型上下文档位、长上下文全局开关、逐模型测试（走
  `prepareCall → stream` 真实通路）。
- 新配置字段 `modelContextWindows`（id → 窗口）：覆盖 `longContext` 的结果，只接受该模型
  **确实提供**的档位，其余忽略并 warn。1M 按更高用量计费，用户常常只想给其中一个模型开。
- **账号页**：本机登录与已接管副本分列，副本可删除。
- **诊断页**：把只读事实归位（区域、上游域名、凭据来源、积分读取时间、目录与启用模型数、
  账号池、最近一次失败）。
- 卡片写配置（`models` / `regions` / `longContext` / `modelContextWindows` /
  `modelImages` / `reasoningEffort`）并**回读校验**：`scope.set()` 返回 `false` 是
  「被拒」而不是「抛错」，不校验就会出现「复选框打上勾、配置纹丝不动」的假成功。

- 新配置字段 `reasoningEffort`（provider 级默认思考档位）：卡片上是一个下拉框，非法取值
  退回 `medium` 并 warn。**不提供 `off`**——`MiniMax-M3.1-Flash` 强制思考，默认值设成
  `off` 会让宿主在选中它时直接失败。
- 删除 `MiniMaxModelSpec.defaultEffort`：声明了 5 次、**读取 0 次**的死字段。实测把某模型
  的该值改成 `xhigh` 后 `resolveModel()` 仍回 `medium`（默认档位来自 provider 级的
  `profile.reasoning`，pi-ai 的模型级只有"可选档位集合"）。留着它比没有更糟：后来人会
  以为改它能生效。

### 修正的事实错误

- 「刻意不做」这一段最初写着「M2.7 就是不能输入图片」——**错的**，是我按记忆写的，
  测试抓到后核实：目录里四个模型全部 `input: ['text','image']`。因此图片开关不是
  "假控件"，按上文 `modelImages` 那条的**不对称掩码**语义实现。

### 测试

- 新增 `tests/client-card-interact.spec.tsx`（16 条）：覆盖**点下去到底写了什么**——
  勾选写入的是目录顺序的补集、关到最后一个被拒、「全部启用」写空列表、单档模型不渲染
  下拉框、区域开关、副本删除 POST 带 id、今天不可领时绝不发写请求、诊断页面板内部
  零写入控件、无作用域时全部禁用并说明原因。渲染冒烟测试只证明"画得出来"；结构变了
  那边会红，而**写入语义**错了（比如把"全部启用"写成关闭全部）只有这边能抓到。
- `inspect()` 与 `token()` 原先门控不一致：宿主重启后第一份真实双区域数据暴露
  ——两条路由余额不同（token 各用各的、正确），状态却都报 `source=lease` + 同一个
  generation。卡片显示与真实通路不一致时，排查方向会被带去怀疑 broker。修复：
  inspect 同样按 generation 门控；跨区回落说明在诊断页新增「凭据说明」行（ready
  态此前无处显示这条事实）。真实机器验证：cn=file gen=17+回落说明，global=lease
  gen=13 无说明 ✓。
- 全量 348 条（此前 307）。

### 刻意不做

- 逐模型的「可关思考」开关：默认思考档位是 provider 级的单个值（`profile.reasoning`），
  pi-ai 的模型级描述只有"可选档位集合"（`reasoningEfforts`），**没有**"每模型默认档"
  这个概念；要做就得改 pi-ai 契约。推理与实测见 `docs/design.md` §11。
- 逐模型「开启图片」在上游不支持的模型上：会被宿主忽略并 warn——声明一个上游不受理的
  模态只会把用户的显式操作变成线上一条 4xx。
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
