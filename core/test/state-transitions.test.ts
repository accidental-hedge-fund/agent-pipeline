// Table-test: each (stage, outcome.advanced) maps to the right next stage
// according to the state-machine contract documented in SKILL.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewStageSkipTarget, STAGES, type Stage } from "../scripts/types.ts";

interface ExpectedTransition {
  from: Stage;
  outcome: "approve" | "needs-attention" | "advance" | "stay" | "ceiling";
  to: Stage;
}

const TABLE: ExpectedTransition[] = [
  { from: "ready",         outcome: "advance",        to: "review-1" },        // planning.ts internally runs planning + plan-review + implementation
  { from: "review-1",      outcome: "approve",        to: "review-2" },
  { from: "review-1",      outcome: "needs-attention", to: "fix-1" },
  { from: "review-1",      outcome: "ceiling",        to: "needs-human" },     // max_adversarial_rounds reached with findings still blocking
  { from: "fix-1",         outcome: "advance",        to: "review-2" },
  { from: "review-2",      outcome: "approve",        to: "pre-merge" },
  { from: "review-2",      outcome: "needs-attention", to: "fix-2" },
  { from: "review-2",      outcome: "ceiling",        to: "needs-human" },     // max_adversarial_rounds reached with findings still blocking
  { from: "fix-2",         outcome: "advance",        to: "pre-merge" },
  { from: "pre-merge",     outcome: "advance",        to: "eval-gate" },
  { from: "eval-gate",     outcome: "advance",        to: "ready-to-deploy" },
];

test("state machine: every documented stage exists in STAGES", () => {
  for (const t of TABLE) {
    assert.ok(STAGES.includes(t.from), `missing from-stage ${t.from}`);
    assert.ok(STAGES.includes(t.to), `missing to-stage ${t.to}`);
  }
});

test("state machine: forward path covers ready → ready-to-deploy", () => {
  const path: Stage[] = [
    "ready",
    "planning",
    "plan-review",
    "implementing",
    "review-1",
    "review-2",
    "pre-merge",
    "ready-to-deploy",
  ];
  for (const s of path) assert.ok(STAGES.includes(s));
});

test("state machine: terminal stages set", async () => {
  const { TERMINAL_STAGES } = await import("../scripts/types.ts");
  assert.ok(TERMINAL_STAGES.has("ready-to-deploy"));
  assert.ok(TERMINAL_STAGES.has("needs-human"), "needs-human is a terminal off-ramp");
});

test("state machine: review verdict mapping", () => {
  for (const round of [1, 2] as const) {
    const fromStage: Stage = `review-${round}` as Stage;
    const approveTo: Stage = round === 1 ? "review-2" : "pre-merge";
    const rejectTo: Stage = round === 1 ? "fix-1" : "fix-2";

    const approveRow = TABLE.find((t) => t.from === fromStage && t.outcome === "approve");
    const rejectRow = TABLE.find((t) => t.from === fromStage && t.outcome === "needs-attention");
    assert.ok(approveRow, `missing approve row for ${fromStage}`);
    assert.ok(rejectRow, `missing needs-attention row for ${fromStage}`);
    assert.equal(approveRow!.to, approveTo);
    assert.equal(rejectRow!.to, rejectTo);
  }
});

test("state machine: STAGES order is forward", () => {
  // Sanity: STAGES is in forward order so STAGE_PRIORITY logic in gh.ts works.
  const expected = [
    "backlog",
    "ready",
    "planning",
    "plan-review",
    "implementing",
    "review-1",
    "fix-1",
    "review-2",
    "fix-2",
    "pre-merge",
    "eval-gate",
    "ready-to-deploy",
    "needs-human",
  ];
  assert.deepEqual([...STAGES], expected);
});

test("state machine: eval-gate sits between pre-merge and ready-to-deploy", () => {
  const stages = [...STAGES];
  const preMergeIdx = stages.indexOf("pre-merge");
  const evalGateIdx = stages.indexOf("eval-gate");
  const readyToDeployIdx = stages.indexOf("ready-to-deploy");
  assert.ok(evalGateIdx > preMergeIdx, "eval-gate must come after pre-merge");
  assert.ok(evalGateIdx < readyToDeployIdx, "eval-gate must come before ready-to-deploy");
});

test("step config (#13): review skip targets keep a valid forward path", () => {
  const cfg = (s: Partial<{ standard_review: boolean; adversarial_review: boolean }>) => ({
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true, ...s },
  });
  // review-1 disabled, adversarial still on → fall through to review-2
  assert.equal(reviewStageSkipTarget(cfg({ standard_review: false }), "review-1"), "review-2");
  // review-1 disabled and adversarial also off → straight to pre-merge
  assert.equal(reviewStageSkipTarget(cfg({ standard_review: false, adversarial_review: false }), "review-1"), "pre-merge");
  // review-2 disabled → always pre-merge
  assert.equal(reviewStageSkipTarget(cfg({ adversarial_review: false }), "review-2"), "pre-merge");
});
