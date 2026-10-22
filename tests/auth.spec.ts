/**
 * MiniMaxAuth 的行为测试：**全部离线**。
 *
 * 用临时目录伪造 `auth/<env>/<region>/mcode-public/{auth.json,auth-state.json}`，
 * 用假 broker 覆盖租约通路，重点验证：
 *  - 优先级（租约 > 本地文件）与兜底条件（只在未过期时用）
 *  - `invalidate()` 真的让下一次重新 lease
 *  - 区域判定与 baseUrl 切换
 *  - **没有任何写文件系统动作**（把目录改成只读 + 前后快照比对）
 */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 写操作监视：把 `node:fs` / `node:fs/promises` 里所有**可能落盘**的函数包一层，
 * 只在 `recording` 打开时记录调用名（fixture 准备阶段不记录）。
 * 这是「绝不写 ~/.minimax」这条硬不变量的断言级防线：
 * 只读目录能挡住写失败，但挡不住「写到别处」——这里连调用意图都不允许出现。
 *
 * `vi.mock` 会被提升到模块顶部，所以工厂函数只能引用 `vi.hoisted` 里的东西。
 */
const fsSpy = vi.hoisted(() => {
  const WRITE_APIS = [
    'writeFile',
    'appendFile',
    'mkdir',
    'mkdtemp',
    'rm',
    'rmdir',
    'unlink',
    'rename',
    'copyFile',
    'cp',
    'chmod',
    'chown',
    'truncate',
    'symlink',
    'link',
    'write',
    'writev',
    'fsync',
    'ftruncate',
    'open',
    'createWriteStream',
  ] as const

  const state = { recording: false, calls: [] as string[] }

  /** 原样转发，只在 recording 时记一笔。 */
  const wrap = <T extends object>(actual: T, label: string): T => {
    const wrapped: Record<string, unknown> = { ...(actual as Record<string, unknown>) }
    for (const name of WRITE_APIS) {
      const original = (actual as Record<string, unknown>)[name]
      if (typeof original !== 'function') continue
      wrapped[name] = (...args: unknown[]): unknown => {
        if (state.recording) state.calls.push(`${label}.${name}`)
        return (original as (...rest: unknown[]) => unknown)(...args)
      }
    }
    return wrapped as T
  }

  return Object.assign(state, { wrap })
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return fsSpy.wrap(actual, 'fs/promises')
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return fsSpy.wrap(actual, 'fs')
})


import { MiniMaxAuth, MiniMaxAuthUnavailableError } from '../src/auth.ts'
import { DEFAULT_BASE_URL_CN, DEFAULT_BASE_URL_GLOBAL } from '../src/catalog.ts'

const CAPABILITY = 'B'.repeat(43)
const CLIENT_ID = 'mcode-public'

interface FakeBroker {
  requests: Record<string, unknown>[]
  close(): Promise<void>
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(body.byteLength, 0)
  return Buffer.concat([prefix, body])
}

/** 起一个只回 lease/status 的假 broker；`expiresAtMs` 可推后/推前以模拟不同寿命。 */
async function startBroker(
  dataDir: string,
  options: { accessToken?: string; expiresAtMs?: number; generation?: number; status?: string; leaseFails?: boolean } = {},
): Promise<FakeBroker> {
  const runDir = join(dataDir, 'run')
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'mcode-auth-lease-v1.cap'), `${CAPABILITY}\n`, { mode: 0o600 })

  const requests: Record<string, unknown>[] = []
  const server: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.byteLength < 4) return
      const length = buffer.readUInt32BE(0)
      if (length === 0 || buffer.byteLength < 4 + length) return
      const request = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>
      buffer = buffer.subarray(4 + length)
      requests.push(request)
      const expiresAtMs = options.expiresAtMs ?? Date.now() + 3_600_000
      if (options.leaseFails === true && request['method'] === 'lease') {
        socket.write(encodeFrame({
          version: 1,
          requestId: request['requestId'],
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'authorization is still pending' },
        }))
        return
      }
      const result =
        request['method'] === 'status'
          ? { method: 'status', status: options.status ?? 'authenticated', generation: options.generation ?? 2, expiresAtMs }
          : {
              method: 'lease',
              accessToken: options.accessToken ?? 'mmoat_from_lease',
              expiresAtMs,
              generation: options.generation ?? 2,
              audience: 'agent-backend',
              scopes: ['agent.default'],
            }
      socket.write(encodeFrame({ version: 1, requestId: request['requestId'], ok: true, result }))
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

interface FixtureOptions {
  /** 凭据目录区域名（`cn` / `en`）。 */
  dir?: 'cn' | 'en'
  /** `auth-state.json.region` 取值；缺省与 `dir` 相同。 */
  stateRegion?: string
  status?: string
  generation?: number
  accessToken?: string
  expiresAtMs?: number
  /** 是否写 records（false = 登录文件存在但没有凭据）。 */
  withRecords?: boolean
  /** 是否写 auth-state.json。 */
  withState?: boolean
  /** 设备码登录的待授权信息（写进 auth-state.json 的 `authorization` 块）。 */
  authorization?: { userCode: string; verificationUriComplete: string }
}

/** 在 `dataDir` 下伪造一套 mcode 凭据文件。 */
async function writeFixtures(dataDir: string, options: FixtureOptions = {}): Promise<string> {
  const dir = options.dir ?? 'cn'
  const credDir = join(dataDir, 'auth', 'prod', dir, CLIENT_ID)
  await mkdir(credDir, { recursive: true })

  const withRecords = options.withRecords ?? true
  const records = withRecords
    ? {
        'com.minimax.mcode.oauth.prod.cn\u0000hash': {
          schemaVersion: 1,
          accessToken: options.accessToken ?? 'mmoat_from_file',
          refreshToken: 'mmort_should_never_be_used',
          tokenType: 'Bearer',
          clientId: CLIENT_ID,
          scopes: ['agent.default'],
          audience: 'agent-backend',
          expiresAtMs: options.expiresAtMs ?? Date.now() + 3_600_000,
          generation: options.generation ?? 2,
          loginEpoch: 'epoch-1',
        },
      }
    : {}
  await writeFile(join(credDir, 'auth.json'), JSON.stringify({ schemaVersion: 1, records }, null, 2))

  if (options.withState !== false) {
    await writeFile(
      join(credDir, 'auth-state.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          status: options.status ?? 'authenticated',
          storeKind: 'file',
          clientId: CLIENT_ID,
          scopes: ['agent.default'],
          audience: 'agent-backend',
          buildEnv: 'prod',
          region: options.stateRegion ?? dir,
          generation: options.generation ?? 2,
          expiresAtMs: options.expiresAtMs ?? Date.now() + 3_600_000,
          ...options.authorization === undefined
            ? {}
            : {
                authorization: {
                  leaseId: 'lease-1',
                  userCode: options.authorization.userCode,
                  verificationUri: 'https://account.minimax.cn/oauth-authorize',
                  verificationUriComplete: options.authorization.verificationUriComplete,
                },
              },
        },
        null,
        2,
      ),
    )
  }
  return credDir
}

async function tempDir(): Promise<string> {
  return mkdtemp(join('/tmp', 'mm-auth-'))
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function track(dir: string, broker?: FakeBroker): void {
  cleanups.push(async () => {
    await broker?.close()
    // 只读用例把子树降成了 0o555/0o444：先恢复权限，否则 rm 会 EACCES。
    await chmod(dir, 0o755).catch(() => undefined)
    await chmodRecursive(dir, 0o755, 0o644).catch(() => undefined)
    await chmod(dir, 0o755).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  })
}

async function chmodRecursive(dir: string, dirMode: number, fileMode: number): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const target = join(dir, entry.name)
    if (entry.isDirectory()) {
      await chmodRecursive(target, dirMode, fileMode)
      await chmod(target, dirMode)
    } else if (entry.isFile()) {
      await chmod(target, fileMode)
    }
    // 其余类型（unix socket）保持原权限：连接 socket 需要写权限，
    // 把 broker 的 socket 改成 0o444 会让「只读目录」用例自己连不上 broker。
  }
}

describe('MiniMaxAuth / 区域与路径', () => {
  it('默认区域是 cn，baseUrl 用国内版', async () => {
    const dir = await tempDir()
    track(dir)
    await writeFixtures(dir)
    const auth = new MiniMaxAuth({ dataDir: dir })
    expect(auth.region).toBe('cn')
    expect(auth.baseUrl).toBe(DEFAULT_BASE_URL_CN)
    expect(auth.regionLabel).toBe('国内版')
    expect(auth.authJsonPath).toBe(join(dir, 'auth', 'prod', 'cn', CLIENT_ID, 'auth.json'))
  })

  it('auth-state.json 的 region 为 en 时切到国际版', async () => {
    const dir = await tempDir()
    track(dir)
    await writeFixtures(dir, { dir: 'en', stateRegion: 'en' })
    const auth = new MiniMaxAuth({ dataDir: dir })
    expect(auth.region).toBe('global')
    expect(auth.baseUrl).toBe(DEFAULT_BASE_URL_GLOBAL)
    expect(auth.regionLabel).toBe('国际版')
    expect(auth.authJsonPath).toBe(join(dir, 'auth', 'prod', 'en', CLIENT_ID, 'auth.json'))
  })

  it('region 取 global 字样也识别为国际版', async () => {
    const dir = await tempDir()
    track(dir)
    await writeFixtures(dir, { dir: 'en', stateRegion: 'global' })
    expect(new MiniMaxAuth({ dataDir: dir }).region).toBe('global')
  })

  it('构造参数 region 可强制覆盖磁盘判定', async () => {
    const dir = await tempDir()
    track(dir)
    await writeFixtures(dir)
    const auth = new MiniMaxAuth({ dataDir: dir, region: 'global' })
    expect(auth.region).toBe('global')
    expect(auth.authJsonPath).toContain(join('prod', 'en'))
  })

  it('DSH_MINIMAX_DATA_DIR 覆盖 dataDir', async () => {
    const dir = await tempDir()
    track(dir)
    await writeFixtures(dir)
    const auth = new MiniMaxAuth({ env: { DSH_MINIMAX_DATA_DIR: dir } })
    expect(auth.dataDir).toBe(dir)
  })

  it('没有覆盖时回落到 <HOME>/.minimax', async () => {
    const dir = await tempDir()
    track(dir)
    const auth = new MiniMaxAuth({ env: { HOME: dir } })
    expect(auth.dataDir).toBe(join(dir, '.minimax'))
  })
})

describe('MiniMaxAuth / 凭据优先级', () => {
  it('broker 可用时用租约，source 为 lease', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, { accessToken: 'mmoat_from_lease' })
    track(dir, broker)
    await writeFixtures(dir, { accessToken: 'mmoat_from_file' })

    const auth = new MiniMaxAuth({ dataDir: dir })
    await expect(auth.token()).resolves.toBe('mmoat_from_lease')
    const status = await auth.inspect()
    expect(status.state).toBe('ready')
    expect(status.source).toBe('lease')
    expect(status.generation).toBe(2)
  })

  // 租约协议**没有区域参数**：broker 只发"当前活跃账号"的令牌。本机同时登录国内版与
  // 国际版时（本插件默认形态），无条件采用租约就会把国际版令牌交给国内版路由，
  // 实测 `401 invalid access token` 且整条通路挂掉。generation 是唯一可用的判别字段。
  it('broker 的 generation 与本区域盘上凭据不一致时，改用本区域凭据（跨区令牌）', async () => {
    const dir = await tempDir()
    // broker 服务的是另一个区域的账号：generation 11 ≠ 本区域 15。
    const broker = await startBroker(dir, { accessToken: 'mmoat_other_region', generation: 11 })
    track(dir, broker)
    await writeFixtures(dir, { accessToken: 'mmoat_from_file', generation: 15 })

    const auth = new MiniMaxAuth({ dataDir: dir })
    await expect(auth.token()).resolves.toBe('mmoat_from_file')
  })

  it('跨区拒绝租约时把原因写进 lastError，且不谎称租约坏了', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, { accessToken: 'mmoat_other_region', generation: 11 })
    track(dir, broker)
    await writeFixtures(dir, { accessToken: 'mmoat_from_file', generation: 15 })

    const auth = new MiniMaxAuth({ dataDir: dir })
    await auth.token()
    // 走的是公开出口 lastFailure（状态卡片读的就是它）：回落成功不该把这条诊断清掉。
    expect(auth.lastFailure).toContain('另一个区域')
    // 说清楚是"不属于本区域"，否则排查时会去怀疑 broker 故障。
    expect(auth.lastFailure).toContain('generation 11')
    expect(auth.lastFailure).toContain('15')
  })

  it('generation 一致时仍优先用租约（同区由 mcode 负责刷新）', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, { accessToken: 'mmoat_from_lease', generation: 15 })
    track(dir, broker)
    await writeFixtures(dir, { accessToken: 'mmoat_from_file', generation: 15 })

    const auth = new MiniMaxAuth({ dataDir: dir })
    await expect(auth.token()).resolves.toBe('mmoat_from_lease')
  })

  it('盘上没有 generation 可比时保持旧行为采用租约（拒绝只会把可能变成一定不能用）', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, { accessToken: 'mmoat_from_lease', generation: 11 })
    track(dir, broker)
    // 有 accessToken/expiresAtMs 但没有 generation 字段。
    await writeFixtures(dir, { accessToken: 'mmoat_from_file' })
    const credDir = join(dir, 'auth', 'prod', 'cn', CLIENT_ID)
    const raw = JSON.parse(await readFile(join(credDir, 'auth.json'), 'utf8')) as {
      records: Record<string, Record<string, unknown>>
    }
    for (const record of Object.values(raw.records)) delete record['generation']
    await writeFile(join(credDir, 'auth.json'), JSON.stringify(raw))

    const auth = new MiniMaxAuth({ dataDir: dir })
    await expect(auth.token()).resolves.toBe('mmoat_from_lease')
  })

  it('token() 每次都要求 60000ms 最小有效期', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir)
    track(dir, broker)
    await writeFixtures(dir)

    const auth = new MiniMaxAuth({ dataDir: dir })
    await auth.token()
    expect(broker.requests[0]).toMatchObject({ method: 'lease', minValidityMs: 60_000 })
  })

  it('broker 不可用时回落到本地文件，source 为 file', async () => {
    const dir = await tempDir()
    track(dir)
    await writeFixtures(dir, { accessToken: 'mmoat_from_file' })

    const auth = new MiniMaxAuth({ dataDir: dir })
    await expect(auth.token()).resolves.toBe('mmoat_from_file')
    const status = await auth.inspect()
    expect(status.state).toBe('ready')
    expect(status.source).toBe('file')
    expect(status.generation).toBe(2)
  })

  it('租约返回的 token 已接近过期时改走本地文件', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, {
      accessToken: 'mmoat_short_lived',
      expiresAtMs: Date.now() + 10_000,
    })
    track(dir, broker)
    await writeFixtures(dir, { accessToken: 'mmoat_from_file' })

    const auth = new MiniMaxAuth({ dataDir: dir })
    await expect(auth.token()).resolves.toBe('mmoat_from_file')
    expect(broker.requests).toHaveLength(1)
  })

  it('本地文件 token 剩余寿命不足 60s 视为过期', async () => {
    const dir = await tempDir()
    track(dir)
    await writeFixtures(dir, { expiresAtMs: Date.now() + 30_000 })

    const auth = new MiniMaxAuth({ dataDir: dir })
    await expect(auth.token()).rejects.toBeInstanceOf(MiniMaxAuthUnavailableError)
    const status = await auth.inspect()
    expect(status.state).toBe('expired')
    expect(status.source).toBe('file')
  })

  it('inspect 不抛异常：文件已过期时给出 expired', async () => {
    const dir = await tempDir()
    track(dir)
    await writeFixtures(dir, { expiresAtMs: Date.now() - 1_000 })
    await expect(new MiniMaxAuth({ dataDir: dir }).inspect()).resolves.toMatchObject({
      state: 'expired',
    })
  })

  it('status 为 anonymous 时报告 anonymous 且取不到 token', async () => {
    const dir = await tempDir()
    track(dir)
    await writeFixtures(dir, { status: 'anonymous', withRecords: false })

    const auth = new MiniMaxAuth({ dataDir: dir })
    const status = await auth.inspect()
    expect(status.state).toBe('anonymous')
    await expect(auth.token()).rejects.toBeInstanceOf(MiniMaxAuthUnavailableError)
  })

  it('凭据文件完全缺失时报告 missing', async () => {
    const dir = await tempDir()
    track(dir)
    await mkdir(dir, { recursive: true })

    const auth = new MiniMaxAuth({ dataDir: dir })
    const status = await auth.inspect()
    expect(status.state).toBe('missing')
    expect(status.source).toBe('none')
    await expect(auth.token()).rejects.toBeInstanceOf(MiniMaxAuthUnavailableError)
    const error = await auth.token().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(MiniMaxAuthUnavailableError)
    expect((error as MiniMaxAuthUnavailableError).status.state).toBe('missing')
  })

  it('只有 auth-state.json 没有 record 时报告 missing', async () => {
    const dir = await tempDir()
    track(dir)
    await writeFixtures(dir, { withRecords: false, status: 'authenticated' })
    await expect(new MiniMaxAuth({ dataDir: dir }).inspect()).resolves.toMatchObject({
      state: 'missing',
    })
  })
})

describe('MiniMaxAuth / 缓存与失效', () => {
  it('有效期内重复取 token 只 lease 一次', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir)
    track(dir, broker)
    await writeFixtures(dir)

    const auth = new MiniMaxAuth({ dataDir: dir })
    await auth.token()
    await auth.token()
    await auth.token()
    expect(broker.requests.filter((r) => r['method'] === 'lease')).toHaveLength(1)
  })

  it('invalidate() 后重新 lease', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir)
    track(dir, broker)
    await writeFixtures(dir)

    const auth = new MiniMaxAuth({ dataDir: dir })
    await auth.token()
    auth.invalidate()
    await auth.token()
    expect(broker.requests.filter((r) => r['method'] === 'lease')).toHaveLength(2)
  })

  it('invalidate() 后 broker 挂掉则回落到文件', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, { accessToken: 'mmoat_from_lease' })
    track(dir, broker)
    await writeFixtures(dir, { accessToken: 'mmoat_from_file' })

    const auth = new MiniMaxAuth({ dataDir: dir })
    await expect(auth.token()).resolves.toBe('mmoat_from_lease')
    await broker.close()
    auth.invalidate()
    await expect(auth.token()).resolves.toBe('mmoat_from_file')
  })

  it('缓存寿命耗尽后自动重新 lease', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, { expiresAtMs: Date.now() + 120_000 })
    track(dir, broker)
    await writeFixtures(dir)

    const leaseCalls = (): number => broker.requests.filter((r) => r['method'] === 'lease').length

    // 只冻结 `Date.now()`（不影响 socket 定时器），把时钟推到缓存提前量之后。
    const realNow = Date.now()
    const auth = new MiniMaxAuth({ dataDir: dir })
    await auth.token()
    expect(leaseCalls()).toBe(1)

    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 70_000)
    try {
      await auth.token()
    } finally {
      clock.mockRestore()
    }
    expect(leaseCalls()).toBe(2)
  })
})

describe('MiniMaxAuth / 只读保证', () => {
  it('取凭据全过程没有调用任何 fs 写函数', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, { accessToken: 'mmoat_from_lease' })
    track(dir, broker)
    await writeFixtures(dir)

    const auth = new MiniMaxAuth({ dataDir: dir })
    fsSpy.calls.length = 0
    fsSpy.recording = true
    try {
      await auth.token()
      await auth.inspect()
      auth.invalidate()
      await auth.token()
      await auth.inspect()
    } finally {
      fsSpy.recording = false
    }
    expect(fsSpy.calls).toEqual([])
  })

  it('文件兜底路径也没有调用任何 fs 写函数', async () => {
    const dir = await tempDir()
    track(dir)
    await writeFixtures(dir, { accessToken: 'mmoat_from_file' })

    const auth = new MiniMaxAuth({ dataDir: dir })
    fsSpy.calls.length = 0
    fsSpy.recording = true
    try {
      await expect(auth.token()).resolves.toBe('mmoat_from_file')
      await auth.inspect()
      auth.invalidate()
      await auth.token()
    } finally {
      fsSpy.recording = false
    }
    expect(fsSpy.calls).toEqual([])
  })

  it('在只读目录上取凭据不写任何文件，且快照不变', async () => {
    const dir = await tempDir()
    const broker = await startBroker(dir, { accessToken: 'mmoat_from_lease' })
    track(dir, broker)
    await writeFixtures(dir)

    // 只收紧凭据子树：`run/` 里的 socket 需要 write 权限才能 connect，
    // 连它一起改只读就等于在测「broker 不可用」，租约通路反而测不到。
    const credRoot = join(dir, 'auth')
    const before = await snapshot(dir)
    await chmodRecursive(credRoot, 0o555, 0o444)

    const auth = new MiniMaxAuth({ dataDir: dir })
    await expect(auth.token()).resolves.toBe('mmoat_from_lease')
    await auth.inspect()
    auth.invalidate()

    await chmodRecursive(credRoot, 0o755, 0o644)
    const after = await snapshot(dir)
    expect(after).toEqual(before)
  })

  it('文件兜底路径同样不写任何文件', async () => {
    const dir = await tempDir()
    track(dir)
    const credDir = await writeFixtures(dir, { accessToken: 'mmoat_from_file' })

    const credRoot = join(dir, 'auth')
    const before = await snapshot(dir)
    await chmodRecursive(credRoot, 0o555, 0o444)

    const auth = new MiniMaxAuth({ dataDir: dir })
    await expect(auth.token()).resolves.toBe('mmoat_from_file')
    await auth.inspect()
    await expect(auth.inspect()).resolves.toMatchObject({ source: 'file' })

    await chmodRecursive(credRoot, 0o755, 0o644)
    expect(await snapshot(dir)).toEqual(before)
    // 兜底路径绝不能碰 refreshToken：文件里它必须原样存在。
    const raw = JSON.parse(await readFile(join(credDir, 'auth.json'), 'utf8')) as {
      records: Record<string, { refreshToken: string }>
    }
    expect(Object.values(raw.records)[0]?.refreshToken).toBe('mmort_should_never_be_used')
  })
})

/** 目录快照：路径 → 内容哈希 + 大小 + mtime，用于证明「没写过」。 */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const target = join(current, entry.name)
      const rel = `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir'
        await walk(target, rel)
        continue
      }
      const info = await stat(target)
      if (!entry.isFile()) {
        out[rel] = `other:${info.size}:${info.mtimeMs}`
        continue
      }
      const digest = createHash('sha256').update(await readFile(target)).digest('hex')
      out[rel] = `${info.size}:${info.mtimeMs}:${digest}`
    }
  }
  await walk(dir, '')
  return out
}

describe('设备码授权进行中（authorizing）', () => {
  it('inspect() 报 authorizing，并带出用户码与授权地址', async () => {
    const dataDir = await tempDir()
    await writeFixtures(dataDir, {
      status: 'authorizing',
      withRecords: false,
      authorization: {
        userCode: 'KQZR-R2M7',
        verificationUriComplete: 'https://account.minimax.cn/oauth-authorize?user_code=KQZR-R2M7',
      },
    })
    const broker = await startBroker(dataDir, { status: 'authorizing' })
    try {
      const auth = new MiniMaxAuth({ dataDir })
      const status = await auth.inspect()
      expect(status.state).toBe('authorizing')
      expect(status.userCode).toBe('KQZR-R2M7')
      expect(status.verificationUri).toContain('user_code=KQZR-R2M7')
    } finally {
      await broker.close()
    }
  })

  it('取不到 token 时，错误信息里带验证码，用户知道下一步做什么', async () => {
    const dataDir = await tempDir()
    await writeFixtures(dataDir, {
      status: 'authorizing',
      withRecords: false,
      authorization: {
        userCode: 'KQZR-R2M7',
        verificationUriComplete: 'https://account.minimax.cn/oauth-authorize?user_code=KQZR-R2M7',
      },
    })
    const broker = await startBroker(dataDir, { status: 'authorizing', leaseFails: true })
    try {
      const auth = new MiniMaxAuth({ dataDir })
      const error = await auth.token().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(MiniMaxAuthUnavailableError)
      expect((error as Error).message).toContain('KQZR-R2M7')
    } finally {
      await broker.close()
    }
  })
})
