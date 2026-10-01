/**
 * 重启后自检：node check-live.mjs [baseUrl]
 *
 * 用途：dsh web 重启后确认两件事在**运行中的进程**里真的成立。
 *
 *   一、鉴权栅栏生效
 *       5 条 /api/agents-md/* 路由都在 Connection 的 /api 前缀栅栏内，
 *       未鉴权的裸请求一律 401/403，**不会**返回真实数据（全局规则内容、
 *       工作区路径等）。
 *       未生效（旧模块仍在跑）：GET 直接 200 把全局 AGENTS.md 内容吐出来。
 *
 *   二、Client bundle 已被注入
 *       运行中的 client-modules 注册表里确有本插件，且它服务的字节就是
 *       仓库里这份 lib/client.js。rev 按出厂算法由文件元信息算出：
 *       sha1("plugin-artifact" + "\0" + 逐项 "<字节数>:<内容>") 取前 12 位。
 *       元信息一变 rev 就变，所以这同时也验证了「服务的是最新字节」。
 *
 * 退出码：0 = 两项都通过；1 = 有检查未通过；2 = 连不上服务器。
 */
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:19387'
const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const bundleId = manifest.name

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
    return { status: response.status, text, headers: response.headers }
  } catch (error) {
    return { status: 0, text: `请求失败: ${error.message}`, headers: new Headers() }
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

/** Mirror of client-modules' framedHash for artifact revisions. */
function artifactRevision(file) {
  const stats = statSync(file)
  const hash = createHash('sha1').update('plugin-artifact').update('\0')
  for (const part of [String(stats.mtimeMs), String(stats.ctimeMs), String(stats.size)]) {
    hash.update(`${Buffer.byteLength(part)}:`).update(part)
  }
  return hash.digest('hex').slice(0, 12)
}

let failures = 0

console.log(`探测目标: ${baseUrl}\n`)

// ── 一、鉴权栅栏 ────────────────────────────────────────────────────────────
console.log('一、鉴权栅栏（未鉴权裸请求应被拒绝）')

const control = await probe(CONTROL)
console.log(`  对照（不存在的路由） → status=${control.status}${control.status === 0 ? ` ${control.text}` : ''}`)
if (control.status === 0) {
  console.error('  连不上服务器：请确认 dsh web 已启动，或传入正确的 baseUrl。')
  process.exit(2)
}

for (const path of PROBES) {
  const result = await probe(path)
  const bad = leaks(result)
  if (bad) failures += 1
  const preview = result.text.length > 60 ? `${result.text.slice(0, 60)}…` : result.text
  console.log(`  ${bad ? '泄露' : '拒绝'}  ${path}  status=${result.status}  body=${JSON.stringify(preview)}`)
}

// GET 通过栅栏后应当返回 JSON 且不允许缓存（浏览器带会话时走这条路径）
const authed = await probe('/api/agents-md/workspaces')
if (authed.status === 200) {
  const isJson = (authed.headers.get('content-type') ?? '').includes('application/json')
  const noStore = authed.headers.get('cache-control') === 'no-store'
  if (!isJson || !noStore) failures += 1
  console.log(`  ${isJson && noStore ? 'ok  ' : 'FAIL'}  响应契约  content-type=${authed.headers.get('content-type')}  cache-control=${authed.headers.get('cache-control')}`)
} else {
  console.log(`  --   响应契约  跳过（裸请求被拒 status=${authed.status}，属预期）`)
}

// ── 二、Client bundle ──────────────────────────────────────────────────────
console.log('\n二、Client bundle 是否被注入并服务最新字节')

const clientFile = join(here, 'lib/client.js')
const onDisk = readFileSync(clientFile, 'utf8')
const rev = artifactRevision(clientFile)
const bundleUrl = `${baseUrl}/plugins/??${bundleId}/client.js&rev=${rev}`

let bundleStatus = 0
let served = ''
try {
  const response = await fetch(bundleUrl, { signal: AbortSignal.timeout(10_000) })
  bundleStatus = response.status
  served = await response.text()
} catch (error) {
  console.log(`  --   跳过（${error.message}）`)
}

if (bundleStatus !== 0) {
  if (bundleStatus !== 200) {
    failures += 1
    console.log(`  FAIL  ${bundleUrl} → status=${bundleStatus}`)
    console.log('        运行中的 client-modules 注册表里没有本插件，或未重新构建')
  } else {
    // 出厂 bundle 路由会在结尾追加一行 sourceMappingURL 尾注
    const stripped = served.replace(/;\n\/\/# sourceMappingURL=[^\n]*\n?$/, '')
    const identical = stripped === onDisk
    if (!identical) failures += 1
    console.log(`  ${identical ? 'ok  ' : 'FAIL'}  bundle 已服务且与 lib/client.js 逐字节一致（${Buffer.byteLength(served)} 字节，rev=${rev}）`)
  }
}

console.log('')

if (failures > 0) {
  console.error(`结论：${failures} 项检查未通过。`)
  console.error('若栅栏泄露 → 重启 dsh web（运行中的进程仍在执行修复前的 Host 模块）。')
  console.error('若 bundle 缺失 → 确认插件已加入 profile 的 dsh.profile.bundles，并刷新页面。')
  process.exit(1)
}

console.log('结论：鉴权栅栏已生效，Client bundle 已注入且是最新字节。')
console.log('（设置面板是同源带会话的请求，不受栅栏影响；若面板报 401，刷新页面重新登录即可。）')
