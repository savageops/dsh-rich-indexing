# dsh-rich-indexing

Tiered, index-aware compaction for DeepSeek Harness. Takes over the
`compaction` service from `compaction-basic` and replaces the single 0.8
cliff with a graduated ladder, escalating consolidation laws, a deterministic
keyword index folded into every checkpoint, and a summarization model chain.

## What changes vs stock compaction

| | stock basic | rich-indexing |
| --- | --- | --- |
| Trigger | one zone (`thresholdRatio: 0.8`) | tier ladder, default **30% / 50% / 70% / 90%** |
| Summarization | one fixed law | four laws, escalating per tier: `gentle` → `standard` → `consolidating` → `maximum` |
| Terminology | model's choice | deterministic **keyword index** (paths, recurring identifiers, versions) merged into every checkpoint; prior index fed back for accumulation |
| Summarizer | one provider/model pair | **primary + up to 3 fallbacks**, each with its own `reasoningEffort`; last resort = the conversation's own route |
| Everything else | — | **inherited unchanged**: lock, head-anchored checkpoint merge, tool-pair balance, overflow recovery, `/compact`, token-meter pricing |

The checkpoint structure stays the stock 8 sections (plus `Problem-Solving
Notes` and verbatim `User Messages` at the gentle/standard tiers), so
downstream consumers see the same durable `<compacted-summary>` shape.

## Takeover semantics (read this)

Cordis allows exactly one provider per service key, so this plugin disables
`compaction-basic` with one managed line in the profile's own
`cordis.patch.yml`:

```yaml
# managed:rich-indexing
- id: compaction-basic
  disabled: true
```

- **Enable**: written automatically at plugin start; the web profile's live
  patch reload swaps the engines without a restart (otherwise after the next
  restart — the panel shows `pending restart` until then).
- **Disable** (toggle the plugin off): the managed line is removed
  automatically; stock compaction returns live. Compaction is never left
  dead by a toggle.
- **Uninstall** (not toggle): has no teardown owner — delete the managed
  block above from `~/.dsh/profiles/web/cordis.patch.yml`, or press
  **Release** in the panel before uninstalling.
- **Release** (`POST /api/rich-indexing/release`): removes the line and
  self-disables the plugin; stock behavior returns.

## Install

```sh
dsh plugin --profile web install ./dsh-rich-indexing
```

Requires the profile to include the token-meter (any deployment running
stock compaction already does). Peer imports (`@deepseek-ai/dsh-compaction-*`,
`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/schemastery`)
resolve through the profile module fallback from the installation closure.

## Configuration

Settings → Plugins → **rich-indexing** (persisted in `~/.dsh/settings.yaml`
under the `rich-indexing` namespace, live-applied), or the equivalent entry
config:

```yaml
enabled: true
tiers:                      # strictly increasing ratios; retain < ratio per tier
  - { ratio: 0.3, retainRatio: 0.12, law: gentle }
  - { ratio: 0.5, retainRatio: 0.1,  law: standard }
  - { ratio: 0.7, retainRatio: 0.08, law: consolidating }
  - { ratio: 0.9, retainRatio: 0.05, law: maximum }
models:                     # primary first; up to 4 routes total
  - { provider: deepseek-official, model: deepseek-reasoner, reasoningEffort: high }
  - { provider: deepseek-official, model: deepseek-v4-flash, reasoningEffort: default }
maxTokens: 8192
```

Empty `models` means "use the conversation's own route" (stock parity). A
crossing of tier N runs one compaction at tier N's law and retention; the
next crossing fires the next tier. `context-overflow` always runs the
maximum law.

## Status API

- `GET  /api/rich-indexing/state?sessionId=…` — pressure fraction vs the
  tier ladder, tier pointer, last compaction facts, model-chain health,
  takeover state, resolved config.
- `POST /api/rich-indexing/compact` `{sessionId}` — the button form of `/compact`.
- `POST /api/rich-indexing/release` — remove the takeover line and self-disable.

Loopback + same-origin guarded, like every plugin-family route.

## Client (module sub-tab + settings card)

The client half registers two slot contributions (no separate build — same
`__ModuleLoader__` facade format as the rest of the plugin family):

- **Compaction** — a `conversation.view` module sub-tab: live pressure vs
  the tier ladder, tier pointer, last checkpoint facts, model-chain health,
  Compact-now and Release actions, 5s auto-refresh.
- **rich-indexing** — a Settings → Plugins card keyed to the settings
  namespace: enabled toggle, maxTokens, the tier table (ratio / keep / law),
  and the model chain editor — provider, model, and effort per route, with
  lists from the host's model catalog. Saves are revision-fenced
  (`remote.settings.mutate`), live-applied, and persisted to
  `~/.dsh/settings.yaml`.

## Testing

```sh
npm test        # 16 unit tests over the pure core (tiering, index, takeover line, laws)
```

## Design

See [DESIGN.md](./DESIGN.md) — the architecture copycats DSH's compaction
capability seam (engine subclass, sanctioned hook points) and adopts the
applicable strategies from the [OpenSDD context-compactor](https://github.com/deepagents-ai/OpenSDD/blob/main/skills/context-compactor/SKILL.md)
(structured template with recall sections, analysis scratchpad, no-recursion,
always-recoverable summarizer).

## License

[MIT](./LICENSE)
