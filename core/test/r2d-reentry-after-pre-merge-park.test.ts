// #1243: re-entry after pre-merge park must resolve trusted-surface candidate
// SHA without a managed worktree, tag the PR at ready-to-deploy, and fail
// closed on mismatch / missing SHA. Injected I/O only — no live network, git,
// or subprocess.

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
  type AdvanceOpts,
} from "../scripts/pipeline-run.ts";
import { toAdvanceOpts } from "../scripts/pipeline.ts";
import { runDirPath } from "../scripts/run-store.ts";
import {
  FACTORY_CONTROL_DIR_ENV,
  PRODUCTION_PIN_ENV,
} from "../scripts/production-engine-pin.ts";
import {
  durablePinCandidatesFromPriorRun,
  extractPreMergeCandidateShaFromEvents,
  resolveTrustedSurfaceCandidateSha,
  selectDurableLastAdvancedPin,
  startedAtFromRunId,
  stageAtOrAfterPreMerge,
  TRUSTED_SURFACE_SENTINEL_SHA,
} from "../scripts/trusted-surface-candidate.ts";
import { finalize as finalizeReadyToDeploy } from "../scripts/stages/deploy_ready.ts";
import { DELTA_REVIEW_MARKER_PREFIX } from "../scripts/stages/review.ts";
import {
  PATH_CLASS_SCHEMA_VERSION,
  TRUSTED_SURFACE_DECISION_SCHEMA_VERSION,
} from "../scripts/trusted-surface.ts";
import { TRUSTED_SURFACE_FILE } from "../scripts/run-store.ts";
import {
  readinessCandidateShaFromDecision,
} from "../scripts/evidence-subject.ts";
import type { EvidenceSubjectV1 } from "../scripts/evidence-subject.ts";
import { STAGES, type PipelineConfig, type Stage } from "../scripts/types.ts";
import type { TrustedSurfaceDecision } from "../scripts/trusted-surface.ts";
import type { PrDetail } from "../scripts/types.ts";

const PIN = "a".repeat(40);
const OTHER = "b".repeat(40);
const WT_HEAD = "c".repeat(40);
const ISSUE = 1236;
const PR = 1242;
const PIPELINE_RUN_TS = fileURLToPath(new URL("../scripts/pipeline-run.ts", import.meta.url));

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

function auditComments(): { author: string; body: string }[] {
  return ["review-1", "review-2", "pre-merge", "visual-gate", "eval-gate", "shipcheck-gate", "ready-to-deploy"].map(
    (s) => ({
      author: "pipeline-bot",
      body: `## Pipeline: ${s}\n<!-- pipeline-audit: run=test state=${s} -->`,
    }),
  );
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

const ENGINE = {
  version: "1.40.0",
  root: "/skill/core",
  templates_fingerprint: "e".repeat(64),
  commit_sha: "f".repeat(40),
};

type PriorRunSeed = {
  runId: string;
  trustedSurfaceSha?: string;
  /** Persist time of the trusted-surface decision; independent of runId. */
  trustedSurfaceDecidedAt?: string;
  preMergeSha?: string;
  preMergeAt?: string;
  /** Directory mtime in ms; used to invert listRunIds order vs recency. */
  mtimeMs?: number;
};

type DriveOpts = {
  worktree: { path: string; slug: string } | null;
  prHead: string | null;
  lastAdvancedPin?: string | null;
  /** Prior-run trusted-surface candidate_sha; not injected as lastAdvancedCandidateSha. */
  priorTrustedSurfaceSha?: string;
  /** Prior-run successful pre-merge stage_complete SHA; not a trusted-surface record. */
  priorPreMergeSha?: string;
  /** Multiple prior runs; when set, replaces the single priorTrustedSurfaceSha/preMergeSha seed. */
  priorRuns?: PriorRunSeed[];
  extraComments?: { author: string; body: string }[];
  overrideSha?: string | null;
  /** Production AdvanceOpts bag (e.g. from toAdvanceOpts / `--sha`). */
  advanceOpts?: AdvanceOpts;
  objectSourceError?: string;
  gitHeadSha?: string;
};

type DriveResult = {
  decision: TrustedSurfaceDecision | null;
  prLabels: string[];
  logs: string[];
  dispatchStages: Stage[];
  mergeCalls: number;
  createWorktreeCalls: number;
  worktreeLookups: number;
  emittedSubject: EvidenceSubjectV1 | null;
};

function seedPriorRun(repoDir: string, seed: PriorRunSeed): void {
  const priorDir = runDirPath(repoDir, seed.runId);
  fs.mkdirSync(priorDir, { recursive: true });
  if (seed.trustedSurfaceSha) {
    fs.writeFileSync(
      path.join(priorDir, TRUSTED_SURFACE_FILE),
      JSON.stringify({
        schema_version: TRUSTED_SURFACE_DECISION_SCHEMA_VERSION,
        path_class_schema_version: PATH_CLASS_SCHEMA_VERSION,
        outcome: "passthrough",
        candidate_sha: seed.trustedSurfaceSha,
        base_sha: null,
        triggering_paths: [],
        classes: [],
        effective_verifier_hash: "d".repeat(64),
        reason: { code: "ok", summary: "prior run pin" },
        ...(seed.trustedSurfaceDecidedAt
          ? { decided_at: seed.trustedSurfaceDecidedAt }
          : {}),
      }),
    );
  }
  if (seed.preMergeSha) {
    fs.writeFileSync(
      path.join(priorDir, "events.jsonl"),
      `${JSON.stringify({
        schema_version: 1,
        type: "stage_complete",
        at: seed.preMergeAt ?? "2026-08-24T00:00:00Z",
        stage: "pre-merge",
        outcome: "advanced",
        commits: [seed.preMergeSha],
      })}\n`,
    );
  }
  if (seed.mtimeMs !== undefined) {
    const t = new Date(seed.mtimeMs);
    fs.utimesSync(priorDir, t, t);
  }
}

async function driveReentry(opts: DriveOpts): Promise<DriveResult> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "r2d-reentry-"));
  const domain = `r2d-reentry-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stateDir = `/tmp/pipeline-${domain}`;
  const runId = `${ISSUE}-2026-08-25T16-48-11-054Z`;
  const labels = ["pipeline:pre-merge"];
  const prLabels: string[] = [];
  const dispatchStages: Stage[] = [];
  const logs: string[] = [];
  let worktreeLookups = 0;
  let mergeCalls = 0;
  let createWorktreeCalls = 0;
  const origLog = console.log;
  const origWarn = console.warn;
  const origExit = process.exitCode;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
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

  const detail = {
    number: ISSUE,
    type: "issue" as const,
    title: "T",
    body: "B",
    state: "open",
    url: `https://example.test/${ISSUE}`,
    labels,
    comments: [
      ...auditComments(),
      ...(opts.prHead && !opts.extraComments
        ? [
            {
              author: "pipeline-bot",
              body:
                `## Review 2 (Adversarial) — approve (commit ${opts.prHead.slice(0, 7)})\n\n` +
                `ok\n\n<!-- reviewed-sha: ${opts.prHead} -->`,
            },
          ]
        : []),
      ...(opts.extraComments ?? []),
    ],
  };

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
    getPrForIssue: async () => (opts.prHead ? PR : null),
    getPrDetail: async () => {
      if (!opts.prHead) throw new Error("getPrDetail must not run without a PR");
      return prDetail(opts.prHead);
    },
    getPrCommits: async () =>
      opts.prHead ? [{ oid: opts.prHead, messageHeadline: "feat: implement" }] : [],
    transition: async (_cfg, _n, from, to) => {
      const idx = labels.findIndex((l) => l.startsWith("pipeline:"));
      if (idx >= 0) labels[idx] = `pipeline:${to}`;
      else labels.push(`pipeline:${to}`);
    },
    getOnDiskForIssue: async () => {
      worktreeLookups += 1;
      return opts.worktree;
    },
    gitInWorktree: async (_cwd, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: `${opts.gitHeadSha ?? WT_HEAD}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse") {
        return { stdout: `${OTHER}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "diff") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "log") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    postComment: async () => {},
    postPrComment: async () => {},
    addLabelToPr: async (_cfg, _pr, label) => {
      prLabels.push(label);
    },
    ...(opts.lastAdvancedPin !== undefined
      ? { lastAdvancedCandidateSha: opts.lastAdvancedPin }
      : {}),
    ...(opts.overrideSha !== undefined
      ? { candidateShaOverride: opts.overrideSha }
      : {}),
    trustedSurfaceObjectSource: opts.objectSourceError
      ? {
          listChangedPaths: async () => ({ error: opts.objectSourceError! }),
        }
      : {
          listChangedPaths: async () => ({ paths: [] }),
          resolveBaseSha: async () => OTHER,
        },
    dispatch: async (_cfg, _n, stage) => {
      dispatchStages.push(stage);
      if (stage === "ready-to-deploy") {
        throw new Error("dispatch must not handle ready-to-deploy");
      }
      if (stage === "review-1" || stage === "review-2") {
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

  const priorSeeds: PriorRunSeed[] =
    opts.priorRuns ??
    (opts.priorTrustedSurfaceSha || opts.priorPreMergeSha
      ? [
          {
            runId: `${ISSUE}-2026-08-24T00-00-00-000Z`,
            trustedSurfaceSha: opts.priorTrustedSurfaceSha,
            preMergeSha: opts.priorPreMergeSha,
          },
        ]
      : []);
  for (const seed of priorSeeds) {
    seedPriorRun(repoDir, seed);
  }

  try {
    await withoutHostPinAuthorityEnv(() =>
      runAdvance(cfg, ISSUE, { ...opts.advanceOpts, runId }, deps),
    );
    const decisionPath = path.join(runDirPath(repoDir, runId), "trusted-surface.json");
    let decision: TrustedSurfaceDecision | null = null;
    if (fs.existsSync(decisionPath)) {
      decision = JSON.parse(fs.readFileSync(decisionPath, "utf8")) as TrustedSurfaceDecision;
    }
    const summaryPath = path.join(runDirPath(repoDir, runId), "summary.json");
    let emittedSubject: EvidenceSubjectV1 | null = null;
    if (fs.existsSync(summaryPath)) {
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as {
        evidence_subject?: EvidenceSubjectV1;
      };
      emittedSubject = summary.evidence_subject ?? null;
    }
    return {
      decision,
      prLabels,
      logs,
      dispatchStages,
      mergeCalls,
      createWorktreeCalls,
      worktreeLookups,
      emittedSubject,
    };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    process.exitCode = origExit;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    void mergeCalls;
    void createWorktreeCalls;
  }
}

// ---------------------------------------------------------------------------
// Pure resolver
// ---------------------------------------------------------------------------

test("stageAtOrAfterPreMerge: late stages only", () => {
  assert.equal(stageAtOrAfterPreMerge("implementing"), false);
  assert.equal(stageAtOrAfterPreMerge("pre-merge"), true);
  assert.equal(stageAtOrAfterPreMerge("visual-gate"), true);
  assert.equal(stageAtOrAfterPreMerge("ready-to-deploy"), true);
  assert.equal(stageAtOrAfterPreMerge("needs-human"), false);
  assert.equal(stageAtOrAfterPreMerge("backlog"), false);
});

test("resolver: matching PR head after park supplies candidate SHA", () => {
  const r = resolveTrustedSurfaceCandidateSha({
    worktreePresent: false,
    stage: "pre-merge",
    linkedPrHead: { prNumber: PR, headSha: PIN },
    lastAdvancedPin: PIN,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.candidateSha, PIN);
    assert.equal(r.source, "pr_head");
  }
});

test("resolver: explicit override supplies candidate SHA", () => {
  const r = resolveTrustedSurfaceCandidateSha({
    worktreePresent: false,
    stage: "pre-merge",
    overrideSha: PIN,
    linkedPrHead: { prNumber: PR, headSha: PIN },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.candidateSha, PIN);
    assert.equal(r.source, "override");
  }
});

test("resolver: absent worktree and absent PR fails closed", () => {
  const r = resolveTrustedSurfaceCandidateSha({
    worktreePresent: false,
    stage: "pre-merge",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "candidate_sha_unresolved");
  }
});

test("resolver: mismatched PR head is not accepted", () => {
  const r = resolveTrustedSurfaceCandidateSha({
    worktreePresent: false,
    stage: "pre-merge",
    linkedPrHead: { prNumber: PR, headSha: OTHER },
    lastAdvancedPin: PIN,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "candidate_sha_mismatch");
  }
});

test("resolver: mismatched override is not accepted", () => {
  const r = resolveTrustedSurfaceCandidateSha({
    worktreePresent: false,
    stage: "pre-merge",
    overrideSha: PIN,
    linkedPrHead: { prNumber: PR, headSha: OTHER },
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "candidate_sha_mismatch");
  }
});

test("resolver: present but invalid override fails closed", () => {
  const r = resolveTrustedSurfaceCandidateSha({
    worktreePresent: false,
    stage: "pre-merge",
    overrideSha: "not-a-sha",
    linkedPrHead: { prNumber: PR, headSha: PIN },
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "invalid_candidate_sha");
  }
});

test("resolver: worktree HEAD still wins when present", () => {
  const r = resolveTrustedSurfaceCandidateSha({
    worktreePresent: true,
    worktreeHeadSha: WT_HEAD,
    stage: "pre-merge",
    linkedPrHead: { prNumber: PR, headSha: OTHER },
    lastAdvancedPin: OTHER,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.candidateSha, WT_HEAD);
    assert.equal(r.source, "worktree_head");
  }
});

test("resolver: early stage without worktree stays worktree_unavailable", () => {
  const r = resolveTrustedSurfaceCandidateSha({
    worktreePresent: false,
    stage: "implementing",
    linkedPrHead: { prNumber: PR, headSha: PIN },
    lastAdvancedPin: PIN,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "worktree_unavailable");
  }
});

// ---------------------------------------------------------------------------
// runAdvance regressions
// ---------------------------------------------------------------------------

test("pre-merge re-entry with matching PR head tags ready-to-deploy (#1243)", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: PIN,
    lastAdvancedPin: PIN,
  });
  assert.ok(result.decision, "trusted-surface decision must be persisted");
  assert.notEqual(result.decision?.reason.code, "worktree_unavailable");
  assert.equal(result.decision?.candidate_sha, PIN);
  assert.notEqual(result.decision?.outcome, "blocked");
  assert.ok(
    result.prLabels.includes("pipeline:ready-to-deploy"),
    "linked PR must be tagged pipeline:ready-to-deploy",
  );
  assert.ok(
    result.logs.some((l) => l.includes(`PR #${PR} tagged pipeline:ready-to-deploy`)),
    "operator log must include PR tagged line",
  );
  const sha = readinessCandidateShaFromDecision(result.decision);
  assert.equal(sha, PIN);
  assert.ok(result.emittedSubject, "production must emit a readiness evidence_subject");
  assert.equal(result.emittedSubject.candidate_sha, PIN);
  assert.equal(result.emittedSubject.pr, PR);
  assert.equal(result.mergeCalls, 0);
  assert.equal(result.createWorktreeCalls, 0);
  assert.ok(result.worktreeLookups > 0);
  assert.ok(!result.dispatchStages.includes("ready-to-deploy"));
});

test("mismatched PR head is not the readiness subject and is not tagged", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: OTHER,
    lastAdvancedPin: PIN,
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.outcome, "blocked");
  assert.equal(result.decision?.reason.code, "candidate_sha_mismatch");
  assert.notEqual(result.decision?.candidate_sha, OTHER);
  assert.equal(readinessCandidateShaFromDecision(result.decision), null);
  assert.equal(result.prLabels.includes("pipeline:ready-to-deploy"), false);
  assert.ok(
    !result.emittedSubject || result.emittedSubject.candidate_sha !== OTHER,
    "emitted readiness subject must not claim the mismatched PR head",
  );
});

test("absent worktree and absent PR fail closed with named unresolved code", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: null,
    lastAdvancedPin: PIN,
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.outcome, "blocked");
  assert.equal(result.decision?.reason.code, "candidate_sha_unresolved");
  assert.notEqual(result.decision?.reason.code, "passthrough");
  const sha = result.decision?.candidate_sha;
  assert.ok(
    !sha || sha === TRUSTED_SURFACE_SENTINEL_SHA,
    "must not invent a product candidate SHA",
  );
  assert.equal(readinessCandidateShaFromDecision(result.decision), null);
  assert.equal(result.prLabels.includes("pipeline:ready-to-deploy"), false);
  assert.equal(result.emittedSubject, null);
});

test("worktree HEAD wins over a different PR head", async () => {
  const result = await driveReentry({
    worktree: { path: "/wt/1236", slug: "1236-x" },
    prHead: OTHER,
    lastAdvancedPin: OTHER,
    gitHeadSha: WT_HEAD,
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.candidate_sha, WT_HEAD);
  assert.notEqual(result.decision?.candidate_sha, OTHER);
  assert.notEqual(result.decision?.reason.code, "worktree_unavailable");
});

test("object source that cannot read paths blocks instead of inventing passthrough", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: PIN,
    lastAdvancedPin: PIN,
    objectSourceError: "objects not readable in host checkout",
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.outcome, "blocked");
  assert.equal(result.decision?.reason.code, "diff_unresolved");
  assert.equal(result.decision?.candidate_sha, PIN);
  assert.equal(result.prLabels.includes("pipeline:ready-to-deploy"), false);
});

test("explicit override SHA is accepted when it matches the PR head", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: PIN,
    lastAdvancedPin: null,
    overrideSha: PIN,
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.candidate_sha, PIN);
  assert.notEqual(result.decision?.reason.code, "worktree_unavailable");
  assert.ok(result.prLabels.includes("pipeline:ready-to-deploy"));
});

test("explicit override that does not match PR head is refused", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: OTHER,
    lastAdvancedPin: null,
    overrideSha: PIN,
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.outcome, "blocked");
  assert.equal(result.decision?.reason.code, "candidate_sha_mismatch");
  assert.notEqual(result.decision?.candidate_sha, PIN);
  assert.notEqual(result.decision?.candidate_sha, OTHER);
  assert.equal(result.prLabels.includes("pipeline:ready-to-deploy"), false);
});

test("operator --sha override is accepted with no worktree and matching PR head", async () => {
  const mapped = toAdvanceOpts({ sha: PIN });
  assert.equal(mapped.candidateShaOverride, PIN);
  const result = await driveReentry({
    worktree: null,
    prHead: PIN,
    lastAdvancedPin: null,
    advanceOpts: mapped,
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.candidate_sha, PIN);
  assert.notEqual(result.decision?.reason.code, "worktree_unavailable");
  assert.ok(result.prLabels.includes("pipeline:ready-to-deploy"));
});

test("operator --sha override supplies candidate SHA when PR head is unavailable", async () => {
  const mapped = toAdvanceOpts({ sha: PIN });
  const result = await driveReentry({
    worktree: null,
    prHead: null,
    lastAdvancedPin: null,
    advanceOpts: mapped,
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.candidate_sha, PIN);
  assert.notEqual(result.decision?.reason.code, "worktree_unavailable");
  assert.notEqual(result.decision?.outcome, "blocked");
});

test("trusted-surface SHA fallback does not rematerialize a worktree", () => {
  const src = readFileSync(PIPELINE_RUN_TS, "utf8");
  const start = src.indexOf("async function ensureTrustedSurfaceDecision");
  const end = src.indexOf("async function checkEngineDrift");
  assert.ok(start !== -1 && end !== -1 && end > start);
  const slice = src.slice(start, end);
  assert.doesNotMatch(slice, /createWorktree/);
});

test("advance dispatch still never merges (#1243)", () => {
  const src = readFileSync(PIPELINE_RUN_TS, "utf8");
  const start = src.indexOf("export async function dispatch(");
  const end = src.indexOf("// Advance mode lifecycle");
  assert.ok(start !== -1 && end !== -1 && end > start);
  const slice = src.slice(start, end);
  assert.doesNotMatch(slice, /mergePr\b/);
  assert.doesNotMatch(slice, /auto_merge/);
  assert.doesNotMatch(slice, /merge-queue/);
});

// ---------------------------------------------------------------------------
// Durable last-advanced pin (fresh re-entry, no lastAdvancedCandidateSha)
// ---------------------------------------------------------------------------

test("selectDurableLastAdvancedPin: prior TS then pre-merge then review SHA-gate", () => {
  assert.equal(
    selectDurableLastAdvancedPin({
      priorTrustedSurfaceShas: [TRUSTED_SURFACE_SENTINEL_SHA, PIN],
      preMergeCandidateSha: OTHER,
      reviewedSha: WT_HEAD,
    }),
    PIN,
  );
  assert.equal(
    selectDurableLastAdvancedPin({
      priorTrustedSurfaceShas: [TRUSTED_SURFACE_SENTINEL_SHA],
      preMergeCandidateSha: OTHER,
      reviewedSha: PIN,
    }),
    OTHER,
  );
  assert.equal(
    selectDurableLastAdvancedPin({
      reviewedSha: PIN,
    }),
    PIN,
  );
  assert.equal(
    selectDurableLastAdvancedPin({
      priorTrustedSurfaceShas: [TRUSTED_SURFACE_SENTINEL_SHA],
      reviewedSha: "not-a-sha",
    }),
    null,
  );
});

test("selectDurableLastAdvancedPin: newest timestamp wins across TS and pre-merge", () => {
  assert.equal(
    selectDurableLastAdvancedPin({
      candidates: [
        { sha: OTHER, at: "2026-08-23T00:00:00.000Z" },
        { sha: PIN, at: "2026-08-24T12:00:00.000Z" },
      ],
    }),
    PIN,
  );
  assert.equal(
    selectDurableLastAdvancedPin({
      candidates: [
        { sha: PIN, at: "2026-08-24T12:00:00.000Z" },
        { sha: OTHER, at: "2026-08-23T00:00:00.000Z" },
      ],
    }),
    PIN,
  );
  assert.equal(
    startedAtFromRunId(`${ISSUE}-2026-08-24T12-00-00-000Z`),
    "2026-08-24T12:00:00.000Z",
  );
});

test("durablePinCandidatesFromPriorRun: run-id and event timestamps", () => {
  const fromTs = durablePinCandidatesFromPriorRun({
    runId: `${ISSUE}-2026-08-23T00-00-00-000Z`,
    trustedSurfaceCandidateSha: OTHER,
  });
  assert.deepEqual(fromTs, [
    { sha: OTHER, at: "2026-08-23T00:00:00.000Z" },
  ]);
  const fromPreMerge = durablePinCandidatesFromPriorRun({
    runId: `${ISSUE}-2026-08-24T12-00-00-000Z`,
    events: [
      {
        type: "stage_complete",
        stage: "pre-merge",
        outcome: "advanced",
        commits: [PIN],
        at: "2026-08-24T12:05:00.000Z",
      },
    ],
  });
  assert.deepEqual(fromPreMerge, [
    { sha: PIN, at: "2026-08-24T12:05:00.000Z" },
  ]);
  assert.equal(
    selectDurableLastAdvancedPin({ candidates: [...fromTs, ...fromPreMerge] }),
    PIN,
  );
});

test("durablePinCandidatesFromPriorRun: reused older run ID uses decision time not run start", () => {
  const resumedOlder = durablePinCandidatesFromPriorRun({
    runId: `${ISSUE}-2026-08-23T00-00-00-000Z`,
    trustedSurfaceCandidateSha: PIN,
    trustedSurfaceDecidedAt: "2026-08-24T18:00:00.000Z",
  });
  const laterStarted = durablePinCandidatesFromPriorRun({
    runId: `${ISSUE}-2026-08-24T12-00-00-000Z`,
    trustedSurfaceCandidateSha: OTHER,
  });
  assert.deepEqual(resumedOlder, [
    { sha: PIN, at: "2026-08-24T18:00:00.000Z" },
  ]);
  assert.equal(
    selectDurableLastAdvancedPin({ candidates: [...resumedOlder, ...laterStarted] }),
    PIN,
  );
  assert.equal(
    selectDurableLastAdvancedPin({ candidates: [...laterStarted, ...resumedOlder] }),
    PIN,
  );
});

test("fresh re-entry loads prior trusted-surface pin without lastAdvancedCandidateSha", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: OTHER,
    priorTrustedSurfaceSha: PIN,
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.outcome, "blocked");
  assert.equal(result.decision?.reason.code, "candidate_sha_mismatch");
  assert.notEqual(result.decision?.candidate_sha, OTHER);
  assert.equal(result.prLabels.includes("pipeline:ready-to-deploy"), false);
});

test("fresh re-entry loads review SHA-gate pin without lastAdvancedCandidateSha", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: OTHER,
    extraComments: [
      {
        author: "pipeline-bot",
        body:
          `## Review 1 (Standard) — approve (commit ${PIN.slice(0, 7)})\n\n` +
          `ok\n\n<!-- reviewed-sha: ${PIN} -->`,
      },
    ],
  });
  assert.ok(
    result.dispatchStages.includes("review-1") ||
      result.logs.some((l) => /returning to review-1/.test(l)),
    "developer HEAD past review SHA must return to review-1 (#1462)",
  );
  assert.equal(result.dispatchStages.includes("visual-gate"), false);
  assert.equal(result.prLabels.includes("pipeline:ready-to-deploy"), false);
});

test("fresh re-entry matching prior pin still tags ready-to-deploy", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: PIN,
    priorTrustedSurfaceSha: PIN,
  });
  assert.ok(result.decision);
  assert.notEqual(result.decision?.reason.code, "worktree_unavailable");
  assert.equal(result.decision?.candidate_sha, PIN);
  assert.notEqual(result.decision?.outcome, "blocked");
  assert.ok(result.prLabels.includes("pipeline:ready-to-deploy"));
  assert.equal(result.emittedSubject?.candidate_sha, PIN);
  assert.equal(result.emittedSubject?.pr, PR);
});

test("extractPreMergeCandidateShaFromEvents: last successful pre-merge commit", () => {
  assert.equal(
    extractPreMergeCandidateShaFromEvents([
      {
        type: "stage_complete",
        stage: "pre-merge",
        outcome: "blocked",
        commits: [OTHER],
      },
      {
        type: "stage_complete",
        stage: "pre-merge",
        outcome: "advanced",
        commits: [PIN],
      },
      {
        type: "stage_complete",
        stage: "eval-gate",
        outcome: "advanced",
        commits: [WT_HEAD],
      },
    ]),
    PIN,
  );
  assert.equal(
    extractPreMergeCandidateShaFromEvents([
      {
        type: "stage_complete",
        stage: "pre-merge",
        outcome: "advanced",
        commits: [TRUSTED_SURFACE_SENTINEL_SHA],
      },
    ]),
    null,
  );
  assert.equal(
    extractPreMergeCandidateShaFromEvents([
      {
        type: "stage_complete",
        stage: "pre-merge",
        outcome: "advanced",
        commits: [PIN],
        at: "2026-08-24T02:00:00Z",
      },
      {
        type: "stage_complete",
        stage: "pre-merge",
        outcome: "advanced",
        commits: [OTHER],
        at: "2026-08-24T01:00:00Z",
      },
    ]),
    PIN,
  );
});

test("fresh re-entry rejects stale PR head when resumed older run ID is newer than later-started run", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: OTHER,
    priorRuns: [
      {
        runId: `${ISSUE}-2026-08-23T00-00-00-000Z`,
        trustedSurfaceSha: PIN,
        trustedSurfaceDecidedAt: "2026-08-24T18:00:00.000Z",
        mtimeMs: 2_000_000_000_000,
      },
      {
        runId: `${ISSUE}-2026-08-24T12-00-00-000Z`,
        trustedSurfaceSha: OTHER,
        trustedSurfaceDecidedAt: "2026-08-24T12:00:00.000Z",
        mtimeMs: 1_000_000_000_000,
      },
    ],
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.outcome, "blocked");
  assert.equal(result.decision?.reason.code, "candidate_sha_mismatch");
  assert.notEqual(result.decision?.candidate_sha, OTHER);
  assert.equal(result.prLabels.includes("pipeline:ready-to-deploy"), false);
  assert.ok(
    !result.emittedSubject || result.emittedSubject.candidate_sha !== OTHER,
    "emitted readiness subject must not claim the stale later-started PR head",
  );
});

test("fresh re-entry rejects stale PR head when older run matches and newest pin differs", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: OTHER,
    priorRuns: [
      {
        runId: `${ISSUE}-2026-08-23T00-00-00-000Z`,
        trustedSurfaceSha: OTHER,
        preMergeSha: OTHER,
        preMergeAt: "2026-08-23T00:05:00Z",
        mtimeMs: 2_000_000_000_000,
      },
      {
        runId: `${ISSUE}-2026-08-24T12-00-00-000Z`,
        trustedSurfaceSha: PIN,
        preMergeSha: PIN,
        preMergeAt: "2026-08-24T12:05:00Z",
        mtimeMs: 1_000_000_000_000,
      },
    ],
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.outcome, "blocked");
  assert.equal(result.decision?.reason.code, "candidate_sha_mismatch");
  assert.notEqual(result.decision?.candidate_sha, OTHER);
  assert.equal(result.prLabels.includes("pipeline:ready-to-deploy"), false);
  assert.ok(
    !result.emittedSubject || result.emittedSubject.candidate_sha !== OTHER,
    "emitted readiness subject must not claim the stale older PR head",
  );
});

test("fresh re-entry loads pre-merge pin from prior stage_complete without lastAdvancedCandidateSha", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: OTHER,
    priorPreMergeSha: PIN,
  });
  assert.ok(result.decision);
  assert.equal(result.decision?.outcome, "blocked");
  assert.equal(result.decision?.reason.code, "candidate_sha_mismatch");
  assert.notEqual(result.decision?.candidate_sha, OTHER);
  assert.equal(result.prLabels.includes("pipeline:ready-to-deploy"), false);
  assert.ok(
    !result.emittedSubject || result.emittedSubject.candidate_sha !== OTHER,
  );
});

test("fresh re-entry loads pre-merge delta-review pin without lastAdvancedCandidateSha", async () => {
  const result = await driveReentry({
    worktree: null,
    prHead: OTHER,
    extraComments: [
      {
        author: "pipeline-bot",
        body:
          `${DELTA_REVIEW_MARKER_PREFIX} — approve (commit ${PIN.slice(0, 7)})\n\n` +
          `ok\n\n<!-- reviewed-sha: ${PIN} -->`,
      },
    ],
  });
  assert.ok(
    result.dispatchStages.includes("review-1") ||
      result.logs.some((l) => /returning to review-1/.test(l)),
    "developer HEAD past review SHA must return to review-1 (#1462)",
  );
  assert.equal(result.dispatchStages.includes("visual-gate"), false);
  assert.equal(result.prLabels.includes("pipeline:ready-to-deploy"), false);
});

test("finalize refuses ready-to-deploy tag when live PR head moved off trusted-surface SHA", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "r2d-stale-head-"));
  const prLabels: string[] = [];
  const postedIssue: string[] = [];
  const postedPr: string[] = [];
  fs.writeFileSync(
    path.join(runDir, TRUSTED_SURFACE_FILE),
    JSON.stringify({
      schema_version: TRUSTED_SURFACE_DECISION_SCHEMA_VERSION,
      path_class_schema_version: PATH_CLASS_SCHEMA_VERSION,
      outcome: "passthrough",
      candidate_sha: PIN,
      base_sha: null,
      triggering_paths: [],
      classes: [],
      effective_verifier_hash: "d".repeat(64),
      reason: { code: "no_sensitive_paths", summary: "ok" },
    }),
  );
  const cfg = {
    repo: "owner/repo",
    domain: "r2d-stale-head",
    repo_dir: runDir,
    base_branch: "main",
    marker_footer: "*Automated by Claude Code Pipeline Skill*",
    harnesses: {
      implementer: "claude",
      implementerSource: "default",
      reviewer: "codex",
      reviewerSource: "default",
    },
  } as unknown as PipelineConfig;
  try {
    const out = await finalizeReadyToDeploy(cfg, ISSUE, runDir, undefined, {
      getIssueDetail: async () =>
        ({
          number: ISSUE,
          type: "issue",
          title: "T",
          body: "B",
          state: "open",
          url: `https://example.test/${ISSUE}`,
          labels: ["pipeline:ready-to-deploy"],
          comments: [],
        }) as Awaited<ReturnType<NonNullable<AdvanceDeps["getIssueDetail"]>>>,
      getPrForIssue: async () => PR,
      getPrDetail: async () => prDetail(OTHER),
      addLabelToPr: async (_cfg, _pr, label) => {
        prLabels.push(label);
      },
      postComment: async (_cfg, _n, body) => {
        postedIssue.push(body);
      },
      postPrComment: async (_cfg, _pr, body) => {
        postedPr.push(body);
      },
      getOnDiskForIssue: async () => null,
    });
    assert.equal(out.status, "blocked");
    assert.match(out.reason ?? "", /stale_pr_head/);
    assert.equal(prLabels.includes("pipeline:ready-to-deploy"), false);
    assert.equal(
      postedIssue.some((b) => b.startsWith("## Pipeline Complete")),
      false,
      "stale-head must not post the terminal completion summary",
    );
    assert.equal(
      postedPr.some((b) => b.startsWith("## Pipeline Complete")),
      false,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("finalize does not post Pipeline Complete when PR head changes before SHA check", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "r2d-stale-head-race-"));
  const prLabels: string[] = [];
  const postedIssue: string[] = [];
  fs.writeFileSync(
    path.join(runDir, TRUSTED_SURFACE_FILE),
    JSON.stringify({
      schema_version: TRUSTED_SURFACE_DECISION_SCHEMA_VERSION,
      path_class_schema_version: PATH_CLASS_SCHEMA_VERSION,
      outcome: "passthrough",
      candidate_sha: PIN,
      base_sha: null,
      triggering_paths: [],
      classes: [],
      effective_verifier_hash: "d".repeat(64),
      reason: { code: "no_sensitive_paths", summary: "ok" },
    }),
  );
  const cfg = {
    repo: "owner/repo",
    domain: "r2d-stale-head-race",
    repo_dir: runDir,
    base_branch: "main",
    marker_footer: "*Automated by Claude Code Pipeline Skill*",
    harnesses: {
      implementer: "claude",
      implementerSource: "default",
      reviewer: "codex",
      reviewerSource: "default",
    },
  } as unknown as PipelineConfig;
  let liveHead = PIN;
  try {
    const out = await finalizeReadyToDeploy(cfg, ISSUE, runDir, undefined, {
      getIssueDetail: async () => {
        liveHead = OTHER;
        return {
          number: ISSUE,
          type: "issue",
          title: "T",
          body: "B",
          state: "open",
          url: `https://example.test/${ISSUE}`,
          labels: ["pipeline:ready-to-deploy"],
          comments: [],
        } as Awaited<ReturnType<NonNullable<AdvanceDeps["getIssueDetail"]>>>;
      },
      getPrForIssue: async () => PR,
      getPrDetail: async () => prDetail(liveHead),
      addLabelToPr: async (_cfg, _pr, label) => {
        prLabels.push(label);
      },
      postComment: async (_cfg, _n, body) => {
        postedIssue.push(body);
      },
      postPrComment: async () => {},
      getOnDiskForIssue: async () => null,
    });
    assert.equal(out.status, "blocked");
    assert.match(out.reason ?? "", /stale_pr_head/);
    assert.equal(prLabels.includes("pipeline:ready-to-deploy"), false);
    assert.equal(
      postedIssue.some((b) => b.startsWith("## Pipeline Complete")),
      false,
      "stale-head must not post the terminal completion summary",
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
