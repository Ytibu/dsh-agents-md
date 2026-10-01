# 故障排查

这里的每一条都是开发过程中**真实发生过**的问题，不是设想。按症状找即可。

先跑一次自检，它能区分掉一大半情况：

```sh
node check-contracts.mjs   # 你的 DSH 版本是否满足本插件依赖的内部契约
node check-live.mjs        # dsh web 在跑时：栅栏是否生效、client bundle 是否注入
```

---

## 设置里看不到「AGENTS.md 管理」入口

**最常见的原因是只加了 `dependencies`，没加 `bundles`。** 这两步缺一不可——本机那个 `dsh-rule-manager` 就是活例子：它在 `dependencies` 里但不在 `dsh.profile.bundles` 里，于是一直处于 disabled，从不出现。

排查顺序：

1. 确认 profile 的 `package.json` 里 `dsh.profile.bundles` 包含 `"dsh-agents-md"`
2. 确认 `node_modules/dsh-agents-md` 存在且内容正确
3. **重启 `dsh web`**，然后刷新页面

> 只改了 profile 的 `package.json` 时，配置监视通常会在运行中自动应用新的 bundle 层；但只要涉及插件模块本身，就必须重启。

## 改了源码但没生效

分两层看，很容易混淆：

| 层 | 行为 |
| --- | --- |
| 文件同步 | `file:` 依赖在 pnpm 的 hoisted linker 下是**硬链接**——原地编辑会自动跟随；新增/重命名文件，或用「写临时文件再 rename」的原子保存（会断硬链接）时，需要重新 `pnpm install` |
| 模块加载 | **必须重启 `dsh web`**。Client 半边会随页面刷新更新，Host 半边不会 |

只想确认 client 是否已经是最新字节，跑 `node check-live.mjs` 的第二部分。

## 页面报 401 / 「会话未通过鉴权」

**这是预期行为，不是故障。** 插件的接口受 DSH 的 Connection 鉴权栅栏保护，非浏览器会话（脚本、curl）访问会被 401 拒绝。

- 浏览器里遇到 → 刷新页面重新登录
- 用命令行测接口遇到 401 → 正常，栅栏在工作。想验证栅栏本身，用 `node check-live.mjs`

## 未鉴权也能读到全局规则内容（危险）

说明**运行中的进程还在执行修复前的 Host 模块**。这个缺陷在 1.0.0 已修复：早期实现用 `ctx.webServer.register` 注册 exact 的 `/api/...` 路由，而 webServer 的路由匹配是「先查 exact 表、未命中再最长前缀」，因此这些 exact 路由**遮蔽**了 Connection 的 `/api` 前缀栅栏。

处理：**重启 `dsh web`**，然后用 `node check-live.mjs` 确认。它会明确报出哪些路由泄露了。

> 顺带提醒：给这个插件加路由时**必须**用 `ctx.connection.fetch.register`，不要在 webServer 上注册 `/api/...`。

## 合并全局规则失败

- **模型没选对** → 在「生成项目规则」tab 重新选 provider / model 再试
- **内容太长** → 报「token 上限」时先精简输入
- **超时** → 模型调用上限 180 秒
- **不想调模型** → 选「直接覆盖」，它完全不走模型

## 提示「全局 AGENTS.md 不存在或为空，已直接使用你输入的内容」

不是错误，是降级：全局规则文件为空或不存在时，合并无从谈起，插件直接用你的输入。想走真正的合并，先到「全局规则」tab 保存一份内容。

## 模型调用报 413 / 400

- **413**：请求体超过 **256 KiB** 上限，精简内容
- **400**：请求体不是合法 JSON，属客户端问题

## 写入后出现 `AGENTS.md.bak-<时间戳>` 文件

这是**有意的备份**：写入前若目标已存在，会先备份，所以你永远不会一次覆盖掉旧规则。

同一毫秒内的连续或并发保存，备份名会自动追加 `-1`/`-2`…，不会互相覆盖。这些 `.bak-*` 文件不会被自动清理，确认不需要后自行删除（`.gitignore` 里已排除，不会误提交）。

## 并发保存报 EBUSY

1.0.0 之前在同一目标上并发写入会触发 Windows 的 `EBUSY: resource busy or locked`。现在写盘按目标文件串行化，正常不应该再出现。

若仍然遇到，说明运行的是旧模块——重启 `dsh web`。

## 换 DSH 版本后插件失效

本插件用的是 **DSH 内部契约**，不是稳定公开 API。升级 DSH 后请先跑：

```sh
node check-contracts.mjs
```

它会打印你的版本并逐项核对契约。非 0 退出说明有契约对不上——请提 issue 附上完整输出与版本号。

---

## 提 issue 前

请务必附上这两样，能直接省掉几轮来回：

1. 你的 DSH 版本
2. `node check-contracts.mjs` 的完整输出

仓库里的问题模板[（bug_report.md）](.github/ISSUE_TEMPLATE/bug_report.md)会把它们列成必填项。
