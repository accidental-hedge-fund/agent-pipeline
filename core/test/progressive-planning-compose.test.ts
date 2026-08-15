// #703: pure progressive-planning composition (offline helpers only).
// No network / git / subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeProgressivePlanningRecommendation,
  recommendedDepthForAction,
  validateProgressivePlanningRecommendation,
} from "../scripts/progressive-planning/compose.ts";
import {
  FORBIDDEN_SCORE_FIELDS,
  PROGRESSIVE_PLANNING_POLICY_ID,
  ROUTING_ACTIONS,
  isRoutingAction,
} from "../scripts/progressive-planning/schema.ts";

test("closed action vocabulary is fixed set", () => {
  assert.deepEqual(
    [...ROUTING_ACTIONS].sort(),
    [
      "deepen_product",
      "deepen_technical",
      "lightweight_plan",
      "preserve_assumptions",
      "request_human_authority",
      "standard_plan",
      "zoom_feasibility",
      "zoom_vertical_slice",
    ].sort(),
  );
  assert.equal(isRoutingAction("lightweight_plan"), true);
  assert.equal(isRoutingAction("make_it_up"), false);
});

test("no signals defaults to standard_plan (not lightweight)", () => {
  const rec = composeProgressivePlanningRecommendation({});
  assert.equal(rec.primary_action, "standard_plan");
  assert.equal(rec.recommended_planning_depth, "standard");
  assert.equal(rec.automation_enabled, false);
  assert.ok(rec.diagnostics.includes("unknown_default"));
});

test("lightweight_favoring alone selects lightweight_plan → minimal", () => {
  const rec = composeProgressivePlanningRecommendation({
    lightweight_favoring: true,
  });
  assert.equal(rec.primary_action, "lightweight_plan");
  assert.equal(rec.recommended_planning_depth, "minimal");
});

test("lightweight + open assumptions stacks preserve_assumptions", () => {
  const rec = composeProgressivePlanningRecommendation({
    lightweight_favoring: true,
    open_or_deferred_assumption_count: 2,
  });
  assert.equal(rec.primary_action, "lightweight_plan");
  assert.ok(rec.actions.includes("preserve_assumptions"));
  assert.ok(rec.diagnostics.includes("open_assumptions_preserved"));
});

test("security_compliance incomplete does not default to lightweight", () => {
  const rec = composeProgressivePlanningRecommendation({
    classes: [{ class_id: "security_compliance", subsignals_complete: false }],
    lightweight_favoring: true,
  });
  assert.notEqual(rec.primary_action, "lightweight_plan");
  assert.equal(rec.primary_action, "request_human_authority");
  assert.ok(rec.actions.includes("deepen_technical"));
  assert.ok(rec.actions.includes("preserve_assumptions"));
  assert.ok(!rec.actions.includes("lightweight_plan"));
  assert.equal(rec.recommended_planning_depth, "deep");
});

test("security_compliance complete floors to deepen_technical", () => {
  const rec = composeProgressivePlanningRecommendation({
    classes: [{ class_id: "security_compliance", subsignals_complete: true }],
  });
  assert.equal(rec.primary_action, "deepen_technical");
  assert.equal(rec.recommended_planning_depth, "deep");
});

test("most-restrictive: ambiguity lightweight conflict loses to security", () => {
  const rec = composeProgressivePlanningRecommendation({
    classes: ["ambiguity", { class_id: "security_compliance", subsignals_complete: false }],
    lightweight_favoring: true,
  });
  assert.equal(rec.primary_action, "request_human_authority");
  assert.ok(rec.diagnostics.includes("conflict") || rec.diagnostics.includes("subsignal_incomplete"));
  assert.ok(!rec.actions.includes("lightweight_plan"));
});

test("conflicting low-risk vs structural records conflict diagnostic", () => {
  const rec = composeProgressivePlanningRecommendation({
    classes: [{ class_id: "blast_radius", subsignals_complete: true }],
    lightweight_favoring: true,
    conflict: true,
  });
  assert.ok(rec.diagnostics.includes("conflict"));
  assert.notEqual(rec.primary_action, "lightweight_plan");
  assert.ok(
    rec.primary_action === "deepen_technical" ||
      rec.primary_action === "zoom_feasibility",
  );
});

test("reversibility without rollback requests human authority", () => {
  const rec = composeProgressivePlanningRecommendation({
    classes: [
      {
        class_id: "reversibility",
        automated_rollback_documented: false,
      },
    ],
  });
  assert.equal(rec.primary_action, "request_human_authority");
  assert.ok(rec.diagnostics.includes("human_authority_floor"));
});

test("human_authority_boundary dominates", () => {
  const rec = composeProgressivePlanningRecommendation({
    lightweight_favoring: true,
    human_authority_boundary: true,
    open_or_deferred_assumption_count: 1,
  });
  assert.equal(rec.primary_action, "request_human_authority");
  assert.ok(rec.actions.includes("preserve_assumptions"));
  assert.ok(!rec.actions.includes("lightweight_plan"));
});

test("observed_rework_cost without history is ignored (history_unavailable)", () => {
  const rec = composeProgressivePlanningRecommendation({
    classes: [{ class_id: "observed_rework_cost", history_available: false }],
  });
  assert.equal(rec.primary_action, "standard_plan");
  assert.ok(rec.diagnostics.includes("history_unavailable"));
});

test("observed_rework_cost elevated history deepens technical", () => {
  const rec = composeProgressivePlanningRecommendation({
    classes: [
      {
        class_id: "observed_rework_cost",
        history_available: true,
        history_elevated: true,
      },
    ],
  });
  assert.equal(rec.primary_action, "deepen_technical");
});

test("recommended depth mapping stays in closed enum", () => {
  for (const a of ROUTING_ACTIONS) {
    const d = recommendedDepthForAction(a);
    assert.ok(["minimal", "standard", "deep", "unknown"].includes(d), a);
  }
  assert.equal(recommendedDepthForAction("deepen_product"), "deep");
  assert.equal(recommendedDepthForAction("lightweight_plan"), "minimal");
});

test("recommendation never carries collapsed score fields", () => {
  const rec = composeProgressivePlanningRecommendation({
    classes: ["blast_radius", "ambiguity"],
  });
  for (const key of FORBIDDEN_SCORE_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(rec, key),
      false,
      `must not have ${key}`,
    );
  }
  assert.equal(rec.policy_id, PROGRESSIVE_PLANNING_POLICY_ID);
});

test("validate rejects free-form action and score fields", () => {
  const bad = validateProgressivePlanningRecommendation({
    primary_action: "yolo_plan",
    actions: ["yolo_plan"],
    recommended_planning_depth: "extra_deep",
    risk_score: 0.9,
    automation_enabled: false,
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.issues.some((i) => i.includes("primary_action")));
    assert.ok(bad.issues.some((i) => i.includes("risk_score") || i.includes("forbidden")));
    assert.ok(bad.issues.some((i) => i.includes("recommended_planning_depth")));
  }
});

test("validate accepts closed recommendation shape", () => {
  const rec = composeProgressivePlanningRecommendation({
    classes: ["novelty"],
  });
  const ok = validateProgressivePlanningRecommendation(rec);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.primary_action, "zoom_feasibility");
    assert.equal(ok.value.automation_enabled, false);
  }
});

test("deepen_product maps to deep without new depth enum", () => {
  const rec = composeProgressivePlanningRecommendation({
    classes: ["ambiguity"],
  });
  assert.equal(rec.primary_action, "deepen_product");
  assert.equal(rec.recommended_planning_depth, "deep");
});
