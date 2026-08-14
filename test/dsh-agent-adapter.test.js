import assert from 'node:assert/strict'
import test from 'node:test'

import { DshAgentAdapter, sessionIdForDingTalkKey } from '../index.js'

function fakeHarness(options = {}) {
  const listeners = new Map()
  const live = new Map()
  const calls = { create: 0, resume: 0, mount: [], dispose: 0, cancel: 0 }
  const ctx = {
    on(name, callback) {
      const bucket = listeners.get(name) ?? []
      bucket.push(callback)
      listeners.set(name, bucket)
      return () => listeners.set(name, bucket.filter((candidate) => candidate !== callback))
    },
    emit(name, ...args) {
      for (const callback of listeners.get(name) ?? []) callback(...args)
    },
    async waterfall(name, request, fallback) {
      const callbacks = listeners.get(name) ?? []
      let index = 0
      const next = () => index < callbacks.length ? callbacks[index++](request, next) : fallback()
      return next()
    },
    get(name) {
      if (name !== 'sessionPersistence' || options.persisted === undefined) return undefined
      return { async list() { return [{ id: options.persisted }] } }
    },
    agentPresets: {
      async mount(_agentCtx, preset) { calls.mount.push(preset) },
    },
    agents: {
      get(id) { return live.get(id) },
      withInitiator(_agent, operation) { return operation() },
      async create(input) { calls.create += 1; return makeHandle(input.sessionId, input.setup) },
      async resume(input) { calls.resume += 1; return makeHandle(input.resumeSessionId, input.setup) },
    },
  }

  function makeHandle(id, setup) {
    const session = { id, header: { id } }
    let idle = Promise.resolve()
    const agent = {
      id,
      session,
      followup(message) {
        const deferred = Promise.withResolvers()
        idle = deferred.promise
        queueMicrotask(async () => {
          try {
            ctx.emit('agent/inbox/claimed', { agent, message, turn: 1 })
            await options.beforeAnswer?.({ ctx, agent, message })
            ctx.emit('session/event', session, {
              type: 'assistant/message',
              data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'committed answer' }] } },
            })
            ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } })
            deferred.resolve()
          } catch (error) {
            deferred.reject(error)
          }
        })
      },
      whenIdle() { return idle },
      cancel() { calls.cancel += 1 },
    }
    return Promise.resolve(setup?.({})).then(() => {
      live.set(id, agent)
      return {
        agent,
        async dispose() { calls.dispose += 1; live.delete(id) },
      }
    })
  }
  return { ctx, calls, live }
}

function inbound() {
  return { conversationId: 'conversation-1', senderId: 'staff-1' }
}

test('derives a stable non-secret storage-safe session id', () => {
  const first = sessionIdForDingTalkKey('direct:c-1:sender:u-1')
  const second = sessionIdForDingTalkKey('direct:c-1:sender:u-1')
  assert.equal(first, second)
  assert.match(first, /^dingtalk-[a-f0-9]{64}$/)
  assert.equal(first.includes('c-1'), false)
  assert.notEqual(first, sessionIdForDingTalkKey('direct:c-1:sender:u-2'))
})

test('creates one preset-mounted agent, returns committed text, and reuses it', async () => {
  const harness = fakeHarness()
  const adapter = new DshAgentAdapter(harness.ctx, { preset: 'standard' })
  const first = await adapter.runTurn({ sessionKey: 'direct:c-1:sender:u-1', text: 'hello', inbound: inbound() })
  const second = await adapter.runTurn({ sessionKey: 'direct:c-1:sender:u-1', text: 'again', inbound: inbound() })
  assert.deepEqual(first, { text: 'committed answer' })
  assert.deepEqual(second, { text: 'committed answer' })
  assert.equal(harness.calls.create, 1)
  assert.equal(harness.calls.resume, 0)
  assert.deepEqual(harness.calls.mount, ['standard'])
  assert.equal(adapter.cancel('direct:c-1:sender:u-1'), true)
  assert.equal(harness.calls.cancel, 1)
  await adapter.dispose()
  assert.equal(harness.calls.dispose, 1)
})

test('resumes an exact persisted deterministic session instead of replacing it', async () => {
  const key = 'group:c-2:sender:u-8'
  const harness = fakeHarness({ persisted: sessionIdForDingTalkKey(key) })
  const adapter = new DshAgentAdapter(harness.ctx)
  await adapter.runTurn({ sessionKey: key, text: 'continue', inbound: inbound() })
  assert.equal(harness.calls.create, 0)
  assert.equal(harness.calls.resume, 1)
  await adapter.dispose()
})

test('binds a one-time approval to the active DingTalk actor', async () => {
  let approval
  let adapter
  const harness = fakeHarness({
    async beforeAnswer({ ctx, agent }) {
      const outcome = await ctx.waterfall(
        'approval/request',
        { agent, toolName: 'bash', reason: 'run a command' },
        () => Promise.resolve('unavailable'),
      )
      assert.equal(outcome, 'allowed-once')
    },
  })
  adapter = new DshAgentAdapter(harness.ctx, {
    async sendApproval(_message, value) { approval = value },
  })
  const running = adapter.runTurn({ sessionKey: 'direct:c-1:sender:u-1', text: 'do it', inbound: inbound() })
  while (!approval) await new Promise((resolve) => setImmediate(resolve))
  assert.throws(
    () => adapter.resolveApproval({ token: approval.token, conversationId: 'conversation-1', senderId: 'attacker', decision: 'approve' }),
    /actor mismatch/,
  )
  await assert.rejects(running)
  await adapter.dispose()
})

test('accepts the correctly bound actor once and settles the harness approval', async () => {
  let approval
  const harness = fakeHarness({
    async beforeAnswer({ ctx, agent }) {
      assert.equal(await ctx.waterfall(
        'approval/request',
        { agent, toolName: 'write_file' },
        () => Promise.resolve('unavailable'),
      ), 'allowed-once')
    },
  })
  const adapter = new DshAgentAdapter(harness.ctx, { async sendApproval(_message, value) { approval = value } })
  const running = adapter.runTurn({ sessionKey: 'direct:c-1:sender:u-1', text: 'write', inbound: inbound() })
  while (!approval) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(adapter.resolveApproval({
    token: approval.token,
    conversationId: 'conversation-1',
    senderId: 'staff-1',
    decision: 'approve',
  }), { text: 'Approved once.' })
  assert.deepEqual(await running, { text: 'committed answer' })
  assert.throws(() => adapter.resolveApproval({
    token: approval.token,
    conversationId: 'conversation-1',
    senderId: 'staff-1',
    decision: 'approve',
  }), /absent|consumed/)
  await adapter.dispose()
})
