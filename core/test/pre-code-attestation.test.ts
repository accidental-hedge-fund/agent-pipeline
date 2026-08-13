// Unit tests for pre-code human attestation pure logic (#575).
// No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildApproveAttestationRecord,
  buildContractTraces,
  buildObjectiveManifest,
  buildRejectAttestationRecord,
  checkSeparationOfDuties,
  contractTracesFailSafe,
  dossierApprovalEligibility,
  evaluateAttestationCurrency,
  evaluatePreCodeAttestationTrigger,
  hashDossier,
  hashPreCodeAttestationPolicy,
  isSilentBypassAttempt,
  isWaitBudgetExhausted,
  parseDossierFromText,
  requireUntestableAffirmations,
  resolveAuthorizedApprover,
  validatePreCodeDesignDossier,
  waitExhaustedOutcome,
} from "../scripts/pre-code-attestation.ts";
import { DEFAULT_CONFIG, type PipelineConfig, type PreCodeDesignDossier } from "../scripts/types.ts";
import { resolvePreCodeAttestationConfig } from "../scripts/config.ts";

function cfg(overrides: Partial<PipelineConfig["pre_code_attestation"]> = {}): Pick<PipelineConfig, "pre_code_attestation"> {
  return {
    pre_code_attestation: {
      ...DEFAULT_CONFIG.pre_code_attestation,
      enabled: true,
      ...overrides,
      thresholds: {
        ...DEFAULT_CONFIG.pre_code_attestation.thresholds,
        ...(overrides.thresholds ?? {}),
      },
      expiration: {
        ...DEFAULT_CONFIG.pre_code_attestation.expiration,
        ...(overrides.expiration ?? {}),
      },
      separation_of_duties: {
        ...DEFAULT_CONFIG.pre_code_attestation.separation_of_duties,
        ...(overrides.separation_of_duties ?? {}),
      },
      wait: {
        ...DEFAULT_CONFIG.pre_code_attestation.wait,
        ...(overrides.wait ?? {}),
      },
    },
  };
}

function completeDossier(overrides: Partial<PreCodeDesignDossier> = {}): PreCodeDesignDossier {
  return {
    schema_version: 1,
    intent: "Users can attest high-risk plans before code",
    system_boundary: "pipeline engine pre-implement gate",
    interaction_sequence: "plan → dossier → human approve → implement",
    expected_delta: {
      call_stack: "evaluateTrigger → validateDossier → resolveApprover",
      file_tree: ["core/scripts/pre-code-attestation.ts", "core/scripts/stages/pre_code_attestation.ts"],
    },
    key_contracts: ["evaluatePreCodeAttestationTrigger", "PreCodeAttestationRecord"],
    slices: [
      {
        id: "s1",
        title: "Gate holds implementing without approve",
        behavior_diff: [{ op: "addition", target: "pre-code-attestation stage" }],
        behaviors: [
          {
            objective_id: "obj-happy",
            preconditions: "gate enabled and auth trigger matched",
            command_or_input: "advance at pre-code-attestation",
            expected_outcome: "blocked waiting for human attestation",
            ownership_boundary: "pipeline engine",
            failure_retry_concurrency: "reject fails closed; no silent approve",
            origin: "stated",
            verification: { kind: "ref", ref: "core/test/pre-code-attestation.test.ts" },
          },
          {
            objective_id: "obj-fail",
            preconditions: "unauthorized actor submits approve",
            command_or_input: "submit attestation",
            expected_outcome: "unauthorized outcome; not implementing",
            ownership_boundary: "pipeline engine",
            origin: "stated",
            verification: { kind: "ref", ref: "core/test/pre-code-attestation.test.ts" },
          },
        ],
      },
    ],
    dossier_author: "planner-bot",
    declared_risk_classes: ["auth"],
    declared_components: ["core/scripts/pre-code-attestation.ts"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Config defaults / resolve
// ---------------------------------------------------------------------------

test("resolvePreCodeAttestationConfig: omitted block disables gate with defaults", () => {
  const resolved = resolvePreCodeAttestationConfig(undefined);
  assert.equal(resolved.enabled, false);
  assert.ok(resolved.triggers.includes("auth"));
  assert.equal(resolved.wait.mode, "resume_safe");
  assert.equal(resolved.separation_of_duties.enabled, false);
});

test("resolvePreCodeAttestationConfig: enabled subset of triggers", () => {
  const resolved = resolvePreCodeAttestationConfig({
    enabled: true,
    triggers: ["auth", "storage"],
  });
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.triggers, ["auth", "storage"]);
});

test("config schema rejects unknown key under pre_code_attestation", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pca-cfg-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, ".github"));
  fs.writeFileSync(
    path.join(dir, ".github", "pipeline.yml"),
    `pre_code_attestation:\n  enabled: true\n  silent_approve: true\n`,
  );
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pca-gh-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env bash\necho "acme/widget"\n`);
  fs.chmodSync(ghPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const { resolveConfig } = await import("../scripts/config.ts");
    assert.throws(
      () => resolveConfig({ repoPath: dir }),
      /silent_approve|unrecognized|Invalid/i,
    );
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("hashPreCodeAttestationPolicy is stable for identical config", () => {
  const a = hashPreCodeAttestationPolicy(DEFAULT_CONFIG.pre_code_attestation);
  const b = hashPreCodeAttestationPolicy(DEFAULT_CONFIG.pre_code_attestation);
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});

// ---------------------------------------------------------------------------
// 2. Trigger evaluation
// ---------------------------------------------------------------------------

test("trigger: gate-disabled", () => {
  const r = evaluatePreCodeAttestationTrigger(cfg({ enabled: false }), {
    labels: ["auth"],
    declaredPaths: ["src/auth.ts"],
  });
  assert.equal(r.triggered, false);
  assert.equal(r.reason, "gate-disabled");
});

test("trigger: no-trigger-matched", () => {
  const r = evaluatePreCodeAttestationTrigger(cfg({ triggers: ["auth"] }), {
    labels: [],
    declaredPaths: ["docs/readme.md"],
  });
  assert.equal(r.triggered, false);
  assert.equal(r.reason, "no-trigger-matched");
});

test("trigger: auth path match", () => {
  const r = evaluatePreCodeAttestationTrigger(cfg({ triggers: ["auth"] }), {
    labels: [],
    declaredPaths: ["src/auth/session.ts"],
  });
  assert.equal(r.triggered, true);
  assert.ok(r.matched.some((m) => m.trigger === "auth"));
});

test("trigger: storage label match", () => {
  const r = evaluatePreCodeAttestationTrigger(cfg({ triggers: ["storage"] }), {
    labels: ["risk:storage"],
    declaredPaths: [],
  });
  assert.equal(r.triggered, true);
  assert.ok(r.matched.some((m) => m.trigger === "storage"));
});

test("trigger: migration path match", () => {
  const r = evaluatePreCodeAttestationTrigger(cfg({ triggers: ["migration"] }), {
    labels: [],
    declaredPaths: ["db/migrations/001_init.sql"],
  });
  assert.equal(r.triggered, true);
});

test("trigger: public-api path match", () => {
  const r = evaluatePreCodeAttestationTrigger(cfg({ triggers: ["public-api"] }), {
    labels: [],
    declaredPaths: ["src/api/users.ts"],
  });
  assert.equal(r.triggered, true);
});

test("trigger: architecture path match", () => {
  const r = evaluatePreCodeAttestationTrigger(cfg({ triggers: ["architecture"] }), {
    labels: [],
    declaredPaths: ["docs/architecture/overview.md"],
  });
  assert.equal(r.triggered, true);
});

test("trigger: large-diff threshold", () => {
  const r = evaluatePreCodeAttestationTrigger(
    cfg({ triggers: ["large-diff"], thresholds: { max_files: 10, max_loc: null } }),
    { labels: [], declaredPaths: [], estimatedFiles: 50 },
  );
  assert.equal(r.triggered, true);
  assert.ok(r.matched.some((m) => m.trigger === "large-diff"));
});

test("trigger: extra_triggers free-form class", () => {
  const r = evaluatePreCodeAttestationTrigger(
    cfg({
      triggers: ["auth"],
      extra_triggers: { billing: ["**/billing/**"] },
    }),
    { labels: [], declaredPaths: ["services/billing/invoice.ts"] },
  );
  assert.equal(r.triggered, true);
  assert.ok(r.matched.some((m) => m.trigger === "billing"));
});

test("trigger: pure and repeatable", () => {
  const input = { labels: ["auth"], declaredPaths: ["src/auth.ts"] as string[] };
  const c = cfg({ triggers: ["auth"] });
  assert.deepEqual(
    evaluatePreCodeAttestationTrigger(c, input),
    evaluatePreCodeAttestationTrigger(c, input),
  );
});

// ---------------------------------------------------------------------------
// 3. Dossier validation
// ---------------------------------------------------------------------------

test("dossier: complete validates", () => {
  const v = validatePreCodeDesignDossier(completeDossier());
  assert.equal(v.ok, true, v.errors.join("; "));
});

test("dossier: missing slices fails", () => {
  const d = completeDossier();
  (d as any).slices = [];
  const v = validatePreCodeDesignDossier(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /slices/i.test(e)));
});

test("dossier: bad op fails", () => {
  const d = completeDossier();
  (d.slices[0]!.behavior_diff[0] as any).op = "rewrite";
  const v = validatePreCodeDesignDossier(d);
  assert.equal(v.ok, false);
});

test("dossier: addition change removal ops accepted", () => {
  const d = completeDossier();
  d.slices[0]!.behavior_diff = [
    { op: "addition", target: "a" },
    { op: "change", target: "b" },
    { op: "removal", target: "c" },
  ];
  const v = validatePreCodeDesignDossier(d);
  assert.equal(v.ok, true, v.errors.join("; "));
});

test("dossier: UI without mockup fails", () => {
  const d = completeDossier({ ui_facing: true });
  delete d.ui_mockup;
  delete d.ui_mockup_exception;
  const v = validatePreCodeDesignDossier(d);
  assert.equal(v.ok, false);
});

test("dossier: derived pending blocks approval", () => {
  const d = completeDossier();
  d.slices[0]!.behaviors.push({
    objective_id: "obj-derived",
    preconditions: "x",
    command_or_input: "y",
    expected_outcome: "z",
    ownership_boundary: "engine",
    origin: "derived",
    derived_disposition: "pending",
    verification: { kind: "ref", ref: "t" },
  });
  const el = dossierApprovalEligibility(d);
  assert.equal(el.eligible, false);
});

test("dossier: accepted derived remains in manifest as derived", () => {
  const d = completeDossier();
  d.slices[0]!.behaviors.push({
    objective_id: "obj-derived",
    preconditions: "x",
    command_or_input: "y",
    expected_outcome: "z",
    ownership_boundary: "engine",
    origin: "derived",
    derived_disposition: "accept",
    verification: { kind: "ref", ref: "t" },
  });
  const m = buildObjectiveManifest(d, { derivedDispositions: { "obj-derived": "accept" } });
  const row = m.find((o) => o.objective_id === "obj-derived");
  assert.ok(row);
  assert.equal(row!.origin, "derived");
});

test("dossier: rejected derived excluded from approved set", () => {
  const d = completeDossier();
  d.slices[0]!.behaviors.push({
    objective_id: "obj-derived",
    preconditions: "x",
    command_or_input: "y",
    expected_outcome: "z",
    ownership_boundary: "engine",
    origin: "derived",
    verification: { kind: "ref", ref: "t" },
  });
  const m = buildObjectiveManifest(d, { derivedDispositions: { "obj-derived": "reject" } });
  assert.equal(m.find((o) => o.objective_id === "obj-derived"), undefined);
});

test("dossier: stated does not require derived disposition", () => {
  const d = completeDossier();
  const el = dossierApprovalEligibility(d);
  assert.equal(el.eligible, true);
});

test("dossier: untestable requires affirmation", () => {
  const d = completeDossier();
  d.slices[0]!.behaviors[0]!.verification = {
    kind: "untestable",
    reason: "Untestable: requires physical hardware",
  };
  const r = requireUntestableAffirmations(d, []);
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("obj-happy"));
  const r2 = requireUntestableAffirmations(d, ["obj-happy"]);
  assert.equal(r2.ok, true);
});

test("dossier: missing verification fails validation", () => {
  const raw = completeDossier();
  const asObj = JSON.parse(JSON.stringify(raw));
  delete asObj.slices[0].behaviors[0].verification;
  const v = validatePreCodeDesignDossier(asObj);
  assert.equal(v.ok, false);
});

test("parseDossierFromText extracts fenced JSON", () => {
  const d = completeDossier();
  const text = `## Pre-Code Design Dossier\n\n\`\`\`json\n${JSON.stringify(d, null, 2)}\n\`\`\``;
  const v = parseDossierFromText(text);
  assert.equal(v.ok, true, v.errors.join("; "));
});

// ---------------------------------------------------------------------------
// 4. Approver resolution + SoD
// ---------------------------------------------------------------------------

test("approver: identity match", async () => {
  const r = await resolveAuthorizedApprover({
    actor: "alice",
    authenticated: true,
    identitySource: "gh",
    affectedPaths: ["src/auth.ts"],
    affectedComponents: ["src/auth.ts"],
    matchedRiskClasses: ["auth"],
    rules: [{ kind: "identity", identity: "alice", risk_classes: ["auth"] }],
  });
  assert.equal(r.authorized, true);
  assert.equal(r.unresolved, false);
});

test("approver: unauthorized actor", async () => {
  const r = await resolveAuthorizedApprover({
    actor: "bob",
    authenticated: true,
    identitySource: "gh",
    affectedPaths: ["src/auth.ts"],
    affectedComponents: ["src/auth.ts"],
    matchedRiskClasses: ["auth"],
    rules: [{ kind: "identity", identity: "alice", risk_classes: ["auth"] }],
  });
  assert.equal(r.authorized, false);
});

test("approver: unresolved ownership fails closed", async () => {
  const r = await resolveAuthorizedApprover({
    actor: "alice",
    authenticated: true,
    identitySource: "gh",
    affectedPaths: ["src/auth.ts"],
    affectedComponents: ["src/auth.ts"],
    matchedRiskClasses: ["auth"],
    rules: [], // no rules
  });
  assert.equal(r.unresolved, true);
  assert.equal(r.authorized, false);
});

test("approver: group_ref via fake adapter", async () => {
  const r = await resolveAuthorizedApprover({
    actor: "carol",
    authenticated: true,
    identitySource: "gh",
    affectedPaths: ["src/auth.ts"],
    affectedComponents: ["src/auth.ts"],
    matchedRiskClasses: ["auth"],
    rules: [{ kind: "group_ref", group_ref: "security-leads" }],
    adapter: {
      resolveGroupMembers: (g) => (g === "security-leads" ? ["carol", "dave"] : []),
    },
  });
  assert.equal(r.authorized, true);
});

test("approver: provider-optional without CODEOWNERS (identity only)", async () => {
  const r = await resolveAuthorizedApprover({
    actor: "alice",
    authenticated: true,
    identitySource: "gh",
    affectedPaths: ["src/auth.ts"],
    affectedComponents: ["src/auth.ts"],
    matchedRiskClasses: ["auth"],
    rules: [{ kind: "identity", identity: "alice" }],
    // no adapter
  });
  assert.equal(r.authorized, true);
});

test("SoD: blocks implementer self-attest when enabled", () => {
  const r = checkSeparationOfDuties({
    enabled: true,
    forbidRoles: ["implementer"],
    actor: "alice",
    implementer: "alice",
    dossierAuthor: "bob",
  });
  assert.equal(r.ok, false);
  assert.ok(r.violatedRoles.includes("implementer"));
});

test("SoD: disabled allows authorized self-attest", () => {
  const r = checkSeparationOfDuties({
    enabled: false,
    forbidRoles: ["implementer", "dossier_author"],
    actor: "alice",
    implementer: "alice",
    dossierAuthor: "alice",
  });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// 5. Attestation currency + bypass
// ---------------------------------------------------------------------------

test("approve record fields are complete", () => {
  const rec = buildApproveAttestationRecord({
    actor: "alice",
    identitySource: "gh",
    resolution: {
      authorized: true,
      resolutions: [
        {
          component: "src/auth.ts",
          risk_class: "auth",
          authorized: true,
          matched_rule: "identity:alice#0",
          evidence: "identity match",
        },
      ],
      unresolved: false,
      matchedRuleIds: ["identity:alice#0"],
    },
    dossierHash: "d".repeat(64),
    policyHash: "p".repeat(64),
    scope: {
      components: ["src/auth.ts"],
      risk_classes: ["auth"],
      objective_ids: ["obj-happy"],
    },
    maxAgeHours: 72,
    nowMs: Date.parse("2026-08-13T00:00:00Z"),
  });
  assert.equal(rec.decision, "approve");
  assert.equal(rec.actor, "alice");
  assert.ok(rec.expires_at);
  assert.equal(rec.dossier_hash.length, 64);
  assert.equal(rec.policy_hash.length, 64);
  assert.ok(rec.resolution_evidence.length > 0);
  assert.ok(rec.evidence_subject);
});

test("reject does not advance (decision reject)", () => {
  const rec = buildRejectAttestationRecord({
    actor: "alice",
    identitySource: "gh",
    dossierHash: "d".repeat(64),
    policyHash: "p".repeat(64),
    scope: { components: [], risk_classes: [], objective_ids: [] },
    nowMs: Date.now(),
  });
  assert.equal(rec.decision, "reject");
  assert.equal(rec.expires_at, undefined);
});

test("currency: dossier hash change invalidates", () => {
  const rec = buildApproveAttestationRecord({
    actor: "alice",
    identitySource: "gh",
    resolution: {
      authorized: true,
      resolutions: [],
      unresolved: false,
      matchedRuleIds: [],
    },
    dossierHash: "a".repeat(64),
    policyHash: "p".repeat(64),
    scope: { components: ["c"], risk_classes: ["auth"], objective_ids: [] },
    maxAgeHours: 72,
    nowMs: Date.now(),
  });
  const cur = evaluateAttestationCurrency({
    record: rec,
    currentDossierHash: "b".repeat(64),
    currentPolicyHash: "p".repeat(64),
    nowMs: Date.now(),
    reapproveOn: ["dossier_change", "policy_change", "scope_change", "ownership_change"],
  });
  assert.equal(cur.current, false);
});

test("currency: policy hash change invalidates", () => {
  const rec = buildApproveAttestationRecord({
    actor: "alice",
    identitySource: "gh",
    resolution: {
      authorized: true,
      resolutions: [],
      unresolved: false,
      matchedRuleIds: [],
    },
    dossierHash: "a".repeat(64),
    policyHash: "p".repeat(64),
    scope: { components: ["c"], risk_classes: ["auth"], objective_ids: [] },
    maxAgeHours: 72,
    nowMs: Date.now(),
  });
  const cur = evaluateAttestationCurrency({
    record: rec,
    currentDossierHash: "a".repeat(64),
    currentPolicyHash: "q".repeat(64),
    nowMs: Date.now(),
    reapproveOn: ["dossier_change", "policy_change"],
  });
  assert.equal(cur.current, false);
});

test("currency: expired is non-current", () => {
  const now = Date.parse("2026-08-13T12:00:00Z");
  const rec = buildApproveAttestationRecord({
    actor: "alice",
    identitySource: "gh",
    resolution: {
      authorized: true,
      resolutions: [],
      unresolved: false,
      matchedRuleIds: [],
    },
    dossierHash: "a".repeat(64),
    policyHash: "p".repeat(64),
    scope: { components: ["c"], risk_classes: ["auth"], objective_ids: [] },
    maxAgeHours: 1,
    nowMs: now - 2 * 3600_000,
  });
  const cur = evaluateAttestationCurrency({
    record: rec,
    currentDossierHash: "a".repeat(64),
    currentPolicyHash: "p".repeat(64),
    nowMs: now,
    reapproveOn: [],
  });
  assert.equal(cur.current, false);
});

test("bypass resistance matrix", () => {
  assert.equal(
    isSilentBypassAttempt({
      hasStructuredAttestation: false,
      authenticated: true,
      agentPlanReviewApproved: true,
    }).bypass,
    true,
  );
  assert.equal(
    isSilentBypassAttempt({
      hasStructuredAttestation: false,
      authenticated: true,
      modelProseClaimsApproval: true,
    }).bypass,
    true,
  );
  assert.equal(
    isSilentBypassAttempt({
      hasStructuredAttestation: false,
      authenticated: false,
    }).bypass,
    true,
  );
  assert.equal(
    isSilentBypassAttempt({
      hasStructuredAttestation: true,
      authenticated: true,
    }).bypass,
    false,
  );
});

// ---------------------------------------------------------------------------
// 6. Traces
// ---------------------------------------------------------------------------

test("traces: verified objective", () => {
  const d = completeDossier();
  const objectives = buildObjectiveManifest(d);
  const traces = buildContractTraces(objectives, {
    "obj-happy": { verified: true, evidence_ref: "test:obj-happy" },
    "obj-fail": { verified: true, evidence_ref: "test:obj-fail" },
  });
  assert.equal(traces.find((t) => t.objective_id === "obj-happy")!.status, "verified");
  assert.equal(contractTracesFailSafe(traces).ok, true);
});

test("traces: untestable is unverified_exception never test_proven", () => {
  const d = completeDossier();
  d.slices[0]!.behaviors[0]!.verification = {
    kind: "untestable",
    reason: "Untestable: hardware",
  };
  const objectives = buildObjectiveManifest(d, { untestableAffirmations: ["obj-happy"] });
  const traces = buildContractTraces(objectives);
  const row = traces.find((t) => t.objective_id === "obj-happy")!;
  assert.equal(row.status, "unverified_exception");
  assert.notEqual(row.status, "verified");
});

test("traces: missing is visible", () => {
  const d = completeDossier();
  const objectives = buildObjectiveManifest(d);
  const traces = buildContractTraces(objectives, {});
  const fail = contractTracesFailSafe(traces);
  assert.equal(fail.ok, false);
  assert.ok(fail.missing.length > 0);
});

test("objective ids stable across rehash without content change", () => {
  const d = completeDossier();
  const h1 = hashDossier(d);
  const h2 = hashDossier(JSON.parse(JSON.stringify(d)));
  assert.equal(h1, h2);
  const m1 = buildObjectiveManifest(d);
  const m2 = buildObjectiveManifest(d);
  assert.deepEqual(
    m1.map((o) => [o.objective_id, o.content_hash]),
    m2.map((o) => [o.objective_id, o.content_hash]),
  );
});

// ---------------------------------------------------------------------------
// 7. Wait modes
// ---------------------------------------------------------------------------

test("wait: resume_safe exhaustion is not silent approve", () => {
  assert.equal(waitExhaustedOutcome("resume_safe"), "wait-exhausted-resume-safe");
  assert.equal(waitExhaustedOutcome("hard_block"), "wait-exhausted-hard-block");
});

test("wait budget exhausted detection", () => {
  const now = Date.parse("2026-08-13T12:00:00Z");
  assert.equal(
    isWaitBudgetExhausted({
      waitStartedAt: new Date(now - 200 * 3600_000).toISOString(),
      maxWaitHours: 168,
      nowMs: now,
    }),
    true,
  );
  assert.equal(
    isWaitBudgetExhausted({
      waitStartedAt: new Date(now - 10 * 3600_000).toISOString(),
      maxWaitHours: 168,
      nowMs: now,
    }),
    false,
  );
});
