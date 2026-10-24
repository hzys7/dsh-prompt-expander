/**
 * Prompt construction for `dsh-prompt-expander`.
 *
 * The system prompt is the product decision of this plugin: it decides what
 * "enhance" means. The default mode EXPANDS a rough draft into a complete,
 * executable specification — the shape a good request has — while keeping the
 * author's own intent, wording, and every concrete detail intact.
 *
 * @module dsh-prompt-expander/prompt
 */

/** Modes the browser half may request, strongest expansion first. */
export const MODES = ['expand', 'standard', 'concise']

/**
 * Coerce an untrusted mode value to a supported one.
 * @param value - the value from the request body.
 * @returns a member of {@link MODES}.
 */
export function normaliseMode(value) {
  return typeof value === 'string' && MODES.includes(value) ? value : 'expand'
}

/** Delimiter the model is told to wrap the prompt in, when it cooperates. */
export const MARKER = '<<<PROMPT>>>'

/** Shared rules every mode obeys. */
const BASE_RULES = `You turn a user's rough draft into a complete prompt for an AI coding agent — the kind of request that leaves almost nothing to clarify.

Hard rules:
- Keep the author's intent. Everything you add must serve the goal they already stated.
- Copy every concrete detail character for character: file paths, identifiers, commands, numbers, URLs, error text, quoted content, product names.
- Keep the author's language. A Chinese draft stays Chinese; an English draft stays English. Never translate.
- Do not answer the request. Do not explain what you changed. Do not add preambles like "Sure" or "Here is".
- Output only the prompt itself.

Shape:
- One opening line stating the goal.
- Then 3–6 numbered requirements, each concrete enough to check afterwards.
- When the draft touches existing data, files, or a running workflow, include what a careful engineer would insist on: inspect before changing, preserve what must not be lost, verify the result, and report what changed.
- When the draft is ambiguous, pick the reasonable reading and state it as a requirement; never ask the author a question and never hedge.

Completeness is the point, but restraint matters too: no invented features, no unrelated scope, no restating the goal twice, no filler.`

/** Per-mode steering. */
const MODE_RULES = {
  expand: `Turn the draft — even a one-line one — into a specification the agent can execute without coming back to ask:
- Infer the concrete sub-tasks the author's request implies and put them in execution order.
- Add the acceptance checks and edge cases the stated goal necessarily involves.
- If the draft modifies an existing process, dataset, or pipeline: say what to inspect first, what must be preserved, how to handle disagreements between old and new, and what to report back.
- Aim for 4–6 numbered items. Concrete verbs, no hedging, no filler.`,
  standard: `Make the draft a precise, well-structured request:
- State the goal in one short opening sentence.
- Make explicit what the author implied but left unstated, ONLY when the draft itself makes it unambiguous.
- Group related asks and order them the way they must be carried out.
- Replace vague verbs with specific ones.
- Keep it tight — no preamble, no filler.`,
  concise: `Make the draft shorter and sharper without losing any requirement:
- Cut hedging, pleasantries, and repetition.
- Merge redundant sentences.
- Keep every technical detail intact.
- Aim for roughly half the original length unless nothing can be removed.`,
}

/**
 * Build the system prompt for one mode.
 * @param mode - a member of {@link MODES}.
 * @returns the system prompt text.
 */
export function buildSystemPrompt(mode) {
  const extra = MODE_RULES[mode] ?? MODE_RULES.expand
  return `${BASE_RULES}\n\n${extra}`
}

/**
 * Pull assistant text out of one stream chunk.
 *
 * The stream is a chunk protocol, not a list of messages:
 *   - `text-delta` carries assistant text, incrementally;
 *   - `reasoning-delta` carries the model's private deliberation;
 *   - `block-end` carries the finished block as a whole.
 * Folding both delta and block-end in would duplicate every character, so this
 * prefers `block-end` when it arrives and treats the deltas as a fallback for
 * adapters that never close a block.
 * @param chunk - one chunk from `call.stream(...)`.
 * @returns the text this chunk contributes, or an empty string.
 */
export function extractText(chunk) {
  if (chunk === null || typeof chunk !== 'object') return ''
  if (chunk.type === 'text-delta') {
    return typeof chunk.text === 'string' ? chunk.text : ''
  }
  // Reasoning, tool arguments, usage and finish carry no deliverable text.
  return ''
}

/**
 * Read the finished text block out of a `block-end` chunk.
 * @param chunk - one chunk from `call.stream(...)`.
 * @returns the block's text, or undefined when this is not a text block.
 */
export function extractBlock(chunk) {
  if (chunk === null || typeof chunk !== 'object') return undefined
  if (chunk.type !== 'block-end') return undefined
  const block = chunk.block
  if (block === null || typeof block !== 'object') return undefined
  if (block.type !== 'text' || typeof block.text !== 'string') return undefined
  return block.text
}

/**
 * Build a stateful reply assembler for one stream.
 *
 * The stream carries the same text twice in two shapes: incrementally as
 * `text-delta`, then once more inside `block-end`. Concatenating both duplicates
 * the whole answer, so the finished block wins and the deltas are only a
 * fallback for adapters that never close a block.
 * @returns `{ push, text }`: feed every chunk in order, then read the reply.
 */
export function createReplyAssembler() {
  let blockText = ''
  let deltaText = ''
  let sawBlock = false
  return {
    /** @param chunk - the next chunk from `call.stream(...)`. */
    push(chunk) {
      const block = extractBlock(chunk)
      if (block !== undefined) {
        blockText += block
        sawBlock = true
        return
      }
      if (!sawBlock) deltaText += extractText(chunk)
    },
    /** @returns the assembled reply text. */
    text() {
      return sawBlock ? blockText : deltaText
    },
  }
}

/**
 * Reduce a raw model reply to the prompt it was asked to produce.
 *
 * The happy path is: the model answers cleanly and this returns the text almost
 * untouched. Recovery only engages when the reply actually contains
 * meta-commentary — some models narrate their analysis into the visible message
 * ("the user's draft says X… I'll go with Y…") instead of using a private
 * reasoning channel. That check is load-bearing: running the cut heuristics on a
 * clean multi-item prompt would slice off every item but the last.
 *
 * Strategy:
 *   0. Take the content between the model's markers when it wrote them.
 *   1. Clean output → returned whole.
 *   2. Narrated output → cut at the last label, else at the first numbered item,
 *      else at the trailing passage that shares the draft's vocabulary.
 * @param raw - the assembled assistant text.
 * @param source - the draft that was sent, used to recognise the deliverable.
 * @returns the prompt text, trimmed.
 */
export function finalizeText(raw, source = '') {
  let text = String(raw ?? '').trim()
  if (text === '') return ''

  const marked = extractBetweenMarkers(text)
  if (marked !== undefined) return tidy(unwrapFence(marked))

  text = unwrapFence(text)

  // The common case must be a pass-through, or a well-structured answer gets
  // mutilated by heuristics meant for a failure mode it does not have.
  if (!looksNarrated(text)) return tidy(text)

  // A polite opener ("好的，以下是…") is one paragraph of narration in front of a
  // complete answer: drop it and keep the rest whole.
  const withoutPreamble = dropLeadingNarration(text)
  if (withoutPreamble !== undefined) {
    if (!looksNarrated(withoutPreamble)) return tidy(withoutPreamble)
    text = withoutPreamble
  }

  const labelled = cutAtLabel(text)
  if (labelled !== undefined) return tidy(labelled)

  const numbered = fromFirstNumberedItem(text)
  if (numbered !== undefined) return tidy(numbered)

  // Vocabulary overlap is the last resort and only earns its risk on a long
  // reply; on a short one the remainder is already the answer.
  if (text.length < 200) return tidy(text)
  const tail = trailingDeliverable(text, source)
  return tidy(tail ?? text)
}

/**
 * Remove one narrated paragraph from the front of the reply.
 * @param text - a reply that opens with commentary.
 * @returns the remainder, or undefined when dropping it would leave too little.
 */
function dropLeadingNarration(text) {
  const paragraphs = text.split(/\n{2,}/u)
  if (paragraphs.length < 2) return undefined
  if (!looksNarrated(paragraphs[0])) return undefined
  const rest = paragraphs.slice(1).join('\n\n').trim()
  return rest.length >= 40 ? rest : undefined
}

/**
 * Drop the deliberation and keep what follows the last "Result:"-style label.
 * @param text - a narrated reply.
 * @returns the deliverable, or undefined when no label is present.
 */
function cutAtLabel(text) {
  const labelRe = /(?:^|\n)[^\S\n]*(?:Result|Rewritten prompt|Rewrite|Final(?: answer)?|Output|最终结果|最终答案|改写结果|改写后)[^\S\n]*[:：]/giu
  const labels = [...text.matchAll(labelRe)]
  if (labels.length === 0) return undefined
  const last = labels[labels.length - 1]
  const after = text.slice(last.index + last[0].length).trim()
  return after === '' ? undefined : after
}

/**
 * Keep the reply from its first numbered requirement onward.
 *
 * A narrating model usually appends the finished specification as a numbered
 * list, so cutting there preserves every item instead of only the last sentence.
 * @param text - a narrated reply.
 * @returns the numbered block, or undefined when there is none worth cutting to.
 */
function fromFirstNumberedItem(text) {
  const match = /(?:^|\n)[^\S\n]*\d{1,2}[.、)]\s/u.exec(text)
  if (match === null) return undefined
  // Only cut when real deliberation precedes the list; a reply that merely
  // starts with "1." is already the deliverable.
  if (match.index < 80) return undefined
  return text.slice(match.index).trim()
}

/**
 * Drop a bare trailing heading and surrounding blank lines.
 * @param text - the candidate prompt.
 * @returns the tidied prompt.
 */
function tidy(text) {
  return text.replace(/\n+(?:#{1,6}[^\n]*|\*\*[^*\n]{1,40}\*\*)\s*$/u, '').trim()
}

/**
 * Find the trailing passage that reads as the rewrite.
 *
 * The decisive property is content: a rewrite keeps the draft's own words, while
 * the analysis around it talks *about* the draft. So the answer is the last
 * window of the reply that overlaps the source's tokens most closely, scored per
 * character so a short answer is not outvoted by a long preamble.
 *
 * Fallbacks keep the behaviour sane when the overlap is inconclusive: a Chinese
 * draft ends in its Han run; an English draft's last non-commentary paragraph.
 * @param text - the reply, already stripped of labels.
 * @param source - the draft.
 * @returns the deliverable, or undefined when the reply is already one passage.
 */
function trailingDeliverable(text, source) {
  const sourceTokens = tokenise(source)
  if (sourceTokens.size > 0) {
    const best = bestOverlapSuffix(text, sourceTokens)
    if (best !== undefined) return best
  }

  const paragraphs = text.split(/\n{2,}/u).map((part) => part.trim()).filter((part) => part !== '')
  if (paragraphs.length === 0) return undefined

  if (/\p{Script=Han}/u.test(source)) {
    const run = lastHanRun(paragraphs[paragraphs.length - 1])
    if (run !== undefined) return run
  }
  if (paragraphs.length > 1) {
    for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
      if (!looksNarrated(paragraphs[index])) return paragraphs[index]
    }
  }
  return undefined
}

/** Words (Latin) and characters (Han) that carry meaning for overlap tests. */
const STOP_TOKENS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are',
  'it', 'this', 'that', 'with', 'as', 'at', 'be', 'by', 'add', 'my', 'i',
])

/**
 * Split text into comparable tokens.
 * @param text - any text.
 * @returns unique meaningful tokens.
 */
function tokenise(text) {
  const tokens = new Set()
  for (const word of String(text).matchAll(/[A-Za-z]{2,}/gu)) {
    const lower = word[0].toLowerCase()
    if (!STOP_TOKENS.has(lower)) tokens.add(lower)
  }
  for (const han of String(text).matchAll(/\p{Script=Han}/gu)) {
    tokens.add(han[0])
  }
  return tokens
}

/**
 * Score each sentence boundary as a cut point and keep the best trailing part.
 *
 * Sentence granularity is enough: the model writes its answer as whole
 * sentences at the end, and a finer split risks cutting inside the answer.
 * @param text - the reply.
 * @param sourceTokens - tokens from the draft.
 * @returns the best trailing passage, or undefined when no cut beats the whole.
 */
function bestOverlapSuffix(text, sourceTokens) {
  const cuts = [0]
  for (const match of text.matchAll(/[.。!！?？\n]/gu)) cuts.push(match.index + 1)

  let best
  let bestScore = -1
  for (const cut of cuts) {
    const candidate = text.slice(cut).trim()
    if (candidate.length < 2) continue
    const tokens = tokenise(candidate)
    let hits = 0
    for (const token of tokens) if (sourceTokens.has(token)) hits += 1
    if (hits === 0) continue
    // Prefer the passage with the best overlap density, breaking ties toward the
    // longer (more complete) answer.
    const score = hits / Math.max(1, tokens.size) + Math.min(candidate.length, 400) / 100000
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  if (best === undefined) return undefined
  // A near-total overlap means the whole reply is the answer; do not cut.
  if (best.length >= text.trim().length * 0.9) return undefined
  return best
}

/**
 * The final run of Han-bearing text in a passage.
 * @param text - the passage.
 * @returns the run, or undefined when it is not worth cutting.
 */
function lastHanRun(text) {
  const match = /\p{Script=Han}[\p{Script=Han}\p{Script=Latin}\p{N}\s\p{P}]*$/u.exec(text)
  if (match === null) return undefined
  const head = text.slice(0, match.index)
  // Only cut when a substantial analysis precedes it.
  if (head.length < 100) return undefined
  const tail = text.slice(match.index).trim()
  return tail === '' ? undefined : tail
}

/**
 * Remove one code fence wrapping the whole text.
 * @param text - the candidate text.
 * @returns the unwrapped text.
 */
function unwrapFence(text) {
  const match = text.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```$/u)
  return match === null ? text : match[1].trim()
}

/**
 * Pull the text between the model's markers.
 *
 * Reads the LAST complete pair when the model wrote several (it sometimes drafts
 * an example first), and falls back to an unterminated final opener so a reply
 * cut off at the token limit still yields its prompt.
 * @param text - the raw reply.
 * @returns the marked content, or undefined when no marker is present.
 */
function extractBetweenMarkers(text) {
  const pattern = new RegExp(`${MARKER.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}([\\s\\S]*?)${MARKER.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'gu')
  const pairs = [...text.matchAll(pattern)]
  if (pairs.length > 0) {
    const last = pairs[pairs.length - 1][1].trim()
    if (last !== '') return last
  }
  const openers = [...text.matchAll(new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu'))]
  if (openers.length === 0) return undefined
  const tail = text.slice(openers[openers.length - 1].index + MARKER.length).trim()
  return tail === '' ? undefined : tail
}

/**
 * Markers of a model talking about the draft rather than writing it.
 *
 * Every pattern is anchored to the start of the reply on purpose: a clean prompt
 * may legitimately mention "the user" or "the draft" further down, and treating
 * that as narration would slice off the real answer.
 */
const NARRATION_MARKERS = [
  /^(?:the (?:user|draft|author)\b|this draft\b|the prompt\b|the (?:user|draft) (?:says|is|wants)\b)/iu,
  /^(?:i should\b|i'll\b|i will\b|let me\b|hmm\b|okay\b|ok[,.]|sure[,.]|here(?:'s| is)\b)/iu,
  /^(?:rewrite|rewritten prompt|result|draft)\s*:/iu,
  /^(?:用户的|这个草稿|草稿内容|我需要|我应该|让我|嗯|好的[，,]|以下是|先看)/u,
]

/** How much of the reply may count as the opening preamble. */
const PREAMBLE_WINDOW = 240

/**
 * Decide whether the reply opens with deliberation rather than the deliverable.
 * @param text - the reply, or one paragraph of it.
 * @returns true when it reads as commentary.
 */
function looksNarrated(text) {
  const head = String(text).trimStart().slice(0, PREAMBLE_WINDOW)
  return NARRATION_MARKERS.some((pattern) => pattern.test(head))
}
