import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRegistry } from './index.js'

export function sessionIdForDingTalkKey(sessionKey) {
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) throw new Error('sessionKey is required')
  return SessionId(`dingtalk-${createHash('sha256').update(sessionKey).digest('hex')}`)
}

function textFromAssistantMessage(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
    .map((block) => block.text)
}

function failureFromTurn(reason) {
  if (reason?.kind !== 'error') return undefined
  return new Error(reason.error?.message ?? 'DeepSeek Harness turn failed')
}

export class DshAgentAdapter {
  constructor(ctx, options = {}) {
    if (!ctx?.agents || typeof ctx.agents.create !== 'function') throw new TypeError('ctx.agents is required')
    if (!ctx?.agentPresets || typeof ctx.agentPresets.mount !== 'function') throw new TypeError('ctx.agentPresets is required')
    if (typeof ctx.on !== 'function') throw new TypeError('ctx.on is required')
    this.ctx = ctx
    this.agents = ctx.agents
    this.agentPresets = ctx.agentPresets
    this.persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
    this.preset = options.preset
    this.cwd = options.cwd
    this.agentOptions = {
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
    }
    this.sendApproval = options.sendApproval
    this.approvals = options.approvals ?? new ApprovalRegistry({ ttlMs: options.approvalTtlMs })
    this.records = new Map()
    this.byAgent = new WeakMap()
    this.bySession = new WeakMap()
    this.pendingRecords = new Map()
    this.disposed = false
    this.disposers = [
      ctx.on('agent/inbox/claimed', (event) => this.onInboxClaimed(event)),
      ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)),
      ctx.on('approval/request', (request, next) => this.onApprovalRequest(request, next)),
    ].filter((value) => typeof value === 'function')
  }

  setupAgent(agentCtx) {
    return this.agentPresets.mount(agentCtx, this.preset).then(() => undefined)
  }

  async hasPersistedSession(sessionId) {
    if (!this.persistence || typeof this.persistence.list !== 'function') return false
    return (await this.persistence.list()).some((header) => header.id === sessionId)
  }

  async buildRecord(sessionKey) {
    if (this.disposed) throw new Error('DingTalk bridge is disposed')
    const sessionId = sessionIdForDingTalkKey(sessionKey)
    const existing = this.agents.get?.(sessionId)
    if (existing) throw new Error(`refusing to adopt an unowned live agent: ${sessionId}`)
    const common = {
      agentOptions: this.agentOptions,
      setup: (agentCtx) => this.setupAgent(agentCtx),
    }
    const handle = await (await this.hasPersistedSession(sessionId)
      ? this.agents.resume({ resumeSessionId: sessionId, ...common })
      : this.agents.create({ sessionId, meta: this.cwd ? { cwd: this.cwd } : {}, ...common }))
    if (this.disposed) {
      await handle.dispose()
      throw new Error('DingTalk bridge was disposed while creating an agent')
    }
    const record = { sessionKey, handle, agent: handle.agent, inflight: undefined, inbound: undefined }
    this.records.set(sessionKey, record)
    this.byAgent.set(handle.agent, record)
    this.bySession.set(handle.agent.session, record)
    return record
  }

  ensureRecord(sessionKey) {
    const existing = this.records.get(sessionKey)
    if (existing) return Promise.resolve(existing)
    const pending = this.pendingRecords.get(sessionKey)
    if (pending) return pending
    const created = this.buildRecord(sessionKey).finally(() => this.pendingRecords.delete(sessionKey))
    this.pendingRecords.set(sessionKey, created)
    return created
  }

  onInboxClaimed({ agent, message, turn } = {}) {
    const record = this.byAgent.get(agent)
    const inflight = record?.inflight
    if (inflight && inflight.messageId === message?.id) inflight.turn = turn
  }

  onSessionEvent(session, event) {
    const record = this.bySession.get(session)
    const inflight = record?.inflight
    if (!inflight || inflight.turn === undefined || event?.data?.turn !== inflight.turn) return
    if (event.type === 'assistant/message') inflight.text.push(...textFromAssistantMessage(event.data.message))
    if (event.type === 'turn/end') inflight.endReason = event.data.reason
  }

  async onApprovalRequest(request, next) {
    const record = this.byAgent.get(request?.agent)
    const inbound = record?.inbound
    if (!record || !inbound || typeof this.sendApproval !== 'function') return next()
    const approval = this.approvals.create({
      sessionKey: record.sessionKey,
      conversationId: inbound.conversationId,
      senderId: inbound.senderId,
      action: request.reason ? `${request.toolName}: ${request.reason}` : request.toolName,
    })
    const settling = this.approvals.wait(approval.token, { signal: request.signal })
    try {
      await this.sendApproval(inbound, approval)
    } catch (error) {
      this.approvals.cancel(approval.token)
      await settling
      throw error
    }
    const settled = await settling
    return settled.decision === 'approve' ? 'allowed-once'
      : settled.decision === 'reject' ? 'rejected'
        : 'cancelled'
  }

  async runTurn({ sessionKey, text, inbound }) {
    const record = await this.ensureRecord(sessionKey)
    if (record.inflight) throw new Error('a DingTalk turn is already in flight for this session')
    if (this.agents.get?.(record.agent.id) !== record.agent) throw new Error('the bridge-owned agent is no longer live')
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const inflight = { messageId: message.id, turn: undefined, text: [], endReason: undefined }
    record.inflight = inflight
    record.inbound = inbound
    try {
      await this.agents.withInitiator(record.agent, async () => {
        record.agent.followup(message)
        await record.agent.whenIdle()
      })
      if (inflight.turn === undefined) throw new Error('the DingTalk prompt was not claimed by the agent')
      const failure = failureFromTurn(inflight.endReason)
      if (failure) throw failure
      const committed = inflight.text.join('\n').trim()
      return { text: committed || 'The harness turn completed without a text response.' }
    } finally {
      if (record.inflight === inflight) record.inflight = undefined
      record.inbound = undefined
    }
  }

  resolveApproval({ token, conversationId, senderId, decision }) {
    const settled = this.approvals.consume({ token, conversationId, senderId, decision })
    return { text: settled.decision === 'approve' ? 'Approved once.' : 'Rejected.' }
  }

  cancel(sessionKey) {
    const record = this.records.get(sessionKey)
    if (!record) return false
    record.agent.cancel({ kind: 'user' })
    return true
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.approvals.dispose()
    for (const dispose of this.disposers.splice(0)) dispose()
    const records = [...this.records.values()]
    this.records.clear()
    const results = await Promise.allSettled(records.map((record) => record.handle.dispose()))
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
