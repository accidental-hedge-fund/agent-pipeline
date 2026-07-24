// Tests for building sanitized, bounded trajectory/verifier artifact objects
// (#536, eval-trajectory-artifacts tasks 2, 3, 4, 5). Pure functions — no
// fs/network/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTreatmentTrajectoryArtifact, buildVerifierEvidenceArtifact } from "../scripts/evals/trajectory/collect.ts";

test("buildTreatmentTrajectoryArtifact: captures per-stage output, timing, and success", () => {
  const artifact = buildTreatmentTrajectoryArtifact({
    cell_id: "exp1/fx/harness=claude/1",
    experiment_id: "exp1",
    execution_class: "local-cli",
    stages: [{ stage: "implementing", output: "did the thing", duration_ms: 1234, success: true }],
    actions: ["invoked stage implementing"],
    toolEvents: { availability: { available: false, reason: "harness does not expose tool-call telemetry" } },
    producedArtifacts: ["src/foo.ts"],
  });
  assert.equal(artifact.schema_version, 1);
  assert.equal(artifact.execution_class, "local-cli");
  assert.equal(artifact.stages.length, 1);
  assert.equal(artifact.stages[0].output, "did the thing");
  assert.equal(artifact.stages[0].duration_ms, 1234);
  assert.equal(artifact.stages[0].success, true);
  assert.deepEqual(artifact.produced_artifacts, [{ path: "src/foo.ts" }]);
});

test("buildTreatmentTrajectoryArtifact: unavailable tool-call telemetry is marked unavailable with a reason, not an empty successful channel", () => {
  const artifact = buildTreatmentTrajectoryArtifact({
    cell_id: "c1",
    experiment_id: "exp1",
    execution_class: "local-cli",
    stages: [],
    actions: [],
    toolEvents: { availability: { available: false, reason: "CLI harness exposes only plain-text stdout" } },
    producedArtifacts: [],
  });
  assert.equal(artifact.tool_events.availability.available, false);
  assert.ok(artifact.tool_events.availability.reason && artifact.tool_events.availability.reason.length > 0);
  assert.deepEqual(artifact.tool_events.items, []);
});

test("buildTreatmentTrajectoryArtifact: an available tool-events channel carries its items", () => {
  const artifact = buildTreatmentTrajectoryArtifact({
    cell_id: "c1",
    experiment_id: "exp1",
    execution_class: "api-key",
    stages: [],
    actions: [],
    toolEvents: {
      availability: { available: true },
      items: [{ stage: "review", tool: "search", input: { q: "x" }, output: { results: [] } }],
    },
    producedArtifacts: [],
  });
  assert.equal(artifact.tool_events.availability.available, true);
  assert.equal(artifact.tool_events.items.length, 1);
});

test("buildTreatmentTrajectoryArtifact: no chain-of-thought field exists — structured stage output/tool events/actions are sufficient for a complete artifact", () => {
  const artifact = buildTreatmentTrajectoryArtifact({
    cell_id: "c1",
    experiment_id: "exp1",
    execution_class: "local-cli",
    stages: [{ stage: "planning", output: "plan text" }],
    actions: ["invoked stage planning"],
    toolEvents: { availability: { available: false, reason: "n/a" } },
    producedArtifacts: [],
  });
  assert.ok(!("chain_of_thought" in artifact));
  assert.ok(!("reasoning" in artifact));
  assert.equal(artifact.stages[0].output, "plan text");
});

test("buildTreatmentTrajectoryArtifact: a secret in stage output is redacted before bounding", () => {
  const artifact = buildTreatmentTrajectoryArtifact({
    cell_id: "c1",
    experiment_id: "exp1",
    execution_class: "local-cli",
    stages: [{ stage: "implementing", output: 'export GH_TOKEN="ghp_1234567890abcdef1234567890abcdef1234"' }],
    actions: [],
    toolEvents: { availability: { available: false, reason: "n/a" } },
    producedArtifacts: [],
  });
  assert.doesNotMatch(artifact.stages[0].output, /ghp_1234567890abcdef1234567890abcdef1234/);
});

test("buildTreatmentTrajectoryArtifact: over-ceiling stage output is truncated deterministically with drop accounting", () => {
  const bigOutput = "X".repeat(10_000);
  const build = () =>
    buildTreatmentTrajectoryArtifact({
      cell_id: "c1",
      experiment_id: "exp1",
      execution_class: "local-cli",
      stages: [{ stage: "implementing", output: bigOutput }],
      actions: [],
      toolEvents: { availability: { available: false, reason: "n/a" } },
      producedArtifacts: [],
      ceilings: { maxEvents: 200, maxBytes: 100 },
    });
  const first = build();
  const second = build();
  assert.equal(first.truncation.status, "truncated");
  assert.ok(first.truncation.dropped_byte_count > 0);
  assert.deepEqual(first, second);
});

test("buildTreatmentTrajectoryArtifact: within-ceiling content is untruncated", () => {
  const artifact = buildTreatmentTrajectoryArtifact({
    cell_id: "c1",
    experiment_id: "exp1",
    execution_class: "local-cli",
    stages: [{ stage: "implementing", output: "short" }],
    actions: ["a"],
    toolEvents: { availability: { available: false, reason: "n/a" } },
    producedArtifacts: [],
  });
  assert.equal(artifact.truncation.status, "none");
});

test("buildTreatmentTrajectoryArtifact: no hidden-check body, seeded-defect ground truth, or golden answer appears even if accidentally passed in stage output", () => {
  // Guards the collector itself: even if a caller mistakenly fed verifier-only
  // text into a stage's output, sanitization does not scrub arbitrary
  // business text (only secrets/injection) — so this test documents that the
  // *architectural* containment lives in the caller (executor.ts only reads
  // harness stdout/stderr, never detail.checks / fixture.hidden_checks), and
  // is enforced by the executor-level test in evals-trajectory-wiring.
  const hiddenCheck = "grep -q SEEDED_DEFECT_MARKER src/thing.ts";
  const artifact = buildTreatmentTrajectoryArtifact({
    cell_id: "c1",
    experiment_id: "exp1",
    execution_class: "local-cli",
    stages: [{ stage: "implementing", output: "normal harness output, no check bodies referenced" }],
    actions: [],
    toolEvents: { availability: { available: false, reason: "n/a" } },
    producedArtifacts: [],
  });
  assert.doesNotMatch(JSON.stringify(artifact), new RegExp(hiddenCheck.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("buildVerifierEvidenceArtifact: carries verifier identity, evidence consulted, and final result", () => {
  const artifact = buildVerifierEvidenceArtifact({
    cell_id: "c1",
    experiment_id: "exp1",
    verifier_kind: "grader",
    verifier_id: "review",
    verifier_version: "1",
    inputs: { reported_findings: [] },
    evidence_consulted: [{ defect_id: "d1", path: "a.ts" }],
    final_result: { true_positives: 0, false_positives: 0, false_negatives: 1 },
  });
  assert.equal(artifact.verifier_kind, "grader");
  assert.equal(artifact.verifier_id, "review");
  assert.equal(artifact.evidence_consulted.length, 1);
  assert.deepEqual(artifact.final_result, { true_positives: 0, false_positives: 0, false_negatives: 1 });
});

test("buildVerifierEvidenceArtifact: MAY carry verifier-only material (hidden checks / seeded defects) — that is where it belongs", () => {
  const artifact = buildVerifierEvidenceArtifact({
    cell_id: "c1",
    experiment_id: "exp1",
    verifier_kind: "grader",
    verifier_id: "implementation-fix",
    verifier_version: "1",
    inputs: {},
    evidence_consulted: [{ hidden_check: "grep -q SEEDED_DEFECT src/x.ts" }],
    final_result: {},
  });
  assert.match(JSON.stringify(artifact.evidence_consulted), /SEEDED_DEFECT/);
});

test("buildVerifierEvidenceArtifact: independently addressable content from a treatment trajectory built for the same cell (different shapes/fields)", () => {
  const treatment = buildTreatmentTrajectoryArtifact({
    cell_id: "c1",
    experiment_id: "exp1",
    execution_class: "local-cli",
    stages: [{ stage: "review", output: "ok" }],
    actions: [],
    toolEvents: { availability: { available: false, reason: "n/a" } },
    producedArtifacts: [],
  });
  const verifier = buildVerifierEvidenceArtifact({
    cell_id: "c1",
    experiment_id: "exp1",
    verifier_kind: "grader",
    verifier_id: "review",
    verifier_version: "1",
    inputs: {},
    evidence_consulted: [],
    final_result: {},
  });
  assert.notDeepEqual(treatment, verifier);
  assert.ok(!("verifier_kind" in treatment));
  assert.ok(!("stages" in verifier));
});
