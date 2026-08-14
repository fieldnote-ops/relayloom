import Schema from '@deepseek-ai/schemastery'
import { DWClient } from 'dingtalk-stream'
import { DingTalkStreamCore } from './index.js'
import { DshAgentAdapter } from './dsh-agent-adapter.js'
import { bindOfficialDingTalkStreamClient } from './official-stream-adapter.js'
import { createDingTalkWebhookTransport } from './webhook-transport.js'

export const name = 'relayloom'
export const inject = ['agents', 'agentPresets']

export const Config = Schema.object({
  enabled: Schema.boolean().default(false),
  clientIdEnv: Schema.string().default('DINGTALK_CLIENT_ID'),
  clientSecretEnv: Schema.string().default('DINGTALK_CLIENT_SECRET'),
  allowedUsers: Schema.array(Schema.string()).default([]),
  preset: Schema.string(),
  provider: Schema.string(),
  model: Schema.string(),
  cwd: Schema.string(),
  maxTextChars: Schema.number().default(4_000),
  deduplicationLimit: Schema.number().default(10_000),
  approvalTtlMs: Schema.number().default(600_000),
  webhookTimeoutMs: Schema.number().default(15_000),
  maxMarkdownChars: Schema.number().default(3_500),
  debug: Schema.boolean().default(false),
})

function envName(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be an environment-variable name`)
  }
  return value
}

function boundedInteger(value, fallback, min, max, label) {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`)
  }
  return result
}

export function normalizePluginConfig(input = {}) {
  const config = {
    enabled: input.enabled ?? false,
    clientIdEnv: envName(input.clientIdEnv ?? 'DINGTALK_CLIENT_ID', 'clientIdEnv'),
    clientSecretEnv: envName(input.clientSecretEnv ?? 'DINGTALK_CLIENT_SECRET', 'clientSecretEnv'),
    allowedUsers: [...new Set(input.allowedUsers ?? [])],
    preset: input.preset,
    provider: input.provider,
    model: input.model,
    cwd: input.cwd,
    maxTextChars: boundedInteger(input.maxTextChars, 4_000, 1, 20_000, 'maxTextChars'),
    deduplicationLimit: boundedInteger(input.deduplicationLimit, 10_000, 1, 1_000_000, 'deduplicationLimit'),
    approvalTtlMs: boundedInteger(input.approvalTtlMs, 600_000, 10_000, 3_600_000, 'approvalTtlMs'),
    webhookTimeoutMs: boundedInteger(input.webhookTimeoutMs, 15_000, 1_000, 120_000, 'webhookTimeoutMs'),
    maxMarkdownChars: boundedInteger(input.maxMarkdownChars, 3_500, 200, 10_000, 'maxMarkdownChars'),
    debug: input.debug ?? false,
  }
  if (typeof config.enabled !== 'boolean' || typeof config.debug !== 'boolean') throw new Error('enabled and debug must be booleans')
  if (config.enabled && config.allowedUsers.length === 0) throw new Error('enabled bridge requires a non-empty allowedUsers list')
  if (config.allowedUsers.some((value) => typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value))) {
    throw new Error('allowedUsers must contain non-empty single-line staff ids')
  }
  if (config.cwd !== undefined && (typeof config.cwd !== 'string' || !config.cwd.startsWith('/'))) {
    throw new Error('cwd must be an absolute path')
  }
  return config
}

export async function mountDingTalkBridge(ctx, inputConfig = {}, dependencies = {}) {
  const config = normalizePluginConfig(inputConfig)
  if (!config.enabled) return { enabled: false, async dispose() {} }
  const env = dependencies.env ?? process.env
  const clientId = env[config.clientIdEnv]
  const clientSecret = env[config.clientSecretEnv]
  if (!clientId || !clientSecret) {
    throw new Error(`DingTalk credentials are missing: set ${config.clientIdEnv} and ${config.clientSecretEnv}`)
  }
  const client = dependencies.client ?? new DWClient({
    clientId,
    clientSecret,
    debug: config.debug,
    autoReconnect: true,
    maxPendingCallbackHandlers: 100,
  })
  const transport = dependencies.transport ?? createDingTalkWebhookTransport(client, {
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: config.webhookTimeoutMs,
    maxMarkdownChars: config.maxMarkdownChars,
  })
  const dsh = dependencies.dshAdapter ?? new DshAgentAdapter(ctx, {
    preset: config.preset,
    provider: config.provider,
    model: config.model,
    cwd: config.cwd,
    approvalTtlMs: config.approvalTtlMs,
    sendApproval: transport.sendApproval,
  })
  const core = dependencies.core ?? new DingTalkStreamCore({
    runTurn: (input) => dsh.runTurn(input),
    sendMarkdown: (message, text) => transport.sendMarkdown(message, text),
    resolveApproval: (input) => dsh.resolveApproval(input),
    cancel: (sessionKey) => dsh.cancel(sessionKey),
  }, {
    allowedUsers: config.allowedUsers,
    maxTextChars: config.maxTextChars,
    deduplicationLimit: config.deduplicationLimit,
  })
  const binding = bindOfficialDingTalkStreamClient(client, core, {
    onProtocolError: (error) => ctx.logger?.warn?.(`dingtalk bridge protocol error: ${String(error)}`),
    onTaskError: (error) => ctx.logger?.warn?.(`dingtalk bridge task error: ${String(error)}`),
  })
  try {
    await client.connect()
    if (client.connected === false) {
      throw new Error('DingTalk Stream connection did not become ready')
    }
  } catch (error) {
    binding.dispose()
    client.disconnect()
    await dsh.dispose()
    throw error
  }
  let disposed = false
  return {
    enabled: true,
    client,
    core,
    async dispose() {
      if (disposed) return
      disposed = true
      binding.dispose()
      client.disconnect()
      await dsh.dispose()
    },
  }
}

export async function apply(ctx, inputConfig) {
  const mounted = await mountDingTalkBridge(ctx, inputConfig)
  ctx.effect(() => () => mounted.dispose())
}

export default apply
