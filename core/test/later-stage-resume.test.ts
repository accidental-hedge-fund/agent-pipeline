// #1462: later-stage resume must reconcile review currency before dispatch.
// Injected I/O only — no live network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  runAdvance,
  type AdvanceDeps,
} from "../scripts/pipeline-run.ts";
import {
  FACTORY_CONTROL_DIR_ENV,
  PRODUCTION_PIN_ENV,
} from "../scripts/production-engine-pin.ts";
import { STAGES, type PipelineConfig, type Stage } from "../scripts/types.ts";
import type { PrDetail } from "../scripts/types.ts";

const SHA_S = "1".repeat(40);
const SHA_H = "2".repeat(40);
const SHA_INTERNAL = "3".repeat(40);
const ISSUE = 1462;
const PR = 1459;

const PIPELINE_RUN_SRC = readFileSync(
  fileURLToPath(new URL("../scripts/pipeline-run.ts", import.meta.url)),
  "utf8",
);
const NESTED_ADVANCE_SRC = readFileSync(
  fileURLToPath(new URL("../scripts/nested-advance.ts", import.meta.url)),
  "utf8",
);
const PIPELINE_SRC = readFileSync(
  fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url)),
  "utf8",
);

const ENGINE = {
  version: "1.40.1",
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

function nextStage(stage: Stage): Stage {
  const i = STAGES.indexOf(stage);
  const next = STAGES[i + 1];
  if (!next || next === "needs-human") {
    throw new Error(`no successor for ${stage}`);
  }
  return next;
}

function reviewComment(sha: string): string {
  return `## Review 2 (Adversarial) — approve\n\n<!-- reviewed-sha: ${sha} -->`;
}

function prDetail(headSha: string): PrDetail {
  return {
    number: PR,
    title: "T",
    body: "B",
    state: "open",
    url: `https://example.test/pull/${PR}`,
    head_ref: `pipeline/${ISSUE}-x`,
    head_sha: headSha,
    base_ref: "main",
    mergeable: true,
    mergeable_state: "CLEAN",
    draft: false,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    merge_commit_sha: null,
  };
}

type DriveOpts = {
  startStage: Stage;
  prHead: string | null;
  prError?: boolean;
  headError?: boolean;
  commits: { oid: string; messageHeadline: string }[];
  blocked?: boolean;
  reviewSha?: string | null;
  attackerReviewSha?: string | null;
  standardReview?: boolean;
  adversarialReview?: boolean;
  advanceReviewStages?: boolean;
  currencySequence?: Array<"current" | "superseded">;
  /** Managed-worktree HEAD at start. Omit for no on-disk worktree. */
  worktreeHead?: string;
  worktreeDirty?: boolean;
  worktreeNotAncestor?: boolean;
};

type DriveResult = {
  dispatchStages: Stage[];
  transitions: { from: Stage; to: Stage; reason: string }[];
  labels: string[];
  logs: string[];
  reviewDispatchedAtSha: string | null;
  reviewDispatchedAtWorktreeHead: string | null;
  reviewAttemptedOnStaleHead: boolean;
  clearBlockedCalls: number;
  finalizeCalls: number;
  candidateEpochEvents: number;
};

async function driveLaterStage(opts: DriveOpts): Promise<DriveResult> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "later-stage-resume-"));
  const domain = `later-stage-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stateDir = `/tmp/pipeline-${domain}`;
  const runId = `${ISSUE}-2026-09-05T15-50-43-000Z`;
  const labels = [
    `pipeline:${opts.startStage}`,
    ...(opts.blocked ? ["blocked"] : []),
  ];
  const dispatchStages: Stage[] = [];
  const transitions: DriveResult["transitions"] = [];
  const logs: string[] = [];
  let reviewDispatchedAtSha: string | null = null;
  let reviewDispatchedAtWorktreeHead: string | null = null;
  let reviewAttemptedOnStaleHead = false;
  let clearBlockedCalls = 0;
  let finalizeCalls = 0;
  let currencyCalls = 0;
  const wtSlug = "x";
  const wtPath = path.join(repoDir, ".worktrees", `pipeline-${ISSUE}-${wtSlug}`);
  let worktreeHead = opts.worktreeHead ?? null;
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origExit = process.exitCode;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  const comments = [
    ...(opts.reviewSha
      ? [{ author: "pipeline-bot", body: reviewComment(opts.reviewSha) }]
      : []),
    ...(opts.attackerReviewSha
      ? [{ author: "attacker", body: reviewComment(opts.attackerReviewSha) }]
      : []),
    ...STAGES.filter((s) => s !== "backlog" && s !== "ready").map((s) => ({
      author: "pipeline-bot",
      body: `## Pipeline: ${s}\n<!-- pipeline-audit: run=${runId} state=${s} -->`,
    })),
    ...(opts.blocked
      ? [{
          author: "pipeline-bot",
          body: `## Pipeline: Blocked\n<!-- pipeline-audit: run=${runId} state=blocked -->`,
        }]
      : []),
  ];

  const detail = {
    number: ISSUE,
    type: "issue" as const,
    title: "T",
    body: "B",
    state: "open",
    url: `https://example.test/${ISSUE}`,
    labels,
    comments,
  };

  const cfg = {
    repo: "owner/repo",
    domain,
    repo_dir: repoDir,
    worktree_root: ".worktrees",
    base_branch: "main",
    invocation: "pipeline",
    marker_footer: "*Automated by Claude Code Pipeline Skill*",
    harnesses: {
      implementer: "claude",
      implementerSource: "default",
      reviewer: "codex",
      reviewerSource: "default",
    },
    steps: {
      standard_review: opts.standardReview ?? true,
      adversarial_review: opts.adversarialReview ?? true,
    },
    auto_loop: { enabled: false, max_rounds: 3, max_wallclock_minutes: 60, stages: [] },
    papercuts: { enabled: false, auto_file: false },
    corrections: { auto_file: false },
    review_policy: {
      block_threshold: "high",
      min_confidence: 0.7,
      max_adversarial_rounds: 3,
      risk_proportional: false,
      ceiling_action: "park",
      surface_recurrence_rounds: 3,
      max_delta_rounds: 4,
    },
  } as unknown as PipelineConfig;

  const deps: AdvanceDeps = {
    resolvePinnedEngineIdentity: () => ENGINE,
    probeEngineIdentity: () => null,
    enforceEngineTrack: async () => ({
      ok: true as const,
      track: "candidate" as const,
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
    getPrForIssue: async () => {
      if (opts.prError) throw new Error("cannot resolve PR");
      return opts.prHead ? PR : null;
    },
    getPrDetail: async () => {
      if (opts.headError) throw new Error("cannot read PR HEAD");
      if (!opts.prHead) throw new Error("getPrDetail must not run without a PR");
      return prDetail(opts.prHead);
    },
    getPrCommits: async () => opts.commits,
    ...(opts.currencySequence
      ? {
          resolveReviewedShaCurrency: async () => {
            const status = opts.currencySequence![Math.min(currencyCalls++, opts.currencySequence!.length - 1)];
            return status === "superseded"
              ? { status: "superseded" as const, headSha: SHA_H }
              : { status: "current" as const };
          },
        }
      : {}),
    getOnDiskForIssue: async () =>
      opts.worktreeHead ? { path: wtPath, slug: wtSlug } : null,
    gitInWorktree: async (_cwd, args) => {
      if (!opts.worktreeHead) return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args.includes("HEAD") && !args.includes("--verify")) {
        return { stdout: `${worktreeHead}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        const ref = args[args.length - 1] ?? "";
        return { stdout: `${ref}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse") {
        return { stdout: `${SHA_S}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "status") {
        return {
          stdout: opts.worktreeDirty ? " M core/scripts/pipeline-run.ts\n" : "",
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "merge-base") {
        return { stdout: "", stderr: "", code: opts.worktreeNotAncestor ? 1 : 0 };
      }
      if (args[0] === "merge" && args.includes("--ff-only")) {
        worktreeHead = args[args.length - 1] ?? worktreeHead;
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "reset" && args.includes("--hard")) {
        worktreeHead = args[args.length - 1] ?? worktreeHead;
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "diff" || args[0] === "fetch" || args[0] === "show") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    postComment: async () => {},
    postPrComment: async () => {},
    addLabelToPr: async () => {},
    lastAdvancedCandidateSha: opts.prHead ?? SHA_H,
    trustedSurfaceObjectSource: {
      listChangedPaths: async () => ({ paths: [] }),
      resolveBaseSha: async () => SHA_S,
    },
    transition: async (_cfg, _n, from, to, reason) => {
      transitions.push({ from, to, reason });
      const idx = labels.findIndex((l) => l.startsWith("pipeline:"));
      if (idx >= 0) labels[idx] = `pipeline:${to}`;
      else labels.push(`pipeline:${to}`);
    },
    clearBlocked: async () => {
      clearBlockedCalls++;
      const idx = labels.indexOf("blocked");
      if (idx >= 0) labels.splice(idx, 1);
    },
    finalizeReadyToDeploy: async () => {
      finalizeCalls++;
      return { advanced: false, status: "finalized", reason: "finalized" };
    },
    dispatch: async (_cfg, _n, stage) => {
      dispatchStages.push(stage);
      if (stage === "ready-to-deploy") {
        throw new Error("dispatch must not handle ready-to-deploy");
      }
      if (stage === "review-1" || stage === "review-2") {
        reviewDispatchedAtSha = opts.prHead;
        reviewDispatchedAtWorktreeHead = worktreeHead;
        if (worktreeHead && worktreeHead !== opts.prHead) {
          reviewAttemptedOnStaleHead = true;
        }
        if (opts.advanceReviewStages) {
          const to = nextStage(stage);
          const idx = labels.findIndex((l) => l.startsWith("pipeline:"));
          if (idx >= 0) labels[idx] = `pipeline:${to}`;
          else labels.push(`pipeline:${to}`);
          return { advanced: true, from: stage, to, summary: `${stage} → ${to}` };
        }
        return {
          advanced: false,
          status: "waiting",
          reason: `review evaluating ${opts.prHead ?? "unknown"}`,
        };
      }
      const to = nextStage(stage);
      const idx = labels.findIndex((l) => l.startsWith("pipeline:"));
      if (idx >= 0) labels[idx] = `pipeline:${to}`;
      else labels.push(`pipeline:${to}`);
      return { advanced: true, from: stage, to, summary: `${stage} → ${to}` };
    },
  };

  try {
    await withoutHostPinAuthorityEnv(() => runAdvance(cfg, ISSUE, { runId }, deps));
    const eventsPath = path.join(repoDir, ".agent-pipeline", "runs", runId, "events.jsonl");
    const events = fs.existsSync(eventsPath)
      ? fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return {
      dispatchStages,
      transitions,
      labels: [...labels],
      logs,
      reviewDispatchedAtSha,
      reviewDispatchedAtWorktreeHead,
      reviewAttemptedOnStaleHead,
      clearBlockedCalls,
      finalizeCalls,
      candidateEpochEvents: events.filter((event) => event.type === "candidate_epoch_restarted").length,
    };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    process.exitCode = origExit;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function developerCommits() {
  return [
    { oid: SHA_S, messageHeadline: "feat: implement change" },
    { oid: SHA_H, messageHeadline: "test: assert archive exists (#1459)" },
  ];
}

function internalCommits() {
  return [
    { oid: SHA_S, messageHeadline: "feat: implement change" },
    { oid: SHA_INTERNAL, messageHeadline: `chore: archive OpenSpec change(s) for #${ISSUE}` },
  ];
}

test("visual-gate unblocked resume after developer HEAD movement returns to review-1", async () => {
  const r = await driveLaterStage({
    startStage: "visual-gate",
    prHead: SHA_H,
    commits: developerCommits(),
    reviewSha: SHA_S,
  });
  assert.equal(r.dispatchStages.includes("visual-gate"), false, "must not run visual-gate");
  assert.equal(r.dispatchStages.includes("eval-gate"), false);
  assert.equal(r.dispatchStages.includes("shipcheck-gate"), false);
  assert.ok(r.transitions.some((t) => t.from === "visual-gate" && t.to === "review-1"));
  assert.ok(r.labels.includes("pipeline:review-1"));
  assert.equal(r.labels.includes("pipeline:ready-to-deploy"), false);
  assert.ok(r.dispatchStages.includes("review-1"), "same invocation must dispatch review-1");
  assert.equal(r.reviewDispatchedAtSha, SHA_H, "review must evaluate HEAD H, not reuse S");
  assert.equal(
    r.logs.some((l) => /Pipeline Complete|ready-to-deploy refused|ready-to-deploy →/.test(l)),
    false,
    "must not reach ready-to-deploy finalize",
  );
});

test("eval-gate, shipcheck-gate, and ready-to-deploy share the same guard", async () => {
  for (const startStage of ["eval-gate", "shipcheck-gate", "ready-to-deploy"] as const) {
    const r = await driveLaterStage({
      startStage,
      prHead: SHA_H,
      commits: developerCommits(),
      reviewSha: SHA_S,
    });
    assert.equal(
      r.dispatchStages.includes(startStage),
      false,
      `${startStage} handler must not run after developer HEAD movement`,
    );
    assert.ok(
      r.transitions.some((t) => t.from === startStage && t.to === "review-1"),
      `${startStage} must transition to review-1`,
    );
    assert.ok(r.dispatchStages.includes("review-1"), `${startStage} must continue into review-1`);
    assert.equal(r.reviewDispatchedAtSha, SHA_H);
  }
});

test("pipeline-internal-only commits keep later-stage dispatch", async () => {
  const r = await driveLaterStage({
    startStage: "visual-gate",
    prHead: SHA_INTERNAL,
    commits: internalCommits(),
    reviewSha: SHA_S,
  });
  assert.ok(r.dispatchStages.includes("visual-gate"), "internal-only must dispatch visual-gate");
  assert.equal(r.transitions.some((t) => t.to === "review-1"), false);
});

test("unreadable HEAD fails closed without later-stage dispatch or ready-to-deploy", async () => {
  const r = await driveLaterStage({
    startStage: "visual-gate",
    prHead: SHA_H,
    headError: true,
    commits: developerCommits(),
    reviewSha: SHA_S,
  });
  assert.equal(r.dispatchStages.includes("visual-gate"), false);
  assert.equal(r.dispatchStages.includes("review-1"), false);
  assert.equal(r.transitions.length, 0);
  assert.ok(r.labels.includes("pipeline:visual-gate"));
  assert.equal(r.labels.includes("pipeline:ready-to-deploy"), false);
  assert.ok(r.logs.some((l) => /fail|cannot read PR HEAD|review-currency/i.test(l)));
});

test("unreadable PR fails closed at ready-to-deploy without finalize", async () => {
  const r = await driveLaterStage({
    startStage: "ready-to-deploy",
    prHead: SHA_H,
    prError: true,
    commits: developerCommits(),
    reviewSha: SHA_S,
  });
  assert.equal(r.dispatchStages.length, 0);
  assert.equal(r.transitions.length, 0);
  assert.ok(r.labels.includes("pipeline:ready-to-deploy"));
  assert.equal(
    r.logs.some((l) => /Pipeline Complete/.test(l)),
    false,
  );
});

test("unknown currency with readable H ≠ S returns to review-1 (rebase-absent S)", async () => {
  const r = await driveLaterStage({
    startStage: "visual-gate",
    prHead: SHA_H,
    commits: [{ oid: SHA_H, messageHeadline: "fix: rebased findings" }],
    reviewSha: SHA_S,
  });
  assert.equal(r.dispatchStages.includes("visual-gate"), false);
  assert.ok(r.transitions.some((t) => t.to === "review-1"));
  assert.ok(r.dispatchStages.includes("review-1"));
  assert.equal(r.reviewDispatchedAtSha, SHA_H);
});

test("blocked leftover is not required: unblocked visual-gate still revalidates", async () => {
  const r = await driveLaterStage({
    startStage: "visual-gate",
    prHead: SHA_H,
    commits: developerCommits(),
    reviewSha: SHA_S,
    blocked: false,
  });
  assert.equal(r.labels.includes("blocked"), false);
  assert.ok(r.transitions.some((t) => t.to === "review-1"));
});

test("blocked forged-comment resume clears the block and records one candidate-epoch audit", async () => {
  const r = await driveLaterStage({
    startStage: "visual-gate",
    prHead: SHA_H,
    commits: developerCommits(),
    reviewSha: SHA_S,
    attackerReviewSha: SHA_H,
    blocked: true,
  });
  assert.equal(r.clearBlockedCalls, 1);
  assert.equal(r.labels.includes("blocked"), false);
  assert.ok(r.transitions.some((t) => t.from === "visual-gate" && t.to === "review-1"));
  assert.ok(r.dispatchStages.includes("review-1"));
  assert.equal(r.candidateEpochEvents, 1);
});

test("later-stage epoch restart selects the enabled exact-SHA review stage", async () => {
  const r = await driveLaterStage({
    startStage: "eval-gate",
    prHead: SHA_H,
    commits: developerCommits(),
    reviewSha: SHA_S,
    standardReview: false,
    adversarialReview: true,
  });
  assert.ok(r.transitions.some((t) => t.from === "eval-gate" && t.to === "review-2"));
  assert.ok(r.dispatchStages.includes("review-2"));
  assert.equal(r.dispatchStages.includes("eval-gate"), false);
});

test("later-stage epoch restart fails closed when both review stages are disabled", async () => {
  const r = await driveLaterStage({
    startStage: "ready-to-deploy",
    prHead: SHA_H,
    commits: developerCommits(),
    reviewSha: SHA_S,
    standardReview: false,
    adversarialReview: false,
  });
  assert.equal(r.transitions.length, 0);
  assert.equal(r.dispatchStages.length, 0);
  assert.equal(r.finalizeCalls, 0);
  assert.ok(r.logs.some((line) => /no exact-SHA review stage is enabled/.test(line)));
});

test("deferred ready-to-deploy finalize rechecks currency and refuses a late HEAD move", async () => {
  const r = await driveLaterStage({
    startStage: "plan-review",
    prHead: SHA_H,
    commits: developerCommits(),
    reviewSha: SHA_S,
    advanceReviewStages: true,
    currencySequence: ["current", "current", "current", "superseded"],
  });
  assert.equal(r.finalizeCalls, 0, "deferred terminal finalize must not run on stale review currency");
  assert.ok(
    r.transitions.some((t) => t.from === "ready-to-deploy" && t.to === "review-1"),
    `deferred terminal path must restart review after the late HEAD move: ${JSON.stringify(r)}`,
  );
  assert.equal(r.candidateEpochEvents, 1);
});

test("epoch restart does not review on managed worktree HEAD S when PR HEAD is H", async () => {
  const r = await driveLaterStage({
    startStage: "visual-gate",
    prHead: SHA_H,
    commits: developerCommits(),
    reviewSha: SHA_S,
    worktreeHead: SHA_S,
  });
  assert.equal(r.reviewAttemptedOnStaleHead, false, "review must not run while worktree HEAD is still S");
  assert.equal(r.reviewDispatchedAtWorktreeHead, SHA_H, "review/test cwd HEAD must be H after bind");
  assert.ok(r.dispatchStages.includes("review-1"));
  assert.equal(r.dispatchStages.includes("visual-gate"), false);
});

test("epoch restart fails closed when stale worktree S cannot bind to H", async () => {
  const r = await driveLaterStage({
    startStage: "eval-gate",
    prHead: SHA_H,
    commits: developerCommits(),
    reviewSha: SHA_S,
    worktreeHead: SHA_S,
    worktreeDirty: true,
  });
  assert.equal(r.dispatchStages.includes("review-1"), false);
  assert.equal(r.dispatchStages.includes("eval-gate"), false);
  assert.equal(r.reviewAttemptedOnStaleHead, false);
  assert.equal(r.transitions.length, 0, "must not reroute to review while worktree remains at S");
  assert.ok(r.logs.some((line) => /refusing to dispatch review/.test(line)));
});

test("nested whole-item, pipeline single, and loop item dispatch share runAdvance later-stage guard", () => {
  assert.match(NESTED_ADVANCE_SRC, /runAdvance\(/);
  assert.match(PIPELINE_SRC, /await deps\.runAdvance\(/);
  assert.match(PIPELINE_RUN_SRC, /reconcileLaterStageReviewCurrency/);
  assert.match(PIPELINE_RUN_SRC, /bindEpochRestartWorktreeToHead/);
  assert.match(
    PIPELINE_RUN_SRC,
    /isLaterStageForReviewCurrency\(stage\)/,
  );
  const laterIdx = PIPELINE_RUN_SRC.indexOf("reconcileLaterStageReviewCurrency");
  const rtdFinalizeIdx = PIPELINE_RUN_SRC.indexOf('runTerminalFinalize("in-loop")');
  assert.ok(laterIdx !== -1 && rtdFinalizeIdx !== -1);
  assert.ok(
    laterIdx < rtdFinalizeIdx,
    "later-stage currency guard must run before in-loop ready-to-deploy finalize",
  );
});
