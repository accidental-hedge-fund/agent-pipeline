## Why

`pipeline train` emits unstructured stdout and has no train-level `events.jsonl`. Advance and loop already publish a run ID plus an append-only event stream that `pipeline logs … --events --follow` and `material-filter.mjs` can follow. Train is the long-running merge-capable command hosts most need to supervise, and it is the one command without that surface. Hosts then grep captured stdout, which matches noise (`/training` in Next.js output, `0 errors` in eslint, repeated CI polls).

## What Changes

- Each train invocation SHALL publish a durable train-level run ID and an append-only `events.jsonl` in the existing generic run-store layout (`.agent-pipeline/runs/<run-id>/`).
- Hosts SHALL follow that stream with existing `pipeline logs <train-run-id> --events --follow`. No train-specific log command is added.
- The stream SHALL use a versioned envelope with sequence, timestamp, train run ID, event type, and issue or PR identity when applicable. It SHALL emit a `run_complete` terminal so existing until-terminal follow exits.
- The train stream SHALL link each advance-wave loop run ID (and absolute events path when known), the same way `loop_item_advance_linked` links advance runs. Raw engine, CI, and harness output stays on the linked wave/advance logs.
- Train SHALL flush an early machine-readable handoff (run ID + events path) before the first wave so a host can follow mid-flight. `train --json` stdout SHALL remain exactly one `train_status` object.
- `material-filter.mjs` SHALL treat the train material kinds as notify-worthy. Host skill notify guidance SHALL describe train the same way it describes loop: logs follow piped through the shared filter.

**BREAKING:** none for train merge/advance semantics, exit codes, or `train --json` stdout shape beyond an additive `run_id` field on `train_status`.

## Capabilities

### New Capabilities

- `train-event-stream`: train-level run identity, generic run-store `events.jsonl`, versioned envelope, material event catalog, wave-loop linkage, compatible `run_complete` terminal, and early handoff. Hosts observe with existing `pipeline logs`.

### Modified Capabilities

- `integrated-train-mode`: train identity includes the durable train run ID; `train_status` carries that ID; the existing “status and events” contract is the durable train stream plus status, not unstructured stdout.
- `host-neutral-progress-notify`: shared material filter and host skill notify maps cover train material kinds; skill guidance uses `pipeline logs <train-run-id> --events --follow | material-filter.mjs` and drills into linked loop run IDs.

## Impact

- **Train command:** `core/scripts/stages/train.ts` and `runTrainCommand` in `core/scripts/pipeline.ts` initialize a generic run store, append train events through `appendEvent`, flush early handoff, and write `run_complete` on exit (including failure/STOP).
- **Run store:** reuse `.agent-pipeline/runs/<run-id>/` and `appendEvent` (redaction, sink, write-health). Train run IDs MUST be distinct from per-issue advance IDs. `run.json` MUST identify a train, not a fake single-issue advance.
- **Observation:** existing `pipeline logs` / until-terminal on `type: "run_complete"`. No `pipeline train logs`.
- **Notify:** `core/scripts/material-filter.ts` gains a train material-kind list; host `SKILL.md` §4-family documents train follow. Drift-guards cover the new kinds.
- **Tests:** injected train/run-store fakes; no live network, git, or subprocess. A regression MUST fail if train completes without a train-level `events.jsonl` or without linking a known wave loop run ID.
- **Does not:** add `train --dry-run`; change merge/advance/recovery law; copy child engine stdout into the train stream; add a second recoverer inside `train.ts`; merge from advance/loop.

## Acceptance criteria

- [ ] A `pipeline train` run (with or without `--merge`) creates `.agent-pipeline/runs/<train-run-id>/events.jsonl` before the first advance wave and publishes that `<train-run-id>` in an early machine-readable handoff a host can parse without scraping prose.
- [ ] `pipeline logs <train-run-id> --events` prints that file. `pipeline logs <train-run-id> --events --follow` streams new lines and, by default, exits 0 after a `type: "run_complete"` line. There is no `pipeline train logs` command.
- [ ] Each train event line is JSON with `schema_version`, monotonic `seq`, ISO timestamp, the train `run_id`, and `type`. Lines that apply to an issue or PR also carry that identity. Unknown fields remain readable.
- [ ] The train stream contains events for: ordered work list resolved; each advance wave start and end; each work-list item start and terminal; PR identity when known; merge attempted, proven contained, and integrated (merge mode); sibling halted; and a terminal summary on `run_complete`.
- [ ] When an advance wave has a real loop run ID, the train stream contains a linkage event with that loop run ID and the absolute loop `events.jsonl` path when known. A host can run `pipeline loop logs <loop-run-id> --events` from that record alone. The train stream does not copy raw engine/CI/harness stdout from that wave.
- [ ] `train --json` stdout is still exactly one unfenced `train_status` object. That object includes `run_id`. Early handoff and train events do not appear on that stdout stream.
- [ ] `material-filter.mjs` emits one-liners for the train material kinds (work list, wave, item, PR, merge, sibling halt, loop linkage, `run_complete`) and suppresses non-material noise. Unfiltered `pipeline logs … --events` still shows the full train file.
- [ ] Host skill notify guidance for train names `pipeline logs <train-run-id> --events --follow | material-filter.mjs` and dual-follow of linked loop runs. It does not teach `tail -F | grep` of train stdout as the primary path.
- [ ] Train events are observational. They do not grant merge or advance authority. Failure to notify does not change train state.
- [ ] Injected unit tests fail if: no train-level `events.jsonl` is written; the published run ID is not followable by `pipeline logs`; a known wave loop run ID is omitted from the train stream; `run_complete` is missing so until-terminal cannot end; `train --json` stdout contains extra JSON objects; or the material filter drops a required train kind. Tests inject I/O (no live network, git, or subprocess).
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `openspec validate train-structured-event-stream` and `npm run ci` pass.

## Out of scope

- `train --dry-run` (advertised and rejected today; filed separately).
- A new `pipeline train logs` command or a second run-store layout.
- Changing train merge-first, frontier, recovery, or independent-sibling merge law.
- Copying child loop/advance raw output into the train material stream.
- A pipeline-owned push/Slack/Discord microservice.
