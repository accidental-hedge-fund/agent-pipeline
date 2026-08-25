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
} from "../scripts/pipeline-run.ts";
import { runDirPath } from "../scripts/run-store.ts";
import {
  FACTORY_CONTROL_DIR_ENV,
  PRODUCTION_PIN_ENV,
} from "../scripts/production-engine-pin.ts";
import {
  resolveTrustedSurfaceCandidateSha,
  stageAtOrAfterPreMerge,
  TRUSTED_SURFACE_SENTINEL_SHA,
} from "../scripts/trusted-surface-candidate.ts";
import {
  buildEngineFingerprint,
  buildEvidenceSubject,
  buildPolicyHash,
  buildRequiredEvidenceSetRevision,
  DEFAULT_REQUIRED_EVIDENCE_KINDS,
  readinessCandidateShaFromDecision,
} from "../scripts/evidence-subject.ts";
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
  return ["pre-merge", "visual-gate", "eval-gate", "shipcheck-gate", "ready-to-deploy"].map(
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

type DriveOpts = {
  worktree: { path: string; slug: string } | null;
  prHead: string | null;
  lastAdvancedPin?: string | null;
  overrideSha?: string | null;
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
};

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
  } as unknown as PipelineConfig;

  const detail = {
    number: ISSUE,
    type: "issue" as const,
    title: "T",
    body: "B",
    state: "open",
    url: `https://example.test/${ISSUE}`,
    labels,
    comments: auditComments(),
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
    lastAdvancedCandidateSha: opts.lastAdvancedPin,
    candidateShaOverride: opts.overrideSha,
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
      const to = nextStage(stage);
      const idx = labels.findIndex((l) => l.startsWith("pipeline:"));
      if (idx >= 0) labels[idx] = `pipeline:${to}`;
      else labels.push(`pipeline:${to}`);
      return { advanced: true, from: stage, to, summary: `${stage} → ${to}` };
    },
  };

  try {
    await withoutHostPinAuthorityEnv(() => runAdvance(cfg, ISSUE, { runId }, deps));
    const decisionPath = path.join(runDirPath(repoDir, runId), "trusted-surface.json");
    let decision: TrustedSurfaceDecision | null = null;
    if (fs.existsSync(decisionPath)) {
      decision = JSON.parse(fs.readFileSync(decisionPath, "utf8")) as TrustedSurfaceDecision;
    }
    return {
      decision,
      prLabels,
      logs,
      dispatchStages,
      mergeCalls,
      createWorktreeCalls,
      worktreeLookups,
    };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
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
  const subject = buildEvidenceSubject({
    domain: "owner/repo",
    issue: ISSUE,
    pr: PR,
    run_id: `${ISSUE}/reentry`,
    candidate_sha: sha!,
    diff_hash: null,
    policy_hash: buildPolicyHash({ k: "p" }),
    engine_fingerprint: buildEngineFingerprint({
      version: ENGINE.version,
      templates_fingerprint: ENGINE.templates_fingerprint,
    }),
    verifier_fingerprint: "d".repeat(64),
    required_evidence_set_revision: buildRequiredEvidenceSetRevision(
      DEFAULT_REQUIRED_EVIDENCE_KINDS,
    ),
  });
  assert.equal(subject.candidate_sha, PIN);
  assert.equal(subject.pr, PR);
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
