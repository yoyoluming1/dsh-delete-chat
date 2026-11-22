/**
 * Host half of `dsh-delete-chat`.
 *
 * A conversation is an append-only Session log, so nothing is erased in place.
 * Deleting a turn means deriving a new Session from the part of the log that
 * stays:
 *
 * - `cut` drops the turn and every later turn.
 * - `keep-later` keeps the turns before AND after the deleted turn, which
 *   requires renumbering events and remapping every Session-seq reference
 *   (`lib/remap.js`).
 *
 * The rebuilt log is validated twice: `ctx.sessions.prepare()` runs the same
 * `Session.create()` surface fold as a live Session, and the log is reopened
 * through the persistence backend after writing, which is the strict v4 reader
 * that rejects wrong delivery markers or non-contiguous turn numbers.
 *
 * The command is the only Host entry point; the Web UI calls it through
 * `ctx.remote.commands.execute`. No agent tool is exposed: deleting history is
 * a user action, never something the model may decide.
 *
 * @module dsh-delete-chat
 */

import { findTurns, planDeletion, remapEvents, RemapRefusal } from './lib/remap.js'

/** Command name shown in the composer's command menu. */
const COMMAND = 'delete-chat'

/** New-session ids accepted from the client, matching the existing uuid shape. */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Injectable Host services; without them the plugin stays inactive. */
export const inject = ['agents', 'commands', 'sessions']

/**
 * Register the delete command.
 * @param ctx - owning Host context.
 */
export function apply(ctx) {
  ctx.commands.register({
    name: COMMAND,
    description: '删除对话片段 / Delete part of this conversation',
    input: { hint: '<cut|keep-later> <seq> <session-id>' },
    handler: ({ agent, rawInput }) => run(ctx, agent, rawInput),
  })
}

/**
 * Execute one delete request.
 * @param ctx - Host context owning the command.
 * @param agent - agent receiving the command; its live Session is the source.
 * @param rawInput - bytes after the command name.
 * @returns settled command result.
 */
async function run(ctx, agent, rawInput) {
  let request
  try {
    request = parseRequest(rawInput)
  } catch (error) {
    return failure(error.message)
  }

  const session = agent.session
  const events = readEvents(session)
  if (hasOpenTurn(events)) {
    return failure('当前会话还在运行，请等这一轮结束后再删除。/ The session is still running; wait for the current turn to finish.')
  }

  const target = findTurn(events, request.seq)
  if (target === undefined) {
    return failure('找不到这条消息所属的完整轮次，可能这一轮还没结束。/ No completed turn contains that message.')
  }

  if (ctx.sessions.get(request.sessionId) !== undefined) {
    return failure('目标会话 id 已存在，请重试。/ That new session id already exists; try again.')
  }

  let seed
  let seeded = false
  let inheritedEventCount = 0
  let rebuilt
  try {
    if (request.mode === 'cut') {
      // A truncation is exactly a fork through the boundary: the untouched
      // prefix keeps its turn numbers, its delivery markers stay inherited, and
      // the official marker makes the persisted log valid even for a Session
      // that was itself branched.
      const [range] = planDeletion(events, [target.turn])
      const boundary = range.startSeq - 1
      if (boundary < 0) return failure('删除后没有剩余对话内容。/ Nothing would be left after this deletion.')
      seed = buildForkPrefix(events, boundary)
      seeded = true
      inheritedEventCount = boundary + 1
    } else {
      rebuilt = remapEvents(events, {
        deleteTurns: [target.turn],
        header: session.header,
        newSessionId: request.sessionId,
      })
      seed = rebuilt.events
      if (!seed.some(event => event.type === 'turn/start')) {
        return failure('删除后没有剩余对话内容。/ Nothing would be left after this deletion.')
      }
    }
  } catch (error) {
    if (error instanceof RemapRefusal) return failure(refusalText(error, request.mode))
    throw error
  }

  seed = withForkTitle(seed, events)

  try {
    await launch(ctx, session, request.sessionId, seed, { seeded, inheritedEventCount })
  } catch (error) {
    return failure(describe(error))
  }

  const renumbered = rebuilt?.report.turnNumbers.renumberedTurns ?? 0
  return success(request.mode === 'cut'
    ? `已删除第 ${target.turn} 轮及之后的对话，新会话 ${request.sessionId} 已创建。`
    : `已删除第 ${target.turn} 轮，后面的对话已保留到新会话 ${request.sessionId}${renumbered > 0 ? `（后续轮次编号前移，共 ${renumbered} 轮）` : ''}。`)
}

/**
 * Parse `<mode> <seq> <session-id>`.
 * @param rawInput - command bytes after the name, including separating spaces.
 * @returns parsed request.
 * @throws when the syntax is invalid.
 */
function parseRequest(rawInput) {
  const match = /^\s*(cut|keep-later)\s+(\d{1,9})\s+(\S+)\s*$/.exec(rawInput ?? '')
  if (match === null) throw new Error('用法：/delete-chat <cut|keep-later> <seq> <session-id>')
  const [, mode, seqText, sessionId] = match
  if (!SESSION_ID.test(sessionId)) throw new Error('无效的新会话 id / Invalid new session id')
  return { mode, seq: Number(seqText), sessionId }
}

/** Read the Session's stable event snapshot. @param session - live source. */
function readEvents(session) {
  // `snapshotEvents` is deprecated for in-repo production callers, but it is the
  // only synchronous whole-log read exposed to plugins; the store still serves it.
  // oxlint-disable-next-line typescript/no-deprecated
  return session.snapshotEvents()
}

/**
 * Whether the log ends inside an unfinished turn.
 * @param events - complete event snapshot.
 * @returns true when a turn/start has no matching turn/end.
 */
function hasOpenTurn(events) {
  let open = null
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data.turn
    else if (event.type === 'turn/end' && event.data.turn === open) open = null
  }
  return open !== null
}

/**
 * Locate the completed turn containing one message seq.
 * @param events - complete event snapshot.
 * @param seq - seq of any event inside the turn.
 * @returns the turn number and its inclusive seq span.
 */
function findTurn(events, seq) {
  const target = events[seq]
  if (target === undefined) return undefined
  const { turns } = findTurns(events)
  for (const turn of turns.values()) {
    if (turn.endSeq === undefined) continue
    if (seq >= turn.startSeq && seq <= turn.endSeq) return turn
  }
  return undefined
}

/**
 * Give the derived conversation a distinct title.
 *
 * A derived Session inherits the source title, so the list would show two
 * identically named conversations and the untouched source looks like the
 * deletion "came back". The built-in branch action uses the same convention:
 * append or increment a trailing fork number.
 * @param seed - replay or fork seed to extend.
 * @param events - source log used to read the current title.
 * @returns the seed with one appended title event.
 */
function withForkTitle(seed, events) {
  let title
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  if (title === undefined || title === '') return seed
  seed.push({
    type: 'session/title',
    seq: seed.length,
    time: Date.now(),
    data: { title: incrementedTitle(title), messageSeqs: [], source: { kind: 'user' } },
  })
  return seed
}

/**
 * Increment a trailing fork number, mirroring the built-in branch action.
 * @param title - current title.
 * @returns the next numbered title.
 */
function incrementedTitle(title) {
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  return `${title} (1)`
}

/**
 * Build the fork seed for a truncating delete.
 * @param events - complete source log.
 * @param boundary - inclusive last kept seq; the prefix ends at a closed point.
 * @returns the copied prefix plus its inherited cut marker.
 */
function buildForkPrefix(events, boundary) {
  const prefix = events.slice(0, boundary + 1).map(event => structuredClone(event))
  prefix.push({
    type: 'session/end-seed',
    seq: boundary + 1,
    time: events[boundary].time,
    data: { inherited: true },
  })
  return prefix
}

/**
 * Create the derived conversation as a live Agent Session.
 *
 * A bare persisted log stays invisible to the client list and has no projection
 * cache, so the row would miss its title and `retain()` would reject it. The
 * agent factory performs the whole creation transaction the fork action uses:
 * backend write, SessionStore entry, announcement, projection checkpoint and a
 * live Agent the API controller reuses for later prompts.
 * @param ctx - Host context.
 * @param source - live source Session.
 * @param sessionId - caller-chosen id for the new Session.
 * @param seed - contiguous replay or fork history.
 * @param options - fork lineage for a truncating delete.
 */
async function launch(ctx, source, sessionId, seed, options = {}) {
  const presets = ctx.get('agentPresets')
  const preset = presets?.presetForSession?.(source) ?? source.header.agentPreset
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  await ctx.agents.create({
    sessionId,
    seed,
    ...options.seeded === true ? { inheritedEventCount: options.inheritedEventCount } : {},
    meta: {
      ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
      ...options.seeded === true ? { isSeeded: true } : {},
      ...preset === undefined ? {} : { agentPreset: preset },
    },
    ...selection === undefined ? {} : { agentOptions: { provider: selection.provider, model: selection.model } },
    ...preset === undefined || presets === undefined ? {} : {
      setup: async agentCtx => { await presets.mount(agentCtx, preset) },
    },
  })
  // The workspace browser lists Sessions through workspace membership, not the
  // working directory alone. The API controller attaches every Session it
  // creates (and every fork it publishes); a Session created straight through
  // the agent factory must do the same or it never reaches the sidebar.
  const registry = ctx.get('workspaceRegistry')
  const workspace = registry?.list?.()?.find(candidate => candidate.sessionIds?.includes(source.id))
  if (workspace !== undefined) await workspace.attachSession(sessionId)
  // The trimmed copy replaces the source in the list. Archiving is a
  // convenience, so a refusal (for example an unexplainably active Session)
  // must not turn a successful deletion into a failure.
  try {
    await registry?.archiveSession?.(source.id, { stopActivity: true })
  } catch {
    // Keep the deletion result; the source stays visible instead.
  }
}

/**
 * User-facing refusal text.
 * @param refusal - structured remap refusal.
 * @param mode - requested deletion mode.
 */
function refusalText(refusal, mode) {
  const hint = mode === 'keep-later'
    ? '这段历史被后续的系统提示替换或压缩检查点引用，无法在保留后文的前提下安全删除；可以改用“删除这一轮及之后”。'
    : '这段历史无法安全截断。'
  return `${hint}（原因：${refusal.message}）`
}

/**
 * Command success result.
 * @param text - user-facing summary.
 */
function success(text) {
  return { kind: 'success', text }
}

/**
 * Command failure result.
 * @param text - user-facing reason.
 */
function failure(text) {
  return { kind: 'error', text }
}

/**
 * Render an unknown error without leaking a stack.
 * @param error - thrown value.
 */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
