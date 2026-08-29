/**
 * dsh-rich-indexing — engine dispatch probe.
 *
 * Proves the runtime wiring the unit tests cannot: service registration on a
 * real cordis Context, the super-dispatch into the overridden summarize(),
 * the tier gate + config swap into basic's pressure path, and the model
 * fallback chain with a scripted stream. Sessions are stubs — the full
 * transaction (lock, surface replacement) stays covered by basic's own
 * specs and the live go-live pass.
 *
 * Run: node --test tests/engine.dispatch.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

/** Resolve dsh packages through the profile's installation-closure fallback. */
const profileRequire = createRequire('/home/sysadmin/.dsh/profiles/web/probe.mjs')
const cordisUrl = profileRequire.resolve('@deepseek-ai/cordis')
const engineUrl = new URL('../src/engine.js', import.meta.url).href
const engineMod = await import(engineUrl).catch(() => null)
const skipReason = engineMod === null
  ? 'bare imports resolve only inside the profile tree — run from a profile-tree copy of this suite'
  : false

async function makeContext() {
  const cordis = await import(cordisUrl)
  const ctx = new cordis.Context()
  return ctx
}

function makeAgent(windowSize, tokens) {
  const session = {
    id: 'probe-session',
    header: {},
    events: [],
    requestHeader: () => ({ config: { provider: 'probe-provider', model: 'probe-model' } }),
    surface: { nodes: [] },
  }
  return {
    options: {},
    session,
    __meter: { totalTokens: tokens, nodes: [] },
    __window: windowSize,
  }
}

function wireStubs(ctx, agent) {
  ctx.tokenMeter = { measure: () => agent.__meter }
  ctx.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: agent.__window }, reasoning: { efforts: [] } }),
    /** Scripted stream: emits the analysis-scratchpad protocol output. */
    stream: async function* (options) {
      wireStubs.lastCall = options
      yield { type: 'text', text: '<analysis>reasoning</analysis><summary>## Primary Request and Intent\n- scripted summary\n</summary>' }
    },
  }
  ctx.sessions = {}
  ctx.get = ctx.get.bind(ctx)
}

/** Module-level capture for stream assertions. */
wireStubs.lastCall = null

/** A well-formed stream: block-start → text-delta → block-end → finish. */
function scriptedStream(text) {
  return async function* (options) {
    wireStubs.lastCall = options
    if (options.provider && options.provider.startsWith("bad")) throw new Error("provider down: " + options.provider)
    yield { type: "block-start", index: 0, blockType: "text" }
    yield { type: "text-delta", index: 0, text }
    yield { type: "block-end", index: 0, block: { type: "text", text } }
    yield { type: "finish", reason: { kind: "stop" } }
  }
}

test('engine registers as the compaction service on a real cordis context', { skip: skipReason }, async () => {
  const ctx = await makeContext()
  const { RichIndexingEngine } = engineMod
  const live = { current: {
    enabled: true,
    tiers: [{ ratio: 0.3, retainRatio: 0.12, law: 'gentle' }],
    models: [{ provider: 'probe-provider', model: 'probe-model', reasoningEffort: 'default' }],
    maxTokens: 8192,
  } }
  const engine = new RichIndexingEngine(ctx, {}, live)

  // cordis hands consumers a tracker-bound face, not the raw instance —
  // assert identity by shape and BEHAVIOR, not by reference.
  const resolved = ctx.get('compaction')
  assert.ok(resolved instanceof RichIndexingEngine, 'resolved face is the tiered engine')

  // Behavioral proof: a pressure reading through the resolved face runs the
  // tier gate end-to-end (45% crosses tier 0; empty surface declines).
  const agent = makeAgent(1000, 450)
  ctx.tokenMeter = { measure: () => agent.__meter }
  ctx.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: agent.__window } }),
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
  }
  ctx.sessions = {}
  const result = await resolved.compactIfNeeded(agent, 'pressure', new AbortController().signal)
  assert.equal(result, null, 'empty surface declines')
  const state = engine.agentState.get(agent)
  assert.ok(state && state.declined && state.declined.index === 0, 'tier 0 fired and declined through the resolved face')
})

test('summarize override: law directive, scratchpad extraction, keyword index, chain', { skip: skipReason }, async () => {
  const ctx = await makeContext()
  const { RichIndexingEngine } = engineMod
  const live = {
    current: {
      enabled: true,
      tiers: [{ ratio: 0.3, retainRatio: 0.12, law: 'consolidating' }],
      models: [
        { provider: 'chain-a', model: 'model-a', reasoningEffort: 'high' },
        { provider: 'chain-b', model: 'model-b', reasoningEffort: 'default' },
      ],
      maxTokens: 4096,
    },
  }
  const engine = new RichIndexingEngine(ctx, {}, live)
  const agent = makeAgent(1000, 100)

  // The chain's first route is what the stub stream sees.
  ctx.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: agent.__window } }),
    stream: scriptedStream('<analysis>hidden reasoning</analysis><summary>## Current Work\n- scripted\n\n## Next Step\n- (none)</summary>'),
  }

  const input = {
    system: 'system prompt',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'worked in /tmp/probe/x.js with loader v2.0.1 loader twice' }] },
    ],
  }
  const result = await engine.summarize(input, agent, undefined)

  // Scratchpad protocol: analysis stripped, summary kept.
  assert.match(result.summary[0].text, /## Current Work/)
  assert.ok(!result.summary[0].text.includes('hidden reasoning'), 'analysis must be stripped')
  // Keyword index appended after the model output.
  assert.ok(result.summary.some(block => block.text.includes('## Keyword Index')), 'index section appended')
  assert.ok(result.summary.some(block => block.text.includes('/tmp/probe/x.js')), 'paths extracted')
  // Envelope records the winning route + call marker.
  assert.equal(result.provider, 'chain-a')
  assert.equal(result.model, 'model-a')
  assert.equal(result.llmStreamCall, true)
  assert.equal(result.maxTokens, 4096)
  // Per-route effort passed to the adapter; purpose pinned.
  assert.equal(wireStubs.lastCall.reasoningEffort, 'high')
  assert.equal(wireStubs.lastCall.purpose, 'compaction')
  assert.equal(wireStubs.lastCall.sessionId, 'probe-session')
})

test('summarize chain: first route fails, second serves; exhaustion falls to the routed target', { skip: skipReason }, async () => {
  const ctx = await makeContext()
  const { RichIndexingEngine } = engineMod
  const live = {
    current: {
      enabled: true,
      tiers: [],
      models: [
        { provider: 'bad', model: 'bad', reasoningEffort: 'default' },
        { provider: 'bad2', model: 'bad2', reasoningEffort: 'default' },
      ],
      maxTokens: 2048,
    },
  }
  const engine = new RichIndexingEngine(ctx, {}, live)
  const agent = makeAgent(1000, 100)
  const attempts = []
  ctx.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: agent.__window } }),
    stream: async function* (options) {
      attempts.push(options.provider)
      if (options.provider !== 'probe-provider') throw new Error('provider down: ' + options.provider)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '## Current Work\n- rescued' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '## Current Work\n- rescued' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello world hello' }] }] }
  const result = await engine.summarize(input, agent, undefined)
  assert.deepEqual(attempts, ['bad', 'bad2', 'probe-provider'], 'chain then last-resort routed target')
  assert.match(result.summary[0].text, /rescued/)
  assert.equal(engine.lastRoute.provider, 'probe-provider')
})

test('tier gate: pressure crossing selects the tier, config swap reaches basic, decline cooldown on null', { skip: skipReason }, async () => {
  const ctx = await makeContext()
  const { RichIndexingEngine } = engineMod
  const live = {
    current: {
      enabled: true,
      tiers: [
        { ratio: 0.3, retainRatio: 0.12, law: 'gentle' },
        { ratio: 0.5, retainRatio: 0.1, law: 'standard' },
        { ratio: 0.7, retainRatio: 0.08, law: 'consolidating' },
        { ratio: 0.9, retainRatio: 0.05, law: 'maximum' },
      ],
      models: [{ provider: 'probe-provider', model: 'probe-model', reasoningEffort: 'default' }],
      maxTokens: 8192,
    },
  }
  const engine = new RichIndexingEngine(ctx, {}, live)
  // 45% pressure: crosses tier 0 (30%) only.
  const agent = makeAgent(1000, 450)
  wireStubsFor(ctx, agent)

  const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
  // The stub session has an empty surface: basic's range selection declines
  // (null) — which proves the gate fired, swapped the tier config, and let
  // basic run its transaction up to range selection.
  assert.equal(result, null)
  const state = engine.agentState.get(agent)
  assert.ok(state, 'agent state tracked')
  assert.equal(state.pointer, -1, 'no tier consumed on a declined pass')
  assert.ok(state.declined && state.declined.index === 0, 'tier 0 declined with cooldown')

  // While cooled down, the same pressure must not re-fire tier 0.
  const again = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
  assert.equal(again, null)

  // Pressure jumping past two tiers skips straight to the highest crossed.
  // The meter spy observes the armed law INSIDE super's pressure path —
  // proof that the tier config swap and law arming reached the transaction.
  agent.__meter.totalTokens = 950
  state.declined = null
  const lawCapture = []
  ctx.tokenMeter.measure = () => { lawCapture.push(engine.activeLaw); return agent.__meter }

  const jumped = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
  assert.equal(jumped, null, 'empty surface still declines the transaction')
  assert.equal(state.pointer, -1, 'pointer did not advance on a declined pass')
  assert.ok(lawCapture.includes('maximum'), '95% pressure armed the maximum law inside super: ' + JSON.stringify(lawCapture))
  assert.equal(engine.activeLaw, null, 'law reset after the pass')
  assert.ok(state.declined && state.declined.index === 3, 'tier 3 declined with cooldown')

  // Overflow trigger delegates with the maximum law regardless of tiers.
  lawCapture.length = 0
  const overflow = await engine.compactIfNeeded(agent, 'context-overflow', new AbortController().signal)
  assert.equal(overflow, null)
  assert.ok(lawCapture.includes('maximum'), 'overflow arms the maximum law: ' + JSON.stringify(lawCapture))
})

/** Wire the stubs the tier-gate path reads (measure + resolveModelInfo + stream). */
function wireStubsFor(ctx, agent) {
  ctx.tokenMeter = { measure: () => agent.__meter }
  ctx.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: agent.__window } }),
    stream: async function* () {
      yield { type: 'text', text: '## Current Work\n- x' }
    },
  }
  ctx.sessions = {}
}
