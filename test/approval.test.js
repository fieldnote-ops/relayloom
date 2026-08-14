import assert from 'node:assert/strict'
import test from 'node:test'
import { ApprovalRegistry } from '../index.js'

test('binds one approval to its actor and consumes it once', () => {
  const registry = new ApprovalRegistry({ now: () => 100, tokenFactory: () => 'token-1' })
  const created = registry.create({ sessionKey: 's-1', conversationId: 'c-1', senderId: 'u-1', action: 'write file' })
  assert.equal(created.expiresAt, 600_100)
  const consumed = registry.consume({ token: 'token-1', conversationId: 'c-1', senderId: 'u-1', decision: 'approve' })
  assert.equal(consumed.decision, 'approve')
  assert.throws(() => registry.consume({ token: 'token-1', conversationId: 'c-1', senderId: 'u-1', decision: 'approve' }), /absent|consumed/)
})

test('rejects an actor mismatch and still burns the token', () => {
  const registry = new ApprovalRegistry({ tokenFactory: () => 'token-2' })
  registry.create({ sessionKey: 's-1', conversationId: 'c-1', senderId: 'u-1', action: 'run command' })
  assert.throws(() => registry.consume({ token: 'token-2', conversationId: 'c-1', senderId: 'u-2', decision: 'approve' }), /actor mismatch/)
  assert.throws(() => registry.consume({ token: 'token-2', conversationId: 'c-1', senderId: 'u-1', decision: 'approve' }), /absent|consumed/)
})

test('expires approvals fail closed', () => {
  let now = 0
  const registry = new ApprovalRegistry({ now: () => now, ttlMs: 10, tokenFactory: () => 'token-3' })
  registry.create({ sessionKey: 's-1', conversationId: 'c-1', senderId: 'u-1', action: 'run command' })
  now = 10
  assert.throws(() => registry.consume({ token: 'token-3', conversationId: 'c-1', senderId: 'u-1', decision: 'approve' }), /expired/)
})

test('settles an awaiting approval and cancellation without exposing internal callbacks', async () => {
  const registry = new ApprovalRegistry({ tokenFactory: () => 'token-wait-123' })
  const created = registry.create({ sessionKey: 's-1', conversationId: 'c-1', senderId: 'u-1', action: 'write file' })
  assert.equal('settle' in created, false)
  const waiting = registry.wait(created.token)
  registry.consume({ token: created.token, conversationId: 'c-1', senderId: 'u-1', decision: 'approve' })
  assert.equal((await waiting).decision, 'approve')

  const second = registry.create({ sessionKey: 's-1', conversationId: 'c-1', senderId: 'u-1', action: 'run command' })
  const cancelled = registry.wait(second.token)
  assert.equal(registry.cancel(second.token), true)
  assert.equal((await cancelled).decision, 'cancelled')
})
