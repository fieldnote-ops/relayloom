# Security policy

RelayLoom is default-off. Enabling it creates a network bridge between one allowlisted DingTalk sender and a configured DeepSeek Harness agent, so operators must treat its configuration as an authority boundary.

## Credentials

- Keep the DingTalk client id and client secret in environment variables; never commit them or put them in the Cordis YAML.
- Use a dedicated internal robot with the minimum tenant permissions required.
- Rotate the client secret immediately if logs, screenshots, reports, or repositories may have exposed it.
- `sessionWebhook` URLs are bearer-like reply capabilities. RelayLoom never logs them and accepts only exact configured HTTPS hosts on port 443.

## Authorization

- The bridge refuses to start enabled with an empty `allowedUsers` list.
- Sessions are isolated by conversation and sender.
- Approval tokens use cryptographic randomness, expire, are single-use, and are bound to both sender and conversation. A mismatched attempt burns the token.
- `/approve` grants only the pending operation once; it does not create a durable allow rule.

## Network behavior

When enabled, the official SDK connects to DingTalk and RelayLoom posts replies only to a validated `sessionWebhook`. Redirects, non-HTTPS URLs, embedded credentials, non-443 ports, non-allowlisted hosts, expired webhooks, oversized responses, and timeouts fail closed.

## Reporting

Do not open a public issue containing credentials, session webhooks, tenant ids, staff ids, message payloads, or private model output. Report security concerns privately through the GitHub repository security advisory interface after publication.

The opt-in tenant smoke probe accepts credentials only from the process environment and creates a new `0600` report without raw tenant identifiers or message content. It refuses to overwrite prior evidence. The printed random challenge is not a credential, but operators should still run the probe in a private terminal and remove credentials from the process environment immediately afterward.

No independent security audit has been completed.
