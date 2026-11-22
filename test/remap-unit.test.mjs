import assert from 'node:assert/strict'
import { findTurns, planDeletion, RemapRefusal } from '../lib/remap.js'

/** Build one synthetic event. */
function event(seq, type, data = {}) {
  return { type, seq, time: 1000 + seq, data }
}

/** Two closed turns with a third left open. */
function conversation() {
  return [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'step/start', { turn: 1, step: 1 }),
    event(2, 'user/message', { role: 'user', content: [{ type: 'text', text: 'one' }] }),
    event(3, 'step/end', { turn: 1, step: 1 }),
    event(4, 'turn/end', { turn: 1 }),
    event(5, 'turn/start', { turn: 2 }),
    event(6, 'step/start', { turn: 2, step: 1 }),
    event(7, 'user/message', { role: 'user', content: [{ type: 'text', text: 'two' }] }),
    event(8, 'step/end', { turn: 2, step: 1 }),
    event(9, 'turn/end', { turn: 2 }),
    event(10, 'turn/start', { turn: 3 }),
  ]
}

const { turns, openTurn } = findTurns(conversation())
assert.equal(turns.size, 3)
assert.equal(openTurn, 3, 'the unfinished turn is reported')
assert.equal(turns.get(2).endSeq, 9)
assert.equal(turns.get(3).endSeq, undefined)

// Deleting a closed turn yields its inclusive span.
const ranges = planDeletion(conversation(), [2])
assert.equal(ranges.length, 1)
assert.equal(ranges[0].startSeq, 5)
assert.equal(ranges[0].endSeq, 9)
assert.equal(ranges[0].preSplices, 0)

// An open turn cannot be deleted.
assert.throws(() => planDeletion(conversation(), [3]), RemapRefusal)
assert.throws(() => planDeletion(conversation(), [9]), RemapRefusal)

// A splice that queued the turn's input is pulled into the deletion range.
const withSplice = [
  event(0, 'turn/start', { turn: 1 }),
  event(1, 'turn/end', { turn: 1 }),
  event(2, 'agent/inbox/spliced', { target: 'next-turn', inserted: ['a'], removedCount: 1 }),
  event(3, 'turn/start', { turn: 2 }),
  event(4, 'agent/inbox/spliced', { target: 'next-turn', inserted: [], removedCount: 1 }),
  event(5, 'turn/end', { turn: 2 }),
]
const spliced = planDeletion(withSplice, [2])
assert.equal(spliced[0].startSeq, 2, 'the pre-turn splice is removed with the turn')
assert.equal(spliced[0].preSplices, 1)

// A splice whose insertion count disagrees with its claim is refused.
const broken = [
  ...withSplice.slice(0, 2),
  event(2, 'agent/inbox/spliced', { target: 'next-turn', inserted: ['a', 'b'], removedCount: 1 }),
  ...withSplice.slice(3),
]
assert.throws(() => planDeletion(broken, [2]), RemapRefusal)

console.log('remap unit checks passed')
