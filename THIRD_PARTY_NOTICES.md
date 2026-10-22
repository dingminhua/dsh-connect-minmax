# Third-Party Notices / 第三方开源依赖声明

本项目（`dsh-connect-minmax`）建立在以下已公开的工作之上。发布时本文件随 npm 包
一起分发（见 `package.json` 的 `files` 白名单）。

This project builds on the following publicly available work. This file ships
with the npm package (see the `files` allowlist in `package.json`).

## 参考项目 / Reference projects

### dingminhua/dsh-connect-workbuddy

- 许可证：MIT — Copyright (c) 2026 LaoDing
- 用途：插件工程骨架（`package.json` 清单形态、`cordis.patch.yml` 的 Loader 补丁
  写法、`tsdown` 双 entry 构建、`client` 半边的槽位注册与 locale 注册形态、设置卡片
  的样式体系）。
- 说明：以上为**架构与形态的参考**，本仓库的代码为独立实现；凡直接复用或逐字
  搬运的文件，其头部注释均标注了参考来源与本项目的改动。

### dingminhua/dsh-connect-trae

- 许可证：MIT — Copyright (c) 2026 LaoDing
- 用途：浏览器半边的注册形态（`slots` / `locale` 两项注入、`LocaleNamespaceMap`
  的模块增强、`plugins.bundle.config` 与 `plugins.row.config` 槽位及 `key` /
  `priority` 写法、整个 `apply` 体包 try/catch 以便槽位 API 变更时降级为
  `console.error` 而不触发 "Failed to load plugins" 红色横幅）、`configForms`
  的软探测写法。

### dingminhua/dsh-connect-qoder

- 许可证：MIT — Copyright (c) 2026 LaoDing
- 用途：配置槽位 key 的**构建期注入**做法（`plugins.bundle.config` 用裸包名、
  `plugins.row.config` 用 `<包名>#<行 id>`），以及"包名改了而槽位 key 没改"这一
  失败模式的记录。

### dingminhua/dsh-subagent-default-model

- 许可证：MIT — Copyright (c) 2026 LaoDing
- 用途：设置卡片的折叠外壳与 `settings.plugin.item` 槽位形态、双语文案键的
  `row.*` 约定。

## 运行时依赖 / Runtime dependencies

以下依赖由本项目**声明为 peer**，实际代码由 DSH 宿主提供；本仓库不随包分发它们。

| 包 | 许可证 | 用途 |
| --- | --- | --- |
| `@deepseek-ai/cordis` | MIT | 插件与服务框架 |
| `@deepseek-ai/dsh-llm` | MIT | `llm` 服务与 adapter 契约 |
| `@deepseek-ai/dsh-llm-pi-ai` | MIT | `PiAiAdapter`（pi-ai 的 StreamChunk 翻译） |
| `@deepseek-ai/dsh-host-webserver` | MIT | 状态路由的 HTTP 承载 |
| `@deepseek-ai/dsh-settings` | MIT | 设置 schema 与设置区注册 |
| `@deepseek-ai/dsh-attachment` | MIT | 附件能力的类型来源 |
| `@deepseek-ai/dsh-client-ui-slots` | MIT | 浏览器半边的槽位注册核心 |
| `@deepseek-ai/dsh-client-ui-renderer` | MIT | 槽位渲染器（类型来源） |
| `@deepseek-ai/dsh-client-ui-settings` | MIT | 配置表单（浏览器半边） |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | MIT | 插件设置页 |
| `@deepseek-ai/dsh-client-ui-primitives` | MIT | UI 原语 |
| `@deepseek-ai/dsh-client-locale` | MIT | 客户端文案注册 |
| `@deepseek-ai/schemastery` | MIT | 类型驱动的 schema 校验 |
| `@earendil-works/pi-ai` | MIT | pi-ai 的 `anthropicMessagesApi`（Anthropic 兼容实现） |
| `react` / `react-dom` | MIT | 浏览器半边的 React 渲染 |

## 上游协议资料 / Upstream protocol material

MiniMax Code（mcode）的 Auth Lease Broker 协议（帧格式、`lease` / `status` 方法、
capability 文件约定）来自对**本机已安装**的 MiniMax Code 客户端的实测与其随包
分发的 bundle 代码阅读，详见 `docs/research/upstream.md`。**未复制其源代码**；
本项目只实现与其兼容的客户端协议。

## 图标 / Icons

`icons/dsh-connect-minmax-64.png` 与 `icons/dsh-connect-minmax-128.png` 使用
`dsh-connect-*` 插件**家族统一图标**（与 `dsh-connect-workbuddy` / `dsh-connect-trae` /
`dsh-connect-qoder` 同一份文件，SHA-256 一致），可自由再分发。

不使用 MiniMax / MiniMax Code 的品牌标识：本插件读取的是用户自己的本机登录态，
不冒充官方客户端，因此图标也不采用厂商 logo。
