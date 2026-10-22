/**
 * 状态路由测试。
 *
 * 三条不变量，每一条都对应一个**具体的失败形态**：
 *
 *  1. **永不抛。** 状态路由挂一次 500，卡片就只能显示"无法读取状态"——用户
 *     看不到任何可操作的信息，而模型那边照样能用。
 *  2. **不无限等。** `auth.inspect()` 要走 unix socket，可能连上但不应答。
 *     没有超时就是一条永久挂起的请求。
 *  3. **不泄露凭据。** 响应里只有登录态、区域、目录与版本号。
 */

import { describe, expect, it } from 'vitest'

import {
  buildMiniMaxStatus,
  inspectWithTimeout,
  isLoopbackRequest,
  MINIMAX_STATUS_PATH,
  MINIMAX_STATUS_TIMEOUT_MS,
  registerMiniMaxStatusRoute,
  safeMessage,
  toStatusModels,
  type MiniMaxStatusAuth,
  type MiniMaxStatusDeps,
  type MiniMaxStatusModelSpec,
  type MiniMaxStatusRouteDeps,
} from '../src/status.ts'

const MODELS: readonly MiniMaxStatusModelSpec[] = [
  { id: 'MiniMax-M3', name: 'M3', contextWindow: 512_000, maxTokens: 128_000, input: ['text', 'image'], reasoning: true, thinkingMode: 'switchable' },
  { id: 'MiniMax-M2.7', name: 'M2.7', contextWindow: 204_800, maxTokens: 131_072, input: ['text', 'image'], reasoning: true, thinkingMode: 'switchable' },
]

/** 一个可控的凭据面替身。 */
function authStub(overrides: Partial<MiniMaxStatusAuth> = {}): MiniMaxStatusAuth {
  return {
    region: 'cn',
    regionLabel: '国内版',
    baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm',
    inspect: async () => ({ state: 'ready', source: 'lease', generation: 3, expiresAtMs: 1_800_000_000_000 }),
    ...overrides,
  }
}

/** 一条路由的依赖（`auth` 换成了 `routes[0]` 里的字段）。 */
function routeStub(overrides: Partial<MiniMaxStatusRouteDeps> = {}): MiniMaxStatusRouteDeps {
  const auth = overrides.auth ?? authStub()
  return {
    route: overrides.route ?? 'minimax',
    region: overrides.region ?? auth.region,
    regionLabel: overrides.regionLabel ?? auth.regionLabel,
    baseUrl: overrides.baseUrl ?? auth.baseUrl,
    auth,
  }
}

function depsStub(overrides: Partial<MiniMaxStatusDeps> = {}): MiniMaxStatusDeps {
  return {
    routes: [routeStub()],
    models: MODELS,
    version: '0.1.0',
    ...overrides,
  }
}

describe('MINIMAX_STATUS_PATH', () => {
  it('固定为 /plugins/dsh-connect-minmax/status', () => {
    expect(MINIMAX_STATUS_PATH).toBe('/plugins/dsh-connect-minmax/status')
  })
})

describe('设备码登录（authorizing）', () => {
  it('验证码与授权地址一路透传到状态文档', async () => {
    const auth = authStub({
      inspect: async () => ({
        state: 'authorizing',
        source: 'file',
        userCode: 'ZHHJ-TCF3',
        verificationUri: 'https://account.minimax.io/oauth-authorize?user_code=ZHHJ-TCF3',
      }),
    })
    const login = await inspectWithTimeout(auth)
    expect(login.userCode).toBe('ZHHJ-TCF3')
    expect(login.verificationUri).toContain('user_code=ZHHJ-TCF3')

    const payload = await buildMiniMaxStatus(depsStub({ routes: [routeStub({ auth })] }))
    expect(payload.routes[0]?.login.userCode).toBe('ZHHJ-TCF3')
    expect(payload.login.userCode).toBe('ZHHJ-TCF3')
  })
})

describe('buildMiniMaxStatus', () => {
  it('组装出完整文档', async () => {
    const payload = await buildMiniMaxStatus(depsStub(), 1_700_000_000_000)
    expect(payload.ok).toBe(true)
    expect(payload.route).toBe('minimax')
    expect(payload.region).toBe('cn')
    expect(payload.regionLabel).toBe('国内版')
    expect(payload.baseUrl).toBe('https://agent.minimax.cn/mavis/api/v1/llm')
    expect(payload.pluginVersion).toBe('0.1.0')
    expect(payload.checkedAt).toBe(1_700_000_000_000)
    expect(payload.login.state).toBe('ready')
    expect(payload.login.source).toBe('lease')
    expect(payload.login.generation).toBe(3)
    expect(payload.routes).toHaveLength(1)
    expect(payload.routes[0]?.route).toBe('minimax')
    expect(payload.routes[0]?.region).toBe('cn')
    expect(payload.routes[0]?.login.state).toBe('ready')
  })

  it('两个区域各自一条路由，顶层字段取第一条', async () => {
    const payload = await buildMiniMaxStatus(depsStub({
      routes: [
        routeStub(),
        routeStub({
          route: 'minimax-global',
          region: 'global',
          regionLabel: '国际版',
          baseUrl: 'https://agent.minimax.io/mavis/api/v1/llm',
          auth: authStub({
            region: 'global',
            regionLabel: '国际版',
            baseUrl: 'https://agent.minimax.io/mavis/api/v1/llm',
            inspect: async () => ({ state: 'missing', source: 'none' }),
          }),
        }),
      ],
    }))
    expect(payload.routes).toHaveLength(2)
    expect(payload.routes[1]?.login.state).toBe('missing')
    expect(payload.region).toBe('cn')
    expect(payload.route).toBe('minimax')
  })

  it('模型目录被投影成可变数组（便于 JSON 序列化）', async () => {
    const payload = await buildMiniMaxStatus(depsStub())
    expect(payload.models).toHaveLength(2)
    expect(payload.models[0]?.input).toEqual(['text', 'image'])
    expect(Array.isArray(payload.models[0]?.input)).toBe(true)
  })

  it('响应里没有任何凭据材料', async () => {
    const payload = await buildMiniMaxStatus(depsStub({
      routes: [routeStub({
        auth: authStub({
          inspect: async () => ({ state: 'ready', source: 'lease', generation: 1, expiresAtMs: 1 }),
        }),
      })],
    }))
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toMatch(/accessToken/i)
    expect(serialized).not.toMatch(/refreshToken/i)
    expect(serialized).not.toMatch(/token"/i)
  })
})

describe('inspectWithTimeout', () => {
  it('inspect 抛错时降级成 error 而不是把异常抛出去', async () => {
    const login = await inspectWithTimeout(authStub({
      inspect: async () => { throw new Error('boom') },
    }))
    expect(login.state).toBe('error')
    expect(login.source).toBe('none')
    expect(login.detail).toContain('boom')
  })

  it('inspect 超过上限时降级成 error（不无限等）', async () => {
    const login = await inspectWithTimeout(authStub({
      // 永不 settle：模拟「broker 连上但不应答」。
      inspect: (_signal?: AbortSignal) => new Promise<never>(() => {}),
    }), 30)
    expect(login.state).toBe('error')
  })

  it('detail 优先取 inspect 自带的，其次取 lastFailure', async () => {
    const withDetail = await inspectWithTimeout(authStub({
      lastFailure: 'from lastFailure',
      inspect: async () => ({ state: 'error', source: 'none', detail: 'from inspect' }),
    }))
    expect(withDetail.detail).toBe('from inspect')

    const withLastFailure = await inspectWithTimeout(authStub({
      lastFailure: 'from lastFailure',
      inspect: async () => ({ state: 'error', source: 'none' }),
    }))
    expect(withLastFailure.detail).toBe('from lastFailure')
  })

  it('超时上限默认 3 秒', () => {
    expect(MINIMAX_STATUS_TIMEOUT_MS).toBe(3_000)
  })
})

describe('safeMessage', () => {
  it('截断长消息', () => {
    // 用**带空格**的文本：一整段 500 个 `x` 本身就是一个 token 形状的片段，
    // 会被遮蔽规则整段换掉 —— 那不是截断的 bug，是遮蔽先于/后于截断的
    // 顺序问题（见 safeMessage 的注释）。
    const message = safeMessage(new Error('word '.repeat(200)))
    expect(message.length).toBeLessThanOrEqual(300)
    expect(message).toBe('word '.repeat(60))
  })

  it('遮蔽长 token 形状的片段', () => {
    const masked = safeMessage(new Error(`failed with ${'a'.repeat(50)}`))
    expect(masked).not.toContain('a'.repeat(50))
    expect(masked).toContain('<redacted>')
  })

  it('遮蔽在截断之后生效，两条规则各自起作用', () => {
    // 前面 200 字符是普通词，后面跟一段 60 字符的 token 形状片段。
    const raw = `${'word '.repeat(40)}${'b'.repeat(60)}`
    const masked = safeMessage(new Error(raw))
    expect(masked).not.toContain('b'.repeat(60))
    expect(masked).toContain('<redacted>')
  })
})

describe('toStatusModels', () => {
  it('input 变成独立副本（不共享原数组）', () => {
    const source: MiniMaxStatusModelSpec = { id: 'x', name: 'X', contextWindow: 1, maxTokens: 1, input: ['text'], reasoning: false, thinkingMode: 'forced' }
    const projected = toStatusModels([source])
    expect(projected[0]?.input).toEqual(['text'])
    expect(projected[0]?.input).not.toBe(source.input)
  })
})

describe('isLoopbackRequest', () => {
  it('接受 127.0.0.1 与 ::1', () => {
    expect(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } } as never)).toBe(true)
    expect(isLoopbackRequest({ socket: { remoteAddress: '::1' } } as never)).toBe(true)
    expect(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } } as never)).toBe(true)
  })

  it('拒绝远程地址与缺失地址', () => {
    expect(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.5' } } as never)).toBe(false)
    expect(isLoopbackRequest({ socket: {} } as never)).toBe(false)
  })
})

describe('registerMiniMaxStatusRoute', () => {
  /** 一个最小的 webServer 替身，记录注册到的路由。 */
  function serverStub(): {
    server: { register(route: { kind: 'exact' | 'prefix', path: string, handler: (req: never, res: never) => void | Promise<void> }): () => void }
    routes: { path: string, handler: (req: never, res: never) => void | Promise<void> }[]
  } {
    const routes: { path: string, handler: (req: never, res: never) => void | Promise<void> }[] = []
    return {
      routes,
      server: {
        register(route) {
          routes.push({ path: route.path, handler: route.handler })
          return () => { /* disposer */ }
        },
      },
    }
  }

  /** 一个最小的 res 替身，记录状态码与应答体。 */
  function resStub(): {
    res: { statusCode: number, body: string, writeHead(status: number, headers: Record<string, string>): void, end(payload: string): void }
    read(): { status: number, body: unknown }
  } {
    let status = 0
    let body = ''
    return {
      res: {
        get statusCode() { return status },
        get body() { return body },
        writeHead(code: number) { status = code },
        end(payload: string) { body = payload },
      } as never,
      read: () => ({ status, body: body === '' ? undefined : JSON.parse(body) }),
    }
  }

  it('注册一条 exact 路由，路径固定', () => {
    const { server, routes } = serverStub()
    registerMiniMaxStatusRoute({ webServer: server }, depsStub())
    expect(routes).toHaveLength(1)
    expect(routes[0]?.path).toBe(MINIMAX_STATUS_PATH)
  })

  it('GET + 回环 → 200 与完整文档', async () => {
    const { server, routes } = serverStub()
    registerMiniMaxStatusRoute({ webServer: server }, depsStub())
    const { res, read } = resStub()
    await routes[0]?.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } } as never, res as never)
    const answer = read()
    expect(answer.status).toBe(200)
    expect((answer.body as { route: string }).route).toBe('minimax')
    expect((answer.body as { models: unknown[] }).models).toHaveLength(2)
  })

  it('非 GET → 405', async () => {
    const { server, routes } = serverStub()
    registerMiniMaxStatusRoute({ webServer: server }, depsStub())
    const { res, read } = resStub()
    await routes[0]?.handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' } } as never, res as never)
    expect(read().status).toBe(405)
  })

  it('非回环 → 403', async () => {
    const { server, routes } = serverStub()
    registerMiniMaxStatusRoute({ webServer: server }, depsStub())
    const { res, read } = resStub()
    await routes[0]?.handler({ method: 'GET', socket: { remoteAddress: '10.0.0.5' } } as never, res as never)
    expect(read().status).toBe(403)
  })

  it('inspect 抛错时仍然回 200 与一份可读的降级文档', async () => {
    const { server, routes } = serverStub()
    registerMiniMaxStatusRoute(
      { webServer: server },
      depsStub({ routes: [routeStub({ auth: authStub({ inspect: async () => { throw new Error('kaboom') } }) })] }),
    )
    const { res, read } = resStub()
    await routes[0]?.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } } as never, res as never)
    const answer = read()
    expect(answer.status).toBe(200)
    const body = answer.body as { ok: boolean, login: { state: string } }
    expect(body.ok).toBe(true)
    expect(body.login.state).toBe('error')
  })
})
