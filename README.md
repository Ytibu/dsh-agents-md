# dsh-agents-md

**给 DeepSeek Harness 加一个 AGENTS.md 的可视化编辑器。**

不用再手动找文件、手动复制粘贴——在设置面板里点几下，就能编辑和生成 `AGENTS.md`。

> 适用版本：**DSH 0.2.0-rc.2**（详见文末[兼容性](#兼容性)）

---

## 它解决什么问题

DSH 会读取 `AGENTS.md` 里的规则来决定怎么干活。但手动管理这些文件很麻烦：

| 你可能遇到的麻烦 | 这个插件怎么办 |
| --- | --- |
| 找不到全局规则文件在哪，路径记不住 | 设置里直接打开编辑，页面会显示解析到的真实路径 |
| 换个项目就要再找一遍项目规则文件 | 下拉选工作区，直接编辑该项目的 `AGENTS.md` |
| 想让项目规则「整体继承全局规则，再加上项目特有的要求」，只能手动复制粘贴 | 选「合并全局规则」，AI 帮你融合成一份完整规则 |
| 不小心把已有规则覆盖没了 | 写入前自动备份成 `AGENTS.md.bak-<时间戳>`，同一毫秒内的多次保存也不会互相覆盖 |

插件**不改变 DSH 的任何行为**，只是给这些文件加了一个好用的编辑界面。

## 三个功能

### 1. 编辑全局规则

读写全局规则文件——它对**所有项目**生效。

- 路径解析与 DSH 完全一致：优先 `$DSH_HOME/AGENTS.md`，没设置就用 `~/.dsh/AGENTS.md`
- 文件不存在时，保存会自动创建

### 2. 编辑项目规则

读写**指定项目**根目录下的 `AGENTS.md`。

- 从下拉列表选工作区，编辑它根目录的 `AGENTS.md`
- 同样支持自动创建与自动备份

### 3. 生成项目规则（这是最省事的一个）

你只需要**用大白话写下你想要的规则**，插件帮你生成规范的 `AGENTS.md`：

1. 选一个工作区
2. 写下你的要求，比如：

   ```
   这个项目必须用 pnpm，不要用 npm
   提交信息用中文
   改数据库前先写迁移脚本
   ```

3. 选一种生成方式（见下表）
4. **先预览，确认后才写入**——在你点「确认写入」之前，磁盘上不会有任何改动

| 生成方式 | 做什么 | 什么时候用 |
| --- | --- | --- |
| **合并全局规则** | 调 AI 把你的输入和全局 `AGENTS.md` **融合**成一份完整规则：保留全局里仍然有效的要求，重复的合并，冲突时以你的项目规则为准 | 想让项目既遵守全局约定，又有自己的额外要求 |
| **直接覆盖** | 直接用你的输入生成，不参考全局规则 | 这个项目完全独立，不需要继承全局 |

> 全局规则文件不存在或为空时，「合并全局规则」会直接使用你输入的内容，不会报错。

## 生效时机

保存后：

- **新会话**：立即生效
- **当前会话**：在下一次文件操作后感知到新规则

（由 DSH 内置的动态检测机制负责，插件本身不做热重载。）

---

## 安装

> 以下内容面向愿意动手的使用者。

装进任意 DSH profile（目录形如 `$DSH_HOME/profiles/<名字>`）需要两步。

**第一步**：在 profile 的 `package.json` 里加上依赖，然后在 profile 目录执行 `pnpm install`：

```json
"dsh-agents-md": "file:/绝对路径/to/dsh-agents-md"
```

> 目前只支持上面这种 `file:` 本地路径安装。插件没有发布到 npm，`github:` / npm 安装方式尚未验证可用。

**第二步**：在同一个 `package.json` 的 `dsh.profile.bundles` 数组里加上插件名：

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

> **只加 `dependencies` 不会让插件装载**——必须同时加进 `bundles`。

最后重启 `dsh web`，打开 **设置 → 「AGENTS.md 管理」**。

<details>
<summary>本地开发时怎么让改动生效</summary>

`file:` 依赖在 pnpm 的 hoisted linker 下是**硬链接**，因此：

- **原地编辑**已有文件会自动同步，不用重装
- **新增/重命名文件**，或用「写临时文件再 rename」的原子保存（会断硬链接）时，需要重新 `pnpm install`

想彻底避开这类不确定性，可以把 profile 里的目录换成指向源码的联接：

```powershell
Remove-Item "<profile>\node_modules\dsh-agents-md" -Recurse -Force
New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-agents-md" -Target "<源码目录>"
```

另外：同步的只是文件，**插件模块要重启 `dsh web` 才会重新加载**（Client 半边随页面刷新更新，Host 半边不会）。

</details>

## 兼容性

### 仅适用于 DSH `0.2.0-rc.2`

| 项 | 值 |
| --- | --- |
| 开发与测试所依据的 DSH 版本 | **0.2.0-rc.2** |
| 对应应用包 | `@deepseek-ai/dsh-desktop` / `@deepseek-ai/dsh-desktop-runtime` `0.2.0-rc.2` |
| 分发渠道 | nightly |

**本插件用的是 DSH 内部契约，不是稳定的公开 API。** 版本一变，下列接口可能改名或消失，插件会随之失效（通常表现为设置页入口消失，或路由 404）：

`ctx.connection.fetch.register` · `ctx.workspaceRegistry` · `ctx.llm.stream` · `ctx.agentDefaultModel.currentSelection` · `slots` 服务与 `settings.section` 槽位 · `window.__ModuleLoader__.load`

**换 DSH 版本后请先跑一次自检**：

```sh
node check-contracts.mjs
```

它直接读你本机安装的 DSH 源码，打印你的版本并逐项核对上述契约；退出码 `0` 表示兼容。**你的版本与 `0.2.0-rc.2` 不一致时，这个脚本的结论比本文档更可信。**

## 常见问题

**设置里看不到「AGENTS.md 管理」入口？**
确认插件已加进 `dsh.profile.bundles`，然后重启 `dsh web` 并刷新页面。

**页面提示 401 / 会话未通过鉴权？**
刷新页面重新登录即可。插件的接口受 DSH 鉴权保护，非浏览器会话访问会被拒绝——这是预期行为。

**「合并全局规则」失败了？**
重新选一下模型再试；内容过长时先精简。

---

## 给开发者

<details>
<summary>工作原理与自检脚本</summary>

**Host**（`lib/index.js`）用 `ctx.connection.fetch.register` 注册 5 条 Fetch 路由，挂在 Connection 的 `/api` 通道上——因此自动落进 Host/Origin 栅栏与浏览器鉴权：

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/api/agents-md/global` | GET / POST | 读 / 写全局 `AGENTS.md` |
| `/api/agents-md/project?workspace=<id>` | GET / POST | 读 / 写 `<工作区>/AGENTS.md` |
| `/api/agents-md/compose` | POST | 生成内容，**不落盘** |
| `/api/agents-md/workspaces` | GET | 工作区列表 |
| `/api/agents-md/models` | GET | 模型目录 |

> 必须走 `connection.fetch`：若改用 `ctx.webServer.register` 注册 `kind:'exact'` 的 `/api/...` 路由，会**遮蔽** Connection 的 `/api` 前缀栅栏（webServer 的路由匹配是「先查 exact 表，未命中再最长前缀」），使只读接口失去鉴权。

**Client**（`lib/client.js`）是手写 `__ModuleLoader__.load` bundle，注册 `settings.section` 槽位，零构建。

**自检脚本**

```sh
node test-smoke.mjs        # 离线冒烟测试（60 项断言，不需要运行中的 DSH）
node check-contracts.mjs   # 兼容性自检：核对本机 DSH 是否满足所依赖的契约
node check-live.mjs        # 运行态自检：确认 /api 栅栏真的拒绝未鉴权请求
```

**目录结构**

```
dsh-agents-md/
├── cordis.patch.yml      # bundle patch：插入插件层
├── package.json          # 含 dsh.compat（记录测试版本与依赖契约）
├── lib/
│   ├── index.js          # Host：5 条 connection.fetch 路由
│   └── client.js         # Client：手写 __ModuleLoader__ bundle
├── test-smoke.mjs        # 离线冒烟测试
├── check-contracts.mjs   # 兼容性自检
└── check-live.mjs        # 运行态自检
```

</details>

## 参与贡献

欢迎贡献。**提 issue 请务必附上你的 DSH 版本和 `node check-contracts.mjs` 的完整输出**——这两样能直接区分「版本不兼容」还是「代码有问题」。仓库里有[问题模板](.github/ISSUE_TEMPLATE/bug_report.md)会提醒你填。

改动代码前请读一下 [CONTRIBUTING.md](CONTRIBUTING.md)，重点只有一条：**新增对 DSH 内部契约的依赖时，要同步更新 `check-contracts.mjs` 和本文档的兼容性表格**——这是插件最容易在 DSH 升级时静默失效的地方。

## License

[MIT](LICENSE)
