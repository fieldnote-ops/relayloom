# RelayLoom

[![Self-test](https://github.com/fieldnote-ops/relayloom/actions/workflows/self-test.yml/badge.svg?branch=main)](https://github.com/fieldnote-ops/relayloom/actions/workflows/self-test.yml)

RelayLoom is an independent, default-off external chat relay for agent harnesses. Its first compatibility adapter connects the public DingTalk Stream protocol to DeepSeek Harness agents.

This repository is a developer preview, not a verified production bot. The credential-free core, official SDK binding, webhook transport, and real DSH install/boot path are tested; no real DingTalk tenant has yet completed the receive → ACK → reply round trip.

## More than a notification webhook

| Surface | Implemented boundary |
| --- | --- |
| Direction | Receives DingTalk Stream callbacks and sends bounded `sessionWebhook` replies; it is not limited to one-way group notifications. |
| Callback ordering | ACK is sent before asynchronous agent work settles; retries are deduplicated by `msgId`. |
| Conversation isolation | Sessions are isolated by sender and conversation, while durable ids are deterministic and do not expose raw tenant identifiers. |
| Approval fallback | `/approve` and `/reject` decisions are single-use, expiring, and bound to the original sender and conversation. Interactive cards are not claimed. |
| Default safety | The bundle ships disabled, requires a non-empty staff-id allowlist when enabled, reads credentials only from named environment variables, and rejects unsafe webhook destinations and redirects. |
| Evidence gap | Credential-free tests and DSH rc.6/`latest`/`next` consumers pass. A real tenant receive → ACK → reply round trip has **not** yet passed. |

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

## Live tenant transport probe

Version 0.2.3 includes an explicit opt-in probe for closing the remaining transport evidence gap without calling a model or DSH agent. It waits for one random challenge from one configured staff account, immediately ACKs the Stream callback, sends a bounded `sessionWebhook` reply, and creates a new `0600` JSON report that contains no credentials, raw staff id, conversation id, message id, webhook, or message body.

Clone the repository and install its locked dependencies without lifecycle scripts:

```sh
git clone https://github.com/fieldnote-ops/relayloom.git
cd relayloom
npm ci --ignore-scripts --registry=https://registry.npmjs.org
```

Set `DINGTALK_CLIENT_ID`, `DINGTALK_CLIENT_SECRET`, and `RELAYLOOM_ALLOWED_USER` in the process environment without placing the secret in a committed file or shell-history command, then run:

```sh
npm run tenant:smoke
```

Send the exact random challenge printed by the process to the internal robot. The default wait is 180 seconds. Use `RELAYLOOM_PROBE_REPORT` for a new workspace-relative report path; an existing report is never overwritten. This command makes real DingTalk network calls and is never run by installation, DSH boot, tests, or CI.

## Install from GitHub

For a copy-pasteable install, pin the last publicly verified runtime commit rather than relying on a moving branch:

```sh
dsh plugin --profile web add github:fieldnote-ops/relayloom#e789dded22a6eeb00bddde0d06e47d15e23eced6
```

That commit passed the public Node 24 unit job and DSH rc.6/latest/next consumer matrix. The installed bundle remains disabled. Edit its profile row only after creating a DingTalk internal robot and setting credentials in the launching environment:

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

Local tests cover protocol normalization, ACK ordering, deduplication, serialization, DSH session create/resume, committed output, cancellation, approval actor binding, webhook SSRF defenses, and default-off lifecycle. HarnessProof v0.1.6 installed the exact locked dependency graph in an isolated copy, added the plugin through the official DSH command, observed the bundle layer, booted DSH `0.1.0-rc.6`, and received HTTP 200 without credentials or external service calls. The live tenant probe is a separate, explicit network action and its result must not be inferred from HarnessProof.

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
