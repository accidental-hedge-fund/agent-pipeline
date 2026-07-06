# Tasks

## 1. Comment timing table (evidence-bundle)

- [x] 1.1 Add a pure `formatStageTimingTableMarkdown(bundle: EvidenceBundle): string` helper
      in `core/scripts/evidence-bundle.ts`, colocated with `formatSummary`, rendering one
      Markdown row per `bundle.stages[]` entry (stage, `enteredAt` → `exitedAt`, duration via
      the existing `formatDuration`, outcome). Reads only stage/timing/outcome fields.
- [x] 1.2 Update `notifyBundlePath()` in `core/scripts/pipeline-run.ts` to read the finalized
      bundle and build the comment body from: a visible **run id** field, the timing table,
      and the local path + `pipeline N --summary` hint demoted to secondary/optional context.
- [x] 1.3 Confirm the comment body draws no data from `commands`, `prompts`, `reviews`, or
      `accounting` (preserve the no-accounting-payload contract).
- [x] 1.4 Unit test: rendered Markdown has one row per stage, correct duration formatting, a
      visible run-id field, and contains no command/prompt/token/cost text. Prove the table
      renders fully from the bundle alone (no filesystem reads).
- [x] 1.5 Add a harness-invocation-duration column to `formatStageTimingTableMarkdown`,
      summing each stage's `StageAccountingRecord.duration_ms` (matched by stage name and the
      record's `started_at` falling inside that row's `enteredAt`→`exitedAt` window, so a
      stage name re-entered within one run is not double-counted across rows) — never the
      record's cost/token/model fields. `finalizeRun()` in `run-store.ts` mutates the passed
      bundle's `accounting` field so this data reaches `notifyBundlePath` via the same object
      reference, with no second events.jsonl read.

## 2. Issue-level append-only history (issue-evidence-history)

- [x] 2.1 Add a compact history-entry record type in `core/scripts/types.ts`
      (`run_id`, `issue`, `pr`, `branch`, `final_state`, `finalized_at`, and `stages[]` of
      `{ stage, enteredAt, exitedAt, durationMs, outcome }`), plus a `schema_version`.
- [x] 2.2 Add the issue-history path helper (`.agent-pipeline/history/issue-<N>.jsonl`) and an
      `appendIssueHistory(...)` writer that serializes one line through the same
      `sanitizeDeep` + `redactSecrets` + `sanitize` chain used for `summary.json`, using
      `appendFile` (create-on-first-write). Wrap in try/catch; log and swallow errors.
- [x] 2.3 Call the appender from `finalizeRun()` in `core/scripts/run-store.ts` after the
      summary.json and legacy evidence.json writes.
- [x] 2.4 Unit test (injected `RunStoreDeps` fakes): finalize twice for one issue → exactly
      two lines; each line is a valid entry with its own run id, per-stage timings, and
      outcome; the first line is byte-identical after the second finalize (append, not
      rewrite). N finalizes → exactly N entries.
- [x] 2.5 Unit test: a throwing `appendFile` is non-fatal — `finalizeRun` still completes and
      still writes summary.json/evidence.json.

## 3. Regression / legacy compatibility

- [x] 3.1 Confirm `<stateDir>/<issue>/evidence.json` is still written and read unchanged;
      `pipeline N --summary` behavior is unaffected. Add/keep a test asserting the legacy path
      still resolves.

## 4. Gate

- [x] 4.1 Regenerate the plugin mirror: `node scripts/build.mjs`.
- [x] 4.2 Run `npm run ci` from the repo root; ensure `ci:core`, mirror check, install-smoke,
      and `openspec validate --all` all pass.
