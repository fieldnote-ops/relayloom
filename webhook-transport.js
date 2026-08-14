const DEFAULT_HOSTS = ['oapi.dingtalk.com', 'api.dingtalk.com']

export function validateSessionWebhook(value, allowedHosts = DEFAULT_HOSTS) {
  let url
  try { url = new URL(value) } catch { throw new Error('DingTalk sessionWebhook is not a valid URL') }
  const hosts = new Set(allowedHosts.map((host) => String(host).toLowerCase()))
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('DingTalk sessionWebhook must be credential-free HTTPS on port 443')
  }
  if (!hosts.has(url.hostname.toLowerCase())) throw new Error('DingTalk sessionWebhook host is not allowlisted')
  return url.toString()
}

function chunks(value, limit) {
  const points = Array.from(value)
  const result = []
  for (let index = 0; index < points.length; index += limit) result.push(points.slice(index, index + limit).join(''))
  return result.length ? result : ['']
}

async function boundedResponse(response, maxBytes) {
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('DingTalk webhook response exceeded the configured byte limit')
  if (!response.ok) throw new Error(`DingTalk webhook returned HTTP ${response.status}`)
  if (!text) return undefined
  let value
  try { value = JSON.parse(text) } catch { throw new Error('DingTalk webhook returned invalid JSON') }
  if (typeof value?.errcode === 'number' && value.errcode !== 0) {
    throw new Error(`DingTalk webhook rejected the reply with errcode ${value.errcode}`)
  }
  return value
}

export function createDingTalkWebhookTransport(client, options = {}) {
  if (!client || typeof client.getAccessToken !== 'function') throw new TypeError('client.getAccessToken is required')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required')
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576
  const maxMarkdownChars = options.maxMarkdownChars ?? 3_500
  const allowedHosts = options.allowedHosts ?? DEFAULT_HOSTS
  const title = options.title ?? 'RelayLoom'

  async function post(message, text) {
    const webhook = validateSessionWebhook(message?.reply?.sessionWebhook, allowedHosts)
    if (message?.reply?.sessionWebhookExpiredTime !== undefined
      && message.reply.sessionWebhookExpiredTime <= Date.now()) {
      throw new Error('DingTalk sessionWebhook has expired')
    }
    const accessToken = await client.getAccessToken()
    if (typeof accessToken !== 'string' || accessToken.length === 0) throw new Error('DingTalk access token is unavailable')
    for (const part of chunks(text, maxMarkdownChars)) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('DingTalk webhook request timed out')), timeoutMs)
      timer.unref?.()
      try {
        const response = await fetchImpl(webhook, {
          method: 'POST',
          signal: controller.signal,
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-acs-dingtalk-access-token': accessToken,
          },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { title, text: part },
            at: { atUserIds: [message.senderId], isAtAll: false },
          }),
        })
        await boundedResponse(response, maxResponseBytes)
      } finally {
        clearTimeout(timer)
      }
    }
  }

  return {
    sendMarkdown: post,
    sendApproval(message, approval) {
      const text = [
        `### Approval required: ${approval.action}`,
        '',
        `Approve once: \`/approve ${approval.token}\``,
        `Reject: \`/reject ${approval.token}\``,
        '',
        'The token is single-use, bound to this sender and conversation, and expires in ten minutes.',
      ].join('\n')
      return post(message, text)
    },
  }
}
