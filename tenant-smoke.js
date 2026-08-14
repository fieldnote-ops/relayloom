import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DWClient } from 'dingtalk-stream'

import { normalizeInbound } from './index.js'
import { bindOfficialDingTalkStreamClient } from './official-stream-adapter.js'
import { createDingTalkWebhookTransport } from './webhook-transport.js'

const DEFAULT_TIMEOUT_SECONDS = 180
const REGISTRATION_TIMEOUT_MS = 15_000

export class TenantSmokeError extends Error {
  constructor(phase, message) {
    super(message)
    this.name = 'TenantSmokeError'
    this.phase = phase
  }
}

function requiredOneLine(value, label, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new TenantSmokeError('configuration', `${label} is missing or invalid`)
  }
  return value
}

function safeReportPath(value, cwd) {
  const path = resolve(cwd, value || 'relayloom-tenant-smoke.json')
  const local = relative(cwd, path)
  if (local === '..' || local.startsWith(`..${sep}`) || local.length === 0) {
    throw new TenantSmokeError('configuration', 'RELAYLOOM_PROBE_REPORT must be a workspace-relative file path')
  }
  return path
}

export function readTenantSmokeConfig(env = process.env, cwd = process.cwd()) {
  const timeoutSeconds = Number(env.RELAYLOOM_PROBE_TIMEOUT_SECONDS || DEFAULT_TIMEOUT_SECONDS)
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 600) {
    throw new TenantSmokeError('configuration', 'RELAYLOOM_PROBE_TIMEOUT_SECONDS must be an integer from 30 to 600')
  }
  return {
    clientId: requiredOneLine(env.DINGTALK_CLIENT_ID, 'DINGTALK_CLIENT_ID', 512),
    clientSecret: requiredOneLine(env.DINGTALK_CLIENT_SECRET, 'DINGTALK_CLIENT_SECRET', 2_048),
    allowedUser: requiredOneLine(env.RELAYLOOM_ALLOWED_USER, 'RELAYLOOM_ALLOWED_USER', 512),
    challenge: `relayloom-${randomBytes(8).toString('hex')}`,
    timeoutMs: timeoutSeconds * 1_000,
    reportPath: safeReportPath(env.RELAYLOOM_PROBE_REPORT, resolve(cwd)),
  }
}

function waitFor(predicate, timeoutMs, delay = 50) {
  const startedAt = Date.now()
  return new Promise((resolvePromise, rejectPromise) => {
    const check = () => {
      if (predicate()) return resolvePromise()
      if (Date.now() - startedAt >= timeoutMs) {
        return rejectPromise(new TenantSmokeError('registration', 'DingTalk Stream registration did not become ready'))
      }
      const timer = setTimeout(check, delay)
      timer.unref?.()
    }
    check()
  })
}

function hashChallenge(value) {
  return createHash('sha256').update(value).digest('hex')
}

function writeReport(path, report) {
  try {
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch {
    throw new TenantSmokeError('report', 'could not create the report; choose a new workspace-relative path')
  }
}

export async function runTenantSmoke(config, dependencies = {}) {
  const now = dependencies.now ?? (() => Date.now())
  const client = dependencies.client ?? new DWClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    debug: false,
    autoReconnect: false,
    maxPendingCallbackHandlers: 10,
  })
  const transport = dependencies.transport ?? createDingTalkWebhookTransport(client)
  const bind = dependencies.bind ?? bindOfficialDingTalkStreamClient
  const persist = dependencies.writeReport ?? writeReport
  const announce = dependencies.announce ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`))
  const startedAt = now()
  let awaitingMatchedAck = false
  let acknowledgedAt
  let ignoredMessages = 0
  let protocolErrors = 0
  let settled = false
  let resolveProbe
  let rejectProbe
  const probe = new Promise((resolvePromise, rejectPromise) => {
    resolveProbe = resolvePromise
    rejectProbe = rejectPromise
  })

  const originalAck = client.socketCallBackResponse.bind(client)
  client.socketCallBackResponse = (messageId, result) => {
    const value = originalAck(messageId, result)
    if (awaitingMatchedAck && acknowledgedAt === undefined) {
      acknowledgedAt = now()
      awaitingMatchedAck = false
    }
    return value
  }

  const core = {
    accept(payload) {
      let message
      try {
        message = normalizeInbound(payload)
      } catch {
        protocolErrors += 1
        return { accepted: false, reason: 'invalid', task: Promise.resolve() }
      }
      if (!message.addressed || message.senderId !== config.allowedUser || message.content !== config.challenge) {
        ignoredMessages += 1
        return { accepted: false, reason: 'not-probe', task: Promise.resolve() }
      }
      awaitingMatchedAck = true
      const task = Promise.resolve()
        .then(() => transport.sendMarkdown(message, [
          '### RelayLoom live probe passed',
          '',
          'The Stream callback was acknowledged before this bounded sessionWebhook reply completed.',
        ].join('\n')))
        .then(() => {
          if (settled) return
          settled = true
          resolveProbe({ message, replyAcceptedAt: now() })
        })
      return { accepted: true, reason: 'probe', task }
    },
  }

  const binding = bind(client, core, {
    onProtocolError() { protocolErrors += 1 },
    onTaskError() {
      if (settled) return
      settled = true
      rejectProbe(new TenantSmokeError('reply', 'DingTalk did not accept the bounded sessionWebhook reply'))
    },
  })

  const timeout = setTimeout(() => {
    if (settled) return
    settled = true
    rejectProbe(new TenantSmokeError('timeout', 'no matching tenant challenge arrived before the timeout'))
  }, config.timeoutMs)
  timeout.unref?.()

  try {
    await client.connect()
    if (client.connected !== true) {
      throw new TenantSmokeError('connection', 'DingTalk Stream connection did not become ready')
    }
    if (client.registered === false) await waitFor(() => client.registered === true, REGISTRATION_TIMEOUT_MS)
    const readyAt = now()
    announce({
      status: 'waiting',
      challenge: config.challenge,
      instruction: 'Send this exact text to the allowlisted internal robot from the configured staff account.',
      timeoutSeconds: Math.round(config.timeoutMs / 1_000),
    })
    const result = await probe
    if (acknowledgedAt === undefined || acknowledgedAt > result.replyAcceptedAt) {
      throw new TenantSmokeError('ordering', 'callback ACK was not observed before reply acceptance')
    }
    const report = {
      schemaVersion: 1,
      decision: 'pass',
      product: 'RelayLoom',
      version: '0.2.1',
      protocol: 'DingTalk Stream robot callback plus sessionWebhook reply',
      checks: {
        streamConnected: true,
        streamRegistered: true,
        exactChallengeMatched: true,
        allowedSenderMatched: true,
        callbackAcknowledged: true,
        ackBeforeReplyAccepted: true,
        replyRequestAccepted: true,
      },
      observations: {
        conversationKind: result.message.kind,
        ignoredMessages,
        protocolErrors,
        challengeSha256: hashChallenge(config.challenge),
      },
      timings: {
        connectAndRegisterMs: readyAt - startedAt,
        challengeToAckMs: acknowledgedAt - readyAt,
        ackToReplyAcceptedMs: result.replyAcceptedAt - acknowledgedAt,
        totalMs: result.replyAcceptedAt - startedAt,
      },
      privacy: {
        clientIdRecorded: false,
        clientSecretRecorded: false,
        staffIdRecorded: false,
        conversationIdRecorded: false,
        messageIdRecorded: false,
        sessionWebhookRecorded: false,
        messageBodyRecorded: false,
      },
      scope: {
        credentialsSource: 'process environment only',
        modelCalled: false,
        dshAgentCalled: false,
        externalServiceCalled: true,
      },
      evidenceLimit: 'Proves one live Stream receive/ACK/sessionWebhook-reply transport round trip. Separate HarnessProof evidence covers DSH composition and boot; this probe does not call a model or DSH agent.',
    }
    persist(config.reportPath, report)
    announce({ status: 'passed', reportPath: relative(process.cwd(), config.reportPath) })
    return report
  } finally {
    clearTimeout(timeout)
    binding.dispose()
    client.socketCallBackResponse = originalAck
    client.disconnect()
  }
}

async function main() {
  try {
    const config = readTenantSmokeConfig()
    await runTenantSmoke(config)
  } catch (error) {
    const phase = error instanceof TenantSmokeError ? error.phase : 'unexpected'
    process.stderr.write(`${JSON.stringify({ decision: 'fail', phase, error: 'RelayLoom tenant smoke did not pass; no credentials or tenant identifiers were written.' })}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
