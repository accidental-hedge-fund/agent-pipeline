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
  setBlocked,
  transition,
} from "../gh.ts";
import { invoke } from "../harness.ts";
import { branchName, getForIssue, gitInWorktree } from "../worktree.ts";
import { buildDocsUpdatePrompt } from "../prompts/index.ts";
import * as openspec from "../openspec.ts";
import type { Outcome, PipelineConfig } from "../types.ts";

const DOCS_COMMIT_PREFIX = "docs: update documentation for #";
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
    console.log(`[pipeline] #${issueNumber}: [dry-run] would docs+CI+merge for PR #${prNumber}`);
    return { advanced: true, from: "pre-merge", to: "ready-to-deploy", summary: "[dry-run]" };
  }

  // ---- Step 1: docs update (once per PR) ----
  if (!(await docsAlreadyUpdated(cfg, issueNumber))) {
    await updateDocs(cfg, issueNumber, prNumber, opts);
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
  await transition(
    cfg,
    issueNumber,
    "pre-merge",
    "ready-to-deploy",
    `All pre-merge gates passed (docs updated, CI green, no conflicts). PR #${prNumber} is ready to merge.`,
  );
  // Note: cfg.auto_merge intentionally NOT honored here. The user owns the merge button.
  return {
    advanced: true,
    from: "pre-merge",
    to: "ready-to-deploy",
    summary: `PR #${prNumber} ready to merge`,
  };
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
): Promise<void> {
  const wt = await getForIssue(cfg, issueNumber);
  if (!wt) return;

  const detail = await getIssueDetail(cfg, issueNumber);
  const harness = cfg.harnesses.implementer;
  let diff: string;
  try {
    diff = await getPrDiff(cfg, prNumber);
  } catch {
    return;
  }
  if (!diff.trim()) return;

  console.log(`[pipeline] #${issueNumber}: updating docs (${harness})`);

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
    return;
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
