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

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import {
  durationPartsOf,
  expiryBucketOf,
  formatContextWindow,
  MINIMAX_ACCOUNT_REMOVE_PATH,
  MINIMAX_CARD_KEYS,
  MINIMAX_DISPLAY_NAME,
  MINIMAX_GITHUB_URL,
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
  MiniMaxRouteView,
  MiniMaxSigninView,
  MiniMaxStatusView,
} from '../status-paths.ts'
import { MINIMAX_CARD_CSS } from './styles.ts'
import type { MiniMaxSettingsScope } from './settings.ts'
import {
  toggleRegion,
  writeLongContext,
  writeModelContextWindow,
  writeModelImages,
  writeModels,
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

/** 账号页：本机登录 + 副本 + 积分 + 签到。 */
function AccountPanel(props: {
  status: MiniMaxStatusView
  region: string
  nowMs: number
  busy: boolean
  message: string | undefined
  onClaim(): void
  onDelete(route: MiniMaxRouteView): void
  t: MiniMaxTranslate
}): ReactElement {
  const { status, region, nowMs, busy, message, onClaim, onDelete, t } = props
  const routes = routesForRegion(effectiveRoutesOf(status), region)
  const live = routes.find(route => !isCopyRoute(route))
  const copies = routes.filter(route => isCopyRoute(route))
  const signin: MiniMaxSigninView | undefined = live?.signin
  const today = signin?.days.find(day => day.isToday)

  return (
    <div className="dsm-minimax-panel">
      {/* 产品承诺放在账号页第一行：用户在这个页面上要确认的就是"我不会在这里被要求填 key"。 */}
      <p className="dsm-minimax-hint">{t('promise.noApiKey')}</p>

      {routes.length === 0 && (
        <p className="dsm-minimax-hint">{t('account.noneRegistered')}</p>
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
  onSelectAll(): void
  onTest(modelId: string): void
  onLongContext(enabled: boolean): void
  busy: boolean
  message: string | undefined
  t: MiniMaxTranslate
}): ReactElement {
  const {
    status, region, canWrite, probes, onToggleModel, onModelContext, onModelImages, onSelectAll, onTest, onLongContext, busy, message, t,
  } = props
  // 模型目录是**全局**的（两个区域共用同一份 config.yaml 快照），所以这一页
  // 不随区域变化——但路由可用性会变，测试要打当前区域那条路由。
  const routes = routesForRegion(effectiveRoutesOf(status), region)
  const testRoute = routes.find(route => route.login.state === 'ready') ?? routes[0]
  const enabledIds = new Set(status.models.map(model => model.id))
  const catalog = status.catalog
  const allChecked = catalog.every(model => enabledIds.has(model.id))

  return (
    <div className="dsm-minimax-panel">
      <div className="dsm-minimax-panel-head">
        <div>
          <div className="dsm-minimax-panel-title">{t('models.label')}</div>
          <div className="dsm-minimax-hint">
            {t('models.enabledCount', { count: enabledIds.size, total: catalog.length })}
          </div>
        </div>
        <div className="dsm-minimax-panel-actions">
          <label className="dsm-minimax-inline-check" title={canWrite ? t('models.longContextHint') : t('settings.readOnly')}>
            <input
              type="checkbox"
              checked={status.longContext}
              disabled={!canWrite || busy}
              onChange={event => { onLongContext((event.target as HTMLInputElement).checked) }}
            />
            {t('models.longContext')}
          </label>
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

      {catalog.map(model => (
        <ModelRow
          key={model.id}
          model={model}
          enabled={enabledIds.has(model.id)}
          canWrite={canWrite}
          busy={busy}
          probe={probes[`${region}:${model.id}`]}
          route={testRoute?.route}
          onToggle={onToggleModel}
          onModelContext={onModelContext}
          onModelImages={onModelImages}
          onTest={onTest}
          t={t}
        />
      ))}

      {message !== undefined && <p className="dsm-minimax-hint">{message}</p>}
      {!canWrite && <p className="dsm-minimax-hint">{t('settings.readOnly')}</p>}
    </div>
  )
}

/** 一行模型。 */
function ModelRow(props: {
  model: MiniMaxModelView
  enabled: boolean
  canWrite: boolean
  busy: boolean
  probe: ModelProbe | undefined
  route: string | undefined
  onToggle(modelId: string, enabled: boolean): void
  onModelContext(modelId: string, window: number): void
  onModelImages(modelId: string, enabled: boolean): void
  onTest(modelId: string): void
  t: MiniMaxTranslate
}): ReactElement {
  const { model, enabled, canWrite, busy, probe, route, onToggle, onModelContext, onModelImages, onTest, t } = props
  // 上游能力与"当前是否发图"是两件事：`input` 是被 modelImages 掩码后的结果。
  // 只看它就画控件的话，用户一关图片复选框就消失，再也勾不回来了。
  const upstreamImages = (model.upstreamInput.length > 0 ? model.upstreamInput : model.input).includes('image')
  const sendsImages = model.input.includes('image')
  return (
    <div className={`dsm-minimax-row${enabled ? '' : ' dsm-minimax-row-off'}`}>
      <div className="dsm-minimax-row-main">
        <label className="dsm-minimax-model-check" title={canWrite ? '' : t('settings.readOnly')}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canWrite || busy}
            onChange={event => { onToggle(model.id, (event.target as HTMLInputElement).checked) }}
          />
          <span className="dsm-minimax-model-id">{model.id}</span>
        </label>
        <div className="dsm-minimax-model-name">
          {model.name}
          {model.badge === undefined
            ? null
            : <span className="dsm-minimax-chip dsm-minimax-chip-on" style={{ marginLeft: 6 }}>{model.badge}</span>}
        </div>
        <div className="dsm-minimax-model-facts">
          <span>{t('models.context')} {formatContextWindow(model.contextWindow)}</span>
          <span>{t('models.output')} {formatContextWindow(model.maxTokens)}</span>
          {model.contextWindowOptions.length > 1 && (
            <label className="dsm-minimax-inline-check" title={canWrite ? t('models.tierHint') : t('settings.readOnly')}>
              <select
                value={model.contextWindow}
                disabled={!canWrite || busy}
                onChange={event => {
                  onModelContext(model.id, Number((event.target as HTMLSelectElement).value))
                }}
              >
                {model.contextWindowOptions.map(option => (
                  <option key={option} value={option}>
                    {formatContextWindow(option)}
                    {option >= 1_000_000 ? ` ${t('models.higherUsage')}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {upstreamImages
            ? (
              <label className="dsm-minimax-inline-check" title={canWrite ? t('models.imageHint') : t('settings.readOnly')}>
                <input
                  type="checkbox"
                  checked={sendsImages}
                  disabled={!canWrite || busy}
                  onChange={event => {
                    onModelImages(model.id, (event.target as HTMLInputElement).checked)
                  }}
                />
                {t('models.imageYes')}
              </label>
            )
            : <span className="dsm-minimax-chip">{t('models.imageNo')}</span>}
          <span className={`dsm-minimax-chip${model.reasoning ? ' dsm-minimax-chip-on' : ''}`}>
            {model.reasoning
              ? (model.thinkingMode === 'forced' ? t('models.thinkingForced') : t('models.thinkingSwitchable'))
              : t('models.reasoningNo')}
          </span>
        </div>
        {probe !== undefined && (
          <p className={`dsm-minimax-hint${probe.ok === false ? ' dsm-minimax-error' : ''}`} style={{ marginTop: '4px' }}>
            {probe.busy ? t('models.testing') : probe.detail ?? ''}
          </p>
        )}
      </div>
      <div className="dsm-minimax-row-side">
        <button
          type="button"
          className="dsm-minimax-btn dsm-minimax-btn-outline"
          disabled={busy || !enabled || route === undefined}
          onClick={() => { onTest(model.id) }}
        >
          {t('models.test')}
        </button>
      </div>
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

  const handleToggleModel = useCallback(async (modelId: string, enabled: boolean): Promise<void> => {
    if (settingsScope === undefined || status === undefined) return
    const next = nextModelSelection(status, modelId, enabled)
    if (next === null) {
      // 关到只剩最后一个：不允许，那等于把插件自己关没。
      setActionMessage(translate('models.lastEnabled'))
      return
    }
    try {
      await writeModels(settingsScope, next)
      setActionMessage(undefined)
      await afterWrite()
    } catch (caught: unknown) {
      setActionMessage(caught instanceof Error ? caught.message : String(caught))
    }
  }, [settingsScope, status, afterWrite, translate])

  const handleModelContext = useCallback(async (modelId: string, window: number): Promise<void> => {
    if (settingsScope === undefined) return
    try {
      await writeModelContextWindow(settingsScope, modelId, window)
      setActionMessage(undefined)
      await afterWrite()
    } catch (caught: unknown) {
      setActionMessage(caught instanceof Error ? caught.message : String(caught))
    }
  }, [settingsScope, afterWrite])

  const handleModelImages = useCallback(async (modelId: string, wants: boolean): Promise<void> => {
    if (settingsScope === undefined) return
    try {
      await writeModelImages(settingsScope, modelId, wants)
      setActionMessage(undefined)
      await afterWrite()
    } catch (caught: unknown) {
      setActionMessage(caught instanceof Error ? caught.message : String(caught))
    }
  }, [settingsScope, afterWrite])

  const handleSelectAll = useCallback(async (): Promise<void> => {
    if (settingsScope === undefined || status === undefined) return
    // 全部启用 = 写空列表（宿主语义：空 = 目录全部）。这样以后上游新增的模型
    // 会自动出现在用户面前，而不是被一次"全选"永久钉死在旧名单上。
    try {
      await writeModels(settingsScope, [])
      setActionMessage(undefined)
      await afterWrite()
    } catch (caught: unknown) {
      setActionMessage(caught instanceof Error ? caught.message : String(caught))
    }
  }, [settingsScope, status, afterWrite])

  const handleLongContext = useCallback(async (enabled: boolean): Promise<void> => {
    if (settingsScope === undefined) return
    try {
      await writeLongContext(settingsScope, enabled)
      setActionMessage(undefined)
      await afterWrite()
    } catch (caught: unknown) {
      setActionMessage(caught instanceof Error ? caught.message : String(caught))
    }
  }, [settingsScope, afterWrite])

  const handleClaim = useCallback(async (): Promise<void> => {
    setBusy(true)
    const outcome = await postAction(MINIMAX_SIGNIN_CLAIM_PATH, { region })
    setActionMessage(outcome.message)
    await load()
    setBusy(false)
  }, [region, load])

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
                  onSelectAll={() => { void handleSelectAll() }}
                  onTest={id => { void handleTest(id) }}
                  onLongContext={enabled => { void handleLongContext(enabled) }}
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

        {/* 操作行 */}
        <div className="dsm-minimax-actions">
          <button
            type="button"
            className="dsm-minimax-btn dsm-minimax-btn-outline"
            onClick={() => { void load() }}
            disabled={busy}
          >
            {busy ? translate('row.refreshing') : translate('row.refresh')}
          </button>
          <a className="dsm-minimax-updated" href={MINIMAX_GITHUB_URL} target="_blank" rel="noreferrer noopener">
            {MINIMAX_DISPLAY_NAME}
          </a>
        </div>
      </div>
    </div>
  )
}

export { MINIMAX_CARD_KEYS, MINIMAX_STATUS_PATH }
