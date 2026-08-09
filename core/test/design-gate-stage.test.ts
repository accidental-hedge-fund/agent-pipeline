// Stage-level tests for the design-gate stage handler (#436). All GitHub and
// harness calls are injected via DesignGateDeps — no network, git, or
// subprocess operations happen in these tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceDesignGate, type DesignGateDeps } from "../scripts/stages/design_gate.ts";
import { encodeDesignGateState, DESIGN_GATE_COMMENT_HEADING, challengeKey } from "../scripts/design-gate.ts";
import { readBundle } from "../scripts/evidence-bundle.ts";
import type { PipelineConfig, DesignGateState } from "../scripts/types.ts";
import type { HarnessResult } from "../scripts/harness.ts";

function baseCfg(overrides: Partial<PipelineConfig["design_gate"]> = {}): PipelineConfig {
  return {
    profile_name: "codex",
    invocation: "$pipeline",
    review_mode: "prompt-harness",
    marker_footer: "—",
    implementation_ready_message: "ready",
    conventions_default: "CLAUDE.md",
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/tmp/does-not-exist",
    base_branch: "main",
    worktree_root: ".worktrees",
    max_concurrent_worktrees: 5,
    auto_recovery_max_retries: 2,
    implementation_timeout: 1200,
    review_timeout: 1200,
    fix_timeout: 1200,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: { implementer: "codex", reviewer: "claude", reviewerModel: undefined, reviewerEffort: undefined },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
    openspec: { enabled: "auto", bootstrap: false },
    last30days: { enabled: false, timeout: 600 },
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
    design_gate: {
      enabled: true,
      triggers: ["storage", "auth"],
      extra_triggers: {},
      max_rounds: 2,
      block_threshold: "medium",
      min_confidence: 0.6,
      limits: { max_decisions: 8, max_field_chars: 4000, max_artifact_bytes: 65_536 },
      ...overrides,
    },
    test_gate: { enabled: true, max_attempts: 3, timeout: 300 },
    eval_gate: { enabled: false, mode: "gate", timeout: 300, max_attempts: 2 },
    visual_gate: { enabled: false, mode: "gate", timeout: 900, max_attempts: 1, artifacts_dir: ".pipeline-visual" },
    shipcheck_gate: { enabled: false, mode: "advisory", max_rounds: 1, rubric_path: ".github/shipcheck-rubric.md", block_on_partial: false },
    review_policy: { block_threshold: "medium", min_confidence: 0.7, max_adversarial_rounds: 3 },
    doctor: { runOnStart: false, failFast: false },
    format_gate: [],
    harness_sandbox: false,
  } as unknown as PipelineConfig;
}

function harnessOk(stdout: string): HarnessResult {
  return { success: true, stdout, stderr: "", exit_code: 0, duration: 1, timed_out: false };
}
function harnessUnavailable(): HarnessResult {
  return { success: false, stdout: "", stderr: "boom", exit_code: 1, duration: 1, timed_out: false, spawn_error: true };
}

const DECISION_RECORD = {
  schema_version: 1,
  decisions: [
    {
      id: "d1",
      title: "Lock granularity",
      surface: "src/lock.ts",
      alternatives: [{ option: "global lock", rejected_because: "kills throughput" }],
      assumptions: ["single writer per shard"],
      invariants: ["shard id is stable"],
      evidence: ["src/lock.ts:42"],
      generalization_boundary: "single-region only",
      uncertainty: "medium",
    },
  ],
};

function decisionRecordOutput(): string {
  return "```json\n" + JSON.stringify(DECISION_RECORD) + "\n```";
}

function verdictOutput(verdict: "approve" | "needs-attention", n = 3, severity = "medium"): string {
  const challenges = Array.from({ length: n }, (_, i) => ({
    decision_id: "d1",
    title: `Challenge ${i}`,
    severity,
    confidence: 0.8,
    falsifier: "x",
    evidence_request: "y",
    required_action: "defend",
  }));
  return "```json\n" + JSON.stringify(verdict === "approve" ? { verdict, challenges: [] } : { verdict, challenges }) + "\n```";
}

function responseOutput(keys: string[], disposition = "defended"): string {
  return (
    "```json\n" +
    JSON.stringify({
      responses: keys.map((k) => ({ challengeKey: k, disposition, evidence: "see benchmark.md" })),
      decision_record: DECISION_RECORD,
    }) +
    "\n```"
  );
}

interface CallLog {
  transitions: Array<{ from: string; to: string }>;
  silentTransitions: Array<{ from: string; to: string }>;
  blocked: Array<{ reason: string; kind?: string }>;
  comments: string[];
  invokeCalls: number;
  /** #870: harness + model for each invoke. */
  invokeModels: Array<{ harness: string; model?: string }>;
}

function makeDeps(
  log: CallLog,
  invokeOutputs: HarnessResult[],
  opts: { issueComments?: { author: string; body: string }[] } = {},
): DesignGateDeps {
  let call = 0;
  return {
    getForIssue: async () => ({ path: "/tmp/wt", slug: "42-slug" }),
    getIssueDetail: async () =>
      ({
        number: 42,
        type: "issue",
        title: "Add sharded lock",
        body: "issue body",
        state: "open",
        url: "https://x",
        labels: [],
        comments: opts.issueComments ?? [{ author: "bot", body: "## Implementation Plan\n\nDo the thing." }],
      }) as any,
    getPrForIssue: async () => 7,
    getPrDetail: async () => ({ additions: 50, deletions: 5, changed_files: 2 }) as any,
    getPrDiff: async () => "diff --git a/src/db/repository.ts b/src/db/repository.ts\n",
    getGhActor: async () => "bot",
    transition: async (_c, _n, from, to) => { log.transitions.push({ from, to }); },
    silentTransition: async (_c, _n, from, to) => { log.silentTransitions.push({ from, to }); },
    setBlocked: async (_c, _n, reason, _stage, kind) => { log.blocked.push({ reason, kind }); },
    postComment: async (_c, _n, body) => { log.comments.push(body); },
    invoke: async (harness, _wt, _prompt, invOpts) => {
      log.invokeCalls++;
      log.invokeModels.push({ harness: String(harness), model: invOpts?.model });
      return invokeOutputs[Math.min(call++, invokeOutputs.length - 1)];
    },
  };
}

function makeLog(): CallLog {
  return { transitions: [], silentTransitions: [], blocked: [], comments: [], invokeCalls: 0, invokeModels: [] };
}

// ---------------------------------------------------------------------------
// no-trigger / disabled
// ---------------------------------------------------------------------------

test("design-gate: disabled — advances immediately, no harness call", async () => {
  const log = makeLog();
  const deps = makeDeps(log, []);
  const cfg = baseCfg({ enabled: false });
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true);
  if (result.advanced) assert.equal(result.to, "review-1");
  assert.equal(log.silentTransitions.length, 1);
  assert.equal(log.invokeCalls, 0);
});

test("design-gate: enabled but no trigger matched — advances immediately, no harness call", async () => {
  const log = makeLog();
  const deps = makeDeps(log, []);
  deps.getPrDiff = async () => "diff --git a/README.md b/README.md\n";
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true);
  if (result.advanced) assert.equal(result.to, "review-1");
  assert.equal(log.invokeCalls, 0);
});

// ---------------------------------------------------------------------------
// Worktree rematerialize (#882 recovery / #760)
// ---------------------------------------------------------------------------

test("design-gate: missing worktree + rematerialize pass continues (not false worktree-missing)", async () => {
  // Live #882 false-fail: ensureManagedWorktree returned result:"pass" with
  // reason "recreated from open PR head …" but design-gate checked === "ok"
  // and parked as worktree-missing with blockerKind undefined.
  const log = makeLog();
  const deps = makeDeps(log, [harnessOk(decisionRecordOutput()), harnessOk(verdictOutput("approve"))]);
  deps.getForIssue = async () => null;
  let ensureCalls = 0;
  deps.ensureManagedWorktree = async () => {
    ensureCalls += 1;
    return {
      result: "pass",
      worktree: { path: "/tmp/wt-remat", slug: "882-slug", branch: "pipeline/882-slug" },
      reason: "recreated from open PR head 93d8f70",
    };
  };
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(ensureCalls, 1, "must attempt rematerialize when on-disk worktree is missing");
  assert.equal(log.blocked.length, 0, `must not park after successful rematerialize; got: ${JSON.stringify(log.blocked)}`);
  assert.equal(result.advanced, true);
  if (result.advanced) assert.equal(result.to, "review-1");
  assert.equal(log.invokeCalls, 2, "decision record + challenge verdict must still run on rematerialized tree");
});

test("design-gate: missing worktree + rematerialize skipped with path continues (#874)", async () => {
  // EnsureManagedWorktreeResult "skipped" (already present / race recreate) is a
  // success variant when worktree path is present — must not false-park.
  const log = makeLog();
  const deps = makeDeps(log, [harnessOk(decisionRecordOutput()), harnessOk(verdictOutput("approve"))]);
  deps.getForIssue = async () => null;
  let ensureCalls = 0;
  deps.ensureManagedWorktree = async () => {
    ensureCalls += 1;
    return {
      result: "skipped",
      worktree: { path: "/tmp/wt-skipped", slug: "874-slug", branch: "pipeline/874-slug" },
      reason: "already present at /tmp/wt-skipped",
    };
  };
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(ensureCalls, 1);
  assert.equal(log.blocked.length, 0, `must not park after skipped rematerialize with path; got: ${JSON.stringify(log.blocked)}`);
  assert.equal(result.advanced, true);
  if (result.advanced) assert.equal(result.to, "review-1");
  assert.equal(log.invokeCalls, 2, "gate work must run from the skipped rematerialize path");
});

test("design-gate: missing worktree + rematerialize fail → worktree-missing park", async () => {
  const log = makeLog();
  const deps = makeDeps(log, []);
  deps.getForIssue = async () => null;
  deps.ensureManagedWorktree = async () => ({
    result: "fail",
    worktree: null,
    reason: "no recoverable remote branch",
    blockerKind: "worktree-missing",
  });
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, false);
  assert.equal((result as { status?: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0]?.kind, "worktree-missing");
  assert.match(log.blocked[0]?.reason ?? "", /rematerialize failed/);
  assert.equal(log.invokeCalls, 0);
});

test("design-gate: rematerialize skipped with null worktree → worktree-missing (no throw)", async () => {
  // #882 review-2: non-fail rematerialize with null worktree must not
  // dereference remat.worktree.path; park as recoverable worktree-missing.
  const log = makeLog();
  const deps = makeDeps(log, []);
  deps.getForIssue = async () => null;
  deps.ensureManagedWorktree = async () =>
    ({
      result: "skipped",
      worktree: null,
      reason: "already-present (stale fixture)",
    }) as Awaited<ReturnType<NonNullable<typeof deps.ensureManagedWorktree>>>;
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, false);
  assert.equal((result as { status?: string }).status, "blocked");
  assert.equal((result as { blockerKind?: string }).blockerKind, "worktree-missing");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0]?.kind, "worktree-missing");
  assert.match(log.blocked[0]?.reason ?? "", /without a worktree/);
  assert.equal(log.invokeCalls, 0);
});

// ---------------------------------------------------------------------------
// Clean approval
// ---------------------------------------------------------------------------

test("design-gate: triggered, clean approval — advances to review-1", async () => {
  const log = makeLog();
  const deps = makeDeps(log, [harnessOk(decisionRecordOutput()), harnessOk(verdictOutput("approve"))]);
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true);
  if (result.advanced) assert.equal(result.to, "review-1");
  assert.equal(log.transitions.at(-1)?.to, "review-1");
});

// ---------------------------------------------------------------------------
// Defense accepted
// ---------------------------------------------------------------------------

test("design-gate: defense accepted — advances to review-1", async () => {
  const log = makeLog();
  const round1Output = verdictOutput("needs-attention", 3);
  const round1 = JSON.parse(round1Output.replace(/```json\n|\n```/g, ""));
  const keys = round1.challenges.map((c: any) => challengeKey(c));
  const deps = makeDeps(log, [
    harnessOk(decisionRecordOutput()),
    harnessOk(round1Output),
    harnessOk(responseOutput(keys, "defended")),
    harnessOk(verdictOutput("approve")),
  ]);
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true);
  if (result.advanced) assert.equal(result.to, "review-1");
});

// ---------------------------------------------------------------------------
// Revision required
// ---------------------------------------------------------------------------

test("design-gate: revision required — decision record versioned, advances", async () => {
  const log = makeLog();
  const round1Output = verdictOutput("needs-attention", 3);
  const round1 = JSON.parse(round1Output.replace(/```json\n|\n```/g, ""));
  const keys = round1.challenges.map((c: any) => challengeKey(c));
  const deps = makeDeps(log, [
    harnessOk(decisionRecordOutput()),
    harnessOk(round1Output),
    harnessOk(responseOutput(keys, "revised")),
    harnessOk(verdictOutput("approve")),
  ]);
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true);
  if (result.advanced) assert.equal(result.to, "review-1");
  // The final comment's embedded state should carry 2 decision-record versions.
  const lastComment = log.comments.at(-1)!;
  const m = lastComment.match(/<!-- design-gate-state: ([A-Za-z0-9_-]+) -->/);
  assert.ok(m);
  const state = JSON.parse(Buffer.from(m![1], "base64url").toString("utf8")) as DesignGateState;
  assert.equal(state.decisionRecordVersions.length, 2);
});

// ---------------------------------------------------------------------------
// Recurring unresolved challenge — parks at needs-human
// ---------------------------------------------------------------------------

test("design-gate: recurring blocking challenge after response — parks at needs-human", async () => {
  const log = makeLog();
  const round1Output = verdictOutput("needs-attention", 3, "high");
  const round1 = JSON.parse(round1Output.replace(/```json\n|\n```/g, ""));
  const keys = round1.challenges.map((c: any) => challengeKey(c));
  const deps = makeDeps(log, [
    harnessOk(decisionRecordOutput()),
    harnessOk(round1Output),
    harnessOk(responseOutput(keys, "defended")),
    // Round 2 re-emits the SAME challenges (same decision_id/severity/title) as still blocking.
    harnessOk(round1Output),
  ]);
  const cfg = baseCfg({ max_rounds: 5 }); // budget not exhausted — recurrence must still park early
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true);
  if (result.advanced) assert.equal(result.to, "needs-human");
  assert.equal(log.transitions.at(-1)?.to, "needs-human");
});

// ---------------------------------------------------------------------------
// Round-budget exhaustion
// ---------------------------------------------------------------------------

test("design-gate: round budget exhausted with unresolved blocking challenge — parks at needs-human", async () => {
  const log = makeLog();
  const round1Output = verdictOutput("needs-attention", 3, "high");
  const deps = makeDeps(log, [
    harnessOk(decisionRecordOutput()),
    harnessOk(round1Output),
    // Response resolves nothing (malformed/empty responses array).
    harnessOk("```json\n" + JSON.stringify({ responses: [], decision_record: DECISION_RECORD }) + "\n```"),
  ]);
  const cfg = baseCfg({ max_rounds: 1 });
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true);
  if (result.advanced) assert.equal(result.to, "needs-human");
});

// ---------------------------------------------------------------------------
// Malformed reviewer output
// ---------------------------------------------------------------------------

test("design-gate: malformed reviewer verdict — one bounded re-ask, then blocks", async () => {
  const log = makeLog();
  const deps = makeDeps(log, [
    harnessOk(decisionRecordOutput()),
    harnessOk("not valid json"),
    harnessOk("still not valid"),
  ]);
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, false);
  if (!result.advanced) {
    assert.equal(result.status, "blocked");
    assert.equal(result.blockerKind, "design-gate-failed");
  }
  assert.equal(log.blocked.length, 1);
});

// ---------------------------------------------------------------------------
// Unavailable reviewer
// ---------------------------------------------------------------------------

test("design-gate: reviewer harness unavailable — blocks rather than advancing or skipping", async () => {
  const log = makeLog();
  const deps = makeDeps(log, [harnessOk(decisionRecordOutput()), harnessUnavailable()]);
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, false);
  if (!result.advanced) assert.equal(result.status, "blocked");
  assert.equal(log.transitions.length, 0);
  assert.equal(log.silentTransitions.length, 0);
});

// ---------------------------------------------------------------------------
// Crash/resume
// ---------------------------------------------------------------------------

test("design-gate: crash/resume — does not re-invoke the implementer for an already-persisted decision record", async () => {
  const state: DesignGateState = {
    schema_version: 1,
    trigger: { triggered: true, matched: [{ trigger: "storage", evidence: "path" }], reason: "triggered" },
    reviewerIdentity: { harness: "claude", independence: "independent" },
    decisionRecordVersions: [DECISION_RECORD],
    bounding: { fieldsTruncated: 0, decisionsDropped: 0, artifactBytesTruncated: false, decisionsDroppedByByteCeiling: 0, arrayEntriesDroppedByByteCeiling: 0 },
    rounds: [],
    outcome: null,
  };
  const priorComment = `${DESIGN_GATE_COMMENT_HEADING}\n\nDecision record recorded.\n\n${encodeDesignGateState(state)}`;
  const log = makeLog();
  const deps = makeDeps(
    log,
    [harnessOk(verdictOutput("approve"))],
    { issueComments: [{ author: "bot", body: "## Implementation Plan\n\nDo the thing." }, { author: "bot", body: priorComment }] },
  );
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true);
  if (result.advanced) assert.equal(result.to, "review-1");
  // Only ONE invoke call: the round-1 verdict. The decision record was reused
  // from the persisted comment, not re-requested from the implementer.
  assert.equal(log.invokeCalls, 1);
});

test("design-gate: crash before any verdict — resumes interrogation from the persisted decision record without re-running implementing", async () => {
  const state: DesignGateState = {
    schema_version: 1,
    trigger: { triggered: true, matched: [{ trigger: "storage", evidence: "path" }], reason: "triggered" },
    reviewerIdentity: null,
    decisionRecordVersions: [DECISION_RECORD],
    bounding: { fieldsTruncated: 0, decisionsDropped: 0, artifactBytesTruncated: false, decisionsDroppedByByteCeiling: 0, arrayEntriesDroppedByByteCeiling: 0 },
    rounds: [],
    outcome: null,
  };
  const priorComment = `${DESIGN_GATE_COMMENT_HEADING}\n\nDecision record recorded.\n\n${encodeDesignGateState(state)}`;
  const log = makeLog();
  const deps = makeDeps(
    log,
    [harnessOk(verdictOutput("approve"))],
    { issueComments: [{ author: "bot", body: priorComment }] },
  );
  const cfg = baseCfg();
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true);
  assert.equal(log.invokeCalls, 1);
});

// ---------------------------------------------------------------------------
// Evidence bundle recording
// ---------------------------------------------------------------------------

test("design-gate: untriggered run records only trigger reason in the evidence bundle", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pipeline-design-gate-"));
  try {
    const log = makeLog();
    const deps = makeDeps(log, []);
    deps.getPrDiff = async () => "diff --git a/README.md b/README.md\n";
    const cfg = baseCfg();
    await advanceDesignGate(cfg, 42, { stateDir }, deps);
    const bundle = await readBundle(stateDir, 42);
    assert.ok(bundle?.designInterrogation);
    assert.equal(bundle!.designInterrogation!.trigger.triggered, false);
    assert.equal(bundle!.designInterrogation!.trigger.reason, "no-trigger-matched");
    assert.equal(bundle!.designInterrogation!.decisionRecordVersions.length, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("design-gate: triggered run records the full chain in the evidence bundle", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pipeline-design-gate-"));
  try {
    const log = makeLog();
    const deps = makeDeps(log, [harnessOk(decisionRecordOutput()), harnessOk(verdictOutput("approve"))]);
    const cfg = baseCfg();
    await advanceDesignGate(cfg, 42, { stateDir }, deps);
    const bundle = await readBundle(stateDir, 42);
    assert.ok(bundle?.designInterrogation);
    assert.equal(bundle!.designInterrogation!.trigger.triggered, true);
    assert.equal(bundle!.designInterrogation!.outcome, "advanced");
    assert.equal(bundle!.designInterrogation!.decisionRecordVersions.length, 1);
    assert.ok(bundle!.designInterrogation!.reviewerIdentity);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #870 — unstructured models.review auto + entitlement
// ---------------------------------------------------------------------------

test("design-gate: unstructured models.review auto supplies concrete Claude model on invoke", async () => {
  const log = makeLog();
  const deps = makeDeps(log, [harnessOk(decisionRecordOutput()), harnessOk(verdictOutput("approve"))]);
  const cfg = baseCfg();
  // No structured review_harness model — only models.review auto provenance.
  cfg.harnesses.reviewerModel = undefined;
  cfg.models.review = "claude-fable-5";
  (cfg.models as { reviewWasAuto?: boolean }).reviewWasAuto = true;
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true);
  // First invoke is implementer (decision record); second is reviewer interrogation.
  const reviewerInvokes = log.invokeModels.filter((c) => c.harness === "claude");
  assert.ok(reviewerInvokes.length >= 1, "reviewer harness must be invoked");
  assert.equal(
    reviewerInvokes[0].model,
    "claude-fable-5",
    "unstructured auto must pass concrete --model, not undefined",
  );
});

test("design-gate: auto entitlement falls back to sonnet and does not treat entitlement text as verdict", async () => {
  const log = makeLog();
  const entitlement: HarnessResult = {
    success: false,
    stdout: "Fable 5 requires usage credits. Run /usage-credits to continue.",
    stderr: "HTTP 429",
    exit_code: 1,
    duration: 2,
    timed_out: false,
    throttled: true,
  };
  // decision record (codex) + fable fail + sonnet approve
  const deps = makeDeps(log, [
    harnessOk(decisionRecordOutput()),
    entitlement,
    harnessOk(verdictOutput("approve")),
  ]);
  const cfg = baseCfg();
  cfg.harnesses.reviewerModel = undefined;
  cfg.models.review = "claude-fable-5";
  (cfg.models as { reviewWasAuto?: boolean }).reviewWasAuto = true;
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true, `expected advance; blocked=${JSON.stringify(log.blocked)}`);
  const claudeModels = log.invokeModels.filter((c) => c.harness === "claude").map((c) => c.model);
  assert.ok(claudeModels.includes("claude-fable-5"), "preferred auto model first");
  assert.ok(claudeModels.includes("sonnet"), "allowlisted subscription fallback");
});

test("design-gate: prior null model identity is re-resolved under auto", async () => {
  const state: DesignGateState = {
    schema_version: 1,
    trigger: { triggered: true, matched: [{ trigger: "storage", evidence: "path" }], reason: "triggered" },
    // Missing model — legacy / incomplete identity under auto config (#870).
    reviewerIdentity: { harness: "claude", independence: "independent" },
    decisionRecordVersions: [DECISION_RECORD as any],
    bounding: {
      fieldsTruncated: 0,
      decisionsDropped: 0,
      artifactBytesTruncated: false,
      decisionsDroppedByByteCeiling: 0,
      arrayEntriesDroppedByByteCeiling: 0,
    },
    rounds: [],
    outcome: null,
  };
  const priorComment = `${DESIGN_GATE_COMMENT_HEADING}\n\nDecision record recorded.\n\n${encodeDesignGateState(state)}`;
  const log = makeLog();
  const deps = makeDeps(log, [harnessOk(verdictOutput("approve"))], {
    issueComments: [
      { author: "bot", body: "## Implementation Plan\n\nDo the thing." },
      { author: "bot", body: priorComment },
    ],
  });
  const cfg = baseCfg();
  cfg.harnesses.reviewerModel = undefined;
  cfg.models.review = "claude-fable-5";
  (cfg.models as { reviewWasAuto?: boolean }).reviewWasAuto = true;
  const result = await advanceDesignGate(cfg, 42, {}, deps);
  assert.equal(result.advanced, true);
  // Decision record already present — must not re-run implementer extraction.
  assert.equal(
    log.invokeModels.filter((c) => c.harness === "codex").length,
    0,
    "must not re-extract decision record when one already exists",
  );
  const claude = log.invokeModels.find((c) => c.harness === "claude");
  assert.equal(claude?.model, "claude-fable-5");
});
