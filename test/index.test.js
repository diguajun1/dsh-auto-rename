import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  name,
  inject,
  apply,
  sessionStartDateOf,
  stripDatePrefix,
  withDatePrefix,
  buildAutoRenamePrompt,
  createRenameTool,
} from '../lib/index.js'

function localDateString(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

test('plugin identity matches the mount contract', () => {
  assert.equal(name, 'dsh-auto-rename')
  assert.ok(inject.includes('commands'))
  assert.ok(inject.includes('sessions'))
})

test('withDatePrefix prefixes a bare semantic title', () => {
  assert.equal(withDatePrefix('2026-08-08', '会议纪要整理'), '2026-08-08_会议纪要整理')
})

test('withDatePrefix is idempotent when the title already carries the prefix', () => {
  assert.equal(withDatePrefix('2026-08-08', '2026-08-08_会议纪要整理'), '2026-08-08_会议纪要整理')
})

test('withDatePrefix replaces a wrong leading date instead of double prefixing', () => {
  assert.equal(withDatePrefix('2026-08-08', '2025-01-01_旧日期'), '2026-08-08_旧日期')
})

test('withDatePrefix tolerates separator noise after the date', () => {
  assert.equal(stripDatePrefix('2026-08-08：语义'), '语义')
  assert.equal(withDatePrefix('2026-08-08', '2026-08-08 - 语义'), '2026-08-08_语义')
})

test('sessionStartDateOf reads the first event time in local date form', () => {
  const sample = new Date(2026, 0, 15, 12, 0, 0)
  const session = {
    snapshotEvents: () => [{ type: 'user/message', time: sample.getTime(), seq: 1 }],
  }
  assert.equal(sessionStartDateOf(session), localDateString(sample))
})

test('sessionStartDateOf falls back to today when the log has no timestamp', () => {
  const session = { snapshotEvents: () => [{ type: 'user/message', seq: 1 }] }
  assert.equal(sessionStartDateOf(session), localDateString(new Date()))
})

test('sessionStartDateOf never throws on broken sessions', () => {
  assert.equal(typeof sessionStartDateOf(undefined), 'string')
  assert.equal(typeof sessionStartDateOf({}), 'string')
  assert.equal(typeof sessionStartDateOf({ snapshotEvents: () => 'nope' }), 'string')
})

test('buildAutoRenamePrompt embeds the date and the tool name', () => {
  const prompt = buildAutoRenamePrompt('2026-08-08')
  assert.ok(prompt.includes('2026-08-08'))
  assert.ok(prompt.includes('rename_current_session'))
  assert.ok(prompt.includes('推荐：'))
  assert.ok(prompt.includes('推荐原因：'))
  assert.ok(prompt.includes('其他备选：'))
})

test('rename tool rejects an execution without a session', async () => {
  const tool = createRenameTool({ get: () => undefined, sessions: {} })
  await assert.rejects(() => tool.execute({ title: '2026-08-08_abc' }, { agent: undefined }), /no current session/)
})

test('rename tool rejects an empty title', async () => {
  const session = { snapshotEvents: () => [] }
  const tool = createRenameTool({ get: () => ({}), sessions: {} })
  await assert.rejects(
    () => tool.execute({ title: '   ' }, { agent: { session } }),
    /title is required/,
  )
})

test('rename tool renames through the official chain and returns the accepted title', async () => {
  const accepted = { title: '2026-08-08_测试会话' }
  const flushed = []
  let renamedWith = null
  const sessionTitle = {
    rename: (session, title) => {
      renamedWith = title
      return accepted
    },
  }
  const session = {
    snapshotEvents: () => [{ type: 'session/end-seed', time: new Date(2026, 7, 8, 9, 0, 0).getTime() }],
  }
  const tool = createRenameTool({
    get: () => sessionTitle,
    sessions: {
      flush: async (s) => {
        flushed.push(s)
      },
    },
  })
  const result = await tool.execute({ title: '测试会话' }, { agent: { session } })
  assert.equal(renamedWith, '2026-08-08_测试会话')
  assert.equal(flushed.length, 1)
  assert.equal(result.acceptedTitle, '2026-08-08_测试会话')
})

test('rename tool reports a missing session-title service clearly', async () => {
  const session = { snapshotEvents: () => [] }
  const tool = createRenameTool({ get: () => undefined, sessions: {} })
  await assert.rejects(
    () => tool.execute({ title: 'x' }, { agent: { session } }),
    /no session-title service/,
  )
})

function makeFakeCmdCtx(record) {
  const commands = {
    register: (definition) => {
      record.definition = definition
      return () => {}
    },
  }
  return {
    commands,
    effect: (gen) => {
      const it = gen()
      let step = it.next()
      while (!step.done) step = it.next(step.value)
      return step.value
    },
  }
}

function makeFakeAppCtx() {
  const record = { definition: undefined, followups: [] }
  const ctx = {
    __dshAutoRenameTool: undefined,
    inject: (names, callback) => callback(makeFakeCmdCtx(record)),
    get: (key) => (key === 'sessionTitle' ? { rename: () => ({ title: 'x' }) } : undefined),
    sessions: {},
  }
  return { ctx, record }
}

test('apply registers the /auto-rename command through the commands surface', () => {
  const { ctx, record } = makeFakeAppCtx()
  apply(ctx)
  assert.ok(record.definition)
  assert.equal(record.definition.name, 'auto-rename')
  assert.equal(typeof record.definition.handler, 'function')
})

test('command handler with a session but no tools seam degrades to a success text', async () => {
  const { ctx, record } = makeFakeAppCtx()
  apply(ctx)
  const session = {
    snapshotEvents: () => [
      { type: 'session/end-seed', time: new Date(2026, 0, 15, 12, 0, 0).getTime() },
    ],
  }
  const agent = { session }
  const invocation = { agent, rawInput: '', signal: new AbortController().signal }
  const result = await record.definition.handler(invocation)
  assert.equal(result.kind, 'success')
  assert.ok(result.text.length > 0)
})

test('command handler rejects non-empty rawInput like /rename-style usage', async () => {
  const { ctx, record } = makeFakeAppCtx()
  apply(ctx)
  const agent = { session: { snapshotEvents: () => [] } }
  const result = await record.definition.handler({ agent, rawInput: 'something' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Usage: \/auto-rename/)
})
