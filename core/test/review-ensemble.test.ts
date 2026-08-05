// Unit tests for review ensemble (#645): pure merge + orchestration with
// injected invoke fakes. No real network, git, or subprocess I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNoEnsembleStageExecutorBypass,
  formatEnsembleIdentityLine,
  invokeReviewEnsemble,
  isEnsembleEnabled,
  isUsablePlanReviewOutput,
  mergeEnsembleVerdicts,
  mergePlanReviewOutputs,
  parsePlanReviewVerdictToken,
  resolveEnsembleAgents,
  tryParseUsableReviewVerdict,
} from "../scripts/review-ensemble.ts";
import { findingKey } from "../scripts/review-policy.ts";
import type { HarnessResult } from "../scripts/harness.ts";
import type { PipelineConfig, ReviewFinding, ReviewVerdict } from "../scripts/types.ts";
import { DEFAULT_CONFIG } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finding(
  partial: Partial<ReviewFinding> & Pick<ReviewFinding, "severity" | "title">,
): ReviewFinding {
  return {
    severity: partial.severity,
    title: partial.title,
    body: partial.body ?? partial.title,
    file: partial.file,
    line_start: partial.line_start,
    line_end: partial.line_end,
    confidence: partial.confidence ?? 0.8,
    recommendation: partial.recommendation ?? "fix it",
    category: partial.category,
    blocking: partial.blocking,
  };
}

function verdict(
  v: "approve" | "needs-attention",
  findings: ReviewFinding[] = [],
  summary = "summary",
): ReviewVerdict {
  return {
    verdict: v,
    summary,
    findings,
    next_steps: findings.length ? ["address findings"] : [],
    commitSha: "abc",
  };
}

function baseCfg(over: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    profile_name: "claude",
    invocation: "claude",
    review_mode: "prompt-harness",
    marker_footer: "<!-- pipeline -->",
    implementation_ready_message: "ready",
    conventions_default: "",
    domain: "test",
    repo: "acme/test",
    repo_dir: "/tmp/test",
    harnesses: {
      implementer: "claude",
      reviewer: "codex",
      implementerSource: "profile",
      reviewerSource: "profile",
    },
    ...over,
  } as PipelineConfig;
}

function okJson(v: ReviewVerdict): HarnessResult {
  return {
    success: true,
    stdout: "```json\n" + JSON.stringify(v) + "\n```\n",
    stderr: "",
    exit_code: 0,
    duration: 0.2,
    timed_out: false,
  };
}

function spawnErr(): HarnessResult {
  return {
    success: false,
    stdout: "",
    stderr: "spawn error: ENOENT",
    exit_code: -1,
    duration: 0,
    timed_out: false,
    spawn_error: true,
  };
}

function timeout(): HarnessResult {
  return {
    success: false,
    stdout: "",
    stderr: "timed out",
    exit_code: -1,
    duration: 9,
    timed_out: true,
  };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

test("isEnsembleEnabled: false when absent or disabled", () => {
  assert.equal(isEnsembleEnabled(baseCfg()), false);
  assert.equal(
    isEnsembleEnabled(
      baseCfg({
        review_ensemble: {
          enabled: false,
          agents: [{ role: "primary" }],
          min_usable_agents: 1,
          max_agents: 4,
        },
      }),
    ),
    false,
  );
});

test("isEnsembleEnabled: true when enabled", () => {
  assert.equal(
    isEnsembleEnabled(
      baseCfg({
        review_ensemble: {
          enabled: true,
          agents: [{ role: "primary" }, { harness: "claude" }],
          min_usable_agents: 1,
          max_agents: 4,
        },
      }),
    ),
    true,
  );
});

test("assertNoEnsembleStageExecutorBypass: allows stage_executor when ensemble disabled", () => {
  assert.doesNotThrow(() =>
    assertNoEnsembleStageExecutorBypass(
      baseCfg({
        stage_executors: { "plan-review": "local-ollama" },
      }),
      "plan-review",
    ),
  );
});

test("assertNoEnsembleStageExecutorBypass: allows ensemble without stage_executor", () => {
  assert.doesNotThrow(() =>
    assertNoEnsembleStageExecutorBypass(
      baseCfg({
        review_ensemble: {
          enabled: true,
          agents: [{ role: "primary" }],
          min_usable_agents: 1,
          max_agents: 4,
        },
      }),
      "plan-review",
    ),
  );
});

test("assertNoEnsembleStageExecutorBypass: throws when ensemble + plan-review stage_executor", () => {
  assert.throws(
    () =>
      assertNoEnsembleStageExecutorBypass(
        baseCfg({
          review_ensemble: {
            enabled: true,
            agents: [{ role: "primary" }],
            min_usable_agents: 1,
            max_agents: 4,
          },
          stage_executors: { "plan-review": "local-ollama" },
        }),
        "plan-review",
      ),
    /review_ensemble\.enabled cannot be combined with stage_executors\.plan-review/,
  );
});

test("assertNoEnsembleStageExecutorBypass: throws for review-1 and review-2 stage_executors", () => {
  const cfg = baseCfg({
    review_ensemble: {
      enabled: true,
      agents: [{ role: "primary" }],
      min_usable_agents: 1,
      max_agents: 4,
    },
    stage_executors: { "review-1": "local-ollama", "review-2": "local-ollama" },
  });
  assert.throws(
    () => assertNoEnsembleStageExecutorBypass(cfg, "review-1"),
    /stage_executors\.review-1/,
  );
  assert.throws(
    () => assertNoEnsembleStageExecutorBypass(cfg, "review-2"),
    /stage_executors\.review-2/,
  );
});

test("resolveEnsembleAgents: primary resolves to configured reviewer", () => {
  const cfg = baseCfg({
    review_ensemble: {
      enabled: true,
      agents: [{ role: "primary" }, { harness: "claude" }],
      min_usable_agents: 1,
      max_agents: 4,
    },
  });
  const agents = resolveEnsembleAgents(cfg);
  assert.equal(agents.length, 2);
  assert.equal(agents[0]!.role, "primary");
  assert.equal(agents[0]!.harness, "codex");
  assert.equal(agents[1]!.harness, "claude");
});

// ---------------------------------------------------------------------------
// Pure merge
// ---------------------------------------------------------------------------

test("mergeEnsembleVerdicts: union keeps a finding only one agent reported", () => {
  const fB = finding({
    severity: "high",
    title: "only B",
    file: "b.ts",
    line_start: 10,
  });
  const merged = mergeEnsembleVerdicts([
    { agentIndex: 0, verdict: verdict("approve", []) },
    { agentIndex: 1, verdict: verdict("needs-attention", [fB]) },
  ]);
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0]!.title, "only B");
  assert.equal(merged.verdict, "needs-attention", "no majority-vote approve");
});

test("mergeEnsembleVerdicts: findingKey dedupe collapses location-equivalent findings", () => {
  const a = finding({
    severity: "high",
    title: "leak risk",
    body: "from A",
    file: "x.ts",
    line_start: 12,
    confidence: 0.5,
  });
  const b = finding({
    severity: "high",
    title: "memory leak risk",
    body: "from B stronger",
    file: "x.ts",
    line_start: 13, // same lineBucket (11-15 → 11)
    confidence: 0.9,
  });
  assert.equal(findingKey(a), findingKey(b), "same key for location-equivalent");
  const merged = mergeEnsembleVerdicts([
    { agentIndex: 0, verdict: verdict("needs-attention", [a]) },
    { agentIndex: 1, verdict: verdict("needs-attention", [b]) },
  ]);
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0]!.confidence, 0.9, "max confidence wins");
  assert.equal(merged.findings[0]!.body, "from B stronger", "higher-confidence body wins on severity tie");
});

test("mergeEnsembleVerdicts: max confidence wins at same severity", () => {
  const low = finding({
    severity: "medium",
    title: "t",
    file: "f.ts",
    line_start: 1,
    confidence: 0.4,
    body: "low",
  });
  const high = finding({
    severity: "medium",
    title: "t2",
    file: "f.ts",
    line_start: 2,
    confidence: 0.9,
    body: "high",
  });
  assert.equal(findingKey(low), findingKey(high));
  const merged = mergeEnsembleVerdicts([
    { agentIndex: 0, verdict: verdict("needs-attention", [low]) },
    { agentIndex: 1, verdict: verdict("needs-attention", [high]) },
  ]);
  assert.equal(merged.findings[0]!.confidence, 0.9);
});

test("mergeEnsembleVerdicts: config-order tie-break is deterministic", () => {
  const a = finding({
    severity: "high",
    title: "same",
    body: "agent-0",
    file: "t.ts",
    line_start: 5,
    confidence: 0.8,
  });
  const b = finding({
    severity: "high",
    title: "same2",
    body: "agent-1",
    file: "t.ts",
    line_start: 5,
    confidence: 0.8,
  });
  assert.equal(findingKey(a), findingKey(b));
  const once = mergeEnsembleVerdicts([
    { agentIndex: 0, verdict: verdict("needs-attention", [a]) },
    { agentIndex: 1, verdict: verdict("needs-attention", [b]) },
  ]);
  const twice = mergeEnsembleVerdicts([
    { agentIndex: 0, verdict: verdict("needs-attention", [a]) },
    { agentIndex: 1, verdict: verdict("needs-attention", [b]) },
  ]);
  assert.equal(once.findings[0]!.body, "agent-0");
  assert.deepEqual(once, twice);
});

test("mergeEnsembleVerdicts: all agents approve with zero findings → approve", () => {
  const merged = mergeEnsembleVerdicts([
    { agentIndex: 0, verdict: verdict("approve", []) },
    { agentIndex: 1, verdict: verdict("approve", []) },
  ]);
  assert.equal(merged.verdict, "approve");
  assert.equal(merged.findings.length, 0);
});

test("mergeEnsembleVerdicts: blocking finding from either agent is kept (no majority approve)", () => {
  const blocker = finding({
    severity: "high",
    title: "blocker",
    file: "z.ts",
    line_start: 1,
    confidence: 0.95,
  });
  const merged = mergeEnsembleVerdicts([
    { agentIndex: 0, verdict: verdict("approve", []) },
    { agentIndex: 1, verdict: verdict("needs-attention", [blocker]) },
  ]);
  assert.equal(merged.verdict, "needs-attention");
  assert.equal(merged.findings.length, 1);
  assert.equal(findingKey(merged.findings[0]!), findingKey(blocker));
});

test("mergePlanReviewOutputs: any NEEDS_REVISION wins", () => {
  const a = "## Plan Review Verdict\nAPPROVE\n\n## Required Changes\n- None\n\n## Risks / Checks\n- None\n";
  const b =
    "## Plan Review Verdict\nNEEDS_REVISION\n\n## Required Changes\n- Add tests\n\n## Risks / Checks\n- Migration risk\n";
  const merged = mergePlanReviewOutputs([
    { agentIndex: 0, harness: "codex", text: a },
    { agentIndex: 1, harness: "claude", text: b },
  ]);
  assert.match(merged, /## Plan Review Verdict\nNEEDS_REVISION/);
  assert.match(merged, /Add tests/);
  assert.match(merged, /Migration risk/);
});

test("tryParseUsableReviewVerdict: full strict JSON fence is usable; garbage is not", () => {
  const ok = tryParseUsableReviewVerdict(
    '```json\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n```',
  );
  assert.ok(ok);
  assert.equal(ok!.verdict, "approve");
  assert.equal(tryParseUsableReviewVerdict("hello world no structure"), null);
});

test("tryParseUsableReviewVerdict: partial JSON approve missing required fields is unparseable (#645 43c9353b)", () => {
  // Missing summary / findings / next_steps — must NOT satisfy min_usable_agents.
  assert.equal(
    tryParseUsableReviewVerdict('```json\n{"verdict":"approve"}\n```'),
    null,
  );
  assert.equal(
    tryParseUsableReviewVerdict('{"verdict":"approve","findings":[]}'),
    null,
    "missing summary and next_steps",
  );
  assert.equal(
    tryParseUsableReviewVerdict(
      '```json\n{"verdict":"approve","summary":"ok","findings":"not-array","next_steps":[]}\n```',
    ),
    null,
  );
  // findings present but records lack required fields (severity/title/body/confidence/recommendation)
  assert.equal(
    tryParseUsableReviewVerdict(
      '```json\n{"verdict":"needs-attention","summary":"x","findings":[{"title":"bare"}],"next_steps":[]}\n```',
    ),
    null,
  );
});

test("isUsablePlanReviewOutput / parsePlanReviewVerdictToken: heading-only is unparseable (#645 43c9353b)", () => {
  assert.equal(isUsablePlanReviewOutput("## Plan Review Verdict"), false);
  assert.equal(isUsablePlanReviewOutput("## Plan Review Verdict\n\n"), false);
  assert.equal(
    isUsablePlanReviewOutput(
      "## Plan Review Verdict\n\n## Required Changes\n- None\n",
    ),
    false,
    "heading present but no APPROVE/NEEDS_REVISION token",
  );
  assert.equal(parsePlanReviewVerdictToken("copied heading only"), null);
  assert.equal(
    parsePlanReviewVerdictToken("## Plan Review Verdict\nAPPROVE\n"),
    "APPROVE",
  );
  assert.equal(
    parsePlanReviewVerdictToken(
      "## Plan Review Verdict\nNEEDS_REVISION\n\n## Required Changes\n- Add tests\n",
    ),
    "NEEDS_REVISION",
  );
  assert.equal(isUsablePlanReviewOutput("## Plan Review Verdict\nAPPROVE\n"), true);
});

test("invokeReviewEnsemble: sole agent with partial JSON approve fails closed (#645 43c9353b)", async () => {
  const inv = async (): Promise<HarnessResult> => ({
    success: true,
    stdout: '```json\n{"verdict":"approve"}\n```',
    stderr: "",
    exit_code: 0,
    duration: 0.1,
    timed_out: false,
  });
  const cfg = baseCfg({
    review_ensemble: {
      enabled: true,
      agents: [{ role: "primary" }, { harness: "claude" }],
      min_usable_agents: 1,
      max_agents: 4,
    },
  });
  const out = await invokeReviewEnsemble(cfg, {
    worktreeDir: "/wt",
    prompt: "p",
    implementer: "claude",
    kind: "structured",
    timeoutSec: 30,
    inv: inv as never,
  });
  assert.equal(out.result.success, false, "must not synthesize approve from malformed JSON");
  assert.equal(out.ensemble!.usable, 0);
  assert.equal(out.mergedVerdict, undefined);
  assert.ok(out.ensemble!.agents.every((a) => a.failureClass === "unparseable"));
});

test("invokeReviewEnsemble: sole agent with heading-only plan review fails closed (#645 43c9353b)", async () => {
  const inv = async (): Promise<HarnessResult> => ({
    success: true,
    stdout: "## Plan Review Verdict\n",
    stderr: "",
    exit_code: 0,
    duration: 0.1,
    timed_out: false,
  });
  const cfg = baseCfg({
    review_ensemble: {
      enabled: true,
      agents: [{ role: "primary" }, { harness: "claude" }],
      min_usable_agents: 1,
      max_agents: 4,
    },
  });
  const out = await invokeReviewEnsemble(cfg, {
    worktreeDir: "/wt",
    prompt: "p",
    implementer: "claude",
    kind: "plan-review",
    timeoutSec: 30,
    inv: inv as never,
  });
  assert.equal(out.result.success, false, "heading-only plan output must not soft-fail as approve");
  assert.equal(out.ensemble!.usable, 0);
  assert.ok(out.ensemble!.agents.every((a) => a.failureClass === "unparseable"));
});

// ---------------------------------------------------------------------------
// Orchestration with injected fakes
// ---------------------------------------------------------------------------

test("invokeReviewEnsemble: disabled path invokes exactly one reviewer", async () => {
  const calls: string[] = [];
  const inv = async (harness: string): Promise<HarnessResult> => {
    calls.push(harness);
    return okJson(verdict("approve", []));
  };
  const cfg = baseCfg();
  const out = await invokeReviewEnsemble(cfg, {
    worktreeDir: "/wt",
    prompt: "review me",
    implementer: "claude",
    kind: "structured",
    timeoutSec: 30,
    inv: inv as never,
  });
  assert.equal(out.ensemble, undefined);
  assert.equal(out.selfReview, false);
  assert.equal(out.result.success, true);
  assert.deepEqual(calls, ["codex"]);
});

test("invokeReviewEnsemble: concurrent multi-agent invoke count equals agent count", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: string[] = [];
  const inv = async (harness: string): Promise<HarnessResult> => {
    calls.push(harness);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return okJson(verdict("approve", []));
  };
  const cfg = baseCfg({
    review_ensemble: {
      enabled: true,
      agents: [{ role: "primary" }, { harness: "claude" }],
      min_usable_agents: 1,
      max_agents: 4,
    },
  });
  // When primary is codex and second is claude, and implementer is claude —
  // both are distinct for primary. Second agent harness is claude; no
  // self-review path unless spawn fails.
  const out = await invokeReviewEnsemble(cfg, {
    worktreeDir: "/wt",
    prompt: "shared prompt",
    implementer: "claude",
    kind: "structured",
    timeoutSec: 30,
    inv: inv as never,
  });
  assert.ok(out.ensemble);
  assert.equal(out.ensemble!.size, 2);
  assert.equal(out.ensemble!.usable, 2);
  assert.equal(calls.length, 2, "exactly two agent invokes");
  assert.ok(maxInFlight >= 2, `agents must run concurrently (maxInFlight=${maxInFlight})`);
  assert.equal(out.result.success, true);
  assert.match(out.result.stdout, /"verdict"/);
});

test("invokeReviewEnsemble: partial failure soft-fails when ≥1 usable", async () => {
  const inv = async (harness: string): Promise<HarnessResult> => {
    if (harness === "codex") {
      return okJson(
        verdict("needs-attention", [
          finding({ severity: "high", title: "bug", file: "a.ts", line_start: 1 }),
        ]),
      );
    }
    return timeout();
  };
  const cfg = baseCfg({
    review_ensemble: {
      enabled: true,
      agents: [{ role: "primary" }, { harness: "claude" }],
      min_usable_agents: 1,
      max_agents: 4,
    },
  });
  const out = await invokeReviewEnsemble(cfg, {
    worktreeDir: "/wt",
    prompt: "p",
    implementer: "claude",
    kind: "structured",
    timeoutSec: 30,
    inv: inv as never,
  });
  assert.equal(out.result.success, true);
  assert.equal(out.ensemble!.usable, 1);
  assert.equal(out.ensemble!.failed, 1);
  assert.equal(out.mergedVerdict!.findings.length, 1);
  const failed = out.ensemble!.agents.find((a) => a.status === "failed");
  assert.equal(failed?.failureClass, "timeout");
});

test("invokeReviewEnsemble: zero usable agents fail closed (never silent approve)", async () => {
  const inv = async (): Promise<HarnessResult> => timeout();
  const cfg = baseCfg({
    review_ensemble: {
      enabled: true,
      agents: [{ role: "primary" }, { harness: "claude" }],
      min_usable_agents: 1,
      max_agents: 4,
    },
  });
  const out = await invokeReviewEnsemble(cfg, {
    worktreeDir: "/wt",
    prompt: "p",
    implementer: "claude",
    kind: "structured",
    timeoutSec: 30,
    inv: inv as never,
  });
  assert.equal(out.result.success, false);
  assert.equal(out.ensemble!.usable, 0);
  assert.match(out.result.stderr, /failed closed/i);
  assert.equal(out.mergedVerdict, undefined);
});

test("invokeReviewEnsemble: per-agent self-review labeled; other agent stays independent", async () => {
  const inv = async (harness: string): Promise<HarnessResult> => {
    // codex (primary) spawn-fails → self-review via implementer claude
    if (harness === "codex") return spawnErr();
    // claude as second agent succeeds as independent (and as implementer fallback)
    return okJson(verdict("approve", []));
  };
  // Use grok as implementer so second agent "claude" is independent, and
  // primary codex falls back to grok self-review.
  const cfg = baseCfg({
    harnesses: {
      implementer: "grok",
      reviewer: "codex",
      implementerSource: "profile",
      reviewerSource: "profile",
    },
    review_ensemble: {
      enabled: true,
      agents: [{ role: "primary" }, { harness: "claude" }],
      min_usable_agents: 1,
      max_agents: 4,
    },
  });
  // fake: codex → spawn_error; grok (fallback) → ok; claude → ok
  const inv2 = async (harness: string): Promise<HarnessResult> => {
    if (harness === "codex") return spawnErr();
    return okJson(verdict("approve", []));
  };
  const out = await invokeReviewEnsemble(cfg, {
    worktreeDir: "/wt",
    prompt: "p",
    implementer: "grok",
    kind: "structured",
    timeoutSec: 30,
    inv: inv2 as never,
  });
  assert.equal(out.result.success, true);
  assert.equal(out.selfReview, true, "any agent self-review marks the round");
  const primary = out.ensemble!.agents.find((a) => a.role === "primary");
  const other = out.ensemble!.agents.find((a) => a.harness === "claude");
  assert.equal(primary?.selfReview, true);
  assert.equal(primary?.effectiveHarness, "grok");
  assert.equal(other?.selfReview, false);
  assert.equal(other?.status, "usable");
  // silence unused
  void inv;
});

test("formatEnsembleIdentityLine names agents", () => {
  const line = formatEnsembleIdentityLine({
    size: 2,
    usable: 2,
    failed: 0,
    merge: "union_blocking",
    agents: [
      {
        index: 0,
        role: "primary",
        harness: "codex",
        effectiveHarness: "codex",
        selfReview: false,
        status: "usable",
      },
      {
        index: 1,
        harness: "claude",
        effectiveHarness: "claude",
        selfReview: false,
        status: "usable",
      },
    ],
    summary: "ok",
  });
  assert.match(line, /Ensemble/);
  assert.match(line, /codex/);
  assert.match(line, /claude/);
});
