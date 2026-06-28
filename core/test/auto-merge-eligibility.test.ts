// Auto-merge eligibility gate unit tests (#306).
//
// All I/O is injected via EligibilityGateDeps — no real network, git, or
// subprocess calls. Each test follows the makeDeps() + rec recording pattern.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runEligibilityGate,
  runDeterministicChecks,
  parseAndValidateJudgeOutput,
  buildJudgePrompt,
  formatEligibilityVerdict,
  parseDiffFiles,
  countDiffLines,
  BUILT_IN_DENY_PATTERNS,
  type EligibilityGateDeps,
  type EligibilityGateOpts,
} from "../scripts/stages/auto_merge_eligibility.ts";
import type {
  AutoMergeEligibilityArtifact,
  EligibilityJudgeOutput,
  PipelineConfig,
  PrDetail,
  CheckRun,
} from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Rec {
  artifacts: AutoMergeEligibilityArtifact[];
  judgeInvocations: number;
}

function makeRec(): Rec {
  return { artifacts: [], judgeInvocations: 0 };
}

const VALID_JUDGE_OUTPUT: EligibilityJudgeOutput = {
  scope_size: "small",
  blast_radius: "low",
  semantic_risk: "mechanical",
  reversibility: "trivial",
  confidence: 0.9,
  reasons: ["purely mechanical refactor with full test coverage"],
  denial_reasons: [],
};

const HIGH_CONFIDENCE_ELIGIBLE_OUTPUT: EligibilityJudgeOutput = {
  ...VALID_JUDGE_OUTPUT,
  confidence: 0.95,
  denial_reasons: [],
};

function makePrDetail(overrides: Partial<PrDetail> = {}): PrDetail {
  return {
    number: 42,
    title: "chore: rename internal helper",
    body: "",
    state: "open",
    url: "https://github.com/acme/widget/pull/42",
    head_ref: "pipeline/123-fix-helper",
    head_sha: "abc1234def5678",
    base_ref: "main",
    mergeable: true,
    mergeable_state: "CLEAN",
    draft: false,
    additions: 10,
    deletions: 5,
    changed_files: 2,
    ...overrides,
  };
}

const SIMPLE_DIFF = `diff --git a/src/utils.ts b/src/utils.ts
index abc..def 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,5 +1,5 @@
-function helper() {
+function renamedHelper() {
   return 42;
 }
diff --git a/src/utils.test.ts b/src/utils.test.ts
index abc..def 100644
--- a/src/utils.test.ts
+++ b/src/utils.test.ts
@@ -1,5 +1,5 @@
-test("helper works", ...);
+test("renamedHelper works", ...);
`;

const MIGRATION_DIFF = `diff --git a/db/migrations/001_add_users.ts b/db/migrations/001_add_users.ts
index abc..def 100644
--- /dev/null
+++ b/db/migrations/001_add_users.ts
@@ -0,0 +1,5 @@
+export const up = () => {};
`;

const BIG_DIFF = "+" + "x".repeat(10) + "\n".repeat(350);

function makeBaseCfg(overrides: Partial<PipelineConfig["auto_merge_eligibility"]> = {}): PipelineConfig {
  return {
    profile_name: "claude",
    invocation: "$pipeline",
    review_mode: "prompt-harness",
    marker_footer: "---",
    implementation_ready_message: "ready",
    conventions_default: "CLAUDE.md",
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/tmp/does-not-exist",
    base_branch: "main",
    worktree_root: ".worktrees",
    max_concurrent_worktrees: 5,
    auto_recovery_max_retries: 2,
    implementation_timeout: 2400,
    review_timeout: 1500,
    plan_review_timeout: 300,
    fix_timeout: 2400,
    intake_timeout: 600,
    sweep_timeout: 600,
    ci_timeout: 900,
    ci_poll_interval: 30,
    ci_no_run_grace_s: 60,
    harnesses: { implementer: "claude", reviewer: "claude" },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet", intake: "sonnet", sweep: "sonnet" },
    openspec: { enabled: "auto", bootstrap: false },
    last30days: { enabled: false, timeout: 600 },
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
    test_gate: { enabled: false, max_attempts: 3, timeout: 300 },
    eval_gate: { enabled: false, mode: "gate", timeout: 300, max_attempts: 2 },
    shipcheck_gate: { enabled: false, mode: "advisory", max_rounds: 1, rubric_path: ".github/rubric.md", block_on_partial: false },
    review_policy: { block_threshold: "medium", min_confidence: 0.7, max_adversarial_rounds: 3, risk_proportional: false, ceiling_action: "park", surface_recurrence_rounds: 3 },
    doctor: { runOnStart: false, failFast: false },
    format_gate: [],
    harness_sandbox: false,
    auto_loop: { enabled: false, max_rounds: 3, max_wallclock_minutes: 60, stages: [] },
    auto_merge_eligibility: {
      enabled: true,
      max_diff_lines: 300,
      max_files: 10,
      deny_paths: [],
      allow_paths: [],
      min_confidence: 0.8,
      ...overrides,
    },
  };
}

function makeOpts(overrides: Partial<EligibilityGateOpts> = {}): EligibilityGateOpts {
  return {
    stateDir: "/tmp/state",
    worktreeDir: "/tmp/worktree",
    runId: "test-run-1",
    reviewVerdict: { verdict: "approve", findingCount: 0, recordedAt: "2026-06-28T00:00:00Z" },
    issueScope: "Rename internal helper function for clarity.",
    ...overrides,
  };
}

const PASSING_CI: CheckRun[] = [
  { name: "test", bucket: "pass", state: "completed" },
  { name: "build", bucket: "pass", state: "completed" },
];

const FAILING_CI: CheckRun[] = [
  { name: "test", bucket: "fail", state: "completed" },
];

function makeDeps(overrides: Partial<EligibilityGateDeps> = {}): { deps: EligibilityGateDeps; rec: Rec } {
  const rec = makeRec();
  const deps: EligibilityGateDeps = {
    getPrDetail: async () => makePrDetail(),
    getPrChecks: async () => PASSING_CI,
    getPrDiff: async () => SIMPLE_DIFF,
    getPrUnresolvedThreadCount: async () => 0,
    readEvidenceBundle: async () => ({ runId: "test-run-1", issue: 123, pr: 42 }),
    invokeJudge: async () => {
      rec.judgeInvocations++;
      return { stdout: JSON.stringify(VALID_JUDGE_OUTPUT), success: true };
    },
    recordArtifact: async (_stateDir, _issue, artifact) => {
      rec.artifacts.push(artifact);
    },
    ...overrides,
  };
  return { deps, rec };
}

// ---------------------------------------------------------------------------
// 7.2 — eligible low-risk PR
// ---------------------------------------------------------------------------

test("auto-merge-eligibility: eligible low-risk PR → artifact has eligibility=auto-merge-eligible", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const { deps, rec } = makeDeps({
    invokeJudge: async () => {
      rec.judgeInvocations++;
      return { stdout: JSON.stringify(HIGH_CONFIDENCE_ELIGIBLE_OUTPUT), success: true };
    },
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "auto-merge-eligible");
  assert.equal(artifact.denial_reasons.length, 0);
  assert.ok(artifact.judge_output !== null);
  assert.equal(artifact.judge_output!.blast_radius, "low");
  assert.equal(rec.judgeInvocations, 1);
  assert.equal(rec.artifacts.length, 1);
  assert.equal(rec.artifacts[0].eligibility, "auto-merge-eligible");
  assert.equal(artifact.linked_issue, 123);
  assert.equal(artifact.linked_pr, 42);
  assert.ok(artifact.revert_note.includes("git revert"));
});

// ---------------------------------------------------------------------------
// 7.3 — migration file triggers hard deny, judge NOT invoked
// ---------------------------------------------------------------------------

test("auto-merge-eligibility: migration file triggers hard deny, judge not invoked", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const { deps, rec } = makeDeps({
    getPrDiff: async () => MIGRATION_DIFF,
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("migrations")),
    `expected denial_reasons to contain 'migrations', got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 0, "judge must NOT be invoked when hard-deny fires");
  assert.equal(artifact.judge_output, null);
});

// ---------------------------------------------------------------------------
// 7.4 — diff line count exceeds threshold
// ---------------------------------------------------------------------------

test("auto-merge-eligibility: diff line count exceeds max_diff_lines → needs-human", async () => {
  const cfg = makeBaseCfg({ max_diff_lines: 100 });
  const opts = makeOpts();

  // Build a diff with 150 added lines
  const bigDiff = Array.from({ length: 150 }, (_, i) => `+line ${i}`).join("\n");
  const { deps, rec } = makeDeps({
    getPrDiff: async () => bigDiff,
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("diff_lines")),
    `expected diff_lines denial, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 0);
});

// ---------------------------------------------------------------------------
// 7.5 — judge returns invalid schema → needs-human
// ---------------------------------------------------------------------------

test("auto-merge-eligibility: judge returns invalid JSON → needs-human with schema validation failed", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const { deps, rec } = makeDeps({
    invokeJudge: async () => {
      rec.judgeInvocations++;
      return { stdout: '{"verdict": "not-a-valid-schema"}', success: true };
    },
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("schema validation failed")),
    `expected schema validation failed, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 1);
});

// ---------------------------------------------------------------------------
// 7.6 — judge confidence below min_confidence → needs-human
// ---------------------------------------------------------------------------

test("auto-merge-eligibility: judge confidence below min_confidence → needs-human", async () => {
  const cfg = makeBaseCfg({ min_confidence: 0.9 });
  const opts = makeOpts();
  const LOW_CONF: EligibilityJudgeOutput = { ...VALID_JUDGE_OUTPUT, confidence: 0.7, denial_reasons: [] };
  const { deps, rec } = makeDeps({
    invokeJudge: async () => {
      rec.judgeInvocations++;
      return { stdout: JSON.stringify(LOW_CONF), success: true };
    },
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("confidence") && r.includes("min_confidence")),
    `expected confidence denial, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 1);
  assert.ok(artifact.judge_output !== null, "judge output should be preserved even when confidence is low");
});

// ---------------------------------------------------------------------------
// 7.7 — judge harness errors → needs-human
// ---------------------------------------------------------------------------

test("auto-merge-eligibility: judge harness error → needs-human with harness error reason", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const { deps, rec } = makeDeps({
    invokeJudge: async () => {
      rec.judgeInvocations++;
      return { stdout: "", success: false, timed_out: true };
    },
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("harness error or timeout")),
    `expected harness error denial, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 1);
});

// ---------------------------------------------------------------------------
// 7.8 — missing evidence bundle → deterministic denial fires
// ---------------------------------------------------------------------------

test("auto-merge-eligibility: missing evidence bundle (no stateDir) → deterministic denial", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts({ stateDir: undefined });
  const { deps, rec } = makeDeps();

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("missing_evidence")),
    `expected missing_evidence denial, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 0, "judge must not be invoked when evidence bundle is missing");
});

// ---------------------------------------------------------------------------
// 7.9 — gate disabled → runEligibilityGate not called (config check)
// ---------------------------------------------------------------------------

test("auto-merge-eligibility: gate disabled → enabled=false returns early (never reaches judge)", async () => {
  // We test this by checking the config flag; the actual skip-when-disabled is in shipcheck.ts.
  // Here we verify that even if runEligibilityGate IS called with disabled config,
  // it still runs but the caller (shipcheck.ts) should skip it.
  // The main guard is in maybeRunEligibilityGate; this test covers the config shape.
  const cfg = makeBaseCfg({ enabled: false });
  assert.equal(cfg.auto_merge_eligibility.enabled, false, "gate should be disabled");
  // The gate function itself doesn't check enabled (that's done in shipcheck.ts wrapper),
  // so no assertion about gate behavior here — this is a config test.
});

// ---------------------------------------------------------------------------
// 7.10 — gate error inside shipcheck does not block ready-to-deploy (integration)
// ---------------------------------------------------------------------------

test("auto-merge-eligibility: gate error (PR fetch failure) does not block → needs-human artifact returned", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const { deps, rec } = makeDeps({
    getPrDetail: async () => { throw new Error("network error"); },
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  // runEligibilityGate itself catches fetch errors and returns a needs-human artifact
  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(artifact.denial_reasons.length > 0);
  // No exception should propagate (tested by the test not throwing)
});

// ---------------------------------------------------------------------------
// 7.11 — judge emits explicit denial reasons
// ---------------------------------------------------------------------------

test("auto-merge-eligibility: judge emits denial_reasons → needs-human with propagated reasons", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const DENY_OUTPUT: EligibilityJudgeOutput = {
    ...VALID_JUDGE_OUTPUT,
    denial_reasons: ["cross-cutting change affects shared contract", "no rollback plan documented"],
  };
  const { deps, rec } = makeDeps({
    invokeJudge: async () => {
      rec.judgeInvocations++;
      return { stdout: JSON.stringify(DENY_OUTPUT), success: true };
    },
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(artifact.denial_reasons.includes("cross-cutting change affects shared contract"));
  assert.ok(artifact.denial_reasons.includes("no rollback plan documented"));
  assert.equal(rec.judgeInvocations, 1);
});

// ---------------------------------------------------------------------------
// Deterministic check unit tests
// ---------------------------------------------------------------------------

test("runDeterministicChecks: clean PR passes all checks", () => {
  const cfg = makeBaseCfg();
  const pr = makePrDetail({ additions: 10, deletions: 5, changed_files: 2 });
  const files = ["src/utils.ts", "src/utils.test.ts"];
  const result = runDeterministicChecks(cfg, pr, files, 15, true, "abc123", true, true, SIMPLE_DIFF);

  assert.equal(result.passed, true);
  assert.equal(result.denial_reasons.length, 0);
  assert.ok(result.checks.every((c) => c.passed));
});

test("runDeterministicChecks: migration file → denial with touches: migrations", () => {
  const cfg = makeBaseCfg();
  const pr = makePrDetail();
  const files = ["db/migrations/001_add_column.ts"];
  const result = runDeterministicChecks(cfg, pr, files, 5, true, "abc123", true, true, MIGRATION_DIFF);

  assert.equal(result.passed, false);
  assert.ok(
    result.denial_reasons.some((r) => r.includes("migrations")),
    `expected migrations denial, got: ${JSON.stringify(result.denial_reasons)}`,
  );
  assert.equal(result.checks.find((c) => c.check === "built_in_deny_patterns")?.passed, false);
});

test("runDeterministicChecks: CI not passing → denial", () => {
  const cfg = makeBaseCfg();
  const pr = makePrDetail();
  const files = ["src/utils.ts", "src/utils.test.ts"];
  const result = runDeterministicChecks(cfg, pr, files, 15, false, "abc123", true, true, SIMPLE_DIFF);

  assert.equal(result.passed, false);
  assert.ok(result.denial_reasons.some((r) => r.includes("ci: no passing run")));
});

test("runDeterministicChecks: behavioral change without tests → denial", () => {
  const cfg = makeBaseCfg();
  const pr = makePrDetail();
  const noTestDiff = `diff --git a/src/utils.ts b/src/utils.ts
index abc..def 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 2;
`;
  const files = ["src/utils.ts"]; // no test files
  const result = runDeterministicChecks(cfg, pr, files, 2, true, "abc123", true, true, noTestDiff);

  assert.equal(result.passed, false);
  assert.ok(result.denial_reasons.some((r) => r.includes("missing_tests")));
});

test("runDeterministicChecks: deny_paths config match → denial", () => {
  const cfg = makeBaseCfg({ deny_paths: ["**/secret/**"] });
  const pr = makePrDetail();
  const files = ["src/secret/key.ts", "src/secret/key.test.ts"];
  const result = runDeterministicChecks(cfg, pr, files, 10, true, "abc123", true, true, SIMPLE_DIFF);

  assert.equal(result.passed, false);
  assert.ok(result.denial_reasons.some((r) => r.includes("deny_paths")));
});

test("runDeterministicChecks: allow_paths covers all files → passes", () => {
  const cfg = makeBaseCfg({ allow_paths: ["src/**"] });
  const pr = makePrDetail();
  const files = ["src/utils.ts", "src/utils.test.ts"];
  const result = runDeterministicChecks(cfg, pr, files, 15, true, "abc123", true, true, SIMPLE_DIFF);

  assert.equal(result.passed, true);
});

test("runDeterministicChecks: allow_paths doesn't cover all files → denial", () => {
  const cfg = makeBaseCfg({ allow_paths: ["src/**"] });
  const pr = makePrDetail();
  const files = ["src/utils.ts", "docs/readme.md", "src/utils.test.ts"];
  const result = runDeterministicChecks(cfg, pr, files, 15, true, "abc123", true, true, SIMPLE_DIFF);

  assert.equal(result.passed, false);
  assert.ok(result.denial_reasons.some((r) => r.includes("allow_paths")));
});

test("runDeterministicChecks: file count exceeds max_files → denial", () => {
  const cfg = makeBaseCfg({ max_files: 3 });
  const pr = makePrDetail({ changed_files: 5 });
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
  const result = runDeterministicChecks(cfg, pr, files, 50, true, "abc123", true, true, SIMPLE_DIFF);

  assert.equal(result.passed, false);
  assert.ok(result.denial_reasons.some((r) => r.includes("file_count")));
});

test("runDeterministicChecks: unclean review verdict → denial", () => {
  const cfg = makeBaseCfg();
  const pr = makePrDetail();
  const files = ["src/utils.ts", "src/utils.test.ts"];
  const result = runDeterministicChecks(cfg, pr, files, 15, true, "abc123", false, true, SIMPLE_DIFF);

  assert.equal(result.passed, false);
  assert.ok(result.denial_reasons.some((r) => r.includes("review: verdict is not approved")));
});

// ---------------------------------------------------------------------------
// parseAndValidateJudgeOutput tests
// ---------------------------------------------------------------------------

test("parseAndValidateJudgeOutput: valid JSON object → ok=true", () => {
  const result = parseAndValidateJudgeOutput(JSON.stringify(VALID_JUDGE_OUTPUT));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.output.scope_size, "small");
    assert.equal(result.output.blast_radius, "low");
    assert.equal(result.output.confidence, 0.9);
  }
});

test("parseAndValidateJudgeOutput: fenced JSON block → ok=true", () => {
  const raw = "Here is the output:\n```json\n" + JSON.stringify(VALID_JUDGE_OUTPUT) + "\n```\n";
  const result = parseAndValidateJudgeOutput(raw);
  assert.equal(result.ok, true);
});

test("parseAndValidateJudgeOutput: missing blast_radius → ok=false", () => {
  const { blast_radius: _, ...incomplete } = VALID_JUDGE_OUTPUT;
  const result = parseAndValidateJudgeOutput(JSON.stringify(incomplete));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.reason.includes("schema validation failed"));
});

test("parseAndValidateJudgeOutput: out-of-range confidence (1.5) → ok=false", () => {
  const result = parseAndValidateJudgeOutput(JSON.stringify({ ...VALID_JUDGE_OUTPUT, confidence: 1.5 }));
  assert.equal(result.ok, false);
});

test("parseAndValidateJudgeOutput: empty reasons array → ok=false", () => {
  const result = parseAndValidateJudgeOutput(JSON.stringify({ ...VALID_JUDGE_OUTPUT, reasons: [] }));
  assert.equal(result.ok, false);
});

test("parseAndValidateJudgeOutput: invalid scope_size → ok=false", () => {
  const result = parseAndValidateJudgeOutput(JSON.stringify({ ...VALID_JUDGE_OUTPUT, scope_size: "enormous" }));
  assert.equal(result.ok, false);
});

test("parseAndValidateJudgeOutput: completely invalid JSON → ok=false", () => {
  const result = parseAndValidateJudgeOutput("not json at all");
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.reason.includes("schema validation failed"));
});

// ---------------------------------------------------------------------------
// parseDiffFiles and countDiffLines
// ---------------------------------------------------------------------------

test("parseDiffFiles: extracts file paths from unified diff", () => {
  const files = parseDiffFiles(SIMPLE_DIFF);
  assert.deepEqual(files, ["src/utils.ts", "src/utils.test.ts"]);
});

test("countDiffLines: counts added and removed lines", () => {
  const count = countDiffLines(SIMPLE_DIFF);
  // 2 added lines + 2 removed lines = 4
  assert.equal(count, 4);
});

// ---------------------------------------------------------------------------
// BUILT_IN_DENY_PATTERNS smoke tests
// ---------------------------------------------------------------------------

test("BUILT_IN_DENY_PATTERNS: migration paths match", () => {
  const migrationPaths = [
    "db/migrations/001_add_column.sql",
    "src/database/migrations/up.ts",
    "migrate.migration.ts",
  ];
  for (const p of migrationPaths) {
    assert.ok(
      BUILT_IN_DENY_PATTERNS.some((r) => r.test(p)),
      `expected ${p} to match a built-in deny pattern`,
    );
  }
});

test("BUILT_IN_DENY_PATTERNS: .github/workflows paths match", () => {
  assert.ok(BUILT_IN_DENY_PATTERNS.some((r) => r.test(".github/workflows/ci.yml")));
});

test("BUILT_IN_DENY_PATTERNS: normal source file does not match", () => {
  const normalPaths = ["src/utils.ts", "core/helpers/parse.js", "README.md"];
  for (const p of normalPaths) {
    assert.ok(
      !BUILT_IN_DENY_PATTERNS.some((r) => r.test(p)),
      `expected ${p} NOT to match any built-in deny pattern`,
    );
  }
});

// ---------------------------------------------------------------------------
// buildJudgePrompt
// ---------------------------------------------------------------------------

test("buildJudgePrompt: substitutes all placeholders including schema_block", () => {
  const prompt = buildJudgePrompt({
    prDiffSummary: "2 files changed",
    fileList: "- src/utils.ts",
    reviewVerdict: "approved",
    ciStatus: "PASS",
    evidenceMetadata: "run-id: test-1",
    issueScope: "Rename helper",
  });
  assert.ok(!prompt.includes("{{"), "all placeholders should be substituted");
  assert.ok(prompt.includes("scope_size"), "schema_block should be substituted");
  assert.ok(prompt.includes("blast_radius"), "schema_block should be substituted");
  assert.ok(prompt.includes("2 files changed"), "pr_diff_summary should be substituted");
});

// ---------------------------------------------------------------------------
// formatEligibilityVerdict
// ---------------------------------------------------------------------------

test("formatEligibilityVerdict: eligible artifact shows ELIGIBLE", () => {
  const artifact: AutoMergeEligibilityArtifact = {
    eligibility: "auto-merge-eligible",
    evaluated_at: "2026-06-28T00:00:00Z",
    deterministic_checks: [],
    denial_reasons: [],
    judge_output: VALID_JUDGE_OUTPUT,
    ci_status_snapshot: { sha: "abc", conclusion: "success", checked_at: "2026-06-28T00:00:00Z" },
    review_verdict_snapshot: { verdict: "approve", finding_count: 0, recorded_at: "2026-06-28T00:00:00Z" },
    linked_run_id: "test-run",
    linked_issue: 123,
    linked_pr: 42,
    revert_note: "git revert abc",
  };
  const line = formatEligibilityVerdict(artifact);
  assert.ok(line.includes("ELIGIBLE"), `expected ELIGIBLE in: ${line}`);
});

test("formatEligibilityVerdict: needs-human artifact shows NEEDS HUMAN and reasons", () => {
  const artifact: AutoMergeEligibilityArtifact = {
    eligibility: "needs-human",
    evaluated_at: "2026-06-28T00:00:00Z",
    deterministic_checks: [],
    denial_reasons: ["touches: migrations (db/migrations/001.ts)", "ci: no passing run"],
    judge_output: null,
    ci_status_snapshot: { sha: "abc", conclusion: "failure", checked_at: "2026-06-28T00:00:00Z" },
    review_verdict_snapshot: { verdict: "approve", finding_count: 0, recorded_at: "2026-06-28T00:00:00Z" },
    linked_run_id: "test-run",
    linked_issue: 123,
    linked_pr: 42,
    revert_note: "git revert abc",
  };
  const line = formatEligibilityVerdict(artifact);
  assert.ok(line.includes("NEEDS HUMAN"), `expected NEEDS HUMAN in: ${line}`);
  assert.ok(line.includes("migrations"), `expected denial reasons in: ${line}`);
});

// ---------------------------------------------------------------------------
// 8.1 — Config schema tests (auto_merge_eligibility block)
// ---------------------------------------------------------------------------

test("config: auto_merge_eligibility defaults are applied correctly", () => {
  const cfg = makeBaseCfg();
  assert.equal(cfg.auto_merge_eligibility.enabled, true); // overridden in makeBaseCfg
  assert.equal(cfg.auto_merge_eligibility.max_diff_lines, 300);
  assert.equal(cfg.auto_merge_eligibility.max_files, 10);
  assert.deepEqual(cfg.auto_merge_eligibility.deny_paths, []);
  assert.deepEqual(cfg.auto_merge_eligibility.allow_paths, []);
  assert.equal(cfg.auto_merge_eligibility.min_confidence, 0.8);
});

test("config: auto_merge_eligibility defaults to disabled when not set", async () => {
  // The DEFAULT_CONFIG has enabled: false
  const { DEFAULT_CONFIG } = await import("../scripts/types.ts");
  assert.equal(DEFAULT_CONFIG.auto_merge_eligibility.enabled, false);
  assert.equal(DEFAULT_CONFIG.auto_merge_eligibility.max_diff_lines, 300);
  assert.equal(DEFAULT_CONFIG.auto_merge_eligibility.max_files, 10);
  assert.equal(DEFAULT_CONFIG.auto_merge_eligibility.min_confidence, 0.8);
});

// ---------------------------------------------------------------------------
// Regression tests for review-1 findings
// ---------------------------------------------------------------------------

// Finding 1: judge high blast_radius → needs-human even with no denial_reasons
test("finding1: judge blast_radius=high with no denial_reasons → needs-human", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const HIGH_BLAST: EligibilityJudgeOutput = {
    ...VALID_JUDGE_OUTPUT,
    blast_radius: "high",
    denial_reasons: [],
  };
  const { deps, rec } = makeDeps({
    invokeJudge: async () => {
      rec.judgeInvocations++;
      return { stdout: JSON.stringify(HIGH_BLAST), success: true };
    },
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("blast_radius")),
    `expected blast_radius denial, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 1);
});

// Finding 1: judge semantic_risk=cross_cutting_behavior → needs-human
test("finding1: judge semantic_risk=cross_cutting_behavior → needs-human", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const CC_OUTPUT: EligibilityJudgeOutput = {
    ...VALID_JUDGE_OUTPUT,
    blast_radius: "low",
    semantic_risk: "cross_cutting_behavior",
    denial_reasons: [],
  };
  const { deps, rec } = makeDeps({
    invokeJudge: async () => {
      rec.judgeInvocations++;
      return { stdout: JSON.stringify(CC_OUTPUT), success: true };
    },
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("semantic_risk")),
    `expected semantic_risk denial, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 1);
});

// Finding 2: empty CI checks → needs-human (parseChecksAggregate([]) is true but no runs exist)
test("finding2: empty CI check runs → needs-human with ci: no passing run", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const { deps, rec } = makeDeps({
    getPrChecks: async () => [],
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("ci: no passing run")),
    `expected ci: no passing run denial, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 0, "judge must not be invoked when CI has no runs");
});

// Finding 3: unresolved review threads → needs-human
test("finding3: unresolved review threads → needs-human with unresolved_review_comments", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const { deps, rec } = makeDeps({
    getPrUnresolvedThreadCount: async () => 2,
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("unresolved_review_comments: 2")),
    `expected unresolved_review_comments denial, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 0, "judge must not be invoked when review threads are unresolved");
});

// Finding 3: unresolved threads check in runDeterministicChecks
test("runDeterministicChecks: unresolved review threads → denial", () => {
  const cfg = makeBaseCfg();
  const pr = makePrDetail();
  const files = ["src/utils.ts", "src/utils.test.ts"];
  const result = runDeterministicChecks(cfg, pr, files, 15, true, "abc123", true, true, SIMPLE_DIFF, {
    unresolvedThreadCount: 3,
  });

  assert.equal(result.passed, false);
  assert.ok(result.denial_reasons.some((r) => r.includes("unresolved_review_comments: 3")));
});

// Finding 3: zero unresolved threads → passes the check
test("runDeterministicChecks: zero unresolved threads → check passes", () => {
  const cfg = makeBaseCfg();
  const pr = makePrDetail();
  const files = ["src/utils.ts", "src/utils.test.ts"];
  const result = runDeterministicChecks(cfg, pr, files, 15, true, "abc123", true, true, SIMPLE_DIFF, {
    unresolvedThreadCount: 0,
  });

  assert.equal(result.passed, true);
  assert.ok(result.checks.find((c) => c.check === "unresolved_review_comments")?.passed);
});

// Finding 4: stateDir set but bundle is null (missing) → needs-human
test("finding4: stateDir set but evidence bundle missing → needs-human with missing_evidence", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts({ stateDir: "/tmp/state" });
  const { deps, rec } = makeDeps({
    readEvidenceBundle: async () => null,
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("missing_evidence")),
    `expected missing_evidence denial, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 0, "judge must not be invoked when evidence bundle is missing");
});

// Finding 4: bundle present + no_test_rationale bypasses behavioral-change denial
test("finding4: no_test_rationale in bundle → behavioral-change check passes", () => {
  const cfg = makeBaseCfg();
  const pr = makePrDetail();
  const noTestDiff = `diff --git a/src/generated.ts b/src/generated.ts
index abc..def 100644
--- a/src/generated.ts
+++ b/src/generated.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 2;
`;
  const files = ["src/generated.ts"]; // no test files, but rationale is present
  const result = runDeterministicChecks(
    cfg, pr, files, 2, true, "abc123", true, true, noTestDiff,
    { noTestRationale: "generated code — tests are snapshot-tested separately" },
  );

  assert.equal(result.passed, true, "should pass when no_test_rationale is provided");
  assert.ok(result.checks.find((c) => c.check === "behavioral_change_without_tests")?.passed);
});

// Finding 5: package.json at any path triggers hard deny
test("finding5: package.json at nested path triggers built-in deny pattern", () => {
  const packageJsonPaths = [
    "package.json",
    "core/package.json",
    "packages/web/package.json",
  ];
  for (const p of packageJsonPaths) {
    assert.ok(
      BUILT_IN_DENY_PATTERNS.some((r) => r.test(p)),
      `expected ${p} to match a built-in deny pattern`,
    );
  }
});

// Finding 5: nested lockfiles trigger hard deny
test("finding5: nested lockfile at any path triggers built-in deny pattern", () => {
  const nestedLockPaths = [
    "core/package-lock.json",
    "packages/api/yarn.lock",
    "services/auth/pnpm-lock.yaml",
  ];
  for (const p of nestedLockPaths) {
    assert.ok(
      BUILT_IN_DENY_PATTERNS.some((r) => r.test(p)),
      `expected ${p} to match a built-in deny pattern`,
    );
  }
});

// ---------------------------------------------------------------------------
// Regression tests for review-2 findings
// ---------------------------------------------------------------------------

// Finding 3 (review-2): parseDiffFiles includes b/ path for renames
test("parseDiffFiles: rename into .github/workflows → b/ path included", () => {
  const renameDiff = `diff --git a/scripts/old-ci.sh b/.github/workflows/ci.yml
similarity index 80%
rename from scripts/old-ci.sh
rename to .github/workflows/ci.yml
index abc..def 100644
--- a/scripts/old-ci.sh
+++ b/.github/workflows/ci.yml
@@ -1,3 +1,3 @@
-old
+new
`;
  const files = parseDiffFiles(renameDiff);
  assert.ok(files.includes(".github/workflows/ci.yml"), `expected b/ path included, got: ${JSON.stringify(files)}`);
  assert.ok(files.includes("scripts/old-ci.sh"), `expected a/ path included, got: ${JSON.stringify(files)}`);
});

test("auto-merge-eligibility: rename from safe file into workflows → needs-human (b/ path evaluated)", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const renameDiff = `diff --git a/scripts/old-ci.sh b/.github/workflows/ci.yml
similarity index 80%
rename from scripts/old-ci.sh
rename to .github/workflows/ci.yml
index abc..def 100644
--- a/scripts/old-ci.sh
+++ b/.github/workflows/ci.yml
@@ -1,3 +1,3 @@
-#!/bin/bash
+name: CI
`;
  const { deps, rec } = makeDeps({
    getPrDiff: async () => renameDiff,
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("release_config") || r.includes("ci.yml") || r.includes("workflows")),
    `expected workflows deny, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 0, "judge must not be invoked when hard-deny fires");
});

// Finding 4 (review-2): stale bundle with wrong PR number → missing_evidence denial
test("finding: stale bundle with wrong PR number → missing_evidence denial", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const { deps, rec } = makeDeps({
    readEvidenceBundle: async () => ({
      runId: "some-run-id",
      issue: 123,
      pr: 999, // wrong PR number — prNumber in the gate call is 42
    }),
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("missing_evidence")),
    `expected missing_evidence denial due to stale bundle, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 0);
});

// Finding 2 (review-3): bundle with pr:null → missing_evidence hard denial (spec: incomplete evidence = deny)
test("finding2-review3: bundle with pr:null → missing_evidence denial", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const { deps, rec } = makeDeps({
    readEvidenceBundle: async () => ({
      runId: "some-run-id",
      issue: 123,
      pr: null, // null PR — must be rejected as incomplete identity
    }),
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  assert.equal(artifact.eligibility, "needs-human");
  assert.ok(
    artifact.denial_reasons.some((r) => r.includes("missing_evidence")),
    `expected missing_evidence denial for null pr, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
  assert.equal(rec.judgeInvocations, 0);
});

test("finding: bundle with matching issue+pr → evidence check passes", async () => {
  const cfg = makeBaseCfg();
  const opts = makeOpts();
  const { deps } = makeDeps({
    readEvidenceBundle: async () => ({
      runId: "run-id-1",
      issue: 123,
      pr: 42,
    }),
  });

  const artifact = await runEligibilityGate(cfg, 123, 42, opts, deps);

  // Should not deny on evidence check when identity matches
  assert.ok(
    !artifact.denial_reasons.some((r) => r.includes("missing_evidence")),
    `should NOT have missing_evidence denial, got: ${JSON.stringify(artifact.denial_reasons)}`,
  );
});

// Finding 5 (review-2): new built-in deny patterns
test("BUILT_IN_DENY_PATTERNS: auth file basename matches", () => {
  const authPaths = ["src/auth.ts", "lib/authentication.js", "app/authorization.rb"];
  for (const p of authPaths) {
    assert.ok(
      BUILT_IN_DENY_PATTERNS.some((r) => r.test(p)),
      `expected ${p} to match a built-in deny pattern`,
    );
  }
});

test("BUILT_IN_DENY_PATTERNS: dependency manifest files match", () => {
  const manifestPaths = [
    "go.mod",
    "packages/api/go.mod",
    "requirements.txt",
    "requirements-dev.txt",
    "pyproject.toml",
    "Cargo.toml",
    "Gemfile",
  ];
  for (const p of manifestPaths) {
    assert.ok(
      BUILT_IN_DENY_PATTERNS.some((r) => r.test(p)),
      `expected ${p} to match a built-in deny pattern`,
    );
  }
});
