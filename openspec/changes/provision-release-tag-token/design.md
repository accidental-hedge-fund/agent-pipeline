## Context

`auto-tag-release.yml` already implements the full auto-tag path from #411/#413:

1. Detect a release merge (subject + `core/package.json` version).
2. Resolve annotated-tag notes from the merge body (or PR body fallback).
3. Push `vX.Y.Z` with `secrets.RELEASE_TAG_TOKEN` so the event re-triggers
   workflows.
4. Fail loudly if the secret is empty — never fall back to `GITHUB_TOKEN`.

The workflow and living `release-auto-tag-on-merge` spec are correct. The gap is
**repo credential state**: as of 2026-07-30 the repository has **zero** Actions
secrets (`total_count: 0`), so every release still ends with a human annotated
tag at the merge commit.

PAT minting is intentionally human-only (GitHub has no first-class unattended
mint API for fine-grained PATs that fits this threat model). This change is
therefore an ops procedure with verification outcomes, not a code change.

## Goals / Non-Goals

**Goals:**

- Provision `RELEASE_TAG_TOKEN` on `accidental-hedge-fund/agent-pipeline` with
  the minimum permissions required for annotated tag push.
- Make the next release merge’s auto-tag path succeed without a manual tag push
  and without changing workflow or engine code.
- Record verification steps that prove secret presence and end-to-end fan-out to
  `release.yml`.

**Non-Goals:**

- Changing `.github/workflows/auto-tag-release.yml` or `release.yml`.
- Falling back to `GITHUB_TOKEN` for tag push (would leave `release.yml`
  untriggered by design).
- Fixing release-notes resolution failures that exit before the tag-push step
  (separate issue if it reproduces after the secret exists).
- Automating PAT mint/rotation inside the pipeline engine or doctor.
- Broader org secret management, GitHub App migration, or SSH deploy-key
  alternatives (allowed by the existing workflow design comments, but not chosen
  for this ops ticket).

## Decisions

### Decision 1 — Fine-grained PAT as the credential form

**Choice:** Mint a fine-grained personal access token owned by a trusted
maintainer/bot account under resource owner `accidental-hedge-fund`, restricted
to repository `agent-pipeline`, with **Contents: Read and write** only.

**Why:** Matches the existing workflow contract and PR-footer guidance in
`release.ts` / `#413`. Contents write is the permission needed to push a tag;
read supports any ancillary git operations over the same remote URL. Narrower
repo selection limits blast radius if the secret leaks.

**Alternatives considered:**

| Option | Why not now |
| --- | --- |
| GitHub App installation token | Better long-term rotation story, but requires App install + secret wiring beyond this issue’s “set the secret” scope. |
| SSH deploy key (write) | Also triggers workflows, but deploy-key lifecycle is less familiar for Actions secrets and not what current docs instruct operators to provision. |
| Classic PAT | Broader default scopes; fine-grained is the documented, least-privilege path. |
| Reuse `GITHUB_TOKEN` | **Rejected by design** — tag events from `GITHUB_TOKEN` do not re-trigger `release.yml`. |

### Decision 2 — Repository Actions secret name is fixed: `RELEASE_TAG_TOKEN`

**Choice:** Store the token via:

```bash
gh secret set RELEASE_TAG_TOKEN -R accidental-hedge-fund/agent-pipeline
```

**Why:** The workflow env binding is already
`${{ secrets.RELEASE_TAG_TOKEN }}`. Renaming would require a code change, which
is out of scope. The name is part of the living capability contract.

### Decision 3 — No application code or doctor check in this change

**Choice:** Do not add a `pipeline doctor` secret probe or other engine check in
this issue.

**Why:** The issue explicitly scopes to credential provisioning only. Secret
*values* are never listable via the API after set; name presence can be listed
(`gh secret list` / Actions secrets API) but adding a permanent doctor gate is
product work beyond “make the next release auto-tag.” A future follow-up may
add a doctor advisory if operators keep forgetting this on forks/new installs.

### Decision 4 — Out-of-scope notes-resolution failure stays separate

**Evidence (2026-07-30):** v1.28.3 auto-tag failed on empty notes resolution
before the tag-push step, so the secret was never exercised. v1.28.4 succeeded
as a no-op because a manual tag raced the workflow.

**Choice:** This change still provisions the secret (necessary). It does **not**
claim notes-resolution robustness. If the next release fails with
“No non-empty release notes could be resolved…”, open/track a separate issue —
do not expand this change into notes-source fixes.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| PAT expires or is revoked later → auto-tag fails again | Prefer a non-expiring or long-lived token policy the org accepts; on failure the workflow already emits an explicit empty-secret / auth error. Rotation is an operator runbook, not this ticket. |
| Over-scoped PAT | Enforce single-repo selection + Contents only at mint time; never org-wide admin. |
| Token stored in wrong place (env vs org secret vs Dependabot) | Use **repository** Actions secret named exactly `RELEASE_TAG_TOKEN` so the workflow binding resolves. |
| Notes-resolution failure still blocks auto-tag after secret is set | Acceptance criterion for end-to-end success may need a release that has non-empty notes; document as independent blocker, not a reason to skip provisioning. |
| Manual tag race still possible during verification | Verifiers should **not** hand-tag while testing; wait for the workflow. |

## Migration Plan

1. Admin mints the fine-grained PAT (UI).
2. Admin sets `RELEASE_TAG_TOKEN` with `gh secret set`.
3. Confirm name via `gh secret list`.
4. On the next `pipeline release` merge, observe `auto-tag-release` success and
   a subsequent green `release.yml` for the new `v*` tag.
5. Rollback (if needed): delete the secret and/or revoke the PAT — reverts to
   the current manual-tag fallback; non-release main pushes remain unaffected
   (#413 single point of use).

## Open Questions

- None blocking provisioning. Optional later: migrate from fine-grained PAT to a
  GitHub App for rotation and non-user ownership (follow-up, not required for
  #449 acceptance).
