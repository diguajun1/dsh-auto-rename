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

/** Cordis plugin name (loader diagnostics). */
export const name = 'dsh-auto-rename'

/**
 * Services the row waits for before starting. `commands` is the official
 * human slash-command registry; `sessions` is injected so
 * `ctx.sessions.flush` is legal to call. `sessionTitle` and `tools` are
 * resolved lazily (`ctx.get`) so deployments without them degrade cleanly
 * instead of failing startup.
 */
export const inject = ['commands', 'sessions']

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

  // Register the model-visible tool lazily (idempotent per ctx). If the tools
  // seam is absent in an older host, the turn still runs and the model simply
  // outputs the recommendation without applying it.
  const tools = ctx.get?.('tools')
  let toolRegistered = false
  if (tools !== undefined && typeof tools.register === 'function' && !ctx.__dshAutoRenameTool) {
    try {
      tools.register(createRenameTool(ctx))
      ctx.__dshAutoRenameTool = true
      toolRegistered = true
    } catch {
      toolRegistered = false
    }
  } else if (ctx.__dshAutoRenameTool) {
    toolRegistered = true
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

  try {
    agent.followup({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-auto-rename' },
    })
  } catch (error) {
    return {
      kind: 'error',
      text: `Auto-rename could not enqueue the naming turn: ${(error && error.message) || String(error)}`,
    }
  }

  return {
    kind: 'success',
    text: toolRegistered
      ? '已让模型通读本会话并给出推荐名，随后会自动应用；请稍候查看模型的回复。'
      : '已让模型通读本会话并给出推荐名；此部署无自动改名工具，模型回复里会给出推荐名，请用 /rename 应用。',
  }
}

/**
 * Cordis apply: register `/auto-rename` once the command service is ready and
 * unregister it on dispose.
 */
export function apply(ctx) {
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
