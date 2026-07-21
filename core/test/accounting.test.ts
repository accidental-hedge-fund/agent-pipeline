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
  sanitizeStageAccountingRecord,
} from "../scripts/accounting.ts";

test("STAGE_ACCOUNTING_SCHEMA_VERSION: bumped to 4 for #431 harness-adapter provenance (additive — no field removed)", () => {
  assert.equal(STAGE_ACCOUNTING_SCHEMA_VERSION, 4);
});

test("buildStageAccountingRecord: harness-adapter provenance fields are carried when present (#431)", () => {
  const record = buildStageAccountingRecord({
    runId: "run-1",
    issue: 431,
    stage: "implementing",
    harness: "grok",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "success",
    adapter: "grok",
    adapterCliVersion: "0.2.93",
    providerAuthClass: "oauth:xai",
    requestedModel: "grok-4",
    resolvedModel: null,
    requestedEffort: "high",
    resolvedEffort: null,
    nativeFlags: ["-m", "--reasoning-effort"],
    fallback: null,
    throttled: null,
    terminationReason: "success",
  });
  assert.equal(record.adapter, "grok");
  assert.equal(record.adapter_cli_version, "0.2.93");
  assert.equal(record.provider_auth_class, "oauth:xai");
  assert.equal(record.requested_model, "grok-4");
  assert.equal(record.resolved_model, undefined, "unknown resolved_model must be omitted, never fabricated");
  assert.equal(record.requested_effort, "high");
  assert.equal(record.resolved_effort, undefined);
  assert.deepEqual(record.native_flags, ["-m", "--reasoning-effort"]);
  assert.equal(record.fallback, undefined, "unknown fallback must be omitted, never a fabricated false");
  assert.equal(record.throttled, undefined);
  assert.equal(record.termination_reason, "success");
});

test("buildStageAccountingRecord: a real false/true fallback/throttled value round-trips through sanitize (#431)", () => {
  const record = buildStageAccountingRecord({
    runId: "run-1",
    issue: 431,
    stage: "implementing",
    harness: "claude",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "success",
    fallback: false,
    throttled: true,
  });
  assert.equal(record.fallback, false);
  assert.equal(record.throttled, true);
  const roundTripped = sanitizeStageAccountingRecord(record);
  assert.equal(roundTripped.fallback, false);
  assert.equal(roundTripped.throttled, true);
});

test("sanitizeStageAccountingRecord: a record predating adapter provenance fields parses with them absent (#431)", () => {
  const legacy = sanitizeStageAccountingRecord({
    schema_version: 3,
    run_id: "run-1",
    issue: 437,
    stage: "planning",
    harness: "claude",
    model_slot: null,
    model: null,
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 1000,
    command_count: 1,
    subprocess_count: 1,
    outcome: "success",
    blocker_kind: null,
    cost_source: "unknown",
    cost_usd: null,
  });
  assert.equal(legacy.adapter, undefined);
  assert.equal(legacy.fallback, undefined);
  assert.equal(legacy.throttled, undefined);
});

test("buildStageAccountingRecord: a resolved effort is carried verbatim (#437)", () => {
  const record = buildStageAccountingRecord({
    runId: "run-1",
    issue: 437,
    stage: "planning",
    harness: "claude",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "success",
    effort: "high",
  });
  assert.equal(record.effort, "high");
});

test("buildStageAccountingRecord: no resolved effort omits the field, not a fabricated default (#437)", () => {
  const record = buildStageAccountingRecord({
    runId: "run-1",
    issue: 437,
    stage: "planning",
    harness: "claude",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    outcome: "success",
  });
  assert.equal(record.effort, undefined);
  assert.ok(!("effort" in record));
});

test("sanitizeStageAccountingRecord: a pre-#437 record shape (no effort field) still parses unchanged", () => {
  const preChange = {
    schema_version: 2,
    run_id: "run-1",
    issue: 437,
    stage: "planning",
    harness: "claude",
    model_slot: null,
    model: null,
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 1000,
    command_count: 1,
    subprocess_count: 1,
    outcome: "success",
    blocker_kind: null,
    cost_source: "unknown" as const,
    cost_usd: null,
  };
  const cleaned = sanitizeStageAccountingRecord(preChange);
  assert.equal(cleaned.run_id, "run-1");
  assert.equal(cleaned.effort, undefined);
  assert.ok(!("effort" in cleaned));
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
