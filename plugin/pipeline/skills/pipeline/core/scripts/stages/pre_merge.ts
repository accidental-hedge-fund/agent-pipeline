// Pre-merge gate: docs update (once) → CI gate → mergeability gate → ready-to-deploy.
//
// Returns { advanced: false, status: "waiting" } when CI is still running or
// docs were just pushed (CI needs to re-run). The caller (pipeline.ts loop)
// breaks on waiting so the user can re-invoke later.
//
// We deliberately do NOT auto-merge. The terminal stage is just the
// `pipeline:ready-to-deploy` label.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  getIssueDetail,
  getPrChecks,
  getPrDetail,
  getPrDiff,
  getPrForIssue,
  parseChecksAggregate,
  parseMergeable,
  postComment,
  setBlocked,
  transition,
} from "../gh.ts";
import { invoke } from "../harness.ts";
import { branchName, getForIssue, gitInWorktree } from "../worktree.ts";
import { buildDocsUpdatePrompt } from "../prompts/index.ts";
import { extractReviewedSha } from "./review.ts";
import * as openspec from "../openspec.ts";
import {
  verifyHarnessCommits,
  type VerifyDeps,
  type VerifyResult,
} from "../verify-harness-commits.ts";
import type { Outcome, PipelineConfig, Stage } from "../types.ts";

const DOCS_COMMIT_PREFIX = "docs: update documentation for #";
const OPENSPEC_ARCHIVE_PREFIX = "chore: archive OpenSpec change(s) for #";
const REBASE_MARKER_FILE = ".pipeline-rebase-attempted";

export interface AdvancePreMergeOpts {
  dryRun?: boolean;
  model?: string;
}

export async function advance(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvancePreMergeOpts = {},
): Promise<Outcome> {
  console.log(`[pipeline] #${issueNumber}: pre-merge gate`);

  const prNumber = await getPrForIssue(cfg, issueNumber);
  if (!prNumber) {
    await setBlocked(cfg, issueNumber, "No pull request found for pre-merge gate.", "pre-merge");
    return { advanced: false, status: "blocked", reason: "no PR" };
  }

  if (opts.dryRun) {
    const dryNextStage = cfg.eval_gate.enabled ? "eval-gate" : "ready-to-deploy";
    console.log(`[pipeline] #${issueNumber}: [dry-run] would archive+docs+CI+merge for PR #${prNumber}`);
    return { advanced: true, from: "pre-merge", to: dryNextStage, summary: "[dry-run]" };
  }

  // ---- Review-SHA gate (#16): runs before any pre-merge work ----
  // pre-merge is the only stage that acts on a prior review verdict without
  // re-running review, so it is where a stale approval would slip through. If
  // HEAD has moved past the reviewed commit via a developer/fix commit, bounce
  // back to the review round before doing any pre-merge work; pipeline-internal
  // commits (docs / openspec archive) do not invalidate the verdict.
  const shaGate = await enforceReviewShaGate(cfg, issueNumber, prNumber);
  if (shaGate) return shaGate;

  // ---- Step 0: OpenSpec archive (once; folds change deltas into living specs) ----
  const archiveOutcome = await maybeArchiveOpenspec(cfg, issueNumber);
  if (archiveOutcome) return archiveOutcome;

  // ---- Step 1: docs update (once per PR; skippable via steps.docs) ----
  if (cfg.steps.docs && !(await docsAlreadyUpdated(cfg, issueNumber))) {
    const docsViolation = await updateDocs(cfg, issueNumber, prNumber, opts);
    if (docsViolation) {
      await setBlocked(cfg, issueNumber, docsViolation.reason, "pre-merge");
      return docsViolation;
    }
    return {
      advanced: false,
      status: "waiting",
      reason: "docs pushed; CI needs to re-run",
    };
  }

  // ---- Step 2: CI ----
  let checks;
  try {
    checks = await getPrChecks(cfg, prNumber);
  } catch (err) {
    const e = err as Error;
    return { advanced: false, status: "waiting", reason: `gh pr checks failed: ${e.message}` };
  }

  const agg = parseChecksAggregate(checks);
  if (agg.pending) {
    return { advanced: false, status: "waiting", reason: "CI still running" };
  }

  if (agg.failed.length > 0) {
    const wt = await getForIssue(cfg, issueNumber);
    const alreadyRebased = wt ? rebaseAlreadyAttempted(wt.path) : true;
    if (!alreadyRebased && wt) {
      const ok = await tryRebaseAndPush(cfg, issueNumber);
      if (ok) {
        markRebaseAttempted(wt.path);
        return { advanced: false, status: "waiting", reason: "rebased; CI re-running" };
      }
    }
    await setBlocked(
      cfg,
      issueNumber,
      `CI checks failed:\n${agg.failed.map((c) => `- ${c.name}: ${c.bucket}`).join("\n")}`,
      "pre-merge",
    );
    return { advanced: false, status: "blocked", reason: "CI failed" };
  }

  // ---- Step 3: mergeability ----
  const detail = await getPrDetail(cfg, prNumber);
  const mergeStatus = parseMergeable(detail);
  if (mergeStatus === "conflict") {
    const ok = await tryRebaseAndPush(cfg, issueNumber);
    if (ok) {
      return { advanced: false, status: "waiting", reason: "rebase-resolved; CI re-running" };
    }
    await setBlocked(
      cfg,
      issueNumber,
      "PR has merge conflicts that could not be automatically resolved.",
      "pre-merge",
    );
    return { advanced: false, status: "blocked", reason: "merge conflict" };
  }
  if (mergeStatus === "unknown") {
    return { advanced: false, status: "waiting", reason: "GitHub still computing mergeability" };
  }

  // ---- Step 3.5: OpenSpec validation gate (opt-in / auto-detected) ----
  // Only runs when the target repo has an `openspec/` workspace (or it's forced
  // on via config). Refuses ready-to-deploy if the change's specs/deltas are
  // structurally invalid. A missing `openspec` CLI is non-blocking (skipped).
  const specWt = await getForIssue(cfg, issueNumber);
  if (specWt && openspec.isActive(cfg, specWt.path)) {
    const spec = await openspec.validate(specWt.path);
    if (spec.unavailable) {
      console.log(
        `[pipeline] #${issueNumber}: openspec active but CLI unavailable; skipping spec validation (non-blocking)`,
      );
    } else if (!spec.valid) {
      const detail = spec.issues.length
        ? spec.issues.map((i) => `- ${i.item ? `${i.item}: ` : ""}${i.message}`).join("\n")
        : spec.raw;
      await setBlocked(
        cfg,
        issueNumber,
        `OpenSpec validation failed (\`openspec validate --all\`):\n${detail}`,
        "pre-merge",
      );
      return { advanced: false, status: "blocked", reason: "openspec validation failed" };
    } else {
      console.log(`[pipeline] #${issueNumber}: openspec validation passed`);
    }
  }

  // ---- Step 4: advance ----
  // Skip the eval-gate label entirely when evals are disabled to avoid spurious
  // label churn and pipeline comments on repos that did not opt in.
  const nextStage = cfg.eval_gate.enabled ? "eval-gate" : "ready-to-deploy";
  await transition(
    cfg,
    issueNumber,
    "pre-merge",
    nextStage,
    `All pre-merge gates passed (docs updated, CI green, no conflicts). Advancing to ${nextStage} for PR #${prNumber}.`,
  );
  return {
    advanced: true,
    from: "pre-merge",
    to: nextStage,
    summary: `PR #${prNumber} pre-merge gates passed`,
  };
}

// ---------------------------------------------------------------------------
// Review-SHA gate (#16): never advance on a stale approval
// ---------------------------------------------------------------------------

/**
 * External seams for {@link enforceReviewShaGate}, overridable in tests.
 * Mirrors the DI pattern used elsewhere (testgate.ts, review.ts).
 */
export interface ShaGateDeps {
  getIssueDetail?: typeof getIssueDetail;
  getPrDetail?: typeof getPrDetail;
  postComment?: typeof postComment;
  transition?: typeof transition;
}

/**
 * Before pre-merge acts on the prior review verdict, verify the most recent
 * review comment still covers HEAD. Returns `null` to proceed (verdict fresh,
 * or nothing to validate), or an `advanced` Outcome that bounces the item back
 * to its review round when the verdict is stale (HEAD moved past the reviewed
 * commit) or unverifiable (no SHA sentinel). The orchestrator loop then re-runs
 * that review stage, which records the new SHA.
 */
export async function enforceReviewShaGate(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  deps: ShaGateDeps = {},
): Promise<Outcome | null> {
  const getIssueDetailFn = deps.getIssueDetail ?? getIssueDetail;
  const getPrDetailFn = deps.getPrDetail ?? getPrDetail;
  const postCommentFn = deps.postComment ?? postComment;
  const transitionFn = deps.transition ?? transition;

  const detail = await getIssueDetailFn(cfg, issueNumber);
  const reviewed = extractReviewedSha(detail.comments);
  // No prior review comment (e.g. review steps disabled, or first run) → nothing
  // to validate; let pre-merge proceed as normal.
  if (!reviewed) return null;

  const head = (await getPrDetailFn(cfg, prNumber)).head_sha;

  // Any SHA mismatch — including pipeline-internal commits — is treated as stale.
  // The only safe path forward is an exact match with the verified SHA.
  if (reviewed.sha && reviewed.sha === head) return null;

  const reviewStage: Stage = reviewed.round === 1 ? "review-1" : "review-2";
  await postCommentFn(cfg, issueNumber, staleReviewNotice(reviewed.sha, head));
  await transitionFn(
    cfg,
    issueNumber,
    "pre-merge",
    reviewStage,
    `Re-running review ${reviewed.round}: HEAD moved past the reviewed commit ` +
      `${reviewed.sha ? `\`${reviewed.sha.slice(0, 7)}\`` : "(unrecorded)"} → \`${head.slice(0, 7)}\`.`,
  );
  return {
    advanced: true,
    from: "pre-merge",
    to: reviewStage,
    summary: `re-review: HEAD moved to ${head.slice(0, 7)}`,
  };
}

/** The notice posted before a SHA-mismatch re-review. Pure; exported for tests. */
export function staleReviewNotice(reviewedSha: string | null, headSha: string): string {
  const newShort = headSha.slice(0, 7);
  const body = reviewedSha
    ? `Re-running review: HEAD has moved from \`${reviewedSha.slice(0, 7)}\` to \`${newShort}\` since the last review.`
    : `Re-running review: the last review did not record the commit it evaluated, ` +
      `so its verdict cannot be verified against current HEAD (\`${newShort}\`).`;
  return [
    "## Pipeline: Re-running review",
    "",
    body,
    "",
    "The prior review verdict is discarded; review re-runs against the current commit before this item can advance.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Docs-only file-constraint gate — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Verifies that a docs-update harness only modified documentation files —
 * no application code or test files. Checks both committed changes
 * (`headBefore..HEAD`) and uncommitted dirty paths (which the stage will
 * auto-commit). Returns `null` to proceed, or a blocked `VerifyResult` on
 * violation. Exported so tests can exercise the gate without mocking the
 * full `updateDocs` call chain.
 */
export async function enforceDocsOnlyGate(
  wtPath: string,
  headBefore: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  return verifyHarnessCommits(wtPath, headBefore, { docsOnly: true }, deps);
}

/**
 * Verifies that every harness-produced commit (in `headBefore..HEAD`) carries
 * the expected docs commit message prefix. Uses `allowEmpty: true` so runs
 * where the harness made no commits (dirty-only) are not blocked — the stage
 * will auto-commit those with the correct message. Exported for direct testing.
 * (#68 review-2 finding 3)
 */
export async function enforceDocsCommitMessageGate(
  wtPath: string,
  headBefore: string,
  issueNumber: number,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  return verifyHarnessCommits(
    wtPath,
    headBefore,
    {
      messagePattern: {
        pattern: new RegExp(`docs: update documentation for #${issueNumber}`, "i"),
        description: `Docs harness committed with wrong message — expected prefix: "${DOCS_COMMIT_PREFIX}${issueNumber}"`,
      },
      allowEmpty: true,
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Docs update
// ---------------------------------------------------------------------------

async function docsAlreadyUpdated(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<boolean> {
  const wt = await getForIssue(cfg, issueNumber);
  if (!wt) return true; // No worktree → skip docs (manually-recovered case).
  const log = await gitInWorktree(
    wt.path,
    ["log", "--oneline", `origin/${cfg.base_branch}..HEAD`],
    { ignoreFailure: true },
  );
  return log.stdout.includes(`${DOCS_COMMIT_PREFIX}${issueNumber}`);
}

async function updateDocs(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  opts: AdvancePreMergeOpts,
): Promise<{ advanced: false; status: "blocked"; reason: string } | null> {
  const wt = await getForIssue(cfg, issueNumber);
  if (!wt) return null;

  const detail = await getIssueDetail(cfg, issueNumber);
  const harness = cfg.harnesses.implementer;
  let diff: string;
  try {
    diff = await getPrDiff(cfg, prNumber);
  } catch {
    return null;
  }
  if (!diff.trim()) return null;

  console.log(`[pipeline] #${issueNumber}: updating docs (${harness})`);

  const headBefore = (
    await gitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();

  const prompt = buildDocsUpdatePrompt({
    cfg,
    issueNumber,
    title: detail.title,
    diff,
  });
  const result = await invoke(harness, wt.path, prompt, {
    timeoutSec: cfg.implementation_timeout,
    model: opts.model,
  });
  if (!result.success) {
    console.log(
      `[pipeline] #${issueNumber}: docs update failed (${result.timed_out ? "timeout" : `exit ${result.exit_code}`}); skipping (non-blocking)`,
    );
    return null;
  }

  // Verify the harness only modified documentation files (#68).
  if (headBefore) {
    const docsCheck = await enforceDocsOnlyGate(wt.path, headBefore);
    if (!docsCheck.ok) {
      return { advanced: false, status: "blocked", reason: docsCheck.reason };
    }
    // Verify harness-produced commit messages match the expected docs prefix (#68 review-2 finding 3).
    const msgCheck = await enforceDocsCommitMessageGate(wt.path, headBefore, issueNumber);
    if (!msgCheck.ok) {
      return { advanced: false, status: "blocked", reason: msgCheck.reason };
    }
  }

  const status = await gitInWorktree(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (!status.stdout.trim()) {
    // Empty marker commit so we don't re-run docs next cycle.
    await gitInWorktree(
      wt.path,
      ["commit", "--allow-empty", "-m", `${DOCS_COMMIT_PREFIX}${issueNumber}`],
      { ignoreFailure: true },
    );
  } else {
    await gitInWorktree(wt.path, ["add", "-A"], { ignoreFailure: true });
    await gitInWorktree(
      wt.path,
      ["commit", "-m", `${DOCS_COMMIT_PREFIX}${issueNumber}`],
      { ignoreFailure: true },
    );
  }

  const branch = branchName(issueNumber, wt.slug);
  await gitInWorktree(wt.path, ["push", "origin", branch], { ignoreFailure: true });
  console.log(`[pipeline] #${issueNumber}: docs pushed; CI will re-run`);
  return null;
}

// ---------------------------------------------------------------------------
// OpenSpec archive (once per PR)
// ---------------------------------------------------------------------------

/**
 * When OpenSpec is active, archive the change(s) this PR branch introduced so
 * their spec deltas fold into the living `openspec/specs/`. Idempotent: a change
 * already archived is no longer an active dir, so it drops out of the candidate
 * set. Returns a `waiting` Outcome after pushing (CI must re-run), a `blocked`
 * Outcome on failure, or null when there is nothing to do (continue the gate).
 */
async function maybeArchiveOpenspec(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<Outcome | null> {
  const wt = await getForIssue(cfg, issueNumber);
  if (!wt || !openspec.isActive(cfg, wt.path)) return null;

  // Changes this PR branch introduced, still active (not yet archived).
  const diff = await gitInWorktree(
    wt.path,
    ["diff", "--name-only", `origin/${cfg.base_branch}...HEAD`],
    { ignoreFailure: true },
  );
  const candidates = openspec
    .changeIdsFromPaths(diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean))
    .filter((id) => openspec.changeDirExists(wt.path, id));
  if (candidates.length === 0) return null; // already archived, or none

  console.log(`[pipeline] #${issueNumber}: archiving OpenSpec change(s): ${candidates.join(", ")}`);
  for (const id of candidates) {
    const res = await openspec.archive(wt.path, id);
    if (res.unavailable) {
      console.log(
        `[pipeline] #${issueNumber}: openspec CLI unavailable; skipping archive (non-blocking)`,
      );
      return null;
    }
    if (!res.success) {
      await setBlocked(cfg, issueNumber, `openspec archive ${id} failed:\n${res.output}`, "pre-merge");
      return { advanced: false, status: "blocked", reason: `openspec archive failed (${id})` };
    }
  }

  // Commit + push the archived specs so CI validates the finalized state.
  await gitInWorktree(wt.path, ["add", "-A"], { ignoreFailure: true });
  const status = await gitInWorktree(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (!status.stdout.trim()) return null; // archive produced no diff (unexpected) → continue
  await gitInWorktree(
    wt.path,
    ["commit", "-m", `${OPENSPEC_ARCHIVE_PREFIX}${issueNumber}`],
    { ignoreFailure: true },
  );
  const push = await gitInWorktree(wt.path, ["push", "origin", branchName(issueNumber, wt.slug)], {
    ignoreFailure: true,
  });
  if (push.code !== 0) {
    await setBlocked(
      cfg,
      issueNumber,
      `Git push failed after OpenSpec archive: ${push.stderr.trim()}`,
      "pre-merge",
    );
    return { advanced: false, status: "blocked", reason: "push failed after archive" };
  }
  console.log(`[pipeline] #${issueNumber}: OpenSpec change(s) archived; CI will re-run`);
  return { advanced: false, status: "waiting", reason: "openspec change archived; CI re-running" };
}

// ---------------------------------------------------------------------------
// Rebase tracking
// ---------------------------------------------------------------------------

function rebaseAlreadyAttempted(wtPath: string): boolean {
  return fs.existsSync(path.join(wtPath, REBASE_MARKER_FILE));
}

function markRebaseAttempted(wtPath: string): void {
  fs.writeFileSync(path.join(wtPath, REBASE_MARKER_FILE), "1");
}

async function tryRebaseAndPush(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<boolean> {
  const wt = await getForIssue(cfg, issueNumber);
  if (!wt) return false;
  const branch = branchName(issueNumber, wt.slug);

  const fetch = await gitInWorktree(wt.path, ["fetch", "origin", cfg.base_branch], {
    ignoreFailure: true,
  });
  if (fetch.code !== 0) return false;

  const rebase = await gitInWorktree(wt.path, ["rebase", `origin/${cfg.base_branch}`], {
    ignoreFailure: true,
  });
  if (rebase.code !== 0) {
    await gitInWorktree(wt.path, ["rebase", "--abort"], { ignoreFailure: true });
    return false;
  }

  const push = await gitInWorktree(
    wt.path,
    ["push", "--force-with-lease", "origin", branch],
    { ignoreFailure: true },
  );
  return push.code === 0;
}

/**
 * Polling loop: invoke `advance` repeatedly until it advances, blocks, or
 * exhausts the CI timeout. Used by the top-level orchestrator. Returns the
 * last outcome.
 */
export async function advancePolling(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvancePreMergeOpts = {},
): Promise<Outcome> {
  const deadline = Date.now() + cfg.ci_timeout * 1000;
  let last: Outcome | null = null;
  while (Date.now() < deadline) {
    last = await advance(cfg, issueNumber, opts);
    if (last.advanced) return last;
    if (!last.advanced && last.status !== "waiting") return last;
    // waiting → sleep and try again
    await new Promise((r) => setTimeout(r, cfg.ci_poll_interval * 1000));
  }
  return last ?? { advanced: false, status: "waiting", reason: "timed out polling pre-merge" };
}
