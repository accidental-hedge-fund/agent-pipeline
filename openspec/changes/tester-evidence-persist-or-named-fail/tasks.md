## 1. Biting regressions (inject I/O; prove fail first)

- [x] 1.1 Add a `runTestGate` / `recordEvidence` test: required command exits 0, run dir has blocked trusted-surface (`missing_base_sha` / all-zero decision SHA), HEAD is a real 40-char SHA from `gitHead`. Assert SHA-matched `tester-evidence.json` is written with `overall_status: "passed"`, `candidate_sha` equal to that HEAD (never the all-zero trusted-surface SHA), and **no** fabricated readiness `evidence_subject`. Verify this test **fails** against current skip-write
- [x] 1.2 Add a `loadOrRegenerateTesterEvidenceForReview` test whose regenerate callback returns a typed observation with `recorded_required_exit_0: true` and does not write `tester-evidence.json`. Assert the test **fails** against current code if `withholdInvoke` stays true solely because the generic missing-file string is used. Inject I/O; no live network, git, or subprocess. Do **not** infer exit 0 from `summary.json` or logs
- [x] 1.3 Add a test that writes `trusted-surface.json` with `outcome: blocked`, `repo_policy` `failure_reason: missing_base_sha`, and all-zero `candidate_sha`, then runs a producer that records typed exit 0. Assert the test **fails** against current code if withhold reason is only `No Tester suite evidence file for this run (missing tester-evidence.json)` and no distinct persist/acquire code is set
- [x] 1.4 Add a write-failure test: producer records exit 0, `writeTesterEvidence` returns `{ ok: false, error }`. Assert no manufactured passed artifact, named code `persist_write_failed`, original error preserved in bounded redacted form
- [x] 1.5 Keep the existing "regenerate that writes nothing still withholds under fail_closed" test for a callback that does **not** record test-gate exit 0 (throw, never-records-command, or non-zero). Verify it still passes

## 2. Producer persist after successful suite command (primary)

- [x] 2.1 In `core/scripts/testgate.ts` `recordEvidence`, do not return before `writeTesterEvidence` solely because trusted-surface is blocked or the verifier fingerprint is null. After required-command exit 0 and a 40-char HEAD pin from `gitHead`, write SHA-matched Tester evidence. Omit fabricated `evidence_subject` when subject emission fail-closes. Verify task 1.1 now passes
- [x] 2.2 Pin `TesterEvidence.candidate_sha` with `normalizeCandidateSha(gitHead(wtPath))`. Never copy `trusted-surface.json` `candidate_sha`. Unpinnable HEAD still MUST NOT write a fake SHA. Verify no all-zero `candidate_sha` on a newly written Tester record
- [x] 2.3 Preserve existing fail-closed subject law: blocked trusted-surface still MUST NOT emit a well-formed subject that claims verifier-fingerprint match. Verify evidence-subject tests still pass
- [x] 2.4 SHA-matched Tester evidence without `evidence_subject` SHALL acquire as `classification: "current"`, `subject_outcome: "legacy_unbound"`, `withholdInvoke: false`. Readiness consumers SHALL still treat the omitted subject as unusable for a readiness pass. Verify both consumer tests

## 3. Typed producer observation through regeneration/acquisition

- [x] 3.1 Extend `TestGateResult` with a typed producer observation: `recorded_required_exit_0`, `required_command_exit_code`, and `persist: { ok, candidate_sha, code?, error? }`. Set these from in-process gate state, not from `summary.json` or logs
- [x] 3.2 Change `loadOrRegenerateTesterEvidenceForReview` regenerate from `() => Promise<void>` to returning that observation. Review-routing and pre-merge SHA-gate pass `runTestGate`'s result through. Existing `Promise<void>` call sites that do not record exit 0 keep fail-closed missing behavior
- [x] 3.3 On atomic write failure after exit 0, set `persist.ok: false`, `code: persist_write_failed`, preserve the original `writeTesterEvidence` error (bounded, redacted). Never manufacture a passed artifact. Verify task 1.4 now passes

## 4. Named withhold after producer success (fallback only)

- [x] 4.1 After `loadOrRegenerateTesterEvidenceForReview` runs the producer, if the typed observation has `recorded_required_exit_0: true` and re-acquire is still `missing`, set `persist_acquire_code` on `TesterAcquisitionResult` to a closed enum (`persist_write_failed` | `unpinnable_candidate_sha` | `producer_exit_0_artifact_missing`). Do not use the generic missing-file string. Persist the code in `tester-persist-acquire.json` in the run dir and as `<!-- pipeline-tester-persist-acquire: v1 {…} -->` on the blocked comment. Verify tasks 1.2 and 1.3 now pass
- [x] 4.2 When persist succeeds, `withholdInvoke` is false and `classification` is `current` for the candidate HEAD. Verify the existing "missing + regenerate writes current evidence" test still passes
- [x] 4.3 Review-routing and pre-merge SHA-gate keep using `testerEvidenceWithholdResult(testerAcq.reason)` so the named reason reaches the block comment. Keep `blockerKind: harness-failure`. Verify a routing test asserts the stderr/reason is not the generic missing-file string after the #1048-shaped trusted-surface fixture, and that the durable code is present

## 5. recover-parked retry for named persist/acquire (SHA-bounded)

- [x] 5.1 When recover-parked sees a `pipeline-tester-persist-acquire` marker with `recorded_required_exit_0: true` and no HEAD-bound residual review finding, re-enter same-issue advance via `reenterAdvanceAfterRecoverParked`. Do not return `still-parked` solely because no HEAD-bound residual review artifact exists. Fingerprint is `(issue, stage, persist_acquire_code, candidate_sha)`. Spend that fingerprint. Add an injected test that fails if that park stays `still-parked` on the first pass
- [x] 5.2 A second recover-parked on the same issue/stage/code/SHA after a spent marker SHALL return `already-spent` and SHALL NOT re-enter again. A new candidate SHA MAY take one new pass. Verify no unbounded loop
- [x] 5.3 HIGH / CRITICAL / security residuals still refuse auto-override. Generic missing-file withhold with no producer-success record still follows existing residual fail-closed rules. Verify those tests still pass. Do not invent a review residual

## 6. Gate

- [x] 6.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 6.2 Run `openspec validate tester-evidence-persist-or-named-fail` and `npm run ci` from the repo root. Verify both are green. Do not change default `on_missing` to `fail_open`. Do not invent a readiness subject on blocked trusted-surface. Do not add an `auto_merge` key or merge stage
