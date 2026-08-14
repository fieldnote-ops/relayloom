import assert from 'node:assert/strict'
import test from 'node:test'
import { DingTalkStreamCore, normalizeInbound } from '../index.js'

function payload(overrides = {}) {
  return {
    msgId: 'm-1',
    conversationId: 'c-1',
    senderStaffId: 'u-1',
    conversationType: '1',
    text: { content: '  ship the patch  ' },
    ...overrides,
  }
}

test('normalizes one direct message into a sender-isolated session', () => {
  assert.deepEqual(normalizeInbound(payload()), {
    msgId: 'm-1', conversationId: 'c-1', senderId: 'u-1', kind: 'direct', addressed: true,
    content: 'ship the patch', sessionKey: 'direct:c-1:sender:u-1',
    reply: { sessionWebhook: undefined, sessionWebhookExpiredTime: undefined },
  })
})

test('routes approval and cancellation controls outside the serialized turn queue', async () => {
  const calls = []
  const core = new DingTalkStreamCore({
    async runTurn() { throw new Error('control commands must not run a turn') },
    async sendMarkdown(message, text) { calls.push(['send', message.msgId, text]) },
    resolveApproval(input) { calls.push(['approval', input.decision, input.token]); return { text: 'recorded' } },
    cancel(sessionKey) { calls.push(['cancel', sessionKey]); return true },
  }, { allowedUsers: ['u-1'] })

  const approval = core.accept(payload({ msgId: 'm-approval', text: { content: '/approve abcdefghijkl' } }))
  const cancellation = core.accept(payload({ msgId: 'm-cancel', text: { content: '/cancel' } }))
  assert.equal(approval.reason, 'approval')
  assert.equal(cancellation.reason, 'cancel')
  await Promise.all([approval.task, cancellation.task])
  assert.ok(calls.some((call) => (
    call[0] === 'approval' && call[1] === 'approve' && call[2] === 'abcdefghijkl'
  )))
  assert.ok(calls.some((call) => call[0] === 'cancel'))
})

test('returns a generic reply and rejects invalid approval decisions', async () => {
  const replies = []
  const core = new DingTalkStreamCore({
    async runTurn() { throw new Error('control commands must not run a turn') },
    async sendMarkdown(_message, text) { replies.push(text) },
    async resolveApproval() { throw new Error('unknown token secret detail') },
  }, { allowedUsers: ['u-1'] })

  const approval = core.accept(payload({ msgId: 'm-invalid-approval', text: { content: '/approve abcdefghijkl' } }))
  await assert.rejects(approval.task, /unknown token secret detail/)
  assert.deepEqual(replies, ['Approval decision was not accepted.'])
})

test('acknowledges immediately and delivers one allowed turn asynchronously', async () => {
  const calls = []
  const core = new DingTalkStreamCore({
    async runTurn(input) { calls.push(['turn', input]); return { text: 'done' } },
    async sendMarkdown(message, text) { calls.push(['send', message.msgId, text]) },
  }, { allowedUsers: ['u-1'] })
  const accepted = core.accept(payload())
  assert.deepEqual(accepted.ack, { status: 'SUCCESS' })
  assert.equal(accepted.accepted, true)
  await accepted.task
  assert.equal(calls[0][0], 'turn')
  assert.deepEqual(calls[1], ['send', 'm-1', 'done'])
})

test('deduplicates retries by msgId', async () => {
  let turns = 0
  const core = new DingTalkStreamCore({ async runTurn() { turns += 1; return { text: 'ok' } }, async sendMarkdown() {} }, { allowedUsers: ['u-1'] })
  await core.accept(payload()).task
  const retry = core.accept(payload())
  assert.equal(retry.reason, 'duplicate')
  await retry.task
  assert.equal(turns, 1)
})

test('denies by default without invoking the harness', async () => {
  let turns = 0
  const replies = []
  const core = new DingTalkStreamCore({ async runTurn() { turns += 1 }, async sendMarkdown(_message, text) { replies.push(text) } })
  assert.deepEqual(await core.accept(payload()).task, { denied: true })
  assert.equal(turns, 0)
  assert.match(replies[0], /Access denied/)
})

test('ignores a group message that does not mention the bot', async () => {
  const core = new DingTalkStreamCore({ async runTurn() { throw new Error('unexpected') }, async sendMarkdown() {} }, { allowedUsers: ['u-1'] })
  const result = core.accept(payload({ conversationType: '2', isInAtList: false }))
  assert.equal(result.reason, 'not-addressed')
  await result.task
})

test('serializes turns in one session while allowing separate session keys', async () => {
  const order = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const core = new DingTalkStreamCore({
    async runTurn(input) {
      order.push(`start:${input.text}`)
      if (input.text === 'first') await firstGate
      order.push(`end:${input.text}`)
      return { text: input.text }
    },
    async sendMarkdown() {},
  }, { allowedUsers: ['u-1', 'u-2'] })
  const first = core.accept(payload({ msgId: 'm-1', text: { content: 'first' } }))
  const second = core.accept(payload({ msgId: 'm-2', text: { content: 'second' } }))
  const other = core.accept(payload({ msgId: 'm-3', senderStaffId: 'u-2', text: { content: 'other' } }))
  await other.task
  assert.deepEqual(order.slice(0, 3), ['start:first', 'start:other', 'end:other'])
  releaseFirst()
  await Promise.all([first.task, second.task])
  assert.deepEqual(order.slice(-3), ['end:first', 'start:second', 'end:second'])
})
