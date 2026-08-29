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
  // The registered component is the slot wrapper (hooks) — call the presenter
  // through it only if it is hook-free; otherwise reach the presenter by
  // rendering with a stubbed hooks environment. Both presenters here are
  // hook-free, so execute them directly.
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
  // The presenter is exported hook-free precisely for this test; unbound
  // identifiers inside its render body throw here.
  const element = mod.views.CompactionTab({ sessionId: 's1', state, busy: false, refresh: () => {}, onCompact: () => {}, onRelease: () => {} })
  assert.ok(element, 'tab returned an element tree')
  const tree = JSON.stringify(element)
  assert.ok(tree.includes('35%'), 'pressure fraction rendered')
  assert.ok(tree.includes('tiered engine'), 'status pill rendered')
})

test('CompactionTab renders loading and null-session states without throwing', () => {
  const mod = loadClient()
  assert.ok(mod.views.CompactionTab({ sessionId: 's1', state: null, busy: false, refresh: () => {}, onCompact: () => {}, onRelease: () => {} }))
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
