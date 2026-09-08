# dsh-auto-rename

[中文说明](README.md)

A slash command `/auto-rename` for the DSH web input box: have the model read the whole current session, recommend a dated semantic title, and rename the session automatically.

Type in the DSH web input box:

```text
/auto-rename
```

The model reads the full session in one ordinary agent turn (no duplicate full-context resend, no extra standalone model call), then outputs a structured recommendation:

```text
推荐 (Recommended):

2026-08-08_会议纪要整理

推荐原因 (Why):

This session is about organizing meeting minutes

改名方式 (Applied):

Already applied automatically via rename_current_session.

其他备选 (Alternatives):

- 2026-08-08_会议纪要
- 会议纪要整理
```

The session title becomes `2026-08-08_会议纪要整理` through the same official chain as a manual sidebar rename (`sessionTitle.rename` + `sessions.flush`), so it survives refresh and resume. The `YYYY-MM-DD` prefix is the session start date, computed host-side from the session log — identical on macOS / Linux / Windows, never guessed by the model.

## Why "command + model turn" instead of renaming directly in the command

DSH slash commands run in the UI command plane, host-side, without the model. If the command itself tried to "read the whole session and pick a name", it would have to send the entire conversation as one extra standalone model request — duplicating the full input and wasting tokens.

Instead, the command just triggers the work: it enqueues one user-role message and wakes the agent driver (the same mechanism the official `/goal` command uses to feed the agent). The model already has the full session in its own context, so reading it costs nothing extra; it then calls the model-visible tool `rename_current_session` registered by this plugin, and the tool persists the title through the official chain. Token cost is equivalent to simply asking the model to name the session — no duplicated full-context send.

## Install

Prerequisites are the same as [dsh-rename](https://github.com/sci-zyf/dsh-rename):

- dsh CLI installed globally: `npm install -g @deepseek-ai/dsh`
- Node.js ≥ 22.19 (see the `engines` field in `package.json`)
- A `web` profile exists: `dsh profile list` should include `web`

Install from the GitHub repo:

```bash
dsh plugin --profile web add https://github.com/sci-zyf/dsh-auto-rename
```

Restart DSH after installing (or it takes effect automatically when the profile has `patchReload: live`). Uninstall:

```bash
dsh plugin --profile web remove dsh-auto-rename
```

## Usage

Type in the DSH web input box:

```text
/auto-rename
```

The command takes no arguments; use `/rename <title>` when you want to set an explicit title. Once the model turn finishes, the title is applied. If the deployment lacks the model-visible tool seam, the plugin degrades to a clear recommendation plus `/rename` guidance instead of failing silently.

## Host adaptation and platforms

- Targets the DSH 0.1.2-rc line (web profile).
- Pure command-plane plugin plus one model-visible tool: no direct imports of any `@deepseek-ai` internal package, no peerDependencies. It relies on the public surfaces `commands`, `sessionTitle`, `sessions`, the agent message seam (`agent.followup`) and the tool registry (`tools`); host upgrades are verified by actually running, not by version pinning.
- Pure JavaScript, no shell, no filesystem dependence; the date prefix is computed in-process, so behavior is identical on macOS / Linux / Windows.
- Distributed through the GitHub repo; not published to npm.

## Implementation

- `lib/index.js`: a cordis plugin that registers `/auto-rename` once `commands` is ready.
- The command handler computes the session start date `YYYY-MM-DD` host-side, builds the naming instruction, and wakes the main model turn via `agent.followup`.
- In that turn the model calls `rename_current_session`, which applies the title through `sessionTitle.rename(session, title)` and persists it with `sessions.flush(session)` — the same apply chain as dsh-rename.
- Registration follows the `@deepseek-ai/dsh-commands` / `@deepseek-ai/dsh-tools` contracts; the tool is registered lazily on first command execution, and the plugin degrades when the host lacks the tool service.

## Tests

```bash
npm test
```

Covers date-prefix computation, title normalization, the naming-instruction text, the official rename chain, and the degradation paths.
