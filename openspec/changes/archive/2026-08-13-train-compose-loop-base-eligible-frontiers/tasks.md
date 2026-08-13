## 1. Spec alignment

- [x] 1.1 Confirm OpenSpec validates: `openspec validate train-compose-loop-base-eligible-frontiers` (or project default validate).
- [x] 1.2 Confirm living `integrated-train-mode` + this delta cover acceptance criteria from proposal (frontier wave, code-dep barrier, independent merge, serial merge, production wiring).

## 2. Frontier selection and orchestrator shape

- [x] 2.1 Implement base-eligible frontier computation: code prereqs integrated (merge-result contained on fetched base); unknown dep kind fails closed as code dep; finished/held items excluded.
- [x] 2.2 Wire train main loop as two-wave facade: while work remains → frontier → one advance wave → optional merge wave → recompute.
- [x] 2.3 Inject multi-item `advanceWave` (or equivalent) on train deps; train MUST NOT invent a second recoverer or call `repair_pipeline_item`.
- [x] 2.4 Ensure already-integrated / already R2D skip paths remain idempotent (including closed+merged class).

## 3. Production loop wiring

- [x] 3.1 Production `runTrainCommand` supplies multi-item loop/advance-wave for the frontier (one call per frontier, not N×`single`).
- [x] 3.2 Ship / Tugboat train path uses the same multi-item loop wiring class; no production `advanceWaveFromSingle` default.
- [x] 3.3 Keep CLI surface: `--merge`, `--milestone`, `--issues`; Tugboat continues to call `train --merge` (no playbook fork).

## 4. Merge wave and partial failure

- [x] 4.1 Merge wave only when `--merge`: serial existing merge surface + fetch + squash-aware containment between merges.
- [x] 4.2 Code-dependent child is not scheduled until parent merge-result is contained on base.
- [x] 4.3 Proven-independent R2D sibling may merge while a peer is parked/blocked; parked item is not merged; unproven independence fails closed.
- [x] 4.4 Advance never merges; concurrency 1 / `max_concurrent_worktrees: 1` keeps advance serial; merge capacity remains one.

## 5. Tests and CI hygiene

- [x] 5.1 Unit test: one multi-item advance-wave call per frontier (call shape with injected deps).
- [x] 5.2 Unit test: A→B code dep — B not advanced until A merge+containment.
- [x] 5.3 Unit test: independent R2D sibling merges while peer parked; unproven independence does not merge.
- [x] 5.4 Unit test: concurrency 1 remains serial advance; no real network/git/subprocess in unit tests.
- [x] 5.5 Regression: production train/ship wiring is multi-item loop (not N×`single` / production `advanceWaveFromSingle`).
- [x] 5.6 After any `core/` edit: `node scripts/build.mjs` and commit regenerated `plugin/`; `npm run ci` green.
