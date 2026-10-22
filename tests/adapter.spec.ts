import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

import { MiniMaxAccountPool } from '../src/pool.ts'
import {
  classifyMessage,
  createMiniMaxProvider,
  errorText,
  guardStream,
  INERT_AUTH,
  MiniMaxAdapter,
  PROVIDER_DISPLAY_NAME,
  switchAccountOf,
} from '../src/adapter.ts'
import type { GuardStreamContext } from '../src/adapter.ts'
import type { MiniMaxAuth } from '../src/auth.ts'
import { MINIMAX_MODELS, ROUTE, toPiModel } from '../src/catalog.ts'

/**
 * 这些测试不联网、不读真实凭据：
 *  guard 逻辑与 provider 装配都可以用假 auth 断言，
 *  `MISSING_CREDENTIAL` 路径在真正发出 HTTP 之前就返回。
 */

/** 一条最小的文本增量，用来证明 chunk 确实被透传。 */
function textChunk(text: string): StreamChunk {
  return { type: 'text-delta', index: 0, text }
}

/** 成功产出一条 chunk 的一次尝试。 */
function succeed(text: string): () => AsyncIterable<StreamChunk> {
  return () => (async function* generate(): AsyncIterable<StreamChunk> {
    yield textChunk(text)
  })()
}

/** 立刻抛错的一次尝试。 */
function fail(error: unknown): () => AsyncIterable<StreamChunk> {
  return () => (async function* generate(): AsyncIterable<StreamChunk> {
    throw error
  })()
}

/** 测试用的国内版网关地址；与 catalog 的默认值一致。 */
const CN_BASE_URL = 'https://agent.minimax.cn/mavis/api/v1/llm'

/** 假 auth：token 可成功/失败，invalidate 计数，另带 adapter 会读的只读属性。 */
function fakeAuth(options: { token?: () => Promise<string>, baseUrl?: string } = {}): {
  auth: MiniMaxAuth
  invalidate: ReturnType<typeof vi.fn>
  token: ReturnType<typeof vi.fn>
} {
  const token = vi.fn(options.token ?? (async () => 'test-token'))
  const invalidate = vi.fn()
  const auth = {
    token,
    invalidate,
    baseUrl: options.baseUrl ?? CN_BASE_URL,
    region: 'cn',
    regionLabel: '国内版',
  } as unknown as MiniMaxAuth
  return { auth, invalidate, token }
}

/** 假 guard：acquire 由测试直接控制。 */
function fakeGuard(overrides: Partial<GuardStreamContext> = {}): {
  guard: GuardStreamContext
  invalidate: ReturnType<typeof vi.fn>
  acquire: ReturnType<typeof vi.fn>
} {
  const acquire = vi.fn(async () => 'test-token')
  const invalidate = vi.fn()
  return {
    guard: { acquire, invalidate, ...overrides },
    acquire,
    invalidate,
  }
}

/** 收集一个流的所有 chunk，失败时把错误原样抛出。 */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 断言 promise/流以指定 code 的 LlmError 失败。 */
async function expectFailure(run: () => Promise<unknown>, code: string): Promise<Error> {
  let caught: unknown
  try {
    await run()
  } catch (error) {
    caught = error
  }
  expect(caught, `期望以 ${code} 失败`).toBeInstanceOf(Error)
  const error = caught as Error & { code?: string }
  expect(error.code).toBe(code)
  return error
}

describe('classifyMessage', () => {
  it('把 401 与 MiniMax 的 invalid access token 归为 AUTH', () => {
    expect(classifyMessage('401 {"error":"invalid access token"}')).toBe('AUTH')
    expect(classifyMessage('Error: invalid access token')).toBe('AUTH')
    expect(classifyMessage('403 forbidden')).toBe('AUTH')
  })

  it('区分限流与配额耗尽', () => {
    expect(classifyMessage('429 rate limit reached')).toBe('RATE_LIMIT')
    expect(classifyMessage('insufficient quota for this request')).toBe('QUOTA')
  })

  it('上下文超限走宿主的结构化分类器', () => {
    expect(classifyMessage('prompt is too long for this model')).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(classifyMessage('maximum context length is 512000 tokens')).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('区分请求非法、服务端与超时', () => {
    expect(classifyMessage('400 invalid request body')).toBe('INVALID_REQUEST')
    expect(classifyMessage('529 overloaded')).toBe('SERVER')
    expect(classifyMessage('request timed out')).toBe('TIMEOUT')
  })

  it('无法识别时给 UNKNOWN，而不是编一个 provider 私有 code', () => {
    expect(classifyMessage('something odd happened')).toBe('UNKNOWN')
  })

  it('pi-ai 包过的 auth 失败归为 MISSING_CREDENTIAL（且不会被当作可重试的 AUTH）', () => {
    const wrapped = 'ModelsError: API key auth failed: MiniMaxAuthUnavailableError: 本机登录凭据不可用：auth.json missing'
    expect(classifyMessage(wrapped)).toBe('MISSING_CREDENTIAL')
  })
})

describe('errorText', () => {
  it('展开 cause 链，便于诊断而不用于控制流', () => {
    const error = new Error('outer', { cause: new TypeError('inner') })
    expect(errorText(error)).toContain('outer')
    expect(errorText(error)).toContain('TypeError: inner')
  })

  it('非 Error 抛出值也能渲染', () => {
    expect(errorText('plain string')).toBe('plain string')
  })
})

describe('guardStream', () => {
  it('凭据不可用时不发起请求，直接报 MISSING_CREDENTIAL', async () => {
    const { guard } = fakeGuard({ acquire: async () => { throw new Error('auth.json missing') } })
    const run = vi.fn(succeed('never')) as unknown as () => AsyncIterable<StreamChunk>
    const error = await expectFailure(() => collect(guardStream(run, guard)), 'MISSING_CREDENTIAL')
    expect(error.message).toContain('MiniMax 本机登录凭据不可用')
    expect(run).not.toHaveBeenCalled()
  })

  it('401 且尚未产出 chunk 时失效缓存并重试一次，第二次成功则正常透传', async () => {
    const { guard, invalidate } = fakeGuard()
    let attempts = 0
    const run = (): AsyncIterable<StreamChunk> => {
      attempts += 1
      return attempts === 1
        ? fail(new Error('401 {"error":"invalid access token"}'))()
        : succeed('hello')()
    }
    const chunks = await collect(guardStream(run, guard))
    expect(chunks).toEqual([textChunk('hello')])
    expect(attempts).toBe(2)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('401 连续两次：只重试一次，最终以 AUTH 失败并提示重新登录', async () => {
    const { guard, invalidate } = fakeGuard()
    let attempts = 0
    const run = (): AsyncIterable<StreamChunk> => {
      attempts += 1
      return fail(new Error('401 {"error":"invalid access token"}'))()
    }
    const error = await expectFailure(() => collect(guardStream(run, guard)), 'AUTH')
    expect(attempts).toBe(2)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(error.message).toContain('MiniMax Code')
  })

  it('已经产出 chunk 之后遇到 401 不重试（流不能撤回）', async () => {
    const { guard, invalidate } = fakeGuard()
    let attempts = 0
    const run = (): AsyncIterable<StreamChunk> => (async function* generate(): AsyncIterable<StreamChunk> {
      attempts += 1
      yield textChunk('partial')
      throw new Error('401 invalid access token')
    })()
    const received: StreamChunk[] = []
    const stream = guardStream(run, guard)
    const error = await expectFailure(async () => {
      for await (const chunk of stream) received.push(chunk)
    }, 'AUTH')
    expect(received).toEqual([textChunk('partial')])
    expect(attempts).toBe(1)
    expect(invalidate).not.toHaveBeenCalled()
    expect(error.message).toContain('MiniMax Code')
  })

  it('非 AUTH 错误直接分类，不消耗重试', async () => {
    const { guard, invalidate } = fakeGuard()
    let attempts = 0
    const run = (): AsyncIterable<StreamChunk> => {
      attempts += 1
      return fail(new Error('429 rate limit'))()
    }
    await expectFailure(() => collect(guardStream(run, guard)), 'RATE_LIMIT')
    expect(attempts).toBe(1)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('调用方取消优先于错误分类，永远报 ABORTED', async () => {
    const { guard } = fakeGuard()
    const controller = new AbortController()
    controller.abort()
    const run = (): AsyncIterable<StreamChunk> => fail(new Error('401 invalid access token'))()
    await expectFailure(() => collect(guardStream(run, guard, controller.signal)), 'ABORTED')
  })

  it('重试前重新取 token：第二次 acquire 之前必须先 invalidate', async () => {
    const order: string[] = []
    const acquire = vi.fn(async () => {
      order.push('acquire')
      return 'token'
    })
    const invalidate = vi.fn(() => {
      order.push('invalidate')
    })
    const guard: GuardStreamContext = { acquire, invalidate }
    let attempts = 0
    const run = (): AsyncIterable<StreamChunk> => {
      attempts += 1
      return attempts === 1 ? fail(new Error('401'))() : succeed('ok')()
    }
    expect(await collect(guardStream(run, guard))).toEqual([textChunk('ok')])
    expect(order).toEqual(['acquire', 'invalidate', 'acquire'])
  })
})

describe('createMiniMaxProvider', () => {
  it('注册 minimax 路由、显示名与模型表，且模型共享同一个 baseUrl', () => {
    const { auth } = fakeAuth()
    const provider = createMiniMaxProvider(auth, MINIMAX_MODELS)
    expect(provider.id).toBe(ROUTE)
    expect(provider.name).toBe(PROVIDER_DISPLAY_NAME)
    expect(provider.baseUrl).toBe(CN_BASE_URL)
    const models = provider.getModels()
    expect(models).toHaveLength(MINIMAX_MODELS.length)
    expect(models.map(model => model.id)).toEqual(MINIMAX_MODELS.map(spec => spec.id))
    for (const model of models) expect(model.baseUrl).toBe(CN_BASE_URL)
  })

  it('baseUrl 覆盖同时作用于 provider 与模型描述', () => {
    const { auth } = fakeAuth()
    const override = 'https://agent.minimax.io/mavis/api/v1/llm'
    const provider = createMiniMaxProvider(auth, MINIMAX_MODELS, { baseUrl: override })
    expect(provider.baseUrl).toBe(override)
    for (const model of provider.getModels()) expect(model.baseUrl).toBe(override)
  })

  it('auth 解析只给 Authorization 头、不给 apiKey（否则会走 x-api-key）', async () => {
    const { auth } = fakeAuth({ token: async () => 'lease-token' })
    const provider = createMiniMaxProvider(auth, MINIMAX_MODELS)
    const resolve = provider.auth.apiKey?.resolve
    expect(resolve).toBeTypeOf('function')
    const result = await resolve!({} as never)
    expect(result?.auth.apiKey).toBeUndefined()
    expect(result?.auth.headers?.authorization).toBe('Bearer lease-token')
    expect(result?.source).toBe('minimax-local-login')
  })

  it('每次解析都重新取 token，因此轮换无需重启', async () => {
    let issued = 0
    const { auth, token } = fakeAuth({ token: async () => `token-${++issued}` })
    const provider = createMiniMaxProvider(auth, MINIMAX_MODELS)
    const resolve = provider.auth.apiKey!.resolve
    const first = await resolve({} as never)
    const second = await resolve({} as never)
    expect(first?.auth.headers?.authorization).toBe('Bearer token-1')
    expect(second?.auth.headers?.authorization).toBe('Bearer token-2')
    expect(token).toHaveBeenCalledTimes(2)
  })

  it('模型描述与目录同源：thinking 走 adaptive + effort，不自己拼 budget_tokens', () => {
    const spec = MINIMAX_MODELS[0]!
    const model = toPiModel(spec, 'https://example.test/mavis/api/v1/llm')
    expect(model.compat).toMatchObject({ forceAdaptiveThinking: true })
    expect(model.thinkingLevelMap?.medium).toBe('medium')
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('MiniMaxAdapter', () => {
  /**
   * 空 profile 的 adapter：只用于验证"取消防抖先于一切"的路径。
   * `super.stream()` 会在解析 profile 时抛 NO_ADAPTER，但 guard 只看 signal。
   */
  function adapterWith(auth: MiniMaxAuth): MiniMaxAdapter {
    const options = {
      profiles: () => new Map(),
      resolveApiKey: async () => undefined,
      auth: INERT_AUTH,
    } satisfies PiAiAdapterOptions
    return new MiniMaxAdapter(options, auth)
  }

  /**
   * 带真实 profile/provider 的 adapter：`prepareCall()` 会先解析模型，
   * 没有 profile 就根本到不了凭据预检，所以这条路径必须用完整装配。
   */
  function adapterWithProfile(auth: MiniMaxAuth): MiniMaxAdapter {
    const piProvider = createMiniMaxProvider(auth, MINIMAX_MODELS)
    const profile: ResolvedPiAiProviderProfile = {
      provider: ROUTE,
      displayName: PROVIDER_DISPLAY_NAME,
      reasoning: 'medium',
      streamIdleTimeoutMs: 300_000,
      retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-minmax test retryPolicy'),
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      maxRequestImageBytes: 20 * 1024 * 1024,
      requestImagePixelBudget: 2048 * 2048,
      requestImageMaxBytes: 1024 * 1024,
      piProvider,
    }
    const profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map([[ROUTE, profile]])
    return new MiniMaxAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined, auth: INERT_AUTH }, auth)
  }

  const call: GenerateOptions = {
    provider: ROUTE,
    model: MINIMAX_MODELS[0]!.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }

  it('凭据不可用时 stream() 报 MISSING_CREDENTIAL（不落到 UNKNOWN）', async () => {
    const { auth } = fakeAuth({ token: async () => { throw new Error('not logged in') } })
    await expectFailure(() => collect(adapterWithProfile(auth).stream(call)), 'MISSING_CREDENTIAL')
  })

  it('prepareCall 返回的流同样先过凭据预检', async () => {
    const { auth } = fakeAuth({ token: async () => { throw new Error('expired') } })
    const adapter = adapterWithProfile(auth)
    const prepared = await adapter.prepareCall(ROUTE, MINIMAX_MODELS[0]!.id)
    await expectFailure(() => collect(prepared.stream(call)), 'MISSING_CREDENTIAL')
  })

  it('用户取消时报 ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    const { auth } = fakeAuth()
    const adapter = adapterWith(auth)
    await expectFailure(
      () => collect(adapter.stream({ ...call, signal: controller.signal })),
      'ABORTED',
    )
  })
})

describe('guardStream / 积分耗尽自动换号', () => {
  // 用户的原话："一个账号积分没有了，自动切换到另外一个账号"。
  // 触发点在请求内：上游回配额错误、且还没吐任何 chunk，就换号重来。
  it('QUOTA 且池里还有别的账号 → 换号重试，用户看到的是正常结果', async () => {
    const switchAccount = vi.fn(() => true)
    const { guard } = fakeGuard({ switchAccount })
    let attempts = 0
    const run = (): AsyncIterable<StreamChunk> => {
      attempts += 1
      if (attempts === 1) return fail(new Error('insufficient balance'))()
      return succeed('换号后成功')()
    }
    const chunks = await collect(guardStream(run, guard))
    // 用户看到的是一次成功的回复，不是一条"积分不足"的错误。
    expect(chunks).toEqual([textChunk('换号后成功')])
    expect(attempts).toBe(2)
    expect(switchAccount).toHaveBeenCalledTimes(1)
  })

  it('换号后仍失败 → 不再换第三次（多账号互相失败时空转没意义）', async () => {
    const switchAccount = vi.fn(() => true)
    const { guard } = fakeGuard({ switchAccount })
    let attempts = 0
    const run = (): AsyncIterable<StreamChunk> => {
      attempts += 1
      return fail(new Error('insufficient quota'))()
    }
    await expectFailure(() => collect(guardStream(run, guard)), 'QUOTA')
    expect(attempts).toBe(2)
    expect(switchAccount).toHaveBeenCalledTimes(1)
  })

  it('池里没有别的账号时直接以 QUOTA 失败（不假称换过）', async () => {
    const switchAccount = vi.fn(() => false)
    const { guard } = fakeGuard({ switchAccount })
    let attempts = 0
    const run = (): AsyncIterable<StreamChunk> => {
      attempts += 1
      return fail(new Error('insufficient balance'))()
    }
    await expectFailure(() => collect(guardStream(run, guard)), 'QUOTA')
    expect(attempts).toBe(1)
  })

  it('已经产出 chunk 后遇到积分不足不重试（流不能撤回）', async () => {
    const switchAccount = vi.fn(() => true)
    const { guard } = fakeGuard({ switchAccount })
    let attempts = 0
    const run = (): AsyncIterable<StreamChunk> => (async function* generate(): AsyncIterable<StreamChunk> {
      attempts += 1
      yield textChunk('半截')
      throw new Error('insufficient balance')
    })()
    const received: StreamChunk[] = []
    await expectFailure(async () => {
      for await (const chunk of guardStream(run, guard)) received.push(chunk)
    }, 'QUOTA')
    expect(received).toEqual([textChunk('半截')])
    expect(attempts).toBe(1)
    expect(switchAccount).not.toHaveBeenCalled()
  })

  it('没有提供 switchAccount 时行为不变（老调用点不受影响）', async () => {
    const { guard } = fakeGuard()
    const run = () => fail(new Error('balance exhausted'))()
    await expectFailure(() => collect(guardStream(run, guard)), 'QUOTA')
  })
})

describe('switchAccountOf（适配器如何发现池的换号能力）', () => {
  /** 最小可用的凭据来源替身。 */
  const localSource = (token = 'mmoat_x') => ({
    region: 'cn' as const,
    regionLabel: '国内版',
    baseUrl: 'https://x',
    token: async () => token,
    invalidate: () => undefined,
  })

  it('池化来源 → 拿到换号函数，调用时真的换号', () => {
    // 这是"自动切换"能被触发的前提：适配器只认接口，能力探测漏了，
    // guardStream 那段 QUOTA 重试就永远不会执行。
    const pool = new MiniMaxAccountPool('cn', { regionLabel: '国内版', baseUrl: 'https://x' })
    pool.setAccounts([
      { id: 'a', label: 'a', live: true, source: localSource('mmoat_a') },
      { id: 'b', label: 'b', live: false, source: localSource('mmoat_b') },
    ])
    const switchAccount = switchAccountOf(pool)
    expect(switchAccount).toBeDefined()
    expect(pool.active).toBe('a')
    expect(switchAccount?.()).toBe(true)
    expect(pool.active).toBe('b')
  })

  it('单账号来源 → undefined（老行为完全不变）', () => {
    expect(switchAccountOf(localSource())).toBeUndefined()
  })
})
