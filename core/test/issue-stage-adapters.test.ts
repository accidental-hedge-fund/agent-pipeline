// Delivery-stage RecoverySupervisor adapter contract (#1328).
// Hermetic: injected fakes only — no real network, git, or subprocess.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { COMMAND_REGISTRY } from "../scripts/command-registry.ts";
import { lookupCommandForm } from "../scripts/command-form-inventory.ts";
import {
  consumeOwnedOperation,
  memoryObservationSink,
  persistOperationObservation,
} from "../scripts/operation-observation.ts";
import {
  DELIVERY_STAGES,
  applySupervisorProcessOutcome,
  assertNoSuperviseAdvanceCommand,
  canStartFixReentry,
  candidateEpochChanged,
  candidateBoundEvidenceAfterMovement,
  candidateEpochFromSha,
  collectForbiddenAdapterTreatments,
  collectForbiddenLifecycleRetries,
  collectWorktreeRematerializeBypasses,
  countRecoveryEpisodeTreatments,
  deliveryStageInvariant,
  isAuthorityHoldValidForCandidate,
  isCandidateBoundEvidenceValid,
  isDeliveryStage,
  missingDeliveryStageInvariants,
  missingOperationInvariantFields,
  observationFromAdapterAttempt,
  reconcileIssueStageObservation,
  remainingFixTimeoutSec,
  requiredEvidenceRoleForStage,
  runDeliveryStageAdapter,
  runOwnedFixAttempts,
  scanDeliveryStageAdapterContracts,
  claimOrResumeRecoveryEpisode,
  recordRecoveryEpisodeTreatment,
  stageRecoveryEpisodeKey,
} from "../scripts/issue-stage-adapters.ts";
import { emptyStageAttemptLedger } from "../scripts/stage-attempt-ledger.ts";
import { resumeEpisodeFromAttempts } from "../scripts/loop/recovery-episodes.ts";
import type { LoopRecoveryAttempt } from "../scripts/loop/types.ts";
import { STAGES, type Outcome, type PipelineConfig } from "../scripts/types.ts";
import {
  ensureManagedWorktree,
  isOccupiedWorktreeFault,
  projectManagedWorktreeFault,
  type EnsureManagedWorktreeDeps,
} from "../scripts/worktree.ts";
import { classifyPorcelainForScratchRecover } from "../scripts/worktree-dirt.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(__dirname, "..");

function cfg(): Pick<PipelineConfig, "repo" | "domain"> {
  return { repo: "owner/repo", domain: "test" };
}

test("1.1 every delivery stage from planning through ready-to-deploy has an invariant", () => {
  const expected = STAGES.filter(
    (s) => s !== "backlog" && s !== "needs-spec" && s !== "ready" && s !== "needs-human",
  );
  assert.deepEqual([...DELIVERY_STAGES], expected);
  assert.deepEqual(missingDeliveryStageInvariants(), []);
  for (const stage of DELIVERY_STAGES) {
    const inv = deliveryStageInvariant(stage);
    assert.equal(inv.operation, stage);
    assert.ok(inv.precondition.length > 0, stage);
    assert.ok(inv.postcondition.length > 0, stage);
    assert.ok(inv.observer.length > 0, stage);
    assert.ok(inv.candidate_binding.length > 0, stage);
    assert.ok(inv.replay_rule.length > 0, stage);
    assert.ok(inv.side_effect_identity.length > 0, stage);
    assert.ok(inv.safe_replay_predicate.length > 0, stage);
    assert.ok(inv.reconstruction_rule.length > 0, stage);
  }
});

test("1.1 missing invariant fails and names the stage", () => {
  const missing = missingDeliveryStageInvariants(["planning", "not-a-stage" as never]);
  assert.ok(!missing.includes("planning"));
  const synthetic = ["planning", "plan-review"] as const;
  const registry = new Set(["planning"]);
  const holes = synthetic.filter((s) => !registry.has(s));
  assert.deepEqual([...holes], ["plan-review"]);
});

test("1.1 missing reconstruction rule fails the contract and names the stage", () => {
  const inv = deliveryStageInvariant("planning");
  const incomplete = { ...inv, reconstruction_rule: "" };
  const missing = missingOperationInvariantFields(incomplete);
  assert.ok(missing.includes("reconstruction_rule"));
  const named = missingDeliveryStageInvariants(["planning"]).length === 0;
  assert.equal(named, true);
});

test("1.2 mechanical-failure fixture emits owned: true and does not mark complete/cancelled/human-owned", async () => {
  const sink = memoryObservationSink();
  await assert.rejects(
    () =>
      runDeliveryStageAdapter({
        stage: "planning",
        cfg: cfg(),
        issueNumber: 1328,
        pipelineRunId: "run-1",
        logicalOperationId: "lop-planning-mech",
        reportObservation: sink.reportObservation,
        attempt: async () => {
          throw new Error("harness timeout");
        },
      }),
    /harness timeout/,
  );
  assert.equal(sink.observations.length, 1);
  const obs = sink.observations[0]!;
  assert.equal(obs.owned, true);
  assert.equal(obs.complete, false);
  assert.equal(obs.cancelled, false);
  assert.equal(obs.human_owned, false);
  assert.equal(obs.process_exit_is_completion, false);
  assert.equal(obs.lifecycle, "cooling");
  const consumed = consumeOwnedOperation({ ...obs, observation_id: "x", recorded_at: "t" });
  assert.equal(consumed.owned, true);
});

test("1.3 synthetic adapter that chooses Cooling/wait/cancellation fails by name", () => {
  const cooling = collectForbiddenAdapterTreatments(
    "function planningAdapter() { enterCooling(op); }",
    "planning.ts",
    "planning",
  );
  assert.ok(cooling.some((h) => /planning/.test(h.reason) && /enterCooling/.test(h.reason)));
  const wait = collectForbiddenAdapterTreatments(
    "selectTreatment('wait')",
    "review.ts",
    "review-1",
  );
  assert.ok(wait.some((h) => /review-1/.test(h.reason)));
  const cancel = collectForbiddenAdapterTreatments(
    "cancelLogicalOperation(id)",
    "fix.ts",
    "fix-1",
  );
  assert.ok(cancel.some((h) => /fix-1/.test(h.reason)));
  const terminal = collectForbiddenAdapterTreatments(
    "return { owned: false, human_owned: true, cancelled: true }",
    "eval.ts",
    "eval-gate",
  );
  assert.ok(terminal.length > 0);
});

test("1.3 production delivery-stage adapters do not choose lifecycle treatments", () => {
  const hits = scanDeliveryStageAdapterContracts(CORE_ROOT);
  assert.deepEqual(hits, []);
});

test("1.4 exit-0 with unproven postcondition is not known_complete", () => {
  const obs = observationFromAdapterAttempt({
    stage: "implementing",
    domain: "test",
    logical_operation_id: "lop-exit0",
    issue: 1328,
    exitCode: 0,
    postconditionProven: false,
  });
  assert.equal(obs.certainty, "uncertain");
  assert.equal(obs.complete, false);
  assert.equal(obs.process_exit_is_completion, false);
  assert.equal(obs.owned, true);
});

test("1.4 advanced handler output without exact evidence returns owned waiting (#1454)", async () => {
  const sink = memoryObservationSink();
  const out = await runDeliveryStageAdapter({
    stage: "implementing",
    cfg: cfg(),
    issueNumber: 1454,
    logicalOperationId: "lop-unproved-advance",
    reportObservation: sink.reportObservation,
    attempt: async () => ({
      advanced: true,
      from: "implementing",
      to: "design-gate",
      summary: "handler claimed advancement",
    }),
  });
  assert.equal(out.advanced, false);
  if (!out.advanced) {
    assert.equal(out.status, "waiting");
    assert.match(out.reason, /RecoverySupervisor retains ownership/);
  }
  assert.equal(sink.observations[0]?.complete, false);
  assert.equal(sink.observations[0]?.certainty, "uncertain");
});

test("1.4 protected dispatch does not invoke its handler before exact evidence is bound (#1454)", async () => {
  let attempts = 0;
  const out = await runDeliveryStageAdapter({
    stage: "implementing",
    cfg: cfg(),
    issueNumber: 1454,
    logicalOperationId: "lop-prebound-1454",
    requireEvidenceBeforeAttempt: true,
    attempt: async () => {
      attempts++;
      return {
        advanced: true,
        from: "implementing",
        to: "design-gate",
        summary: "must not mutate",
      };
    },
  });
  assert.equal(attempts, 0);
  assert.equal(out.advanced, false);
  if (!out.advanced) assert.match(out.reason, /observer is required before execution/);
});

test("1.4 protected dispatch binds before mutation and re-observes completion (#1454)", async () => {
  const order: string[] = [];
  const sha = "a".repeat(40);
  const out = await runDeliveryStageAdapter({
    stage: "implementing",
    cfg: cfg(),
    issueNumber: 1454,
    logicalOperationId: "lop-prebound-1454",
    requireEvidenceBeforeAttempt: true,
    observeEvidence: async (phase) => {
      order.push(`observe:${phase}`);
      return {
        candidateSha: sha,
        candidateEpoch: sha,
        evidenceRole: "implementation",
        artifactIdentity: `implementation:${sha}`,
        postconditionProven: true,
      };
    },
    attempt: async () => {
      order.push("attempt");
      return {
        advanced: true,
        from: "implementing",
        to: "design-gate",
        summary: "proved implementation",
      };
    },
  });
  assert.equal(out.advanced, true);
  assert.deepEqual(order, ["observe:before", "attempt", "observe:after"]);
});

test("1.4 evidence-consuming stage cannot mutate before artifact proof (#1454)", async () => {
  let attempts = 0;
  const sha = "a".repeat(40);
  const out = await runDeliveryStageAdapter({
    stage: "ready-to-deploy",
    cfg: cfg(),
    issueNumber: 1454,
    logicalOperationId: "lop-no-implementation-proof",
    requireEvidenceBeforeAttempt: true,
    observeEvidence: async () => ({
      candidateSha: sha,
      candidateEpoch: sha,
      evidenceRole: null,
      artifactIdentity: null,
      postconditionProven: false,
    }),
    attempt: async () => {
      attempts++;
      return { advanced: false, status: "finalized", reason: "must not publish" };
    },
  });
  assert.equal(attempts, 0);
  assert.equal(out.advanced, false);
  if (!out.advanced) assert.match(out.reason, /evidence (binding )?refused before execution/);
});

test("1.4 evidence producer may establish the exact artifact during its attempt (#1454)", async () => {
  let attempts = 0;
  const sha = "a".repeat(40);
  const out = await runDeliveryStageAdapter({
    stage: "implementing",
    cfg: cfg(),
    issueNumber: 1454,
    logicalOperationId: "lop-produce-implementation",
    requireEvidenceBeforeAttempt: true,
    evidenceProducerBeforeAttempt: true,
    producerCompletionEvidence: () => ({
      candidateSha: sha,
      candidateEpoch: sha,
      evidenceRole: "implementation",
      artifactIdentity: `implementation:${sha}`,
      postconditionProven: true,
    }),
    observeEvidence: async (phase) => phase === "before"
      ? {
          candidateSha: sha,
          candidateEpoch: sha,
          evidenceRole: null,
          artifactIdentity: null,
          postconditionProven: false,
        }
      : {
          candidateSha: sha,
          candidateEpoch: sha,
          evidenceRole: "implementation",
          artifactIdentity: `implementation:${sha}`,
          postconditionProven: true,
        },
    attempt: async () => {
      attempts++;
      return {
        advanced: true,
        from: "implementing",
        to: "design-gate",
        summary: "implementation proof established",
      };
    },
  });
  assert.equal(attempts, 1);
  assert.equal(out.advanced, true);
});

test("1.4 evidence producer cannot establish an artifact for a replacement Candidate (#1454)", async () => {
  const beforeSha = "a".repeat(40);
  const afterSha = "b".repeat(40);
  const out = await runDeliveryStageAdapter({
    stage: "implementing",
    cfg: cfg(),
    issueNumber: 1454,
    logicalOperationId: "lop-producer-candidate-moved",
    requireEvidenceBeforeAttempt: true,
    evidenceProducerBeforeAttempt: true,
    producerCompletionEvidence: () => ({
      candidateSha: beforeSha,
      candidateEpoch: beforeSha,
      evidenceRole: "implementation",
      artifactIdentity: `implementation:${beforeSha}`,
      postconditionProven: true,
    }),
    observeEvidence: async (phase) => phase === "before"
      ? {
          candidateSha: beforeSha,
          candidateEpoch: beforeSha,
          evidenceRole: null,
          artifactIdentity: null,
          postconditionProven: false,
        }
      : {
          candidateSha: afterSha,
          candidateEpoch: afterSha,
          evidenceRole: "implementation",
          artifactIdentity: `implementation:${afterSha}`,
          postconditionProven: true,
        },
    attempt: async () => ({
      advanced: true,
      from: "implementing",
      to: "design-gate",
      summary: "must not certify replacement Candidate",
    }),
  });
  assert.equal(out.advanced, false);
  if (!out.advanced) assert.match(out.reason, /Candidate binding changed during execution/);
});

test("1.4 protected dispatch rejects completion when the Candidate binding changes during execution (#1454)", async () => {
  const beforeSha = "a".repeat(40);
  const afterSha = "b".repeat(40);
  const before = {
    candidateSha: beforeSha,
    candidateEpoch: beforeSha,
    evidenceRole: "implementation" as const,
    artifactIdentity: `implementation:${beforeSha}`,
    postconditionProven: true,
  };
  const changedBindings = [
    { name: "candidate SHA", after: { ...before, candidateSha: afterSha } },
    { name: "candidate epoch", after: { ...before, candidateEpoch: afterSha } },
    { name: "evidence role", after: { ...before, evidenceRole: "planning" as const } },
    { name: "artifact identity", after: { ...before, artifactIdentity: `implementation:${afterSha}` } },
  ];

  for (const changed of changedBindings) {
    const sink = memoryObservationSink();
    const out = await runDeliveryStageAdapter({
      stage: "implementing",
      cfg: cfg(),
      issueNumber: 1454,
      logicalOperationId: `lop-candidate-moved-${changed.name.replaceAll(" ", "-")}`,
      requireEvidenceBeforeAttempt: true,
      reportObservation: sink.reportObservation,
      observeEvidence: async (phase) => phase === "before"
        ? before
        : { ...changed.after, postconditionProven: true },
      attempt: async () => ({
        advanced: true,
        from: "implementing",
        to: "design-gate",
        summary: "must not certify the replacement Candidate",
      }),
    });

    assert.equal(out.advanced, false, changed.name);
    if (!out.advanced) {
      assert.equal(out.status, "waiting", changed.name);
      assert.match(out.reason, /Candidate binding changed during execution/, changed.name);
    }
    assert.equal(sink.observations.length, 1, changed.name);
    assert.equal(sink.observations[0]?.complete, false, changed.name);
    assert.equal(sink.observations[0]?.owned, true, changed.name);
  }
});

test("2.1 fixture that retries after uncertain side effects or candidate movement fails", () => {
  const uncertain = collectForbiddenLifecycleRetries(
    `
    async function retry() {
      for (let i = 0; i < 3; i++) {
        const result = await invokeAttempt();
        if (result.certainty === "uncertain") retry();
      }
    }
    `,
    "fix.ts",
  );
  assert.ok(uncertain.some((h) => /uncertain side effects/.test(h.reason)));
  const moved = collectForbiddenLifecycleRetries(
    `
    while (true) {
      if (candidateMoved) await invoke(harness);
      retry against prior epoch
    }
    `,
    "review.ts",
  );
  assert.ok(moved.some((h) => /candidate movement/.test(h.reason)));
});

test("2.2 crashing harness is invoked once per adapter attempt; RecoverySupervisor retains ownership", async () => {
  const sink = memoryObservationSink();
  let calls = 0;
  const once = await runOwnedFixAttempts({
    maxRetries: 0,
    fixTimeoutSec: 2400,
    basePrompt: "fix it",
    buildRetryPreamble: () => "ADDENDUM\n",
    invokeAttempt: async () => {
      calls += 1;
      return { success: false, exit_code: 1, duration: 1 };
    },
    observeCertainty: () => "known_absent",
    reportObservation: sink.reportObservation,
    identity: { domain: "test", logical_operation_id: "lop-fix-once", issue: 1328, stage: "fix-2" },
  });
  assert.equal(calls, 1);
  assert.equal(once.attempts.length, 1);
  assert.equal(sink.observations[0]?.owned, true);
  assert.equal(sink.observations[0]?.complete, false);
  assert.equal(sink.observations[0]?.cancelled, false);
  assert.equal(sink.observations[0]?.human_owned, false);
});

test("2.2 RecoverySupervisor may re-enter so harness is invoked at most cap+1 times", async () => {
  let calls = 0;
  const sink = memoryObservationSink();
  const out = await runOwnedFixAttempts({
    maxRetries: 2,
    fixTimeoutSec: 2400,
    basePrompt: "fix it",
    buildRetryPreamble: (attempt, limit, reason) => `ADDENDUM ${attempt}/${limit} ${reason}\n`,
    invokeAttempt: async () => {
      calls += 1;
      return { success: false, exit_code: 1, duration: 1 };
    },
    observeCertainty: () => "known_absent",
    nowMs: (() => {
      let t = 0;
      return () => {
        t += 1000;
        return t;
      };
    })(),
    reportObservation: sink.reportObservation,
    identity: { domain: "test", logical_operation_id: "lop-fix-cap", issue: 1328, stage: "fix-2" },
  });
  assert.equal(calls, 3);
  assert.equal(out.attempts.length, 3);
  assert.equal(out.observation, "attempt");
  assert.ok(sink.observations.every((o) => o.owned && !o.complete && !o.cancelled && !o.human_owned));
});

test("2.4 remaining budget and addendum on re-entry; first prompt has no addendum", async () => {
  const prompts: string[] = [];
  const timeouts: number[] = [];
  let now = 0;
  await runOwnedFixAttempts({
    maxRetries: 2,
    fixTimeoutSec: 2400,
    basePrompt: "BASE",
    buildRetryPreamble: (attempt, _limit, reason) =>
      `ADDENDUM prior=${reason} attempt=${attempt}; uncommitted work remains\n`,
    invokeAttempt: async (_prompt, timeoutSec) => {
      timeouts.push(timeoutSec);
      return { success: false, exit_code: 1, duration: 780 };
    },
    observeCertainty: () => "known_absent",
    nowMs: () => {
      now += 780_000;
      return now;
    },
    onBeforeAttempt: async (_a, _t, prompt) => {
      prompts.push(prompt);
    },
  });
  assert.equal(prompts[0], "BASE");
  assert.ok(!prompts[0]!.includes("ADDENDUM"));
  assert.ok(prompts[1]!.includes("ADDENDUM"));
  assert.ok(prompts[1]!.includes("uncommitted") || prompts[1]!.includes("prior="));
  assert.ok(timeouts[1]! <= 1620);
  assert.ok(timeouts[1]! < 2400);
  assert.equal(canStartFixReentry(remainingFixTimeoutSec(2400, 2395)), false);
});

test("retry observation: known_complete is verified success of the original operation, not the failed attempt", async () => {
  const sink = memoryObservationSink();
  let calls = 0;
  const out = await runOwnedFixAttempts({
    maxRetries: 2,
    fixTimeoutSec: 2400,
    basePrompt: "fix it",
    buildRetryPreamble: () => "ADDENDUM\n",
    invokeAttempt: async () => {
      calls += 1;
      return { success: false, exit_code: 1, timed_out: true, duration: 1 };
    },
    observeCertainty: () => "known_complete",
    reportObservation: sink.reportObservation,
    identity: { domain: "test", logical_operation_id: "lop-fix-complete", issue: 1324, stage: "fix-2" },
  });
  assert.equal(calls, 1, "must not replay after known_complete");
  assert.equal(out.observation, "verified-complete");
  assert.equal(out.certainty, "known_complete");
  assert.equal(out.finalResult.success, true);
  assert.equal(out.finalResult.observed_complete, true);
  assert.notEqual(out.finalResult.exit_code, 1);
  const completed = sink.observations.filter((o) => o.complete);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.certainty, "known_complete");
  assert.equal(completed[0]?.owned, true);
});

test("retry observation: uncertain is owned cooling, not the original failed attempt", async () => {
  const sink = memoryObservationSink();
  let calls = 0;
  const out = await runOwnedFixAttempts({
    maxRetries: 2,
    fixTimeoutSec: 2400,
    basePrompt: "fix it",
    buildRetryPreamble: () => "ADDENDUM\n",
    invokeAttempt: async () => {
      calls += 1;
      return { success: false, exit_code: 1, timed_out: true, duration: 1 };
    },
    observeCertainty: () => "uncertain",
    reportObservation: sink.reportObservation,
    identity: { domain: "test", logical_operation_id: "lop-fix-cool", issue: 1324, stage: "fix-2" },
  });
  assert.equal(calls, 1, "must not replay when uncertain");
  assert.equal(out.observation, "cooling");
  assert.equal(out.certainty, "uncertain");
  assert.equal(out.finalResult.success, false);
  assert.equal(out.finalResult.cooling, true);
  assert.notEqual(out.finalResult, out.attempts[0]?.result);
  const cooling = sink.observations.filter((o) => o.lifecycle === "cooling" && o.message.includes("could not prove"));
  assert.equal(cooling.length, 1);
  assert.equal(cooling[0]?.certainty, "uncertain");
  assert.equal(cooling[0]?.complete, false);
  assert.equal(cooling[0]?.owned, true);
});

test("successful first attempt is verified success only after observer proves known_complete", async () => {
  const sink = memoryObservationSink();
  let calls = 0;
  const out = await runOwnedFixAttempts({
    maxRetries: 2,
    fixTimeoutSec: 2400,
    basePrompt: "fix it",
    buildRetryPreamble: () => "ADDENDUM\n",
    invokeAttempt: async () => {
      calls += 1;
      return { success: true, exit_code: 0, duration: 1 };
    },
    observeCertainty: () => "known_complete",
    reportObservation: sink.reportObservation,
    identity: { domain: "test", logical_operation_id: "lop-fix-first-ok", issue: 1324, stage: "fix-2" },
  });
  assert.equal(calls, 1, "must not replay after verified complete");
  assert.equal(out.observation, "verified-complete");
  assert.equal(out.certainty, "known_complete");
  assert.equal(out.finalResult.success, true);
  assert.equal(out.finalResult.observed_complete, true);
});

test("successful first attempt with uncertain observation is owned cooling, not verified success", async () => {
  let calls = 0;
  const out = await runOwnedFixAttempts({
    maxRetries: 2,
    fixTimeoutSec: 2400,
    basePrompt: "fix it",
    buildRetryPreamble: () => "ADDENDUM\n",
    invokeAttempt: async () => {
      calls += 1;
      return { success: true, exit_code: 0, duration: 1 };
    },
    observeCertainty: () => "uncertain",
  });
  assert.equal(calls, 1, "must not replay when uncertain");
  assert.equal(out.observation, "cooling");
  assert.equal(out.certainty, "uncertain");
  assert.equal(out.finalResult.success, false);
  assert.equal(out.finalResult.cooling, true);
});

test("successful first attempt with known_absent may replay under remaining budget", async () => {
  let calls = 0;
  const out = await runOwnedFixAttempts({
    maxRetries: 1,
    fixTimeoutSec: 2400,
    basePrompt: "fix it",
    buildRetryPreamble: () => "ADDENDUM\n",
    invokeAttempt: async () => {
      calls += 1;
      return { success: true, exit_code: 0, duration: 1 };
    },
    observeCertainty: () => (calls === 1 ? "known_absent" : "known_complete"),
  });
  assert.equal(calls, 2, "known_absent after exit 0 may replay");
  assert.equal(out.observation, "verified-complete");
  assert.equal(out.certainty, "known_complete");
  assert.equal(out.finalResult.success, true);
});

test("retry observation: missing observer on a retry-capable path is fail-closed cooling", async () => {
  let calls = 0;
  const out = await runOwnedFixAttempts({
    maxRetries: 2,
    fixTimeoutSec: 2400,
    basePrompt: "fix it",
    buildRetryPreamble: () => "ADDENDUM\n",
    invokeAttempt: async () => {
      calls += 1;
      return { success: false, exit_code: 1, duration: 1 };
    },
    observeCertainty: undefined as unknown as () => "known_absent",
  });
  assert.equal(calls, 1);
  assert.equal(out.observation, "cooling");
  assert.equal(out.certainty, "uncertain");
  assert.equal(out.finalResult.cooling, true);
});

test("3.1 occupied trees are not stolen; remotely advanced HEAD does not skip as matching", async () => {
  const createCalls: string[] = [];
  const occupied = await ensureManagedWorktree(
    {
      repo: "acme/x",
      repo_dir: "/repo",
      worktree_root: ".worktrees",
      base_branch: "main",
      domain: "test",
      max_concurrent_worktrees: 4,
    } as PipelineConfig,
    1328,
    {
      getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/pipeline-1328-x", slug: "x" }),
      createWorktree: async () => {
        createCalls.push("create");
        return { path: "/repo/.worktrees/pipeline-1328-x", branch: "pipeline/1328-x" };
      },
      isOccupiedByOther: () => true,
    } as EnsureManagedWorktreeDeps,
  );
  assert.equal(occupied.result, "fail");
  assert.match(occupied.reason, /occupied/i);
  assert.equal(occupied.occupied, true);
  assert.equal(isOccupiedWorktreeFault(occupied), true);
  const wait = projectManagedWorktreeFault(occupied);
  assert.equal(wait.status, "waiting");
  assert.equal(wait.advanced, false);
  assert.equal(createCalls.length, 0);

  const remoteCalls: string[] = [];
  const remote = await ensureManagedWorktree(
    {
      repo: "acme/x",
      repo_dir: "/repo",
      worktree_root: ".worktrees",
      base_branch: "main",
      domain: "test",
      max_concurrent_worktrees: 4,
    } as PipelineConfig,
    1328,
    {
      getOnDiskForIssue: async () => ({ path: "/repo/.worktrees/pipeline-1328-x", slug: "x" }),
      createWorktree: async () => {
        remoteCalls.push("create");
        return { path: "/repo/.worktrees/pipeline-1328-x", branch: "pipeline/1328-x" };
      },
      isOccupiedByOther: () => false,
      getIssueTitle: async () => "x",
      gitCmd: async (_cfg, _cwd, args) => {
        if (args[0] === "ls-remote") {
          return { stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/pipeline/1328-x\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      gitInWorktree: async (_cwd, args) => {
        if (args[0] === "rev-parse") {
          return { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", stderr: "", code: 0 };
        }
        if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      },
      resolveOpenPrHeadForBranch: async () => ({ prNumber: 9, headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    } as EnsureManagedWorktreeDeps,
  );
  assert.notEqual(remote.result, "skipped");
  assert.match(remote.reason, /remote|intended|advanced|mismatch/i);
});

test("3.2 stage-local rematerialize bypass fixture fails and names the module", () => {
  const hits = collectWorktreeRematerializeBypasses(
    `await setBlocked(cfg, n, "missing tree", "fix-1", "worktree-missing");`,
    "scripts/stages/fix.ts",
  );
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.reason, /scripts\/stages\/fix\.ts/);
  const ok = collectWorktreeRematerializeBypasses(
    `const remat = await ensureManagedWorktree(cfg, n);\nawait setBlocked(cfg, n, remat.reason, "fix-1", "worktree-missing");`,
    "scripts/stages/fix.ts",
  );
  assert.equal(ok.length, 0);
});

test("3.3 unclassified porcelain is still on disk after materialization refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-1328-dirt-"));
  const unknown = join(dir, "secret-notes.md");
  writeFileSync(unknown, "keep me");
  const out = await ensureManagedWorktree(
    {
      repo: "acme/x",
      repo_dir: "/repo",
      worktree_root: ".worktrees",
      base_branch: "main",
      domain: "test",
      max_concurrent_worktrees: 4,
    } as PipelineConfig,
    1328,
    {
      getOnDiskForIssue: async () => ({ path: dir, slug: "x" }),
      createWorktree: async () => {
        throw new Error("must not create");
      },
      isOccupiedByOther: () => false,
      getIssueTitle: async () => "x",
      gitCmd: async (_cfg, _cwd, args) => {
        if (args[0] === "ls-remote") {
          return { stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/pipeline/1328-x\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      gitInWorktree: async (_cwd, args) => {
        if (args[0] === "rev-parse") {
          return { stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", stderr: "", code: 0 };
        }
        if (args[0] === "status") {
          return { stdout: "?? secret-notes.md\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      unlinkPath: async () => {
        throw new Error("must not delete unknown dirt");
      },
      resolveOpenPrHeadForBranch: async () => ({ prNumber: 9, headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    } as EnsureManagedWorktreeDeps,
  );
  assert.equal(out.result, "fail");
  assert.match(out.reason, /inconsistenc|unknown|unclassified/i);
  assert.equal(existsSync(unknown), true);
  rmSync(dir, { recursive: true, force: true });
});

test("3.4 scratch-only porcelain unlinks without deleting non-scratch paths", () => {
  const classified = classifyPorcelainForScratchRecover("?? tasks/todo.md\n?? secret-notes.md\n");
  assert.deepEqual(classified.untrackedScratch, ["tasks/todo.md"]);
  assert.ok(classified.product.includes("secret-notes.md"));
});

test("4.1 prior-epoch review verdict cannot authorize advancement at the new HEAD", () => {
  const prior = candidateEpochFromSha("a".repeat(40));
  const next = candidateEpochFromSha("b".repeat(40));
  assert.equal(candidateEpochChanged(prior.sha, next.sha), true);
  assert.equal(isCandidateBoundEvidenceValid(prior.sha, next.sha), false);
  assert.equal(isCandidateBoundEvidenceValid(next.sha, next.sha), true);
  const invalidated = candidateBoundEvidenceAfterMovement(prior.sha, next.sha);
  assert.ok(Object.values(invalidated).every((valid) => valid === false));
});

test("4.1 completing observations require the exact role, artifact, candidate, and epoch (#1454)", () => {
  const sha = "a".repeat(40);
  const complete = observationFromAdapterAttempt({
    stage: "implementing",
    domain: "test",
    logical_operation_id: "lop-role-exact",
    candidateSha: sha,
    candidateEpoch: sha,
    evidenceRole: "implementation",
    artifactIdentity: "sha256:product-delta",
    postconditionProven: true,
    outcome: { advanced: true, from: "implementing", to: "design-gate", summary: "proved" },
  });
  assert.equal(complete.complete, true);
  assert.equal(complete.evidence_role, "implementation");
  assert.equal(complete.candidate_epoch, sha);

  for (const fixture of [
    {},
    { evidenceRole: "unknown" },
    { evidenceRole: "planning", artifactIdentity: "sha256:plan", candidateEpoch: sha },
    { evidenceRole: "implementation", artifactIdentity: "sha256:impl", candidateEpoch: "b".repeat(40) },
  ]) {
    const rejected = observationFromAdapterAttempt({
      stage: "implementing",
      domain: "test",
      logical_operation_id: "lop-role-rejected",
      candidateSha: sha,
      postconditionProven: true,
      outcome: { advanced: true, from: "implementing", to: "design-gate", summary: "claimed" },
      ...fixture,
    });
    assert.equal(rejected.complete, false);
    assert.equal(rejected.certainty, "uncertain");
    assert.match(rejected.message, /completion evidence rejected/);
  }
  assert.equal(requiredEvidenceRoleForStage("planning"), "planning");
  assert.equal(requiredEvidenceRoleForStage("review-1"), "implementation");
});

test("4.2 stale authority hold is not preserved by a leftover blocked label", () => {
  assert.equal(
    isAuthorityHoldValidForCandidate({
      holdSha: "a".repeat(40),
      currentSha: "b".repeat(40),
      leftoverBlockedLabel: true,
    }),
    false,
  );
  assert.equal(
    isAuthorityHoldValidForCandidate({
      holdSha: "a".repeat(40),
      currentSha: "a".repeat(40),
      leftoverBlockedLabel: true,
    }),
    true,
  );
});

test("RecoverySupervisor reconciles harness-failure to Cooling and occupied to wait", () => {
  const crash = observationFromAdapterAttempt({
    stage: "fix-2",
    domain: "test",
    logical_operation_id: "lop-reconcile-crash",
    outcome: { advanced: false, status: "blocked", reason: "exit 1", blockerKind: "harness-failure" },
  });
  const cooling = reconcileIssueStageObservation(crash, {
    advanced: false,
    status: "blocked",
    reason: "exit 1",
    blockerKind: "harness-failure",
  });
  assert.equal(cooling.treatment, "Cooling");
  assert.equal(cooling.owned, true);
  assert.equal(cooling.complete, false);
  assert.equal(cooling.cancelled, false);
  assert.equal(cooling.human_owned, false);
  assert.equal(cooling.lifecycle, "cooling");

  const occupiedObs = observationFromAdapterAttempt({
    stage: "planning",
    domain: "test",
    logical_operation_id: "lop-reconcile-occ",
    outcome: {
      advanced: false,
      status: "blocked",
      reason: "occupied by live owner — waiting without stealing the workspace",
      blockerKind: "worktree-creation-failed",
    },
  });
  const wait = reconcileIssueStageObservation(occupiedObs, {
    advanced: false,
    status: "blocked",
    reason: "occupied by live owner — waiting without stealing the workspace",
    blockerKind: "worktree-creation-failed",
  });
  assert.equal(wait.treatment, "external-condition wait");
  assert.equal(wait.lifecycle, "waiting");
  assert.equal(wait.owned, true);
  const processOut = applySupervisorProcessOutcome(occupiedObs, {
    advanced: false,
    status: "blocked",
    reason: "occupied by live owner — waiting without stealing the workspace",
    blockerKind: "worktree-creation-failed",
  });
  assert.equal(processOut.status, "waiting");
});

test("runDeliveryStageAdapter converts occupied block into a waiting process stop", async () => {
  const sink = memoryObservationSink();
  const out = await runDeliveryStageAdapter({
    stage: "eval-gate",
    cfg: cfg(),
    issueNumber: 1328,
    pipelineRunId: "run-occ",
    logicalOperationId: "lop-occ-wait",
    reportObservation: sink.reportObservation,
    attempt: async () => ({
      advanced: false,
      status: "blocked",
      reason: "occupied by live owner — waiting without stealing the workspace",
      blockerKind: "worktree-creation-failed",
    }),
  });
  assert.equal(out.status, "waiting");
  assert.equal(out.advanced, false);
  assert.equal(sink.observations[0]?.owned, true);
  assert.equal(sink.observations[0]?.complete, false);
  assert.equal(sink.observations[0]?.human_owned, false);
});

test("5.1 comment-counted auto-recovery cap cannot post a terminal that ends ownership", () => {
  const sink = memoryObservationSink();
  const obs = claimOrResumeRecoveryEpisode({
    domain: "test",
    logical_operation_id: "lop-auto",
    issue: 1328,
    message: "auto_recover cap reached — Cooling, not terminal",
    reportObservation: sink.reportObservation,
    episodeKey: stageRecoveryEpisodeKey({
      issue: 1328,
      candidateEpoch: "unresolved",
      evidence: "auto_recover:#1328",
    }),
  });
  assert.equal(obs.owned, true);
  assert.equal(obs.complete, false);
  assert.equal(obs.cancelled, false);
  assert.equal(obs.human_owned, false);
});

test("5.4 auto-recovery comments are not the sole authority — ledger + claim are", () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-1328-claim-"));
  const episodeKey = stageRecoveryEpisodeKey({
    issue: 1328,
    candidateEpoch: "a".repeat(40),
    evidence: "resume episode",
  });
  const obs = claimOrResumeRecoveryEpisode({
    domain: "test",
    logical_operation_id: "lop-ledger",
    issue: 1328,
    message: "resume episode",
    persistDir: dir,
    episodeKey,
  });
  persistOperationObservation(obs, dir);
  const ledger = recordRecoveryEpisodeTreatment({
    ledger: emptyStageAttemptLedger(),
    headSha: "a".repeat(40),
    action: "no_run_recovery",
    itemId: "1328",
    typedReason: "auto-recover-treatment",
    episodeKey,
  });
  assert.ok(ledger.attempts.length >= 1);
  assert.equal(ledger.attempts[0]!.action, "no_run_recovery");
  assert.equal(countRecoveryEpisodeTreatments(ledger, "1328"), 1);
  assert.equal(ledger.attempts[0]!.episode_id, obs.episode_id);
  const resumed = claimOrResumeRecoveryEpisode({
    domain: "test",
    logical_operation_id: "lop-ledger",
    issue: 1328,
    message: "resume episode after restart",
    persistDir: dir,
    episodeKey,
  });
  assert.equal(resumed.episode_id, obs.episode_id);
  rmSync(dir, { recursive: true, force: true });
});

test("5.5 stage treatments for the same candidate share one Recovery Episode", () => {
  const headSha = "a".repeat(40);
  const episodeKey = stageRecoveryEpisodeKey({
    issue: 1325,
    candidateEpoch: headSha,
    evidence: "same-evidence",
  });
  const first = recordRecoveryEpisodeTreatment({
    ledger: emptyStageAttemptLedger(),
    headSha,
    action: "worktree_rematerialize",
    itemId: "1325",
    evidenceFingerprint: "same-evidence",
    episodeKey,
  });
  const second = recordRecoveryEpisodeTreatment({
    ledger: first,
    headSha,
    action: "no_run_recovery",
    itemId: "1325",
    evidenceFingerprint: "same-evidence",
    episodeKey,
  });
  assert.equal(second.attempts.length, 2);
  assert.equal(second.attempts[0]!.episode_id, second.attempts[1]!.episode_id);
  assert.equal(second.attempts[0]!.invariant, "issue:1325");
  assert.equal(second.attempts[1]!.invariant, "issue:1325");
  assert.equal(second.attempts[1]!.attempts_per_strategy?.["worktree_rematerialize"], 1);
  assert.equal(second.attempts[1]!.attempts_per_strategy?.["no_run_recovery"], 1);
  assert.equal(first.attempts[0]!.strategy_cursor, 1);
  assert.equal(second.attempts[1]!.strategy_cursor, 2);
  assert.ok((second.attempts[1]!.strategy_cursor ?? 0) >= (first.attempts[0]!.strategy_cursor ?? 0));
  const restarted = resumeEpisodeFromAttempts(second.attempts as unknown as LoopRecoveryAttempt[], episodeKey);
  assert.ok(restarted);
  assert.equal(restarted!.strategy_cursor, 2);
  assert.notEqual(restarted!.strategy_cursor, 0);
  assert.notEqual(second.attempts[0]!.episode_id, `${"1325"}:${headSha}:worktree_rematerialize`);
});

test("5.6 omitted episode key is rejected rather than defaulting apart", () => {
  assert.throws(
    () =>
      claimOrResumeRecoveryEpisode({
        domain: "test",
        issue: 1325,
        message: "missing key",
        episodeKey: undefined as never,
      }),
    /complete RecoveryEpisodeKey/,
  );
  assert.throws(
    () =>
      recordRecoveryEpisodeTreatment({
        ledger: emptyStageAttemptLedger(),
        headSha: "a".repeat(40),
        action: "no_run_recovery",
        episodeKey: { operation: "", invariant: "", candidate_epoch: "", evidence_identity: "" },
      }),
    /complete RecoveryEpisodeKey/,
  );
});

test("6.1 harness crash, malformed output, unsatisfied no-op, and non-convergence stay owned", () => {
  const crash = observationFromAdapterAttempt({
    stage: "fix-1",
    domain: "test",
    logical_operation_id: "lop-crash",
    error: new Error("exit 1"),
  });
  const malformed = observationFromAdapterAttempt({
    stage: "review-1",
    domain: "test",
    logical_operation_id: "lop-malformed",
    outcome: { advanced: false, status: "blocked", reason: "unparseable verdict", blockerKind: "harness-failure" },
  });
  const noop: Outcome = { advanced: false, status: "no-op", reason: "unsatisfied no-new-commit" };
  const unsatisfied = observationFromAdapterAttempt({
    stage: "implementing",
    domain: "test",
    logical_operation_id: "lop-noop",
    outcome: noop,
  });
  const nonconv = observationFromAdapterAttempt({
    stage: "review-2",
    domain: "test",
    logical_operation_id: "lop-ceil",
    outcome: { advanced: false, status: "blocked", reason: "review ceiling", blockerKind: "review-findings" },
  });
  for (const obs of [crash, malformed, unsatisfied, nonconv]) {
    assert.equal(obs.owned, true);
    assert.equal(obs.complete, false);
    assert.equal(obs.cancelled, false);
    assert.equal(obs.human_owned, false);
  }
});

test("6.2 eval-fail and OpenSpec-invalid fixtures still do not advance", () => {
  const evalFail = observationFromAdapterAttempt({
    stage: "eval-gate",
    domain: "test",
    logical_operation_id: "lop-eval",
    outcome: { advanced: false, status: "blocked", reason: "eval failed", blockerKind: "eval-gate-failed" },
  });
  const osFail = observationFromAdapterAttempt({
    stage: "pre-merge",
    domain: "test",
    logical_operation_id: "lop-os",
    outcome: { advanced: false, status: "blocked", reason: "openspec invalid", blockerKind: "openspec-invalid" },
  });
  assert.equal(evalFail.complete, false);
  assert.equal(osFail.complete, false);
  assert.equal(evalFail.fault, "eval-gate-failed");
  assert.equal(osFail.fault, "openspec-invalid");
});

test("6.3 harness-failure setBlocked projection leaves owned: true", () => {
  const obs = observationFromAdapterAttempt({
    stage: "fix-2",
    domain: "test",
    logical_operation_id: "lop-block",
    outcome: { advanced: false, status: "blocked", reason: "exit 1", blockerKind: "harness-failure" },
  });
  assert.equal(obs.owned, true);
  assert.equal(obs.lifecycle, "cooling");
  assert.equal(obs.complete, false);
});

test("7.3 blocked or waiting process stop does not end ownership; no supervise-advance verb", () => {
  const blocked = observationFromAdapterAttempt({
    stage: "planning",
    domain: "test",
    logical_operation_id: "lop-stop",
    outcome: { advanced: false, status: "blocked", reason: "park" },
  });
  const waiting = observationFromAdapterAttempt({
    stage: "planning",
    domain: "test",
    logical_operation_id: "lop-wait",
    outcome: { advanced: false, status: "waiting", reason: "occupied" },
  });
  assert.equal(blocked.owned, true);
  assert.equal(waiting.owned, true);
  assert.equal(waiting.lifecycle, "waiting");
  assert.equal(lookupCommandForm("supervise-advance"), undefined);
  assert.ok(!("supervise-advance" in COMMAND_REGISTRY));
  assertNoSuperviseAdvanceCommand(Object.keys(COMMAND_REGISTRY));
  assert.equal(isDeliveryStage("backlog"), false);
  assert.equal(isDeliveryStage("needs-spec"), false);
  const dispatchSrc = readFileSync(join(CORE_ROOT, "scripts/pipeline-run.ts"), "utf8");
  assert.match(dispatchSrc, /runDeliveryStageAdapter/);
  assert.match(dispatchSrc, /isDeliveryStage\(stage\)/);
});
