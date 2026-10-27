/**
 * Smoke test for the composer button's draft follower.
 *
 * The browser half is a UMD module that expects `window.__ModuleLoader__`, so
 * it is evaluated in a `vm` sandbox with stubbed react/jsx and a fake input
 * shell shaped like the real one (`draftSnapshot.text`, `state.subscribe`).
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/** Minimal snapshot store: same subscribe/set/getSnapshot shape as the app's. */
function createStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    set(next) {
      value = next
      for (const listener of [...listeners]) listener(value)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Fake session input shell: writes publish into its own state store. */
function createShell() {
  const state = createStore({ draft: '' })
  return {
    text: '',
    state,
    get draftSnapshot() {
      return { text: this.text }
    },
    setDraft(next) {
      this.text = next
      state.set({ draft: next })
    },
  }
}

/** Load lib/client.js in a sandbox and hand back its test seams. */
function loadPlugin() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
  const stubRequire = () => ({})
  let exported
  const sandbox = {
    console,
    window: {
      setTimeout,
      clearTimeout,
      __ModuleLoader__: {
        load({ factory }) {
          exported = factory(stubRequire)
        },
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  return exported.__test__
}

const test = loadPlugin()
const results = []

async function check(name, run) {
  try {
    await run()
    results.push(`PASS ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

async function main() {
  await check('no memory means no reset', () => {
    assert.equal(test.draftMovedOn(undefined, 'anything'), false)
  })

  await check('unchanged draft keeps the memory', () => {
    assert.equal(test.draftMovedOn({ enhanced: 'A' }, 'A'), false)
  })

  await check('sent draft (cleared composer) drops the memory', () => {
    assert.equal(test.draftMovedOn({ enhanced: 'A' }, ''), true)
  })

  await check('edited draft drops the memory', () => {
    assert.equal(test.draftMovedOn({ enhanced: 'A' }, 'B'), true)
  })

  await check('follower subscribes and unsubscribes', () => {
    const shell = createShell()
    const seen = []
    const off = test.followDraft(shell, () => seen.push(shell.text))
    shell.setDraft('one')
    off()
    shell.setDraft('two')
    assert.deepEqual(seen, ['one'])
  })

  await check('shell without a state store is tolerated', () => {
    const off = test.followDraft({ setDraft() {} }, () => {
      throw new Error('listener must not run')
    })
    off()
  })

  await check('our own write does not look like the author moving on', async () => {
    const shell = createShell()
    let duringWrite
    test.followDraft(shell, () => {
      duringWrite = test.memoryIsStale({ enhanced: 'A' }, shell, 'Z')
    })
    test.writeDraft(shell, 'Z')
    assert.equal(duringWrite, false, 'write is still ours while setDraft runs')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(test.memoryIsStale({ enhanced: 'A' }, shell, 'Z'), true)
  })

  await check('press -> enhance -> send -> one-click enhance again', async () => {
    const shell = createShell()
    let memory = { original: 'hello', enhanced: 'READ hello' }
    const resets = []
    const off = test.followDraft(shell, () => {
      if (!test.memoryIsStale(memory, shell, test.readDraft(shell))) return
      resets.push(test.readDraft(shell))
      memory = undefined
    })

    test.writeDraft(shell, 'hello')
    test.writeDraft(shell, 'READ hello') // press: draft replaced by the rewrite
    assert.deepEqual(resets, [], 'enhance keeps the button restorable')

    shell.setDraft('') // send: the composer commits and empties
    assert.deepEqual(resets, [''], 'send settles the button back to idle')

    test.writeDraft(shell, 'next draft')
    assert.equal(resets.length, 1, 'no second reset for the following draft')
    off()
  })

  await check('restore still works before any send', () => {
    const shell = createShell()
    const memory = { original: 'hello', enhanced: 'READ hello' }
    const resets = []
    test.followDraft(shell, () => {
      if (test.memoryIsStale(memory, shell, test.readDraft(shell))) resets.push(shell.text)
    })
    test.writeDraft(shell, memory.enhanced)
    test.writeDraft(shell, memory.original) // press again: restore
    assert.deepEqual(resets, [], 'restoring the original is not a reset')
    assert.equal(shell.text, 'hello')
  })

  console.log(results.join('\n'))
}

main()
