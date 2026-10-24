/**
 * Browser half of `dsh-prompt-expander`.
 *
 * Registers one entry in the composer's `conversation.input.right` list seat,
 * which the shell renders immediately before the model picker. The button is a
 * two-state toggle:
 *
 *   press (idle)     → send the draft to the host, replace it with the rewrite,
 *                      keep the original text in memory
 *   press (enhanced) → put the original text back
 *
 * The draft is read and written through the session's own input shell
 * (`conversation.shellFor(binding)`), the same object the composer drives, so
 * `setDraft` is one undo step and the persisted draft stays consistent.
 *
 * @module dsh-prompt-expander/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-expander',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const jsx = require('react/jsx-runtime')

    const ENDPOINT = '/prompt-expander/enhance'
    const LOCALE_NS = 'prompt-expander'
    const STYLE_ID = 'dsh-prompt-expander/styles'

    /** Per-session memory of the draft this plugin replaced. */
    const originals = new Map()

    const dictionaries = {
      zh: {
        'boost.idle': '增强提示词',
        'boost.busy': '正在增强…',
        'boost.restore': '恢复原提示词',
        'boost.empty': '请先输入内容',
        'boost.noRequest': '没有需要扩写的内容',
        'boost.failed': '增强失败',
        'boost.noShell': '拿不到输入框，请刷新页面',
      },
      en: {
        'boost.idle': 'Enhance prompt',
        'boost.busy': 'Enhancing…',
        'boost.restore': 'Restore original prompt',
        'boost.empty': 'Type something first',
        'boost.noRequest': 'Nothing to expand here',
        'boost.failed': 'Enhancement failed',
        'boost.noShell': 'Composer not reachable — reload the page',
      },
    }

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) {
        return () => {}
      }
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-prompt-expander'
      style.dataset.pluginCss = STYLE_ID
      style.textContent = [
        // Sits in the standardControls row immediately before the model seat:
        // same 28px height and radius token so the two read as one group.
        '.dshBoost{display:inline-flex;align-items:center;justify-content:center;flex:none;',
        'width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);',
        'background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;',
        'transition:background-color .1s,color .1s}',
        '.dshBoost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshBoost:disabled{cursor:default;opacity:.5}',
        '.dshBoost[data-state="enhanced"]{color:var(--dsw-alias-button-info-fill);',
        'background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshBoost[data-state="error"]{color:#e5484d}',
        '.dshBoost svg{width:16px;height:16px;display:block}',
        '@keyframes dshBoostPulse{0%,100%{opacity:1}50%{opacity:.35}}',
        '.dshBoost[data-state="busy"] svg{animation:dshBoostPulse 1s ease-in-out infinite}',
      ].join('')
      document.head.append(style)
      return () => style.remove()
    }

    /** A four-point sparkle: the convention for "enhance" in this class of tool. */
    function SparkleIcon() {
      return jsx.jsx('svg', {
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        children: jsx.jsxs('g', {
          fill: 'currentColor',
          children: [
            jsx.jsx('path', {
              d: 'M6.6 2.2l1.15 2.95 2.95 1.15-2.95 1.15L6.6 10.4 5.45 7.45 2.5 6.3l2.95-1.15L6.6 2.2z',
            }),
            jsx.jsx('path', {
              d: 'M11.9 8.6l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z',
              opacity: 0.7,
            }),
          ],
        }),
      })
    }

    /**
     * Resolve the session's composer shell.
     *
     * `conversation.input.for(actx)` is the documented resolver: it maps a
     * session-scope context to the resident shell, which is the same object the
     * composer drives and therefore the only correct write target.
     * @param ctx - the client plugin context.
     * @param sessionId - the session whose composer owns the button.
     * @returns the shell, or undefined when the composer is not reachable.
     */
    function shellFor(ctx, sessionId) {
      if (sessionId === undefined) return undefined
      const sessions = ctx.get('sessions')
      if (sessions === undefined || typeof sessions.scope !== 'function') return undefined
      const actx = sessions.scope(sessionId)
      if (actx === undefined) return undefined
      const conversation = ctx.get('conversation')
      const input = conversation?.input
      if (input === undefined || typeof input.for !== 'function') return undefined
      const shell = input.for(actx)
      return shell !== undefined && typeof shell.setDraft === 'function' ? shell : undefined
    }

    /**
     * Read the shell's current draft text.
     *
     * `draftSnapshot` is the shell's semantic document accessor; `text` on it is
     * the plain draft. Older shapes exposed the text elsewhere, so this reads the
     * known places in order rather than trusting one.
     * @param shell - the input shell.
     * @returns the draft text.
     */
    function readDraft(shell) {
      const snapshot = shell?.draftSnapshot
      if (snapshot !== undefined && snapshot !== null && typeof snapshot.text === 'string') {
        return snapshot.text
      }
      if (typeof shell?.snapshot?.text === 'string') return shell.snapshot.text
      return ''
    }

    /**
     * Report one diagnostic line to the host so the agent can read it back.
     * @param payload - JSON-safe facts about the current attempt.
     */
    function report(payload) {
      try {
        void fetch('/prompt-expander/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {})
      } catch {
        // Diagnostics must never break the button.
      }
    }

    /**
     * Describe what the composer bridge looks like right now.
     *
     * The browser half cannot be inspected from outside, so this records the
     * exact shape it found: which services resolved, and what the shell offers.
     * @param ctx - the client plugin context.
     * @param sessionId - the session under test.
     * @param shell - the resolved shell, when one was found.
     * @returns JSON-safe facts.
     */
    function describe(ctx, sessionId, shell) {
      const conversation = ctx.get('conversation')
      const sessions = ctx.get('sessions')
      const draft = shell === undefined ? undefined : readDraft(shell)
      return {
        sessionId: sessionId === undefined ? null : sessionId,
        hasSessions: sessions !== undefined,
        hasScope: typeof sessions?.scope === 'function',
        hasConversation: conversation !== undefined,
        hasInput: conversation?.input !== undefined,
        hasFor: typeof conversation?.input?.for === 'function',
        shellFound: shell !== undefined,
        shellKeys: shell === undefined
          ? []
          : Object.getOwnPropertyNames(Object.getPrototypeOf(shell) ?? {}).slice(0, 60),
        draftLength: draft === undefined ? null : draft.length,
      }
    }

    /**
     * The composer button.
     * @param props - `sessionId` from the entry's inject, `ctx`, and locale `t`.
     */
    function BoostButton({ sessionId, ctx, t }) {
      const [state, setState] = React.useState('idle')
      const [error, setError] = React.useState('')

      // Drop this session's memory when the seat unmounts (session switch).
      React.useEffect(() => () => { originals.delete(sessionId) }, [sessionId])

      // One mount-time snapshot: enough to see which link is broken without
      // requiring the user to click and describe what happened.
      React.useEffect(() => {
        const shell = shellFor(ctx, sessionId)
        report({ event: 'mount', ...describe(ctx, sessionId, shell) })
      }, [ctx, sessionId])

      /** Show a failure on the button, then settle back to idle. */
      const flash = React.useCallback((message) => {
        setError(message)
        setState('error')
      }, [])

      React.useEffect(() => {
        if (state !== 'error') return undefined
        const timer = window.setTimeout(() => setState('idle'), 2500)
        return () => window.clearTimeout(timer)
      }, [state])

      const onPress = React.useCallback(async (event) => {
        event.preventDefault()
        setError('')

        const shell = shellFor(ctx, sessionId)
        if (shell === undefined) {
          report({ event: 'press-no-shell', ...describe(ctx, sessionId, undefined) })
          flash(t('boost.noShell'))
          return
        }

        // Second press: restore, but only while the draft is still our rewrite.
        const remembered = originals.get(sessionId)
        if (remembered !== undefined) {
          if (readDraft(shell) !== remembered.enhanced) {
            // The author edited our rewrite: forget the old original rather than
            // overwriting their edit on the next press.
            originals.delete(sessionId)
            setState('idle')
            return
          }
          shell.setDraft(remembered.original)
          originals.delete(sessionId)
          setState('idle')
          return
        }

        const draft = readDraft(shell).trim()
        if (draft === '') {
          report({ event: 'press-empty', ...describe(ctx, sessionId, shell) })
          flash(t('boost.empty'))
          return
        }

        setState('busy')
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: draft }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true || typeof payload.text !== 'string') {
            report({ event: 'press-refused', status: response.status, payload: String(JSON.stringify(payload)).slice(0, 300) })
            flash(payload?.error ?? t('boost.failed'))
            return
          }
          if (payload.passthrough === true) {
            // A greeting carries no request; the host says so instead of
            // inventing a task. Leave the draft untouched.
            report({ event: 'press-no-request', from: draft.length })
            flash(t('boost.noRequest'))
            return
          }
          const enhanced = payload.text
          shell.setDraft(enhanced)
          originals.set(sessionId, { original: draft, enhanced })
          report({ event: 'press-enhanced', from: draft.length, to: enhanced.length })
          setState('enhanced')
        } catch (cause) {
          report({ event: 'press-error', message: String(cause).slice(0, 300) })
          flash(t('boost.failed'))
        }
      }, [ctx, sessionId, t, flash])

      const label = state === 'busy'
        ? t('boost.busy')
        : state === 'enhanced'
          ? t('boost.restore')
          : t('boost.idle')

      return jsx.jsx('button', {
        type: 'button',
        className: 'dshBoost',
        'data-state': state,
        title: error === '' ? label : error,
        'aria-label': error === '' ? label : `${label} · ${error}`,
        'aria-pressed': state === 'enhanced',
        disabled: state === 'busy' || sessionId === undefined,
        onClick: (event) => { void onPress(event) },
        children: jsx.jsx(SparkleIcon, {}),
      })
    }

    /**
     * Mount into the composer.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(), 'prompt-expander: button styles')
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, dictionaries),
        'prompt-expander: dictionaries',
      )
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'prompt-expander',
        // The model seat renders right after this list, so a low order keeps the
        // button visually adjacent to the picker.
        order: 10,
        locale: LOCALE_NS,
        inject: (sessionId) => ({ sessionId, ctx }),
      }, BoostButton))
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
