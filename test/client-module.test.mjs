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
    useEffect: effect => { const cleanup = effect(); return cleanup },
  }
  return factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
}

const module = loadModule()
assert.ok(Array.isArray(module.inject), 'declares injected services')
assert.equal(typeof module.apply, 'function', 'exports apply')

const registrations = []
const calls = []
const ctx = {
  effect: (run) => { calls.push(['effect']); return run() },
  locale: { register: (namespace, dictionaries) => { calls.push(['locale', namespace, Object.keys(dictionaries)]); return () => {} } },
  slots: {
    inject: (name, install) => { calls.push(['inject', name]); return install() },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
  remote: { commands: { execute: async () => ({ ok: true, value: { kind: 'success' } }) } },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  uiWorkspace: { openSession: () => {} },
}

module.apply(ctx)
assert.equal(registrations.length, 2, 'registers the turn control and the settings row')
const tail = registrations.find(entry => entry.options.name === 'conversation.chat.turnTail')
const settings = registrations.find(entry => entry.options.name === 'settings.general.item')
assert.ok(tail, 'registers the per-turn entry')
assert.ok(settings, 'registers the General settings row')
assert.equal(tail.options.locale, 'deleteChat')
assert.deepEqual(calls.find(entry => entry[0] === 'locale')?.slice(1), ['deleteChat', ['zh', 'en']])

const tree = tail.component({ seq: 42, sessionId: 'session-test', t: key => key })
assert.equal(tree.type, 'div', 'component renders a container')
assert.equal(tree.children[0].type, 'button', 'component renders the delete control')
const row = settings.component({ t: key => key })
assert.equal(row.type, 'div', 'settings row renders')

console.log('client module checks passed')
