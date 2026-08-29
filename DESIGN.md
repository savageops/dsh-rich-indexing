# rich-indexing — compaction hub

A DSH plugin that takes over session compaction and runs it as a tiered,
index-aware, multi-model pipeline. v1 owns the **compaction module**; the
plugin identity is the hub for future modules (folder-indexing, etc.).

## Why it exists

Stock `compaction-basic` compacts once, at one fixed zone (default
`thresholdRatio: 0.8`), with one fixed summarization law and one
provider/model pair (no fallback, no per-call effort). Long sessions get one
cliff instead of a graduated response, and a busy or failing summary model
blocks the only recovery path.

## Architecture — copycat of the compaction capability seam

The seam (`.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md`)
splits contract from backend: abstract `CompactionEngine` (`compactIfNeeded`,
`compactNow`, `compactRegion`), `summarize()` as the **sole subclass hook**,
`compactIfNeeded` **dynamically dispatched** so subclass overrides are honored
at event time. rich-indexing is a backend, not a parallel system:

```
RichIndexingEngine extends BasicCompactionEngine
  inherits: compaction/* event vocabulary, log-recorded lock, head-anchored
    single-checkpoint merge, tool-pairing balance, ctx.tokenMeter pricing,
    overflow recovery wiring, /compact compactNow, surface replacement
    (checkpoint user/message with surfaceOp replace)
  overrides:
    compactIfNeeded()  — single 0.8 zone → tier ladder
    summarize()        — fixed law → tier-law + model fallback chain
```

### Tier ladder (the "aggression" curve)

Configurable ratios, default `[0.30, 0.50, 0.70, 0.90]`. Each tier carries:

| field         | meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `ratio`       | pressure fraction of the routed model's context window that triggers |
| `retainRatio` | verbatim tail kept (smaller = more aggressive)                       |
| `law`         | `gentle` \| `standard` \| `consolidating` \| `maximum` — the summarization directive variant |

Pressure crossing tier N fires **one** compaction at tier N's policy; after
commit the pointer advances, so the next crossing fires the next tier —
the same head-anchored checkpoint merge that basic already performs, but
each pass condenses with a stronger law and a smaller retained tail. Tiers
must be strictly increasing in ratio, and each `retainRatio` must stay below
its tier ratio (the basic invariant, kept).

### Tier laws

All four laws emit the same durable checkpoint structure (the
`COMPACTION_INSTRUCTION` sections — never drop a section), differing only in
consolidation pressure:

- **gentle** — summarize the oldest segment; keep near-verbatim detail.
- **standard** — the stock basic law (sentence-for-sentence parity target).
- **consolidating** — merge redundant statements: many sentences that say
  the same thing become one; keep every distinct fact, path, decision, and
  quoted user correction.
- **maximum** — hardest consolidation pass; drop superseded detail, keep the
  index section and every still-true decision.

### Keyword index

Model-free lexical extraction over the shadowed region *before* the LLM
call: file paths, frequent non-stopword identifiers, and version-like
tokens — terms that *identify this session*, with a ~230-entry stopword
vocabulary (function words, discourse filler, generic tech nouns like
file/output/value that discriminate nothing) keeping the index signal-heavy.
The index merges into the checkpoint frame as a dedicated section inside
`<compacted-summary>` — durable, replay-safe, **no new session event type**.
On the next compaction the prior index (read from the previous checkpoint)
is handed to the summarizer so facts accumulate instead of being re-derived.

### Adopted strategies (OpenSDD context-compactor)

The [context-compactor skill](https://github.com/deepagents-ai/OpenSDD/blob/main/skills/context-compactor/SKILL.md)
(shaped for SDK-run-loop harnesses) maps onto DSH's seam almost entirely
through what basic already inherits — the parts this plugin adds:

| Skill strategy | rich-indexing realization |
| --- | --- |
| Structured 9-section summary | Core 8 sections (stock) + `Problem-Solving Notes` + `User Messages (verbatim)` at gentle/standard; folded away at consolidating/maximum where compression is the point |
| Analysis scratchpad | `<analysis>` reasoning then `<summary>` payload; deterministic extraction keeps only `<summary>`, full-text fallback when tags are absent; skipped at maximum (token cap economy) |
| Raw-truncation safety net | Adapted: the chain walks primary → fallbacks → **the conversation's own routed target** (warm, demonstrably working) before giving up; guaranteed-fit overflow coverage stays with stock `agent/request-error` recovery + the tool-result pruner |
| Post-tool-result size caps | `ctx.toolResultPruner` runs before summary selection (inherited wiring) |
| summaryModel configurable, default ≠ expensive primary | The settings chain is exactly that; deliberate deviation: an empty chain falls back to the routed target (parity with basic), and the settings card nudges toward a small fast model |
| No recursion | Bounded `compactionRetries` loop (inherited) |
| Verbatim recent preservation | Per-tier `retainRatio` tail (inherited) |
| Token counting accuracy | `ctx.tokenMeter` replay fold (inherited — strictly better than the skill's heuristic ladder) |
| Invariants (never exceed window, keep pairs, preserve tail, never touch system prompt / latest user message) | All inherited; asserted in tests where pure |

### Model fallback chain

Configured chain: one responsible model + up to 3 fallbacks, each
`{ provider, model, reasoningEffort }`. `summarize()` walks the chain:

1. try the entry's route with `reasoningEffort` passed as
   `GenerateOptions.reasoningEffort` (per-call field, verified in
   `@deepseek-ai/dsh-llm` types);
2. the call copycats `summarizeWithLlm` exactly: prefix-cache replay
   (conversation system + tools + messages, directive as trailing user
   message, `purpose: 'compaction'`, `BlockAssembler`, no-image projection,
   `rawOutput` + `llmStreamCall` envelope);
3. on `LlmError` / `max-tokens` truncation / empty text / abort → next entry;
4. the route that actually wrote the summary is what the
   `compaction/summary` envelope records (reconstructability preserved);
5. all entries fail → throw through the inherited failure taxonomy
   (`compaction/end` carries `error`).

## Takeover mechanics

Cordis hard rule: providing an already-provided service name **throws**
(`service "compaction" has been registered at ...`) — one owner per key.
DSH's accepted pattern for exclusive capabilities (shell README): *"a profile
layer selects exactly one executor implementation; mounting two fails loud on
the duplicate service registration."* A user plugin's swap surface is the
**user patch layer**:

- at `apply()` the host upserts one managed line into the profile's
  `cordis.patch.yml` (copycat of `dsh-plugin-toggle`'s
  `# managed:plugin-toggle` upsert):
  `- id: compaction-basic` / `disabled: true` under `# managed:rich-indexing`.
- the web profile hot-reloads the user patch → the tree recomposes live →
  basic unmounts, its `compaction` service releases; the engine then
  instantiates and self-registers (its `Service` constructor does the
  `ctx.provide`). Cold boot order is the same end state, reached at
  composition time.
- teardown (toggle-off / unmount): the fiber disposal path removes the
  managed line → live re-composition remounts basic. The plugin is either
  **on** (basic off, tiered engine) or **off** (basic on, stock 0.8
  behavior). Compaction is never left dead by a toggle.
- known limit: *uninstalling* the package (not toggling) has no teardown
  owner — one managed YAML line remains and must be deleted, or the sub-tab's
  release action does it while installed. Documented in the README.

## Settings — its own row in Settings → Plugins

`ctx.settings.register(settingsNamespace('richIndexing'), Schema, { base: entryConfig })`
— user layer in the harness-home settings document, live changes,
`watch` reconfigures the running engine without restart.

Schema (all JSON-compatible, validated at registration and on every update):

```
{
  enabled: boolean,
  tiers:   [{ ratio, retainRatio, law }],   // strictly increasing ratios
  models:  [{ provider, model, reasoningEffort }],  // 1..4 entries
  maxTokens: number                          // summary generation cap
}
```

Route validation is live against `ctx.llm.listConfigurableProviders()` +
`resolveModelInfo` (60s cache; `effortsUnknown` distinguishes a transient
fetch failure from a model with no efforts — the rich-context idiom).

## Status API (host routes, loopback + same-origin guard)

- `GET  /api/rich-indexing/state` — per-session pressure %, tier pointer,
  last `compaction/*` event facts, resolved config echo, takeover state.
- `POST /api/rich-indexing/config` — settings update
  (`ctx.settings.update` with `expectedRevision` — stale writer refused).
- `POST /api/rich-indexing/compact` — manual compaction for the sub-tab
  (`ctx.compaction.compactNow` — the button form of `/compact`).
- `POST /api/rich-indexing/release` — removes the managed line; restores
  stock basic compaction live.

## UI

Client bundle follows the established rich-plugin family: self-healing
sidebar entry in the task-board family chain, overlay panel, DSW CSS
variables, `/api/rich-indexing/*` fetch. v1 tabs: **Compaction** (live
pressure vs tier ladder, last compaction, model chain status) and
**Settings** (tier ratio/retain sliders, law selects, model chain editor —
copycat of DSH's own provider/model/effort picker pattern). The module
sub-tab takeover lands where DSH allows plugin surfaces (the UI research
receipt decides: module sub-tab registration if open, else the family panel
above).

## Testing

- pure: tier selection (pressure → tier pointer + retain invariant),
  managed-line upsert YAML round-trip, fallback-chain decision, keyword
  extraction, law selection.
- dispatch probe (landed): real cordis Context + scripted stream from the
  profile tree — registration as `ctx.compaction`, super dispatch, tier gate
  + law arming, chain walk to the routed last resort.
- integration: full transaction against a real session (template:
  `compaction-basic/tests/manual-compaction.spec.ts`) — lands with the
  live go-live pass.
- live: restart, real session crossing each configured tier, sub-tab
  readback, toggle-off restores stock compaction.
