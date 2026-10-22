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
export type MiniMaxWritableField
  = 'models' | 'regions' | 'longContext' | 'modelContextWindows' | 'modelImages' | 'modelContextWindows'

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
async function writeField(
  scope: MiniMaxSettingsScope,
  field: MiniMaxWritableField,
  value: unknown,
  same: (expected: unknown, actual: unknown) => boolean,
): Promise<void> {
  let refused = false
  try {
    refused = (await scope.set(field, value)) === false
  } catch {
    refused = true
  }
  if (!refused && same(value, readField(scope, field))) return
  throw new MiniMaxSettingsWriteError(
    field,
    refused ? '设置面板拒绝了这次写入' : '写入后回读到的值与期望不一致',
  )
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

/** 写入一个"模型 id → 数值/布尔"映射里的单项。 */
function writeFlag<T extends number | boolean>(
  scope: MiniMaxSettingsScope,
  field: 'modelContextWindows' | 'modelImages',
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
