## Why

`main` still exposes 12 top-level OpenSpec change directories as **active** work:
`config-sync-command`, `fix-round-spec-delta-consistency`, `gh-wrapper-review-followup`,
`implementing-model-slot`, `intake-sub-command`, `pipeline-throughput-remediation`,
`planning-crash-recovery`, `queue-and-budget-mode`, `review-prompt-craft-gaps`,
`roadmap-perf-observability`, `roadmap-release-model-config`, `sweep-sub-command`.

Every one of them predates or corresponds to already-merged work (PRs #113, #130, #165,
#205, #207, #219, #274, #293, #310, #329, #330). The known archive bug (#308 — a missing
OpenSpec CLI during pre-merge silently skipped archiving) was fixed by #338 on 2026-06-29,
and every pipeline PR merged since (#351, #354, #357, #361, #363) carries its OpenSpec
archive commit. So this is **legacy drift plus a missing guard**, not a live archive bug.

The drift is not cosmetic: `openspec` context (and therefore every planning/implementation
prompt the pipeline builds) reports these as current implementation intent, so agents can
treat shipped or abandoned proposals as work still to do. And nothing catches recurrence —
`npm run ci:openspec` runs `openspec validate --all`, which happily validates stale entries
as perfectly well-formed *active* changes.

## What Changes

Two halves: a one-time cleanup, and a recurrence guard.

**1. Cleanup (one-time, this change's implementation).** Adjudicate each of the 12 legacy
changes into exactly one disposition and archive it under `openspec/changes/archive/`:

- *Shipped, requirements already in living specs* → `openspec archive <id> --skip-specs`
  (re-merging the delta would duplicate or fight requirements already in `openspec/specs/`).
- *Shipped, requirements NOT yet reflected in living specs* → `openspec archive <id> --yes`
  so the shipped behavior lands in the durable specs before the change leaves `changes/`.
- *Never shipped / superseded* → archive with a `SUPERSEDED.md` note naming the reason, and
  file a follow-up issue capturing any intent worth keeping. Nothing is deleted; the
  proposal, design, tasks, and deltas stay readable under `archive/` and in git history.

Disposition is decided per change by comparing its `specs/<capability>/spec.md` deltas
against `openspec/specs/`, not assumed — several deltas name capabilities
(`gh-write-helpers`, `batch-queue-engine`, `queue-batch-safety`, `roadmap-run-stats`,
`roadmap-release-model`, `openspec-fix-round-spec-revision`,
`review-prompt-confidence-calibration`, `review-prompt-few-shot-anchoring`) that have no
living spec directory today.

**2. Recurrence guard.** Extend the existing `npm run ci:openspec` step
(`scripts/ci-openspec.mjs`) with a **default-branch active-change guard**: when CI is
evaluating the repo's default branch, any directory under `openspec/changes/` other than
`archive/` is an error. The guard prints each offending change id and the expected cleanup
path (pre-merge archiving, or `openspec archive <id>`), and exits non-zero. On pull-request
branches the guard is inert — a PR legitimately carries its own in-flight change, and firing
there would break every pipeline run.

A checked-in escape hatch, `openspec/active-allowlist.txt` (one change id per line, `#`
comments), lets a genuinely long-lived change live on the default branch with an auditable,
reviewed justification. Missing or empty file = strict zero-active.

## Capabilities

### New Capabilities
- `openspec-active-change-hygiene`: the default branch SHALL carry no active OpenSpec change
  directories outside an explicit allowlist, enforced by the `ci:openspec` gate.

### Modified Capabilities
- (none — the pre-merge archive flow and `openspec validate --all` behavior are unchanged.)

## Impact

- `scripts/ci-openspec.mjs` — add the default-branch active-change guard after validation.
- `scripts/ci-openspec.test.mjs` — unit tests for the guard (fixture repos, no network/git).
- `openspec/active-allowlist.txt` — new, empty-with-comments escape hatch.
- `openspec/changes/*` → `openspec/changes/archive/*` — the 12 legacy changes move.
- `openspec/specs/*` — may gain requirements from any legacy change archived *with* spec merge.
- No engine (`core/`) changes, so no `plugin/` mirror regeneration, no config schema change,
  no state-machine/label change, and no change to merge policy.

## Acceptance Criteria

- [ ] `openspec list` on the default branch reports **zero** active changes (only `archive/`
      remains under `openspec/changes/`), and none of the 12 named legacy ids is active.
- [ ] Each of the 12 legacy changes exists under `openspec/changes/archive/<id>/` with its
      `proposal.md` (and `design.md`/`tasks.md`/spec deltas where they existed) intact.
- [ ] For every legacy change whose delta requirements describe shipped behavior, those
      requirements are present in `openspec/specs/<capability>/spec.md` after cleanup — either
      already there (archived `--skip-specs`) or merged during archiving.
- [ ] Every legacy change archived as never-shipped/superseded carries a `SUPERSEDED.md`
      naming the reason and, where intent survives, the follow-up issue number.
- [ ] `npm run ci:openspec` fails, exits non-zero, and lists the offending change ids plus the
      cleanup path when run in default-branch mode against a fixture repo containing an
      unallowlisted active change.
- [ ] `npm run ci:openspec` passes when the same active change id is listed in
      `openspec/active-allowlist.txt`.
- [ ] `npm run ci:openspec` passes in pull-request mode with an active change present (guard
      inert off the default branch) — proving the pipeline's own PR flow is not broken.
- [ ] `openspec validate --all` still runs and still fails on a structurally invalid change
      (guard is additive; existing validation coverage is not weakened).
- [ ] Guard unit tests run with no real network, git, or `gh` calls.
- [ ] `npm run ci` passes from the repo root after the cleanup.
