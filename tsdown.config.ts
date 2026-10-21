import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

/**
 * Read the package identity once. Both the browser bundle's module id and the
 * injected version derive from it, so a rename cannot leave one of them behind.
 */
const PACKAGE = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string, version: string }

/**
 * The browser bundle's `window.__ModuleLoader__` id.
 *
 * **It must equal `package.json` `name`** — NOT the Loader entry id. The shell's
 * client module roster keys every row by the package name it reads out of the
 * package manifest, and the module loader pairs a bundle's *declared* id with
 * that row to remember its revision and to invalidate it on rebuild. Declare
 * anything else and the registration can never be tied back to its row.
 *
 * The Loader entry id (`cordis.patch.yml`'s `id:`) is a DIFFERENT, deliberately
 * stable identifier: it backs the settings namespace and the `/plugins/<id>/…`
 * routes.
 */
export const PLUGIN_ID = PACKAGE.name

/**
 * Build-time constants injected into the source (`src/version.ts`).
 *
 * The **package name** is injected alongside the version because the browser
 * half needs it as a runtime string: the plugin manager keys the configuration
 * slots by package name (`plugins.bundle.config`). Hardcoding a stale alias
 * there makes the card render nothing on the bundle's page — the plugin shows
 * up as running, with its description and rows, but no configuration body.
 */
const BUILD_DEFINE = {
  __DSH_CONNECT_MINMAX_VERSION__: JSON.stringify(PACKAGE.version),
  __DSH_CONNECT_MINMAX_PACKAGE_NAME__: JSON.stringify(PLUGIN_ID),
}

/**
 * Client-side packages must stay external: the shell registers them in its
 * module loader. Bundling `react-dom` inlines CJS builds that throw
 * `process is not defined` at module-evaluation time in the browser.
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
] as const

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    define: BUILD_DEFINE,
    deps: {
      /**
       * Every host package stays external so the plugin borrows the DSH
       * installation's copies instead of carrying its own.
       */
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-attachment',
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
    dts: false,
    clean: false,
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
