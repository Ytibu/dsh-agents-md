// dsh-agents-md client bundle: registers an "AGENTS.md 管理" settings section
// with three tabs — "全局规则" (edit the global AGENTS.md), "项目规则"
// (read/write <工作区>/AGENTS.md) and "生成项目规则" (compose a project
// AGENTS.md from free-form input, optionally fusing the global rules through a
// model, preview it, and only write to disk after an explicit confirmation).
//
// Host routes stay exactly as the Host half declares them:
//   GET/POST /api/agents-md/global
//   GET      /api/agents-md/workspaces
//   GET/POST /api/agents-md/project?workspace=<id>
//   GET      /api/agents-md/models
//   POST     /api/agents-md/compose
//
// Hand-written __ModuleLoader__ factory (no build step). The only external
// require is react, which the loader module table provides.
window.__ModuleLoader__.load({ id: "dsh-agents-md", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	let react = require("react");
	const h = react.createElement;
	const { useState, useEffect, useCallback } = react;

	const name = "agents-md";
	const inject = ["slots"];

	const SAVED_HINT = "新会话立即生效；当前会话将在下一次文件操作后感知新规则。";

	const TEXTAREA_STYLE = {
		width: "100%",
		minHeight: "300px",
		boxSizing: "border-box",
		fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
		fontSize: "13px",
		lineHeight: 1.5,
		padding: "10px",
		background: "transparent",
		color: "inherit",
		border: "1px solid rgba(128, 128, 128, 0.35)",
		borderRadius: "6px",
		resize: "vertical",
	};

	const ROW_STYLE = {
		display: "flex",
		alignItems: "center",
		gap: "10px",
		marginTop: "10px",
		flexWrap: "wrap",
	};

	const SELECT_STYLE = {
		padding: "6px 10px",
		borderRadius: "6px",
		border: "1px solid rgba(128, 128, 128, 0.35)",
		background: "transparent",
		color: "inherit",
		fontSize: "13px",
		maxWidth: "420px",
		width: "100%",
		boxSizing: "border-box",
	};

	const BUTTON_STYLE = {
		padding: "6px 16px",
		borderRadius: "6px",
		border: "none",
		cursor: "pointer",
		fontSize: "13px",
	};

	const PRIMARY_BUTTON_STYLE = Object.assign({}, BUTTON_STYLE, {
		background: "var(--accent, #2f81f7)",
		color: "#fff",
	});

	const TAB_BAR_STYLE = {
		display: "flex",
		gap: "6px",
		marginBottom: "14px",
		borderBottom: "1px solid rgba(128, 128, 128, 0.25)",
		paddingBottom: "8px",
	};

	const TAB_STYLE = {
		padding: "6px 16px",
		borderRadius: "6px",
		border: "1px solid transparent",
		cursor: "pointer",
		fontSize: "13px",
		background: "transparent",
		color: "inherit",
		opacity: 0.65,
	};

	const TAB_ACTIVE_STYLE = Object.assign({}, TAB_STYLE, {
		opacity: 1,
		border: "1px solid rgba(128, 128, 128, 0.35)",
		background: "rgba(128, 128, 128, 0.12)",
	});

	const HINT_STYLE = { fontSize: "13px", opacity: 0.75 };

	const RESULT_BOX_STYLE = {
		marginTop: "12px",
		padding: "10px 12px",
		borderRadius: "6px",
		border: "1px solid rgba(128, 128, 128, 0.25)",
		fontSize: "13px",
		lineHeight: 1.6,
	};

	const PRE_STYLE = {
		fontSize: "12px",
		lineHeight: 1.5,
		margin: "8px 0 0",
		padding: "8px 10px",
		whiteSpace: "pre-wrap",
		wordBreak: "break-word",
		opacity: 0.88,
		background: "rgba(128,128,128,0.08)",
		borderRadius: "6px",
		maxHeight: "320px",
		overflowY: "auto",
	};

	/** Panel-facing failure text: an expired session needs a refresh, not a status code. */
	function failureMessage(res) {
		if (res.status === 401 || res.status === 403) {
			return "会话未通过鉴权，请刷新页面后重试";
		}
		return "HTTP " + res.status;
	}

	/** Parse a JSON response, turning any non-2xx status into a readable error. */
	function readJson(res) {
		return res.json().catch(() => ({})).then((data) => {
			if (!res.ok) throw new Error((data && data.error) || failureMessage(res));
			return data;
		});
	}

	function WorkspaceSelect({ workspaces, selectedId, onChange, disabled }) {
		return h("select", {
			style: SELECT_STYLE,
			value: selectedId,
			onChange: (event) => onChange(event.target.value),
			disabled: disabled || workspaces.length === 0,
		},
			workspaces.length === 0
				? h("option", { value: "" }, "暂无可用的工作区")
				: workspaces.map((ws) => h("option", { key: ws.id, value: ws.id },
					ws.title + "  (" + ws.path + ")")),
		);
	}

	// ── Tab 1: 全局规则 ─────────────────────────────────────────────────────
	function GlobalRulesTab() {
		const [content, setContent] = useState("");
		const [loaded, setLoaded] = useState(false);
		const [exists, setExists] = useState(true);
		const [pathLabel, setPathLabel] = useState("");
		const [saving, setSaving] = useState(false);
		const [notice, setNotice] = useState({ kind: "idle", text: "" });

		useEffect(() => {
			let cancelled = false;
			fetch("/api/agents-md/global", { cache: "no-store" })
				.then(readJson)
				.then((data) => {
					if (cancelled) return;
					setContent(String(data.content || ""));
					setExists(Boolean(data.exists));
					setPathLabel(String(data.path || ""));
					setLoaded(true);
				})
				.catch((error) => {
					if (cancelled) return;
					setNotice({ kind: "error", text: "读取失败: " + error.message });
					setLoaded(true);
				});
			return () => { cancelled = true; };
		}, []);

		const save = useCallback(() => {
			setSaving(true);
			setNotice({ kind: "idle", text: "" });
			fetch("/api/agents-md/global", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content }),
			})
				.then(readJson)
				.then(() => {
					setExists(true);
					setNotice({
						kind: "ok",
						text: "已写入 " + (pathLabel || "全局 AGENTS.md") + "。" + SAVED_HINT,
					});
				})
				.catch((error) => {
					setNotice({ kind: "error", text: "保存失败: " + error.message });
				})
				.finally(() => setSaving(false));
		}, [content, pathLabel]);

		return h("div", null,
			h("p", { style: Object.assign({}, HINT_STYLE, { marginTop: 0 }) },
				"全局 AGENTS.md 对每个会话生效。保存后写入上面这个路径。"),
			pathLabel !== "" ? h("p", { style: { opacity: 0.6, fontSize: "12px", margin: "0 0 6px" } },
				"路径：" + pathLabel) : null,
			exists ? null : h("p", { style: HINT_STYLE }, "文件尚不存在，保存将创建它。"),
			!loaded ? h("p", { style: { opacity: 0.6 } }, "加载中…") : h("textarea", {
				style: TEXTAREA_STYLE,
				value: content,
				onChange: (event) => setContent(event.target.value),
				spellCheck: false,
				placeholder: "# 全局规则\n\n在这里编写对每个会话生效的指令…",
			}),
			h("div", { style: ROW_STYLE },
				h("button", {
					style: Object.assign({}, PRIMARY_BUTTON_STYLE, { opacity: saving ? 0.6 : 1 }),
					disabled: saving,
					onClick: save,
				}, saving ? "保存中…" : "保存"),
				notice.kind === "ok" ? h("span", { style: HINT_STYLE }, notice.text)
					: notice.kind === "error" ? h("span", { style: { fontSize: "13px", color: "#e5484d" } }, notice.text)
					: null,
			),
		);
	}

	// ── Tab 2: 项目规则（<工作区>/AGENTS.md）────────────────────────────────
	function ProjectRulesTab({ workspaces }) {
		const [selectedId, setSelectedId] = useState("");
		const [content, setContent] = useState("");
		const [loaded, setLoaded] = useState(false);
		const [exists, setExists] = useState(true);
		const [pathLabel, setPathLabel] = useState("");
		const [saving, setSaving] = useState(false);
		const [notice, setNotice] = useState({ kind: "idle", text: "" });

		useEffect(() => {
			if (workspaces.length > 0 && selectedId === "") setSelectedId(workspaces[0].id);
		}, [workspaces, selectedId]);

		useEffect(() => {
			if (selectedId === "") return;
			let cancelled = false;
			setLoaded(false);
			setNotice({ kind: "idle", text: "" });
			fetch("/api/agents-md/project?workspace=" + encodeURIComponent(selectedId), { cache: "no-store" })
				.then(readJson)
				.then((data) => {
					if (cancelled) return;
					setContent(String(data.content || ""));
					setExists(Boolean(data.exists));
					setPathLabel(String(data.path || ""));
					setLoaded(true);
				})
				.catch((error) => {
					if (cancelled) return;
					setNotice({ kind: "error", text: "读取失败: " + error.message });
					setLoaded(true);
				});
			return () => { cancelled = true; };
		}, [selectedId]);

		const save = useCallback(() => {
			if (selectedId === "") {
				setNotice({ kind: "error", text: "请先选择一个工作区" });
				return;
			}
			setSaving(true);
			setNotice({ kind: "idle", text: "" });
			fetch("/api/agents-md/project?workspace=" + encodeURIComponent(selectedId), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content }),
			})
				.then(readJson)
				.then((data) => {
					setExists(true);
					setNotice({
						kind: "ok",
						text: "已写入 " + (data.path || pathLabel || "工作区 AGENTS.md") + "。"
							+ (data.backupPath ? "原文件已备份为 " + data.backupPath + "。" : "")
							+ SAVED_HINT,
					});
				})
				.catch((error) => {
					setNotice({ kind: "error", text: "保存失败: " + error.message });
				})
				.finally(() => setSaving(false));
		}, [content, selectedId, pathLabel, workspaces]);

		return h("div", null,
			h("p", { style: Object.assign({}, HINT_STYLE, { marginTop: 0 }) },
				"编辑所选工作区根目录下的 AGENTS.md，只对该工作区（及其子目录）生效；原文件存在时保存会先自动备份。"),
			h("div", { style: ROW_STYLE },
				h(WorkspaceSelect, { workspaces, selectedId, onChange: setSelectedId }),
			),
			pathLabel !== "" ? h("p", { style: { opacity: 0.6, fontSize: "12px", margin: "4px 0 6px" } },
				"路径：" + pathLabel) : null,
			exists ? null : h("p", { style: HINT_STYLE }, "文件尚不存在，保存将创建它。"),
			!loaded ? h("p", { style: { opacity: 0.6 } }, "加载中…") : h("textarea", {
				style: TEXTAREA_STYLE,
				value: content,
				onChange: (event) => setContent(event.target.value),
				spellCheck: false,
				placeholder: "# 项目规则\n\n在这里编写对该工作区生效的指令…",
			}),
			h("div", { style: ROW_STYLE },
				h("button", {
					style: Object.assign({}, PRIMARY_BUTTON_STYLE, { opacity: saving ? 0.6 : 1 }),
					disabled: saving || selectedId === "",
					onClick: save,
				}, saving ? "保存中…" : "保存"),
				notice.kind === "ok" ? h("span", { style: HINT_STYLE }, notice.text)
					: notice.kind === "error" ? h("span", { style: { fontSize: "13px", color: "#e5484d" } }, notice.text)
					: null,
			),
		);
	}

	// ── Tab 3: 生成项目规则（compose → 预览 → 确认写入）─────────────────────
	function ComposeTab({ workspaces }) {
		const [selectedId, setSelectedId] = useState("");
		const [input, setInput] = useState("");
		const [mode, setMode] = useState("merge");
		const [catalog, setCatalog] = useState([]);
		const [selectedProvider, setSelectedProvider] = useState("");
		const [selectedModel, setSelectedModel] = useState("");
		const [generating, setGenerating] = useState(false);
		const [preview, setPreview] = useState(null);
		const [expanded, setExpanded] = useState(true);
		const [writing, setWriting] = useState(false);
		const [written, setWritten] = useState(false);
		const [notice, setNotice] = useState({ kind: "idle", text: "" });

		// 模型目录只需加载一次，默认选中 Host 报告的 default provider/model。
		useEffect(() => {
			let cancelled = false;
			fetch("/api/agents-md/models", { cache: "no-store" })
				.then(readJson)
				.then((data) => {
					if (cancelled) return;
					setCatalog(Array.isArray(data.providers) ? data.providers : []);
					const fallback = data.default || {};
					setSelectedProvider(String(fallback.provider || ""));
					setSelectedModel(String(fallback.model || ""));
				})
				.catch((error) => {
					if (cancelled) return;
					setNotice({ kind: "error", text: "模型列表加载失败: " + error.message });
				});
			return () => { cancelled = true; };
		}, []);

		useEffect(() => {
			if (workspaces.length > 0 && selectedId === "") setSelectedId(workspaces[0].id);
		}, [workspaces, selectedId]);

		const providerModels = catalog.find((p) => p.id === selectedProvider)?.models || [];
		const changeProvider = useCallback((providerId) => {
			setSelectedProvider(providerId);
			const models = catalog.find((p) => p.id === providerId)?.models || [];
			setSelectedModel(models.length > 0 ? models[0].id : "");
		}, [catalog]);

		// 生成只调用 compose，不落盘；预览确认后才写文件。
		const generate = useCallback(() => {
			if (selectedId === "") {
				setNotice({ kind: "error", text: "请先选择一个工作区" });
				return;
			}
			if (input.trim() === "") {
				setNotice({ kind: "error", text: "请先输入要生成的内容" });
				return;
			}
			setGenerating(true);
			setPreview(null);
			setWritten(false);
			setNotice({
				kind: "idle",
				text: mode === "merge"
					? "正在调用模型融合全局规则，请稍候（最多 3 分钟）…"
					: "正在生成项目规则，请稍候…",
			});
			fetch("/api/agents-md/compose", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					workspaceId: selectedId,
					content: input,
					mode,
					provider: selectedProvider,
					model: selectedModel,
				}),
			})
				.then(readJson)
				.then((data) => {
					setPreview({
						content: String(data.content || ""),
						mode: data.mode || mode,
						usedGlobal: Boolean(data.usedGlobal),
						model: data.model || null,
						path: String(data.path || ""),
					});
					setExpanded(true);
					setNotice({
						kind: "ok",
						text: "生成完成（"
							+ (data.model ? data.model.provider + "/" + data.model.model : "未调用模型")
							+ "，" + (data.usedGlobal ? "已融合全局规则" : "未使用全局规则")
							+ "）。请先预览确认，再点击「确认写入」落盘；确认前不会改动磁盘上的文件。",
					});
				})
				.catch((error) => {
					setNotice({ kind: "error", text: "生成失败: " + error.message });
				})
				.finally(() => setGenerating(false));
		}, [selectedId, input, mode, selectedProvider, selectedModel]);

		const confirmWrite = useCallback(() => {
			if (preview === null || written) return;
			setWriting(true);
			setNotice({ kind: "idle", text: "正在写入文件…" });
			fetch("/api/agents-md/project?workspace=" + encodeURIComponent(selectedId), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: preview.content }),
			})
				.then(readJson)
				.then((data) => {
					setWritten(true);
					setNotice({
						kind: "ok",
						text: "已写入 " + (data.path || "工作区 AGENTS.md") + "。"
							+ (data.backupPath ? "原文件已备份为 " + data.backupPath + "。" : "")
							+ SAVED_HINT,
					});
				})
				.catch((error) => {
					setNotice({ kind: "error", text: "写入失败: " + error.message });
				})
				.finally(() => setWriting(false));
		}, [preview, written, selectedId]);

		const canWrite = preview !== null && preview.content.trim() !== "" && !written && !writing;

		return h("div", null,
			h("p", { style: Object.assign({}, HINT_STYLE, { marginTop: 0 }) },
				"输入你的项目规则要点，选一种生成方式，由模型产出可直接使用的项目级 AGENTS.md，预览确认后再写入工作区根目录 AGENTS.md。"),
			h("p", { style: Object.assign({}, HINT_STYLE, { marginTop: "6px" }) },
				"「合并全局规则」：把全局 AGENTS.md 与你输入的内容做语义融合（调用模型），结果写入工作区根目录 AGENTS.md。"),
			h("p", { style: Object.assign({}, HINT_STYLE, { marginTop: "4px" }) },
				"「直接覆盖」：直接用你输入的内容生成项目级 AGENTS.md，不经过全局规则；原文件若存在会被替换（自动备份）。"),
			h("div", { style: ROW_STYLE },
				h(WorkspaceSelect, { workspaces, selectedId, onChange: setSelectedId, disabled: generating }),
			),
			h("div", { style: ROW_STYLE },
				h("label", { style: { fontSize: "13px", opacity: 0.85 } }, "生成模型："),
				h("select", {
					style: SELECT_STYLE,
					value: selectedProvider,
					onChange: (event) => changeProvider(event.target.value),
					disabled: catalog.length === 0 || generating,
				},
					catalog.length === 0
						? h("option", { value: "" }, "加载模型中…")
						: catalog.map((p) => h("option", { key: p.id, value: p.id }, p.name))),
				providerModels.length > 0 ? h("select", {
					style: Object.assign({}, SELECT_STYLE, { maxWidth: "260px" }),
					value: selectedModel,
					onChange: (event) => setSelectedModel(event.target.value),
					disabled: generating,
				},
					providerModels.map((m) => h("option", { key: m.id, value: m.id }, m.name)),
				) : null,
			),
			h("div", { style: Object.assign({}, ROW_STYLE, { marginTop: "10px" }) },
				h("label", { style: { fontSize: "13px", opacity: 0.85 } }, "生成方式："),
				h("button", {
					style: Object.assign({}, BUTTON_STYLE, {
						background: "transparent",
						color: "inherit",
						border: mode === "merge" ? "1px solid var(--accent, #2f81f7)" : "1px solid rgba(128,128,128,0.35)",
						opacity: mode === "merge" ? 1 : 0.65,
					}),
					disabled: generating,
					onClick: () => setMode("merge"),
				}, "合并全局规则"),
				h("button", {
					style: Object.assign({}, BUTTON_STYLE, {
						background: "transparent",
						color: "inherit",
						border: mode === "overwrite" ? "1px solid var(--accent, #2f81f7)" : "1px solid rgba(128,128,128,0.35)",
						opacity: mode === "overwrite" ? 1 : 0.65,
					}),
					disabled: generating,
					onClick: () => setMode("overwrite"),
				}, "直接覆盖"),
			),
			h("textarea", {
				style: TEXTAREA_STYLE,
				value: input,
				onChange: (event) => setInput(event.target.value),
				spellCheck: false,
				disabled: generating,
				placeholder: "# 项目规则要点\n\n例如：\n- 本仓库是 TypeScript + React，组件放在 src/components…\n- 提交前必须跑 pnpm test…\n- 数据库迁移只允许新增，不得修改历史迁移…",
			}),
			h("div", { style: ROW_STYLE },
				h("button", {
					style: Object.assign({}, PRIMARY_BUTTON_STYLE, { opacity: generating ? 0.6 : 1 }),
					disabled: generating || selectedId === "",
					onClick: generate,
				}, generating ? "生成中…" : "生成"),
				notice.kind === "ok" ? h("span", { style: HINT_STYLE }, notice.text)
					: notice.kind === "error" ? h("span", { style: { fontSize: "13px", color: "#e5484d" } }, notice.text)
					: notice.text !== "" ? h("span", { style: { fontSize: "13px", opacity: 0.6 } }, notice.text)
					: null,
			),
			preview !== null ? h("div", { style: RESULT_BOX_STYLE },
				h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
					h("button", {
						style: {
							background: "transparent",
							border: "none",
							cursor: "pointer",
							color: "var(--accent, #2f81f7)",
							fontSize: "13px",
							padding: "2px 0",
							textAlign: "left",
						},
						onClick: () => setExpanded((prev) => !prev),
					}, (expanded ? "▾ " : "▸ ") + "预览：将要写入的 AGENTS.md（点击" + (expanded ? "折叠" : "展开") + "）"),
					h("span", { style: { fontSize: "12px", opacity: 0.7 } },
						"生成方式：" + (preview.mode === "merge" ? "合并全局规则" : "直接覆盖")),
					h("span", { style: { fontSize: "12px", opacity: 0.7 } },
						preview.usedGlobal ? "已使用全局规则" : "未使用全局规则"),
					preview.model ? h("span", { style: { fontSize: "12px", opacity: 0.7 } },
						"模型：" + preview.model.provider + "/" + preview.model.model) : null,
					preview.mode === "overwrite" ? h("span", { style: { fontSize: "12px", color: "#d29922", opacity: 0.9 } },
						"（写入时将覆盖原文件，自动备份）") : null,
				),
				expanded ? h("pre", { style: PRE_STYLE }, preview.content) : null,
				!expanded ? h("p", { style: { margin: "6px 0 0", fontSize: "12px", opacity: 0.6 } },
					"（已折叠，展开后查看生成的完整 markdown）") : null,
				written ? h("p", { style: { margin: "8px 0 0", fontSize: "13px", opacity: 0.85 } },
					"已确认写入，未再次落盘。") : h("div", { style: ROW_STYLE },
					h("button", {
						style: Object.assign({}, PRIMARY_BUTTON_STYLE, {
							opacity: canWrite ? 1 : 0.6,
						}),
						disabled: !canWrite,
						onClick: confirmWrite,
					}, writing ? "写入中…" : "确认写入"),
					h("span", { style: { fontSize: "12px", opacity: 0.65 } },
						"将写入：" + (preview.path || "工作区根目录 AGENTS.md")),
				),
			) : null,
		);
	}

	// ── Section shell: tab bar + 全局规则 / 项目规则 / 生成项目规则 ───────────
	function AgentsMdSection() {
		const [workspaces, setWorkspaces] = useState([]);
		const [tab, setTab] = useState("global");
		const [notice, setNotice] = useState({ kind: "idle", text: "" });

		// 「项目规则」与「生成项目规则」都需要工作区列表，挂载时统一加载。
		useEffect(() => {
			let cancelled = false;
			fetch("/api/agents-md/workspaces", { cache: "no-store" })
				.then(readJson)
				.then((data) => {
					if (cancelled) return;
					setWorkspaces(Array.isArray(data.workspaces) ? data.workspaces : []);
				})
				.catch((error) => {
					if (cancelled) return;
					setNotice({ kind: "error", text: "工作区列表加载失败: " + error.message });
				});
			return () => { cancelled = true; };
		}, []);

		return h("div", { style: { maxWidth: "760px" } },
			h("div", { style: TAB_BAR_STYLE },
				h("button", { style: tab === "global" ? TAB_ACTIVE_STYLE : TAB_STYLE, onClick: () => setTab("global") }, "全局规则"),
				h("button", { style: tab === "project" ? TAB_ACTIVE_STYLE : TAB_STYLE, onClick: () => setTab("project") }, "项目规则"),
				h("button", { style: tab === "compose" ? TAB_ACTIVE_STYLE : TAB_STYLE, onClick: () => setTab("compose") }, "生成项目规则"),
			),
			notice.kind === "error" ? h("p", { style: { fontSize: "13px", color: "#e5484d", marginTop: 0 } }, notice.text) : null,
			tab === "global"
				? h(GlobalRulesTab, null)
				: tab === "project"
					? h(ProjectRulesTab, { workspaces })
					: h(ComposeTab, { workspaces }),
		);
	}

	function apply(ctx) {
		ctx.slots.inject("settings.section", () => ctx.slots.register({
			name: "settings.section",
			id: "agents-md",
			order: 31,
			label: () => "AGENTS.md 管理",
		}, () => h(AgentsMdSection, null)));
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
}
});
