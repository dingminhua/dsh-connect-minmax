/**
 * 卡片写回插件配置的能力。
 *
 * # 为什么可以写，以及写什么
 *
 * 本插件**没有任何 API Key 输入项**，凭据永远来自本机登录态——这条不可让渡。
 * 卡片能写的只有三样，且都是 `Config` 里早就存在的字段：
 *
 *  - `models`：启用哪些模型（空 = 全部）；
 *  - `regions`：注册哪些区域（国内版 / 国际版）；
 *  - `longContext`：是否用 1M 长上下文档。
 *
 * 逐模型的图片开关是**不对称**的：关掉一个上游支持的模态是真实的能力掩码
 * （宿主从此不再往这个模型发图，可能因此省积分或绕开上游视觉解析的不稳定），
 * 而开启一个上游不支持的模态会被宿主忽略——声明一个上游不受理的模态只会把
 * 用户的显式操作变成线上一条 4xx。
 *
 * 仍然**不做**：逐模型的"可关思考"开关。思考档位是 provider 级的单个值
 * （`profile.reasoning`），要按模型分就得改 pi-ai 的契约，不是插件侧能表达的。
 *
 * # 写入必须回读校验
 *
 * `scope.set()` 返回 `false` 表示宿主**拒绝**了这次写入（不是抛错），而某些宿主
 * 版本连返回值都没有。所以每次写完都重新读一次快照并比对：只有真的落进配置
 * 才算成功。否则卡片会把复选框打上勾、显示"已保存"，而实际配置纹丝不动——
 * 这种假成功比直接报错难查得多。
 *
 * 参考：dingminhua/dsh-connect-qoder（`client/account-selection.ts` 的
 * `writeField` + landed 校验）与 dsh-connect-workbuddy 的同源做法。
 */

/** 宿主设置面板给卡片的作用域（软探测，可能不存在）。 */
export interface MiniMaxSettingsScope {
  getSnapshot(): { value?: unknown }
  /**
   * 宿主是否接受了写入。`false` = 被拒；`undefined`/`void`（旧宿主）按接受处理，
   * 但仍要靠回读校验兜底。
   */
  set(field: string, value: unknown): Promise<boolean | void>
  subscribe?(listener: () => void): () => void
}

/** 卡片可写的字段名。 */
import { MINIMAX_SETTINGS_SAVE_PATH } from '../status-paths.ts'

export type MiniMaxWritableField
  = 'models' | 'regions' | 'longContext' | 'modelContextWindows' | 'modelImages'
    | 'modelThinkingOff' | 'reasoningEffort' | 'modelContextWindows'

/** 写入没落地的错误。 */
export class MiniMaxSettingsWriteError extends Error {
  readonly field: MiniMaxWritableField

  constructor(field: MiniMaxWritableField, reason?: string) {
    super(
      `dsh-connect-minmax: 配置字段 "${field}" 没有被设置面板保存`
      + (reason === undefined ? '' : `：${reason}`),
    )
    this.name = 'MiniMaxSettingsWriteError'
    this.field = field
  }
}

/** 从 volatile 包装里取真实值（宿主的响应式配置会包一层 `.get()`）。 */
function unwrap(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const holder = value as Record<string, unknown>
  if (typeof holder['get'] === 'function' && Object.keys(holder).length <= 2) {
    try {
      return unwrap((holder['get'] as () => unknown).call(value))
    } catch {
      return value
    }
  }
  return value
}

/** 读当前配置里某个字段的值；缺失回 `undefined`。 */
export function readField(scope: MiniMaxSettingsScope, field: MiniMaxWritableField): unknown {
  const root = unwrap(scope.getSnapshot().value)
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return undefined
  return unwrap((root as Record<string, unknown>)[field])
}

/** 数组字段是否等价（顺序敏感：`models` 的顺序就是目录里的展示顺序）。 */
function sameList(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}

/**
 * 写一个字段并确认落地。
 *
 * @param same - 比对函数：`longContext` 是标量，`models`/`regions` 是数组。
 */
/**
 * 走宿主侧保存端点写入，返回**宿主真正落盘**的值。
 *
 * 为什么必须有这条路：浏览器侧 `ConfigForm.set` 在部分宿主上会静默不落盘
 * （workbuddy 的 0.1.7 缺陷同款——scope 解析成功、set 返回 true，文档却一个字
 * 都没变）。真写入只能在宿主进程里 `settings.mutate`。端点把拒绝的原始异常
 * 带回来，所以失败是有名字的，而不是一个被吞掉的 ok:false。
 *
 * @param field - 配置字段名。
 * @param value - 要写入的值。
 * @returns 宿主落盘后的该字段值；旧宿主只回 `{ok:true}` 时为 undefined。
 * @throws {MiniMaxSettingsWriteError} 端点不可达或拒绝时。
 */
async function saveViaHostEndpoint(
  field: MiniMaxWritableField,
  value: unknown,
): Promise<unknown | undefined> {
  let response: Response
  try {
    response = await fetch(MINIMAX_SETTINGS_SAVE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value }),
    })
  } catch (error: unknown) {
    throw new MiniMaxSettingsWriteError(field, `宿主保存端点不可达：${String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: `HTTP ${String(response.status)}` })) as { error?: string }
    throw new MiniMaxSettingsWriteError(field, `宿主保存被拒：${String(detail.error ?? response.status)}`)
  }
  const answer = await response.json().catch(() => undefined) as { value?: unknown } | undefined
  return answer?.value
}

/**
 * 写一个字段并确认落地。
 *
 * **顺序是有意的，搞反会删数据。** 两条写入路径语义不同：
 *
 *  - 宿主端点在宿主进程里做**服务端合并**，只改目标字段，不碰兄弟字段；
 *  - `scope.set` 把**整个字段**交给设置服务，客户端从浏览器镜像合并出来的那份
 *    会原样替换字段。镜像不是可靠的合并基准（宿主端点写入后不更新它），拿它
 *    合并就可能把兄弟字段写丢。
 *
 * 所以宿主端点优先；`scope.set` 只用于把宿主落盘的值**刷进镜像**，或作为旧宿主
 * （没有端点）的回退，且回退时必须回读确认真的落地。
 *
 * @param same - 比对函数：标量比相等，数组比顺序与内容。
 */
async function writeField(
  scope: MiniMaxSettingsScope,
  field: MiniMaxWritableField,
  value: unknown,
  same: (expected: unknown, actual: unknown) => boolean,
): Promise<void> {
  // 1. 权威路径：宿主进程内 mutate，服务端合并，不会删兄弟字段。
  let hostError: unknown
  try {
    const authoritative = await saveViaHostEndpoint(field, value)
    // 2. 把**宿主落盘的值**刷进镜像，而不是用客户端自己那份可能过期的镜像重新
    //    合并——在"给什么存什么"的 scope 上，写回过期合并会撤销上面的合并。
    //    尽力而为：宿主已经是权威，刷新被拒没关系。
    if (authoritative !== undefined) {
      try { await scope.set(field, authoritative) } catch { /* 可选 */ }
    }
    return
  } catch (error: unknown) {
    hostError = error
  }

  // 3. 端点不可用（旧宿主）：回退到 scope，并回读确认真的落地。
  let scopeDelivered = false
  try {
    scopeDelivered = (await scope.set(field, value)) !== false
  } catch {
    scopeDelivered = false
  }
  if (scopeDelivered) {
    if (same(value, readField(scope, field))) return
    // scope 说成功但回读不一致 = 静默没落盘，这是最危险的假成功，必须点名。
    throw new MiniMaxSettingsWriteError(field, '设置面板返回成功但回读到的值与期望不一致（值没落地）')
  }
  throw hostError instanceof MiniMaxSettingsWriteError
    ? hostError
    : new MiniMaxSettingsWriteError(field, '宿主保存端点与设置面板都没能把值落盘')
}

/** 写入启用的模型列表（顺序即展示顺序）。 */
export function writeModels(scope: MiniMaxSettingsScope, models: readonly string[]): Promise<void> {
  return writeField(scope, 'models', [...models], sameList)
}

/** 写入启用的区域列表。至少留一个：空列表会让插件一条路由都不注册。 */
export function writeRegions(scope: MiniMaxSettingsScope, regions: readonly string[]): Promise<void> {
  return writeField(scope, 'regions', [...regions], sameList)
}

/**
 * 写入某个模型的上下文档位。
 *
 * 只接受该模型确实提供的档位（由调用方从 `contextWindowOptions` 里选），
 * 写一个上游不受理的值会让宿主按错误的窗口做上下文压缩。
 */
export function writeModelContextWindow(
  scope: MiniMaxSettingsScope,
  modelId: string,
  window: number,
): Promise<void> {
  return writeFlag(scope, 'modelContextWindows', modelId, window)
}

/** 写入某个模型的图片输入开关（见文件头的不对称说明）。 */
export function writeModelImages(
  scope: MiniMaxSettingsScope,
  modelId: string,
  enabled: boolean,
): Promise<void> {
  return writeFlag(scope, 'modelImages', modelId, enabled)
}

/** 写入某个模型的「提供关闭思考档」开关（只能关，见 catalog 的 withModelThinkingOff）。 */
export function writeModelThinkingOff(
  scope: MiniMaxSettingsScope,
  modelId: string,
  allow: boolean,
): Promise<void> {
  return writeFlag(scope, 'modelThinkingOff', modelId, allow)
}

/** 写入一个"模型 id → 数值/布尔"映射里的单项。 */
function writeFlag<T extends number | boolean>(
  scope: MiniMaxSettingsScope,
  field: 'modelContextWindows' | 'modelImages' | 'modelThinkingOff',
  modelId: string,
  value: T,
): Promise<void> {
  const current = readField(scope, field)
  const base = (typeof current === 'object' && current !== null && !Array.isArray(current))
    ? { ...(current as Record<string, T>) }
    : {}
  base[modelId] = value
  return writeField(scope, field, base, (expected, actual) => {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false
    const readBack = actual as Record<string, unknown>
    const wanted = expected as Record<string, unknown>
    const keys = Object.keys(wanted)
    return keys.length === Object.keys(readBack).length
      && keys.every(key => readBack[key] === wanted[key])
  })
}

/**
 * 写入默认思考档位（provider 级）。
 *
 * 只有这一层可配：pi-ai 的模型级描述里只有 `reasoningEfforts`（**可选档位集合**），
 * 没有"这个模型的默认档"这个概念，所以逐模型的默认强度在插件侧无法表达。
 */
export function writeReasoningEffort(scope: MiniMaxSettingsScope, effort: string): Promise<void> {
  return writeField(scope, 'reasoningEffort', effort, (expected, actual) => actual === expected)
}

/** 写入长上下文档开关。 */
export function writeLongContext(scope: MiniMaxSettingsScope, enabled: boolean): Promise<void> {
  return writeField(scope, 'longContext', enabled, (expected, actual) => actual === expected)
}

/**
 * 切换一个区域的启用状态，并保证结果里至少还有一个区域。
 *
 * 两个区域都关掉意味着插件什么都不注册——那不是"用户想要的状态"，而是卡片
 * 把自己搞没了。所以取消最后一个时返回 `false` 让调用方给提示。
 */
export function toggleRegion(
  current: readonly string[],
  region: string,
): { next: string[], accepted: boolean } {
  const has = current.includes(region)
  if (has && current.length === 1) return { next: [...current], accepted: false }
  const next = has ? current.filter(entry => entry !== region) : [...current, region]
  // 固定顺序：写回配置时避免同样的集合因顺序抖动而反复触发宿主重注册。
  return { next: ['cn', 'global'].filter(entry => next.includes(entry)), accepted: true }
}
