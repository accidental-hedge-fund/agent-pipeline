## Why

Ship v1.39.8 started Tugboat and train. The Buzz channel got no stage posts.
Tugboat launched the sibling `ship-stage-watch.sh` with `--milestone` and
`--since`. The bundled script rejects `--milestone` (exit 2). The watch pid
died at once. Tugboat still logged `stage-watch started`. Train kept running.
Operators saw a dead channel. A leftover `~/.local/bin/ship-stage-watch` that
still accepts `--milestone` is not the product path.

## What Changes

- **Class law, not a 1.39.8 mole.** Tugboat SHALL invoke the bundled
  `examples/supervisor/shell/ship-stage-watch.sh` with an argv that script
  accepts. The product watch is `--events-file` only. Tugboat SHALL pass an
  absolute `events.jsonl` from the live train/loop handoff. It SHALL NOT
  discover a host-global “latest” run. It SHALL NOT pass `--milestone` while
  the bundled parser rejects it.
- **Named spawn failure.** Tugboat SHALL NOT treat a watch that exits 2 on
  `--milestone` (or any non-zero immediate spawn) as “stage-watch started”.
  That case SHALL log a named failure (`stage-watch argv rejected` or
  equivalent) and SHALL NOT claim a live pid.
- **Default binary stays the sibling.** Default `SHIP_STAGE_WATCH_BIN` SHALL
  remain the repo sibling (or an installed copy of that same contract).
  Installing an older `--milestone` binary on PATH SHALL NOT be required for
  Buzz posts.
- **Tests bite.** A unit test SHALL extract the Tugboat train watch launch
  and the bundled script’s `usage` / argv parser. The test SHALL fail if
  Tugboat passes `--milestone` while the bundled usage only documents
  `--events-file` (the v1.39.8 helper).

**BREAKING** for any Tugboat fixture that expects the train watch spawn to
pass `--milestone` / `--since`, or that treats `stage-watch started pid=…`
as proof the watch is live after an argv-reject exit.

Non-goals: replacing Buzz; discovering latest run directories; KEY_FILE
engine loader (#1181); `train.complete.json` (#1182); a second production pin
(#1183); killing or restarting an in-flight ship as the fix; human `git tag`
/ `--skip-frg`; restoring `--milestone` on the bundled script so a leftover
PATH binary becomes the product.

## Acceptance criteria

- [ ] Tugboat’s train-phase stage-watch spawn uses an argv the bundled
      `examples/supervisor/shell/ship-stage-watch.sh` accepts. With the
      product watch `--events-file` only, that argv includes
      `--events-file <absolute events.jsonl>` from the live train/loop
      handoff and does not include `--milestone`.
- [ ] The `--events-file` value is an absolute path. Tugboat does not glob
      host-global run directories or pick the newest `events.jsonl`.
- [ ] When the bundled watch rejects argv (exit 2 on `--milestone`, or any
      non-zero immediate spawn), Tugboat logs a named failure
      (`stage-watch argv rejected` or equivalent). It does not log
      `stage-watch started pid=…` for that spawn. It does not claim a live
      watch pid.
- [ ] A successful watch spawn still writes `--pid-file` and Tugboat may
      log a started pid only after that spawn did not exit non-zero on
      argv parse.
- [ ] Default `SHIP_STAGE_WATCH_BIN` is the repo sibling
      `examples/supervisor/shell/ship-stage-watch.sh` (or an installed copy
      of that same `--events-file` contract). Buzz posts do not require
      `~/.local/bin/ship-stage-watch` on PATH.
- [ ] A unit test extracts the Tugboat train watch launch and the bundled
      script `usage` / argv parser. The test fails if Tugboat passes
      `--milestone` while the bundled usage only documents `--events-file`.
- [ ] Existing `ship-stage-watch` tests still require one absolute events
      file and still forbid host-global latest-run discovery.
- [ ] When a train advance-wave loop is ready, train writes a machine-readable
      `loop_run_handoff` JSON line (or equivalent) on stderr that includes
      the absolute `events` path. That object does not appear on train
      `--json` stdout.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change.
      `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends existing Tugboat stage-watch compose law. -->

### Modified Capabilities

- `tugboat-thin-ship`: Tugboat SHALL launch the bundled stage-watch sibling
  with argv that script accepts (`--events-file` plus documented optional
  flags). The events path SHALL be the live train/loop handoff absolute
  `events.jsonl`. Tugboat SHALL NOT pass `--milestone` while the bundled
  parser rejects it. A non-zero watch spawn SHALL be a named failure and
  SHALL NOT claim a live pid. Default `SHIP_STAGE_WATCH_BIN` SHALL remain
  that sibling contract. A regression test SHALL fail if Tugboat passes
  `--milestone` while bundled usage only documents `--events-file`.
- `integrated-train-mode`: When a train advance-wave loop is ready, train
  SHALL emit the live `loop_run_handoff` absolute `events` path on a
  machine-readable stream that does not corrupt `train --json` stdout
  (stderr JSON line of `kind: loop_run_handoff`, or equivalent). Nested
  handoff objects SHALL still NOT appear on train `--json` stdout.

Living `supervisor-ship-playbook` does not document `--milestone` watch
argv. No playbook delta.

## Impact

- **Tugboat:** `examples/supervisor/shell/tugboat.sh` train-phase watch
  spawn (~line 2368). Change argv and the “started” log. Keep
  `SHIP_STAGE_WATCH_BIN` default as the sibling.
- **Train:** `core/scripts/pipeline.ts` train advance-wave `onRunReady`
  already has `ctx.events` and today logs only `runId`. Emit the live
  handoff `events` path on stderr so Tugboat can pass `--events-file`
  without latest-run discovery.
- **Bundled watch:** `examples/supervisor/shell/ship-stage-watch.sh` stays
  `--events-file` only. Do not add `--milestone` / `--since`.
- **Tests:** `core/test/tugboat.test.ts` extracts launch + bundled usage.
  Keep `core/test/ship-stage-watch.test.ts` as the watch contract gate.
  Add a train-side check that the advance-wave ready path includes the
  absolute `events` field.
- **Docs / skills:** Hermes and ship-milestone already document
  `--events-file` and “do not discover latest”. Align any Tugboat comment
  that still says `--milestone` watch.
- **Depends on:** living `loop-early-run-handoff` (`events` absolute path)
  and `host-neutral-progress-notify` (shared material filter). Train
  `--json` stdout stays one `train_status` object
  (`integrated-train-mode`).
- **Does not:** restore a PATH `--milestone` binary; glob latest runs;
  fail the ship solely because watch notify is down (`supervisor-ship-notify`
  still observational); merge inside advance/loop.
- **Evidence:** `~/.local/state/pipeline-supervisor/ship-v1.39.8/stage-watch.log`
  at `2026-08-21T01:51:23Z`: `unknown argument: --milestone`. Playbook
  logged `stage-watch started pid=2009569` then that pid died. Tugboat pid
  2009504 stayed in train.
}
