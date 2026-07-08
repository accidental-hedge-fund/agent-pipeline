## Why

`runCapped` (`core/scripts/harness.ts`) is the single choke point through which every
harness call — planning, review-1/2, fix, test-gate, eval — is bounded by a wall-clock
timeout. Its resolution today is not truly unconditional: the happy path settles from the
child's `close` event, and the timeout path settles from a `setTimeout` nested *inside* the
SIGTERM→grace→SIGKILL escalation chain. When a detached grandchild survives SIGKILL and
keeps the inherited stdio pipes open, the parent's `child.stdout`/`child.stderr` streams
never emit `close`, and if the escalation chain itself does not reach its final settle, the
`runCapped` promise stays pending forever. The stage never concludes: no `timed_out`
classification, no blocked label, no terminal line — the run looks *healthy* while being
wedged.

Observed (castrecall #64, run `64/2026-07-07T05:xx`, `review_timeout: 1500`): a review-1
codex invocation ran **10 hours** past its 25-minute cap with the pipeline process alive and
silent. Recovery required an operator SIGTERM'ing the pipeline. A hang is strictly worse than
a crash — a crash at least fires process-exit signals that an operator or supervisor can see.

Two gaps compound the harm: (1) resolution is coupled to child/kill outcomes it should be
independent of, and (2) there is no signal — in `events.jsonl` or in `pipeline status` — that
distinguishes a legitimately long stage from a wedged one, so an unattended overnight batch
cannot self-report the wedge.

## What Changes

- Arm a **hard secondary deadline** in `runCapped`: at the moment the wall-clock cap fires,
  schedule a failsafe timer (default +30s after the SIGKILL point) that force-resolves the
  promise with `timed_out: true` regardless of whether the child streams ever `close` or the
  process-group kill succeeds. Resolution no longer depends on the escalation chain or on any
  child event. Make the deadline injectable so tests use a short value.
- Emit a **`harness_timeout`** event to the run store (`events.jsonl`) at the instant the cap
  fires — before/independent of the promise resolving — so an external supervisor watching the
  event stream detects the wedge without process introspection. Threaded through the existing
  run-store deps already carried on the invocation; best-effort and inert when no run-store
  context is present (e.g. bare `runCapped` callers).
- Flag a **possibly-wedged run** in `pipeline <issue> --status --json`: when the run is not
  finalized (no `run_complete`) and the newest `events.jsonl` entry is older than the largest
  configured stage timeout, surface a `possibly_wedged` object carrying the last-event age and
  the threshold, so an operator or supervisor can tell "long stage" from "wedged run."
- Add a regression test (injected spawn seam, no real subprocess) that simulates a child whose
  streams never `close` after the kill and asserts `runCapped` resolves `timed_out: true`
  within the secondary window instead of pending forever.

## Capabilities

### New Capabilities
- (none — this hardens and observes an existing behavioral surface)

### Modified Capabilities
- `harness-descendant-cleanup`: `runCapped`'s timeout path gains an unconditional bounded
  resolution guarantee (a hard secondary deadline) that is independent of child stream `close`
  and of process-group kill success.
- `events-jsonl-streaming`: adds a `harness_timeout` event type recorded at cap-fire time.
- `machine-readable-status`: the `--status --json` envelope gains a `possibly_wedged` field
  derived from run-store event recency vs. the largest configured stage timeout.

## Impact

- `core/scripts/harness.ts` — `runCapped` timeout path: hard secondary deadline timer;
  timeout-event hook wired from the run-store deps carried on the invocation.
- `core/scripts/run-store.ts` — `HarnessTimeoutEvent` type added to the `RunEvent` union.
- `core/scripts/pipeline.ts` (or the status assembly module) — `possibly_wedged` computation
  in the `--status --json` envelope.
- Co-located unit tests in `core/test/` (harness resolution, event recording, status wedge
  flag).
- `plugin/` mirror (regenerated via `node scripts/build.mjs`; no hand-edits).

## Acceptance Criteria

- [ ] After the wall-clock cap fires and the SIGTERM→SIGKILL escalation runs, `runCapped`
      resolves within a hard secondary deadline (default +30s after the SIGKILL point) with
      `timed_out: true` — even when the child's streams never emit `close` and the
      process-group kill fails.
- [ ] The timeout-path resolution is independent of the SIGKILL escalation chain completing:
      a stubbed `killGroup` that no-ops does not prevent resolution within the secondary window.
- [ ] A `harness_timeout` event is appended to `events.jsonl` at the moment the cap fires
      (carrying at minimum `stage`/`label`, the configured `timeout_sec`, and `at`), so a
      supervisor tailing the event stream sees the wedge before — and independent of — the
      promise resolving.
- [ ] `pipeline <issue> --status --json` includes a `possibly_wedged` object (last-event age
      and threshold) when the run is not finalized and the newest `events.jsonl` entry is older
      than the largest configured stage timeout; otherwise `possibly_wedged` is `null`.
- [ ] A regression test using the injected spawn seam simulates a child whose stdout/stderr
      never `close` after the kill and asserts `runCapped` resolves `timed_out: true` within the
      secondary window (not pending). The test bites: it fails/hangs without the failsafe timer.
- [ ] Normal timeouts (child dies on SIGTERM/SIGKILL and closes its streams) return the same
      `HarnessResult` shape with no added latency, and non-timeout exits are unchanged.
- [ ] No default timeout value or the SIGTERM→SIGKILL grace-period semantics are changed.
- [ ] `npm run ci` passes end-to-end after the change.
