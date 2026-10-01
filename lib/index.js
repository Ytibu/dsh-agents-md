/**
 * dsh-agents-md host 入口。
 *
 * 三个功能，五条路由 —— 全部经 `ctx.connection.fetch.register` 挂在 Connection 的
 * `/api` 通道上，因此自动落进 Host/Origin 栅栏与浏览器鉴权之内（自查同源不够：
 * 在 webServer 上直接注册 `/api/...` 的 exact 路由会遮蔽该前缀栅栏，导致只读接口
 * 无鉴权即可访问）。
 *
 *   1) GET/POST /api/agents-md/global      —— 读/写全局 AGENTS.md（$DSH_HOME 优先，否则 ~/.dsh）；
 *   2) GET/POST /api/agents-md/project     —— 读/写 <工作区>/AGENTS.md（固定工作区根目录）；
 *   3) POST     /api/agents-md/compose     —— 由用户内容生成项目级 AGENTS.md 内容（不落盘）：
 *                                             merge = 调 LLM 与全局 AGENTS.md 语义融合；
 *                                             overwrite = 直接用用户内容；
 *   辅助）GET   /api/agents-md/workspaces  —— 工作区列表；
 *         GET   /api/agents-md/models      —— 模型目录（供 merge 选择模型）。
 *
 * 客户端拿到 compose 的结果预览确认后，再用 (2) 落盘 —— 未确认前绝不写文件。
 * 所有写盘都会在目标已存在时先备份为 AGENTS.md.bak-<时间戳>。
 * 安装：装进 web profile 并加入 dsh.profile.bundles 后重启 dsh web，打开 设置 -> AGENTS.md 管理。
 */
import { readFile, writeFile, mkdir, copyFile, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const name = 'agents-md'

export const inject = ['llm', 'agentDefaultModel', 'connection', 'workspaceRegistry']

const MAX_BODY_BYTES = 256 * 1024
const COMPOSE_TIMEOUT_MS = 180_000
const MAX_OUTPUT_TOKENS = 16000
const JSON_HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' }

/** Build a JSON Response with the plugin's no-store contract. */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS })
}

/** Read a JSON request body, capped at a given byte limit. */
async function readJsonBody(request, capBytes) {
  const buffer = new Uint8Array(await request.arrayBuffer())
  if (buffer.byteLength > capBytes) {
    throw Object.assign(new Error('请求体过大（上限 256 KiB）'), { status: 413 })
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer))
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })
  }
}

/** Report one failure as JSON: an explicit status wins, everything else is a 500. */
function failureResponse(error) {
  const status = typeof error?.status === 'number' ? error.status : 500
  return jsonResponse(status, { error: String(error?.message ?? error) })
}

/**
 * Resolve the user-global rules file the same way the harness does:
 * a non-empty $DSH_HOME wins, otherwise ~/.dsh. This keeps the panel editing
 * the file that actually takes effect.
 */
function globalRulesFile() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home.trim() !== '' ? home.trim() : join(homedir(), '.dsh')
  return join(base, 'AGENTS.md')
}

/** Read a text file, reporting ENOENT as "absent" instead of throwing. */
async function readTextIfExists(file) {
  try {
    return { exists: true, content: await readFile(file, 'utf8') }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, content: '' }
    throw error
  }
}

/**
 * Reserve a backup path that does not exist yet. `COPYFILE_EXCL` makes the claim
 * atomic, so two concurrent saves in the same millisecond can never pick the same
 * candidate and silently overwrite one another's backup.
 */
async function copyWithReservedBackup(file) {
  const stamp = `${file}.bak-${Date.now()}`
  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? stamp : `${stamp}-${attempt}`
    try {
      await copyFile(file, candidate, constants.COPYFILE_EXCL)
      return candidate
    } catch (error) {
      if (error && error.code === 'EEXIST') continue
      throw error
    }
  }
}

/** Write text, creating parent directories and backing up an existing file. */
async function writeTextWithBackup(file, content) {
  const current = await readTextIfExists(file)
  let backupPath = null
  if (current.exists) {
    backupPath = await copyWithReservedBackup(file)
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  return backupPath
}

/**
 * Serialize every write to one target file. Concurrent read→copy→write on the
 * same path is not atomic: on Windows it fails with EBUSY, and elsewhere it can
 * interleave into a torn backup. A rejected write must not poison the queue.
 */
function serializeByTarget() {
  const tails = new Map()
  return (file, operation) => {
    const previous = tails.get(file) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    const settled = next.then(() => undefined, () => undefined)
    tails.set(file, settled)
    settled.then(() => {
      if (tails.get(file) === settled) tails.delete(file)
    })
    return next
  }
}

/** Resolve a workspace from the `workspace` query parameter. */
function resolveWorkspace(host, url) {
  const id = url.searchParams.get('workspace')
  if (id === null || id === '') {
    return { error: Object.assign(new Error('缺少 workspace 查询参数'), { status: 400 }) }
  }
  const workspace = host.workspaceRegistry.get(id)
  if (workspace === undefined) {
    return { error: Object.assign(new Error('未知工作区'), { status: 404 }) }
  }
  return { workspace, file: join(workspace.path, 'AGENTS.md') }
}

/** Collect text deltas from an llm.stream() chunk sequence. */
async function collectText(stream, signal) {
  let text = ''
  let reasoning = ''
  let finish = null
  for await (const chunk of stream) {
    signal?.throwIfAborted()
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'reasoning-delta') {
      reasoning += chunk.text
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  return { text, reasoning, finish }
}

/** Strip a single wrapping markdown code fence the model may have added. */
function stripFence(text) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?\s*```$/)
  return (fenced ? fenced[1] : trimmed).trim()
}

/** Run one LLM call to semantically fuse the global rules with the user's content. */
async function fuseWithGlobal(host, selection, globalContent, userContent) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), COMPOSE_TIMEOUT_MS)
  try {
    const stream = host.llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildFusePrompt(globalContent, userContent) }] }],
      system: FUSE_SYSTEM_PROMPT,
      maxTokens: MAX_OUTPUT_TOKENS,
      reasoningEffort: 'off',
      signal: controller.signal,
    })
    const { text, reasoning, finish } = await collectText(stream, controller.signal)
    if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
      throw new Error(`模型调用失败: ${finish.failure?.message ?? String(finish.kind)}`)
    }
    if (finish && finish.kind === 'max-tokens') {
      throw new Error('模型输出超出 token 上限，请减少内容后重试')
    }
    const fused = stripFence(text.trim() !== '' ? text : reasoning)
    if (fused === '') throw new Error('模型返回了空内容')
    return fused
  } finally {
    clearTimeout(timer)
  }
}

/** Read the request body and enforce the content contract shared by both writers. */
async function requireContent(request) {
  const body = await readJsonBody(request, MAX_BODY_BYTES)
  const content = body !== null && typeof body === 'object' ? body.content : undefined
  if (typeof content !== 'string') {
    throw Object.assign(new Error('content 必须是字符串'), { status: 400 })
  }
  return content
}

export function apply(ctx) {
  ctx.inject(['llm', 'agentDefaultModel', 'connection', 'workspaceRegistry'], (host) => {
    /** Register one fenced Fetch route on the Connection `/api` channel. */
    const route = (path, methods, fetch) => {
      host.effect(
        () => host.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }),
        `dsh-agents-md: ${path}`,
      )
    }
    const serializeWrite = serializeByTarget()

    // ── 1) 全局规则：读写 $DSH_HOME/AGENTS.md（否则 ~/.dsh/AGENTS.md）─────────
    route('/api/agents-md/global', ['GET', 'POST'], async (request) => {
      const file = globalRulesFile()
      try {
        if (request.method === 'GET') {
          const state = await readTextIfExists(file)
          return jsonResponse(200, { exists: state.exists, content: state.content, path: file })
        }
        const content = await requireContent(request)
        const backupPath = await serializeWrite(file, () => writeTextWithBackup(file, content))
        return jsonResponse(200, { ok: true, path: file, backupPath })
      } catch (error) {
        return failureResponse(error)
      }
    })

    // ── 2) 项目规则：读写 <工作区>/AGENTS.md ─────────────────────────────────
    route('/api/agents-md/project', ['GET', 'POST'], async (request) => {
      const resolved = resolveWorkspace(host, new URL(request.url))
      if (resolved.error !== undefined) return failureResponse(resolved.error)
      const { workspace, file } = resolved
      try {
        if (request.method === 'GET') {
          const state = await readTextIfExists(file)
          return jsonResponse(200, {
            exists: state.exists,
            content: state.content,
            path: file,
            workspace: workspace.path,
            file: 'AGENTS.md',
          })
        }
        const content = await requireContent(request)
        const backupPath = await serializeWrite(file, () => writeTextWithBackup(file, content))
        return jsonResponse(200, { ok: true, path: file, backupPath })
      } catch (error) {
        return failureResponse(error)
      }
    })

    // ── 3) 工作区列表 ───────────────────────────────────────────────────────
    route('/api/agents-md/workspaces', ['GET'], async () => {
      try {
        const workspaces = host.workspaceRegistry.list().map((workspace) => ({
          id: workspace.id,
          title: workspace.title,
          path: workspace.path,
        }))
        return jsonResponse(200, { workspaces })
      } catch (error) {
        return failureResponse(error)
      }
    })

    // ── 4) 模型目录 ─────────────────────────────────────────────────────────
    route('/api/agents-md/models', ['GET'], async () => {
      try {
        const catalog = []
        for (const provider of host.llm.listProviders()) {
          const models = await host.llm.listModels(provider.id)
          catalog.push({
            id: provider.id,
            name: provider.name,
            models: models.map((model) => ({ id: model.id, name: model.name })),
          })
        }
        const selection = host.agentDefaultModel.currentSelection()
        return jsonResponse(200, {
          providers: catalog,
          default: { provider: selection.provider, model: selection.model },
        })
      } catch (error) {
        return failureResponse(error)
      }
    })

    // ── 5) 生成内容：merge 调模型融合，overwrite 直接用用户内容；均不落盘 ────
    route('/api/agents-md/compose', ['POST'], async (request) => {
      let body
      try {
        body = await readJsonBody(request, MAX_BODY_BYTES)
      } catch (error) {
        return failureResponse(error)
      }
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
      const content = typeof body.content === 'string' ? body.content : ''
      const mode = body.mode === 'merge' ? 'merge' : 'overwrite'
      if (workspaceId === '' || content.trim() === '') {
        return jsonResponse(400, { error: 'workspaceId 与 content 均为必填' })
      }
      const workspace = host.workspaceRegistry.get(workspaceId)
      if (workspace === undefined) return jsonResponse(404, { error: '未知工作区' })
      const target = join(workspace.path, 'AGENTS.md')
      try {
        if (mode === 'overwrite') {
          return jsonResponse(200, { ok: true, mode, content, usedGlobal: false, model: null, path: target })
        }
        // merge：全局文件缺失或为空时降级为直接使用用户内容，不报错。
        const global = await readTextIfExists(globalRulesFile())
        const globalContent = global.content.trim()
        if (!global.exists || globalContent === '') {
          return jsonResponse(200, {
            ok: true,
            mode,
            content,
            usedGlobal: false,
            model: null,
            path: target,
            note: '全局 AGENTS.md 不存在或为空，已直接使用你输入的内容。',
          })
        }
        const fallback = host.agentDefaultModel.currentSelection()
        const selection = {
          provider: typeof body.provider === 'string' && body.provider !== '' ? body.provider : fallback.provider,
          model: typeof body.model === 'string' && body.model !== '' ? body.model : fallback.model,
        }
        const fused = await fuseWithGlobal(host, selection, globalContent, content)
        return jsonResponse(200, {
          ok: true,
          mode,
          content: fused,
          usedGlobal: true,
          model: selection,
          path: target,
        })
      } catch (error) {
        return failureResponse(error)
      }
    })
  })
}

/** Frame the two rule sources for the fusion call. */
function buildFusePrompt(globalContent, userContent) {
  return [
    '【全局规则（对所有项目生效）】',
    '```markdown',
    globalContent,
    '```',
    '',
    '【用户输入的项目级规则】',
    '```markdown',
    userContent,
    '```',
  ].join('\n')
}

const FUSE_SYSTEM_PROMPT = [
  '你是 DSH 的项目规则编辑器。用户会给你两份 Markdown：一份是全局规则（对所有项目生效），一份是用户为本项目写的规则。',
  '你的任务：把它们语义融合成【一份】可直接写入该项目根目录 AGENTS.md 的完整规则文档。',
  '',
  '融合要求：',
  '1. 保留全局规则中仍然有效的约束，不要丢弃；项目级规则与全局规则重复时只保留一份，表述取更具体的那个。',
  '2. 两者冲突时以项目级规则为准（项目更具体），并让表述自然衔接，不要出现"覆盖了全局的某条"这类说明文字。',
  '3. 按主题重新组织，合并同类项，层级用 Markdown 标题与列表；项目专属内容排在前面或单独成节。',
  '4. 只输出最终的 Markdown 正文本身：不要输出任何解释、前言、后记，不要用 ``` 代码围栏把整篇包起来。',
  '5. 不要编造原文中没有的规则。',
].join('\n')
