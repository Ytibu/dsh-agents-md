/**
 * 契约自检：node check-contracts.mjs [DSH 安装目录]
 *
 * 本插件用的是 DSH **内部**契约，而不是公开的 npm 包 API。DSH 升级后这些契约可能改名或消失，
 * 那时插件会静默失效。这个脚本直接从你本机安装的 DSH（app.asar）里读源码，核对插件依赖的
 * 每一项契约是否仍然存在，并打印你的 DSH 版本。
 *
 * 用法：
 *   node check-contracts.mjs
 *   node check-contracts.mjs "C:\Users\you\AppData\Local\Programs\DeepSeek Harness"
 *   node check-contracts.mjs /Applications/DeepSeek\ Harness.app/Contents/Resources
 *
 * 退出码：0 = 全部命中；1 = 有契约缺失（版本可能不兼容）；2 = 找不到 app.asar / 读不出来。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import { fileURLToPath } from 'node:url'

const TESTED_ON = '0.2.0-rc.2'

/** 候选安装位置：显式参数优先，其次按平台猜常见路径。 */
function candidateRoots() {
  const roots = []
  const arg = process.argv[2]
  if (arg) roots.push(arg)
  if (platform() === 'win32') {
    roots.push(
      join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness'),
      'C:\\Program Files\\DeepSeek Harness',
    )
  } else if (platform() === 'darwin') {
    roots.push('/Applications/DeepSeek Harness.app/Contents', join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents'))
  } else {
    roots.push('/opt/DeepSeek Harness', join(homedir(), '.local', 'share', 'DeepSeek Harness'))
  }
  return roots
}

/** Locate resources/app.asar, searching the given root and its `resources` subdirectory. */
function findAsar(roots) {
  for (const root of roots) {
    for (const candidate of [join(root, 'resources', 'app.asar'), join(root, 'app.asar')]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Parse a minimal asar archive into { path, text() } entries. */
function openAsar(file) {
  const fd = readFileSync(file)
  if (fd.length < 16) throw new Error('文件太小，不是有效的 asar')
  const headerSize = fd.readUInt32LE(12)
  const header = JSON.parse(fd.subarray(16, 16 + headerSize).toString('utf8').replace(/\0+$/, ''))
  const baseOffset = 16 + headerSize
  const entries = []
  // asar 头里目录节点带 files 字典，文件节点带 offset/size。两个坑：①offset 是**字符串**
  // 不是数字；②头里存在 __proto__ 这样的键名，Object.entries 会丢键，必须用 Object.keys。
  const walk = (node, prefix) => {
    for (const name of Object.keys(node.files ?? {})) {
      const child = node.files[name]
      const path = `${prefix}/${name}`
      if (child.files !== undefined) walk(child, path)
      else if (child.offset !== undefined && child.unpacked !== true) {
        entries.push({ path, offset: Number(child.offset), size: child.size })
      }
    }
  }
  walk(header, '')
  return {
    entries,
    read(entry) {
      return fd.subarray(baseOffset + entry.offset, baseOffset + entry.offset + entry.size).toString('utf8')
    },
    find(path) {
      return entries.find((entry) => entry.path === path)
    },
  }
}

/**
 * 插件依赖的契约。`needle` 是必须出现在该包源码里的字面量。
 * 说明写的是「为什么插件离不开它」，方便升级后快速判断影响面。
 */
const CONTRACTS = [
  {
    why: 'Host 路由挂在 Connection 的 /api 栅栏内（否则只读接口会失去鉴权）',
    pkg: '@deepseek-ai/dsh-client-connection',
    needle: 'registerFetchRoute',
  },
  {
    why: 'webServer 的路由匹配必须是「先查 exact 表、未命中再最长前缀」（栅栏遮蔽风险评估依据）',
    pkg: '@deepseek-ai/dsh-host-webserver',
    needle: 'Longest-prefix-wins over the prefix table after an exact-table miss',
  },
  {
    why: 'workspaceRegistry.list() / get(id) 提供工作区与其根目录',
    pkg: '@deepseek-ai/dsh-workspace',
    needle: 'resolveByPath',
  },
  {
    why: 'llm.stream() 迭代 text-delta / reasoning-delta / finish 分片，用于「合并」调模型',
    pkg: '@deepseek-ai/dsh-llm',
    needle: 'text-delta',
  },
  {
    why: 'agentDefaultModel.currentSelection() 提供 merge 的默认 provider/model',
    pkg: '@deepseek-ai/dsh-agent-default-model',
    needle: 'currentSelection',
  },
  {
    why: 'Client 半边把设置页注册进 settings.section 槽位（该槽由设置面板渲染）',
    pkg: '@deepseek-ai/dsh-client-ui-settings-general',
    needle: 'settings.section',
  },
  {
    why: 'Client 半边持有的 slots 服务与 register/inject API',
    pkg: '@deepseek-ai/dsh-client-ui-settings-general',
    needle: 'ctx.slots',
  },
  {
    why: 'global AGENTS.md 的路径解析规则（非空 $DSH_HOME 优先，否则 ~/.dsh）',
    pkg: '@deepseek-ai/dsh-home-paths',
    needle: 'DSH_HOME',
  },
  {
    why: 'AGENTS.md 的动态加载与热检测由它负责，插件依赖它生效',
    pkg: '@deepseek-ai/dsh-agent-instructions',
    needle: 'AGENTS.md',
  },
]

const asarPath = findAsar(candidateRoots())
if (asarPath === null) {
  console.error('找不到 app.asar。请把 DSH 安装目录作为参数传入，例如：')
  console.error('  node check-contracts.mjs "C:\\Users\\you\\AppData\\Local\\Programs\\DeepSeek Harness"')
  process.exit(2)
}

let asar
try {
  asar = openAsar(asarPath)
} catch (error) {
  console.error(`读取 app.asar 失败: ${error.message}`)
  process.exit(2)
}

console.log(`app.asar: ${asarPath}`)
console.log(`文件大小: ${(statSync(asarPath).size / 1024 / 1024).toFixed(1)} MiB\n`)

// 版本：以随应用分发的桌面运行时包为准。
const pkgEntry = asar.find('/package.json')
const dshPkgEntry = asar.find('/dsh/package.json')
const appPkg = pkgEntry ? JSON.parse(asar.read(pkgEntry)) : null
const dshPkg = dshPkgEntry ? JSON.parse(asar.read(dshPkgEntry)) : null
const version = appPkg?.version ?? dshPkg?.version ?? '(未知)'
console.log(`你的 DSH 版本: ${version}${appPkg?.name ? `  (${appPkg.name})` : ''}`)
console.log(`本插件测试于  : ${TESTED_ON}`)
if (version !== TESTED_ON) {
  console.log('  ⚠ 版本与测试版本不一致 —— 下面的契约检查结果请重点看。')
} else {
  console.log('  ✓ 与测试版本一致。')
}
console.log('')

let missing = 0
let checked = 0

for (const contract of CONTRACTS) {
  const dir = `/dsh/node_modules/${contract.pkg}`
  const rows = asar.entries.filter((entry) => entry.path.startsWith(`${dir}/`) && entry.path.endsWith('.js'))
  if (rows.length === 0) {
    missing += 1
    console.log(`缺失  ${contract.pkg}`)
    console.log(`      该包在 app.asar 中不存在（${contract.why}）`)
    continue
  }
  checked += 1
  const hit = rows.some((row) => asar.read(row).includes(contract.needle))
  if (hit) {
    console.log(`ok    ${contract.pkg}`)
  } else {
    missing += 1
    console.log(`缺失  ${contract.pkg}`)
    console.log(`      源码中找不到 "${contract.needle}"（${contract.why}）`)
  }
}

// 顺带核对 client 清单里声明的包是否真实存在（曾经有个不存在的包名混进来过）。
console.log('')
const here = fileURLToPath(new URL('.', import.meta.url))
{
  const manifestPath = join(here, 'package.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const name of manifest.dsh?.client?.inject ?? []) {
      const exists = asar.entries.some((entry) => entry.path.startsWith(`/dsh/node_modules/${name}/`))
      console.log(`${exists ? 'ok   ' : '缺失 '} client.inject → ${name}`)
      if (!exists) missing += 1
    }
  }
}

console.log('')
if (missing > 0) {
  console.error(`结论：${missing} 项契约/依赖不匹配（已核对 ${checked} 项）—— 你的 DSH 版本可能不兼容本插件。`)
  console.error('请提 issue 附上上面的完整输出与该 DSH 版本号。')
  process.exit(1)
}

console.log(`结论：全部 ${checked} 项契约命中，client.inject 依赖齐备 —— 与你的 DSH ${version} 兼容。`)
