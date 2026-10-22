/**
 * 卡片用的三个动作接口（POST）。
 *
 * 状态路由是只读的，而卡片上有三件事必须由宿主代做：
 *
 *  - **代领当天签到**：只有点按钮才发，绝不自动领；
 *  - **删除一个账号副本**：删的是插件自己的库（`~/.dsh/.minimax-accounts.json`），
 *    从不碰 MiniMax Code 的文件；
 *  - **测试一个模型**：打一发最小请求，把延迟与错误原样带回来。
 *
 * # 安全边界
 *
 * 三条都挂在 loopback 之后（沿用 `isLoopbackRequest`），且都是 POST —— 浏览器
 * 跨站表单只能发 GET/POST，loopback + 同源校验已经把"网页骗着点"这条路堵住。
 * 请求体有长度上限，避免一个坏 body 把进程拖住。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { routeForRegion, type MiniMaxRegion } from './catalog.ts'
import { claimSignin, fetchSigninStatus } from './credits.ts'
import { accountRouteOf, readAccounts, writeAccounts } from './accounts.ts'
import { invalidateAccountCache, isLoopbackRequest, json, safeMessage } from './status.ts'

/** 动作路由的挂载点。 */

/**
 * 动作路径统一由 `status-paths.ts` 定义后转出。
 *
 * 曾经两个文件各写一份字符串：改一处忘另一处就会让卡片 POST 到一个不存在的
 * 路径，而两边都"有常量"、都不报错。单一出处就是为了避免这种沉默的不一致。
 */
import {
  MINIMAX_ACCOUNT_REFRESH_PATH,
  MINIMAX_ACCOUNT_REMOVE_PATH,
  MINIMAX_ACCOUNT_SELECT_PATH,
  MINIMAX_MODEL_TEST_PATH,
  MINIMAX_SETTINGS_SAVE_PATH,
  MINIMAX_SIGNIN_CLAIM_PATH,
  unwrapVolatileDeep,
} from './status-paths.ts'

export {
  MINIMAX_ACCOUNT_REFRESH_PATH,
  MINIMAX_ACCOUNT_REMOVE_PATH,
  MINIMAX_ACCOUNT_SELECT_PATH,
  MINIMAX_MODEL_TEST_PATH,
  MINIMAX_SETTINGS_SAVE_PATH,
  MINIMAX_SIGNIN_CLAIM_PATH,
}

/** 请求体上限：这些动作只带一个 id 或一个模型名。 */
const MAX_BODY_BYTES = 8_192

/** 动作路由需要的依赖。 */
export interface MiniMaxActionDeps {
  /** 按区域取一个可用 token（本机登录优先）。 */
  tokenForRegion(region: MiniMaxRegion, signal?: AbortSignal): Promise<string>
  /**
   * 按路由测试一次最小请求。
   *
   * 交给调用方实现，因为"怎么打一发请求"要复用适配器那条真实通路
   * （baseUrl、鉴权头、思考档位），在这里重造一份就等于测了个假链路。
   */
  /**
   * 宿主侧保存一个配置字段，返回**真正落盘**的值。
   *
   * 浏览器侧 `ConfigForm.set` 在这台宿主上会静默不落盘（workbuddy 的 0.1.7
   * 缺陷同款）；真写入必须在宿主进程里 `settings.mutate`。端点把拒绝的原始
   * 异常带回来，所以失败是有名字的，而不是一个被吞掉的 ok:false。
   */
  saveField?(field: string, value: unknown): Promise<Record<string, unknown> | undefined>
  testModel(route: string, model: string, signal?: AbortSignal): Promise<MiniMaxModelTestResult>
  /**
   * 把池里某个账号设为某区域的当前账号。
   *
   * @returns 切换成功返回 `true`；该区域池里没有这个 id 返回 `false`。
   */
  selectAccount?(region: MiniMaxRegion, id: string): Promise<boolean>
  /**
   * 重新读取本机登录态、账号副本与积分缓存。
   *
   * 卡片上的「刷新」按钮用它：浏览器端重拉状态只会拿到**缓存里的**旧读数，
   * 真正要重新读的是盘上凭据与上游积分——那些只有宿主侧能做。
   */
  refreshAccount?(region: MiniMaxRegion): Promise<void>
  /** 日志面（可选）。 */
  log?: (message: string) => void
}

/** 模型测试结果。 */
export interface MiniMaxModelTestResult {
  ok: boolean
  latencyMs: number
  /** 成功时回一小段文本，证明真跑通了而不是只连上了。 */
  sample?: string
  error?: string
}

/** webServer 的最小面。 */
export interface MiniMaxActionContext {
  webServer: {
    register(options: {
      kind: 'exact'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }): () => void
  }
}

/**
 * 读一个 JSON body。
 *
 * 超限、非法 JSON、非对象都返回 `undefined`：动作接口宁可不做事，也不猜参数。
 */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function regionOf(value: unknown): MiniMaxRegion | undefined {
  return value === 'cn' || value === 'global' ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 只接受 loopback 的 POST；其余一律拒。 */
async function guardPost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method not allowed' })
    return undefined
  }
  if (!isLoopbackRequest(req)) {
    json(res, 403, { error: 'origin-not-trusted' })
    return undefined
  }
  return await readBody(req)
}

/**
 * 注册三条动作路由。
 *
 * @returns 一个 disposer，撤销全部注册。
 */
export function registerMiniMaxActionRoutes(
  ctx: MiniMaxActionContext,
  deps: MiniMaxActionDeps,
): () => void {
  const disposers: Array<() => void> = []

  // ---------------------------------------------------------------
  // POST /signin/claim —— 代领当天签到
  // ---------------------------------------------------------------
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: MINIMAX_SIGNIN_CLAIM_PATH,
    handler: async (req, res) => {
      const body = await guardPost(req, res)
      if (body === undefined) return
      const region = regionOf(body['region'])
      if (region === undefined) return json(res, 400, { error: 'region must be cn or global' })
      try {
        const token = await deps.tokenForRegion(region)
        // 先问服务端"今天到底能不能领"：能领才发 claim。上游的 status 是四值枚举
        // （1 未到 / 2 可领 / 3 已领 / 4 不发），跳过这一步就会对着不能领的日子发写请求。
        const status = await fetchSigninStatus(region, token)
        if (!status.ok) return json(res, 502, { error: status.error ?? '签到状态读取失败' })
        if (!status.claimableToday) {
          return json(res, 200, { ok: true, claimed: false, message: '今天不需要领取（还没轮到或已经领过）。' })
        }
        const outcome = await claimSignin(region, token)
        deps.log?.(`signin claim (${region}) → claimed=${outcome.claimed}`)
        // 卡片紧接着就会重读状态；不清缓存的话它拿到的是 60 秒内的旧读数——
        // 按钮继续亮着、余额不动，用户以为没生效（真实反馈过的现象）。
        invalidateAccountCache(routeForRegion(region))
        return json(res, outcome.ok ? 200 : 502, outcome)
      } catch (error: unknown) {
        return json(res, 502, { ok: false, claimed: false, error: safeMessage(error) })
      }
    },
  }))

  // ---------------------------------------------------------------
  // POST /account/remove —— 删除一个账号副本
  // ---------------------------------------------------------------
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: MINIMAX_ACCOUNT_REMOVE_PATH,
    handler: async (req, res) => {
      const body = await guardPost(req, res)
      if (body === undefined) return
      const id = stringOf(body['id'])
      if (id === undefined) return json(res, 400, { error: 'id is required' })
      try {
        const accounts = await readAccounts()
        const target = accounts.find(account => account.id === id)
        if (target === undefined) return json(res, 404, { error: `账号副本 ${id} 不存在。` })
        // 只删插件自己库里的这一条：MiniMax Code 的凭据文件从不被本插件写入。
        await writeAccounts(accounts.filter(account => account.id !== id))
        // 该副本可能正被池选为当前账号；它的积分数也随路由一起消失，别留在缓存里。
        invalidateAccountCache(accountRouteOf(target))
        invalidateAccountCache(routeForRegion(target.region))
        deps.log?.(`removed account copy ${id} (${target.region}, owned=${target.owned})`)
        return json(res, 200, { ok: true, removed: id })
      } catch (error: unknown) {
        return json(res, 500, { error: safeMessage(error) })
      }
    },
  }))

  // ---------------------------------------------------------------
  // POST /account/select —— 把池里某个账号设为当前账号
  // ---------------------------------------------------------------
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: MINIMAX_ACCOUNT_SELECT_PATH,
    handler: async (req, res) => {
      const body = await guardPost(req, res)
      if (body === undefined) return
      const id = stringOf(body['id'])
      const region = body['region'] === 'global' ? 'global' : body['region'] === 'cn' ? 'cn' : undefined
      if (id === undefined || region === undefined) {
        return json(res, 400, { error: 'id and region are required' })
      }
      if (deps.selectAccount === undefined) {
        return json(res, 501, { error: '账号池不可用。' })
      }
      try {
        const ok = await deps.selectAccount(region, id)
        if (!ok) return json(res, 404, { error: `账号池里没有 ${id}。` })
        return json(res, 200, { ok: true, active: id })
      } catch (error: unknown) {
        return json(res, 500, { error: safeMessage(error) })
      }
    },
  }))

  // ---------------------------------------------------------------
  // POST /__save —— 宿主侧保存配置字段（真写入）
  // ---------------------------------------------------------------
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: MINIMAX_SETTINGS_SAVE_PATH,
    handler: async (req, res) => {
      const body = await guardPost(req, res)
      if (body === undefined) return
      if (deps.saveField === undefined) return json(res, 503, { error: 'settings service unavailable to this fiber' })
      const field = typeof body['field'] === 'string' ? body['field'] : undefined
      if (field === undefined) return json(res, 400, { error: 'field is required' })
      try {
        const value = await deps.saveField(field, body['value'])
        return json(res, 200, value === undefined ? { ok: true } : { ok: true, value })
      } catch (error: unknown) {
        return json(res, 500, { error: safeMessage(error) })
      }
    },
  }))

  // ---------------------------------------------------------------
  // POST /account/refresh —— 重新读取本机登录态、账号副本与积分
  // ---------------------------------------------------------------
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: MINIMAX_ACCOUNT_REFRESH_PATH,
    handler: async (req, res) => {
      const body = await guardPost(req, res)
      if (body === undefined) return
      const region = regionOf(body['region'])
      if (region === undefined) return json(res, 400, { error: 'region must be cn or global' })
      if (deps.refreshAccount === undefined) return json(res, 501, { error: '刷新不可用。' })
      try {
        await deps.refreshAccount(region)
        return json(res, 200, { ok: true })
      } catch (error: unknown) {
        return json(res, 500, { error: safeMessage(error) })
      }
    },
  }))

  // ---------------------------------------------------------------
  // POST /model/test —— 用真实通路测一个模型
  // ---------------------------------------------------------------
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: MINIMAX_MODEL_TEST_PATH,
    handler: async (req, res) => {
      const body = await guardPost(req, res)
      if (body === undefined) return
      const route = stringOf(body['route'])
      const model = stringOf(body['model'])
      if (route === undefined || model === undefined) {
        return json(res, 400, { error: 'route and model are required' })
      }
      try {
        return json(res, 200, await deps.testModel(route, model))
      } catch (error: unknown) {
        return json(res, 200, { ok: false, latencyMs: 0, error: safeMessage(error) })
      }
    },
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
