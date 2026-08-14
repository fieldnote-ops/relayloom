# RelayLoom

RelayLoom is an independent, default-off external chat relay for agent harnesses. Its first compatibility adapter connects the public DingTalk Stream protocol to DeepSeek Harness agents.

This repository is a developer preview, not a verified production bot. The credential-free core, official SDK binding, webhook transport, and real DSH install/boot path are tested; no real DingTalk tenant has yet completed the receive → ACK → reply round trip.

## What is implemented

- immediate callback ACK before asynchronous model work settles;
- retry deduplication by `msgId` and bounded memory use;
- direct-message and group-mention filtering;
- default-deny staff-id allowlist;
- stable sender-isolated sessions with deterministic non-secret storage ids;
- DSH agent create/resume, preset mounting, committed-answer delivery, cancellation, and bounded teardown;
- single-use, expiring, sender-and-conversation-bound `/approve` and `/reject` decisions;
- official `sessionWebhook` Markdown replies with exact HTTPS host allowlisting, redirect denial, response limits, timeout, expiry checks, and output chunking;
- a default `enabled: false` bundle, so installation and boot do not read credentials or make DingTalk requests.

The text approval flow is a safe fallback, not a claim that interactive approval cards work. Card rendering/update, attachments, reconnect replay, and a tenant-observed round trip remain deferred.

## Install from GitHub

During the DeepSeek Harness developer preview, review and pin a full RelayLoom commit rather than relying on a moving branch:

```sh
dsh plugin --profile web add github:fieldnote-ops/relayloom#FULL_COMMIT_SHA
```

The installed bundle remains disabled. Edit its profile row only after creating a DingTalk internal robot and setting credentials in the launching environment:

```yaml
- id: relayloom
  name: relayloom
  config:
    enabled: true
    clientIdEnv: DINGTALK_CLIENT_ID
    clientSecretEnv: DINGTALK_CLIENT_SECRET
    allowedUsers:
      - your-staff-id
    preset: standard
```

RelayLoom does not read credentials from YAML. Empty allowlists are rejected whenever the bridge is enabled.

## Evidence

Local tests cover protocol normalization, ACK ordering, deduplication, serialization, DSH session create/resume, committed output, cancellation, approval actor binding, webhook SSRF defenses, and default-off lifecycle. HarnessProof v0.1.5 installed the exact locked dependency graph in an isolated copy, added the plugin through the official DSH command, observed the bundle layer, booted DSH `0.1.0-rc.6`, and received HTTP 200 without credentials or external service calls.

This does **not** prove a live DingTalk robot, card approval behavior, independent security review, independent-user adoption, Marketplace acceptance, purchase, or income.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

The direct runtime dependency is the official `dingtalk-stream` Node SDK. Protocol references:

- <https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs>
- <https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md>

RelayLoom is a FIELD NOTE AI-assisted, human-reviewed interoperability experiment. It is not affiliated with, sponsored by, endorsed by, or an official product of DingTalk, Alibaba, DeepSeek, or their affiliates. Product names identify compatibility targets only; no logos or brand trade dress are used.

MIT licensed.
