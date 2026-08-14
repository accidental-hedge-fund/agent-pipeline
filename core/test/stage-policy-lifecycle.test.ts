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
  isLegalLifecycleEdge,
  isPolicyLifecycleState,
  POLICY_LIFECYCLE_STATES,
  stagedPolicyFromDecl,
  toPolicyEvidenceRow,
  type PolicyAuthorityRecord,
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
// Config / materialize: enforcing requires lineage (#695 review finding b24e688e)
// ---------------------------------------------------------------------------

test("createStagedPolicy rejects bare enforcing without lineage", () => {
  assert.throws(
    () => createStagedPolicy("p1", {}, "enforcing"),
    /enforcing.*lineage|lineage.*enforcing/i,
  );
  assert.throws(
    () => stagedPolicyFromDecl({ policy_id: "p1", state: "enforcing" }),
    /enforcing.*lineage|lineage.*enforcing/i,
  );
  assert.throws(
    () => assertEnforcingLineage("p1", "enforcing", []),
    /enforcing.*lineage|lineage.*enforcing/i,
  );
});

test("createStagedPolicy rejects enforcing lineage missing authority", () => {
  const forged: PolicyLineageEvent = {
    policy_id: "p1",
    from_state: "required",
    to_state: "enforcing",
    policy_hash_before: "a".repeat(64),
    policy_hash_after: "b".repeat(64),
    at: AT,
    authority: null,
    evidence_refs: [],
  };
  assert.throws(
    () => createStagedPolicy("p1", {}, "enforcing", [forged]),
    /enforcing.*lineage|authority/i,
  );
  assert.equal(hasValidEnforcingPromotionLineage("p1", [forged]), false);
  assert.equal(
    enforcingStateHasLineage({
      policy_id: "p1",
      state: "enforcing",
      acceptance: {},
      lineage: [forged],
    }),
    false,
  );
});

test("createStagedPolicy accepts enforcing when lineage has required→enforcing + authority", () => {
  const event: PolicyLineageEvent = {
    policy_id: "p1",
    from_state: "required",
    to_state: "enforcing",
    policy_hash_before: "a".repeat(64),
    policy_hash_after: "b".repeat(64),
    at: AT,
    authority: AUTH,
    evidence_refs: ["obs://1"],
  };
  const p = createStagedPolicy("p1", { gate: true }, "enforcing", [event]);
  assert.equal(p.state, "enforcing");
  assert.equal(enforcingStateHasLineage(p), true);
  assert.equal(hasValidEnforcingPromotionLineage("p1", p.lineage), true);
  const fromDecl = stagedPolicyFromDecl({
    policy_id: "p1",
    state: "enforcing",
    acceptance: { gate: true },
    lineage: [event],
  });
  assert.equal(fromDecl.state, "enforcing");
  assert.equal(fromDecl.lineage.length, 1);
});

test("non-enforcing initial states still allow empty lineage", () => {
  for (const s of ["draft", "observe", "required", "retired"] as const) {
    const p = createStagedPolicy("p1", {}, s);
    assert.equal(p.state, s);
    assert.equal(p.lineage.length, 0);
    assert.equal(enforcingStateHasLineage(p), true);
  }
});
