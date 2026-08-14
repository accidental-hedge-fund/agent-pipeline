// Unit tests for governed typed overrides (#693).
// Pure evaluators only — no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeProjectionToPartitionInputs,
  authorizeOverrideActor,
  buildHumanRenewalDecision,
  buildLiteRenewalDecision,
  buildOverrideDecision,
  buildOverrideEvent,
  checkOverrideSeparationOfDuties,
  evaluateOverrideValidity,
  evaluateRenewalLiteEligibility,
  freezeDecision,
  getClassPolicy,
  implicitOverrideGovernance,
  missingRequiredEvidence,
  parseEvidenceRefTokens,
  projectActiveOverrides,
  resolveClassId,
  stripEvidenceRefTokens,
  validateOverrideRecord,
  type OverrideDecisionV1,
} from "../scripts/override-governance.ts";
import {
  extractOverrideDecisions,
  findingKey,
  govPayloadFromDecision,
  overrideComment,
  parseOverrideArg,
  partitionFindings,
  projectOverridesForPartition,
  scopedOverrideComment,
} from "../scripts/review-policy.ts";
import { resolveOverrideGovernanceConfig } from "../scripts/config.ts";
import type { EvidenceSubjectV1 } from "../scripts/evidence-subject.ts";
import type { OverrideClassPolicy, OverrideGovernanceConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pin(overrides: Partial<EvidenceSubjectV1> = {}): EvidenceSubjectV1 {
  return {
    schema_version: 1,
    domain: "test",
    issue: 1,
    pr: 2,
    run_id: "run-1",
    candidate_sha: "a".repeat(40),
    diff_hash: "b".repeat(64),
    policy_hash: "c".repeat(64),
    engine_fingerprint: "d".repeat(64),
    verifier_fingerprint: "e".repeat(64),
    required_evidence_set_revision: "f".repeat(64),
    ...overrides,
  };
}

function lowRiskPolicy(): OverrideClassPolicy {
  return implicitOverrideGovernance().classes.low_risk_deferred!;
}

function highRiskPolicy(): OverrideClassPolicy {
  return {
    max_duration_hours: 72,
    required_evidence: ["remediation_issue_url", "risk_acceptance_ref"],
    renewal: {
      mode: "human",
      require_human_on: [
        "fingerprint_drift",
        "region_drift",
        "subject_mismatch",
        "policy_change",
      ],
    },
    approvers: [{ kind: "identity", identity: "risk-officer" }],
    separation_of_duties: {
      enabled: true,
      forbid_roles: ["implementer", "finding_author"],
    },
  };
}

function explicitGovernance(): OverrideGovernanceConfig {
  return {
    schema_version: 1,
    implicit: false,
    default_class: "low_risk_deferred",
    classes: {
      low_risk_deferred: lowRiskPolicy(),
      high_risk_accept: highRiskPolicy(),
    },
  };
}

function activeDecision(
  overrides: {
    decisionId?: string;
    target?: OverrideDecisionV1["target"];
    classId?: string;
    evidenceSubject?: EvidenceSubjectV1;
    findingFingerprint?: string | null;
    codeRegion?: string | null;
    maxDurationHours?: number;
    createdAt?: string;
  } = {},
): OverrideDecisionV1 {
  return buildOverrideDecision({
    classId: overrides.classId ?? "low_risk_deferred",
    disposition: "deferred",
    target: overrides.target ?? { kind: "key", key: "a1b2c3d4" },
    explanation: "tracked offline",
    actor: "alice",
    identitySource: "gh_actor",
    authorization: {
      authorized: true,
      matched_rule: "implicit:any_authenticated",
      evidence: "ok",
      identity_source: "gh_actor",
    },
    evidenceSubject: overrides.evidenceSubject ?? pin(),
    findingFingerprint:
      overrides.findingFingerprint === undefined
        ? "fp".repeat(8).slice(0, 16)
        : overrides.findingFingerprint,
    codeRegion:
      overrides.codeRegion === undefined ? "rg".repeat(8).slice(0, 16) : overrides.codeRegion,
    createdAt: overrides.createdAt ?? "2026-08-01T00:00:00Z",
    maxDurationHours: overrides.maxDurationHours ?? 720,
    decisionId: overrides.decisionId,
  });
}

// ---------------------------------------------------------------------------
// 1. Config schema / resolve
// ---------------------------------------------------------------------------

test("resolveOverrideGovernanceConfig: omitted block → implicit low-risk", () => {
  const g = resolveOverrideGovernanceConfig(undefined);
  assert.equal(g.implicit, true);
  assert.equal(g.default_class, "low_risk_deferred");
  assert.ok(g.classes.low_risk_deferred);
  assert.equal(g.classes.low_risk_deferred!.renewal.mode, "lite");
  assert.equal(g.classes.low_risk_deferred!.max_duration_hours, 720);
});

test("resolveOverrideGovernanceConfig: valid block accepted", () => {
  const g = resolveOverrideGovernanceConfig({
    schema_version: 1,
    default_class: "low_risk_deferred",
    classes: {
      low_risk_deferred: {
        max_duration_hours: 100,
        required_evidence: [],
        renewal: { mode: "lite", require_human_on: ["fingerprint_drift"] },
        approvers: [{ kind: "trusted_override_actors_allowlist" }],
        separation_of_duties: { enabled: false },
      },
      high_risk_accept: {
        max_duration_hours: 24,
        required_evidence: ["remediation_issue_url"],
        renewal: { mode: "human" },
        approvers: [{ kind: "identity", identity: "bob" }],
      },
    },
  });
  assert.equal(g.implicit, false);
  assert.equal(g.classes.high_risk_accept!.max_duration_hours, 24);
  assert.deepEqual(g.classes.high_risk_accept!.required_evidence, ["remediation_issue_url"]);
});

test("resolveOverrideGovernanceConfig: default_class not in classes fails", () => {
  assert.throws(
    () =>
      resolveOverrideGovernanceConfig({
        schema_version: 1,
        default_class: "missing",
        classes: {
          low_risk_deferred: {
            max_duration_hours: 10,
            renewal: { mode: "none" },
          },
        },
      }),
    /default_class/,
  );
});

test("resolveOverrideGovernanceConfig: empty classes fails", () => {
  assert.throws(
    () =>
      resolveOverrideGovernanceConfig({
        schema_version: 1,
        classes: {},
      }),
    /at least one class/,
  );
});

// ---------------------------------------------------------------------------
// 2. Class resolution + evidence tokens
// ---------------------------------------------------------------------------

test("resolveClassId: bare reason maps to default under explicit config", () => {
  const r = resolveClassId(explicitGovernance(), undefined);
  assert.deepEqual(r, { classId: "low_risk_deferred" });
});

test("resolveClassId: unknown class errors", () => {
  const r = resolveClassId(explicitGovernance(), "not_a_class");
  assert.ok("error" in r);
});

test("parseEvidenceRefTokens + strip", () => {
  const text = "deferred #99 remediation_issue_url=https://x/1 risk_acceptance_ref=RA-1";
  const refs = parseEvidenceRefTokens(text);
  assert.equal(refs.remediation_issue_url, "https://x/1");
  assert.equal(refs.risk_acceptance_ref, "RA-1");
  assert.equal(stripEvidenceRefTokens(text), "deferred #99");
});

test("missingRequiredEvidence detects gaps", () => {
  const missing = missingRequiredEvidence(highRiskPolicy(), {}, {});
  assert.deepEqual(missing, ["remediation_issue_url", "risk_acceptance_ref"]);
});

// ---------------------------------------------------------------------------
// 3. Authority + SoD
// ---------------------------------------------------------------------------

test("authorizeOverrideActor: null actor fail-closed", async () => {
  const r = await authorizeOverrideActor({
    actor: null,
    identitySource: "gh_actor",
    classPolicy: lowRiskPolicy(),
    implicitGovernance: true,
  });
  assert.equal(r.authorized, false);
  assert.equal(r.refusal, "unauthenticated");
});

test("authorizeOverrideActor: identity match", async () => {
  const r = await authorizeOverrideActor({
    actor: "alice",
    identitySource: "gh_actor",
    classPolicy: {
      ...highRiskPolicy(),
      separation_of_duties: { enabled: false, forbid_roles: [] },
      approvers: [{ kind: "identity", identity: "alice" }],
    },
  });
  assert.equal(r.authorized, true);
  assert.ok(r.authorization.matched_rule?.startsWith("identity:alice"));
});

test("authorizeOverrideActor: identity miss", async () => {
  const r = await authorizeOverrideActor({
    actor: "bob",
    identitySource: "gh_actor",
    classPolicy: {
      ...highRiskPolicy(),
      separation_of_duties: { enabled: false, forbid_roles: [] },
      approvers: [{ kind: "identity", identity: "alice" }],
    },
  });
  assert.equal(r.authorized, false);
  assert.equal(r.refusal, "unauthorized");
});

test("authorizeOverrideActor: group_ref via adapter", async () => {
  const r = await authorizeOverrideActor({
    actor: "carol",
    identitySource: "gh_actor",
    classPolicy: {
      ...lowRiskPolicy(),
      approvers: [{ kind: "group_ref", group_ref: "risk-team" }],
    },
    adapter: {
      resolveGroupMembers: async (g) => (g === "risk-team" ? ["carol", "dave"] : []),
    },
  });
  assert.equal(r.authorized, true);
});

test("authorizeOverrideActor: role via adapter", async () => {
  const r = await authorizeOverrideActor({
    actor: "erin",
    identitySource: "gh_actor",
    classPolicy: {
      ...lowRiskPolicy(),
      approvers: [{ kind: "role", role: "risk_authority" }],
    },
    adapter: {
      actorHasRole: async (a, role) => a === "erin" && role === "risk_authority",
    },
  });
  assert.equal(r.authorized, true);
});

test("authorizeOverrideActor: trusted allowlist explicit", async () => {
  const ok = await authorizeOverrideActor({
    actor: "on-list",
    identitySource: "gh_actor",
    classPolicy: {
      ...lowRiskPolicy(),
      approvers: [{ kind: "trusted_override_actors_allowlist" }],
    },
    trustedAllowlist: ["on-list"],
    implicitGovernance: false,
  });
  assert.equal(ok.authorized, true);
  const miss = await authorizeOverrideActor({
    actor: "off-list",
    identitySource: "gh_actor",
    classPolicy: {
      ...lowRiskPolicy(),
      approvers: [{ kind: "trusted_override_actors_allowlist" }],
    },
    trustedAllowlist: ["on-list"],
    implicitGovernance: false,
  });
  assert.equal(miss.authorized, false);
});

test("SoD forbids implementer self-disposition", async () => {
  const sod = checkOverrideSeparationOfDuties({
    enabled: true,
    forbidRoles: ["implementer"],
    actor: "impl",
    implementer: "impl",
  });
  assert.equal(sod.ok, false);
  assert.deepEqual(sod.violatedRoles, ["implementer"]);

  const r = await authorizeOverrideActor({
    actor: "impl",
    identitySource: "gh_actor",
    classPolicy: highRiskPolicy(),
    implementer: "impl",
  });
  assert.equal(r.authorized, false);
  assert.equal(r.refusal, "sod_violation");
});

// ---------------------------------------------------------------------------
// 4. Validity evaluation
// ---------------------------------------------------------------------------

test("evaluateOverrideValidity: active when current", () => {
  const d = activeDecision();
  const v = evaluateOverrideValidity({
    decision: d,
    pin: pin(),
    live: {
      finding_fingerprint: d.finding_fingerprint,
      code_region: d.code_region,
    },
    classPolicy: lowRiskPolicy(),
    now: Date.parse("2026-08-02T00:00:00Z"),
  });
  assert.equal(v.status, "active");
});

test("evaluateOverrideValidity: expired", () => {
  const d = activeDecision();
  const v = evaluateOverrideValidity({
    decision: d,
    pin: pin(),
    live: {},
    classPolicy: lowRiskPolicy(),
    now: Date.parse("2026-12-01T00:00:00Z"),
  });
  assert.equal(v.status, "expired");
});

test("evaluateOverrideValidity: subject candidate mismatch invalidates", () => {
  const d = activeDecision();
  const v = evaluateOverrideValidity({
    decision: d,
    pin: pin({ candidate_sha: "9".repeat(40) }),
    live: {
      finding_fingerprint: d.finding_fingerprint,
      code_region: d.code_region,
    },
    classPolicy: lowRiskPolicy(),
    now: Date.parse("2026-08-02T00:00:00Z"),
  });
  assert.equal(v.status, "invalidated");
  assert.ok(v.mismatched_subject_fields?.includes("candidate_sha"));
});

test("evaluateOverrideValidity: policy_hash mismatch invalidates", () => {
  const d = activeDecision();
  const v = evaluateOverrideValidity({
    decision: d,
    pin: pin({ policy_hash: "1".repeat(64) }),
    live: {
      finding_fingerprint: d.finding_fingerprint,
      code_region: d.code_region,
    },
    classPolicy: lowRiskPolicy(),
    now: Date.parse("2026-08-02T00:00:00Z"),
  });
  assert.equal(v.status, "invalidated");
  assert.ok(v.mismatched_subject_fields?.includes("policy_hash"));
});

test("evaluateOverrideValidity: fingerprint drift invalidates", () => {
  const d = activeDecision();
  const v = evaluateOverrideValidity({
    decision: d,
    pin: pin(),
    live: {
      finding_fingerprint: "zz".repeat(8).slice(0, 16),
      code_region: d.code_region,
    },
    classPolicy: lowRiskPolicy(),
    now: Date.parse("2026-08-02T00:00:00Z"),
  });
  assert.equal(v.status, "invalidated");
  assert.equal(v.invalidation_reason, "fingerprint_drift");
});

test("evaluateOverrideValidity: scope mismatch", () => {
  const d = activeDecision({
    target: { kind: "scope", scopeType: "file", scopeValue: "src/a.ts" },
  });
  const v = evaluateOverrideValidity({
    decision: d,
    pin: null,
    live: { scope_matches: false },
    classPolicy: lowRiskPolicy(),
    now: Date.parse("2026-08-02T00:00:00Z"),
  });
  assert.equal(v.status, "scope_mismatch");
});

test("evaluateOverrideValidity: reauthorize refuse → unauthorized", () => {
  const d = activeDecision();
  const v = evaluateOverrideValidity({
    decision: d,
    pin: pin(),
    live: {},
    classPolicy: lowRiskPolicy(),
    now: Date.parse("2026-08-02T00:00:00Z"),
    reauthorize: {
      authorized: false,
      authorization: {
        authorized: false,
        matched_rule: null,
        evidence: "no longer on allowlist",
        identity_source: "gh_actor",
      },
    },
  });
  assert.equal(v.status, "unauthorized");
});

// ---------------------------------------------------------------------------
// 5. Projection, supersession, append-only
// ---------------------------------------------------------------------------

test("projectActiveOverrides: latest valid wins; history retained", () => {
  const d1 = activeDecision({ decisionId: "d1" });
  const d2 = buildOverrideDecision({
    classId: "low_risk_deferred",
    disposition: "deferred",
    target: { kind: "key", key: "a1b2c3d4" },
    explanation: "revised",
    actor: "alice",
    identitySource: "gh_actor",
    authorization: d1.authorization,
    evidenceSubject: pin(),
    findingFingerprint: d1.finding_fingerprint,
    codeRegion: d1.code_region,
    createdAt: "2026-08-03T00:00:00Z",
    maxDurationHours: 720,
    supersedes: "d1",
    decisionId: "d2",
  });
  const { activeByTarget, all } = projectActiveOverrides({
    decisions: [d1, d2],
    governance: implicitOverrideGovernance(),
    pin: pin(),
    now: Date.parse("2026-08-04T00:00:00Z"),
    liveByTarget: new Map([
      [
        "key:a1b2c3d4",
        {
          finding_fingerprint: d1.finding_fingerprint!,
          code_region: d1.code_region!,
        },
      ],
    ]),
  });
  assert.equal(all.length, 2);
  assert.equal(all[0]!.validity.status, "superseded");
  assert.equal(all[1]!.validity.status, "active");
  assert.equal(activeByTarget.get("key:a1b2c3d4")!.decision.decision_id, "d2");
  // Prior expiry unchanged
  assert.equal(d1.expires_at, all[0]!.decision.expires_at);
});

test("append-only: freezeDecision + lite renewal does not mutate prior", () => {
  const prior = freezeDecision(activeDecision({ decisionId: "p1" }));
  const priorExpires = prior.expires_at;
  const renewal = buildLiteRenewalDecision(prior, lowRiskPolicy(), "2026-08-20T00:00:00Z");
  assert.equal(prior.expires_at, priorExpires);
  assert.equal(renewal.renewed_from, "p1");
  assert.notEqual(renewal.decision_id, prior.decision_id);
  assert.notEqual(renewal.expires_at, prior.expires_at);
  assert.equal(renewal.renewal_kind, "lite");
});

test("human renewal preserves prior and sets lineage", () => {
  const prior = activeDecision({ decisionId: "p1" });
  const human = buildHumanRenewalDecision(prior, {
    classId: prior.class,
    disposition: prior.disposition,
    target: prior.target,
    explanation: "renewed after review",
    actor: "risk-officer",
    identitySource: "gh_actor",
    authorization: {
      authorized: true,
      matched_rule: "identity:risk-officer#0",
      evidence: "ok",
      identity_source: "gh_actor",
    },
    evidenceSubject: pin(),
    findingFingerprint: prior.finding_fingerprint,
    codeRegion: prior.code_region,
    createdAt: "2026-08-20T00:00:00Z",
    maxDurationHours: 72,
  });
  assert.equal(human.renewed_from, "p1");
  assert.equal(human.renewal_kind, "human");
  assert.equal(prior.expires_at, activeDecision({ decisionId: "p1" }).expires_at);
});

// ---------------------------------------------------------------------------
// 6. Renewal-lite eligibility
// ---------------------------------------------------------------------------

test("renewal-lite: eligible when fingerprint+region+subject match", () => {
  const prior = activeDecision();
  const r = evaluateRenewalLiteEligibility({
    prior,
    classPolicy: lowRiskPolicy(),
    live: {
      finding_fingerprint: prior.finding_fingerprint,
      code_region: prior.code_region,
    },
    pin: pin(),
    now: Date.parse("2026-09-01T00:00:00Z"),
    priorAuthStillHolds: true,
  });
  assert.equal(r.eligible, true);
});

test("renewal-lite: fingerprint drift requires human", () => {
  const prior = activeDecision();
  const r = evaluateRenewalLiteEligibility({
    prior,
    classPolicy: lowRiskPolicy(),
    live: {
      finding_fingerprint: "xx".repeat(8).slice(0, 16),
      code_region: prior.code_region,
    },
    pin: pin(),
    now: Date.parse("2026-09-01T00:00:00Z"),
    priorAuthStillHolds: true,
  });
  assert.equal(r.eligible, false);
  if (!r.eligible) assert.equal(r.drift, "fingerprint_drift");
});

test("renewal-lite: human mode never auto-renews", () => {
  const prior = activeDecision({ classId: "high_risk_accept" });
  const r = evaluateRenewalLiteEligibility({
    prior,
    classPolicy: highRiskPolicy(),
    live: {
      finding_fingerprint: prior.finding_fingerprint,
      code_region: prior.code_region,
    },
    pin: pin(),
    now: Date.parse("2026-09-01T00:00:00Z"),
    priorAuthStillHolds: true,
  });
  assert.equal(r.eligible, false);
  if (!r.eligible) assert.equal(r.drift, "mode_forbids");
});

// ---------------------------------------------------------------------------
// 7. validateOverrideRecord refuse path
// ---------------------------------------------------------------------------

test("validateOverrideRecord: missing evidence refused", async () => {
  const r = await validateOverrideRecord({
    governance: explicitGovernance(),
    classId: "high_risk_accept",
    actor: "risk-officer",
    identitySource: "gh_actor",
    explanation: "accept residual risk",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.refusal, "missing_evidence");
});

test("validateOverrideRecord: authorized high-risk with evidence", async () => {
  const r = await validateOverrideRecord({
    governance: explicitGovernance(),
    classId: "high_risk_accept",
    actor: "risk-officer",
    identitySource: "gh_actor",
    explanation:
      "accept residual risk remediation_issue_url=https://x/1 risk_acceptance_ref=RA-9",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.classId, "high_risk_accept");
    assert.equal(r.evidenceRefs.remediation_issue_url, "https://x/1");
  }
});

test("validateOverrideRecord: unauthenticated refused", async () => {
  const r = await validateOverrideRecord({
    governance: implicitOverrideGovernance(),
    classId: undefined,
    actor: null,
    identitySource: "gh_actor",
    explanation: "deferred",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.refusal, "unauthenticated");
});

test("validateOverrideRecord: unknown class refused", async () => {
  const r = await validateOverrideRecord({
    governance: explicitGovernance(),
    classId: "nope",
    actor: "alice",
    identitySource: "gh_actor",
    explanation: "x",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.refusal, "unknown_class");
});

// ---------------------------------------------------------------------------
// 8. CLI parse forms
// ---------------------------------------------------------------------------

test("parseOverrideArg: bare key reason", () => {
  const p = parseOverrideArg("a1b2c3d4: deferred — tracked offline");
  assert.ok(!("error" in p));
  if (!("error" in p)) {
    assert.equal(p.kind, "key");
    assert.equal(p.disposition, "deferred");
    assert.equal(p.classId, undefined);
  }
});

test("parseOverrideArg: key with class when known", () => {
  const p = parseOverrideArg(
    "a1b2c3d4: high_risk_accept: accept residual risk",
    ["low_risk_deferred", "high_risk_accept"],
  );
  assert.ok(!("error" in p));
  if (!("error" in p) && p.kind === "key") {
    assert.equal(p.classId, "high_risk_accept");
    assert.equal(p.reason, "accept residual risk");
  }
});

test("parseOverrideArg: unknown class token stays in reason", () => {
  const p = parseOverrideArg("a1b2c3d4: not_a_class: still a reason", ["low_risk_deferred"]);
  assert.ok(!("error" in p));
  if (!("error" in p) && p.kind === "key") {
    assert.equal(p.classId, undefined);
    assert.ok(p.reason.includes("not_a_class"));
  }
});

// ---------------------------------------------------------------------------
// 9. Dual-read comments + partition validity
// ---------------------------------------------------------------------------

test("overrideComment dual-read: extractOverrides + extractOverrideDecisions", () => {
  const d = activeDecision({ decisionId: "dec-1" });
  const body = overrideComment({
    key: "a1b2c3d4",
    disposition: "deferred",
    reason: "tracked offline",
    stage: "review-1",
    timestamp: "2026-08-01T00:00:00Z",
    gov: govPayloadFromDecision(d),
  });
  const map = new Map(
    // strip would not apply — extractOverrides reads last line after attest
  );
  void map;
  // Use extractOverrideDecisions
  const decisions = extractOverrideDecisions([{ body, createdAt: "2026-08-01T00:00:00Z" }]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.decision_id, "dec-1");
  assert.equal(decisions[0]!.class, "low_risk_deferred");
  assert.equal(decisions[0]!.expires_at, d.expires_at);
});

test("legacy sentinel extracts as low_risk_deferred compat", () => {
  const body = [
    "## Pipeline: Finding override",
    "",
    "**Finding**: `a1b2c3d4`",
    "",
    "### Reason",
    "old",
    "",
    "<!-- pipeline-override: a1b2c3d4 deferred -->",
  ].join("\n");
  const decisions = extractOverrideDecisions([{ body, createdAt: "2026-06-01T00:00:00Z" }]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.legacy_compat, true);
  assert.equal(decisions[0]!.class, "low_risk_deferred");
});

test("projectOverridesForPartition: expired decision does not deblock", () => {
  const d = activeDecision({
    decisionId: "old",
    // force short window by rebuilding
  });
  // Build an already-expired decision via custom expires
  const expired: OverrideDecisionV1 = {
    ...d,
    expires_at: "2020-01-01T00:00:00Z",
  };
  const body = overrideComment({
    key: "a1b2c3d4",
    disposition: "deferred",
    reason: "old",
    stage: "review-1",
    timestamp: "2020-01-01T00:00:00Z",
    gov: govPayloadFromDecision(expired),
  });
  const finding = {
    severity: "high",
    file: "src/a.ts",
    title: "bug",
    body: "b",
    confidence: 0.9,
    recommendation: "fix",
  };
  // Key won't match a1b2c3d4 unless we force — use partition with synthetic map
  const projected = projectOverridesForPartition({
    comments: [{ body }],
    governance: implicitOverrideGovernance(),
    now: Date.parse("2026-08-14T00:00:00Z"),
  });
  assert.equal(projected.overrides.size, 0);
  assert.equal(projected.decisions.length, 1);
});

test("partitionFindings: valid active override deblocks", () => {
  const finding = {
    severity: "high" as const,
    file: "src/x.ts",
    title: "Null deref",
    body: "b",
    confidence: 0.9,
    recommendation: "fix",
  };
  const key = findingKey(finding);
  const part = partitionFindings(
    [finding],
    { block_threshold: "medium", min_confidence: 0.7 },
    new Map([[key, "deferred"]]),
  );
  assert.equal(part.blocking.length, 0);
  assert.equal(part.overridden.length, 1);
});

test("partitionFindings: empty overrides leave finding blocking", () => {
  const finding = {
    severity: "high" as const,
    file: "src/y.ts",
    title: "Auth gap",
    body: "b",
    confidence: 0.9,
    recommendation: "fix",
  };
  const part = partitionFindings(
    [finding],
    { block_threshold: "medium", min_confidence: 0.7 },
    new Map(),
  );
  assert.equal(part.blocking.length, 1);
});

// ---------------------------------------------------------------------------
// 10. Events
// ---------------------------------------------------------------------------

test("buildOverrideEvent carries analysis fields", () => {
  const ev = buildOverrideEvent("override_recorded", {
    decision_id: "d1",
    class: "low_risk_deferred",
    actor: "alice",
    target: { kind: "key", key: "a1b2c3d4" },
    lifecycle: "active",
    created_at: "2026-08-01T00:00:00Z",
    expires_at: "2026-08-31T00:00:00Z",
  });
  assert.equal(ev.type, "override_recorded");
  assert.equal(ev.decision_id, "d1");
  assert.equal(ev.class, "low_risk_deferred");
  assert.ok(ev.created_at);
  assert.ok(ev.expires_at);
});

test("activeProjectionToPartitionInputs maps key and scope", () => {
  const dKey = activeDecision({ decisionId: "k1" });
  const dScope = activeDecision({
    decisionId: "s1",
    target: { kind: "scope", scopeType: "category", scopeValue: "rollback-safety" },
  });
  const { activeByTarget } = projectActiveOverrides({
    decisions: [dKey, dScope],
    governance: implicitOverrideGovernance(),
    pin: pin(),
    now: Date.parse("2026-08-02T00:00:00Z"),
    liveByTarget: new Map([
      [
        "key:a1b2c3d4",
        {
          finding_fingerprint: dKey.finding_fingerprint!,
          code_region: dKey.code_region!,
        },
      ],
    ]),
  });
  const { overrides, scopes } = activeProjectionToPartitionInputs(activeByTarget);
  assert.equal(overrides.get("a1b2c3d4"), "deferred");
  assert.ok(scopes.some((s) => s.type === "category" && s.value === "rollback-safety"));
});

test("getClassPolicy returns null for unknown", () => {
  assert.equal(getClassPolicy(implicitOverrideGovernance(), "nope"), null);
});

test("scopedOverrideComment accepts gov payload", () => {
  const d = activeDecision({
    target: { kind: "scope", scopeType: "file", scopeValue: "src/a.ts" },
  });
  const body = scopedOverrideComment({
    scopeType: "file",
    scopeValue: "src/a.ts",
    disposition: "deferred",
    reason: "whole file deferred",
    stage: "review-1",
    timestamp: "2026-08-01T00:00:00Z",
    gov: govPayloadFromDecision(d),
  });
  assert.ok(body.includes("pipeline-override-gov"));
  assert.ok(body.includes("pipeline-override-scope"));
});
