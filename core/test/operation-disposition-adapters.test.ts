// Adapter, fence, and isolation tests for command-form dispositions (#1329).
// Hermetic: injected fakes only.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  lookupCommandForm,
} from "../scripts/command-form-inventory.ts";
import {
  collectCommandLocalLifecycleExits,
  collectReadOnlyRecoveryWrites,
} from "../scripts/fault-recovery-static-guards.ts";
import {
  consumeOwnedOperation,
  listPersistedOperationObservations,
  loadOwnedOperationClaim,
  mechanicalFaultObservation,
  memoryObservationSink,
  ownedAdmissionObservation,
  persistOperationObservation,
  recoverySupervisorObservationSink,
  reportMechanicalFault,
} from "../scripts/operation-observation.ts";
import {
  runEnginePromote,
  type EnginePromoteDeps,
} from "../scripts/stages/engine-promote.ts";
import { runGrill, type GrillDeps, type GrillIssueRecord } from "../scripts/stages/grill.ts";
import type { GrillStoreDeps } from "../scripts/grill-store.ts";
import { runQueue, type QueueDeps, type QueueOpts } from "../scripts/stages/queue.ts";
import { sweepMergedWorktrees, removeWorktreeForIssue, type WorktreeRecord } from "../scripts/worktree.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import {
  answeredFulfillmentHandoff,
  fulfillTypedRequestAndValidateResume,
} from "../scripts/typed-request-resume.ts";
import { validateHandoffResume } from "../scripts/human-question-handoff.ts";
import {
  runDoctor,
  runStartPreflightGate,
  runOverride,
  resolveLiveCandidateSha,
  _internals,
  type CliOpts,
  type PreflightCliDeps,
  type RunOverrideDeps,
  type RunUnblockDeps,
} from "../scripts/pipeline.ts";
import type { PreflightResult } from "../scripts/stages/doctor.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeCfg(): PipelineConfig {
  return {
    repo: "owner/repo",
    repo_dir: "/repo",
    worktree_root: ".worktrees",
    base_branch: "main",
    domain: "test",
    max_concurrent_worktrees: 4,
    invocation: "pipeline",
  } as unknown as PipelineConfig;
}

function makeRec(issueNumber: number, slug: string): WorktreeRecord {
  return {
    path: `/repo/.worktrees/pipeline-${issueNumber}-${slug}`,
    branch: `pipeline/${issueNumber}-${slug}`,
    issueNumber,
    slug,
  };
}

test("queue nested throw reports an observation and does not process.exit(1)", async () => {
  const sink = memoryObservationSink();
  const exits: number[] = [];
  const originalExit = process.exit;
  (process as { exit: typeof process.exit }).exit = ((code?: number) => {
    exits.push(code ?? 0);
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  try {
    const deps: QueueDeps = {
      listEligibleIssues: async () => [
        { number: 1, title: "one", labels: ["pipeline:ready"], priorityScore: 100 },
        { number: 2, title: "two", labels: ["pipeline:ready"], priorityScore: 90 },
      ],
      runPipeline: async (n) => {
        if (n === 1) throw new Error("nested timeout");
        return { issueNumber: n, finalState: "ready-to-deploy", costUsd: 0, durationMs: 1 };
      },
      readRunCost: async () => null,
      writeFile: async () => {},
      autoFilePapercuts: async () => {},
      autoFileCorrections: async () => {},
      log: () => {},
      clock: () => 1,
      reportObservation: sink.reportObservation,
    };
    const opts: QueueOpts = {
      maxIssues: 10,
      budgetDollars: null,
      concurrency: 1,
      maxFailureRate: 1,
      filters: {},
      repoDir: "/fake/repo",
      batchId: "batch-1",
      domain: "test",
    };
    await runQueue(opts, deps);
    assert.equal(exits.length, 0, "queue must not call process.exit");
    const cooling = sink.observations.find((o) => o.lifecycle === "cooling");
    assert.ok(cooling);
    assert.equal(cooling.owned, true);
    assert.equal(cooling.complete, false);
    assert.equal(cooling.human_owned, false);
    assert.equal(cooling.cancelled, false);
    assert.equal(cooling.issue, 1);
    assert.ok(cooling.logical_operation_id.startsWith("lop-"));
  } finally {
    process.exit = originalExit;
  }
});

test("merge/train/ship/recover-parked are supervised; dry-run and ship status are read-only", () => {
  for (const id of ["merge", "train", "ship", "recover-parked"]) {
    assert.equal(lookupCommandForm(id)?.execution_disposition, "supervised-lifecycle", id);
  }
  assert.equal(lookupCommandForm("train.dry-run")?.execution_disposition, "read-only");
  assert.equal(lookupCommandForm("ship.status")?.execution_disposition, "read-only");
  assert.equal(lookupCommandForm("merge-queue.dry-run")?.execution_disposition, "read-only");
});

test("release and factory-release mechanical observations stay owned", () => {
  const obs = mechanicalFaultObservation({
    operation: "release_prepare",
    form_id: "release",
    message: "gh failed",
    domain: "test",
    logical_operation_id: "lop-release-test",
  });
  assert.equal(obs.owned, true);
  assert.equal(obs.complete, false);
  assert.equal(obs.human_owned, false);
  assert.equal(lookupCommandForm("release")?.execution_disposition, "supervised-lifecycle");
  assert.equal(lookupCommandForm("factory-release")?.execution_disposition, "supervised-lifecycle");
});

test("engine-promote rollback is protected-authority and dry-run is read-only", () => {
  assert.equal(lookupCommandForm("factory-pin.rollback")?.authority_requirement, "protected-authority");
  assert.equal(lookupCommandForm("engine-promote.dry-run")?.execution_disposition, "read-only");
  assert.equal(lookupCommandForm("engine-promote")?.execution_disposition, "supervised-lifecycle");
});

test("grill dry-run and status are read-only", () => {
  assert.equal(lookupCommandForm("grill.dry-run")?.execution_disposition, "read-only");
  assert.equal(lookupCommandForm("grill.status")?.execution_disposition, "read-only");
  assert.equal(lookupCommandForm("grill")?.execution_disposition, "supervised-lifecycle");
});

test("stale-SHA fulfillment refuses resume for unblock/override/handoff answer", async () => {
  const handoff = answeredFulfillmentHandoff({
    repoDir: "/repo",
    issueNumber: 7,
    answer: "ok",
    actor: "alice",
    candidateSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    resumeTarget: "override-or-unblock",
  });
  const stale = await validateHandoffResume(handoff, {
    candidate_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "stale_sha");
});

test("queue nested throw persists RecoverySupervisor ownership", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-obs-queue-"));
  try {
    const sink = recoverySupervisorObservationSink(dir);
    const deps: QueueDeps = {
      listEligibleIssues: async () => [
        { number: 1, title: "one", labels: ["pipeline:ready"], priorityScore: 100 },
      ],
      runPipeline: async () => {
        throw new Error("nested timeout");
      },
      readRunCost: async () => null,
      writeFile: async () => {},
      autoFilePapercuts: async () => {},
      autoFileCorrections: async () => {},
      log: () => {},
      clock: () => 1,
      reportObservation: sink,
    };
    const opts: QueueOpts = {
      maxIssues: 10,
      budgetDollars: null,
      concurrency: 1,
      maxFailureRate: 1,
      filters: {},
      repoDir: "/fake/repo",
      batchId: "batch-persist",
      domain: "test",
    };
    await runQueue(opts, deps);
    const persisted = listPersistedOperationObservations(dir);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.owned, true);
    assert.equal(persisted[0]!.complete, false);
    assert.equal(persisted[0]!.human_owned, false);
    assert.equal(persisted[0]!.form_id, "queue");
    assert.equal(persisted[0]!.domain, "test");
    assert.equal(persisted[0]!.issue, 1);
    assert.ok(persisted[0]!.logical_operation_id.startsWith("lop-"));
    const loaded = loadOwnedOperationClaim("test", persisted[0]!.logical_operation_id, dir);
    assert.ok(loaded);
    const consumed = consumeOwnedOperation(loaded);
    assert.equal(consumed.owned, true);
    assert.equal(consumed.lifecycle, "cooling");
    assert.equal(consumed.issue, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release mechanical fault persists RecoverySupervisor ownership", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-obs-release-"));
  try {
    reportMechanicalFault(recoverySupervisorObservationSink(dir), {
      operation: "release_prepare",
      form_id: "release",
      message: "gh failed",
      fault: "mechanical",
      domain: "test",
      logical_operation_id: "lop-release-persist",
      repository: "owner/repo",
    });
    const persisted = listPersistedOperationObservations(dir);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.owned, true);
    assert.equal(persisted[0]!.complete, false);
    assert.equal(persisted[0]!.human_owned, false);
    assert.equal(persisted[0]!.form_id, "release");
    assert.equal(persisted[0]!.domain, "test");
    assert.equal(persisted[0]!.logical_operation_id, "lop-release-persist");
    assert.equal(persisted[0]!.observation_id, "lop-release-persist:release:release_prepare");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate reports for one logical operation persist a single claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-obs-idempotent-"));
  try {
    const sink = recoverySupervisorObservationSink(dir);
    const input = {
      operation: "engine_promote",
      form_id: "engine-promote",
      message: "not found",
      fault: "mechanical" as const,
      domain: "engine",
      logical_operation_id: "lop-engine-dup",
      repository: "/repo",
    };
    reportMechanicalFault(sink, input);
    reportMechanicalFault(sink, input);
    const persisted = listPersistedOperationObservations(dir);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.observation_id, "lop-engine-dup:engine-promote:engine_promote");
    assert.equal(consumeOwnedOperation(persisted[0]!).owned, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function exclusiveCreatePlantsCompetitor(
  competitor: ReturnType<typeof ownedAdmissionObservation> | ReturnType<typeof mechanicalFaultObservation>,
): (file: string, _contents: string) => void {
  return (file) => {
    writeFileSync(file, JSON.stringify({
      ...competitor,
      observation_id: `${competitor.logical_operation_id}:${competitor.form_id}:${competitor.operation}`,
      recorded_at: "2026-01-01T00:00:00Z",
      claim_revision: 1,
    }), { encoding: "utf8" });
    const err = new Error("EEXIST") as NodeJS.ErrnoException;
    err.code = "EEXIST";
    throw err;
  };
}

test("EEXIST after a concurrent admission write still applies the cooling fault", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-obs-eexist-fault-"));
  try {
    const identity = {
      operation: "engine_promote",
      form_id: "engine-promote",
      domain: "engine",
      logical_operation_id: "lop-engine-eexist-fault",
      repository: "/repo",
    };
    const admission = ownedAdmissionObservation({
      ...identity,
      message: "admitted",
    });
    const fault = mechanicalFaultObservation({
      ...identity,
      message: "promote failed",
      fault: "mechanical",
    });
    const persisted = persistOperationObservation(fault, dir, {
      exclusiveCreate: exclusiveCreatePlantsCompetitor(admission),
    });
    assert.equal(persisted.lifecycle, "cooling");
    assert.equal(persisted.fault, "mechanical");
    assert.equal(persisted.complete, false);
    const loaded = loadOwnedOperationClaim(identity.domain, identity.logical_operation_id, dir);
    assert.ok(loaded);
    assert.equal(loaded.lifecycle, "cooling");
    assert.equal(loaded.fault, "mechanical");
    assert.equal(consumeOwnedOperation(loaded).owned, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EEXIST after a concurrent cooling write does not let admission discard the fault", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-obs-eexist-admit-"));
  try {
    const identity = {
      operation: "engine_promote",
      form_id: "engine-promote",
      domain: "engine",
      logical_operation_id: "lop-engine-eexist-admit",
      repository: "/repo",
    };
    const fault = mechanicalFaultObservation({
      ...identity,
      message: "promote failed",
      fault: "mechanical",
    });
    const admission = ownedAdmissionObservation({
      ...identity,
      message: "admitted",
    });
    const persisted = persistOperationObservation(admission, dir, {
      exclusiveCreate: exclusiveCreatePlantsCompetitor(fault),
    });
    assert.equal(persisted.lifecycle, "cooling");
    assert.equal(persisted.fault, "mechanical");
    const loaded = loadOwnedOperationClaim(identity.domain, identity.logical_operation_id, dir);
    assert.ok(loaded);
    assert.equal(loaded.lifecycle, "cooling");
    assert.equal(loaded.fault, "mechanical");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("active admission cannot overwrite a persisted cooling fault", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-obs-mono-active-"));
  try {
    const identity = {
      operation: "engine_promote",
      form_id: "engine-promote",
      domain: "engine",
      logical_operation_id: "lop-engine-mono-active",
      repository: "/repo",
    };
    persistOperationObservation(ownedAdmissionObservation({
      ...identity,
      message: "admitted",
    }), dir);
    persistOperationObservation(mechanicalFaultObservation({
      ...identity,
      message: "promote failed",
      fault: "mechanical",
    }), dir);
    const stale = persistOperationObservation(ownedAdmissionObservation({
      ...identity,
      message: "retry admission",
    }), dir);
    assert.equal(stale.lifecycle, "cooling");
    assert.equal(stale.fault, "mechanical");
    const loaded = loadOwnedOperationClaim(identity.domain, identity.logical_operation_id, dir);
    assert.ok(loaded);
    assert.equal(loaded.lifecycle, "cooling");
    assert.equal(loaded.fault, "mechanical");
    assert.equal(loaded.message, "promote failed");
    assert.equal(consumeOwnedOperation(loaded).owned, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent active admission cannot overwrite a cooling fault", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-obs-cas-active-fault-"));
  try {
    const identity = {
      operation: "engine_promote",
      form_id: "engine-promote",
      domain: "engine",
      logical_operation_id: "lop-engine-cas-active-fault",
      repository: "/repo",
    };
    const admission = ownedAdmissionObservation({
      ...identity,
      message: "admitted",
    });
    const staleAdmission = ownedAdmissionObservation({
      ...identity,
      message: "retry admission",
    });
    const fault = mechanicalFaultObservation({
      ...identity,
      message: "promote failed",
      fault: "mechanical",
    });
    persistOperationObservation(admission, dir);
    let injected = false;
    const persisted = persistOperationObservation(staleAdmission, dir, {
      afterRead(existing) {
        if (injected || existing?.lifecycle !== "active") return;
        injected = true;
        persistOperationObservation(fault, dir);
      },
    });
    assert.equal(injected, true);
    assert.equal(persisted.lifecycle, "cooling");
    assert.equal(persisted.fault, "mechanical");
    assert.equal(persisted.complete, false);
    const loaded = loadOwnedOperationClaim(identity.domain, identity.logical_operation_id, dir);
    assert.ok(loaded);
    assert.equal(loaded.lifecycle, "cooling");
    assert.equal(loaded.fault, "mechanical");
    assert.equal(loaded.message, "promote failed");
    assert.equal(consumeOwnedOperation(loaded).owned, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engine-promote fault persists one recovery record even if CLI reports again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-obs-promote-"));
  try {
    const sink = recoverySupervisorObservationSink(dir);
    const deps: EnginePromoteDeps = {
      log() {},
      reportObservation: sink,
      async verifyPublishedRelease() {
        return { ok: false, error: "not found" };
      },
      async promote() {
        throw new Error("promote must not run");
      },
      async rollback() {
        throw new Error("rollback must not run");
      },
      async loadPin() {
        return { kind: "missing", path: "/pin.json" };
      },
      async installFromTag() {
        throw new Error("install must not run");
      },
      async installedVersion() {
        return null;
      },
      async installedDigest() {
        return null;
      },
      async resolvePromoteGitSha() {
        return "b".repeat(40);
      },
      async listRemainingOpenMilestoneIssues() {
        return [];
      },
      readSkipFrg: () => undefined,
    };
    const result = await runEnginePromote(
      {
        version: "1.34.0",
        repoDir: "/repo",
        host: "codex",
        domain: "engine",
        logicalOperationId: "lop-engine-promote-one",
      },
      deps,
    );
    assert.ok(result.error);
    assert.equal(result.observation_recorded, true);
    reportMechanicalFault(sink, {
      operation: "engine_promote",
      form_id: "engine-promote",
      message: result.error ?? "cli",
      fault: "mechanical",
      domain: "engine",
      logical_operation_id: "lop-engine-promote-one",
      repository: "/repo",
    });
    const persisted = listPersistedOperationObservations(dir);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.logical_operation_id, "lop-engine-promote-one");
    assert.equal(consumeOwnedOperation(persisted[0]!).owned, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grill isolated admission fault persists one recovery record even if CLI reports again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-obs-grill-"));
  try {
    const sink = recoverySupervisorObservationSink(dir);
    const files = new Map<string, string>();
    const store: GrillStoreDeps = {
      fsExists: async (p) => files.has(p),
      readTextFile: async (p) => files.get(p) ?? null,
      writeFileAtomic: async (p, c) => {
        files.set(p, c);
      },
      createFileExclusive: async (p, c) => {
        if (files.has(p)) return false;
        files.set(p, c);
        return true;
      },
      mkdirp: async () => {},
      listDir: async () => [],
      now: () => new Date("2026-09-01T00:00:00Z"),
      uuid: () => "grillfault01",
      env: { AGENT_PIPELINE_STATE_HOME: dir },
    };
    const issue: GrillIssueRecord = {
      number: 10,
      title: "Issue 10",
      body: "## Summary\nThin.\n",
      labels: ["pipeline:backlog"],
      state: "open",
    };
    const deps: GrillDeps = {
      getIssue: async () => issue,
      fetchDependencyIssue: async () => ({ ok: true, title: issue.title, body: issue.body }),
      listMilestoneOpenIssues: async () => [],
      listOpenIssuesByLabel: async () => [],
      updateIssueBody: async () => {},
      getIssueLabels: async () => issue.labels,
      addLabel: async () => {},
      removeLabel: async () => {},
      readContextMd: async () => {
        throw new Error("isolated timeout");
      },
      resolveIntegrationBase: async () => "abc123def456",
      runImplementer: async () => ({ success: true, output: "{}" }),
      providerConfig: {
        implementer: "grok",
        reviewer: "codex",
        planning_model: "grok-4.6",
        planning_effort: "auto",
      },
      planningTreatment: {
        adapter: "grok",
        model: "grok-4.6",
        effort: "auto",
      } as never,
      repo: "acme/r",
      domain: "acme",
      repoDir: "/tmp/repo",
      baseBranch: "main",
      store,
      now: () => new Date("2026-09-01T00:00:00Z"),
      uuid: () => "grillfault01",
      log: () => {},
      writeStdout: () => {},
      writeStderr: () => {},
      callLog: [],
      reportObservation: sink,
    };
    const exitCode = await runGrill({ issue: 10 }, deps);
    assert.equal(exitCode, 1);
    const first = listPersistedOperationObservations(dir);
    assert.equal(first.length, 1);
    reportMechanicalFault(sink, {
      operation: first[0]!.operation,
      form_id: first[0]!.form_id,
      message: `pipeline grill exited ${exitCode}`,
      fault: "mechanical",
      domain: first[0]!.domain,
      logical_operation_id: first[0]!.logical_operation_id,
      repository: first[0]!.repository,
      issue: first[0]!.issue,
      run_id: first[0]!.run_id,
    });
    const persisted = listPersistedOperationObservations(dir);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.form_id, "grill");
    assert.equal(persisted[0]!.issue, 10);
    assert.equal(consumeOwnedOperation(persisted[0]!).owned, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engine-promote and grill CLI do not re-report an adapter-observed fault", () => {
  const src = readFileSync(join(__dirname, "../scripts/pipeline.ts"), "utf8");
  assert.doesNotMatch(src, /pipeline grill exited/);
  assert.doesNotMatch(
    src,
    /if \(result\.error && !opts\.dryRun\) \{\s*reportMechanicalFault/,
  );
});

test("persistOperationObservation refuses an anonymous observation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-obs-anon-"));
  try {
    assert.throws(
      () =>
        persistOperationObservation({
          schema_version: 1,
          operation: "release_prepare",
          form_id: "release",
          domain: "",
          logical_operation_id: "",
          repository: null,
          issue: null,
          run_id: null,
          certainty: "uncertain",
          lifecycle: "cooling",
          human_owned: false,
          complete: false,
          cancelled: false,
          process_exit_is_completion: false,
          owned: true,
          fault: "mechanical",
          message: "anon",
          capability_request: null,
        }, dir),
      /domain and logical_operation_id are required/,
    );
    assert.equal(listPersistedOperationObservations(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStartPreflightGate failure persists RecoverySupervisor ownership", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-obs-preflight-"));
  try {
    const failing: PreflightResult = {
      schema_version: 1,
      ok: false,
      checks: [
        {
          id: "github-auth",
          description: "auth",
          status: "fail",
          detail: "not logged in",
          remediation: "gh auth login",
        },
      ],
      ranAt: "2026-01-01T00:00:00Z",
    };
    const deps: PreflightCliDeps = {
      runPreflight: async () => failing,
      storePreflightResult: async () => {},
      reportObservation: recoverySupervisorObservationSink(dir),
    };
    const orig = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
    try {
      const gate = await runStartPreflightGate(
        { ...makeCfg(), doctor: { runOnStart: true, failFast: false } } as PipelineConfig,
        {} as CliOpts,
        deps,
      );
      assert.equal(gate.proceed, false);
    } finally {
      console.log = orig.log;
      console.error = orig.error;
    }
    const persisted = listPersistedOperationObservations(dir);
    assert.ok(persisted.length >= 1);
    assert.equal(persisted[0]!.owned, true);
    assert.equal(persisted[0]!.complete, false);
    assert.ok(persisted[0]!.capability_request);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fulfillTypedRequestAndValidateResume refuses when no pending request exists", async () => {
  let answered = 0;
  const result = await fulfillTypedRequestAndValidateResume(
    {
      repoDir: "/repo",
      issueNumber: 7,
      answer: "the answer",
      actor: "alice",
      candidateSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resumeTarget: "override-or-unblock",
    },
    {
      listHandoffs: async () => [],
      answerAndPersistHandoff: async () => {
        answered++;
        throw new Error("must not persist a fabricated handoff");
      },
    },
  );
  assert.equal(answered, 0);
  assert.equal(result.fulfilled, false);
  assert.equal(result.handoff, null);
  assert.equal(result.resume.ok, false);
  if (!result.resume.ok) assert.equal(result.resume.code, "no_pending_request");
});

test("fulfillTypedRequestAndValidateResume refuses stale candidate SHA after persist", async () => {
  const pending = answeredFulfillmentHandoff({
    repoDir: "/repo",
    issueNumber: 7,
    answer: "pending",
    actor: "alice",
    candidateSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    resumeTarget: "override-or-unblock",
  });
  pending.status = "pending";
  pending.answer = null;
  pending.handoff_id = "h1";
  const answeredHandoff = {
    ...pending,
    status: "answered" as const,
    answer: {
      decision: "answer" as const,
      responder: "alice",
      identity_source: "gh",
      answer_text: "the answer",
      answered_at: "2026-01-01T00:00:00Z",
      payload_hash: "x",
    },
  };
  const result = await fulfillTypedRequestAndValidateResume(
    {
      repoDir: "/repo",
      issueNumber: 7,
      answer: "the answer",
      actor: "alice",
      candidateSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      resumeTarget: "override-or-unblock",
    },
    {
      listHandoffs: async () => [pending],
      answerAndPersistHandoff: async () => ({
        ok: true,
        duplicate: false,
        advances_item: false,
        handoff: answeredHandoff,
      }),
    },
  );
  assert.equal(result.fulfilled, true);
  assert.equal(result.resume.ok, false);
  if (!result.resume.ok) assert.equal(result.resume.code, "stale_sha");
});

test("resolveLiveCandidateSha returns the open PR head without network", async () => {
  const sha = "c".repeat(40);
  const resolved = await resolveLiveCandidateSha(makeCfg(), 7, {
    getPrForIssue: async () => 99,
    getPrDetail: async () => ({ head_sha: sha }) as never,
  });
  assert.equal(resolved, sha);
});

test("runUnblock refuses when no pending typed request exists", async () => {
  let cleared = false;
  const deps: RunUnblockDeps = {
    getIssueDetail: async () => ({
      number: 7,
      type: "issue",
      title: "t",
      body: "b",
      state: "open",
      url: "u",
      labels: ["pipeline:review-1", "blocked"],
      comments: [],
    }) as never,
    postComment: async () => {},
    clearBlocked: async () => {
      cleared = true;
    },
    isKillSwitchActive: () => false,
    getGhActor: async () => "alice",
    getCandidateSha: async () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fulfillTypedRequest: async () => ({
      resume: {
        ok: false,
        reason: "no eligible current typed request to fulfill",
        code: "no_pending_request",
        advances_item: false,
      },
      handoff: null,
      fulfilled: false,
    }),
  };
  const origErr = console.error;
  console.error = () => {};
  const prev = process.exitCode;
  try {
    await _internals.runUnblock(makeCfg(), 7, "answer", 7, undefined, deps);
  } finally {
    console.error = origErr;
    process.exitCode = prev;
  }
  assert.equal(cleared, false);
});

test("runUnblock passes the live candidate SHA into typed-request resume", async () => {
  const liveSha = "d".repeat(40);
  let seenSha: string | null | undefined;
  const deps: RunUnblockDeps = {
    getIssueDetail: async () => ({
      number: 7,
      type: "issue",
      title: "t",
      body: "b",
      state: "open",
      url: "u",
      labels: ["pipeline:review-1", "blocked"],
      comments: [],
    }) as never,
    postComment: async () => {},
    clearBlocked: async () => {},
    isKillSwitchActive: () => false,
    getGhActor: async () => "alice",
    getCandidateSha: async () => liveSha,
    fulfillTypedRequest: async (input) => {
      seenSha = input.candidateSha;
      return {
        resume: { ok: true, resume_target: "override-or-unblock", handoff_id: "h1" },
        handoff: null,
        fulfilled: true,
      };
    },
  };
  const origLog = console.log;
  console.log = () => {};
  const prev = process.exitCode;
  try {
    await _internals.runUnblock(makeCfg(), 7, "answer", 7, undefined, deps);
  } finally {
    console.log = origLog;
    process.exitCode = prev;
  }
  assert.equal(seenSha, liveSha);
});

test("fulfillTypedRequestAndValidateResume answers a pending handoff then validates", async () => {
  const pending = answeredFulfillmentHandoff({
    repoDir: "/repo",
    issueNumber: 7,
    answer: "pending",
    actor: "alice",
    candidateSha: null,
    resumeTarget: "override-or-unblock",
  });
  pending.status = "pending";
  pending.answer = null;
  pending.handoff_id = "h1";
  const result = await fulfillTypedRequestAndValidateResume(
    {
      repoDir: "/repo",
      issueNumber: 7,
      answer: "the answer",
      actor: "alice",
      candidateSha: null,
      resumeTarget: "override-or-unblock",
    },
    {
      listHandoffs: async () => [pending],
      answerAndPersistHandoff: async () => ({
        ok: true,
        duplicate: false,
        advances_item: false,
        handoff: { ...pending, status: "answered", answer: {
          decision: "answer",
          responder: "alice",
          identity_source: "gh",
          answer_text: "the answer",
          answered_at: "2026-01-01T00:00:00Z",
          payload_hash: "x",
        } },
      }),
    },
  );
  assert.equal(result.fulfilled, true);
  assert.equal(result.resume.ok, true);
});

test("runUnblock fails the contract if it only clears blocked without typed-request resume", async () => {
  const cfg = makeCfg();
  cfg.repo_dir = "/tmp";
  let resumeCalled = false;
  let cleared = false;
  const deps: RunUnblockDeps = {
    getIssueDetail: async () => ({
      number: 7,
      type: "issue",
      title: "t",
      body: "b",
      state: "open",
      url: "u",
      labels: ["pipeline:review-1", "blocked"],
      comments: [],
    }) as never,
    postComment: async () => {},
    clearBlocked: async () => {
      cleared = true;
    },
    isKillSwitchActive: () => false,
    getGhActor: async () => "alice",
    fulfillTypedRequest: async () => {
      resumeCalled = true;
      return {
        resume: { ok: true, resume_target: "override-or-unblock", handoff_id: "h1" },
        handoff: null,
        fulfilled: true,
      };
    },
  };
  const prev = process.exitCode;
  process.exitCode = 0;
  const origLog = console.log;
  console.log = () => {};
  try {
    await _internals.runUnblock(cfg, 7, "answer", 7, undefined, deps);
  } finally {
    console.log = origLog;
    process.exitCode = prev;
  }
  assert.equal(resumeCalled, true, "unblock must call typed-request resume, not only clear blocked");
  assert.equal(cleared, true);
});

test("runUnblock kill-switch performs no GitHub mutation", async () => {
  let posted = 0;
  let cleared = 0;
  const deps: RunUnblockDeps = {
    getIssueDetail: async () => {
      throw new Error("should not read github");
    },
    postComment: async () => {
      posted++;
    },
    clearBlocked: async () => {
      cleared++;
    },
    isKillSwitchActive: () => true,
  };
  const origErr = console.error;
  console.error = () => {};
  try {
    await _internals.runUnblock(makeCfg(), 7, "answer", 7, undefined, deps);
  } finally {
    console.error = origErr;
  }
  assert.equal(posted, 0);
  assert.equal(cleared, 0);
});

test("override mechanical fault after record stays owned", async () => {
  const sink = memoryObservationSink();
  const cfg = makeCfg();
  cfg.override_governance = {
    schema_version: 1,
    implicit: true,
    default_class: "low_risk_deferred",
    classes: {
      low_risk_deferred: {
        max_duration_hours: 720,
        required_evidence: [],
        renewal: { mode: "lite", require_human_on: [] },
        approvers: [{ kind: "trusted_override_actors_allowlist" }],
        separation_of_duties: { enabled: false, forbid_roles: [] },
      },
    },
  } as never;
  cfg.trusted_override_actors = ["alice"];
  const deps: RunOverrideDeps = {
    getIssueDetail: async () => ({
      number: 7,
      type: "issue",
      title: "t",
      body: "b",
      state: "open",
      url: "u",
      labels: ["pipeline:review-1"],
      comments: [],
    }) as never,
    postComment: async () => {},
    clearBlocked: async () => {},
    silentTransition: async () => {},
    runAdvance: async () => {
      throw new Error("mechanical fault after override");
    },
    getGhActor: async () => "alice",
    isKillSwitchActive: () => false,
    fulfillTypedRequest: async () => ({
      resume: { ok: true, resume_target: "override-or-unblock", handoff_id: "h1" },
      handoff: null,
      fulfilled: true,
    }),
    reportObservation: sink.reportObservation,
  };
  const orig = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  const prev = process.exitCode;
  try {
    await runOverride(cfg, 7, "abc12345: deferred #99", {} as CliOpts, deps, 7);
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    process.exitCode = prev;
  }
  assert.ok(sink.observations.some((o) => o.owned && !o.complete && !o.human_owned));
});

test("runStartPreflightGate failure reports an observation and spends no tokens", async () => {
  const sink = memoryObservationSink();
  let planning = 0;
  const failing: PreflightResult = {
    schema_version: 1,
    ok: false,
    checks: [
      {
        id: "github-auth",
        description: "auth",
        status: "fail",
        detail: "not logged in",
        remediation: "gh auth login",
      },
    ],
    ranAt: "2026-01-01T00:00:00Z",
  };
  const deps: PreflightCliDeps = {
    runPreflight: async () => failing,
    storePreflightResult: async () => {},
    reportObservation: sink.reportObservation,
  };
  const orig = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    const gate = await runStartPreflightGate(
      { ...makeCfg(), doctor: { runOnStart: true, failFast: false } } as PipelineConfig,
      {} as CliOpts,
      deps,
    );
    if (gate.proceed) planning++;
    assert.equal(gate.proceed, false);
  } finally {
    console.log = orig.log;
    console.error = orig.error;
  }
  assert.equal(planning, 0);
  assert.ok(sink.observations.length >= 1);
  assert.equal(sink.observations[0]!.owned, true);
  assert.ok(sink.observations[0]!.capability_request);
});

test("standalone doctor does not write recovery state", async () => {
  let recoveryWrites = 0;
  const failing: PreflightResult = {
    schema_version: 1,
    ok: false,
    checks: [{ id: "cli:gh", description: "gh", status: "fail", detail: "missing", remediation: "install gh" }],
    ranAt: "2026-01-01T00:00:00Z",
  };
  const deps: PreflightCliDeps = {
    runPreflight: async () => failing,
    storePreflightResult: async () => {},
    reportObservation: () => {
      recoveryWrites++;
    },
    writeRecoveryEpisode: () => {
      recoveryWrites++;
    },
  };
  const orig = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  const prev = process.exitCode;
  try {
    await runDoctor({ ...makeCfg(), doctor: { runOnStart: false, failFast: false } } as PipelineConfig, {} as CliOpts, deps);
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    process.exitCode = prev;
  }
  assert.equal(recoveryWrites, 0);
});

test("warn-only run-start preflight still proceeds", async () => {
  const deps: PreflightCliDeps = {
    runPreflight: async () => ({
      schema_version: 1,
      ok: true,
      checks: [{ id: "install:version-freshness", description: "fresh", status: "warn", detail: "stale", remediation: "npm ci" }],
      ranAt: "2026-01-01T00:00:00Z",
    }),
    storePreflightResult: async () => {},
  };
  const orig = console.log;
  console.log = () => {};
  try {
    const gate = await runStartPreflightGate(
      { ...makeCfg(), doctor: { runOnStart: true, failFast: false } } as PipelineConfig,
      {} as CliOpts,
      deps,
    );
    assert.equal(gate.proceed, true);
  } finally {
    console.log = orig;
  }
});

test("sweep skips unclassified worktree state", async () => {
  const rec: WorktreeRecord = { path: "/repo/.worktrees/mystery" };
  let removed = 0;
  const result = await sweepMergedWorktrees(makeCfg(), {
    listOnDisk: async () => [rec],
    getPrMergeState: async () => ({ merged: true, prNumber: 1, headSha: "abc" }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "abc",
    pathExists: () => true,
    removeWorktree: async () => {
      removed++;
      return { ok: true as const };
    },
    isFencedLiveOwner: () => false,
  });
  assert.equal(removed, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.reason, /unknown or unclassified/);
});

test("sweep skips a fenced live owner even when the PR is merged", async () => {
  const rec = makeRec(9, "live");
  let removed = 0;
  const result = await sweepMergedWorktrees(makeCfg(), {
    listOnDisk: async () => [rec],
    getPrMergeState: async () => ({ merged: true, prNumber: 9, headSha: "abc" }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "abc",
    pathExists: () => true,
    removeWorktree: async () => {
      removed++;
      return { ok: true as const };
    },
    isFencedLiveOwner: () => true,
  });
  assert.equal(removed, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.reason, /live owner/);
});

test("remove-worktree including --force refuses a fenced live owner", async () => {
  let gitRemove = 0;
  const rec = makeRec(42, "feat");
  const deps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => {
      gitRemove++;
    },
    pathExists: () => true,
    isFencedLiveOwner: () => true,
  };
  const clean = await removeWorktreeForIssue(makeCfg(), 42, {}, deps);
  const forced = await removeWorktreeForIssue(makeCfg(), 42, { force: true }, deps);
  assert.equal(clean.removed, false);
  assert.equal(forced.removed, false);
  assert.equal(gitRemove, 0);
  assert.match(clean.error ?? "", /live owner/);
});

test("bounded-atomic inspect-list forms never start a Logical Operation", () => {
  for (const id of ["init", "intake", "triage", "decompose.apply", "sweep.apply", "roadmap.apply"]) {
    const form = lookupCommandForm(id);
    assert.equal(form?.execution_disposition, "bounded-atomic-administration", id);
    assert.ok(form?.ownership_exception?.trim(), id);
  }
  const intake = readFileSync(join(__dirname, "../scripts/stages/intake.ts"), "utf8");
  const triage = readFileSync(join(__dirname, "../scripts/stages/triage.ts"), "utf8");
  const decompose = readFileSync(join(__dirname, "../scripts/stages/decompose.ts"), "utf8");
  const sweep = readFileSync(join(__dirname, "../scripts/stages/sweep.ts"), "utf8");
  for (const [name, src] of [["intake", intake], ["triage", triage], ["decompose", decompose], ["sweep", sweep]] as const) {
    assert.doesNotMatch(src, /mintLogicalOperationId/, `${name} must not mint a Logical Operation`);
    assert.doesNotMatch(src, /initRecoverableRun/, `${name} must not take run ownership`);
  }
});

test("synthetic process.exit(1) on a mechanical fault fails the expanded guard", () => {
  const hits = collectCommandLocalLifecycleExits(
    `async function run() {\n  // mechanical fault\n  process.exit(1);\n}\n`,
    "scripts/stages/queue.ts",
  );
  assert.ok(hits.some((h) => /process.exit/.test(h.reason)));
});

test("parser exit 2 is not a lifecycle terminal", () => {
  const hits = collectCommandLocalLifecycleExits(
    `if (badFlag) { process.exit(2); } // mechanical recovery exhaust\n`,
    "scripts/pipeline.ts",
  );
  assert.equal(hits.length, 0);
});

test("read-only form recovery write fixture fails", () => {
  const hits = collectReadOnlyRecoveryWrites(
    `export async function runStatus() { writeRecoveryEpisode({ id: 1 }); }\n`,
    "scripts/status-json.ts",
  );
  assert.ok(hits.some((h) => /writeRecoveryEpisode/.test(h.reason)));
});
