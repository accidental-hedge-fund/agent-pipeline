## Why

`pipeline intake --release vX.Y.Z` requires a `### vX.Y.Z` detail section in
`ROADMAP.md`, but milestones created through the GitHub API (the common path lately —
v1.23.0 / v1.24.0 / v1.28.0 among others) have no ROADMAP detail structure, so intake
aborts. Two defects compound (observed 2026-07-23 targeting v1.26.0 — the spec printed,
then `ROADMAP anchor not found: detail-section-v1.26.0`):

1. **Wasted model call.** The deterministic ROADMAP anchor check runs *after*
   spec generation (`applyRoadmapMutations` at step 7, the harness call at step 5), so a
   doomed intake still burns the run's only model call before failing. The existing
   regression tests only assert that no *issue* is created — the harness has already run.
2. **Silent discard.** The abort creates nothing — no issue, no partial roadmap entry —
   so the freshly generated spec is thrown away and the user must file the issue and the
   roadmap edits fully by hand.

Related drift: `ROADMAP.md` currently lacks detail sections for every post-v1.23.0 lane.
`pipeline roadmap --apply` / `sweep --apply` are the reconciliation tools, but intake
SHALL NOT hard-depend on that reconciliation having run.

## What Changes

- **Deterministic preconditions run before the spec-generation model call.** Every check
  that does not depend on the generated spec — `--release` validity, base-branch SHA
  resolution, ROADMAP readability, and the presence of the *global* release-plan and
  per-issue table anchors that every intake insertion depends on — is evaluated BEFORE
  the harness is invoked. A doomed intake fails in seconds at zero token cost.
- **A missing target-release detail section no longer discards the generated spec.** When
  the `### vX.Y.Z` detail section for the target release is absent (a milestone that
  exists on GitHub but was never given ROADMAP structure), intake SHALL **scaffold** the
  minimal missing detail-section heading onto its already-human-reviewed PR so the detail
  bullet and the release-plan / per-issue rows all land together. If scaffolding the
  structure is genuinely impossible, intake SHALL **degrade** — create the issue and
  report the roadmap gap explicitly — but SHALL NEVER silently discard the generated spec.
- **Regression coverage** proves (a) a missing precondition fails before any harness call
  (deps-seam assertion on `runHarness` call count), and (b) the scaffold path produces
  the detail section + all three insertions + a created issue for a milestone that exists
  on GitHub but not in `ROADMAP.md`.

## Acceptance Criteria

- [ ] When a deterministic precondition fails (e.g. a global ROADMAP table anchor is
  absent, or `origin/<base>` is unresolvable), `pipeline intake` exits non-zero WITHOUT
  making any spec-generation model harness call — a deps-seam test asserts the
  `runHarness` call count is `0`.
- [ ] The spec-generation harness is invoked at most once, and only after every
  deterministic precondition has passed.
- [ ] When the target release's `### vX.Y.Z` detail section is absent, intake does NOT
  abort-and-discard the generated spec: it scaffolds the minimal missing detail-section
  heading on the intake branch so the detail bullet lands in the same PR, and the GitHub
  issue is still created.
- [ ] In the scaffold path the resulting ROADMAP PR contains a new `### vX.Y.Z` detail
  section, the release-plan table row, the per-issue sem-ver row, and the detail bullet —
  all referencing the same issue number and version.
- [ ] If scaffolding is impossible, intake completes issue creation and prints an explicit
  roadmap-gap report naming the missing structure and the reconciliation command
  (`pipeline roadmap --apply` / `sweep --apply`); it never silently discards the spec.
- [ ] A regression test reproduces the missing-detail-section case for a milestone that
  exists on GitHub but not in `ROADMAP.md` and proves the scaffold-or-degrade behavior;
  it fails against the current abort-and-discard code.
- [ ] The `--dry-run` path reflects the scaffolded structure in its printed diff and still
  performs no writes.
- [ ] The non-OpenSpec pipeline path and all other stages are unaffected; `npm run ci` is
  green (core tests, mirror `--check`, install smoke, openspec validate).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `intake-sub-command`: adds a requirement that all spec-independent preconditions run
  before the spec-generation model call; adds a requirement that a missing target-release
  detail section is scaffolded (or degrades to issue-plus-gap-report) rather than
  discarding the generated spec; and updates the issue-creation ordering requirement to
  reflect precondition-before-generation and scaffold-not-abort.

## Impact

- `core/scripts/stages/intake.ts` — reorder `runIntake` so deterministic prechecks
  (release-slot validity, base SHA, ROADMAP read, global table anchors) precede
  `d.runHarness`; add the scaffold-or-degrade path for a missing target-release detail
  section; extend `IntakeDeps` only as needed to keep the unit-test seam intact.
- `core/scripts/stages/release.ts` — a minimal helper to scaffold a `### vX.Y.Z`
  detail-section heading when absent (reusing existing insertion helpers).
- `core/test/intake.test.ts` — replace the existing "detail section absent → throws" test
  with the scaffold-or-degrade coverage; add the precondition-before-harness deps-seam
  assertion.
- `plugin/` regenerated via `node scripts/build.mjs`.
