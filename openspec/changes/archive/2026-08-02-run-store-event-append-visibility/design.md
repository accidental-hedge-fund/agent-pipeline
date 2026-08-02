## Context

`appendEvent` in `core/scripts/run-store.ts` is best-effort: local I/O errors and sink delivery
failures are logged with `console.warn` and return `false`. Most stage call sites ignore the
boolean (often via `.catch(() => {})`). In `event_sink.mode: exclusive`, the local `events.jsonl`
write is skipped entirely, so a sink failure can drop the only copy of an event.

PR #787 elevated canonical `pipeline/stage-diagnostic@1` / `blocker_set` evidence and recovery
claims into control-plane inputs. Labels and prose cannot reconstruct authority or recovery
disposition. Silent event loss is therefore a recovery-correctness risk, not only an observability
gap. Labels remain the stage source of truth, so ordinary telemetry still must not abort stages.

Operators currently have no durable signal on status/doctor/summary that a run finished “green”
with an empty or truncated event stream.

## Goals / Non-Goals

**Goals:**

- Persist mid-run event-stream write failures in a durable, run-scoped write-health artifact.
- Classify appends as **control-critical** vs **best-effort** and treat control-critical loss as
  operator-visible and fail-safe for recovery.
- Surface write-health on status, doctor, and summary (prose + structured where available).
- Exclusive sink: fall back to local write when delivery fails; document the risk and the fallback.
- Preserve labels-as-SoT: best-effort telemetry failures never block stage advancement.
- Cover regressions with injectable `RunStoreDeps` unit tests (no real network/git/subprocess).

**Non-Goals:**

- Making every telemetry failure abort the stage or flip pipeline labels.
- Replacing the durable-loop store’s atomic+fsync document model for all run artifacts.
- Changing the `events.jsonl` `schema_version` or event field contracts for successful writes.
- Cross-host shared write-health (run-store remains host-local under `.agent-pipeline/runs/`).
- Redesigning external sink protocols or adding new sink transports.

## Decisions

1. **Durable write-health artifact per run (not only stderr).**
   On durable-delivery failure for an append, update a small host-local file in the run directory
   (e.g. `write-health.json` or an equivalent field merged into `run.json`/`summary.json` at
   finalize). The record SHALL carry at least: failure count, last failure timestamp, last error
   message (redacted/capped), last failed event `type`, criticality of the worst failed write, and
   whether exclusive-sink fallback was used. In-process memory may mirror this for the live run;
   the on-disk record is the restart/operator source of truth.

   Alternative: only `console.warn` + return false. Rejected — operators never see it after the
   run, and recovery cannot consult it after restart.

2. **Criticality class at the append API boundary.**
   Callers (or a thin typed wrapper) mark events as `control-critical` or `best-effort`.
   Control-critical types include at least: `blocker_set` / `blocker_cleared`, stage diagnostics
   used as recovery input, recovery claim/result events, and loop/run terminal state
   (`run_complete` and durable-loop terminal records routed through this path). All other current
   event types default to best-effort unless explicitly elevated.
   - Best-effort failure: record write-health; do not throw; stage continues.
   - Control-critical failure: record write-health with elevated severity; still do not abort the
     stage solely for I/O (labels remain SoT), but operator surfaces MUST warn, and recovery
     consumers MUST treat missing control evidence as fail-safe (unknown/engine-defect path), never
     as “no blocker” or an unrelated class.

   Alternative: make control-critical append throw and fail the stage. Rejected for this issue —
   out of scope per “must remain best-effort for labels-as-SoT”; visibility + fail-safe recovery is
   the required bar.

3. **Exclusive sink local fallback on delivery failure.**
   When `eventSinkMode === "exclusive"` and sink delivery fails, attempt a local `events.jsonl`
   append for that same line. Success of the local fallback counts as durable delivery for the
   boolean return when local succeeds; sink failure is still recorded in write-health. When both
   fail, return `false` and elevate write-health. Happy-path exclusive mode continues to skip local
   write when the sink succeeds.

   Alternative: always write local even in exclusive mode (make exclusive additive). Rejected as a
   broader product change; operators chose exclusive to avoid dual destinations. Fallback-only
   preserves the intent while closing the dual-loss hole.

4. **Operator surfaces.**
   - **Status**: prose warning line + additive JSON field (e.g. `event_stream_write_health`) on
     `--status --json`, schema_version remains `"1"`.
   - **Summary**: include write-health in `summary.json` and human summary output.
   - **Doctor**: add a deterministic check that (a) the configured run-store parent path is
     writable when resolvable, and/or (b) recent runs with elevated write-health failures are
     reported with remediation (inspect disk, sink command, re-run with additive mode). Failures
     contribute to doctor exit code 1 like other checks.

5. **Durability hardening (optional within this change).**
   Prefer documenting current O_APPEND single-line write guarantees and reader partial-tail
   tolerance first. If low-cost, add fsync after append (or open with sync) behind the existing
   deps seam so tests can still inject I/O. Do not adopt full temp+rename for every event line
   (that would break concurrent multi-writer append semantics and inflate cost). Residual gap vs
   loop-store whole-document fsync MUST be stated in design/docs if fsync is deferred.

6. **Recovery fail-safe on missing control evidence.**
   When the autonomous recovery controller (or equivalent) cannot retrieve a required
   control-critical record because of write-health failure or empty/truncated stream, it SHALL
   classify as a typed engine-owned defect / unknown diagnostic path already defined by recovery
   policy — not invent `human-decision-required`, not treat absence as “cleared,” and not pick an
   unrelated blocker class from labels/prose.

## Risks / Trade-offs

- **Write-health file itself can fail** → Mitigate with best-effort update + still emit stderr
  warning; status/summary treat “unreadable write-health with empty events after mid-run” as
  degraded. Do not throw from the append path solely for write-health I/O.
- **Callers that `.catch(() => {})` still ignore boolean** → Centralize write-health inside
  `appendEvent` so visibility does not depend on every call site. Control-critical callers may
  additionally log or attach context; they are not the only path to operator visibility.
- **Exclusive fallback reintroduces local disk use under failure** → Acceptable; document that
  exclusive mode is best-effort remote-only only while the sink is healthy.
- **fsync cost on high-frequency events** → Keep optional/measurable; default to current append if
  cost is unacceptable; never block the stage on fsync failure beyond write-health recording.
- **Additive JSON status fields** → Follow existing additive-field pattern; keep schema_version
  `"1"`.

## Migration Plan

Ship engine + regenerated `plugin/` together. No persisted schema migration for historical runs:
runs without write-health are treated as “unknown / not recorded” (no warning), not as failures.
Operators with exclusive sinks get local fallback automatically on the next engine version.
Rollback removes the surfaces and fallback; historical write-health files are inert if unread.

## Open Questions

- Exact on-disk filename and field names for write-health (implementer choice within the
  `run-store-write-health` capability, kept stable once shipped).
- Whether doctor scans only the latest run per issue or a bounded recent window — default to a
  small bounded scan of recent run directories under the resolved repo root.
- Whether control-critical list is a closed enum of event `type` strings or an explicit
  `criticality` argument on `appendEvent` — prefer explicit argument with defaults derived from
  type for safety.
