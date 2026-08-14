import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readTenantSmokeConfig, runTenantSmoke, TenantSmokeError } from '../tenant-smoke.js'

class FakeClient extends EventEmitter {
  connected = false
  registered = false
  order = []

  registerCallbackListener(topic, listener) {
    this.on(topic, listener)
  }

  socketCallBackResponse(messageId, value) {
    this.order.push(['ack', messageId, value])
  }

  async connect() {
    this.connected = true
    this.registered = true
  }

  disconnect() {
    this.connected = false
  }
}

function config(overrides = {}) {
  return {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    allowedUser: 'staff-1',
    challenge: 'relayloom-0123456789abcdef',
    timeoutMs: 100,
    reportPath: '/unused/report.json',
    ...overrides,
  }
}

function downstream(challenge, overrides = {}) {
  return {
    headers: { messageId: 'stream-message-1' },
    data: JSON.stringify({
      msgId: 'robot-message-1',
      conversationId: 'conversation-1',
      senderStaffId: 'staff-1',
      conversationType: '1',
      text: { content: challenge },
      sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=opaque',
      ...overrides,
    }),
  }
}

test('requires credentials, one allowed user, and a workspace-local report', () => {
  assert.throws(() => readTenantSmokeConfig({}, '/tmp/workspace'), /DINGTALK_CLIENT_ID/)
  assert.throws(() => readTenantSmokeConfig({
    DINGTALK_CLIENT_ID: 'id',
    DINGTALK_CLIENT_SECRET: 'secret',
    RELAYLOOM_ALLOWED_USER: 'staff',
    RELAYLOOM_PROBE_REPORT: '../outside.json',
  }, '/tmp/workspace'), /workspace-relative/)
})

test('records a sanitized live round trip with ACK before reply acceptance', async () => {
  const client = new FakeClient()
  const announcements = []
  let written
  const promise = runTenantSmoke(config(), {
    client,
    transport: {
      async sendMarkdown(_message, text) {
        client.order.push(['reply', text])
      },
    },
    announce(value) { announcements.push(value) },
    writeReport(_path, report) { written = report },
  })
  await new Promise((resolve) => setImmediate(resolve))
  client.emit('/v1.0/im/bot/messages/get', downstream(config().challenge))
  const report = await promise
  assert.equal(report.decision, 'pass')
  assert.equal(report.checks.ackBeforeReplyAccepted, true)
  assert.deepEqual(client.order.map((entry) => entry[0]), ['ack', 'reply'])
  assert.equal(written.privacy.clientSecretRecorded, false)
  assert.equal(JSON.stringify(written).includes('client-secret'), false)
  assert.equal(JSON.stringify(written).includes('staff-1'), false)
  assert.equal(JSON.stringify(written).includes('conversation-1'), false)
  assert.equal(JSON.stringify(written).includes('robot-message-1'), false)
  assert.equal(announcements[0].status, 'waiting')
  assert.equal(announcements.at(-1).status, 'passed')
})

test('ignores a non-matching challenge and fails closed at timeout', async () => {
  const client = new FakeClient()
  const promise = runTenantSmoke(config({ timeoutMs: 15 }), {
    client,
    transport: { async sendMarkdown() { throw new Error('must not reply') } },
    announce() {},
    writeReport() {},
  })
  await new Promise((resolve) => setImmediate(resolve))
  client.emit('/v1.0/im/bot/messages/get', downstream('wrong-challenge'))
  await assert.rejects(promise, (error) => error instanceof TenantSmokeError && error.phase === 'timeout')
  assert.deepEqual(client.order.map((entry) => entry[0]), ['ack'])
})

test('creates a new 0600 report without overwriting an existing evidence file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relayloom-tenant-smoke-test-'))
  const reportPath = join(directory, 'report.json')
  const client = new FakeClient()
  const promise = runTenantSmoke(config({ reportPath }), {
    client,
    transport: { async sendMarkdown() {} },
    announce() {},
  })
  await new Promise((resolve) => setImmediate(resolve))
  client.emit('/v1.0/im/bot/messages/get', downstream(config().challenge))
  await promise
  assert.equal(statSync(reportPath).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(reportPath)).decision, 'pass')

  const secondClient = new FakeClient()
  const second = runTenantSmoke(config({ reportPath }), {
    client: secondClient,
    transport: { async sendMarkdown() {} },
    announce() {},
  })
  await new Promise((resolve) => setImmediate(resolve))
  secondClient.emit('/v1.0/im/bot/messages/get', downstream(config().challenge))
  await assert.rejects(second, (error) => error instanceof TenantSmokeError && error.phase === 'report')
})
