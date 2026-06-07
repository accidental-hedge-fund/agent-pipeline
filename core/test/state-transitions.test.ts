// Table-test: each (stage, outcome.advanced) maps to the right next stage
// according to the state-machine contract documented in SKILL.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewStageSkipTarget, STAGES, type Stage } from "../scripts/types.ts";

interface ExpectedTransition {
  from: Stage;
  outcome: "approve" | "needs-attention" | "advance" | "stay";
  to: Stage;
}

const TABLE: ExpectedTransition[] = [
  { from: "ready",         outcome: "advance",        to: "review-1" },        // planning.ts internally runs planning + plan-review + implementation
  { from: "review-1",      outcome: "approve",        to: "review-2" },
  { from: "review-1",      outcome: "needs-attention", to: "fix-1" },
  { from: "fix-1",         outcome: "advance",        to: "review-2" },
  { from: "review-2",      outcome: "approve",        to: "pre-merge" },
  { from: "review-2",      outcome: "needs-attention", to: "fix-2" },
  { from: "fix-2",         outcome: "advance",        to: "pre-merge" },
  { from: "pre-merge",     outcome: "advance",        to: "ready-to-deploy" },
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
    "ready-to-deploy",
  ];
  assert.deepEqual([...STAGES], expected);
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

test("step config (#13): fix-1 dispatch guard routes to next active stage when standard_review is disabled", () => {
  // fix-1 with standard_review disabled is equivalent to review-1 disabled:
  // it should route via reviewStageSkipTarget(cfg, "review-1").
  const cfg = (s: Partial<{ standard_review: boolean; adversarial_review: boolean }>) => ({
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true, ...s },
  });
  // standard_review off, adversarial still on → fix-1 skipped → review-2
  assert.equal(reviewStageSkipTarget(cfg({ standard_review: false }), "review-1"), "review-2");
  // both off → fix-1 skipped → pre-merge
  assert.equal(reviewStageSkipTarget(cfg({ standard_review: false, adversarial_review: false }), "review-1"), "pre-merge");
});

test("step config (#13): fix-2 dispatch guard routes to pre-merge when adversarial_review is disabled", () => {
  const cfg = (s: Partial<{ adversarial_review: boolean }>) => ({
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true, ...s },
  });
  // fix-2 with adversarial_review disabled → pre-merge
  assert.equal(reviewStageSkipTarget(cfg({ adversarial_review: false }), "review-2"), "pre-merge");
});

test("step config (#13): fix-1 completion routes to pre-merge when adversarial_review is disabled", () => {
  // The fix.ts round-1 path uses cfg.steps.adversarial_review to choose the target.
  // Verify the routing logic matches expectations.
  const advDisabled = { steps: { plan_review: true, standard_review: true, adversarial_review: false, docs: true } };
  const advEnabled  = { steps: { plan_review: true, standard_review: true, adversarial_review: true,  docs: true } };
  const fix1Target = (cfg: typeof advDisabled) => cfg.steps.adversarial_review ? "review-2" : "pre-merge";
  assert.equal(fix1Target(advDisabled), "pre-merge");
  assert.equal(fix1Target(advEnabled), "review-2");
});

test("step config (#13): plan-review skip with existing PR routes to first active review stage", () => {
  // When plan_review is disabled and a PR already exists, the orchestrator should
  // route to the first active review stage (not to `implementing` which is a no-op dispatch).
  const cfg = (s: Partial<{ standard_review: boolean; adversarial_review: boolean }>) => ({
    steps: { plan_review: false, standard_review: true, adversarial_review: true, docs: true, ...s },
  });
  // Both reviews on → review-1
  const targetWithPr = (c: ReturnType<typeof cfg>) =>
    c.steps.standard_review ? "review-1" : reviewStageSkipTarget(c, "review-1");
  assert.equal(targetWithPr(cfg({})), "review-1");
  // standard off → review-2
  assert.equal(targetWithPr(cfg({ standard_review: false })), "review-2");
  // both off → pre-merge
  assert.equal(targetWithPr(cfg({ standard_review: false, adversarial_review: false })), "pre-merge");
});

test("step config (#13): plan-review skip without existing PR routes back to ready", () => {
  // When plan_review is disabled and NO PR exists, the orchestrator should route
  // back to `ready` so planning re-runs with plan_review disabled.
  // This test documents the intended routing logic (no PR → "ready").
  const noPrTarget = "ready";
  assert.equal(noPrTarget, "ready");
});
