#!/usr/bin/env node
/**
 * 端到端验证**动作接口与积分投影**（开发/排障用，不参与插件运行）。
 *
 * 为什么需要它：宿主对插件模块有缓存，`install_bundle` + 开关重载都换不掉
 * 已挂载的 webServer 路由层——要看到新路由只能整个重启 Harness。本脚本绕开
 * 这个限制：起一个**真的** http server，把 `ctx.inject(['webServer'])` 的回调
 * 接到它上面，于是能像浏览器一样打这三条 POST 与那条 GET。
 *
 * 用法：
 *   pnpm build && node scripts/e2e-actions.mjs
 *   node scripts/e2e-actions.mjs --no-claim     # 只读，不测签到领取
 *
 * 注意：`signin/claim` 会**真的改变账户状态**（领当天的积分）。默认跳过，
 * 只有显式带 `--claim` 才发。
 */
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { apply } = await import(join(here, '..', 'lib', 'index.js'))

const wantClaim = process.argv.includes('--claim')

// ---------------------------------------------------------------------------
// 真 http server + 最小 webServer 桩
// ---------------------------------------------------------------------------
const routes = []
const server = http.createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const match = routes.find(route => route.path === path)
  if (match === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }
  void match.handler(req, res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const ctx = {
  logger: {
    info: (...a) => console.log('  [info]', ...a),
    warn: (...a) => console.log('  [warn]', ...a),
    debug: () => {},
    error: (...a) => console.error('  [error]', ...a),
  },
  llm: { listProviders: () => [], registerAdapter: () => () => {} },
  get: () => undefined,
  inject: (services, callback) => {
    if (services.includes('webServer')) {
      callback({
        ...ctx,
        webServer: {
          register: options => {
            routes.push(options)
            return () => {
              const index = routes.indexOf(options)
              if (index >= 0) routes.splice(index, 1)
            }
          },
        },
      })
    }
  },
  effect: (_dispose, _label) => {},
}

apply(ctx, { models: [], regions: ['cn', 'global'], streamIdleTimeoutMs: 300_000, baseUrl: '' })

const base = `http://127.0.0.1:${port}`
console.log('mounted routes:')
for (const route of routes) console.log('  ', route.path)

async function get(path) {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: await response.json() }
}

async function post(path, payload) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

let failures = 0
function check(label, passed, detail = '') {
  console.log(`${passed ? '  ✓' : '  ✗'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!passed) failures += 1
}

// ---------------------------------------------------------------------------
// 1. 状态里的积分与签到
// ---------------------------------------------------------------------------
console.log('\n== GET /status ==')
const status = await get('/plugins/dsh-connect-minmax/status')
check('HTTP 200', status.status === 200)
const cn = status.body.routes?.find(route => route.route === 'minimax')
check('国内版路由存在', cn !== undefined)
check(
  '投影出积分余额',
  typeof cn?.credits?.balance?.totalRemaining === 'number',
  `totalRemaining=${cn?.credits?.balance?.totalRemaining} lots=${cn?.credits?.lotCount} err=${JSON.stringify(cn?.credits?.error ?? cn?.signin?.error)}`,
)
check(
  '投影出签到进度',
  Array.isArray(cn?.signin?.days) && cn.signin.days.length > 0,
  `格子=${cn?.signin?.days?.map(day => `${day.dayNo}:${day.status}${day.isToday ? '*' : ''}`).join(' ')} 今天可领=${cn?.signin?.claimableToday}`,
)
check(
  '最早到期时间有值',
  typeof cn?.credits?.earliestExpiryMs === 'number',
  cn?.credits?.earliestExpiryMs === undefined ? '' : new Date(cn.credits.earliestExpiryMs).toISOString().slice(0, 10),
)

// 缓存：紧接着再打一次，不应该更慢（也不应该再打上游）
const secondStarted = Date.now()
await get('/plugins/dsh-connect-minmax/status')
check('第二次读取命中缓存', Date.now() - secondStarted < 400, `${Date.now() - secondStarted}ms`)

// ---------------------------------------------------------------------------
// 2. 测试模型（真实通路）
// ---------------------------------------------------------------------------
console.log('\n== POST /model/test ==')
const probe = await post('/plugins/dsh-connect-minmax/model/test', { route: 'minimax', model: 'MiniMax-M3.1-Flash' })
check('HTTP 200', probe.status === 200)
check(
  '模型跑通并回了文本',
  probe.body.ok === true,
  `latency=${probe.body.latencyMs}ms sample=${JSON.stringify(probe.body.sample ?? probe.body.error)}`,
)
const badProbe = await post('/plugins/dsh-connect-minmax/model/test', { route: 'nope', model: 'x' })
check('未知路由被拒而不是崩', badProbe.status === 200 && badProbe.body.ok === false, badProbe.body.error)
const missingArgs = await post('/plugins/dsh-connect-minmax/model/test', { route: 'minimax' })
check('缺参数回 400', missingArgs.status === 400)

// ---------------------------------------------------------------------------
// 3. 删除副本（用一条假 id，验证边界而不是真删）
// ---------------------------------------------------------------------------
console.log('\n== POST /account/remove ==')
const removeMissing = await post('/plugins/dsh-connect-minmax/account/remove', { id: 'cn-does-not-exist' })
check('不存在的副本回 404 且不动库', removeMissing.status === 404)
const removeNoId = await post('/plugins/dsh-connect-minmax/account/remove', {})
check('缺 id 回 400', removeNoId.status === 400)

// ---------------------------------------------------------------------------
// 4. 签到领取（默认跳过：它会真的改变账户状态）
// ---------------------------------------------------------------------------
console.log('\n== POST /account/select ==')
const selectBadRegion = await post('/plugins/dsh-connect-minmax/account/select', { id: 'live', region: 'mars' })
check('未知 region 回 400（不猜默认值）', selectBadRegion.status === 400)
const selectBadId = await post('/plugins/dsh-connect-minmax/account/select', { id: 'cn-does-not-exist', region: 'cn' })
check('池里没有的 id 回 404（不假装切成功）', selectBadId.status === 404)
const selectNoId = await post('/plugins/dsh-connect-minmax/account/select', { region: 'cn' })
check('缺 id 回 400', selectNoId.status === 400)
// 切到当前账号本身是幂等的：写一次再写一次都该成功，且不该丢账号列表。
const selectLive = await post('/plugins/dsh-connect-minmax/account/select', { id: 'live', region: 'cn' })
check('切到本机登录成功', selectLive.status === 200 && selectLive.body.active === 'live', JSON.stringify(selectLive.body))

console.log('\n== POST /account/refresh ==')
const refreshOk = await post('/plugins/dsh-connect-minmax/account/refresh', { region: 'cn' })
check('刷新重读凭据与积分成功', refreshOk.status === 200 && refreshOk.body.ok === true, JSON.stringify(refreshOk.body))
const refreshBad = await post('/plugins/dsh-connect-minmax/account/refresh', { region: 'mars' })
check('非法 region 回 400', refreshBad.status === 400)

console.log('\n== POST /account/transfer ==')
const badPreview = await post('/plugins/dsh-connect-minmax/account/transfer', { action: 'preview', file: 'not json' })
check('坏文件回 400', badPreview.status === 400)
const badAction = await post('/plugins/dsh-connect-minmax/account/transfer', { action: 'nope' })
check('未知 action 回 400', badAction.status === 400)
const noIds = await post('/plugins/dsh-connect-minmax/account/transfer', { action: 'export', accountIds: [] })
check('空勾选导出回 400（不是"全部"）', noIds.status === 400)

console.log('\n== POST /account/move ==')
const moveBad = await post('/plugins/dsh-connect-minmax/account/move', { region: 'cn', id: 'nope', direction: 'up' })
check('池里没有的 id 回 404', moveBad.status === 404)
const moveDir = await post('/plugins/dsh-connect-minmax/account/move', { region: 'cn', id: 'live', direction: 'sideways' })
check('非法 direction 回 400', moveDir.status === 400)

console.log('\n== POST /signin/claim ==')
if (!wantClaim) {
  console.log('  – 跳过（加 --claim 才会真的领当天积分）')
} else {
  const claim = await post('/plugins/dsh-connect-minmax/signin/claim', { region: 'cn' })
  check('HTTP 200', claim.status === 200, JSON.stringify(claim.body))
}
const claimBadRegion = await post('/plugins/dsh-connect-minmax/signin/claim', { region: 'mars' })
check('非法 region 回 400', claimBadRegion.status === 400)

server.close()
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
