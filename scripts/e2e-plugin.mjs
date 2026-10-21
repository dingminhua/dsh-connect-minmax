#!/usr/bin/env node
/**
 * 端到端自检（开发/排障用，不参与插件运行）：直接加载构建产物 `lib/index.js`，
 * 用最小 ctx 桩调用 `apply()`，再通过真实 adapter 走一次 MiniMax 请求
 * （真凭据、真上游、真 SSE）。
 *
 * 它验证的是「宿主之外的最后一公里」：模型目录、思考档位、pi-ai 适配、Bearer 鉴权
 * 与 token 获取是否串起来了。GUI 里的表现仍需在浏览器里看。
 *
 * 用法：
 *   pnpm build && node scripts/e2e-plugin.mjs                 # 默认 MiniMax-M3.1-Flash
 *   node scripts/e2e-plugin.mjs MiniMax-M3 --tools            # 带工具调用
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { apply } = await import(join(here, '..', 'lib', 'index.js'))

const model = process.argv[2]?.startsWith('--') ? 'MiniMax-M3.1-Flash' : (process.argv[2] ?? 'MiniMax-M3.1-Flash')
const withTools = process.argv.includes('--tools')

const captured = { adapters: new Map() }
const ctx = {
  logger: { info: (...a) => console.log('  [info]', ...a), warn: (...a) => console.log('  [warn]', ...a), debug: () => {}, error: (...a) => console.error('  [error]', ...a) },
  llm: {
    listProviders: () => [],
    registerAdapter: (routes, adapter) => {
      for (const route of routes) captured.adapters.set(route, adapter)
      return () => {}
    },
  },
  get: () => undefined,
  inject: () => {},
}

apply(ctx, { models: [], regions: ['cn', 'global'], streamIdleTimeoutMs: 300_000, baseUrl: '' })

// 两条路由各一个 adapter；用 --route=minimax-global 可切到国际版。
const route = process.argv.find(arg => arg.startsWith('--route='))?.slice('--route='.length) ?? 'minimax'
const adapter = captured.adapters.get(route)
if (!adapter) throw new Error(`apply() 没有注册路由 ${route}（已注册：${[...captured.adapters.keys()].join(', ')}）`)
console.log('routes:', [...captured.adapters.keys()].join(', '))

const models = await adapter.listModels(route)
console.log('models:', models.map(m => m.id).join(', '))
for (const info of models) {
  const resolved = await adapter.resolveModel(route, info.id)
  console.log(`  ${info.id}: ctx=${resolved.context?.contextWindow} efforts=[${resolved.reasoning?.efforts.map(e => e.id).join(',') ?? ''}] default=${resolved.reasoning?.defaultEffort ?? '-'}`)
}

const tools = withTools
  ? [{ name: 'get_weather', description: '查询城市天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]
  : undefined

const call = await adapter.prepareCall(route, model)
console.log(`\n== stream ${model}${withTools ? ' (tools)' : ''} ==`)
const started = Date.now()
let text = ''
let reasoning = ''
let toolCalls = []
let finish
for await (const chunk of call.stream({
  provider: 'minimax',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: withTools ? '北京今天天气怎么样？请调用工具。' : '用一句话介绍你自己，然后数到三。' }] }],
  ...(tools === undefined ? {} : { tools }),
  maxTokens: 600,
})) {
  if (chunk.type === 'text-delta') { text += chunk.text; process.stdout.write(chunk.text) }
  if (chunk.type === 'reasoning-delta') reasoning += chunk.text
  if (chunk.type === 'tool-call-delta') toolCalls.push(chunk)
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCalls.push(chunk.block)
  if (chunk.type === 'finish') finish = chunk
  if (chunk.type === 'usage') console.log('\n  usage:', JSON.stringify(chunk.usage))
}
console.log('\n---')
console.log('elapsed:', Date.now() - started, 'ms')
console.log('reasoning chars:', reasoning.length)
console.log('tool calls:', toolCalls.map(t => `${t.name}(${t.arguments ?? t.argumentsDelta ?? ''})`).join(' ') || 'none')
console.log('finish:', JSON.stringify(finish?.reason))
if (finish?.reason?.kind !== 'stop' && finish?.reason?.kind !== 'tool-calls') {
  console.error('❌ 非正常结束', JSON.stringify(finish))
  process.exit(1)
}
if (text.length === 0 && toolCalls.length === 0) {
  console.error('❌ 没有任何输出')
  process.exit(1)
}
console.log('✅ 端到端通过')
process.exit(0)
