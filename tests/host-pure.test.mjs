/**
 * dsh-rich-indexing — host-pure unit tests.
 * Run: node --test tests/host-pure.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_TIERS,
  buildDirective,
  extractKeywordIndex,
  extractSummaryContent,
  formatIndex,
  hasManagedLine,
  SELF_ENTRY_ID,
  STOCK_ENTRY_ID,
  priorIndexFromSummary,
  removeManagedLine,
  resolveLiveConfig,
  selectTier,
  upsertManagedLine,
  validateLiveConfig,
} from '../src/host-pure.js'

// ── Tier selection ───────────────────────────────────────────────────────────

test('selectTier fires the highest crossed tier above the pointer', () => {
  const tiers = DEFAULT_TIERS
  assert.equal(selectTier(tiers, 0.25, -1, null), -1)
  assert.equal(selectTier(tiers, 0.31, -1, null), 0)
  assert.equal(selectTier(tiers, 0.85, -1, null), 2)
  assert.equal(selectTier(tiers, 0.95, -1, null), 3)
})

test('selectTier never re-fires a consumed or lower tier', () => {
  assert.equal(selectTier(DEFAULT_TIERS, 0.95, 2, null), 3)
  assert.equal(selectTier(DEFAULT_TIERS, 0.95, 3, null), -1)
  assert.equal(selectTier(DEFAULT_TIERS, 0.4, 1, null), -1, 'pressure fell back below the pointer tier')
})

test('selectTier honors the decline cooldown for that tier only', () => {
  const cooldown = { index: 2, remaining: 1 }
  assert.equal(selectTier(DEFAULT_TIERS, 0.85, 1, cooldown), -1)
  assert.equal(selectTier(DEFAULT_TIERS, 0.95, 1, cooldown), 3, 'a higher tier skips the cooldown')
})

// ── Live config ──────────────────────────────────────────────────────────────

test('resolveLiveConfig sorts tiers and defaults effort', () => {
  const cfg = resolveLiveConfig({
    tiers: [
      { ratio: 0.9, retainRatio: 0.1, law: 'maximum' },
      { ratio: 0.3, retainRatio: 0.4, law: 'gentle' },
    ],
    models: [{ provider: 'p', model: 'm', reasoningEffort: '' }],
  })
  assert.equal(cfg.tiers[0].ratio, 0.3)
  assert.equal(cfg.tiers[1].ratio, 0.9)
  assert.equal(cfg.models[0].reasoningEffort, 'default')
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.maxTokens, 8192)
})

test('resolveLiveConfig falls back to stock defaults on empty input', () => {
  const cfg = resolveLiveConfig({})
  assert.deepEqual(cfg.tiers, DEFAULT_TIERS.map(tier => ({ ...tier })))
  assert.deepEqual(cfg.models, [])
})

test('validateLiveConfig rejects unsorted, inverted retention, and bad chains', () => {
  assert.throws(() => validateLiveConfig({ tiers: [{ ratio: 0.5, retainRatio: 0.6, law: 'gentle' }], models: [] }), /retainRatio/)
  assert.throws(() => validateLiveConfig({
    tiers: [{ ratio: 0.5, retainRatio: 0.2, law: 'gentle' }, { ratio: 0.5, retainRatio: 0.2, law: 'gentle' }],
    models: [],
  }), /strictly greater/)
  assert.throws(() => validateLiveConfig({
    tiers: DEFAULT_TIERS.map(tier => ({ ...tier })),
    models: Array.from({ length: 5 }, () => ({ provider: 'p', model: 'm' })),
  }), /at most 4/)
  assert.throws(() => validateLiveConfig({
    tiers: DEFAULT_TIERS.map(tier => ({ ...tier })),
    models: [{ provider: '', model: 'm' }],
  }), /non-empty provider/)
  assert.doesNotThrow(() => validateLiveConfig({
    tiers: DEFAULT_TIERS.map(tier => ({ ...tier })),
    models: [{ provider: 'p', model: 'm' }],
  }))
})

// ── Keyword index ────────────────────────────────────────────────────────────

test('extractKeywordIndex drops stopword noise, keeps discriminating terms', () => {
  const text = [
    'The config file loader failed in richContextHost.js twice.',
    'The loader cached the config, then the loader retried and the config loaded.',
    'Edited /home/sysadmin/.dsh/plugins/dsh-rich-indexing/src/host.js and /tmp/plan.md',
    'Deployed dsh v0.3.1 and v1.2.0 today; the file update worked.',
  ].join('\n')
  const index = extractKeywordIndex([{ type: 'text', text }])
  assert.ok(index.paths.some(path => path.includes('host.js')), `paths: ${index.paths.join(',')}`)
  assert.ok(index.versions.includes('v0.3.1'), `versions: ${index.versions.join(',')}`)
  assert.ok(!index.terms.includes('file'), `stopword leaked: ${index.terms.join(',')}`)
  assert.ok(!index.terms.includes('update'), `stopword leaked: ${index.terms.join(',')}`)
  assert.ok(index.terms.includes('loader'), `terms: ${index.terms.join(',')}`)
  assert.ok(index.terms.includes('config'), `terms: ${index.terms.join(',')}`)
})

test('formatIndex renders sections and an explicit none', () => {
  assert.equal(formatIndex({ paths: [], terms: [], versions: [] }), '(none)')
  const rendered = formatIndex({ paths: ['/a/b.js'], terms: ['loader'], versions: [] })
  assert.match(rendered, /Paths: \/a\/b\.js/)
  assert.match(rendered, /Terms: loader/)
})

// ── Summary extraction (analysis scratchpad protocol) ────────────────────────

test('extractSummaryContent keeps only the summary block', () => {
  const blocks = [
    { type: 'text', text: '<analysis>\nthink about load-bearing facts\n</analysis>\n<summary>\n## Primary Request and Intent\n- ship it\n</summary>' },
  ]
  const out = extractSummaryContent(blocks)
  assert.equal(out.length, 1)
  assert.match(out[0].text, /^## Primary Request and Intent/)
  assert.ok(!out[0].text.includes('analysis'))
})

test('extractSummaryContent falls back to full text without tags and strips stray analysis', () => {
  const plain = extractSummaryContent([{ type: 'text', text: '## Current Work\n- writing tests' }])
  assert.match(plain[0].text, /writing tests/)

  const stray = extractSummaryContent([
    { type: 'text', text: '<analysis>half-open reasoning without close\n## Next Step\n- run' },
  ])
  assert.match(stray[0].text, /## Next Step/)
})

// ── Directive construction ───────────────────────────────────────────────────

test('directive carries recall sections at gentle/standard, folds them at high laws', () => {
  for (const law of ['gentle', 'standard']) {
    const directive = buildDirective(law, null)
    assert.match(directive, /## User Messages \(verbatim/, `${law} should carry verbatim user messages`)
    assert.match(directive, /## Problem-Solving Notes/, `${law} should carry problem-solving notes`)
    assert.match(directive, /<analysis>/, `${law} should use the scratchpad protocol`)
  }
  for (const law of ['consolidating', 'maximum']) {
    const directive = buildDirective(law, null)
    assert.ok(!directive.includes('## User Messages (verbatim'), `${law} folds verbatim user messages`)
    assert.ok(!directive.includes('## Problem-Solving Notes'), `${law} folds problem-solving notes`)
  }
  assert.ok(!buildDirective('maximum', null).includes('<analysis>'), 'maximum skips the scratchpad')
})

test('directive always keeps the eight core sections in order', () => {
  const directive = buildDirective('consolidating', null)
  const sections = [
    '## Primary Request and Intent',
    '## Key Technical Concepts',
    '## Files and Code',
    '## Errors and Fixes',
    '## Pending Jobs',
    '## Current Work',
    '## Next Step',
    '## Critical Context',
  ]
  let cursor = -1
  for (const section of sections) {
    const at = directive.indexOf(section)
    assert.ok(at > cursor, `${section} missing or out of order`)
    cursor = at
  }
})

test('prior index paragraph only appears where the law uses it', () => {
  assert.ok(!buildDirective('gentle', 'Terms: loader').includes('Prior Keyword Index'))
  assert.ok(buildDirective('maximum', 'Terms: loader').includes('Terms: loader'))
  assert.ok(buildDirective('consolidating', 'Terms: loader').includes('Terms: loader'))
})

// ── Prior index recovery ─────────────────────────────────────────────────────

test('priorIndexFromSummary extracts the index body between sections', () => {
  const blocks = [
    { type: 'text', text: '## Current Work\n- x\n\n## Keyword Index\nPaths: /a/b.js\nTerms: loader\n\n## Next Step\n- y' },
  ]
  assert.equal(priorIndexFromSummary(blocks), 'Paths: /a/b.js\nTerms: loader')
  assert.equal(priorIndexFromSummary([{ type: 'text', text: 'no index here' }]), null)
})

// ── Managed takeover line ────────────────────────────────────────────────────

test('upsert is idempotent and preserves foreign content', () => {
  const original = [
    '# my hand-written tweaks live here',
    '- id: ui-task-board',
    '  disabled: true',
    '',
  ].join('\n')
  const once = upsertManagedLine(original)
  assert.ok(hasManagedLine(once))
  assert.match(once, /- id: compaction-basic\n  disabled: true\n$/)
  assert.ok(once.includes('- id: ui-task-board'), 'foreign entries must survive')
  const twice = upsertManagedLine(once)
  assert.equal((twice.match(/# managed:rich-indexing/g) ?? []).length, 1, 'exactly one managed block')
  assert.equal(twice, once, 'second upsert is a no-op')
})

test('removeManagedLine drops only the managed block', () => {
  const text = upsertManagedLine('- id: ui-task-board\n  disabled: true\n')
  const removed = removeManagedLine(text)
  assert.equal(hasManagedLine(removed), false)
  assert.ok(!removed.includes('compaction-basic'))
  assert.ok(removed.includes('ui-task-board'))
  assert.equal(removeManagedLine(''), '')
})

test('release write: stock block out, self-disable in, teardown removes only stock', () => {
  const afterRelease = upsertManagedLine(
    removeManagedLine(upsertManagedLine('- id: ui-task-board\n  disabled: true\n'), STOCK_ENTRY_ID),
    SELF_ENTRY_ID,
    true,
  )
  assert.ok(hasManagedLine(afterRelease, SELF_ENTRY_ID), 'self-disable block present')
  assert.equal(hasManagedLine(afterRelease, STOCK_ENTRY_ID), false, 'stock-disable block gone')
  assert.ok(afterRelease.includes('ui-task-board'), 'foreign entries survive')
  const afterTeardown = removeManagedLine(afterRelease, STOCK_ENTRY_ID)
  assert.ok(hasManagedLine(afterTeardown, SELF_ENTRY_ID), 'self-disable block survives teardown')
  assert.match(afterTeardown, /- id: rich-indexing\n  disabled: true\n$/)
})
