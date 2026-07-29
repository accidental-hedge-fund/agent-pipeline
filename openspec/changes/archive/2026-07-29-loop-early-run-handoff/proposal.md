## Why

`pipeline loop` (and `/pipeline:loop` / `$pipeline:loop`) drives multi-item work for a long
wall-clock period, but the CLI only surfaces `run_id` in a terminal JSON blob after the
supervisor finishes — often tens of minutes later. Single-issue `pipeline run N --detach`
already returns a machine-readable handoff (`run-store.json` with `run_store_run_id` +
`events` path) immediately so a harness can arm a Monitor or follow structured progress.
Loop has no equivalent early handoff, even though durable events already exist under
`<state-home>/runs/<run_id>/events.jsonl`. Host packaging still claims the command
"completes in seconds" and "No Monitor needed," which is false for multi-item durable runs.

## What Changes

- After a durable loop run is successfully created or resumed and exclusively locked — and
  **before** the first item dispatch can block for minutes — the CLI SHALL emit a
  machine-readable **early run handoff** containing at least `run_id`, the absolute path to
  the run's `events.jsonl`, and enough context to follow progress (engine; selector summary
  when known).
- The handoff SHALL be parseable without scraping human prose (stable JSON shape with a
  kind discriminator that distinguishes it from the existing terminal summary).
- Stdout SHALL be flushed so a streaming harness observes the handoff while the supervisor
  is still running.
- Preflight and other failure paths that refuse to start/resume SHALL continue to perform
  zero durable writes beyond existing contracts, and SHALL NOT emit a successful handoff.
- Host packaging docs (`pipeline:loop.md` and any skill text that restates the same claim)
  SHALL stop claiming the command completes in seconds / needs no Monitor for multi-item
  durable runs; they SHALL point operators/harnesses at the early handoff for progress
  follow.
- Terminal JSON at end-of-run remains; this change adds an early signal, not a replacement
  for the terminal summary.

Out of scope (related cluster issues, not this change):

- Loop logs follow CLI (#666)
- Dispatch → per-item advance `run_id` linkage (#667)
- Skill orchestration rewrite (#668)
- Rewriting the durable store schema
- Auto-merge
- Detaching the loop process itself (loop stays synchronous; only the *identity* of the
  durable run is advertised early)

## Acceptance criteria

- [ ] When a durable loop run is successfully created or resumed and locked, the CLI emits
      a machine-readable early handoff (JSON on stdout) containing at least `run_id` and an
      absolute `events` path before the first item dispatch blocks.
- [ ] The handoff is distinguishable from the terminal summary (stable kind/discriminator)
      and is parseable without scraping human-readable prose.
- [ ] Stdout is flushed after the handoff so a streaming consumer can read it while the
      supervisor is still running.
- [ ] `--audit` remains read-only and does not emit a drive handoff or perform durable
      writes.
- [ ] Preflight / lock / init failure paths still exit non-zero with remediation and perform
      zero durable writes beyond existing contracts; they do not emit a successful handoff.
- [ ] Resume (`--resume <run-id>`) also emits the early handoff after lock acquisition and
      before the first dispatch of that process.
- [ ] Host packaging no longer claims multi-item loop "completes in seconds" / "No Monitor
      needed"; it documents the early handoff for progress follow.
- [ ] Unit/CLI tests cover the handoff shape, timing relative to first dispatch, and
      failure-path non-emission; the regression bites without the fix.
- [ ] `npm run ci` is green; `plugin/` is regenerated if `core/` (or host packaging mirrored
      into plugin) changes.

## Capabilities

### New Capabilities

- `loop-early-run-handoff`: early machine-readable advertisement of a durable loop run's
  identity and events path so a harness or operator can follow structured progress for the
  whole wall-clock of a multi-item run, with parity intent to single-issue detach handoff
  without rewriting the durable store schema.

### Modified Capabilities

- `pipeline-loop-facade`: the `pipeline loop` / `pipeline:loop` surface must emit the early
  handoff on successful drive/resume start and correct packaging guidance that currently
  claims the command completes in seconds with no Monitor.

## Impact

- `core/scripts/pipeline.ts` — `runLoopCommand` / engine drive path: emit + flush early
  handoff after lock, before supervisor dispatch cycles block.
- `core/scripts/loop/supervisor.ts` and/or `defaultRunLoopEngine` — seam so identity is
  available to the CLI layer before `driveSupervisor` blocks on the first item (callback,
  yield, or split "attach then drive" without rewriting store schema).
- `core/test/loop-command.test.ts` (and adjacent loop CLI tests) — handoff shape, flush/
  ordering relative to first dispatch, failure-path non-emission.
- Host packaging: `hosts/*/…` and generated `plugin/pipeline/commands/pipeline:loop.md` (and
  skill text if it restates the seconds/Monitor claim).
- `plugin/` regenerated via `node scripts/build.mjs` when core/hosts change.
- No change to durable store document layout, contract hash, ledger graph, merge boundary,
  review rigor, or per-item advance `run_id` linkage.
)
