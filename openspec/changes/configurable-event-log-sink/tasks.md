## 1. Config schema

- [x] 1.1 Add a strict optional `event_sink` block to `PartialConfigSchema` in
  `core/scripts/config.ts` with `command` (string) and `mode` (`additive` | `exclusive`,
  default `additive`).
- [x] 1.2 Add `event_sink` to `DEFAULT_CONFIG` / resolved config with the sink unset by default.
- [x] 1.3 Apply environment-variable overrides `PIPELINE_EVENT_SINK_COMMAND` and
  `PIPELINE_EVENT_SINK_MODE` with env-over-file precedence; env absent → file value.
- [x] 1.4 Reject invalid config (unknown key, wrong type, `mode` outside the enum) with a
  fast schema error, consistent with existing block validation.

## 2. Event-sink seam

- [x] 2.1 Add an optional `eventSink?: (line: string) => void | Promise<void>` to
  `RunStoreDeps` in `core/scripts/run-store.ts`.
- [x] 2.2 In `appendEvent`, deliver the already-serialized event line to `deps.eventSink`
  when present; wrap delivery so any error is caught and logged as a non-fatal
  `[pipeline] run-store:` warning and never rejects.
- [x] 2.3 Gate the local `events.jsonl` append on mode: additive → append then deliver;
  exclusive → deliver only (skip the local append). Leave `run.json`, `terminal.log`, and
  `summary.json` behavior untouched.

## 3. Forwarder wiring

- [x] 3.1 Add a sink factory that builds an `eventSink` from the resolved `event_sink` config
  by invoking the operator's forwarder command with the event line on stdin; no-op factory
  (returns `undefined`) when no command is configured.
- [x] 3.2 Wire the sink into `runStoreDeps` in `core/scripts/pipeline-run.ts` alongside the
  existing `stdoutWrite` wiring so all event producers reach it.

## 4. Tests

- [x] 4.1 Config tests: `event_sink` parsed from file, env-var override precedence, default
  `additive`, invalid-mode and unknown-key rejection.
- [x] 4.2 `run-store` tests (fake `eventSink` dep, no real subprocess): additive delivers to
  both the local file and the sink; exclusive delivers to the sink and does not write
  `events.jsonl`; a throwing sink is non-fatal and, in additive mode, the local write still
  succeeds.
- [x] 4.3 Regression: with no sink configured, `appendEvent` output and `readEvents` are
  identical to current behavior (the test bites — fails if delivery/gating leaks into the
  unconfigured path).

## 5. Docs & mirror

- [x] 5.1 Document `event_sink` (command, mode, env vars, additive-vs-exclusive, non-fatal
  delivery) in the README and the config scaffold/comments.
- [x] 5.2 Regenerate the plugin mirror (`node scripts/build.mjs`) and commit it in the same change.
- [x] 5.3 Run `npm run ci` from the repo root (core tests + mirror check + install smoke +
  `openspec validate --all`) and confirm green.
