/**
 * 重启后自检：node check-live.mjs [baseUrl]
 *
 * 用途：dsh web 重启后确认「未鉴权访问拿不到数据」这条修复真的在运行中的进程里生效。
 * 默认探测 http://127.0.0.1:19387。
 *
 * 判定依据（不需要浏览器会话）：
 *   - 修复生效：5 条 /api/agents-md/* 路由都会先过 Connection 的 /api 栅栏，
 *     未鉴权的裸请求一律 401/403，**不会**返回真实数据（全局规则内容、工作区路径等）。
 *   - 未生效（旧模块仍在跑）：GET 会直接 200 并把全局 AGENTS.md 内容
 *     / 工作区路径吐给未鉴权调用方。
 *
 * 退出码：0 = 修复已生效；1 = 仍在跑旧模块（需要重启）；2 = 连不上服务器。
 */
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:19387'

const PROBES = [
  '/api/agents-md/global',
  '/api/agents-md/workspaces',
  '/api/agents-md/models',
]
const CONTROL = '/api/agents-md/no-such-route'

/** Read a response defensively: an aborted/empty response must not throw. */
async function probe(path) {
  try {
    const response = await fetch(baseUrl + path, { signal: AbortSignal.timeout(10_000) })
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    return { status: response.status, text }
  } catch (error) {
    return { status: 0, text: `请求失败: ${error.message}` }
  }
}

/** A response leaks data when it is 2xx and carries a JSON body. */
function leaks(result) {
  if (result.status < 200 || result.status >= 300) return false
  try {
    const parsed = JSON.parse(result.text)
    return parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length > 0
  } catch {
    return result.text.length > 0
  }
}

console.log(`探测目标: ${baseUrl}\n`)

const control = await probe(CONTROL)
console.log(`对照（不存在的路由） ${CONTROL}`)
console.log(`  status=${control.status}  ${control.status === 0 ? control.text : '（栅栏应给出 401/403）'}\n`)

if (control.status === 0) {
  console.error('连不上服务器：请确认 dsh web 已经启动，或传入正确的 baseUrl。')
  process.exit(2)
}

let leaked = 0
for (const path of PROBES) {
  const result = await probe(path)
  const bad = leaks(result)
  if (bad) leaked += 1
  const preview = result.text.length > 80 ? `${result.text.slice(0, 80)}…` : result.text
  console.log(`${bad ? '泄露' : '拒绝'}  ${path}`)
  console.log(`  status=${result.status}  body=${JSON.stringify(preview)}`)
}

console.log('')

if (leaked > 0) {
  console.error(`结论：${leaked}/${PROBES.length} 条路由在未鉴权时返回了数据 —— 修复**未**生效。`)
  console.error('处理：重启 dsh web（运行中的进程仍在执行修复前的 Host 模块）。')
  process.exit(1)
}

console.log('结论：未鉴权的裸请求全部被栅栏拒绝，修复已在运行中的进程里生效。')
console.log('（浏览器里的设置面板是同源带会话的请求，不受影响；若面板报 401，刷新页面重新登录即可。）')
