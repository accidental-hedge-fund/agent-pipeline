## 1. Biting regressions (inject I/O; prove fail first)

- [ ] 1.1 Add a `loadOrRegenerateTesterEvidenceForReview` test whose regenerate callback records test-gate exit 0 and does not write `tester-evidence.json`. Assert the test **fails** against current code if `withholdInvoke` stays true solely because the generic missing-file string is used. Inject I/O; no live network, git, or subprocess
- [ ] 1.2 Add a test that writes `trusted-surface.json` with `outcome: blocked`, `repo_policy` `failure_reason: missing_base_sha`, and all-zero `candidate_sha`, then runs a producer that records test-gate exit 0. Assert the test **fails** against current code if withhold reason is only `No Tester suite evidence file for this run (missing tester-evidence.json)`
- [ ] 1.3 Add a `runTestGate` / `recordEvidence` test: required command exits 0, run dir has blocked trusted-surface (`missing_base_sha` / all-zero SHA), HEAD is a real 40-char SHA. Assert SHA-matched `tester-evidence.json` is written with `overall_status: "passed"` and **no** fabricated readiness `evidence_subject`. Verify this test **fails** against current skip-write
- [ ] 1.4 Keep the existing "regenerate that writes nothing still withholds under fail_closed" test for a callback that does **not** record test-gate exit 0. Verify it still passes

## 2. Producer persist after successful suite command

- [ ] 2.1 In `core/scripts/testgate.ts` `recordEvidence`, do not return before `writeTesterEvidence` solely because trusted-surface is blocked or the verifier fingerprint is null. After required-command exit 0 and a 40-char HEAD pin, write SHA-matched Tester evidence. Omit fabricated `evidence_subject` when subject emission fail-closes. Verify task 1.3 now passes
- [ ] 2.2 Preserve existing fail-closed subject law: blocked trusted-surface still MUST NOT emit a well-formed subject that claims verifier-fingerprint match. Verify evidence-subject tests still pass
- [ ] 2.3 Unpinnable HEAD (no 40-char SHA) still MUST NOT write a fake SHA. That path uses named persist/acquire fail in task 3, not a zero SHA artifact. Verify no all-zero `candidate_sha` on a newly written Tester record

## 3. Named withhold after producer success

- [ ] 3.1 After `loadOrRegenerateTesterEvidenceForReview` runs the producer, if the producer recorded test-gate exit 0 and re-acquire is still `missing`, set withhold reason to a named persist/acquire cause (include trusted-surface `blocked` / `missing_base_sha` when `trusted-surface.json` is present). Do not use the generic missing-file string. Verify tasks 1.1 and 1.2 now pass
- [ ] 3.2 When persist succeeds, `withholdInvoke` is false and `classification` is `current` for the candidate HEAD. Verify the existing "missing + regenerate writes current evidence" test still passes
- [ ] 3.3 Review-routing and pre-merge SHA-gate keep using `testerEvidenceWithholdResult(testerAcq.reason)` so the named reason reaches the block comment. Verify a routing test asserts the stderr/reason is not the generic missing-file string after the #1048-shaped trusted-surface fixture

## 4. recover-parked retry for named persist/acquire

- [ ] 4.1 When recover-parked sees a named Tester persist/acquire withhold and no HEAD-bound residual review finding, re-enter same-issue advance. Do not return `still-parked` solely because no HEAD-bound residual review artifact exists. Add an injected test that fails if that park stays `still-parked`
- [ ] 4.2 HIGH / CRITICAL / security residuals still refuse auto-override. Generic missing-file withhold with no producer-success record still follows existing residual fail-closed rules. Verify those tests still pass

## 5. Gate

- [ ] 5.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [ ] 5.2 Run `openspec validate tester-evidence-persist-or-named-fail` and `npm run ci` from the repo root. Verify both are green. Do not change default `on_missing` to `fail_open`. Do not invent a readiness subject on blocked trusted-surface. Do not add an `auto_merge` key or merge stage
