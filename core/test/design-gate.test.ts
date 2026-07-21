// Pure-logic tests for the risk-triggered design-interrogation gate (#436):
// deterministic trigger evaluation, decision-record validation/bounding/
// redaction, challenge identity + blocking partition, and conservative
// verdict/response parsing. No network/git/subprocess access anywhere here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boundDesignDecisionRecord,
  challengeKey,
  decodeDesignGateState,
  DESIGN_DECISION_RECORD_SCHEMA_VERSION,
  DesignRecordLimitsError,
  encodeDesignGateState,
  evaluateDesignGateTrigger,
  isBlockingChallenge,
  parseDesignDecisionRecord,
  parseDesignResponses,
  parseDesignVerdict,
  redactDesignDecisionRecord,
  validateDesignDecisionRecord,
} from "../scripts/design-gate.ts";
import type { DesignChallenge, DesignDecisionRecord, DesignGateState } from "../scripts/types.ts";

const DISABLED_CFG = { design_gate: { enabled: false, triggers: [], extra_triggers: {} } } as any;
const ENABLED_ALL = {
  design_gate: {
    enabled: true,
    triggers: ["concurrency", "storage", "auth", "migration", "infrastructure", "public-api", "architecture"],
    extra_triggers: {},
  },
} as any;

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

test("evaluateDesignGateTrigger: disabled — gate-disabled, no matches", () => {
  const result = evaluateDesignGateTrigger(DISABLED_CFG, {
    changedFiles: ["src/auth/session.ts"],
    labels: [],
    diffAdditions: 0,
    diffDeletions: 0,
  });
  assert.equal(result.triggered, false);
  assert.equal(result.reason, "gate-disabled");
  assert.deepEqual(result.matched, []);
});

test("evaluateDesignGateTrigger: enabled, no match — no-trigger-matched", () => {
  const result = evaluateDesignGateTrigger(ENABLED_ALL, {
    changedFiles: ["README.md"],
    labels: [],
    diffAdditions: 5,
    diffDeletions: 1,
  });
  assert.equal(result.triggered, false);
  assert.equal(result.reason, "no-trigger-matched");
});

test("evaluateDesignGateTrigger: storage class matches a changed path", () => {
  const result = evaluateDesignGateTrigger(ENABLED_ALL, {
    changedFiles: ["db/migrations/0001_init.sql"],
    labels: [],
    diffAdditions: 10,
    diffDeletions: 0,
  });
  assert.equal(result.triggered, true);
  assert.ok(result.matched.some((m) => m.trigger === "storage" || m.trigger === "migration"));
});

test("evaluateDesignGateTrigger: each built-in class matches its representative path", () => {
  const cases: [string, string][] = [
    ["concurrency", "src/scheduler/worker.ts"],
    ["storage", "src/db/repository.ts"],
    ["auth", "src/auth/session.ts"],
    ["migration", "db/migrations/0002_add_col.sql"],
    ["infrastructure", "infra/Dockerfile"],
    ["public-api", "src/api/routes.ts"],
    ["architecture", "docs/ARCHITECTURE.md"],
  ];
  for (const [cls, file] of cases) {
    const cfg = { design_gate: { enabled: true, triggers: [cls], extra_triggers: {} } } as any;
    const result = evaluateDesignGateTrigger(cfg, { changedFiles: [file], labels: [], diffAdditions: 0, diffDeletions: 0 });
    assert.equal(result.triggered, true, `expected ${cls} to trigger on ${file}`);
    assert.ok(result.matched.some((m) => m.trigger === cls), `expected matched to include ${cls}`);
  }
});

test("evaluateDesignGateTrigger: architecture class matches on changed-file-count threshold", () => {
  const cfg = { design_gate: { enabled: true, triggers: ["architecture"], extra_triggers: {} } } as any;
  const files = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
  const result = evaluateDesignGateTrigger(cfg, { changedFiles: files, labels: [], diffAdditions: 0, diffDeletions: 0 });
  assert.equal(result.triggered, true);
  assert.ok(result.matched.some((m) => m.trigger === "architecture"));
});

test("evaluateDesignGateTrigger: label match fires the named trigger class", () => {
  const cfg = { design_gate: { enabled: true, triggers: ["auth"], extra_triggers: {} } } as any;
  const result = evaluateDesignGateTrigger(cfg, { changedFiles: ["src/whatever.ts"], labels: ["auth"], diffAdditions: 0, diffDeletions: 0 });
  assert.equal(result.triggered, true);
});

test("evaluateDesignGateTrigger: extra_triggers merges additional globs into a class", () => {
  const cfg = {
    design_gate: { enabled: true, triggers: ["storage"], extra_triggers: { storage: ["**/*warehouse*.*"] } },
  } as any;
  const result = evaluateDesignGateTrigger(cfg, { changedFiles: ["src/warehouse_client.ts"], labels: [], diffAdditions: 0, diffDeletions: 0 });
  assert.equal(result.triggered, true);
});

test("evaluateDesignGateTrigger: repeat-call determinism", () => {
  const inputs = { changedFiles: ["src/auth/session.ts", "README.md"], labels: ["storage"], diffAdditions: 3, diffDeletions: 1 };
  const first = evaluateDesignGateTrigger(ENABLED_ALL, inputs);
  const second = evaluateDesignGateTrigger(ENABLED_ALL, inputs);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// Decision record validation
// ---------------------------------------------------------------------------

function validRecord(): DesignDecisionRecord {
  return {
    schema_version: DESIGN_DECISION_RECORD_SCHEMA_VERSION,
    decisions: [
      {
        id: "d1",
        title: "Lock granularity",
        surface: "src/lock.ts",
        alternatives: [{ option: "global lock", rejected_because: "kills throughput" }],
        assumptions: ["single writer per shard"],
        invariants: ["shard id is stable"],
        evidence: ["src/lock.ts:42 shows per-shard mutex"],
        generalization_boundary: "only holds for single-region deployment",
        uncertainty: "medium — would be falsified by multi-region rollout",
      },
    ],
  };
}

test("validateDesignDecisionRecord: valid record accepted", () => {
  const result = validateDesignDecisionRecord(validRecord());
  assert.equal(result.ok, true);
});

test("validateDesignDecisionRecord: missing required field is rejected", () => {
  const record = validRecord();
  delete (record.decisions[0] as any).generalization_boundary;
  const result = validateDesignDecisionRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("generalization_boundary")));
});

test("validateDesignDecisionRecord: empty alternatives is rejected", () => {
  const record = validRecord();
  record.decisions[0].alternatives = [];
  const result = validateDesignDecisionRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("alternatives")));
});

test("validateDesignDecisionRecord: unknown schema_version is refused", () => {
  const record = { ...validRecord(), schema_version: 2 };
  const result = validateDesignDecisionRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("schema_version")));
});

test("parseDesignDecisionRecord: extracts a fenced JSON record and validates it", () => {
  const output = "Here you go:\n```json\n" + JSON.stringify(validRecord()) + "\n```\n";
  const { record, errors } = parseDesignDecisionRecord(output);
  assert.ok(record);
  assert.equal(errors.length, 0);
  assert.equal(record!.decisions[0].id, "d1");
});

test("parseDesignDecisionRecord: malformed output yields null record with errors", () => {
  const { record, errors } = parseDesignDecisionRecord("not json at all");
  assert.equal(record, null);
  assert.ok(errors.length > 0);
});

// ---------------------------------------------------------------------------
// Bounding / truncation
// ---------------------------------------------------------------------------

test("boundDesignDecisionRecord: over-long field truncated with a marker", () => {
  const record = validRecord();
  record.decisions[0].uncertainty = "x".repeat(100);
  const { record: bounded, bounding } = boundDesignDecisionRecord(record, {
    max_decisions: 8,
    max_field_chars: 10,
    max_artifact_bytes: 1_000_000,
  });
  assert.ok(bounded.decisions[0].uncertainty.endsWith("…[truncated]"));
  assert.ok(bounding.fieldsTruncated > 0);
});

test("boundDesignDecisionRecord: excess decisions are dropped and counted", () => {
  const record = validRecord();
  record.decisions = [record.decisions[0], { ...record.decisions[0], id: "d2" }, { ...record.decisions[0], id: "d3" }];
  const { record: bounded, bounding } = boundDesignDecisionRecord(record, {
    max_decisions: 1,
    max_field_chars: 4000,
    max_artifact_bytes: 1_000_000,
  });
  assert.equal(bounded.decisions.length, 1);
  assert.equal(bounding.decisionsDropped, 2);
});

test("boundDesignDecisionRecord: artifact byte ceiling honored", () => {
  const record = validRecord();
  record.decisions = Array.from({ length: 8 }, (_, i) => ({ ...record.decisions[0], id: `d${i}` }));
  const { record: bounded, bounding } = boundDesignDecisionRecord(record, {
    max_decisions: 8,
    max_field_chars: 4000,
    max_artifact_bytes: 500,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 500);
  assert.equal(bounding.artifactBytesTruncated, true);
});

test("boundDesignDecisionRecord: byte ceiling honored even with large alternatives/assumptions on a single decision", () => {
  const record = validRecord();
  record.decisions[0].alternatives = Array.from({ length: 20 }, (_, i) => ({
    option: `option ${i} `.repeat(50),
    rejected_because: `rejected because ${i} `.repeat(50),
  }));
  record.decisions[0].assumptions = Array.from({ length: 20 }, (_, i) => `assumption ${i} `.repeat(50));
  record.decisions[0].invariants = Array.from({ length: 20 }, (_, i) => `invariant ${i} `.repeat(50));
  const { record: bounded, bounding } = boundDesignDecisionRecord(record, {
    max_decisions: 8,
    max_field_chars: 4000,
    max_artifact_bytes: 500,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 500);
  assert.equal(bounding.artifactBytesTruncated, true);
});

test("boundDesignDecisionRecord: truncated field never exceeds max_field_chars including the marker", () => {
  const record = validRecord();
  record.decisions[0].uncertainty = "x".repeat(100);
  const { record: bounded } = boundDesignDecisionRecord(record, {
    max_decisions: 8,
    max_field_chars: 20,
    max_artifact_bytes: 1_000_000,
  });
  assert.ok(bounded.decisions[0].uncertainty.length <= 20);
  assert.ok(bounded.decisions[0].uncertainty.endsWith("…[truncated]"));
});

test("boundDesignDecisionRecord: throws when max_artifact_bytes is too small to encode a minimal record", () => {
  const record = validRecord();
  assert.throws(
    () =>
      boundDesignDecisionRecord(record, {
        max_decisions: 8,
        max_field_chars: 4000,
        max_artifact_bytes: 10,
      }),
    DesignRecordLimitsError,
  );
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("redactDesignDecisionRecord: secret-looking evidence is redacted", () => {
  const record = validRecord();
  record.decisions[0].evidence = ["AWS_SECRET_ACCESS_KEY=abcd1234efgh5678ijkl"];
  const redacted = redactDesignDecisionRecord(record);
  assert.ok(!redacted.decisions[0].evidence[0].includes("abcd1234efgh5678ijkl"));
});

// ---------------------------------------------------------------------------
// Challenge identity + blocking partition
// ---------------------------------------------------------------------------

const POLICY = { block_threshold: "medium" as const, min_confidence: 0.6 };

function makeChallenge(overrides: Partial<DesignChallenge> = {}): DesignChallenge {
  return {
    decision_id: "d1",
    title: "Lock granularity may starve writers",
    severity: "high",
    confidence: 0.8,
    falsifier: "show a benchmark under contention",
    evidence_request: "benchmark results",
    required_action: "defend",
    ...overrides,
  };
}

test("challengeKey: reworded (case/punctuation) title at same decision/severity — same key", () => {
  const a = challengeKey(makeChallenge({ title: "Lock granularity may starve writers" }));
  const b = challengeKey(makeChallenge({ title: "**Lock granularity may starve writers**..." }));
  assert.equal(a, b);
});

test("challengeKey: different decision or severity — different key", () => {
  const base = challengeKey(makeChallenge());
  const diffDecision = challengeKey(makeChallenge({ decision_id: "d2" }));
  const diffSeverity = challengeKey(makeChallenge({ severity: "low" }));
  assert.notEqual(base, diffDecision);
  assert.notEqual(base, diffSeverity);
});

test("isBlockingChallenge: severity/confidence policy gate", () => {
  assert.equal(isBlockingChallenge(makeChallenge({ severity: "high", confidence: 0.8 }), POLICY), true);
  assert.equal(isBlockingChallenge(makeChallenge({ severity: "low", confidence: 0.9 }), POLICY), false);
  assert.equal(isBlockingChallenge(makeChallenge({ severity: "critical", confidence: 0.3 }), POLICY), false);
});

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

function makeVerdictJson(count: number): string {
  const challenges = Array.from({ length: count }, (_, i) => ({
    decision_id: "d1",
    title: `Challenge ${i}`,
    severity: "medium",
    confidence: 0.7,
    falsifier: "x",
    evidence_request: "y",
    required_action: "defend",
  }));
  return "```json\n" + JSON.stringify({ verdict: "needs-attention", challenges }) + "\n```";
}

test("parseDesignVerdict: clean approval parses", () => {
  const verdict = parseDesignVerdict("```json\n" + JSON.stringify({ verdict: "approve", challenges: [] }) + "\n```");
  assert.ok(verdict);
  assert.equal(verdict!.verdict, "approve");
  assert.equal(verdict!.challenges.length, 0);
});

test("parseDesignVerdict: 3-7 challenge band accepted", () => {
  for (const n of [3, 5, 7]) {
    const verdict = parseDesignVerdict(makeVerdictJson(n));
    assert.ok(verdict, `expected ${n} challenges to parse`);
    assert.equal(verdict!.challenges.length, n);
  }
});

test("parseDesignVerdict: challenge count outside 3-7 band is malformed", () => {
  assert.equal(parseDesignVerdict(makeVerdictJson(2)), null);
  assert.equal(parseDesignVerdict(makeVerdictJson(8)), null);
});

test("parseDesignVerdict: unparseable output returns null, never an approval", () => {
  assert.equal(parseDesignVerdict("not json"), null);
  assert.equal(parseDesignVerdict("```json\n{\"verdict\": \"approve\", \"challenges\": [{}]}\n```"), null);
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

test("parseDesignResponses: valid responses + revised record parsed", () => {
  const payload = {
    responses: [{ challengeKey: "abcd1234", disposition: "defended", evidence: "see benchmark.md" }],
    decision_record: validRecord(),
  };
  const result = parseDesignResponses("```json\n" + JSON.stringify(payload) + "\n```");
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].disposition, "defended");
  assert.ok(result.revisedRecord);
});

test("parseDesignResponses: disposition with empty evidence is rejected", () => {
  const payload = {
    responses: [{ challengeKey: "abcd1234", disposition: "defended", evidence: "" }],
    decision_record: validRecord(),
  };
  const result = parseDesignResponses("```json\n" + JSON.stringify(payload) + "\n```");
  assert.equal(result.responses.length, 0);
});

test("parseDesignResponses: malformed output never throws, returns empty", () => {
  const result = parseDesignResponses("garbage");
  assert.deepEqual(result.responses, []);
  assert.equal(result.revisedRecord, null);
});

// ---------------------------------------------------------------------------
// State artifact codec
// ---------------------------------------------------------------------------

test("encodeDesignGateState / decodeDesignGateState round-trip", () => {
  const state: DesignGateState = {
    schema_version: 1,
    trigger: { triggered: true, matched: [{ trigger: "storage", evidence: "path" }], reason: "triggered" },
    reviewerIdentity: { harness: "codex", independence: "independent" },
    decisionRecordVersions: [validRecord()],
    bounding: { fieldsTruncated: 0, decisionsDropped: 0, artifactBytesTruncated: false },
    rounds: [],
    outcome: null,
  };
  const comment = `## Design Interrogation\n\nsome text\n\n${encodeDesignGateState(state)}`;
  const decoded = decodeDesignGateState(comment);
  assert.deepEqual(decoded, state);
});

test("decodeDesignGateState: absent or malformed artifact returns null", () => {
  assert.equal(decodeDesignGateState("no artifact here"), null);
  assert.equal(decodeDesignGateState("<!-- design-gate-state: !!!not-base64!!! -->"), null);
});
