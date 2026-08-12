## 1. Live-head pin seam

- [x] 1.1 Identify every pre-merge consumer of tester evidence, last test-gate `stage_accounting` row, github/local CI classification, and durable delta `pipeline-blocking-keys` markers
- [x] 1.2 Resolve the open PR live head once per evaluation (reuse existing `getPrDetail` / head pin where already hoisted) and thread that pin into those consumers via existing deps seams
- [x] 1.3 Add a pure helper (unit-tested) that classifies a recorded candidate/test SHA as current vs stale relative to the live-head pin

## 2. Tester evidence pre-merge currency

- [x] 2.1 Ensure pre-merge load/acquire path treats SHA-mismatched fail evidence as stale/non-current (no live-head fail authority, no invented pass)
- [x] 2.2 Unit tests: mismatched fail at `H_fail` with live head `H_green` → stale; matched fail at live head remains authoritative

## 3. CI / test-gate SHA fail authority

- [x] 3.1 Local mode: do not treat a test-gate **failure** with `pr_head_sha ≠` live head as current-head suite failure / `test-gate-exhausted` alone
- [x] 3.2 Preserve existing local-mode stale-**pass** fail-closed behavior
- [x] 3.3 Github mode: when checks are success on live head, do not divert to suite/CI block solely from prior-head local fail rows
- [x] 3.4 Unit tests for 3.1–3.3 via injectable deps (no real network/git)

## 4. Delta blocking-key SHA scope at gate start

- [x] 4.1 At SHA-gate / delta entry, compare durable blocking-key marker reviewed SHA to live head; on mismatch, withhold residual block and re-evaluate delta (or conservative re-review) at live head
- [x] 4.2 Preserve same-head residual block and mid-review supersession behavior
- [x] 4.3 Unit tests: prior-head keys do not auto-block; same-head keys still block; control residual at live head still blocks
- [x] 4.4 Review fix: remove pipeline-internal residual-authority bypass; pipeline-internal tip advance with prior-head keys re-evaluates at live head (no setBlocked solely from H_fail markers); regression + review-sha-gating MODIFIED delta

## 5. Autofix noop-clean / DNR + green head offramp

- [x] 5.1 After noop-clean / does-not-reproduce at live head H with green CI, run clean-noop re-verify / shared noop-advance at H before terminal block
- [x] 5.2 Do not escalate solely on autofix-exhausted + prior-head finding keys when re-verify at H is clean
- [x] 5.3 When residual still blocks at H, escalate with reason naming prior candidate SHA (if any) and live head H, plus whether override is required
- [x] 5.4 Unit tests covering the #1010-class path and residual true-block control

## 6. Regression fixture and CI gate

- [x] 6.1 Add an injectable end-to-end pre-merge regression: fail evidence + keys at `H_fail`, live head + green checks at `H_green`, autofix DNR/noop-clean → no stale-only block; control residual at `H_green` still blocks
- [x] 6.2 Prove the primary regression fails without the pin/invalidation fix (bite), then passes with it
- [x] 6.3 Run `cd core && npm test` for touched files; run `npm run ci` from repo root
- [x] 6.4 If any `core/` file changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change
