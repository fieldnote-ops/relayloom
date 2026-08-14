import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bindOfficialDingTalkStreamClient,
  DINGTALK_ROBOT_TOPIC,
} from '../index.js'

function fakeClient() {
  return {
    registered: [],
    acknowledgements: [],
    registerCallbackListener(topic, listener) {
      this.registered.push({ topic, listener })
      return this
    },
    socketCallBackResponse(messageId, value) {
      this.acknowledgements.push({ messageId, value })
    },
    off(topic, listener) {
      this.removed = { topic, listener }
    },
  }
}

test('registers the official robot topic and ACKs before async work settles', async () => {
  const client = fakeClient()
  let settle
  const task = new Promise((resolve) => { settle = resolve })
  const accepted = []
  bindOfficialDingTalkStreamClient(client, {
    accept(payload) {
      accepted.push(payload)
      return { accepted: true, task }
    },
  })

  assert.equal(client.registered[0].topic, DINGTALK_ROBOT_TOPIC)
  client.registered[0].listener({
    headers: { messageId: 'transport-1' },
    data: JSON.stringify({ msgId: 'business-1' }),
  })

  assert.deepEqual(accepted, [{ msgId: 'business-1' }])
  assert.deepEqual(client.acknowledgements, [{ messageId: 'transport-1', value: null }])
  settle()
  await task
})

test('returns an explicit listener disposer', () => {
  const client = fakeClient()
  const binding = bindOfficialDingTalkStreamClient(client, { accept() { return { task: Promise.resolve() } } })
  binding.dispose()
  assert.equal(client.removed.topic, DINGTALK_ROBOT_TOPIC)
  assert.equal(client.removed.listener, binding.listener)
})

test('ACKs malformed payloads once and reports the protocol error', () => {
  const client = fakeClient()
  const errors = []
  bindOfficialDingTalkStreamClient(client, { accept() { throw new Error('must not run') } }, {
    onProtocolError(error, context) { errors.push({ error, context }) },
  })

  client.registered[0].listener({ headers: { messageId: 'transport-2' }, data: '{' })

  assert.equal(errors.length, 1)
  assert.equal(errors[0].context.messageId, 'transport-2')
  assert.deepEqual(client.acknowledgements, [{ messageId: 'transport-2', value: null }])
})

test('reports rejected turn work without withholding an ACK', async () => {
  const client = fakeClient()
  const errors = []
  const rejection = Promise.reject(new Error('turn failed'))
  bindOfficialDingTalkStreamClient(client, {
    accept() { return { accepted: true, task: rejection } },
  }, {
    onTaskError(error, context) { errors.push({ error, context }) },
  })

  client.registered[0].listener({ headers: { messageId: 'transport-3' }, data: '{}' })
  await rejection.catch(() => undefined)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(errors[0].error.message, 'turn failed')
  assert.equal(errors[0].context.messageId, 'transport-3')
  assert.deepEqual(client.acknowledgements, [{ messageId: 'transport-3', value: null }])
})

test('rejects incomplete client and core contracts before registration', () => {
  assert.throws(() => bindOfficialDingTalkStreamClient({}, { accept() {} }), /registerCallbackListener/)
  assert.throws(
    () => bindOfficialDingTalkStreamClient(fakeClient(), {}),
    /core must implement accept/,
  )
})
