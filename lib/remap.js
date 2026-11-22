#!/usr/bin/env node
/**
 * remap.js — rebuild a DSH session event log after deleting whole turns.
 *
 * Input: a contiguous event array decoded from a v4 session log (seq 0..n-1).
 * Output: a new contiguous event array (seq 0..m-1) with every known
 * sequence reference remapped. Deletion is by turn number and covers
 * `turn/start .. turn/end`, plus the contiguous `agent/inbox/spliced`
 * insertion(s) immediately before `turn/start` that fed that turn (otherwise
 * the deleted user prompt would remain queued and be replayed on resume).
 * When the requested set reaches the last closed turn, deletion is a cut from
 * the first requested turn through EOF, removing inter-turn and post-turn
 * records rather than leaving them to reference the deleted suffix.
 *
 * Safety policy: a reference to a dropped event is either removed (when the
 * field is an optional citation and its loss cannot change reconstruction) or
 * refused with `RemapRefusal`. Nothing is left dangling silently. The final
 * event array is also checked with a pure surface fold, exactly the surface
 * invariants `Session.create()` enforces.
 *
 * Persistence note: the v4 JSONL reader is stricter than `Session.create()`.
 * It requires turn/start to open 1,2,3…, so this module renumbers every later
 * turn (and every `turn` field) after a deletion. To rewrite
 * `delivery-accepted.sessionId`, pass both `header` and `newSessionId`; without
 * a new id the rebuilt log is valid for an in-memory Session but a persisted
 * copy will be refused as naming the wrong Session.
 *
 * This module is dependency-free so it can be copied into a plugin.
 */

export class RemapRefusal extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'RemapRefusal'
    this.detail = detail
  }
}

const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

const HANDLED_REF_KEYS = new Set([
  'surfaceOp',
  'sourceEventSeqs',
  'headerSeq',
  'sourceEventSeq',
  'throughSeq',
  'shadowedRange',
  'shadowedSeqs',
  'messageSeqs',
  'targets',
  'through',
])

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

function assertEventEnvelope(event, index) {
  if (!isObject(event)) throw new RemapRefusal(`event at index ${index} is not an object`)
  if (typeof event.type !== 'string' || event.type.length === 0) {
    throw new RemapRefusal(`event at index ${index} has no type`)
  }
  if (event.seq !== index) {
    throw new RemapRefusal(`event at index ${index} has seq ${String(event.seq)}; input must be contiguous from 0`)
  }
  if (!isObject(event.data)) throw new RemapRefusal(`event ${event.seq} (${event.type}) has no object data`)
}

/** Index every complete turn. Throws only on structurally impossible logs. */
export function findTurns(events) {
  const turns = new Map()
  let open = null
  for (const [index, event] of events.entries()) {
    if (event.type === 'turn/start') {
      if (open !== null) {
        throw new RemapRefusal(`turn/start at seq ${event.seq} opens turn ${event.data.turn} while turn ${open.turn} is still open`)
      }
      if (turns.has(event.data.turn)) {
        throw new RemapRefusal(`turn ${event.data.turn} starts twice`)
      }
      open = { turn: event.data.turn, startSeq: event.seq, startIndex: index, endSeq: undefined, endIndex: undefined }
      turns.set(event.data.turn, open)
      continue
    }
    if (event.type !== 'turn/end') continue
    if (open === null || open.turn !== event.data.turn) {
      throw new RemapRefusal(`turn/end ${event.data.turn} at seq ${event.seq} has no matching open turn`)
    }
    open.endSeq = event.seq
    open.endIndex = index
    open = null
  }
  return { turns, openTurn: open?.turn }
}

/**
 * Resolve requested turn numbers to inclusive old-seq ranges, extending each
 * range backwards over the inbox splice(s) that queued this turn's input.
 * The splice after turn/start (which removes the claimed input) is already
 * inside the bracket.
 */
export function planDeletion(events, deleteTurns) {
  const { turns } = findTurns(events)
  const requested = [...new Set(deleteTurns)].sort((a, b) => a - b)
  if (requested.length === 0) throw new RemapRefusal('no turns requested for deletion')
  const ranges = []
  for (const turnNumber of requested) {
    const turn = turns.get(turnNumber)
    if (turn === undefined) throw new RemapRefusal(`turn ${turnNumber} does not exist in this log`)
    if (turn.endSeq === undefined) throw new RemapRefusal(`turn ${turnNumber} is still open (no turn/end); refusing to delete it`)

    let startIndex = turn.startIndex
    let inserted = 0
    let preSplices = 0
    let cursor = turn.startIndex - 1
    while (cursor >= 0) {
      const candidate = events[cursor]
      if (candidate.type !== 'agent/inbox/spliced' || candidate.data?.target !== 'next-turn') break
      const count = Array.isArray(candidate.data.inserted) ? candidate.data.inserted.length : 0
      if (count === 0) break
      inserted += count
      preSplices += 1
      startIndex = cursor
      cursor -= 1
    }

    let removed = 0
    let post = turn.startIndex + 1
    while (post < events.length) {
      const candidate = events[post]
      if (candidate.type !== 'agent/inbox/spliced' || candidate.data?.target !== 'next-turn') break
      removed += Number.isInteger(candidate.data.removedCount) ? candidate.data.removedCount : 0
      post += 1
    }
    if (inserted > 0 && inserted !== removed) {
      throw new RemapRefusal(
        `turn ${turnNumber} is preceded by inbox splice(s) that inserted ${inserted} message(s) but its opening splice removed ${removed}; deleting the whole range would corrupt the queued-inbox fold`,
        { turn: turnNumber },
      )
    }

    ranges.push({
      turn: turnNumber,
      startSeq: events[startIndex].seq,
      endSeq: turn.endSeq,
      preSplices,
    })
  }
  return ranges
}

function expandSeqRanges(value) {
  if (!Array.isArray(value)) throw new RemapRefusal('sourceEventSeqs is not an array')
  const expanded = []
  for (const entry of value) {
    if (typeof entry === 'number') {
      expanded.push(entry)
      continue
    }
    if (Array.isArray(entry) && entry.length === 2
      && Number.isSafeInteger(entry[0]) && Number.isSafeInteger(entry[1]) && entry[0] <= entry[1]) {
      for (let seq = entry[0]; seq <= entry[1]; seq += 1) expanded.push(seq)
      continue
    }
    throw new RemapRefusal(`sourceEventSeqs contains an invalid range entry ${JSON.stringify(entry)}`)
  }
  return expanded
}

function assertRefShape(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RemapRefusal(`${label} is not a non-negative safe integer: ${JSON.stringify(value)}`)
  }
}

/**
 * Validate the final array's surface fold and all event-local reference rules
 * that do not require message content. This is the same node algebra
 * `Session.create()` applies while seeding.
 */
export function assertSurfaceFold(events) {
  const nodes = []
  let protectedHead
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) throw new RemapRefusal(`output event at index ${index} has seq ${event.seq}`)
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      const range = event.data.shadowedRange
      const seqs = event.data.shadowedSeqs
      if (!isObject(range) || !Array.isArray(seqs)) {
        throw new RemapRefusal(`${event.type} at seq ${event.seq} lacks shadowedRange/shadowedSeqs`)
      }
      const start = nodes.indexOf(range.start)
      const end = nodes.indexOf(range.end)
      const expected = start < 0 || end < start ? [] : nodes.slice(start, end + 1)
      if (expected.length !== seqs.length || expected.some((seq, i) => seq !== seqs[i])) {
        throw new RemapRefusal(`${event.type} at seq ${event.seq} shadowedSeqs do not name the exact current surface span ${range.start}..${range.end}`)
      }
      if (protectedHead !== undefined && seqs.includes(protectedHead)) {
        throw new RemapRefusal(`${event.type} at seq ${event.seq} shadows the protected system head ${protectedHead}`)
      }
      continue
    }
    if (!SURFACE_TYPES.has(event.type)) {
      if (event.surfaceOp !== undefined) throw new RemapRefusal(`${event.type} at seq ${event.seq} carries surfaceOp`)
      if (event.sourceEventSeqs !== undefined) throw new RemapRefusal(`${event.type} at seq ${event.seq} carries sourceEventSeqs`)
      continue
    }
    const op = event.surfaceOp
    if (op === 'append') {
      if (event.type === 'system/message' && nodes.length > 0 && protectedHead === undefined) {
        throw new RemapRefusal(`system/message at seq ${event.seq} requires a protected first surface head`)
      }
      if (event.type === 'system/message' && nodes.length === 0) protectedHead = event.seq
      nodes.push(event.seq)
      continue
    }
    if (!isObject(op) || op.op !== 'replace') {
      throw new RemapRefusal(`${event.type} at seq ${event.seq} lacks a valid surfaceOp`)
    }
    assertRefShape(op.startSeq, `${event.type} at seq ${event.seq} surfaceOp.startSeq`)
    assertRefShape(op.endSeq, `${event.type} at seq ${event.seq} surfaceOp.endSeq`)
    if (op.startSeq >= event.seq || op.endSeq >= event.seq) {
      throw new RemapRefusal(`${event.type} at seq ${event.seq} replacement references a non-earlier event`)
    }
    const start = nodes.indexOf(op.startSeq)
    const end = nodes.indexOf(op.endSeq)
    if (start < 0 || end < start) {
      throw new RemapRefusal(`${event.type} at seq ${event.seq} replacement range ${op.startSeq}..${op.endSeq} is not on the current surface`)
    }
    const shadowed = nodes.slice(start, end + 1)
    const sources = new Set(Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [])
    const missing = shadowed.filter(seq => !sources.has(seq))
    if (missing.length > 0) {
      throw new RemapRefusal(`${event.type} at seq ${event.seq} replacement omits shadowed surface nodes ${missing.join(', ')}`)
    }
    if (protectedHead !== undefined && shadowed.includes(protectedHead)) {
      if (event.type !== 'system/message' || shadowed.length !== 1) {
        throw new RemapRefusal(`${event.type} at seq ${event.seq} would shadow the protected system head ${protectedHead}`)
      }
      protectedHead = event.seq
    }
    nodes.splice(start, end - start + 1, event.seq)
  }
  return nodes
}

/** Collect compaction transactions and refuse deletions that split one. */
function assertCompactionTransactions(events, droppedSeqs) {
  const starts = new Map()
  const ends = new Map()
  const summaries = new Map()
  for (const event of events) {
    if (event.type === 'compaction/start') starts.set(event.data.compactionId, event)
    else if (event.type === 'compaction/end') ends.set(event.data.compactionId, event)
    else if (event.type === 'compaction/summary') summaries.set(event.data.compactionId, event)
  }
  for (const [id, start] of starts) {
    const end = ends.get(id)
    if (end === undefined) continue // An already-stale start (crash/fork lifecycle) stays stale.
    const startDropped = droppedSeqs.has(start.seq)
    const endDropped = droppedSeqs.has(end.seq)
    if (startDropped !== endDropped) {
      throw new RemapRefusal(`deletion would split compaction ${id} (start ${start.seq}, end ${end.seq}, one side deleted)`)
    }
    const summary = summaries.get(id)
    const checkpoint = events.find(event => event.type === 'user/message'
      && event.data.source?.kind === 'compact-checkpoint'
      && event.data.source.compactionId === id)
    if (checkpoint !== undefined && !droppedSeqs.has(checkpoint.seq)
      && (startDropped || endDropped || (summary !== undefined && droppedSeqs.has(summary.seq)))) {
      throw new RemapRefusal(`deletion would keep compaction ${id}'s checkpoint ${checkpoint.seq} without its start/end/summary`)
    }
    if (startDropped && endDropped) {
      if (summary !== undefined && !droppedSeqs.has(summary.seq)) {
        throw new RemapRefusal(`deletion would remove compaction ${id}'s start/end but keep its summary ${summary.seq}`)
      }
      continue
    }
    if (summary !== undefined && droppedSeqs.has(summary.seq)) {
      throw new RemapRefusal(`deletion would remove compaction/summary ${summary.seq} while its start/end survive`)
    }
    for (let seq = start.seq + 1; seq < end.seq; seq += 1) {
      if (droppedSeqs.has(seq)) {
        throw new RemapRefusal(`deletion would delete event ${seq} inside the open compaction transaction ${id} (${start.seq}..${end.seq}); v1 refuses to split a compaction`)
      }
    }
  }
}

/** Refuse deleting a live surface replacement while its shadowed target survives. */
function assertReplacementDrops(events, droppedSeqs) {
  for (const event of events) {
    if (!droppedSeqs.has(event.seq)) continue
    const op = event.surfaceOp
    if (!isObject(op) || op.op !== 'replace') continue
    if (!droppedSeqs.has(op.startSeq) || !droppedSeqs.has(op.endSeq)) {
      throw new RemapRefusal(
        `deleting ${event.type} seq ${event.seq} would remove a live surface replacement (${op.startSeq}..${op.endSeq}) and resurrect shadowed history; v1 refuses`,
      )
    }
  }
}

const TITLE_REQUEST_PREFIX = 'Generate the session title from this JSON array of human messages:\n'

/** Parse the framed title request text, which embeds `{seq,text}` objects. */
function titleRequestItems(event) {
  const block = event.data?.messages?.[0]?.content?.[0]
  if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') return undefined
  if (!block.text.startsWith(TITLE_REQUEST_PREFIX)) return undefined
  try {
    const parsed = JSON.parse(block.text.slice(TITLE_REQUEST_PREFIX.length))
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function assertNotFork(header, events, allowFork) {
  if (allowFork) return
  const tagged = events.find(event => event.type === 'session/end-seed' && event.data?.inherited === true)
  if (header?.isSeeded === true || header?.parentSession !== undefined || header?.origin === 'subagent' || tagged !== undefined) {
    throw new RemapRefusal(
      'forked/seeded sessions are not supported by v1: copying or relocating a tagged session/end-seed cut can change which history a later resume treats as inherited',
      { isSeeded: header?.isSeeded, parentSession: header?.parentSession, taggedMarkerSeq: tagged?.seq },
    )
  }
}

/**
 * Validate turn/step numbering against the v4 on-disk relationship rules:
 * turn/start opens 1,2,3…, step/start opens 1,2,3… inside each turn, and
 * turn/end closes a turn with no open step. An open trailing turn is allowed
 * (a crash tail), matching the storage reader.
 */
export function assertTurnAndStepSequence(events) {
  let turn = null
  let step = null
  let nextTurn = 1
  let nextStep = 1
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (turn !== null || event.data.turn !== nextTurn) {
        throw new RemapRefusal(`turn/start at seq ${event.seq} opens ${event.data.turn}, expected ${nextTurn} with no open turn`)
      }
      turn = nextTurn
      step = null
      nextStep = 1
    } else if (event.type === 'turn/end') {
      if (turn === null || event.data.turn !== turn || step !== null) {
        throw new RemapRefusal(`turn/end at seq ${event.seq} does not close the open turn with no open step`)
      }
      turn = null
      nextTurn += 1
    } else if (event.type === 'step/start') {
      if (turn === null || step !== null || event.data.turn !== turn || event.data.step !== nextStep) {
        throw new RemapRefusal(`step/start at seq ${event.seq} does not open step ${nextStep} of turn ${String(turn)}`)
      }
      step = nextStep
    } else if (event.type === 'step/end') {
      if (turn === null || step === null || event.data.turn !== turn || event.data.step !== step) {
        throw new RemapRefusal(`step/end at seq ${event.seq} does not close the open step`)
      }
      step = null
      nextStep += 1
    }
  }
}

/**
 * Remap one session log after deleting whole turns.
 *
 * If `deleteTurns` includes the last closed turn, this performs a cut: every
 * event from the earliest requested range start through EOF is dropped, so no
 * inter-turn record, post-turn title/delivery/command/job record, open turn, or
 * trailing `session/end-seed` survives to reference the removed suffix. The
 * `report.cutRange`/`report.tailRange` fields describe that extension.
 *
 * @param {any[]} events contiguous decoded event array.
 * @param {object} options
 * @param {number[]} options.deleteTurns turn numbers to delete (inclusive brackets plus feeding inbox splices).
 * @param {any} [options.header] stored session header (used for fork refusal and session-id rewrite).
 * @param {string} [options.sourceSessionId]
 * @param {string} [options.newSessionId]
 * @param {boolean} [options.allowFork=false]
 * @param {boolean} [options.rewriteSessionIds=true] rewrite data.sessionId/owner equal to sourceSessionId.
 * @returns {{events:any[], report:object}}
 */
export function remapEvents(events, options = {}) {
  const {
    deleteTurns = [],
    header,
    sourceSessionId = header?.id,
    newSessionId,
    allowFork = false,
    rewriteSessionIds = true,
  } = options
  if (!Array.isArray(events) || events.length === 0) throw new RemapRefusal('events must be a non-empty array')
  for (const [index, event] of events.entries()) assertEventEnvelope(event, index)
  assertNotFork(header, events, allowFork)

  const ranges = planDeletion(events, deleteTurns)
  const deletedTurns = new Set(ranges.map(range => range.turn))
  const deletedSeqs = new Set()

  // Cut semantics: if the requested set reaches the last closed turn, delete
  // everything from the first requested turn to EOF. Deleting only the turn
  // brackets would leave inter-turn records (session/end-seed, titles,
  // delivery watermarks) and any open trailing turn behind, some of which name
  // the removed suffix. Extending to EOF makes the new log end at the last
  // surviving turn/end and covers the plugin's `deleteTurns = [target..last]`.
  const { turns } = findTurns(events)
  const lastClosedTurn = [...turns.values()]
    .filter(turn => turn.endSeq !== undefined)
    .sort((left, right) => left.endIndex - right.endIndex)
    .at(-1)
  let cutRange
  let tailRange
  if (lastClosedTurn !== undefined && ranges.some(range => range.turn === lastClosedTurn.turn)) {
    const startSeq = Math.min(...ranges.map(range => range.startSeq))
    cutRange = { startSeq, endSeq: events.length - 1, eventCount: events.length - startSeq }
    for (let seq = startSeq; seq < events.length; seq += 1) deletedSeqs.add(seq)
    for (const turn of turns.values()) {
      if (turn.startSeq >= startSeq) deletedTurns.add(turn.turn)
    }
    const tailStart = lastClosedTurn.endSeq + 1
    if (tailStart < events.length) {
      tailRange = { startSeq: tailStart, endSeq: events.length - 1, eventCount: events.length - tailStart }
    }
  } else {
    for (const range of ranges) {
      for (let seq = range.startSeq; seq <= range.endSeq; seq += 1) deletedSeqs.add(seq)
    }
  }

  const warnings = []
  const droppedEvents = []
  const policyDropped = new Set()

  // Whole-event drops that are safe and simpler than partial rewriting.
  for (const event of events) {
    if (deletedSeqs.has(event.seq)) continue
    if (event.type === 'session/title' || event.type === 'session/title-llm-request') {
      const seqs = Array.isArray(event.data.messageSeqs) ? event.data.messageSeqs : []
      if (seqs.some(seq => deletedSeqs.has(seq))) {
        policyDropped.add(event.seq)
        droppedEvents.push({ seq: event.seq, type: event.type, reason: 'title cites a deleted human message' })
      } else if (event.type === 'session/title-llm-request') {
        const block = event.data?.messages?.[0]?.content?.[0]
        if (isObject(block) && typeof block.text === 'string' && block.text.startsWith(TITLE_REQUEST_PREFIX)
          && titleRequestItems(event) === undefined) {
          policyDropped.add(event.seq)
          droppedEvents.push({ seq: event.seq, type: event.type, reason: 'framed title request text is not parseable, so its embedded seqs cannot be remapped' })
        }
      }
    } else if (event.type === 'image/offload') {
      const targets = Array.isArray(event.data.targets) ? event.data.targets : []
      if (targets.length > 0 && targets.every(target => deletedSeqs.has(target.seq))) {
        policyDropped.add(event.seq)
        droppedEvents.push({ seq: event.seq, type: event.type, reason: 'every offload target was deleted' })
      }
    }
  }

  const droppedSeqs = new Set([...deletedSeqs, ...policyDropped])

  // A command/done whose command/run was inside the deleted turn would make the
  // strict v4 reader reject the log ("no prior command/run"). The done record is
  // log-only presentation, so drop it rather than keep a broken pair.
  const survivingCommandRuns = new Set(
    events
      .filter(event => event.type === 'command/run' && !deletedSeqs.has(event.seq) && !policyDropped.has(event.seq))
      .map(event => event.data.commandId),
  )
  for (const event of events) {
    if (event.type !== 'command/done' || deletedSeqs.has(event.seq) || policyDropped.has(event.seq)) continue
    if (!survivingCommandRuns.has(event.data.commandId)) {
      policyDropped.add(event.seq)
      droppedSeqs.add(event.seq)
      droppedEvents.push({ seq: event.seq, type: event.type, reason: 'its command/run was deleted' })
    }
  }

  assertReplacementDrops(events, droppedSeqs)
  assertCompactionTransactions(events, droppedSeqs)

  const newSeqOf = new Map()
  const survivors = []
  for (const event of events) {
    if (droppedSeqs.has(event.seq)) continue
    newSeqOf.set(event.seq, survivors.length)
    survivors.push(event)
  }

  // The v4 on-disk relationship validator requires turn/start to open
  // 1, 2, 3, … and step/start to open 1, 2, 3, … inside each turn. Deleting a
  // middle turn therefore forces us to renumber every later turn; step numbers
  // inside surviving turns are already contiguous. (Session.create() alone
  // tolerates a gap, but a persisted log does not reopen.)
  const turnMap = new Map()
  for (const event of events) {
    if (droppedSeqs.has(event.seq) || event.type !== 'turn/start') continue
    turnMap.set(event.data.turn, turnMap.size + 1)
  }
  const renumberTurns = (value, seq, type) => {
    if (Array.isArray(value)) {
      for (const child of value) renumberTurns(child, seq, type)
      return
    }
    if (!isObject(value)) return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'turn' && Number.isInteger(child)) {
        if (turnMap.has(child)) value[key] = turnMap.get(child)
        else if (deletedTurns.has(child)) {
          throw new RemapRefusal(`${type} at source seq ${seq} references deleted turn ${child}`)
        }
      }
      renumberTurns(child, seq, type)
    }
  }

  const mapRef = (seq, label) => {
    assertRefShape(seq, label)
    if (seq >= events.length) throw new RemapRefusal(`${label} points past the end of the source log: ${seq}`)
    const mapped = newSeqOf.get(seq)
    if (mapped === undefined) throw new RemapRefusal(`${label} points at dropped event ${seq}`)
    return mapped
  }
  const predecessor = oldSeq => {
    for (let seq = oldSeq - 1; seq >= 0; seq -= 1) {
      const mapped = newSeqOf.get(seq)
      if (mapped !== undefined) return mapped
    }
    return 0
  }
  const rewriteOptional = (value, label) => {
    if (value === undefined) return undefined
    if (deletedSeqs.has(value) || policyDropped.has(value)) return undefined
    return mapRef(value, label)
  }

  const rewrites = {
    surfaceOp: 0, sourceEventSeqs: 0, headerSeq: 0, sourceEventSeq: 0,
    shadowed: 0, messageSeqs: 0, titleText: 0, imageTargets: 0, through: 0, sessionIds: 0,
  }

  const sourceHeaders = events.filter(event => event.type === 'request/header')

  const out = survivors.map(source => {
    const event = structuredClone(source)
    event.seq = newSeqOf.get(source.seq)
    renumberTurns(event.data, source.seq, event.type)

    if (isObject(event.surfaceOp) && event.surfaceOp.op === 'replace') {
      const op = event.surfaceOp
      if (droppedSeqs.has(op.startSeq) || droppedSeqs.has(op.endSeq)) {
        throw new RemapRefusal(
          `${event.type} at source seq ${source.seq} is a live replacement whose range ${op.startSeq}..${op.endSeq} includes a deleted turn; deleting it would either dangle the range or resurrect shadowed history`,
          { seq: source.seq, startSeq: op.startSeq, endSeq: op.endSeq },
        )
      }
      op.startSeq = mapRef(op.startSeq, `${event.type} surfaceOp.startSeq`)
      op.endSeq = mapRef(op.endSeq, `${event.type} surfaceOp.endSeq`)
      rewrites.surfaceOp += 1
    }

    if (event.sourceEventSeqs !== undefined) {
      if (event.type === 'assistant/message') {
        throw new RemapRefusal(`assistant/message at source seq ${source.seq} cannot carry sourceEventSeqs`)
      }
      const expanded = expandSeqRanges(event.sourceEventSeqs)
      const mapped = []
      for (const seq of expanded) {
        if (seq >= events.length) throw new RemapRefusal(`sourceEventSeqs cites past the end: ${seq}`)
        if (!newSeqOf.has(seq)) continue
        mapped.push(newSeqOf.get(seq))
      }
      if (mapped.length === 0) delete event.sourceEventSeqs
      else event.sourceEventSeqs = mapped
      rewrites.sourceEventSeqs += 1
    }

    if (event.type === 'developer/message' && event.data.headerSeq !== undefined) {
      const old = event.data.headerSeq
      if (newSeqOf.has(old)) {
        event.data.headerSeq = newSeqOf.get(old)
      } else {
        const additions = (Array.isArray(event.data.message?.content) ? event.data.message.content : [])
          .filter(block => block?.type === 'tool-addition')
          .map(block => block.toolName)
        if (additions.length === 0) {
          throw new RemapRefusal(`developer/message at source seq ${source.seq} has headerSeq ${old} but no tool-addition blocks`)
        }
        const earlier = sourceHeaders
          .filter(candidate => candidate.seq < source.seq && newSeqOf.has(candidate.seq))
          .reverse()
          .find(candidate => additions.every(name => {
            const tools = Array.isArray(candidate.data.header?.tools) ? candidate.data.header.tools : []
            const matches = tools.filter(tool => tool.name === name)
            const tool = matches[0]
            return matches.length === 1
              && typeof tool.description === 'string'
              && isObject(tool.parameters)
              && tool.deferLoading !== false
          }))
        if (earlier === undefined) {
          throw new RemapRefusal(
            `developer/message at source seq ${source.seq} needs tool-addition header seq ${old}, which is deleted, and no earlier surviving request/header defines ${additions.join(', ')}; v1 refuses`,
          )
        }
        event.data.headerSeq = newSeqOf.get(earlier.seq)
        warnings.push(`developer/message ${source.seq}: headerSeq ${old} deleted; repointed to earlier request/header ${earlier.seq}`)
      }
      rewrites.headerSeq += 1
    }

    if (event.type === 'command/done' && event.data.sourceEventSeq !== undefined) {
      const mapped = rewriteOptional(event.data.sourceEventSeq, `command/done ${source.seq} sourceEventSeq`)
      if (mapped === undefined) {
        delete event.data.sourceEventSeq
        warnings.push(`command/done ${source.seq}: dropped sourceEventSeq pointing at a deleted event (optional presentation citation)`)
      } else {
        event.data.sourceEventSeq = mapped
        rewrites.sourceEventSeq += 1
      }
    }

    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      const range = event.data.shadowedRange
      if (isObject(range)) {
        if (droppedSeqs.has(range.start) || droppedSeqs.has(range.end)) {
          throw new RemapRefusal(
            `${event.type} at source seq ${source.seq} prices a range ${range.start}..${range.end} whose endpoint is deleted; its paired surface replacement cannot remain valid`,
          )
        }
        range.start = mapRef(range.start, `${event.type} shadowedRange.start`)
        range.end = mapRef(range.end, `${event.type} shadowedRange.end`)
      }
      if (Array.isArray(event.data.shadowedSeqs)) {
        event.data.shadowedSeqs = event.data.shadowedSeqs
          .filter(seq => newSeqOf.has(seq))
          .map(seq => newSeqOf.get(seq))
        rewrites.shadowed += 1
      }
      const kept = event.data.shadowedSeqs?.length
      const original = Array.isArray(source.data.shadowedSeqs) ? source.data.shadowedSeqs.length : 0
      if (kept !== undefined && kept !== original) {
        warnings.push(`${event.type} ${source.seq}: filtered ${original - kept} deleted seq(s) out of shadowedSeqs; shadowedTokenCount is left as the historical price of the original range`)
      }
    }

    if (event.type === 'session/title' || event.type === 'session/title-llm-request') {
      if (Array.isArray(event.data.messageSeqs)) {
        event.data.messageSeqs = event.data.messageSeqs
          .filter(seq => newSeqOf.has(seq))
          .map(seq => newSeqOf.get(seq))
        rewrites.messageSeqs += 1
      }
      if (event.type === 'session/title-llm-request') {
        const items = titleRequestItems(event)
        if (items !== undefined) {
          const rewritten = items.map(item => {
            if (!isObject(item) || typeof item.seq !== 'number') return item
            if (!newSeqOf.has(item.seq)) {
              throw new RemapRefusal(`session/title-llm-request at source seq ${source.seq} embeds dropped seq ${item.seq} in its request text`)
            }
            return { ...item, seq: newSeqOf.get(item.seq) }
          })
          const block = event.data.messages[0].content[0]
          block.text = `${TITLE_REQUEST_PREFIX}${JSON.stringify(rewritten)}`
          rewrites.titleText += 1
          if (Array.isArray(event.data.messageSeqs) && rewritten.length !== event.data.messageSeqs.length) {
            warnings.push(`session/title-llm-request ${source.seq}: embedded request text has ${rewritten.length} item(s) but messageSeqs has ${event.data.messageSeqs.length}`)
          }
        }
      }
    }

    if (event.type === 'image/offload') {
      if (!Array.isArray(event.data.targets)) throw new RemapRefusal(`image/offload at source seq ${source.seq} has no targets array`)
      event.data.targets = event.data.targets
        .filter(target => newSeqOf.has(target.seq))
        .map(target => ({ ...target, seq: newSeqOf.get(target.seq) }))
      if (event.data.targets.length === 0) {
        // The whole-event drop was already precomputed; this is defensive.
        throw new RemapRefusal(`image/offload at source seq ${source.seq} lost every target but was not dropped`)
      }
      rewrites.imageTargets += 1
    }

    if (event.type === 'session-log-deepseek/delivery-accepted' && event.data.throughSeq !== undefined) {
      const old = event.data.throughSeq
      if (newSeqOf.has(old)) {
        event.data.throughSeq = newSeqOf.get(old)
        rewrites.through += 1
      } else {
        event.data.throughSeq = predecessor(old)
        warnings.push(`delivery-accepted ${source.seq}: throughSeq ${old} targeted a deleted event; clamped to predecessor ${event.data.throughSeq}`)
      }
    }

    if (event.type === 'user/message' && event.data.source?.kind === 'action-cards' && event.data.source.through !== undefined) {
      const old = event.data.source.through
      if (newSeqOf.has(old)) {
        event.data.source.through = newSeqOf.get(old)
      } else {
        event.data.source.through = predecessor(old)
        warnings.push(`action-cards message ${source.seq}: source.through ${old} targeted a deleted decision; clamped to predecessor ${event.data.source.through}`)
      }
      rewrites.through += 1
    }

    if (rewriteSessionIds && sourceSessionId !== undefined && newSessionId !== undefined) {
      const walk = value => {
        if (Array.isArray(value)) return value.forEach(walk)
        if (!isObject(value)) return
        for (const [key, child] of Object.entries(value)) {
          if ((key === 'sessionId' || key === 'owner') && child === sourceSessionId) {
            value[key] = newSessionId
            rewrites.sessionIds += 1
          } else {
            walk(child)
          }
        }
      }
      walk(event.data)
    }

    // Generic fallback: any unhandled `*Seq`/`*Seqs`/nested `seq` field must
    // either remap cleanly or be refused. No silent stale numbers.
    const walkGeneric = (value, path) => {
      if (Array.isArray(value)) {
        for (const [index, child] of value.entries()) walkGeneric(child, `${path}[${index}]`)
        return
      }
      if (!isObject(value)) return
      for (const [key, child] of Object.entries(value)) {
        const childPath = path === '' ? key : `${path}.${key}`
        if (HANDLED_REF_KEYS.has(key)) continue
        if (/seq$/i.test(key) && typeof child === 'number') {
          if (newSeqOf.has(child)) value[key] = newSeqOf.get(child)
          else if (droppedSeqs.has(child)) {
            throw new RemapRefusal(`${event.type} at source seq ${source.seq} has unhandled ${childPath} -> dropped event ${child}`)
          }
          continue
        }
        if (/seqs$/i.test(key) && Array.isArray(child)) {
          const mapped = child.map(entry => {
            if (typeof entry !== 'number') return entry
            if (newSeqOf.has(entry)) return newSeqOf.get(entry)
            if (droppedSeqs.has(entry)) {
              throw new RemapRefusal(`${event.type} at source seq ${source.seq} has unhandled ${childPath} entry -> dropped event ${entry}`)
            }
            return entry
          })
          value[key] = mapped
          continue
        }
        walkGeneric(child, childPath)
      }
    }
    walkGeneric(event.data, '')

    return event
  })

  // Turn numbers are renumbered so the persisted v4 log reopens; see turnMap.
  const nodes = assertSurfaceFold(out)
  assertTurnAndStepSequence(out)

  const turnStarts = out.filter(event => event.type === 'turn/start').map(event => event.data.turn)
  const gaps = []
  for (let index = 1; index < turnStarts.length; index += 1) {
    if (turnStarts[index] !== turnStarts[index - 1] + 1) {
      gaps.push([turnStarts[index - 1], turnStarts[index]])
    }
  }
  const renumberedTurns = [...turnMap].filter(([oldTurn, newTurn]) => oldTurn !== newTurn).length

  return {
    events: out,
    report: {
      oldEventCount: events.length,
      newEventCount: out.length,
      deletedTurns: [...deletedTurns].sort((a, b) => a - b),
      deletionRanges: ranges,
      cutRange,
      tailRange,
      deletedEventCount: deletedSeqs.size,
      policyDroppedEvents: droppedEvents,
      newSeqOf,
      surfaceNodes: nodes,
      rewrites,
      warnings,
      turnNumbers: { count: turnStarts.length, gaps, first: turnStarts[0], last: turnStarts.at(-1), renumberedTurns },
    },
  }
}

export default remapEvents
