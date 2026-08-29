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

		//#region lib/ladder.js
		/** Horizontal tier ladder with the live pressure marker. */
		function LadderBar(props) {
			var tiers = props.tiers || [];
			var fraction = props.fraction;
			var children = [];
			for (var i = 0; i < tiers.length; i += 1) {
				var tier = tiers[i];
				var crossed = typeof fraction === "number" && fraction >= tier.ratio;
				var consumed = props.pointer !== null && props.pointer !== undefined && i <= props.pointer;
				children.push(h("div", {
					key: "t" + i,
					title: "tier " + (i + 1) + ": " + pctOf(tier.ratio) + " · keep " + pctOf(tier.retainRatio) + " · " + tier.law,
					style: {
						flex: "1", height: "10px", borderRadius: "5px",
						background: consumed ? "var(--dsw-alias-state-business-primary, #4a7dff)"
							: crossed ? "var(--dsw-alias-state-warning-primary, #d9a441)"
							: "var(--dsw-alias-border-l2, #8884)",
						marginRight: "4px",
					},
				}));
			}
			return h("div", { style: { display: "flex", alignItems: "center", margin: "6px 0" } }, children);
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
			var marks = [];
			for (var i = 0; i < tiers.length; i += 1) {
				var tier = tiers[i];
				var consumed = pointer !== null && pointer !== undefined && i <= pointer;
				var armed = pointer !== null && pointer !== undefined && i === pointer + 1;
				marks.push(h("div", {
					key: "m" + i,
					className: "ri-gaugeMark" + (consumed ? " ri-consumed" : armed ? " ri-armed" : ""),
					style: { left: (tier.ratio * 100) + "%" },
					title: "tier " + (i + 1) + " \u00b7 " + pctOf(tier.ratio) + " \u00b7 keep " + pctOf(tier.retainRatio) + " \u00b7 " + tier.law,
				}, h("span", { className: "ri-gaugeMarkLabel" }, pctOf(tier.ratio) + " " + tier.law)));
			}
			return h("div", { className: "ri-section" },
				h("div", { className: "ri-eyebrow" }, "pressure"),
				h("div", { className: "ri-gauge" },
					h("div", { className: "ri-gaugeTrack" },
					h("div", { className: "ri-gaugeFill", style: { width: fraction === null ? 0 : (Math.min(1, fraction) * 100) + "%" } }),
					fraction === null ? null : h("div", { className: "ri-gaugeNeedle", style: { left: (Math.min(1, fraction) * 100) + "%" } }),
					marks)));
		}

		function TierTable(props) {
			var tiers = props.tiers || [];
			var pointer = props.pointer;
			var rows = tiers.map(function (tier, i) {
				var consumed = pointer !== null && pointer !== undefined && i <= pointer;
				var armed = pointer !== null && pointer !== undefined && i === pointer + 1;
				return h("tr", { key: "t" + i, className: consumed ? " ri-rowConsumed" : "" }, [
					h("td", { key: "n" }, "T" + (i + 1)),
					h("td", { key: "r", className: "ri-num" }, pctOf(tier.ratio)),
					h("td", { key: "k", className: "ri-num" }, pctOf(tier.retainRatio)),
					h("td", { key: "l" }, tier.law),
					h("td", { key: "s" }, h("span", { className: "ri-pill " + (consumed ? "ri-pillConsumed" : armed ? "ri-pillArmed" : "ri-pillPending") },
						consumed ? "consumed" : armed ? "armed" : "pending")),
				]);
			});
			return h("div", { className: "ri-section" },
				h("div", { className: "ri-eyebrow" }, "tier ladder"),
				h("table", { className: "ri-table" },
					h("thead", null, h("tr", null, [
					h("th", { key: "a" }, "tier"), h("th", { key: "b" }, "fires at"), h("th", { key: "c" }, "keeps"),
					h("th", { key: "d" }, "law"), h("th", { key: "e" }, "status"),
				])),
					h("tbody", null, rows)));
		}

		function HistoryTable(props) {
			var history = props.history || [];
			if (history.length === 0) {
					return h("div", { className: "ri-section" },
					h("div", { className: "ri-eyebrow" }, "checkpoints"),
					h("div", { className: "ri-empty" }, "none yet in this session"));
			}
			var rows = history.map(function (entry, i) {
				if (entry.kind === "error") {
					return h("tr", { key: "h" + i, className: "ri-rowError" }, [
						h("td", { key: "a", className: "ri-num" }, fmtTime(entry.at)),
						h("td", { key: "b", colSpan: 3 }, "error: " + (entry.error || "unknown")),
					]);
				}
				return h("tr", { key: "h" + i }, [
					h("td", { key: "a", className: "ri-num" }, fmtTime(entry.at)),
					h("td", { key: "b" }, (entry.provider || "?") + "/" + (entry.model || "?")),
					h("td", { key: "c", className: "ri-num" }, entry.shadowedTokens != null ? entry.shadowedTokens.toLocaleString() + " tok" : "\u2014"),
					h("td", { key: "d", className: "ri-num" }, entry.shadowedNodes != null ? String(entry.shadowedNodes) : "\u2014"),
				]);
			});
			return h("div", { className: "ri-section" },
				h("div", { className: "ri-eyebrow" }, "checkpoints (newest first)"),
				h("table", { className: "ri-table" },
					h("thead", null, h("tr", null, [
					h("th", { key: "a" }, "at"), h("th", { key: "b" }, "route"), h("th", { key: "c" }, "shadowed"), h("th", { key: "d" }, "nodes"),
				])),
					h("tbody", null, rows)));
		}

		function ChainTable(props) {
			var models = props.models || [];
			var lastRoute = props.lastRoute;
			if (models.length === 0) {
				return h("div", { className: "ri-section" },
					h("div", { className: "ri-eyebrow" }, "model chain"),
					h("div", { className: "ri-empty" }, "none configured \u2014 summaries ride the conversation's own route"));
			}
			var rows = models.map(function (route, i) {
				var isLast = lastRoute != null && lastRoute.provider === route.provider && lastRoute.model === route.model;
				return h("tr", { key: "c" + i }, [
					h("td", { key: "a" }, i === 0 ? "primary" : "fallback " + i),
					h("td", { key: "b" }, route.provider + "/" + route.model),
					h("td", { key: "c" }, route.reasoningEffort && route.reasoningEffort !== "default" ? route.reasoningEffort : "default"),
					h("td", { key: "d" }, isLast ? h("span", { className: "ri-pill ri-pillConsumed" }, "last used") : "\u2014"),
				]);
			});
			return h("div", { className: "ri-section" },
				h("div", { className: "ri-eyebrow" }, "model chain"),
				h("table", { className: "ri-table" },
					h("thead", null, h("tr", null, [
					h("th", { key: "a" }, "role"), h("th", { key: "b" }, "route"), h("th", { key: "c" }, "effort"), h("th", { key: "d" }, "status"),
				])),
					h("tbody", null, rows)));
		}

		function FactsGrid(props) {
			var session = props.session;
			var takeover = props.takeover;
			var facts = [];
			function add(key, value) { facts.push([key, value]) }
			add("tokens", session && session.tokens != null ? session.tokens.toLocaleString() : "\u2014");
			add("window", session && session.window != null ? session.window.toLocaleString() : "\u2014");
			add("routed", session && session.routed ? session.routed.provider + "/" + session.routed.model : "\u2014");
			add("engine", takeover && takeover.engineRegistered === true ? "tiered \u00b7 active" : String((takeover && takeover.state) || "unknown"));
			var nextTier = session && session.engine ? session.engine.nextTier : null;
			add("next tier", nextTier ? pctOf(nextTier.ratio) + " (" + nextTier.law + ")" : "ladder complete");
			if (takeover && Array.isArray(takeover.fallbackLog) && takeover.fallbackLog.length > 0) {
				add("fallback trail", takeover.fallbackLog.map(function (entry) { return entry.route }).join(" \u2192 "));
			}
			return h("div", { className: "ri-section" },
				h("div", { className: "ri-eyebrow" }, "session"),
				h("div", { className: "ri-facts" }, facts.map(function (fact, i) { return [
				h("span", { key: "k" + i, className: "ri-factKey" }, fact[0]),
				h("span", { key: "v" + i, className: "ri-factVal" }, fact[1]),
			]; }).flat()));
		}

		function fmtTime(at) {
			if (at === null || at === undefined) return "\u2014";
			try { return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }
			catch { return "\u2014" }
		}

		/** The tab root: fills the view cell, toolbar rail + scrolling body. */
		function CompactionTab(props) {
			var state = props.state;
			if (state === null) {
				return h("div", { className: "ri-root" },
					h("div", { className: "ri-toolbar" }, h("span", { className: "ri-toolbarTitle" }, "compaction")),
					h("div", { className: "ri-body" }, h("div", { className: "ri-empty" }, "loading\u2026")));
			}
			var takeover = state.takeover || {};
			var session = state.session;
			var config = state.config || {};
			var tiers = config.tiers || [];
			var healthy = takeover.engineRegistered === true;
			var fraction = session ? session.fraction : null;
			var pointer = session && session.engine ? session.engine.tierPointer : null;
			return h("div", { className: "ri-root" }, [
				h("div", { key: "bar", className: "ri-toolbar" }, [
					h("span", { key: "t", className: "ri-toolbarTitle" }, "compaction"),
					h("span", { key: "r", className: "ri-readout" }, fraction === null ? "\u2014 / " + ((session && session.window) || 0).toLocaleString() :
					h("b", null, (session.tokens || 0).toLocaleString()), " / " + (session.window || 0).toLocaleString() + " \u00b7 " + pct(fraction)),
					h(primitives.Pill, { key: "p", active: healthy }, healthy ? "tiered engine" : String(takeover.state || "unknown")),
					h("span", { key: "sp", className: "ri-spacer" }),
					props.children !== undefined && props.children !== null ? h("button", {
					key: "cfg", type: "button", className: "ri-btn", onClick: props.onToggleConfig,
					"aria-expanded": props.configOpen === true,
				}, props.configOpen ? "Hide config" : "Configure") : null,
					h("button", {
					key: "go", type: "button", className: "ri-btn ri-btnPrimary", disabled: props.busy || !healthy || !session,
					onClick: props.onCompact,
					title: "fire the next armed tier now",
				}, "Compact now"),
				]),
				h("div", { key: "body", className: "ri-body" }, [
					h(Gauge, { key: "g", tiers: tiers, fraction: fraction, pointer: pointer }),
					h(TierTable, { key: "tt", tiers: tiers, pointer: pointer }),
					h(FactsGrid, { key: "f", session: session, takeover: takeover }),
					h(HistoryTable, { key: "h", history: session ? session.history : [] }),
					h(ChainTable, { key: "c", models: config.models || [], lastRoute: takeover.lastRoute }),
					props.children !== undefined && props.children !== null ? props.children : null,
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
			return h("div", { className: "ri-section ri-cfg" }, [
				h("div", { key: "eb", className: "ri-eyebrow" }, "configuration (live-applied)"),
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
		var CSS = ".ri-root{display:flex;flex-direction:column;overflow:hidden;height:100%;min-height:0;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font-size:12.5px}"
		+ ".ri-toolbar{display:flex;align-items:center;gap:10px;height:32px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l2-darkmode-thin);flex:none}"
		+ ".ri-toolbarTitle{font-weight:600;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}"
		+ ".ri-readout{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}"
		+ ".ri-readout b{color:var(--dsw-alias-label-primary);font-weight:600}"
		+ ".ri-spacer{flex:1}"
		+ ".ri-body{flex:1;min-height:0;min-width:0;overflow-y:auto;padding:14px 20px 24px;overscroll-behavior:contain;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}"
		+ ".ri-section{margin:0 0 18px;min-width:0}"
		+ ".ri-eyebrow{color:var(--dsw-alias-label-tertiary);font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px}"
		+ ".ri-empty{color:var(--dsw-alias-label-tertiary);font-size:12px}"
		+ ".ri-gauge{position:relative;height:44px;margin:2px 0 4px}"
		+ ".ri-gaugeTrack{position:absolute;left:0;right:0;top:26px;height:6px;border-radius:3px;background:var(--dsw-alias-markdown-code-block)}"
		+ ".ri-gaugeFill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--dsw-alias-state-business-primary);min-width:2px}"
		+ ".ri-gaugeNeedle{position:absolute;top:-4px;bottom:-2px;width:2px;background:var(--dsw-alias-label-primary);border-radius:1px}"
		+ ".ri-gaugeMark{position:absolute;top:16px;bottom:0;width:2px;background:var(--dsw-alias-border-l2-darkmode-thin)}"
		+ ".ri-gaugeMarkLabel{position:absolute;bottom:12px;left:4px;white-space:nowrap;font-size:10px;color:var(--dsw-alias-label-tertiary)}"
		+ ".ri-gaugeMark.ri-consumed{background:var(--dsw-alias-state-business-primary)}"
		+ ".ri-gaugeMark.ri-consumed .ri-gaugeMarkLabel{color:var(--dsw-alias-state-business-primary)}"
		+ ".ri-gaugeMark.ri-armed{background:var(--dsw-alias-state-warning-primary)}"
		+ ".ri-gaugeMark.ri-armed .ri-gaugeMarkLabel{color:var(--dsw-alias-state-warning-primary)}"
		+ ".ri-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}"
		+ ".ri-table th{text-align:left;font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);padding:2px 8px;border-bottom:1px solid var(--dsw-alias-border-l2-darkmode-thin)}"
		+ ".ri-table td{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2-darkmode-thin);overflow-wrap:anywhere}"
		+ ".ri-table tbody tr:hover{background:var(--dsw-alias-markdown-code-block)}"
		+ ".ri-num{text-align:right;white-space:nowrap}"
		+ ".ri-rowConsumed td{color:var(--dsw-alias-label-secondary)}"
		+ ".ri-rowError td{color:var(--dsw-alias-state-danger-primary)}"
		+ ".ri-pill{display:inline-block;border-radius:999px;padding:0 7px;font-size:10.5px;line-height:16px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);color:var(--dsw-alias-label-secondary)}"
		+ ".ri-pillConsumed{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}"
		+ ".ri-pillArmed{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary)}"
		+ ".ri-facts{display:grid;grid-template-columns:120px 1fr;row-gap:4px;column-gap:12px}"
		+ ".ri-factKey{color:var(--dsw-alias-label-tertiary);font-size:11.5px}"
		+ ".ri-factVal{overflow-wrap:anywhere}"
		+ ".ri-cfg{border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))}"
		+ ".ri-cfgRow{display:flex;align-items:center;gap:8px;margin:4px 0;flex-wrap:wrap}"
		+ ".ri-cfgLabel{color:var(--dsw-alias-label-tertiary);font-size:11.5px;min-width:44px}"
		+ ".ri-cfgCheck{display:inline-flex;align-items:center;gap:6px;cursor:pointer}"
		+ ".ri-input,.ri-select{padding:2px 6px;border-radius:6px;font-size:12px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary)}"
		+ ".ri-w70{width:70px}.ri-w90{width:90px}"
		+ ".ri-cfgRemove{width:20px;height:20px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:999px;display:grid;place-items:center;padding:0}"
		+ ".ri-cfgRemove:hover{color:var(--dsw-alias-state-danger-primary)}"
		+ ".ri-cfgAdd{margin:2px 0 8px}"
		+ ".ri-cfgActions{display:flex;align-items:center;gap:8px;margin-top:10px}"
		+ ".ri-notice{font-size:11.5px;color:var(--dsw-alias-state-danger-primary)}"
		+ ".ri-noticeOk{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}"
		// Trajectory-metric buttons: 20px tall, 3px radius, no border \u2014
		// deliberately smaller and squarer than the shared Button primitive.
		+ ".ri-btn{display:inline-flex;align-items:center;height:20px;padding:0 6px;gap:4px;border:0;border-radius:3px;color:var(--dsw-alias-label-tertiary);background:transparent;cursor:pointer;font-size:11.5px;font-weight:500;white-space:nowrap}"
		+ ".ri-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-markdown-code-block))}"
		+ ".ri-btn:disabled{color:var(--dsw-alias-label-tertiary);opacity:.5;cursor:default;background:transparent}"
		+ ".ri-btnPrimary{color:var(--dsw-alias-state-business-primary)}"
		+ ".ri-btnPrimary:hover{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-markdown-code-block))}"
		// Bottom fade: matches the composer seat's own input-mask gradient
		// (bg fades to transparent over the last 36px) so the body recedes
		// under the floating composer instead of hard-clipping.
		+ ".ri-body{-webkit-mask-image:linear-gradient(180deg,#000 calc(100% - 36px),transparent 100%);mask-image:linear-gradient(180deg,#000 calc(100% - 36px),transparent 100%)}"
		// Segmented lane bars (trajectory's span metric: thin, near-square,
		// color-mixed by kind) replace the old chunky rounded gauge.
		+ ".ri-lanes{position:relative;height:34px;margin:2px 0 6px}"
		+ ".ri-laneTrack{position:absolute;left:0;right:0;top:14px;height:6px;border-radius:1px;background:var(--dsw-alias-markdown-code-block);overflow:hidden}"
		+ ".ri-laneFill{position:absolute;left:0;top:0;bottom:0;border-radius:1px;background:var(--dsw-alias-state-business-primary);min-width:2px}"
		+ ".ri-laneNeedle{position:absolute;top:-3px;bottom:-3px;width:2px;border-radius:1px;background:var(--dsw-alias-label-primary)}"
		+ ".ri-laneSeg{position:absolute;top:14px;height:6px;border-radius:1px;background:var(--dsw-alias-border-l2-darkmode-thin)}"
		+ ".ri-laneSeg.ri-consumed{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 68%,var(--dsw-alias-label-secondary))}"
		+ ".ri-laneSeg.ri-armed{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 72%,var(--dsw-alias-label-secondary))}"
		+ ".ri-laneTick{position:absolute;top:6px;bottom:6px;width:1px;background:var(--dsw-alias-border-l2-darkmode-thin)}"
		+ ".ri-laneLabel{position:absolute;top:0;font-size:9.5px;line-height:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}"
		+ ".ri-laneLabel.ri-consumed{color:var(--dsw-alias-state-business-primary)}"
		+ ".ri-laneLabel.ri-armed{color:var(--dsw-alias-state-warning-primary)}";
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
			return h("div", { style: { display: "contents" } }, children);
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
