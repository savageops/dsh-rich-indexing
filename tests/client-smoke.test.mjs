/**
 * dsh-rich-indexing — client smoke test.
 *
 * Executes the real client factory (window.__ModuleLoader__ shim + stub
 * require) and CALLS the registered slot components with stub props.
 * Syntax checks cannot catch unbound identifiers inside render bodies —
 * this test exists because exactly that bug blanked the live sub-tab.
 *
 * Run: node --test tests/client-smoke.test.mjs  (no dsh packages needed)
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const bundlePath = fileURLToPath(new URL('../src/client.bundle.js', import.meta.url))
const bundleSource = readFileSync(bundlePath, 'utf8')

/** Minimal element stub: records type/props/children without rendering. */
function el(type, props, ...children) {
  return { $: 'element', type, props: props || {}, children }
}
const reactStub = {
  createElement: el,
  useState: () => [null, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}
const primitivesStub = new Proxy({}, {
  get: (target, name) => function Primitive(props, ...children) { return el(String(name), props, ...children) },
})

/** Load the bundle through a facade shim; returns the module exports. */
function loadClient() {
  const registered = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          const require = (spec) => {
            if (spec === 'react') return reactStub
            if (spec.startsWith('@deepseek-ai/dsh-client-ui-primitives')) return primitivesStub
            throw new Error('unexpected require: ' + spec)
          }
          const mod = factory(require)
          return { id, mod }
        },
      },
    },
  }
  const run = new Function('window', 'el', 'reactStub', 'primitivesStub', `
    with (window) { ${bundleSource} }`)
  // The bundle self-executes window.__ModuleLoader__.load(...); capture its return.
  let loaded = null
  const shimWindow = {
    __ModuleLoader__: {
      load: (spec) => {
        const require = (specName) => {
          if (specName === 'react') return reactStub
          if (String(specName).startsWith('@deepseek-ai/dsh-client-ui-primitives')) return primitivesStub
          throw new Error('unexpected require: ' + specName)
        }
        loaded = { id: spec.id, mod: spec.factory(require) }
        return loaded
      },
    },
  }
  new Function('window', bundleSource)(shimWindow)
  assert.ok(loaded, 'the bundle registered itself through __ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-rich-indexing')
  assert.deepEqual(loaded.mod.inject, ['slots', 'locale', 'remote.session', 'remote.settings'])
  assert.equal(typeof loaded.mod.apply, 'function')
  return loaded.mod
}

/** Stub ctx for apply(): captures slot registrations. */
function stubApply(mod) {
  const registrations = []
  const ctx = {
    'remote.session': { modelCatalog: async () => ({ groups: [], default: { provider: 'p', model: 'm' } }) },
    'remote.settings': {
      describe: async () => ({ writable: true, namespaces: [] }),
      mutate: async () => ({}),
    },
    locale: { register: () => ({}) },
    effect: (fn, label) => { fn(); return () => {} },
    slots: {
      inject: (name, factory) => {
        const first = factory()
        if (first && typeof first[Symbol.iterator] === 'function') {
          for (const reg of first) registrations.push({ name, ...reg.spec, component: reg.component })
        } else {
          const reg = factory()
          registrations.push({ name, ...reg.spec, component: reg.component })
        }
      },
      register: (spec, component) => ({ spec, component }),
    },
  }
  mod.apply(ctx)
  return registrations
}

test('client factory loads, applies, and registers both slots', () => {
  const mod = loadClient()
  const registrations = stubApply(mod)
  const tab = registrations.find(r => r.name === 'conversation.view')
  const card = registrations.find(r => r.name === 'settings.plugin.item')
  assert.ok(tab, 'conversation.view slot registered')
  assert.equal(tab.id, 'rich-indexing')
  assert.equal(typeof tab.inject, 'function')
  assert.equal(tab.inject('session-1').sessionId, 'session-1')
  assert.ok(card, 'settings.plugin.item slot registered')
  assert.equal(card.key, 'rich-indexing')
  assert.equal(typeof card.component, 'function')
})

test('CompactionTab renders full state without unbound identifiers', () => {
  const mod = loadClient()
  const registrations = stubApply(mod)
  const tab = registrations.find(r => r.name === 'conversation.view')
  const state = {
    takeover: {
      engineRegistered: true,
      state: 'active',
      linePresent: true,
      lastRoute: { provider: 'chain-a', model: 'model-a', reasoningEffort: 'high' },
      fallbackLog: [{ route: 'chain-b/model-b', error: 'down' }],
    },
    session: {
      routed: { provider: 'zai', model: 'glm' },
      window: 1000000,
      tokens: 350000,
      fraction: 0.35,
      engine: { tierPointer: 0, nextTier: { ratio: 0.5, retainRatio: 0.1, law: 'standard' } },
      lastCompaction: { kind: 'summary', provider: 'chain-a', model: 'model-a', shadowedTokens: 4200 },
      history: [
        { kind: 'summary', at: '2026-08-29T16:00:00Z', provider: 'chain-a', model: 'model-a', shadowedTokens: 4200, shadowedNodes: 40 },
        { kind: 'error', at: '2026-08-29T15:00:00Z', error: 'route down' },
      ],
    },
    config: {
      enabled: true,
      maxTokens: 8192,
      tiers: [
        { ratio: 0.3, retainRatio: 0.12, law: 'gentle' },
        { ratio: 0.5, retainRatio: 0.1, law: 'standard' },
        { ratio: 0.7, retainRatio: 0.08, law: 'consolidating' },
        { ratio: 0.9, retainRatio: 0.05, law: 'maximum' },
      ],
      models: [{ provider: 'chain-a', model: 'model-a', reasoningEffort: 'high' }],
    },
  }
  const element = mod.views.CompactionTab({
    sessionId: 's1', state, busy: false,
    onCompact: () => {}, configOpen: false, onToggleConfig: () => {},
  })
  const tree = JSON.stringify(expand(element))
  assert.ok(tree.includes('35%'), 'pressure readout rendered')
  assert.ok(tree.includes('tiered engine'), 'status pill rendered')
  assert.ok(tree.includes('gentle') && tree.includes('consolidating'), 'tier table rendered')
  assert.ok(tree.includes('armed') && tree.includes('consumed'), 'tier statuses rendered')
  assert.ok(tree.includes('4,200 tok'), 'checkpoint history rendered')
  assert.ok(tree.includes('route down'), 'checkpoint errors rendered')
  assert.ok(tree.includes('effort high') && tree.includes('last used'), 'chain rows rendered')
  assert.ok(!tree.includes('Release') && !tree.includes('Refresh'), 'utility-only actions: no release, no refresh')
})

test('ConfigPanel renders and edits tiers/models without unbound identifiers', () => {
  const mod = loadClient()
  const draft = {
    enabled: true,
    maxTokens: 8192,
    tiers: [
      { ratio: 0.3, retainRatio: 0.12, law: 'gentle' },
      { ratio: 0.5, retainRatio: 0.1, law: 'standard' },
    ],
    models: [{ provider: 'chain-a', model: 'model-a', reasoningEffort: 'high' }],
  }
  const catalog = { groups: [{ id: 'chain-a', name: 'Chain A', models: [{ id: 'model-a', name: 'Model A', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }], default: { provider: 'chain-a', model: 'model-a' } }
  let patched = null
  const element = mod.views.ConfigPanel({
    draft, setDraft: (next) => { patched = next }, catalog, notice: null, saving: false,
    onSave: () => {}, onDiscard: () => {},
  })
  const tree = JSON.stringify(expand(element))
  assert.ok(tree.includes('Configuration') && tree.includes('live-applied'), 'config group header rendered')
  assert.ok(tree.includes('maxTokens'), 'maxTokens editor rendered')
  assert.ok(tree.includes('primary'), 'chain role rendered')

  // Editing a tier ratio flows through setDraft.
  const tierInput = JSON.stringify(tree).length // locate via behavior instead:
  const rows = collect(element, 'input')
  const ratioInput = rows.find(r => String(r.props.value) === '0.3')
  assert.ok(ratioInput, 'tier ratio input present')
  ratioInput.props.onChange({ target: { value: '0.25' } })
  assert.ok(patched && patched.tiers[0].ratio === 0.25, 'tier edit flows through setDraft')
})

/** Depth-first collect elements matching a tag name. */
function collect(node, tag, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.type === tag) out.push(node)
  for (const child of [node.children, node.props && node.props.children].flat(4)) collect(child, tag, out)
  return out
}

/**
 * Expand function components by executing them (presenters are hook-free).
 * DOM elements pass through; arrays flatten; depth-capped for safety.
 */
function expand(node, depth = 0) {
  if (depth > 12 || node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const props = Object.assign({}, node.props)
    if (node.children !== undefined && node.children.length > 0) props.children = node.children.length === 1 ? node.children[0] : node.children
    return expand(node.type(props), depth + 1)
  }
  const kids = [node.children, node.props && node.props.children].flat(4).map((child) => expand(child, depth + 1))
  return { type: node.type, props: node.props || {}, children: kids }
}

test('CompactionTab renders loading and null-session states without throwing', () => {
  const mod = loadClient()
  assert.ok(mod.views.CompactionTab({ sessionId: 's1', state: null, busy: false, onCompact: () => {}, configOpen: false, onToggleConfig: () => {} }))
})

test('settings card renders the registered-namespace view end to end', () => {
  const mod = loadClient()
  const view = {
    id: 'rich-indexing',
    revision: 3,
    value: {
      enabled: true,
      maxTokens: 8192,
      tiers: [
        { ratio: 0.3, retainRatio: 0.12, law: 'gentle' },
        { ratio: 0.5, retainRatio: 0.1, law: 'standard' },
        { ratio: 0.7, retainRatio: 0.08, law: 'consolidating' },
        { ratio: 0.9, retainRatio: 0.05, law: 'maximum' },
      ],
      models: [{ provider: 'chain-a', model: 'model-a', reasoningEffort: 'high' }],
    },
  }
  const element = mod.views.RichIndexingCard({
    settingsRemote: { describe: async () => ({ namespaces: [view] }), mutate: async () => ({}) },
    sessionRemote: { modelCatalog: async () => ({ groups: [{ id: 'chain-a', name: 'Chain A', models: [{ id: 'model-a', name: 'Model A', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }], default: { provider: 'chain-a', model: 'model-a' } }) },
    catalog: { groups: [{ id: 'chain-a', name: 'Chain A', models: [{ id: 'model-a', name: 'Model A', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }], default: { provider: 'chain-a', model: 'model-a' } },
    view,
    revision: 3,
    draft: JSON.parse(JSON.stringify(view.value)),
    setDraft: () => {},
    notice: null,
    setNotice: () => {},
  })
  assert.ok(element, 'card returned an element tree')
  const tree = JSON.stringify(element)
  assert.ok(tree.includes('rich-indexing'), 'card title rendered')
  assert.ok(tree.includes('consolidating'), 'tier laws rendered')
})
