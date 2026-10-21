import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 测试绝不能碰真实的 DSH home，也不能碰用户真实的 `~/.minimax`。
 *
 * 本插件会读本机 MiniMax Code 的登录态（`~/.minimax/**`）。若测试直接读
 * 开发者自己的登录目录，一份在开发者机器上能过的测试会在 CI 上失败（那里
 * 没有登录态），反过来也会在有登录态的机器上读到真实 token。
 *
 * 所以 home 派生出的所有路径都被隔离到一个临时目录：`HOME` / `USERPROFILE`
 * 覆盖 `os.homedir()`（POSIX vs Windows），`LOCALAPPDATA` / `APPDATA` 覆盖
 * Windows 分支，`XDG_CONFIG_HOME` 覆盖 Linux 分支，`DSH_MINIMAX_DATA_DIR`
 * 直接指向插件自己的凭据根目录。
 */
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-connect-minmax-test-'))

const isolatedEnv = {
  DSH_HOME: isolatedHome,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  LOCALAPPDATA: join(isolatedHome, 'AppData', 'Local'),
  APPDATA: join(isolatedHome, 'AppData', 'Roaming'),
  XDG_CONFIG_HOME: join(isolatedHome, '.config'),
  // 插件自己的凭据根目录（`MiniMaxAuth` 认这个环境变量）。
  DSH_MINIMAX_DATA_DIR: join(isolatedHome, '.minimax'),
}

/**
 * Mirror the build-time constants `tsdown.config.ts` injects, read from the same
 * `package.json`.
 *
 * Without this the browser half would fall back to its literal default under
 * test — and a test asserting the configuration-slot keys would then happily
 * pass against a name that no longer matches the installed package, which is
 * precisely the failure mode this guards (the card rendered nothing because its
 * slots were keyed by a stale name).
 */
const PACKAGE = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string, version: string }

export default defineConfig({
  define: {
    __DSH_CONNECT_MINMAX_VERSION__: JSON.stringify(PACKAGE.version),
    __DSH_CONNECT_MINMAX_PACKAGE_NAME__: JSON.stringify(PACKAGE.name),
  },
  test: {
    // `.tsx` entries are component tests that mount the real card under jsdom.
    // They opt into the DOM via a `@vitest-environment jsdom` docblock so every
    // other file stays on the plain node environment — jsdom is a dev-only
    // dependency and must never leak a `window` into tests that assert
    // host-side behaviour.
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    env: isolatedEnv,
    testTimeout: 30_000,
  },
})
