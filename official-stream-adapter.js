export const DINGTALK_ROBOT_TOPIC = '/v1.0/im/bot/messages/get'

function requiredMethod(value, name) {
  if (!value || typeof value[name] !== 'function') {
    throw new TypeError(`client must implement ${name}`)
  }
}

function report(callback, error, context) {
  try {
    callback?.(error, context)
  } catch {
    // A reporting hook must not turn an already-acknowledged callback into a retry.
  }
}

/**
 * Bind the credential-free core to the public dingtalk-stream DWClient surface.
 * The caller owns client construction, connect/disconnect, and credentials.
 */
export function bindOfficialDingTalkStreamClient(client, core, options = {}) {
  requiredMethod(client, 'registerCallbackListener')
  requiredMethod(client, 'socketCallBackResponse')
  if (!core || typeof core.accept !== 'function') {
    throw new TypeError('core must implement accept')
  }

  const listener = (downstream) => {
    const messageId = downstream?.headers?.messageId
    if (typeof messageId !== 'string' || messageId.length === 0) {
      report(options.onProtocolError, new Error('downstream messageId is required'), { downstream })
      return
    }

    let outcome
    try {
      const payload = JSON.parse(downstream.data)
      outcome = core.accept(payload)
    } catch (error) {
      report(options.onProtocolError, error, { messageId })
    }

    // DingTalk's robot CALLBACK response ignores data. Reply before any turn work
    // settles so a slow harness run cannot trigger the platform retry window.
    try {
      client.socketCallBackResponse(messageId, null)
    } catch (error) {
      report(options.onProtocolError, error, { messageId, phase: 'ack' })
      return
    }

    if (outcome?.task) {
      void Promise.resolve(outcome.task).catch((error) => {
        report(options.onTaskError, error, {
          messageId,
          accepted: outcome.accepted,
          reason: outcome.reason,
        })
      })
    }
  }

  client.registerCallbackListener(DINGTALK_ROBOT_TOPIC, listener)
  return {
    topic: DINGTALK_ROBOT_TOPIC,
    listener,
    dispose() {
      if (typeof client.off === 'function') client.off(DINGTALK_ROBOT_TOPIC, listener)
      else if (typeof client.removeListener === 'function') client.removeListener(DINGTALK_ROBOT_TOPIC, listener)
    },
  }
}
