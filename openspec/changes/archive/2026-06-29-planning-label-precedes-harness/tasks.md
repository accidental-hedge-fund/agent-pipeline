## 1. Confirm the runtime behavior is present (no code change expected)

- [ ] 1.1 Verify in `core/scripts/stages/planning.ts` that `runPlanningPhases` transitions
  `ready → planning` before `hooks.authorArtifact(...)` is called (shipped in `61f1a5f`).
- [ ] 1.2 Verify the four planning-stage block paths call `setBlocked(..., "planning", ...)`:
  bootstrap failure, authorArtifact failure, validateArtifact failure (`blockStage: "planning"`),
  and that no planning-stage block still passes `"ready"`.
- [ ] 1.3 If — and only if — 1.1 or 1.2 is NOT satisfied (a regression landed since `61f1a5f`),
  restore the behavior with the minimal diff; otherwise make no production change.

## 2. Complete the regression coverage in `core/test/planning.test.ts`

- [ ] 2.1 Extend the "bootstrap creation failure" blocker-equivalence test to assert
  `f?.stage === "planning"` (and the OpenSpec variant matches).
- [ ] 2.2 Extend the "bootstrap setup failure" blocker-equivalence test to assert
  `f?.stage === "planning"`.
- [ ] 2.3 Add a blocker-equivalence case for OpenSpec validation failure (a hook whose
  `validateArtifact` returns `{ ok: false, blockStage: "planning", ... }`) asserting
  `stage === "planning"`.
- [ ] 2.4 Keep the existing "transitions ready to planning before authoring" ordering test and
  the lifecycle-sequence test (`planning → plan-review → implementing`) green — they cover the
  ordering and downstream-unaffected criteria.

## 3. Prove the tests bite

- [ ] 3.1 Temporarily change one planning-stage `setBlocked(..., "planning", ...)` back to
  `"ready"`, run `npm test` (core), confirm the new assertion(s) from §2 fail, then restore.

## 4. Spec + mirror + CI

- [ ] 4.1 `openspec validate planning-label-precedes-harness --strict` passes.
- [ ] 4.2 `node scripts/build.mjs` — regenerate the `plugin/` mirror (required even for
  test-only `core/` changes so `build.mjs --check` stays green).
- [ ] 4.3 `npm run ci` green end-to-end from the repo root.
