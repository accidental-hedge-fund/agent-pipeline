## 1. Evidence model and pure composition

- [x] 1.1 Define a small injectable type for “last advance-wave loop evidence” (at least: optional `loop_run_stopped.reason`, optional last `loop_item_blocked.class` + issue, optional `blocker_kind` / comment first line, optional exit code / engine message).
- [x] 1.2 Implement a pure helper that composes the human-visible train STOP / item-error string using the priority order in the `integrated-train-mode` delta (stop reason → blocked class+issue → blocker_kind/comment first line → exit code), without inventing classes when fields are absent.
- [x] 1.3 Unit-test the pure helper: (a) `supervisor_no_progress` + issue appears and is not exit-only; (b) `recovery_exhausted` class + issue; (c) empty evidence → exit code only, no invented class.

## 2. Wire production train advance-wave path

- [x] 2.1 From the production multi-item advance-wave path, obtain last-run loop evidence for the just-finished wave (run id / events path already known to the engine result, or extend the injectable result with a compact evidence summary — prefer minimal surface).
- [x] 2.2 Replace exit-only classification for non-ok outcomes (`classifyTrainAdvanceLabels` exit path and/or `advanceWaveThroughLoop` when `engineFailed` / non-zero) so per-item `error` and train `blocker` / `train_status.blocker` use the pure helper when the failure is advance-related.
- [x] 2.3 Ensure held-item errors and final “all remaining work held” / STOP aggregations preserve enriched per-item reasons (no re-collapse to exit-only).
- [x] 2.4 Confirm production path remains multi-item loop advance wave (no N×`single` regression) and non-zero exit / incomplete status is unchanged.

## 3. Tugboat thin-read regression (no second brain)

- [x] 3.1 Add or extend a Tugboat / failure_detail fixture where `train.json.blocker` contains `supervisor_no_progress` + issue number and assert notify/state detail preserves those tokens (not exit-only).
- [x] 3.2 Assert that an exit-only train blocker is still surfaced without inventing a class (thin reader stays honest).

## 4. End-to-end train fixtures and gate

- [x] 4.1 Train fixture with injected advance-wave deps: loop evidence `supervisor_no_progress` for issue N → `train_status.blocker` / STOP log contains that string and N; exit remains non-zero.
- [x] 4.2 Train fixture: non-zero advance with no loop evidence → blocker/error includes exit code (or engine message), does not invent a class.
- [x] 4.3 If `core/` changed: run `node scripts/build.mjs` and include regenerated `plugin/` in the same change.
- [x] 4.4 Run `npm run ci` and fix any failures until green.
