## 1. Precondition ordering

- [ ] 1.1 In `core/scripts/stages/intake.ts` `runIntake`, split the deterministic,
  spec-independent checks out of the current post-harness flow: `--release` semver
  validity, `gitResolveBaseSha`, `readFileAtBase("ROADMAP.md")`, release-slot inference,
  and presence of the **global** ROADMAP table anchors (the release-plan `| *(none)* |`
  sentinel row and the per-issue table header) that every intake insertion depends on.
- [ ] 1.2 Run all of 1.1 BEFORE `d.runHarness` is called, so a failing precondition aborts
  with a non-zero exit and zero model harness calls. Keep the pinned-base-SHA invariant
  (read ROADMAP and fork the branch from the one SHA).

## 2. Scaffold-or-degrade for a missing target-release detail section

- [ ] 2.1 Add a helper (in `core/scripts/stages/release.ts`, next to
  `insertDetailSectionBullet`) that, when the `### vX.Y.Z` detail-section heading is
  absent, inserts a minimal new heading in the "Remaining work — detail (grouped by
  release)" section so the detail bullet can be inserted. Reuse existing helpers; do not
  duplicate anchor logic.
- [ ] 2.2 In `applyRoadmapMutations`, when the target-release detail section is missing,
  scaffold it (2.1) and then insert the bullet — instead of throwing
  `detail-section-vX.Y.Z`. The release-plan row and per-issue row already insert against
  global anchors and need no per-version pre-existing structure.
- [ ] 2.3 Define the degrade fallback: if the structure genuinely cannot be scaffolded,
  complete `createIssue` and print an explicit roadmap-gap report (which structure is
  missing + `pipeline roadmap --apply` / `sweep --apply`). Never discard the spec.
- [ ] 2.4 Ensure `--dry-run` prints the diff including the scaffolded heading and writes
  nothing.

## 3. Tests

- [ ] 3.1 Deps-seam regression: a failing precondition (remove a global table anchor from
  the ROADMAP fixture) asserts `runHarness` was called `0` times AND no issue is created.
  Prove it bites against a build where the check still runs post-harness.
- [ ] 3.2 Replace the current "detail section absent → throws" test
  (`intake.test.ts:450`) with scaffold coverage: a milestone present on GitHub but with
  no `### vX.Y.Z` section — assert the mutated ROADMAP contains the new heading, the
  release-plan row, the per-issue row, and the detail bullet (same issue# + version), and
  an issue is created.
- [ ] 3.3 If the degrade fallback is implemented, cover it: issue created + gap report
  emitted + spec not discarded.
- [ ] 3.4 Unit test the new scaffold helper directly (heading inserted at the right place;
  idempotent when the section already exists).

## 4. Mirror & gate

- [ ] 4.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 4.2 `npm run ci` green (core tests, mirror `--check`, install smoke, openspec
  validate).
