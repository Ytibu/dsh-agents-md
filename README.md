# dsh-agents-md

在 DeepSeek Harness Web 的设置面板里管理 `AGENTS.md` 的插件。

三个功能点：

- **编辑全局规则**：读写用户级全局规则文件（路径解析与 harness 一致：非空 `$DSH_HOME` 优先，否则 `~/.dsh/AGENTS.md`）
- **编辑项目规则**：读写所选工作区根目录下的 `AGENTS.md`
- **生成项目规则**：输入规则要点，选「合并全局规则」或「直接覆盖」生成项目级 `AGENTS.md`，预览确认后才写入

零构建：Host 端为纯 Node ESM（只用 node 内置模块，无运行时依赖），Client 端为手写 `__ModuleLoader__` bundle，由 loader 提供 react。

## 兼容性 / Compatibility

> ### 仅适用于 DSH `0.2.0-rc.2`
>
> | 项 | 值 |
> | --- | --- |
> | 开发与测试所依据的 DSH 版本 | **0.2.0-rc.2** |
> | 对应应用包 | `@deepseek-ai/dsh-desktop` / `@deepseek-ai/dsh-desktop-runtime` `0.2.0-rc.2` |
> | 分发渠道 | nightly |
> | 随应用一起分发的 DSH 内部包 | 均为 `0.2.0-rc.2` |
>
> **本插件用的是 DSH 内部契约，不是稳定的公开 API。** DSH 版本一变，下列接口可能改名、改签名或消失，插件会随之失效（通常表现为设置页入口消失，或路由 404）：
>
> | 依赖的契约 | 用途 |
> | --- | --- |
> | `ctx.connection.fetch.register({path, methods, requestBody, fetch})` | Host 的 5 条路由，挂在 `/api` 鉴权栅栏内 |
> | `ctx.workspaceRegistry.list()` / `.get(id)` | 工作区列表与工作区根目录 |
> | `ctx.llm.stream()` / `listProviders()` / `listModels()` | 「合并」调用模型做语义融合 |
> | `ctx.agentDefaultModel.currentSelection()` | merge 的默认 provider / model |
> | Client 的 `slots` 服务与 `settings.section` 槽位 | 设置页入口 |
> | `window.__ModuleLoader__.load({id, factory})` | Client bundle 的装载形式 |
>
> **换 DSH 版本后请先跑一次自检**：
>
> ```sh
> node check-contracts.mjs
> ```
>
> 它直接读你本机安装的 DSH（`app.asar`）源码，打印你的 DSH 版本，再逐项核对上表契约是否仍然存在；退出码 `0` 表示兼容，非 `0` 会指出是哪一项丢了。**当你的版本与 `0.2.0-rc.2` 不一致时，这个脚本的结论比本文档更可信**——脚本按你的实际安装判断，本文档只记录作者测过的那个版本。

## 安装 / Install

装进任意 profile（profile 目录形如 `$DSH_HOME/profiles/<name>`，本机为 `C:\Users\dar06\.dsh\profiles\desktop`）需要两步。

### 1. 让 profile 能找到这个包

在 profile 的 `package.json` 的 `dependencies` 里指向本插件源码目录：

```json
"dsh-agents-md": "file:/绝对路径/to/dsh-agents-md"
```

本机实际写法：

```json
"dsh-agents-md": "file:E:\\workSpace\\myProject\\agents-to-more"
```

然后在 profile 目录执行 `pnpm install`。

> **关于 `file:` 依赖的同步行为（实测，别记错）。** 本机 profile 用的是 hoisted linker，`node_modules\dsh-agents-md` 是一个 **Junction**，指向 `.pnpm` 下的实体目录，而 `.pnpm` 里的文件与源码是**同一 inode 的硬链接**。因此：
>
> - **原地编辑**已有文件（`lib/index.js` 等）会自动同步到 profile，不需要重装；
> - 但**新增/重命名文件**，或编辑器用「写临时文件再 rename」的原子保存（会断掉硬链接）时，副本不会跟随 —— 这种情况要重新 `pnpm install`。
>
> 想彻底避开这类不确定性，可以直接把 profile 里的目录换成指向源码的联接：
>
> ```powershell
> Remove-Item "<profile>\node_modules\dsh-agents-md" -Recurse -Force
> New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-agents-md" -Target "E:\workSpace\myProject\agents-to-more"
> ```
>
> 另外：同步的只是文件；**插件模块本身要重启 `dsh web` 才会重新加载**（Client 半边随页面刷新更新，Host 半边不会）。

### 2. 把插件登记为 bundle（必须）

同一个 `package.json` 的 `dsh.profile.bundles` 数组里加上 `"dsh-agents-md"`：

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-agents-md"
    ]
  }
}
```

> **只写 `dependencies` 不会让插件装载。** 本机已装的 `dsh-rule-manager` 就是这种情况——它在 `dependencies` 里却不在 `dsh.profile.bundles` 里，因此一直处于 disabled。

改完 profile 的 `package.json` 后，profile 的配置监视会在运行中自动应用新的 bundle 层；若设置页看不到入口，重启 `dsh web` 并刷新页面。

## 使用 / Usage

打开 **设置 → 「AGENTS.md 管理」**，共三个 tab：

| Tab | 作用 |
| --- | --- |
| 全局规则 | 读写全局 `AGENTS.md`（解析到的绝对路径会显示在页面上） |
| 项目规则 | 读写所选工作区根目录下的 `AGENTS.md` |
| 生成项目规则 | 输入规则要点 → 选生成方式与生成模型 → 预览 → 确认写入 |

「项目规则」与「生成项目规则」需要先选择工作区；功能 2、3 写入的都是**工作区根目录**的 `AGENTS.md`。

「生成项目规则」的两种方式：

- **合并全局规则**：调用模型把你输入的内容与全局 `AGENTS.md` 语义融合成一份文档（保留全局规则中仍有效的约束、去重、冲突时以项目规则为准）；全局文件不存在或为空时直接使用你的输入，不报错。
- **直接覆盖**：直接用你输入的内容生成，不经过全局规则。

两种方式都是先出预览、确认后才落盘；写入时若目标 `AGENTS.md` 已存在，Host 会先自动备份为 `AGENTS.md.bak-<时间戳>`，所以覆盖模式不需要手动备份。备份名的占用是原子的（`COPYFILE_EXCL`，重名自动加 `-1`/`-2`…），且同一目标文件的写入按顺序串行执行，因此**同一毫秒内的连续或并发保存各自留一份备份，不会互相覆盖、也不会出现残缺备份**。

## 生效机制 / How it works

- **Host**（`lib/index.js`）用 `ctx.connection.fetch.register` 注册 5 条 Fetch 路由，**挂在 Connection 的 `/api` 通道上**——因此自动落进 Host/Origin 栅栏与浏览器鉴权，插件自己不再手写同源判断：

  | 路由 | 方法 | 作用 |
  | --- | --- | --- |
  | `/api/agents-md/global` | GET / POST | 读 / 写全局 `AGENTS.md` |
  | `/api/agents-md/project?workspace=<id>` | GET / POST | 读 / 写 `<工作区>/AGENTS.md` |
  | `/api/agents-md/compose` | POST | 生成内容（merge 调模型融合 / overwrite 直用输入），**不落盘** |
  | `/api/agents-md/workspaces` | GET | 工作区列表 |
  | `/api/agents-md/models` | GET | 模型目录 + 当前默认选择 |

  > 这里必须走 `connection.fetch`：如果改用 `ctx.webServer.register` 注册 `kind:'exact'` 的 `/api/...` 路由，会**遮蔽** Connection 的 `/api` 前缀栅栏（webServer 的路由匹配是「先查 exact 表，未命中再最长前缀」），使只读接口失去鉴权。`dsh-global-rules` 用的也是 `connection.fetch`。

- **Client**（`lib/client.js`）是手写 `__ModuleLoader__.load` bundle，注册 `settings.section`（id `agents-md`，标题「AGENTS.md 管理」）。
- `AGENTS.md` 的加载由 DSH 内置的 `dsh-agent-instructions` 负责，它会动态检测文件变化。
- 保存后：**新会话立即生效**；当前会话在**下一次文件操作后**感知变化并注入新规则。
- 插件自身不做热重载，也不缓存规则内容。

## 目录结构 / Structure

```
agents-to-more/
├── cordis.patch.yml      # bundle patch：插入 agents-md 层
├── package.json          # 含 dsh.compat（记录测试版本与依赖的契约）
├── README.md
├── LICENSE
├── lib/
│   ├── index.js          # Host：node ESM，5 条 connection.fetch 路由
│   └── client.js         # Client：手写 __ModuleLoader__ bundle（零构建）
├── test-smoke.mjs        # 离线冒烟测试（60 项）
├── check-contracts.mjs   # 兼容性自检：核对你的 DSH 版本是否满足契约
└── check-live.mjs        # 运行态自检：确认 /api 鉴权栅栏真的生效
```

## 开发 / Development

```sh
node test-smoke.mjs
```

离线冒烟测试，用假的 `ctx`/`host` 服务与真实临时目录跑通全部 5 条路由，不需要运行中的 DSH。覆盖范围：全局/项目读写、备份、同毫秒连续写与并发的备份完整性（各 6 份不丢不残缺）、merge 融合与降级、overwrite、256 KiB 上限、模型报错与 token 超限、工作区与模型目录。

```sh
node check-contracts.mjs     # 兼容性自检（读本机 app.asar，不需要启动 DSH）
node check-live.mjs          # 运行态自检，默认探测 http://127.0.0.1:19387
```

`check-contracts.mjs` 输出示例（本机实测）：

```
你的 DSH 版本: 0.2.0-rc.2  (@deepseek-ai/dsh-desktop)
本插件测试于  : 0.2.0-rc.2
  ✓ 与测试版本一致。

ok    @deepseek-ai/dsh-client-connection
ok    @deepseek-ai/dsh-host-webserver
...
结论：全部 9 项契约命中，client.inject 依赖齐备 —— 与你的 DSH 0.2.0-rc.2 兼容。
```

`check-live.mjs` 用来确认这 5 条路由真的落在 Connection 鉴权栅栏之内——未鉴权的裸请求应当被拒绝，而不是把全局规则内容或工作区路径返回给调用方。退出码 0 = 栅栏已生效，1 = 仍在跑旧模块（需要重启），2 = 连不上服务器。

> 为什么需要它：`lib/index.js` 的改动只有**重启 `dsh web`** 才会被重新加载。Client 半边随页面刷新更新，Host 半边不会。

## 贡献 / Contributing

**提 issue 请务必附上你的 DSH 版本**，以及 `node check-contracts.mjs` 的完整输出——这两样能直接定位「是版本不兼容还是代码有问题」：

```
DSH 版本：0.2.0-rc.2（或你的实际版本，可跑 check-contracts.mjs 得到）
运行平台：Windows 11 / macOS 15 / Ubuntu 24.04
现象：设置页看不到「AGENTS.md 管理」入口
check-contracts.mjs 输出：
  <把完整输出粘在这里>
```

改代码时的约定：

- 新增/改动 Host 路由后，同步更新 `test-smoke.mjs`（离线断言）与 `check-live.mjs`（运行态断言）；
- 如果新增了对 DSH 内部契约的依赖，在 `check-contracts.mjs` 的 `CONTRACTS` 数组里加一条，并在本文档的兼容性表格里补上——**这是这个插件最容易在 DSH 升级时静默失效的地方**；
- 不要引入运行时依赖；Host 只用 node 内置模块，Client 只用 loader 提供的 react。

## 故障排查 / Troubleshooting

- **设置里看不到入口**：确认 `dsh-agents-md` 已加入 profile 的 `dsh.profile.bundles`（只加 `dependencies` 不够，见上文 `dsh-rule-manager` 的例子）；然后重启 `dsh web` 并刷新页面。
- **改了源码但没生效**：分两种情况——Host 半边必须**重启 `dsh web`** 才会重新加载模块；文件层面的同步见上文 `file:` 依赖的说明（原地编辑会自动跟随，新增/重命名文件或原子保存需重新 `pnpm install`）。
- **页面报 401 / 「会话未通过鉴权」**：刷新页面重新登录；路由本身受 Connection 栅栏保护，非浏览器会话访问会被拒绝，属预期。
- **合并失败**：重新选择 provider/model 后重试；规则内容过长时先精简再生成。

## License

MIT
