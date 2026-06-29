## 1. Stage Lifecycle

- [x] 1.1 Move `ready -> planning` transition to the start of the planning flow and update planning blockers to use `planning`.
- [x] 1.2 Emit separate lifecycle/evidence records for `planning`, `plan-review`, and `implementing` from the compound planning flow.
- [x] 1.3 Prevent the outer advance loop from writing a wrapper lifecycle record for the `ready` dispatch.
- [x] 1.4 Add regression tests for early planning label transition and split lifecycle records.

## 2. OpenSpec Consistency

- [x] 2.1 Extract stale-delta consistency logic into a shared helper used by pre-merge and fix rounds.
- [x] 2.2 Run the shared stale-delta guard in fix rounds after format/test convergence and before push.
- [x] 2.3 Add regression tests proving stale deltas block before push and updated deltas pass.

## 3. Prompt Accounting

- [x] 3.1 Add sanitized prompt-size fields to stage accounting types and sanitization.
- [x] 3.2 Populate prompt-size telemetry from harness invocations.
- [x] 3.3 Aggregate and display prompt-size telemetry in scoreboard output.
- [x] 3.4 Add accounting, harness, and scoreboard tests for prompt-size telemetry.

## 4. Queue Safety

- [x] 4.1 Add a repo-local queue batch lock with stale-lock cleanup.
- [x] 4.2 Wrap `pipeline queue` execution in the batch lock.
- [x] 4.3 Add queue tests for concurrent and stale lock behavior.

## 5. Documentation and Verification

- [ ] 5.1 Update README/OpenSpec docs for split planning stages, prompt telemetry, and queue locking.
- [ ] 5.2 Run `openspec validate pipeline-throughput-remediation`.
- [ ] 5.3 Run targeted tests for touched modules.
- [ ] 5.4 Run `node scripts/build.mjs` and verify the generated `plugin/` mirror.
- [ ] 5.5 Run `npm run ci`.
