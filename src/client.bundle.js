/**
 * dsh-rich-indexing — client half.
 *
 * Hand-authored in the same __ModuleLoader__ facade format the rich plugin
 * family ships (window.__ModuleLoader__.load + factory(require)) — no build
 * step. Registers two slot contributions:
 *
 *  - `conversation.view` tab "Compaction" (the module sub-tab): live pressure
 *    vs the tier ladder, tier pointer, last compaction facts, model-chain
 *    health, Compact-now and Release actions.
 *  - `settings.plugin.item` card keyed `rich-indexing`: enabled, maxTokens,
 *    the tier table, and the model chain editor (provider/model/effort per
 *    row, lists from remote.session.modelCatalog()). Writes ride the
 *    settings remote (revision-fenced mutate) into ~/.dsh/settings.yaml.
 *
 * @module dsh-rich-indexing/client
 */
window.__ModuleLoader__.load({
	id: "dsh-rich-indexing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		var h = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;
		var useCallback = react.useCallback;

		//#region lib/api.js
		var NS = "rich-indexing";
		var API = "/api/rich-indexing";
		var LAWS = ["gentle", "standard", "consolidating", "maximum"];

		async function getState(sessionId) {
			var res = await fetch(API + "/state?sessionId=" + encodeURIComponent(sessionId), { cache: "no-store" });
			var body = await res.json();
			if (!body || body.ok !== true) throw new Error(body && body.error || "state failed");
			return body.state;
		}
		async function post(action, body) {
			var res = await fetch(API + "/" + action, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body || {}),
			});
			var parsed = await res.json().catch(function () { return null; });
			if (res.status >= 400 || !parsed || parsed.ok !== true) {
				throw new Error((parsed && parsed.error) || (action + " failed"));
			}
			return parsed;
		}
		//#endregion

		//#region lib/format.js
		function pct(value) {
			if (typeof value !== "number" || !isFinite(value)) return "—";
			return Math.round(value * 100) + "%";
		}
		function pctOf(ratio) {
			return Math.round((Number(ratio) || 0) * 100) + "%";
		}
		//#endregion

		//#region view/CompactionTab.js
		/**
		 * The conversation.view tab, trajectory-grade: a full-bleed host that
		 * fills its cell (the container contract from ui-trajectory's
		 * views.module.css), a 32px toolbar rail, and a scrolling body of
		 * dense sections — gauge, tier table, facts, checkpoint history, model
		 * chain — plus an inline advanced-config panel. Presenters are
		 * hook-free (the slot wrapper owns state); actions are utility only:
		 * Compact now, Configure. No refresh (5s poll), no release (plugin
		 * toggle-off owns restoration).
		 */

		function Gauge(props) {
			var tiers = props.tiers || [];
			var fraction = typeof props.fraction === "number" ? props.fraction : null;
			var pointer = props.pointer;
			var segs = [];
			var ticks = [];
			var labels = [];
			var prevPct = 0;
			for (var i = 0; i < tiers.length; i += 1) {
				var tier = tiers[i];
				var pct100 = tier.ratio * 100;
				var consumed = pointer !== null && pointer !== undefined && i <= pointer;
				var armed = pointer !== null && pointer !== undefined && i === pointer + 1;
				segs.push(h("div", {
					key: "s" + i,
					className: "ri-laneSeg" + (consumed ? " ri-consumed" : armed ? " ri-armed" : ""),
					style: { left: prevPct + "%", width: Math.max(0, pct100 - prevPct) + "%" },
					title: "tier " + (i + 1) + " \u00b7 " + pctOf(tier.ratio) + " \u00b7 keep " + pctOf(tier.retainRatio) + " \u00b7 " + tier.law,
				}));
				ticks.push(h("div", { key: "t" + i, className: "ri-laneTick", style: { left: pct100 + "%" } }));
				labels.push(h("div", {
					key: "l" + i,
					className: "ri-laneLabel" + (consumed ? " ri-consumed" : armed ? " ri-armed" : ""),
					style: { left: "calc(" + pct100 + "% + 3px)" },
				}, pctOf(tier.ratio) + " " + tier.law));
				prevPct = pct100;
			}
			return h("div", { className: "ri-lanes" }, [
				h("div", { key: "track", className: "ri-laneTrack" }, [
					h("div", { key: "fill", className: "ri-laneFill", style: { width: fraction === null ? 0 : (Math.min(1, fraction) * 100) + "%" } }),
					segs,
				]),
				ticks,
				fraction === null ? null : h("div", { key: "needle", className: "ri-laneNeedle", style: { left: (Math.min(1, fraction) * 100) + "%" } }),
				labels,
			]);
		}

		/** Group header row (TrajectoryGroupHeader): title + tertiary description. */
		function GroupHeader(props) {
			return h("div", { className: "ri-group" }, [
				h("span", { key: "t", className: "ri-groupTitle" }, props.title),
				props.description ? h("span", { key: "d", className: "ri-groupDesc" }, props.description) : null,
			]);
		}

		/** One 38px tagged card row (TrajectoryCell): index, law tag, text, trailing. */
		function Row(props) {
			return h("div", { className: "ri-card" + (props.error === true ? " ri-rowError" : "") }, [
				h("span", { key: "i", className: "ri-index" }, props.index),
				h("span", { key: "ts", className: "ri-tagSlot" },
					h("span", { key: "tag", className: "ri-tag " + props.tagClass }, props.tag)),
				h("span", { key: "x", className: "ri-text" }, props.text),
				h("span", { key: "tr", className: "ri-trailing" }, props.trailing),
			]);
		}

		var LAW_TAG = { gentle: "ri-tagGentle", standard: "ri-tagStandard", consolidating: "ri-tagConsolidating", maximum: "ri-tagMaximum" };

		function TierRows(props) {
			var tiers = props.tiers || [];
			var pointer = props.pointer;
			var nextTier = props.nextTier;
			var rows = tiers.map(function (tier, i) {
				var consumed = pointer !== null && pointer !== undefined && i <= pointer;
				var armed = pointer !== null && pointer !== undefined && i === pointer + 1;
				var law = tier.law || "standard";
				return h(Row, { key: "t" + i,
					index: "T" + (i + 1),
					tagClass: LAW_TAG[law] || "ri-tagStandard", tag: law,
					text: "fires at " + pctOf(tier.ratio) + " \u00b7 keeps " + pctOf(tier.retainRatio),
					trailing: h("span", { className: consumed ? "ri-consumed" : armed ? "ri-armed" : "" },
						consumed ? "consumed" : armed ? "armed next" : "pending"),
				});
			});
			return h("div", { className: "ri-section" }, [
				h(GroupHeader, { key: "h", title: "Tier ladder",
				description: nextTier ? "next: " + pctOf(nextTier.ratio) + " " + nextTier.law : "ladder complete" }),
				h("div", { key: "r", className: "ri-rows" }, rows),
			]);
		}

		function HistoryRows(props) {
			var history = props.history || [];
			var rows = history.map(function (entry, i) {
				if (entry.kind === "error") {
					return h(Row, { key: "h" + i, error: true,
						index: fmtTime(entry.at), tagClass: "ri-tagMaximum", tag: "error",
						text: String(entry.error || "unknown"), trailing: "\u2014" });
				}
				return h(Row, { key: "h" + i,
					index: fmtTime(entry.at),
					tagClass: "ri-tagRoute", tag: (entry.provider || "?") + "/" + (entry.model || "?"),
					text: "shadowed " + (entry.shadowedTokens != null ? entry.shadowedTokens.toLocaleString() : "\u2014") + " tokens",
					trailing: (entry.shadowedNodes != null ? entry.shadowedNodes + " nodes" : "\u2014"),
				});
			});
			return h("div", { className: "ri-section" }, [
				h(GroupHeader, { key: "h", title: "Checkpoints", description: history.length > 0 ? "newest first" : "" }),
				history.length === 0
					? h("div", { key: "e", className: "ri-empty" }, "none yet in this session")
					: h("div", { key: "r", className: "ri-rows" }, rows),
			]);
		}

		function ChainRows(props) {
			var models = props.models || [];
			var lastRoute = props.lastRoute;
			if (models.length === 0) {
				return h("div", { className: "ri-section" }, [
					h(GroupHeader, { key: "h", title: "Model chain", description: "" }),
					h("div", { key: "e", className: "ri-empty" }, "none configured \u2014 summaries ride the conversation's own route"),
				]);
			}
			var rows = models.map(function (route, i) {
				var isLast = lastRoute != null && lastRoute.provider === route.provider && lastRoute.model === route.model;
				return h(Row, { key: "c" + i,
					index: i === 0 ? "P" : "F" + i,
					tagClass: "ri-tagRoute", tag: route.provider,
					text: route.model + " \u00b7 " + (route.reasoningEffort && route.reasoningEffort !== "default" ? "effort " + route.reasoningEffort : "default effort"),
					trailing: isLast ? h("span", { className: "ri-consumed" }, "last used") : "\u2014",
				});
			});
			return h("div", { className: "ri-section" }, [
				h(GroupHeader, { key: "h", title: "Model chain", description: models.length + " route(s) \u00b7 exhaustion falls back to the conversation route" }),
				h("div", { key: "r", className: "ri-rows" }, rows),
			]);
		}

		function fmtTime(at) {
			if (at === null || at === undefined) return "\u2014";
			try { return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }
			catch { return "\u2014" }
		}

		/** The tab root: sticky toolbar rail + scrolling body (full-bleed host). */
		function CompactionTab(props) {
			var state = props.state;
			if (state === null) {
				return h("div", { className: "ri-root" },
					h("div", { className: "ri-toolbar" }, h("div", { className: "ri-inner" },
					h("div", { className: "ri-actions" }, h("span", { className: "ri-title" }, "compaction")))),
					h("div", { className: "ri-body" }, [h("div", { className: "ri-empty" }, "loading\u2026"), h("div", { className: "ri-fade", "aria-hidden": "true" })]));
			}
			var takeover = state.takeover || {};
			var session = state.session;
			var config = state.config || {};
			var tiers = config.tiers || [];
			var healthy = takeover.engineRegistered === true;
			var fraction = session ? session.fraction : null;
			var pointer = session && session.engine ? session.engine.tierPointer : null;
			var nextTier = session && session.engine ? session.engine.nextTier : null;
			return h("div", { className: "ri-root" }, [
				h("div", { key: "bar", className: "ri-toolbar" },
					h("div", { className: "ri-inner" }, [
					h("div", { key: "a", className: "ri-actions" }, [
						h("span", { key: "t", className: "ri-title" }, "compaction"),
						h("span", { key: "r", className: "ri-readout" }, fraction === null ? "\u2014 / " + ((session && session.window) || 0).toLocaleString() :
						h("b", null, (session.tokens || 0).toLocaleString()), " / " + (session.window || 0).toLocaleString() + " \u00b7 " + pct(fraction)),
						h("span", { key: "p", className: "ri-pill" + (healthy ? " ri-pillOn" : "") }, healthy ? "tiered engine" : String(takeover.state || "unknown")),
					]),
					props.children !== undefined && props.children !== null ? h("button", {
					key: "cfg", type: "button", className: "ri-btn", onClick: props.onToggleConfig,
					"aria-expanded": props.configOpen === true, "aria-pressed": props.configOpen === true,
					}, props.configOpen ? "Hide config" : "Configure") : null,
					h("button", {
					key: "go", type: "button", className: "ri-btn ri-btnPrimary", disabled: props.busy || !healthy || !session,
					onClick: props.onCompact,
					title: "fire the next armed tier now",
					}, "Compact now"),
					])),
				h("div", { key: "body", className: "ri-body" }, [
					h(Gauge, { key: "g", tiers: tiers, fraction: fraction, pointer: pointer }),
					h(TierRows, { key: "tt", tiers: tiers, pointer: pointer, nextTier: nextTier }),
					h(HistoryRows, { key: "h", history: session ? session.history : [] }),
					h(ChainRows, { key: "c", models: config.models || [], lastRoute: takeover.lastRoute }),
					props.children !== undefined && props.children !== null ? props.children : null,
				h("div", { key: "fade", className: "ri-fade", "aria-hidden": "true" }),
				]),
			]);
		}

		/**
		 * Inline advanced configuration. Hook-free presenter: the wrapper owns
		 * the draft. Saves ride the settings remote (whole-section set), the
		 * same write the Plugins card uses \u2014 live-applied by the host.
		 */
		function ConfigPanel(props) {
			var draft = props.draft || {};
			var tiers = draft.tiers || [];
			var models = draft.models || [];
			var groups = (props.catalog && props.catalog.groups) || [];
			var setDraft = props.setDraft;
			function patch(next) { setDraft(Object.assign({}, draft, next)) }
			function setTier(i, key, value) {
				var next = tiers.slice(); next[i] = Object.assign({}, next[i]); next[i][key] = value; patch({ tiers: next });
			}
			var tierRows = tiers.map(function (tier, i) {
				return h("div", { key: "tr" + i, className: "ri-cfgRow" }, [
					h("span", { key: "l", className: "ri-cfgLabel" }, "T" + (i + 1)),
					h("input", { key: "r", type: "number", step: "0.01", min: "0.01", max: "1", className: "ri-input ri-w70",
					value: tier.ratio, title: "fires at (fraction of window)", onChange: function (e) { setTier(i, "ratio", Number(e.target.value)) } }),
					h("span", { key: "s1", className: "ri-cfgLabel" }, "keep"),
					h("input", { key: "k", type: "number", step: "0.01", min: "0.01", className: "ri-input ri-w70",
					value: tier.retainRatio, title: "verbatim tail kept (fraction)", onChange: function (e) { setTier(i, "retainRatio", Number(e.target.value)) } }),
					h("select", { key: "law", className: "ri-select", value: tier.law || "standard",
					onChange: function (e) { setTier(i, "law", e.target.value) } },
					LAWS.map(function (law) { return h("option", { key: law, value: law }, law) })),
					tiers.length > 1 ? h("button", { key: "x", type: "button", className: "ri-cfgRemove", title: "remove tier",
					onClick: function () { patch({ tiers: tiers.filter(function (_, j) { return j !== i }) }) } }, "\u00d7") : null,
				]);
			});
			var modelRows = models.map(function (route, i) {
				var group = null;
				for (var g = 0; g < groups.length; g += 1) if (groups[g].id === route.provider) group = groups[g];
				var modelOptions = group ? group.models : [];
				var model = null;
				for (var m = 0; m < modelOptions.length; m += 1) if (modelOptions[m].id === route.model) model = modelOptions[m];
				var efforts = (model && model.reasoning && model.reasoning.efforts) || [];
				return h("div", { key: "mr" + i, className: "ri-cfgRow" }, [
					h("span", { key: "l", className: "ri-cfgLabel" }, i === 0 ? "primary" : "fb " + i),
					h("select", { key: "p", className: "ri-select", value: route.provider,
					onChange: function (e) { var next = models.slice(); next[i] = { provider: e.target.value, model: "", reasoningEffort: "default" }; patch({ models: next }) } },
						groups.length === 0 && route.provider ? h("option", { value: route.provider }, route.provider) : null,
						groups.map(function (grp) { return h("option", { key: grp.id, value: grp.id }, grp.name || grp.id) })),
					h("select", { key: "m", className: "ri-select", value: route.model,
					onChange: function (e) { var next = models.slice(); next[i] = { provider: route.provider, model: e.target.value, reasoningEffort: "default" }; patch({ models: next }) } },
						modelOptions.length === 0 && route.model ? h("option", { value: route.model }, route.model) : null,
						modelOptions.map(function (mdl) { return h("option", { key: mdl.id, value: mdl.id }, mdl.name || mdl.id) })),
					h("select", { key: "e", className: "ri-select", value: route.reasoningEffort || "default",
					onChange: function (e) { var next = models.slice(); next[i] = Object.assign({}, route, { reasoningEffort: e.target.value }); patch({ models: next }) } },
						[{ id: "default", name: "default" }].concat(efforts).map(function (effort) { return h("option", { key: effort.id, value: effort.id }, effort.name || effort.id) })),
					h("button", { key: "x", type: "button", className: "ri-cfgRemove", title: "remove route",
					onClick: function () { patch({ models: models.filter(function (_, j) { return j !== i }) }) } }, "\u00d7"),
				]);
			});
			return h("div", { className: "ri-section" }, [
				h(GroupHeader, { key: "gh", title: "Configuration", description: "live-applied on save" }),
				h("div", { key: "wrap", className: "ri-cfg" }, [
				h("div", { key: "top", className: "ri-cfgRow" }, [
					h("label", { key: "en", className: "ri-cfgCheck" },
					h("input", { type: "checkbox", checked: draft.enabled !== false, onChange: function (e) { patch({ enabled: e.target.checked }) } }),
					"enabled"),
					h("span", { key: "sp", className: "ri-spacer" }),
					h("span", { key: "ml", className: "ri-cfgLabel" }, "maxTokens"),
					h("input", { key: "mt", type: "number", min: "1", className: "ri-input ri-w90", value: draft.maxTokens || 8192,
					onChange: function (e) { patch({ maxTokens: Number(e.target.value) }) } }),
				]),
				tierRows,
				tiers.length < 6 ? h("button", { key: "at", type: "button", className: "ri-btn ri-cfgAdd",
				onClick: function () {
					var last = tiers[tiers.length - 1];
					var ratio = last ? Math.min(0.98, last.ratio + 0.1) : 0.3;
					patch({ tiers: tiers.concat([{ ratio: ratio, retainRatio: last ? Math.max(0.02, last.retainRatio - 0.02) : 0.12, law: "maximum" }]) });
				} }, "+ tier") : null,
				models.length > 0 ? modelRows : h("div", { key: "me", className: "ri-empty" }, "no chain \u2014 summaries ride the conversation's own route"),
				models.length < 4 ? h("button", { key: "am", type: "button", className: "ri-btn ri-cfgAdd",
					onClick: function () {
					var dflt = (props.catalog && props.catalog.default) || {};
					patch({ models: models.concat([{ provider: dflt.provider || "", model: dflt.model || "", reasoningEffort: "default" }]) });
				} }, "+ route") : null,
				h("div", { key: "act", className: "ri-cfgActions" }, [
					h("button", { key: "save", type: "button", className: "ri-btn ri-btnPrimary", disabled: props.saving === true, onClick: props.onSave }, "Save"),
					h("button", { key: "dis", type: "button", className: "ri-btn", onClick: props.onDiscard }, "Discard"),
					props.notice ? h("span", { key: "n", className: props.notice.indexOf("saved") === 0 ? "ri-notice ri-noticeOk" : "ri-notice" }, props.notice) : null,
					]),
				]),
				]);
			}
		//#endregion

		//#region card/RichIndexingCard.js
		/**
		 * The Settings → Plugins card. Draft-edit locally, save through the
		 * settings remote with the revision it was read at (a stale writer is
		 * refused instead of clobbering).
		 */
		function RichIndexingCard(props) {
			var remote = props.remote;
			var remoteSettings = props.remoteSettings;
			var catalog = props.catalog;
			var view = props.view;
			var revision = props.revision;
			var draft = props.draft;
			var setDraft = props.setDraft;
			var notice = props.notice;
			var setNotice = props.setNotice;

			function save() {
				setNotice(null);
				var tiers = draft.tiers || [];
				for (var i = 0; i < tiers.length; i += 1) {
					if (!(tiers[i].ratio > 0 && tiers[i].ratio <= 1)) { setNotice("tier " + (i + 1) + ": ratio must be in (0, 1]"); return }
					if (!(tiers[i].retainRatio > 0 && tiers[i].retainRatio < tiers[i].ratio)) {
						setNotice("tier " + (i + 1) + ": retainRatio must be in (0, ratio)"); return
					}
					if (i > 0 && tiers[i].ratio <= tiers[i - 1].ratio) { setNotice("tier ratios must be strictly increasing"); return }
				}
				var models = (draft.models || []).filter(function (route) { return route.provider && route.model });
				if (models.length > 4) { setNotice("at most 4 model routes"); return }
				remoteSettings.mutate(NS, [{ op: "set", path: [], value: {
					enabled: draft.enabled !== false,
					tiers: tiers,
					models: models.map(function (route) { return {
						provider: route.provider, model: route.model,
						reasoningEffort: route.reasoningEffort || "default",
					} }),
					maxTokens: Number(draft.maxTokens) > 0 ? Math.floor(Number(draft.maxTokens)) : 8192,
				} }], revision).then(function () {
					setNotice("saved — live-applied");
				}).catch(function (error) {
					setNotice("save refused: " + (error && error.message || error));
				});
			}

			if (!view) {
				return h("div", { style: cardStyle() },
					h("div", null, "rich-indexing — settings namespace not registered (host half inactive)."));
			}
			var groups = (catalog && catalog.groups) || [];
			var tiers = draft.tiers || [];
			var models = draft.models || [];
			var children = [];
			children.push(h("div", { key: "title", style: { fontWeight: "600", marginBottom: "6px" } }, "rich-indexing — tiered compaction"));
			children.push(h("div", { key: "sub", style: { color: "var(--dsw-alias-label-secondary, #888)", fontSize: "12px", marginBottom: "10px" } },
				"Progressive compaction: each tier crossing condenses with a stronger law and a smaller verbatim tail. Persists to ~/.dsh/settings.yaml."));
			// enabled + maxTokens
			children.push(h("label", { key: "en", style: rowStyle() },
				h("input", { type: "checkbox", checked: draft.enabled !== false, onChange: function (event) { setDraft(Object.assign({}, draft, { enabled: event.target.checked })) } }),
				h("span", null, "enabled"),
				h("span", { style: spacerStyle() }),
				"maxTokens ",
				h("input", {
					type: "number", min: 1, value: draft.maxTokens || 8192,
					onChange: function (event) { setDraft(Object.assign({}, draft, { maxTokens: Number(event.target.value) })) },
					style: inputStyle(90),
				})));
			// tiers
			var tierRows = tiers.map(function (tier, index) {
				return h("div", { key: "tier" + index, style: rowStyle() },
					h("span", { style: labelStyle() }, "tier " + (index + 1) + " at"),
					h("input", {
						type: "number", step: "0.01", min: "0.01", max: "1", value: tier.ratio,
						onChange: function (event) { setTier(index, "ratio", Number(event.target.value)) },
						style: inputStyle(70),
					}),
					h("span", { style: labelStyle() }, "keep"),
					h("input", {
						type: "number", step: "0.01", min: "0.01", value: tier.retainRatio,
						onChange: function (event) { setTier(index, "retainRatio", Number(event.target.value)) },
						style: inputStyle(70),
					}),
					h("select", {
						value: tier.law || "standard",
						onChange: function (event) { setTier(index, "law", event.target.value) },
						style: inputStyle(130),
					}, LAWS.map(function (law) { return h("option", { key: law, value: law }, law) })));
			});
			children.push(h("div", { key: "tiers", style: { marginBottom: "10px" } }, tierRows));
			// models
			var modelRows = models.map(function (route, index) {
				var group = null;
				for (var g = 0; g < groups.length; g += 1) if (groups[g].id === route.provider) group = groups[g];
				var modelOptions = group ? group.models : [];
				var model = null;
				for (var m = 0; m < modelOptions.length; m += 1) if (modelOptions[m].id === route.model) model = modelOptions[m];
				var efforts = (model && model.reasoning && model.reasoning.efforts) || [];
				return h("div", { key: "m" + index, style: rowStyle() },
					h("span", { style: labelStyle() }, index === 0 ? "primary" : "fallback " + index),
					h("select", {
						value: route.provider,
						onChange: function (event) { setModel(index, { provider: event.target.value, model: "", reasoningEffort: "default" }) },
						style: inputStyle(150),
					}, groups.map(function (grp) { return h("option", { key: grp.id, value: grp.id }, grp.name || grp.id) })),
					h("select", {
						value: route.model,
						onChange: function (event) { setModel(index, { provider: route.provider, model: event.target.value, reasoningEffort: "default" }) },
						style: inputStyle(180),
					}, modelOptions.map(function (mdl) { return h("option", { key: mdl.id, value: mdl.id }, mdl.name || mdl.id) })),
					h("select", {
						value: route.reasoningEffort || "default",
						onChange: function (event) { setModel(index, { provider: route.provider, model: route.model, reasoningEffort: event.target.value }) },
						style: inputStyle(110),
					}, [{ id: "default", name: "default" }].concat(efforts).map(function (effort) {
						return h("option", { key: effort.id, value: effort.id }, effort.name || effort.id)
					})),
					h(primitives.Button, { onClick: function () { removeModel(index) }, variant: "outline", size: "sm" }, "×"));
			});
			children.push(h("div", { key: "models", style: { marginBottom: "10px" } },
				modelRows.length > 0 ? modelRows : h("div", { style: { color: "var(--dsw-alias-label-secondary, #888)", fontSize: "12px" } }, "no chain configured — summaries use the conversation's own route"),
				models.length < 4 ? h(primitives.Button, { onClick: addModel, variant: "ghost", size: "sm", style: { marginTop: "4px" } }, "+ add route") : null));
			// actions
			children.push(h("div", { key: "actions", style: { display: "flex", gap: "8px", alignItems: "center" } }, [
				h(primitives.Button, { key: "save", variant: "primary", size: "sm", onClick: save }, "Save"),
				h(primitives.Button, { key: "reset", variant: "ghost", size: "sm", onClick: function () { setDraft(JSON.parse(JSON.stringify(view.value || {}))); setNotice(null) } }, "Discard"),
				notice ? h("span", { key: "notice", style: { fontSize: "12px", color: notice.indexOf("saved") === 0 ? "var(--dsw-alias-state-success-primary, #3d9970)" : "var(--dsw-alias-state-danger-primary, #c0392b)" } }, notice) : null,
			]));

			function setTier(index, key, value) {
				var next = JSON.parse(JSON.stringify(draft));
				next.tiers[index][key] = value;
				setDraft(next);
			}
			function setModel(index, route) {
				var next = JSON.parse(JSON.stringify(draft));
				next.models[index] = route;
				setDraft(next);
			}
			function addModel() {
				var next = JSON.parse(JSON.stringify(draft));
				next.models = next.models || [];
				var dflt = (catalog && catalog.default) || { provider: "", model: "" };
				next.models.push({ provider: dflt.provider || "", model: dflt.model || "", reasoningEffort: "default" });
				setDraft(next);
			}
			function removeModel(index) {
				var next = JSON.parse(JSON.stringify(draft));
				next.models.splice(index, 1);
				setDraft(next);
			}
			return h("div", { style: cardStyle() }, children);
		}

		function cardStyle() {
			return {
				border: "1px solid var(--dsw-alias-border-l2, #8884)", borderRadius: "10px",
				padding: "12px 14px", margin: "8px 0", fontSize: "13px",
			};
		}
		function rowStyle() {
			return { display: "flex", alignItems: "center", gap: "8px", margin: "4px 0", flexWrap: "wrap" };
		}
		function labelStyle() {
			return { color: "var(--dsw-alias-label-secondary, #888)", minWidth: "64px", fontSize: "12px" };
		}
		function spacerStyle() {
			return { flex: 1 };
		}
		function inputStyle(width) {
			return {
				width: width + "px", padding: "2px 6px", borderRadius: "6px", fontSize: "12.5px",
				border: "1px solid var(--dsw-alias-border-l2, #8884)",
				background: "var(--dsw-alias-bg-base, transparent)",
				color: "var(--dsw-alias-label-primary, inherit)",
			};
		}
		//#endregion

		//#region styles
		var CSS = ""
		// Container (ui-trajectory views.module.css contract).
		+ ".ri-root{display:flex;flex-direction:column;overflow:hidden;height:100%;min-height:0;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}"
		// Toolbar rail (TrajectoryToolbar.module.css .root/.inner).
		+ ".ri-toolbar{position:sticky;top:0;z-index:4;box-sizing:border-box;width:100%;height:32px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}"
		+ ".ri-inner{display:flex;align-items:center;box-sizing:border-box;width:100%;height:100%;padding:0 6px;gap:8px}"
		+ ".ri-actions{display:flex;flex:none;align-items:center;gap:2px}"
		+ ".ri-btn{display:inline-flex;flex:none;align-items:center;height:20px;padding:0 7px;gap:4px;border:0;border-radius:3px;color:var(--dsw-alias-label-tertiary);background:transparent;cursor:pointer;font:var(--dsw-font-xxs-12);white-space:nowrap}"
		+ ".ri-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-markdown-code-block))}"
		+ ".ri-btn[aria-pressed='true']{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-markdown-code-block))}"
		+ ".ri-btn:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:1px}"
		+ ".ri-btn:disabled{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));cursor:not-allowed;background:transparent}"
		+ ".ri-btnPrimary{color:var(--dsw-alias-state-business-primary)}"
		+ ".ri-btnPrimary:hover{color:var(--dsw-alias-state-business-primary)}"
		// Readout + status pill.
		+ ".ri-readout{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}"
		+ ".ri-readout b{color:var(--dsw-alias-label-primary);font-weight:600}"
		+ ".ri-pill{display:inline-flex;align-items:center;height:22px;box-sizing:border-box;padding:0 4px;border-radius:6px;font:var(--dsw-font-xxs-12);white-space:nowrap;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-markdown-code-block))}"
		+ ".ri-pillOn{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}"
		// Scrolling body + bottom recede (the composer seat's input-mask gradient).
		+ ".ri-body{flex:1;min-height:0;min-width:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;padding:0 0 calc(var(--dsh-composer-height,152px) + 16px)}"
		+ ".ri-body::-webkit-scrollbar{display:none}"
		// Group headers (TrajectoryGroupHeader.module.css).
		+ ".ri-group{display:flex;align-items:center;box-sizing:border-box;height:36px;padding:0 20px;gap:24px;min-width:0;margin-top:8px}"
		+ ".ri-lanes ~ .ri-section .ri-group:first-child,.ri-body > .ri-section:first-child .ri-group{margin-top:0}"
		+ ".ri-title{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.05em}"
		+ ".ri-groupTitle{flex:none;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}"
		+ ".ri-groupDesc{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary)}"
		// Pressure lanes (TrajectoryTimeline span metric).
		+ ".ri-lanes{position:relative;height:40px;margin:4px 20px 10px}"
		+ ".ri-laneTrack{position:absolute;left:0;right:0;top:16px;height:8px;border-radius:1px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}"
		+ ".ri-laneFill{position:absolute;left:0;top:0;bottom:0;border-radius:1px;background:var(--dsw-alias-state-business-primary);min-width:2px;opacity:.78}"
		+ ".ri-laneNeedle{position:absolute;top:6px;bottom:8px;width:2px;border-radius:1px;background:var(--dsw-alias-label-primary)}"
		+ ".ri-laneSeg{position:absolute;top:0;bottom:0;border-radius:1px;background:var(--dsw-alias-border-l2-darkmode-thin)}"
		+ ".ri-laneSeg.ri-consumed{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 68%,var(--dsw-alias-label-secondary))}"
		+ ".ri-laneSeg.ri-armed{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 72%,var(--dsw-alias-label-secondary))}"
		+ ".ri-laneTick{position:absolute;top:10px;bottom:12px;width:1px;background:var(--dsw-alias-border-l2)}"
		+ ".ri-laneLabel{position:absolute;top:0;font:var(--dsw-font-xxs-12);line-height:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}"
		+ ".ri-laneLabel.ri-consumed{color:var(--dsw-alias-state-business-primary)}"
		+ ".ri-laneLabel.ri-armed{color:var(--dsw-alias-state-warning-primary)}"
		// Card rows (TrajectoryCell.module.css .root: 38px cards on layer-3).
		+ ".ri-rows{display:flex;flex-direction:column;gap:1px;padding:0 20px}"
		+ ".ri-tagSlot{flex:none;width:80px;display:flex;align-items:center;min-width:0}"
		+ ".ri-card{display:flex;align-items:center;box-sizing:border-box;height:38px;padding:0 8px 0 20px;gap:24px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);min-width:0}"
		+ ".ri-card.ri-rowError{border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary) 40%,var(--dsw-alias-border-l2))}"
		+ ".ri-index{flex:none;min-width:24px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary)}"
		+ ".ri-tag{display:inline-flex;align-items:center;box-sizing:border-box;height:22px;max-width:100%;padding:0 4px;border-radius:6px;font:var(--dsw-font-xxs-12);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
		+ ".ri-tagGentle{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}"
		+ ".ri-tagStandard{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-markdown-code-block))}"
		+ ".ri-tagConsolidating{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warning-primary));background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-markdown-code-block))}"
		+ ".ri-tagMaximum{color:var(--dsw-alias-state-danger-primary);background:color-mix(in srgb,var(--dsw-alias-state-danger-primary) 12%,var(--dsw-alias-bg-layer-1))}"
		+ ".ri-tagRoute{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,var(--dsw-alias-bg-layer-1))}"
		+ ".ri-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}"
		+ ".ri-trailing{flex:none;display:flex;align-items:center;gap:12px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);white-space:nowrap}"
		+ ".ri-trailing .ri-consumed{color:var(--dsw-alias-state-business-primary)}"
		+ ".ri-trailing .ri-armed{color:var(--dsw-alias-state-warning-primary)}"
		+ ".ri-trailing .ri-rowError{color:var(--dsw-alias-state-danger-primary)}"
		+ ".ri-empty{padding:6px 20px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}"
		// Inline config panel (search-input grammar for fields).
		+ ".ri-fade{position:sticky;bottom:0;z-index:2;height:36px;margin-top:-36px;pointer-events:none;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 0%,transparent) 0,var(--dsw-alias-bg-layer-1) 36px)}"
		+ ".ri-cfg{padding:0 20px}"
		+ ".ri-cfgRow{display:flex;align-items:center;gap:8px;margin:4px 0;flex-wrap:wrap}"
		+ ".ri-cfgLabel{flex:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);min-width:44px}"
		+ ".ri-cfgCheck{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font:var(--dsw-font-xxs-12)}"
		+ ".ri-input,.ri-select{box-sizing:border-box;height:22px;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}"
		+ ".ri-input:hover,.ri-select:hover{border-color:var(--dsw-alias-label-caption,var(--dsw-alias-border-l2))}"
		+ ".ri-input:focus,.ri-select:focus{border-color:var(--dsw-alias-state-business-primary);outline:none;background:var(--dsw-alias-bg-layer-1)}"
		+ ".ri-w70{width:70px}.ri-w90{width:90px}"
		+ ".ri-cfgRemove{width:20px;height:20px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:3px;display:grid;place-items:center;padding:0;font:var(--dsw-font-xxs-12)}"
		+ ".ri-cfgRemove:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-markdown-code-block))}"
		+ ".ri-cfgAdd{margin:4px 0 2px}"
		+ ".ri-cfgActions{display:flex;align-items:center;gap:8px;margin-top:10px}"
		+ ".ri-notice{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-danger-primary)}"
		+ ".ri-noticeOk{color:var(--dsw-alias-state-success-primary)}";
		function injectStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-rich-indexing-styles")) return;
			var style = document.createElement("style");
			style.id = "dsh-rich-indexing-styles";
			style.textContent = CSS;
			(document.head || document.documentElement).appendChild(style);
		}
		//#endregion

		//#region apply.js
		/** Client services this module needs on its ctx. */
		var inject = ["slots", "locale", "remote.session", "remote.settings"];

		/**
		 * Client plugin body: the Compaction conversation.view sub-tab and the
		 * rich-indexing settings card.
		 */
		function apply(ctx) {
			var settingsRemote = ctx["remote.settings"];
			var sessionRemote = ctx["remote.session"];
			injectStyles();
			ctx.effect(function () { return ctx.locale.register(NS, {
				en: { tab: "Compaction" },
				zh: { tab: "压缩" },
			}) }, "rich-indexing: dictionaries");

			ctx.slots.inject("conversation.view", function () {
				return ctx.slots.register({
					name: "conversation.view",
					id: "rich-indexing",
					order: 20,
					locale: NS,
					label: function () { return "Compaction" },
					inject: function (sessionId) {
						return { sessionId: sessionId, settingsRemote: settingsRemote, sessionRemote: sessionRemote }
					},
				}, CompactionSlot);
			});

			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register({
					name: "settings.plugin.item",
					key: NS,
					locale: NS,
					inject: function () { return { settingsRemote: settingsRemote, sessionRemote: sessionRemote } },
				}, RichIndexingCardSlot);
			});
		}

		/** Slot wrapper: state poll + the inline config's draft/save cycle. */
		function CompactionSlot(props) {
			var sessionId = props.sessionId;
			var settingsRemote = props.settingsRemote;
			var sessionRemote = props.sessionRemote;
			var _a = useState(null), state = _a[0], setState = _a[1];
			var _b = useState(false), busy = _b[0], setBusy = _b[1];
			var _c = useState(""), error = _c[0], setError = _c[1];
			var _d = useState(false), configOpen = _d[0], setConfigOpen = _d[1];
			var _e = useState(null), draft = _e[0], setDraft = _e[1];
			var _f = useState(null), catalog = _f[0], setCatalog = _f[1];
			var _g = useState(null), notice = _g[0], setNotice = _g[1];
			var _h = useState(false), saving = _h[0], setSaving = _h[1];
			var refresh = useCallback(function () {
				if (!sessionId) return;
				getState(sessionId).then(function (next) {
					setState(next); setError("");
					if (draft === null && next && next.config) setDraft(JSON.parse(JSON.stringify(next.config)));
				}).catch(function (e) { setError(String(e.message || e)) });
			}, [sessionId, draft]);
			useEffect(function () {
				refresh();
				var timer = setInterval(refresh, 5000);
				return function () { clearInterval(timer) };
			}, [refresh]);
			useEffect(function () {
				if (!sessionRemote || catalog !== null) return;
				sessionRemote.modelCatalog().then(setCatalog).catch(function () { setCatalog({ groups: [] }) });
			}, [sessionRemote, catalog]);
			// The draft tracks the live config until the user edits; Discard
			// re-syncs it (polls never clobber an in-progress edit).
			useEffect(function () {
				if (draft === null && state !== null && state.config) setDraft(JSON.parse(JSON.stringify(state.config)));
			}, [state, draft]);
			var run = useCallback(function (action, body) {
				setBusy(true);
				post(action, body).then(function () { return getState(sessionId) }).then(function (next) {
					setState(next); setError("");
				}).catch(function (e) { setError(String(e.message || e)) }).finally(function () { setBusy(false) });
			}, [sessionId]);
			var save = useCallback(function () {
				if (!settingsRemote || draft === null) return;
				setNotice(null);
				var tiers = draft.tiers || [];
				for (var i = 0; i < tiers.length; i += 1) {
					if (!(tiers[i].ratio > 0 && tiers[i].ratio <= 1)) { setNotice("tier " + (i + 1) + ": fires-at must be in (0, 1]"); return }
					if (!(tiers[i].retainRatio > 0 && tiers[i].retainRatio < tiers[i].ratio)) { setNotice("tier " + (i + 1) + ": keep must be in (0, fires-at)"); return }
					if (i > 0 && tiers[i].ratio <= tiers[i - 1].ratio) { setNotice("tier thresholds must be strictly increasing"); return }
				}
				var models = (draft.models || []).filter(function (route) { return route.provider && route.model });
				if (models.length > 4) { setNotice("at most 4 model routes"); return }
				setSaving(true);
				settingsRemote.mutate(NS, [{ op: "set", path: [], value: {
					enabled: draft.enabled !== false,
					tiers: tiers,
					models: models.map(function (route) { return { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort || "default" } }),
					maxTokens: Number(draft.maxTokens) > 0 ? Math.floor(Number(draft.maxTokens)) : 8192,
				} }], undefined).then(function () {
					setNotice("saved \u2014 live-applied");
					return getState(sessionId);
				}).then(function (next) { setState(next) }).catch(function (e) {
					setNotice("save refused: " + String(e && e.message || e));
				}).finally(function () { setSaving(false) });
			}, [settingsRemote, draft, sessionId]);
			if (!sessionId) return null;
			var children = [];
			if (error) children.push(h("div", { key: "err", style: { padding: "6px 20px", color: "var(--dsw-alias-state-danger-primary, #c0392b)", fontSize: "12px" } }, error));
			children.push(h(CompactionTab, {
				key: "tab", state: state, busy: busy,
				onCompact: function () { run("compact", { sessionId: sessionId }) },
				configOpen: configOpen, onToggleConfig: function () { setConfigOpen(function (v) { return !v }) },
			}, configOpen && settingsRemote !== undefined ? h(ConfigPanel, {
				key: "cfg", draft: draft || {}, setDraft: setDraft, catalog: catalog,
				notice: notice, saving: saving,
				onSave: save,
				onDiscard: function () {
					setDraft(state !== null && state.config ? JSON.parse(JSON.stringify(state.config)) : null);
					setNotice(null);
				},
			}) : null));
			if (children.length === 1) return children[0]
			return h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, height: "100%" } }, children);
		}

		/** Slot wrapper: load describe + catalog, hand the card its props. */
		function RichIndexingCardSlot(props) {
			var settingsRemote = props.settingsRemote;
			var sessionRemote = props.sessionRemote;
			var _a = useState(null), loaded = _a[0], setLoaded = _a[1];
			var _b = useState(null), draft = _b[0], setDraft = _b[1];
			var _c = useState(null), notice = _c[0], setNotice = _c[1];
			var load = useCallback(function () {
				Promise.all([
					settingsRemote.describe(),
					sessionRemote ? sessionRemote.modelCatalog() : Promise.resolve(null),
				]).then(function (results) {
					var described = results[0];
					var catalog = results[1];
					var view = null;
					var namespaces = described.namespaces || [];
					for (var i = 0; i < namespaces.length; i += 1) {
						var candidate = namespaces[i];
						if ((candidate.id || candidate.ns || candidate.name) === NS) view = candidate;
					}
					if (view === null) { setLoaded({ view: null, catalog: catalog, revision: null, value: null }); return }
					setLoaded({ view: view, catalog: catalog, revision: view.revision, value: view.value });
					setDraft(JSON.parse(JSON.stringify(view.value || {})));
				}).catch(function (e) { setLoaded({ view: null, error: String(e.message || e) }) });
			}, []);
			useEffect(function () { load() }, [load]);
			if (loaded === null) return h("div", { style: cardStyle() }, "loading rich-indexing settings…");
			if (loaded.error) return h("div", { style: cardStyle() }, "rich-indexing settings unavailable: " + loaded.error);
			if (loaded.view === null) {
				return h("div", { style: cardStyle() }, "rich-indexing — settings namespace not registered (host half inactive).");
			}
			var passed = {
				remote: remote,
				remoteSettings: remote.settings,
				catalog: loaded.catalog,
				view: loaded.view,
				revision: loaded.revision,
				draft: draft || {},
				setDraft: setDraft,
				notice: notice,
				setNotice: setNotice,
			};
			return h(react.Fragment, null,
				h(RichIndexingCard, passed),
				h("div", { style: { margin: "0 0 8px", textAlign: "right" } },
					h(primitives.Button, { onClick: load, variant: "ghost", size: "sm" }, "Reload from host")));
		}

		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/** Presenters exported hook-free for the client smoke test. */
		exports.views = { CompactionTab: CompactionTab, ConfigPanel: ConfigPanel, RichIndexingCard: RichIndexingCard };
		return module.exports;
	},
});
