# Tasks — harness actual-cost capture

## 1. Telemetry envelope parsing

- [x] 1.1 Add a pure `parseHarnessTelemetry(harness, capturedStdout)` helper in
      `core/scripts/harness.ts` (or a small sibling module) returning
      `{ text: string | null, costUsd: number | null, usage: {...} | null }`.
- [x] 1.2 Implement the `claude` shape: last `{"type":"result"}` line →
      `result` text, `total_cost_usd`, `usage` token counters.
- [x] 1.3 Implement the `codex` shape: last `agent_message` item text and
      `turn.completed.usage` token counters; no cost field.
- [x] 1.4 Return a null/empty result for absent, truncated, or non-JSON output —
      never throw.
- [x] 1.5 Unit-test the parser against recorded fixture lines for both harnesses:
      success, truncated final line, interleaved non-JSON noise, empty input.

## 2. Invocation + streaming

- [x] 2.1 Switch `claude` argv to
      `--print --verbose --output-format stream-json --include-partial-messages`
      (keeping `--tools ""`/`--strict-mcp-config`, `--model`, `--effort`, and the
      prompt positional), and `codex` argv to add `--json`.
- [x] 2.2 Add the `PIPELINE_HARNESS_TELEMETRY=off` kill-switch restoring the previous
      plain-text argv for both built-in harnesses; leave custom `review_harness` argv
      untouched.
- [x] 2.3 Forward only assistant text to the terminal when streaming, not raw envelope
      lines; keep the existing `forwardTo` / forward-error diagnostic behavior (#384)
      intact.
- [x] 2.4 Set `HarnessResult.stdout` to the parsed final assistant text when parsing
      succeeds; fall back to the raw captured output when it does not.
- [x] 2.5 Test via the injectable `spawnFn` + `forwardTo` seams: verdict-JSON stdout is
      preserved, envelope JSON is not forwarded, and a spawn/timeout path is unaffected.

## 3. Accounting wiring

- [x] 3.1 Feed the parsed telemetry into `buildStageAccountingRecord` as
      `accounting.usage`, so an actual cost classifies as `cost_source: "actual"`.
- [x] 3.2 Confirm the allowlist in `extractUsageAccounting` drops `session_id`, `uuid`,
      `parent_tool_use_id`, `result` text, and rate-limit objects; extend the
      allowlist only for the verified numeric counters that are genuinely missing.
- [x] 3.3 Test that a claude envelope produces `cost_source: "actual"` with the reported
      cost, and that a codex envelope produces token `usage` with a non-`actual`
      cost source.
- [x] 3.4 Test that a record built from an envelope containing a secret-looking string
      persists no raw secret and no assistant text.

## 4. Schema version

- [x] 4.1 Bump `STAGE_ACCOUNTING_SCHEMA_VERSION` to `2` in `core/scripts/accounting.ts`.
- [x] 4.2 Audit readers (`scoreboard.ts`, `stages/queue.ts`, summary/evidence paths) for
      any `schema_version` equality check and remove/loosen it.
- [x] 4.3 Test that a mixed set of version-`1` and version-`2` records aggregates fully
      with no dropped records and no schema diagnostics.

## 5. Scoreboard coverage

- [x] 5.1 Compute per-source call counts and `actual_coverage` (null when the
      denominator is zero) in `core/scripts/scoreboard.ts`.
- [x] 5.2 Emit coverage in the `--json` report under the cost/accounting metrics.
- [x] 5.3 Print the coverage line in the human-readable cost/accounting section.
- [x] 5.4 Test JSON and human coverage output, including the empty-window null case, and
      assert existing cost totals / `cost_per_ready_pr_usd` values are unchanged.

## 6. Close out

- [x] 6.1 Update `README`/skill docs only where they describe harness output mode or
      scoreboard cost reporting.
- [x] 6.2 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [x] 6.3 Run `npm run ci` from the repo root and confirm it is green.
