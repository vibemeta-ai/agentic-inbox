# Agentic Inbox reference deployment manifest

This manifest prepares the executable teaching product at `inbox.vibe-meta.ai`. It does not authorize a deployment. Creating or changing a Cloudflare resource, route, secret, Email Routing rule or deployed Worker requires explicit approval for one exact, clean and verified commit.

## Product boundary

- The only inbound teaching address is `lab@vibe-meta.ai`.
- All requesters, order identifiers, messages and attachments are synthetic.
- The first product slice ends at `awaiting_human_review`; external delivery is outside its completion claim.
- Cloudflare Access must fail closed for the browser, API, Agent and MCP surfaces.
- A successful build, CI run or source inspection is Teaching Source Evidence, not Runtime Evidence.

## Exact release identity

Fill these fields only after the local changes are reviewed and committed:

| Field | Required value |
| --- | --- |
| Teaching commit | Full 40-character SHA; no placeholder is deployable |
| Git state | Clean worktree on the reviewed branch |
| Wrangler config | `wrangler.reference.jsonc` |
| Worker name | `vibe-meta-agentic-inbox-reference` |
| Compatibility date | `2025-11-28` |
| Application route | `inbox.vibe-meta.ai` as a custom domain |
| Inbound address | `lab@vibe-meta.ai` only |
| R2 bucket | `vibe-meta-agentic-inbox-reference` |
| R2 preview bucket | `vibe-meta-agentic-inbox-reference-preview` |

Durable Object storage is isolated by the reference Worker deployment and its three bindings: `MAILBOX`, `EMAIL_AGENT` and `EMAIL_MCP`. Mailbox migrations `1` through `11` include the inbound operation ledger, intake recovery fields and persisted Agent trigger used by the MailboxDO alarm. Workers AI and the Email binding are account services; they do not reuse an application database or object bucket.

## Configuration and secrets

The committed non-secret variables are:

| Name | Value |
| --- | --- |
| `DOMAINS` | `vibe-meta.ai` |
| `EMAIL_ADDRESSES` | `['lab@vibe-meta.ai']` |

The required secret names are:

| Secret | Purpose |
| --- | --- |
| `POLICY_AUD` | Cloudflare Access application audience |
| `TEAM_DOMAIN` | Access team URL or full `/cdn-cgi/access/certs` URL |
| `TEACHING_ADMIN_TOKEN` | Secondary authorization for the bounded teaching scenario control plane |

Secret values must never enter Git, course content, screenshots or Runtime Evidence. The Worker fails closed outside local development when either Access secret is absent, and rejects missing or invalid Access JWTs. All teaching scenario endpoints independently return `403` when `TEACHING_ADMIN_TOKEN` is absent or incorrect.

## Local release gate

Run from a clean teaching worktree:

```bash
git status --short
git rev-parse HEAD
npm ci
npm test
npm run typecheck
npm run build
npm run reference:dry-run
git diff --check
```

`npm run reference:dry-run` builds through the Cloudflare Vite plugin using `wrangler.reference.jsonc`, then asks Wrangler to validate the generated `build/server/wrangler.json` bundle locally. It is not a deployment and must not be reported as Runtime Evidence.

## Authorized remote procedure

The following actions are intentionally not executed by this manifest. After explicit authorization for the exact commit:

1. Confirm the Cloudflare account and reviewed commit.
2. Create the two isolated R2 buckets if they do not already exist.
3. Configure Cloudflare Access for the reference Worker and write `POLICY_AUD`, `TEAM_DOMAIN` and a unique `TEACHING_ADMIN_TOKEN` as Worker secrets.
4. Deploy with `npm run deploy:reference` from the clean verified commit.
5. Create one exact Email Routing rule for `lab@vibe-meta.ai` to the reference Worker. Do not create a catch-all rule.
6. Create the `lab@vibe-meta.ai` mailbox through the Access-protected application.
7. Execute only the approved synthetic scenarios and capture Runtime Evidence against the deployed commit.

Every remote command and dashboard mutation must be recorded with operator, timestamp, target account and exact commit.

## Read-only verification

After deployment, the minimum read-only checks are:

```bash
git rev-parse HEAD
npx wrangler deployments list --config wrangler.reference.jsonc
npx wrangler versions list --config wrangler.reference.jsonc
curl -sS -o /dev/null -w '%{http_code}\n' https://inbox.vibe-meta.ai/
curl -sS https://inbox.vibe-meta.ai/api/v1/teaching/scenarios/vm-1007/status \
  -H "Authorization: Bearer $TEACHING_ADMIN_TOKEN"
```

An anonymous request must not reach mailbox data. Depending on whether Access intercepts at the edge or the Worker validates the request, the observed response may be an Access redirect or a `403`; the exact response must be captured, not assumed.

## Data handling and abuse limits

- Reject messages larger than the Worker bound of 25 MiB. The first lesson fixture remains a tiny plain-text attachment.
- Reject inbound recipients outside `lab@vibe-meta.ai`, and reject creation of any other mailbox.
- Keep the existing per-mailbox outbound rate limit. Do not exercise outbound delivery in the first slice.
- Store no customer data. Redact Access identities, raw headers, tokens and secret values from evidence.
- Do not delete a source request independently of its durable operation. The domain rejects generic source deletion; use the approved scenario reset to remove operation, message metadata and attachment bytes as one bounded procedure.
- Retain synthetic Runtime Evidence only for the course evidence window; delete mailbox metadata and attachment objects when the approved capture is complete.
- Before deletion, enumerate attachment metadata and the deterministic R2 prefix `attachments/<emailId>/` to identify missing or orphaned objects. Reconciliation is an operator-reviewed action until a durable automated policy exists.

## Reset, rollback and incident boundary

The authenticated teaching Admin reset is:

```bash
curl -X POST https://inbox.vibe-meta.ai/api/v1/teaching/scenarios/vm-1007/reset \
  -H "Authorization: Bearer $TEACHING_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"mode":"normal"}'
```

It first plans and deletes both committed attachment keys and keys retained only in an incomplete intake manifest, then atomically clears the mailbox projections and operation ledger, clears teaching Agent history, recreates the single allowlisted mailbox and seeds `VM-1007` through the normal Email Worker intake function. Missing or incorrect Admin authorization returns `403`. The token does not replace Cloudflare Access; both boundaries apply in a deployed environment.

The same endpoint accepts `{"mode":"draft_failed"}`. That mode commits the normal synthetic intake without Agent scheduling, then records `synthetic_teaching_draft_failure` so the deployed failure projection and recovery action can be observed deterministically. It is fault injection at the product-state boundary, not evidence of a natural Workers AI or Agent outage.

After a normal reset, the protected `/replay` and `/conflict` endpoints re-enter the deployed inbound function with the exact fixture or the same Message-ID plus a changed body. They do not schedule Agent work. The exact commands, acceptance checks, evidence strength and stop conditions are defined in `docs/reference-runtime-evidence-plan.md`.

This is a destructive Production mutation and still requires explicit approval for each evidence reset. Export approved evidence before reset and never log or capture the token.

Rollback means deploying a previously verified Worker version or commit, then running read-only checks before accepting new inbound mail. Rollback does not automatically reverse Durable Object schema migrations or delete R2 data. If the Admin status reports `intake_failed`, pause inbound routing and inspect its persisted manifest before an approved retry or reset.

If an Agent trigger or Draft attempt reports `draft_failed`, the Access-authorized operator can retry from the email status band or call:

```bash
curl -X POST \
  https://inbox.vibe-meta.ai/api/v1/mailboxes/lab%40vibe-meta.ai/emails/<synthetic-email-id>/operation/retry-draft
```

The first retry atomically moves the operation to `drafting`, persists the Agent trigger and schedules a MailboxDO alarm. A competing retry returns `409`; it does not start another attempt. The pending trigger survives the API request lifecycle, does not grant send authority and still ends at `awaiting_human_review` or a visible `draft_failed` state.

## Runtime Evidence record

Execute the bounded sequence in `docs/reference-runtime-evidence-plan.md`; do not improvise a failure hook or use external customer mail.

Every approved observation must include:

- full deployed commit and Worker version;
- entry point and RFC 3339 capture time;
- initialized synthetic state and exact input identity;
- expected invariant and observed state transition;
- sanitized logs, API projection or screenshot;
- known gaps, especially the broader MCP authority surface and outbound delivery convergence.
