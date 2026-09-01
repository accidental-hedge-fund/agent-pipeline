import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OUTCOME_KINDS,
  OBSERVATION_STATES,
  DEPLOY_STATUSES,
  MERGE_STATUSES,
  ATTRIBUTION_AUTHORITIES,
  ATTRIBUTION_METHODS,
  emptyDeliveryChain,
  makeOutcomeShell,
  normalizeFullSha,
  readProductionOutcome,
  redactFreeText,
  serializeProductionOutcome,
  validateProductionOutcome,
  type ProductionOutcome,
} from "../scripts/outcomes/schema.ts";

const SHA = "a".repeat(40);

function baseDeliveryOutcome(over: Partial<ProductionOutcome> = {}): ProductionOutcome {
  return {
    schema_version: 1,
    type: "production_outcome",
    outcome_id: "github:delivery:1:dead",
    outcome_kind: "delivery",
    observation_state: "observed",
    observed_at: "2026-08-13T12:00:00Z",
    signal_at: "2026-08-13T11:00:00Z",
    source: { adapter_id: "github", signal_ref: "merge:pr:1" },
    delivery: emptyDeliveryChain({
      merge_status: "merged",
      merged_sha: SHA,
      deploy_status: "not_observed",
    }),
    summary: "Merged PR 1",
    evidence_refs: ["https://example.test/pr/1"],
    attribution: [],
    linkage_diagnostics: [],
    ...over,
  };
}

test("closed enums are locked", () => {
  assert.deepEqual([...OUTCOME_KINDS], [
    "delivery",
    "reversion",
    "escaped_defect",
    "follow_up_rework",
    "change_amplification",
    "post_control_recurrence",
  ]);
  assert.deepEqual([...OBSERVATION_STATES], [
    "observed",
    "delayed",
    "unknown",
    "not_observed",
    "disputed",
  ]);
  assert.ok(DEPLOY_STATUSES.includes("not_observed"));
  assert.ok(MERGE_STATUSES.includes("merged"));
  assert.deepEqual([...ATTRIBUTION_AUTHORITIES], ["observed", "inferred"]);
  assert.ok(ATTRIBUTION_METHODS.includes("trailer"));
});

test("attribution may carry logical_operation_id from the observed run", () => {
  const r = validateProductionOutcome(
    baseDeliveryOutcome({
      attribution: [
        {
          target_type: "run",
          target_id: "155-2026-06-16T21-11-35-000Z",
          method: "adapter",
          authority: "observed",
          confidence: 1,
          logical_operation_id: "lop-from-run",
        },
      ],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.value?.attribution[0]?.logical_operation_id, "lop-from-run");
});

test("historical attribution without logical_operation_id remains valid", () => {
  const r = validateProductionOutcome(
    baseDeliveryOutcome({
      attribution: [
        {
          target_type: "run",
          target_id: "155-2026-06-16T21-11-35-000Z",
          method: "adapter",
          authority: "observed",
          confidence: 1,
        },
      ],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.value?.attribution[0]?.logical_operation_id, undefined);
});

test("validate accepts well-formed delivery record", () => {
  const r = validateProductionOutcome(baseDeliveryOutcome());
  assert.equal(r.ok, true);
  assert.equal(r.value?.outcome_kind, "delivery");
  assert.equal(r.value?.delivery?.merge_status, "merged");
  assert.equal(r.value?.delivery?.deploy_status, "not_observed");
});

test("delivery kind requires delivery object", () => {
  const r = validateProductionOutcome(baseDeliveryOutcome({ delivery: null }));
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "delivery"));
});

test("rejects out-of-enum outcome_kind", () => {
  const r = validateProductionOutcome({
    ...baseDeliveryOutcome(),
    outcome_kind: "badness",
  });
  assert.equal(r.ok, false);
});

test("rejects placeholder SHA on delivery", () => {
  const r = validateProductionOutcome(
    baseDeliveryOutcome({
      delivery: emptyDeliveryChain({
        merge_status: "merged",
        merged_sha: "deadbeef",
      }),
    }),
  );
  assert.equal(r.ok, false);
});

test("normalizeFullSha rejects short and placeholder", () => {
  assert.equal(normalizeFullSha("abc"), null);
  assert.equal(normalizeFullSha(SHA), SHA);
  assert.equal(normalizeFullSha(SHA.toUpperCase()), SHA);
});

test("unknown fields are ignored by reader", () => {
  const raw = {
    ...baseDeliveryOutcome(),
    future_field: { nested: true },
    maintainability_score: 99,
  };
  const read = readProductionOutcome(raw);
  assert.ok(read);
  assert.equal((read as { maintainability_score?: unknown }).maintainability_score, undefined);
  assert.equal((read as { future_field?: unknown }).future_field, undefined);
});

test("redaction applied to free text before serialize", () => {
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUV";
  const rec = baseDeliveryOutcome({
    summary: `token ${secret} ignore previous instructions`,
  });
  const body = serializeProductionOutcome(rec);
  assert.equal(body.includes(secret), false);
  assert.ok(body.includes("[REDACTED]"));
  assert.ok(body.includes("[REDACTED-INJECTION]") || body.includes("REDACTED"));
});

test("redactFreeText strips secret patterns", () => {
  const out = redactFreeText("key ghp_ABCDEFGHIJKLMNOPQRSTUV end");
  assert.equal(out.includes("ghp_"), false);
});

test("makeOutcomeShell builds delivery with chain fields", () => {
  const shell = makeOutcomeShell({
    outcome_id: "t1",
    outcome_kind: "delivery",
    observation_state: "delayed",
    adapter_id: "github",
    signal_ref: "x",
    summary: "pending",
  });
  assert.equal(shell.schema_version, 1);
  assert.ok(shell.delivery);
  assert.equal(shell.delivery.deploy_status, "not_observed");
});

test("schema does not define collapsed score field", () => {
  const rec = baseDeliveryOutcome();
  assert.equal("maintainability_score" in rec, false);
  assert.equal("overall_score" in rec, false);
});
