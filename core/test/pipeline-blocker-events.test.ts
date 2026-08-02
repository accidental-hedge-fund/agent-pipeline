import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";

import {
  autoLoopExhaustedBlockedOutcome,
  emitBlockedOutcomeEvents,
  isAutoLoopRecoverable,
  isHumanAuthorityBlocker,
  runAdvance,
  type AdvanceDeps,
} from "../scripts/pipeline-run.ts";
import { runDirPath, type RunStoreDeps } from "../scripts/run-store.ts";
import {
  buildStageDiagnostic,
  projectStageDiagnostic,
  type StageDiagnostic,
} from "../scripts/stage-diagnostic.ts";
import type { BlockerKind, Outcome, PipelineConfig } from "../scripts/types.ts";

const runStoreDeps = {} as RunStoreDeps;

function blocked(
  blockerKind: BlockerKind,
  offrampPathTag?: "ci-failed" | "merge-conflict" | "openspec-invalid",
  diagnostic?: StageDiagnostic,
): Extract<Outcome, { advanced: false; status: "blocked" }> {
  return {
    advanced: false,
    status: "blocked",
    reason: `${blockerKind} reason`,
    blockerKind,
    ...(diagnostic ? { diagnostic } : {}),
    ...(offrampPathTag ? { offrampPathTag } : {}),
  };
}

test("mechanical OpenSpec, merge, and test blocks emit blocker_set without human_intervention", async () => {
  const cases = [
    ["openspec-invalid", "openspec-invalid", "openspec-invalid"],
    ["merge-conflict", "merge-conflict", "merge-conflict"],
    ["test-gate-exhausted", "ci-failed", "ci-failed"],
  ] as const;

  for (const [kind, pathTag, expectedClass] of cases) {
    const blockerEvents: Record<string, unknown>[] = [];
    const interventionEvents: Record<string, unknown>[] = [];
    const event = await emitBlockedOutcomeEvents(
      "/run",
      42,
      "pre-merge",
      blocked(kind, pathTag),
      runStoreDeps,
      {
        randomUUID: () => `offramp-${kind}`,
        appendEvent: async (_runDir, payload) => {
          blockerEvents.push(payload as unknown as Record<string, unknown>);
          return true;
        },
        emitHumanIntervention: async (_runDir, payload) => {
          interventionEvents.push(payload as unknown as Record<string, unknown>);
        },
      },
    );

    assert.equal(blockerEvents.length, 1, `${kind} must retain canonical blocker evidence`);
    assert.equal(interventionEvents.length, 0, `${kind} is mechanical, not human authority`);
    assert.equal(event.blocker_kind, kind);
    assert.equal(event.offramp_class, expectedClass);
    assert.equal(event.offramp_id, `offramp-${kind}`);
    assert.equal(event.diagnostic?.detail.blocker_kind, kind);
    assert.equal(event.diagnostic?.detail.stage, "pre-merge");
    assert.equal(event.diagnostic?.detail.offramp_class, expectedClass);
  }
});

test("only explicit human-decision-required block emits paired human_intervention", async () => {
  const blockerEvents: Record<string, unknown>[] = [];
  const interventionEvents: Record<string, unknown>[] = [];
  const diagnostic = buildStageDiagnostic({
    blockerKind: "human-decision-required",
    reason: "human-decision-required reason",
    stage: "fix-1",
    authorityEvidence: [{
      category: "product-decision",
      finding_key: "deadbeef",
      finding_fingerprint: "0123456789abcdef",
      reviewed_sha: "abc1234",
    }],
  });
  const event = await emitBlockedOutcomeEvents(
    "/run",
    77,
    "fix-1",
    blocked("human-decision-required", undefined, diagnostic),
    runStoreDeps,
    {
      randomUUID: () => "authority-offramp",
      appendEvent: async (_runDir, payload) => {
        blockerEvents.push(payload as unknown as Record<string, unknown>);
        return true;
      },
      emitHumanIntervention: async (_runDir, payload) => {
        interventionEvents.push(payload as unknown as Record<string, unknown>);
      },
    },
  );

  assert.equal(blockerEvents.length, 1);
  assert.equal(event.blocker_kind, "human-decision-required");
  assert.equal(interventionEvents.length, 1);
  assert.equal(interventionEvents[0].kind, "product-judgment-required");
  assert.equal(interventionEvents[0].offramp_id, event.offramp_id);
});

test("human-decision-required kind without attested diagnostic emits no intervention", async () => {
  const interventions: unknown[] = [];
  await emitBlockedOutcomeEvents(
    "/run",
    78,
    "fix-1",
    blocked("human-decision-required"),
    runStoreDeps,
    {
      appendEvent: async () => true,
      emitHumanIntervention: async (_runDir, payload) => { interventions.push(payload); },
    },
  );
  assert.deepEqual(interventions, []);
});

test("blocker_set preserves the producer diagnostic exactly", async () => {
  const diagnostic = buildStageDiagnostic({
    blockerKind: "openspec-invalid",
    reason: "generated delta is invalid",
    stage: "plan-review",
  });
  const outcome: Extract<Outcome, { advanced: false; status: "blocked" }> = {
    ...blocked("openspec-invalid"),
    diagnostic,
  };

  const event = await emitBlockedOutcomeEvents(
    "/run",
    91,
    "plan-review",
    outcome,
    runStoreDeps,
    {
      randomUUID: () => "diagnostic-offramp",
      appendEvent: async () => true,
      emitHumanIntervention: async () => assert.fail("mechanical diagnostic must not emit human intervention"),
    },
  );

  assert.equal(event.diagnostic, diagnostic, "the emitter must transport, not regenerate, the diagnostic");
});

test("generic needs-human is not authority evidence", async () => {
  const interventions: unknown[] = [];
  const event = await emitBlockedOutcomeEvents(
    "/run",
    88,
    "review-2",
    blocked("needs-human"),
    runStoreDeps,
    {
      randomUUID: () => "generic-offramp",
      appendEvent: async () => true,
      emitHumanIntervention: async (_runDir, payload) => {
        interventions.push(payload);
      },
    },
  );

  assert.equal(isHumanAuthorityBlocker("needs-human"), false);
  assert.equal(isHumanAuthorityBlocker("human-decision-required"), false);
  assert.equal(interventions.length, 0);
  assert.equal(event.diagnostic?.reason_code, "workflow-state");
  assert.equal(event.diagnostic?.detail.stage, "review-2");
});

test("explicit authority is not eligible for mechanical auto-loop retry", () => {
  assert.equal(isAutoLoopRecoverable(blocked("human-decision-required")), false);
});

test("auto-loop exhaustion preserves typed blocks and materializes typed waits", () => {
  const openspec = blocked("openspec-invalid", "openspec-invalid");
  assert.equal(autoLoopExhaustedBlockedOutcome(openspec, "pre-merge"), openspec);

  const ciWait: Outcome = { advanced: false, status: "waiting", reason: "CI still running" };
  const exhaustedCi = autoLoopExhaustedBlockedOutcome(ciWait, "pre-merge");
  assert.equal(exhaustedCi.status, "blocked");
  assert.equal(exhaustedCi.reason, "auto-loop budget exhausted at pre-merge: CI still running");
  assert.equal(exhaustedCi.blockerKind, "ci-exhausted");
  assert.equal(exhaustedCi.offrampPathTag, "ci-failed");
  assert.equal(exhaustedCi.diagnostic?.detail.blocker_kind, "ci-exhausted");
  assert.equal(exhaustedCi.diagnostic?.reason_code, "implementation-ci");

  // A non-pre-merge expired wait is workflow state, never an engine defect:
  // `harness-failure` would project to `workflow-engine-defect` (run_fatal,
  // retry budget 1) and stop a whole durable loop run over an ordinary wait.
  const executorWait: Outcome = { advanced: false, status: "waiting", reason: "executor unavailable" };
  const exhaustedExecutor = autoLoopExhaustedBlockedOutcome(executorWait, "eval-gate");
  assert.equal(exhaustedExecutor.status, "blocked");
  assert.equal(exhaustedExecutor.blockerKind, "needs-human");
  assert.equal(exhaustedExecutor.diagnostic?.reason_code, "workflow-state");
  assert.notEqual(exhaustedExecutor.blockerKind, "harness-failure");
  const projected = projectStageDiagnostic(exhaustedExecutor.diagnostic);
  assert.equal(projected.blockerClass, "workflow-state");
  assert.equal(projected.disposition, "recover");
});

// ---------------------------------------------------------------------------
// Runtime wiring regression (#787): the REAL runAdvance loop must write the
// canonical blocker_set evidence to events.jsonl for a blocked stage outcome.
// Deleting the emission block in runAdvance must fail this test — a source-text
// pin cannot detect that. All I/O is injected via AdvanceDeps; the run store
// writes to a temp dir. No network, git, or subprocess.
// ---------------------------------------------------------------------------

test("runAdvance emits blocker_set with the producer diagnostic to events.jsonl (runtime wiring)", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-run-advance-"));
  // runStateDir/withLock derive host-local paths from the domain; a unique
  // domain confines this test's /tmp state, removed in the finally below.
  const domain = `blocker-events-${process.pid}-${Date.now()}`;
  const stateDir = `/tmp/pipeline-${domain}`;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "merge conflict with base",
    stage: "ready",
  });
  const cfg = {
    repo: "owner/repo",
    domain,
    repo_dir: repoDir,
    base_branch: "main",
    invocation: "pipeline",
    marker_footer: "*Automated by Claude Code Pipeline Skill*",
    harnesses: {
      implementer: "claude",
      implementerSource: "default",
      reviewer: "codex",
      reviewerSource: "default",
    },
    steps: { standard_review: true, adversarial_review: true },
    auto_loop: { enabled: false, max_rounds: 3, max_wallclock_minutes: 60, stages: [] },
    papercuts: { enabled: false, auto_file: false },
    corrections: { auto_file: false },
  } as unknown as PipelineConfig;
  const detail = {
    number: 7,
    type: "issue",
    title: "T",
    body: "B",
    state: "open",
    url: "https://example.test/7",
    labels: ["pipeline:ready"],
    comments: [],
  };
  const runId = "7-2026-08-01T00-00-00-000Z";
  const deps: AdvanceDeps = {
    resolvePinnedEngineIdentity: () => null,
    probeEngineIdentity: () => null,
    releaseParkedWorktree: async () => ({
      action: "absent",
      reason: "no managed worktree",
      branch: null,
      worktree: null,
    }),
    ensurePipelineLabels: async () => {},
    getIssueDetail: (async () => detail) as AdvanceDeps["getIssueDetail"],
    getGhActor: async () => "pipeline-bot",
    getPrForIssue: async () => null,
    getOnDiskForIssue: async () => null,
    postComment: async () => {},
    postPrComment: async () => {},
    dispatch: async () => ({
      advanced: false,
      status: "blocked",
      reason: "merge conflict with base",
      blockerKind: "merge-conflict",
      diagnostic,
    }),
  };
  try {
    await runAdvance(cfg, 7, { runId }, deps);
    const eventsPath = path.join(runDirPath(repoDir, runId), "events.jsonl");
    const events = fs
      .readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const blockerEvents = events.filter((e) => e.type === "blocker_set");
    assert.equal(
      blockerEvents.length,
      1,
      "the real advance loop must emit exactly one blocker_set for a blocked outcome",
    );
    const event = blockerEvents[0];
    assert.equal(event.stage, "ready");
    assert.equal(event.blocker_kind, "merge-conflict");
    assert.equal(event.reason, "merge conflict with base");
    assert.deepEqual(event.diagnostic, diagnostic, "the producer diagnostic must be transported into the event");
    assert.equal(typeof event.offramp_id, "string");
    // Mechanical block: canonical evidence only — no human_intervention.
    assert.equal(events.some((e) => e.type === "human_intervention"), false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("auto-loop exhaustion branch does not transition or emit generic human intervention", () => {
  const source = readFileSync(new URL("../scripts/pipeline-run.ts", import.meta.url), "utf8");
  const start = source.indexOf("} else if (eligible && autoLoopRoundsSpent > 0) {");
  const end = source.indexOf("} else {", start + 1);
  assert.ok(start >= 0 && end > start, "auto-loop exhaustion branch must exist");
  const branch = source.slice(start, end);

  assert.doesNotMatch(branch, /transition\([^)]*["']needs-human["']/s);
  assert.doesNotMatch(branch, /emitHumanIntervention\(/);
  assert.match(branch, /autoLoopExhaustedBlockedOutcome\(out, stage\)/);
  assert.match(branch, /out = exhaustedOutcome/);
});
