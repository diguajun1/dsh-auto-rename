// dsh-auto-rename — slash command `/auto-rename` for the DSH web input box,
// plus an idle auto mode that runs the same naming turn on its own.
//
// What it does: typing `/auto-rename` (or, in idle auto mode, staying idle
// after a turn) asks the model (in one ordinary agent turn) to read the full
// current session, recommend a dated title in the `YYYY-MM-DD_语义名` shape,
// and then apply it automatically through the same official chain as the
// sidebar rename (`sessionTitle.rename` -> `sessions.flush`). The date prefix
// is computed host-side from the session log (no shell, no file stat), so it
// is identical across macOS / Linux / Windows and does not depend on the
// model guessing the session start date.
//
// How it achieves that inside DSH's split-plane architecture:
//
//   1. Registered commands run in the UI command plane, host-side, with NO
//      model message created (`command/run` + `command/done` lifecycle only).
//   2. A model-visible tool CAN be registered through `ctx.tools` (the same
//      official seam the anysearch plugin uses). The handler therefore
//      enqueues one ordinary user-role prompt through `agent.followup()` —
//      the exact mechanism the official `/goal` command uses to feed the
//      agent — so the main model reads the full session in its own context
//      window (no token-cost duplication beyond a normal turn) and calls the
//      registered `rename_current_session` tool to persist the title.
//   3. If the session-title service or the agent inbox is unavailable, the
//      command degrades to a clear text answer instead of failing startup.
//
// Idle auto mode (opt-in per row config, on by default with 5 minutes):
//
//   A host-plane listener observes `session/event`. A turn that a HUMAN started
//   (`user/message` with `source.kind === 'user'`) arms one `setTimeout` for
//   that session; the timer is cleared by any further human message, by the
//   next `turn/start`, and by session disposal. When the timer survives the
//   whole window, the plugin enqueues the very same naming prompt the
//   `/auto-rename` command enqueues. Two states keep that from looping:
//   `awaitingRename` swallows the `turn/end` of the naming turn itself (so the
//   plugin never re-arms on its own output), and `pendingUserTurn` is only set
//   by a human message, so a session that the person stopped touching is
//   renamed at most once per conversation.
//
// Design constraints (kept intentionally identical to dsh-rename):
//   - No import of any `@deepseek-ai` internal package.
//   - No peerDependencies; only stable public surfaces (`commands`,
//     `sessionTitle`, `sessions`, `agents`) plus the documented agent tool seam.
//   - Pure JS, zero native dependencies -> runs on macOS / Linux / Windows
//     and across DSH web-profile versions; verified against the running host.

import { randomUUID } from 'node:crypto'

/** Cordis plugin name (loader diagnostics). */
export const name = 'dsh-auto-rename'

/**
 * Services the row waits for before starting. `commands` is the official
 * human slash-command registry; `sessions` is injected so
 * `ctx.sessions.flush` is legal to call; `tools` is injected so the
 * model-visible rename tool is registered into the tool registry before any
 * model turn assembles its toolset (the same seam the anysearch plugin uses).
 * `sessionTitle` and `agents` are resolved lazily (`ctx.get`) so a deployment
 * without them degrades to a clear error instead of failing startup.
 */
export const inject = ['commands', 'sessions', 'tools']

/** Source kinds the host records for a message a human typed. */
export const HUMAN_SOURCE_KINDS = ['user', 'user-approval']

/** Source kind this plugin stamps on the prompts it enqueues. */
export const SELF_SOURCE_KIND = 'plugin:dsh-auto-rename'

/** Default idle window before the automatic naming turn: five minutes. */
export const DEFAULT_IDLE_MS = 5 * 60 * 1000

/** Re-check delay while the session still looks busy (running turn, inbox work). */
const BUSY_RECHECK_MS = 15 * 1000

/**
 * YYYY-MM-DD prefix for a session title. This is the ONE host-side fact the
 * model cannot reliably invent, so the plugin computes it from the session
 * log instead of asking the model to. Fallback is the current local date
 * when the log exposes no usable timestamp (never crashes).
 *
 * @param {import('node:events').EventEmitter & {snapshotEvents?: () => unknown[]}} session - live session object.
 * @returns {string} local date `YYYY-MM-DD`.
 */
export function sessionStartDateOf(session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
    if (Array.isArray(events) && events.length > 0) {
      for (const event of events) {
        const time = event?.time
        if (typeof time === 'number' && Number.isFinite(time) && time > 0) {
          return toLocalDate(new Date(time))
        }
        const created = event?.data?.createdAt
        if (typeof created === 'number' && Number.isFinite(created) && created > 0) {
          return toLocalDate(new Date(created))
        }
      }
    }
  } catch {
    /* fall through to today */
  }
  return toLocalDate(new Date())
}

/** Local-date `YYYY-MM-DD` for one Date. */
function toLocalDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Strip a leading `YYYY-MM-DD` date prefix plus any single separator so the
 * semantic part survives when a caller already passed the full form.
 * @param {string} title
 * @returns {string}
 */
export function stripDatePrefix(title) {
  return String(title).replace(/^\s*\d{4}-\d{2}-\d{2}\s*[-_:\s：]*/, '').trim()
}

/**
 * Normalize one accepted title so it always carries the `YYYY-MM-DD_` date
 * prefix of the session start date. Double-prefixing is impossible: any
 * existing leading date is dropped first.
 *
 * @param {string} date - session start date `YYYY-MM-DD`.
 * @param {string} title - semantic title supplied by the model or the user.
 * @returns {string} `YYYY-MM-DD_semantic`
 */
export function withDatePrefix(date, title) {
  const semantic = stripDatePrefix(title)
  if (semantic.length === 0) return title.trim()
  return `${date}_${semantic}`
}

/**
 * Build the user-role prompt that drives the naming turn. It mirrors the
 * recommend-new-session-name skill contract: one recommended name
 * (`YYYY-MM-DD_语义名`), a one-line reason, alternatives, and the explicit
 * instruction to apply it through the registered rename tool.
 *
 * @param {string} date - session start date `YYYY-MM-DD`.
 * @returns {string}
 */
export function buildAutoRenamePrompt(date) {
  return [
    '请你为当前这个 DSH 会话推荐一个名字，并直接应用它。',
    '',
    '请只做下面这一件事，不要做其他任何操作，不要询问用户：',
    '',
    `1. 通读本会话的完整对话内容，找出这段会话真正在做的核心工作（1-3 个概念）。不要假设任何项目或领域，完全基于对话内容本身。`,
    `2. 用与会话语言一致的语言，生成一个简洁、一眼能看懂的语义名：优先不超过 20 个字符；只有核心概念确实需要更长时才可突破，总长建议不超过 40 个字符。不要用「讨论」「整理」「弄一下」这类空泛词。`,
    `3. 推荐名 = \`${date}_语义名\`。日期前缀必须是 ${date}（会话开始日期），不要用今天，不要自己改日期。语义名不要带引号、不要带空格外的多余符号。`,
    `4. 调用工具 \`rename_current_session\`，参数 title 传 \`${date}_语义名\`（完整带上日期前缀），完成实际改名。`,
    '',
    '然后按下面结构原样输出（标签与内容之间必须空行，单个换行会被 Markdown 折叠成空格）：',
    '',
    '推荐：',
    '',
    `<最终推荐名>`,
    '',
    '推荐原因：',
    '',
    `<一句话说明这段会话的核心工作与命名依据>`,
    '',
    '改名方式：',
    '',
    '已通过 rename_current_session 自动应用。',
    '',
    '其他备选：',
    '',
    `- <备选名1>`,
    `- <备选名2>`,
    '',
    '硬性规则：不要先问用户；不要在模型里凭空捏造会话内容；如果会话还没有任何实质内容、无法提炼核心概念，就直接说明无法推荐并结束，不要改名。',
  ].join('\n')
}

/**
 * Enqueue one naming turn into an agent's inbox. Kept separate from the
 * command handler so idle auto mode and `/auto-rename` share exactly one
 * enqueue path.
 *
 * A user message reaching the agent seam MUST carry a stable `id`, a `role`,
 * and a producer-owned `source`: the host records it verbatim in
 * `agent/inbox/spliced` and later in `user/message`, and the released
 * Session validator refuses the event when any of them is missing, which
 * makes the whole session unopenable. Official producers use
 * createUserMessage(); this plugin stays import-free, so it supplies all
 * three members itself.
 *
 * Session format v4 retired the V3 `{ kind: 'plugin', plugin: <name> }`
 * wrapper: a plugin is identified by its own `plugin:<name>` kind. That is
 * exactly the kind the v3->v4 migrator derives for rows earlier versions
 * wrote, so both generations read back under one shape.
 *
 * @param {object} agent - live agent whose session should be renamed.
 * @param {string} date - session start date `YYYY-MM-DD`.
 * @returns {void}
 */
export function enqueueNamingTurn(agent, date) {
  agent.followup({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: buildAutoRenamePrompt(date) }],
    source: { kind: SELF_SOURCE_KIND },
  })
}

/**
 * Model-visible rename tool registered lazily on `ctx.tools`. When the model
 * turn calls it, the host performs the official rename chain and returns the
 * accepted title so the model can confirm it in its answer.
 *
 * @param {object} ctx - plugin context.
 * @returns {object} a dsh-tools definition (hand-written, no internal import).
 */
export function createRenameTool(ctx) {
  return {
    name: 'rename_current_session',
    description:
      'Rename the CURRENT session to the given title. This is how the /auto-rename flow persists the recommended name. Pass title in the form YYYY-MM-DD_语义名 (date prefix + underscore + short semantic name). The host normalizes the date prefix from the session start date.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'Full new title, e.g. 2026-01-01_实现自动改名插件',
        },
      },
      required: ['title'],
    },
    timeoutMs: 15000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          acceptedTitle: { type: 'string' },
        },
        required: ['acceptedTitle'],
      },
      render: (_args, value) => [
        { type: 'text', text: `Renamed session to: ${value.acceptedTitle}` },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined || session === null) {
        throw new Error('rename_current_session: no current session in this execution context')
      }
      const raw = typeof args?.title === 'string' ? args.title.trim() : ''
      if (raw.length === 0) {
        throw new Error('rename_current_session: title is required and must not be empty')
      }
      const sessionTitle = ctx.get?.('sessionTitle')
      if (sessionTitle === undefined) {
        throw new Error('rename_current_session: this deployment has no session-title service; cannot rename.')
      }
      const date = sessionStartDateOf(session)
      const finalTitle = withDatePrefix(date, raw)
      const accepted = sessionTitle.rename(session, finalTitle)
      const sessions = ctx.sessions
      if (sessions !== undefined && typeof sessions.flush === 'function') {
        await sessions.flush(session)
      }
      const label = accepted?.title ?? finalTitle
      return { acceptedTitle: label }
    },
  }
}

/**
 * Slash-command handler: `/auto-rename`.
 *
 * @param {object} ctx - plugin context.
 * @param {object} invocation - command invocation ({@code agent, rawInput, signal}).
 * @returns {Promise<{kind:'success'|'error', text:string}>}
 */
async function autoRenameCurrentSession(ctx, invocation) {
  const raw = invocation.rawInput
  const agent = invocation.agent

  if (raw !== undefined && raw.trim().length > 0) {
    return {
      kind: 'error',
      text: 'Usage: /auto-rename takes no arguments. Use /rename <title> to set an explicit title.',
    }
  }

  const session = agent?.session
  if (session === undefined || session === null) {
    return { kind: 'error', text: 'No current session to rename.' }
  }

  const sessionTitle = ctx.get?.('sessionTitle')
  if (sessionTitle === undefined) {
    return {
      kind: 'error',
      text: 'This deployment has no session-title service; automatic renaming is unavailable here. Ask the model to recommend a name, then rename manually.',
    }
  }

  const date = sessionStartDateOf(session)
  const prompt = buildAutoRenamePrompt(date)

  if (agent?.followup === undefined) {
    // No agent inbox seam: degrade to a recommendation-only answer that the
    // model produces in its own next turn is not possible from the command
    // plane, so we print the naming guidance and stop.
    return {
      kind: 'success',
      text: [
        'Auto-rename is unavailable on this host (no agent prompt seam).',
        '',
        `Recommended prefix for this session: ${date}_语义名`,
        'Ask the model to recommend a semantic name, or use /rename <title>.',
      ].join('\n'),
    }
  }

  // Safety net: if the apply-time tool registration did not happen (tools
  // service was not ready yet), try once more from the handler. The durable
  // registration still lives in apply(); this only covers a startup race.
  await ensureRenameToolRegistered(ctx)

  try {
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: SELF_SOURCE_KIND },
    })
  } catch (error) {
    return {
      kind: 'error',
      text: `Auto-rename could not enqueue the naming turn: ${(error && error.message) || String(error)}`,
    }
  }

  return {
    kind: 'success',
    text: ctx.__dshAutoRenameTool
      ? '已让模型通读本会话并给出推荐名，随后会自动应用；请稍候查看模型的回复。'
      : '已让模型通读本会话并给出推荐名；此部署无自动改名工具，模型回复里会给出推荐名，请用 /rename 应用。',
  }
}

/**
 * Register the model-visible rename tool once for the plugin lifetime.
 * Idempotent per context. Failures are recorded on the context and logged,
 * never thrown, so the command itself still works with degraded output.
 *
 * @param {object} ctx - plugin context.
 * @returns {Promise<boolean>} whether the tool is registered and visible.
 */
async function ensureRenameToolRegistered(ctx) {
  if (ctx.__dshAutoRenameTool !== undefined) return ctx.__dshAutoRenameTool
  try {
    const tools = ctx.get?.('tools')
    if (tools === undefined || typeof tools.register !== 'function') {
      ctx.__dshAutoRenameTool = false
      ctx.logger?.warn?.('dsh-auto-rename: no tools service; rename tool not registered.')
      return false
    }
    const disposer = tools.register(createRenameTool(ctx))
    if (typeof disposer === 'function') ctx.__dshAutoRenameToolDisposer = disposer
    ctx.__dshAutoRenameTool = true
    ctx.logger?.info?.('dsh-auto-rename: rename_current_session tool registered.')
    return true
  } catch (error) {
    ctx.__dshAutoRenameTool = false
    ctx.logger?.warn?.(
      `dsh-auto-rename: rename tool registration failed: ${(error && error.message) || String(error)}`,
    )
    return false
  }
}

/**
 * Resolve the idle window from one row's config.
 *
 * Accepted shapes, highest precedence first: `idleMs` (milliseconds),
 * `idleMinutes` (minutes), then {@link DEFAULT_IDLE_MS}. A non-positive or
 * non-finite value falls back to the default instead of firing instantly.
 *
 * @param {object} [config] - the row config from `cordis.patch.yml`.
 * @returns {number} idle window in milliseconds.
 */
export function resolveIdleMs(config) {
  const explicitMs = typeof config?.idleMs === 'number' && Number.isFinite(config.idleMs) ? config.idleMs : undefined
  const explicitMinutes =
    typeof config?.idleMinutes === 'number' && Number.isFinite(config.idleMinutes) ? config.idleMinutes * 60_000 : undefined
  const requested = explicitMs ?? explicitMinutes ?? DEFAULT_IDLE_MS
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_IDLE_MS
  return Math.round(requested)
}

/**
 * Whether one durable session event is a message a human typed. The host
 * stamps `source.kind` on every `user/message`; `user` (and the approval
 * answer) are the human kinds, while a plugin-produced prompt carries its own
 * `plugin:<name>` kind and must never arm the idle timer.
 *
 * @param {{type?: string, data?: {source?: {kind?: string}}}} event - durable session event.
 * @returns {boolean}
 */
export function isHumanUserMessage(event) {
  if (event?.type !== 'user/message') return false
  const kind = event?.data?.source?.kind
  return typeof kind === 'string' && HUMAN_SOURCE_KINDS.includes(kind)
}

/**
 * Whether an agent still has work in flight, so the naming turn must wait.
 * Mirrors the host's own desktop active-task test: a running turn, or a
 * non-empty inbox for the next turn/step.
 *
 * @param {object} agent - live agent entry from `agents.list()`.
 * @returns {boolean}
 */
export function hasActiveWork(agent) {
  if (agent === undefined || agent === null) return false
  if (agent.status === 'running') return true
  const inbox = agent.inbox
  const queued = (list) => Array.isArray(list) && list.length > 0
  return queued(inbox?.nextTurn) || queued(inbox?.nextStep)
}

/**
 * Parent session id of a subagent (child) session, or undefined for a
 * top-level session. Child sessions are renamed by their child agent, so idle
 * auto mode leaves them alone.
 *
 * @param {object} session - live session object.
 * @returns {string|undefined}
 */
export function parentSessionIdOf(session) {
  const direct = session?.parentSessionId
  if (typeof direct === 'string' && direct.length > 0) return direct
  const nested = session?.info?.parentSessionId
  if (typeof nested === 'string' && nested.length > 0) return nested
  return undefined
}

/**
 * Build the idle auto-renamer: a host-plane observer of `session/event` that
 * arms one timer per session after a human-driven turn, and enqueues the
 * naming turn when that window elapses untouched.
 *
 * @param {object} ctx - plugin context (services resolved lazily).
 * @param {object} [config] - row config (`enabled`, `idleMs`, `idleMinutes`).
 * @returns {{enabled: boolean, idleMs: number, handleSessionEvent: Function, forget: Function, dispose: Function, pendingSessions: Function}}
 */
export function createIdleAutoRenamer(ctx, config = {}) {
  const enabled = config?.enabled !== false
  const idleMs = resolveIdleMs(config)
  // How often to re-test a still-busy session. Configurable so tests do not
  // have to wait the production interval.
  const busyRecheckMs =
    typeof config?.busyRecheckMs === 'number' && Number.isFinite(config.busyRecheckMs) && config.busyRecheckMs > 0
      ? Math.round(config.busyRecheckMs)
      : BUSY_RECHECK_MS

  /** @type {Map<object, {timer?: ReturnType<typeof setTimeout>, pendingUserTurn: boolean, awaitingRename: boolean, lastRenameAt?: number, lastTurnEndAt?: number}>} */
  const states = new Map()

  const stateOf = (session) => {
    let state = states.get(session)
    if (state === undefined) {
      state = { pendingUserTurn: false, awaitingRename: false }
      states.set(session, state)
    }
    return state
  }

  const clearTimer = (state) => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  const agentFor = (session) => {
    const agents = ctx.get?.('agents') ?? ctx.agents
    if (agents === undefined || agents === null || typeof agents.list !== 'function') return undefined
    let live
    try {
      live = agents.list()
    } catch {
      return undefined
    }
    if (!Array.isArray(live)) return undefined
    // The desktop host keys agents by their session id (`agent.id` doubles as
    // the session id, see dsh-desktop-host update-tasks), but the assistant
    // stream frames also expose `agent.session`. Accept either identity.
    for (const agent of live) {
      if (agent === session || agent?.session === session) return agent
      const liveSessionId = agent?.session?.id ?? agent?.id
      if (typeof liveSessionId === 'string' && liveSessionId === session?.id) return agent
    }
    return undefined
  }

  const fire = async (session, state) => {
    state.timer = undefined
    if (!enabled) return
    if (!state.pendingUserTurn) return
    if (parentSessionIdOf(session) !== undefined) return
    const agent = agentFor(session)
    if (agent === undefined) {
      state.pendingUserTurn = false
      return
    }
    if (hasActiveWork(agent)) {
      schedule(session, state, busyRecheckMs)
      return
    }
    if (ctx.get?.('sessionTitle') === undefined) {
      state.pendingUserTurn = false
      ctx.logger?.warn?.('dsh-auto-rename: no session-title service; idle auto-rename skipped.')
      return
    }
    state.pendingUserTurn = false
    state.awaitingRename = true
    try {
      await ensureRenameToolRegistered(ctx)
      enqueueNamingTurn(agent, sessionStartDateOf(session))
      state.lastRenameAt = Date.now()
      ctx.logger?.info?.(
        `dsh-auto-rename: idle for ${idleMs}ms, naming turn enqueued (session ${String(session?.id ?? '?')})`,
      )
    } catch (error) {
      state.awaitingRename = false
      ctx.logger?.warn?.(`dsh-auto-rename: idle naming turn failed: ${(error && error.message) || String(error)}`)
    }
  }

  const schedule = (session, state, delay) => {
    clearTimer(state)
    state.timer = setTimeout(() => {
      void fire(session, state)
    }, delay)
    // A pending timer must never keep the host process alive on its own.
    if (typeof state.timer?.unref === 'function') state.timer.unref()
  }

  /** Feed one durable session event through the idle state machine. */
  const handleSessionEvent = (session, event) => {
    if (!enabled || session === undefined || session === null || event === undefined || event === null) return
    // Subagent sessions are renamed by their own agent; never even arm for them.
    if (parentSessionIdOf(session) !== undefined) return
    const type = event.type

    if (type === 'user/message') {
      if (!isHumanUserMessage(event)) return
      const state = stateOf(session)
      // A human message outranks any naming turn still queued; the window
      // restarts from the turn this message starts.
      state.awaitingRename = false
      state.pendingUserTurn = true
      clearTimer(state)
      return
    }

    if (type === 'turn/start') {
      clearTimer(stateOf(session))
      return
    }

    if (type === 'turn/end') {
      const state = stateOf(session)
      clearTimer(state)
      state.lastTurnEndAt = typeof event.time === 'number' ? event.time : Date.now()
      if (state.awaitingRename) {
        // This turn IS the naming turn: never re-arm on our own output.
        state.awaitingRename = false
        state.pendingUserTurn = false
        return
      }
      if (!state.pendingUserTurn) return
      const kind = event?.data?.reason?.kind
      if (kind === 'blocked') return
      schedule(session, state, idleMs)
      return
    }
  }

  /** Drop one session's timer and state (session disposed / archived). */
  const forget = (session) => {
    const state = states.get(session)
    if (state !== undefined) clearTimer(state)
    states.delete(session)
  }

  /** Clear every armed timer (plugin dispose / row reload). */
  const dispose = () => {
    for (const state of states.values()) clearTimer(state)
    states.clear()
  }

  /** Sessions with a window armed right now (diagnostics). */
  const pendingSessions = () => {
    const pending = []
    for (const [session, state] of states) {
      if (state.timer !== undefined) pending.push(session)
    }
    return pending
  }

  return { enabled, idleMs, handleSessionEvent, forget, dispose, pendingSessions }
}

/**
 * Cordis apply: register `/auto-rename`, the model-visible rename tool and the
 * idle auto-renamer once the commands/sessions/tools services are ready, and
 * unregister everything on dispose.
 *
 * The tool MUST be registered at plugin load time — not lazily inside the
 * command handler. The model turn that `/auto-rename` wakes assembles its
 * toolset when the agent request starts; a tool registered only after the
 * handler ran would never be visible to that turn. Registering here on the
 * plugin context (global scope) is the same seam the anysearch plugin uses
 * for its model-visible tools.
 */
export function apply(ctx, config = {}) {
  ctx.effect(function* () {
    const tools = ctx.tools ?? ctx.get?.('tools')
    if (tools === undefined || typeof tools.register !== 'function') {
      ctx.__dshAutoRenameTool = false
      ctx.logger?.warn?.('dsh-auto-rename: no tools service; rename tool not registered.')
      return
    }
    try {
      yield tools.register(createRenameTool(ctx))
      ctx.__dshAutoRenameTool = true
      ctx.logger?.info?.('dsh-auto-rename: rename_current_session tool registered.')
    } catch (error) {
      ctx.__dshAutoRenameTool = false
      ctx.logger?.warn?.(
        `dsh-auto-rename: rename tool registration failed: ${(error && error.message) || String(error)}`,
      )
    }
  }, 'dsh-auto-rename: rename tool registration')

  ctx.inject(['commands'], (cmdCtx) => {
    const commands = cmdCtx.commands
    cmdCtx.effect(function* () {
      yield commands.register({
        name: 'auto-rename',
        description: 'Read the whole session, recommend a dated title, and rename the session automatically',
        handler: async (invocation) => autoRenameCurrentSession(ctx, invocation),
      })
    }, 'dsh-auto-rename: /auto-rename command')
  })

  // Idle auto mode: rename a session on its own once a human-driven turn has
  // been quiet for the configured window. Registers listeners on the plugin
  // context so a row reload tears them down with the plugin.
  ctx.effect(() => {
    const renamer = createIdleAutoRenamer(ctx, config)
    const offEvent = ctx.on('session/event', (session, event) => renamer.handleSessionEvent(session, event))
    const offDisposed = ctx.on('session/disposed', (session) => renamer.forget(session))
    ctx.logger?.info?.(
      renamer.enabled
        ? `dsh-auto-rename: idle auto-rename armed (idleMs=${renamer.idleMs})`
        : 'dsh-auto-rename: idle auto-rename disabled by config.',
    )
    return () => {
      offEvent?.()
      offDisposed?.()
      renamer.dispose()
    }
  }, 'dsh-auto-rename: idle auto-rename')
}
