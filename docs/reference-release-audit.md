# Agentic Inbox reference release audit

**Status:** Local release candidate verified; authorized for one local teaching commit, not authorized for push or deployment

**Teaching baseline:** `3ed0b762176b8e714c930f7f64273627a6492c45`

**Reference target:** `inbox.vibe-meta.ai`

**Audit date:** 2026-07-14

This audit records local Teaching Source and deterministic product evidence. On 2026-07-14 the user authorized exactly one local teaching commit from the scope below. That authorization is not a CI result, push authorization, Cloudflare deployment authorization or Runtime Evidence.

## Release decision

The current worktree is ready to be frozen into the one authorized local teaching commit. It is not deployable because no push or remote Cloudflare mutation is authorized, no CI run exists for the resulting SHA and no Runtime Evidence has been captured.

## Product invariant evidence

| Product invariant | Local evidence | Result |
| --- | --- | --- |
| One external inbound identity owns one operation | MailboxDO claim/replay/conflict tests plus real Email Worker replay | Pass |
| Exact replay adds no message, attachment object, intake attempt or Agent trigger | Workers emulation runs ten completed replays; MailboxDO also rejects an overlapping replay under an active attachment-storage lease | Pass |
| Changed payload under the same identity is blocked visibly | Email Worker input reaches persisted conflict metadata, Operation API and status component | Pass |
| Cross-store attachment failure is reconcilable | Manifest is committed before R2 writes; acknowledged-write failure retains keys and recovers by deterministic overwrite | Pass |
| Failure before the first R2 write is visible | Injected thread-lookup failure records `intake_failed` from `received`, preserves the reason and remains retryable | Pass |
| Accepted Agent work survives the Email Worker request | MailboxDO persists the trigger, schedules a Durable Object alarm and exposes queued `drafting` before the alarm completes | Pass |
| Automatic Agent capability stops at a bounded Draft | Registered automatic tools are limited to four context reads and operation-aware `draft_reply`; no organize, new-Draft or send tool is exposed | Pass |
| One operation has at most one current Draft | Stable Draft identity, guarded state transitions and repeated Agent output converge on one row | Pass |
| Human edit and rejection preserve operation truth | Editing retains the current Draft identity; discard atomically moves the proposal to Trash and transitions the operation to `rejected` | Pass |
| Durable work cannot lose its source request | API and shared tool deletion return a conflict while an inbound operation retains the message and attachment manifest | Pass |
| Agent trigger failure has a reason and next action | Non-2xx trigger response becomes `draft_failed`; the product exposes one guarded Retry Draft command | Pass |
| Repeated retry does not start competing Agent attempts | The first retry moves `draft_failed` to `drafting`; a competing retry returns `409` | Pass |
| Deployed evidence scenarios have bounded deterministic controls | Admin-only normal/failure reset and exact/conflict replay actions use one fixed synthetic fixture and explicitly label their proof limits | Pass |
| Teaching scenario controls have a separate authority boundary | Status, reset and replay controls require a constant-time Bearer-token check and exactly one `lab@<configured-domain>` mailbox | Pass |
| The first slice stops at human authority | The automatic path ends at `awaiting_human_review`; no registered Email Agent tool can send | Pass |
| Review cannot be mistaken for delivery | Reply delivery returns `409` while an operation-owned Draft is awaiting review, including after the operator edits it | Pass |

## Findings resolved during release audit

1. The teaching Admin path previously selected the first `lab@` address from a broader allowlist. It now refuses mutation unless the normalized allowlist contains exactly one teaching mailbox on a configured domain.
2. The local secret example briefly displaced the two Cloudflare Access variables. The template now includes `POLICY_AUD`, `TEAM_DOMAIN` and `TEACHING_ADMIN_TOKEN` without values suitable for deployment.
3. Pre-manifest failures could leave an operation at `received` without a durable reason. All post-claim intake work is now inside the failure-recording region, and `received` can transition to `intake_failed`.
4. The automatic Agent received interactive organize and new-Draft tools. Automatic execution now receives only context reads and one operation-aware reply-Draft capability.
5. A resolved non-2xx Agent fetch could leave work waiting forever at `intake_committed`. Trigger failure now becomes `draft_failed`, preserving an operator-visible reason.
6. The state model named an operator Draft retry but the product had no action. The Operation API and email status band now expose a guarded retry, and repeated clicks cannot create competing attempts.
7. The Runtime Evidence checklist named replay, conflict and failure observations without a safe deployed trigger protocol. Admin-only exact/conflict replays and normal/injected-failure reset modes now make those product paths repeatable while explicitly limiting what each observation can prove.
8. Agent dispatch was still a best-effort `waitUntil` side effect, so accepted work could remain at `intake_committed` with no recovery action. MailboxDO now persists the trigger before acceptance and uses a Durable Object alarm to resume it after the Email Worker request ends.
9. Human edit and discard could replace or delete the operation-owned Draft while leaving `currentDraftId` stale. Draft edits now retain the same identity, and discard atomically records `rejected` while retaining the proposal in Trash.
10. Generic email deletion could remove the source message and R2 bytes while leaving a committed operation that exact replay would not reconstruct. MailboxDO now blocks source deletion for every retained inbound operation, and API/MCP surfaces project the conflict instead of claiming deletion.
11. The ordinary composer could send an edited operation-owned Draft and then record its deletion as rejection. The reply boundary now returns `409` while that Draft is awaiting review, so editing cannot cross the first-slice delivery boundary.
12. A replay arriving during `storing_attachments` could increment the intake attempt and repeat R2 writes. An active MailboxDO intake lease now makes the overlap a replay; a stale lease remains recoverable after the bounded timeout.

## Local verification

- `npm test`: 3 files, 16 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed serially.
- `npm run reference:dry-run`: passed without remote mutation.
- Reference bundle: 5254.99 KiB upload, 1090.59 KiB gzip.
- Resolved bindings: MailboxDO, EmailAgent, EmailMCP, Email Service, R2, Workers AI, `DOMAINS=vibe-meta.ai` and only `lab@vibe-meta.ai`.
- Browser projection: `draft_failed` and Retry Draft verified at `1440x900`, `390x844` and `320x568` with zero horizontal overflow, zero console errors and zero console warnings.
- Retry interaction: click projected `Drafting response` and a success notification before the next mocked poll.
- `git diff --check`: passed in both repositories after the final audit and milestone updates.

Browser checks used intercepted synthetic API responses. They prove UI behavior against the local build, not a deployed Worker or Runtime Evidence.

## Remaining release blockers

- Create the one authorized local teaching commit from exactly the documented scope.
- Run the repository CI for that exact pushed commit; local checks are not CI.
- Record the resulting full SHA in the course milestone and require an operator to verify it against `git rev-parse HEAD` before any separately authorized deployment.
- Obtain explicit authorization before creating resources, writing secrets, configuring Access, adding the custom domain, changing Email Routing or deploying.
- Capture synthetic Runtime Evidence only after the exact authorized deployment exists.
- Keep outbound delivery convergence and MCP action-level authority outside the first release claim.

## Proposed teaching commit scope

This is the exact current local release-candidate boundary. It is authorized for exactly one local teaching commit and is not authorized for push or deployment:

```text
.dev.vars.example
.github/workflows/verify.yml
.gitignore
README.md
app/components/EmailPanel.tsx
app/components/email-panel/InboundOperationStatus.tsx
app/queries/keys.ts
app/queries/operations.ts
app/services/api.ts
app/types/index.ts
docs/reference-deployment.md
docs/reference-release-audit.md
docs/reference-runtime-evidence-plan.md
package-lock.json
package.json
test/agent-draft.workers.test.ts
test/inbound-operation.workers.test.ts
test/receive-email.workers.test.ts
test/worker.ts
tsconfig.json
tsconfig.node.json
tsconfig.test.json
vite.config.ts
vitest.config.ts
workers/agent/index.ts
workers/db/schema.ts
workers/durableObject/index.ts
workers/durableObject/migrations.ts
workers/index.ts
workers/lib/inbound-identity.ts
workers/lib/teaching-auth.ts
workers/lib/tools.ts
workers/types.ts
wrangler.reference.jsonc
wrangler.test.jsonc
```

Before an authorized commit, compare this list with `git status --porcelain=v1`. Any addition, removal or rename requires another scope review.

## Scope boundary

Before the authorized local freeze, no commit, push, pull request, deployment, Cloudflare resource mutation, secret write, Email Routing change, real email delivery, customer-data use or Runtime Evidence capture occurred. The authorization permits only the one local teaching commit described above.
