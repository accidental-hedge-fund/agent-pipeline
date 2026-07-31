## 1. Regression tests first (prove thrash)

- [ ] 1.1 Add unit tests (injected deps, no live network/git/subprocess) that inject settled `failure` checks at head `H` across two+ poll hops and assert: outcome `blocked` with `ci-exhausted` / offramp `ci-failed` after budget exhaustion; `tryRebaseAndPush` invoked at most once for `H`.
- [ ] 1.2 Add unit test: checks with `pending` remain `waiting` / partial — no false settle to block.
- [ ] 1.3 Add unit test: after one allowlisted recovery attempt at head `H` (rebase or re-run), second hop with same head still red blocks and does not re-invoke that recovery seam.
- [ ] 1.4 Add unit test: rebase reports success but HEAD unchanged → does **not** return reason `rebased; CI re-running`; rebase budget for `H` is consumed so a second hop does not rebase again.
- [ ] 1.5 Add unit test (or extend 1.1): escalated path records a terminal `gate_result` with `gate: "ci"` / `result: "fail"` and does not append unbounded `partial` + `rebased; CI re-running` rows for pure re-polls of the same red SHA.
- [ ] 1.6 Confirm the new tests fail on current main behavior (or document which already pass); keep them red until implementation lands.

## 2. Durable rebase budget + truthful rebase outcome

- [ ] 2.1 Extend durable CI recovery markers (`pre-merge-ci-recovery.json` / `PreMergePollingContext`) with a per-head rebase-attempted field parallel to re-run/assertion markers; hydrate/persist with existing helpers.
- [ ] 2.2 Evolve `tryRebaseAndPush` (or a thin wrapper used by the CI ladder and BEHIND path) to report whether HEAD moved (result object), not only push exit code.
- [ ] 2.3 In `handleDefinitiveCiFailure` step 1: consult durable per-head rebase marker; on attempt, persist before/alongside side-effect per #679 durability rules; return `rebased; CI re-running` only when HEAD moved; on no-op success, consume budget and continue ladder.
- [ ] 2.4 When durable marker persistence fails / runDir absent, refuse unbounded rebase wait and escalate with `ci-exhausted` naming persistence failure (match #679 pattern).
- [ ] 2.5 Apply the same truthful HEAD-moved result to the BEHIND mergeability rebase path so it cannot thrash the same reason string without progress.

## 3. Gate-result / poll settle behavior

- [ ] 3.1 Ensure budget-exhausted settle path always records `gate_result` `ci`/`fail` (existing helper) before returning blocked.
- [ ] 3.2 Ensure pure re-polls of an unchanged red head after budget consumption do not re-clear the partial-spam guard solely to re-emit `partial` + `rebased; CI re-running`.
- [ ] 3.3 Keep pending path unchanged: still `waiting` with at most one continuous-stretch partial for `CI still running` (#682).

## 4. Integration finish

- [ ] 4.1 Update any existing pre-merge CI recovery / convergence tests that assumed bare boolean rebase or always-`rebased; CI re-running` on success.
- [ ] 4.2 Run `cd core && npm test` for affected suites; fix regressions.
- [ ] 4.3 From repo root: `node scripts/build.mjs` and include regenerated `plugin/` if `core/` changed.
- [ ] 4.4 Run `npm run ci` from repo root; resolve any gate failures.
- [ ] 4.5 `openspec validate pre-merge-ci-settled-failure-no-thrash` remains green after any artifact touch-ups.
