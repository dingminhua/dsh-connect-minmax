/**
 * AuthLeaseClient 的协议级测试：**全部离线**。
 *
 * 用一个真实的 unix socket server（`node:net`）实现与 mcode broker 相同的帧协议，
 * 覆盖 status/lease、能力校验、错误码、超时降级与「socket 不存在」的可用性判断。
 * 不读真实凭据、不联网、不写 `~/.minimax`。
 */

import { createServer, type Server } from 'node:net'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AuthLeaseClient,
  AuthLeaseError,
  resolveLeaseEndpoint,
  windowsPipeName,
} from '../src/lease.ts'

const POSIX_ONLY = process.platform === 'win32' ? describe.skip : describe

/** 43 字符 base64url，与 mcode 生成的 capability 形状一致。 */
const CAPABILITY = 'A'.repeat(43)

type BrokerRequest = Record<string, unknown>
type HandlerResult = Record<string, unknown> | 'silent' | 'oversize'
type Handler = (request: BrokerRequest) => HandlerResult

interface FakeBroker {
  requests: BrokerRequest[]
  close(): Promise<void>
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(body.byteLength, 0)
  return Buffer.concat([prefix, body])
}

function ok(requestId: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { version: 1, requestId, ok: true, result }
}

async function startBroker(
  dataDir: string,
  handler: Handler,
  capability: string | undefined = CAPABILITY,
): Promise<FakeBroker> {
  const runDir = join(dataDir, 'run')
  await mkdir(runDir, { recursive: true })
  if (capability !== undefined) {
    await writeFile(join(runDir, 'mcode-auth-lease-v1.cap'), `${capability}\n`, { mode: 0o600 })
  }

  const requests: BrokerRequest[] = []
  const server: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.byteLength < 4) return
      const length = buffer.readUInt32BE(0)
      if (length === 0 || buffer.byteLength < 4 + length) return
      const request = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as BrokerRequest
      buffer = buffer.subarray(4 + length)
      requests.push(request)
      const result = handler(request)
      if (result === 'silent') return
      if (result === 'oversize') {
        const prefix = Buffer.alloc(4)
        prefix.writeUInt32BE(70_000, 0)
        socket.write(Buffer.concat([prefix, Buffer.from('{}', 'utf8')]))
        return
      }
      socket.write(encodeFrame(result))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(join(runDir, 'mcode-auth-lease-v1.sock'), () => resolve())
  })

  return {
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/** 每个测试一个独立临时目录（放在 `/tmp` 下，避免 unix socket 路径长度超限）。 */
async function tempDir(): Promise<string> {
  return mkdtemp(join('/tmp', 'mm-lease-'))
}

async function expectLeaseError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AuthLeaseError)
  await promise.catch((error: unknown) => {
    expect((error as AuthLeaseError).code).toBe(code)
  })
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function track(dir: string, broker?: FakeBroker): void {
  cleanups.push(async () => {
    await broker?.close()
    await rm(dir, { recursive: true, force: true })
  })
}

POSIX_ONLY('resolveLeaseEndpoint', () => {
  it('在 POSIX 上落在 <dataDir>/run 下', () => {
    const { endpoint, capabilityFile } = resolveLeaseEndpoint('/home/u/.minimax', 'darwin')
    expect(endpoint).toBe('/home/u/.minimax/run/mcode-auth-lease-v1.sock')
    expect(capabilityFile).toBe('/home/u/.minimax/run/mcode-auth-lease-v1.cap')
  })

  it('在 Windows 上用 sha256(canonicalDataDir.toLowerCase()) 前 16 位命名管道', () => {
    const pipe = windowsPipeName('C:\\Users\\u\\.minimax')
    expect(pipe.startsWith('\\\\.\\pipe\\mcode-auth-lease-')).toBe(true)
    expect(pipe.slice('\\\\.\\pipe\\mcode-auth-lease-'.length)).toMatch(/^[a-f0-9]{16}$/u)
    // canonical 化会 toLowerCase：大小写不同的同一路径必须得到同一个管道名。
    // （尾部反斜杠的归一化依赖 win32 的 path.resolve，只在 Windows 上成立，故不在此断言。）
    expect(windowsPipeName('c:\\users\\u\\.minimax')).toBe(pipe)
  })
})

POSIX_ONLY('AuthLeaseClient', () => {
  it('status 返回登录态与 generation', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) =>
      ok(request['requestId'], {
        method: 'status',
        status: 'authenticated',
        generation: 7,
        expiresAtMs: 1_700_000_000_000,
      }),
    )
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    const status = await client.status()
    expect(status).toEqual({
      status: 'authenticated',
      generation: 7,
      expiresAtMs: 1_700_000_000_000,
    })
    expect(broker.requests).toHaveLength(1)
    expect(broker.requests[0]).toMatchObject({
      version: 1,
      capability: CAPABILITY,
      method: 'status',
    })
    expect(typeof broker.requests[0]?.['requestId']).toBe('string')
    // status 不带 minValidityMs。
    expect(broker.requests[0]).not.toHaveProperty('minValidityMs')
    client.close()
  })

  it('lease 默认要 60000ms 最小有效期的租约', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) =>
      ok(request['requestId'], {
        method: 'lease',
        accessToken: 'mmoat_test_token',
        expiresAtMs: 1_800_000_000_000,
        generation: 3,
        audience: 'agent-backend',
        scopes: ['agent.default'],
      }),
    )
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expect(client.lease()).resolves.toEqual({
      accessToken: 'mmoat_test_token',
      expiresAtMs: 1_800_000_000_000,
      generation: 3,
    })
    expect(broker.requests[0]).toMatchObject({ method: 'lease', minValidityMs: 60_000 })
    client.close()
  })

  it('lease 透传调用方给的 minValidityMs', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) =>
      ok(request['requestId'], {
        method: 'lease',
        accessToken: 'mmoat_x',
        expiresAtMs: 1,
        generation: 0,
      }),
    )
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await client.lease(300_000)
    expect(broker.requests[0]).toMatchObject({ minValidityMs: 300_000 })
    client.close()
  })

  it('minValidityMs 越界直接拒绝，不建立连接', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) =>
      ok(request['requestId'], { method: 'lease', accessToken: 'x', expiresAtMs: 1, generation: 0 }),
    )
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expectLeaseError(client.lease(-1), 'INVALID_REQUEST')
    await expectLeaseError(client.lease(300_001), 'INVALID_REQUEST')
    expect(broker.requests).toHaveLength(0)
    client.close()
  })

  it('能力文件里带换行也能用（必须 strip）', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) =>
      ok(request['requestId'], { method: 'status', status: 'authenticated', generation: 1 }),
    )
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expect(client.status()).resolves.toMatchObject({ status: 'authenticated' })
    expect(broker.requests[0]?.['capability']).toBe(CAPABILITY)
    client.close()
  })

  it('broker 拒绝能力时抛 CAPABILITY_REJECTED', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) => ({
      version: 1,
      requestId: request['requestId'],
      ok: false,
      error: { code: 'CAPABILITY_REJECTED', message: 'Desktop authentication capability was rejected.' },
    }))
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expectLeaseError(client.lease(), 'CAPABILITY_REJECTED')
    client.close()
  })

  it('未登录时抛 AUTH_REQUIRED（不重试）', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) => ({
      version: 1,
      requestId: request['requestId'],
      ok: false,
      error: { code: 'AUTH_REQUIRED', message: 'Desktop authentication is required.' },
    }))
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expectLeaseError(client.lease(), 'AUTH_REQUIRED')
    expect(broker.requests).toHaveLength(1)
    client.close()
  })

  it('不暴露 unauthorized 能力（调用它会登出用户），且失败后不补发任何请求', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) =>
      ok(request['requestId'], { method: 'status', status: 'authenticated', generation: 1 }),
    )
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    // 硬不变量：客户端根本没有这个方法，运行时也拿不到。
    expect('unauthorized' in client).toBe(false)
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(client))).not.toContain('unauthorized')

    await client.status()
    await client.lease(60_000).catch(() => undefined)
    // 无论成功失败，发出去的 method 只可能是 status / lease。
    expect(broker.requests.every((r) => r['method'] === 'status' || r['method'] === 'lease')).toBe(
      true,
    )
    client.close()
  })

  it('未知错误码折算成 INTERNAL_ERROR', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) => ({
      version: 1,
      requestId: request['requestId'],
      ok: false,
      error: { code: 'SOMETHING_NEW', message: 'boom' },
    }))
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expectLeaseError(client.status(), 'INTERNAL_ERROR')
    client.close()
  })

  it('协议版本不符抛 PROTOCOL_MISMATCH', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) => ({
      version: 2,
      requestId: request['requestId'],
      ok: true,
      result: { method: 'status', status: 'authenticated', generation: 1 },
    }))
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expectLeaseError(client.status(), 'PROTOCOL_MISMATCH')
    client.close()
  })

  it('requestId 不匹配抛 PROTOCOL_MISMATCH', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, () =>
      ok('not-the-request-id', { method: 'status', status: 'authenticated', generation: 1 }),
    )
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expectLeaseError(client.status(), 'PROTOCOL_MISMATCH')
    client.close()
  })

  it('响应 method 与方法不符抛 PROTOCOL_MISMATCH', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) =>
      ok(request['requestId'], {
        method: 'status',
        accessToken: 'mmoat_x',
        expiresAtMs: 1,
        generation: 1,
      }),
    )
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expectLeaseError(client.lease(), 'PROTOCOL_MISMATCH')
    client.close()
  })

  it('lease 响应缺字段抛 PROTOCOL_MISMATCH', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) =>
      ok(request['requestId'], { method: 'lease', generation: 1 }),
    )
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expectLeaseError(client.lease(), 'PROTOCOL_MISMATCH')
    client.close()
  })

  it('响应帧超过 64KiB 抛 PROTOCOL_MISMATCH', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, () => 'oversize')
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expectLeaseError(client.status(), 'PROTOCOL_MISMATCH')
    client.close()
  })

  it('broker 不回包时按请求超时降级为 BROKER_UNAVAILABLE', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, () => 'silent')
    track(dir, broker)

    const client = new AuthLeaseClient(dir, { connectTimeoutMs: 1_000, requestTimeoutMs: 150 })
    const started = Date.now()
    await expectLeaseError(client.lease(), 'BROKER_UNAVAILABLE')
    expect(Date.now() - started).toBeLessThan(2_000)
    client.close()
  })

  it('socket 不存在时 available() 为 false 且 lease 降级为 BROKER_UNAVAILABLE', async () => {
    const dir = await tempDir()
    track(dir)
    await mkdir(join(dir, 'run'), { recursive: true })
    await writeFile(join(dir, 'run', 'mcode-auth-lease-v1.cap'), `${CAPABILITY}\n`)

    const client = new AuthLeaseClient(dir, { connectTimeoutMs: 200 })
    await expect(client.available()).resolves.toBe(false)
    await expectLeaseError(client.lease(), 'BROKER_UNAVAILABLE')
    client.close()
  })

  it('缺少能力文件时 available() 为 false', async () => {
    const dir = await tempDir()
    track(dir)
    await mkdir(join(dir, 'run'), { recursive: true })

    const client = new AuthLeaseClient(dir)
    await expect(client.available()).resolves.toBe(false)
    client.close()
  })

  it('能力文件格式非法时 available() 为 false，lease 抛 CAPABILITY_REJECTED', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) =>
      ok(request['requestId'], { method: 'status', status: 'authenticated', generation: 1 }),
    )
    track(dir, broker)
    await writeFile(join(dir, 'run', 'mcode-auth-lease-v1.cap'), 'too-short\n')

    const client = new AuthLeaseClient(dir)
    await expect(client.available()).resolves.toBe(false)
    await expectLeaseError(client.status(), 'CAPABILITY_REJECTED')
    client.close()
  })

  it('端点存在但不是 socket 时 available() 为 false', async () => {
    const dir = await tempDir()
    track(dir)
    const runDir = join(dir, 'run')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'mcode-auth-lease-v1.cap'), `${CAPABILITY}\n`)
    await writeFile(join(runDir, 'mcode-auth-lease-v1.sock'), '')
    await chmod(join(runDir, 'mcode-auth-lease-v1.sock'), 0o600)

    const client = new AuthLeaseClient(dir)
    await expect(client.available()).resolves.toBe(false)
    client.close()
  })

  it('broker 存在时 available() 为 true', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, (request) =>
      ok(request['requestId'], { method: 'status', status: 'authenticated', generation: 1 }),
    )
    track(dir, broker)

    const client = new AuthLeaseClient(dir)
    await expect(client.available()).resolves.toBe(true)
    client.close()
  })
})
