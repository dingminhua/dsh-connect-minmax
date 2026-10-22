/**
 * MiniMax 状态卡片，贡献给 Harness 的插件配置页。
 *
 * # 形态
 *
 * 顶部两个**区域 tab**（国内版 / 国际版）——每个 tab 是一个独立供应商，可以单独
 * 关掉；下面三个**子页**：
 *
 *  - **账号**：本机登录态、账号副本、积分余额与到期、七天一签；
 *  - **模型**：全目录勾选启用、逐模型测试、长上下文档位；
 *  - **诊断**：这张卡片实际读到了什么（只读，没有任何会改动设置的控件）。
 *
 * 之所以是这个形态而不是"一张表平铺两条路由"：两个区域是**两个独立供应商**，
 * 各有各的凭据、积分与登录态，用户关心的问题是"这一侧现在怎么样"，把它们塞进
 * 同一张表就丢掉了这个语义。
 *
 * # 可写与不可写
 *
 * 卡片能写的只有 `Config` 里早就存在的三个字段（`models` / `regions` /
 * `longContext`），见 `settings.ts`。**没有 API Key 输入项**，也永远不会加：
 * 凭据只来自本机 MiniMax Code 的登录态，这一点在账号页明写出来。
 *
 * 没有 `settingsScope`（旧宿主 / 非设置页挂载）时整张卡片退化成只读，控件禁用
 * 并说明原因——而不是假装能保存。
 *
 * # 数据来源
 *
 * 宿主的 `/plugins/dsh-connect-minmax/status`（同源），10 秒轮询一次，且**只在
 * 页面可见时**轮询：后台标签页里的定时器不产生收益，还会让人以为插件在偷跑。
 *
 * 参考：dingminhua/dsh-connect-workbuddy 与 dsh-connect-qoder（MIT，
 * Copyright (c) 2026 LaoDing）—— 卡片外壳、模块加载时注入一次 `<style>`、
 * 轮询与 AbortController 清理、区域 tab + 子页的布局均来自这两个项目。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

/** 仓库地址：底部「鼓励一下」指向它。 */
const MINIMAX_REPO_URL = 'https://github.com/dingminhua/dsh-connect-minmax'

import {
  durationPartsOf,
  expiryBucketOf,
  formatContextWindow,
  MINIMAX_ACCOUNT_REMOVE_PATH,
  MINIMAX_ACCOUNT_MOVE_PATH,
  MINIMAX_ACCOUNT_REFRESH_PATH,
  MINIMAX_ACCOUNT_SELECT_PATH,
  MINIMAX_ACCOUNT_TRANSFER_PATH,
  MINIMAX_CARD_KEYS,
  MINIMAX_MODEL_TEST_PATH,
  MINIMAX_SIGNIN_CLAIM_PATH,
  MINIMAX_STATUS_PATH,
  toStatusView,
} from '../status-paths.ts'
import type {
  MiniMaxCreditsView,
  MiniMaxLoginState,
  MiniMaxLoginView,
  MiniMaxModelView,
  MiniMaxPoolEntryView,
  MiniMaxPoolView,
  MiniMaxRouteView,
  MiniMaxSigninView,
  MiniMaxStatusView,
  MiniMaxTransferPreviewEntryView,
} from '../status-paths.ts'
import { MINIMAX_CARD_CSS } from './styles.ts'
import type { MiniMaxSettingsScope } from './settings.ts'
import {
  toggleRegion,
  writeLongContext,
  writeModelContextWindow,
  writeModelImages,
  writeModelThinkingOff,
  writeModels,
  writePoolDisabled,
  writeReasoningEffort,
  writeRegions,
} from './settings.ts'

/** 轮询间隔（毫秒）。 */
export const MINIMAX_POLL_INTERVAL_MS = 10_000

/** 注入到卡片的文案函数。 */
export type MiniMaxTranslate = (key: string, params?: Record<string, unknown>) => string

/** 卡片由浏览器插件注册时注入的面。 */
export interface MiniMaxCardInjected {
  t: MiniMaxTranslate
  /**
   * 设置写入面。**可选是刻意的**：没有它的宿主线路上卡片退化成只读，
   * 保存是唯一需要它的功能。
   */
  settingsScope?: MiniMaxSettingsScope
}

/** 卡片 props。`view` 是宿主给的页面形态（'summary' | 'page'）。 */
export type MiniMaxCardProps = Partial<MiniMaxCardInjected>

/** 注入或刷新这张卡片的共享 CSS。 */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-connect-minmax/client.css'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${cssId}"]`)
  if (existing !== null) {
    existing.textContent = MINIMAX_CARD_CSS
  } else {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-connect-minmax'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = MINIMAX_CARD_CSS
    document.head.appendChild(styleTag)
  }
}

/** 登录态的视觉分档：颜色只回答"能不能用"。 */
export type MiniMaxBadgeTone = 'ready' | 'warn' | 'error' | 'unknown'

/** 子页标识。 */
export type MiniMaxPanelKey = 'account' | 'models' | 'diagnostics'

/**
 * 登录态 → 徽标分档。
 *
 * `ready` 绿；`anonymous` / `missing` 琥珀（用户能做点什么：打开并登录）；
 * `expired` 琥珀（同样要重新登录）；`error` 红（出错了）。
 *
 * 单独一个函数是为了让它**可单测**：这个映射错了，卡片就会把"没登录"显示成
 * 红色的故障。
 */
export function badgeToneOf(state: MiniMaxLoginView['state']): MiniMaxBadgeTone {
  switch (state) {
    case 'ready': return 'ready'
    case 'authorizing': return 'warn'
    case 'anonymous':
    case 'missing':
    case 'expired': return 'warn'
    case 'error': return 'error'
  }
}

/**
 * 登录态 → 一句话"你需要做什么"。
 *
 * 这是这张卡片最重要的一行：用户来这里是为了知道**下一步做什么**，而不是
 * 看到一个状态码。所以每一种状态都给出一句可执行的建议：
 *
 *  - `ready` + lease → 凭据由 MiniMax Code 提供并自动续期；
 *  - `ready` + file  → MiniMax Code 没在运行，用的是本地凭据文件的副本；
 *  - `anonymous` / `missing` → 去 MiniMax Code 登录；
 *  - `expired`        → 去 MiniMax Code 重新登录；
 *  - `error`          → 显示宿主给的 `detail`。
 */
export function loginAdviceOf(
  login: MiniMaxLoginView,
  t: MiniMaxTranslate,
): string {
  switch (login.state) {
    case 'ready':
      return login.source === 'lease'
        ? t('advice.readyLease')
        : t('advice.readyFile')
    case 'authorizing':
      return t('advice.authorizing')
    case 'anonymous':
    case 'missing':
      return t('advice.signInRequired')
    case 'expired':
      return t('advice.expired')
    case 'error':
      return login.detail ?? t('login.error')
  }
}

/** 凭据来源 → 文案键。 */
export function sourceLabelKeyOf(source: MiniMaxLoginView['source']): string {
  switch (source) {
    case 'lease': return 'login.sourceLease'
    case 'file': return 'login.sourceFile'
    case 'none': return 'login.sourceNone'
  }
}

/**
 * 登录态的**严重程度**排序（数字越大越严重）。
 *
 * 顶部那个汇总徽标回答的是"整体能不能用"，所以它必须挑出最严重的那条
 * 路由：一条路由出错时，不能因为另一条已经就绪就把错误盖住。
 *
 * 排序：`error` > `expired` > `missing` / `anonymous` > `authorizing`。
 * `authorizing` 最轻——它不是故障，而是"还差一次点击"。
 */
const LOGIN_SEVERITY: Record<MiniMaxLoginState, number> = {
  error: 4,
  expired: 3,
  missing: 2,
  anonymous: 2,
  authorizing: 1,
  ready: 0,
}

/**
 * 一组登录态里最严重的那个。
 *
 * 全部为空时返回 `undefined`（卡片据此显示"读取中"）。
 */
export function worstLoginStateOf(states: MiniMaxLoginState[]): MiniMaxLoginState | undefined {
  let worst: MiniMaxLoginState | undefined
  for (const state of states) {
    if (worst === undefined || LOGIN_SEVERITY[state] > LOGIN_SEVERITY[worst]) {
      worst = state
    }
  }
  return worst
}

/**
 * 汇总徽标的色调。
 *
 * **任一路由就绪就是绿色**——至少有一条路由能用，用户就能开工了；否则取最
 * 严重的那条路由的色调。
 */
export function aggregateBadgeToneOf(routes: MiniMaxRouteView[]): MiniMaxBadgeTone {
  if (routes.length === 0) return 'unknown'
  if (routes.some(route => route.login.state === 'ready')) return 'ready'
  const worst = worstLoginStateOf(routes.map(route => route.login.state))
  return worst === undefined ? 'unknown' : badgeToneOf(worst)
}

/**
 * 汇总徽标上的**文字**键。
 *
 * 三种情形：全就绪、只就绪一部分（另有未就绪的）、全未就绪。第三种沿用
 * `login.*` 的状态名——那条最严重的路由是什么状态，徽标就写什么状态。
 */
export function aggregateLabelKeyOf(
  routes: MiniMaxRouteView[],
  loading: boolean,
): string {
  if (loading || routes.length === 0) return 'row.loading'
  const ready = routes.filter(route => route.login.state === 'ready').length
  if (ready === routes.length) return 'routes.allReady'
  if (ready > 0) return 'routes.anyReady'
  const worst = worstLoginStateOf(routes.map(route => route.login.state))
  return worst === undefined ? 'row.loading' : `login.${worst}`
}

/**
 * 卡片上**实际要渲染的路由列表**。
 *
 * 旧版本的应答没有 `routes` 字段（收窄后是空数组）。那时**不能白屏**，也不能
 * 什么都不显示：顶层字段本来就是第一条路由的镜像，所以用它们合成一条
 * `minimax`（国内版）路由，退化成**单路由**渲染。
 */
export function effectiveRoutesOf(status: MiniMaxStatusView): MiniMaxRouteView[] {
  if (status.routes.length > 0) return status.routes
  return [{
    route: status.route,
    region: status.region,
    regionLabel: status.regionLabel,
    baseUrl: status.baseUrl,
    login: status.login,
  }]
}

/**
 * 路由名 → 供应商显示名。
 *
 * `minimax` → `MiniMax`，`minimax-global` → `MiniMax Global`。不认识的路
 * 由名原样显示（不要凭空编一个名字）。
 */
export function providerLabelOf(route: string, t: MiniMaxTranslate): string {
  switch (route) {
    case 'minimax': return t('provider.minimax')
    case 'minimax-global': return t('provider.minimaxGlobal')
    default: return route
  }
}

/**
 * 这条路由是不是**账号副本**（插件自己续期的旧账号）。
 *
 * 判据只有一个：宿主在副本路由上透传 `accountId`，本机登录没有这个字段。
 * 所以认 `accountId`，**不去解析路由名的形状** —— 路由名是宿主那边的命名
 * 约定（`minimax-<region>-<短 id>`），改名的权利在宿主，而 `accountId` 的
 * 存在与否是这份契约里唯一的判据。
 */
export function isCopyRoute(route: MiniMaxRouteView): boolean {
  return route.accountId !== undefined
}

/** 取一个 id 最后一段 `-` 分隔的非空片段。 */
function lastDashSegment(value: string): string | undefined {
  const parts = value.split('-')
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part !== undefined && part !== '') return part
  }
  return undefined
}

/**
 * 副本的**短 id**：`minimax-cn-cfd703e1` → `cfd703e1`。本机登录 → undefined。
 *
 * 副本 id 形如 `cn-cfd703e1`（区域 + 登录指纹前 8 位），取最后一段就足够区分
 * 同一区域里的两个账号。最后一段退化成像区域名（`cn` / `global`）时宁可显示
 * 整个 id：一个和区域列重复的"短 id"没有任何区分度，只会让人以为读错了列。
 */
export function copyLabelOf(route: MiniMaxRouteView): string | undefined {
  const accountId = route.accountId
  if (accountId === undefined) return undefined
  const short = lastDashSegment(accountId) ?? lastDashSegment(route.route)
  if (short !== undefined && short !== 'cn' && short !== 'global') return short
  return accountId === '' ? route.route : accountId
}

/**
 * 「路由」表里**供应商列**要显示的名字。
 *
 * 本机登录沿用 {@link providerLabelOf}；副本带上 `副本 · <短 id>`，因为模型
 * 选择器里那是第三个分组，用户必须能一眼看出它是**谁的**账号。
 */
export function routeProviderLabelOf(route: MiniMaxRouteView, t: MiniMaxTranslate): string {
  const label = copyLabelOf(route)
  if (label === undefined) return providerLabelOf(route.route, t)
  return t(route.region === 'global' ? 'provider.minimaxGlobalCopy' : 'provider.minimaxCopy', { label })
}

/**
 * 一条路由的"你需要做什么"。
 *
 * 与顶层的 {@link loginAdviceOf} 同一套逻辑，但**区分区域**：国内版与国际版
 * 是两个不同的账号，"去登录"要说清是去登录哪个。
 *
 * 副本要单独走一条岔路，理由正是这张卡片最要紧的那件事——**下一步做什么**：
 * 副本早就不在 MiniMax Code 手里了，过期时叫用户"去 MiniMax Code 重新登录"
 * 会把人支到别处去（该刷新的插件自己会刷，只有刷新凭据作废时才真的要重新登录）：
 *  - 副本 + `expired`（无 detail）→ token 过期但还能续，刷新这张卡片即可；
 *  - 副本 + `expired` + `detail` → 刷新凭据已作废，插件续不动，只能重新登录
 *    该账号让插件重新镜像一份新副本。
 * 副本就绪时**不给建议语**：卡片只为未就绪的路由画建议行，就绪副本在表里
 * 已经有「副本 · <短 id>」的供应商名与角标，再加一句废话只会稀释重点。
 */
export function routeAdviceOf(route: MiniMaxRouteView, t: MiniMaxTranslate): string {
  const region = route.region === 'global' ? 'global' : 'cn'
  const label = copyLabelOf(route)
  if (label !== undefined && route.login.state === 'expired') {
    return t(route.login.detail === undefined ? 'advice.copy.expired' : 'advice.copy.expiredDead', { label })
  }
  switch (route.login.state) {
    case 'ready':
      return route.login.source === 'lease'
        ? t('advice.readyLease')
        : t('advice.readyFile')
    case 'authorizing':
      return t(`advice.${region}.authorizing`)
    case 'anonymous':
    case 'missing':
      return t(`advice.${region}.signInRequired`)
    case 'expired':
      return t(`advice.${region}.expired`)
    case 'error':
      return route.login.detail ?? t('login.error')
  }
}

/** 到期时间的展示文本。`undefined` → "未知"。 */
export function expiryTextOf(
  login: MiniMaxLoginView,
  nowMs: number,
  t: MiniMaxTranslate,
): string {
  if (login.expiresAtMs === undefined) return t('login.expiresUnknown')
  const bucket = expiryBucketOf(login.expiresAtMs - nowMs)
  switch (bucket) {
    case 'expired': return t('login.expiredAgo')
    case 'unknown': return t('login.expiresUnknown')
    case 'minutes': {
      const parts = durationPartsOf(Math.max(0, login.expiresAtMs - nowMs))
      return t('login.inMinutes', { count: parts.value })
    }
    case 'hours': {
      const parts = durationPartsOf(Math.max(0, login.expiresAtMs - nowMs))
      return t('login.inHours', { count: parts.value })
    }
    case 'days': {
      const parts = durationPartsOf(Math.max(0, login.expiresAtMs - nowMs))
      return t('login.inDays', { count: parts.value })
    }
  }
}

export function isRegionEnabled(status: MiniMaxStatusView, region: string): boolean {
  return status.enabledRegions.includes(region)
}

export function routesForRegion(
  routes: readonly MiniMaxRouteView[],
  region: string,
): MiniMaxRouteView[] {
  const owned = routes.filter(route => route.region === region)
  const live = owned.filter(route => !isCopyRoute(route))
  const copies = owned.filter(route => isCopyRoute(route))
  return [...live, ...copies]
}

export const MINIMAX_REGIONS = ['cn', 'global'] as const

export function creditsTextOf(
  credits: MiniMaxCreditsView | undefined,
  t: MiniMaxTranslate,
): string {
  if (credits?.balance === undefined) {
    return credits?.error ?? t('credits.unavailable')
  }
  return `${formatCredits(credits.balance.totalRemaining)} ${t('credits.unit')}`
}

export function formatCredits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

export function expirySummaryTextOf(
  credits: MiniMaxCreditsView | undefined,
  nowMs: number,
  t: MiniMaxTranslate,
): string {
  if (credits === undefined) return t('credits.unavailable')
  if (credits.error !== undefined && credits.balance === undefined) return credits.error
  const bits: string[] = []
  if (credits.earliestExpiryMs !== undefined) {
    const days = Math.max(0, Math.ceil((credits.earliestExpiryMs - nowMs) / 86_400_000))
    bits.push(t('credits.expiresIn', { days }))
  }
  if ((credits.expiringIn30d ?? 0) > 0) {
    bits.push(t('credits.expiring30', { amount: formatCredits(credits.expiringIn30d ?? 0) }))
  }
  if (credits.lotCount !== undefined) bits.push(t('credits.lots', { count: credits.lotCount }))
  return bits.length === 0 ? t('credits.noLots') : bits.join(' · ')
}

export function signinDayToneOf(day: { status: number }): 'claimed' | 'claimable' | 'upcoming' {
  if (day.status === 3) return 'claimed'
  if (day.status === 2) return 'claimable'
  return 'upcoming'
}

/**
 * 诊断页的"积分读取于"一行。
 *
 * 读不到时也要说清楚**为什么**读不到（上游错误原文），否则这一行只会显示
 * "不可用"，用户和排查的人都无从判断是没登录、令牌过期还是上游挂了。
 */
export function creditsFactOf(
  credits: MiniMaxCreditsView | undefined,
  fallbackAtMs: number,
  t: MiniMaxTranslate,
): string {
  if (credits === undefined) return t('credits.unavailable')
  if (credits.balance === undefined) return credits.error ?? t('credits.unavailable')
  const at = new Date(credits.atMs ?? fallbackAtMs).toLocaleString()
  return `${creditsTextOf(credits, t)} · ${t('diagnostics.readAt', { at })}`
}

/**
 * 算出勾选某个模型之后的启用列表。
 *
 * 返回 `null` 表示这次操作会把模型关到零个——那不是"用户想要的状态"，而是
 * 插件把自己关没了（模型选择器里会一个 MiniMax 都不剩）。
 *
 * 落盘时按**目录顺序**过滤：`selectModels` 会保留配置里的顺序，用户点两下
 * 就让模型选择器里的顺序抖一次是很烦人的。另外"全选了"会归一成空列表，
 * 让上游以后新增的模型自动可见。
 */
export function nextModelSelection(
  status: MiniMaxStatusView,
  modelId: string,
  enabled: boolean,
): string[] | null {
  const catalog = status.catalog.map(model => model.id)
  // 空配置 = 全部启用，所以当前集合要从目录取，不能从 models 取（那是空的）。
  const all = new Set(status.models.length === 0 ? catalog : status.models.map(model => model.id))
  if (enabled) all.add(modelId)
  else {
    if (all.size <= 1) return null
    all.delete(modelId)
  }
  const next = catalog.filter(id => all.has(id))
  return next.length === catalog.length ? [] : next
}

/** 一行"键：值"。 */
function fact(key: string, value: ReactElement | string): ReactElement {
  return (
    <>
      <dt className="dsm-minimax-fact-key">{key}</dt>
      <dd className="dsm-minimax-fact-value">{value}</dd>
    </>
  )
}

/**
 * 取一次状态。
 *
 * 非 200、JSON 解析失败、网络错误——**一律**变成一个"读不到"的结果，而不是
 * 一个抛出的异常：卡片是这个插件在页面上的全部存在，它崩了等于插件没有界面，
 * 而宿主那边模型照样能用。
 */
export async function fetchMiniMaxStatus(signal?: AbortSignal): Promise<MiniMaxStatusView> {
  const response = await fetch(MINIMAX_STATUS_PATH, {
    method: 'GET',
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('the status route did not answer JSON')
  }
  return toStatusView(payload)
}

/**
 * 打一个动作接口。
 *
 * 动作接口都是宿主侧的 loopback-only POST；这里只负责"发出去 + 把话带回来"，
 * 失败一律变成一行提示，不抛异常（卡片不该因为一次点击失败而白屏）。
 */
/** 同 postAction，但把应答 body 原样带回来（传输/批量动作要读 results）。 */
async function postActionJson(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean, message: string, body: Record<string, unknown> }> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { ok: false, message: `HTTP ${response.status}`, body: {} }
    }
    const record = (typeof payload === 'object' && payload !== null && !Array.isArray(payload))
      ? payload as Record<string, unknown>
      : {}
    return { ok: response.ok && record['ok'] !== false, message: typeof record['error'] === 'string' ? record['error'] : '', body: record }
  } catch (caught: unknown) {
    return { ok: false, message: caught instanceof Error ? caught.message : String(caught), body: {} }
  }
}

async function postAction(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean, message: string }> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { ok: false, message: `HTTP ${response.status}` }
    }
    const record = (typeof payload === 'object' && payload !== null && !Array.isArray(payload))
      ? payload as Record<string, unknown>
      : {}
    const ok = response.ok && record['ok'] !== false
    const message = typeof record['message'] === 'string'
      ? record['message']
      : typeof record['error'] === 'string'
        ? record['error']
        : ok ? 'ok' : `HTTP ${response.status}`
    return { ok, message }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 模型测试的一条结果。 */
interface ModelProbe {
  busy: boolean
  ok?: boolean
  detail?: string
}

/**
 * 区域 tab 条。
 *
 * 每个 tab 是一个**独立供应商**：绿点回答"这一侧能不能用"，复选框回答"这一侧
 * 要不要注册"。两边可以同时开着，不同会话各选各的。
 */
function RegionTabs(props: {
  status: MiniMaxStatusView | undefined
  active: string
  onSelect(region: string): void
  onToggle(region: string): void
  canWrite: boolean
  busyRegion: string | undefined
  t: MiniMaxTranslate
}): ReactElement {
  const { status, active, onSelect, onToggle, canWrite, busyRegion, t } = props
  return (
    <div className="dsm-minimax-tabs" role="tablist">
      {MINIMAX_REGIONS.map(region => {
        const routes = status === undefined ? [] : routesForRegion(effectiveRoutesOf(status), region)
        const enabled = status === undefined || isRegionEnabled(status, region)
        const tone = enabled
          ? aggregateBadgeToneOf(routes)
          : 'unknown'
        return (
          <div
            key={region}
            className={`dsm-minimax-tab${active === region ? ' dsm-minimax-tab-on' : ''}${enabled ? '' : ' dsm-minimax-tab-off'}`}
            role="tab"
            aria-selected={active === region}
          >
            <button
              type="button"
              className="dsm-minimax-tab-label"
              onClick={() => { onSelect(region) }}
            >
              <span className={`dsm-minimax-dot dsm-minimax-dot-${tone}`} />
              {t(region === 'global' ? 'region.global' : 'region.cn')}
            </button>
            <label
              className="dsm-minimax-tab-switch"
              title={canWrite ? t('region.toggleHint') : t('settings.readOnly')}
            >
              <input
                type="checkbox"
                checked={enabled}
                disabled={!canWrite || busyRegion === region}
                onChange={() => { onToggle(region) }}
              />
            </label>
          </div>
        )
      })}
    </div>
  )
}

/** 子页 tab 条。 */
function PanelTabs(props: {
  active: MiniMaxPanelKey
  onSelect(panel: MiniMaxPanelKey): void
  t: MiniMaxTranslate
}): ReactElement {
  const { active, onSelect, t } = props
  const panels: MiniMaxPanelKey[] = ['account', 'models', 'diagnostics']
  return (
    <div className="dsm-minimax-subtabs" role="tablist">
      {panels.map(panel => (
        <button
          key={panel}
          type="button"
          role="tab"
          aria-selected={active === panel}
          className={`dsm-minimax-subtab${active === panel ? ' dsm-minimax-subtab-on' : ''}`}
          onClick={() => { onSelect(panel) }}
        >
          {t(`panel.${panel}`)}
        </button>
      ))}
    </div>
  )
}

/**
 * 账号池表格：勾选、优先级、积分、状态、签到、批量动作、导入导出。
 *
 * 布局照 workbuddy 的池表格（账号 / 积分 / 状态 / 签到 四列 + 行尾动作），
 * 但每一格都只放**真读到的**数据：积分来自 get_membership_info，签到来自
 * signin/status，"测得 x 前"来自状态里的 checkedAt。没有的就不画，不编。
 *
 * 表格与批量动作只在真"池"（>1 个账号）时画；传输区（导入/导出）永远画——
 * 单账号也有"把这个号搬到另一台机器"的需求。
 */
function PoolTable(props: {
  pool: MiniMaxPoolView
  routes: MiniMaxRouteView[]
  region: string
  nowMs: number
  busy: boolean
  t: MiniMaxTranslate
  onSelectAccount(id: string): void
  onDelete(route: MiniMaxRouteView): void
  onTest(route: string): void
  onClaim(ids: readonly string[]): void
  onMove(id: string, direction: 'up' | 'down'): void
  /** 写入"不参与换号/批量动作"的账号 id 列表（复选框是持久化开关）。 */
  onParticipate(ids: readonly string[]): void
}): ReactElement {
  const {
    pool, routes, region, nowMs, busy, t,
    onSelectAccount, onDelete, onTest, onClaim, onMove, onParticipate,
  } = props
  /**
   * 复选框 = **参与开关**（持久化），不是临时勾选：workbuddy 表头那句
   * "只有勾选的账号参与轮换、签到与测试"就是这个语义。批量动作与导出都
   * 跟着勾选走，所以不需要第二套选择状态。
   */
  const participating = new Set(pool.accounts.filter(entry => entry.participates !== false).map(entry => entry.id))
  const [transfer, setTransfer] = useState<{
    phase: 'idle' | 'preview' | 'busy'
    preview?: MiniMaxTransferPreviewEntryView[]
    raw?: string
    picked?: Set<string>
    note?: string
  }>({ phase: 'idle' })
  const fileRef = useRef<HTMLInputElement>(null)
  const isPool = pool.accounts.length > 1

  const routeOf = (entry: MiniMaxPoolEntryView): MiniMaxRouteView | undefined =>
    routes.find(route => (entry.live ? !isCopyRoute(route) : route.accountId === entry.id))

  const selectedIds = pool.accounts.filter(entry => participating.has(entry.id)).map(entry => entry.id)
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(participating)
    if (on) next.add(id)
    else next.delete(id)
    onParticipate(pool.accounts.filter(entry => next.has(entry.id)).map(entry => entry.id))
  }

  const doExport = async (): Promise<void> => {
    setTransfer(state => ({ ...state, phase: 'busy' }))
    const outcome = await postActionJson(MINIMAX_ACCOUNT_TRANSFER_PATH, { action: 'export', accountIds: selectedIds })
    if (!outcome.ok) {
      setTransfer({ phase: 'idle', note: outcome.message })
      return
    }
    // 下载：卡片在设置页 iframe 里，a[download] 同源下载是沙箱内最可靠的方式。
    const blob = new Blob([JSON.stringify(outcome.body['file'], undefined, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `minimax-accounts-${region}-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setTransfer({ phase: 'idle', note: t('pool.exportHint') })
  }

  const doPreview = async (file: File): Promise<void> => {
    const raw = await file.text()
    setTransfer(state => ({ ...state, phase: 'busy' }))
    const outcome = await postActionJson(MINIMAX_ACCOUNT_TRANSFER_PATH, { action: 'preview', file: raw })
    if (!outcome.ok || !Array.isArray(outcome.body['preview'])) {
      setTransfer({ phase: 'idle', note: t('pool.transferBadFile') })
      return
    }
    const preview = outcome.body['preview'] as MiniMaxTransferPreviewEntryView[]
    setTransfer({
      phase: 'preview',
      raw,
      preview,
      picked: new Set(preview.filter(entry => !entry.duplicate && entry.hasToken).map(entry => entry.id)),
    })
  }

  const doImport = async (): Promise<void> => {
    if (transfer.raw === undefined || transfer.picked === undefined) return
    setTransfer(state => ({ ...state, phase: 'busy' }))
    const outcome = await postActionJson(MINIMAX_ACCOUNT_TRANSFER_PATH, {
      action: 'import',
      file: transfer.raw,
      accountIds: [...transfer.picked],
    })
    const added = Array.isArray(outcome.body['added']) ? (outcome.body['added'] as unknown[]).length : 0
    const skipped = Array.isArray(outcome.body['skipped']) ? (outcome.body['skipped'] as unknown[]).length : 0
    setTransfer({ phase: 'idle', note: outcome.ok ? t('pool.imported', { added, skipped }) : outcome.message })
  }

  return (
    <div className="dsm-minimax-pool">
      {isPool && (
        <>
          <div className="dsm-minimax-panel-head">
            <div>
              <div className="dsm-minimax-panel-title">{t('pool.title')}</div>
              <div className="dsm-minimax-hint">{t('pool.hint')}</div>
            </div>
            <div className="dsm-minimax-panel-actions">
              <span className="dsm-minimax-hint">
                {t('pool.selected', { done: selectedIds.length, total: pool.accounts.length })}
              </span>
              <button
                type="button"
                className="dsm-minimax-btn dsm-minimax-btn-ghost"
                disabled={busy}
                onClick={() => { onParticipate(pool.accounts.map(entry => entry.id)) }}
              >
                {t('pool.selectAll')}
              </button>
              <button
                type="button"
                className="dsm-minimax-btn dsm-minimax-btn-ghost"
                disabled={busy}
                onClick={() => { onParticipate([]) }}
              >
                {t('pool.selectNone')}
              </button>
            </div>
          </div>

          <div className="dsm-minimax-pool-actions">
            <button
              type="button"
              className="dsm-minimax-btn dsm-minimax-btn-primary"
              disabled={busy || selectedIds.length === 0}
              onClick={() => { onClaim(selectedIds) }}
            >
              {t('pool.claimSelected')}
            </button>
            <button
              type="button"
              className="dsm-minimax-btn dsm-minimax-btn-outline"
              disabled={busy || selectedIds.length === 0}
              onClick={() => {
                for (const id of selectedIds) {
                  const entry = pool.accounts.find(item => item.id === id)
                  const route = entry === undefined ? undefined : routeOf(entry)
                  if (route !== undefined) onTest(route.route)
                }
              }}
            >
              {t('pool.testSelected')}
            </button>
          </div>

          <table className="dsm-minimax-pool-table">
            <thead>
              <tr>
                <th>{t('pool.colAccount')}</th>
                <th>{t('pool.colCredits')}</th>
                <th>{t('pool.colStatus')}</th>
                <th>{t('pool.colCheckin')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pool.accounts.map(entry => {
                const route = routeOf(entry)
                const signin = route?.signin
                const today = signin?.days.find(day => day.isToday)
                return (
                  <tr key={entry.id} className={entry.active ? 'dsm-minimax-pool-row-active' : ''}>
                    <td>
                      <label className="dsm-minimax-pool-pick">
                        <input
                          type="checkbox"
                          checked={participating.has(entry.id)}
                          disabled={busy}
                          onChange={event => { toggle(entry.id, (event.target as HTMLInputElement).checked) }}
                        />
                      </label>
                      <span className="dsm-minimax-pool-rank">{t('pool.rank', { rank: entry.rank })}</span>
                      <button
                        type="button"
                        className="dsm-minimax-pool-move"
                        disabled={busy || entry.rank <= 1}
                        title={t('pool.moveUp')}
                        onClick={() => { onMove(entry.id, 'up') }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="dsm-minimax-pool-move"
                        disabled={busy || entry.rank >= pool.accounts.length}
                        title={t('pool.moveDown')}
                        onClick={() => { onMove(entry.id, 'down') }}
                      >
                        ↓
                      </button>
                      <div className="dsm-minimax-pool-label">
                        {entry.label}
                        {entry.live && <span className="dsm-minimax-chip">{t('pool.live')}</span>}
                        {entry.active && <span className="dsm-minimax-chip dsm-minimax-chip-on">{t('pool.active')}</span>}
                        {entry.drained && <span className="dsm-minimax-chip">{t('pool.drained')}</span>}
                        {!entry.participates && <span className="dsm-minimax-chip">{t('pool.optOut')}</span>}
                      </div>
                    </td>
                    <td>
                      {entry.balance === undefined
                        ? <span className="dsm-minimax-hint">{t('pool.balanceUnknown')}</span>
                        : <span className="dsm-minimax-pool-balance">{formatCredits(entry.balance)}</span>}
                    </td>
                    <td>
                      {route === undefined
                        ? <span className="dsm-minimax-hint">—</span>
                        : (
                          <span className="dsm-minimax-hint">
                            {route.login.state === 'ready' ? t('pool.usable') : t(`login.${route.login.state}`)}
                            {route.login.state === 'ready'
                              ? ` · ${t('pool.probedAt', { at: new Date(nowMs).toLocaleTimeString() })}`
                              : ''}
                          </span>
                        )}
                    </td>
                    <td>
                      {signin === undefined
                        ? <span className="dsm-minimax-hint">—</span>
                        : today?.status === 3
                          ? <span className="dsm-minimax-pool-checkin-on">{t('pool.checkedIn')}</span>
                          : <span className="dsm-minimax-hint">{t('pool.notCheckedIn')}</span>}
                    </td>
                    <td className="dsm-minimax-pool-row-actions">
                      {!entry.active && (
                        <button
                          type="button"
                          className="dsm-minimax-btn dsm-minimax-btn-ghost"
                          disabled={busy}
                          onClick={() => { onSelectAccount(entry.id) }}
                        >
                          {t('pool.setActive')}
                        </button>
                      )}
                      {route !== undefined && (
                        <button
                          type="button"
                          className="dsm-minimax-btn dsm-minimax-btn-outline"
                          disabled={busy || route.login.state !== 'ready'}
                          onClick={() => { onTest(route.route) }}
                        >
                          {t('models.test')}
                        </button>
                      )}
                      {!entry.live && route !== undefined && (
                        <button
                          type="button"
                          className="dsm-minimax-btn dsm-minimax-btn-ghost"
                          disabled={busy}
                          onClick={() => { onDelete(route) }}
                        >
                          {t('account.remove')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      <div className="dsm-minimax-pool-transfer">
        <button
          type="button"
          className="dsm-minimax-btn dsm-minimax-btn-outline"
          disabled={busy || transfer.phase === 'busy' || selectedIds.length === 0}
          onClick={() => { void doExport() }}
        >
          {transfer.phase === 'busy' ? t('pool.exporting') : t('pool.export')}
        </button>
        <button
          type="button"
          className="dsm-minimax-btn dsm-minimax-btn-outline"
          disabled={busy || transfer.phase === 'busy'}
          onClick={() => { fileRef.current?.click() }}
        >
          {t('pool.import')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={event => {
            const file = event.target.files?.[0]
            if (file !== undefined) void doPreview(file)
            event.target.value = ''
          }}
        />
        {transfer.phase === 'preview' && transfer.preview !== undefined && (
          <div className="dsm-minimax-pool-preview">
            {transfer.preview.map(entry => (
              <label key={entry.id} className="dsm-minimax-pool-preview-row">
                <input
                  type="checkbox"
                  checked={transfer.picked?.has(entry.id) ?? false}
                  disabled={entry.duplicate || !entry.hasToken}
                  onChange={() => {
                    setTransfer(state => ({
                      ...state,
                      picked: (() => {
                        const next = new Set(state.picked)
                        if (next.has(entry.id)) next.delete(entry.id)
                        else next.add(entry.id)
                        return next
                      })(),
                    }))
                  }}
                />
                <span>{entry.label}</span>
                <span className="dsm-minimax-hint">{entry.region === 'cn' ? t('region.cn') : t('region.global')}</span>
                {entry.duplicate && <span className="dsm-minimax-chip">{t('pool.importDuplicate')}</span>}
                {!entry.hasToken && <span className="dsm-minimax-chip">{t('pool.importNoToken')}</span>}
              </label>
            ))}
            <div className="dsm-minimax-pool-actions">
              <button
                type="button"
                className="dsm-minimax-btn dsm-minimax-btn-primary"
                disabled={busy || (transfer.picked?.size ?? 0) === 0}
                onClick={() => { void doImport() }}
              >
                {t('pool.importConfirm')}
              </button>
              <button
                type="button"
                className="dsm-minimax-btn dsm-minimax-btn-ghost"
                disabled={busy}
                onClick={() => { setTransfer({ phase: 'idle' }) }}
              >
                {t('models.discard')}
              </button>
            </div>
          </div>
        )}
        {transfer.note !== undefined && <p className="dsm-minimax-hint">{transfer.note}</p>}
      </div>
    </div>
  )
}

/** 账号页：本机登录 + 副本 + 积分 + 签到。 */
function AccountPanel(props: {
  status: MiniMaxStatusView
  region: string
  nowMs: number
  busy: boolean
  message: string | undefined
  onClaim(): void
  onDelete(route: MiniMaxRouteView): void
  onSelectAccount(id: string): void
  onTestRoute(route: string): void
  onClaimAccounts(ids: readonly string[]): void
  onMoveAccount(id: string, direction: 'up' | 'down'): void
  onParticipate(ids: readonly string[]): void
  t: MiniMaxTranslate
}): ReactElement {
  const {
    status, region, nowMs, busy, message,
    onClaim, onDelete, onSelectAccount, onTestRoute, onClaimAccounts, onMoveAccount, onParticipate, t,
  } = props
  const routes = routesForRegion(effectiveRoutesOf(status), region)
  const live = routes.find(route => !isCopyRoute(route))
  const copies = routes.filter(route => isCopyRoute(route))
  const signin: MiniMaxSigninView | undefined = live?.signin
  const today = signin?.days.find(day => day.isToday)
  const pool = live?.pool

  return (
    <div className="dsm-minimax-panel">
      {/* 产品承诺放在账号页第一行：用户在这个页面上要确认的就是"我不会在这里被要求填 key"。 */}
      <p className="dsm-minimax-hint">{t('promise.noApiKey')}</p>

      {routes.length === 0 && (
        <p className="dsm-minimax-hint">{t('account.noneRegistered')}</p>
      )}

      {pool !== undefined && pool.accounts.length > 0 && (
        <PoolTable
          pool={pool}
          routes={routes}
          region={region}
          nowMs={nowMs}
          busy={busy}
          t={t}
          onSelectAccount={onSelectAccount}
          onDelete={onDelete}
          onTest={route => onTestRoute(route)}
          onClaim={ids => onClaimAccounts(ids)}
          onMove={(id, dir) => onMoveAccount(id, dir)}
          onParticipate={ids => onParticipate(ids)}
        />
      )}

      {routes.map(route => (
        <div key={route.route} className="dsm-minimax-row">
          <div className="dsm-minimax-row-main">
            <div className="dsm-minimax-model-id">{route.route}</div>
            <div className="dsm-minimax-model-name">
              {routeProviderLabelOf(route, t)}
              {isCopyRoute(route) && (
                <span className="dsm-minimax-chip dsm-minimax-chip-on" style={{ marginLeft: 6 }}>
                  {translateCopyLabel(route, t)}
                </span>
              )}
            </div>
            {route.login.state === 'authorizing' && route.login.verificationUri !== undefined && (
              <div className="dsm-minimax-hint" style={{ marginTop: '4px' }}>
                {route.login.userCode === undefined
                  ? null
                  : (
                    <span>
                      {t('advice.authorizingCode', { code: route.login.userCode })}
                      {' · '}
                    </span>
                  )}
                <a href={route.login.verificationUri} target="_blank" rel="noreferrer">
                  {route.login.verificationUri}
                </a>
              </div>
            )}
            {/* 刻意不在这里重复 routeAdviceOf：顶部那条"你需要做什么"已经按路由
                列了所有未就绪项，行内再抄一遍只会让同一句话出现两次。行内只放
                事实：状态、到期、凭据来源。 */}
          </div>
          <div className="dsm-minimax-row-side">
            <span className={`dsm-minimax-badge dsm-minimax-badge-${badgeToneOf(route.login.state)}`}>
              <span className="dsm-minimax-badge-dot" />
              {t(`login.${route.login.state}`)}
            </span>
            <span className="dsm-minimax-row-meta">{t('routes.expires')}：{expiryTextOf(route.login, nowMs, t)}</span>
            <span className="dsm-minimax-row-meta">
              {t('login.source')}：{t(sourceLabelKeyOf(route.login.source))}
            </span>
            {isCopyRoute(route) && (
              <button
                type="button"
                className="dsm-minimax-btn dsm-minimax-btn-ghost"
                onClick={() => { onDelete(route) }}
              >
                {t('account.delete')}
              </button>
            )}
          </div>
        </div>
      ))}

      {copies.length > 0 && (
        <p className="dsm-minimax-hint">{t('routes.copyHint')}</p>
      )}

      {/* 积分与签到：本机登录那条才有意义（副本的令牌属于另一个账号，读它的积分会误导）。 */}
      {live !== undefined && (
        <div className="dsm-minimax-credits">
          <div className="dsm-minimax-credits-balance">
            <div>
              <div className="dsm-minimax-fact-key">{t('credits.balance')}</div>
              <div className="dsm-minimax-credits-value">{creditsTextOf(live.credits, t)}</div>
              <div className="dsm-minimax-hint">{expirySummaryTextOf(live.credits, nowMs, t)}</div>
            </div>
          </div>
          <div className="dsm-minimax-signin">
            <div className="dsm-minimax-fact-key">{t('signin.label')}</div>
            <div className="dsm-minimax-days">
              {(signin?.days ?? []).map(day => (
                <span
                  key={day.dayNo}
                  className={`dsm-minimax-day dsm-minimax-day-${signinDayToneOf(day)}${day.isToday ? ' dsm-minimax-day-today' : ''}`}
                  title={t('signin.dayTitle', { day: day.dayNo, points: day.points, status: day.status })}
                >
                  +{day.points}
                </span>
              ))}
              {signin === undefined && <span className="dsm-minimax-hint">{t('signin.unavailable')}</span>}
            </div>
            <div className="dsm-minimax-signin-foot">
              <span className="dsm-minimax-row-meta">
                {today === undefined
                  ? t('signin.noToday')
                  : signin?.claimableToday === true
                    ? t('signin.ready')
                    : t('signin.done')}
              </span>
              <button
                type="button"
                className="dsm-minimax-btn dsm-minimax-btn-outline"
                disabled={!signin?.claimableToday || busy}
                title={signin?.claimableToday ? t('signin.claimHint') : t('signin.disabledHint')}
                onClick={onClaim}
              >
                {busy ? t('signin.claiming') : t('signin.claim')}
              </button>
            </div>
          </div>
        </div>
      )}

      {message !== undefined && <p className="dsm-minimax-hint">{message}</p>}
    </div>
  )
}

/** 副本 chip 的文案。 */
function translateCopyLabel(route: MiniMaxRouteView, t: MiniMaxTranslate): string {
  const label = copyLabelOf(route)
  return label === undefined ? t('routes.copy') : `${t('routes.copy')} ${label}`
}

/** 模型页：全目录勾选启用 + 测试。 */
function ModelPanel(props: {
  status: MiniMaxStatusView
  region: string
  canWrite: boolean
  probes: Record<string, ModelProbe>
  onToggleModel(modelId: string, enabled: boolean): void
  onModelContext(modelId: string, window: number): void
  onModelImages(modelId: string, enabled: boolean): void
  onThinkingOff(modelId: string, allow: boolean): void
  onSelectAll(): void
  onTest(modelId: string): void
  /** 草稿：勾选启用的模型 id。 */
  draftEnabledIds: readonly string[]
  /** 草稿：模型 id → 是否发送图片。 */
  draftImages: Record<string, boolean>
  /** 草稿：模型 id → 是否提供「关闭思考」档。 */
  draftThinkingOff: Record<string, boolean>
  /** 草稿：模型 id → 上下文档位。 */
  draftContextWindows: Record<string, number>
  /** 草稿是否有未保存的改动。 */
  dirty: boolean
  onSave(): void
  onDiscard(): void
  onRefresh(): void
  busy: boolean
  message: string | undefined
  t: MiniMaxTranslate
}): ReactElement {
  const {
    status, region, canWrite, probes, onToggleModel, onModelContext, onModelImages, onThinkingOff,
    onSelectAll, onTest, onRefresh, busy, message, t,
    draftEnabledIds, draftImages, draftThinkingOff, draftContextWindows, dirty, onSave, onDiscard,
  } = props
  // 模型目录是**全局**的（两个区域共用同一份 config.yaml 快照），所以这一页
  // 不随区域变化——但路由可用性会变，测试要打当前区域那条路由。
  const routes = routesForRegion(effectiveRoutesOf(status), region)
  const testRoute = routes.find(route => route.login.state === 'ready') ?? routes[0]
  // 有草稿时以草稿为准（用户改过但还没保存）；没有草稿就是已保存的值。
  const enabledIds = new Set(draftEnabledIds)
  const catalog = status.catalog
  const allChecked = catalog.every(model => enabledIds.has(model.id))

  return (
    <div className="dsm-minimax-panel">
      <div className="dsm-minimax-panel-head">
        <div>
          <div className="dsm-minimax-panel-title">
            {t('models.label')}
            {dirty ? <span className="dsm-minimax-dirty">{t('models.dirty')}</span> : null}
          </div>
          <div className="dsm-minimax-hint">
            {t('models.enabledCount', { count: enabledIds.size, total: catalog.length })}
          </div>
        </div>
        <div className="dsm-minimax-panel-actions">
          <button
            type="button"
            className="dsm-minimax-btn dsm-minimax-btn-outline"
            disabled={busy}
            onClick={() => { onRefresh() }}
          >
            {busy ? t('models.refreshing') : t('models.refresh')}
          </button>
          {!allChecked && (
            <button
              type="button"
              className="dsm-minimax-btn dsm-minimax-btn-ghost"
              disabled={!canWrite || busy}
              title={t('models.selectAllHint')}
              onClick={onSelectAll}
            >
              {t('models.selectAll')}
            </button>
          )}
        </div>
      </div>

      {catalog.length === 0 && <p className="dsm-minimax-hint">{t('models.empty')}</p>}

      <div className="dsm-minimax-model-list">
      {catalog.map(model => (
        <ModelRow
          key={model.id}
          model={model}
          enabled={enabledIds.has(model.id)}
          canWrite={canWrite}
          busy={busy}
          probe={probes[`${region}:${model.id}`]}
          route={testRoute?.route}
          draftImages={draftImages}
          draftThinkingOff={draftThinkingOff}
          draftContextWindows={draftContextWindows}
          onToggle={onToggleModel}
          onModelContext={onModelContext}
          onModelImages={onModelImages}
          onThinkingOff={onThinkingOff}
          onTest={onTest}
          t={t}
        />
      ))}
      </div>

      {/* 与 Qoder 的模型页一致：把"这一页只展示上游明确公布的能力"写在底部，
          用户就不会指望这里出现上游没声明的档位。 */}
      <p className="dsm-minimax-hint">{t('models.capabilityNote')}</p>

      {/* 底部操作条：草稿的「放弃修改 / 保存」+ 一句鼓励（Qoder/workbuddy 同款）。 */}
      <div className="dsm-minimax-model-actions">
        <a
          className="dsm-minimax-cheer"
          href={MINIMAX_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('models.cheer')}
          <span className="dsm-minimax-cheer-star" aria-hidden="true">★</span>
        </a>
        <div className="dsm-minimax-model-actions-buttons">
          <button
            type="button"
            className="dsm-minimax-btn dsm-minimax-btn-outline"
            disabled={!dirty || !canWrite || busy}
            onClick={onDiscard}
          >
            {t('models.discard')}
          </button>
          <button
            type="button"
            className="dsm-minimax-btn dsm-minimax-btn-primary"
            disabled={!dirty || !canWrite || busy}
            onClick={onSave}
          >
            {busy ? t('models.saving') : t('models.save')}
          </button>
        </div>
      </div>
      {message !== undefined && <p className="dsm-minimax-hint">{message}</p>}
      {!canWrite && <p className="dsm-minimax-hint">{t('settings.readOnly')}</p>}
    </div>
  )
}

/**
 * 模型页草稿：用户改动先落在这里，底部「保存」才写回配置。
 *
 * 四个字段与插件配置一一对应（`models` / `modelImages` / `modelThinkingOff` /
 * `modelContextWindows`），都不分区域，所以草稿是**全局一份**。
 */
interface ModelDraft {
  /** 勾选启用的模型 id。空数组 = 一个都不启用。 */
  enabledIds: string[]
  /** 模型 id → 是否发送图片。 */
  images: Record<string, boolean>
  /** 模型 id → 是否提供「关闭思考」档。 */
  thinkingOff: Record<string, boolean>
  /** 模型 id → 上下文档位。 */
  contextWindows: Record<string, number>
}

/** 一行模型。 */
function ModelRow(props: {
  model: MiniMaxModelView
  enabled: boolean
  canWrite: boolean
  busy: boolean
  probe: ModelProbe | undefined
  route: string | undefined
  /** 草稿里的图片开关；undefined = 用已保存的值。 */
  draftImages: Record<string, boolean>
  /** 草稿里的「可关闭思考」；undefined = 用已保存的值。 */
  draftThinkingOff: Record<string, boolean>
  /** 草稿里的上下文档位；undefined = 用已保存的值。 */
  draftContextWindows: Record<string, number>
  onToggle(modelId: string, enabled: boolean): void
  onModelContext(modelId: string, window: number): void
  onModelImages(modelId: string, enabled: boolean): void
  onThinkingOff(modelId: string, allow: boolean): void
  onTest(modelId: string): void
  t: MiniMaxTranslate
}): ReactElement {
  const {
    model, enabled, canWrite, busy, probe, route,
    draftImages, draftThinkingOff, draftContextWindows,
    onToggle, onModelContext, onModelImages, onThinkingOff, onTest, t,
  } = props
  // 上游能力与"当前是否发图"是两件事：`input` 是被 modelImages 掩码后的结果。
  // 只看它就画控件的话，用户一关图片复选框就消失，再也勾不回来了。
  const upstreamImages = (model.upstreamInput.length > 0 ? model.upstreamInput : model.input).includes('image')
  // 草稿优先：用户改了还没保存时，界面要显示草稿里的值。
  const sendsImages = draftImages[model.id] ?? model.input.includes('image')
  const thinkingOff = draftThinkingOff[model.id] ?? model.thinkingOff
  const contextWindow = draftContextWindows[model.id] ?? model.contextWindow
  const tiers = (model.contextWindowOptions.length > 0 ? model.contextWindowOptions : [model.contextWindow])
  // 强制思考的模型**不提供** off 档（上游会拒绝），所以这一项要禁用并标出来。
  const offBlocked = model.thinkingMode === 'forced'

  return (
    <div className={`dsm-minimax-model${enabled ? '' : ' dsm-minimax-model-disabled'}`}>
      <div className="dsm-minimax-model-head">
        <label className="dsm-minimax-model-enabled" title={canWrite ? '' : t('settings.readOnly')}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canWrite || busy}
            onChange={event => { onToggle(model.id, (event.target as HTMLInputElement).checked) }}
          />
          <span className="dsm-minimax-model-name">{model.name}</span>
          {model.badge === undefined ? null : (
            <span className="dsm-minimax-model-promo">{model.badge}</span>
          )}
        </label>

        <div className="dsm-minimax-model-tools">
          {upstreamImages
            ? (
              <label className="dsm-minimax-model-image" title={canWrite ? t('models.imageHint') : t('settings.readOnly')}>
                <input
                  type="checkbox"
                  checked={sendsImages}
                  disabled={!canWrite || busy}
                  onChange={event => { onModelImages(model.id, (event.target as HTMLInputElement).checked) }}
                />
                <span>{t('models.imageYes')}</span>
              </label>
            )
            : <span className="dsm-minimax-model-image dsm-minimax-model-image-off">{t('models.imageNo')}</span>}

          <label
            className={`dsm-minimax-model-off${offBlocked ? ' dsm-minimax-model-off-blocked' : ''}`}
            title={offBlocked ? t('models.thinkingOffRefusedHint') : t('models.thinkingOffHint')}
          >
            <input
              type="checkbox"
              checked={!offBlocked && thinkingOff}
              disabled={!canWrite || busy || offBlocked}
              onChange={event => { onThinkingOff(model.id, (event.target as HTMLInputElement).checked) }}
            />
            <span>{t('models.thinkingOff')}</span>
            {offBlocked ? <span className="dsm-minimax-model-off-flag">{t('models.thinkingOffRefused')}</span> : null}
          </label>

          {/* 上下文档位：行内下拉，选项**只**来自上游声明的档位。单档模型也画一个
              （禁用）选择器——"只有这一档"本身是信息，不画反而让人以为没读到。 */}
          <span className="dsm-minimax-inline-picker" title={t('models.tierLabel')}>
            <select
              className="dsm-minimax-inline-select"
              value={String(contextWindow)}
              disabled={!canWrite || busy || tiers.length <= 1}
              onChange={event => { onModelContext(model.id, Number((event.target as HTMLSelectElement).value)) }}
            >
              {tiers.map(option => (
                <option key={option} value={String(option)}>{formatContextWindow(option)}</option>
              ))}
            </select>
            <span className="dsm-minimax-inline-caret" aria-hidden="true">▾</span>
          </span>

          <button
            type="button"
            className="dsm-minimax-model-test"
            disabled={busy || !enabled || route === undefined}
            onClick={() => { onTest(model.id) }}
          >
            {t('models.test')}
          </button>
        </div>
      </div>

      <div className="dsm-minimax-model-meta">
        <span>{t('models.context')} {formatContextWindow(contextWindow)}</span>
        <span>{t('models.output')} {formatContextWindow(model.maxTokens)}</span>
      </div>

      {probe !== undefined && (
        <p className={`dsm-minimax-hint${probe.ok === false ? ' dsm-minimax-error' : ''}`}>
          {probe.busy ? t('models.testing') : probe.detail ?? ''}
        </p>
      )}
    </div>
  )
}

/** 诊断页：这张卡片实际读到了什么。全部只读。 */
function DiagnosticsPanel(props: {
  status: MiniMaxStatusView
  region: string
  nowMs: number
  error: string | undefined
  t: MiniMaxTranslate
}): ReactElement {
  const { status, region, nowMs, error, t } = props
  const routes = routesForRegion(effectiveRoutesOf(status), region)
  const live = routes.find(route => !isCopyRoute(route))
  const copies = routes.filter(route => isCopyRoute(route))
  const failed = routes.filter(route => route.login.state !== 'ready')
  const checkedAt = status.checkedAt === 0 ? t('login.expiresUnknown') : new Date(status.checkedAt).toLocaleString()

  return (
    <div className="dsm-minimax-panel">
      <dl className="dsm-minimax-facts">
        {fact(t('region.label'), t(region === 'global' ? 'region.global' : 'region.cn'))}
        {fact(t('region.baseUrl'), live?.baseUrl ?? status.baseUrl)}
        {fact(t('diagnostics.route'), live?.route ?? status.route)}
        {fact(t('diagnostics.enabledRegions'), status.enabledRegions
          .map(entry => t(entry === 'global' ? 'region.global' : 'region.cn'))
          .join(' / ') || t('diagnostics.none'))}
        {fact(t('login.source'), live === undefined ? t('login.sourceNone') : t(sourceLabelKeyOf(live.login.source)))}
        {fact(t('login.expires'), live === undefined ? t('login.expiresUnknown') : expiryTextOf(live.login, nowMs, t))}
        {live?.login.generation === undefined
          ? null
          : fact(t('login.generation'), String(live.login.generation))}
        {live?.login.detail === undefined
          ? null
          : fact(t('diagnostics.credentialNote'), live.login.detail)}
        {fact(t('diagnostics.creditsAt'), creditsFactOf(live?.credits, status.checkedAt, t))}
        {fact(t('diagnostics.catalog'), String(status.catalog.length))}
        {fact(t('diagnostics.enabledModels'), String(status.models.length))}
        {fact(t('diagnostics.copies'), t('diagnostics.copyCount', { count: copies.length }))}
        {fact(t('diagnostics.longContext'), status.longContext ? t('models.longContextOn') : t('models.longContextOff'))}
        {fact(t('version.label'), status.pluginVersion)}
        {fact(t('diagnostics.checkedAt'), checkedAt)}
        {fact(
          t('diagnostics.lastError'),
          error ?? (failed.length === 0 ? t('diagnostics.noError') : failed
            .map(route => `${route.route}: ${route.login.detail ?? t(`login.${route.login.state}`)}`)
            .join('；')),
        )}
      </dl>
      <p className="dsm-minimax-hint">{t('diagnostics.note')}</p>
    </div>
  )
}

/** 卡片本体。 */
export function MiniMaxCard({ t, settingsScope }: MiniMaxCardProps): ReactElement {
  const translate = t ?? ((key: string) => key)
  const [status, setStatus] = useState<MiniMaxStatusView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [region, setRegion] = useState<string>('cn')
  const [panel, setPanel] = useState<MiniMaxPanelKey>('account')
  const [probes, setProbes] = useState<Record<string, ModelProbe>>({})
  /**
   * 模型页的**草稿**。
   *
   * 与 Qoder/workbuddy 同款：改动先落在草稿里，底部「保存」才写回配置，
   * 「放弃修改」丢弃。好处是批量改多个模型只写一次，中途失败不会留下半套配置；
   * 代价是用户改完没点保存就关页面会丢——所以标题旁要有 dirty 徽章提示。
   *
   * 草稿是**全局**的一份（模型启用、图片、思考、档位这几个配置字段都不分区域）。
   */
  const [draft, setDraft] = useState<ModelDraft | undefined>(undefined)
  /**
   * **已保存**的基线快照。
   *
   * dirty 判定必须拿它比对，而不是每次从 `status` 现算：保存写入配置后，宿主要
   * 重新激活插件才会把新值反映到 status 上（中间有几百毫秒）。那段时间里
   * 现算的基线还是**旧值**，于是刚保存完就又显示"未保存"——用户以为没保存成功，
   * 可能又点一次。
   */
  const [savedBase, setSavedBase] = useState<ModelDraft | undefined>(undefined)
  const [actionMessage, setActionMessage] = useState<string | undefined>(undefined)
  const [busyRegion, setBusyRegion] = useState<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const inFlight = useRef<AbortController | undefined>(undefined)

  const load = useCallback(async () => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setBusy(true)
    try {
      const next = await fetchMiniMaxStatus(controller.signal)
      if (controller.signal.aborted) return
      setStatus(next)
      setError(undefined)
    } catch (caught: unknown) {
      if (controller.signal.aborted) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (inFlight.current === controller) inFlight.current = undefined
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // 只在页面可见时轮询。
    const startTimer = (): void => {
      if (timer.current !== undefined) return
      timer.current = setInterval(() => { void load() }, MINIMAX_POLL_INTERVAL_MS)
    }
    const stopTimer = (): void => {
      if (timer.current === undefined) return
      clearInterval(timer.current)
      timer.current = undefined
    }
    const onVisibility = (): void => {
      if (typeof document === 'undefined') return
      if (document.visibilityState === 'visible') {
        void load()
        startTimer()
      } else {
        stopTimer()
      }
    }
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') startTimer()
    document?.addEventListener?.('visibilitychange', onVisibility)
    return () => {
      stopTimer()
      document?.removeEventListener?.('visibilitychange', onVisibility)
      inFlight.current?.abort()
    }
  }, [load])

  /** 设置作用域订阅：宿主里改了配置，卡片要跟着刷新而不是等下一次轮询。 */
  useEffect(() => settingsScope?.subscribe?.(() => { void load() }) ?? (() => undefined), [load, settingsScope])

  const canWrite = settingsScope !== undefined

  /**
   * 写配置后立刻重读状态。
   *
   * 宿主应用新配置需要重新激活插件，所以这里等一下再拉：拉太早会拿到旧值，
   * 用户看到的就是"我勾了但没生效"。
   */
  const afterWrite = useCallback(async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 400))
    await load()
  }, [load])

  const handleToggleRegion = useCallback(async (target: string): Promise<void> => {
    if (settingsScope === undefined || status === undefined) return
    const { next, accepted } = toggleRegion(status.enabledRegions, target)
    if (!accepted) {
      // 两个区域都关掉 = 插件一条路由都不注册，卡片也会跟着消失。这不是用户想要的。
      setActionMessage(translate('region.lastOne'))
      return
    }
    setBusyRegion(target)
    try {
      await writeRegions(settingsScope, next)
      setActionMessage(undefined)
      await afterWrite()
    } catch (caught: unknown) {
      setActionMessage(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyRegion(undefined)
    }
  }, [settingsScope, status, afterWrite, translate])

  /**
   * 从已保存的状态派生出草稿基线。
   *
   * 基线必须来自**已保存的覆盖值**（`status.modelOverrides`）而不是"当前生效
   * 的投影"：投影已经被掩码过了（`modelImages: false` 会让 `input` 少一个
   * image），拿它当基线就分不清"用户没动过"和"用户显式关掉了"。
   */
  const draftBase = useCallback((): ModelDraft | undefined => {
    if (status === undefined) return undefined
    const overrides = status.modelOverrides
    const enabledIds = status.models.map(model => model.id)
    const images: Record<string, boolean> = {}
    const thinkingOff: Record<string, boolean> = {}
    const contextWindows: Record<string, number> = {}
    for (const model of status.catalog) {
      images[model.id] = overrides.images[model.id] ?? model.input.includes('image')
      thinkingOff[model.id] = overrides.thinkingOff[model.id] ?? model.thinkingOff
      contextWindows[model.id] = overrides.contextWindows[model.id] ?? model.contextWindow
    }
    return { enabledIds, images, thinkingOff, contextWindows }
  }, [status])

  /**
   * 草稿是否与已保存的值不同（= 有未保存的改动）。
   *
   * 逐字段比：任一不同就是 dirty。全同则 dirty = false，"放弃修改"也就没意义。
   */
  const draftDirty = useMemo((): boolean => {
    if (draft === undefined || status === undefined) return false
    const base = savedBase ?? draftBase()
    if (base === undefined) return false
    const savedIds = new Set(status.models.map(model => model.id))
    if (draft.enabledIds.length !== savedIds.size) return true
    if (draft.enabledIds.some(id => !savedIds.has(id))) return true
    for (const [id, value] of Object.entries(draft.images)) {
      const saved = base.images[id]
      if (saved !== undefined && saved !== value) return true
    }
    for (const [id, value] of Object.entries(draft.thinkingOff)) {
      const saved = base.thinkingOff[id]
      if (saved !== undefined && saved !== value) return true
    }
    for (const [id, value] of Object.entries(draft.contextWindows)) {
      const saved = base.contextWindows[id]
      if (saved !== undefined && saved !== value) return true
    }
    return false
  }, [draft, status, savedBase, draftBase])

  /** 改草稿：先按需从已保存值建基线，再改。 */
  const editDraft = useCallback((mutate: (draft: ModelDraft) => ModelDraft): void => {
    setDraft(previous => {
      const base = previous ?? draftBase()
      if (base === undefined) return previous
      return mutate(base)
    })
  }, [draftBase])

  const handleToggleModel = useCallback((modelId: string, enabled: boolean): void => {
    if (status === undefined) return
    const current = new Set(draft?.enabledIds ?? status.models.map(model => model.id))
    if (enabled) {
      current.add(modelId)
    } else {
      current.delete(modelId)
      if (current.size === 0) {
        // 关到只剩最后一个：不允许，那等于把插件自己关没。
        setActionMessage(translate('models.lastEnabled'))
        return
      }
    }
    // 落盘顺序按目录顺序，避免"保存"出来的名单顺序随勾选顺序乱跳。
    const ordered = status.catalog
      .map(model => model.id)
      .filter(id => current.has(id))
    editDraft(prev => ({ ...prev, enabledIds: ordered }))
  }, [status, draft, editDraft, translate])

  const handleModelContext = useCallback((modelId: string, window: number): void => {
    editDraft(prev => ({ ...prev, contextWindows: { ...prev.contextWindows, [modelId]: window } }))
  }, [editDraft])

  const handleModelImages = useCallback((modelId: string, wants: boolean): void => {
    editDraft(prev => ({ ...prev, images: { ...prev.images, [modelId]: wants } }))
  }, [editDraft])

  const handleSelectAccount = useCallback(async (id: string): Promise<void> => {
    try {
      const outcome = await postAction(MINIMAX_ACCOUNT_SELECT_PATH, { region, id })
      if (!outcome.ok) {
        setActionMessage(outcome.message)
        return
      }
      setActionMessage(undefined)
      await afterWrite()
    } catch (caught: unknown) {
      setActionMessage(caught instanceof Error ? caught.message : String(caught))
    }
  }, [region, afterWrite])

  const handleThinkingOff = useCallback((modelId: string, allow: boolean): void => {
    editDraft(prev => ({ ...prev, thinkingOff: { ...prev.thinkingOff, [modelId]: allow } }))
  }, [editDraft])

  const handleRefresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const outcome = await postAction(MINIMAX_ACCOUNT_REFRESH_PATH, { region })
      if (!outcome.ok) {
        setActionMessage(outcome.message)
      } else {
        setActionMessage(undefined)
      }
      // 动作已经让宿主重读过了，这里再拉一次拿最新读数。
      await load()
    } catch (caught: unknown) {
      setActionMessage(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [region, load])

  /**
   * 把草稿写回配置。
   *
   * 逐字段写、只写**与已保存值不同**的那些：少写一次是一次，配置文档里也不会
   * 多出一堆与默认值相同的噪音条目。
   */
  const handleSaveDraft = useCallback(async (): Promise<void> => {
    if (settingsScope === undefined || draft === undefined) return
    const base = draftBase()
    if (base === undefined) return
    setBusy(true)
    try {
      // 1) 启用列表：空数组 = 目录全部（宿主语义），所以只有"用户全不选"才写空。
      const savedIds = base.enabledIds
      const sameIds = savedIds.length === draft.enabledIds.length
        && savedIds.every(id => draft.enabledIds.includes(id))
      if (!sameIds) {
        // 全选 = 空列表，将来上游新增模型会自动出现。
        await writeModels(settingsScope, draft.enabledIds.length === status?.catalog.length ? [] : draft.enabledIds)
      }
      // 2) 逐模型覆盖：只写变化过的。
      for (const [id, value] of Object.entries(draft.images)) {
        if (base.images[id] !== value) await writeModelImages(settingsScope, id, value)
      }
      for (const [id, value] of Object.entries(draft.thinkingOff)) {
        if (base.thinkingOff[id] !== value) await writeModelThinkingOff(settingsScope, id, value)
      }
      for (const [id, value] of Object.entries(draft.contextWindows)) {
        if (base.contextWindows[id] !== value) await writeModelContextWindow(settingsScope, id, value)
      }
      // 先把刚写下去的值记成基线，再清草稿：dirty 判定立刻就是干净的，
      // 不用等宿主把新配置反映到 status 上。
      setSavedBase(draft)
      setDraft(undefined)
      setActionMessage(undefined)
      await afterWrite()
    } catch (caught: unknown) {
      // **草稿不清**：写入失败时用户的改动必须还在，否则改一次丢一次。
      setActionMessage(translate('models.writeFailed'))
    } finally {
      setBusy(false)
    }
  }, [settingsScope, draft, draftBase, status, afterWrite, translate])

  /** 放弃修改：丢弃草稿，回到已保存的值。 */
  const handleDiscardDraft = useCallback((): void => {
    setDraft(undefined)
    setActionMessage(undefined)
  }, [])

  const handleSelectAll = useCallback((): void => {
    if (status === undefined) return
    // 全部启用 = 写空列表（宿主语义：空 = 目录全部）。这样以后上游新增的模型
    // 会自动出现在用户面前，而不是被一次"全选"永久钉死在旧名单上。
    editDraft(prev => ({ ...prev, enabledIds: status.catalog.map(model => model.id) }))
  }, [status, editDraft])

  const handleClaim = useCallback(async (): Promise<void> => {
    setBusy(true)
    const outcome = await postAction(MINIMAX_SIGNIN_CLAIM_PATH, { region })
    setActionMessage(outcome.message)
    await load()
    setBusy(false)
  }, [region, load])

  /** 批量签到勾选的账号；空 = 只签当前生效账号（旧行为）。 */
  const handleClaimAccounts = useCallback(async (ids: readonly string[]): Promise<void> => {
    setBusy(true)
    const outcome = await postActionJson(MINIMAX_SIGNIN_CLAIM_PATH, { region, accountIds: [...ids] })
    setActionMessage(outcome.message)
    await load()
    setBusy(false)
  }, [region, load])

  /** 写入"不参与换号/批量动作"的账号列表（复选框是持久化开关）。 */
  const handleParticipate = useCallback(async (ids: readonly string[]): Promise<void> => {
    if (settingsScope === undefined) return
    // 池在**路由级**（每个区域一条），取当前区域 live 路由的那份。
    const routes = status === undefined ? [] : routesForRegion(effectiveRoutesOf(status), region)
    const pool = routes.find(route => !isCopyRoute(route))?.pool
    const disabled = (pool?.accounts ?? [])
      .filter(entry => !ids.includes(entry.id))
      .map(entry => entry.id)
    try {
      await writePoolDisabled(settingsScope, disabled)
      setActionMessage(undefined)
      await afterWrite()
    } catch (caught: unknown) {
      setActionMessage(caught instanceof Error ? caught.message : String(caught))
    }
  }, [settingsScope, status, region, afterWrite])

  /** 调整池里副本的优先级。 */
  const handleMoveAccount = useCallback(async (id: string, direction: 'up' | 'down'): Promise<void> => {
    const outcome = await postAction(MINIMAX_ACCOUNT_MOVE_PATH, { region, id, direction })
    if (!outcome.ok) setActionMessage(outcome.message)
    await load()
  }, [region, load])

  /** 按账号路由测一发最小请求（池表格里的"测试"）。模型取第一个已启用的。 */
  const handleTestRoute = useCallback(async (route: string): Promise<void> => {
    const modelId = status?.models[0]?.id
    if (modelId === undefined) {
      setActionMessage(translate('models.empty'))
      return
    }
    const outcome = await postActionJson(MINIMAX_MODEL_TEST_PATH, { route, model: modelId })
    setActionMessage(outcome.ok ? translate('models.testOk') : outcome.message)
  }, [translate, status])

  const handleDelete = useCallback(async (route: MiniMaxRouteView): Promise<void> => {
    if (route.accountId === undefined) return
    const outcome = await postAction(MINIMAX_ACCOUNT_REMOVE_PATH, { id: route.accountId })
    setActionMessage(`${route.accountId}：${outcome.message}`)
    await load()
  }, [load])

  const handleTest = useCallback(async (modelId: string): Promise<void> => {
    const routes = status === undefined ? [] : routesForRegion(effectiveRoutesOf(status), region)
    const target = routes.find(route => route.login.state === 'ready') ?? routes[0]
    if (target === undefined) return
    const key = `${region}:${modelId}`
    setProbes(current => ({ ...current, [key]: { busy: true } }))
    const started = Date.now()
    const outcome = await postAction(MINIMAX_MODEL_TEST_PATH, { route: target.route, model: modelId })
    setProbes(current => ({
      ...current,
      [key]: {
        busy: false,
        ok: outcome.ok,
        detail: outcome.ok
          ? `${translate('models.testOk')} ${Date.now() - started}ms`
          : outcome.message,
      },
    }))
  }, [region, status, translate])

  const nowMs = Date.now()
  const login = status?.login
  const routes = status === undefined ? [] : effectiveRoutesOf(status)
  const unreadyRoutes = routes.filter(route => route.login.state !== 'ready')

  return (
    <div className="dsm-minimax-card">
      <div className="dsm-minimax-card-body">
        {/* 汇总徽标 + 「你需要做什么」 */}
        <div>
          <span className={`dsm-minimax-badge dsm-minimax-badge-${aggregateBadgeToneOf(routes)}`}>
            <span className="dsm-minimax-badge-dot" />
            {translate(aggregateLabelKeyOf(routes, status === undefined))}
          </span>
          {unreadyRoutes.length > 0
            ? unreadyRoutes.map(route => (
              <p key={`advice:${route.route}`} className="dsm-minimax-hint" style={{ marginTop: '8px' }}>
                {routeAdviceOf(route, translate)}
              </p>
            ))
            : login !== undefined
              ? <p className="dsm-minimax-hint" style={{ marginTop: '8px' }}>{loginAdviceOf(login, translate)}</p>
              : null}
        </div>

        <RegionTabs
          status={status}
          active={region}
          onSelect={setRegion}
          onToggle={route => { void handleToggleRegion(route) }}
          canWrite={canWrite}
          busyRegion={busyRegion}
          t={translate}
        />
        <p className="dsm-minimax-hint">{translate('region.tabHint')}</p>

        <PanelTabs active={panel} onSelect={setPanel} t={translate} />

        {status === undefined
          ? <p className="dsm-minimax-hint">{translate(error === undefined ? 'badge.loading' : 'row.unreachable')}</p>
          : panel === 'account'
            ? (
              <AccountPanel
                status={status}
                region={region}
                nowMs={nowMs}
                busy={busy}
                message={actionMessage}
                onClaim={() => { void handleClaim() }}
                onDelete={route => { void handleDelete(route) }}
                onSelectAccount={id => { void handleSelectAccount(id) }}
                onTestRoute={route => { void handleTestRoute(route) }}
                onClaimAccounts={ids => { void handleClaimAccounts(ids) }}
                onMoveAccount={(id, dir) => { void handleMoveAccount(id, dir) }}
                onParticipate={ids => { void handleParticipate(ids) }}
                t={translate}
              />
            )
            : panel === 'models'
              ? (
                <ModelPanel
                  status={status}
                  region={region}
                  canWrite={canWrite}
                  probes={probes}
                  onToggleModel={(id, enabled) => { void handleToggleModel(id, enabled) }}
                  onModelContext={(id, window) => { void handleModelContext(id, window) }}
                  onModelImages={(id, wants) => { void handleModelImages(id, wants) }}
                  onThinkingOff={(id, allow) => { void handleThinkingOff(id, allow) }}
                  onSelectAll={() => { handleSelectAll() }}
                  draftEnabledIds={draft?.enabledIds ?? status.models.map(model => model.id)}
                  draftImages={draft?.images ?? {}}
                  draftThinkingOff={draft?.thinkingOff ?? {}}
                  draftContextWindows={draft?.contextWindows ?? {}}
                  dirty={draftDirty}
                  onSave={() => { void handleSaveDraft() }}
                  onDiscard={() => { handleDiscardDraft() }}
                  onTest={id => { void handleTest(id) }}
                  onRefresh={() => { void handleRefresh() }}
                  busy={busy}
                  message={actionMessage}
                  t={translate}
                />
              )
              : (
                <DiagnosticsPanel
                  status={status}
                  region={region}
                  nowMs={nowMs}
                  error={error}
                  t={translate}
                />
              )}

        {/* 最近错误 */}
        {error !== undefined && (
          <p className="dsm-minimax-error">{translate('row.unreachable')}{error === '' ? '' : `: ${error}`}</p>
        )}

      </div>
    </div>
  )
}

export { MINIMAX_CARD_KEYS, MINIMAX_STATUS_PATH }
