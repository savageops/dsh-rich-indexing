/**
 * dsh-rich-indexing — host half.
 *
 * Takes over session compaction with a tiered engine (see DESIGN.md):
 *
 *  1. Upserts one managed takeover line into the profile's cordis.patch.yml
 *     (`compaction-basic: disabled: true` under `# managed:rich-indexing`) —
 *     cordis refuses a second provider for the `compaction` service, so the
 *     stock engine must be off before the tiered engine can register. The
 *     web profile hot-reloads the user patch, so the swap goes live without
 *     a restart (cold boot: the line is already applied at compose time).
 *  2. Registers the RichIndexingEngine (a BasicCompactionEngine subclass)
 *     as the `compaction` service the moment the stock engine is gone.
 *  3. Registers the `rich-indexing` settings namespace (schema + live
 *     watch) — the Settings → Plugins card and this host share it.
 *  4. Serves /api/rich-indexing/{state,compact,release} for the client.
 *  5. On fiber dispose (plugin toggled off), removes the takeover line so
 *     stock compaction returns live. Compaction is never left dead.
 *
 * @module dsh-rich-indexing/host
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

import { RichIndexingEngine } from './engine.js'
import {
  MANAGED_MARKER,
  SELF_ENTRY_ID,
  STOCK_ENTRY_ID,
  hasManagedLine,
  removeManagedLine,
  resolveLiveConfig,
  upsertManagedLine,
  validateLiveConfig,
} from './host-pure.js'

export const name = 'dsh-rich-indexing'
export const inject = ['webServer', 'agents', 'llm']

const API_PREFIX = '/api/rich-indexing'
const POLL_INTERVAL_MS = 300
const POLL_TIMEOUT_MS = 15_000

/** Entry/namespace schema (per-field only; cross-field rules live in validateLiveConfig). */
export const Config = z.object({
  enabled: z.boolean(),
  tiers: z.array(z.object({
    ratio: z.number(),
    retainRatio: z.number(),
    law: z.string(),
  })),
  models: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
  })),
  maxTokens: z.number().min(1),
})

/** Home of the DSH deployment: $DSH_HOME, else ~/.dsh. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * Resolve the booted profile's patch file. ctx.baseUrl is unreliable in a
 * plugin context, so anchors are tried in order: ancestors of ctx.baseUrl,
 * then every $DSH_HOME/profiles/* that carries a patch file — preferring the
 * profile whose node_modules holds this very package (proof it is the booted
 * tree), falling back to the only candidate when there is exactly one.
 * (Copycat of dsh-plugin-toggle's proven resolver.)
 */
function resolvePatchPath(baseUrl) {
  const anchors = []
  if (typeof baseUrl === 'string') {
    const path = isAbsolute(baseUrl) ? baseUrl : resolve(baseUrl)
    anchors.push(path, dirname(path))
  } else if (baseUrl instanceof URL) {
    const path = fileURLToPath(baseUrl)
    anchors.push(path, dirname(path))
  }
  for (const anchor of anchors) {
    const patch = resolve(anchor, 'cordis.patch.yml')
    if (existsSync(patch)) return patch
  }
  const profilesRoot = join(dshHome(), 'profiles')
  let entries
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const patch = join(profilesRoot, entry.name, 'cordis.patch.yml')
    if (existsSync(patch)) candidates.push(patch)
  }
  const selfMarker = (patch) => existsSync(join(dirname(patch), 'node_modules', 'dsh-rich-indexing'))
  return candidates.find(selfMarker) ?? (candidates.length === 1 ? candidates[0] : undefined)
}

/** The durable provider/model of the latest routed request on a session. */
function routedTargetOf(session) {
  const config = session?.requestHeader?.()?.config
  if (config === undefined || config?.provider?.length === 0 || config?.model?.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/** The session's own (post-seed) events — fork children must not read the seed. */
function ownEvents(session) {
  const events = Array.isArray(session?.events) ? session.events : []
  const boundary = Number(session?.header?.seedLength) > 0 ? Number(session.header.seedLength) : 0
  return boundary > 0 ? events.slice(boundary) : events
}

/** Last compaction facts from the durable log, for the state route. */
function lastCompactionOf(session) {
  for (let i = ownEvents(session).length - 1; i >= 0; i -= 1) {
    const event = ownEvents(session)[i]
    if (event?.type === 'compaction/summary') {
      return {
        kind: 'summary',
        provider: event.data?.provider ?? null,
        model: event.data?.model ?? null,
        shadowedTokens: event.data?.shadowedTokenCount ?? null,
        shadowedNodes: Array.isArray(event.data?.shadowedSeqs) ? event.data.shadowedSeqs.length : null,
      }
    }
    if (event?.type === 'compaction/end') {
      return { kind: event.data?.error !== undefined ? 'error' : 'end', error: event.data?.error ?? null }
    }
  }
  return null
}

/** Loopback + same-origin guard (plugin-family posture; DSH core fences /api, plugins fence their own routes). */
function guard(req, res) {
  const remote = req.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const site = req.headers['sec-fetch-site']
  const browser = site === 'same-origin' || typeof req.headers.origin === 'string'
  if (!loopback || !browser) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
    return false
  }
  return true
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req, limit = 2_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config - composition entry config (base layer).
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger('rich-indexing')
  const live = { current: resolveLiveConfig(config) }

  // ── 1. Settings namespace: the Settings → Plugins card writes here. ────────
  let scope = null
  try {
    const settings = ctx.get?.('settings')
    if (settings?.register !== undefined) {
      scope = settings.register(settingsNamespace('rich-indexing'), Config, {
        base: config,
        validate: (value) => validateLiveConfig(resolveLiveConfig(value)),
      })
      live.current = resolveLiveConfig(scope.get())
      scope.watch?.(() => {
        try {
          live.current = resolveLiveConfig(scope.get())
          log.info('settings updated: tiers=' + live.current.tiers.length + ' models=' + live.current.models.length)
        } catch (error) {
          log.warn('settings apply failed, keeping last good: ' + (error?.message ?? error))
        }
      })
    }
  } catch (error) {
    log.warn('settings namespace unavailable, entry config only: ' + (error?.message ?? error))
  }

  // ── 2. Takeover line: stock compaction must be off before we can own it. ──
  const patchPath = resolvePatchPath(ctx.baseUrl)
  let takeoverWritten = false
  if (patchPath !== undefined) {
    try {
      const text = readFileSync(patchPath, 'utf8')
      if (!hasManagedLine(text)) {
        writeFileSync(patchPath, upsertManagedLine(text))
        takeoverWritten = true
        log.info('takeover line written to ' + patchPath + ' — recomposition will unmount compaction-basic')
      }
    } catch (error) {
      log.warn('takeover line not written: ' + (error?.message ?? error))
    }
  } else {
    log.warn('profile cordis.patch.yml not found — takeover line not managed')
  }

  // ── 3. Engine registration once the stock engine is gone. ─────────────────
  let engine = null
  let takeoverState = 'pending'
  const tryRegister = () => {
    if (engine !== null) return true
    if (ctx.get?.('tokenMeter') === undefined) {
      takeoverState = 'blocked: tokenMeter service absent'
      return false
    }
    if (ctx.get?.('compaction') !== undefined) return false
    try {
      engine = new RichIndexingEngine(ctx, config, live)
      takeoverState = 'active'
      log.info('tiered compaction engine registered as the compaction service')
      return true
    } catch (error) {
      takeoverState = 'blocked: ' + String(error?.message ?? error)
      log.error('engine registration failed: ' + (error?.message ?? error))
      return true
    }
  }
  if (!tryRegister()) {
    const started = Date.now()
    const timer = setInterval(() => {
      if (tryRegister() || Date.now() - started > POLL_TIMEOUT_MS) {
        clearInterval(timer)
        if (engine === null && takeoverState === 'pending') {
          takeoverState = 'pending restart: compaction-basic still mounted'
          log.warn('compaction-basic still mounted after ' + POLL_TIMEOUT_MS / 1000 + 's — takeover completes after a restart')
        }
      }
    }, POLL_INTERVAL_MS)
    // The poll must not hold the fiber open: unref when available.
    timer?.unref?.()
  }

  // ── 4. Teardown: toggling the plugin off restores stock compaction. ───────
  const releaseTakeover = () => {
    if (patchPath === undefined) return
    try {
      const text = readFileSync(patchPath, 'utf8')
      if (hasManagedLine(text)) {
        writeFileSync(patchPath, removeManagedLine(text))
        log.info('takeover line removed — stock compaction-basic restores on recomposition')
      }
    } catch (error) {
      log.warn('takeover line cleanup failed (delete the # managed:rich-indexing block by hand): '
        + (error?.message ?? error))
    }
  }
  // The plugin's own fiber carries the engine service; its disposal must also
  // drop the takeover line, or stock compaction stays off with nobody owning it.
  ctx.fiber?.effect?.(releaseTakeover)

  // ── 5. Routes. ─────────────────────────────────────────────────────────────
  const routes = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/state`,
      handler: async (req, res) => {
        if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!guard(req, res)) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const agent = sessionId !== '' ? ctx.agents?.get?.(sessionId) : undefined
        let sessionState = null
        if (agent !== undefined) {
          const target = routedTargetOf(agent.session)
          let window = null
          let tokens = null
          let fraction = null
          if (target !== undefined) {
            try {
              const info = await ctx.llm.resolveModelInfo(target.provider, target.model)
              window = info?.context?.contextWindow ?? null
            } catch { window = null }
          }
          if (window !== null) {
            try {
              tokens = ctx.tokenMeter.measure(agent.session).totalTokens
              fraction = window > 0 ? tokens / window : null
            } catch { tokens = null }
          }
          sessionState = {
            routed: target ?? null,
            window,
            tokens,
            fraction,
            ...(engine !== null ? { engine: engine.agentStatus(agent, window) } : {}),
            lastCompaction: lastCompactionOf(agent.session),
          }
        }
        writeJson(res, 200, {
          ok: true,
          state: {
            takeover: {
              engineRegistered: engine !== null,
              state: takeoverState,
              linePresent: patchPath !== undefined && hasManagedLine(readFileSync(patchPath, 'utf8')),
              fallbackLog: engine?.fallbackLog ?? [],
              lastRoute: engine?.lastRoute ?? null,
            },
            session: sessionState,
            config: live.current,
          },
        })
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/compact`,
      handler: async (req, res) => {
        if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!guard(req, res)) return
        let body
        try { body = await readJsonBody(req) } catch (error) {
          writeJson(res, 400, { ok: false, error: error?.message ?? 'bad-request' })
          return
        }
        const agent = typeof body?.sessionId === 'string' ? ctx.agents?.get?.(body.sessionId) : undefined
        if (agent === undefined) { writeJson(res, 409, { ok: false, error: 'session-offline' }); return }
        try {
          const controller = new AbortController()
          const result = await ctx.compaction.compactNow(agent, controller.signal)
          writeJson(res, 200, {
            ok: true,
            compacted: result === null ? null : {
              shadowedTokens: result.shadowedTokenCount,
              shadowedNodes: result.shadowedSeqs.length,
            },
          })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/release`,
      handler: async (req, res) => {
        if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!guard(req, res)) return
        if (patchPath === undefined) { writeJson(res, 409, { ok: false, error: 'patch-file-unknown' }); return }
        try {
          // ONE atomic write, ONE recomposition: the stock-disable block goes
          // away and this plugin self-disables in the same patch revision —
          // so the engine release and the stock remount land together, with
          // no moment where `compaction` has two owners or none.
          let text = readFileSync(patchPath, 'utf8')
          text = removeManagedLine(text, STOCK_ENTRY_ID)
          text = upsertManagedLine(text, SELF_ENTRY_ID, true)
          writeFileSync(patchPath, text)
          writeJson(res, 200, {
            ok: true,
            note: 'takeover released and the plugin self-disabled in one patch write; stock compaction restores on recomposition',
          })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
  ]
  const disposers = routes.map((route) => ctx.webServer.register(route))
  void disposers
}
