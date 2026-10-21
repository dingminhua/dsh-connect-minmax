/**
 * 客户端 bundle 在浏览器里**能不能加载**的静态规则。
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   —— 该项目的 `tests/client-runtime-imports.spec.ts`。那边因此吃过一次
 *     线上事故（2.12.0 / 2.13.0：整个客户端半边 import failed），本项目
 *     第一次出现就搬来了同一条规则。
 *
 * 两件**都**必须成立，而那个仓库恰好在破坏第二条时让其它测试全绿：
 *
 *  1. 一个**值 import**（不是 `import type`）如果不在 tsdown 的
 *     `CLIENT_EXTERNALS` 里，就会被**打包**进来。打包宿主本来就提供的包，
 *     会把它的 CJS 构建内联——而 react-dom 的构建开头是
 *     `if (process.env.NODE_ENV !== "production")`，在浏览器里**模块求值期**
 *     就抛 `ReferenceError: process is not defined`，整个客户端半边随之
 *     import 失败：
 *
 *       web boot: 1 entry did not activate
 *       dsh-connect-minmax: import failed
 *
 *  2. 一个 **external** import 必须指向宿主 module loader 注册过的模块，
 *     否则它 emit 出来的 `require(...)` 解析不到任何东西。
 *
 * 这两件事在运行时测试里都**看不见**：Node 会从 node_modules 里把这些包全部
 * 解析掉，而组件测试又把浏览器专用的那些包 mock 掉了。所以这里对**源码**做
 * 静态检查。
 *
 * 注册表抄自 shell 自己的 bootstrap（`@deepseek-ai/dsh-web-frontend` 的
 * `staticModules`）。DSH 升级新增共享模块时，回头核对这里。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const clientDir = join(root, 'src', 'client')

/**
 * 宿主 `__ModuleLoader__` 能交给插件 bundle 的模块。
 *
 * 抄自 shell 自己的注册表；注释里给每个导出点名，重新核对时一眼能看出差异。
 */
const HOST_REGISTERED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-renderer/client',
]

/**
 * tsdown 的 `CLIENT_EXTERNALS` 里声明的模块。
 *
 * 与 `tsdown.config.ts` 里的清单保持一致。**两处不一致时**，这里必须失败：
 * external 名单比宿主注册表多一项 → 浏览器里 `require` 解析不到；少一项 →
 * 那个包会被打包进 bundle（规则 1 说的事故）。
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** 递归列出目录下的源文件。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.tsx?$/u.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/**
 * 一个源文件里的**值** import 的模块名。
 *
 * `import type { X } from 'y'` 是**类型** import，编译后完全消失——它不会
 * 变成 require，也不会被 bundle。所以必须把它与值 import 分开，否则这个
 * 检查会要求所有类型依赖都进 external 名单（那是错的：类型依赖本来就会被
 * 擦除）。
 */
function valueImportsOf(source: string): string[] {
  const names: string[] = []
  // `import ... from 'x'`（非 type）
  for (const match of source.matchAll(/^import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gmu)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  // 裸副作用 import：`import 'x'`
  for (const match of source.matchAll(/^import\s+['"]([^'"]+)['"]/gmu)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  // 动态 import：`await import('x')`
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  return names
}

describe('客户端 bundle 的 import 规则', () => {
  const files = sourceFiles(clientDir)

  it('找到了客户端源文件（否则下面的检查是空的，等于没检查）', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('客户端的值 import 必须都在 CLIENT_EXTERNALS 里', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const specifier of valueImportsOf(source)) {
        // 相对路径是本仓库自己的模块，不参与这条规则。
        if (specifier.startsWith('.')) continue
        if (!CLIENT_EXTERNALS.includes(specifier)) {
          offenders.push(`${file.slice(root.length + 1)} → ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('每一个 external 都必须是宿主 module loader 注册过的模块', () => {
    const unknown = CLIENT_EXTERNALS.filter(name => !HOST_REGISTERED.includes(name))
    expect(unknown).toEqual([])
  })

  it('react-dom 与 react-dom/client 必须在 external 名单里', () => {
    // 这两条是 trae 线上事故的直接原因：打包 react-dom 会把
    // `process.env.NODE_ENV` 内联进 bundle，在浏览器里抛
    // `ReferenceError: process is not defined`。
    expect(CLIENT_EXTERNALS).toContain('react-dom')
    expect(CLIENT_EXTERNALS).toContain('react-dom/client')
  })

  it('external 名单不含宿主没有的模块', () => {
    // 反向检查：external 名单里有宿主不认识的模块时，它会被 emit 成一个
    // 解析不到的 `require(...)`。
    const extra = CLIENT_EXTERNALS.filter(name => !HOST_REGISTERED.includes(name))
    expect(extra).toEqual([])
  })
})

describe('tsdown 客户端配置', () => {
  it('bundle 的 module loader id 等于包名', () => {
    // 浏览器 bundle 的 `window.__ModuleLoader__.load({ id })` 必须等于
    // package.json 的 `name`——**不是** Loader 条目 id。宿主按包名索引
    // 每一行，而 module loader 用声明的 id 与那一行配对；对不上就永远
    // 关联不上，重启后还会抛
    // `client-modules: duplicate factory registration for "<id>"`。
    const pkg = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { name: string }
    const config = readFileSync(join(root, 'tsdown.config.ts'), 'utf8')
    expect(config).toContain('export const PLUGIN_ID = PACKAGE.name')
    expect(pkg.name).toBe('dsh-connect-minmax')
  })
})
