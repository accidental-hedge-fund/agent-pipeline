// Unit tests for doctor harness-smoke orchestration (#780).
// All I/O goes through injectable HarnessSmokeDeps — no real network/git/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PipelineConfig } from "../scripts/types.ts";
import type {
  AdapterPreflightResult,
  HarnessAdapter,
  HarnessTelemetry,
} from "../scripts/harness-adapters/types.ts";
import { EMPTY_TELEMETRY } from "../scripts/harness-adapters/types.ts";
import {
  getStageOutputContract,
  HARNESS_SMOKE_IMPLEMENTER_CONTRACT_ID,
  HARNESS_SMOKE_REVIEWER_CONTRACT_ID,
  validateHarnessSmokeImplementer,
  validateStageOutput,
} from "../scripts/stage-output-contract.ts";
import {
  buildSmokePlan,
  foldSmokeIntoChecks,
  HARNESS_SMOKE_CONTRACT_IDS,
  implementerSmokePrompt,
  reviewerSmokePrompt,
  runHarnessSmoke,
  scratchRepoMutated,
  smokeCheckId,
  treatmentKey,
  type HarnessSmokeDeps,
  type ScratchRepoSnapshot,
  type SmokeInvokeRequest,
  type SmokeInvokeResult,
  type SmokeTreatment,
} from "../scripts/stages/harness-smoke.ts";
import {
  formatDoctorJson,
  type CheckOutcome,
} from "../scripts/stages/doctor.ts";
import {
  runDoctor,
  type CliOpts,
  type PreflightCliDeps,
} from "../scripts/pipeline.ts";
import {
  HARNESS_SMOKE_FAILURE_SCHEMA,
  parseHarnessSmokeFailureArtifact,
  serializeHarnessSmokeFailureArtifact,
  buildHarnessSmokeFailureArtifact,
} from "../scripts/harness-smoke-failure.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    profile_name: "codex",
    invocation: "pipeline",
    review_mode: "prompt-harness",
    marker_footer: "",
    implementation_ready_message: "",
    conventions_default: "CLAUDE.md",
    domain: "smoketest",
    repo: "acme/widget",
    repo_dir: "/repo",
    base_branch: "main",
    worktree_root: ".worktrees",
    max_concurrent_worktrees: 5,
    auto_recovery_max_retries: 2,
    implementation_timeout: 2400,
    review_timeout: 1500,
    fix_timeout: 2400,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: {
      implementer: "codex",
      reviewer: "claude",
      implementerSource: "profile",
      reviewerSource: "profile",
    },
    models: {
      planning: "sonnet",
      implementing: "sonnet",
      review: "opus",
      fix: "sonnet",
      intake: "sonnet",
      sweep: "sonnet",
    },
    effort: {
      planning: "medium",
      implementing: "low",
      review: "high",
      fix: "low",
    },
    plan_review_effort: "medium",
    openspec: { enabled: "off", bootstrap: false },
    last30days: { enabled: false, timeout: 600 },
    steps: {
      plan_review: true,
      standard_review: true,
      adversarial_review: true,
      docs: true,
    },
    test_gate: { enabled: true, max_attempts: 3, timeout: 300 },
    eval_gate: { enabled: false, mode: "gate", timeout: 300, max_attempts: 2 },
    review_policy: {
      block_threshold: "medium",
      min_confidence: 0.7,
      max_adversarial_rounds: 3,
    },
    doctor: { runOnStart: false, failFast: false },
    ...overrides,
  } as PipelineConfig;
}

function fakeAdapter(
  name: string,
  opts: {
    roles?: Array<"implementer" | "reviewer">;
    telemetry?: "none" | "jsonl";
    origin?: "builtin" | "extension" | "compatibility";
  } = {},
): HarnessAdapter {
  const roles = opts.roles ?? (["implementer", "reviewer"] as const);
  const telemetry = opts.telemetry ?? "none";
  return {
    name,
    capabilities: {
      model: true,
      effort: true,
      sandbox: false,
      workingDir: "cwd",
      telemetry,
      maxPromptBytes: "unlimited",
      background_job_lifecycle: { supported: false },
    },
    declaration: {
      roles: [...roles],
      executable: { command: name, resolution: "path" },
      prompt: { delivery: "stdin", sizeLimit: "unlimited" },
      model: { supported: true, validation: "open" },
      effort: { supported: true, validation: "open" },
      sandbox: { supported: false },
      workingDir: "cwd",
      outputEnvelope: telemetry === "jsonl" ? "jsonl" : "text",
      telemetry,
      authProbe: "documented",
      versionProbe: "documented",
      origin: opts.origin ?? "builtin",
      background_job_lifecycle: { supported: false },
    },
    buildInvocation: () => ({
      cmd: name,
      args: [],
      cwd: "/tmp",
      promptDelivery: "stdin",
      stdinPayload: "",
    }),
    preflight: async () => ({ ok: true, authState: "authenticated" }),
    parseTelemetry: () => ({ ...EMPTY_TELEMETRY }),
    describeTreatment: () => ({
      adapter: name,
      cliVersion: null,
      providerAuthClass: "unknown",
      requestedModel: null,
      resolvedModel: null,
      requestedEffort: null,
      resolvedEffort: null,
      nativeFlags: [],
      fallback: null,
      throttled: null,
    }),
    runtimeSmoke: async () => ({ ok: true, authState: "authenticated" }),
  };
}

interface FakeSmokeOpts {
  adapters?: Map<string, HarnessAdapter>;
  runtimeSmoke?: (
    adapter: HarnessAdapter,
  ) => Promise<AdapterPreflightResult> | AdapterPreflightResult;
  preflight?: (
    adapter: HarnessAdapter,
    req: { model?: string; effort?: string },
  ) => Promise<AdapterPreflightResult> | AdapterPreflightResult;
  invoke?: (req: SmokeInvokeRequest) => Promise<SmokeInvokeResult> | SmokeInvokeResult;
  newCommitMessages?: (root: string, beforeHead: string | null) => string[];
  /** Optional snapshot sequence: first call = before invoke, later = after. */
  snapshots?: ScratchRepoSnapshot[];
  validateContract?: (
    id: string,
    input: string,
  ) => { ok: true } | { ok: false; reason: string };
  parseTelemetry?: (adapter: HarnessAdapter, out: string) => HarnessTelemetry;
  onInvoke?: (req: SmokeInvokeRequest) => void;
  onRuntimeSmoke?: (name: string) => void;
  createScratchRoots?: string[];
  writeFailureArtifact?: HarnessSmokeDeps["writeFailureArtifact"];
  onWriteArtifact?: (artifact: unknown) => void;
  onCleanup?: (root: string) => void;
}

function fakeSmokeDeps(o: FakeSmokeOpts = {}): HarnessSmokeDeps {
  const adapters =
    o.adapters ??
    new Map<string, HarnessAdapter>([
      ["codex", fakeAdapter("codex")],
      ["claude", fakeAdapter("claude")],
      ["ext-reviewer", fakeAdapter("ext-reviewer", { roles: ["reviewer"] })],
    ]);
  const scratchRoots: string[] = o.createScratchRoots ?? [];
  let scratchSeq = 0;
  let snapshotIdx = 0;
  /** Last invoke role — default newCommitMessages only invents commits for implementer. */
  let lastRole: "implementer" | "reviewer" | null = null;
  const cleanSnap = (): ScratchRepoSnapshot => ({
    head: null,
    commitCount: 0,
    statusPorcelain: "",
  });

  return {
    resolveAdapter: (name) => adapters.get(name) ?? null,
    materializeCompatibilityAdapter: (name) =>
      fakeAdapter(name, { roles: ["reviewer"], origin: "compatibility" }),
    createScratchRepo: async () => {
      const root = `/tmp/fake-smoke-${scratchSeq++}`;
      scratchRoots.push(root);
      return root;
    },
    cleanupScratchRepo: async (root) => {
      o.onCleanup?.(root);
    },
    snapshotRepo: async () => {
      if (o.snapshots && o.snapshots.length > 0) {
        const snap = o.snapshots[Math.min(snapshotIdx, o.snapshots.length - 1)]!;
        snapshotIdx += 1;
        return snap;
      }
      return cleanSnap();
    },
    newCommitMessages: async (root, before) => {
      if (o.newCommitMessages) return o.newCommitMessages(root, before);
      // Default happy path: implementer creates a trailer-bearing commit;
      // reviewer leaves the repo unchanged.
      if (lastRole === "implementer") {
        return ["smoke\n\nIssue: #0\nPipeline-Run: harness-smoke/0\n"];
      }
      return [];
    },
    runtimeSmoke: async (adapter, _deps) => {
      o.onRuntimeSmoke?.(adapter.name);
      if (o.runtimeSmoke) return o.runtimeSmoke(adapter);
      return { ok: true, authState: "authenticated" };
    },
    preflight: async (adapter, _deps, req) => {
      if (o.preflight) return o.preflight(adapter, req);
      return { ok: true, authState: "authenticated" };
    },
    invokeSmoke: async (req) => {
      lastRole = req.role;
      o.onInvoke?.(req);
      if (o.invoke) return o.invoke(req);
      if (req.role === "implementer") {
        return {
          success: true,
          exitCode: 0,
          stdout: '{"ok":true,"smoke":"implementer"}',
          stderr: "",
        };
      }
      return {
        success: true,
        exitCode: 0,
        stdout:
          '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
        stderr: "",
      };
    },
    validateContract: (id, input) => {
      if (o.validateContract) return o.validateContract(id, input);
      return validateStageOutput(id, input);
    },
    parseTelemetry: (adapter, out) => {
      if (o.parseTelemetry) return o.parseTelemetry(adapter, out);
      return adapter.parseTelemetry(out);
    },
    adapterPreflightDeps: {
      exec: async () => ({ ok: true, stdout: "", stderr: "" }),
      execCheck: async () => true,
    },
    writeFailureArtifact: async (domain, artifact) => {
      if (o.writeFailureArtifact) return o.writeFailureArtifact(domain, artifact);
      o.onWriteArtifact?.(artifact);
      return {
        path: `/tmp/pipeline-${domain}-doctor-harness-smoke/fake.json`,
        content_hash: "0".repeat(64),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

test("buildSmokePlan: includes implementer and reviewer treatments from config", () => {
  const plan = buildSmokePlan(
    makeConfig({
      harnesses: {
        implementer: "codex",
        reviewer: "claude",
        implementerSource: "profile",
        reviewerSource: "profile",
      },
      models: {
        planning: "m-plan",
        implementing: "m-impl",
        review: "m-rev",
        fix: "m-impl",
        intake: "m-impl",
        sweep: "m-impl",
      },
      effort: {
        planning: "e-plan",
        implementing: "e-impl",
        review: "e-rev",
        fix: "e-impl",
      },
      plan_review_effort: "e-rev",
    }),
  );
  const keys = plan.map(treatmentKey);
  assert.ok(
    keys.includes(treatmentKey({ adapter: "codex", role: "implementer", model: "m-impl", effort: "e-impl" })),
  );
  assert.ok(
    keys.includes(treatmentKey({ adapter: "claude", role: "reviewer", model: "m-rev", effort: "e-rev" })),
  );
  // planning distinct model/effort for implementer
  assert.ok(
    keys.includes(treatmentKey({ adapter: "codex", role: "implementer", model: "m-plan", effort: "e-plan" })),
  );
});

test("buildSmokePlan: deduplicates identical coordinates", () => {
  const plan = buildSmokePlan(
    makeConfig({
      models: {
        planning: "same",
        implementing: "same",
        review: "rev",
        fix: "same",
        intake: "same",
        sweep: "same",
      },
      effort: {
        planning: "low",
        implementing: "low",
        review: "high",
        fix: "low",
        intake: "low",
        sweep: "low",
      },
      plan_review_effort: "high",
    }),
  );
  const impl = plan.filter((t) => t.role === "implementer");
  assert.equal(impl.length, 1, JSON.stringify(impl));
  const rev = plan.filter((t) => t.role === "reviewer");
  assert.equal(rev.length, 1, JSON.stringify(rev));
});

test("buildSmokePlan: external reviewer name is not skipped for being non-built-in", () => {
  const plan = buildSmokePlan(
    makeConfig({
      harnesses: {
        implementer: "codex",
        reviewer: "ext-reviewer",
        implementerSource: "repo-config",
        reviewerSource: "repo-config",
      },
    }),
  );
  assert.ok(plan.some((t) => t.adapter === "ext-reviewer" && t.role === "reviewer"));
});

test("buildSmokePlan: unassigned adapters are not required", () => {
  const plan = buildSmokePlan(makeConfig());
  assert.ok(!plan.some((t) => t.adapter === "pi"));
  assert.ok(!plan.some((t) => t.adapter === "grok"));
});

// ---------------------------------------------------------------------------
// Readiness short-circuit
// ---------------------------------------------------------------------------

test("runHarnessSmoke: readiness failure short-circuits model invoke", async () => {
  const invoked: SmokeInvokeRequest[] = [];
  const smokeCalls: string[] = [];
  const deps = fakeSmokeDeps({
    onRuntimeSmoke: (n) => smokeCalls.push(n),
    runtimeSmoke: async () => ({
      ok: false,
      failure: "missing-cli",
      message: "cli not found",
    }),
    onInvoke: (req) => invoked.push(req),
  });
  const outcomes = await runHarnessSmoke(makeConfig(), deps);
  assert.ok(outcomes.length >= 1);
  assert.ok(outcomes.every((o) => o.status === "fail"));
  assert.ok(outcomes.every((o) => /readiness failed/i.test(o.detail)));
  assert.equal(invoked.length, 0, "canned model prompt must not spawn on readiness fail");
  assert.ok(smokeCalls.length > 0);
});

test("runHarnessSmoke: readiness success proceeds to canned prompt with exact treatment", async () => {
  const invoked: SmokeInvokeRequest[] = [];
  const deps = fakeSmokeDeps({
    onInvoke: (req) => invoked.push(req),
  });
  const cfg = makeConfig({
    models: {
      planning: "m1",
      implementing: "m1",
      review: "m2",
      fix: "m1",
      intake: "m1",
      sweep: "m1",
    },
    effort: {
      implementing: "e1",
      review: "e2",
      planning: "e1",
      fix: "e1",
    },
    plan_review_effort: "e2",
  });
  const outcomes = await runHarnessSmoke(cfg, deps);
  assert.ok(outcomes.every((o) => o.status === "pass"), JSON.stringify(outcomes));
  assert.ok(invoked.some((r) => r.role === "implementer" && r.model === "m1" && r.effort === "e1"));
  assert.ok(invoked.some((r) => r.role === "reviewer" && r.model === "m2" && r.effort === "e2"));
  // No silent fallback adapter names
  for (const r of invoked) {
    assert.ok(r.adapter === "codex" || r.adapter === "claude");
  }
});

// ---------------------------------------------------------------------------
// Role-aware assertions
// ---------------------------------------------------------------------------

test("runHarnessSmoke: implementer missing trailer-bearing commit fails", async () => {
  const deps = fakeSmokeDeps({
    newCommitMessages: () => [], // no commits
    invoke: async (req) => {
      if (req.role === "implementer") {
        return {
          success: true,
          exitCode: 0,
          stdout: '{"ok":true,"smoke":"implementer"}',
          stderr: "",
        };
      }
      return {
        success: true,
        exitCode: 0,
        stdout: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
        stderr: "",
      };
    },
  });
  const outcomes = await runHarnessSmoke(
    makeConfig({
      models: {
        planning: "x",
        implementing: "x",
        review: "y",
        fix: "x",
        intake: "x",
        sweep: "x",
      },
      effort: {},
      plan_review_effort: "medium",
    }),
    deps,
  );
  const impl = outcomes.filter((o) => o.id.includes(":implementer"));
  assert.ok(impl.length >= 1);
  assert.ok(impl.every((o) => o.status === "fail"));
  assert.ok(impl.every((o) => /trailer/i.test(o.detail) || /commit/i.test(o.detail)));
});

test("runHarnessSmoke: implementer contract failure fails treatment", async () => {
  const deps = fakeSmokeDeps({
    newCommitMessages: () => [
      "msg\n\nIssue: #0\nPipeline-Run: harness-smoke/0\n",
    ],
    invoke: async (req) => {
      if (req.role === "implementer") {
        return { success: true, exitCode: 0, stdout: "not-json", stderr: "" };
      }
      return {
        success: true,
        exitCode: 0,
        stdout: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
        stderr: "",
      };
    },
  });
  const outcomes = await runHarnessSmoke(
    makeConfig({
      models: {
        planning: "x",
        implementing: "x",
        review: "y",
        fix: "x",
        intake: "x",
        sweep: "x",
      },
      effort: {},
    }),
    deps,
  );
  const impl = outcomes.filter((o) => o.id.includes(":implementer"));
  assert.ok(impl.every((o) => o.status === "fail"));
  assert.ok(impl.every((o) => /contract/i.test(o.detail)));
});

test("runHarnessSmoke: reviewer mutation fails", async () => {
  let lastRole: "implementer" | "reviewer" | null = null;
  const deps = fakeSmokeDeps({
    onInvoke: (req) => {
      lastRole = req.role;
    },
    newCommitMessages: () => {
      // Implementer: valid trailer commit. Reviewer: illicit mutation.
      if (lastRole === "implementer") {
        return ["x\n\nIssue: #0\nPipeline-Run: harness-smoke/0\n"];
      }
      return ["illicit reviewer commit"];
    },
  });
  const mutOut = await runHarnessSmoke(
    makeConfig({
      models: {
        planning: "x",
        implementing: "x",
        review: "y",
        fix: "x",
        intake: "x",
        sweep: "x",
      },
      effort: {},
    }),
    deps,
  );
  const revFail = mutOut.filter((o) => o.id.includes(":reviewer"));
  assert.ok(revFail.every((o) => o.status === "fail"));
  assert.ok(revFail.every((o) => /read-only|mutat/i.test(o.detail)));
});

test("runHarnessSmoke: reviewer uncommitted file write fails (no new commit)", async () => {
  // Before: clean tree. After invoke: porcelain shows untracked file — no commits.
  const before: ScratchRepoSnapshot = {
    head: "abc",
    commitCount: 1,
    statusPorcelain: "",
  };
  const afterDirty: ScratchRepoSnapshot = {
    head: "abc",
    commitCount: 1,
    statusPorcelain: "?? REVIEWER_TOUCHED.md\n",
  };
  assert.equal(scratchRepoMutated(before, afterDirty), true);

  // Single reviewer treatment (plan_review_effort matches review effort).
  // Implementer readiness fails so it never consumes snapshots.
  let snapCalls = 0;
  const deps = fakeSmokeDeps({
    adapters: new Map([
      ["codex", fakeAdapter("codex")],
      ["ext-reviewer", fakeAdapter("ext-reviewer", { roles: ["reviewer"] })],
    ]),
    newCommitMessages: () => [],
    runtimeSmoke: async (adapter) => {
      if (adapter.name === "codex") {
        return { ok: false, failure: "cli_missing", message: "skip impl" };
      }
      return { ok: true, authState: "authenticated" };
    },
  });
  deps.snapshotRepo = async () => {
    // Odd calls = pre-invoke (clean); even = post-invoke (dirty uncommitted write).
    snapCalls += 1;
    return snapCalls % 2 === 1 ? before : afterDirty;
  };

  const outcomes = await runHarnessSmoke(
    makeConfig({
      harnesses: {
        implementer: "codex",
        reviewer: "ext-reviewer",
        implementerSource: "repo-config",
        reviewerSource: "repo-config",
      },
      models: {
        planning: "x",
        implementing: "x",
        review: "y",
        fix: "x",
        intake: "x",
        sweep: "x",
      },
      effort: {
        planning: "low",
        implementing: "low",
        review: "high",
        fix: "low",
        intake: "low",
        sweep: "low",
      },
      plan_review_effort: "high",
    }),
    deps,
  );
  const revFail = outcomes.filter((o) => o.id.includes(":reviewer"));
  assert.ok(revFail.length >= 1, JSON.stringify(outcomes));
  assert.ok(revFail.every((o) => o.status === "fail"), JSON.stringify(revFail));
  assert.ok(
    revFail.every((o) => /read-only|mutat|working-tree/i.test(o.detail)),
    JSON.stringify(revFail),
  );
  assert.ok(
    revFail.every((o) => /file mutation|read-only/i.test(o.remediation ?? o.detail)),
    JSON.stringify(revFail),
  );
  assert.equal(snapCalls, 2, "one reviewer treatment: before + after snapshot");
});

test("runHarnessSmoke: reviewer-only adapter is not required to commit", async () => {
  const okDeps = fakeSmokeDeps({
    adapters: new Map([
      ["codex", fakeAdapter("codex")],
      ["ext-reviewer", fakeAdapter("ext-reviewer", { roles: ["reviewer"] })],
    ]),
    // Default newCommitMessages: implementer gets trailers, reviewer gets [].
  });
  const okOut = await runHarnessSmoke(
    makeConfig({
      harnesses: {
        implementer: "codex",
        reviewer: "ext-reviewer",
        implementerSource: "repo-config",
        reviewerSource: "repo-config",
      },
      models: {
        planning: "x",
        implementing: "x",
        review: "y",
        fix: "x",
        intake: "x",
        sweep: "x",
      },
      effort: {},
    }),
    okDeps,
  );
  const revOk = okOut.filter((o) => o.id.includes(":reviewer"));
  assert.ok(revOk.length >= 1);
  assert.ok(revOk.every((o) => o.status === "pass"), JSON.stringify(revOk));
  assert.ok(!revOk.some((o) => /no new commit/i.test(o.detail)));
});

test("runHarnessSmoke: unparseable reviewer verdict is output-contract failure", async () => {
  const deps = fakeSmokeDeps({
    newCommitMessages: () => [],
    invoke: async (req) => {
      if (req.role === "reviewer") {
        return { success: true, exitCode: 0, stdout: "LGTM", stderr: "" };
      }
      return {
        success: true,
        exitCode: 0,
        stdout: '{"ok":true}',
        stderr: "",
      };
    },
  });
  // Only smoke reviewer by making implementer readiness fail without invoke? Better: check reviewer outcomes only.
  const outcomes = await runHarnessSmoke(
    makeConfig({
      models: {
        planning: "x",
        implementing: "x",
        review: "y",
        fix: "x",
        intake: "x",
        sweep: "x",
      },
      effort: {},
    }),
    deps,
  );
  const rev = outcomes.filter((o) => o.id.includes(":reviewer"));
  assert.ok(rev.every((o) => o.status === "fail"));
  assert.ok(rev.every((o) => /verdict|contract/i.test(o.detail)));
  assert.ok(rev.every((o) => o.remediation && /output-contract|verdict/i.test(o.remediation)));
});

// ---------------------------------------------------------------------------
// Telemetry provenance (field-aware — not merely nonempty stdout)
// ---------------------------------------------------------------------------

/** Minimal plan: one implementer + one reviewer coordinate. */
function singleCoordConfig(implAdapter: string, revAdapter: string): PipelineConfig {
  return makeConfig({
    harnesses: {
      implementer: implAdapter,
      reviewer: revAdapter,
      implementerSource: "repo-config",
      reviewerSource: "repo-config",
    },
    models: {
      planning: "m",
      implementing: "m",
      review: "m",
      fix: "m",
      intake: "m",
      sweep: "m",
    },
    effort: {
      planning: "low",
      implementing: "low",
      review: "low",
      fix: "low",
      intake: "low",
      sweep: "low",
    },
    plan_review_effort: "low",
  });
}

test("runHarnessSmoke: telemetry inventing cost/model from nonempty product output fails", async () => {
  // Successful canned prompts always emit nonempty product JSON — empty-stdout
  // invention guards alone are insufficient (review 2 finding 383e6ce6).
  const telAdapter = fakeAdapter("tel-impl", {
    roles: ["implementer"],
    telemetry: "jsonl",
  });
  const revAdapter = fakeAdapter("tel-rev", {
    roles: ["reviewer"],
    telemetry: "jsonl",
  });
  const deps = fakeSmokeDeps({
    adapters: new Map([
      ["tel-impl", telAdapter],
      ["tel-rev", revAdapter],
    ]),
    parseTelemetry: () => ({
      text: "product",
      costUsd: 0.42,
      usage: null,
      resolvedModel: "fabricated-model-xyz",
      throttled: null,
    }),
  });
  const outcomes = await runHarnessSmoke(singleCoordConfig("tel-impl", "tel-rev"), deps);
  assert.ok(outcomes.length >= 1, JSON.stringify(outcomes));
  assert.ok(
    outcomes.every((o) => o.status === "fail"),
    JSON.stringify(outcomes),
  );
  assert.ok(
    outcomes.every((o) => /invented/i.test(o.detail)),
    JSON.stringify(outcomes),
  );
  assert.ok(
    outcomes.every((o) => /costUsd|resolvedModel/i.test(o.detail)),
    JSON.stringify(outcomes),
  );
});

test("runHarnessSmoke: telemetry inventing cost from JSONL without cost field fails", async () => {
  // Codex-shaped JSONL: product + usage, no total_cost_usd / modelUsage.
  const jsonlNoCost =
    '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}\n' +
    '{"type":"turn.completed","usage":{"input_tokens":2}}\n';
  const telAdapter = fakeAdapter("tel-impl", {
    roles: ["implementer"],
    telemetry: "jsonl",
  });
  const revAdapter = fakeAdapter("tel-rev", {
    roles: ["reviewer"],
    telemetry: "none",
  });
  const deps = fakeSmokeDeps({
    adapters: new Map([
      ["tel-impl", telAdapter],
      ["tel-rev", revAdapter],
    ]),
    invoke: async (req) => {
      if (req.role === "implementer") {
        return { success: true, exitCode: 0, stdout: jsonlNoCost, stderr: "" };
      }
      return {
        success: true,
        exitCode: 0,
        stdout: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
        stderr: "",
      };
    },
    parseTelemetry: (_adapter, _out) => ({
      text: '{"ok":true}',
      costUsd: 1.23,
      usage: { input_tokens: 2 },
      resolvedModel: null,
      throttled: null,
    }),
    // Contract validate on product JSON reconstructed by adapter — smoke uses
    // raw stdout for validateContract, so force pass for implementer envelope.
    validateContract: (id, _input) => {
      if (id === HARNESS_SMOKE_IMPLEMENTER_CONTRACT_ID) return { ok: true };
      return validateStageOutput(id, _input);
    },
  });
  const outcomes = await runHarnessSmoke(singleCoordConfig("tel-impl", "tel-rev"), deps);
  const impl = outcomes.filter((o) => o.id.includes(":implementer"));
  assert.ok(impl.length >= 1, JSON.stringify(outcomes));
  assert.ok(impl.every((o) => o.status === "fail"), JSON.stringify(impl));
  assert.ok(impl.every((o) => /invented/i.test(o.detail) && /costUsd/i.test(o.detail)));
});

test("runHarnessSmoke: telemetry inventing resolvedModel from JSONL without model field fails", async () => {
  const jsonlNoModel =
    '{"type":"result","result":"{\\"ok\\":true}","total_cost_usd":0.01,"usage":{"input_tokens":1}}\n';
  const telAdapter = fakeAdapter("tel-impl", {
    roles: ["implementer"],
    telemetry: "jsonl",
  });
  const revAdapter = fakeAdapter("tel-rev", {
    roles: ["reviewer"],
    telemetry: "none",
  });
  const deps = fakeSmokeDeps({
    adapters: new Map([
      ["tel-impl", telAdapter],
      ["tel-rev", revAdapter],
    ]),
    invoke: async (req) => {
      if (req.role === "implementer") {
        return { success: true, exitCode: 0, stdout: jsonlNoModel, stderr: "" };
      }
      return {
        success: true,
        exitCode: 0,
        stdout: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
        stderr: "",
      };
    },
    parseTelemetry: () => ({
      text: '{"ok":true}',
      costUsd: 0.01, // present in envelope — ok
      usage: { input_tokens: 1 },
      resolvedModel: "hardcoded-model", // NOT in envelope
      throttled: null,
    }),
    validateContract: (id, input) => {
      if (id === HARNESS_SMOKE_IMPLEMENTER_CONTRACT_ID) return { ok: true };
      return validateStageOutput(id, input);
    },
  });
  const outcomes = await runHarnessSmoke(singleCoordConfig("tel-impl", "tel-rev"), deps);
  const impl = outcomes.filter((o) => o.id.includes(":implementer"));
  assert.ok(impl.length >= 1, JSON.stringify(outcomes));
  assert.ok(impl.every((o) => o.status === "fail"), JSON.stringify(impl));
  assert.ok(
    impl.every((o) => /invented/i.test(o.detail) && /resolvedModel/i.test(o.detail)),
    JSON.stringify(impl),
  );
  // Must not claim cost was invented when total_cost_usd was present.
  assert.ok(impl.every((o) => !/costUsd/i.test(o.detail)), JSON.stringify(impl));
});

test("runHarnessSmoke: honest telemetry recovery from envelope with cost and model passes", async () => {
  const envelope =
    '{"type":"result","result":"{\\"ok\\":true}","total_cost_usd":0.05,"usage":{"input_tokens":3},"modelUsage":{"real-model-abc":{}}}\n';
  const telAdapter = fakeAdapter("tel-impl", {
    roles: ["implementer"],
    telemetry: "jsonl",
  });
  const revAdapter = fakeAdapter("tel-rev", {
    roles: ["reviewer"],
    telemetry: "jsonl",
  });
  const deps = fakeSmokeDeps({
    adapters: new Map([
      ["tel-impl", telAdapter],
      ["tel-rev", revAdapter],
    ]),
    invoke: async (req) => {
      if (req.role === "implementer") {
        return { success: true, exitCode: 0, stdout: envelope, stderr: "" };
      }
      // Reviewer: product verdict only; parseTelemetry returns nulls (honest).
      return {
        success: true,
        exitCode: 0,
        stdout: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
        stderr: "",
      };
    },
    parseTelemetry: (_adapter, out) => {
      if (out.includes("total_cost_usd")) {
        return {
          text: '{"ok":true}',
          costUsd: 0.05,
          usage: { input_tokens: 3 },
          resolvedModel: "real-model-abc",
          throttled: null,
        };
      }
      return { ...EMPTY_TELEMETRY };
    },
    validateContract: (id, input) => {
      if (id === HARNESS_SMOKE_IMPLEMENTER_CONTRACT_ID) return { ok: true };
      return validateStageOutput(id, input);
    },
  });
  const outcomes = await runHarnessSmoke(singleCoordConfig("tel-impl", "tel-rev"), deps);
  assert.ok(
    outcomes.every((o) => o.status === "pass"),
    JSON.stringify(outcomes),
  );
});

test("runHarnessSmoke: telemetry declared but EMPTY_TELEMETRY on nonempty product passes", async () => {
  const telAdapter = fakeAdapter("tel-impl", {
    roles: ["implementer"],
    telemetry: "jsonl",
  });
  const revAdapter = fakeAdapter("tel-rev", {
    roles: ["reviewer"],
    telemetry: "jsonl",
  });
  const deps = fakeSmokeDeps({
    adapters: new Map([
      ["tel-impl", telAdapter],
      ["tel-rev", revAdapter],
    ]),
    parseTelemetry: () => ({ ...EMPTY_TELEMETRY }),
  });
  const outcomes = await runHarnessSmoke(singleCoordConfig("tel-impl", "tel-rev"), deps);
  assert.ok(
    outcomes.every((o) => o.status === "pass"),
    JSON.stringify(outcomes),
  );
});

// ---------------------------------------------------------------------------
// JSON / exit aggregation
// ---------------------------------------------------------------------------

test("foldSmokeIntoChecks: any smoke fail makes ok false", () => {
  const staticChecks: CheckOutcome[] = [
    { id: "cli:gh", description: "gh", status: "pass", detail: "ok" },
  ];
  const smoke: CheckOutcome[] = [
    {
      id: "harness-smoke:codex:implementer",
      description: "smoke",
      status: "fail",
      detail: "nope",
      remediation: "fix it",
    },
  ];
  const folded = foldSmokeIntoChecks(staticChecks, smoke);
  assert.equal(folded.ok, false);
  assert.equal(folded.checks.length, 2);
});

test("formatDoctorJson includes harness-smoke treatment records", () => {
  const result = {
    schema_version: 1,
    ok: false,
    ranAt: "2026-01-01T00:00:00.000Z",
    checks: [
      {
        id: smokeCheckId({
          adapter: "codex",
          role: "implementer",
          model: "m1",
          effort: "e1",
        }),
        description: "smoke",
        status: "fail" as const,
        detail: "missing commit",
        remediation: "fix trailers",
      },
    ],
  };
  const env = formatDoctorJson(result);
  assert.equal(env.schema_version, "1");
  assert.equal(env.status, "error");
  assert.equal(env.checks.length, 1);
  assert.match(env.checks[0]!.name, /harness-smoke:codex:implementer/);
  assert.equal(env.checks[0]!.status, "fail");
  assert.equal(env.checks[0]!.ok, false);
  assert.equal(env.checks[0]!.fix, "fix trailers");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(env)));
});

test("runDoctor with --harness-smoke folds smoke into result; without flag does not invoke smoke", async () => {
  let smokeCalls = 0;
  const staticResult = {
    schema_version: 1,
    ok: true,
    ranAt: "2026-01-01T00:00:00.000Z",
    checks: [
      { id: "cli:gh", description: "gh", status: "pass" as const, detail: "ok" },
    ],
  };
  const deps: PreflightCliDeps = {
    runPreflight: async () => staticResult,
    storePreflightResult: async () => {},
    runHarnessSmoke: async () => {
      smokeCalls += 1;
      return [
        {
          id: "harness-smoke:codex:implementer",
          description: "smoke",
          status: "pass",
          detail: "ok",
        },
      ];
    },
  };
  const cfg = makeConfig();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    process.exitCode = undefined;
    await runDoctor(cfg, { harnessSmoke: true } as CliOpts, deps);
    assert.equal(smokeCalls, 1);
    assert.equal(process.exitCode, 0);
    assert.ok(logs.some((l) => /Harness smoke/i.test(l) || /harness-smoke/i.test(l)));

    smokeCalls = 0;
    logs.length = 0;
    process.exitCode = undefined;
    await runDoctor(cfg, {} as CliOpts, deps);
    assert.equal(smokeCalls, 0, "default doctor must not run harness smoke");
  } finally {
    console.log = origLog;
    process.exitCode = undefined;
  }
});

test("runDoctor --harness-smoke with failing smoke exits non-zero", async () => {
  const deps: PreflightCliDeps = {
    runPreflight: async () => ({
      schema_version: 1,
      ok: true,
      ranAt: "2026-01-01T00:00:00.000Z",
      checks: [],
    }),
    storePreflightResult: async () => {},
    runHarnessSmoke: async () => [
      {
        id: "harness-smoke:codex:implementer",
        description: "smoke",
        status: "fail",
        detail: "readiness failed",
        remediation: "install codex",
      },
    ],
  };
  const origLog = console.log;
  console.log = () => {};
  try {
    process.exitCode = undefined;
    await runDoctor(makeConfig(), { harnessSmoke: true } as CliOpts, deps);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = origLog;
    process.exitCode = undefined;
  }
});

test("runDoctor --harness-smoke --fail-fast does not invoke smoke after static failure", async () => {
  let smokeCalls = 0;
  const deps: PreflightCliDeps = {
    runPreflight: async () => ({
      schema_version: 1,
      ok: false,
      ranAt: "2026-01-01T00:00:00.000Z",
      checks: [
        {
          id: "cli:gh",
          description: "gh",
          status: "fail",
          detail: "missing",
          remediation: "install gh",
        },
      ],
    }),
    storePreflightResult: async () => {},
    runHarnessSmoke: async () => {
      smokeCalls += 1;
      return [
        {
          id: "harness-smoke:codex:implementer",
          description: "smoke",
          status: "pass",
          detail: "should not run",
        },
      ];
    },
  };
  const origLog = console.log;
  console.log = () => {};
  try {
    process.exitCode = undefined;
    await runDoctor(
      makeConfig(),
      { harnessSmoke: true, failFast: true } as CliOpts,
      deps,
    );
    assert.equal(smokeCalls, 0, "fail-fast static failure must not start harness smoke");
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = origLog;
    process.exitCode = undefined;
  }
});

// ---------------------------------------------------------------------------
// Drift guards
// ---------------------------------------------------------------------------

test("drift-guard: smoke contract ids are registered in stage-output-contract", () => {
  assert.equal(
    HARNESS_SMOKE_CONTRACT_IDS.implementer,
    HARNESS_SMOKE_IMPLEMENTER_CONTRACT_ID,
  );
  assert.equal(
    HARNESS_SMOKE_CONTRACT_IDS.reviewer,
    HARNESS_SMOKE_REVIEWER_CONTRACT_ID,
  );
  assert.ok(getStageOutputContract(HARNESS_SMOKE_CONTRACT_IDS.implementer));
  assert.ok(getStageOutputContract(HARNESS_SMOKE_CONTRACT_IDS.reviewer));
  assert.equal(
    validateHarnessSmokeImplementer('{"ok":true,"smoke":"implementer"}').ok,
    true,
  );
  assert.equal(validateHarnessSmokeImplementer("nope").ok, false);
});

test("drift-guard: harness-smoke module references registered contract ids", () => {
  const src = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../scripts/stages/harness-smoke.ts",
    ),
    "utf8",
  );
  assert.match(src, /HARNESS_SMOKE_IMPLEMENTER_CONTRACT_ID|harness-smoke\.implementer@1/);
  assert.match(src, /HARNESS_SMOKE_REVIEWER_CONTRACT_ID|review\.verdict@1/);
  assert.match(src, /runtimeSmoke/);
  // No hardcoded built-in-only name list for plan building
  assert.doesNotMatch(src, /const BUILTIN_ONLY\s*=/);
  // #1265: implementer smoke must not hardcode tool-disabling lean.
  assert.doesNotMatch(src, /lean:\s*req\.role\s*===\s*"implementer"\s*\?\s*true/);
});

test("canned prompts mention trailers / read-only verdict", () => {
  const impl = implementerSmokePrompt();
  assert.match(impl, /Issue: #0/);
  assert.match(impl, /Pipeline-Run: harness-smoke\/0/);
  assert.match(impl, /ok.*true/i);
  const rev = reviewerSmokePrompt();
  assert.match(rev, /read-only|Do NOT create commits/i);
  assert.match(rev, /verdict/);
  assert.match(rev, /findings/);
});

test("fail-fast stops after first failing treatment", async () => {
  let invokes = 0;
  const deps = fakeSmokeDeps({
    runtimeSmoke: async () => ({
      ok: false,
      failure: "unauthenticated",
      message: "no auth",
    }),
    onInvoke: () => {
      invokes += 1;
    },
  });
  const outcomes = await runHarnessSmoke(makeConfig(), deps, { failFast: true });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "fail");
  assert.equal(invokes, 0);
});

function collapsedConfig(): PipelineConfig {
  return makeConfig({
    models: {
      planning: "x",
      implementing: "x",
      review: "y",
      fix: "x",
      intake: "x",
      sweep: "x",
    },
    effort: {
      planning: "low",
      implementing: "low",
      review: "high",
      fix: "low",
      intake: "low",
      sweep: "low",
    },
    plan_review_effort: "high",
  });
}

// ---------------------------------------------------------------------------
// #1265 — implementer smoke is not lean; failure artifacts
// ---------------------------------------------------------------------------

test("runHarnessSmoke: implementer invoke is not lean; reviewer MAY be lean", async () => {
  const invoked: SmokeInvokeRequest[] = [];
  const deps = fakeSmokeDeps({
    onInvoke: (req) => invoked.push(req),
  });
  const outcomes = await runHarnessSmoke(collapsedConfig(), deps);
  assert.ok(outcomes.every((o) => o.status === "pass"), JSON.stringify(outcomes));
  const impl = invoked.filter((r) => r.role === "implementer");
  const rev = invoked.filter((r) => r.role === "reviewer");
  assert.ok(impl.length >= 1);
  assert.ok(impl.every((r) => r.lean !== true), JSON.stringify(impl));
  assert.ok(rev.length >= 1);
  assert.ok(rev.every((r) => r.lean === true), JSON.stringify(rev));
});

test("runHarnessSmoke: fake implementer that commits only without lean passes", async () => {
  const leanByRoot = new Map<string, boolean | undefined>();
  const deps = fakeSmokeDeps({
    onInvoke: (req) => {
      leanByRoot.set(req.worktreeDir, req.lean);
    },
    newCommitMessages: (root) => {
      if (leanByRoot.get(root) === true) return [];
      return ["smoke\n\nIssue: #0\nPipeline-Run: harness-smoke/0\n"];
    },
  });
  const outcomes = await runHarnessSmoke(collapsedConfig(), deps);
  const impl = outcomes.filter((o) => o.id.includes(":implementer"));
  assert.ok(impl.length >= 1);
  assert.ok(impl.every((o) => o.status === "pass"), JSON.stringify(impl));
});

test("parseHarnessSmokeFailureArtifact rejects missing required fields", () => {
  const missingStdout = {
    schema: HARNESS_SMOKE_FAILURE_SCHEMA,
    treatment: { adapter: "claude", role: "implementer" },
    stderr: "",
    before_porcelain: "",
    after_porcelain: "",
    head: null,
    log_excerpt: "",
    exit_code: 0,
    timed_out: false,
    preflight_failed: false,
  };
  const parsed = parseHarnessSmokeFailureArtifact(missingStdout);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.reason, /stdout/);
});

test("runHarnessSmoke: trailer-miss writes evidence before scratch delete", async () => {
  const events: string[] = [];
  const deps = fakeSmokeDeps({
    newCommitMessages: () => [],
    invoke: async (req) => {
      if (req.role === "implementer") {
        return {
          success: true,
          exitCode: 0,
          stdout: '{"ok":true,"smoke":"implementer"}',
          stderr: "secret ghp_abcdefghijklmnopqrstuvwxyz012345",
        };
      }
      return {
        success: true,
        exitCode: 0,
        stdout: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
        stderr: "",
      };
    },
    writeFailureArtifact: async () => {
      events.push("write");
      return { path: "/tmp/pipeline-smoketest-doctor-harness-smoke/abc.json", content_hash: "abc" };
    },
    onCleanup: () => {
      events.push("delete");
    },
  });
  const outcomes = await runHarnessSmoke(collapsedConfig(), deps);
  const impl = outcomes.filter((o) => o.id.includes(":implementer"));
  assert.ok(impl.every((o) => o.status === "fail"));
  assert.ok(impl.every((o) => o.evidence?.path.includes("abc.json")));
  assert.ok(impl.every((o) => /digest abc/.test(o.detail)));
  const env = formatDoctorJson({
    schema_version: 1,
    ok: false,
    ranAt: "t",
    checks: impl,
  });
  assert.equal(env.checks[0]!.evidence?.path, impl[0]!.evidence?.path);
  assert.equal(env.checks[0]!.evidence?.content_hash, "abc");
  const writeIdx = events.indexOf("write");
  const deleteIdx = events.indexOf("delete");
  assert.ok(writeIdx >= 0 && deleteIdx > writeIdx, JSON.stringify(events));
});

test("runHarnessSmoke: artifact write throw still status-fails", async () => {
  const deps = fakeSmokeDeps({
    newCommitMessages: () => [],
    invoke: async (req) => {
      if (req.role === "implementer") {
        return {
          success: true,
          exitCode: 0,
          stdout: '{"ok":true,"smoke":"implementer"}',
          stderr: "",
        };
      }
      return {
        success: true,
        exitCode: 0,
        stdout: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
        stderr: "",
      };
    },
    writeFailureArtifact: async () => {
      throw new Error("disk full");
    },
  });
  const outcomes = await runHarnessSmoke(collapsedConfig(), deps);
  const impl = outcomes.filter((o) => o.id.includes(":implementer"));
  assert.ok(impl.every((o) => o.status === "fail"));
  assert.ok(impl.every((o) => /trailer/i.test(o.detail)));
  assert.ok(impl.every((o) => /evidence capture failed/i.test(o.detail)));
  assert.ok(impl.every((o) => o.evidence === undefined));
});

test("runHarnessSmoke: spawn/contract/mutation/telemetry failures capture evidence", async () => {
  const spawnDeps = fakeSmokeDeps({
    invoke: async () => ({ success: false, exitCode: 1, stdout: "", stderr: "boom" }),
  });
  const spawnOut = await runHarnessSmoke(collapsedConfig(), spawnDeps);
  assert.ok(spawnOut.some((o) => o.status === "fail" && o.evidence && /spawn failed/i.test(o.detail)));

  const contractDeps = fakeSmokeDeps({
    newCommitMessages: () => ["msg\n\nIssue: #0\nPipeline-Run: harness-smoke/0\n"],
    invoke: async (req) => {
      if (req.role === "implementer") {
        return { success: true, exitCode: 0, stdout: "not-json", stderr: "" };
      }
      return {
        success: true,
        exitCode: 0,
        stdout: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
        stderr: "",
      };
    },
  });
  const contractOut = await runHarnessSmoke(collapsedConfig(), contractDeps);
  assert.ok(contractOut.some((o) => o.id.includes(":implementer") && o.status === "fail" && o.evidence && /contract/i.test(o.detail)));
});

test("serializeHarnessSmokeFailureArtifact redacts secret-shaped tokens", () => {
  const artifact = buildHarnessSmokeFailureArtifact({
    treatment: { adapter: "claude", role: "implementer" },
    stdout: "token ghp_abcdefghijklmnopqrstuvwxyz012345 in stdout",
    stderr: "please log in",
    beforePorcelain: "",
    afterPorcelain: "",
    head: null,
    logExcerpt: "",
    exitCode: 0,
    timedOut: false,
    preflightFailed: false,
  });
  const bytes = serializeHarnessSmokeFailureArtifact(artifact);
  assert.equal(bytes.includes("ghp_abcdefghijklmnopqrstuvwxyz012345"), false);
  assert.match(bytes, /REDACTED/);
});
