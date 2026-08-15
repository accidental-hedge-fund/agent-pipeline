// #703: pure progressive-planning composition (offline helpers only).
// No network / git / subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeProgressivePlanningRecommendation,
  recommendedDepthForAction,
  resolveOpenAssumptionsStrict,
  resolveSafetyConflicts,
  unresolvedAssumptionIdsFromCurrent,
  validateClassEvidenceAssignment,
  validateClassEvidenceRef,
  validateObservedReworkProvenance,
  validateProgressivePlanningRecommendation,
  type ClassEvidenceInput,
  type ClassEvidenceRef,
} from "../scripts/progressive-planning/compose.ts";
import {
  FORBIDDEN_SCORE_FIELDS,
  PROGRESSIVE_PLANNING_POLICY_ID,
  ROUTING_ACTIONS,
  isHighBlastDefaultTrafficDeploy,
  isRoutingAction,
} from "../scripts/progressive-planning/schema.ts";
import {
  createOpenAssumption,
  projectAssumptionCurrentState,
  updateAssumptionStatus,
} from "../scripts/planning-leverage/assumptions.ts";

const AS_OF = "2026-08-15T12:00:00.000Z";
const BEFORE = "2026-08-15T10:00:00.000Z";

function evRef(
  ref: string,
  source_kind: ClassEvidenceRef["source_kind"] = "structural",
  observed_as_of = BEFORE,
): ClassEvidenceRef {
  return { ref, source_kind, observed_as_of };
}

function cls(
  class_id: ClassEvidenceInput["class_id"],
  extra: Partial<ClassEvidenceInput> = {},
  ref = `fixture:${class_id}`,
): ClassEvidenceInput {
  const { evidence: extraEvidence, ...rest } = extra;
  return {
    class_id,
    ...rest,
    evidence: extraEvidence ?? [evRef(ref)],
  };
}

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

test("no signals defaults to standard_plan (not lightweight) when scan complete", () => {
  const rec = composeProgressivePlanningRecommendation({});
  assert.equal(rec.primary_action, "standard_plan");
  assert.equal(rec.recommended_planning_depth, "standard");
  assert.equal(rec.automation_enabled, false);
  assert.ok(rec.diagnostics.includes("unknown_default"));
  assert.deepEqual(rec.preserved_assumption_ids, []);
});

test("high_severity_scan_incomplete does not ordinary-standard (adversarial omitted declarations)", () => {
  const rec = composeProgressivePlanningRecommendation({
    high_severity_scan_complete: false,
  });
  assert.notEqual(rec.primary_action, "standard_plan");
  assert.notEqual(rec.primary_action, "lightweight_plan");
  assert.equal(rec.primary_action, "deepen_technical");
  assert.ok(rec.diagnostics.includes("high_severity_scan_incomplete"));
  assert.ok(!rec.diagnostics.includes("unknown_default"));
  assert.ok(rec.actions.includes("preserve_assumptions"));
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
    recommendation_as_of: AS_OF,
    classes: [
      cls("security_compliance", { subsignals_complete: false }, "pre-code:auth"),
    ],
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
    recommendation_as_of: AS_OF,
    classes: [cls("security_compliance", { subsignals_complete: true }, "pre-code:auth")],
  });
  assert.equal(rec.primary_action, "deepen_technical");
  assert.equal(rec.recommended_planning_depth, "deep");
});

test("most-restrictive: ambiguity lightweight conflict loses to security", () => {
  const rec = composeProgressivePlanningRecommendation({
    recommendation_as_of: AS_OF,
    classes: [
      cls("ambiguity", {}, "issue:open_questions"),
      cls("security_compliance", { subsignals_complete: false }, "pre-code:auth"),
    ],
    lightweight_favoring: true,
  });
  assert.equal(rec.primary_action, "request_human_authority");
  assert.ok(rec.diagnostics.includes("conflict") || rec.diagnostics.includes("subsignal_incomplete"));
  assert.ok(!rec.actions.includes("lightweight_plan"));
});

test("conflicting low-risk vs structural records conflict diagnostic", () => {
  const rec = composeProgressivePlanningRecommendation({
    recommendation_as_of: AS_OF,
    classes: [cls("blast_radius", { subsignals_complete: true }, "path:packages/*")],
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

test("boolean conflict alone never selects lightweight_plan (restrictive floor)", () => {
  // Finding d34e579e: { lightweight_favoring: true, conflict: true } must not
  // stay on lightweight — unresolved conflict prefers the more restrictive side.
  const rec = composeProgressivePlanningRecommendation({
    lightweight_favoring: true,
    conflict: true,
  });
  assert.notEqual(rec.primary_action, "lightweight_plan");
  assert.ok(rec.diagnostics.includes("conflict"));
  assert.ok(!rec.actions.includes("lightweight_plan"));
  // Without a safety dimension, floor is at least standard (not forced deep).
  assert.equal(rec.primary_action, "standard_plan");
});

test("reversibility without rollback requests human authority", () => {
  const rec = composeProgressivePlanningRecommendation({
    recommendation_as_of: AS_OF,
    classes: [
      cls(
        "reversibility",
        { automated_rollback_documented: false },
        "design:drop-column",
      ),
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
    recommendation_as_of: AS_OF,
    classes: [
      cls(
        "observed_rework_cost",
        { history_available: false, evidence: [evRef("cohort:prior", "historical_observed")] },
        "cohort:prior",
      ),
    ],
  });
  assert.equal(rec.primary_action, "standard_plan");
  assert.ok(rec.diagnostics.includes("history_unavailable"));
});

test("observed_rework_cost elevated history deepens technical when provenance ok", () => {
  const rec = composeProgressivePlanningRecommendation({
    recommendation_as_of: AS_OF,
    classes: [
      cls(
        "observed_rework_cost",
        {
          history_available: true,
          history_elevated: true,
          evidence: [evRef("cohort:run-prior-1", "historical_observed")],
        },
      ),
    ],
    observed_rework_provenance: {
      recommendation_as_of: AS_OF,
      history_cutoff_at: AS_OF,
      target_run_id: "run-target",
      cohort_run_ids: ["run-prior-1"],
      cohort_completed_at: {
        "run-prior-1": "2026-08-14T10:00:00.000Z",
      },
    },
  });
  assert.equal(rec.primary_action, "deepen_technical");
  assert.ok(!rec.diagnostics.includes("history_provenance_rejected"));
});

test("observed_rework_cost rejects target_run_id in cohort (no outcome leakage)", () => {
  const rec = composeProgressivePlanningRecommendation({
    recommendation_as_of: AS_OF,
    classes: [
      cls(
        "observed_rework_cost",
        {
          history_available: true,
          history_elevated: true,
          evidence: [evRef("cohort:leaked", "historical_observed")],
        },
      ),
    ],
    observed_rework_provenance: {
      recommendation_as_of: AS_OF,
      history_cutoff_at: AS_OF,
      target_run_id: "run-target",
      cohort_run_ids: ["run-target", "run-prior-1"],
      cohort_completed_at: {
        "run-target": "2026-08-15T18:00:00.000Z",
        "run-prior-1": "2026-08-14T10:00:00.000Z",
      },
    },
  });
  assert.notEqual(rec.primary_action, "deepen_technical");
  assert.equal(rec.primary_action, "standard_plan");
  assert.ok(rec.diagnostics.includes("history_provenance_rejected"));
});

test("observed_rework_cost rejects cohort completed_at after recommendation_as_of", () => {
  const check = validateObservedReworkProvenance(
    {
      recommendation_as_of: AS_OF,
      history_cutoff_at: AS_OF,
      target_run_id: "run-target",
      cohort_run_ids: ["run-future"],
      cohort_completed_at: {
        "run-future": "2026-08-16T00:00:00.000Z",
      },
    },
    true,
  );
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.ok(check.diagnostics.includes("history_provenance_rejected"));
  }

  const rec = composeProgressivePlanningRecommendation({
    recommendation_as_of: AS_OF,
    classes: [
      cls(
        "observed_rework_cost",
        {
          history_available: true,
          history_elevated: true,
          evidence: [evRef("cohort:future", "historical_observed")],
        },
      ),
    ],
    observed_rework_provenance: {
      recommendation_as_of: AS_OF,
      history_cutoff_at: AS_OF,
      target_run_id: "run-target",
      cohort_run_ids: ["run-future"],
      cohort_completed_at: {
        "run-future": "2026-08-16T00:00:00.000Z",
      },
    },
  });
  assert.equal(rec.primary_action, "standard_plan");
  assert.ok(rec.diagnostics.includes("history_provenance_rejected"));
});

test("observed_rework_cost history_available without provenance is rejected", () => {
  const rec = composeProgressivePlanningRecommendation({
    recommendation_as_of: AS_OF,
    classes: [
      cls(
        "observed_rework_cost",
        {
          history_available: true,
          history_elevated: true,
          evidence: [evRef("cohort:x", "historical_observed")],
        },
      ),
    ],
  });
  assert.equal(rec.primary_action, "standard_plan");
  assert.ok(rec.diagnostics.includes("history_provenance_rejected"));
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
    recommendation_as_of: AS_OF,
    classes: [
      cls("blast_radius", {}, "path:packages/*"),
      cls("ambiguity", {}, "issue:ac-conflict"),
    ],
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
    recommendation_as_of: AS_OF,
    classes: [cls("novelty", {}, "path:new-subsystem/")],
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
    recommendation_as_of: AS_OF,
    classes: [cls("ambiguity", {}, "issue:missing-ac")],
  });
  assert.equal(rec.primary_action, "deepen_product");
  assert.equal(rec.recommended_planning_depth, "deep");
});

// ---------------------------------------------------------------------------
// Assumption lineage reconstructability (d7)
// ---------------------------------------------------------------------------

test("assumption_ids survive lightweight, deep, and human-authority paths", () => {
  const runId = "run-lineage-1";
  const a1 = createOpenAssumption({
    run_id: runId,
    issue: 703,
    kind: "assumption",
    statement: "API remains backward compatible",
    introduced_phase: "planning",
    status_updated_at: "2026-08-15T10:00:00.000Z",
    ordinal: 0,
  });
  const a2 = createOpenAssumption({
    run_id: runId,
    issue: 703,
    kind: "open_question",
    statement: "Which region hosts the migration?",
    introduced_phase: "planning",
    status_updated_at: "2026-08-15T10:01:00.000Z",
    ordinal: 0,
  });
  const a2def = updateAssumptionStatus({
    prior: a2,
    status: "deferred",
    status_updated_at: "2026-08-15T10:05:00.000Z",
    resolution_note: "park for operator",
  });
  const events = [a1, a2, a2def];
  const current = projectAssumptionCurrentState(events, runId);
  assert.equal(current.get(a1.assumption_id)?.status, "open");
  assert.equal(current.get(a2.assumption_id)?.status, "deferred");
  assert.equal(current.get(a2.assumption_id)?.introduced_phase, "planning");

  const unresolved = unresolvedAssumptionIdsFromCurrent(current);
  assert.deepEqual(unresolved.sort(), [a1.assumption_id, a2.assumption_id].sort());

  const paths = [
    composeProgressivePlanningRecommendation({
      lightweight_favoring: true,
      open_or_deferred_assumption_ids: unresolved,
    }),
    composeProgressivePlanningRecommendation({
      recommendation_as_of: AS_OF,
      classes: [cls("ambiguity", {}, "issue:ac")],
      open_or_deferred_assumption_ids: unresolved,
    }),
    composeProgressivePlanningRecommendation({
      human_authority_boundary: true,
      open_or_deferred_assumption_ids: unresolved,
    }),
  ];

  assert.equal(paths[0].primary_action, "lightweight_plan");
  assert.equal(paths[1].primary_action, "deepen_product");
  assert.equal(paths[2].primary_action, "request_human_authority");

  for (const rec of paths) {
    assert.ok(rec.actions.includes("preserve_assumptions"), rec.primary_action);
    assert.deepEqual(rec.preserved_assumption_ids.sort(), unresolved.sort());
    const reprojected = projectAssumptionCurrentState(events, runId);
    for (const id of rec.preserved_assumption_ids) {
      const p = reprojected.get(id);
      assert.ok(p, `missing ${id}`);
      assert.ok(p!.status === "open" || p!.status === "deferred");
      assert.equal(p!.introduced_phase, "planning");
    }
  }
});

test("preserve_assumptions does not mint new assumption_ids", () => {
  const id = "A-fixed-id-0001";
  const rec = composeProgressivePlanningRecommendation({
    lightweight_favoring: true,
    open_or_deferred_assumption_ids: [id],
  });
  assert.deepEqual(rec.preserved_assumption_ids, [id]);
  assert.ok(rec.actions.includes("preserve_assumptions"));
});

// ---------------------------------------------------------------------------
// b317b808 — per-class evidence provenance
// ---------------------------------------------------------------------------

test("class evidence rejects outcome_derived source_kind", () => {
  const check = validateClassEvidenceRef(
    {
      ref: "material_rework:target-run",
      source_kind: "outcome_derived",
      observed_as_of: BEFORE,
    },
    AS_OF,
  );
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.match(check.reason, /forbidden source_kind|outcome_derived/);
  }
});

test("class evidence rejects post-routing observed_as_of", () => {
  const check = validateClassEvidenceRef(
    {
      ref: "path:core/scripts",
      source_kind: "structural",
      observed_as_of: "2026-08-16T00:00:00.000Z",
    },
    AS_OF,
  );
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.match(check.reason, /post-routing|after recommendation/);
  }
});

test("class evidence rejects production_outcome ref encoding", () => {
  const check = validateClassEvidenceRef(
    {
      ref: "production_outcome:po-123",
      source_kind: "structural",
      observed_as_of: BEFORE,
    },
    AS_OF,
  );
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.match(check.reason, /outcome-derived/);
  }
});

test("structured class without evidence does not elevate (class_evidence_missing)", () => {
  const rec = composeProgressivePlanningRecommendation({
    recommendation_as_of: AS_OF,
    require_class_evidence: true,
    classes: [{ class_id: "security_compliance", subsignals_complete: false }],
    lightweight_favoring: true,
  });
  assert.ok(rec.diagnostics.includes("class_evidence_missing"));
  // Rejected class must not force human authority; lightweight may win.
  assert.equal(rec.primary_action, "lightweight_plan");
  assert.ok(!rec.matched_classes.includes("security_compliance"));
});

test("valid structural evidence assigns class and floors action", () => {
  const assignment = validateClassEvidenceAssignment(
    {
      class_id: "blast_radius",
      evidence: [evRef("path:public-api/**", "structural", BEFORE)],
    },
    AS_OF,
    true,
  );
  assert.equal(assignment.ok, true);

  const rec = composeProgressivePlanningRecommendation({
    recommendation_as_of: AS_OF,
    classes: [
      {
        class_id: "blast_radius",
        subsignals_complete: true,
        evidence: [evRef("path:public-api/**", "structural", BEFORE)],
      },
    ],
  });
  assert.ok(rec.matched_classes.includes("blast_radius"));
  assert.notEqual(rec.primary_action, "standard_plan");
  assert.notEqual(rec.primary_action, "lightweight_plan");
});

test("string shorthand without evidence is rejected when require_class_evidence", () => {
  const rec = composeProgressivePlanningRecommendation({
    recommendation_as_of: AS_OF,
    classes: ["ambiguity"],
  });
  assert.ok(rec.diagnostics.includes("class_evidence_missing"));
  assert.equal(rec.primary_action, "standard_plan");
  assert.ok(!rec.matched_classes.includes("ambiguity"));
});

// ---------------------------------------------------------------------------
// 8d4ca0dd — conflicting safety evidence fail-closed
// ---------------------------------------------------------------------------

test("safety conflict matrix: rollback declared-clear vs structural-elevate → human", () => {
  const resolved = resolveSafetyConflicts([
    {
      dimension: "rollback",
      declared_polarity: "clearing",
      structural_polarity: "elevating",
    },
  ]);
  assert.ok(resolved.hasConflict);
  assert.ok(resolved.actions.includes("request_human_authority"));

  const rec = composeProgressivePlanningRecommendation({
    lightweight_favoring: true,
    safety_conflicts: [
      {
        dimension: "rollback",
        declared_polarity: "clearing",
        structural_polarity: "elevating",
      },
    ],
  });
  assert.equal(rec.primary_action, "request_human_authority");
  assert.ok(rec.diagnostics.includes("safety_conflict"));
  assert.ok(!rec.actions.includes("lightweight_plan"));
  assert.ok(!rec.actions.includes("standard_plan"));
});

test("safety conflict matrix: security declared-clear vs structural-elevate → human", () => {
  const rec = composeProgressivePlanningRecommendation({
    safety_conflicts: [
      {
        dimension: "security",
        declared_polarity: "clearing",
        structural_polarity: "elevating",
      },
    ],
  });
  assert.equal(rec.primary_action, "request_human_authority");
  assert.ok(rec.diagnostics.includes("safety_conflict"));
  assert.notEqual(rec.primary_action, "standard_plan");
});

test("safety conflict matrix: blast declared-clear vs structural-elevate → deepen not standard", () => {
  const rec = composeProgressivePlanningRecommendation({
    lightweight_favoring: true,
    safety_conflicts: [
      {
        dimension: "blast_radius",
        declared_polarity: "clearing",
        structural_polarity: "elevating",
      },
    ],
  });
  assert.ok(rec.diagnostics.includes("safety_conflict"));
  assert.notEqual(rec.primary_action, "lightweight_plan");
  assert.notEqual(rec.primary_action, "standard_plan");
  assert.ok(
    rec.primary_action === "deepen_technical" ||
      rec.primary_action === "zoom_feasibility",
  );
});

test("safety conflict matrix: compliance conflict never ordinary standard", () => {
  const rec = composeProgressivePlanningRecommendation({
    safety_conflicts: [
      {
        dimension: "compliance",
        declared_polarity: "clearing",
        structural_polarity: "elevating",
      },
    ],
  });
  assert.equal(rec.primary_action, "request_human_authority");
  assert.ok(!rec.actions.includes("standard_plan"));
});

// ---------------------------------------------------------------------------
// e8254614 — default-traffic deploy criterion bounded
// ---------------------------------------------------------------------------

test("isHighBlastDefaultTrafficDeploy: ordinary app release is negative", () => {
  assert.equal(
    isHighBlastDefaultTrafficDeploy({
      ordinary_app_release_via_existing_cicd: true,
    }),
    false,
  );
});

test("isHighBlastDefaultTrafficDeploy: staged canary without path change is negative", () => {
  assert.equal(
    isHighBlastDefaultTrafficDeploy({
      staged_or_canary_plan_documented: true,
      forced_all_tenant_or_default_rollout: false,
    }),
    false,
  );
});

test("isHighBlastDefaultTrafficDeploy: CDN/auth gateway cutover is positive", () => {
  assert.equal(
    isHighBlastDefaultTrafficDeploy({
      alters_default_traffic_path: true,
      changes_deploy_pipeline_or_infra: true,
    }),
    true,
  );
});

test("isHighBlastDefaultTrafficDeploy: forced all-tenant rollout is positive", () => {
  assert.equal(
    isHighBlastDefaultTrafficDeploy({
      forced_all_tenant_or_default_rollout: true,
    }),
    true,
  );
});

test("isHighBlastDefaultTrafficDeploy: deploy pipeline change affecting default traffic is positive", () => {
  assert.equal(
    isHighBlastDefaultTrafficDeploy({
      changes_deploy_pipeline_or_infra: true,
      ordinary_app_release_via_existing_cicd: false,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// 5469c272 — count vs assumption ids must agree
// ---------------------------------------------------------------------------

test("count derived from ids when only ids supplied", () => {
  const resolved = resolveOpenAssumptionsStrict({
    open_or_deferred_assumption_ids: ["A-1", "A-2", "A-1"],
  });
  assert.equal(resolved.openCount, 2);
  assert.deepEqual(resolved.preservedIds, ["A-1", "A-2"]);
});

test("matching count and ids accepted", () => {
  const rec = composeProgressivePlanningRecommendation({
    lightweight_favoring: true,
    open_or_deferred_assumption_ids: ["A-1", "A-2"],
    open_or_deferred_assumption_count: 2,
  });
  assert.deepEqual(rec.preserved_assumption_ids, ["A-1", "A-2"]);
  assert.ok(rec.actions.includes("preserve_assumptions"));
});

test("contradictory count vs ids throws before recommendation", () => {
  assert.throws(
    () =>
      composeProgressivePlanningRecommendation({
        lightweight_favoring: true,
        open_or_deferred_assumption_ids: ["A-1", "A-2"],
        open_or_deferred_assumption_count: 5,
      }),
    /assumption_count_id_mismatch/,
  );
  assert.throws(
    () =>
      resolveOpenAssumptionsStrict({
        open_or_deferred_assumption_ids: ["A-only"],
        open_or_deferred_assumption_count: 0,
      }),
    /assumption_count_id_mismatch/,
  );
});
