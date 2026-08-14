import assert from 'node:assert/strict'
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
