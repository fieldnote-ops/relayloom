import { randomBytes } from 'node:crypto'

export {
  bindOfficialDingTalkStreamClient,
  DINGTALK_ROBOT_TOPIC,
} from './official-stream-adapter.js'
export { DshAgentAdapter, sessionIdForDingTalkKey } from './dsh-agent-adapter.js'
export { createDingTalkWebhookTransport, validateSessionWebhook } from './webhook-transport.js'
export { apply, Config, mountDingTalkBridge, name } from './plugin.js'

const DEFAULT_MAX_TEXT_CHARS = 4_000
const DEFAULT_DEDUPLICATION_LIMIT = 10_000
const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1_000

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required`)
  return value.trim()
}

function conversationType(value) {
  return String(value) === '2' ? 'group' : 'direct'
}

function safeOptionalString(value, label, maxLength = 8_192) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

export function normalizeInbound(payload, { maxTextChars = DEFAULT_MAX_TEXT_CHARS } = {}) {
  const msgId = requiredString(payload?.msgId, 'msgId')
  const conversationId = requiredString(payload?.conversationId, 'conversationId')
  const senderId = requiredString(payload?.senderStaffId ?? payload?.senderId, 'sender id')
  const kind = conversationType(payload?.conversationType)
  if (payload?.msgtype !== undefined && payload.msgtype !== 'text') throw new Error('only text messages are supported')
  const content = requiredString(payload?.text?.content, 'text content')
  if (content.length > maxTextChars) throw new Error(`text content exceeds ${maxTextChars} characters`)
  return {
    msgId,
    conversationId,
    senderId,
    kind,
    addressed: kind === 'direct' || payload?.isInAtList === true,
    content,
    sessionKey: `${kind}:${conversationId}:sender:${senderId}`,
    reply: {
      sessionWebhook: safeOptionalString(payload?.sessionWebhook, 'sessionWebhook'),
      sessionWebhookExpiredTime: Number.isSafeInteger(payload?.sessionWebhookExpiredTime)
        ? payload.sessionWebhookExpiredTime
        : undefined,
    },
  }
}

class BoundedSeenSet {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) {
      throw new Error('deduplicationLimit must be an integer between 1 and 1000000')
    }
    this.limit = limit
    this.values = new Map()
  }

  add(value) {
    if (this.values.has(value)) return false
    this.values.set(value, true)
    while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value)
    return true
  }
}

class SerialQueues {
  constructor() { this.tails = new Map() }

  enqueue(key, task) {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.then(() => undefined, () => undefined)
    this.tails.set(key, settled)
    return next.finally(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key)
    })
  }
}

function publicApproval(record) {
  const { settle: _settle, timer: _timer, ...value } = record
  return { ...value }
}

export class ApprovalRegistry {
  constructor(options = {}) {
    this.now = options.now ?? Date.now
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(18).toString('base64url'))
    this.ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.pending = new Map()
  }

  create({ sessionKey, conversationId, senderId, action }) {
    const token = this.tokenFactory()
    if (this.pending.has(token)) throw new Error('approval token collision')
    const record = {
      token,
      sessionKey: requiredString(sessionKey, 'sessionKey'),
      conversationId: requiredString(conversationId, 'conversationId'),
      senderId: requiredString(senderId, 'senderId'),
      action: requiredString(action, 'action'),
      expiresAt: this.now() + this.ttlMs,
      settle: undefined,
      timer: undefined,
    }
    this.pending.set(token, record)
    return publicApproval(record)
  }

  wait(token, { signal } = {}) {
    const record = this.pending.get(token)
    if (!record) return Promise.reject(new Error('approval is absent or already consumed'))
    if (record.settle) return Promise.reject(new Error('approval already has a waiter'))
    return new Promise((resolve) => {
      const finish = (decision) => {
        if (record.timer !== undefined) this.clearTimer(record.timer)
        signal?.removeEventListener('abort', abort)
        resolve({ ...publicApproval(record), decision })
      }
      const abort = () => {
        if (this.pending.get(token) !== record) return
        this.pending.delete(token)
        finish('cancelled')
      }
      record.settle = finish
      const delay = Math.max(0, record.expiresAt - this.now())
      record.timer = this.setTimer(() => {
        if (this.pending.get(token) !== record) return
        this.pending.delete(token)
        finish('expired')
      }, delay)
      record.timer?.unref?.()
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  }

  consume({ token, conversationId, senderId, decision }) {
    const record = this.pending.get(token)
    if (!record) throw new Error('approval is absent or already consumed')
    this.pending.delete(token)
    if (record.expiresAt <= this.now()) {
      record.settle?.('expired')
      throw new Error('approval expired')
    }
    if (record.conversationId !== conversationId || record.senderId !== senderId) {
      record.settle?.('rejected')
      throw new Error('approval actor mismatch')
    }
    if (!['approve', 'reject'].includes(decision)) {
      record.settle?.('rejected')
      throw new Error('decision must be approve or reject')
    }
    record.settle?.(decision)
    return { ...publicApproval(record), decision }
  }

  cancel(token) {
    const record = this.pending.get(token)
    if (!record) return false
    this.pending.delete(token)
    record.settle?.('cancelled')
    return true
  }

  dispose() {
    for (const record of this.pending.values()) record.settle?.('cancelled')
    this.pending.clear()
  }
}

function controlCommand(content) {
  if (content === '/cancel') return { kind: 'cancel' }
  const match = /^\/(approve|reject)\s+([A-Za-z0-9_-]{12,128})$/.exec(content)
  return match ? { kind: 'approval', decision: match[1], token: match[2] } : undefined
}

export class DingTalkStreamCore {
  constructor(adapter, options = {}) {
    if (!adapter || typeof adapter.runTurn !== 'function' || typeof adapter.sendMarkdown !== 'function') {
      throw new TypeError('adapter must implement runTurn and sendMarkdown')
    }
    this.adapter = adapter
    this.allowedUsers = new Set(options.allowedUsers ?? [])
    this.maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
    this.seen = new BoundedSeenSet(options.deduplicationLimit ?? DEFAULT_DEDUPLICATION_LIMIT)
    this.queues = new SerialQueues()
  }

  denialTask(message) {
    return this.adapter.sendMarkdown(message, 'Access denied. Ask the operator to add your staff id to the allowlist.')
      .then(() => ({ denied: true }))
  }

  accept(payload) {
    let message
    try { message = normalizeInbound(payload, { maxTextChars: this.maxTextChars }) } catch (error) {
      return { ack: { status: 'SUCCESS' }, accepted: false, reason: 'invalid', task: Promise.resolve({ error }) }
    }
    if (!this.seen.add(message.msgId)) {
      return { ack: { status: 'SUCCESS' }, accepted: false, reason: 'duplicate', task: Promise.resolve({ duplicate: true }) }
    }
    if (!message.addressed) {
      return { ack: { status: 'SUCCESS' }, accepted: false, reason: 'not-addressed', task: Promise.resolve({ ignored: true }) }
    }
    if (!this.allowedUsers.has(message.senderId)) {
      return { ack: { status: 'SUCCESS' }, accepted: true, reason: 'denied', task: this.denialTask(message) }
    }

    const control = controlCommand(message.content)
    if (control?.kind === 'approval') {
      const task = Promise.resolve()
        .then(() => {
          if (typeof this.adapter.resolveApproval !== 'function') throw new Error('approval controls are unavailable')
          return this.adapter.resolveApproval({
            ...control,
            sessionKey: message.sessionKey,
            conversationId: message.conversationId,
            senderId: message.senderId,
          })
        })
        .then((result) => this.adapter.sendMarkdown(message, result?.text ?? 'Approval decision recorded.'))
        .catch(async (error) => {
          await this.adapter.sendMarkdown(message, 'Approval decision was not accepted.')
          throw error
        })
      return { ack: { status: 'SUCCESS' }, accepted: true, reason: 'approval', task }
    }
    if (control?.kind === 'cancel') {
      const task = Promise.resolve(this.adapter.cancel?.(message.sessionKey))
        .then((cancelled) => this.adapter.sendMarkdown(message, cancelled ? 'Cancellation requested.' : 'No active session was found.'))
      return { ack: { status: 'SUCCESS' }, accepted: true, reason: 'cancel', task }
    }

    const task = this.queues.enqueue(message.sessionKey, async () => {
      const result = await this.adapter.runTurn({
        sessionKey: message.sessionKey,
        text: message.content,
        inbound: message,
        source: {
          platform: 'dingtalk',
          conversationId: message.conversationId,
          senderId: message.senderId,
          msgId: message.msgId,
        },
      })
      await this.adapter.sendMarkdown(message, requiredString(result?.text, 'turn result text'))
      return { delivered: true, sessionKey: message.sessionKey }
    })
    return { ack: { status: 'SUCCESS' }, accepted: true, task }
  }
}
