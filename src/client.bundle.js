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
		 * The conversation.view sub-tab, styled with the system's own
		 * primitives (Button, Pill) and the family's label/hairline language:
		 * 20px rhythm, secondary-label facts, one accent per state.
		 */
		function CompactionTab(props) {
			var state = props.state;
			if (state === null) {
				return h("div", { style: { padding: "20px", color: "var(--dsw-alias-label-secondary, #888)", fontSize: "12.5px" } }, "Loading compaction state\u2026");
			}
			var takeover = state.takeover || {};
			var session = state.session;
			var config = state.config || {};
			var tiers = config.tiers || [];
			var fraction = session ? session.fraction : null;
			var pointer = session && session.engine ? session.engine.tierPointer : null;
			var nextTier = session && session.engine ? session.engine.nextTier : null;
			var last = session ? session.lastCompaction : null;
			var healthy = takeover.engineRegistered === true;
			var engineState = takeover.state || (healthy ? "active" : "unknown");
			var children = [];
			// Headline: pressure fraction + status pill, one row, system typography.
			children.push(h("div", { key: "head", style: { display: "flex", alignItems: "center", gap: "10px" } }, [
				h("span", { key: "f", style: { fontSize: "20px", lineHeight: "28px", fontWeight: "600", fontVariantNumeric: "tabular-nums" } }, pct(fraction)),
				h("span", { key: "l", style: { color: "var(--dsw-alias-label-secondary, #888)", fontSize: "12.5px" } },
					"of the routed context window" + (nextTier ? " \u00b7 next tier at " + pctOf(nextTier.ratio) : " \u00b7 ladder complete")),
				h("span", { key: "sp", style: { flex: 1 } }),
				h(primitives.Pill, { key: "badge", active: healthy }, healthy ? "tiered engine" : String(engineState)),
			]));
			children.push(h(LadderBar, { key: "ladder", tiers: tiers, fraction: fraction, pointer: pointer }));
			// Facts: definition rows, label column aligned like the family's panels.
			var facts = [];
			addFact(facts, "tokens", session && session.tokens != null ? String(session.tokens) : "\u2014");
			addFact(facts, "window", session && session.window != null ? String(session.window) : "\u2014");
			if (pointer != null && tiers[pointer]) {
				addFact(facts, "last fired tier", (pointer + 1) + " (" + tiers[pointer].law + ", keep " + pctOf(tiers[pointer].retainRatio) + ")");
			}
			if (last && last.kind === "summary") {
				addFact(facts, "last checkpoint", (last.provider || "?") + "/" + (last.model || "?") + " \u00b7 shadowed ~" + (last.shadowedTokens != null ? last.shadowedTokens : "?") + " tok");
			} else if (last && last.kind === "error") {
				addFact(facts, "last checkpoint", "error: " + (last.error || "unknown"));
			} else {
				addFact(facts, "last checkpoint", "none yet in this session");
			}
			if (takeover.lastRoute) {
				addFact(facts, "summary route", takeover.lastRoute.provider + "/" + takeover.lastRoute.model
					+ (takeover.lastRoute.reasoningEffort && takeover.lastRoute.reasoningEffort !== "default" ? " (effort " + takeover.lastRoute.reasoningEffort + ")" : ""));
			}
			if (Array.isArray(takeover.fallbackLog) && takeover.fallbackLog.length > 0) {
				addFact(facts, "fallback trail", takeover.fallbackLog.map(function (entry) { return entry.route }).join(" \u2192 "));
			}
			addFact(facts, "model chain", (config.models || []).length === 0 ? "conversation route (none configured)" : (config.models.length) + " route(s)");
			children.push(h("div", { key: "facts", style: { margin: "10px 0 14px", display: "grid", gridTemplateColumns: "130px 1fr", rowGap: "4px", columnGap: "12px", fontSize: "12.5px", lineHeight: "18px" } },
				facts.map(function (fact, i) {
					return [
						h("span", { key: "k" + i, style: { color: "var(--dsw-alias-label-secondary, #888)" } }, fact[0]),
						h("span", { key: "v" + i, style: { color: "var(--dsw-alias-label-primary, inherit)", overflowWrap: "anywhere" } }, fact[1]),
					];
				}).flat()));
			// Actions: system Button primitives.
			children.push(h("div", { key: "actions", style: { display: "flex", gap: "8px" } }, [
				h(primitives.Button, { key: "compact", variant: "primary", size: "sm", disabled: busy, onClick: props.onCompact }, "Compact now"),
				h(primitives.Button, { key: "refresh", variant: "ghost", size: "sm", disabled: busy, onClick: refresh }, "Refresh"),
				h(primitives.Button, { key: "release", variant: "outline", size: "sm", disabled: busy, onClick: props.onRelease,
					style: { color: "var(--dsw-alias-state-danger-primary, #c0392b)" } }, "Release takeover"),
			]));
			return h("div", { style: { padding: "16px 20px" } }, children);
		}

		function addFact(list, key, value) {
			list.push([key, value]);
		}

		/** Horizontal tier ladder with the live pressure marker (system hairline + accent). */
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
					title: "tier " + (i + 1) + ": " + pctOf(tier.ratio) + " \u00b7 keep " + pctOf(tier.retainRatio) + " \u00b7 " + tier.law,
					style: {
						flex: "1", height: "6px", borderRadius: "3px",
						background: consumed ? "var(--dsw-alias-state-business-primary, #4a7dff)"
							: crossed ? "var(--dsw-alias-state-warning-primary, #d9a441)"
							: "var(--dsw-alias-border-l2, #8884)",
						marginRight: "4px",
					},
				}));
			}
			return h("div", { style: { display: "flex", alignItems: "center", margin: "10px 0 12px" } }, children);
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
					inject: function (sessionId) { return { sessionId: sessionId } },
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

		/** Slot wrapper: own state + polling, hand the presenter its props. */
		function CompactionSlot(props) {
			var sessionId = props.sessionId;
			var _a = useState(null), state = _a[0], setState = _a[1];
			var _b = useState(false), busy = _b[0], setBusy = _b[1];
			var _c = useState(""), error = _c[0], setError = _c[1];
			var refresh = useCallback(function () {
				if (!sessionId) return;
				getState(sessionId).then(function (next) { setState(next); setError("") }).catch(function (e) { setError(String(e.message || e)) });
			}, [sessionId]);
			useEffect(function () {
				refresh();
				var timer = setInterval(refresh, 5000);
				return function () { clearInterval(timer) };
			}, [refresh]);
			var run = useCallback(function (action, body) {
				setBusy(true);
				post(action, body).then(function () { return getState(sessionId) }).then(function (next) {
					setState(next); setError("");
				}).catch(function (e) { setError(String(e.message || e)) }).finally(function () { setBusy(false) });
			}, [sessionId]);
			if (!sessionId) return null;
			var children = [];
			if (error) children.push(h("div", { key: "err", style: { padding: "8px 18px", color: "var(--dsw-alias-state-danger-primary, #c0392b)", fontSize: "12px" } }, error));
			children.push(h(CompactionTab, {
				key: "tab", sessionId: sessionId, state: state, busy: busy, refresh: refresh,
				onCompact: function () { run("compact", { sessionId: sessionId }) },
				onRelease: function () {
					if (!window.confirm("Release the takeover? Stock compaction-basic returns and this plugin disables itself.")) return;
					run("release", {});
				},
			}));
			return h("div", null, children);
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
		return module.exports;
	},
});
