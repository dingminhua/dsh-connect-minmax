/**
 * 设置卡片的文案，注册在 `settings.minmax` 命名空间下。
 *
 * `zh` 写成 `Record<MiniMaxSettingsKey, string>` 是**故意的**：它强制中英
 * 两份字典的键**一一对应**。少一个键就编译不过——而不是等到某个人在英文
 * 界面里看到一串 `row.something` 的原始键名。
 *
 * 命名约定沿用本插件族：`row.*` 前缀。
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   —— `row.*` 的键约定与中英 1:1 键对齐的写法来自该项目。
 */

/** 英文文案（同时充当键的联合类型）。 */
export const en = {
  'row.title': 'MiniMax (local sign-in)',
  'row.desc': 'Uses the MiniMax account you are already signed into on this machine. No API key: the plugin reads the local login state and refreshes it through MiniMax Code itself.',
  'row.loading': 'Reading status…',
  'row.unreachable': 'Cannot read the plugin status.',
  'row.refresh': 'Refresh',
  'row.refreshing': 'Refreshing…',
  'row.retry': 'Try again',

  'login.label': 'Sign-in',
  'login.ready': 'Signed in',
  'login.anonymous': 'Sign-in required',
  'login.missing': 'No local login found',
  'login.expired': 'Sign-in expired',
  'login.error': 'Sign-in error',
  'login.source': 'Source',
  'login.sourceLease': 'MiniMax Code lease',
  'login.sourceFile': 'Local credential file',
  'login.sourceNone': 'None',
  'login.generation': 'Generation',
  'login.expires': 'Expires',
  'login.expiresUnknown': 'Unknown',
  'login.expiredAgo': 'expired',
  'login.inMinutes': 'in {count} min',
  'login.inHours': 'in {count} h',
  'login.inDays': 'in {count} d',

  'advice.readyLease': 'Signed in. MiniMax Code provides the credential and refreshes it for you.',
  'advice.readyFile': 'Signed in. MiniMax Code is not running, so the plugin is reading the local credential file instead.',
  'advice.signInRequired': 'Not signed in: open MiniMax Code and sign in there. This plugin follows that sign-in.',
  'advice.expired': 'The sign-in expired: sign in again in MiniMax Code.',

  'promise.noApiKey': 'This plugin never reads, asks for, or stores an API key — the credential always comes from the local sign-in.',

  'region.label': 'Region',
  'region.baseUrl': 'Endpoint',
  'route.label': 'Provider route',
  'version.label': 'Plugin version',

  'models.label': 'Models',
  'models.count': '{count} models',
  'models.empty': 'No models are offered.',
  'models.context': 'Context',
  'models.output': 'Max output',
  'models.image': 'Image',
  'models.imageYes': 'Yes',
  'models.imageNo': 'No',
  'models.reasoning': 'Thinking',
  'models.reasoningYes': 'Yes',
  'models.reasoningNo': 'No',

  'error.recent': 'Last error',
} as const

/** 文案键的联合类型。 */
export type MiniMaxSettingsKey = keyof typeof en

/** 中文文案。键必须与英文**完全一致**。 */
export const zh: Record<MiniMaxSettingsKey, string> = {
  'row.title': 'MiniMax（本机登录）',
  'row.desc': '使用本机已登录的 MiniMax 账号，无需 API Key：插件读取本机登录态，续期交由 MiniMax Code 自行处理。',
  'row.loading': '正在读取状态…',
  'row.unreachable': '无法读取插件状态。',
  'row.refresh': '刷新',
  'row.refreshing': '刷新中…',
  'row.retry': '重试',

  'login.label': '登录态',
  'login.ready': '已登录',
  'login.anonymous': '需要登录',
  'login.missing': '未找到本机登录',
  'login.expired': '登录已过期',
  'login.error': '登录出错',
  'login.source': '来源',
  'login.sourceLease': 'MiniMax Code 租约',
  'login.sourceFile': '本地凭据文件',
  'login.sourceNone': '无',
  'login.generation': '代数',
  'login.expires': '到期',
  'login.expiresUnknown': '未知',
  'login.expiredAgo': '已过期',
  'login.inMinutes': '{count} 分钟后',
  'login.inHours': '{count} 小时后',
  'login.inDays': '{count} 天后',

  'advice.readyLease': '已登录。凭据由 MiniMax Code 提供，并由它自动续期。',
  'advice.readyFile': '已登录。MiniMax Code 没有在运行，插件改为读取本地凭据文件。',
  'advice.signInRequired': '尚未登录：请打开 MiniMax Code 并在那里登录，本插件会自动跟随该登录。',
  'advice.expired': '登录已过期：请在 MiniMax Code 中重新登录。',

  'promise.noApiKey': '本插件不读取、不索取、也不保存任何 API Key —— 凭据始终来自本机登录态。',

  'region.label': '区域',
  'region.baseUrl': '接口地址',
  'route.label': '供应商路由',
  'version.label': '插件版本',

  'models.label': '模型',
  'models.count': '{count} 个模型',
  'models.empty': '没有可用的模型。',
  'models.context': '上下文',
  'models.output': '最大输出',
  'models.image': '图片',
  'models.imageYes': '支持',
  'models.imageNo': '不支持',
  'models.reasoning': '思考',
  'models.reasoningYes': '支持',
  'models.reasoningNo': '不支持',

  'error.recent': '最近错误',
}
