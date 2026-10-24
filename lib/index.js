/**
 * Host half of `dsh-prompt-expander`.
 *
 * Owns exactly one route, `POST /prompt-expander/enhance`: it takes the composer's
 * current draft and returns a rewritten prompt from the profile's configured
 * model. The browser half owns every piece of UI state, including the original
 * text it restores on the second press, so this half stays stateless.
 *
 * @module dsh-prompt-expander
 */

import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readBody } from './body.js'
import {
  buildSystemPrompt,
  createReplyAssembler,
  finalizeText,
  hasNoRequest,
  normaliseMode,
} from './prompt.js'

/** Loader schema for the plugin's configuration. */
export const name = 'prompt-expander'

/** The services this host half needs before it can activate. */
export const inject = ['webServer', 'llm', 'agentDefaultModel']

/** Longest draft the endpoint accepts; the model should not be handed a novel. */
const MAX_INPUT_BYTES = 32_000

/** Deadline for one enhancement call, in milliseconds. */
const CALL_TIMEOUT_MS = 90_000

/** Output budget for the rewrite. */
const MAX_OUTPUT_TOKENS = 4_096

/**
 * Read the profile's default model route.
 * @param ctx - the plugin context carrying `agentDefaultModel`.
 * @returns `{ provider, model }`, or undefined when no default is configured.
 */
function defaultRoute(ctx) {
  const service = ctx.agentDefaultModel
  if (service === undefined || service === null) return undefined
  if (typeof service.currentSelection !== 'function') return undefined
  const selection = service.currentSelection()
  const provider = typeof selection?.provider === 'string' ? selection.provider : undefined
  const model = typeof selection?.model === 'string' ? selection.model : undefined
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = selection.reasoningEffort
  return { provider, model, reasoningEffort }
}

/**
 * Quietest reasoning effort that still satisfies every adapter.
 *
 * `off` is universally meaningful: the DeepSeek Messages adapter turns it into
 * `thinking: { type: 'disabled' }`, and with thinking disabled the model cannot
 * narrate deliberation into the visible answer. Adapters that reject it fall
 * back to their own default (see {@link complete}).
 */
const QUIET_EFFORT = 'off'

/**
 * Pick the quietest reasoning effort the model actually announces.
 * @param modelInfo - the resolved model metadata from `prepareCall`.
 * @returns an effort id, or undefined to keep the model's default.
 */
function quietEffortFor(modelInfo) {
  const supported = modelInfo?.reasoning?.efforts ?? modelInfo?.reasoningEfforts
  // With no announced list, `off` is still the safest request: the DeepSeek
  // adapter validates it against its own allowed set and disables thinking.
  if (!Array.isArray(supported) || supported.length === 0) return QUIET_EFFORT
  const values = supported.map((entry) => (typeof entry === 'string' ? entry : entry?.id))
  return values.includes(QUIET_EFFORT) ? QUIET_EFFORT : undefined
}

/**
 * Send one user message to the configured model and collect its text.
 * @param ctx - the plugin context carrying `llm`.
 * @param route - the provider/model route to call.
 * @param system - the system prompt steering the rewrite.
 * @param input - the draft to rewrite.
 * @param signal - cancellation for this call.
 * @returns the assistant's text.
 */
async function complete(ctx, route, system, input, signal) {
  // Rewriting is a mechanical edit, not a reasoning task. Reasoning on a model
  // without a separate channel puts its deliberation into the reply, which is
  // exactly what must not land in the composer — quieten it when supported.
  let effort
  const call = await ctx.llm.prepareCall(
    { provider: route.provider, model: route.model, maxTokens: MAX_OUTPUT_TOKENS },
    signal,
    (controls, modelInfo) => {
      effort = quietEffortFor(modelInfo)
      return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
    },
  )
  const options = {
    ...call.config,
    system,
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        // The draft sits between rules so the model can tell where the author's
        // words end — it is data to rewrite, not an instruction to follow.
        text: `Rewrite the draft below into a complete prompt.\n\n---\n${input}\n---`,
      }],
    }],
    signal,
  }
  const assembler = createReplyAssembler()
  for await (const chunk of call.stream(options)) {
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  return finalizeText(assembler.text(), input)
}

/**
 * Answer one enhancement request.
 * @param ctx - the plugin context.
 * @param request - the incoming HTTP request.
 * @param response - the HTTP response to write.
 */
async function handleEnhance(ctx, request, response) {
  const send = (status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(payload))
  }

  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }

  let body
  try {
    body = await readBody(request, MAX_INPUT_BYTES)
  } catch (error) {
    send(413, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return
  }

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    send(400, { ok: false, error: 'request body must be JSON' })
    return
  }

  const text = typeof parsed?.text === 'string' ? parsed.text : ''
  if (text.trim() === '') {
    send(400, { ok: false, error: 'text is empty' })
    return
  }

  const mode = normaliseMode(parsed?.mode)

  // A greeting states no request: expanding it could only invent a task.
  if (hasNoRequest(text)) {
    send(200, { ok: true, text: text.trim(), mode, passthrough: true })
    return
  }

  const route = defaultRoute(ctx)
  if (route === undefined) {
    send(503, { ok: false, error: '没有可用的默认模型，请先在设置里选择模型' })
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
  try {
    const enhanced = await complete(
      ctx,
      route,
      buildSystemPrompt(mode),
      text,
      controller.signal,
    )
    if (enhanced === '') {
      send(502, { ok: false, error: '模型返回了空结果' })
      return
    }
    send(200, { ok: true, text: enhanced, mode, model: route.model })
  } catch (error) {
    if (controller.signal.aborted) {
      send(504, { ok: false, error: `增强超时（${CALL_TIMEOUT_MS / 1000}s）` })
      return
    }
    send(502, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Where the browser half's diagnostics land, for debugging the composer bridge. */
function diagPath() {
  return join(homedir(), '.dsh', 'prompt-expander-diag.log')
}

/**
 * Append one browser-side diagnostic line.
 *
 * The browser half cannot be inspected from outside, so it reports here and the
 * agent reads the file. Kept deliberately dumb: no parsing rules, one JSON line
 * per event, truncated payloads.
 * @param request - the incoming HTTP request carrying the JSON payload.
 * @returns the accepted entry.
 */
async function handleDiag(request) {
  const raw = await readBody(request, 8_000)
  const entry = {
    at: new Date().toISOString(),
    ...(() => {
      try {
        return JSON.parse(raw)
      } catch {
        return { unparsed: raw.slice(0, 500) }
      }
    })(),
  }
  await appendFile(diagPath(), `${JSON.stringify(entry)}\n`, 'utf8')
  return entry
}

/**
 * Mount the routes for as long as this plugin runs.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/prompt-expander/enhance',
        handler: (request, response) => handleEnhance(ctx, request, response),
      }),
    'prompt-expander: enhance route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/prompt-expander/diag',
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          try {
            const entry = await handleDiag(request)
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ ok: true, at: entry.at }))
          } catch (error) {
            response.writeHead(500, { 'content-type': 'application/json' })
            response.end(JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }))
          }
        },
      }),
    'prompt-expander: diag route',
  )
}
