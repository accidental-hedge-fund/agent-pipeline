## Why

Run-store event append is deliberately non-fatal (`appendEvent` returns `false` after `console.warn`, and most callers ignore the boolean). Exclusive event-sink mode can skip the local `events.jsonl` write entirely, so a sink failure can erase both local and remote audit. After PR #787, canonical `blocker_set` / `pipeline/stage-diagnostic@1` records and recovery claims are control-plane inputs — silent loss is no longer only an observability defect: it can cause recovery misclassification or empty “green” evidence. Operators need a durable, queryable failure signal without turning every telemetry write into a stage-blocking hard failure.

## What Changes

- Record and retain **run event-stream write health** when local append and/or exclusive-sink delivery fails mid-run (not only a one-shot `console.warn`).
- Split event writes into **control-critical** vs **best-effort telemetry** criticality classes. Control-critical failures (blocker diagnostics, recovery claim/result, loop terminal state, and other SoT control records) MUST be operator-visible and MUST NOT silently degrade into an unrelated recovery classification.
- Best-effort telemetry failures remain non-blocking for stage advancement (labels-as-SoT preserved).
- Surface write-health on **status**, **doctor**, and **summary** (prose and machine-readable where those surfaces already emit structured output), including advisory non-zero exit where the product already uses advisory modes.
- Change **exclusive** sink mode so that when sink delivery fails, the engine **falls back to a local `events.jsonl` write** for that event (and records the sink failure), instead of dropping the only copy.
- Document exclusive-sink durability risk and the new local-fallback guarantee in config/docs surfaces that describe `event_sink.mode`.
- Optionally strengthen `events.jsonl` durability (fsync or documented O_APPEND atomic-line guarantees) toward loop-store parity when cost is acceptable; if deferred, document the residual durability gap.
- Add regression tests for `appendEvent` returning `false`, control-critical visibility, exclusive-sink fallback, restart/partial-write read behavior, and operator-surface warnings.
- Regenerate `plugin/` and keep `npm run ci` green.

## Capabilities

### New Capabilities

- `run-store-write-health`: Persist and expose per-run event-stream write-health (failure counts, last error, criticality class of failed writes) so status/doctor/summary and recovery consumers can observe mid-run append loss without requiring stage abortion.

### Modified Capabilities

- `events-jsonl-streaming`: Append path records write-health on failure; readers and finalize paths expose partial/failed stream state; optional durability hardening for `events.jsonl`.
- `configurable-event-sink`: Exclusive mode falls back to local write when sink delivery fails; document durability risk and fallback behavior.
- `evidence-bundle`: Finalized `summary.json` (and summary command output) includes event-stream write-health so a “green” run cannot hide empty/truncated audit.
- `machine-readable-status`: Status JSON (and prose status) surfaces event-stream write failure for the active/latest run.
- `doctor-preflight`: Doctor reports run-store write-path / recent write-health problems with remediation text and non-zero exit when applicable.
- `autonomous-recovery-controller`: Failure to durably record or retrieve control-critical blocker/recovery/terminal records is operator-visible and fail-safe — it MUST NOT invent an unrelated recovery class or human hold from missing evidence.

## Impact

- `core/scripts/run-store.ts` (append path, write-health artifact, exclusive-sink fallback, finalize enrichment)
- Call sites that append control-critical events (blocker, recovery, stage diagnostic, loop terminal) — may inspect `appendEvent` result or rely on write-health rather than `.catch(() => {})` silence
- Status / doctor / summary command surfaces and their JSON envelopes
- Event-sink delivery path and config/docs for `event_sink.mode`
- Unit tests under `core/test/` with injectable `RunStoreDeps` (no real network/git/subprocess)
- Generated `plugin/` mirror after core edits

## Acceptance criteria

- [ ] When `appendEvent` fails to durably deliver a local or exclusive-sink event, the run retains a durable **write-health** record (not only stderr) identifying that the event stream failed mid-run.
- [ ] `pipeline <issue> --status` (prose) and `pipeline <issue> --status --json` surface an event-stream / write-health warning when the latest run has recorded append failures.
- [ ] `pipeline doctor` surfaces run-store write-path or recent write-health failure with remediation text and exits non-zero when that check fails.
- [ ] `pipeline summary` (and finalized `summary.json`) include write-health so operators can detect empty or truncated evidence after an otherwise successful stage outcome.
- [ ] Control-critical records (blocker diagnostics / `blocker_set`, recovery claim and result, loop terminal state) are classified distinctly from best-effort telemetry; a control-critical durability failure is operator-visible.
- [ ] A control-critical persistence or retrieval failure does **not** silently project into an unrelated recovery class, human hold, or false “recovered” outcome; fail-safe disposition is explicit and tested.
- [ ] Best-effort telemetry append failure still does **not** block stage advancement (labels remain source of truth for stage progress).
- [ ] Exclusive sink mode: when sink delivery fails for an event, a local `events.jsonl` write is attempted for that event and the sink failure is recorded in write-health.
- [ ] Exclusive-sink durability risk and local-fallback behavior are documented wherever `event_sink.mode` is described to operators.
- [ ] Readers tolerate partial/corrupt tail lines and restart after mid-write failure without throwing; tests cover partial-write and restart cases.
- [ ] Unit tests prove: `appendEvent` returning `false` becomes visible on status/doctor/summary paths; exclusive-sink fallback; control-critical vs best-effort distinction; recovery does not misclassify on missing control records.
- [ ] `npm run ci` is green and `plugin/` is regenerated in the same change as any `core/` edits.
