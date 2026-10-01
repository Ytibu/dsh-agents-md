# 参与贡献

感谢愿意帮忙。这个插件很小，贡献方式也很直接。

## 提 issue 之前

**先跑一次兼容性自检**：

```sh
node check-contracts.mjs
```

它会打印你的 DSH 版本，并逐项核对插件依赖的内部契约是否仍然存在。很多「插件坏了」其实是「DSH 版本对不上」，这一步能直接定位。请把完整输出一并贴在 issue 里。

## 兼容性是第一位

这个插件用的是 **DSH 内部契约**，不是稳定的公开 API。所以改代码时请守住两条：

1. **新增了对 DSH 内部契约的依赖** → 在 `check-contracts.mjs` 的 `CONTRACTS` 数组里加一条核对规则，并在 `README.md` 的兼容性表格里补一行。**这是插件最容易在 DSH 升级时静默失效的地方。**
2. **改了 Host 路由** → 同步更新 `test-smoke.mjs`（离线断言）与 `check-live.mjs`（运行态断言）。

## 本地验证

提交前请确认这三条都过：

```sh
node test-smoke.mjs        # 离线冒烟测试，60 项断言
node check-contracts.mjs   # 契约自检，退出码 0
node check-live.mjs        # 需要 dsh web 在跑；确认 /api 栅栏拒绝未鉴权请求
```

## 代码约定

- **不要引入运行时依赖。** Host 只用 node 内置模块，Client 只用 loader 提供的 react。
- Host 侧的路由**必须**用 `ctx.connection.fetch.register` 注册。不要在 `ctx.webServer` 上注册 `kind:'exact'` 的 `/api/...` 路由——那会遮蔽 Connection 的 `/api` 前缀栅栏，让接口失去鉴权（webServer 的匹配规则是「先查 exact 表，未命中再最长前缀」）。
- Client 侧是手写 `__ModuleLoader__` bundle，**零构建**：不要引入 JSX、TypeScript 或打包步骤。
- 输出、注释、文档用中文；变量名、文件名保持英文规范。

## 关于「让更多人看到」

插件列表和目录站大多按 GitHub 的 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 聚合，所以仓库的 **description 与 topics** 比代码里的任何东西都更影响被发现。改这些不需要动代码，但需要仓库写权限——如果你发现了新的聚合渠道，欢迎开 issue 告诉我。
