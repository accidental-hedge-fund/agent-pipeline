## 1. Fixture contract and types

- [x] 1.1 Extend multi-change fixture types in `core/scripts/evals/types.ts` (kind marker, ordered checkpoints, per-checkpoint task input, held-out verifiers, optional role metadata for shortcut-debt / portability override / external canary).
- [x] 1.2 Extend `fixture.ts` validation: accept multi-change form; reject empty checkpoints, duplicate `checkpoint_id`, missing held-out verifiers, and treatment-visible leakage of held-out verifier content; keep single-task fixtures valid.
- [x] 1.3 Bump or document `schema_version` support as needed; add unit tests in `evals-fixture.test.ts` (or co-located) proving acceptance and each rejection path without network/git.

## 2. Multi-change runner lineage

- [x] 2.1 Implement multi-change cell execution: one isolated worktree per cell at `base_commit`, ordered checkpoints against persistent repo state (no reset between checkpoints of the same cell).
- [x] 2.2 Enforce fresh model/session context per checkpoint; preserve only the declared pipeline evidence contract (no chat transcripts, no held-out verifier bodies).
- [x] 2.3 Record per-checkpoint evidence trail (prompt identity/hash, treatment/config, model identity, post-step revision/fingerprint, verifier result refs, resource use).
- [x] 2.4 Continue the lineage after quality non-strict failures; abort/classify infra, auth, and timeout via existing result classes.
- [x] 2.5 Support bare / just-solve and pipeline-current treatments under one multi-change experiment; keep #575 and other variants optional and non-blocking for the baseline.
- [x] 2.6 Unit-test lineage sequencing, isolation between cells, fresh-context guarantees, evidence-contract bounds, and continue-after-fail with fake harness adapters (no live model).

## 3. Graders and defect accounting

- [x] 3.1 Implement multi-change grading: at checkpoint k run new + inherited (1..k-1) held-out verifiers deterministically.
- [x] 3.2 Emit strict-pass boolean and defect-state fields (current-step, inherited, accumulated unresolved, recovered) per checkpoint; terminal all-green on full closure after the final checkpoint.
- [x] 3.3 Ensure intermediate strict-fail does not drop later checkpoint grades when steps executed.
- [x] 3.4 Unit-test inheritance set construction, strict-pass truth table, recovery transitions, and terminal all-green; leave single-task grading path unchanged.

## 4. Comparative reporting

- [x] 4.1 Extend reporting for multi-change: per-checkpoint and cumulative correctness with defect-state breakdowns; pair treatments within fixture × checkpoint index.
- [x] 4.2 Report effort (time, tokens, cost with unknown-not-zero), retries, interventions, code growth, change amplification / touch-point churn, and structural telemetry as separate dimensions.
- [x] 4.3 Forbid emission of a single synthetic maintainability or slop score as ground truth; add a regression test that the summary shape lacks such a field.
- [x] 4.4 Support bare-as-baseline deltas, optional variants as not-run when absent, and portability-probe weaker-model labeled metrics (correctness, time, cost, intervention).
- [x] 4.5 Unit-test pairing alignment, baseline naming, cost-unknown coverage, and portability labeling with fixture fakes.

## 5. Corpus and experiment manifests

- [x] 5.1 Author at least one repo-native multi-change fixture with architectural ambiguity and a cross-cutting constraint; deterministic held-out verifiers per checkpoint.
- [x] 5.2 Author at least one shortcut-debt sequence where an early test-passing shortcut increases later inherited failure risk or change amplification under later verifiers.
- [x] 5.3 Author at least one stronger-to-weaker (or stronger-to-cheaper) portability-probe checkpoint and wire model override application at that step only.
- [x] 5.4 Package at least one curated external canary (pinned in-repo) using incremental disclosure + inherited verifiers.
- [x] 5.5 Add a sample multi-change experiment manifest comparing bare vs pipeline-current on the corpus (optional variants documented, not required).
- [x] 5.6 Extend preflight as needed so multi-change fixtures get base_commit reachability and held-out verifier structural checks without model spend.

## 6. Integration, mirror, and CI

- [x] 6.1 Wire multi-change detection into fixture load / run / grade / report entry points; document operator usage briefly where eval docs or command help already live.
- [x] 6.2 After any `core/` change, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [x] 6.3 Run `npm run ci` from repo root and fix failures until green.
- [x] 6.4 Confirm acceptance criteria in `proposal.md` are met by implemented behavior and tests (checklist review before ready-to-deploy).
