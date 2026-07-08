# Design — Auto-tag releases when a release PR merges

## Context

`pipeline release` opens a `release/vX.Y.Z` PR (title `release: X.Y.Z — <theme>`)
that bumps both `package.json` versions and stamps `ROADMAP.md`. A human merges it.
Today the human must then push an annotated `vX.Y.Z` tag, which is what actually
triggers `release.yml` to publish the GitHub Release. That trailing step is the
failure point (#411): forgotten, delayed, or pushed as a lightweight tag.

This change inserts an automated step between "PR merged" and "tag exists" — a new
workflow that watches default-branch pushes and tags release merges — without
touching `release.yml`.

## Goals / Non-goals

- **Goal:** merging the release PR is the last human action; the annotated tag is
  created automatically and correctly (never lightweight).
- **Goal:** zero changes to `release.yml`'s publish logic and its guards (#289).
- **Non-goal:** auto-merging release PRs. The human merge stays.
- **Non-goal:** a second publish path. Publishing stays entirely in `release.yml`,
  reached only via a `v*` tag push.

## Decision 1 — Two workflows, chained by the tag push

`release.yml` triggers on `push: tags: v*` and is deliberately left unchanged. The
new `auto-tag-release.yml` triggers on `push: branches: [<default>]`, detects the
release merge, and pushes the annotated tag. That tag push is what fans out to
`release.yml`. Keeping them separate means the publish path has exactly one entry
(a `v*` tag) whether the tag is pushed by a human (fallback) or the automation.

**Rejected:** folding tagging into `release.yml` (it triggers on tags, not branch
pushes, so it can't observe the merge) and folding publishing into the new workflow
(would create a second publish path and duplicate #289's guards).

## Decision 2 — Detection requires two independent signals

A commit is a release merge only if **both** hold:

1. The commit **subject** matches the `pipeline release` format. Squash-merging the
   `release/vX.Y.Z` PR produces subject `release: X.Y.Z — <theme> (#N)`; the raw
   commit produced by `pipeline release` is `release: X.Y.Z — <theme>`. The pattern
   anchors on the `release: ` prefix and a semver, tolerant of the trailing ` (#N)`.
2. `core/package.json` **at that commit** has `version` exactly equal to the `X.Y.Z`
   captured from the subject.

The version cross-check is what makes non-release traffic safe: a feature commit that
happens to start with `release:` won't have a matching version bump, and a genuine
release always does (the PR bumped it). Both signals must agree or the workflow exits
a clean no-op.

The em dash (`—`, U+2014) in the subject is the real separator `pipeline release`
emits (see `buildPRBody` / `prTitle` in `release.ts`). The detection pattern matches
that exact character, not a hyphen.

## Decision 3 — Tag message (release notes) source

`release.yml` extracts the Release body from the annotated tag message and rejects an
empty/whitespace-only annotation. So the auto-created tag must carry real notes.

Primary source: the **merge-commit body** (`git log -1 --format=%b <sha>`), which for
a squash-merge of a `pipeline release` PR contains the PR body (version, included PRs,
fallback tag command). If the body is empty/whitespace, fall back to fetching the
release PR body via `gh pr view` (resolve the PR from the merge subject's `(#N)` or by
`gh pr list --search <sha>`). If neither yields non-empty notes, the workflow fails
loudly (a release with no notes is a defect, not a silent skip) rather than pushing a
tag that `release.yml` will only reject.

## Decision 4 — The pushed tag MUST be able to trigger `release.yml`

GitHub does **not** re-trigger workflows for events created with the default
`GITHUB_TOKEN`. If `auto-tag-release.yml` pushes the tag using `GITHUB_TOKEN`, the
`push: tags` event will be created but **`release.yml` will not run** — reproducing
exactly the "PR merged, no Release" symptom this change fixes.

Therefore the tag push must use a credential whose events trigger workflows:

- A **dedicated token secret** (fine-grained PAT or GitHub App installation token with
  `contents: write`), or
- An **SSH deploy key** with write access (deploy-key pushes do trigger workflows).

The workflow reads this credential from a repo secret. This is a required
provisioning step, documented in `tasks.md`; the spec makes the *outcome*
("`release.yml` runs off the pushed tag") a requirement, and the drift-guard/design
records that `GITHUB_TOKEN` alone is insufficient.

**No infinite loop:** the new workflow triggers only on branch pushes, and the tag it
pushes is a *tag* push — it can only fan out to `release.yml`, never back to itself.

## Decision 5 — Idempotency

Before creating the tag, check whether `vX.Y.Z` already exists on the remote
(`git ls-remote --tags origin refs/tags/vX.Y.Z`). If it exists, exit 0 without
creating, pushing, or force-updating anything. This covers the race where a human
pushed the tag manually (fallback path) before/while the automation ran. The workflow
never force-pushes or deletes a tag — retagging a published release is out of bounds.

## Decision 6 — Drift-guard for the detection pattern

The detection pattern lives in the workflow YAML but must stay in lock-step with the
title `release.ts` actually emits. A test in `core/test/` asserts that:

- the pattern (read from the workflow file, single source) matches a subject built the
  same way `release.ts` builds `prTitle` (`release: X.Y.Z — <theme>`) and its
  squash-merged form (`release: X.Y.Z — <theme> (#N)`), and
- it does **not** match a plausible non-release subject (e.g.
  `feat: release notes tooling (#N)`).

This is the same drift-guard discipline used for the review schema and prompt
constants — a code change to the title format that isn't reflected in the workflow
fails the test.

## Risks

- **Credential provisioning (Decision 4)** is the highest-risk item: get it wrong and
  the symptom is identical to today's failure. Mitigated by making it an explicit task
  and a spec requirement on the observable outcome.
- **Squash-commit body variability:** GitHub's squash-merge body is configurable per
  repo. The PR-body fallback (Decision 3) covers the case where the merge body is thin.
