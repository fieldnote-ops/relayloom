import assert from 'node:assert/strict'
import test from 'node:test'

import { createDingTalkWebhookTransport, validateSessionWebhook } from '../index.js'

function message(overrides = {}) {
  return {
    senderId: 'staff-1',
    reply: { sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=opaque' },
    ...overrides,
  }
}

test('allows only credential-free DingTalk HTTPS webhook targets', () => {
  assert.match(validateSessionWebhook(message().reply.sessionWebhook), /^https:\/\/oapi\.dingtalk\.com\//)
  for (const target of [
    'http://oapi.dingtalk.com/robot/send',
    'https://user:pass@oapi.dingtalk.com/robot/send',
    'https://oapi.dingtalk.com.evil.example/robot/send',
    'https://127.0.0.1/robot/send',
    'https://oapi.dingtalk.com:444/robot/send',
  ]) assert.throws(() => validateSessionWebhook(target), /DingTalk sessionWebhook/)
})

test('posts bounded markdown with an access token and sender mention', async () => {
  const requests = []
  const transport = createDingTalkWebhookTransport({ async getAccessToken() { return 'access-token' } }, {
    maxMarkdownChars: 5,
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) })
      return new Response('{"errcode":0}', { status: 200 })
    },
  })
  await transport.sendMarkdown(message(), '123456789')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].init.headers['x-acs-dingtalk-access-token'], 'access-token')
  assert.deepEqual(requests[0].body.at, { atUserIds: ['staff-1'], isAtAll: false })
  assert.equal(requests[0].body.markdown.text, '12345')
  assert.equal(requests[1].body.markdown.text, '6789')
})

test('rejects an expired webhook before token or network access', async () => {
  let touched = false
  const transport = createDingTalkWebhookTransport({ async getAccessToken() { touched = true; return 'x' } }, {
    fetchImpl: async () => { touched = true; return new Response('{}') },
  })
  await assert.rejects(
    transport.sendMarkdown(message({ reply: { sessionWebhook: message().reply.sessionWebhook, sessionWebhookExpiredTime: Date.now() - 1 } }), 'x'),
    /expired/,
  )
  assert.equal(touched, false)
})

test('surfaces webhook protocol rejection without disclosing the secret URL', async () => {
  const transport = createDingTalkWebhookTransport({ async getAccessToken() { return 'x' } }, {
    fetchImpl: async () => new Response('{"errcode":40035}', { status: 200 }),
  })
  await assert.rejects(transport.sendMarkdown(message(), 'x'), /errcode 40035/)
})
