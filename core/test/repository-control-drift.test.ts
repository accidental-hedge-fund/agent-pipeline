// Unit tests for repository-control drift (#695). Injectable deps only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertControlRiskClass,
  bindDriftEvidenceSubject,
  compareRepositoryControlState,
  CONTROL_RISK_CLASSES,
  disposeCompareResult,
  disposeDriftForReadiness,
  DRIFT_OUTCOMES,
  DRIFT_REASON_CODES,
  fetchLiveRepositoryControlState,
  formatControlsCheckHuman,
  isControlRiskClass,
  parseRepositoryControlDesiredState,
  parkFailClosedRepositoryControlDrift,
  REPOSITORY_CONTROL_DESIRED_STATE_SCHEMA_VERSION,
  runControlsCheck,
  type LiveRepositoryControlState,
  type RepositoryControlDesiredStateV1,
  type RepositoryControlLiveReaderDeps,
} from "../scripts/repository-control-drift.ts";
import { createStagedPolicy, evaluateLifecycleTransition } from "../scripts/stage-policy-lifecycle.ts";
import { COMMAND_REGISTRY, lookupCommand, validateFlags } from "../scripts/command-registry.ts";
import { ESCALATION_INVENTORY } from "../scripts/escalation-dispositions.ts";
import {
  buildEvidenceSubject,
  buildEngineFingerprint,
  buildPolicyHash,
  buildRequiredEvidenceSetRevision,
  DEFAULT_REQUIRED_EVIDENCE_KINDS,
  verifierFingerprintFromEngine,
} from "../scripts/evidence-subject.ts";

const NOW = "2026-08-14T12:00:00.000Z";
const FRESH = "2026-08-14T11:55:00.000Z";
const STALE = "2026-08-14T10:00:00.000Z";

function sampleDesired(
  over: Partial<RepositoryControlDesiredStateV1> = {},
): RepositoryControlDesiredStateV1 {
  return {
    schema_version: 1,
    repository: "acme/widgets",
    default_branch: "main",
    required_checks: ["CI"],
    branch_protections: {
      required_approving_review_count: 1,
      allow_force_pushes: false,
    },
    rulesets: [],
    required_pipeline_gates: [],
    collector_requirements: [],
    risk_class: "fail_closed",
    ...over,
  };
}

function sampleLive(
  over: Partial<LiveRepositoryControlState> = {},
): LiveRepositoryControlState {
  return {
    repository: "acme/widgets",
    default_branch: "main",
    required_checks: ["CI"],
    branch_protections: {
      required_approving_review_count: 1,
      allow_force_pushes: false,
      required_status_check_contexts: ["CI"],
    },
    rulesets: [],
    unsupported_families: [],
    fetched_at: FRESH,
    read_error: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Desired-state schema
// ---------------------------------------------------------------------------

test("schema_version 1 carries required families", () => {
  const d = parseRepositoryControlDesiredState(sampleDesired());
  assert.equal(d.schema_version, REPOSITORY_CONTROL_DESIRED_STATE_SCHEMA_VERSION);
  assert.equal(d.repository, "acme/widgets");
  assert.equal(d.default_branch, "main");
  assert.ok(Array.isArray(d.required_checks));
  assert.ok(d.branch_protections);
  assert.ok(Array.isArray(d.rulesets));
  assert.ok(Array.isArray(d.required_pipeline_gates));
  assert.ok(Array.isArray(d.collector_requirements));
});

test("unknown risk_class is rejected", () => {
  assert.equal(isControlRiskClass("fail_closed"), true);
  assert.equal(isControlRiskClass("block_forever"), false);
  assert.throws(() => assertControlRiskClass("block_forever"), /invalid risk_class/);
  assert.throws(
    () =>
      parseRepositoryControlDesiredState({
        ...sampleDesired(),
        risk_class: "block_forever",
      }),
    /invalid risk_class/,
  );
});

test("unknown schema_version is rejected", () => {
  assert.throws(
    () => parseRepositoryControlDesiredState({ ...sampleDesired(), schema_version: 99 }),
    /unsupported.*schema_version/,
  );
});

test("CONTROL_RISK_CLASSES and DRIFT_OUTCOMES are closed sets", () => {
  assert.deepEqual([...CONTROL_RISK_CLASSES], ["observation", "fail_open", "fail_closed"]);
  assert.deepEqual([...DRIFT_OUTCOMES], [
    "in_sync",
    "drifted",
    "unknown",
    "unsupported",
    "unavailable",
  ]);
  assert.ok(DRIFT_REASON_CODES.includes("drift_required_checks"));
  assert.ok(DRIFT_REASON_CODES.includes("drift_branch_protection"));
  assert.ok(DRIFT_REASON_CODES.includes("drift_ruleset"));
  assert.ok(DRIFT_REASON_CODES.includes("drift_pipeline_gates"));
  assert.ok(DRIFT_REASON_CODES.includes("drift_collector"));
  assert.ok(DRIFT_REASON_CODES.includes("drift_live_unavailable"));
  assert.ok(DRIFT_REASON_CODES.includes("drift_unsupported"));
});

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

test("matching fresh live state is in_sync", () => {
  const r = compareRepositoryControlState(sampleDesired(), sampleLive(), { nowIso: NOW });
  assert.equal(r.outcome, "in_sync");
  assert.equal(r.differences.length, 0);
  assert.equal(r.stale, false);
  assert.equal(r.repository, "acme/widgets");
  assert.ok(r.live_snapshot_digest);
  assert.ok(r.compared_at);
});

test("required-check name missing live is drifted", () => {
  const r = compareRepositoryControlState(
    sampleDesired({ required_checks: ["CI", "Lint"] }),
    sampleLive({ required_checks: ["CI"] }),
    { nowIso: NOW },
  );
  assert.equal(r.outcome, "drifted");
  assert.ok(r.differences.some((d) => d.path.includes("Lint") || d.path.includes("required_checks")));
  assert.ok(r.reason_codes.includes("drift_required_checks"));
});

test("branch protection mismatch is drifted", () => {
  const r = compareRepositoryControlState(
    sampleDesired({
      branch_protections: { required_approving_review_count: 2, allow_force_pushes: false },
    }),
    sampleLive({
      branch_protections: {
        required_approving_review_count: 1,
        allow_force_pushes: false,
      },
    }),
    { nowIso: NOW },
  );
  assert.equal(r.outcome, "drifted");
  assert.ok(r.differences.some((d) => d.path.includes("required_approving_review_count")));
  assert.ok(r.reason_codes.includes("drift_branch_protection"));
});

test("ruleset mismatch is drifted", () => {
  const r = compareRepositoryControlState(
    sampleDesired({
      rulesets: [{ id_or_name: "default", enforcement: "active" }],
    }),
    sampleLive({
      rulesets: [{ id_or_name: "default", enforcement: "evaluate" }],
    }),
    { nowIso: NOW },
  );
  assert.equal(r.outcome, "drifted");
  assert.ok(r.reason_codes.includes("drift_ruleset"));
});

test("stale live state is not in_sync", () => {
  const r = compareRepositoryControlState(
    sampleDesired(),
    sampleLive({ fetched_at: STALE }),
    { nowIso: NOW, maxAgeMs: 15 * 60 * 1000 },
  );
  assert.notEqual(r.outcome, "in_sync");
  assert.equal(r.stale, true);
  assert.ok(r.reason_codes.includes("drift_stale"));
});

test("missing permissions yield unavailable", () => {
  const r = compareRepositoryControlState(
    sampleDesired(),
    sampleLive({
      required_checks: null,
      branch_protections: null,
      rulesets: null,
      read_error: "permission",
      read_error_message: "HTTP 403: Resource not accessible",
    }),
    { nowIso: NOW },
  );
  assert.equal(r.outcome, "unavailable");
  assert.notEqual(r.outcome, "in_sync");
  assert.ok(r.reason_codes.includes("drift_live_unavailable"));
});

test("unsupported control family yields unsupported", () => {
  const r = compareRepositoryControlState(
    sampleDesired({
      rulesets: [{ id_or_name: "rs1", enforcement: "active" }],
    }),
    sampleLive({
      rulesets: null,
      unsupported_families: ["rulesets"],
    }),
    { nowIso: NOW },
  );
  assert.equal(r.outcome, "unsupported");
  assert.ok(r.reason_codes.includes("drift_unsupported"));
});

// ---------------------------------------------------------------------------
// Live reader (injectable) — no mutation
// ---------------------------------------------------------------------------

test("check path performs only read operations through gh seam", async () => {
  const calls: string[][] = [];
  const deps: RepositoryControlLiveReaderDeps = {
    ghRun: async (args) => {
      calls.push([...args]);
      // Refuse any mutation-looking verbs
      assert.equal(args.includes("PUT") || args.includes("POST") || args.includes("PATCH") || args.includes("DELETE"), false);
      assert.equal(args[0], "api");
      if (String(args[1]).includes("/protection")) {
        return JSON.stringify({
          required_pull_request_reviews: { required_approving_review_count: 1 },
          required_status_checks: { contexts: ["CI"] },
          allow_force_pushes: { enabled: false },
        });
      }
      if (String(args[1]).includes("/rulesets")) {
        return JSON.stringify([]);
      }
      return "{}";
    },
    nowIso: () => FRESH,
  };
  const live = await fetchLiveRepositoryControlState(sampleDesired(), deps);
  assert.equal(live.required_checks?.includes("CI"), true);
  assert.ok(calls.every((c) => c[0] === "api"));
  assert.ok(calls.length >= 1);
});

test("permission error from gh maps to unavailable compare path", async () => {
  const deps: RepositoryControlLiveReaderDeps = {
    ghRun: async () => {
      throw new Error("gh api failed: HTTP 403: Resource not accessible by integration");
    },
    nowIso: () => FRESH,
  };
  const live = await fetchLiveRepositoryControlState(sampleDesired(), deps);
  assert.equal(live.read_error, "permission");
  const r = compareRepositoryControlState(sampleDesired(), live, { nowIso: NOW });
  assert.equal(r.outcome, "unavailable");
});

// ---------------------------------------------------------------------------
// Disposition
// ---------------------------------------------------------------------------

test("observe policy drift does not block readiness", () => {
  const result = compareRepositoryControlState(
    sampleDesired({ required_checks: ["CI", "X"] }),
    sampleLive({ required_checks: ["CI"] }),
    { nowIso: NOW },
  );
  const d = disposeCompareResult({
    result,
    desired: sampleDesired({ risk_class: "fail_closed" }),
    lifecycle_state: "observe",
  });
  assert.equal(d.blocks_readiness, false);
  assert.equal(d.disposition, "record_only");
});

test("enforcing fail-closed drift blocks readiness", () => {
  const result = compareRepositoryControlState(
    sampleDesired({ required_checks: ["CI", "X"] }),
    sampleLive({ required_checks: ["CI"] }),
    { nowIso: NOW },
  );
  const d = disposeCompareResult({
    result,
    desired: sampleDesired({ risk_class: "fail_closed" }),
    lifecycle_state: "enforcing",
  });
  assert.equal(d.blocks_readiness, true);
  assert.equal(d.disposition, "block");
  assert.ok(d.reason_code);
});

test("enforcing fail-open drift does not hard-block", () => {
  const result = compareRepositoryControlState(
    sampleDesired({ required_checks: ["CI", "X"] }),
    sampleLive({ required_checks: ["CI"] }),
    { nowIso: NOW },
  );
  const d = disposeCompareResult({
    result,
    desired: sampleDesired({ risk_class: "fail_open" }),
    lifecycle_state: "enforcing",
  });
  assert.equal(d.blocks_readiness, false);
  assert.equal(d.disposition, "advisory");
});

test("unavailable on fail-closed enforcing is not in_sync pass", () => {
  const result = compareRepositoryControlState(
    sampleDesired(),
    sampleLive({
      required_checks: null,
      branch_protections: null,
      read_error: "permission",
    }),
    { nowIso: NOW },
  );
  assert.equal(result.outcome, "unavailable");
  const d = disposeDriftForReadiness({
    outcome: result.outcome,
    risk_class: "fail_closed",
    lifecycle_state: "enforcing",
    primary_reason: "drift_live_unavailable",
  });
  assert.equal(d.blocks_readiness, true);
  assert.notEqual(result.outcome, "in_sync");
});

// ---------------------------------------------------------------------------
// Check surface
// ---------------------------------------------------------------------------

test("runControlsCheck JSON path includes outcomes; no mutation", async () => {
  let wrote = false;
  const deps: RepositoryControlLiveReaderDeps = {
    ghRun: async (args) => {
      if (args.some((a) => /PUT|POST|PATCH|DELETE|-X/.test(a))) wrote = true;
      if (String(args[1]).includes("/protection")) {
        return JSON.stringify({
          required_pull_request_reviews: { required_approving_review_count: 1 },
          required_status_checks: { contexts: ["CI"] },
          allow_force_pushes: { enabled: false },
        });
      }
      return "[]";
    },
    nowIso: () => FRESH,
  };
  const out = await runControlsCheck(
    {
      desired: sampleDesired({ policy_id: "pol-1" }),
      lifecycle_state: "enforcing",
      json: true,
      nowIso: NOW,
    },
    deps,
  );
  assert.equal(out.configured, true);
  assert.equal(out.results[0]!.outcome, "in_sync");
  assert.equal(out.results[0]!.standalone_check, true);
  assert.equal(out.results[0]!.readiness_claim, "none");
  assert.equal(wrote, false);
  assert.equal(out.exit_code, 0);
});

test("absent desired state is no-op pass", async () => {
  const out = await runControlsCheck(
    { desired: null },
    { ghRun: async () => { throw new Error("should not call gh"); } },
  );
  assert.equal(out.configured, false);
  assert.equal(out.exit_code, 0);
  assert.match(out.message, /not configured/);
  assert.equal(formatControlsCheckHuman(out).includes("not configured"), true);
});

test("fail-closed enforcing non-sync exits non-zero", async () => {
  const deps: RepositoryControlLiveReaderDeps = {
    ghRun: async (args) => {
      if (String(args[1]).includes("/protection")) {
        return JSON.stringify({
          required_pull_request_reviews: { required_approving_review_count: 1 },
          required_status_checks: { contexts: [] },
          allow_force_pushes: { enabled: false },
        });
      }
      return "[]";
    },
    nowIso: () => FRESH,
  };
  const out = await runControlsCheck(
    {
      desired: sampleDesired({ required_checks: ["CI"], risk_class: "fail_closed" }),
      lifecycle_state: "enforcing",
      nowIso: NOW,
    },
    deps,
  );
  assert.equal(out.results[0]!.outcome, "drifted");
  assert.equal(out.exit_code, 1);
  assert.equal(out.decisions[0]!.blocks_readiness, true);
});

test("standalone check does not invent readiness pass", async () => {
  const out = await runControlsCheck(
    {
      desired: sampleDesired(),
      lifecycle_state: "enforcing",
      nowIso: NOW,
    },
    {
      ghRun: async (args) => {
        if (String(args[1]).includes("/protection")) {
          return JSON.stringify({
            required_pull_request_reviews: { required_approving_review_count: 1 },
            required_status_checks: { contexts: ["CI"] },
            allow_force_pushes: { enabled: false },
          });
        }
        return "[]";
      },
      nowIso: () => FRESH,
    },
  );
  assert.equal(out.results[0]!.standalone_check, true);
  assert.equal(out.results[0]!.readiness_claim, "none");
});

test("run-scoped drift binds evidence_subject", () => {
  const result = compareRepositoryControlState(sampleDesired(), sampleLive(), { nowIso: NOW });
  const engine = buildEngineFingerprint({
    version: "1",
    templates_fingerprint: "a".repeat(64),
  });
  const subject = buildEvidenceSubject({
    domain: "acme/widgets",
    issue: 695,
    run_id: "695/r",
    candidate_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    policy_hash: buildPolicyHash({ x: 1 }),
    engine_fingerprint: engine,
    verifier_fingerprint: verifierFingerprintFromEngine(engine),
    required_evidence_set_revision: buildRequiredEvidenceSetRevision(
      DEFAULT_REQUIRED_EVIDENCE_KINDS,
    ),
  });
  const bound = bindDriftEvidenceSubject(result, subject, false);
  assert.equal(bound.standalone_check, false);
  assert.ok(bound.evidence_subject);
  assert.equal(bound.evidence_subject!.candidate_sha, subject.candidate_sha);
});

// ---------------------------------------------------------------------------
// Park helper does not remediate; records typed reason
// ---------------------------------------------------------------------------

test("parkFailClosedRepositoryControlDrift calls setBlocked only; no forge rewrite", async () => {
  const calls: unknown[] = [];
  const result = compareRepositoryControlState(
    sampleDesired({ required_checks: ["CI", "X"] }),
    sampleLive({ required_checks: ["CI"] }),
    { nowIso: NOW },
  );
  const decision = disposeCompareResult({
    result,
    desired: sampleDesired({ risk_class: "fail_closed" }),
    lifecycle_state: "enforcing",
  });
  await parkFailClosedRepositoryControlDrift(695, decision, result, {
    setBlocked: async (args) => {
      calls.push(args);
    },
  });
  assert.equal(calls.length, 1);
  const a = calls[0] as { kind: string; reason: string; issueNumber: number };
  assert.equal(a.kind, "needs-human");
  assert.equal(a.issueNumber, 695);
  assert.match(a.reason, /repository-control drift fail-closed/);
  assert.match(a.reason, /does not auto-remediate/);
});

test("park helper refuses when decision does not block", async () => {
  const result = compareRepositoryControlState(sampleDesired(), sampleLive(), { nowIso: NOW });
  const decision = disposeCompareResult({
    result,
    desired: sampleDesired({ risk_class: "observation" }),
    lifecycle_state: "observe",
  });
  await assert.rejects(
    () =>
      parkFailClosedRepositoryControlDrift(1, decision, result, {
        setBlocked: async () => {
          throw new Error("must not call");
        },
      }),
    /does not block readiness/,
  );
});

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

test("controls registry entry is non-mutating", () => {
  const entry = COMMAND_REGISTRY.controls;
  assert.ok(entry);
  assert.equal(entry.mutatesGitHub, false);
  assert.equal(lookupCommand("controls"), entry);
  assert.equal(entry.supportsJson, true);
  assert.ok(entry.allowedFlags instanceof Set);
  const set = entry.allowedFlags as Set<string>;
  assert.equal(set.has("json"), true);
  assert.equal(set.has("strict"), true);
});

test("controls unsupported write-oriented flag is rejected by validateFlags", () => {
  const entry = COMMAND_REGISTRY.controls;
  const cmd = {
    options: [{ attributeName: () => "apply" }],
    getOptionValueSource: (k: string) => (k === "apply" ? "cli" : "default"),
  };
  const bad = validateFlags(entry, cmd);
  assert.ok(bad.includes("apply"));
});

// ---------------------------------------------------------------------------
// Escalation inventory
// ---------------------------------------------------------------------------

test("fail-closed repository-control drift park is inventoried", () => {
  const hit = ESCALATION_INVENTORY.sites.some(
    (s) =>
      s.module.includes("repository-control-drift") &&
      s.disposition === "deliberately-fail-closed",
  );
  assert.ok(
    hit,
    "inventory must include repository-control-drift fail-closed park site",
  );
});

test("observation-only drift is not an escalation park site requirement", () => {
  // Disposition law: observe never blocks; inventory site is only for fail-closed parks.
  const d = disposeDriftForReadiness({
    outcome: "drifted",
    risk_class: "observation",
    lifecycle_state: "observe",
    primary_reason: "drift_required_checks",
  });
  assert.equal(d.blocks_readiness, false);
});

// ---------------------------------------------------------------------------
// Lifecycle + evidence compose
// ---------------------------------------------------------------------------

test("enforcing policy evidence row after legal path", () => {
  let p = createStagedPolicy("pol-rc", { required_checks: ["CI"] });
  const auth = { actor: "a", role: "admin" };
  const obs = {
    observation_run_count: 5,
    false_positive_or_override_rate: 0,
    unresolved_evidence_count: 0,
  };
  for (const to of ["observe", "required", "enforcing"] as const) {
    const r = evaluateLifecycleTransition({
      policy: p,
      to,
      at: NOW,
      authority: to === "observe" ? null : auth,
      observation: to === "observe" ? null : obs,
    });
    assert.equal(r.ok, true);
    if (r.ok) p = r.policy;
  }
  assert.equal(p.state, "enforcing");
  assert.ok(p.lineage.some((e) => e.to_state === "enforcing"));
});
