# dsh-auto-rename

Automatic session naming for DSH Web: the AI reads the whole session and renames it to `YYYY-MM-DD_semantic-name`.

Two triggers:

| Mode | Trigger | Notes |
| --- | --- | --- |
| Manual | type `/auto-rename` in the input box | renames immediately |
| Idle auto (new in 0.2.0) | 5 minutes with no human activity after a turn | injects the same naming turn automatically |

The window is configurable: `idleMs` (default `300000` = 5 minutes) and `enabled` (default `true`).

## Why

Sidebar titles are truncated first messages, so long multi-day sessions are indistinguishable. The plugin splits the work:

- the **date prefix** is computed host-side from the session's first event timestamp (local time zone) — the model never guesses it;
- the rename uses the official chain `sessionTitle.rename()` → `sessions.flush()`, identical to the sidebar rename, so it survives reloads;
- no `@deepseek-ai` internal imports, no peer dependencies, pure JS with zero native deps (macOS / Linux / Windows).

## How it works

1. **Command plane** (host-side, no model message): `ctx.inject(['commands'])` registers `/auto-rename`.
2. **Model plane**: `ctx.tools.register()` exposes a `rename_current_session` tool. The handler enqueues one ordinary user message through `agent.followup()` (the same seam the official `/goal` uses), so the model reads the full session in its own context and calls the tool.
3. **Idle auto**: a host-plane `session/event` listener arms one timer per session, but only for messages a human typed (`user/message` with `source.kind === 'user'`). Later human messages, the next `turn/start`, and session disposal clear it. When the timer survives the whole window, the plugin enqueues the exact same naming turn as `/auto-rename`.

Two state flags keep it from looping: `awaitingRename` swallows the `turn/end` of the naming turn itself, and `pendingUserTurn` is set only by human messages, so a conversation is renamed at most once.

Additional guards: a busy agent (`status === 'running'` or pending inbox work) defers the turn and re-checks in 15s; `turn/end` with `reason.kind === 'blocked'` (waiting for approval) never arms; child sessions (`parentSessionId`) are skipped; timers are `unref()`ed.

## Config

```yaml
- insert:
    - id: dsh-auto-rename
      name: dsh-auto-rename
      inject: [commands]
      config:
        enabled: true
        idleMs: 300000   # or idleMinutes: 5
```

## Install

```bash
dsh plugin --profile web add https://github.com/sci-zyf/dsh-auto-rename
```

Restart DSH afterwards (or let a `patchReload: live` profile pick it up).

## Development

```bash
npm test   # node --test test/
```

## License

MIT
