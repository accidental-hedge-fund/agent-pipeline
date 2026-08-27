// #1245: MAX_ITERATIONS fall-through at a non-terminal stage is an incomplete
// invocation — not a successful `done` summary. Injected I/O only.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MAX_ITERATIONS,
  autoLoopExhaustedBlockedOutcome,
  exhaustedWaitBlockerMapping,
  iterationBudgetExhaustedMessage,
  materializeExhaustedBlockedOutcome,
  runAdvance,
  type AdvanceDeps,
} from "../scripts/pipeline-run.ts";
import { runDirPath } from "../scripts/run-store.ts";
import {
  FACTORY_CONTROL_DIR_ENV,
  PRODUCTION_PIN_ENV,
} from "../scripts/production-engine-pin.ts";
import type { BlockerKind, Outcome, PipelineConfig, Stage } from "../scripts/types.ts";
import { STAGES } from "../scripts/types.ts";

const PIN = "a".repeat(40);
const ISSUE = 1245;
const ENGINE = {
  version: "1.40.0",
  root: "/skill/core",
  templates_fingerprint: "e".repeat(64),
  commit_sha: "f".repeat(40),
};

function withoutHostPinAuthorityEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const savedPin = process.env[PRODUCTION_PIN_ENV];
  const savedControl = process.env[FACTORY_CONTROL_DIR_ENV];
  delete process.env[PRODUCTION_PIN_ENV];
  delete process.env[FACTORY_CONTROL_DIR_ENV];
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      if (savedPin === undefined) delete process.env[PRODUCTION_PIN_ENV];
      else process.env[PRODUCTION_PIN_ENV] = savedPin;
      if (savedControl === undefined) delete process.env[FACTORY_CONTROL_DIR_ENV];
      else process.env[FACTORY_CONTROL_DIR_ENV] = savedControl;
    });
}

function auditComments(runId: string): { author: string; body: string }[] {
  return STAGES.filter((s) => s !== "ready" && s !== "backlog" && s !== "needs-spec").map((s) => ({
    author: "pipeline-bot",
    body: `## Pipeline: ${s}\n<!-- pipeline-audit: run=${runId} state=${s} -->`,
  }));
}

/** 12 advancing destinations from `ready` that land at `pre-merge` without dispatching it. */
const PRE_MERGE_FALLTHROUGH: Stage[] = [
  "planning",
  "plan-review",
  "pre-code-attestation",
  "implementing",
  "design-gate",
  "review-1",
  "fix-1",
  "review-2",
  "fix-2",
  "review-2",
  "fix-2",
  "pre-merge",
];

/** 12 advancing destinations from `ready` that land at `review-1` without dispatching it. */
const REVIEW_1_FALLTHROUGH: Stage[] = [
  "planning",
  "plan-review",
  "pre-code-attestation",
  "implementing",
  "design-gate",
  "implementing",
  "design-gate",
  "implementing",
  "design-gate",
  "implementing",
  "design-gate",
  "review-1",
];

/** 11 advancing destinations from `ready` that land at `pre-merge` so the 12th slot can dispatch it. */
const ELEVEN_TO_PRE_MERGE: Stage[] = [
  "planning",
  "plan-review",
  "pre-code-attestation",
  "implementing",
  "implementing",
  "design-gate",
  "review-1",
  "fix-1",
  "review-2",
  "fix-2",
  "pre-merge",
];

type DriveOpts = {
  startStage: Stage;
  advances: Stage[];
  lastOutcome?: Outcome;
  autoLoop?: PipelineConfig["auto_loop"];
  dryRun?: boolean;
  issue?: number;
};

type DriveResult = {
  logs: string[];
  exitCode: string | number | null | undefined;
  blocked: Array<{ reason: string; kind: BlockerKind | undefined; stage: Stage | null }>;
  releases: number;
  dispatchStages: Stage[];
  events: Record<string, unknown>[];
  autoLoopExhaustedComments: number;
};

async function driveAdvance(opts: DriveOpts): Promise<DriveResult> {
  assert.ok(
    opts.advances.length <= MAX_ITERATIONS,
    "scripted advances must not exceed MAX_ITERATIONS",
  );
  const issue = opts.issue ?? ISSUE;
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "iter-budget-"));
  const domain = `iter-budget-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stateDir = `/tmp/pipeline-${domain}`;
  const runId = `${issue}-2026-08-26T00-00-00-000Z`;
  const labels = [`pipeline:${opts.startStage}`];
  const comments = auditComments(runId);
  const blocked: DriveResult["blocked"] = [];
  let releases = 0;
  const dispatchStages: Stage[] = [];
  const logs: string[] = [];
  let advanceIdx = 0;
  let autoLoopExhaustedComments = 0;

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

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
    auto_loop: opts.autoLoop ?? {
      enabled: false,
      max_rounds: 3,
      max_wallclock_minutes: 60,
      stages: [],
    },
    papercuts: { enabled: false, auto_file: false },
    corrections: { auto_file: false },
  } as unknown as PipelineConfig;

  const detail = {
    number: issue,
    type: "issue" as const,
    title: "T",
    body: "B",
    state: "open",
    url: `https://example.test/${issue}`,
    labels,
    comments,
  };

  const deps: AdvanceDeps = {
    resolvePinnedEngineIdentity: () => ENGINE,
    probeEngineIdentity: () => null,
    enforceEngineTrack: async () => ({
      ok: true as const,
      track: "candidate" as const,
    }),
    releaseParkedWorktree: async () => {
      releases += 1;
      return {
        action: "released",
        reason: "safe managed worktree released",
        branch: null,
        worktree: null,
      };
    },
    setBlocked: async (_cfg, _n, reason, stage, kind) => {
      blocked.push({ reason, kind, stage: stage ?? null });
    },
    ensurePipelineLabels: async () => {},
    getIssueDetail: (async () => detail) as AdvanceDeps["getIssueDetail"],
    getGhActor: async () => "pipeline-bot",
    getPrForIssue: async () => null,
    getOnDiskForIssue: async () => ({ path: "/tmp/fake-wt", slug: "x" }),
    gitInWorktree: async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: `${PIN}\n`, stderr: "", code: 0 };
      if (args[0] === "diff") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "log") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    postComment: async (_cfg, _n, body) => {
      if (body.includes("Auto-Loop Budget Exhausted")) autoLoopExhaustedComments += 1;
    },
    postPrComment: async () => {},
    lastAdvancedCandidateSha: PIN,
    trustedSurfaceObjectSource: {
      listChangedPaths: async () => ({ paths: [] }),
      resolveBaseSha: async () => PIN,
    },
    dispatch: async (_cfg, _n, stage) => {
      dispatchStages.push(stage);
      if (advanceIdx < opts.advances.length) {
        const to = opts.advances[advanceIdx++];
        const idx = labels.findIndex((l) => l.startsWith("pipeline:"));
        if (idx >= 0) labels[idx] = `pipeline:${to}`;
        else labels.push(`pipeline:${to}`);
        return { advanced: true, from: stage, to, summary: `${stage} → ${to}` };
      }
      if (opts.lastOutcome) return opts.lastOutcome;
      throw new Error(`dispatch exhausted script at ${stage}`);
    },
  };

  const prevExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await withoutHostPinAuthorityEnv(() =>
      runAdvance(cfg, issue, { runId, dryRun: opts.dryRun }, deps),
    );
    const eventsPath = path.join(runDirPath(repoDir, runId), "events.jsonl");
    let events: Record<string, unknown>[] = [];
    if (fs.existsSync(eventsPath)) {
      events = fs
        .readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    }
    return {
      logs,
      exitCode: process.exitCode,
      blocked,
      releases,
      dispatchStages,
      events,
      autoLoopExhaustedComments,
    };
  } finally {
    process.exitCode = prevExit;
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function runComplete(events: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return [...events].reverse().find((e) => e.type === "run_complete");
}

function joinedLogs(logs: string[]): string {
  return logs.join("\n");
}

test("exhaustedWaitBlockerMapping: pre-merge is ci-exhausted; others are needs-human", () => {
  assert.deepEqual(exhaustedWaitBlockerMapping("pre-merge"), {
    blockerKind: "ci-exhausted",
    offrampPathTag: "ci-failed",
  });
  assert.deepEqual(exhaustedWaitBlockerMapping("review-1"), { blockerKind: "needs-human" });
  assert.deepEqual(exhaustedWaitBlockerMapping("eval-gate"), { blockerKind: "needs-human" });
});

test("autoLoopExhaustedBlockedOutcome keeps the auto-loop reason prefix", () => {
  const wait: Outcome = { advanced: false, status: "waiting", reason: "CI still running" };
  const out = autoLoopExhaustedBlockedOutcome(wait, "pre-merge");
  assert.equal(out.blockerKind, "ci-exhausted");
  assert.equal(out.reason, "auto-loop budget exhausted at pre-merge: CI still running");
});

test("materializeExhaustedBlockedOutcome uses the supplied iteration-budget reason", () => {
  const wait: Outcome = {
    advanced: false,
    status: "waiting",
    reason: iterationBudgetExhaustedMessage("pre-merge", ISSUE),
  };
  const out = materializeExhaustedBlockedOutcome(wait, "pre-merge", wait.reason);
  assert.equal(out.blockerKind, "ci-exhausted");
  assert.match(out.reason, /iteration budget exhausted/);
  assert.doesNotMatch(out.reason, /auto-loop budget exhausted/);
});

test("runAdvance: MAX_ITERATIONS fall-through at pre-merge is incomplete (#1245)", async () => {
  assert.equal(PRE_MERGE_FALLTHROUGH.length, MAX_ITERATIONS);
  const r = await driveAdvance({
    startStage: "ready",
    advances: PRE_MERGE_FALLTHROUGH,
  });
  const text = joinedLogs(r.logs);
  assert.doesNotMatch(text, /done — /);
  assert.match(
    text,
    /iteration budget exhausted at pre-merge; re-run pipeline 1245 to continue/,
  );
  assert.equal(r.exitCode, 1);
  assert.equal(r.dispatchStages.includes("pre-merge"), false, "pre-merge must not have been dispatched");
  const complete = runComplete(r.events);
  assert.ok(complete, "run_complete must still be written");
  assert.equal(complete.final_state, "pre-merge");
  assert.equal(complete.stop_reason, "iteration-budget-exhausted");
  assert.equal(complete.schema_version, 1);
  assert.equal(r.blocked.length, 1, "pre-merge fall-through must set a blocker");
  assert.equal(r.blocked[0].kind, "ci-exhausted");
  assert.match(r.blocked[0].reason, /iteration budget exhausted/);
  assert.doesNotMatch(r.blocked[0].reason, /auto-loop budget exhausted/);
  assert.ok(r.releases >= 1, "park-release must be attempted");
});

test("runAdvance: MAX_ITERATIONS fall-through at review-1 is incomplete without ci-exhausted", async () => {
  assert.equal(REVIEW_1_FALLTHROUGH.length, MAX_ITERATIONS);
  const r = await driveAdvance({
    startStage: "ready",
    advances: REVIEW_1_FALLTHROUGH,
  });
  const text = joinedLogs(r.logs);
  assert.doesNotMatch(text, /done — /);
  assert.match(
    text,
    /iteration budget exhausted at review-1; re-run pipeline 1245 to continue/,
  );
  assert.equal(r.exitCode, 1);
  assert.equal(r.blocked.length, 0, "review-1 must not park with ci-exhausted");
  assert.equal(r.releases, 0, "review-1 must not park-release");
  const complete = runComplete(r.events);
  assert.ok(complete);
  assert.equal(complete.final_state, "review-1");
  assert.equal(complete.stop_reason, "iteration-budget-exhausted");
});

test("runAdvance: waiting break on the last slot is not iteration-budget exhaustion", async () => {
  const r = await driveAdvance({
    startStage: "ready",
    advances: PRE_MERGE_FALLTHROUGH.slice(0, MAX_ITERATIONS - 1),
    lastOutcome: { advanced: false, status: "waiting", reason: "CI still running" },
  });
  const text = joinedLogs(r.logs);
  assert.doesNotMatch(text, /iteration budget exhausted/);
  assert.match(text, /done — /);
  assert.equal(r.exitCode === 1, false, "waiting stop must not set exitCode 1");
  const complete = runComplete(r.events);
  assert.ok(complete);
  assert.notEqual(complete.stop_reason, "iteration-budget-exhausted");
  assert.equal(r.blocked.length, 0);
});

test("runAdvance: dry-run fall-through prints exhausted line and skips GitHub park", async () => {
  const r = await driveAdvance({
    startStage: "ready",
    advances: PRE_MERGE_FALLTHROUGH,
    dryRun: true,
  });
  const text = joinedLogs(r.logs);
  assert.doesNotMatch(text, /done — /);
  assert.match(
    text,
    /iteration budget exhausted at pre-merge; re-run pipeline 1245 to continue/,
  );
  assert.equal(r.exitCode, 1);
  assert.equal(r.blocked.length, 0);
  assert.equal(r.releases, 0);
});

test("runAdvance: in-loop auto-loop exhaustion does not take the iteration-budget path", async () => {
  const r = await driveAdvance({
    startStage: "pre-merge",
    advances: [],
    lastOutcome: { advanced: false, status: "waiting", reason: "CI still running" },
    autoLoop: {
      enabled: true,
      max_rounds: 1,
      max_wallclock_minutes: 60,
      stages: ["pre-merge"],
    },
  });
  const text = joinedLogs(r.logs);
  assert.doesNotMatch(text, /iteration budget exhausted/);
  assert.match(text, /auto-loop budget exhausted/);
  assert.equal(r.exitCode === 1, false, "auto-loop park is not the iteration-budget exit");
  const complete = runComplete(r.events);
  assert.ok(complete);
  assert.notEqual(complete.stop_reason, "iteration-budget-exhausted");
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].kind, "ci-exhausted");
  assert.match(r.blocked[0].reason, /auto-loop budget exhausted/);
});

test("runAdvance: last-slot auto-loop continue then cap uses iteration-budget path", async () => {
  assert.equal(ELEVEN_TO_PRE_MERGE.length, MAX_ITERATIONS - 1);
  const r = await driveAdvance({
    startStage: "ready",
    advances: ELEVEN_TO_PRE_MERGE,
    lastOutcome: { advanced: false, status: "waiting", reason: "CI still running" },
    autoLoop: {
      enabled: true,
      max_rounds: 5,
      max_wallclock_minutes: 60,
      stages: ["pre-merge"],
    },
  });
  const text = joinedLogs(r.logs);
  assert.match(text, /auto-loop round /);
  assert.doesNotMatch(text, /auto-loop budget exhausted/);
  assert.equal(r.autoLoopExhaustedComments, 0);
  assert.match(
    text,
    /iteration budget exhausted at pre-merge; re-run pipeline 1245 to continue/,
  );
  assert.equal(r.exitCode, 1);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].kind, "ci-exhausted");
  assert.match(r.blocked[0].reason, /iteration budget exhausted/);
  assert.doesNotMatch(r.blocked[0].reason, /auto-loop budget exhausted/);
  const complete = runComplete(r.events);
  assert.ok(complete);
  assert.equal(complete.final_state, "pre-merge");
  assert.equal(complete.stop_reason, "iteration-budget-exhausted");
});
