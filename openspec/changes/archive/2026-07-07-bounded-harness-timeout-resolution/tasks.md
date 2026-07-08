# Tasks

## 1. Harness: unconditional bounded resolution
- [ ] 1.1 Add `hardDeadlineSec?: number` to the `runCapped` opts (default `30`).
- [ ] 1.2 In the wall-clock cap `setTimeout` callback, arm a sibling failsafe timer at
      `(killGraceSec + hardDeadlineSec) * 1000` that calls `settle({ ...timed_out: true })`
      unconditionally — not nested inside the SIGKILL escalation chain.
- [ ] 1.3 Confirm `settle` idempotence (`if (settled) return`) makes the failsafe a no-op when
      the escalation chain or a child event already resolved; no new teardown needed.
- [ ] 1.4 Leave the SIGTERM → grace → SIGKILL → 200ms settle chain intact so clean timeouts
      resolve at the same latency as today (failsafe never fires on the happy timeout path).

## 2. Harness: record `harness_timeout` at cap-fire time
- [ ] 2.1 Add an optional run-store context to `runCapped` opts (`runDir`, `runStoreDeps`,
      `stage`/`issue`), threaded from `invoke()`'s existing `opts.accounting`.
- [ ] 2.2 In the cap callback (alongside SIGTERM, before/independent of resolution),
      best-effort `appendEvent(runDir, { type: "harness_timeout", stage, timeout_sec, at }, deps)`
      when a run-store context is present; wrap in `.catch(() => {})`.
- [ ] 2.3 Keep the event inert for bare `runCapped` callers (`testgate.ts`, `eval.ts`) that pass
      no run-store context — no behavior change there.

## 3. Run store: event type
- [ ] 3.1 Add `HarnessTimeoutEvent` (`type: "harness_timeout"`, `stage`/`label`, `timeout_sec`)
      to `run-store.ts` and to the `RunEvent` union; keep `schema_version` at `1`.
- [ ] 3.2 Confirm `readEvents()` includes `harness_timeout` and that stage-timeline filters
      (`stage_start`/`stage_complete`) exclude it.

## 4. Status: possibly-wedged flag
- [ ] 4.1 Add a helper computing the largest configured stage timeout from the resolved config.
- [ ] 4.2 In the `--status --json` assembly, compute `possibly_wedged` when the run is not
      finalized (no `run_complete`) and `now - last_event.at` exceeds the largest stage timeout
      (plus margin); otherwise `null`.
- [ ] 4.3 Add `possibly_wedged` to the status envelope (additive; `schema_version` stays `"1"`).

## 5. Tests
- [ ] 5.1 Bite test: injected `spawnFn` with a child whose streams never `close` and a no-op
      group kill — assert `runCapped` resolves `timed_out: true` within the secondary window;
      verify it hangs/fails without the failsafe timer.
- [ ] 5.2 Test that a `harness_timeout` event is appended at cap-fire time (injected run-store
      deps) and that none is appended on a normal pre-cap exit.
- [ ] 5.3 Status test via the `deps` seam: unfinalized + stale log → `possibly_wedged` populated;
      finalized or fresh log → `null`.
- [ ] 5.4 No-regression: existing descendant-cleanup + non-timeout scenarios pass with unchanged
      `HarnessResult` shape and no added latency.

## 6. Mirror + gate
- [ ] 6.1 `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 6.2 `npm run ci` green (core tests → mirror check → install smoke → `openspec validate --all`).
