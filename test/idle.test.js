// Unit tests for the pure helpers and the idle auto-renamer state machine.
// Run with `node --test test/` (Node >= 22.19). No DSH host required: every
// service the plugin touches is faked at the seam.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SELF_SOURCE_KIND,
  createIdleAutoRenamer,
  hasActiveWork,
  isHumanUserMessage,
  parentSessionIdOf,
  resolveIdleMs,
  stripDatePrefix,
  withDatePrefix,
} from '../lib/index.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createHarness({ idleMs = 25, enabled = true, agents = [], titleService = { rename: () => ({}) }, busyRecheckMs = 25 } = {}) {
  const log = []
  const ctx = {
    logger: { info: (line) => log.push(line), warn: (line) => log.push(line) },
    services: {
      sessionTitle: titleService,
      agents: { list: () => agents },
      tools: { register: () => () => {} },
    },
    get(name) {
      return this.services[name]
    },
  }
  const renamer = createIdleAutoRenamer(ctx, { enabled, idleMs, busyRecheckMs })
  return { ctx, log, renamer }
}

function createSession(id = 'session-1') {
  return { id, snapshotEvents: () => [{ time: new Date(2026, 0, 2, 10, 0, 0).getTime() }] }
}

function createAgent(session, overrides = {}) {
  const followups = []
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) {
      followups.push(message)
    },
    ...overrides,
  }
  return { agent, followups }
}

const humanMessage = () => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } })
const pluginMessage = () => ({ type: 'user/message', data: { source: { kind: SELF_SOURCE_KIND }, content: [{ type: 'text', text: 'naming' }] } })
const turnStart = () => ({ type: 'turn/start', data: {} })
const turnEnd = (kind = 'completed') => ({ type: 'turn/end', data: { reason: { kind } }, time: Date.now() })

test('resolveIdleMs defaults to five minutes and honours idleMs / idleMinutes', () => {
  assert.equal(resolveIdleMs(undefined), 300_000)
  assert.equal(resolveIdleMs({}), 300_000)
  assert.equal(resolveIdleMs({ idleMinutes: 2 }), 120_000)
  assert.equal(resolveIdleMs({ idleMs: 45_000, idleMinutes: 9 }), 45_000)
  assert.equal(resolveIdleMs({ idleMs: -1 }), 300_000)
  assert.equal(resolveIdleMs({ idleMs: Number.NaN }), 300_000)
})

test('isHumanUserMessage only accepts human source kinds', () => {
  assert.equal(isHumanUserMessage(humanMessage()), true)
  assert.equal(isHumanUserMessage({ type: 'user/message', data: { source: { kind: 'user-approval' } } }), true)
  assert.equal(isHumanUserMessage(pluginMessage()), false)
  assert.equal(isHumanUserMessage({ type: 'user/message', data: { source: { kind: 'agent-message' } } }), false)
  assert.equal(isHumanUserMessage({ type: 'turn/end', data: { source: { kind: 'user' } } }), false)
  assert.equal(isHumanUserMessage(undefined), false)
})

test('hasActiveWork mirrors the host active-task test', () => {
  assert.equal(hasActiveWork({ status: 'idle', inbox: { nextTurn: [], nextStep: [] } }), false)
  assert.equal(hasActiveWork({ status: 'running', inbox: { nextTurn: [], nextStep: [] } }), true)
  assert.equal(hasActiveWork({ status: 'idle', inbox: { nextTurn: [{}], nextStep: [] } }), true)
  assert.equal(hasActiveWork({ status: 'idle', inbox: { nextTurn: [], nextStep: [{}] } }), true)
  assert.equal(hasActiveWork(undefined), false)
})

test('parentSessionIdOf ignores top-level sessions', () => {
  assert.equal(parentSessionIdOf({ id: 'a' }), undefined)
  assert.equal(parentSessionIdOf({ id: 'a', parentSessionId: 'p' }), 'p')
  assert.equal(parentSessionIdOf({ id: 'a', info: { parentSessionId: 'p' } }), 'p')
})

test('date prefix helpers never double-prefix', () => {
  assert.equal(stripDatePrefix('2026-01-02_实现插件'), '实现插件')
  assert.equal(stripDatePrefix('实现插件'), '实现插件')
  assert.equal(withDatePrefix('2026-01-02', '实现插件'), '2026-01-02_实现插件')
  assert.equal(withDatePrefix('2026-01-02', '2026-05-06_实现插件'), '2026-01-02_实现插件')
})

test('a turn end without a human message never arms; blocked turns are skipped', async () => {
  const session = createSession()
  const { agent, followups } = createAgent(session)
  const { renamer } = createHarness({ agents: [agent] })

  renamer.handleSessionEvent(session, turnEnd('completed'))
  await delay(60)
  assert.equal(followups.length, 0, 'a turn end without a human message must not arm')

  renamer.handleSessionEvent(session, humanMessage())
  renamer.handleSessionEvent(session, turnStart())
  renamer.handleSessionEvent(session, turnEnd('blocked'))
  await delay(60)
  assert.equal(followups.length, 0, 'blocked turns wait for the approval answer')
})

test('a plugin-produced prompt never arms the timer', async () => {
  const session = createSession()
  const { agent, followups } = createAgent(session)
  const { renamer } = createHarness({ agents: [agent] })

  renamer.handleSessionEvent(session, pluginMessage())
  renamer.handleSessionEvent(session, turnEnd())
  await delay(60)
  assert.equal(followups.length, 0)
})

test('human turn + idle window enqueues exactly one naming turn', async () => {
  const session = createSession()
  const { agent, followups } = createAgent(session)
  const { renamer } = createHarness({ agents: [agent], idleMs: 25 })

  renamer.handleSessionEvent(session, humanMessage())
  renamer.handleSessionEvent(session, turnStart())
  renamer.handleSessionEvent(session, turnEnd())
  await delay(80)

  assert.equal(followups.length, 1)
  const message = followups[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, SELF_SOURCE_KIND)
  assert.match(message.content[0].text, /rename_current_session/)
  assert.match(message.content[0].text, /2026-01-02/)
})

test('the naming turn itself does not re-arm the timer (no rename loop)', async () => {
  const session = createSession()
  const { agent, followups } = createAgent(session)
  const { renamer } = createHarness({ agents: [agent], idleMs: 25 })

  renamer.handleSessionEvent(session, humanMessage())
  renamer.handleSessionEvent(session, turnEnd())
  await delay(80)
  assert.equal(followups.length, 1)

  // The naming turn the plugin injected starts and ends; that must not arm.
  renamer.handleSessionEvent(session, pluginMessage())
  renamer.handleSessionEvent(session, turnStart())
  renamer.handleSessionEvent(session, turnEnd())
  await delay(80)
  assert.equal(followups.length, 1, 'plugin output must not trigger a second rename')
})

test('a new human message restarts the window instead of renaming twice', async () => {
  const session = createSession()
  const { agent, followups } = createAgent(session)
  const { renamer } = createHarness({ agents: [agent], idleMs: 40 })

  renamer.handleSessionEvent(session, humanMessage())
  renamer.handleSessionEvent(session, turnEnd())
  await delay(60)
  assert.equal(followups.length, 1)

  renamer.handleSessionEvent(session, humanMessage())
  renamer.handleSessionEvent(session, turnStart())
  renamer.handleSessionEvent(session, turnEnd())
  await delay(90)
  assert.equal(followups.length, 2)
})

test('a busy agent defers the naming turn until it is idle', async () => {
  const session = createSession()
  const { agent, followups } = createAgent(session, { status: 'running' })
  const { renamer } = createHarness({ agents: [agent], idleMs: 25 })

  renamer.handleSessionEvent(session, humanMessage())
  renamer.handleSessionEvent(session, turnEnd())
  await delay(80)
  assert.equal(followups.length, 0, 'must not inject while the turn is still running')

  agent.status = 'idle'
  agent.inbox = { nextTurn: [], nextStep: [] }
  // The re-check interval is configurable (25ms in this harness); production
  // uses 15s.
  await delay(90)
  assert.equal(followups.length, 1)
})

test('child sessions are never auto-renamed', async () => {
  const session = createSession('child')
  session.parentSessionId = 'parent'
  const { agent, followups } = createAgent(session)
  const { renamer } = createHarness({ agents: [agent], idleMs: 25 })

  renamer.handleSessionEvent(session, humanMessage())
  renamer.handleSessionEvent(session, turnEnd())
  await delay(80)
  assert.equal(followups.length, 0)
})

test('session disposal clears the armed timer', async () => {
  const session = createSession()
  const { agent, followups } = createAgent(session)
  const { renamer } = createHarness({ agents: [agent], idleMs: 40 })

  renamer.handleSessionEvent(session, humanMessage())
  renamer.handleSessionEvent(session, turnEnd())
  renamer.forget(session)
  await delay(80)
  assert.equal(followups.length, 0)
  assert.equal(renamer.pendingSessions().length, 0)
})

test('disabled config keeps the command plane silent', async () => {
  const session = createSession()
  const { agent, followups } = createAgent(session)
  const { renamer } = createHarness({ agents: [agent], idleMs: 20, enabled: false })

  renamer.handleSessionEvent(session, humanMessage())
  renamer.handleSessionEvent(session, turnEnd())
  await delay(60)
  assert.equal(followups.length, 0)
  assert.equal(renamer.enabled, false)
})
