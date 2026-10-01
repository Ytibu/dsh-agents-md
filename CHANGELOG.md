# 更新日志

本文件记录每个版本的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-02

首个公开版本。仅适用于 **DSH `0.2.0-rc.2`**。

### 新增

- **编辑全局规则**：在设置面板读写全局 `AGENTS.md`，路径解析与 DSH 一致（优先 `$DSH_HOME`，否则 `~/.dsh`）
- **编辑项目规则**：读写所选工作区根目录的 `AGENTS.md`
- **生成项目规则**：由用户输入生成项目级 `AGENTS.md`，两种方式——
  - 「合并全局规则」：调用模型把用户输入与全局规则**语义融合**成一份文档
  - 「直接覆盖」：直接用用户输入生成，不参考全局规则
- 写入前**自动备份**为 `AGENTS.md.bak-<时间戳>`；生成过程先预览，确认后才落盘
- Host 的路由经 `ctx.connection.fetch.register` 注册，落在 Connection 的 `/api` 鉴权栅栏内
- 三个自检脚本：`test-smoke.mjs`、`check-contracts.mjs`、`check-live.mjs`

### 安全

- **修复了一个信息泄露缺陷**：早期实现用 `ctx.webServer.register` 注册 `kind:'exact'` 的 `/api/...`
  路由，而 webServer 的路由匹配是「先查 exact 表、未命中再最长前缀」，因此这些 exact 路由
  **遮蔽**了 Connection 的 `/api` 前缀栅栏——未鉴权的 `GET` 可以直接读到全局规则内容，且
  同源判断可被 DNS rebinding 满足。改用 `connection.fetch` 后由内核统一栅栏处理，
  未鉴权请求返回 401、跨站来源返回 403。
  这个缺陷是独立复验时发现并复现的，不是自测发现的。

### 修复

- **并发写会丢备份**：备份名原为 `AGENTS.md.bak-<时间戳>`，同一毫秒内的并发保存会互相覆盖
  （冻结时钟可稳定复现），并出现空备份与 Windows `EBUSY` 500。改为 `COPYFILE_EXCL` 原子占位
  并在重名时追加 `-1`/`-2`…，同时按目标文件串行化写入。
- 超限与坏 JSON 的状态码不再一律 500：请求体超过 256 KiB 返回 413，JSON 解析失败返回 400。
- 全局规则路由现在也回传 `backupPath`，与项目规则路由一致。
- Client 不再硬编码 `"\\AGENTS.md"` 拼接路径，改用响应中的真实 `path`（非 Windows 平台不再显示错误路径）。

### 说明

- 未发布到 npm，需按 README 的方式装进 profile
- 使用的是 DSH 内部契约而非稳定公开 API；升级 DSH 后请先运行 `node check-contracts.mjs`

[1.0.0]: https://github.com/Ytibu/dsh-agents-md/releases/tag/v1.0.0
