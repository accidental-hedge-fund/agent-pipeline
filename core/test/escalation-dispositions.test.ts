// Drift guards + inventory contract for #760 per-site safety dispositions.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_CENSUS_REQUIRED_PATTERNS,
  assertInventoryDispositionsClosed,
  discoverProductionSetBlockedSites,
  diffEscalationInventory,
  dispositionForSiteId,
  ESCALATION_INVENTORY,
  ESCALATION_SITE_DISPOSITIONS,
  isEscalationSiteDisposition,
  isTransientRetryableSite,
} from "../scripts/escalation-dispositions.ts";
import {
  classifyGhError,
  classifyHarnessFailure,
  durableClassForReasonCode,
  interventionKindFromReason,
  isMechanicalInfrastructureReason,
  offrampClassFromReason,
} from "../scripts/escalation-classify.ts";
import {
  buildStageDiagnostic,
  projectPipelineReasonCode,
  projectStageDiagnostic,
  STAGE_DIAGNOSTIC_REASON_CODES,
} from "../scripts/stage-diagnostic.ts";
import {
  prescribedFixCommitSubject,
  pushWithCurrencyCheck,
  runTransientLabelEdit,
  selfFixPipelineFormat,
  validateFixCommitSubject,
} from "../scripts/transient-wrappers.ts";
import { DURABLE_BLOCKER_CLASSES, isDurableBlockerClass } from "../scripts/loop/types.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import type { BlockerKind } from "../scripts/types.ts";

/** Mirror of pipeline-run.isHumanAuthorityBlocker — kept local so this suite
 *  does not pull the full pipeline-run → config → zod graph into a pure unit test. */
function isHumanAuthorityBlocker(kind: BlockerKind | undefined, diagnostic?: unknown): boolean {
  return kind === "human-decision-required" &&
    projectStageDiagnostic(diagnostic).disposition === "human_authority";
}

// ---------------------------------------------------------------------------
// 1. Inventory closedness + census coverage
// ---------------------------------------------------------------------------

test("disposition enum is closed and total over inventory rows", () => {
  assertInventoryDispositionsClosed();
  for (const site of ESCALATION_INVENTORY.sites) {
    assert.ok(
      isEscalationSiteDisposition(site.disposition),
      `${site.site_id} disposition ${site.disposition}`,
    );
  }
  assert.deepEqual([...ESCALATION_SITE_DISPOSITIONS], [
    "deliberately-fail-closed",
    "transient-retryable",
    "reconcile-owned",
  ]);
});

test("inventory covers audit census named zero-retry classes", () => {
  for (const req of AUDIT_CENSUS_REQUIRED_PATTERNS) {
    const hit = ESCALATION_INVENTORY.sites.some((s) => req.test(s));
    assert.ok(hit, `inventory missing census class: ${req.id}`);
  }
  // Explicit named classes from the issue body.
  assert.ok(
    ESCALATION_INVENTORY.sites.some(
      (s) => s.canonical_reason === "environment-auth" && s.disposition === "deliberately-fail-closed",
    ),
    "getGhActor/attestation fail-closed sites",
  );
  assert.ok(
    ESCALATION_INVENTORY.sites.some((s) => s.blocker_kind === "push-failed"),
    "push-failed sites",
  );
  assert.ok(
    ESCALATION_INVENTORY.sites.some((s) => s.blocker_kind === "worktree-missing"),
    "worktree-missing sites",
  );
});

test("unknown site ids default to deliberately-fail-closed (never open retry)", () => {
  assert.equal(dispositionForSiteId("no-such-site:ever"), "deliberately-fail-closed");
  assert.equal(isTransientRetryableSite("no-such-site:ever"), false);
});

// ---------------------------------------------------------------------------
// 1.4 Disposition drift guard
// ---------------------------------------------------------------------------

test("disposition drift-guard: every production setBlocked has an inventory row", () => {
  const discovered = discoverProductionSetBlockedSites();
  assert.ok(discovered.length > 50, `expected substantial discovery, got ${discovered.length}`);
  const { missing, orphans, ok } = diffEscalationInventory(discovered);
  assert.equal(
    missing.length,
    0,
    `missing inventory for: ${missing.map((m) => `${m.site_id} (${m.module}:${m.line})`).join("; ")}`,
  );
  assert.equal(
    orphans.length,
    0,
    `orphan inventory rows (no production site): ${orphans.map((o) => o.site_id).join("; ")}`,
  );
  assert.equal(ok, true);
});

test("disposition drift-guard bites when a site is missing from inventory", () => {
  const discovered = discoverProductionSetBlockedSites();
  // Simulate a new emitter the inventory does not know about.
  const fake = {
    ...discovered[0]!,
    site_id: "stages.fake-module:needs-human#0",
    module: "scripts/stages/fake-module.ts",
    kind: "needs-human",
    occurrence: 0,
  };
  const { missing, ok } = diffEscalationInventory([...discovered, fake]);
  assert.equal(ok, false);
  assert.ok(missing.some((m) => m.site_id === fake.site_id));
});

// ---------------------------------------------------------------------------
// 1.5 Authority drift guard
// ---------------------------------------------------------------------------

test("authority drift-guard: production human_intervention emitters are inventoried", () => {
  assert.ok(ESCALATION_INVENTORY.authority_emitters.length >= 1);
  for (const emitter of ESCALATION_INVENTORY.authority_emitters) {
    if (!emitter.reporting_only) {
      assert.equal(
        emitter.requires_authority_predicate,
        true,
        `${emitter.site_id} must require the canonical authority predicate`,
      );
    }
  }
  // Canonical predicate: only human-decision-required + projected human_authority.
  assert.equal(isHumanAuthorityBlocker("needs-human"), false);
  assert.equal(isHumanAuthorityBlocker("review-findings"), false);
  assert.equal(isHumanAuthorityBlocker("harness-failure"), false);
  const humanDiag = buildStageDiagnostic({
    blockerKind: "human-decision-required",
    reason: "choose the product contract",
    authorityEvidence: [{
      category: "product-decision",
      finding_key: "deadbeef",
      finding_fingerprint: "0123456789abcdef",
      reviewed_sha: "abc1234",
    }],
  });
  assert.equal(isHumanAuthorityBlocker("human-decision-required", humanDiag), true);
});

test("authority drift-guard: mechanical exhaustion cannot mint human authority", () => {
  for (const reason of [
    "repair-budget-exhausted",
    "transient-infra",
    "harness-timeout",
    "harness-contract",
    "workflow-engine-defect",
  ] as const) {
    const proj = projectPipelineReasonCode(reason);
    assert.notEqual(proj.disposition, "human_authority", reason);
    assert.equal(isMechanicalInfrastructureReason(reason), true, reason);
  }
});

test("review-non-convergence reporting kind does not grant human authority alone", () => {
  const kind = interventionKindFromReason("review-findings");
  assert.equal(kind, "review-non-convergence");
  // Authority still requires attested diagnostic — reporting kind is irrelevant.
  assert.equal(isHumanAuthorityBlocker("review-findings"), false);
  const diag = buildStageDiagnostic({
    blockerKind: "review-findings",
    reason: "blocking finding remains",
  });
  assert.equal(projectStageDiagnostic(diag).disposition, "recover");
});

// ---------------------------------------------------------------------------
// 2. Mechanical classifiers + reason exhaustiveness
// ---------------------------------------------------------------------------

test("harness timed_out maps mechanically without prose scraping", () => {
  assert.equal(classifyHarnessFailure({ timed_out: true, code: 1 }), "harness-timeout");
});

test("capture_error / oversize_argv map to harness-contract", () => {
  assert.equal(classifyHarnessFailure({ capture_error: true, timed_out: false }), "harness-contract");
  assert.equal(
    classifyHarnessFailure({ oversize_argv: true, spawn_error: true, timed_out: false }),
    "harness-contract",
  );
});

test("preflight_reason_code environment-auth projects to environment-auth, not harness-contract", () => {
  const code = classifyHarnessFailure({
    spawn_error: true,
    code: -1,
    preflight_reason_code: "environment-auth",
    stdout: "",
    stderr: "",
  });
  assert.equal(code, "environment-auth");
  assert.notEqual(code, "harness-contract");
  assert.notEqual(code, "workflow-engine-defect");
  const proj = projectPipelineReasonCode(code);
  assert.equal(proj.blockerClass, "environment-auth");
  assert.equal(proj.disposition, "recover");
  assert.deepEqual(DEFAULT_RECOVERY_POLICY["environment-auth"].recipes, ["verify_authentication"]);
});

test("revoked refresh token JSON marker themes environment-auth", () => {
  const stderr = [
    "ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: {",
    '  "error": { "message": "Your session has ended. Please log in again.",',
    '             "code": "refresh_token_invalidated" } }',
  ].join("\n");
  const code = classifyHarnessFailure({
    code: 1,
    stdout: "",
    stderr,
  });
  assert.equal(code, "environment-auth");
  assert.equal(durableClassForReasonCode(code), "environment-auth");
  assert.equal(projectPipelineReasonCode(code).blockerClass, "environment-auth");
});

test("structured provider status 401 on the status object is environment-auth", () => {
  const code = classifyHarnessFailure({
    code: 1,
    stdout: "",
    stderr: "",
    provider_auth_status: { session: "invalidated", http_status: 401 },
  });
  assert.equal(code, "environment-auth");
});

test("unallowlisted please log in prose is not environment-auth", () => {
  const code = classifyHarnessFailure({
    code: 1,
    stdout: "",
    stderr: "please log in",
  });
  assert.equal(code, "harness-contract");
  assert.notEqual(code, "environment-auth");
});

test("DurableBlockerClass gains no new auth-specific theme token", () => {
  assert.deepEqual([...DURABLE_BLOCKER_CLASSES], [
    "transient-rate-limit",
    "workflow-state",
    "implementation-ci",
    "review-findings",
    "environment-auth",
    "specification-decision",
    "missing-authority",
    "upstream-dependency",
    "workflow-engine-defect",
  ]);
});

test("gh HTTP 504 classifies as transient-infra", () => {
  const c = classifyGhError("gh api failed: HTTP 504 Gateway Timeout");
  assert.equal(c.transient, true);
  assert.equal(c.reason_code, "transient-infra");
  assert.equal(c.class, "transient-infra");
});

test("gh HTTP 422 is deterministic and not retried class", () => {
  const c = classifyGhError("HTTP 422: Validation Failed");
  assert.equal(c.transient, false);
  assert.equal(c.class, "deterministic-client");
});

test("gh PR combined-diff HTTP 406 too_large is workflow-engine-defect, not workflow-state", () => {
  const stderr =
    "gh pr diff 1222 failed: could not find pull request diff: HTTP 406: " +
    "Sorry, the diff exceeded the maximum number of files (300). " +
    "PullRequest.diff too_large";
  const c = classifyGhError(stderr);
  assert.equal(c.transient, false);
  assert.equal(c.class, "deterministic-client");
  assert.equal(c.reason_code, "workflow-engine-defect");
  assert.notEqual(c.reason_code, "workflow-state");
  const proj = projectPipelineReasonCode(c.reason_code);
  assert.equal(proj.blockerClass, "workflow-engine-defect");
  assert.equal(proj.disposition, "recover");
  assert.notEqual(proj.disposition, "human_authority");
});

test("gh capability refusal keeps a distinct canonical reason (not environment-auth)", () => {
  for (const stderr of [
    "HTTP 403: Resource not accessible by integration",
    "GraphQL: Resource not accessible by integration (repository)",
    "HTTP 403: Forbidden — missing permission to update labels",
  ]) {
    const c = classifyGhError(stderr);
    assert.equal(c.class, "capability-refusal", stderr);
    assert.equal(c.reason_code, "capability-refusal", stderr);
    assert.equal(c.transient, false, stderr);
    assert.notEqual(c.reason_code, "environment-auth", stderr);
  }
  // Auth remains a separate code.
  const auth = classifyGhError("HTTP 401: authentication required");
  assert.equal(auth.reason_code, "environment-auth");
  assert.equal(auth.class, "environment-auth");
  // Projection stays engine-owned environment recovery class.
  const proj = projectPipelineReasonCode("capability-refusal");
  assert.equal(proj.blockerClass, "environment-auth");
  assert.equal(proj.disposition, "recover");
  assert.notEqual(proj.disposition, "human_authority");
});

test("pre-merge delta-round ceiling inventory projects review-findings (not needs-human default)", () => {
  const ceiling = ESCALATION_INVENTORY.sites.find(
    (s) =>
      s.module.includes("pre-merge-sha-gate") &&
      /deltaRoundCap|round ceiling|delta review reached/i.test(s.match + s.notes),
  );
  assert.ok(ceiling, "expected pre-merge delta-round ceiling inventory row");
  assert.equal(ceiling!.blocker_kind, "review-findings");
  assert.equal(ceiling!.canonical_reason, "review-findings");
  assert.notEqual(ceiling!.blocker_kind, "needs-human");
});

test("every reason code projects to exactly one DurableBlockerClass (or residual protocol path)", () => {
  for (const code of STAGE_DIAGNOSTIC_REASON_CODES) {
    const proj = projectPipelineReasonCode(code);
    assert.ok(isDurableBlockerClass(proj.blockerClass), `${code} → ${proj.blockerClass}`);
    assert.notEqual(proj.disposition, "protocol_failure", `${code} must be known`);
    assert.equal(durableClassForReasonCode(code), proj.blockerClass);
  }
  // Unknown still protocol-fails closed.
  const unknown = projectPipelineReasonCode("not-a-real-code");
  assert.equal(unknown.disposition, "protocol_failure");
  assert.equal(unknown.blockerClass, "workflow-engine-defect");
});

test("loop recovery budget keys are the closed DurableBlockerClass set", () => {
  // Every projected class from the vocabulary is a legal budget key.
  const projected = new Set(
    STAGE_DIAGNOSTIC_REASON_CODES.map((c) => projectPipelineReasonCode(c).blockerClass),
  );
  for (const cls of projected) {
    assert.ok(
      (DURABLE_BLOCKER_CLASSES as readonly string[]).includes(cls),
      `projected class ${cls} missing from DURABLE_BLOCKER_CLASSES`,
    );
  }
});

test("label-edit 504 does not project to product human authority", () => {
  const classified = classifyGhError("HTTP 504");
  const proj = projectPipelineReasonCode(classified.reason_code);
  assert.equal(proj.disposition, "recover");
  assert.notEqual(proj.disposition, "human_authority");
  const diag = buildStageDiagnostic({
    reasonCode: "transient-infra",
    blockerKind: "harness-failure",
    reason: "label edit failed after retries: HTTP 504",
  });
  assert.equal(projectStageDiagnostic(diag).disposition, "recover");
  assert.equal(isHumanAuthorityBlocker("harness-failure", diag), false);
});

test("intervention and offramp kinds are pure projections (not authority)", () => {
  assert.equal(interventionKindFromReason("human-decision-required"), "product-judgment-required");
  assert.equal(offrampClassFromReason("implementation-ci", "ci-exhausted"), "ci-failed");
  assert.equal(offrampClassFromReason("review-findings"), "delta-review");
});

// ---------------------------------------------------------------------------
// 3. Bounded wrappers (injected deps)
// ---------------------------------------------------------------------------

test("transient label edit: 504 then success does not park", async () => {
  let calls = 0;
  const result = await runTransientLabelEdit(
    ["issue", "edit", "1", "--add-label", "blocked", "-R", "o/r"],
    {
      sleep: async () => {},
      runner: async () => {
        calls++;
        if (calls === 1) {
          const err = new Error("boom") as Error & { stderr: string };
          err.stderr = "HTTP 504 Gateway Timeout";
          throw err;
        }
        return { stdout: "ok\n" };
      },
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.attempts, 2);
  }
  assert.equal(calls, 2);
});

test("transient label edit: 5xx exhaustion stays engine-owned", async () => {
  const result = await runTransientLabelEdit(
    ["issue", "edit", "1", "--add-label", "blocked", "-R", "o/r"],
    {
      sleep: async () => {},
      retries: 3,
      runner: async () => {
        const err = new Error("boom") as Error & { stderr: string };
        err.stderr = "HTTP 504 Gateway Timeout";
        throw err;
      },
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.exhausted, true);
    assert.equal(result.reason_code, "transient-infra");
    assert.equal(result.attempts, 3);
  }
});

test("transient label edit: deterministic 422 is not retried", async () => {
  let calls = 0;
  let slept = 0;
  const result = await runTransientLabelEdit(
    ["issue", "edit", "1", "--add-label", "x", "-R", "o/r"],
    {
      sleep: async () => {
        slept++;
      },
      runner: async () => {
        calls++;
        const err = new Error("boom") as Error & { stderr: string };
        err.stderr = "HTTP 422: Validation Failed";
        throw err;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test("push wrapper retries after transient blip", async () => {
  let pushes = 0;
  const result = await pushWithCurrencyCheck("pipeline/1-x", {
    sleep: async () => {},
    expectedLocalSha: "aaa111",
    git: async (args) => {
      if (args[0] === "push") {
        pushes++;
        if (pushes === 1) {
          return { stdout: "", stderr: "HTTP 502 Bad Gateway", code: 1 };
        }
        return { stdout: "ok", stderr: "", code: 0 };
      }
      if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: "aaa111\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(pushes, 2);
});

test("push wrapper refuses retry on head drift (no force-push)", async () => {
  let pushes = 0;
  const result = await pushWithCurrencyCheck("pipeline/1-x", {
    sleep: async () => {},
    expectedLocalSha: "aaa111",
    git: async (args) => {
      if (args[0] === "push") {
        pushes++;
        return { stdout: "", stderr: "HTTP 502 Bad Gateway", code: 1 };
      }
      if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: "bbb222\n", stderr: "", code: 0 }; // drifted
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.head_drift, true);
    assert.match(result.reason, /drifted|currency/i);
  }
  assert.equal(pushes, 1);
});

test("format self-fix rewrites pipeline-owned fix subject once", () => {
  const prescribed = prescribedFixCommitSubject(1, 760);
  const result = selfFixPipelineFormat({
    kind: "fix-commit-subject",
    current: "wip: stuff",
    prescribed,
    validate: (t) => validateFixCommitSubject(t, 1, 760),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.rewrote, true);
    assert.equal(result.text, prescribed);
  }
});

test("format self-fix refuses human prose rewrite", () => {
  const result = selfFixPipelineFormat({
    kind: "fix-commit-subject",
    current: "operator left a note about product trade-offs",
    prescribed: prescribedFixCommitSubject(1, 760),
    validate: () => false,
    humanProse: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.refused_human_prose, true);
  }
});

test("format self-fix exhaustion stays engine-owned", () => {
  const result = selfFixPipelineFormat({
    kind: "verdict-section",
    current: "bad",
    prescribed: "still-bad",
    validate: () => false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason_code, "workflow-engine-defect");
    assert.equal(projectPipelineReasonCode(result.reason_code).disposition, "recover");
  }
});

// ---------------------------------------------------------------------------
// Attestation getGhActor sites remain deliberately fail-closed
// ---------------------------------------------------------------------------

test("attestation getGhActor sites are deliberately-fail-closed in inventory", () => {
  const authSites = ESCALATION_INVENTORY.sites.filter(
    (s) => s.canonical_reason === "environment-auth",
  );
  assert.ok(authSites.length >= 1, "expected attestation/auth inventory rows");
  for (const s of authSites) {
    assert.equal(
      s.disposition,
      "deliberately-fail-closed",
      `${s.site_id} must not be wrapped as transient-retryable`,
    );
  }
});

// ---------------------------------------------------------------------------
// Override governance integrity sites (#693)
// ---------------------------------------------------------------------------

test("override_governance_sites inventory covers refuse and expiry classes", () => {
  const sites = ESCALATION_INVENTORY.override_governance_sites ?? [];
  assert.ok(sites.length >= 6, "expected override_governance_sites rows");
  const ids = new Set(sites.map((s) => s.site_id));
  for (const required of [
    "override-governance:unauthorized-record",
    "override-governance:sod-violation",
    "override-governance:missing-evidence",
    "override-governance:unknown-class",
    "override-governance:expired-unblock",
    "override-governance:drift-blocked-lite-renewal",
  ]) {
    assert.ok(ids.has(required), `missing inventory row ${required}`);
  }
  for (const s of sites) {
    assert.notEqual(
      s.disposition,
      "transient-retryable",
      `${s.site_id} must not be transient-retryable (integrity / typed hold)`,
    );
  }
});
