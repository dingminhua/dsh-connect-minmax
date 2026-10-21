/**
 * MiniMax 状态卡片，贡献给 Harness 的插件配置页。
 *
 * 这张卡片是**只读**的：它回答"现在能用吗、凭据从哪来、有哪些模型"，并**不**
 * 提供任何写入。本插件没有 API Key 输入项，也不保存任何凭据——凭据始终来自
 * 本机登录态，这一点在卡片上明写出来。
 *
 * 数据来自宿主的 `/plugins/dsh-connect-minmax/status` 路由（同源），10 秒
 * 轮询一次，且**只在页面可见时**轮询：后台标签页里的定时器不产生任何收益，
 * 还会让用户以为插件在偷跑。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 卡片外壳的形态、模块加载时注入一次 `<style>` 的写法、轮询与
 *     AbortController 清理，均来自该项目。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import {
  durationPartsOf,
  expiryBucketOf,
  formatContextWindow,
  MINIMAX_CARD_KEYS,
  MINIMAX_DISPLAY_NAME,
  MINIMAX_GITHUB_URL,
  MINIMAX_STATUS_PATH,
  toStatusView,
} from '../status-paths.ts'
import type {
  MiniMaxLoginState,
  MiniMaxLoginView,
  MiniMaxRouteView,
  MiniMaxStatusView,
} from '../status-paths.ts'
import { MINIMAX_CARD_CSS } from './styles.ts'

/** 轮询间隔（毫秒）。 */
export const MINIMAX_POLL_INTERVAL_MS = 10_000

/** 注入到卡片的文案函数。 */
export type MiniMaxTranslate = (key: string, params?: Record<string, unknown>) => string

/** 卡片由浏览器插件注册时注入的面。 */
export interface MiniMaxCardInjected {
  t: MiniMaxTranslate
}

/** 卡片 props。`view` 是宿主给的页面形态（'summary' | 'page'）。 */
export type MiniMaxCardProps = Partial<MiniMaxCardInjected> & { view?: string }

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
 * 一条路由的"你需要做什么"。
 *
 * 与顶层的 {@link loginAdviceOf} 同一套逻辑，但**区分区域**：国内版与国际版
 * 是两个不同的账号，"去登录"要说清是去登录哪个。
 */
export function routeAdviceOf(route: MiniMaxRouteView, t: MiniMaxTranslate): string {
  const region = route.region === 'global' ? 'global' : 'cn'
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

/** 卡片本体。 */
export function MiniMaxCard({ t }: MiniMaxCardProps): ReactElement {
  const translate = t ?? ((key: string) => key)
  const [status, setStatus] = useState<MiniMaxStatusView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
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
    // 只在页面可见时轮询。后台标签页里的定时器不产生任何收益，还会让人
    // 以为插件在偷跑；而 `visibilitychange` 回到前台时立刻补一次。
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

  const nowMs = Date.now()
  const login = status?.login
  // `routes` 为空（旧版本应答）时退化成单路由渲染，不会白屏。
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
              <p
                key={`advice:${route.route}`}
                className="dsm-minimax-hint"
                style={{ marginTop: '8px' }}
              >
                {routeAdviceOf(route, translate)}
              </p>
            ))
            : login !== undefined
              ? (
                <p className="dsm-minimax-hint" style={{ marginTop: '8px' }}>
                  {loginAdviceOf(login, translate)}
                </p>
              )
              : null}
          {/* 产品承诺：明写出来。用户要确认的正是这一点。 */}
          <p className="dsm-minimax-hint" style={{ marginTop: '4px' }}>
            {translate('promise.noApiKey')}
          </p>
        </div>

        {/* 路由区块：每个区域一条 */}
        {routes.length > 0 && (
          <div>
            <p className="dsm-minimax-fact-key" style={{ margin: '0 0 8px' }}>
              {translate('routes.label')}
            </p>
            <table className="dsm-minimax-models">
              <thead>
                <tr>
                  <th>{translate('routes.provider')}</th>
                  <th>{translate('region.label')}</th>
                  <th>{translate('routes.state')}</th>
                  <th>{translate('routes.expires')}</th>
                </tr>
              </thead>
              <tbody>
                {routes.map(route => (
                  <tr key={route.route}>
                    <td>
                      <div className="dsm-minimax-model-id">{route.route}</div>
                      <div className="dsm-minimax-model-name">
                        {providerLabelOf(route.route, translate)}
                      </div>
                    </td>
                    <td title={route.regionLabel}>
                      {translate(route.region === 'global' ? 'region.global' : 'region.cn')}
                    </td>
                    <td>
                      <span className={`dsm-minimax-badge dsm-minimax-badge-${badgeToneOf(route.login.state)}`}>
                        <span className="dsm-minimax-badge-dot" />
                        {translate(`login.${route.login.state}`)}
                      </span>
                      {route.login.state === 'authorizing'
                        && route.login.verificationUri !== undefined
                        && (
                          <div className="dsm-minimax-hint" style={{ marginTop: '4px' }}>
                            {route.login.userCode === undefined
                              ? null
                              : (
                                <span>
                                  {translate('advice.authorizingCode', { code: route.login.userCode })}
                                  {' · '}
                                </span>
                              )}
                            <a href={route.login.verificationUri} target="_blank" rel="noreferrer">
                              {route.login.verificationUri}
                            </a>
                          </div>
                        )}
                    </td>
                    <td>{expiryTextOf(route.login, nowMs, translate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 事实表 */}
        {status !== undefined && (
          <dl className="dsm-minimax-facts">
            {fact(translate('login.source'), translate(sourceLabelKeyOf(status.login.source)))}
            {fact(translate('region.label'), `${status.regionLabel} (${status.region})`)}
            {fact(translate('region.baseUrl'), status.baseUrl)}
            {fact(translate('route.label'), status.route)}
            {status.login.generation === undefined
              ? null
              : fact(translate('login.generation'), String(status.login.generation))}
            {fact(translate('login.expires'), expiryTextOf(status.login, nowMs, translate))}
            {fact(translate('version.label'), status.pluginVersion)}
          </dl>
        )}

        {/* 最近错误 */}
        {error !== undefined && (
          <p className="dsm-minimax-error">
            {translate('row.unreachable')}{error === '' ? '' : `: ${error}`}
          </p>
        )}
        {login?.state === 'error' && login.detail !== undefined && (
          <p className="dsm-minimax-error">{login.detail}</p>
        )}

        {/* 模型表 */}
        {status !== undefined && (
          <div>
            <p className="dsm-minimax-fact-key" style={{ margin: '0 0 8px' }}>
              {translate('models.label')} · {translate('models.count', { count: status.models.length })}
            </p>
            {status.models.length === 0
              ? <p className="dsm-minimax-hint">{translate('models.empty')}</p>
              : (
                <table className="dsm-minimax-models">
                  <thead>
                    <tr>
                      <th>{translate('models.label')}</th>
                      <th>{translate('models.context')}</th>
                      <th>{translate('models.output')}</th>
                      <th>{translate('models.image')}</th>
                      <th>{translate('models.reasoning')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.models.map(model => (
                      <tr key={model.id}>
                        <td>
                          <div className="dsm-minimax-model-id">{model.id}</div>
                          <div className="dsm-minimax-model-name">
                            {model.name}
                            {model.badge === undefined
                              ? null
                              : <span className="dsm-minimax-chip dsm-minimax-chip-on" style={{ marginLeft: 6 }}>
                                  {model.badge}
                                </span>}
                          </div>
                        </td>
                        <td>{formatContextWindow(model.contextWindow)}</td>
                        <td>{formatContextWindow(model.maxTokens)}</td>
                        <td>
                          <span className={`dsm-minimax-chip${model.input.includes('image') ? ' dsm-minimax-chip-on' : ''}`}>
                            {model.input.includes('image')
                              ? translate('models.imageYes')
                              : translate('models.imageNo')}
                          </span>
                        </td>
                        <td>
                          {model.reasoning
                            ? (
                              <span className="dsm-minimax-chip dsm-minimax-chip-on">
                                {model.thinkingMode === 'forced'
                                  ? translate('models.thinkingForced')
                                  : translate('models.thinkingSwitchable')}
                              </span>
                            )
                            : <span className="dsm-minimax-chip">{translate('models.reasoningNo')}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
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
          <a
            className="dsm-minimax-updated"
            href={MINIMAX_GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            {MINIMAX_DISPLAY_NAME}
          </a>
        </div>
      </div>
    </div>
  )
}

export { MINIMAX_CARD_KEYS, MINIMAX_STATUS_PATH }
