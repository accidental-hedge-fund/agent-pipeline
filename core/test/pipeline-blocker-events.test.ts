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
import { setBlocked } from "../scripts/gh.ts";
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
    // #762: pin enforcement fails closed without a pin/receipt; this test is
    // about blocker_set emission, so inject a coherent candidate track result.
    enforceEngineTrack: async () => ({
      ok: true as const,
      track: "candidate" as const,
      pin_version: undefined,
      git_sha: undefined,
    }),
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

// #763: non-live discovery channel must survive runAdvance → setBlocked.
// A review-batch (or manual) dispatch that parks must NOT stamp live-run.
test("runAdvance: review-batch discovery channel reaches setBlocked, not live-run (#763)", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-run-discovery-"));
  const domain = `discovery-ch-${process.pid}-${Date.now()}`;
  const stateDir = `/tmp/pipeline-${domain}`;
  const posted: string[] = [];
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
    number: 63,
    type: "issue",
    title: "T",
    body: "B",
    state: "open",
    url: "https://example.test/63",
    labels: ["pipeline:ready"],
    comments: [],
  };
  const runId = "63-2026-08-05T00-00-00-000Z";
  const deps: AdvanceDeps = {
    resolvePinnedEngineIdentity: () => null,
    probeEngineIdentity: () => null,
    enforceEngineTrack: async () => ({
      ok: true as const,
      track: "candidate" as const,
      pin_version: undefined,
      git_sha: undefined,
    }),
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
    // Simulate a stage that parks: call real setBlocked so it inherits the
    // module-level channel runAdvance stamped from AdvanceOpts / run.json.
    dispatch: async () => {
      await setBlocked(cfg, 63, "batch park", "ready", "needs-human", {
        getIssueDetail: async () => ({ labels: ["pipeline:ready"] }),
        addBlockedLabel: async () => {},
        postComment: async (_c, _n, body) => {
          posted.push(body);
        },
        sleep: async () => {},
      });
      return {
        advanced: false as const,
        status: "blocked" as const,
        reason: "batch park",
        blockerKind: "needs-human" as const,
      };
    },
  };
  try {
    await runAdvance(cfg, 63, { runId, discoveryChannel: "review-batch" }, deps);

    const runJsonPath = path.join(runDirPath(repoDir, runId), "run.json");
    const runMeta = JSON.parse(fs.readFileSync(runJsonPath, "utf8")) as {
      discovery_channel?: string;
    };
    assert.equal(
      runMeta.discovery_channel,
      "review-batch",
      "initRunDir must persist the non-live channel from AdvanceOpts",
    );

    assert.equal(posted.length, 1, "dispatch must post a blocker via setBlocked");
    assert.match(
      posted[0]!,
      /<!--\s*pipeline:discovery-channel review-batch\s*-->/,
      "blocker comment must inherit review-batch from runAdvance, not hardcode live-run",
    );
    assert.doesNotMatch(
      posted[0]!,
      /<!--\s*pipeline:discovery-channel live-run\s*-->/,
      "must not corrupt discovery-channel decomposition with live-run",
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// #763: resume must re-read persisted run.json.discovery_channel into setBlocked.
test("runAdvance: resume preserves persisted review-batch channel for setBlocked (#763)", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-run-discovery-resume-"));
  const domain = `discovery-resume-${process.pid}-${Date.now()}`;
  const stateDir = `/tmp/pipeline-${domain}`;
  const posted: string[] = [];
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
    number: 64,
    type: "issue",
    title: "T",
    body: "B",
    state: "open",
    url: "https://example.test/64",
    labels: ["pipeline:ready"],
    comments: [],
  };
  const runId = "64-2026-08-05T00-00-00-000Z";
  // Pre-seed a run.json as if a prior review-batch dispatch already initialized it.
  const seededRunDir = runDirPath(repoDir, runId);
  fs.mkdirSync(seededRunDir, { recursive: true });
  fs.writeFileSync(
    path.join(seededRunDir, "run.json"),
    `${JSON.stringify({
      schema_version: 1,
      run_id: runId,
      issue: 64,
      repo: "owner/repo",
      profile: null,
      started_at: "2026-08-05T00:00:00Z",
      discovery_channel: "review-batch",
    }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(seededRunDir, "events.jsonl"), "");
  fs.writeFileSync(path.join(seededRunDir, "terminal.log"), "");
  const deps: AdvanceDeps = {
    resolvePinnedEngineIdentity: () => null,
    probeEngineIdentity: () => null,
    enforceEngineTrack: async () => ({
      ok: true as const,
      track: "candidate" as const,
      pin_version: undefined,
      git_sha: undefined,
    }),
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
    dispatch: async () => {
      await setBlocked(cfg, 64, "resume park", "ready", "needs-human", {
        getIssueDetail: async () => ({ labels: ["pipeline:ready"] }),
        addBlockedLabel: async () => {},
        postComment: async (_c, _n, body) => {
          posted.push(body);
        },
        sleep: async () => {},
      });
      return {
        advanced: false as const,
        status: "blocked" as const,
        reason: "resume park",
        blockerKind: "needs-human" as const,
      };
    },
  };
  try {
    // No discoveryChannel in opts — must re-read review-batch from run.json.
    await runAdvance(cfg, 64, { runId }, deps);

    assert.equal(posted.length, 1);
    assert.match(
      posted[0]!,
      /<!--\s*pipeline:discovery-channel review-batch\s*-->/,
      "resume must propagate persisted run.json.discovery_channel into setBlocked",
    );
    assert.doesNotMatch(
      posted[0]!,
      /<!--\s*pipeline:discovery-channel live-run\s*-->/,
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// #762 review 2: two-track pin enforcement must not break ordinary product-repo
// advances. A non-factory host with no production pin must reach stages (not
// exit early with missing_pin). Pin authority for factory runs is the control
// checkout / override path, not every target product repoDir.
test("runAdvance: non-factory advance with no production pin does not refuse (#762)", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-run-nopin-"));
  const domain = `nopin-${process.pid}-${Date.now()}`;
  const stateDir = `/tmp/pipeline-${domain}`;
  let dispatchCalls = 0;
  let enforceCalls = 0;
  const cfg = {
    repo: "acme/widget",
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
    number: 42,
    type: "issue",
    title: "T",
    body: "B",
    state: "open",
    url: "https://example.test/42",
    labels: ["pipeline:ready"],
    comments: [],
  };
  const runId = "42-2026-08-05T00-00-00-000Z";
  const deps: AdvanceDeps = {
    resolvePinnedEngineIdentity: () => ({
      version: "1.30.0",
      root: "/skill/core",
      templates_fingerprint: "abc",
    }),
    probeEngineIdentity: () => null,
    // Must not be required for non-factory: if the default path wrongly calls
    // enforce under pinned intent without a pin, advance would refuse before
    // dispatch. Count calls to prove policy is inactive.
    enforceEngineTrack: async () => {
      enforceCalls += 1;
      return {
        ok: false as const,
        code: "missing_pin",
        message: "should not run for non-factory",
        remediation: "n/a",
      };
    },
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
    dispatch: async () => {
      dispatchCalls += 1;
      return {
        advanced: false,
        status: "blocked",
        reason: "merge conflict with base",
        blockerKind: "merge-conflict",
      };
    },
  };
  try {
    await runAdvance(cfg, 42, { runId }, deps);
    assert.equal(enforceCalls, 0, "non-factory advance must not invoke pin enforcement");
    assert.equal(dispatchCalls, 1, "non-factory advance must reach stages without a pin");
    // run.json may omit track when two-track policy is inactive
    const runJsonPath = path.join(runDirPath(repoDir, runId), "run.json");
    if (fs.existsSync(runJsonPath)) {
      const runJson = JSON.parse(fs.readFileSync(runJsonPath, "utf8")) as {
        engine?: { track?: string };
      };
      assert.equal(
        runJson.engine?.track,
        undefined,
        "non-factory inactive policy must not claim pinned/candidate track",
      );
    }
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("runAdvance: factory pin authority uses override path not product target (#762)", async () => {
  const productDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-run-product-"));
  const domain = `pin-auth-${process.pid}-${Date.now()}`;
  const stateDir = `/tmp/pipeline-${domain}`;
  const pinOverride = "/factory/control/.agent-pipeline/production-engine-pin.json";
  let seenRepoDir: string | null = null;
  let seenPinOverride: string | null | undefined = null;
  let dispatchCalls = 0;
  const cfg = {
    // Explicit pinned intent on a product target (not factory control repo id).
    repo: "acme/widget",
    domain,
    repo_dir: productDir,
    base_branch: "main",
    invocation: "pipeline",
    marker_footer: "*Automated by Claude Code Pipeline Skill*",
    engine_track: "pinned",
    production_engine_pin_path: pinOverride,
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
    number: 9,
    type: "issue",
    title: "T",
    body: "B",
    state: "open",
    url: "https://example.test/9",
    labels: ["pipeline:ready"],
    comments: [],
  };
  const runId = "9-2026-08-05T00-00-00-000Z";
  const deps: AdvanceDeps = {
    resolvePinnedEngineIdentity: () => ({
      version: "1.29.1",
      root: "/skill/core",
      templates_fingerprint: "abc",
    }),
    probeEngineIdentity: () => null,
    enforceEngineTrack: async (input) => {
      seenRepoDir = input.repoDir;
      seenPinOverride = input.pinPathOverride ?? null;
      assert.equal(input.intent, "pinned");
      return {
        ok: true as const,
        track: "pinned" as const,
        pin_version: "1.29.1",
        git_sha: undefined,
      };
    },
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
    dispatch: async () => {
      dispatchCalls += 1;
      return {
        advanced: false,
        status: "blocked",
        reason: "merge conflict with base",
        blockerKind: "merge-conflict",
      };
    },
  };
  try {
    await runAdvance(cfg, 9, { runId }, deps);
    assert.equal(dispatchCalls, 1, "pinned intent with pin override must reach stages");
    assert.equal(
      seenPinOverride,
      pinOverride,
      "enforce must receive production_engine_pin_path as pin authority override",
    );
    // repoDir passed to enforce is pin-authority dir (resolvePinAuthorityDir);
    // product target alone is not enough when override names factory pin.
    assert.ok(seenRepoDir, "enforce must be invoked with a pin-authority repoDir");
  } finally {
    fs.rmSync(productDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("runAdvance: product pinned without factory authority refuses (#762)", async () => {
  // Explicit pinned intent on a product target without factory-control dir or
  // pin path must refuse — must not treat product-local pin as authority.
  const productDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-run-noauth-"));
  const domain = `pin-noauth-${process.pid}-${Date.now()}`;
  const stateDir = `/tmp/pipeline-${domain}`;
  // Place a product-local pin that must NOT become authority.
  fs.mkdirSync(path.join(productDir, ".agent-pipeline"), { recursive: true });
  fs.writeFileSync(
    path.join(productDir, ".agent-pipeline", "production-engine-pin.json"),
    JSON.stringify({
      schema_version: 1,
      version: "1.29.1",
      tag: "v1.29.1",
      git_sha: null,
      git_sha_source: "unknown",
      frg_run_id: "frg-product-local",
      promoted_at: "2026-01-01T00:00:00Z",
    }),
  );
  let enforceCalls = 0;
  let dispatchCalls = 0;
  const cfg = {
    repo: "acme/widget",
    domain,
    repo_dir: productDir,
    base_branch: "main",
    invocation: "pipeline",
    marker_footer: "*Automated by Claude Code Pipeline Skill*",
    engine_track: "pinned",
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
    number: 11,
    type: "issue",
    title: "T",
    body: "B",
    state: "open",
    url: "https://example.test/11",
    labels: ["pipeline:ready"],
    comments: [],
  };
  const runId = "11-2026-08-05T00-00-00-000Z";
  const deps: AdvanceDeps = {
    resolvePinnedEngineIdentity: () => ({
      version: "1.29.1",
      root: "/skill/core",
      templates_fingerprint: "abc",
    }),
    probeEngineIdentity: () => null,
    enforceEngineTrack: async () => {
      enforceCalls += 1;
      return {
        ok: true as const,
        track: "pinned" as const,
        pin_version: "1.29.1",
        git_sha: undefined,
      };
    },
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
    dispatch: async () => {
      dispatchCalls += 1;
      return {
        advanced: false,
        status: "blocked",
        reason: "merge conflict with base",
        blockerKind: "merge-conflict",
      };
    },
  };
  try {
    await runAdvance(cfg, 11, { runId }, deps);
    assert.equal(
      enforceCalls,
      0,
      "must refuse before enforce when product has no factory pin authority",
    );
    assert.equal(dispatchCalls, 0, "must not reach stages without factory pin authority");
  } finally {
    fs.rmSync(productDir, { recursive: true, force: true });
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
