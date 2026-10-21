/**
 * MiniMax Code 的 Auth Lease Broker 客户端（只读凭据，永不写用户文件）。
 *
 * 协议（`@mavis/oauth-lease-protocol` v1，详见 docs/research/upstream.md §3.4）：
 *  - 传输：unix domain socket（macOS/Linux）或命名管道（Windows）
 *  - 帧：4 字节大端长度 + UTF-8 JSON，单帧 ≤ 64 KiB
 *  - 请求：`{version:1,requestId,capability,method:'status'|'lease',minValidityMs?}`
 *  - 响应：`{version:1,requestId,ok:true,result:{…}}` 或 `{ok:false,error:{code,message}}`
 *
 * **禁止调用 broker 的 `unauthorized` 方法**（协议里有，本模块故意不提供）：
 * mcode 收到 `unauthorized` 会当成「刷新失败」并**直接把用户登出**（实测踩过，
 * 见 docs/design.md §2）。所以 401 只能「清缓存 → 重新 `lease`」，绝不转述给 broker。
 * `call()` 的 method 参数被收窄成 `'status' | 'lease'`，从类型上就发不出去。
 *
 * 失败即降级：这里不重试、不排队，调用方（auth.ts）负责回退到本地凭据文件。
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import net from 'node:net'
import { join, resolve, win32 } from 'node:path'

const PROTOCOL_VERSION = 1
const SOCKET_FILE = 'mcode-auth-lease-v1.sock'
const CAPABILITY_FILE = 'mcode-auth-lease-v1.cap'
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\mcode-auth-lease-'
const MAX_FRAME_BYTES = 64 * 1024
const MAX_MIN_VALIDITY_MS = 5 * 60 * 1000
const DEFAULT_MIN_VALIDITY_MS = 60_000
const FRAME_PREFIX_BYTES = 4
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000

/** broker 可能返回的错误码（见协议 contracts.js）。 */
export type AuthLeaseErrorCode =
  | 'AUTH_REQUIRED'
  | 'BROKER_UNAVAILABLE'
  | 'CAPABILITY_REJECTED'
  | 'PROTOCOL_MISMATCH'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR'

const KNOWN_CODES: ReadonlySet<string> = new Set<AuthLeaseErrorCode>([
  'AUTH_REQUIRED',
  'BROKER_UNAVAILABLE',
  'CAPABILITY_REJECTED',
  'PROTOCOL_MISMATCH',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
])

/** 租约请求失败。`code` 直接对应用协议错误码，便于上层决定「提示登录」还是「启动应用」。 */
export class AuthLeaseError extends Error {
  readonly code: AuthLeaseErrorCode

  constructor(code: AuthLeaseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AuthLeaseError'
    this.code = code
  }
}

/** `status` 结果：不包含 token。 */
export interface AuthLeaseStatus {
  status: string
  generation: number
  expiresAtMs?: number
}

/** `lease` 结果：包含可用的 access token。 */
export interface AuthLeaseToken {
  accessToken: string
  expiresAtMs: number
  generation: number
}

/** 构造参数里的可调项（超时只给测试与排障用）。 */
export interface AuthLeaseClientOptions {
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}

interface RawResponse {
  version?: unknown
  requestId?: unknown
  ok?: unknown
  result?: unknown
  error?: unknown
}

/**
 * 计算 Windows 命名管道名。
 *
 * 与 mcode 的实现保持一致：`sha256(canonicalDataDir.toLowerCase()).hex().slice(0,16)`，
 * canonical 路径用 `path.resolve()` 归一化（去掉尾部分隔符与 `.`/`..`）。
 */
export function windowsPipeName(dataDir: string): string {
  // 先规范化：去掉尾部分隔符并用 win32 规则归一（`~/.minimax` 的正常取值是绝对路径）。
  const trimmed = dataDir.replace(/[\\/]+$/u, '')
  const canonical = trimmed.length === 0 ? dataDir : win32.normalize(trimmed)
  const digest = createHash('sha256').update(canonical.toLowerCase()).digest('hex')
  return `${WINDOWS_PIPE_PREFIX}${digest.slice(0, 16)}`
}

/** 解析 broker 端点与能力文件路径（导出便于状态展示与测试）。 */
export function resolveLeaseEndpoint(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): { endpoint: string; capabilityFile: string } {
  const runDir = join(resolve(dataDir), 'run')
  return {
    endpoint: platform === 'win32' ? windowsPipeName(dataDir) : join(runDir, SOCKET_FILE),
    capabilityFile: join(runDir, CAPABILITY_FILE),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNonNegativeInteger(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function readFiniteNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  if (body.byteLength === 0 || body.byteLength > MAX_FRAME_BYTES) {
    throw new AuthLeaseError('INVALID_REQUEST', '认证租约请求帧超出允许范围。')
  }
  const prefix = Buffer.alloc(FRAME_PREFIX_BYTES)
  prefix.writeUInt32BE(body.byteLength, 0)
  return Buffer.concat([prefix, body])
}

/**
 * Auth Lease 客户端。
 *
 * 每次调用建立一条短连接：unix socket 的 connect 很便宜，而常驻连接在
 * mcode 重启后需要重连状态机，得不偿失。`close()` 只用于中断在途请求。
 */
export class AuthLeaseClient {
  /** socket 路径或 Windows 管道名。 */
  readonly endpoint: string
  /** capability 文件路径（0600，内容为 43 字符 base64url + 换行）。 */
  readonly capabilityFile: string

  private readonly connectTimeoutMs: number
  private readonly requestTimeoutMs: number
  private activeSocket: net.Socket | undefined

  constructor(
    private readonly dataDir: string,
    options: AuthLeaseClientOptions = {},
  ) {
    const resolved = resolveLeaseEndpoint(dataDir)
    this.endpoint = resolved.endpoint
    this.capabilityFile = resolved.capabilityFile
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  /**
   * broker 是否「看起来可用」：能力文件可读且格式合法，端点存在。
   *
   * 注意这是配置层判断，不代表 broker 活着 —— 真正的可用性由 `status()`/`lease()` 回答。
   * 任何异常都折算成 `false`，绝不抛出（探测路径不该把插件启动搞挂）。
   */
  async available(): Promise<boolean> {
    try {
      await this.readCapability()
    } catch {
      return false
    }
    if (process.platform === 'win32') {
      // 命名管道无法 stat；有能力文件就认为已配置。
      return true
    }
    try {
      const info = await stat(this.endpoint)
      return info.isSocket()
    } catch {
      return false
    }
  }

  /** 查询登录态（不返回 token）。 */
  async status(signal?: AbortSignal): Promise<AuthLeaseStatus> {
    const result = await this.call('status', undefined, signal)
    const status = readString(result, 'status')
    const generation = readNonNegativeInteger(result, 'generation')
    if (!status || generation === undefined) {
      throw new AuthLeaseError('PROTOCOL_MISMATCH', '认证租约 status 响应缺少 status/generation。')
    }
    const expiresAtMs = readFiniteNumber(result, 'expiresAtMs')
    return expiresAtMs === undefined ? { status, generation } : { status, generation, expiresAtMs }
  }

  /**
   * 取一个 access token 租约。
   *
   * `minValidityMs` 是硬约束：broker 只在「剩余寿命 ≥ 该值」时才复用缓存，
   * 否则会自己刷新（这是我们要的行为 —— 刷新责任留在 mcode）。
   */
  async lease(minValidityMs = DEFAULT_MIN_VALIDITY_MS, signal?: AbortSignal): Promise<AuthLeaseToken> {
    const validity = Math.trunc(minValidityMs)
    if (!Number.isFinite(validity) || validity < 0 || validity > MAX_MIN_VALIDITY_MS) {
      throw new AuthLeaseError(
        'INVALID_REQUEST',
        `minValidityMs 必须是 0..${MAX_MIN_VALIDITY_MS} 之间的整数。`,
      )
    }
    const result = await this.call('lease', validity, signal)
    const accessToken = readString(result, 'accessToken')
    const expiresAtMs = readFiniteNumber(result, 'expiresAtMs')
    const generation = readNonNegativeInteger(result, 'generation')
    if (!accessToken || expiresAtMs === undefined || generation === undefined) {
      throw new AuthLeaseError(
        'PROTOCOL_MISMATCH',
        '认证租约 lease 响应缺少 accessToken/expiresAtMs/generation。',
      )
    }
    return { accessToken, expiresAtMs, generation }
  }

  /** 中断在途请求（不改变 broker 状态）。 */
  close(): void {
    const socket = this.activeSocket
    this.activeSocket = undefined
    socket?.destroy()
  }

  private async readCapability(): Promise<string> {
    let raw: string
    try {
      raw = await readFile(this.capabilityFile, 'utf8')
    } catch (error) {
      throw new AuthLeaseError('BROKER_UNAVAILABLE', '读取不到 MiniMax Code 认证能力文件。', {
        cause: error,
      })
    }
    // 文件末尾带换行，必须 strip。
    const capability = raw.trim()
    if (!CAPABILITY_PATTERN.test(capability)) {
      throw new AuthLeaseError('CAPABILITY_REJECTED', '认证能力文件格式不正确。')
    }
    return capability
  }

  private async call(
    method: 'status' | 'lease',
    minValidityMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
      throw new AuthLeaseError('BROKER_UNAVAILABLE', '认证租约请求已取消。')
    }
    const capability = await this.readCapability()
    const requestId = randomRequestId()
    const request: Record<string, unknown> = {
      version: PROTOCOL_VERSION,
      requestId,
      capability,
      method,
      ...(minValidityMs === undefined ? {} : { minValidityMs }),
    }
    const response = await this.exchange(request, signal)
    return this.readResult(response, requestId, method)
  }

  private readResult(
    response: RawResponse,
    requestId: string,
    method: 'status' | 'lease',
  ): Record<string, unknown> {
    if (response.version !== PROTOCOL_VERSION) {
      throw new AuthLeaseError('PROTOCOL_MISMATCH', '认证租约协议版本不兼容。')
    }
    if (response.requestId !== requestId) {
      throw new AuthLeaseError('PROTOCOL_MISMATCH', '认证租约响应与请求不匹配。')
    }
    if (response.ok === false) {
      const error = isRecord(response.error) ? response.error : undefined
      const rawCode = readString(error, 'code')
      const code: AuthLeaseErrorCode =
        rawCode && KNOWN_CODES.has(rawCode) ? (rawCode as AuthLeaseErrorCode) : 'INTERNAL_ERROR'
      const message = readString(error, 'message') ?? 'MiniMax Code 认证租约服务返回了错误。'
      throw new AuthLeaseError(code, message)
    }
    if (response.ok !== true || !isRecord(response.result)) {
      throw new AuthLeaseError('PROTOCOL_MISMATCH', '认证租约响应格式不正确。')
    }
    if (response.result['method'] !== method) {
      throw new AuthLeaseError('PROTOCOL_MISMATCH', '认证租约响应的方法与请求不符。')
    }
    return response.result
  }

  /** 一次完整往返：连接 → 写一帧 → 读一帧 → 断开。 */
  private exchange(request: Record<string, unknown>, signal?: AbortSignal): Promise<RawResponse> {
    const frame = encodeFrame(request)
    return new Promise<RawResponse>((resolvePromise, rejectPromise) => {
      let settled = false
      let buffer: Buffer = Buffer.alloc(0)
      let timer: NodeJS.Timeout | undefined
      const socket = net.createConnection(this.endpoint)

      const finish = (error: Error | undefined, value?: RawResponse): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.activeSocket = undefined
        socket.destroy()
        if (error) rejectPromise(error)
        else resolvePromise(value as RawResponse)
      }

      const failUnavailable = (cause?: unknown): void => {
        finish(
          new AuthLeaseError('BROKER_UNAVAILABLE', 'MiniMax Code 认证租约服务不可用。', {
            ...(cause === undefined ? {} : { cause }),
          }),
        )
      }

      const onAbort = (): void => failUnavailable()

      this.activeSocket = socket
      socket.setNoDelay(true)
      signal?.addEventListener('abort', onAbort, { once: true })

      timer = setTimeout(() => failUnavailable(), this.connectTimeoutMs)

      socket.once('connect', () => {
        if (settled) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => failUnavailable(), this.requestTimeoutMs)
        socket.write(frame)
      })

      socket.on('data', (chunk: Buffer) => {
        if (settled) return
        buffer = buffer.byteLength === 0 ? chunk : Buffer.concat([buffer, chunk])
        if (buffer.byteLength < FRAME_PREFIX_BYTES) return
        const length = buffer.readUInt32BE(0)
        if (length === 0 || length > MAX_FRAME_BYTES) {
          finish(new AuthLeaseError('PROTOCOL_MISMATCH', '认证租约响应帧超出允许范围。'))
          return
        }
        if (buffer.byteLength < FRAME_PREFIX_BYTES + length) return
        const body = buffer.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + length)
        let parsed: unknown
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          finish(new AuthLeaseError('PROTOCOL_MISMATCH', '认证租约响应不是合法 JSON。'))
          return
        }
        if (!isRecord(parsed)) {
          finish(new AuthLeaseError('PROTOCOL_MISMATCH', '认证租约响应格式不正确。'))
          return
        }
        finish(undefined, parsed as RawResponse)
      })

      socket.once('error', (error: Error) => failUnavailable(error))
      socket.once('close', () => {
        if (!settled) failUnavailable()
      })
    })
  }
}

function randomRequestId(): string {
  return globalThis.crypto.randomUUID()
}
