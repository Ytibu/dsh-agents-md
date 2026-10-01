/**
 * 客户端契约测试：node test-client-contract.mjs
 *
 * `lib/client.js` 是手写 bundle，不能像 host 那样直接 import 进来断言，但它和
 * host 之间的接口是全插件最容易悄悄坏掉的地方：改了一侧的路由名、忘了同步另一侧，
 * 表现是设置页某个 tab 静默 404。
 *
 * 这个脚本用**正则对照两份源码**，把不变量固化成断言：
 *   1. client 里出现的每个 fetch 路径，host 都注册了；
 *   2. host 注册的每条路由，client 都在用（防止留下死路由）；
 *   3. client 只 require 了 react，没有偷偷引入别的模块；
 *   4. bundle id / exports / 槽位注册参数与 package.json 保持一致。
 *
 * 之所以能这么做而不误报：host 的 register 路径与 client 的 fetch 路径都是字面量。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const hostSource = readFileSync(join(here, 'lib/index.js'), 'utf8')
const clientSource = readFileSync(join(here, 'lib/client.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ' -> ' + detail}`)
  }
}

/** Collect unique string literals matching a pattern. */
function collect(source, pattern) {
  const found = new Set()
  for (const match of source.matchAll(pattern)) found.add(match[1])
  return [...found]
}

/** Normalize a fetch target to a comparable route path (drop the query string). */
function routeOf(target) {
  return '/' + target.split('?')[0].replace(/^\/+/, '').split('/').filter(Boolean).join('/')
}

console.log('路由契约')

// host: route('/api/...', ['GET', ...], handler) —— register 的参数在 route() 包装里
const hostRoutes = collect(hostSource, /route\('(\/api\/[^']+)',\s*\[/g)
// client: fetch("/api/..." 或 fetch("/api/..." + ...)
const clientTargets = collect(clientSource, /fetch\(\s*"([^"]+)"/g)
const clientRoutes = [...new Set(clientTargets.map(routeOf))]

check('host 侧解析出 5 条路由', hostRoutes.length === 5, JSON.stringify(hostRoutes))
check('client 侧解析出 5 条路由', clientRoutes.length === 5, JSON.stringify(clientRoutes))

const missingOnHost = clientRoutes.filter((route) => !hostRoutes.includes(route))
check('client 调用的路由 host 全都注册了', missingOnHost.length === 0, JSON.stringify(missingOnHost))

const unusedOnHost = hostRoutes.filter((route) => !clientRoutes.includes(route))
check('host 注册的路由 client 全都在用（无死路由）', unusedOnHost.length === 0, JSON.stringify(unusedOnHost))

check(
  '所有路由都挂在 /api 前缀下（鉴权栅栏要求）',
  [...hostRoutes, ...clientRoutes].every((route) => route.startsWith('/api/')),
  JSON.stringify([...hostRoutes, ...clientRoutes]),
)

console.log('\nClient 形态')

check('只 require 了 react', [...clientSource.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].length === 1
  && clientSource.includes('require("react")'), '存在额外 require')
check('没有用 import/export 语法（零构建）', !/^\s*(import|export)\s/m.test(clientSource))
// 去掉块注释、行注释与字符串字面量后再找 JSX：否则 `a < b`、字符串里的 `<div>` 都会误报。
const clientCode = clientSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/"[^"]*"/g, '""')
  .replace(/'[^']*'/g, "''")
  .replace(/`[^`]*`/g, '``')
const jsxHits = [...clientCode.matchAll(/<[A-Za-z][A-Za-z0-9.]*[\s/>]/g)].map((match) => match[0])
check('没有 JSX 尖括号', jsxHits.length === 0, JSON.stringify(jsxHits.slice(0, 5)))

const bundleId = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)
check('bundle id 等于包名', bundleId?.[1] === manifest.name, `${bundleId?.[1]} vs ${manifest.name}`)

const exportedName = clientSource.match(/const name = "([^"]+)"/)
const patchFile = readFileSync(join(here, 'cordis.patch.yml'), 'utf8')
const patchName = patchFile.match(/name:\s*'([^']+)'/)
const patchId = patchFile.match(/id:\s*(\S+)/)
check('client exports.name 等于 cordis.patch.yml 的 insert.id', exportedName?.[1] === patchId?.[1], `${exportedName?.[1]} vs ${patchId?.[1]}`)
check('cordis.patch.yml 的 insert.name 等于包名', patchName?.[1] === manifest.name, `${patchName?.[1]} vs ${manifest.name}`)

check('client.inject 只声明 slots', /const inject = \["slots"\]/.test(clientSource))

const register = clientSource.match(/slots\.register\(\{([\s\S]*?)\}/)
const options = register?.[1] ?? ''
check('注册进 settings.section 槽位', options.includes('name: "settings.section"'))
check('槽位 id 为 agents-md', options.includes('id: "agents-md"'))
check('槽位标签与 README 一致', options.includes('label: () => "AGENTS.md 管理"'))

console.log('\nHost 形态')

check('host 用 connection.fetch.register（不得用 webServer）', hostSource.includes('connection.fetch.register'))
check('host 没有用 webServer.register 注册 /api 路由', !/webServer\.register\(\{\s*kind:\s*'exact'[\s\S]{0,80}\/api\//.test(hostSource))
check(
  'host 每条路由都显式声明 methods 与 buffered body',
  (hostSource.match(/route\('\/api\/[^']+',\s*\[[^\]]+\]/g) ?? []).length === hostRoutes.length
    && hostSource.includes("requestBody: 'buffered'"),
  '有路由缺少 methods 声明',
)
check('host 未声明运行时依赖', manifest.dependencies === undefined, JSON.stringify(manifest.dependencies))

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exitCode = 1
