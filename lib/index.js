// dsh-auto-rename — slash command `/auto-rename` for the DSH web input box.
//
// What it does: typing `/auto-rename` asks the model (in one ordinary agent
// turn) to read the full current session, recommend a dated title in the
// `YYYY-MM-DD_语义名` shape, and then apply it automatically through the same
// official chain as the sidebar rename (`sessionTitle.rename` ->
// `sessions.flush`). The date prefix is computed host-side from the session
// log (no shell, no file stat), so it is identical across macOS / Linux /
// Windows and does not depend on the model guessing the session start date.
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
// Design constraints (kept intentionally identical to dsh-rename):
//   - No import of any `@deepseek-ai` internal package.
//   - No peerDependencies; only stable public surfaces (`commands`,
//     `sessionTitle`, `sessions`) plus the documented agent tool seam.
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
 * `sessionTitle` is resolved lazily (`ctx.get`) inside the tool so a
 * deployment without it degrades to a clear error instead of failing startup.
 */
export const inject = ['commands', 'sessions', 'tools']

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
    // A user message reaching the agent seam MUST carry a stable `id`, a
    // `role`, and a producer-owned `source`: the host records it verbatim in
    // `agent/inbox/spliced` and later in `user/message`, and the released
    // Session validator refuses the event when any of them is missing, which
    // makes the whole session unopenable. Official producers use
    // createUserMessage(); this plugin stays import-free, so it supplies all
    // three members itself.
    //
    // Session format v4 retired the V3 `{ kind: 'plugin', plugin: <name> }`
    // wrapper: a plugin is identified by its own `plugin:<name>` kind. That is
    // exactly the kind the v3->v4 migrator derives for rows earlier versions
    // wrote, so both generations read back under one shape.
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin:dsh-auto-rename' },
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
 * Cordis apply: register `/auto-rename` and the model-visible rename tool once
 * the commands/sessions/tools services are ready, and unregister both on
 * dispose.
 *
 * The tool MUST be registered at plugin load time — not lazily inside the
 * command handler. The model turn that `/auto-rename` wakes assembles its
 * toolset when the agent request starts; a tool registered only after the
 * handler ran would never be visible to that turn. Registering here on the
 * plugin context (global scope) is the same seam the anysearch plugin uses
 * for its model-visible tools.
 */
export function apply(ctx) {
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
}
