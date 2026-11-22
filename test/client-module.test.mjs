import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Load `client.js` the way the browser module loader does. */
function loadModule() {
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory: loaded }) => { factory = loaded } } },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    setTimeout,
    console,
    Uint8Array,
    Math,
    JSON,
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8'), sandbox)
  assert.equal(typeof factory, 'function', 'client module registers a factory')

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [initial, () => {}],
  }
  return factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
}

const module = loadModule()
assert.ok(Array.isArray(module.inject), 'declares injected services')
assert.equal(typeof module.apply, 'function', 'exports apply')

let registration = null
const calls = []
const ctx = {
  effect: (run) => { calls.push(['effect']); return run() },
  locale: { register: (namespace, dictionaries) => { calls.push(['locale', namespace, Object.keys(dictionaries)]); return () => {} } },
  slots: {
    inject: (name, install) => { calls.push(['inject', name]); return install() },
    register: (options, component) => { registration = { options, component }; return () => {} },
  },
  remote: { commands: { execute: async () => ({ ok: true, value: { kind: 'success' } }) } },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  uiWorkspace: { openSession: () => {} },
}

module.apply(ctx)
assert.ok(registration, 'registers one slot entry')
assert.equal(registration.options.name, 'conversation.chat.turnTail')
assert.equal(registration.options.locale, 'deleteChat')
assert.deepEqual(calls.find(entry => entry[0] === 'locale')?.slice(1), ['deleteChat', ['zh', 'en']])

const tree = registration.component({ seq: 42, sessionId: 'session-test', t: key => key })
assert.equal(tree.type, 'div', 'component renders a container')
assert.equal(tree.children[0].type, 'button', 'component renders the delete control')

console.log('client module checks passed')
