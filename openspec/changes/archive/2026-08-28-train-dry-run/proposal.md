## Why

`pipeline train` advertises `--dry-run` in its allowlist and usage error, then rejects the flag. `train --merge` is an operator-authorized merge surface, and it is the only command in that family with no preview. An operator who follows the allowed-flags list cannot rehearse a multi-hour merge train.

## What Changes

- `pipeline train --dry-run` SHALL be accepted in normal mode and in `--merge` mode.
- Dry-run SHALL print a structured, point-in-time, read-only plan: resolved order, current stages, dependency eligibility, linked PRs, and intended merge behavior.
- Dry-run MAY read configuration and GitHub state. It SHALL NOT invoke an engine, create a worktree, post a comment, push, merge, or write a train run store.
- `--json --dry-run` SHALL emit exactly one unfenced JSON plan object. That object SHALL reuse the train status/event field vocabulary (`ordered_issues`, `merge_mode`, per-item issue/PR/stage) without calling the live event-stream writer.
- Live `pipeline train` without `--dry-run` SHALL stay the default. Dry-run is opt-in. This is not merge-queue's dry-run-default contract.
- CLI docs usage for `train` SHALL list `--dry-run` and the handler SHALL honor it.

**BREAKING:** none. The current handler already rejects `--dry-run`; accepting it is additive. Live train, `train --json` `train_status`, and ship-playbook completion (which keys on `kind: "train_status"`) stay unchanged.

## Acceptance criteria

- [ ] `pipeline train --issues "<n,n>" --dry-run` and `pipeline train --milestone <m> --dry-run` are accepted. The command does not print `pipeline train: --dry-run is not supported for train; omit it.`
- [ ] `pipeline train --issues "<n,n>" --merge --dry-run` is accepted the same way. It does not merge, push, or call the live merge surface.
- [ ] A successful dry-run prints the resolved issue order and, for each item, the current pipeline stage, whether it is on the current base-eligible frontier, any linked PR number, and the intended next train action (`would-advance`, `would-merge`, `already-integrated`, `would-block`, or waiting-on-deps).
- [ ] `pipeline train … --dry-run --json` writes exactly one unfenced JSON object to stdout. `kind` is `train_plan` (not `train_status`). `schema_version` is `1`. The object includes `ordered_issues`, `merge_mode`, and per-item issue/stage/PR/intended-action fields shared with the train status/event vocabulary.
- [ ] Dry-run does not invoke an engine, create a worktree, post a GitHub comment, push, merge, mint a train run directory, or write `events.jsonl`.
- [ ] Dry-run without `--dry-run` is unchanged: live train still advances (and with `--merge`, still merges). Omitting `--dry-run` does not become a preview.
- [ ] A ship-playbook train-completion scan of dry-run JSON does not treat `train_plan` as a completed `train_status`. Live `train --json` stdout remains exactly one `train_status` object.
- [ ] The train command-registry allowlist still includes `dryRun`, and a unit test fails if the handler rejects an allowlisted `--dry-run`.
- [ ] Injected unit tests fail against today's reject-and-exit-2 path, and they assert the dry-run plan never calls `advanceWave` or `mergeIssuePr`. Tests inject I/O (no live network, git, or subprocess).
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `openspec validate train-dry-run` and `npm run ci` pass.

## Capabilities

### New Capabilities

- `train-dry-run`: Opt-in read-only train plan for `--dry-run` in normal and `--merge` modes. Structured human and JSON output. No engine, worktree, comment, push, merge, or run-store writes.

### Modified Capabilities

- `integrated-train-mode`: Stop rejecting `--dry-run`. Live train without the flag stays the default executor. Dry-run does not advance or merge.
- `command-registry`: Train `allowedFlags` already lists `dryRun`. The advertised flag SHALL be implemented, not rejected after validation.
- `train-event-stream`: A dry-run admission SHALL NOT create a train run directory, `events.jsonl`, or `train_run_handoff`.
- `merge-authority-boundary`: `pipeline train --merge --dry-run` SHALL NOT merge. Merge still requires a live operator-authorized `train --merge` (no `--dry-run`).

## Impact

- CLI handler: `runTrainCommand` in `core/scripts/pipeline.ts` must stop returning 2 for `--dry-run` and must dispatch a read-only planner.
- Train orchestrator: `core/scripts/stages/train.ts` already resolves order and merge-first before it mutates. Dry-run should stop after that snapshot (plus GitHub PR/stage reads) and print the plan.
- JSON contract: new `kind: "train_plan"` object. Shared field names with `train_status` / train events. No call into `train-events.ts` from the dry-run path.
- Docs: `core/scripts/command-docs.ts` usage, generated `docs/cli.md`, and host SKILL command tables.
- Tests: injected `runTrain` / `runTrainCommand` regressions in `core/test/`. No live GitHub.
- Does not: change live merge-first / frontier / recovery law; default train to dry-run; add `pipeline train logs`; merge from advance/loop; write a grant file.
