# Pre-merge OpenSpec archive: fail closed instead of silently skipping (#467)

## Why

Run `464-2026-07-21T09-43-10-064Z` advanced `pre-merge → ready-to-deploy` in 27s with **no
`chore: archive OpenSpec change(s) for #464` commit** on the branch
(`git log origin/main..origin/pipeline/464-…` shows only the spec/impl/fix commits). PR #465
merged with `openspec/changes/finding-level-reversal-matching/` still active, and the #365
hygiene gate (`ci-openspec`) then failed on `main`: *unexpected active OpenSpec change(s)*.
Cleanup needed an out-of-band ops PR (#466).

Two independent defects are in play, and the first is broader than the issue title suggests:

1. **The archive step no-ops silently.** `maybeArchiveOpenspec` returns `null` (meaning
   "nothing to do, continue") for *four* different reasons — worktree not found on disk,
   OpenSpec not active, the `git diff origin/<base>...HEAD` candidate probe failing
   (`ignoreFailure: true` → empty stdout → zero candidates), and a genuine no-candidate case.
   Only the last is really "nothing to do"; the others are *unknown state* being treated as
   success, and nothing downstream re-checks. Evidence that this is not override-specific:
   the pre-override run (`464-2026-07-21T08-33-51-349Z`, line 27273 `pre-merge gate`) reached
   the delta review, which sits *after* the archive step — so archive already silently no-opped
   on the normal path too, while a real candidate existed in the branch diff. The
   override-resumed run was simply the first one to get past the delta review and out of
   pre-merge. **Conflict with the issue text, surfaced rather than averaged:** #467 states the
   override-resumed path "skips the archive step"; the run artifacts show *both* runs skipped
   it. The fix must therefore be a fail-closed archive step plus a head-side guard, not an
   override-path special case.
2. **Nothing verifies the outcome.** No stage asserts, before `ready-to-deploy`, that the PR
   head actually carries zero active `openspec/changes/<id>/` directories. The only detector
   is the #365 hygiene check on the default branch — i.e. *after* the human merges, at the
   release barrier.

Separately, archiving #464 by hand surfaced a papercut: its delta retitled requirements with
`## MODIFIED Requirements` headers whose text does not exist in the living spec, so
`openspec archive` fails with "header not found". That failure path already blocks
(`setBlocked(… "openspec archive <id> failed:")`) — but only if the archive step *runs*, which
is exactly what defect 1 prevents. This change keeps that behavior and requires the CLI output
to be surfaced verbatim so the operator sees the header mismatch.

## What changes

- **Fail-closed candidate detection.** The archive step derives its candidate set from the
  head-side PR file list (the existing `getPrDiff`/`diffFilePaths` seam already used by the
  pre-merge delta review) rather than depending solely on a local worktree `git diff` that can
  fail silently. A candidate probe that errors, or a missing worktree while OpenSpec is active
  and the PR touches `openspec/changes/`, blocks with `openspec-invalid` instead of returning
  `null`.
- **Head-side active-change guard before advancing.** Pre-merge SHALL NOT advance out of the
  stage while the PR introduces an `openspec/changes/<id>/` path (id ≠ `archive`) that is not
  matched by a corresponding `openspec/changes/archive/<id>/` path in the same file list. This
  is a pure computation over the PR file list — worktree-independent, so it holds on the
  override-resumed path, on a fresh process, and after a worktree removal/recreation.
- **Explicit skip accounting.** Every archive decision (`archived`, `skipped: no-candidates`,
  `blocked: <reason>`) is logged and recorded as a run event, so a silent no-op is visible in
  `events.jsonl` instead of being invisible.
- **Archive failure stays blocking, with the CLI output surfaced** — including the
  "header not found" case produced by retitled `## MODIFIED Requirements` deltas.

## Scope

In scope: `core/scripts/stages/pre_merge.ts` (`maybeArchiveOpenspec` + the pre-merge advance
path), its deps seams, run-event accounting, and tests. Spec deltas on `openspec-integration`.

Out of scope: auto-generating `## RENAMED Requirements` blocks for retitled requirements
(file a papercut if it recurs); changing the #365 default-branch hygiene gate; any change to
the human-owned merge step.

## Acceptance criteria

- [ ] A unit test drives the override-resumed pre-merge path (blocked delta review → override
      recorded → `runAdvance` re-enters pre-merge) and proves the archive step is invoked, via
      a `deps.openspecArchive` fake that records its calls.
- [ ] A unit test proves that when `openspecArchive` fails (e.g. stdout containing
      `header not found`), pre-merge returns `{ advanced: false, status: "blocked" }`, the
      blocker reason contains the archive CLI output verbatim, and `ready-to-deploy` is not
      reached.
- [ ] A unit test proves that when the local candidate probe (`git diff …`) exits non-zero,
      `maybeArchiveOpenspec` blocks with `openspec-invalid` instead of returning `null`.
- [ ] A unit test proves that when the worktree is missing while OpenSpec is active and the PR
      file list contains `openspec/changes/<id>/…`, the step blocks instead of returning `null`.
- [ ] A unit test proves the head-side guard: given a PR file list containing
      `openspec/changes/foo/proposal.md` and no `openspec/changes/archive/foo/…` entry,
      pre-merge does not advance and blocks naming `foo`.
- [ ] A unit test proves the guard is inert when the file list contains
      `openspec/changes/archive/foo/proposal.md` (change archived) or no `openspec/changes/`
      paths at all — pre-merge advances unchanged.
- [ ] Replaying the #464 shape (candidate exists, archive step reached, no archive commit
      produced) fails on `main` and passes with this change — i.e. the regression tests bite.
- [ ] `events.jsonl` for a pre-merge run records the archive decision (`archived` /
      `skipped` with a reason / `blocked` with a reason).
- [ ] `npm run ci` passes from the repo root (core tests, mirror check via
      `node scripts/build.mjs --check`, install smoke, `openspec validate --all`).
