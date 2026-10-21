#!/usr/bin/env node
/**
 * 上游连通性自检（开发/排障用，不参与插件运行）。
 *
 * 走与插件完全相同的两条凭据通路：
 *   1. mcode Auth Lease Broker（unix socket，首选）
 *   2. ~/.minimax/auth/<env>/<region>/mcode-public/auth.json（只读兜底）
 * 然后用拿到的 token 打一次真实的 Anthropic 兼容 /messages 请求。
 *
 * 用法：
 *   node scripts/verify-upstream.mjs            # 只查登录态与 token 可用性
 *   node scripts/verify-upstream.mjs --full     # 额外验证 thinking / 工具 / 流式
 *   node scripts/verify-upstream.mjs --matrix   # 逐模型核对 mcode 的 thinking 线上形态
 *   node scripts/verify-upstream.mjs --json     # 机器可读输出
 *
 * 退出码：0 全部通过；1 有失败项；2 没有可用登录。
 */

import { readFile, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = process.env.DSH_MINIMAX_DATA_DIR ?? join(homedir(), '.minimax')
const SOCKET_NAME = 'mcode-auth-lease-v1.sock'
const CAPABILITY_NAME = 'mcode-auth-lease-v1.cap'
const BASE_URL_CN = 'https://agent.minimax.cn/mavis/api/v1/llm/v1'
const BASE_URL_GLOBAL = 'https://agent.minimax.io/mavis/api/v1/llm/v1'
const MODEL = process.env.DSH_MINIMAX_MODEL ?? 'MiniMax-M3'

const argv = new Set(process.argv.slice(2))
const FULL = argv.has('--full')
const MATRIX = argv.has('--matrix')
const AS_JSON = argv.has('--json')
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  if (!AS_JSON) console.log(`${ok ? '✅' : '❌'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 4 字节大端长度 + UTF-8 JSON。 */
function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const prefix = Buffer.allocUnsafe(4)
  prefix.writeUInt32BE(payload.length, 0)
  return Buffer.concat([prefix, payload])
}

function leaseEndpoint(dataDir) {
  if (process.platform === 'win32') {
    const canonical = dataDir.replace(/[\\/]+$/u, '').toLowerCase()
    const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16)
    return {
      transport: 'pipe',
      endpoint: `\\\\.\\pipe\\mcode-auth-lease-${digest}`,
      capabilityFile: join(dataDir, 'run', CAPABILITY_NAME),
    }
  }
  return {
    transport: 'unix',
    endpoint: join(dataDir, 'run', SOCKET_NAME),
    capabilityFile: join(dataDir, 'run', CAPABILITY_NAME),
  }
}

/** 一次连接发一串请求，按 requestId 收响应。 */
async function brokerCall(requests, timeoutMs = 8000) {
  const { transport, endpoint, capabilityFile } = leaseEndpoint(DATA_DIR)
  const capability = (await readFile(capabilityFile, 'utf8')).trim()
  return await new Promise((resolve, reject) => {
    const socket = connect({ path: endpoint, ...(transport === 'pipe' ? {} : {}) })
    const pending = new Map()
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`auth lease 请求超时（${timeoutMs}ms）`))
    }, timeoutMs)
    const finish = (error, value) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    socket.on('error', error => finish(error))
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (buffer.length < 4 + length) break
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))
        buffer = buffer.subarray(4 + length)
        const waiter = pending.get(message.requestId)
        if (waiter === undefined) continue
        pending.delete(message.requestId)
        waiter(message)
      }
      if (pending.size === 0) finish(undefined, replies)
    })
    const replies = []
    socket.on('connect', () => {
      for (const body of requests) {
        const requestId = randomUUID()
        pending.set(requestId, message => {
          // 响应顺序不保证与请求一致，按 method 贴标签后再交回调用方。
          replies.push({ method: body.method, message })
          if (replies.length === requests.length) finish(undefined, replies)
        })
        socket.write(encodeFrame({ version: 1, requestId, capability, ...body }))
      }
    })
  })
}

function pickRecord(raw) {
  const parsed = JSON.parse(raw)
  if (typeof parsed.accessToken === 'string') return parsed
  const records = parsed.records
  if (records === null || typeof records !== 'object') return undefined
  for (const value of Object.values(records)) {
    if (typeof value?.accessToken === 'string') return value
  }
  return undefined
}

async function readCredentialsFile() {
  for (const buildEnv of ['prod', 'pre', 'test', 'dev']) {
    for (const region of ['cn', 'en']) {
      const dir = join(DATA_DIR, 'auth', buildEnv, region, 'mcode-public')
      try {
        const [authRaw, stateRaw] = await Promise.all([
          readFile(join(dir, 'auth.json'), 'utf8'),
          readFile(join(dir, 'auth-state.json'), 'utf8').catch(() => '{}'),
        ])
        const record = pickRecord(authRaw)
        if (record === undefined) continue
        const state = JSON.parse(stateRaw)
        return { ...record, dir, buildEnv, region, stateStatus: state.status, stateRegion: state.region }
      } catch {
        continue
      }
    }
  }
  return undefined
}

async function main() {
  // 1. 登录态
  let lease
  try {
    const replies = await brokerCall([
      { method: 'status' },
      { method: 'lease', minValidityMs: 60_000 },
    ])
    const byMethod = name => replies.find(item => item.method === name)?.message
    const statusReply = byMethod('status')
    const leaseReply = byMethod('lease')
    lease = leaseReply?.ok === true ? leaseReply.result : undefined
    const status = statusReply?.ok === true ? statusReply.result : undefined
    record('auth lease broker', lease !== undefined, status === undefined ? 'status 不可读' : `status=${status.status} generation=${status.generation}`)
  } catch (error) {
    const file = await readCredentialsFile().catch(() => undefined)
    const usable = file !== undefined && file.expiresAtMs > Date.now() + 60_000
    record('auth lease broker', false, `${error.message}；回退到本地文件：${file === undefined ? '无凭据' : usable ? '可用' : '已过期'}`)
  }
  const file = await readCredentialsFile().catch(() => undefined)
  const token = lease?.accessToken ?? (file !== undefined && file.expiresAtMs > Date.now() + 60_000 ? file.accessToken : undefined)
  if (token === undefined) {
    record('可用 access token', false, '没有可用的本机登录凭据；请在 MiniMax Code 里登录后重试')
    return finish(2)
  }
  record('可用 access token', true, lease === undefined ? `来源=本地文件（region=${file?.region ?? '?'}）` : '来源=mcode 租约')
  const region = (file?.region ?? 'cn') === 'en' ? 'global' : 'cn'
  const baseUrl = region === 'global' ? BASE_URL_GLOBAL : BASE_URL_CN

  // 2. 最小请求
  const call = async (body, label) => {
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) {
      record(label, false, `HTTP ${response.status} ${text.slice(0, 200)}`)
      return undefined
    }
    record(label, true, `HTTP 200 ${text.slice(0, 80).replace(/\s+/g, ' ')}`)
    return text
  }

  await call({ model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'ping' }] }, `messages（${MODEL}）`)
  if (MATRIX) return finish(await thinkingMatrix(call))
  if (!FULL) return finish(0)

  // 3. thinking
  await call({ model: MODEL, max_tokens: 1200, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: '用一句话解释递归' }] }, 'thinking adaptive')

  // 4. 工具调用
  await call(
    {
      model: MODEL,
      max_tokens: 200,
      thinking: { type: 'disabled' },
      tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      messages: [{ role: 'user', content: '北京天气如何？请调用工具' }],
    },
    'tool_use',
  )

  // 5. 流式（只读到第一个 content_block_start 就算通）
  try {
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: MODEL, max_tokens: 64, stream: true, messages: [{ role: 'user', content: '数到三' }] }),
    })
    const text = await response.text()
    const ok = response.ok && text.includes('content_block_delta')
    record('streaming SSE', ok, ok ? '收到 content_block_delta' : `HTTP ${response.status} ${text.slice(0, 160)}`)
  } catch (error) {
    record('streaming SSE', false, error.message)
  }

  return finish(results.every(item => item.ok) ? 0 : 1)
}


/**
 * 逐模型核对 mcode 自己的 thinking 线上形态（依据 MiniMax Code 的
 * `@mavis/local-runtime/src/model-provider/thinking.ts`）：
 *
 *   - MiniMax-M3 只有 on/off：`thinking:{type:'adaptive'}` 配 `output_config.effort:'on'`，
 *     关闭时 `thinking:{type:'disabled'}` 且不带 output_config；
 *   - 其他模型把用户选的 effort 原样放进 `output_config.effort`（含 `default`）。
 *
 * 任何一项失败都意味着插件与 MiniMax Code 的真实行为不一致。
 */
/** 1×1 红色 PNG。 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

async function thinkingMatrix(call) {
  const prompts = [{ role: 'user', content: '一句话解释递归' }]
  const cases = [
    ['MiniMax-M3', { thinking: { type: 'adaptive' }, output_config: { effort: 'on' } }, 'M3 adaptive + effort=on'],
    ['MiniMax-M3', { thinking: { type: 'disabled' } }, 'M3 disabled（无 output_config）'],
    ['MiniMax-M3.1-Flash', { thinking: { type: 'adaptive' }, output_config: { effort: 'default' } }, 'M3.1-Flash adaptive + effort=default'],
    ['MiniMax-M3.1-Flash', { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }, 'M3.1-Flash adaptive + effort=low'],
    ['MiniMax-M2.7', { thinking: { type: 'adaptive' }, output_config: { effort: 'on' } }, 'M2.7 adaptive + effort=on'],
    ['MiniMax-M2.7-highspeed', { thinking: { type: 'disabled' } }, 'M2.7-highspeed disabled'],
    ['MiniMax-M3', { thinking: { type: 'adaptive' } }, 'M3 adaptive（无 effort）'],
    ['MiniMax-M3', { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } }, 'M3 adaptive + effort=medium'],
    ['MiniMax-M3.1-Flash', { thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } }, 'M3.1-Flash adaptive + effort=xhigh'],
    ['MiniMax-M2.7', { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } }, 'M2.7 adaptive + effort=medium'],
    ['MiniMax-M2.7', { thinking: { type: 'adaptive' } }, 'M2.7 adaptive（无 effort）'],
    ['MiniMax-M2.7-highspeed', { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }, 'M2.7-highspeed adaptive + effort=max'],
    ['MiniMax-M2.7', { thinking: { type: 'disabled' }, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } }, { type: 'text', text: '这张图是什么颜色？一个字回答' }] }] }, 'M2.7 图片输入'],
    ['MiniMax-M2.7-highspeed', { thinking: { type: 'disabled' }, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } }, { type: 'text', text: '这张图是什么颜色？一个字回答' }] }] }, 'M2.7-highspeed 图片输入'],
  ]
  let failed = 0
  for (const [model, patch, label] of cases) {
    const text = await call({ model, max_tokens: 1200, ...patch, messages: prompts }, label)
    if (text === undefined) {
      failed += 1
      continue
    }
    const thinking = text.includes('"type":"thinking"')
    if (!AS_JSON) console.log(`   ${thinking ? '含思考块' : '无思考块'} · ${model}`)
  }
  return failed === 0 ? 0 : 1
}

function finish(code) {
  if (AS_JSON) console.log(JSON.stringify({ code, results }, null, 2))
  else {
    const failed = results.filter(item => !item.ok)
    console.log(failed.length === 0 ? '\n全部检查通过。' : `\n${failed.length} 项失败。`)
  }
  process.exit(code)
}

main().catch(error => {
  console.error('自检脚本崩溃：', error)
  process.exit(1)
})
