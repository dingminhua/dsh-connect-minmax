/**
 * 构建期注入的插件版本号。
 *
 * `tsdown` 的 `define` 会把 `__DSH_CONNECT_MINMAX_VERSION__` 就地替换成
 * `package.json` 的 `version` 字面量；但源码在 vitest / tsc / 直接 `node`
 * 下也会被加载，此时这个全局并不存在。
 *
 * 用 `typeof` 判断而不是直接引用：`typeof 未声明标识符` 在 JS 里是安全操作
 * （返回 `'undefined'`），直接引用才会抛 `ReferenceError`。
 *
 * @module dsh-connect-minmax/version
 */

declare const __DSH_CONNECT_MINMAX_VERSION__: string | undefined

/** 插件版本；未经过构建注入时为 `'dev'`。 */
export const PLUGIN_VERSION: string =
  typeof __DSH_CONNECT_MINMAX_VERSION__ === 'string' && __DSH_CONNECT_MINMAX_VERSION__.length > 0
    ? __DSH_CONNECT_MINMAX_VERSION__
    : 'dev'
