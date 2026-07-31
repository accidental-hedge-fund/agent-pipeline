## 1. Regression tests first (prove thrash)

- [x] 1.1 Settled `failure` at head `H`, recovery budget exhausted → `blocked` / `ci-exhausted` / offramp `ci-failed`; `tryRebaseAndPush` at most once across two+ poll hops on same `H`.
- [x] 1.2 Checks with `pending` remain `waiting` — no false settle; no `setBlocked` ci-exhausted on that tick.
- [x] 1.3 Red + pending together → `waiting`, **no** recovery side-effect (pending precedence).
- [x] 1.4 After one allowlisted recovery attempt at head `H` (rebase or re-run), second hop same head still red **blocks** and does not re-invoke that recovery seam.
- [x] 1.5 Rebase reports success but HEAD unchanged → does **not** return `rebased; CI re-running`; rebase budget for `H` consumed; second hop does not rebase again.
- [x] 1.6 Rebase moves HEAD `H1`→`H2` → `waiting` / `rebased; CI re-running`; subsequent poll with pending on `H2` stays waiting (no false settle).
- [x] 1.7 Settled red → one rebase attempt → terminal block survives **fresh process / durable-state reload** (hydrate from `pre-merge-ci-recovery.json`; no second rebase).
- [x] 1.8 Terminal `gate_result` `ci`/`fail` emitted once per unchanged failed SHA; pure re-poll does not spam `partial` + `rebased; CI re-running`.
- [x] 1.9 Persist read/write failure → finite `ci-exhausted` with persistence failure named; **no** in-memory retry loop / unbounded waiting.
- [x] 1.10 Externally changed head during recovery (beforeSha ≠ afterSha without attributing success to a failed local rebase) → reevaluate new head safely; do not thrash rebase for the old SHA.
- [x] 1.11 Log fetch failure still escalates with failing check names (no wait-for-logs).
- [x] 1.12 Confirm new thrash tests fail on current main behavior (or document which already pass); keep red until implementation lands.

## 2. Durable recovery model + truthful rebase outcome

- [x] 2.1 Extend `CiRecoveryMarkers` / `PreMergePollingContext` with `ciRebaseAttemptedForSha` and `ciTerminalFailRecordedForSha`; hydrate/persist via existing load/save/read-back helpers.
- [x] 2.2 Evolve `tryRebaseAndPush` (or CI-ladder wrapper) to compare authoritative `getPrDetail.head_sha` before/after; return `{ ok, headMoved, beforeSha, afterSha }` (or equivalent).
- [x] 2.3 In `handleDefinitiveCiFailure` step 1: durable per-head rebase guard (not worktree-only); persist-before-side-effect; `rebased; CI re-running` only when `headMoved`; no-op/fail continues ladder; persist failure → escalate.
- [x] 2.4 Apply same HEAD-moved truthfulness to BEHIND mergeability rebase path (no false re-running reason without HEAD move).
- [x] 2.5 Document ladder table in code comment: one attempt **per class per head SHA**, ordered rebase → classify → rerun → archive → assertion → escalate.

## 3. Gate-result / poll settle behavior

- [x] 3.1 Budget-exhausted path records `gate_result` `ci`/`fail` once per head SHA (terminal marker).
- [x] 3.2 Pure re-polls of unchanged red head after budget consumption do not re-clear partial spam guard solely to re-emit `partial` + `rebased; CI re-running`.
- [x] 3.3 Pending path unchanged: `waiting` with at most one continuous-stretch partial for `CI still running` (#682).
- [x] 3.4 Escalation evidence: failing check names always; capped log excerpt only when fetch succeeds.

## 4. Integration finish

- [x] 4.1 Update existing pre-merge CI recovery / convergence / conflict tests that assumed bare boolean rebase or always-`rebased; CI re-running` on success.
- [x] 4.2 Run `cd core && npm test` for affected suites; fix regressions.
- [x] 4.3 From repo root: `node scripts/build.mjs` and include regenerated `plugin/` if `core/` changed.
- [x] 4.4 Run `npm run ci` from repo root; resolve any gate failures.
- [x] 4.5 `openspec validate pre-merge-ci-settled-failure-no-thrash` remains green after artifact touch-ups.
