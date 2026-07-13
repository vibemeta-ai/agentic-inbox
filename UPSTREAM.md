# Upstream provenance

This repository is the public Vibe Meta educational fork of [`cloudflare/agentic-inbox`](https://github.com/cloudflare/agentic-inbox).

It exists to support source-driven courses, deterministic labs, reviewed teaching implementations, and a reference deployment. It is independently maintained and is not an official Cloudflare product or endorsement.

## Fixed course source snapshot

The first course source snapshot is the immutable official commit:

```text
cloudflare/agentic-inbox@48039bb6785af34e592c2966f87cde2b255c4c80
```

The fork's initial `main` branch pointed exactly to that commit. Vibe Meta changes begin after this fixed point. Course material must continue to identify whether a claim comes from the official snapshot, this teaching fork, a captured runtime, or an unimplemented production design.

## Remotes

A maintainer checkout uses these roles:

```text
origin    https://github.com/vibemeta-ai/agentic-inbox.git
upstream  https://github.com/cloudflare/agentic-inbox.git
```

`origin` is the only push target. `upstream` is fetch-only and must never receive Vibe Meta branches or tags.

## Synchronization policy

Upstream changes do not enter `main` automatically.

1. Fetch the official repository without modifying either remote.
2. Create a dated `sync/upstream-YYYY-MM-DD` branch from the current teaching fork.
3. Review the official commit range and its effect on course claims, source coordinates, labs, and deployment configuration.
4. Run the upstream and Vibe Meta focused checks.
5. Merge through a pull request only after provenance and course evidence have been updated.

Published course snapshots remain pinned. A newer upstream commit creates a new snapshot; it does not silently rewrite an older one.

## Deployment boundary

`inbox.vibe-meta.ai` is the intended reference deployment for this fork. A repository commit, pull request, or merge does not by itself prove that commit is deployed. Runtime evidence must name the exact deployed commit and satisfy the capture requirements in [docs/course-boundary.md](docs/course-boundary.md).
