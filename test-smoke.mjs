/**
 * dsh-agents-md 离线冒烟测试：node test-smoke.mjs
 *
 * 不依赖真实 DSH 环境：用假的 ctx/host 服务 + 真实临时目录，把 lib/index.js
 * 经 ctx.connection.fetch.register 注册的路由全部跑一遍，验证读/写/合并/覆盖/
 * 备份/错误码。
 */
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from './lib/index.js'

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

function deepEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

const ORIGIN = 'http://localhost:19387'

/** Build a real Fetch Request, the exact shape the Connection route receives. */
function makeRequest({ method = 'GET', url = '/', body = undefined }) {
  const headers = { host: 'localhost:19387', origin: ORIGIN }
  if (body === undefined) return new Request(ORIGIN + url, { method, headers })
  headers['content-type'] = 'application/json'
  return new Request(ORIGIN + url, { method, headers, body: JSON.stringify(body) })
}

/** Fake llm service: streams a scripted chunk sequence unless overridden. */
function makeLlm(script) {
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: async (provider) => [{ provider, id: 'fake-model', name: 'Fake Model' }],
    stream(options) {
      calls.push(options)
      const chunks = typeof script === 'function' ? script(options) : script
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

const DEFAULT_SCRIPT = [
  { type: 'text-delta', index: 0, text: '# 融合结果\n\n' },
  { type: 'text-delta', index: 0, text: '- 规则 A\n- 规则 B\n' },
  { type: 'finish', reason: { kind: 'stop' } },
]

/**
 * Build the fake plugin context and capture every registered route.
 * Routes now ride `ctx.connection.fetch.register`, so the fake captures those
 * fenced Fetch routes instead of raw webServer handlers.
 */
function makeHost({ llm, workspaces, defaultSelection = { provider: 'fake-provider', model: 'fake-model' } }) {
  const routes = new Map()
  const host = {
    effect: (factory) => {
      factory()
      return () => {}
    },
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route)
          return async () => {}
        },
      },
    },
    workspaceRegistry: {
      list: () => workspaces.map((ws) => ({ id: ws.id, title: ws.title, path: ws.path })),
      get: (id) => workspaces.find((ws) => ws.id === id),
    },
    llm,
    agentDefaultModel: { currentSelection: () => defaultSelection },
  }
  const ctx = {
    inject: (deps, callback) => {
      callback(host)
      return () => {}
    },
  }
  apply(ctx)
  return { host, routes }
}

/** Call a registered route and return its Response. */
async function call(routes, path, request) {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`路由未注册: ${path}`)
  if (!route.methods.includes(request.method)) {
    return new Response(null, { status: 405 })
  }
  return route.fetch(request)
}

/** Read a Response as parsed JSON (memoized: a Fetch body is single-read). */
const bodyCache = new WeakMap()
async function body(response) {
  if (!bodyCache.has(response)) {
    bodyCache.set(response, JSON.parse(await response.text()))
  }
  return bodyCache.get(response)
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'agents-md-smoke-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'dsh-home')
  const realNow = Date.now

  const workspace = { id: 'ws-1', title: '测试工作区', path: join(root, 'project') }
  await mkdir(workspace.path, { recursive: true })
  const globalFile = join(process.env.DSH_HOME, 'AGENTS.md')

  try {
    console.log('导出契约')
    check('name === "agents-md"', name === 'agents-md', String(name))
    check(
      'inject 覆盖 4 个必需服务',
      deepEqual([...inject].sort(), ['agentDefaultModel', 'connection', 'llm', 'workspaceRegistry']),
      JSON.stringify(inject),
    )

    const llm = makeLlm(DEFAULT_SCRIPT)
    const { routes } = makeHost({ llm, workspaces: [workspace] })
    check(
      '注册 5 条路由',
      deepEqual([...routes.keys()].sort(), [
        '/api/agents-md/compose',
        '/api/agents-md/global',
        '/api/agents-md/models',
        '/api/agents-md/project',
        '/api/agents-md/workspaces',
      ]),
      JSON.stringify([...routes.keys()]),
    )
    check(
      '路由全部声明显式 methods（栅栏契约要求）',
      [...routes.values()].every((route) => Array.isArray(route.methods) && route.methods.length > 0),
      JSON.stringify([...routes.values()].map((r) => r.methods)),
    )
    check(
      '只读路由不声明 POST',
      deepEqual(routes.get('/api/agents-md/workspaces').methods, ['GET'])
        && deepEqual(routes.get('/api/agents-md/compose').methods, ['POST']),
      JSON.stringify([routes.get('/api/agents-md/workspaces').methods, routes.get('/api/agents-md/compose').methods]),
    )

    // ── 功能 1：全局 AGENTS.md ──────────────────────────────────────────────
    console.log('功能 1：全局 AGENTS.md')
    let res = await call(routes, '/api/agents-md/global', makeRequest({}))
    check('全局 GET 未创建时 exists=false', res.status === 200 && (await body(res)).exists === false)
    res = await call(routes, '/api/agents-md/global', makeRequest({}))
    check('全局路径解析到 $DSH_HOME', (await body(res)).path === globalFile, (await body(res)).path)

    res = await call(routes, '/api/agents-md/global', makeRequest({
      method: 'POST',
      body: { content: '# 全局规则\n\n- 中文注释\n' },
    }))
    check('全局 POST 返回 ok', res.status === 200 && (await body(res)).ok === true)
    check('全局 POST 首次写入无备份', (await body(res)).backupPath === null, JSON.stringify(await body(res)))
    check('全局 POST 真的落盘', (await readFile(globalFile, 'utf8')).includes('中文注释'))

    res = await call(routes, '/api/agents-md/global', makeRequest({}))
    const globalState = await body(res)
    check('全局 GET 回读一致', globalState.exists === true && globalState.content.includes('中文注释'))

    res = await call(routes, '/api/agents-md/global', makeRequest({ method: 'POST', body: { content: 123 } }))
    check('全局 POST 非字符串 content 400', res.status === 400, String(res.status))

    res = await call(routes, '/api/agents-md/global', makeRequest({
      method: 'POST',
      body: { content: 'x'.repeat(256 * 1024 + 1) },
    }))
    check('全局 POST 超 256 KiB 返回 413', res.status === 413, String(res.status))

    res = await call(routes, '/api/agents-md/global', makeRequest({ method: 'POST', url: '/', body: {} }))
    check('全局 POST 缺 content 400', res.status === 400, String(res.status))

    // ── 功能 2：项目级 AGENTS.md ────────────────────────────────────────────
    console.log('功能 2：项目级 AGENTS.md')
    res = await call(routes, '/api/agents-md/project', makeRequest({}))
    check('项目 GET 缺参 400', res.status === 400, String(res.status))
    res = await call(routes, '/api/agents-md/project', makeRequest({ url: '/api/agents-md/project?workspace=nope' }))
    check('项目 GET 未知工作区 404', res.status === 404, String(res.status))

    res = await call(routes, '/api/agents-md/project', makeRequest({ url: '/api/agents-md/project?workspace=ws-1' }))
    const projectState = await body(res)
    check('项目 GET 未创建时 exists=false', res.status === 200 && projectState.exists === false)
    check('项目 GET 目标是工作区根 AGENTS.md', projectState.path === join(workspace.path, 'AGENTS.md'), projectState.path)

    res = await call(routes, '/api/agents-md/project', makeRequest({
      method: 'POST',
      url: '/api/agents-md/project?workspace=ws-1',
      body: { content: '# 项目规则 v1\n' },
    }))
    check('项目 POST 首次写入无备份', res.status === 200 && (await body(res)).backupPath === null)
    check('项目 POST 落盘', (await readFile(join(workspace.path, 'AGENTS.md'), 'utf8')).includes('v1'))

    res = await call(routes, '/api/agents-md/project', makeRequest({
      method: 'POST',
      url: '/api/agents-md/project?workspace=ws-1',
      body: { content: '# 项目规则 v2\n' },
    }))
    const backupPath = (await body(res)).backupPath
    check('项目 POST 覆盖时生成备份', typeof backupPath === 'string' && backupPath.includes('.bak-'), String(backupPath))
    check('备份内容是旧版本', (await readFile(backupPath, 'utf8')).includes('v1'))
    check('当前文件是新版本', (await readFile(join(workspace.path, 'AGENTS.md'), 'utf8')).includes('v2'))

    // 回归（复验缺陷 D2）：同一毫秒内的两次覆盖写不能互相覆盖备份。
    const projectFile = join(workspace.path, 'AGENTS.md')
    Date.now = () => 1700000000000
    await call(routes, '/api/agents-md/project', makeRequest({
      method: 'POST', url: '/api/agents-md/project?workspace=ws-1', body: { content: 'S0\n' },
    }))
    await call(routes, '/api/agents-md/project', makeRequest({
      method: 'POST', url: '/api/agents-md/project?workspace=ws-1', body: { content: 'S1\n' },
    }))
    await call(routes, '/api/agents-md/project', makeRequest({
      method: 'POST', url: '/api/agents-md/project?workspace=ws-1', body: { content: 'S2\n' },
    }))
    Date.now = realNow
    const sameMsBackups = (await readdir(workspace.path)).filter((entry) => entry.startsWith('AGENTS.md.bak-1700000000000'))
    check('同毫秒三次写入留下三个独立备份', sameMsBackups.length === 3, JSON.stringify(sameMsBackups))
    const sameMsContents = []
    for (const entry of sameMsBackups) {
      sameMsContents.push((await readFile(join(workspace.path, entry), 'utf8')).trim())
    }
    check(
      '三个同毫秒备份内容互不相同、无静默覆盖',
      new Set(sameMsContents).size === 3,
      JSON.stringify(sameMsContents),
    )
    check('其中一个备份是 S1（第三次写覆盖了 S1）', sameMsContents.includes('S1'), JSON.stringify(sameMsContents))
    check('当前文件是最后一次写入 S2', (await readFile(projectFile, 'utf8')) === 'S2\n', await readFile(projectFile, 'utf8'))

    // 回归（第二轮复验 D2 并发残留）：同毫秒并发写不得丢备份、不得 500。
    Date.now = () => 1700000009999
    const concurrentBase = await readFile(projectFile, 'utf8')
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, (_, index) => call(routes, '/api/agents-md/project', makeRequest({
        method: 'POST',
        url: '/api/agents-md/project?workspace=ws-1',
        body: { content: `C${index}\n` },
      }))),
    )
    Date.now = realNow
    const concurrentStatuses = concurrent.map((response) => response.status)
    check('并发 6 写全部 200（无 EBUSY 500）', concurrentStatuses.every((status) => status === 200), JSON.stringify(concurrentStatuses))
    const concurrentBackups = (await readdir(workspace.path))
      .filter((entry) => entry.startsWith('AGENTS.md.bak-1700000009999'))
    check('并发 6 写留下 6 个独立备份', concurrentBackups.length === 6, JSON.stringify(concurrentBackups))
    const concurrentContents = []
    for (const entry of concurrentBackups) {
      concurrentContents.push(await readFile(join(workspace.path, entry), 'utf8'))
    }
    check('并发备份内容无残缺（全是此前写入之一）', concurrentContents.every((text) => /^(S2|C\d)\n$/.test(text)), JSON.stringify(concurrentContents))
    check('并发前状态至少被备份一次', concurrentContents.includes(concurrentBase), JSON.stringify(concurrentContents))
    check('并发后当前文件是某个完整写入', /^C\d\n$/.test(await readFile(projectFile, 'utf8')), await readFile(projectFile, 'utf8'))

    // ── 功能 3：合并 / 覆盖 ─────────────────────────────────────────────────
    console.log('功能 3：合并 / 覆盖生成')
    res = await call(routes, '/api/agents-md/compose', makeRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', content: '# 我的项目规则\n', mode: 'overwrite' },
    }))
    let composed = await body(res)
    check('覆盖模式直接返回用户内容', composed.content === '# 我的项目规则\n' && composed.mode === 'overwrite', JSON.stringify(composed))
    check('覆盖模式不调用模型', llm.calls.length === 0, String(llm.calls.length))
    check('覆盖模式 usedGlobal=false', composed.usedGlobal === false, JSON.stringify(composed))

    res = await call(routes, '/api/agents-md/compose', makeRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', content: '# 我的项目规则\n', mode: 'merge' },
    }))
    composed = await body(res)
    check('合并模式调用了一次模型', llm.calls.length === 1, String(llm.calls.length))
    check('合并模式拼接 text-delta', composed.content.includes('融合结果') && composed.content.includes('规则 A'), JSON.stringify(composed))
    check('合并模式 usedGlobal=true', composed.usedGlobal === true, JSON.stringify(composed))
    check('合并模式回传模型标识', deepEqual(composed.model, { provider: 'fake-provider', model: 'fake-model' }), JSON.stringify(composed.model))
    check('合并模式不落盘', !(await readFile(projectFile, 'utf8')).includes('融合结果'))

    const prompt = llm.calls[0].messages[0].content[0].text
    check('融合 prompt 含全局原文', prompt.includes('中文注释'))
    check('融合 prompt 含用户输入', prompt.includes('我的项目规则'))
    check('融合请求带 system 提示', typeof llm.calls[0].system === 'string' && llm.calls[0].system.includes('AGENTS.md'))
    check('融合请求带 abort signal', llm.calls[0].signal instanceof AbortSignal)

    res = await call(routes, '/api/agents-md/compose', makeRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', content: 'x', mode: 'merge', provider: 'fake-provider', model: 'other-model' },
    }))
    check('合并模式支持指定模型', llm.calls[1].model === 'other-model', String(llm.calls[1].model))

    // 围栏兜底
    const fencedHost = makeHost({
      llm: makeLlm([
        { type: 'text-delta', index: 0, text: '```markdown\n# 围栏内容\n```' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
      workspaces: [workspace],
    })
    res = await call(fencedHost.routes, '/api/agents-md/compose', makeRequest({
      method: 'POST', body: { workspaceId: 'ws-1', content: 'x', mode: 'merge' },
    }))
    check('合并结果剥掉代码围栏', (await body(res)).content === '# 围栏内容', JSON.stringify(await body(res)))

    // reasoning 兜底
    const reasoningHost = makeHost({
      llm: makeLlm([
        { type: 'reasoning-delta', index: 0, text: '# 来自 reasoning' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
      workspaces: [workspace],
    })
    res = await call(reasoningHost.routes, '/api/agents-md/compose', makeRequest({
      method: 'POST', body: { workspaceId: 'ws-1', content: 'x', mode: 'merge' },
    }))
    check('模型无 text 时回退 reasoning', (await body(res)).content === '# 来自 reasoning', JSON.stringify(await body(res)))

    // 全局文件缺失 -> 降级
    const savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'empty-home')
    const degradeHost = makeHost({ llm: makeLlm(DEFAULT_SCRIPT), workspaces: [workspace] })
    res = await call(degradeHost.routes, '/api/agents-md/compose', makeRequest({
      method: 'POST', body: { workspaceId: 'ws-1', content: '# 只有项目规则\n', mode: 'merge' },
    }))
    composed = await body(res)
    check('全局缺失时降级为直接用用户内容', composed.content === '# 只有项目规则\n' && composed.usedGlobal === false, JSON.stringify(composed))
    check('全局缺失时不调用模型', degradeHost.host.llm.calls.length === 0, String(degradeHost.host.llm.calls.length))

    // 空全局文件 -> 降级
    const blankHome = join(root, 'blank-home')
    await mkdir(blankHome, { recursive: true })
    await writeFile(join(blankHome, 'AGENTS.md'), '   \n', 'utf8')
    process.env.DSH_HOME = blankHome
    const blankHost = makeHost({ llm: makeLlm(DEFAULT_SCRIPT), workspaces: [workspace] })
    res = await call(blankHost.routes, '/api/agents-md/compose', makeRequest({
      method: 'POST', body: { workspaceId: 'ws-1', content: '# 只有项目规则\n', mode: 'merge' },
    }))
    const blankResult = await body(res)
    check('全局为空时降级且不调模型', blankResult.usedGlobal === false && blankHost.host.llm.calls.length === 0, JSON.stringify(blankResult))
    process.env.DSH_HOME = savedHome

    // 错误路径
    res = await call(routes, '/api/agents-md/compose', makeRequest({
      method: 'POST', body: { workspaceId: '', content: 'x' },
    }))
    check('compose 缺 workspaceId 400', res.status === 400, String(res.status))
    res = await call(routes, '/api/agents-md/compose', makeRequest({
      method: 'POST', body: { workspaceId: 'ws-1', content: '   ' },
    }))
    check('compose 空内容 400', res.status === 400, String(res.status))
    res = await call(routes, '/api/agents-md/compose', makeRequest({
      method: 'POST', body: { workspaceId: 'ghost', content: 'x' },
    }))
    check('compose 未知工作区 404', res.status === 404, String(res.status))
    res = await call(routes, '/api/agents-md/compose', makeRequest({
      method: 'POST', body: { content: 'x'.repeat(256 * 1024 + 1), workspaceId: 'ws-1' },
    }))
    check('compose 超 256 KiB 返回 413', res.status === 413, String(res.status))

    // 安全兜底：mode 传了未知值时必须回退为 overwrite（不误调模型消耗一次调用），
    // 而不是被当成 merge。
    const callsBeforeUnknownMode = llm.calls.length
    res = await call(routes, '/api/agents-md/compose', makeRequest({
      method: 'POST', body: { workspaceId: 'ws-1', content: '# 未知模式\n', mode: 'definitely-not-a-mode' },
    }))
    const unknownMode = await body(res)
    check(
      'compose 未知 mode 安全回退为 overwrite',
      unknownMode.mode === 'overwrite' && unknownMode.usedGlobal === false,
      JSON.stringify(unknownMode),
    )
    check('compose 未知 mode 不调用模型', llm.calls.length === callsBeforeUnknownMode, `${llm.calls.length} vs ${callsBeforeUnknownMode}`)

    // 响应契约：必须是 JSON 且 no-store（面板每次都要读到最新内容）
    const probeResponse = await call(routes, '/api/agents-md/global', makeRequest({}))
    check(
      '响应 content-type 为 application/json',
      (probeResponse.headers.get('content-type') ?? '').includes('application/json'),
      String(probeResponse.headers.get('content-type')),
    )
    check(
      '响应带 cache-control: no-store',
      probeResponse.headers.get('cache-control') === 'no-store',
      String(probeResponse.headers.get('cache-control')),
    )

    // 请求体不是合法 JSON 时返回 400，而不是 500
    const brokenBody = new Request(`${ORIGIN}/api/agents-md/global`, {
      method: 'POST',
      headers: { host: 'localhost:19387', origin: ORIGIN, 'content-type': 'application/json' },
      body: '{ 这不是 JSON',
    })
    res = await call(routes, '/api/agents-md/global', brokenBody)
    check('坏 JSON 请求体返回 400', res.status === 400, `${res.status} ${JSON.stringify(await body(res))}`)

    const errorHost = makeHost({
      llm: makeLlm([
        { type: 'text-delta', index: 0, text: 'partial' },
        { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'E_FAKE' } } },
      ]),
      workspaces: [workspace],
    })
    res = await call(errorHost.routes, '/api/agents-md/compose', makeRequest({
      method: 'POST', body: { workspaceId: 'ws-1', content: 'x', mode: 'merge' },
    }))
    check('模型 finish=error 时 500 且带原因', res.status === 500 && (await body(res)).error.includes('provider exploded'))

    const maxHost = makeHost({
      llm: makeLlm([
        { type: 'text-delta', index: 0, text: 'x' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ]),
      workspaces: [workspace],
    })
    res = await call(maxHost.routes, '/api/agents-md/compose', makeRequest({
      method: 'POST', body: { workspaceId: 'ws-1', content: 'x', mode: 'merge' },
    }))
    check('max-tokens 时提示内容过长', res.status === 500 && (await body(res)).error.includes('token 上限'))

    // ── 辅助路由 ────────────────────────────────────────────────────────────
    console.log('辅助路由')
    res = await call(routes, '/api/agents-md/workspaces', makeRequest({}))
    check(
      '工作区列表返回 id/title/path',
      deepEqual((await body(res)).workspaces, [{ id: 'ws-1', title: '测试工作区', path: workspace.path }]),
    )

    res = await call(routes, '/api/agents-md/models', makeRequest({}))
    const models = await body(res)
    check('模型目录含 provider 与 model', models.providers[0].id === 'fake-provider' && models.providers[0].models[0].id === 'fake-model')
    check('模型目录带默认选择', deepEqual(models.default, { provider: 'fake-provider', model: 'fake-model' }), JSON.stringify(models.default))

    // 备份文件命名可读性抽查：写多次后目录里应有 .bak-*
    const entries = await readdir(workspace.path)
    check('工作区根目录存在备份文件', entries.some((entry) => entry.startsWith('AGENTS.md.bak-')), JSON.stringify(entries))
  } finally {
    Date.now = realNow
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }

  console.log(`\n通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exitCode = 1
}

await main()
