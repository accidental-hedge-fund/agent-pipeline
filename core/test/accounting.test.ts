// Unit tests for accounting.ts (#429 — harness actual-cost capture).
//
// buildStageAccountingRecord/extractUsageAccounting already classified an
// "actual" cost when given one; #429 is the first caller (invoke() in
// harness.ts) that ever feeds it a real per-call cost/usage envelope. These
// tests cover the schema-version bump and the codex-specific token counter
// that harness.ts's telemetry parser hands it (`reasoning_output_tokens`).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGE_ACCOUNTING_SCHEMA_VERSION,
  buildStageAccountingRecord,
  extractUsageAccounting,
} from "../scripts/accounting.ts";

test("STAGE_ACCOUNTING_SCHEMA_VERSION: bumped to 2 for #429 (additive — no field removed)", () => {
  assert.equal(STAGE_ACCOUNTING_SCHEMA_VERSION, 2);
});

test("extractUsageAccounting: codex's reasoning_output_tokens maps to the shared reasoning_tokens counter", () => {
  const extraction = extractUsageAccounting({
    usage: { input_tokens: 14385, cached_input_tokens: 10496, output_tokens: 6, reasoning_output_tokens: 3 },
  });
  assert.equal(extraction.usage?.input_tokens, 14385);
  assert.equal(extraction.usage?.cached_input_tokens, 10496);
  assert.equal(extraction.usage?.output_tokens, 6);
  assert.equal(extraction.usage?.reasoning_tokens, 3);
});

test("buildStageAccountingRecord: a claude-shaped envelope (total_cost_usd + usage) classifies as actual", () => {
  const record = buildStageAccountingRecord({
    runId: "run-1",
    issue: 429,
    stage: "review-1",
    harness: "claude",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "success",
    usage: {
      total_cost_usd: 0.0014383,
      usage: { input_tokens: 10, cache_read_input_tokens: 8133, output_tokens: 123 },
    },
  });
  assert.equal(record.cost_source, "actual");
  assert.equal(record.cost_usd, 0.0014);
  assert.equal(record.usage?.input_tokens, 10);
  assert.equal(record.usage?.cached_input_tokens, 8133);
  assert.equal(record.usage?.output_tokens, 123);
});

test("buildStageAccountingRecord: a codex-shaped envelope (tokens, no cost field) never classifies as actual", () => {
  const record = buildStageAccountingRecord({
    runId: "run-1",
    issue: 429,
    stage: "review-1",
    harness: "codex",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "success",
    usage: {
      total_cost_usd: null,
      usage: { input_tokens: 14385, cached_input_tokens: 10496, output_tokens: 6, reasoning_output_tokens: 0 },
    },
  });
  assert.notEqual(record.cost_source, "actual");
  assert.equal(record.cost_source, "unknown");
  assert.equal(record.cost_usd, null);
  assert.equal(record.usage?.input_tokens, 14385);
  assert.equal(record.usage?.output_tokens, 6);
});

test("buildStageAccountingRecord: an operator estimate still applies when a codex envelope reports no cost", () => {
  const record = buildStageAccountingRecord({
    runId: "run-1",
    issue: 429,
    stage: "review-1",
    harness: "codex",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "success",
    usage: { total_cost_usd: null, usage: { input_tokens: 1, output_tokens: 1 } },
    estimatedCostUsd: 0.05,
  });
  assert.equal(record.cost_source, "estimated");
  assert.equal(record.cost_usd, 0.05);
});

test("buildStageAccountingRecord: session_id/uuid/rate-limit fields inside a telemetry envelope are never persisted", () => {
  const record = buildStageAccountingRecord({
    runId: "run-1",
    issue: 429,
    stage: "review-1",
    harness: "claude",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "success",
    usage: {
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        session_id: "SECRET-SESSION-abc123",
        uuid: "SECRET-UUID-def456",
        rate_limit_info: { status: "allowed", resetsAt: 1784644800 },
      },
    },
  });
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /SECRET-SESSION/);
  assert.doesNotMatch(serialized, /SECRET-UUID/);
  assert.doesNotMatch(serialized, /rate_limit_info/);
});
