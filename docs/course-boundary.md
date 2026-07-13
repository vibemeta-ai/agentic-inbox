# Course and evidence boundary

This repository is the public, executable teaching project for Vibe Meta's Agentic Inbox courses. The private `vibemeta/vibe-meta` repository owns the bilingual course website, publication workflow, access control, and final lesson bodies.

Keeping those roles separate prevents executable labs, published prose, upstream facts, and production observations from collapsing into one unqualified source of truth.

## Repository roles

| Role | Repository or deployment | Authority |
| --- | --- | --- |
| Official source | `cloudflare/agentic-inbox` | Behavior directly established by a pinned official commit |
| Teaching implementation | `vibemeta-ai/agentic-inbox` | Reviewed Vibe Meta changes and executable deterministic labs |
| Course publication | `vibemeta/vibe-meta` | Bilingual lesson bodies, source maps, product access, and release state |
| Runtime observation | `inbox.vibe-meta.ai` | A separately captured observation from one identified deployed commit |

## Evidence classes

### Official Source Evidence

Official Source Evidence describes only behavior established by a full commit in `cloudflare/agentic-inbox`. The initial course snapshot is:

```text
48039bb6785af34e592c2966f87cde2b255c4c80
```

Line coordinates, dependency versions, and behavioral claims must be reproducible from that immutable commit. Later teaching-fork changes cannot be used to retroactively strengthen an official-source claim.

### Teaching Implementation

Teaching Implementation describes code and tests that exist in `vibemeta-ai/agentic-inbox` after the official fixed point. Every claim must name a full fork commit. A proposed change does not become Teaching Implementation until it is merged and its relevant checks pass.

The preferred teaching sequence is:

```text
official behavior
→ deterministic failing lab
→ reviewed teaching change
→ passing lab
```

### Runtime Evidence

Runtime Evidence is a separately approved observation from `inbox.vibe-meta.ai`; source inspection, a successful CI run, or a chat message is not Runtime Evidence.

Every runtime record must include:

- the full deployed commit;
- route or event entry point;
- RFC 3339 capture time;
- synthetic scenario and initialized state;
- observed result and relevant client/server projections;
- redactions performed;
- enough detail to distinguish response arrival from state convergence.

Runtime capture must use synthetic mailbox data and must not expose credentials, real addresses, message content, attachments, or unredacted logs.

### Production Design

Production Design is a proposal that is not yet established by the pinned official source, merged teaching implementation, or approved runtime capture. Course material must label it as a design and state what test or observation would promote it to an implemented or observed fact.

## Publication boundary

Final English and Chinese lesson Markdown remains in `vibemeta/vibe-meta`, where it is validated and published. This public repository may contain labs, fixtures, implementation notes, and links, but it must not become a second authoritative copy of paid or release-managed lesson bodies.

## Deployment boundary

No commit, tag, merge, workflow, domain name, or README statement authorizes a Production deployment. Deployment and any Cloudflare data or resource mutation require a separate, explicit approval and must identify the exact verified commit.
