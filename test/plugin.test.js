import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { mountDingTalkBridge } from '../index.js'
import { normalizePluginConfig } from '../plugin.js'

test('is network-inert and credential-free while disabled', async () => {
  const mounted = await mountDingTalkBridge(undefined, { enabled: false })
  assert.equal(mounted.enabled, false)
  await mounted.dispose()
})

test('fails closed when enabled without an allowlist or credentials', async () => {
  assert.throws(() => normalizePluginConfig({ enabled: true }), /allowedUsers/)
  await assert.rejects(
    mountDingTalkBridge({}, { enabled: true, allowedUsers: ['staff-1'] }, { env: {} }),
    /credentials are missing/,
  )
})

test('fails closed and disconnects when the official SDK swallows a connection failure', async () => {
  class FailedClient extends EventEmitter {
    connected = false
    disconnected = false
    registerCallbackListener(topic, listener) { this.on(topic, listener) }
    socketCallBackResponse() {}
    async connect() {}
    disconnect() { this.disconnected = true }
  }
  const client = new FailedClient()
  let disposed = false
  await assert.rejects(
    mountDingTalkBridge({}, { enabled: true, allowedUsers: ['staff-1'] }, {
      env: { DINGTALK_CLIENT_ID: 'id', DINGTALK_CLIENT_SECRET: 'secret' },
      client,
      transport: { async sendMarkdown() {}, async sendApproval() {} },
      dshAdapter: { async dispose() { disposed = true } },
      core: { accept() { return { task: Promise.resolve() } } },
    }),
    /connection did not become ready/,
  )
  assert.equal(client.disconnected, true)
  assert.equal(disposed, true)
})
