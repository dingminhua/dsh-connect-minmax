# `dsh-connect-minmax` 包骨架研究报告

> 目标：从零建立一个 DSH 插件包 `dsh-connect-minmax`（把本机 MiniMax 登录账号接入 DSH 作为模型供应商，**无 API Key 输入**）。
> 参考样本：`dsh-connect-workbuddy`（v5.2.x，34k 行 TS，同作者，最完整）、`dsh-connect-trae`（v4.3.0）、`dsh-connect-qoder`（v1.7.0）。
> 调研日期：2026-10-22。本机：macOS（darwin 25.3.0）、Node **v25.9.0**、pnpm **10.34.5**（Homebrew）。
> 本文档只研究与产出模板，**不含业务逻辑实现**。
>
> 纪律声明：本次调研**未执行任何安装/构建命令**，**未修改 `~/.dsh` 下任何文件**，**未调用 `plugin_manager`**。只跑了只读检查（`node -v` / `pnpm -v` / 读文件）。模板拷贝放在 `docs/research/samples/` 下。

---

## 0. 三分钟速览

| 项 | 结论 |
| --- | --- |
| 包名 | `dsh-connect-minmax`（**不要加 npm scope**；见 §5.1 与坑 #1） |
| 宿主线 | DSH `>=0.1.7-rc.1 <0.3.0-0`（peer 上界必须带 `-0`） |
| Loader 条目 id | `dsh-connect-minmax`（= 设置命名空间 + 路由前缀） |
| 浏览器半边 id | `dsh-connect-minmax`（= **package.json 的 `name`**，不是 Loader id） |
| 客户端槽位 | `plugins.bundle.config`（key = 包名）、`plugins.row.config`（key = `<包名>#<行 id>`） |
| 设置注册 | `ctx.settings.configure({ auto: true }, ctx.fiber)`（0.1.7 起 `installSection` **已删除**） |
| 状态获取 | 宿主 `webServer` 注册 `/plugins/dsh-connect-minmax/status` 路由，前端 `fetch` |
| 构建 | `tsdown` 双 entry：ESM(`lib/index.js`) + CJS(`lib/client.js`) |
| 本地生效 | `pnpm build` → 重启 DSH Desktop（**无 HMR**；见 §2.5） |

---

## 1. 包骨架清单（文件树 + 逐文件说明）

### 1.1 推荐文件树

```
dsh-connect-minmax/
├── package.json                  # 清单：dsh.bundle.patch / dsh.client / exports / files / peerDeps
├── cordis.patch.yml              # Loader 补丁：insert 一行 host 条目
├── tsdown.config.ts              # 构建：ESM host entry + CJS client entry
├── tsconfig.json                 # 宿主侧类型检查（src + tests，排除 src/client）
├── tsconfig.client.json          # 浏览器侧类型检查（src/client + tests/**/*.tsx）
├── vitest.config.ts              # 单测：node 环境 + 隔离 HOME + define 注入
├── pnpm-workspace.yaml           # 单包 workspace + overrides + minimumReleaseAge: 0
├── pnpm-lock.yaml                # 锁文件（CI 用 --frozen-lockfile）
├── .gitignore
├── LICENSE                       # MIT，Copyright (c) 2026 LaoDing
├── THIRD_PARTY_NOTICES.md        # 致谢/合规（workbuddy/trae/qoder 皆必备）
├── README.md                     # 中文
├── README.en.md                  # 英文（与中文 1:1）
├── CHANGELOG.md                  # 变更记录
├── RELEASING.md                  # 发布流程（可后补）
├── screenshots.json              # 截图清单（可选但被 workbuddy 收录）
├── icons/
│   ├── dsh-connect-minmax-128.png
│   └── dsh-connect-minmax-64.png
├── locale/
│   ├── en.json                   # { "meta": { "title", "description" } }
│   └── zh.json
├── docs/                         # 设计文档（可选）
├── scripts/                      # 探测脚本 + 发布核验脚本（可选）
├── src/
│   ├── index.ts                  # 宿主主入口：apply() + Config + 注册 provider
│   ├── version.ts                # 构建期注入的版本号/包名
│   ├── status-paths.ts           # node-free 桥：路由路径 + 类型 + 设置读写助手
│   ├── auth.ts                   # 读本机 MiniMax 登录凭据
│   ├── catalog.ts                # 模型目录
│   ├── adapter.ts                # pi-ai 适配器
│   ├── upstream.ts               # 上游 API 客户端
│   ├── shim.ts                   # 回环 shim（如上游协议需要）
│   ├── web-status.ts             # webServer 路由（卡片数据源）
│   └── client/
│       ├── index.tsx             # 浏览器入口：slots.inject + locale.register
│       ├── MiniMaxCard.tsx       # 状态卡片组件
│       ├── locales.ts            # 卡片文案（zh/en）
│       └── styles.ts             # 卡片 CSS
└── tests/
    ├── auth.spec.ts
    ├── catalog.spec.ts
    ├── upstream-sse.spec.ts
    ├── web-status.spec.ts
    ├── client-card-render.spec.tsx   # jsdom
    └── client-runtime-imports.spec.ts
```

### 1.2 逐文件：从 workbuddy 复制并改什么

#### `package.json`

**来源**：`dsh-connect-workbuddy/package.json`（拷到 `docs/research/samples/package.json.workbuddy`）。
**动作**：复制后逐项改。

| 字段 | workbuddy 的值 | minmax 应改成 | 说明 |
| --- | --- | --- | --- |
| `name` | `dsh-connect-workbuddy` | `dsh-connect-minmax` | **必须等于**浏览器 bundle 的 `PLUGIN_ID`（§3.4 坑 #1） |
| `displayName` | `DSH Connect WorkBuddy` | `DSH Connect MiniMax` | 插件管理器展示名 |
| `description` | 长描述 | MiniMax 版 | 一句话说清能力 |
| `version` | `5.2.1` | **`0.1.0`** | 新包起点建议 `0.1.0`（见 §5.2） |
| `type` | `module` | `module` | 保持 |
| `engines.node` | `^22.19.0 \|\| >=24.0.0` | 同 | 本机 Node 25.9.0 满足 `>=24` |
| `main` / `types` | `lib/index.js` / `lib/index.d.ts` | 同 | |
| `bin` | `dsh-connect-workbuddy: lib/bin.js` | **先不要**（无 CLI 就不加） | qoder 有 CLI（`src/bin.ts`）；minmax 若不做 `status/doctor` CLI 可省，省掉能避开 `host-peers` 的一整类坑（§4.3） |
| `icon` | `icons/dsh-connect-workbuddy-128.png` | `icons/dsh-connect-minmax-128.png` | 顶层 `icon` 优先于 `./icon` 导出（host-plugin.md §显示元数据） |
| `exports` | 见下 | 照抄改包名 | |
| `files` | 见下 | 照抄改包名 | |
| `scripts` | 见下 | 照抄 | |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 同 | **必填**，否则不是 bundle |
| `dsh.client.inject` | 4 个包 | 见 §1.3 | |
| `dsh.client.platform` | `web` | 同 | |
| `peerDependencies` | 14 个 | 见 §1.3 | |
| `devDependencies` | 20 个 | 见 §1.3 | |
| `dependencies` | `{ "@deepseek-ai/schemastery": "3.18.4" }` | 同（可保留） | schemastery 需要真依赖，因为 `z.object` 的 `volatile()` 行为与宿主版本绑定 |
| `repository` / `homepage` / `bugs` | 指向 github | 改成 minmax 仓库 | |

**`exports`（照抄改包名）：**

```json
"exports": {
  ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
  "./client": "./lib/client.js",
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./locale/*.json": "./locale/*.json",
  "./package.json": "./package.json"
}
```

> `./locale/*.json` 这一行**必需**：插件管理器和设置页在**不激活插件**的前提下就要读 `meta.title` / `meta.description`（host-plugin.md §显示元数据）。

**`files`（照抄改包名）：**

```json
"files": [
  "lib",
  "icons",
  "locale",
  "docs/assets",
  "screenshots.json",
  "cordis.patch.yml",
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE"
]
```

> `tests/` 与 `node_modules/` 天然不入包（不在白名单里）。
> **注意**：`files` 只对 **npm 打包**生效；**本地 `link:` 安装不经过 `files` 过滤**（host-plugin.md 明确说了），所以本地调试时"文件不在包里"不会成为问题。

**`scripts`（照抄）：**

```json
"scripts": {
  "prepack": "npm run build",
  "build": "tsdown",
  "test": "vitest run",
  "typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.client.json",
  "check": "pnpm run typecheck && ppnpm run test && pnpm run build"
}
```
> 上面 `check` 里有个笔误，正确的是：`"check": "pnpm run typecheck && pnpm run test && pnpm run build"`。

#### `cordis.patch.yml`

**来源**：`dsh-connect-workbuddy/cordis.patch.yml`（拷到 `docs/research/samples/cordis.patch.yml.workbuddy`）。
**动作**：只改两处。

```yaml
# Register the MiniMax provider without changing the profile's default model.
# The plugin reuses the local MiniMax sign-in; no separate OAuth flow is started.
- insert:
    - id: dsh-connect-minmax
      name: dsh-connect-minmax
```

**写法要点（Loader patch 方言，cordis-composition-reference skill）：**

- `insert:` 是**追加**行；`- id:` 是**行 id**，`name:` 是**包说明符**（在本仓库内相对 patch 文件锚定；发布后由 profile 的 node_modules 解析）。
- `id` 一旦定下**不可改**：它同时是
  1. 设置命名空间（`settingsNamespaceOf` 读 `ctx.fiber.entry?.options.id`），
  2. `/plugins/<id>/…` 路由前缀，
  3. `plugins.row.config` 槽位的 key 后半段。
  改名会让所有已保存的配置静默孤立（qoder 的 `cordis.patch.yml` 注释明确写了这条）。
- `disabled` 字段：默认不写（= 启用）。若要默认关闭，写 `disabled: true`。
  `disabled` 接受 `boolean | null | !!js` 表达式。
- `config:` 字段：行级 `config` 是给该插件行的**初始配置**，**整体替换**（不是深合并）。minmax 若配置全在 `Config` schema 的默认值里，就**不需要** `config:`。
- `inject` / `intercept` / `isolate` 字段：minmax 用不到。
- 若需要引用宿主自带包（`@deepseek-ai/dsh-*`），**不要在 patch 里写依赖**——它们由宿主提供，组合包直接用即可。

> **宿主包依赖从哪来？** `cordis.patch.yml` **不声明**宿主包依赖。宿主包（`dsh-llm` / `dsh-settings` / `dsh-host-webserver` / `dsh-client-ui-*`）由 DSH 安装自带，插件在 `peerDependencies` 里声明**版本范围**（§1.3），运行时由宿主提供。`dsh-connect-trae` 的 patch 只有两行就是这个原因。

#### `tsdown.config.ts`

**来源**：`dsh-connect-workbuddy/tsdown.config.ts`（拷到 `docs/research/samples/tsdown.config.ts.workbuddy`）。
**动作**：复制 + 改 `PLUGIN_ID` + 改 define 名 + 删掉 `bin` entry。

**结构（双 entry）：**

```ts
import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

const PACKAGE = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string, version: string }

/** 浏览器 bundle 的 window.__ModuleLoader__ id —— 必须等于 package.json 的 name */
export const PLUGIN_ID = PACKAGE.name

/** 构建期注入到 src/version.ts 的常量 */
const BUILD_DEFINE = {
  __DSH_MINMAX_VERSION__: JSON.stringify(PACKAGE.version),
  __DSH_MINMAX_PACKAGE_NAME__: JSON.stringify(PACKAGE.name),
}

/** 客户端半边必须 external —— 由宿主 shell 的 module loader 注册 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,          // 宿主入口要出 .d.ts
    clean: true,
    define: BUILD_DEFINE,
    deps: {
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-atomic-write',
        '@deepseek-ai/dsh-attachment',
        '@deepseek-ai/dsh-home-paths',
        '@deepseek-ai/dsh-host-webserver',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        '@deepseek-ai/dsh-settings',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,         // 客户端不产 d.ts
    clean: false,       // 两个 entry 共享 outDir，第二个不能 clean
    define: BUILD_DEFINE,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
```

**要点：**

- **`neverBundle` 宿主包列表**：宿主半边把 `@earendil-works/pi-ai`、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis`、`dsh-atomic-write`、`dsh-attachment`、`dsh-home-paths`、`dsh-host-webserver`、`dsh-llm`、`dsh-llm-pi-ai`、`dsh-settings` 全部 external——插件借用 DSH 安装里的那份，不自带副本。
  - `@earendil-works/pi-ai` 与 `@deepseek-ai/cordis` **必须** external：cordis 携带服务注册表，pi-ai 的代际决定上下文形状，自带副本一定是错的。
  - `dsh-atomic-write` / `dsh-home-paths` 是纯无状态工具，理论可自带，但**不要**（见 §4.3 的 `host-peers` 坑）。
- **`react-dom` 必须 external**（三者共同强调的线上事故）：把它 bundle 进来会把 `if (process.env.NODE_ENV !== "production")` 内联进 CJS 构建，浏览器在**模块求值期**就抛 `ReferenceError: process is not defined`，整个客户端半边 import 失败（`web boot: 1 entry did not activate`）。trae 2.12.0 / 2.13.0 就这么翻的车。`tests/client-runtime-imports.spec.ts` 钉这条。
- **client entry 的 `banner/footer/intro`** 是 CJS 包装：把 bundle 注册进 shell 的 `window.__ModuleLoader__`，`id` 必须是包名。
- **`define` 版本注入**：`src/version.ts` 用 `declare const __DSH_MINMAX_VERSION__: string` + `typeof` 守卫读取，发布包只含 `lib/`，没有可解析的 `package.json` 路径。
- `dts: true` 只给宿主 entry（`lib/index.d.ts` 要被 `exports.types` 指到）。

#### `tsconfig.json`（宿主侧）

**来源**：`docs/research/samples/tsconfig.json.workbuddy`。**动作**：复制，把 `exclude` 里的长名单改成最小两条。

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2024",
    "lib": ["es2024"],
    "allowImportingTsExtensions": true,
    "esModuleInterop": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"],
  "exclude": ["src/client", "tests/**/*.spec.tsx"]
}
```

> workbuddy 的 `exclude` 列了 30 条具体 `.tsx` 文件名——那是历史累积，**新项目不要抄**，用通配 `tests/**/*.spec.tsx` 即可。
> `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` 是这套代码风格的关键，**保留**。

#### `tsconfig.client.json`（浏览器侧）

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2024",
    "lib": ["es2024", "dom"],
    "jsx": "react-jsx",
    "allowImportingTsExtensions": true,
    "esModuleInterop": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/client", "tests/**/*.spec.tsx"]
}
```

> 与宿主 tsconfig 的差别只有三处：`lib` 加 `"dom"`、`jsx: "react-jsx"`、`include` 换成 client 侧。
> **两个 tsconfig 必须都跑**：宿主侧 `include: ["src","tests"]` 会把 `tests/**/*.spec.ts` 收进来（Node 环境），client 侧收 `tests/**/*.spec.tsx`（DOM 环境）。缺一个就有一半代码从没被类型检查过。

#### `vitest.config.ts`

**来源**：`docs/research/samples/vitest.config.ts.workbuddy`（workbuddy 版带 `setupFiles` 与 `env`；qoder 版带 `define`）。
**动作**：复制 qoder 版（它已经把 define 注入做好了），改包名。

```ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/** 测试绝不能碰真实的 DSH home —— 插件会在 $DSH_HOME 下写凭据副本/心跳 */
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-connect-minmax-test-'))

/** 由 home 派生的路径也必须隔离（HOME / USERPROFILE / LOCALAPPDATA / APPDATA / XDG_CONFIG_HOME） */
const isolatedEnv = {
  DSH_HOME: isolatedHome,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  LOCALAPPDATA: join(isolatedHome, 'AppData', 'Local'),
  APPDATA: join(isolatedHome, 'AppData', 'Roaming'),
  XDG_CONFIG_HOME: join(isolatedHome, '.config'),
}

/** 镜像 tsdown.config.ts 注入的构建期常量，读同一个 package.json */
const PACKAGE = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string, version: string }

export default defineConfig({
  define: {
    __DSH_MINMAX_VERSION__: JSON.stringify(PACKAGE.version),
    __DSH_MINMAX_PACKAGE_NAME__: JSON.stringify(PACKAGE.name),
  },
  test: {
    setupFiles: ['./tests/setup-per-file-home.ts'],
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',       // .tsx 用文件级 `@vitest-environment jsdom` pragma 切过去
    env: isolatedEnv,
    testTimeout: 30_000,       // Windows runner 冷启动余量
  },
})
```

**要点：**

- **`environment: 'node'` 是全局默认**，`.tsx` 组件测试在文件头写 `/** @vitest-environment jsdom */`。这样 jsdom（dev-only 依赖）不会泄漏到断言宿主行为的测试里。
- **`define` 必须镜像 `tsdown.config.ts`**：否则浏览器半边在测试里会退化到字面默认值，一个断言"配置槽位 key"的测试会**对着一个与已安装包名不符的名字**心满意足地通过——这正是 qoder 换 scope 后卡片渲染不出来的那个失败模式。
- **`setupFiles: ['./tests/setup-per-file-home.ts']`**：workbuddy 的这个文件给每个测试文件一份独立的临时 HOME（因为 `env` 是进程级共享的，一个文件写的东西会漏给另一个文件）。**新项目至少要抄这个文件**。

#### `.gitignore`

**来源**：`docs/research/samples/gitignore.workbuddy`。**动作**：复制，可加 `dist/`、`*.tsbuildinfo`。

```
node_modules/
.pnpm-store/
lib/
coverage/
*.log
.env
.DS_Store
```

> **`.npmrc` 必须 gitignore**（trae 的版本显式加了，并注释"可能内含 `_authToken`，绝不入库"）。

#### `LICENSE`

**来源**：`docs/research/samples/LICENSE.workbuddy`（MIT，Copyright (c) 2026 LaoDing）。
**动作**：复制，版权主体保持 `LaoDing`。发布前用 `grep -F "Copyright (c) 2026 LaoDing" LICENSE` 自检。

#### `icons/`

- `dsh-connect-minmax-64.png`、`dsh-connect-minmax-128.png`。
- 约束（host-plugin.md）：SVG / PNG / JPEG / WebP，**≤ 256 KiB**，必须在包内（绝对路径、URL、指向包外的 symlink 都被拒）。
- `package.json` 顶层 `icon` 优先于 `./icon` 导出；顶层写法：`"icon": "icons/dsh-connect-minmax-128.png"`。
- **文件名合法 ≠ 能渲染**——要实际看一眼 PNG。

#### `locale/*.json`

**只有 `meta`**，是插件管理器的显示元数据：

```json
{ "meta": { "title": "dsh-connect-minmax", "description": "把本机登录的 MiniMax 模型接入 DSH……" } }
```
（`locale/en.json` 与 `locale/zh.json` 各一份；拷样本见 `docs/research/samples/locale-{en,zh}.json.workbuddy`。）

**这一层与卡片文案是两回事**（坑 #4）：
- `locale/*.json` → 插件管理器 / 设置页的**标题与描述**（宿主读 JSON 文件）。
- 卡片里的按钮文字 → `src/client/locales.ts` 里的 `zh`/`en` 字典，通过 `ctx.locale.register(ns, { zh, en })` 注册（浏览器侧代码），**与 JSON 文件无关**。

#### `README.md` / `README.en.md`

**结构**（参照 workbuddy / trae 的目录，两份一一对应）：

1. 标题 + 一句话定位 + 徽章
2. **风险提示**（workbuddy 放在最前面：非官方接口、上游调整可能导致失效、账号风险自负）——MiniMax 同理，**必须写**
3. 亮点列表
4. 工作原理 / 架构（凭据来源、目录来源、请求路径）
5. **安装**（npm 版 + 本地开发版，§2.3）
6. DSH 版本兼容（peer 范围表）
7. 平台支持（macOS / Windows / Linux，措辞分「已验证 / 未验证」）
8. 配置项说明（设置卡片里的每一项）
9. 故障排查（常见报错 → 原因 → 修法）
10. 开发（`pnpm install` / `pnpm run check` / `link:` 安装）
11. 致谢 / 第三方开源依赖（指向 `THIRD_PARTY_NOTICES.md`）
12. 许可证

#### `pnpm-workspace.yaml`（workbuddy/trae 都有，**别漏**）

单包 workspace，但需要 `overrides` + `minimumReleaseAge: 0`：

```yaml
packages:
  - '.'

overrides:
  '@deepseek-ai/cordis': 4.0.2
  '@deepseek-ai/dsh-atomic-write': 0.1.7-rc.1
  '@deepseek-ai/dsh-attachment': 0.1.7-rc.1
  '@deepseek-ai/dsh-client-locale': 0.1.7-rc.1
  '@deepseek-ai/dsh-client-ui-primitives': 0.1.7-rc.1
  '@deepseek-ai/dsh-client-ui-renderer': 0.1.7-rc.1
  '@deepseek-ai/dsh-client-ui-settings': 0.1.7-rc.1
  '@deepseek-ai/dsh-client-ui-settings-plugins': 0.1.7-rc.1
  '@deepseek-ai/dsh-client-ui-slots': 0.1.7-rc.1
  '@deepseek-ai/dsh-home-paths': 0.1.7-rc.1
  '@deepseek-ai/dsh-host-webserver': 0.1.7-rc.1
  '@deepseek-ai/dsh-llm': 0.1.7-rc.1
  '@deepseek-ai/dsh-llm-pi-ai': 0.1.7-rc.1
  '@deepseek-ai/dsh-settings': 0.1.7-rc.1
  '@deepseek-ai/schemastery': 3.18.4
  '@earendil-works/pi-ai': 0.85.1

allowBuilds:
  '@google/genai': false
  protobufjs: false

minimumReleaseAge: 0
```

**为什么需要 `minimumReleaseAge: 0`**（trae 的注释写得最清楚）：
pnpm 11 默认有 24h 的"新版本等待期"，CI 上没有 `~/.npmrc` 就会用 pnpm 的默认窗口。你追的是 DSH 的预发布线（发布才几小时），于是 `pnpm install --frozen-lockfile` 会报
`The lockfile contains entries that the active policies reject`，**所有后续 CI 步骤被跳过**——而这个失败本地看不见（开发者的 `~/.npmrc` 把它设成 0）。必须显式写 0。

**为什么需要 `overrides`**：让**开发树**与**用户实际解析到的**一致。schemastery 的 `volatile()` 在 3.18.3 才出现，0.1.7 线发的是 ~3.18.4；如果 devDependency 停在 3.18.2，`asVolatile()` 会退化成恒等 no-op，**用户实际会走的那条 volatile 路径在本地一次都不会执行**——trae 的 0.1.5 线"设置区整个消失"就是这么溜过 PR 与 CI 的。

### 1.3 `dsh.client.inject` 与 peerDependencies

**`dsh.client.inject`（workbuddy 版，四个）：**

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-client-ui-settings-plugins",
      "@deepseek-ai/dsh-client-locale"
    ],
    "platform": "web"
  }
}
```

- 这四个是**浏览器侧的 Cordis 服务包**：`slots`（槽位注册）、`locale`（文案）、`settings`（配置表单）、`settings-plugins`（插件页）。
- trae 额外注入了 `@deepseek-ai/dsh-client-ui-renderer` 和 `@deepseek-ai/dsh-client-ui-primitives`。**建议照抄 trae 的六项**（更全，且 `client-runtime-imports.spec.ts` 会校验 external 名单与宿主注册表一致，多注入更保险）。
- **注意 `inject` 里写的是「包」，`src/client/index.tsx` 里 `export const inject` 写的是「服务名」**——后者是 `['slots', 'locale']`，两者不是一回事，别混。

**peerDependencies（照抄 workbuddy，按 minmax 实际用到的裁剪）：**

```json
"peerDependencies": {
  "@deepseek-ai/cordis": ">=4.0.1-rc.1 <5.0.0 || >=4.0.2 <5.0.0",
  "@deepseek-ai/dsh-atomic-write": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-attachment": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-client-ui-primitives": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-client-ui-renderer": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-client-ui-settings": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-client-ui-settings-plugins": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-client-ui-slots": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-client-locale": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-home-paths": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-host-webserver": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-llm": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-llm-pi-ai": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-settings": ">=0.1.7-rc.1 <0.3.0-0",
  "@deepseek-ai/schemastery": ">=3.18.1-rc.1 <4.0.0 || >=3.18.2 <4.0.0",
  "@earendil-works/pi-ai": ">=0.85.0 <0.88.0 || >=1.0.0 <2.0.0",
  "react": "^18.2.0"
}
```

**铁律（RELEASING.md §2.6）：**

- 所有 `dsh-*` peer 必须是**同一条范围**，上界统一 `>=0.1.7-rc.1 <0.3.0-0`。
- **上界必须带 `-0` 后缀**。DSH 至今全部 tag 都是预发布（`0.1.7-rc.1`、`0.2.1-rc.1`），写 `<0.3.0` 等于**不挡**——围栏会静默失效。
- **peer 范围写错不会让任何构建或测试失败**，它只在下一个 DSH 版本落地那一刻生效，用户侧表现为插件**静默消失**（组合包被 `loadProfileDirectory` 跳过，只往 stderr 写一行）。workbuddy 有专门的 `tests/dsh-line.spec.ts` 强制所有 `dsh-*` peer 范围一致——**minmax 也应该抄这个测试**。
- `react` 是 peer（浏览器端 React 由 shell 提供，宿主侧不需要）。
- `schemastery` **同时**出现在 `dependencies`（固定版本）与 `peerDependencies`（范围）——这不是笔误：workbuddy/trae/qoder 三家都这么做。

**devDependencies：** 照抄 workbuddy（把 peer 里的包都加一份，版本用 `0.1.7-rc.1` / `3.18.4` / `0.85.1`），再加 `jsdom`、`@testing-library/react`、`@testing-library/dom`、`@types/react`、`@types/react-dom`、`tsdown`、`typescript`、`vitest`。

---

## 2. 构建与安装流程

### 2.1 本机可用的工具链（只读检查结果）

```
$ which node pnpm
/opt/homebrew/Cellar/node/25.9.0_3/bin/node
/opt/homebrew/Cellar/node/25.9.0_3/bin/pnpm

$ node -v
v25.9.0

$ pnpm -v
10.34.5
```

- Node v25.9.0 满足 `engines.node: "^22.19.0 || >=24.0.0"`。
- pnpm **10.34.5**，而 CI 用的是 pnpm **11**（`.github/workflows/ci.yml` 里 `pnpm/action-setup@v6` + `version: 11`）。**本地 10 与 CI 11 的行为差异**：`minimumReleaseAge` 是 pnpm 11 的特性，pnpm 10 会忽略该字段——所以本地不报错、CI 报错，这正是必须在 `pnpm-workspace.yaml` 里显式写 `minimumReleaseAge: 0` 的原因。

### 2.2 peer 依赖与 `autoInstallPeers`

**关键事实：本机 desktop profile 的 `pnpm-workspace.yaml` 写着：**

```yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
```

含义与后果：

1. **`autoInstallPeers: false`** —— profile 里**不会**自动安装 peer 依赖。宿主包（`@deepseek-ai/dsh-llm` 等）由 DSH 安装自带、通过运行期拦截层解析，**不需要**（也不应该）装进 profile。
2. **`nodeLinker: hoisted`** —— profile 的 `node_modules` 是**扁平**结构（不是 pnpm 的符号链接隔离布局）。当前 profile 的 `node_modules/@deepseek-ai/` 里只有 `cosmokit`、`dsh-brand`、`schemastery` 三个包，印证了"宿主包不装进 profile"。
3. **因此 `plugin_manager install_bundle` 不会因为 peer 缺失而失败**——门禁只校验 **peer 的版本范围**是否被满足（宿主提供的那份算作满足），不校验"装没装进 node_modules"。

**结论：minmax 的 `peerDependencies` 必须覆盖它 `import` 的每一个 `@deepseek-ai/dsh-*`**，否则宿主门禁会**整体跳过**这个 bundle（插件静默消失，只往 stderr 写一行）。

### 2.3 从零到安装的完整命令序列

> 以下命令**可直接复制**。前 4 步是仓库内操作，后 2 步会改 profile（本次调研**未执行**）。

```bash
# 0) 进入项目目录
cd /Users/dmh2002/DshProject/dsh-connect-minmax

# 1) 装依赖（第一次必须联网；之后用 --frozen-lockfile）
pnpm install

# 2) 类型检查（两个 tsconfig 都要跑）
pnpm run typecheck

# 3) 单元测试
pnpm run test

# 4) 构建（产出 lib/index.js + lib/index.d.ts + lib/client.js）
pnpm run build

# 4.5) 一条龙（typecheck + test + build），发布前跑这个
pnpm run check

# 5) 安装到 desktop profile
#    方式 A：DSH CLI（等价于 link: 安装，见 §2.4）
dsh plugin --profile desktop add /Users/dmh2002/DshProject/dsh-connect-minmax

#    方式 B：DSH 插件管理器（本会话可用）
#    plugin_manager(action="install_bundle", target="/Users/dmh2002/DshProject/dsh-connect-minmax")
#    → 返回值里的 application / warnings 决定"是否已生效"，不是日志、进程列表或页面 boot payload
```

**验证安装结果：**

```bash
# profile 的 package.json 里应出现 link: 依赖
grep -n "minmax" ~/.dsh/profiles/desktop/package.json

# node_modules 里应是符号链接
ls -la ~/.dsh/profiles/desktop/node_modules/ | grep minmax

# profile 的 cordis.patch.yml 里应出现这一行
grep -n "minmax" ~/.dsh/profiles/desktop/cordis.patch.yml
```

**参考：workbuddy/trae README 的「开发」章节原话**：

```sh
pnpm install
pnpm run check   # typecheck + test + build
dsh plugin --profile desktop add /path/to/dsh-connect-minmax
```
> 「本地开发用 `link:` 安装到 desktop profile（**改码后重启 DSH Desktop 生效**）」

### 2.4 `link:` 安装 vs `install_bundle` 的区别

| | `dsh plugin --profile desktop add <路径>` / `install_bundle` | 手工在 profile 里写 `link:` |
| --- | --- | --- |
| 谁写 profile 的 `package.json` | 插件管理器 | 你自己 |
| 依赖形式 | 同样是 `link:`（当前 profile 里三个连接器插件全是 `link:`） | 同 |
| `cordis.patch.yml` | 插件管理器追加行 | 你自己手写（易错，且要手写 `config:`） |
| `dsh.profile.bundles` 白名单 | 自动追加 | 你自己手写 |
| 可重复执行 | 是（幂等） | 否 |
| **建议** | **用这个** | **别用**（skill 明确说：不要写 profile 的 `package.json` / `cordis.patch.yml`，不要在 profile 目录里跑 pnpm） |

**本机 profile 的现状**（`~/.dsh/profiles/desktop/package.json`）：

```json
"dependencies": {
  "dsh-connect-workbuddy": "link:/Users/dmh2002/DshProject/dsh-connect-workbuddy",
  "dsh-connect-trae": "link:/Users/dmh2002/DshProject/dsh-connect-trae",
  "@dmh2002/dsh-connect-qoder": "link:/Users/dmh2002/DshProject/dsh-connect-qoder"
}
```
对应的 `node_modules` 是符号链接：
```
dsh-connect-workbuddy -> ../../../../DshProject/dsh-connect-workbuddy
```

`dsh.profile.bundles` 里还列着这三个包名——**install_bundle 会一并维护这个白名单**。

> 注意 qoder 用了 scope（`@dmh2002/dsh-connect-qoder`）而 workbuddy/trae 没有。scope 会让 `plugins.bundle.config` 的 key 变成带 scope 的包名——qoder 因为这个踩过坑（见 §3.4 坑 #1）。**minmax 建议不带 scope。**

### 2.5 每次改代码后如何生效

**答：`pnpm build` + 重启 DSH Desktop。就这两步。**

- **没有 HMR。** 运行时上下文里明确写着：client-plugin 的 HMR 接收器是**活跃**的，但只有当 `pnpm run dev:web` **从同一个 checkout** 跑着时才会自动重建 bundle。
  - DSH 自带的 checkout 在 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/`，**不在** `/Users/dmh2002/DshProject/dsh-connect-minmax`。
  - 所以**在 minmax 仓库里跑 `pnpm run dev:web` 不会让这个 GUI 的 client bundle 热更新**（`apps/web` 的 Vite entry 只是构建 shell，真正的 `window.__DSH_BOOT__` 由 `dsh web` 注入）。
- **宿主半边（`lib/index.js`）**：加载后被 Node 模块缓存，**必须重启进程**。
- **客户端半边（`lib/client.js`）**：skill 明确说——
  > 「安装新 bundle 可以通过 HMR 激活；**替换已安装的包需要重启**才能加载新的 JavaScript 模块代次。不要从未变的 slot id 推断浏览器代码已更新。」
- 实践上：**`pnpm build` → 完全退出 DSH Desktop（⌘Q，不是关窗口）→ 重新打开**。

**别做的事：**
- 不要为了"热更新"启动第二个服务器——那不会更新这个 GUI。
- 不要在 profile 目录里跑 pnpm（会破坏 profile 的依赖树）。

### 2.6 清理

```bash
# 卸载（CLI）
dsh plugin --profile desktop remove dsh-connect-minmax
# 或
dsh plugin --profile desktop rm dsh-connect-minmax
```
（`plugin_manager` 的对应动作是 `remove_bundle`，target 是包名。）

---

## 3. 设置卡片 UI（最小可用实现）

### 3.1 三条数据通路（必须分清）

```
┌──────────────── HOST (Node) ─────────────────┐         ┌────────── CLIENT (browser) ──────────┐
│                                               │         │                                     │
│  src/index.ts                                 │         │  src/client/index.tsx                 │
│   ├─ Config (schemastery schema)              │         │   ├─ ctx.locale.register(ns,{zh,en})   │
│   ├─ ctx.settings.configure({auto}, fiber) ───┼── 设置命名空间 ──▶│   ├─ ctx.slots.inject(              │
│   ├─ ctx.llm.registerAdapter([...])           │         │   │     'plugins.bundle.config', ...)  │
│   ├─ ctx.llm.registerConfigurableProviders()  │         │   ├─ ctx.slots.inject(              │
│   ├─ ctx.llm.registerModelDiscovery(ns, fn)   │         │   │     'plugins.row.config', ...)     │
│   └─ ctx.inject(['webServer'], ...)           │         │   └─ fetch('/plugins/<id>/status')   │
│        └─ ctx.webServer.register({kind:'exact',│         │            ▲                       │
│              path, handler})  ◀── HTTP ────────┼─────────┴────────────┘                       │
└───────────────────────────────────────────────┘         └─────────────────────────────────────┘
```

### 3.2 槽位（slot）：确切名字与注册 API

**确切槽位名（0.1.7 线）：**

| 槽位 | kind | key | 用途 |
| --- | --- | --- | --- |
| `plugins.bundle.config` | keyed | **包名**（`dsh-connect-minmax`） | 插件页「bundle」那一栏的配置体 |
| `plugins.row.config` | keyed | **`<包名>#<行 id>`**（`dsh-connect-minmax#dsh-connect-minmax`） | 某个插件行的「Configure」 |
| `conversation.input.left` | list | — | （可选）输入框工具栏读数；**共享席**，多插件会互相挤 |
| `conversation.composer.dock` | list | — | （可选）输入框下方常驻栏；shell 自己的 round/step/token 就在这 |
| `shell.quota-notice` | chain | — | （可选）额度提示；**不建议占**，workbuddy 明确 DECLINE 了 |

**注册 API（宿主客户端半边）：**

```ts
ctx.slots.inject(slotName as never, () => (ctx.slots as unknown as {
  register(options: { name: string; key: string; priority: number; inject: () => Props }, component: unknown): () => void
}).register({ name: slotName, key, priority: 30, inject: () => ({ t }) }, MiniMaxCard))
```

- `ctx.slots.inject(seat, factory)` 是**声明式**的：seat 还没被声明时先排队，声明了再执行 factory。所以页面还没挂载时注册**不会丢**。
- `ctx.slots.register({...}, Component)` 返回 **disposer**。keyed 槽位里**同一 key 重复注册会抛**（`already has an entry for key …`），所以替换注册必须**先 dispose 再 register**。
- `priority: 30` 是 workbuddy/trae/qoder 三家都用的一致值。
- list 槽位（`conversation.*`）用的是 `id` + `order` + `locale`（不是 `key` + `priority`）——这是 0.1.7 rc.6→rc.7 的改名（`id`→`key`、`order`→`priority`）留下的两套写法，**别混**。

**⚠️ key 必须是包名，不是设置命名空间。** qoder 的 `src/client/slot-keys.ts` 把这件事写成了独立模块：

```ts
export function qoderCardSlotKeys(packageName: string, rowId: string) {
  return {
    bundle: packageName,          // plugins.bundle.config
    row: `${packageName}#${rowId}`, // plugins.row.config
  }
}
```
> 「插件管理器按**包标识**给配置槽位打 key —— 不是按本插件自己的设置命名空间。……这正是把包改名成带 scope 的 `@dmh2002/dsh-connect-qoder`、而这些 key 还硬编码着旧的裸名时发生的事：插件照常显示为 running，有描述有行，**但配置体渲染不出任何东西**。」

**workbuddy 的做法更保险**：它把**每一种拼法都注册一遍**（`WORKBUDDY_CARD_KEYS = ['dsh-connect-workbuddy', 'include:dsh-connect-workbuddy']`），因为插件页按**精确相等**在 `Set` 里查 key，而部署方可以把安装行命名成任何样子。**minmax 建议照抄这个「多拼法注册」策略**，成本是 4 次注册而不是 2 次。

### 3.3 `installSettingsSection` 的现状（host 侧）

**结论：0.1.7 线已经没有 `installSettingsSection` 了。**

- `installSettingsSection` 是 **0.1.5 线** `SettingsProvider` 的 API，workbuddy 在 1.1.3 之前用过（历史提交 `457d51d`）：
  ```ts
  import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
  installSettingsSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, {
    setSource(source) { current = source },
    onChange() { ... },
  })
  ```
- **0.1.7 的 `SettingsForms` 彻底删掉了 `installSection`**，只暴露 `configure({auto}, owner)`。
  workbuddy 的注释写得很清楚：
  > 「`SettingsForms` dropped `installSection` entirely and exposes `configure({auto}, owner)`; calling the removed method unconditionally made `apply()` throw on 0.1.7 (`ctx.settings.installSection is not a function`) and took down the **WHOLE plugin**.」
- 现在的写法（workbuddy / trae 一致）：
  ```ts
  interface SettingsShapes {
    configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void
  }
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings as unknown as SettingsShapes
    ctx.effect(() => settings.configure({ auto: true }, ctx.fiber))
  })
  ```
- 命名空间由宿主推导：`describe()` 返回 `ns: entry.options.id`，即 **Loader 条目 id**。插件自己用
  ```ts
  export function settingsNamespaceOf(ctx: unknown): SettingsNamespace {
    const id = (ctx as { fiber?: { entry?: { options?: { id?: unknown } } } })?.fiber?.entry?.options?.id
    return typeof id === 'string' && id !== '' ? id as SettingsNamespace : 'minmax' as SettingsNamespace
  }
  ```
  **写死命名空间 = 宿主精确匹配查不到 = provider 被判"未配置"**，配置入口与模型发现双双静默失效。

### 3.4 客户端入口导出什么

`src/client/index.tsx` 必须导出：

```ts
export const name = 'dsh-connect-minmax-client'   // 浏览器插件名
export const inject = ['slots', 'locale']            // 需要的服务（不是包名！）
export function apply(ctx: ClientContext): void { ... }
```

并且**类型增强** `LocaleNamespaceMap`：

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.minmax': MiniMaxSettingsKey
  }
}
```

**为什么 `inject` 只能写 `['slots', 'locale']`（不能写 `configForms`）：**
Cordis 的依赖门禁是**硬的**——写进 `inject` 的服务如果当前宿主不提供，`apply` 就**一次都不会跑**。trae 的注释：
> 「探测两个都通过 `ctx.get()`（对缺失的服务返回 undefined，**永不抛**）——这让一份构建能同时服务两条宿主线。」

所以：**`configForms` 必须用 `ctx.get('configForms')` 软探测，不能进 `inject`。**

### 3.5 怎么拿到宿主状态

**三种途径，minmax 用前两种的组合：**

**(a) HTTP 路由（workbuddy / trae / qoder 都用这个）**

宿主侧注册：

```ts
ctx.inject(['webServer'], (webCtx) => {
  registerMiniMaxStatusRoute(webCtx, { ... })
})
```

```ts
export function registerMiniMaxStatusRoute(ctx: Context, deps: Deps): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: MINMAX_STATUS_PATH,      // '/plugins/dsh-connect-minmax/status'
      handler: async (req, res) => {
        if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return }
        if (!loopbackOrigin(req)) { json(res, 403, { error: 'origin-not-trusted' }); return }
        try {
          json(res, 200, await miniMaxWebStatus(deps))
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    return dispose
  })
}
```

**要点：**
- `ctx.inject(['webServer'], ...)` —— webServer 是**可选服务**（无头 profile 下没有浏览器），宿主 provider 必须在它缺席时照常工作。
- 路由前缀用**Loader 条目 id**：`/plugins/<entry id>/…`。
- **回环来源校验**（`loopbackOrigin(req)`）：只接受 loopback 浏览器请求。
- **脱敏**：`safeMessage(error)` 把 JWT / token 查询参数截断到 500 字符。
- **凭据绝不过桥**：路由只返回状态（登录了没有、目录、账号名），token 永远不出宿主进程。

前端取数：

```ts
const response = await fetch(MINMAX_STATUS_PATH, { headers: { accept: 'application/json' } })
```

**(b) 设置值下发（`configForms` 镜像）**

浏览器侧的 `ctx.get('configForms')`：

```ts
const forms = softGet('configForms') as {
  describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } }; subscribe(l: () => void): () => void }
  get(ns: string): SettingsScope
  whileServed?(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
} | undefined
```

- `describe().getSnapshot().view.namespaces` 列出宿主**实际服务**的命名空间（就是 Loader 条目 id）。
- `forms.get(ns)` 拿到该命名空间的 scope，接口是：
  ```ts
  interface SettingsScope {
    getSnapshot(): { status: string; value?: unknown; writable: boolean }
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<boolean | void>
  }
  ```
- **必须动态绑定，不能写死**：镜像由异步 `remote.settings.describe()` 填充，`apply()` 时通常还是空的。写死 → provider 被判"未配置"，且卡片上的开关"点了没反应"（写进去了，但读的是另一个命名空间）。trae 用一个**重绑定代理 scope**（转发读写到当前 controller，镜像没到时 `writable: false`）；workbuddy 用 `configForms.whileServed(candidates, cb)`（宿主自己的惯用法），在"未服务→已服务"的**边沿**上重新注册所有槽位。
- **⚠️ volatile 陷阱**：0.1.7 会把 `asVolatile()` 字段解析成**活引用** `{ get(): T }`。它是 `typeof === 'object'`，所以 `{ ...reference }` **不会**读到字段——只会得到 `{ get: <fn> }`。**任何要展开/合并设置的代码都必须先 `unwrapVolatileDeep()`**（workbuddy 的 `status-paths.ts` 里有现成实现，抄它）。

**(c) 事件**

宿主侧可监听 `loader/volatile-update`（0.1.7 独有，0.1.5 没有）：

```ts
;(ctx as unknown as { on(name: string, listener: () => void): unknown })
  .on('loader/volatile-update', () => { applySelection(current()) })
```

### 3.6 locale 资源怎么被加载（两层，别混）

| 层 | 位置 | 谁读 | 加载方式 |
| --- | --- | --- | --- |
| **插件元数据** | `locale/en.json`、`locale/zh.json` | 插件管理器 / 设置页 | 宿主**直接读 JSON 文件**（`exports` 里要有 `"./locale/*.json"`），**不需要激活插件** |
| **卡片文案** | `src/client/locales.ts` 里的 `en` / `zh` 字典 | 浏览器组件 | `ctx.locale.register('settings.minmax', { zh, en })` + `ctx.locale.bind(ns)` |

`dsh-client-locale` 的契约（其 README）：
- `ctx.locale.register(ns, { zh, en })`——命名空间必须合并进 `LocaleNamespaceMap`，编译器检查每个 key，且**两个 locale 都必须完整**。
- `ctx.locale.bind(ns)` 返回稳定的 translate 函数；`ctx.locale.resolveText(text)` 用于 `LocalizedText`（比如插件的 title/description）。
- 字典在 UI 已挂载后注册也会被拾取，**不需要 remount**。

**卡片文案的键约定**（三家一致）：`row.*` 前缀。例：
```ts
export const en = {
  'row.title': 'MiniMax (dsh-connect-minmax)',
  'row.desc': '...',
  'row.refresh': 'Refresh',
  'row.signedOutHint': 'Sign in to the MiniMax app once; this plugin follows that sign-in automatically.',
  'row.creditsError': 'Credit query unavailable: {message}',
} as const
export type MiniMaxSettingsKey = keyof typeof en
export const zh: Record<MiniMaxSettingsKey, string> = { ... }
```
> `zh: Record<Key, string>` 这个写法**强制中英 1:1 键对齐**——少一个键就编译不过。**照抄**。

### 3.7 最小卡片骨架代码

> 只展示结构，不抄 1000 行。完整实现见 workbuddy `src/client/WorkBuddyCard.tsx`（1000+ 行）与 `src/client/styles.ts`。

#### 宿主侧：`src/index.ts`（关键片段）

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { registerMiniMaxStatusRoute } from './web-status.ts'

export const name = 'dsh-connect-minmax'
export const inject = ['llm', 'settings']

/** 宿主实际服务的命名空间 = Loader 条目 id */
export function settingsNamespaceOf(ctx: unknown): SettingsNamespace {
  const id = (ctx as { fiber?: { entry?: { options?: { id?: unknown } } } })?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id as SettingsNamespace : 'minmax' as SettingsNamespace
}

/** 设置 schema —— 卡片能改的每个字段都在这里 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  lastCatalog: z.array(ModelEntry).default([]),
  enabledModelIds: z.array(z.string()).default([]),
  // ... MiniMax 需要的字段
})

export function apply(ctx: Context, config: Config): void {
  const settingsNs = settingsNamespaceOf(ctx)

  // ① 设置区注册（0.1.7 API；installSection 已删除）
  interface SettingsShapes { configure: (p: { auto?: boolean }, owner?: unknown) => () => void }
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings as unknown as SettingsShapes
    ctx.effect(() => settings.configure({ auto: true }, ctx.fiber))
  })

  // ② 浏览器状态路由（webServer 可选）
  ctx.inject(['webServer'], (webCtx) => {
    registerMiniMaxStatusRoute(webCtx, { store, client, displayModels: () => displayModels(current()) })
  })

  // ③ provider 注册（异步：先起 shim 拿端口，再构造 adapter）
  void Promise.all([/* ready */]).then(() => {
    let releaseAdapter: AdapterRegistrationHandle | undefined
    let releaseDirectory: DirectoryRegistrationHandle | undefined
    try {
      releaseAdapter = ctx.llm.registerAdapter([MINMAX_PROVIDER], adapter)
      releaseDirectory = ctx.llm.registerConfigurableProviders([{
        provider: MINMAX_PROVIDER,
        displayName: 'MiniMax',
        settingsNs,
        settingsPath: [],
        declared: false,
      }])
    } finally {
      if (releaseAdapter === undefined || releaseDirectory === undefined) {
        releaseAdapter?.(); releaseDirectory?.()
      }
    }
    ctx.effect(() => () => { releaseAdapter?.(); releaseDirectory?.() })

    // ④ 模型发现
    ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
      const models = await discoverModels(signal)
      return models.map(m => ({
        id: m.id, name: m.name, contextWindow: m.contextWindow,
        maxTokens: m.maxTokens, inputModalities: m.input,
      }))
    })
  }).catch((error: unknown) => {
    ctx.logger.error('dsh-connect-minmax: provider registration failed', error)
  })
}
```

#### 客户端侧：`src/client/index.tsx`

```tsx
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MiniMaxCard } from './MiniMaxCard.tsx'
import type { MiniMaxCardInjected } from './MiniMaxCard.tsx'
import { en, zh } from './locales.ts'
import type { MiniMaxSettingsKey } from './locales.ts'
import { MINMAX_CARD_KEYS } from '../status-paths.ts'

export type MiniMaxClientContext = ClientContext & {
  slots: ClientContext['slots']
  locale: ClientContext['locale']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.minmax': MiniMaxSettingsKey }
}

export const name = 'dsh-connect-minmax-client'
export const inject = ['slots', 'locale']

export function apply(ctx: MiniMaxClientContext): void {
  try {
    const namespace = 'settings.minmax'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-connect-minmax: settings copy')
    const t = ctx.locale.bind(namespace) as MiniMaxCardInjected['t']

    // 软探测：configForms 绝不进 inject
    const softGet = (n: string): unknown => (ctx as unknown as { get(n: string): unknown }).get(n)
    const forms = softGet('configForms') as {
      describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } } }
      get(ns: string): MiniMaxCardInjected['settingsScope']
    } | undefined

    let settingsScope: MiniMaxCardInjected['settingsScope'] | undefined
    if (forms !== undefined) {
      let ns = 'minmax'
      try {
        const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
        const served = namespaces.find(e => e.ns === 'minmax' || /minmax/i.test(e.ns))
        if (served !== undefined) ns = served.ns
      } catch { /* 镜像未就绪：回落到声明名 */ }
      settingsScope = forms.get(ns)
    }

    const registerCard = (slotName: string, key: string): void => {
      try {
        ctx.slots.inject(slotName as never, () => (ctx.slots as unknown as {
          register(o: { name: string; key: string; priority: number; inject: () => MiniMaxCardInjected }, c: unknown): () => void
        }).register({
          name: slotName, key, priority: 30,
          inject: () => (settingsScope === undefined ? { t } : { t, settingsScope }),
        }, MiniMaxCard))
      } catch (error: unknown) {
        console.error(`[dsh-connect-minmax] card slot "${slotName}" failed to register (host provider unaffected):`, error)
      }
    }

    // 每种包名拼法都注册一遍（workbuddy 的 WORKBUDDY_CARD_KEYS 策略）
    for (const key of MINMAX_CARD_KEYS) {
      registerCard('plugins.bundle.config', key)
      registerCard('plugins.row.config', `${key}#${key}`)
    }
  } catch (error: unknown) {
    console.error('[dsh-connect-minmax] client card failed to load (host provider unaffected):', error)
  }
}
```

#### 客户端侧：`src/client/MiniMaxCard.tsx`（最小骨架）

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { MINMAX_STATUS_PATH } from '../status-paths.ts'
import { MINMAX_CARD_CSS } from './styles.ts'

export interface MiniMaxCardInjected {
  t: (key: string, params?: Record<string, unknown>) => string
  settingsScope?: {
    getSnapshot(): { status: string; value?: unknown; writable: boolean }
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<boolean | void>
  }
}

export type MiniMaxCardProps = Partial<MiniMaxCardInjected> & { view?: string }

interface Status { signedIn: boolean; accountName?: string; models: { id: string; name: string }[] }

export function MiniMaxCard({ t }: MiniMaxCardProps): JSX.Element {
  const [status, setStatus] = useState<Status | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const res = await fetch(MINMAX_STATUS_PATH, { headers: { accept: 'application/json' } })
      if (!res.ok) { setError(`HTTP ${res.status}`); return }
      setStatus(await res.json() as Status)
      setError(undefined)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
    timer.current = setInterval(() => { void load() }, 60_000)
    return () => { if (timer.current !== undefined) clearInterval(timer.current) }
  }, [load])

  return (
    <div className="dsm-plugin-card">
      <style>{MINMAX_CARD_CSS}</style>
      <header className="dsm-plugin-card-header">
        <span className="dsm-plugin-card-title">{t('row.title')}</span>
        <span className="dsm-plugin-card-description">{t('row.desc')}</span>
      </header>
      <div className="dsm-plugin-card-body">
        {error !== undefined && <p>{t('row.requestFailed')}</p>}
        {status === undefined
          ? <p>{t('row.loading')}</p>
          : !status.signedIn
            ? <p>{t('row.signedOutHint')}</p>
            : <ul>{status.models.map(m => <li key={m.id}>{m.name}</li>)}</ul>}
      </div>
    </div>
  )
}
```

#### 客户端侧：`src/client/locales.ts`

```ts
export const en = {
  'row.title': 'MiniMax (dsh-connect-minmax)',
  'row.desc': 'Connects your locally signed-in MiniMax models to DSH.',
  'row.loading': 'Loading…',
  'row.signedOutHint': 'Sign in once in the MiniMax app; this plugin follows that sign-in automatically.',
  'row.requestFailed': 'Request failed',
} as const

export type MiniMaxSettingsKey = keyof typeof en

export const zh: Record<MiniMaxSettingsKey, string> = {
  'row.title': 'MiniMax（dsh-connect-minmax）',
  'row.desc': '把本机登录的 MiniMax 模型接入 DSH。',
  'row.loading': '加载中…',
  'row.signedOutHint': '在 MiniMax 客户端登录一次，本插件会自动跟随该登录。',
  'row.requestFailed': '请求失败',
}
```

#### 客户端侧：`src/client/styles.ts`

抄 workbuddy 的 `dsm-*` 卡片样式系统（`docs/research/samples/` 未拷，可直接从 `../dsh-connect-workbuddy/src/client/styles.ts` 取），类名改 `dsm-minmax-*`。主题变量用 `--dsw-alias-*` 并带十六进制回退值（宿主主题切换时不会塌）。

---

## 4. 测试与质量门

### 4.1 workbuddy 的 `tests/` 目录结构

112 个文件，按类别：

| 类别 | 例子 | 测什么 |
| --- | --- | --- |
| 凭据/账号 | `auth.spec.ts`、`credential-recovery.spec.ts`、`account-pool*.spec.ts`、`transfer.spec.ts` | 读本机登录、解析、账号池 |
| 目录/模型 | `catalog.spec.ts`、`persisted-model.spec.ts`、`region.spec.ts` | 模型目录派生 |
| 协议 | `upstream.spec.ts`、`adapter.spec.ts`、`adapter-outgoing-body.spec.ts`、`issue53-sse-terminator.spec.ts` | 上游请求体、SSE 转换 |
| 宿主装配 | `web-status.spec.ts`、`settings-integration.spec.ts`、`host-peers.spec.ts`、`dsh-line.spec.ts` | 路由、设置集成、peer 边界 |
| 客户端 | `client-fallback.spec.ts`、`client-runtime-imports.spec.ts`、`client-host-contract.spec.ts`、`issue46-namespace-binding.spec.tsx`、`issue55-card-not-registered.spec.ts` | 客户端注册契约 |
| 组件渲染 | `card-panels.spec.tsx`、`pool-render.spec.tsx` 等 | jsdom 渲染 |
| 平台 | `windows-file-lock.spec.ts`、`platform-standing.spec.ts` | Windows 行为 |

**命名约定**：`issue<N>-<描述>.spec.ts` 用来钉死某个 issue 的回归。

### 4.2 vitest 关键 alias / 环境

- **环境**：全局 `environment: 'node'`；`.tsx` 组件测试在**文件头**写 `/** @vitest-environment jsdom */`。
- **jsdom** 是 devDependency，**绝不能**泄漏到断言宿主行为的测试里（会引入 `window`）。
- **没有 alias**：workbuddy/qoder/trae 的 vitest 配置里**没有 `resolve.alias`**。测试直接用相对路径 `../src/xxx.ts` 导入源码（配合 `allowImportingTsExtensions: true`）。
- **`define`**：qoder 版 vitest 配置里镜像了 tsdown 的构建期常量（workbuddy 版没有，所以它没有 `__DSH_WORKBUDDY_PACKAGE_NAME__` 这个常量）。
- **`env` / `setupFiles`**：隔离 `DSH_HOME` + 全部 home 派生路径（§1.2）。
- **`testTimeout: 30_000`**：Windows runner 冷启动余量。trae 的注释记录了实测：某个文件第一个用例 9.4s 超时，后面的用例 50–196ms——**只有每文件首个慢 = 冷启动；所有平台都变慢 = 真回归**。**不要靠放宽断言消除超时。**

### 4.3 `tsc -p tsconfig.json && tsc -p tsconfig.client.json` 的作用

**两个编译器，两套 include，是一道"两半代码都被检查过"的门。**

- `tsconfig.json`：`include: ["src","tests"]`，`exclude: ["src/client","tests/**/*.spec.tsx"]` → 检查**宿主侧**全部源码 + Node 环境测试。
- `tsconfig.client.json`：`include: ["src/client","tests/**/*.spec.tsx"]`，`lib` 加 `"dom"`、`jsx: "react-jsx"` → 检查**浏览器侧**全部源码 + DOM 环境测试。

**为什么必须两个都跑：** 宿主侧的 `include: ["src","tests"]` 虽然 exclude 了 `src/client`，但 `tests/*.spec.ts` 里可能有从 `src/client/` import 的东西（反过来，client 侧的 `tests/**/*.spec.tsx` 也 import 宿主侧的纯函数）。少跑一个，就有一半代码**从来没被类型检查过**——而且 `pnpm run build` **不会**报错（tsdown 只做转译，不做类型检查）。

**注意 `exactOptionalPropertyTypes: true`**：这是这一家代码风格的关键。它让 `{ x: undefined }` 和 `{}` 成为不同类型，逼你在可选字段上用**条件展开**而不是显式传 undefined：
```ts
{ ...opts.foo === undefined ? {} : { foo: opts.foo } }
```
workbuddy 的 `status-paths.ts` 全是这个写法。

### 4.4 CI / 发布脚本：哪些值得继承

**workbuddy 的 `scripts/`**（15 个 `.mjs`，几乎全是 `probe-*.mjs` 上游探测脚本 + `verify-*.mjs`）：

| 脚本 | 价值 | minmax 是否要 |
| --- | --- | --- |
| `probe-models.mjs` / `probe-credits.mjs` / `probe-auth.mjs` | 读本机登录、探测上游接口——**开发期自查神器** | **要**（对应 MiniMax 的登录/目录/用量探测） |
| `verify-dsml.mjs` | 上游格式异常的离线验证 | 视上游是否需要 |
| `verify-e2e.mjs` | 端到端验证 | 可选 |
| `verify-release.mjs`（**trae 有**） | **发布后一致性核验**：线上包 == tag 指向的源码？ | **强烈建议抄**（§5.4） |

**`trae/scripts/verify-release.mjs` 值得抄的三条设计**：
1. **遍历发布包全体**做 shasum 比对，而不是"我记得要核对的那几个文件"（手工清单会漏项）。
2. **先验"工作树 == tag"，再审"包 == tag"**——基准永远是 tag 指向的那棵树，不是本地 `lib/`（本地构建产物是不可信的一方）。
3. `lib/` 用**重建后比对**（因为构建产物带时间戳/随机序，可能随机红），并**如实说明**这一点。

**CI（`.github/workflows/ci.yml`，workbuddy 版）：**

```yaml
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
        with: { version: 11 }
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm run test
      - run: pnpm run build
      - run: npm pack --dry-run     # 核对打包内容
```

**minmax 起步阶段建议**：CI 矩阵先只保留 `ubuntu-latest`（Windows 支持是**长期目标**，不是第一版的目标；trae 的 DEVELOPMENT.md 把 Windows 写成"明确的长期支持目标"，并要求任何改动都考虑 Windows 影响——但不必第一版就上双矩阵）。

### 4.5 建议的最小测试集合

| 文件 | 断言什么 | 优先级 |
| --- | --- | --- |
| `tests/auth.spec.ts` | 凭据解析：文件缺失 → 未登录；token 过期 → 明确报错；加密字段 → 明确报错（**不返回残缺 token**） | P0 |
| `tests/catalog.spec.ts` | 模型目录派生：上游返回 → 归一化；上游失败 → 回落到静态目录 | P0 |
| `tests/upstream-sse.spec.ts` | SSE 转换：`data:` 行、`[DONE]` 终止符（workbuddy 有 `issue53-sse-terminator.spec.ts`）、错误事件、usage | P0 |
| `tests/adapter-outgoing-body.spec.ts` | 请求体形状（system prompt / tools 的位置取决于 pi-ai 代际） | P0 |
| `tests/web-status.spec.ts` | 路由：方法 → 405、非回环 → 403、成功 → 200 且**不含 token** | P0 |
| `tests/settings-integration.spec.ts` | 设置写入 → provider 配置可读；`enabled: false` → provider 被撤回 | P1 |
| `tests/client-runtime-imports.spec.ts` | 静态检查源码：client 的**值 import**必须都在 `CLIENT_EXTERNALS` 里；**external** 必须都在宿主 `staticModules` 注册表里 | P0（这条曾经救过 trae 的线上事故） |
| `tests/client-fallback.spec.ts` | 镜像 client 入口的 try/catch 形状（真实入口在 Node 环境下 import 不了） | P1 |
| `tests/dsh-line.spec.ts` | 所有 `dsh-*` peer 范围**完全一致**，上界带 `-0` | P1 |
| `tests/client-card-render.spec.tsx` | jsdom 挂载真实卡片组件 → 渲染出标题与"未登录"提示 | P1 |
| `tests/client-runtime-imports.spec.ts` 的负控制 | 断言 `lib/client.js` 存在且含 `window.__ModuleLoader__.load` | P2 |

**每条测试都要能独立复现。** 特别注意：任何"读本机登录"的测试都必须用 `env` 隔离（§1.2），否则会读到开发者自己的账号，在 CI 上又读不到——**同一份代码本地绿、CI 红**。

---

## 5. 命名 / 发布约定

### 5.1 包名

**建议：`dsh-connect-minmax`（不带 npm scope）。**

理由：
1. workbuddy 与 trae 都用裸名；qoder 用 `@dmh2002/dsh-connect-qoder` 并因此踩了槽位 key 的坑（§3.2）。
2. 插件页按**包名**精确匹配 `plugins.bundle.config` 的 key。裸名更短、更不容易漂。
3. `name` 同时是**浏览器 bundle 的 `PLUGIN_ID`**，也是 `exports` 的基准，改名的连锁成本高。

**必须一致的四个地方**（改名时一次全改）：
1. `package.json` 的 `name`
2. `tsdown.config.ts` 的 `PLUGIN_ID`（= `PACKAGE.name`）
3. `cordis.patch.yml` 的 `id`（= 设置命名空间 + 路由前缀，**这个改了会孤立已有配置**）
4. `src/version.ts` 的 `__DSH_MINMAX_PACKAGE_NAME__` 回落值

**`displayName`：** `DSH Connect MiniMax`。
**`description`：** 一句话讲清「读本机 MiniMax 登录 → 作为模型供应商接入 DSH，无需 API Key」。

### 5.2 版本号起点

- **建议 `0.1.0`。**
- 理由：qoder 起步 `1.7.0`（它已经迭代很久），trae `4.3.0`，workbuddy `5.2.1`——但那三个都是**已经发布并被市场收录**的成熟包。新包从 `0.1.0` 起，语义清晰：0.x = 未稳定 API。
- `version` 是**构建期注入**到 `src/version.ts` 的（`__DSH_MINMAX_VERSION__`），所以改版本号不需要改代码。

### 5.3 `awesome-dsh-plugin-submission/` 是否必需

**不必需。** 它是**本地草稿镜像**，用于向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 注册表提 PR。

- 收录规范（workbuddy 的 `awesome-dsh-plugin-submission/README.md`）：
  - 每个插件一个 YAML：`data/plugins/<owner>__<repo>.yml`
  - 字段：`url`（与仓库地址**完全一致**）、`name`（`owner/repo`）、`category`（有效值之一，如 `model`）、`description.en`（必填，一行，以句号结尾）、`description.zh`（可选）
  - 前置要求：仓库 `package.json` 声明 `dsh.bundle` manifest（**minmax 已有**）、仓库打 `dsh-plugin` topic、仓库满 1 天、提交数 ≥ 10
  - README 由脚本生成，**不要手工编辑**
  - 一个 PR 最多收录 3 条

- **建议**：第一版**先不做**。等插件在真机上跑通、README 成型后再补这个目录（10 分钟的事）。但要记住：**`dsh-plugin` topic + `dsh.bundle` manifest 是收录的前置**，topic 现在就可以打。

### 5.4 `docs/` 与 `CHANGELOG.md` 是否必需

| 文件 | 必需？ | 说明 |
| --- | --- | --- |
| `CHANGELOG.md` | **是** | `files` 白名单里有；RELEASING.md §4 要求每版在顶部新增一节 `## X.Y.Z (YYYY-MM-DD)`，按 `Features` / `Fixes` / `Docs` 分组。**从第一版就开始写**，否则以后补写极痛苦。 |
| `RELEASING.md` | **是**（可后补，但发布前必须有） | 唯一权威发布流程。§5.5 给最简版。 |
| `docs/` | 否 | workbuddy 有 18 篇（设计、取证、Windows 验证、发布经验）。**第一版不需要**；但 `docs/assets/`（截图）要在 `files` 里预留位置。 |
| `DEVELOPMENT.md` | 否（trae 有） | 开发约定 / 平台约束 / 对外发布基准。第一版可省。 |
| `THIRD_PARTY_NOTICES.md` | **是** | 致谢 workbuddy / trae / qoder（都是 MIT）+ 任何上游协议参考项目。**必须在 `files` 白名单里随包分发。** |
| `screenshots.json` | 否（收录时可能需要） | workbuddy/trae/qoder 都有。 |
| `BLUEPRINT.md` | 否（qoder 有） | 设计蓝图。 |

### 5.5 最简发布流程（参考 workbuddy 的 `RELEASING.md`，不照抄全部）

**前置**：`npm whoami` 显示你的账号；仓库 `main` 分支；`gh` 已登录且带 `repo` scope。

```bash
# 1) 确认代码、测试与版权
cd /Users/dmh2002/DshProject/dsh-connect-minmax
pnpm run check                                    # typecheck + test + build
grep -F "Copyright (c) 2026 LaoDing" LICENSE

# 2) 核对溯源与致谢（不得跳过）
grep -F "THIRD_PARTY_NOTICES.md" package.json     # 必须在 files 白名单内
grep -F "dsh-connect-workbuddy" README.md README.en.md
grep -F "dsh-connect-trae" README.md README.en.md

# 3) 核对宿主范围（peer 上界）
grep -c '">=0.1.7-rc.1 <0.3.0-0"' package.json    # 所有 dsh-* peer 数量应一致

# 4) 更新版本号 + CHANGELOG
#    手动改 package.json 的 version；CHANGELOG.md 顶部新增一节

# 5) 提交并打 annotated tag
git add package.json CHANGELOG.md README.md README.en.md THIRD_PARTY_NOTICES.md
git commit -m "chore: 版本升级至 X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话说明>"
git push origin main
git push origin vX.Y.Z

# 6) 发布到 npm（见下面的警告）
npm publish

# 7) 验证发布成功（权威判据，绕开本机代理缓存）
npm view dsh-connect-minmax --prefer-online version
curl -s --noproxy '*' -H "Cache-Control: no-cache" https://registry.npmjs.org/dsh-connect-minmax \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('latest:',j['dist-tags'].latest);console.log('published:',j.time['X.Y.Z'])})"

# 8) 创建 GitHub Release（最容易漏的一步）
gh release create vX.Y.Z \
  --title "vX.Y.Z — <一句话说明>" \
  --notes-file /tmp/release-X.Y.Z.md \
  --verify-tag
```

**四个必须知道的坑（来自 workbuddy RELEASING.md 的实操记录）：**

1. **`npm publish` 成功退出 ≠ 版本已上线。** 本账号走 **staged publishing**：registry 返回 `202 Accepted`，npm 当成功（`info ok`、exit 0），但版本只在暂存区，公开 packument 里看不到。判据：输出里**没有** `+ dsh-connect-minmax@X.Y.Z` 那一行。需要维护者带 2FA 到 npmjs.com → Staged Packages 点 Approve（或 `npm stage approve <stage-id>`，CLI ≥ 11.15.0）。**不要改版本号重发。**
2. **2FA 授权窗口只有约 5 分钟**（npm 轮询 ~92 次 ≈ 4.6 分钟后作废该 authId）。**`npm publish` 必须在交互式 TTY 终端里跑**——一旦进管道 / 重定向 / 后台任务，npm 会印出遮蔽的链接并**立刻退出**（不等待确认）。所以"AI 跑命令 → 把链接转给用户 → 用户确认"这条链路**必然赶不上**。**交给用户在自己的终端跑。**
3. **本机 `~/.npmrc` 配了本地代理**（`proxy`/`https-proxy`，端口 7897），`npm view` 与普通 `curl` 会走代理并可能读到**缓存的旧版本**，把一次成功误判为失败。**验证发布只认 `--noproxy '*'` 的直连命令。**
4. **409 的两种报文含义完全相反**：`Cannot publish over previously staged version` = 待批准未发布；`You cannot publish over the previously published versions` = **已经发布成功**。**任何时候都以第 7 步的直连核验为准。**

**另记**：npm 日志只保留 **10 份**，会静默轮转。发布当天少跑命令，尽早摘出关键证据。

---

## 6. 坑 Top 10

| # | 坑 | 后果 | 修法 |
| --- | --- | --- | --- |
| **1** | **`tsdown.config.ts` 的 `PLUGIN_ID` 不等于 `package.json` 的 `name`** | 浏览器 bundle 注册不上；重启后抛 `client-modules: duplicate factory registration for "<id>"` | `PLUGIN_ID = PACKAGE.name`（从 package.json 读，不要手写字符串）。**注意它 ≠ Loader 条目 id** |
| **2** | **`cordis.patch.yml` 的 `id` 改名** | 所有已保存配置静默孤立；`/plugins/<id>/…` 路由前缀变了 | `id` 一旦定下不可改。它同时是设置命名空间 + 路由前缀 + 槽位 key 后半段 |
| **3** | **设置命名空间写死** | 宿主按**精确匹配**查表 → provider 被判"未配置"，配置入口与模型发现双双静默失效 | 用 `ctx.fiber.entry?.options.id`，回落到声明名 |
| **4** | **`locale/*.json` 与 `src/client/locales.ts` 混淆** | 插件管理器显示的是模板文案；卡片按钮还是英文 | 前者是 JSON 文件（宿主读），后者是 `ctx.locale.register(ns, {zh, en})`（浏览器注册） |
| **5** | **`react-dom` 被 bundle** | 浏览器模块求值期抛 `process is not defined` → **整个客户端半边 import 失败**（`web boot: 1 entry did not activate`）。trae 2.12.0/2.13.0 线上事故 | `react-dom` 必须进 `CLIENT_EXTERNALS`；`tests/client-runtime-imports.spec.ts` 钉住 |
| **6** | **peer 范围上界写成 `<0.3.0`（漏 `-0`）** | DSH 全是预发布 tag，围栏**静默失效**；插件在下一个 DSH 版本落地时**整体消失**（只往 stderr 写一行） | 上界统一 `>=0.1.7-rc.1 <0.3.0-0`；`tests/dsh-line.spec.ts` 强制一致 |
| **7** | **volatile 字段当普通对象展开** | 0.1.7 的 `asVolatile()` 返回活引用 `{ get(): T }`；`{ ...ref }` 得到 `{ get: fn }`，**字段读出来是 undefined**，开关"永远显示开着" | 展开前先 `unwrapVolatileDeep()`（抄 workbuddy `status-paths.ts`） |
| **8** | **`ctx.configForms` 直接属性访问 / 写进 `inject`** | 属性访问对未声明服务**会抛**（`?.` 挡不住 throwing getter）；写进 `inject` 则该服务缺失时 **`apply` 一次都不跑** | 一律用 `ctx.get('configForms')` 软探测；`inject` 只写 `['slots','locale']` |
| **9** | **只跑 `pnpm run build`** | tsdown 只转译、**不做类型检查**；`tsconfig.client.json` 覆盖的代码**从没被检查过** | `pnpm run typecheck` = `tsc -p tsconfig.json && tsc -p tsconfig.client.json`，两个都要 |
| **10** | **`minimumReleaseAge` 没设 0** | pnpm 11 默认 24h 等待期 → CI 的 `--frozen-lockfile` 报 "lockfile contains entries that the active policies reject"，**所有后续步骤被跳过**；本地看不见（本地 `.npmrc` 设了 0） | `pnpm-workspace.yaml` 显式写 `minimumReleaseAge: 0`；CI 不用 pnpm 10 |

**次级坑（也很容易踩）：**

- **HMR 幻觉**：本 GUI 的 client HMR 需要 `pnpm run dev:web` 从 **DSH 的 checkout** 跑着，那不是 minmax 仓库。**结论：`pnpm build` + 完全重启 DSH Desktop。**
- **`files` 白名单与本地 link 安装**：本地 link 安装**不过滤** `files`；只有 npm 打包才过滤。两者行为不同，别用本地现象推断发布包。
- **keyed 槽位重复注册**：同一 key 重复 `register` 会抛；替换注册必须**先 dispose 再 register**。
- **忘记 `ctx.effect` 包住 disposer**：注册的资源会泄漏到插件卸载之后。
- **`withFileLock` / `writeFileAtomic` 的静态 import**：如果 minmax 做 CLI（`bin`），这些 peer 的静态 import 会让 `dsh plugin … exec` 直接崩（profile 是 `autoInstallPeers: false` + `nodeLinker: hoisted`，peers 根本没装）。**要么不做 CLI，要么用 `import()` 延迟加载 + 自带 fallback**（workbuddy `src/host-peers.ts` 整套机制）。**第一版强烈建议不做 CLI。**
- **`.npmrc` 入库**：可能含 `_authToken`，必须 gitignore。
- **测试污染真实 DSH home**：插件会在 `$DSH_HOME` 下写凭据副本/心跳；必须隔离 `DSH_HOME` + `HOME`/`USERPROFILE`/`LOCALAPPDATA`/`APPDATA`/`XDG_CONFIG_HOME`。

---

## 7. 附录：本次调研的只读证据

```bash
# 工具链
which node pnpm   # /opt/homebrew/Cellar/node/25.9.0_3/bin/{node,pnpm}
node -v           # v25.9.0
pnpm -v           # 10.34.5

# profile 现状（只读）
cat ~/.dsh/profiles/desktop/package.json
cat ~/.dsh/profiles/desktop/pnpm-workspace.yaml   # nodeLinker: hoisted / autoInstallPeers: false
ls -la ~/.dsh/profiles/desktop/node_modules/ | grep -E 'trae|workbuddy|qoder'   # 全是符号链接

# 宿主包 API（从已安装包的 .d.ts 读，未修改）
#   @deepseek-ai/dsh-settings@0.1.7-rc.1  → SettingsForms.configure({auto}, owner)，无 installSection
#   @deepseek-ai/dsh-client-ui-settings/client → ConfigForm.getSnapshot/subscribe/set
#   @deepseek-ai/dsh-client-ui-slots → SlotMap / LocaleNamespaceMap（空表，由宿主与插件合并）
#   @deepseek-ai/dsh-client-locale/client → ctx.locale.register(ns,{zh,en}) / bind(ns) / resolveText

# 模板拷贝（本工作区）
ls docs/research/samples/
```

**模板样本清单**（`docs/research/samples/`）：

| 文件 | 来源 |
| --- | --- |
| `package.json.workbuddy` | `dsh-connect-workbuddy/package.json` |
| `cordis.patch.yml.workbuddy` | `dsh-connect-workbuddy/cordis.patch.yml` |
| `tsdown.config.ts.workbuddy` | `dsh-connect-workbuddy/tsdown.config.ts` |
| `tsconfig.json.workbuddy` | `dsh-connect-workbuddy/tsconfig.json` |
| `tsconfig.client.json.workbuddy` | `dsh-connect-workbuddy/tsconfig.client.json` |
| `vitest.config.ts.workbuddy` | `dsh-connect-workbuddy/vitest.config.ts` |
| `locale-en.json.workbuddy` / `locale-zh.json.workbuddy` | `dsh-connect-workbuddy/locale/*.json` |
| `LICENSE.workbuddy` | `dsh-connect-workbuddy/LICENSE` |
| `gitignore.workbuddy` | `dsh-connect-workbuddy/.gitignore` |

> 这些是**研究用拷贝**，位于 `docs/research/samples/`，不参与构建（不在 `src/`、不在 `tsconfig` 的 `include` 里），不会污染后续实现路径。真正实现时应从 `../dsh-connect-workbuddy/` 与 `../dsh-connect-trae/` 直接复制到仓库根目录。
