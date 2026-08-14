// Unit tests for staged policy lifecycle (#695).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertEnforcingLineage,
  assertPolicyLifecycleState,
  computeStagedPolicyHash,
  createStagedPolicy,
  DEFAULT_PROMOTION_THRESHOLDS,
  effectivePolicyHash,
  enforcingStateHasLineage,
  evaluateLifecycleTransition,
  hasEnforcingLineage,
  hasValidEnforcingPromotionLineage,
  isIso8601Timestamp,
  isLegalLifecycleEdge,
  isPolicyLifecycleState,
  POLICY_LIFECYCLE_STATES,
  stagedPolicyFromDecl,
  toPolicyEvidenceRow,
  validateMaterializedLineage,
  type PolicyAuthorityRecord,
  type PolicyLifecycleState,
  type PolicyLineageEvent,
  type PolicyObservationAggregates,
  type StagedPolicy,
} from "../scripts/stage-policy-lifecycle.ts";
import {
  buildEvidenceSubject,
  buildEngineFingerprint,
  buildRequiredEvidenceSetRevision,
  compareEvidenceSubjects,
  DEFAULT_REQUIRED_EVIDENCE_KINDS,
  verifierFingerprintFromEngine,
} from "../scripts/evidence-subject.ts";

const AT = "2026-08-14T00:00:00.000Z";
const AUTH: PolicyAuthorityRecord = { actor: "operator", role: "policy-admin" };
const GOOD_OBS: PolicyObservationAggregates = {
  observation_run_count: DEFAULT_PROMOTION_THRESHOLDS.min_observation_run_count,
  false_positive_or_override_rate: 0.05,
  unresolved_evidence_count: 0,
};

function promoteTo(
  policy: StagedPolicy,
  to: Parameters<typeof evaluateLifecycleTransition>[0]["to"],
  extra: Partial<Parameters<typeof evaluateLifecycleTransition>[0]> = {},
): StagedPolicy {
  const r = evaluateLifecycleTransition({
    policy,
    to,
    at: AT,
    authority: AUTH,
    observation: GOOD_OBS,
    evidence_refs: ["obs://1"],
    ...extra,
  });
  assert.equal(r.ok, true, r.ok ? "" : r.message);
  return (r as { ok: true; policy: StagedPolicy }).policy;
}

/** Build legal promotion lineage through `through` with recomputed hashes (config materialize). */
function buildLegalPromotionLineage(
  policyId: string,
  through: "observe" | "required" | "enforcing",
  acceptance: Record<string, unknown> = {},
  at: string = AT,
): PolicyLineageEvent[] {
  const path: Array<[PolicyLifecycleState, PolicyLifecycleState]> = [
    ["draft", "observe"],
    ["observe", "required"],
    ["required", "enforcing"],
  ];
  const stopAt =
    through === "observe" ? 1 : through === "required" ? 2 : 3;
  return path.slice(0, stopAt).map(([from, to]) => ({
    policy_id: policyId,
    from_state: from,
    to_state: to,
    policy_hash_before: computeStagedPolicyHash({
      policy_id: policyId,
      state: from,
      acceptance,
    }),
    policy_hash_after: computeStagedPolicyHash({
      policy_id: policyId,
      state: to,
      acceptance,
    }),
    at,
    authority: to === "enforcing" ? AUTH : null,
    evidence_refs:
      (from === "observe" && to === "required") || (from === "required" && to === "enforcing")
        ? ["obs://1"]
        : [],
  }));
}

/** Build a full legal draft→…→enforcing lineage with recomputed hashes (config materialize). */
function buildLegalEnforcingLineage(
  policyId: string,
  acceptance: Record<string, unknown> = {},
  at: string = AT,
): PolicyLineageEvent[] {
  return buildLegalPromotionLineage(policyId, "enforcing", acceptance, at);
}

// ---------------------------------------------------------------------------
// Closed states
// ---------------------------------------------------------------------------

test("POLICY_LIFECYCLE_STATES is the closed set draft|observe|required|enforcing|retired", () => {
  assert.deepEqual([...POLICY_LIFECYCLE_STATES], [
    "draft",
    "observe",
    "required",
    "enforcing",
    "retired",
  ]);
});

test("valid state is accepted; unknown state is rejected", () => {
  for (const s of POLICY_LIFECYCLE_STATES) {
    assert.equal(isPolicyLifecycleState(s), true);
    assert.equal(assertPolicyLifecycleState(s), s);
  }
  assert.equal(isPolicyLifecycleState("enforced"), false);
  assert.throws(() => assertPolicyLifecycleState("enforced"), /invalid policy lifecycle state/);
  assert.throws(() => assertPolicyLifecycleState("active"), /invalid policy lifecycle state/);
});

// ---------------------------------------------------------------------------
// Legal transitions
// ---------------------------------------------------------------------------

test("legal draft → observe", () => {
  assert.equal(isLegalLifecycleEdge("draft", "observe"), true);
  let p = createStagedPolicy("p1", { gate: "x" });
  p = promoteTo(p, "observe", { authority: null, observation: null, evidence_refs: [] });
  assert.equal(p.state, "observe");
  assert.equal(p.lineage.length, 1);
  assert.equal(p.lineage[0]!.from_state, "draft");
  assert.equal(p.lineage[0]!.to_state, "observe");
});

test("illegal jump to enforcing from draft/observe is rejected", () => {
  const draft = createStagedPolicy("p1");
  const r1 = evaluateLifecycleTransition({
    policy: draft,
    to: "enforcing",
    at: AT,
    authority: AUTH,
    observation: GOOD_OBS,
  });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, "illegal_edge");
  assert.equal(draft.state, "draft");

  let observe = promoteTo(draft, "observe", { authority: null, observation: null });
  const r2 = evaluateLifecycleTransition({
    policy: observe,
    to: "enforcing",
    at: AT,
    authority: AUTH,
    observation: GOOD_OBS,
  });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "illegal_edge");
  assert.equal(observe.state, "observe");
});

test("retired is terminal", () => {
  let p = createStagedPolicy("p1");
  p = promoteTo(p, "observe", { authority: null, observation: null });
  p = promoteTo(p, "retired");
  assert.equal(p.state, "retired");
  const r = evaluateLifecycleTransition({
    policy: p,
    to: "observe",
    at: AT,
    authority: AUTH,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "retired_terminal");
});

// ---------------------------------------------------------------------------
// Promotion evidence + authority
// ---------------------------------------------------------------------------

test("enforcing promotion with complete evidence succeeds", () => {
  let p = createStagedPolicy("p1", { block: true });
  p = promoteTo(p, "observe", { authority: null, observation: null });
  p = promoteTo(p, "required");
  p = promoteTo(p, "enforcing");
  assert.equal(p.state, "enforcing");
  assert.equal(hasEnforcingLineage(p), true);
  assert.equal(enforcingStateHasLineage(p), true);
  const ev = p.lineage.find((e) => e.to_state === "enforcing");
  assert.ok(ev);
  assert.ok(ev!.authority);
  assert.equal(ev!.authority!.actor, "operator");
  assert.ok(ev!.policy_hash_after);
});

test("enforcing promotion without authority is rejected", () => {
  let p = createStagedPolicy("p1");
  p = promoteTo(p, "observe", { authority: null, observation: null });
  p = promoteTo(p, "required");
  const r = evaluateLifecycleTransition({
    policy: p,
    to: "enforcing",
    at: AT,
    authority: null,
    observation: GOOD_OBS,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing_authority");
  assert.equal(p.state, "required");
  assert.equal(hasEnforcingLineage(p), false);
});

test("enforcing promotion with insufficient observation is rejected", () => {
  let p = createStagedPolicy("p1");
  p = promoteTo(p, "observe", { authority: null, observation: null });
  p = promoteTo(p, "required");
  const r = evaluateLifecycleTransition({
    policy: p,
    to: "enforcing",
    at: AT,
    authority: AUTH,
    observation: { ...GOOD_OBS, observation_run_count: 0 },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "insufficient_observation");
});

test("authorized retirement appends lineage", () => {
  let p = createStagedPolicy("p1");
  p = promoteTo(p, "observe", { authority: null, observation: null });
  const n = p.lineage.length;
  p = promoteTo(p, "retired");
  assert.equal(p.state, "retired");
  assert.equal(p.lineage.length, n + 1);
  assert.equal(p.lineage[n]!.to_state, "retired");
  assert.ok(p.lineage[n]!.authority);
});

test("retirement without authority is rejected", () => {
  const p = createStagedPolicy("p1");
  const r = evaluateLifecycleTransition({
    policy: p,
    to: "retired",
    at: AT,
    authority: null,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing_authority");
  assert.equal(p.state, "draft");
});

// ---------------------------------------------------------------------------
// Lineage append-only + policy_hash
// ---------------------------------------------------------------------------

test("lineage is append-only and prior events remain byte-identical", () => {
  let p = createStagedPolicy("p1", { a: 1 });
  p = promoteTo(p, "observe", { authority: null, observation: null });
  const snap = JSON.stringify(p.lineage);
  p = promoteTo(p, "required");
  assert.equal(JSON.stringify(p.lineage.slice(0, 1)), snap);
  assert.equal(p.lineage.length, 2);
});

test("policy_hash changes when state or acceptance changes", () => {
  const h1 = computeStagedPolicyHash({
    policy_id: "p1",
    state: "required",
    acceptance: { gate: "a" },
  });
  const h2 = computeStagedPolicyHash({
    policy_id: "p1",
    state: "enforcing",
    acceptance: { gate: "a" },
  });
  const h3 = computeStagedPolicyHash({
    policy_id: "p1",
    state: "enforcing",
    acceptance: { gate: "b" },
  });
  assert.notEqual(h1, h2);
  assert.notEqual(h2, h3);
  assert.equal(
    h1,
    computeStagedPolicyHash({
      policy_id: "p1",
      state: "required",
      acceptance: { gate: "a" },
    }),
  );
});

test("promotion into enforcing revises policy_hash and invalidates prior subject", () => {
  let p = createStagedPolicy("p1", { required_checks: ["CI"] });
  p = promoteTo(p, "observe", { authority: null, observation: null });
  p = promoteTo(p, "required");
  const h1 = effectivePolicyHash(p);
  p = promoteTo(p, "enforcing");
  const h2 = effectivePolicyHash(p);
  assert.notEqual(h1, h2);

  const engine = buildEngineFingerprint({
    version: "1.0.0",
    templates_fingerprint: "t".repeat(64),
  });
  const verifier = verifierFingerprintFromEngine(engine);
  const req = buildRequiredEvidenceSetRevision(DEFAULT_REQUIRED_EVIDENCE_KINDS);
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const prior = buildEvidenceSubject({
    domain: "o/r",
    issue: 695,
    run_id: "695/a",
    candidate_sha: sha,
    policy_hash: h1,
    engine_fingerprint: engine,
    verifier_fingerprint: verifier,
    required_evidence_set_revision: req,
  });
  const pin = buildEvidenceSubject({
    domain: "o/r",
    issue: 695,
    run_id: "695/a",
    candidate_sha: sha,
    policy_hash: h2,
    engine_fingerprint: engine,
    verifier_fingerprint: verifier,
    required_evidence_set_revision: req,
  });
  const cmp = compareEvidenceSubjects(prior, pin);
  assert.equal(cmp.outcome, "mismatch");
  assert.ok(cmp.mismatched_fields.includes("policy_hash"));
});

test("toPolicyEvidenceRow records id, state, policy_hash", () => {
  let p = createStagedPolicy("pol-x", { k: 1 });
  p = promoteTo(p, "observe", { authority: null, observation: null });
  const row = toPolicyEvidenceRow(p);
  assert.equal(row.policy_id, "pol-x");
  assert.equal(row.state, "observe");
  assert.ok(row.policy_hash.length > 0);
  assert.equal(row.lineage_head?.to_state, "observe");
});

test("observe is not treated as enforcing in evidence row", () => {
  let p = createStagedPolicy("p1");
  p = promoteTo(p, "observe", { authority: null, observation: null });
  const row = toPolicyEvidenceRow(p);
  assert.equal(row.state, "observe");
  assert.notEqual(row.state, "enforcing");
});

// ---------------------------------------------------------------------------
// Config / materialize: enforcing requires VERIFIED promotion provenance
// (#695 review 1c974526, delta 66803fac)
// ---------------------------------------------------------------------------

test("createStagedPolicy rejects bare enforcing without provenance", () => {
  assert.throws(
    () => createStagedPolicy("p1", {}, "enforcing"),
    /verified promotion provenance|config-declared lineage cannot mint authority/i,
  );
  assert.throws(
    () => stagedPolicyFromDecl({ policy_id: "p1", state: "enforcing" }),
    /verified promotion provenance|config-declared lineage cannot mint authority/i,
  );
  assert.throws(
    () => assertEnforcingLineage("p1", "enforcing", []),
    /verified promotion provenance|config-declared lineage cannot mint authority/i,
  );
});

test("createStagedPolicy rejects bare retired without provenance", () => {
  assert.throws(
    () => createStagedPolicy("p1", {}, "retired"),
    /verified promotion provenance|config-declared lineage cannot mint authority|retired/i,
  );
  assert.throws(
    () => stagedPolicyFromDecl({ policy_id: "p1", state: "retired" }),
    /verified promotion provenance|retired/i,
  );
});

test("forged single-head required→enforcing lineage is rejected", () => {
  const acceptance = { gate: true };
  const forged: PolicyLineageEvent = {
    policy_id: "p1",
    from_state: "required",
    to_state: "enforcing",
    policy_hash_before: computeStagedPolicyHash({
      policy_id: "p1",
      state: "required",
      acceptance,
    }),
    policy_hash_after: computeStagedPolicyHash({
      policy_id: "p1",
      state: "enforcing",
      acceptance,
    }),
    at: AT,
    authority: AUTH,
    evidence_refs: ["obs://1"],
  };
  // Even with verified provenance claimed, the structural path check rejects.
  assert.throws(
    () =>
      validateMaterializedLineage({
        policy_id: "p1",
        state: "enforcing",
        acceptance,
        lineage: [forged],
        verified: true,
      }),
    /complete predecessor chain|self-attested|draft→observe→required→enforcing/i,
  );
  assert.equal(hasValidEnforcingPromotionLineage("p1", [forged], acceptance), false);
  assert.equal(
    enforcingStateHasLineage({
      policy_id: "p1",
      state: "enforcing",
      acceptance,
      lineage: [forged],
    }),
    false,
  );
});

test("forged lineage with arbitrary non-empty hashes is rejected", () => {
  const forgedPath: PolicyLineageEvent[] = [
    {
      policy_id: "p1",
      from_state: "draft",
      to_state: "observe",
      policy_hash_before: "a".repeat(64),
      policy_hash_after: "b".repeat(64),
      at: AT,
      authority: null,
      evidence_refs: [],
    },
    {
      policy_id: "p1",
      from_state: "observe",
      to_state: "required",
      policy_hash_before: "b".repeat(64),
      policy_hash_after: "c".repeat(64),
      at: AT,
      authority: null,
      evidence_refs: ["obs://1"],
    },
    {
      policy_id: "p1",
      from_state: "required",
      to_state: "enforcing",
      policy_hash_before: "c".repeat(64),
      policy_hash_after: "d".repeat(64),
      at: AT,
      authority: AUTH,
      evidence_refs: ["obs://1"],
    },
  ];
  assert.throws(
    () =>
      validateMaterializedLineage({
        policy_id: "p1",
        state: "enforcing",
        acceptance: { gate: true },
        lineage: forgedPath,
        verified: true,
      }),
    /recomputed hash|forged or stale/i,
  );
});

test("illegal predecessor edge in lineage chain is rejected", () => {
  const acceptance = {};
  const bad: PolicyLineageEvent[] = [
    {
      policy_id: "p1",
      from_state: "draft",
      to_state: "observe",
      policy_hash_before: computeStagedPolicyHash({
        policy_id: "p1",
        state: "draft",
        acceptance,
      }),
      policy_hash_after: computeStagedPolicyHash({
        policy_id: "p1",
        state: "observe",
        acceptance,
      }),
      at: AT,
      authority: null,
      evidence_refs: [],
    },
    {
      policy_id: "p1",
      from_state: "observe",
      to_state: "enforcing",
      policy_hash_before: computeStagedPolicyHash({
        policy_id: "p1",
        state: "observe",
        acceptance,
      }),
      policy_hash_after: computeStagedPolicyHash({
        policy_id: "p1",
        state: "enforcing",
        acceptance,
      }),
      at: AT,
      authority: AUTH,
      evidence_refs: ["obs://1"],
    },
  ];
  assert.throws(
    () =>
      validateMaterializedLineage({
        policy_id: "p1",
        state: "enforcing",
        acceptance,
        lineage: bad,
        verified: true,
      }),
    /illegal edge|complete predecessor/i,
  );
});

test("evidence-less observe→required or required→enforcing is rejected", () => {
  const acceptance = { gate: true };
  const lineage = buildLegalEnforcingLineage("p1", acceptance);
  lineage[1] = { ...lineage[1]!, evidence_refs: [] };
  assert.throws(
    () =>
      validateMaterializedLineage({
        policy_id: "p1",
        state: "enforcing",
        acceptance,
        lineage,
        verified: true,
      }),
    /evidence_refs/i,
  );
});

test("non-ISO at timestamp is rejected", () => {
  assert.equal(isIso8601Timestamp("not-a-date"), false);
  assert.equal(isIso8601Timestamp(AT), true);
  const acceptance = {};
  const lineage = buildLegalEnforcingLineage("p1", acceptance, "yesterday");
  assert.throws(
    () =>
      validateMaterializedLineage({
        policy_id: "p1",
        state: "enforcing",
        acceptance,
        lineage,
        verified: true,
      }),
    /ISO 8601/i,
  );
});

test("enforcing lineage missing authority on promotion is rejected", () => {
  const acceptance = {};
  const lineage = buildLegalEnforcingLineage("p1", acceptance);
  lineage[2] = { ...lineage[2]!, authority: null };
  assert.throws(
    () =>
      validateMaterializedLineage({
        policy_id: "p1",
        state: "enforcing",
        acceptance,
        lineage,
        verified: true,
      }),
    /authority/i,
  );
  assert.equal(hasValidEnforcingPromotionLineage("p1", lineage, acceptance), false);
});

test("config-declared enforcing with full validated lineage is REJECTED (#695 66803fac)", () => {
  // A config author can construct a locally-consistent draft→…→enforcing chain
  // with recomputed hashes, evidence_refs, and an authority claim. That is NOT
  // independently verified promotion: config load must reject static enforcing.
  const acceptance = { gate: true };
  const lineage = buildLegalEnforcingLineage("p1", acceptance);
  assert.throws(
    () => createStagedPolicy("p1", acceptance, "enforcing", lineage),
    /verified promotion provenance|config-declared lineage cannot mint authority/i,
  );
  assert.throws(
    () => stagedPolicyFromDecl({ policy_id: "p1", state: "enforcing", acceptance, lineage }),
    /verified promotion provenance|config-declared lineage cannot mint authority/i,
  );
  assert.equal(hasValidEnforcingPromotionLineage("p1", lineage, acceptance), false);
  // Engine transition path reaches enforcing with verified provenance.
  let runtime = createStagedPolicy("p1", acceptance);
  runtime = promoteTo(runtime, "observe", { authority: null, observation: null });
  runtime = promoteTo(runtime, "required");
  runtime = promoteTo(runtime, "enforcing");
  assert.equal(runtime.state, "enforcing");
  assert.equal(runtime.promotion_provenance?.kind, "engine-transition");
  assert.equal(runtime.promotion_provenance?.actor, "operator");
  assert.equal(enforcingStateHasLineage(runtime), true);
  validateMaterializedLineage({
    policy_id: runtime.policy_id,
    state: runtime.state,
    acceptance: runtime.acceptance,
    lineage: runtime.lineage,
    verified: true,
  });
});

test("forged StagedPolicy with valid lineage but no provenance fails invariant (#695 delta)", () => {
  // A caller can hand-construct a structurally valid enforcing policy with the
  // full draft→…→enforcing chain — but without engine-attested provenance it
  // must NOT satisfy the enforcing invariant.
  const acceptance = { gate: true };
  const lineage = buildLegalEnforcingLineage("p1", acceptance);
  const forged: StagedPolicy = {
    policy_id: "p1",
    state: "enforcing",
    acceptance,
    lineage,
  };
  assert.equal(forged.promotion_provenance, undefined);
  assert.equal(enforcingStateHasLineage(forged), false);
  // Stale provenance token (hash mismatch) also fails closed.
  const stale: StagedPolicy = {
    ...forged,
    promotion_provenance: {
      kind: "engine-transition",
      policy_hash: "0".repeat(64),
      actor: "operator",
      role: "policy-admin",
      observed_at: AT,
    },
  };
  assert.equal(enforcingStateHasLineage(stale), false);
});

test("authorized retirement lineage is accepted via verified; bare retired is not", () => {
  const acceptance = { gate: true };
  const enforceLineage = buildLegalEnforcingLineage("p1", acceptance);
  const retireEvent: PolicyLineageEvent = {
    policy_id: "p1",
    from_state: "enforcing",
    to_state: "retired",
    policy_hash_before: computeStagedPolicyHash({
      policy_id: "p1",
      state: "enforcing",
      acceptance,
    }),
    policy_hash_after: computeStagedPolicyHash({
      policy_id: "p1",
      state: "retired",
      acceptance,
    }),
    at: AT,
    authority: AUTH,
    evidence_refs: [],
  };
  // Config/materialize with retired is unverified → rejected outright.
  assert.throws(
    () => createStagedPolicy("p1", acceptance, "retired", [...enforceLineage, retireEvent]),
    /verified promotion provenance|retired/i,
  );
  // Verified engine retirement chain is accepted.
  validateMaterializedLineage({
    policy_id: "p1",
    state: "retired",
    acceptance,
    lineage: [...enforceLineage, retireEvent],
    verified: true,
  });

  const noAuth = { ...retireEvent, authority: null };
  assert.throws(
    () =>
      validateMaterializedLineage({
        policy_id: "p1",
        state: "retired",
        acceptance,
        lineage: [...enforceLineage, noAuth],
        verified: true,
      }),
    /authority|retired/i,
  );
});

test("draft is the only empty-lineage initial state; observe/required need predecessor chain", () => {
  const draft = createStagedPolicy("p1", {}, "draft");
  assert.equal(draft.state, "draft");
  assert.equal(draft.lineage.length, 0);
  assert.equal(enforcingStateHasLineage(draft), true);

  assert.throws(
    () => createStagedPolicy("p1", {}, "observe"),
    /requires validated append-only lineage|lineage-free/i,
  );
  assert.throws(
    () => createStagedPolicy("p1", {}, "required"),
    /requires validated append-only lineage|lineage-free|required requires/i,
  );
  assert.throws(
    () => stagedPolicyFromDecl({ policy_id: "p1", state: "required" }),
    /requires validated append-only lineage|lineage-free|required requires/i,
  );
});

test("lineage-free required materialization is rejected (#695 121f8a7b)", () => {
  assert.throws(
    () =>
      validateMaterializedLineage({
        policy_id: "p1",
        state: "required",
        acceptance: {},
        lineage: [],
      }),
    /requires validated append-only lineage/,
  );
  // Single-head observe→required without draft→observe is also rejected.
  const acceptance = { gate: true };
  const forgedHead: PolicyLineageEvent = {
    policy_id: "p1",
    from_state: "observe",
    to_state: "required",
    policy_hash_before: computeStagedPolicyHash({
      policy_id: "p1",
      state: "observe",
      acceptance,
    }),
    policy_hash_after: computeStagedPolicyHash({
      policy_id: "p1",
      state: "required",
      acceptance,
    }),
    at: AT,
    authority: null,
    evidence_refs: ["obs://1"],
  };
  assert.throws(
    () =>
      validateMaterializedLineage({
        policy_id: "p1",
        state: "required",
        acceptance,
        lineage: [forgedHead],
      }),
    /required requires the complete predecessor chain|draft→observe→required/i,
  );
});

test("required with full draft→observe→required validated lineage is accepted", () => {
  const acceptance = { gate: true };
  const lineage = buildLegalPromotionLineage("p1", "required", acceptance);
  validateMaterializedLineage({
    policy_id: "p1",
    state: "required",
    acceptance,
    lineage,
  });
  const p = createStagedPolicy("p1", acceptance, "required", lineage);
  assert.equal(p.state, "required");
  assert.equal(p.lineage.length, 2);
  assert.equal(p.lineage[0]!.from_state, "draft");
  assert.equal(p.lineage[1]!.to_state, "required");
});

test("observe with draft→observe validated lineage is accepted", () => {
  const acceptance = {};
  const lineage = buildLegalPromotionLineage("p1", "observe", acceptance);
  const p = createStagedPolicy("p1", acceptance, "observe", lineage);
  assert.equal(p.state, "observe");
  assert.equal(p.lineage.length, 1);
});
