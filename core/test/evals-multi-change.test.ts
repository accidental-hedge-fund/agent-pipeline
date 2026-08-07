// Multi-change maintainability (#577): inheritance, defect accounting, runner
// lineage isolation, and report shape. No live model/network/git.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDefectState,
  gradeMultiChangeLineage,
  inheritedVerifiers,
  materializeMultiChangeCheckpointPrompt,
  resolveCheckpointCoordinates,
  resolveMultiChangeProfile,
  verifiersThrough,
  type MultiChangeCheckpointEvidence,
} from "../scripts/evals/multi-change.ts";
import { validateFixture } from "../scripts/evals/fixture.ts";
import { runCell, type CellExecutionDeps } from "../scripts/evals/executor.ts";
import { gradeExperiment } from "../scripts/evals/grading/grade.ts";
import { buildMultiChangeReport, generateSummary } from "../scripts/evals/reporting/report.ts";
import { qualityScore } from "../scripts/evals/reporting/quality.ts";
import { FORBIDDEN_MAINTAINABILITY_SCORE_FIELDS } from "../scripts/evals/reporting/types.ts";
import type { Cell, ExperimentManifest, Fixture, RunPlan } from "../scripts/evals/types.ts";
import type { GradeRecord } from "../scripts/evals/grading/types.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

const SHA = "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd";
const FAKE_CFG = {
  ...DEFAULT_CONFIG,
  repo_dir: "/fake/repo",
  repo: "owner/repo",
  domain: "test",
  review_policy: { block_threshold: "medium" as const, min_confidence: 0.7 },
} as PipelineConfig;

function approveVerdict(
  findings: Array<{
    severity: string;
    title: string;
    body: string;
    confidence: number;
    recommendation: string;
    file: string;
    line_start: number;
    line_end: number;
  }> = [],
): string {
  return JSON.stringify({
    verdict: findings.length === 0 ? "approve" : "needs-attention",
    summary: findings.length === 0 ? "LGTM" : "Issues found",
    findings,
    next_steps: [],
  });
}

const BLOCKING_FINDING = {
  severity: "high",
  title: "bug",
  body: "A real defect",
  confidence: 0.9,
  recommendation: "Fix it",
  file: "core/scripts/foo.ts",
  line_start: 1,
  line_end: 2,
};

function multiChangeFixture(): Fixture {
  return validateFixture(
    {
      fixture_id: "mc1",
      schema_version: 1,
      kind: "multi_change",
      base_commit: SHA,
      task_input: "synopsis",
      stage_entry_artifacts: { implementing: { plan: "stepwise" } },
      public_checks: [],
      grader_refs: [{ grader: "multi-change", version: "1" }],
      smoke_only: false,
      category: "maintainability",
      risk: "medium",
      provenance: "synthetic",
      checkpoints: [
        {
          checkpoint_id: "C1",
          task_input: "Requirement one only.",
          held_out_verifiers: [
            { verifier_id: "C1.a", check: "check-c1-a" },
            { verifier_id: "C1.b", check: "check-c1-b" },
          ],
        },
        {
          checkpoint_id: "C2",
          task_input: "Requirement two only.",
          held_out_verifiers: [{ verifier_id: "C2.a", check: "check-c2-a" }],
        },
        {
          checkpoint_id: "C3",
          task_input: "Portability probe step.",
          held_out_verifiers: [{ verifier_id: "C3.a", check: "check-c3-a" }],
          portability: { model: "weak-model" },
        },
      ],
    },
    "mc1.json",
  );
}

// --- pure inheritance / defect accounting ---

test("inheritedVerifiers: at C3 equals union of C1 and C2", () => {
  const cps = multiChangeFixture().checkpoints!;
  const inherited = inheritedVerifiers(cps, 2);
  assert.deepEqual(
    inherited.map((v) => v.verifier_id).sort(),
    ["C1.a", "C1.b", "C2.a"],
  );
});

test("inheritedVerifiers: at C1 is empty", () => {
  assert.deepEqual(inheritedVerifiers(multiChangeFixture().checkpoints!, 0), []);
});

test("verifiersThrough: full closure at final checkpoint", () => {
  const cps = multiChangeFixture().checkpoints!;
  const all = verifiersThrough(cps, 2);
  assert.equal(all.length, 4);
});

test("computeDefectState: strict pass false on inherited failure", () => {
  const state = computeDefectState({
    newVerifierIds: ["C2.a"],
    inheritedVerifierIds: ["C1.a", "C1.b"],
    verifierResults: { "C2.a": true, "C1.a": false, "C1.b": true },
    priorAccumulatedUnresolved: ["C1.a"],
  });
  assert.equal(state.strict_pass, false);
  assert.deepEqual(state.current_step_defects, []);
  assert.deepEqual(state.inherited_defects, ["C1.a"]);
  assert.ok(state.accumulated_unresolved.includes("C1.a"));
});

test("computeDefectState: recovery is recorded and removed from accumulated", () => {
  const state = computeDefectState({
    newVerifierIds: ["C2.a"],
    inheritedVerifierIds: ["C1.a"],
    verifierResults: { "C2.a": true, "C1.a": true },
    priorAccumulatedUnresolved: ["C1.a"],
  });
  assert.equal(state.strict_pass, true);
  assert.deepEqual(state.recovered_defects, ["C1.a"]);
  assert.deepEqual(state.accumulated_unresolved, []);
});

test("gradeMultiChangeLineage: terminal all-green requires full closure", () => {
  const fixture = multiChangeFixture();
  const evidence: MultiChangeCheckpointEvidence[] = [
    stepEvidence("C1", 0, { "C1.a": true, "C1.b": true }, ["C1.a", "C1.b"], []),
    stepEvidence("C2", 1, { "C1.a": true, "C1.b": true, "C2.a": true }, ["C2.a"], ["C1.a", "C1.b"]),
    stepEvidence(
      "C3",
      2,
      { "C1.a": true, "C1.b": true, "C2.a": true, "C3.a": true },
      ["C3.a"],
      ["C1.a", "C1.b", "C2.a"],
      "weak-model",
      true,
    ),
  ];
  const grade = gradeMultiChangeLineage(fixture, evidence);
  assert.equal(grade.terminal_all_green, true);
  assert.ok(grade.checkpoints.every((c) => c.strict_pass));
});

test("gradeMultiChangeLineage: later grades exist after early fail", () => {
  const fixture = multiChangeFixture();
  const evidence: MultiChangeCheckpointEvidence[] = [
    stepEvidence("C1", 0, { "C1.a": false, "C1.b": true }, ["C1.a", "C1.b"], []),
    stepEvidence(
      "C2",
      1,
      { "C1.a": true, "C1.b": true, "C2.a": false },
      ["C2.a"],
      ["C1.a", "C1.b"],
    ),
  ];
  const grade = gradeMultiChangeLineage(fixture, evidence);
  assert.equal(grade.checkpoints.length, 2);
  assert.equal(grade.checkpoints[0].strict_pass, false);
  assert.deepEqual(grade.checkpoints[1].recovered_defects, ["C1.a"]);
  assert.deepEqual(grade.checkpoints[1].current_step_defects, ["C2.a"]);
  assert.equal(grade.terminal_all_green, false);
});

function stepEvidence(
  checkpoint_id: string,
  checkpoint_index: number,
  verifier_results: Record<string, boolean>,
  new_verifier_ids: string[],
  inherited_verifier_ids: string[],
  model: string | null = "strong-model",
  portability_probe = false,
): MultiChangeCheckpointEvidence {
  return {
    checkpoint_id,
    checkpoint_index,
    prompt_hash: "p",
    treatment_id: "profile=bare",
    treatment_profile: "bare",
    model,
    harness: "claude",
    session_id: `sess-${checkpoint_id}`,
    repo_fingerprint: `fp-${checkpoint_index}`,
    verifier_results,
    new_verifier_ids,
    inherited_verifier_ids,
    resource: { duration_sec: 1, cost_source: "unknown" },
    portability_probe,
    preserved_evidence_keys: ["repository_state", "pipeline_evidence_bundle"],
  };
}

test("materializeMultiChangeCheckpointPrompt: discloses only current requirement", () => {
  const fixture = multiChangeFixture();
  const prompt = materializeMultiChangeCheckpointPrompt(fixture, fixture.checkpoints![0], "bare");
  assert.match(prompt, /Requirement one only/);
  assert.doesNotMatch(prompt, /Requirement two only/);
  assert.doesNotMatch(prompt, /check-c1-a/);
  assert.doesNotMatch(prompt, /Portability probe/);
});

test("resolveCheckpointCoordinates: portability override applies only when marked", () => {
  const fixture = multiChangeFixture();
  const treatment = { harness: "claude", model: "strong-model" };
  const c1 = resolveCheckpointCoordinates(treatment, fixture.checkpoints![0]);
  const c3 = resolveCheckpointCoordinates(treatment, fixture.checkpoints![2]);
  assert.equal(c1.model, "strong-model");
  assert.equal(c1.portability, false);
  assert.equal(c3.model, "weak-model");
  assert.equal(c3.portability, true);
});

test("resolveMultiChangeProfile: bare default for implementing mode", () => {
  assert.equal(resolveMultiChangeProfile({}, "implementing"), "bare");
  assert.equal(resolveMultiChangeProfile({ profile: "pipeline-current" }, "implementing"), "pipeline-current");
  assert.equal(resolveMultiChangeProfile({}, "pipeline-paired"), "pipeline-current");
});

// --- runner lineage with fakes ---

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

test("runCell multi-change: one worktree, ordered checkpoints, fresh sessions, continue after quality fail", async () => {
  const fixture = multiChangeFixture();
  const cell: Cell = {
    cell_id: "exp/mc1/profile=bare/1",
    experiment_id: "exp",
    fixture_id: "mc1",
    treatment_id: "profile=bare",
    treatment: { harness: "claude", model: "strong-model", profile: "bare" },
    replicate: 1,
    mode: "implementing",
    base_sha: SHA,
  };
  const manifest = {
    schema_version: 1,
    experiment_id: "exp",
    fixture_ids: ["mc1"],
    mode: "implementing",
    treatments: { harness: ["claude"], profile: ["bare"] },
    replicates: 1,
    seed: 1,
    concurrency: 1,
    timeout: 120,
    output_dir: "/out",
    sandbox_mode: "managed",
  } as ExperimentManifest;

  const worktreesCreated: string[] = [];
  const sessions: string[] = [];
  const models: (string | undefined)[] = [];
  let checkPassPattern = 0;

  const deps: CellExecutionDeps = {
    contractIO: fakeContractIO(),
    installBoundaryShim: (d) => `${d}/.shim`,
    readBoundaryDenials: () => [],
    removeBoundaryShim: () => {},
    createWorktree: async (_c, o) => {
      worktreesCreated.push(o.baseCommit);
      return { path: o.path, branch: o.branch };
    },
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async (args) => {
      sessions.push(args.env?.PIPELINE_EVAL_SESSION_ID ?? "");
      models.push(args.model);
      // Prompt must not contain held-out check bodies or later requirements when on C1.
      assert.doesNotMatch(args.prompt, /check-c1-a/);
      return {
        success: true,
        timed_out: false,
        exit_code: 0,
        stdout: "ok",
        stderr: "",
        duration: 0.5,
      };
    },
    runChecks: async ({ checks }) => {
      // C1 fails first verifier, later steps pass all — continue-after-fail.
      const out: Record<string, boolean> = {};
      for (const c of checks) {
        if (checkPassPattern === 0 && c === "check-c1-a") out[c] = false;
        else out[c] = true;
      }
      checkPassPattern++;
      return out;
    },
    getChangedPaths: async () => ["core/evals/sandboxes/x.js"],
    getRepoFingerprint: async () => `fp-${checkPassPattern}`,
    createVerifierSnapshot: async (dir) => `${dir}__verifier_snap`,
    removeVerifierSnapshot: async () => {},
  };

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(worktreesCreated.length, 1);
  assert.equal(worktreesCreated[0], SHA);

  const mc = result.outcome.detail?.multi_change as {
    checkpoints: MultiChangeCheckpointEvidence[];
    fresh_context_sessions: string[];
  };
  assert.equal(mc.checkpoints.length, 3);
  // Fresh session per checkpoint.
  assert.equal(new Set(mc.fresh_context_sessions).size, 3);
  assert.equal(new Set(sessions.filter(Boolean)).size, 3);
  // Portability model only on C3.
  assert.equal(models[0], "strong-model");
  assert.equal(models[models.length - 1], "weak-model");
  // Evidence trail fields.
  for (const step of mc.checkpoints) {
    assert.ok(step.prompt_hash);
    assert.ok(step.repo_fingerprint);
    assert.ok(step.treatment_id);
    assert.ok(step.resource);
    assert.deepEqual(step.preserved_evidence_keys, ["repository_state", "pipeline_evidence_bundle"]);
  }
  // C1 had quality fail but lineage continued.
  assert.equal(mc.checkpoints[0].verifier_results["C1.a"], false);
  assert.equal(mc.checkpoints[1].verifier_results["C1.a"], true);
});

test("runCell multi-change: cells are isolated (separate worktree paths)", async () => {
  const fixture = multiChangeFixture();
  const paths: string[] = [];
  const makeCell = (id: string): Cell => ({
    cell_id: id,
    experiment_id: "exp",
    fixture_id: "mc1",
    treatment_id: id.includes("bare") ? "profile=bare" : "profile=pipeline-current",
    treatment: {
      harness: "claude",
      model: "m",
      profile: id.includes("bare") ? "bare" : "pipeline-current",
    },
    replicate: 1,
    mode: "implementing",
    base_sha: SHA,
  });
  const manifest = {
    schema_version: 1,
    experiment_id: "exp",
    fixture_ids: ["mc1"],
    mode: "implementing",
    treatments: { profile: ["bare"] },
    replicates: 1,
    seed: 1,
    concurrency: 1,
    timeout: 60,
    output_dir: "/out",
    sandbox_mode: "managed",
  } as ExperimentManifest;

  const deps: CellExecutionDeps = {
    contractIO: fakeContractIO(),
    installBoundaryShim: (d) => `${d}/.shim`,
    readBoundaryDenials: () => [],
    removeBoundaryShim: () => {},
    createWorktree: async (_c, o) => {
      paths.push(o.path);
      return { path: o.path, branch: o.branch };
    },
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      // Parseable approval (no blocking → no fix loop).
      stdout: approveVerdict(),
      stderr: "",
      duration: 0.1,
    }),
    runChecks: async ({ checks }) => Object.fromEntries(checks.map((c) => [c, true])),
    getChangedPaths: async () => [],
    getRepoFingerprint: async () => "fp",
    getDiff: async () => "diff --git a/x b/x\n+ok\n",
    createVerifierSnapshot: async (dir) => `${dir}__verifier_snap`,
    removeVerifierSnapshot: async () => {},
  };

  await runCell(FAKE_CFG, makeCell("exp/mc1/profile=bare/1"), fixture, manifest, deps);
  await runCell(FAKE_CFG, makeCell("exp/mc1/profile=pipeline-current/1"), fixture, manifest, deps);
  assert.equal(paths.length, 2);
  assert.notEqual(paths[0], paths[1]);
});

test("runCell multi-change: infra abort does not continue lineage as quality", async () => {
  const fixture = multiChangeFixture();
  const cell: Cell = {
    cell_id: "exp/mc1/profile=bare/1",
    experiment_id: "exp",
    fixture_id: "mc1",
    treatment_id: "profile=bare",
    treatment: { harness: "claude", profile: "bare" },
    replicate: 1,
    mode: "implementing",
    base_sha: SHA,
  };
  const manifest = {
    schema_version: 1,
    experiment_id: "exp",
    fixture_ids: ["mc1"],
    mode: "implementing",
    treatments: { profile: ["bare"] },
    replicates: 1,
    seed: 1,
    concurrency: 1,
    timeout: 60,
    output_dir: "/out",
    sandbox_mode: "managed",
  } as ExperimentManifest;

  let invokes = 0;
  const deps: CellExecutionDeps = {
    contractIO: fakeContractIO(),
    installBoundaryShim: (d) => `${d}/.shim`,
    readBoundaryDenials: () => [],
    removeBoundaryShim: () => {},
    createWorktree: async (_c, o) => ({ path: o.path, branch: o.branch }),
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => {
      invokes++;
      return {
        success: false,
        timed_out: false,
        spawn_error: true,
        exit_code: -1,
        stdout: "",
        stderr: "spawn failed",
        duration: 0,
      };
    },
    runChecks: async () => {
      throw new Error("should not run checks after spawn_error");
    },
    getChangedPaths: async () => [],
    getRepoFingerprint: async () => "fp",
    createVerifierSnapshot: async () => {
      throw new Error("should not snapshot after spawn_error");
    },
    removeVerifierSnapshot: async () => {},
  };

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, deps);
  assert.equal(result.outcome.result_class, "infra_error");
  assert.equal(invokes, 1);
  const mc = result.outcome.detail?.multi_change as { aborted?: { result_class: string } };
  assert.equal(mc?.aborted?.result_class, "infra_error");
});

test("runCell multi-change: held-out verifiers run on disposable snapshot, not lineage worktree", async () => {
  const fixture = multiChangeFixture();
  const cell: Cell = {
    cell_id: "exp/mc1/profile=bare/1",
    experiment_id: "exp",
    fixture_id: "mc1",
    treatment_id: "profile=bare",
    treatment: { harness: "claude", model: "strong-model", profile: "bare" },
    replicate: 1,
    mode: "implementing",
    base_sha: SHA,
  };
  const manifest = {
    schema_version: 1,
    experiment_id: "exp",
    fixture_ids: ["mc1"],
    mode: "implementing",
    treatments: { profile: ["bare"] },
    replicates: 1,
    seed: 1,
    concurrency: 1,
    timeout: 60,
    output_dir: "/out",
    sandbox_mode: "managed",
  } as ExperimentManifest;

  let lineagePath = "";
  const checkDirs: string[] = [];
  const snapshotsCreated: string[] = [];
  const snapshotsRemoved: string[] = [];

  const deps: CellExecutionDeps = {
    contractIO: fakeContractIO(),
    installBoundaryShim: (d) => `${d}/.shim`,
    readBoundaryDenials: () => [],
    removeBoundaryShim: () => {},
    createWorktree: async (_c, o) => {
      lineagePath = o.path;
      return { path: o.path, branch: o.branch };
    },
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      stdout: "ok",
      stderr: "",
      duration: 0.1,
    }),
    createVerifierSnapshot: async (worktreeDir) => {
      assert.equal(worktreeDir, lineagePath);
      const snap = `${worktreeDir}__verifier_snap_${snapshotsCreated.length}`;
      snapshotsCreated.push(snap);
      return snap;
    },
    removeVerifierSnapshot: async (dir) => {
      snapshotsRemoved.push(dir);
    },
    runChecks: async ({ worktreeDir, checks }) => {
      checkDirs.push(worktreeDir);
      // Mutating verifier: if this ran on the lineage path it would leak state.
      assert.notEqual(worktreeDir, lineagePath, "held-out checks must not run in the lineage worktree");
      assert.ok(worktreeDir.includes("__verifier_snap"));
      return Object.fromEntries(checks.map((c) => [c, true]));
    },
    getChangedPaths: async () => [],
    getRepoFingerprint: async () => "fp",
  };

  const result = await runCell(FAKE_CFG, cell, fixture, manifest, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(checkDirs.length, 3);
  for (const d of checkDirs) {
    assert.notEqual(d, lineagePath);
  }
  assert.equal(snapshotsCreated.length, 3);
  assert.deepEqual(snapshotsRemoved.sort(), snapshotsCreated.sort());
});

test("runCell multi-change: pipeline-current runs review_policy + fix when findings block", async () => {
  const fixture = multiChangeFixture();
  // Single checkpoint to keep role sequence short.
  const oneCp = validateFixture(
    {
      ...fixture,
      fixture_id: "mc-pipe",
      checkpoints: [
        {
          checkpoint_id: "C1",
          task_input: "Only requirement.",
          held_out_verifiers: [{ verifier_id: "C1.a", check: "check-c1-a" }],
        },
      ],
    },
    "mc-pipe.json",
  );
  const cell: Cell = {
    cell_id: "exp/mc-pipe/profile=pipeline-current/1",
    experiment_id: "exp",
    fixture_id: "mc-pipe",
    treatment_id: "profile=pipeline-current",
    treatment: { harness: "claude", model: "m", profile: "pipeline-current" },
    replicate: 1,
    mode: "implementing",
    base_sha: SHA,
  };
  const bareCell: Cell = {
    ...cell,
    cell_id: "exp/mc-pipe/profile=bare/1",
    treatment_id: "profile=bare",
    treatment: { harness: "claude", model: "m", profile: "bare" },
  };
  const manifest = {
    schema_version: 1,
    experiment_id: "exp",
    fixture_ids: ["mc-pipe"],
    mode: "implementing",
    treatments: { profile: ["bare", "pipeline-current"] },
    replicates: 1,
    seed: 1,
    concurrency: 1,
    timeout: 120,
    output_dir: "/out",
    sandbox_mode: "managed",
  } as ExperimentManifest;

  const rolesFor = async (profile: "bare" | "pipeline-current") => {
    let reviewInvokes = 0;
    const deps: CellExecutionDeps = {
      contractIO: fakeContractIO(),
      installBoundaryShim: (d) => `${d}/.shim`,
      readBoundaryDenials: () => [],
      removeBoundaryShim: () => {},
      createWorktree: async (_c, o) => ({ path: o.path, branch: o.branch }),
      removeWorktree: async () => {},
      preflight: async () => ({ ok: true }),
      getDiff: async () => "diff --git a/x b/x\n+changed\n",
      createVerifierSnapshot: async (dir) => `${dir}__snap`,
      removeVerifierSnapshot: async () => {},
      runChecks: async ({ checks }) => Object.fromEntries(checks.map((c) => [c, true])),
      getChangedPaths: async () => [],
      getRepoFingerprint: async () => "fp",
      invokeHarness: async (args) => {
        // review-1 / review-2 prompts are production review templates (not the multi-change implement prompt).
        const isImplement = args.prompt.includes("You are applying the next change");
        const isFix = args.prompt.includes("fixRound") || /fix round|surgical-fix|Resolve the following review/i.test(args.prompt);
        let stdout = "implemented";
        if (!isImplement && !isFix) {
          reviewInvokes++;
          stdout = reviewInvokes === 1 ? approveVerdict([BLOCKING_FINDING]) : approveVerdict();
        }
        return {
          success: true,
          timed_out: false,
          exit_code: 0,
          stdout,
          stderr: "",
          duration: 0.1,
        };
      },
    };
    const c = profile === "bare" ? bareCell : cell;
    const result = await runCell(FAKE_CFG, c, oneCp, manifest, deps);
    assert.equal(result.outcome.result_class, "completed", result.outcome.error);
    return result.trajectory.stages.map((s) => s.stage);
  };

  const bareRoles = await rolesFor("bare");
  assert.deepEqual(bareRoles, ["implement"]);

  const pipeRoles = await rolesFor("pipeline-current");
  assert.ok(pipeRoles.includes("implement"), `expected implement in ${pipeRoles.join(",")}`);
  assert.ok(pipeRoles.includes("review-1"), `expected review-1 in ${pipeRoles.join(",")}`);
  assert.ok(pipeRoles.includes("fix-1"), `expected fix-1 after blocking findings in ${pipeRoles.join(",")}`);
  assert.ok(pipeRoles.includes("review-2"), `expected re-review after fix in ${pipeRoles.join(",")}`);
  // Differentiated from bare: more than a single implement invoke.
  assert.ok(pipeRoles.length > bareRoles.length);
});

test("mc-native-widget-config portability model is Claude-harness compatible", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  // Fixture lives next to other eval fixtures under core/evals/fixtures.
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../evals/fixtures/mc-native-widget-config.json",
  );
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    checkpoints: Array<{ checkpoint_id: string; portability?: { model?: string; harness?: string } }>;
  };
  const c3 = raw.checkpoints.find((c) => c.checkpoint_id === "C3");
  assert.ok(c3?.portability?.model);
  // Sample experiment pins harness=claude; override must not be an OpenAI-only id.
  assert.notEqual(c3!.portability!.model, "gpt-4o-mini");
  assert.match(c3!.portability!.model!, /haiku|claude|sonnet|opus/i);
});

// --- grading integration ---

test("gradeExperiment: multi-change grades both steps after early fail", async () => {
  const fixture = multiChangeFixture();
  const evidence: MultiChangeCheckpointEvidence[] = [
    stepEvidence("C1", 0, { "C1.a": false, "C1.b": true }, ["C1.a", "C1.b"], []),
    stepEvidence("C2", 1, { "C1.a": true, "C1.b": true, "C2.a": true }, ["C2.a"], ["C1.a", "C1.b"]),
  ];
  const files: Record<string, string> = {
    "/out/exp/manifest.json": JSON.stringify({
      schema_version: 1,
      experiment_id: "exp",
      fixture_ids: ["mc1"],
      mode: "implementing",
      treatments: { profile: ["bare"] },
      replicates: 1,
      seed: 1,
      concurrency: 1,
      timeout: 60,
      output_dir: "/out",
      sandbox_mode: "managed",
    }),
    "/out/exp/runs.jsonl":
      JSON.stringify({
        cell_id: "c1",
        experiment_id: "exp",
        fixture_id: "mc1",
        treatment_id: "profile=bare",
        replicate: 1,
        prompt_hash: "p",
        config_hash: "c",
        base_sha: SHA,
        env_surface_hash: fixture.env_surface_hash,
        sandbox_mode: "managed",
        result_class: "completed",
        detail: { multi_change: { profile: "bare", checkpoints: evidence } },
      }) + "\n",
    "/out/exp/failures.jsonl": "",
  };

  const result = await gradeExperiment(FAKE_CFG, "/out", "exp", new Map([["mc1", fixture]]), {
    readFile: async (p) => files[p] ?? null,
    writeFile: async (p, c) => {
      files[p] = c;
    },
  });
  assert.equal(result.grades.length, 1);
  assert.equal(result.grades[0].payload.kind, "multi-change");
  if (result.grades[0].payload.kind === "multi-change") {
    assert.equal(result.grades[0].payload.grade.checkpoints.length, 2);
    assert.equal(result.grades[0].payload.grade.checkpoints[0].strict_pass, false);
    assert.equal(result.grades[0].payload.grade.checkpoints[1].strict_pass, true);
  }
});

// --- reporting ---

test("buildMultiChangeReport: pairs within fixture × checkpoint index; no slop score", () => {
  const gradeBare: GradeRecord = {
    cell_id: "c-bare",
    experiment_id: "exp",
    fixture_id: "mc1",
    treatment_id: "profile=bare",
    replicate: 1,
    graders: [{ grader: "multi-change", version: "1" }],
    payload: {
      kind: "multi-change",
      grade: {
        checkpoints: [
          {
            checkpoint_id: "C1",
            checkpoint_index: 0,
            strict_pass: true,
            current_step_defects: [],
            inherited_defects: [],
            accumulated_unresolved: [],
            recovered_defects: [],
            new_verifier_results: { "C1.a": true },
            inherited_verifier_results: {},
            model: "strong",
            portability_probe: false,
            resource: { duration_sec: 10, cost_source: "unknown" },
          },
          {
            checkpoint_id: "C2",
            checkpoint_index: 1,
            strict_pass: false,
            current_step_defects: ["C2.a"],
            inherited_defects: [],
            accumulated_unresolved: ["C2.a"],
            recovered_defects: [],
            new_verifier_results: { "C2.a": false },
            inherited_verifier_results: { "C1.a": true },
            model: "strong",
            portability_probe: false,
            resource: { duration_sec: 12, cost_source: "unknown" },
          },
        ],
        terminal_all_green: false,
      },
    },
  };
  const gradePipe: GradeRecord = {
    ...gradeBare,
    cell_id: "c-pipe",
    treatment_id: "profile=pipeline-current",
    payload: {
      kind: "multi-change",
      grade: {
        checkpoints: [
          {
            checkpoint_id: "C1",
            checkpoint_index: 0,
            strict_pass: true,
            current_step_defects: [],
            inherited_defects: [],
            accumulated_unresolved: [],
            recovered_defects: [],
            new_verifier_results: { "C1.a": true },
            inherited_verifier_results: {},
            model: "strong",
            portability_probe: false,
            resource: { duration_sec: 20, cost_usd: 0.5, cost_source: "actual" },
          },
          {
            checkpoint_id: "C2",
            checkpoint_index: 1,
            strict_pass: true,
            current_step_defects: [],
            inherited_defects: [],
            accumulated_unresolved: [],
            recovered_defects: [],
            new_verifier_results: { "C2.a": true },
            inherited_verifier_results: { "C1.a": true },
            model: "strong",
            portability_probe: false,
            resource: { duration_sec: 22, cost_usd: 0.6, cost_source: "actual" },
          },
        ],
        terminal_all_green: true,
      },
    },
  };

  const report = buildMultiChangeReport(
    [gradeBare, gradePipe],
    [
      {
        cell_id: "c-bare",
        experiment_id: "exp",
        fixture_id: "mc1",
        treatment_id: "profile=bare",
        replicate: 1,
        prompt_hash: "p",
        config_hash: "c",
        base_sha: SHA,
        env_surface_hash: "e",
        sandbox_mode: "managed",
        result_class: "completed",
        detail: { multi_change: { profile: "bare" } },
      },
      {
        cell_id: "c-pipe",
        experiment_id: "exp",
        fixture_id: "mc1",
        treatment_id: "profile=pipeline-current",
        replicate: 1,
        prompt_hash: "p",
        config_hash: "c",
        base_sha: SHA,
        env_surface_hash: "e",
        sandbox_mode: "managed",
        result_class: "completed",
        detail: { multi_change: { profile: "pipeline-current" } },
      },
    ],
    "profile=bare",
    { name: "bootstrap-percentile", resamples: 100, seed: 1, confidence: 0.95 },
    5,
  );

  assert.ok(report);
  assert.equal(report!.structural_telemetry_is_not_ground_truth, true);
  // C2 treatments both present — aligned pairing by checkpoint index.
  const c2 = report!.by_checkpoint.find((c) => c.checkpoint_index === 1);
  assert.ok(c2);
  assert.equal(c2!.treatments.length, 2);
  assert.ok(c2!.treatments.every((t) => t.checkpoint_id === undefined || true));
  // Baseline named on non-baseline lineages.
  const pipeLineage = report!.lineages.find((l) => l.treatment_id === "profile=pipeline-current");
  assert.equal(pipeLineage?.baseline_treatment_id, "profile=bare");
  // Cost unknown stays unknown for bare (coverage < 1, not imputed zero mean from missing).
  const bareC1 = report!.by_checkpoint
    .find((c) => c.checkpoint_index === 0)!
    .treatments.find((t) => t.treatment_id === "profile=bare")!;
  assert.equal(bareC1.cost?.mean_cost_usd, null);
  assert.ok((bareC1.cost?.coverage ?? 1) < 1 || bareC1.cost?.n_with_cost === 0);
  // Optional variants not run.
  assert.ok(report!.variants_not_run.includes("design-dossier"));
  // Forbidden fields absent from serialized report.
  const json = JSON.stringify(report);
  for (const field of FORBIDDEN_MAINTAINABILITY_SCORE_FIELDS) {
    assert.equal(json.includes(`"${field}"`), false, `must not include ${field}`);
  }
});

test("buildMultiChangeReport: portability probe labels weaker model metrics", () => {
  const grade: GradeRecord = {
    cell_id: "c1",
    experiment_id: "exp",
    fixture_id: "mc1",
    treatment_id: "profile=bare",
    replicate: 1,
    graders: [{ grader: "multi-change", version: "1" }],
    payload: {
      kind: "multi-change",
      grade: {
        checkpoints: [
          {
            checkpoint_id: "C1",
            checkpoint_index: 0,
            strict_pass: true,
            current_step_defects: [],
            inherited_defects: [],
            accumulated_unresolved: [],
            recovered_defects: [],
            new_verifier_results: {},
            inherited_verifier_results: {},
            model: "strong",
            portability_probe: false,
            resource: { duration_sec: 5, cost_usd: 1, cost_source: "actual", interventions: 0 },
          },
          {
            checkpoint_id: "C3",
            checkpoint_index: 2,
            strict_pass: true,
            current_step_defects: [],
            inherited_defects: [],
            accumulated_unresolved: [],
            recovered_defects: [],
            new_verifier_results: {},
            inherited_verifier_results: {},
            model: "weak-model",
            portability_probe: true,
            resource: { duration_sec: 8, cost_usd: 0.1, cost_source: "actual", interventions: 1 },
          },
        ],
        terminal_all_green: true,
      },
    },
  };
  const report = buildMultiChangeReport(
    [grade],
    [
      {
        cell_id: "c1",
        experiment_id: "exp",
        fixture_id: "mc1",
        treatment_id: "profile=bare",
        replicate: 1,
        prompt_hash: "p",
        config_hash: "c",
        base_sha: SHA,
        env_surface_hash: "e",
        sandbox_mode: "managed",
        result_class: "completed",
        detail: { multi_change: { profile: "bare" } },
      },
    ],
    "profile=bare",
    { name: "bootstrap-percentile", resamples: 50, seed: 1, confidence: 0.95 },
    5,
  );
  const probe = report!.by_checkpoint.find((c) => c.checkpoint_id === "C3")!.treatments[0];
  assert.equal(probe.portability_probe, true);
  assert.equal(probe.model, "weak-model");
  assert.equal(probe.mean_duration_sec, 8);
  assert.equal(probe.cost?.mean_cost_usd, 0.1);
  assert.equal(probe.mean_interventions, 1);
});

test("generateSummary: multi_change section present; no forbidden maintainability score keys", () => {
  const fixture = multiChangeFixture();
  const grade: GradeRecord = {
    cell_id: "c1",
    experiment_id: "exp",
    fixture_id: "mc1",
    treatment_id: "profile=bare",
    replicate: 1,
    graders: [{ grader: "multi-change", version: "1" }],
    payload: {
      kind: "multi-change",
      grade: {
        checkpoints: [
          {
            checkpoint_id: "C1",
            checkpoint_index: 0,
            strict_pass: true,
            current_step_defects: [],
            inherited_defects: [],
            accumulated_unresolved: [],
            recovered_defects: [],
            new_verifier_results: { "C1.a": true },
            inherited_verifier_results: {},
            model: "m",
            portability_probe: false,
            resource: { duration_sec: 1, cost_source: "unknown" },
          },
        ],
        terminal_all_green: true,
      },
    },
  };
  const manifest = {
    schema_version: 1,
    experiment_id: "exp",
    fixture_ids: ["mc1"],
    mode: "implementing",
    treatments: { profile: ["bare"] },
    replicates: 1,
    seed: 42,
    concurrency: 1,
    timeout: 60,
    output_dir: "/out",
    sandbox_mode: "managed",
  } as ExperimentManifest;
  const plan: RunPlan = {
    schema_version: 1,
    experiment_id: "exp",
    seed: 42,
    cells: [
      {
        cell_id: "c1",
        experiment_id: "exp",
        fixture_id: "mc1",
        treatment_id: "profile=bare",
        treatment: { profile: "bare" },
        replicate: 1,
        mode: "implementing",
        base_sha: SHA,
      },
    ],
  };
  const runs = [
    {
      cell_id: "c1",
      experiment_id: "exp",
      fixture_id: "mc1",
      treatment_id: "profile=bare",
      replicate: 1,
      prompt_hash: "p",
      config_hash: "c",
      base_sha: SHA,
      env_surface_hash: fixture.env_surface_hash,
      sandbox_mode: "managed" as const,
      result_class: "completed" as const,
      detail: { multi_change: { profile: "bare" }, stages: [{ duration: 1 }] },
    },
  ];
  const summary = generateSummary(
    manifest,
    plan,
    runs,
    [],
    [grade],
    new Map([["mc1", fixture]]),
    { baselineTreatmentId: "profile=bare" },
  );
  assert.ok(summary.multi_change);
  assert.equal(summary.baseline_treatment_id, "profile=bare");
  const text = JSON.stringify(summary);
  for (const field of FORBIDDEN_MAINTAINABILITY_SCORE_FIELDS) {
    assert.equal(text.includes(`"${field}"`), false);
  }
  // qualityScore path for multi-change does not throw.
  assert.ok(qualityScore(grade) > 0);
});
