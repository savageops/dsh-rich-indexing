/**
 * dsh-rich-indexing — pure core: tier selection, keyword index, managed
 * takeover line, config resolution. No cordis, no fs — unit-testable in
 * plain Node.
 *
 * @module dsh-rich-indexing/host-pure
 */

/** The four default tiers: ratios ascending, retention shrinking, law hardening. */
export const DEFAULT_TIERS = [
  { ratio: 0.3, retainRatio: 0.12, law: 'gentle' },
  { ratio: 0.5, retainRatio: 0.1, law: 'standard' },
  { ratio: 0.7, retainRatio: 0.08, law: 'consolidating' },
  { ratio: 0.9, retainRatio: 0.05, law: 'maximum' },
]

/** Law names, weakest to strongest. */
export const LAWS = ['gentle', 'standard', 'consolidating', 'maximum']

/**
 * Pick the tier to fire for this pressure reading.
 *
 * @param {Array<{ratio: number}>} tiers - ascending-ratio tiers.
 * @param {number} pressure - totalTokens / contextWindow.
 * @param {number} pointer - highest tier index already consumed (-1 fresh).
 * @param {{index: number, remaining: number}|null} cooldown - a declined
 *   attempt still cooling down (retry suppression for un-compactable ranges).
 * @returns {number} the tier index to fire, or -1.
 */
export function selectTier(tiers, pressure, pointer, cooldown) {
  let candidate = -1
  for (let i = 0; i < tiers.length; i += 1) {
    if (pressure >= tiers[i].ratio) candidate = i
  }
  if (candidate < 0 || candidate <= pointer) return -1
  if (cooldown !== null && cooldown.index === candidate && cooldown.remaining > 0) return -1
  return candidate
}

/**
 * Resolve a raw settings/entry document into the engine's live config.
 * @param {object} cfg - raw values (entry base merged with user section).
 * @returns the live config shape the engine reads.
 */
export function resolveLiveConfig(cfg = {}) {
  const tiers = Array.isArray(cfg.tiers) && cfg.tiers.length > 0
    ? [...cfg.tiers].sort((a, b) => a.ratio - b.ratio)
      .map(tier => ({
        ratio: Number(tier?.ratio),
        retainRatio: Number(tier?.retainRatio),
        law: LAWS.includes(tier?.law) ? tier.law : 'standard',
      }))
    : DEFAULT_TIERS.map(tier => ({ ...tier }))
  const models = Array.isArray(cfg.models)
    ? cfg.models
      .filter(route => typeof route?.provider === 'string' && route.provider !== ''
        && typeof route?.model === 'string' && route.model !== '')
      .slice(0, 4)
      .map(route => ({
        provider: route.provider,
        model: route.model,
        reasoningEffort: typeof route.reasoningEffort === 'string' && route.reasoningEffort !== ''
          ? route.reasoningEffort
          : 'default',
      }))
    : []
  return {
    enabled: cfg.enabled !== false,
    tiers,
    models,
    maxTokens: Number.isInteger(cfg.maxTokens) && cfg.maxTokens > 0 ? cfg.maxTokens : 8192,
  }
}

/**
 * Cross-field validation (settings `validate` hook + engine sanity).
 * @throws {Error} with an actionable message on the first violation.
 */
export function validateLiveConfig(cfg) {
  const tiers = cfg.tiers
  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i]
    const name = `tiers[${i}]`
    if (!Number.isFinite(tier.ratio) || tier.ratio <= 0 || tier.ratio > 1) {
      throw new Error(`${name}.ratio must be a number in (0, 1] (got ${tier.ratio})`)
    }
    if (!Number.isFinite(tier.retainRatio) || tier.retainRatio <= 0 || tier.retainRatio >= tier.ratio) {
      throw new Error(`${name}.retainRatio (${tier.retainRatio}) must be in (0, ratio ${tier.ratio})`)
    }
    if (i > 0 && tier.ratio <= tiers[i - 1].ratio) {
      throw new Error(`${name}.ratio must be strictly greater than the previous tier (${tier.ratio} <= ${tiers[i - 1].ratio})`)
    }
  }
  if (cfg.models.length > 4) throw new Error('models: at most 4 routes (primary + 3 fallbacks)')
  for (const route of cfg.models) {
    if (route.provider === '' || route.model === '') {
      throw new Error('models: each route needs a non-empty provider and model')
    }
  }
}

// ── Keyword index (deterministic, model-free) ────────────────────────────────

// Stopword vocabulary: English function words + discourse filler + generic
// tech nouns that appear in every coding session and discriminate nothing.
// The index must surface terms that IDENTIFY this session, not vocabulary
// that describes all sessions.
const STOPWORDS = new Set((
  // function words / pronouns / articles / prepositions
  'the,a,an,and,or,but,for,with,without,this,that,these,those,from,into,onto,when,then,than,'
  + 'have,has,had,was,were,been,being,is,are,am,will,would,shall,should,can,could,may,might,'
  + 'must,not,nor,so,if,because,as,at,by,in,on,of,to,up,down,out,off,over,under,again,further,'
  + 'once,here,there,all,any,both,each,few,more,most,other,some,such,only,own,same,too,very,'
  + 'you,your,yours,our,ours,their,theirs,its,it,he,she,they,them,we,us,me,my,mine,i,'
  + 'what,which,who,whom,whose,where,why,how,'
  // verbs / discourse
  + 'said,says,use,uses,used,using,run,runs,ran,check,checks,checked,see,seen,saw,seems,'
  + 'get,gets,got,let,lets,make,makes,made,do,does,did,done,go,goes,went,gone,come,comes,'
  + 'came,take,takes,took,give,gives,gave,find,finds,found,know,knows,knew,think,thinks,'
  + 'want,wants,wanted,need,needs,going,also,just,like,okay,yes,yeah,hmm,wait,sure,thanks,'
  + 'please,gonna,wanna,really,quite,rather,still,yet,already,now,today,tonight,new,old,'
  + 'every,always,never,try,tries,trying,keep,keeps,kept,put,puts,look,looks,looked,'
  + 'work,works,worked,working,help,helps,start,started,starts,stop,stopped,stops,'
  // generic tech nouns — present in literally every session
  + 'file,files,line,lines,code,coding,output,input,values,value,list,lists,data,string,'
  + 'strings,number,numbers,object,objects,array,arrays,method,methods,param,params,'
  + 'parameter,parameters,option,options,type,types,typo,node,nodes,key,keys,name,names,named,message,messages,'
  + 'session,sessions,agent,agents,tool,tools,test,tests,testing,update,updated,updates,'
  + 'change,changed,changes,fix,fixed,fixes,issue,issues,problem,problems,result,results,'
  + 'return,returns,returned,call,calls,called,build,builds,built,create,created,creates,'
  + 'remove,removed,removes,add,added,adding,info,information,content,text,block,blocks,'
  + 'item,items,entry,entries,field,fields,prop,props,property,properties,state,states,'
  + 'store,stored,stores,local,locally,global,current,currently,version,versions,above,'
  + 'below,between,during,before,after,while,about,against,instead,thing,things,stuff,'
  + 'way,ways,part,parts,point,points,case,cases,example,examples,note,notes,note'
).split(','))

/** Concatenate the text of content blocks / messages into one string. */
export function textOf(messages) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    // Bare content block ({type:'text', text}) — accept it directly.
    if (message !== null && typeof message === 'object' && message.type === 'text'
      && typeof message.text === 'string') {
      out.push(message.text)
      continue
    }
    // Message shape ({role, content: ContentBlock[]}).
    const content = Array.isArray(message?.content) ? message.content : []
    out.push(content
      .filter(block => block !== null && typeof block === 'object' && block.type === 'text'
        && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n'))
  }
  return out.join('\n')
}

function uniqueCapped(values, cap) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const clean = String(value).replace(/[.,;:)\]]+$/, '')
    if (clean.length < 4 || clean.length > 160) continue
    if (/^https?:\/\//.test(clean)) continue
    if (seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length >= cap) break
  }
  return out
}

/**
 * Extract a bounded keyword index from a message list: file paths, frequent
 * identifiers, and version-like tokens. Deterministic and cheap — this is
 * what keeps multi-sentence consolidation from losing context.
 * @param {Array} messages - ContentBlock arrays or Message shapes.
 * @param {{maxChars?: number}} [opts]
 * @returns {{paths: string[], terms: string[], versions: string[]}}
 */
export function extractKeywordIndex(messages, opts = {}) {
  const maxChars = opts.maxChars ?? 1200
  const text = textOf(messages)

  const paths = uniqueCapped(text.match(/(?:~|\/)[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+/g) ?? [], 24)

  const counts = new Map()
  for (const match of text.match(/[A-Za-z_$][A-Za-z0-9_$]{4,}/g) ?? []) {
    if (STOPWORDS.has(match.toLowerCase())) continue
    counts.set(match, (counts.get(match) ?? 0) + 1)
  }
  const terms = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([term]) => term)

  const versions = uniqueCapped(text.match(/(?:^|[\s`'("])(v?\d+\.\d+(?:\.\d+)?)(?=[\s`'",);.:]|$)/g) ?? [], 8)
    .map(value => {
      const match = value.match(/v?\d+\.\d+(?:\.\d+)?/)
      return match ? match[0] : value.trim()
    })

  // Bound the whole index so a chatty range cannot bloat the checkpoint.
  let budget = maxChars
  const trim = (list) => {
    const out = []
    let used = 0
    for (const item of list) {
      const cost = (out.length > 0 ? 2 : 0) + item.length
      if (used + cost > budget) break
      used += cost
      out.push(item)
    }
    return out
  }
  const boundedPaths = trim(paths)
  budget -= boundedPaths.join(', ').length
  const boundedTerms = trim(terms)
  budget -= boundedTerms.join(', ').length
  const boundedVersions = trim(versions)

  return { paths: boundedPaths, terms: boundedTerms, versions: boundedVersions }
}

/** Render the index as the checkpoint section body. */
export function formatIndex(index) {
  const sections = []
  if (index.paths.length > 0) sections.push(`Paths: ${index.paths.join(', ')}`)
  if (index.terms.length > 0) sections.push(`Terms: ${index.terms.join(', ')}`)
  if (index.versions.length > 0) sections.push(`Versions: ${index.versions.join(', ')}`)
  return sections.length > 0 ? sections.join('\n') : '(none)'
}

/**
 * Extract the safe summary text from raw model output, honoring the
 * analysis-scratchpad protocol: the directive asks for an optional
 * `<analysis>...</analysis>` reasoning block followed by `<summary>...</summary>`
 * carrying the checkpoint. The analysis is discarded, the summary retained;
 * when the tags are absent the full text output is the summary (fallback).
 * @param {Array<{type: string, text?: string}>} blocks - raw text blocks.
 * @returns {Array<{type: 'text', text: string}>} projected summary blocks.
 */
export function extractSummaryContent(blocks) {
  const text = (Array.isArray(blocks) ? blocks : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  const summaryStart = text.indexOf('<summary>')
  if (summaryStart === -1) {
    // No protocol tags: the whole output is the summary, minus any stray
    // analysis block a model emitted without the closing protocol.
    const stripped = text.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').trim()
    return stripped.length > 0 ? [{ type: 'text', text: stripped }] : []
  }
  const body = text.slice(summaryStart + '<summary>'.length)
  const summaryEnd = body.indexOf('</summary>')
  const content = (summaryEnd === -1 ? body : body.slice(0, summaryEnd)).trim()
  return content.length > 0 ? [{ type: 'text', text: content }] : []
}

/** Pull a previously rendered index body out of a summary block list. */
export function priorIndexFromSummary(summaryBlocks) {
  const text = (Array.isArray(summaryBlocks) ? summaryBlocks : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  const marker = '## Keyword Index'
  const start = text.indexOf(marker)
  if (start === -1) return null
  const body = text.slice(start + marker.length)
  const nextSection = body.search(/\n## (?!Keyword)/)
  return (nextSection === -1 ? body : body.slice(0, nextSection)).trim() || null
}

// ── Managed takeover lines (profile cordis.patch.yml) ────────────────────────

export const MANAGED_MARKER = '# managed:rich-indexing'
export const STOCK_ENTRY_ID = 'compaction-basic'
export const SELF_ENTRY_ID = 'rich-indexing'

/** The three lines of one managed block. */
function blockLines(entryId, disabled) {
  return [MANAGED_MARKER, `- id: ${entryId}`, `  disabled: ${disabled === true ? 'true' : 'false'}`]
}

/**
 * Remove every managed block that names entryId (marker + `- id: entryId` +
 * indented body), preserving everything else — including managed blocks that
 * name a DIFFERENT entry.
 */
export function removeManagedLine(text, entryId = STOCK_ENTRY_ID) {
  const lines = String(text ?? '').split('\n')
  const entryLine = `- id: ${entryId}`
  const out = []
  let skipping = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!skipping && line.trim() === MANAGED_MARKER && (lines[i + 1] ?? '').trim() === entryLine) {
      skipping = true
      continue
    }
    if (skipping) {
      // The entry line itself, then its indented body; the first
      // non-indented line after the entry ends the block.
      if (line.startsWith('- id: ') || line.startsWith('  ')) continue
      skipping = false
    }
    out.push(line)
  }
  // Squeeze the blank gap the block left, but never eat real content.
  const cleaned = []
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === '' && out[i + 1] === '') continue
    cleaned.push(out[i])
  }
  return cleaned.join('\n')
}

/** True when a managed block naming entryId is present. */
export function hasManagedLine(text, entryId = STOCK_ENTRY_ID) {
  const lines = String(text ?? '').split('\n')
  const entryLine = `- id: ${entryId}`
  return lines.some((line, i) => line.trim() === MANAGED_MARKER && (lines[i + 1] ?? '').trim() === entryLine)
}

/**
 * Upsert the managed block for entryId: replace in place when present, append
 * at the end when absent. Later entries win within the file, so the block is
 * authoritative even if a hand-written entry names the same id.
 */
export function upsertManagedLine(text, entryId = STOCK_ENTRY_ID, disabled = true) {
  let out = removeManagedLine(text, entryId)
  if (out.endsWith('\n')) out = out.slice(0, -1)
  if (out.length > 0 && !out.endsWith('\n')) out += '\n'
  if (out.length > 0 && out.endsWith('\n\n')) out = out.slice(0, -1)
  return `${out}\n${blockLines(entryId, disabled).join('\n')}\n`
}

/**
 * Core checkpoint sections, present at every law (basic's 8-section stock
 * structure — never drop a section).
 */
const CORE_SECTIONS = [
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
]

/**
 * Recall sections, present only at gentle/standard: verbatim user messages
 * and problem-solving state (adopted from the OpenSDD context-compactor's
 * 9-section template). consolidating/maximum fold these away — at those
 * tiers the verbatim list is the first thing compression exists to remove.
 */
const RECALL_SECTIONS = [
  '## Problem-Solving Notes',
  '- [what has been figured out so far; what remains unresolved or unverified]',
  '',
  '## User Messages (verbatim or near-verbatim, in order)',
  '- [each non-tool-result user message, one bullet, preserving exact wording of instructions and corrections]',
]

/** Per-law consolidation rules — the only thing that changes with the tier. */
const LAW_RULES = {
  gentle: [
    'Summarize the oldest span of the conversation, keeping details near-verbatim.',
    'Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
    'Do not merge distinct statements; keep each fact as it was stated.',
  ],
  standard: [
    'Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
    'Capture user feedback and explicit instructions faithfully, especially corrections.',
  ],
  consolidating: [
    'Merge redundant statements: when multiple sentences convey the same fact, keep ONE best phrasing. Every distinct fact, file path, command, decision, and quoted user correction must survive the merge.',
    'Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
    'Capture user feedback and explicit instructions faithfully, especially corrections.',
  ],
  maximum: [
    'Consolidate aggressively: drop detail superseded by later state; keep decisions WITH their rationale, every explicit user preference and correction, and every open question.',
    'In "Files and Code" keep one line per path: current relevance only, no history.',
    'Preserve exact file paths, commands, error strings, identifiers, and numeric values that are still load-bearing.',
  ],
}

const INDEX_SECTION_RULE =
  'The established keyword index from a prior checkpoint, when given, is authoritative terminology: keep those terms where they remain relevant and do not reintroduce dropped ones.'

/**
 * Build the tier directive: law-dependent section set, the law's rules, the
 * prior-index paragraph when a previous checkpoint carried an index, and the
 * analysis-scratchpad protocol (everything except maximum, where the token
 * cap is too tight to spend on reasoning).
 * @param {'gentle'|'standard'|'consolidating'|'maximum'} law
 * @param {string|null} priorIndex - prior index body or null.
 * @returns {string} the full compaction instruction.
 */
export function buildDirective(law, priorIndex) {
  const rules = [...LAW_RULES[law] ?? LAW_RULES.standard]
  const withRecall = law === 'gentle' || law === 'standard'
  const scratchpad = law !== 'maximum'
  if (priorIndex !== null && (law === 'consolidating' || law === 'maximum')) {
    rules.unshift(INDEX_SECTION_RULE)
  }
  const sections = withRecall
    ? [...CORE_SECTIONS.slice(0, 11), '', ...RECALL_SECTIONS, '', ...CORE_SECTIONS.slice(12)]
    : [...CORE_SECTIONS]
  const parts = [
    'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
    '',
    ...(scratchpad ? [
      'Begin with a brief <analysis> block reasoning about what is load-bearing versus stale, then close it. After it, emit the checkpoint itself inside <summary>...</summary>. Only the <summary> content is kept.',
      '',
    ] : []),
    'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
    '',
    sections.join('\n'),
    '',
    'Rules:',
    ...rules.map(rule => `- ${rule}`),
    '- Do NOT mention this summarization request or that the context was compacted.',
    '- Output only the checkpoint text: do not call any tool or take any other action.',
    '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
  ]
  if (priorIndex !== null && (law === 'consolidating' || law === 'maximum')) {
    parts.push('', '## Prior Keyword Index (for reference while consolidating)', priorIndex)
  }
  return parts.join('\n')
}
