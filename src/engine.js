/**
 * dsh-rich-indexing — engine half.
 *
 * RichIndexingEngine extends BasicCompactionEngine and overrides exactly the
 * two points the compaction capability seam allows: the trigger policy
 * (compactIfNeeded — a tier ladder instead of one fixed 0.8 zone) and the
 * summarizer (summarize — tier-law directive plus a model fallback chain).
 *
 * Everything else is inherited and untouched: the compaction/* event
 * vocabulary, the log-recorded lock, head-anchored checkpoint merging,
 * tool-pairing balance, token-meter pricing, overflow recovery, and the
 * surface replacement transaction.
 *
 * The base checkpoint instruction text is from DSH's compaction-basic
 * (MIT, © 2026 DeepSeek), extended per tier.
 *
 * @module dsh-rich-indexing/engine
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, LlmError, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  buildDirective,
  extractKeywordIndex,
  extractSummaryContent,
  formatIndex,
  priorIndexFromSummary,
  selectTier,
} from './host-pure.js'

/** Steps a declined tier waits before it may be retried (un-compactable tail). */
const DECLINE_COOLDOWN_STEPS = 3

/** Map a terminal summarization finish to its fail-closed error (basic parity). */
function finishError(finish) {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message)
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/**
 * One summarization attempt on one exact route. Copycat of basic's
 * summarizeWithLlm: prefix-cache replay (conversation system + tools +
 * messages, directive as trailing user message), purpose 'compaction'.
 * Differences: the route is fixed by the fallback chain, the effort is
 * per-route, and the directive is tier-law.
 */
async function summarizeRoute(ctx, route, input, agent, maxTokens, directive, signal) {
  const assembler = new BlockAssembler()
  const messages = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: directive }],
      source: { kind: 'plugin', plugin: 'dsh-rich-indexing' },
    }),
  ]
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    ...(route.reasoningEffort !== 'default' ? { reasoningEffort: route.reasoningEffort } : {}),
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  if (contentHasImage(rawOutput)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  // Analysis-scratchpad protocol: keep only the <summary> content when the
  // model followed the protocol; fall back to the full text output.
  const summary = extractSummaryContent(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: route.provider,
    model: route.model,
    maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/** The exact provider/model durably routed for the latest request. */
function routedTarget(session) {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * The tiered compaction backend.
 *
 * Construction is owned by the plugin host (which also owns the takeover
 * line): `new RichIndexingEngine(ctx, entryConfig, liveRef)` self-registers
 * as the `compaction` service through the inherited Service constructor.
 */
export class RichIndexingEngine extends BasicCompactionEngine {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {object} entryConfig - composition entry config (base layer).
   * @param {{current: object}} liveRef - mutable live-config holder; the
   *   host updates `liveRef.current` on every settings commit.
   */
  constructor(ctx, entryConfig, liveRef) {
    // Basic config is inert under the tier override (the pressure path is
    // replaced); valid stock values keep its validation and the overflow
    // path intact.
    super(ctx, { thresholdRatio: 0.9, retainRatio: 0.16, maxTokens: 8192, auto: true })
    this.liveRef = liveRef
    this.entryConfig = entryConfig
    /** @type {WeakMap<object, {pointer: number, declined: {index: number, remaining: number}|null}>} */
    this.agentState = new WeakMap()
    /** @type {{provider: string, model: string, reasoningEffort: string}|null} */
    this.lastRoute = null
    /** @type {Array<{route: string, error: string}>} */
    this.fallbackLog = []
    /** @type {string|null} */
    this.activeLaw = null
    void entryConfig
  }

  /** The current live config (settings snapshot or entry base). */
  snapshot() {
    return this.liveRef.current
  }

  /** Per-agent tier pointer bookkeeping. */
  stateFor(agent) {
    let state = this.agentState.get(agent)
    if (state === undefined) {
      state = { pointer: -1, declined: null }
      this.agentState.set(agent, state)
    }
    return state
  }

  /**
   * Tiered pressure path; overflow and everything below it stay stock.
   * @override
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (trigger === 'context-overflow') {
      this.activeLaw = 'maximum'
      try {
        return await super.compactIfNeeded(agent, trigger, signal)
      } finally {
        this.activeLaw = null
      }
    }

    const cfg = this.snapshot()
    if (cfg.enabled !== true) return null
    const target = routedTarget(agent.session)
    if (target === undefined) return null

    // Capacity comes from the route-owning adapter (same call stock makes).
    let window
    try {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
      window = info?.context?.contextWindow
    } catch {
      window = undefined
    }
    if (window === undefined || !(window > 0)) {
      // No capacity metadata: defer to the stock path (it warns once per target).
      return super.compactIfNeeded(agent, trigger, signal)
    }

    const state = this.stateFor(agent)
    if (state.declined !== null) {
      state.declined.remaining -= 1
      if (state.declined.remaining <= 0) state.declined = null
    }
    const pressure = this.ctx.tokenMeter.measure(agent.session).totalTokens / window
    const tierIndex = selectTier(cfg.tiers, pressure, state.pointer, state.declined)
    if (tierIndex === -1) return null
    const tier = cfg.tiers[tierIndex]

    // Run the stock pressure transaction with this tier's policy: swap the
    // resolved config, let super do measurement, pruning, range selection,
    // locking, and retries. summarize() dispatches to the tier law.
    this.activeLaw = tier.law
    const previous = this.config
    try {
      this.config = {
        ...previous,
        thresholdRatio: tier.ratio,
        retainRatio: tier.retainRatio,
        retainTokens: undefined,
        summarizationProvider: '',
        summarizationModel: '',
        maxTokens: cfg.maxTokens,
        modelPolicies: [],
      }
      const result = await super.compactIfNeeded(agent, trigger, signal)
      if (result !== null) {
        state.pointer = tierIndex
        state.declined = null
      } else {
        state.declined = { index: tierIndex, remaining: DECLINE_COOLDOWN_STEPS }
      }
      return result
    } finally {
      this.config = previous
      this.activeLaw = null
    }
  }

  /**
   * Tier-law summarization with the model fallback chain.
   * @override
   */
  async summarize(input, agent, signal) {
    const cfg = this.snapshot()
    const law = this.activeLaw ?? 'standard'
    const priorIndex = this.priorIndex(agent.session)
    const directive = buildDirective(law, priorIndex)

    // An empty configured chain means "use the conversation's route" —
    // stock resolution, so a fresh install behaves like basic.
    const target = routedTarget(agent.session)
    const chain = cfg.models.length > 0
      ? cfg.models
      : target === undefined
        ? []
        : [{ provider: target.provider, model: target.model, reasoningEffort: 'default' }]
    if (chain.length === 0) {
      throw new Error(
        'rich-indexing: no summarization route: configure models, or route one request first',
      )
    }

    let lastError = null
    for (const route of chain) {
      signal?.throwIfAborted()
      try {
        const result = await summarizeRoute(this.ctx, route, input, agent, cfg.maxTokens, directive, signal)
        // Deterministic index appended to the durable summary: survives
        // replay inside the checkpoint frame, needs no new event type.
        const indexBody = formatIndex(extractKeywordIndex(input.messages))
        result.summary = [...result.summary, {
          type: 'text',
          text: `\n\n## Keyword Index\n${indexBody}`,
        }]
        this.lastRoute = { ...route }
        this.fallbackLog.length = 0
        return result
      } catch (error) {
        if (signal !== undefined && signal.aborted) throw error
        lastError = error
        this.fallbackLog.push({
          route: `${route.provider}/${route.model}`,
          error: String(error?.message ?? error),
        })
        if (this.fallbackLog.length > 8) this.fallbackLog.shift()
      }
    }
    // Safety net (adapted from the OpenSDD context-compactor's "always
    // recoverable" rule): the conversation's own routed target is warm and
    // demonstrably working — try it before giving up and leaving the
    // pressure to the stock overflow backstop.
    if (target !== undefined
      && !chain.some(route => route.provider === target.provider && route.model === target.model)) {
      signal?.throwIfAborted()
      try {
        const result = await summarizeRoute(this.ctx, {
          provider: target.provider,
          model: target.model,
          reasoningEffort: 'default',
        }, input, agent, cfg.maxTokens, directive, signal)
        const indexBody = formatIndex(extractKeywordIndex(input.messages))
        result.summary = [...result.summary, {
          type: 'text',
          text: `\n\n## Keyword Index\n${indexBody}`,
        }]
        this.lastRoute = { provider: target.provider, model: target.model, reasoningEffort: 'default' }
        this.fallbackLog.length = 0
        return result
      } catch (error) {
        if (signal !== undefined && signal.aborted) throw error
        lastError = error
        this.fallbackLog.push({
          route: `${target.provider}/${target.model} (last resort)`,
          error: String(error?.message ?? error),
        })
      }
    }
    throw lastError
  }

  /** Read the keyword index body from the most recent prior checkpoint. */
  priorIndex(session) {
    const events = Array.isArray(session?.events) ? session.events : []
    const boundary = Number(session?.header?.seedLength) > 0 ? Number(session.header.seedLength) : 0
    for (let i = events.length - 1; i >= boundary; i -= 1) {
      const event = events[i]
      if (event?.type === 'compaction/summary') {
        return priorIndexFromSummary(event.data?.summary)
      }
    }
    return null
  }

  /** State route facts for one agent. */
  agentStatus(agent, window) {
    const state = this.agentState.get(agent) ?? { pointer: -1, declined: null }
    const cfg = this.snapshot()
    return {
      tierPointer: state.pointer,
      tierLabel: state.pointer >= 0 ? cfg.tiers[state.pointer] : null,
      nextTier: state.pointer + 1 < cfg.tiers.length ? cfg.tiers[state.pointer + 1] : null,
      declined: state.declined,
      window: window ?? null,
      lastRoute: this.lastRoute,
      fallbackLog: [...this.fallbackLog],
    }
  }
}

export default RichIndexingEngine
