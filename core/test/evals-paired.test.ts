// Paired-mode tests (#601 implementing-paired / pipeline-paired).
// Every dependency is injected — no real fs, git, subprocess, or network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runCell as runCellReal,
  type CellExecutionDeps,
} from "../scripts/evals/executor.ts";
import { validateFixture } from "../scripts/evals/fixture.ts";
import { validateManifest } from "../scripts/evals/manifest.ts";
import { gradeImplementationFix } from "../scripts/evals/grading/graders/implementation.ts";
import { generateSummary } from "../scripts/evals/reporting/report.ts";
import {
  materializePairedImplementPrompt,
  materializePairedStandardReviewPrompt,
  EVAL_NO_COMMIT_PUSH_OVERRIDE,
} from "../scripts/evals/stage-adapters.ts";
import { DEFAULT_CONFIG, type PipelineConfig, type ReviewFinding } from "../scripts/types.ts";
import type { Cell, Fixture } from "../scripts/evals/types.ts";
import type { GradeRecord } from "../scripts/evals/grading/types.ts";

function fakeContractIO(): NonNullable<CellExecutionDeps["contractIO"]> {
  const files = new Map<string, string>();
  return {
    readFile: (p) => (files.has(p) ? files.get(p)! : null),
    writeFile: (p, c) => {
      files.set(p, c);
    },
    removeFile: (p) => {
      files.delete(p);
    },
  };
}

async function runCell(...args: Parameters<typeof runCellReal>): ReturnType<typeof runCellReal> {
  const [cfg, cell, fixture, manifest, deps = {}] = args;
  return runCellReal(cfg, cell, fixture, manifest, {
    contractIO: fakeContractIO(),
    installBoundaryShim: (worktreeDir: string) => `${worktreeDir}/.eval-boundary-shim`,
    readBoundaryDenials: () => [],
    ...deps,
  });
}

const SHA = "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd";

const FAKE_CFG = {
  ...DEFAULT_CONFIG,
  repo_dir: "/fake/repo",
  repo: "owner/repo",
  domain: "test",
  harnesses: {
    implementer: "claude",
    reviewer: "codex",
    implementerSource: "profile",
    reviewerSource: "profile",
    reviewerEffort: "xhigh",
  },
} as PipelineConfig;

function approveVerdict(findings: ReviewFinding[] = []): string {
  return JSON.stringify({
    verdict: findings.length === 0 ? "approve" : "needs-attention",
    summary: findings.length === 0 ? "LGTM" : "Issues found",
    findings,
    next_steps: [],
  });
}

function blockingFinding(title = "bug"): ReviewFinding {
  return {
    severity: "high",
    title,
    body: "A real defect",
    confidence: 0.9,
    recommendation: "Fix it",
    file: "core/scripts/foo.ts",
    line_start: 1,
    line_end: 2,
  };
}

function makeFixture(stage: "implementing" | "planning" = "implementing"): Fixture {
  return validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "Implement positive issue numbers.",
      stage_entry_artifacts: {
        [stage]: stage === "implementing" ? { plan: "Add validation." } : { notes: "plan stage" },
      },
      public_checks: [],
      grader_refs: [{ grader: "implementation-fix", version: "1" }],
      category: "correctness",
      risk: "low",
      provenance: "synthetic",
      allowed_change_paths: ["core/scripts/foo.ts", "plugin/skills/pipeline/core/scripts/foo.ts"],
    },
    "f1.json",
  );
}

function pairedManifest(mode: "implementing-paired" | "pipeline-paired" = "implementing-paired") {
  return validateManifest(
    {
      schema_version: 1,
      experiment_id: "pair-exp",
      fixture_ids: ["f1"],
      mode,
      treatments: {
        form: "named-pairs",
        pairs: [
          {
            id: "claude__codex",
            primary: { harness: "claude", model: "sonnet" },
            reviewer: { harness: "codex", model: "gpt-5" },
          },
        ],
      },
      replicates: 1,
      seed: 1,
      concurrency: 1,
      timeout: 120,
      output_dir: ".agent-pipeline/evals",
    },
    new Set(["f1"]),
  );
}

function makeCell(mode: "implementing-paired" | "pipeline-paired" = "implementing-paired"): Cell {
  return {
    cell_id: "pair-exp/f1/claude__codex/1",
    experiment_id: "pair-exp",
    fixture_id: "f1",
    treatment_id: "claude__codex",
    treatment: {
      id: "claude__codex",
      harness: "claude",
      primary: { harness: "claude", model: "sonnet" },
      reviewer: { harness: "codex", model: "gpt-5" },
    },
    replicate: 1,
    mode,
    base_sha: SHA,
  };
}

function success(stdout: string, duration = 1) {
  return { success: true, timed_out: false, exit_code: 0, stdout, stderr: "", duration };
}

test("materializePairedImplementPrompt: reuses production implement path + eval no-commit override", () => {
  const fixture = makeFixture();
  const prompt = materializePairedImplementPrompt(
    {
      cfg: FAKE_CFG,
      fixture,
      pipelineRunId: "eval-1",
      implementer: "claude",
      reviewer: "codex",
    },
    "Add validation.",
  );
  assert.match(prompt, /Implement|implementation|plan/i);
  assert.ok(prompt.includes(EVAL_NO_COMMIT_PUSH_OVERRIDE.trim().slice(0, 40)));
  assert.match(prompt, /MUST NOT/);
});

test("materializePairedStandardReviewPrompt: includes actual diff not only frozen artifact", () => {
  const fixture = makeFixture();
  const diff = "diff --git a/core/scripts/foo.ts b/core/scripts/foo.ts\n+export const x = 1;\n";
  const prompt = materializePairedStandardReviewPrompt(
    {
      cfg: FAKE_CFG,
      fixture,
      pipelineRunId: "eval-1",
      implementer: "claude",
      reviewer: "codex",
    },
    "plan text",
    diff,
  );
  assert.ok(prompt.includes(diff));
  assert.match(prompt, /verdict|findings/i);
});

test("implementing-paired: no-fix path when first review has no blocking findings", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  const phases: string[] = [];
  let contractPresentAtReview = false;
  const contractFiles = new Map<string, string>();
  const contractIO = {
    readFile: (p: string) => (contractFiles.has(p) ? contractFiles.get(p)! : null),
    writeFile: (p: string, c: string) => {
      contractFiles.set(p, c);
    },
    removeFile: (p: string) => {
      contractFiles.delete(p);
    },
  };

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    contractIO,
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff --git a/core/scripts/foo.ts\n+ok\n",
    getChangedPaths: async () => ["core/scripts/foo.ts"],
    invokeHarness: async (args) => {
      phases.push(`${args.harness}:${args.prompt.slice(0, 40)}`);
      // Contract must still be installed mid-loop (before review).
      if (args.harness === "codex") {
        contractPresentAtReview = [...contractFiles.values()].some((v) => v.includes("evaluation") || v.includes("eval"));
      }
      if (args.harness === "claude") {
        return success("implemented");
      }
      return success(approveVerdict([]));
    },
  });

  assert.equal(result.outcome.result_class, "completed");
  const detail = result.outcome.detail!;
  assert.equal(detail.fix_invoked, false);
  assert.equal(detail.fix_1_invoked, false);
  assert.equal(detail.pair_id, "claude__codex");
  assert.equal(detail.blocking_findings_before, 0);
  assert.equal(detail.review_1_verdict_parse, "strict");
  // implement + review only (no fix, no re-review)
  assert.equal(phases.length, 2);
  assert.ok(phases[0].startsWith("claude:"));
  assert.ok(phases[1].startsWith("codex:"));
  assert.ok(phases[1].includes("diff") || result.materializedPrompt.includes("diff --git"));
  assert.ok(contractPresentAtReview, "eval contract must remain installed before reviewer invocation");
  // Reviewer prompt must carry the actual diff
  assert.ok(result.materializedPrompt.includes("diff --git"));
});

test("implementing-paired: blocking findings trigger fix and re-review", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  const phases: string[] = [];
  let reviewRound = 0;

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff --git a/x\n+fixed\n",
    getChangedPaths: async () => ["core/scripts/foo.ts"],
    invokeHarness: async (args) => {
      phases.push(args.harness);
      if (args.harness === "claude") {
        return success(args.prompt.includes("fix") || args.prompt.includes("Finding") || args.prompt.includes("findings")
          ? "fixed"
          : "implemented");
      }
      reviewRound += 1;
      if (reviewRound === 1) {
        return success(approveVerdict([blockingFinding()]));
      }
      return success(approveVerdict([]));
    },
  });

  assert.equal(result.outcome.result_class, "completed");
  const detail = result.outcome.detail!;
  assert.equal(detail.fix_invoked, true);
  assert.equal(detail.fix_1_invoked, true);
  assert.equal(detail.blocking_findings_before, 1);
  assert.equal(detail.blocking_findings_after, 0);
  // primary implement, reviewer review-1, primary fix, reviewer re-review
  assert.deepEqual(phases, ["claude", "codex", "claude", "codex"]);
});

test("implementing-paired: advisory findings do not trigger fix", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  const phases: string[] = [];
  const advisory: ReviewFinding = {
    severity: "low",
    title: "nit",
    body: "style",
    confidence: 0.5,
    recommendation: "optional",
  };

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff",
    invokeHarness: async (args) => {
      phases.push(args.harness);
      if (args.harness === "claude") return success("impl");
      return success(approveVerdict([advisory]));
    },
  });

  assert.equal(result.outcome.result_class, "completed");
  assert.equal(result.outcome.detail!.fix_invoked, false);
  assert.equal(phases.length, 2);
});

test("implementing-paired: malformed review is never treated as approval", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  let reviewCalls = 0;

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff",
    invokeHarness: async (args) => {
      if (args.harness === "claude") return success("impl-or-fix");
      reviewCalls += 1;
      if (reviewCalls === 1) return success("This is free-form prose, not a verdict JSON.");
      return success(approveVerdict([]));
    },
  });

  assert.equal(result.outcome.result_class, "completed");
  const detail = result.outcome.detail!;
  assert.equal(detail.review_1_verdict_parse, "unparseable");
  assert.equal(detail.fix_invoked, true, "unparseable must not be empty-findings approval");
  assert.ok((detail.malformed_review_count as number) >= 1);
  assert.equal(reviewCalls, 2, "re-review after unparseable-triggered fix");
});

test("implementing-paired: primary auth failure is attributed to primary and does not invoke reviewer", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  const harnesses: string[] = [];

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async (harness) => {
      if (harness === "claude") {
        return { ok: false, failure: "unauthenticated", message: "not logged in" };
      }
      return { ok: true };
    },
    invokeHarness: async (args) => {
      harnesses.push(args.harness);
      return success("x");
    },
  });

  assert.equal(result.outcome.result_class, "auth_error");
  assert.equal(result.outcome.detail?.failed_role, "primary");
  assert.deepEqual(harnesses, [], "reviewer must not be invoked after primary auth failure");
});

test("implementing-paired: reviewer auth failure is attributed to reviewer after primary implement", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  const harnesses: string[] = [];

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async (harness) => {
      if (harness === "codex") {
        return { ok: false, failure: "unauthenticated", message: "codex auth missing" };
      }
      return { ok: true };
    },
    getDiff: async () => "diff",
    invokeHarness: async (args) => {
      harnesses.push(args.harness);
      return success("implemented");
    },
  });

  assert.equal(result.outcome.result_class, "auth_error");
  assert.equal(result.outcome.detail?.failed_role, "reviewer");
  assert.deepEqual(harnesses, ["claude"], "primary implement must run before reviewer auth failure");
});

test("implementing-paired: per-cell timeout spans the whole pair loop", async () => {
  const fixture = makeFixture();
  const manifest = validateManifest(
    {
      ...Object.fromEntries(
        Object.entries({
          schema_version: 1,
          experiment_id: "pair-exp",
          fixture_ids: ["f1"],
          mode: "implementing-paired",
          treatments: {
            form: "named-pairs",
            pairs: [
              {
                id: "claude__codex",
                primary: { harness: "claude" },
                reviewer: { harness: "codex" },
              },
            ],
          },
          replicates: 1,
          seed: 1,
          concurrency: 1,
          timeout: 1,
          output_dir: ".agent-pipeline/evals",
        }),
      ),
    },
    new Set(["f1"]),
  );
  // Force timeout by making invocations take wall-clock past deadline.
  const cell = makeCell();
  let call = 0;
  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff",
    invokeHarness: async (args) => {
      call += 1;
      if (call >= 2) {
        // Exceed remaining budget by reporting timed_out.
        return { success: false, timed_out: true, exit_code: -1, stdout: "", stderr: "timeout", duration: 2 };
      }
      return success(args.harness === "claude" ? "impl" : approveVerdict([blockingFinding()]));
    },
  });

  assert.equal(result.outcome.result_class, "timeout");
});

test("implementing-paired: no production GitHub writes across full pair loop", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  const ghOps: string[] = [];

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff --git a/x\n+y\n",
    getChangedPaths: async () => ["core/scripts/foo.ts"],
    invokeHarness: async (args) => {
      // Attempt mutating operations through the eval gh surface if present.
      const gh = args.gh as {
        addLabel?: (...a: unknown[]) => Promise<unknown>;
        postComment?: (...a: unknown[]) => Promise<unknown>;
        createPr?: (...a: unknown[]) => Promise<unknown>;
      };
      if (gh.addLabel) {
        try {
          await gh.addLabel("x", 1, "pipeline:implementing");
          ghOps.push("addLabel-succeeded");
        } catch {
          ghOps.push("addLabel-refused");
        }
      }
      if (gh.postComment) {
        try {
          await gh.postComment("x", 1, "hi");
          ghOps.push("postComment-succeeded");
        } catch {
          ghOps.push("postComment-refused");
        }
      }
      if (args.harness === "claude") return success("impl");
      return success(approveVerdict([]));
    },
  });

  assert.equal(result.outcome.result_class, "completed");
  assert.ok(!ghOps.some((op) => op.endsWith("-succeeded")), `no successful mutations: ${ghOps.join(",")}`);
  // Refusals should be recorded when the surface is exercised.
  if (ghOps.length > 0) {
    assert.ok(result.ghRefusals.length > 0 || ghOps.every((op) => op.endsWith("-refused")));
  }
});

test("pipeline-paired: graph order planning → plan-review → implement → review; skips plan revision when clean", async () => {
  const fixture = makeFixture("planning");
  const manifest = pairedManifest("pipeline-paired");
  const cell = makeCell("pipeline-paired");
  const phases: string[] = [];

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff --git a/x\n+y\n",
    getChangedPaths: async () => ["core/scripts/foo.ts"],
    invokeHarness: async (args) => {
      // Infer phase from prompt content.
      const p = args.prompt;
      if (p.includes("plan review") || p.includes("Plan Review") || p.includes("review the following implementation plan") || /plan_review|Review the plan/i.test(p) || (args.harness === "codex" && phases.filter((x) => x.startsWith("codex")).length === 0 && phases.some((x) => x.startsWith("claude")))) {
        // first codex after first claude is plan-review when planning ran
      }
      const label =
        args.harness === "claude"
          ? phases.filter((x) => x.startsWith("claude")).length === 0
            ? "claude:planning"
            : phases.some((x) => x === "codex:plan-review")
              ? phases.some((x) => x === "claude:implementing")
                ? "claude:fix-or-later"
                : "claude:implementing"
              : "claude:later"
          : phases.filter((x) => x.startsWith("codex")).length === 0
            ? "codex:plan-review"
            : phases.filter((x) => x.startsWith("codex")).length === 1
              ? "codex:review-1"
              : "codex:review-2";
      phases.push(label);

      if (label === "claude:planning") return success("# Plan\nDo the thing.");
      if (label === "codex:plan-review") return success(approveVerdict([]));
      if (label.startsWith("claude:implementing")) return success("implemented");
      if (label === "codex:review-1") return success(approveVerdict([]));
      if (label === "codex:review-2") return success(approveVerdict([]));
      return success("ok");
    },
  });

  assert.equal(result.outcome.result_class, "completed");
  assert.equal(result.outcome.detail!.plan_revision_invoked, false);
  assert.ok(phases[0] === "claude:planning");
  assert.ok(phases[1] === "codex:plan-review");
  assert.ok(phases.includes("claude:implementing"));
  assert.ok(phases.includes("codex:review-1"));
  // plan-review input must include plan text from primary
  assert.ok(result.materializedPrompt.includes("Do the thing."));
  // no fabricated third review after fix-2 path (we never fixed)
  assert.equal(result.outcome.detail!.fix_2_invoked, false);
});

test("pipeline-paired: no third review after fix-2; review-2 findings labeled separately", async () => {
  const fixture = makeFixture("planning");
  const manifest = pairedManifest("pipeline-paired");
  const cell = makeCell("pipeline-paired");
  const phases: string[] = [];
  let codexCount = 0;
  let claudeCount = 0;

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff",
    getChangedPaths: async () => ["core/scripts/foo.ts"],
    invokeHarness: async (args) => {
      if (args.harness === "claude") {
        claudeCount += 1;
        phases.push(`claude-${claudeCount}`);
        if (claudeCount === 1) return success("# Plan");
        return success("work");
      }
      codexCount += 1;
      phases.push(`codex-${codexCount}`);
      // plan-review clean, review-1 clean, review-2 blocking
      if (codexCount === 1) return success(approveVerdict([]));
      if (codexCount === 2) return success(approveVerdict([]));
      return success(approveVerdict([blockingFinding("adv-bug")]));
    },
  });

  assert.equal(result.outcome.result_class, "completed");
  assert.equal(result.outcome.detail!.fix_2_invoked, true);
  assert.equal(result.outcome.detail!.review_2_unparseable, false);
  assert.ok(Array.isArray(result.outcome.detail!.review_2_findings));
  assert.equal(result.outcome.detail!.post_fix_2_diff_present, true);
  // plan-review + review-1 + review-2 only (no third review)
  assert.equal(codexCount, 3);
  // planning + implementing + fix-2 (and possibly not plan revision)
  assert.ok(claudeCount >= 3);
  assert.ok(!phases.includes("codex-4"), "must not fabricate a third review after fix-2");
});

test("pair role overlay: pair coordinates override config slot defaults", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  // Pair says primary=claude; config says implementer=codex — pair wins.
  const cfg = {
    ...FAKE_CFG,
    harnesses: {
      ...FAKE_CFG.harnesses,
      implementer: "codex",
      reviewer: "claude",
      reviewerEffort: "xhigh",
    },
  } as PipelineConfig;
  const harnesses: string[] = [];

  await runCell(cfg, makeCell(), fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "d",
    invokeHarness: async (args) => {
      harnesses.push(args.harness);
      if (args.harness === "claude") return success("impl");
      return success(approveVerdict([]));
    },
  });

  assert.ok(harnesses.includes("claude"), "primary pair harness must win over config implementer");
  assert.ok(harnesses.includes("codex"), "reviewer pair harness must win over config reviewer");
});

test("deterministic implementation grading applies to completed paired cells", () => {
  const fixture = makeFixture();
  const grade = gradeImplementationFix(
    fixture,
    { "true": true },
    { "true": true },
    ["core/scripts/foo.ts"],
  );
  assert.ok(grade);
  // Grade identity is joined via treatment_id on GradeRecord — verified in summary test.
});

test("summary includes pair identity, fix invocation, blocking, malformed, quality, reliability", () => {
  const manifest = pairedManifest();
  const plan = {
    schema_version: 1,
    experiment_id: "pair-exp",
    seed: 1,
    cells: [
      {
        cell_id: "pair-exp/f1/claude__codex/1",
        experiment_id: "pair-exp",
        fixture_id: "f1",
        treatment_id: "claude__codex",
        treatment: {
          id: "claude__codex",
          primary: { harness: "claude" },
          reviewer: { harness: "codex" },
        },
        replicate: 1,
        mode: "implementing-paired" as const,
        base_sha: SHA,
      },
    ],
  };
  const runs = [
    {
      cell_id: "pair-exp/f1/claude__codex/1",
      experiment_id: "pair-exp",
      fixture_id: "f1",
      treatment_id: "claude__codex",
      replicate: 1,
      prompt_hash: "p",
      config_hash: "c",
      base_sha: SHA,
      env_surface_hash: "e",
      sandbox_mode: "managed" as const,
      result_class: "completed" as const,
      detail: {
        stages: [{ duration: 3 }],
        pair_id: "claude__codex",
        primary: { harness: "claude", model: "sonnet", effort: null },
        reviewer: { harness: "codex", model: "gpt-5", effort: null },
        fix_invoked: true,
        blocking_findings_before: 2,
        blocking_findings_after: 0,
        malformed_review_count: 1,
      },
    },
  ];
  const grades: GradeRecord[] = [
    {
      cell_id: "pair-exp/f1/claude__codex/1",
      experiment_id: "pair-exp",
      fixture_id: "f1",
      treatment_id: "claude__codex",
      replicate: 1,
      graders: [{ grader: "implementation-fix", version: "1" }],
      payload: {
        kind: "implementation-fix",
        grade: {
          hidden_tests: { passed: 1, total: 1 },
          acceptance: { criteria: [], completed: 0, total: 0 },
          regressions: 0,
          pre_existing_failures: 0,
          out_of_scope_changes: 0,
        },
      },
    },
  ];
  const fixtures = new Map([["f1", makeFixture()]]);
  const summary = generateSummary(manifest, plan, runs, [], grades, fixtures, {
    baselineTreatmentId: "claude__codex",
  });
  assert.equal(summary.treatments.length, 1);
  const t = summary.treatments[0];
  assert.equal(t.treatment_id, "claude__codex");
  assert.ok(t.pair);
  assert.equal(t.pair!.pair_id, "claude__codex");
  assert.equal(t.pair!.fix_invoked_cells, 1);
  assert.equal(t.pair!.blocking_findings_before, 2);
  assert.equal(t.pair!.blocking_findings_after, 0);
  assert.equal(t.pair!.malformed_review_count, 1);
  assert.equal(t.reliability.completion_rate, 1);
  assert.ok(t.mean_duration_sec !== null);
});

test("implementing-paired: unsuccessful harness result is infra_error and does not advance (#601 031e981b)", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  const harnesses: string[] = [];

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff",
    invokeHarness: async (args) => {
      harnesses.push(args.harness);
      if (args.harness === "claude") {
        return {
          success: false,
          timed_out: false,
          exit_code: 1,
          stdout: "",
          stderr: "implementation crashed",
          duration: 0.5,
        };
      }
      return success(approveVerdict([]));
    },
  });

  assert.equal(result.outcome.result_class, "infra_error");
  assert.equal(result.outcome.detail?.failed_role, "primary");
  assert.match(result.outcome.error ?? "", /implementing|exited unsuccessfully/i);
  assert.deepEqual(harnesses, ["claude"], "reviewer must not run after failed primary implementation");
});

test("implementing-paired: unresolved final re-review is not completed (#601 14b9a887)", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  let reviewRound = 0;

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff --git a/x\n+still-broken\n",
    invokeHarness: async (args) => {
      if (args.harness === "claude") return success("impl-or-fix");
      reviewRound += 1;
      // Both reviews remain blocking — final re-review never clears.
      return success(approveVerdict([blockingFinding(`still-open-${reviewRound}`)]));
    },
  });

  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /still has blocking findings|not a completed/i);
  const detail = result.outcome.detail!;
  assert.equal(detail.final_review_disposition, "unresolved_blocking");
  assert.equal(detail.fix_1_invoked, true);
  assert.equal(detail.blocking_findings_after, 1);
  assert.equal(detail.review_1_verdict_parse, "strict");
  assert.equal(detail.re_review_verdict_parse, "strict");
  assert.equal(reviewRound, 2);
});

test("implementing-paired: unparseable final re-review is not completed (#601 14b9a887)", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  let reviewRound = 0;

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff",
    invokeHarness: async (args) => {
      if (args.harness === "claude") return success("impl-or-fix");
      reviewRound += 1;
      if (reviewRound === 1) return success(approveVerdict([blockingFinding()]));
      return success("still not a verdict JSON after fix");
    },
  });

  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /unparseable|not a completed/i);
  const detail = result.outcome.detail!;
  assert.equal(detail.final_review_disposition, "unresolved_unparseable");
  assert.equal(detail.re_review_verdict_parse, "unparseable");
  assert.ok((detail.malformed_review_count as number) >= 1);
  assert.equal(detail.blocking_findings_after, 1);
});

test("pipeline-paired: adversarial blocking count is recorded as post-fix-1 (#601 6d63e02e)", async () => {
  const fixture = makeFixture("planning");
  const manifest = pairedManifest("pipeline-paired");
  const cell = makeCell("pipeline-paired");
  let codexCount = 0;
  let claudeCount = 0;

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff",
    getChangedPaths: async () => ["core/scripts/foo.ts"],
    invokeHarness: async (args) => {
      if (args.harness === "claude") {
        claudeCount += 1;
        if (claudeCount === 1) return success("# Plan");
        return success("work");
      }
      codexCount += 1;
      // plan-review clean, review-1 clean, adversarial (review-2) two blocking findings
      if (codexCount === 1) return success(approveVerdict([]));
      if (codexCount === 2) return success(approveVerdict([]));
      return success(approveVerdict([blockingFinding("a"), blockingFinding("b")]));
    },
  });

  assert.equal(result.outcome.result_class, "completed");
  const detail = result.outcome.detail!;
  assert.equal(detail.fix_1_invoked, false);
  assert.equal(detail.fix_2_invoked, true);
  assert.equal(detail.blocking_findings_after_fix_1, 2);
  assert.equal(detail.blocking_findings_before_fix_2, 2);
  const pairLoop = detail.pair_loop as Record<string, unknown>;
  assert.equal(pairLoop.blocking_after_fix_1, 2);
  assert.equal(pairLoop.blocking_before_fix_2, 2);
  // review-2 findings remain separately labeled
  assert.ok(Array.isArray(detail.review_2_findings));
  assert.equal((detail.review_2_findings as unknown[]).length, 2);
});

test("paired: getDiff failure is infra_error — never empty review body (#601 8c015b1f)", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  const harnesses: string[] = [];

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => {
      throw new Error("maxBuffer exceeded collecting tracked worktree diff");
    },
    invokeHarness: async (args) => {
      harnesses.push(args.harness);
      return success("implemented");
    },
  });

  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /diff|maxBuffer/i);
  assert.deepEqual(harnesses, ["claude"], "reviewer must not run when primary diff collection fails");
});

test("paired: successful phase after wall-clock deadline is timeout not completed (#601 c77be66e)", async () => {
  const fixture = makeFixture();
  const manifest = validateManifest(
    {
      schema_version: 1,
      experiment_id: "pair-exp",
      fixture_ids: ["f1"],
      mode: "implementing-paired",
      treatments: {
        form: "named-pairs",
        pairs: [
          {
            id: "claude__codex",
            primary: { harness: "claude" },
            reviewer: { harness: "codex" },
          },
        ],
      },
      replicates: 1,
      seed: 1,
      concurrency: 1,
      timeout: 1,
      output_dir: ".agent-pipeline/evals",
    },
    new Set(["f1"]),
  );
  const cell = makeCell();
  let call = 0;
  const seenTimeouts: number[] = [];

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    getDiff: async () => "diff --git a/x\n+ok\n",
    invokeHarness: async (args) => {
      call += 1;
      seenTimeouts.push(args.timeoutSec);
      if (call === 1) {
        // Burn most of the 1s cell budget; leave a sub-second remainder.
        await new Promise((r) => setTimeout(r, 700));
        return success("implemented");
      }
      // Injected harness ignores timeoutSec and finishes after the absolute
      // cell deadline while reporting success — the loop must still timeout.
      await new Promise((r) => setTimeout(r, 400));
      return success(approveVerdict([]));
    },
  });

  assert.equal(result.outcome.result_class, "timeout");
  assert.match(result.outcome.error ?? "", /deadline|timeout/i);
  // Sub-second remainder must not be rounded up to a full 1s overrun allowance.
  assert.equal(seenTimeouts.length, 2);
  assert.ok(
    seenTimeouts[1]! < 1,
    `remaining budget must not ceil to 1s, got timeoutSec=${seenTimeouts[1]}`,
  );
  assert.ok(seenTimeouts[1]! > 0, "remaining budget before second invoke must be positive");
  // Failed terminal path still carries pair diagnostics.
  const detail = result.outcome.detail!;
  assert.equal(detail.pair_id, "claude__codex");
  assert.ok(Array.isArray(detail.stages));
  assert.ok((detail.stages as unknown[]).length >= 1);
});

test("paired: failed cell retains accumulated pair-loop diagnostics (#601 36a6a954)", async () => {
  const fixture = makeFixture();
  const manifest = pairedManifest();
  const cell = makeCell();
  const harnesses: string[] = [];

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, {
    createWorktree: async () => ({ path: "/fake/wt", branch: "b" }),
    removeWorktree: async () => {},
    preflight: async (harness) => {
      if (harness === "codex") {
        return { ok: false, failure: "unauthenticated", message: "codex auth missing" };
      }
      return { ok: true };
    },
    getDiff: async () => "diff --git a/core/scripts/foo.ts\n+ok\n",
    invokeHarness: async (args) => {
      harnesses.push(args.harness);
      return success("implemented");
    },
  });

  assert.equal(result.outcome.result_class, "auth_error");
  assert.deepEqual(harnesses, ["claude"]);
  const detail = result.outcome.detail!;
  assert.equal(detail.failed_role, "reviewer");
  assert.equal(detail.pair_id, "claude__codex");
  assert.deepEqual(detail.primary, { harness: "claude", model: "sonnet", effort: null });
  // Reviewer effort falls through from pipeline.yml structured settings when the pair omits it.
  assert.deepEqual(detail.reviewer, { harness: "codex", model: "gpt-5", effort: "xhigh" });
  assert.equal(detail.fix_1_invoked, false);
  assert.equal(detail.fix_2_invoked, false);
  assert.equal(detail.malformed_review_count, 0);
  assert.ok(Array.isArray(detail.stages), "phaseDetails must be present on failed cells");
  assert.equal((detail.stages as { phase: string }[]).length, 1);
  assert.equal((detail.stages as { phase: string }[])[0]!.phase, "implementing");
  assert.ok(detail.pair_loop);
  assert.equal((detail.pair_loop as { mode: string }).mode, "implementing-paired");
  assert.equal(typeof detail.duration_sec, "number");
});

test("collectPairedWorktreeDiff: includes >50 untracked files and fails closed on size (#601 8c015b1f)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { collectPairedWorktreeDiff, PAIRED_DIFF_MAX_BYTES } = await import(
    "../scripts/evals/executor.ts"
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paired-diff-"));
  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "eval@test"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "eval"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "tracked.txt"), "base\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: dir });
    const { stdout: baseSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
    const sha = baseSha.trim();

    // 60 untracked files — old code only included the first 50.
    for (let i = 0; i < 60; i++) {
      const name = `untracked-${String(i).padStart(3, "0")}.txt`;
      fs.writeFileSync(path.join(dir, name), `content-${i}\n`);
    }
    // One late untracked source file that must not be dropped.
    fs.writeFileSync(path.join(dir, "core-scripts-foo.ts"), "export const x = 1;\n");

    const diff = await collectPairedWorktreeDiff({ worktreeDir: dir, baseSha: sha });
    assert.match(diff, /untracked-000\.txt/);
    assert.match(diff, /untracked-059\.txt/, "must include untracked files past the old 50-file cap");
    assert.match(diff, /core-scripts-foo\.ts/, "late untracked source must be included");

    // Size-limit fail-closed: a huge *text* untracked file makes the unified
    // diff exceed PAIRED_DIFF_MAX_BYTES (binary files only emit a short marker).
    const huge = path.join(dir, "huge.txt");
    const line = "x".repeat(1024) + "\n"; // 1 KiB line
    const fd = fs.openSync(huge, "w");
    try {
      // ~21 MiB of text → unified diff body exceeds 20 MiB cap.
      const lines = Math.ceil((PAIRED_DIFF_MAX_BYTES + 1024 * 1024) / line.length);
      for (let i = 0; i < lines; i++) fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
    await assert.rejects(
      () => collectPairedWorktreeDiff({ worktreeDir: dir, baseSha: sha }),
      /exceeds .* byte limit|complete reviewable diff|maxBuffer|ENOBUFS/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture allows generator-owned plugin/ paths in allowed_change_paths", () => {
  const fixture = validateFixture(
    {
      fixture_id: "plugin-ok",
      schema_version: 1,
      base_commit: SHA,
      task_input: "edit core and mirror",
      stage_entry_artifacts: { implementing: {} },
      public_checks: [],
      grader_refs: [{ grader: "implementation-fix", version: "1" }],
      category: "c",
      risk: "low",
      provenance: "synthetic",
      allowed_change_paths: [
        "core/scripts/foo.ts",
        "plugin/skills/pipeline/core/scripts/foo.ts",
      ],
    },
    "plugin-ok.json",
  );
  assert.ok(fixture.allowed_change_paths!.some((p) => p.startsWith("plugin/")));

  // Unlisted plugin path is out of scope when boundary is declared.
  const grade = gradeImplementationFix(
    fixture,
    {},
    {},
    ["plugin/skills/pipeline/core/scripts/other.ts"],
  );
  assert.ok(grade.out_of_scope_changes >= 1);
});

test("graderIdForMode maps paired modes to implementation-fix", async () => {
  const { graderIdForMode } = await import("../scripts/evals/grading/grade.ts");
  assert.equal(graderIdForMode("implementing-paired"), "implementation-fix");
  assert.equal(graderIdForMode("pipeline-paired"), "implementation-fix");
});
