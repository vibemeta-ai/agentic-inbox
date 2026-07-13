# Security policy

Agentic Inbox processes email content, attachments, mailbox state, model input, and outbound messages. Treat repository examples, issue reports, test fixtures, and runtime captures accordingly.

## Reporting a vulnerability

Do not publish exploit details, credentials, access tokens, private email addresses, message bodies, attachments, or production logs in a public issue or pull request.

Use GitHub's private vulnerability reporting flow when the repository exposes a **Report a vulnerability** action. If that action is unavailable, open a minimal public issue asking the maintainers to establish a private reporting channel; include no sensitive or exploitable details in that issue.

## Testing authorization

The public source code and local synthetic fixtures are available for review and testing. The current or future `inbox.vibe-meta.ai` reference deployment is not an open security-testing target. Do not scan, probe, send email to, access, or attempt to bypass authentication on a deployed Vibe Meta service without separate explicit authorization.

## Sensitive data

Never commit or attach:

- GitHub, Cloudflare, model-provider, or email-service credentials;
- Cloudflare Access tokens, JWTs, secrets, or private configuration values;
- real mailbox addresses, message bodies, headers, attachments, or contact data;
- production database, R2, Durable Object, browser-cache, or log exports;
- unredacted runtime traces or screenshots.

Tests and course evidence must use synthetic identities such as `alice@example.test`. Revoking or deleting a leaked value from the latest commit is insufficient: rotate the credential and remove it from the complete reachable history.

## Pull requests and deployment credentials

Workflows triggered by untrusted pull requests must not receive deployment credentials. Production deployment, if introduced, must be restricted to a protected branch and a GitHub Environment with least-privilege secrets. A successful pull-request check is not authorization to deploy or mutate Cloudflare resources.

## Supported state

Before the Vibe Meta reference deployment is established, only the latest protected `main` branch is maintained by this fork. The official project remains governed by Cloudflare's repository and policies.
