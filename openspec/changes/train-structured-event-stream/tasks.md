## 1. Biting regressions (inject I/O; prove fail first)

- [ ] 1.1 Add an injected `runTrain` test that advances two issues with a fake `advanceWave` and asserts the test **fails** against current code if no `.agent-pipeline/runs/train-*/events.jsonl` exists before the first `advanceWave` call. No live network, git, or subprocess.
- [ ] 1.2 Add an injected test that a fake advance wave reports a confirmed loop run id plus absolute events path, and assert the test **fails** against current code if the train stream has no `train_loop_linked` with that id. No live I/O.
- [ ] 1.3 Add an injected `--json` test that captures stdout/stderr and asserts the test **fails** against current code if stdout is not exactly one `train_status` with additive `run_id`, or if stderr has no `kind: "train_run_handoff"` line with `run_id` and absolute `events` before the first wave.
- [ ] 1.4 Add an injected STOP/blocker fixture that initializes a train store then stops, and assert the test **fails** against current code if `events.jsonl` has no `type: "run_complete"` line.

## 2. Run identity and append seam

- [ ] 2.1 Add `trainRunIdFor(startedAt)` (or equivalent) that returns `train-<filesystem-safe UTC timestamp with ms>`. Verify a unit test distinguishes it from `runIdFor(issue, startedAt)` and rejects collision with `<issue>-…` ids.
- [ ] 2.2 Extend generic run-store init so a train run can write `run.json` that marks the run as a train (selector, merge mode, ordered issues when known) without pretending to be a single-issue advance. Verify a unit test fails if `run.json.issue` is the only identity and equals the first work-list issue.
- [ ] 2.3 Add a train `appendEvent` helper that writes through existing `appendEvent` with `schema_version: 1`, monotonic `seq`, `type`, `at`, and `run_id`. Verify a unit test reads three appended lines as `seq` 1, 2, 3 and preserves unknown fields.

## 3. Train command wiring

- [ ] 3.1 In `runTrain` / `runTrainCommand`, after selector admission and before the first `advanceWave`, init the train run store, append `run_start`, and flush stderr `train_run_handoff`. Verify tasks 1.1 and 1.3 now fail only on later catalog/linkage assertions.
- [ ] 3.2 Emit `train_work_list_resolved`, per-wave `train_wave_started` / `train_wave_ended`, per-item `train_item_started` / `train_item_completed`, `train_pr_created` when a PR number is known, merge-mode `train_merge_attempted` / `train_merge_proven` / `train_merge_integrated`, and `train_sibling_halted` when a parked item continues beside independents. Verify a hermetic merge-mode fixture contains those types and a non-merge fixture does not contain merge types. Verify raw child stdout is not copied into the train file.
- [ ] 3.3 When `advanceWave` (or the production loop-wave seam) reports a confirmed loop run id and events path, append `train_loop_linked` with the real loop id and absolute path; omit the event when the store is unconfirmed. Verify task 1.2. Keep existing per-wave `loop_run_handoff` on stderr.
- [ ] 3.4 On every non-crash exit after init (complete, STOP, error), append `run_complete` with `final_state` and `elapsed_ms` in a `finally` path. Add additive `run_id` on `train_status` (`schema_version` stays 1). Verify task 1.4 and that `--json` stdout remains one object. Do not add `pipeline train logs`. Do not implement `train --dry-run`.

## 4. Material filter and host notify

- [ ] 4.1 Add single-sourced `TRAIN_MATERIAL_KINDS` covering `run_start`, `train_work_list_resolved`, `train_wave_started`, `train_loop_linked`, `train_item_started`, `train_item_completed`, `train_pr_created`, `train_merge_attempted`, `train_merge_proven`, `train_merge_integrated`, `train_sibling_halted`, `train_wave_ended`, and `run_complete`. Verify `material-filter` unit tests emit a one-liner for each and drop a non-listed heartbeat. Verify a missing kind fails the existing drift-guard pattern.
- [ ] 4.2 Document train follow in host skill notify guidance (`hosts/claude/SKILL.md` and the other host overlays that carry §4 / §4b): parse `train_run_handoff`, `pipeline logs <train-run-id> --events --follow | material-filter.mjs`, dual-follow `train_loop_linked` loop runs, re-arm until `run_complete`. Verify drift-guards fail if train kinds drift from the filter constant, and that the text does not teach `tail -F | grep` as the primary path. After `hosts/claude/SKILL.md` edits, run `node scripts/build.mjs` so `plugin/` matches.

## 5. Gate

- [ ] 5.1 After any `core/` or `hosts/claude` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean.
- [ ] 5.2 Run `openspec validate train-structured-event-stream` and `npm run ci` from the repo root. Verify both are green. Do not add `pipeline train logs`. Do not change merge-first / frontier / recovery law. Do not merge from advance/loop.
