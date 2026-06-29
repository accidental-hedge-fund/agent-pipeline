// Shipcheck-gate stage (#148): reviewer-owned acceptance rubric evaluated after
// eval-gate and before ready-to-deploy.
//
// The reviewer harness (NOT the implementing harness) evaluates the rubric so
// the builder cannot self-certify. Advisory mode records pass/fail/findings
// without blocking; gate mode blocks ready-to-deploy on a fail verdict.
// A configurable max_rounds bound applies; timeout surfaces as needs-human.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  postComment as defaultPostComment,
  postPrComment as defaultPostPrComment,
  getPrForIssue as defaultGetPrForIssue,
  getPrDiff as defaultGetPrDiff,
  getPrDetail as defaultGetPrDetail,
  getPrCommits as defaultGetPrCommits,
  getGhActor as defaultGetGhActor,
  getIssueDetail as defaultGetIssueDetail,
  setBlocked as defaultSetBlocked,
  silentTransition as defaultSilentTransition,
  transition as defaultTransition,
} from "../gh.ts";
import { isPipelineInternalCommit } from "./pre_merge.ts";
import { extractSnapshotComment } from "../issue-context-snapshot.ts";
import { getOnDiskForIssue as defaultGetForIssue, gitInWorktree as defaultGitInWorktree } from "../worktree.ts";
import { openspecContextFromDiff, readSpecDeltas } from "../openspec.ts";
import { readBundle as defaultReadBundle, patchBundleIdentity as defaultPatchBundleIdentity } from "../evidence-bundle.ts";
import { invoke as defaultInvoke } from "../harness.ts";
import { substitute } from "../prompts/index.ts";
import { SHIPCHECK_VERDICT_SCHEMA_BLOCK } from "../review-schema.ts";
import { appendEvent, RUN_SCHEMA_VERSION, type RunStoreDeps } from "../run-store.ts";
import {
  runEligibilityGate,
  formatEligibilityVerdict,
  type EligibilityGateDeps,
} from "./auto_merge_eligibility.ts";
import type {
  AutoMergeEligibilityArtifact,
  BlockerKind,
  EvidenceBundle,
  Outcome,
  PipelineConfig,
  ShipcheckVerdict,
  Stage,
} from "../types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadShipcheckTemplate(): string {
  return fs.readFileSync(path.join(here, "../prompts/shipcheck.md"), "utf8");
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export interface BuildShipcheckPromptOpts {
  rubric: string;
  issueBody: string;
  planAndAcs: string;
  changedFiles: string;
  evalSummary?: string;
  openspecDeltas?: string;
  /** Pre-rendered context snapshot block for prompt injection (#318). */
  contextSnapshot?: string;
}

export function buildShipcheckPrompt(opts: BuildShipcheckPromptOpts): string {
  return substitute(loadShipcheckTemplate(), {
    rubric: opts.rubric || "(no rubric provided)",
    issue_body: opts.issueBody || "(no issue body)",
    context_snapshot: opts.contextSnapshot || "",
    plan_and_acs: opts.planAndAcs || "(not available)",
    changed_files: opts.changedFiles || "(not available)",
    eval_summary: opts.evalSummary ?? "eval results: not available",
    openspec_deltas: opts.openspecDeltas || "(not applicable)",
    schema_block: SHIPCHECK_VERDICT_SCHEMA_BLOCK,
  });
}

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

/** Extract a ShipcheckVerdict from raw harness output.
 *  Tries fenced block first, then bare JSON. On parse failure returns a
 *  conservative fail verdict with the raw output as summary. */
export function parseShipcheckVerdict(
  raw: string,
  warn: (msg: string) => void = console.warn,
): ShipcheckVerdict {
  // Try fenced block: ```[json]\n...\n```
  const fencedMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates = fencedMatch ? [fencedMatch[1], raw] : [raw];

  for (const candidate of candidates) {
    const jsonStart = candidate.indexOf("{");
    const jsonEnd = candidate.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) continue;
    try {
      const parsed = JSON.parse(candidate.slice(jsonStart, jsonEnd + 1)) as unknown;
      if (isShipcheckVerdict(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }

  const truncated = raw.slice(0, 500);
  warn(`[pipeline] shipcheck: could not parse verdict JSON from harness output; falling back to fail. Output: ${truncated}`);
  return {
    verdict: "fail",
    summary: truncated || "(no output)",
    criteria: [],
  };
}

function isShipcheckCriterion(c: unknown): boolean {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.criterion === "string" &&
    ["pass", "fail", "na"].includes(o.result as string) &&
    typeof o.note === "string"
  );
}

function isShipcheckVerdict(v: unknown): v is ShipcheckVerdict {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (!["pass", "partial", "fail"].includes(o.verdict as string)) return false;
  if (typeof o.summary !== "string") return false;
  if (!Array.isArray(o.criteria)) return false;
  // Empty criteria array means the reviewer did not evaluate any rubric criterion.
  // Treat as parse failure so the conservative fail fallback fires rather than
  // silently advancing on a pass/partial with no human-auditable breakdown.
  if (o.criteria.length === 0) return false;
  return o.criteria.every(isShipcheckCriterion);
}

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

export function formatShipcheckComment(
  verdict: ShipcheckVerdict,
  mode: "advisory" | "gate",
  prHeadSha?: string,
): string {
  const header = mode === "advisory" ? "## Shipcheck (advisory)" : "## Shipcheck";
  const emoji = verdict.verdict === "pass" ? "✅" : verdict.verdict === "partial" ? "⚠️" : "❌";
  const lines: string[] = [
    header,
    "",
    `**Verdict**: ${emoji} ${verdict.verdict.toUpperCase()}`,
    `**Mode**: ${mode}`,
    "",
    "### Summary",
    verdict.summary,
  ];

  if (verdict.criteria.length > 0) {
    lines.push("", "### Criteria");
    lines.push("| Criterion | Result | Note |");
    lines.push("|-----------|--------|------|");
    for (const c of verdict.criteria) {
      const resultEmoji = c.result === "pass" ? "✅" : c.result === "na" ? "—" : "❌";
      lines.push(`| ${c.criterion} | ${resultEmoji} ${c.result} | ${c.note} |`);
    }
  }

  lines.push("", "---", "*Automated by Claude Code Pipeline Skill*");
  if (prHeadSha) {
    lines.push(`<!-- shipcheck-sha: ${prHeadSha} -->`);
  }
  return lines.join("\n");
}

/**
 * Extract the PR head SHA embedded in a shipcheck verdict comment.
 * Returns the full 40-char SHA or null when absent (first-entry comments, legacy).
 * Mirrors the `extractReviewedSha` pattern from review-sha-gating.
 */
export function extractShipcheckSha(commentBody: string): string | null {
  const m = commentBody.match(/<!--\s*shipcheck-sha:\s*([0-9a-f]{40})\s*-->/);
  return m ? m[1] : null;
}

/**
 * Extract the revalidation-requested sentinel from a notice comment body.
 * When the stage routes to pre-merge for a given PR head, it embeds
 * `<!-- shipcheck-revalidation-sha: <sha> -->` in the notice so the next
 * entry can detect that routing already occurred for that head and skip
 * the route-back (idempotency guard, #317 Finding 1).
 * Returns the 40-char SHA or null when absent.
 */
export function extractRevalidationSha(commentBody: string): string | null {
  const m = commentBody.match(/<!--\s*shipcheck-revalidation-sha:\s*([0-9a-f]{40})\s*-->/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Deps seam
// ---------------------------------------------------------------------------

export interface ShipcheckDeps {
  getIssueDetail?: typeof defaultGetIssueDetail;
  getPrForIssue?: typeof defaultGetPrForIssue;
  getPrDiff?: typeof defaultGetPrDiff;
  getPrDetail?: typeof defaultGetPrDetail;
  getPrCommits?: typeof defaultGetPrCommits;
  /** Return the authenticated GitHub actor login, or null if unavailable. */
  getGhActor?: () => Promise<string | null>;
  /** Read the HEAD SHA of a worktree path. Throws on error (non-40-char output). */
  getWorktreeHead?: (wtPath: string) => Promise<string>;
  getForIssue?: typeof defaultGetForIssue;
  postComment?: typeof defaultPostComment;
  postPrComment?: typeof defaultPostPrComment;
  transition?: typeof defaultTransition;
  silentTransition?: typeof defaultSilentTransition;
  setBlocked?: typeof defaultSetBlocked;
  /** Read a file at the given absolute path. Returns null when not found. */
  readFile?: (filePath: string) => string | null;
  /** Resolve a canonical path following symlinks. Default: fs.realpathSync. Throws on ENOENT. */
  realpathFn?: (filePath: string) => string;
  /** Read the evidence bundle for an issue. Returns null when not found. */
  readEvidenceBundle?: (stateDir: string, issue: number) => Promise<EvidenceBundle | null>;
  /** Run git diff --name-only in a worktree. Returns path list. */
  gitDiffNames?: (wtPath: string, base: string) => Promise<string[]>;
  /** Read OpenSpec spec deltas for a change dir name. Default: openspec.readSpecDeltas. */
  readSpecDeltasFn?: (wtPath: string, name: string) => string;
  /** Invoke the reviewer harness with a prompt. Returns stdout string or null on failure. */
  invokeReviewer?: (prompt: string, worktreeDir: string, timeoutSec: number) => Promise<{ stdout: string; success: boolean; timed_out?: boolean; stderr?: string }>;
  /** Run the auto-merge eligibility gate (#306). Injectable for tests. */
  runEligibilityGateFn?: typeof runEligibilityGate;
  /** Deps forwarded to the eligibility gate (for deep test injection). */
  eligibilityGateDeps?: EligibilityGateDeps;
  /** Patch the evidence bundle's PR identity before the eligibility gate runs. Injectable for tests. */
  patchBundleIdentityFn?: (stateDir: string, issue: number, patch: { pr?: number | null }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Main stage handler
// ---------------------------------------------------------------------------

export interface AdvanceShipcheckOpts {
  dryRun?: boolean;
  /** Evidence-bundle run/state dir; when set, eval results are read from it. */
  stateDir?: string;
  /** Run directory for JSONL event log. Undefined → event appends disabled. */
  runDir?: string;
  /** Run-store deps carrying `stdoutWrite` for streaming events. */
  runStoreDeps?: RunStoreDeps;
}

function eventTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function recordGateResult(
  opts: AdvanceShipcheckOpts,
  result: ShipcheckVerdict["verdict"] | "skipped",
  mode: PipelineConfig["shipcheck_gate"]["mode"],
  reason?: string,
): Promise<void> {
  if (!opts.runDir) return;
  await appendEvent(
    opts.runDir,
    {
      schema_version: RUN_SCHEMA_VERSION,
      type: "gate_result",
      at: eventTimestamp(),
      gate: "shipcheck-gate",
      result,
      mode,
      reason,
    },
    opts.runStoreDeps,
  ).catch(() => {});
}

export async function advance(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceShipcheckOpts = {},
  deps: ShipcheckDeps = {},
): Promise<Outcome> {
  console.log(`[pipeline] #${issueNumber}: shipcheck-gate`);

  const transitionFn = deps.transition ?? defaultTransition;
  const silentTransitionFn = deps.silentTransition ?? defaultSilentTransition;
  const setBlockedFn = deps.setBlocked ?? defaultSetBlocked;
  const postCommentFn = deps.postComment ?? defaultPostComment;
  const postPrCommentFn = deps.postPrComment ?? defaultPostPrComment;
  const getPrForIssueFn = deps.getPrForIssue ?? defaultGetPrForIssue;
  const getIssueDetailFn = deps.getIssueDetail ?? defaultGetIssueDetail;
  const getForIssueFn = deps.getForIssue ?? defaultGetForIssue;
  const getPrDiffFn = deps.getPrDiff ?? defaultGetPrDiff;
  const getPrDetailFn = deps.getPrDetail ?? defaultGetPrDetail;
  const getPrCommitsFn = deps.getPrCommits ?? defaultGetPrCommits;
  const getGhActorFn = deps.getGhActor ?? defaultGetGhActor;
  const getWorktreeHeadFn = deps.getWorktreeHead ?? defaultGetWorktreeHead;
  const readEvidenceBundleFn = deps.readEvidenceBundle ?? defaultReadBundle;
  const gitDiffNamesFn = deps.gitDiffNames ?? defaultGitDiffNames;
  const readSpecDeltasFnBound = deps.readSpecDeltasFn ?? readSpecDeltas;

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would run shipcheck`);
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: "[dry-run]" };
  }

  // Skip path — disabled → silent label swap, no comment.
  if (!cfg.shipcheck_gate.enabled) {
    console.log(`[pipeline] #${issueNumber}: shipcheck-gate step disabled; skipping.`);
    let eligibilitySuffix = "";
    if (cfg.auto_merge_eligibility?.enabled) {
      try {
        const prNumForElig = await getPrForIssueFn(cfg, issueNumber);
        const wtForElig = await getForIssueFn(cfg, issueNumber);
        const wdForElig = wtForElig?.path ?? cfg.repo_dir;
        eligibilitySuffix = await maybeRunEligibilityGate(cfg, issueNumber, prNumForElig, wdForElig, opts, deps);
      } catch (err) {
        console.warn(`[pipeline] #${issueNumber}: eligibility gate lookup failed (non-fatal in disabled-shipcheck path): ${err}`);
      }
    }
    await silentTransitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy");
    await recordGateResult(opts, "skipped", cfg.shipcheck_gate.mode, "disabled");
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: `shipcheck-gate step disabled; skipping.${eligibilitySuffix}` };
  }

  // Load the issue detail for context.
  const detail = await getIssueDetailFn(cfg, issueNumber);
  const prNumber = await getPrForIssueFn(cfg, issueNumber);

  // Extract pre-planning context snapshot (#318). Use exact header match to
  // avoid picking up the last30days brief (## Pre-Planning Context — last30days).
  const prePlanningCtxComment = extractSnapshotComment(detail.comments);
  const contextSnapshot = prePlanningCtxComment
    ? (() => {
        const trimmedBody = prePlanningCtxComment.body.trimStart();
        return trimmedBody
          .slice(trimmedBody.indexOf('\n'))
          .trimStart()
          .replace(/\n\n---\n.*$/s, '')
          .trimEnd();
      })()
    : undefined;

  // Resolve the issue worktree; reviewer runs inside it when present.
  const wt = await getForIssueFn(cfg, issueNumber);
  const worktreeDir = wt?.path ?? cfg.repo_dir;

  // ---- HEAD-COHERENCE GATE (#317) ----
  // Runs on the enabled path, before the reviewer is invoked and before any
  // transition to ready-to-deploy. Guards against two failure modes:
  //   3.2a: unpushed local fix marks a stale PR ready.
  //   3.2b: pushed fix bypasses pre-merge/eval/review-SHA re-validation.

  let prHeadSha: string | null = null;
  if (prNumber !== null) {
    try {
      const prDetail = await getPrDetailFn(cfg, prNumber);
      prHeadSha = prDetail.head_sha;
    } catch (err) {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate: could not fetch PR head SHA: ${err}`);
      await setBlockedFn(cfg, issueNumber, `Shipcheck gate: could not fetch PR head SHA: ${String(err)}`, "shipcheck-gate", "needs-human" as BlockerKind);
      await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "pr_head_fetch_error");
      return { advanced: false, status: "blocked", reason: "shipcheck: failed to fetch PR head SHA", blockerKind: "needs-human" as BlockerKind };
    }
  }

  // 3.2a: Unpushed-fix block — worktree HEAD differs from PR head.
  if (wt !== null && prHeadSha !== null) {
    let worktreeHead: string;
    try {
      worktreeHead = await getWorktreeHeadFn(wt.path);
    } catch (err) {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate: could not read worktree head SHA: ${err}`);
      await setBlockedFn(cfg, issueNumber, `Shipcheck gate: could not read worktree head SHA: ${String(err)}`, "shipcheck-gate", "needs-human" as BlockerKind);
      await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "worktree_head_error");
      return { advanced: false, status: "blocked", reason: "shipcheck: failed to read worktree head", blockerKind: "needs-human" as BlockerKind };
    }
    if (worktreeHead !== prHeadSha) {
      const reason = `Shipcheck gate: worktree HEAD (${worktreeHead}) differs from PR head (${prHeadSha}). Push the local commits so the PR head includes the fix before re-running.`;
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate: head drift detected (worktree=${worktreeHead.slice(0, 8)} pr=${prHeadSha.slice(0, 8)}); blocking`);
      await setBlockedFn(cfg, issueNumber, reason, "shipcheck-gate", "head-drift" as BlockerKind);
      await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "head_drift");
      return { advanced: false, status: "blocked", reason: "shipcheck: worktree head differs from PR head", blockerKind: "head-drift" as BlockerKind };
    }
  }

  // 3.2b: Post-verdict re-validation routing — developer commit since prior verdict.
  if (prHeadSha !== null) {
    const actor = await getGhActorFn();
    // Finding 3: fail closed when actor lookup fails with a PR linked.
    // Without a verified actor, provenance of prior shipcheck verdict comments cannot
    // be confirmed; advancing risks blessing an unvalidated head on a transient auth failure.
    if (actor === null) {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate: actor lookup failed; cannot verify prior verdict provenance; blocking`);
      await setBlockedFn(
        cfg, issueNumber,
        `Shipcheck gate: could not resolve authenticated gh actor; cannot verify prior shipcheck verdict provenance. Restore gh auth and retry.`,
        "shipcheck-gate", "needs-human" as BlockerKind,
      );
      await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "actor_lookup_failure");
      return { advanced: false, status: "blocked", reason: "shipcheck: actor lookup failure", blockerKind: "needs-human" as BlockerKind };
    }
    // Finding 1 idempotency guard: if we already routed to pre-merge for the current
    // head (the revalidation notice authored by the actor carries the current prHeadSha),
    // skip the route-back and proceed with reviewer evaluation. Without this guard the
    // second shipcheck entry after pre-merge/eval completes would loop back again because
    // the prior verdict still records the pre-fix SHA.
    const alreadyRoutedForCurrentHead = detail.comments.some(
      (c) => c.author === actor && extractRevalidationSha(c.body) === prHeadSha,
    );
    if (!alreadyRoutedForCurrentHead) {
      // Find the most recent shipcheck verdict comment authored by the pipeline actor
      // that carries a shipcheck-sha sentinel (i.e. posted by this harness, not legacy).
      const shipcheckedByActor = detail.comments.filter(
        (c) => c.author === actor && extractShipcheckSha(c.body) !== null,
      );
      const lastVerdictComment = shipcheckedByActor[shipcheckedByActor.length - 1];
      if (lastVerdictComment) {
        const recordedSha = extractShipcheckSha(lastVerdictComment.body)!;
        if (recordedSha !== prHeadSha) {
          // Prior verdict evaluated a different SHA — check the commits since.
          let commits: { oid: string; messageHeadline: string }[];
          try {
            commits = await getPrCommitsFn(cfg, prNumber!);
          } catch (err) {
            console.log(`[pipeline] #${issueNumber}: shipcheck-gate: could not fetch PR commits: ${err}`);
            await setBlockedFn(cfg, issueNumber, `Shipcheck gate: could not fetch PR commits: ${String(err)}`, "shipcheck-gate", "needs-human" as BlockerKind);
            await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "pr_commits_fetch_error");
            return { advanced: false, status: "blocked", reason: "shipcheck: failed to fetch PR commits", blockerKind: "needs-human" as BlockerKind };
          }
          // Find commits since the recorded SHA (oldest-first list from gh).
          const recordedIdx = commits.findIndex((c) => c.oid === recordedSha);
          const commitsSince = recordedIdx >= 0 ? commits.slice(recordedIdx + 1) : commits;
          if (commitsSince.some((c) => !isPipelineInternalCommit(c.messageHeadline))) {
            console.log(`[pipeline] #${issueNumber}: shipcheck-gate: developer commit since prior verdict SHA ${recordedSha.slice(0, 8)}; routing to pre-merge`);
            // Transition FIRST so the idempotency marker is only posted after a
            // confirmed route. If transition throws, no notice is posted and the
            // next run retries the route-back correctly (Finding 1, review-2).
            await transitionFn(cfg, issueNumber, "shipcheck-gate", "pre-merge", `Developer commit(s) since last shipcheck verdict (${recordedSha.slice(0, 8)} → ${prHeadSha.slice(0, 8)}); re-validating through pre-merge.`);
            const notice =
              `**Shipcheck re-validation notice**: A developer commit has landed since the last shipcheck verdict (stale: \`${recordedSha.slice(0, 8)}\`, current: \`${prHeadSha.slice(0, 8)}\`). Routing back through pre-merge, eval-gate, and review-SHA validation for the new head.\n<!-- shipcheck-revalidation-sha: ${prHeadSha} -->`;
            await postCommentFn(cfg, issueNumber, notice);
            return { advanced: true, from: "shipcheck-gate", to: "pre-merge", summary: `shipcheck: re-validation routing to pre-merge (${recordedSha.slice(0, 8)} → ${prHeadSha.slice(0, 8)})` };
          }
          // Only pipeline-internal commits — fall through to normal reviewer evaluation.
        }
      } else {
        // No sentinel-bearing verdict found. Check for legacy verdict comments posted
        // by older harness versions that predate the shipcheck-sha sentinel (#317 Finding 2,
        // review-2). Treat them as an unknown prior verdict and route to pre-merge once so
        // the current head is validated through CI/review-SHA/eval before shipcheck proceeds.
        // The alreadyRoutedForCurrentHead guard (checked above) prevents looping after the
        // first migration route.
        const hasLegacyVerdict = detail.comments.some(
          (c) => c.author === actor && isShipcheckVerdictBody(c.body),
        );
        if (hasLegacyVerdict) {
          console.log(`[pipeline] #${issueNumber}: shipcheck-gate: legacy verdict comment (no sentinel); routing to pre-merge for migration`);
          await transitionFn(cfg, issueNumber, "shipcheck-gate", "pre-merge", `Legacy shipcheck verdict comment found without SHA sentinel; re-validating through pre-merge.`);
          const legacyNotice =
            `**Shipcheck re-validation notice**: A prior shipcheck verdict comment without a recorded head SHA was found. The current head (\`${prHeadSha.slice(0, 8)}\`) must be validated through pre-merge, eval-gate, and review-SHA before shipcheck can proceed.\n<!-- shipcheck-revalidation-sha: ${prHeadSha} -->`;
          await postCommentFn(cfg, issueNumber, legacyNotice);
          return { advanced: true, from: "shipcheck-gate", to: "pre-merge", summary: `shipcheck: legacy verdict migration routing to pre-merge` };
        }
      }
    }
  }

  // ---- END HEAD-COHERENCE GATE ----

  // Compute rubric fallback from issue body before loading the configured file.
  const rubricFallback = extractAcceptanceCriteria(detail.body) || detail.body || "(no rubric available)";
  const rubric = loadRubric(cfg, deps, rubricFallback);

  // Gather changed-files summary from the PR diff.
  const changedFilesSummary = await gatherChangedFiles(cfg, prNumber, getPrDiffFn);

  // Extract plan and acceptance criteria from issue comments.
  const planAndAcs = extractPlanFromComments(detail.comments);

  // Extract eval summary from the evidence bundle when available.
  const evalSummary = opts.stateDir
    ? await gatherEvalSummary(opts.stateDir, issueNumber, readEvidenceBundleFn)
    : undefined;

  // Derive OpenSpec deltas from the worktree branch diff when applicable.
  const openspecDeltas = wt
    ? await gatherOpenspecDeltas(cfg, wt.path, gitDiffNamesFn, readSpecDeltasFnBound)
    : undefined;

  // Assemble prompt context.
  const prompt = buildShipcheckPrompt({
    rubric,
    issueBody: detail.body,
    planAndAcs,
    changedFiles: changedFilesSummary,
    evalSummary,
    openspecDeltas,
    contextSnapshot,
  });

  // Run reviewer harness up to max_rounds.
  const maxRounds = cfg.shipcheck_gate.max_rounds;
  const reviewerHarness = cfg.harnesses.reviewer;
  // Reuse cfg.review_timeout so repos can tune the reviewer latency budget centrally.
  const timeoutSec = cfg.review_timeout;

  let verdict: ShipcheckVerdict | null = null;
  let parseFailure = false;

  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate retry (round ${round}/${maxRounds})`);
    } else {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate invoking reviewer (${reviewerHarness})`);
    }

    let result: { stdout: string; success: boolean; timed_out?: boolean; stderr?: string };
    if (deps.invokeReviewer) {
      result = await deps.invokeReviewer(prompt, worktreeDir, timeoutSec);
    } else {
      const model = cfg.models.review;
      const harnessResult = await defaultInvoke(reviewerHarness, worktreeDir, prompt, {
        timeoutSec,
        model,
        accounting: opts.runDir
          ? {
              runDir: opts.runDir,
              runStoreDeps: opts.runStoreDeps,
              issue: issueNumber,
              stage: "shipcheck-gate",
              modelSlot: "review",
              model,
            }
          : undefined,
      });
      result = {
        stdout: harnessResult.stdout,
        success: harnessResult.success,
        timed_out: harnessResult.timed_out,
        stderr: harnessResult.stderr,
      };
    }

    // Only parse stdout from successful invocations. A non-zero exit, spawn error,
    // or timeout must be treated as a failed round regardless of any output on
    // stdout — a timed-out process that happened to print parseable JSON must not
    // silently pass the gate.
    if (!result.success) {
      parseFailure = true;
      if (!verdict) {
        const timedOut = result.timed_out === true;
        const prefix = timedOut ? "[reviewer timed out]" : "[reviewer exited non-zero]";
        const detail = timedOut
          ? `timed out after ${timeoutSec}s`
          : result.stdout.trim() || result.stderr?.trim() || "no output";
        verdict = {
          verdict: "fail",
          summary: `${prefix}: ${detail.slice(0, 500)}`,
          criteria: [],
        };
      }
      continue;
    }

    let warnCalled = false;
    const parsed = parseShipcheckVerdict(result.stdout, (msg) => {
      console.warn(msg);
      warnCalled = true;
    });
    if (!warnCalled) {
      // Clean parse.
      verdict = parsed;
      parseFailure = false;
      break;
    }
    // Warn was called → parse failure, keep the fallback verdict for now but try again.
    verdict = parsed;
    parseFailure = true;
  }

  // ---- POST-REVIEW HEAD-COHERENCE RECHECK (#317 Finding 2) ----
  // Guard against a push to the PR or worktree during the reviewer run (which can
  // take minutes). The reviewer evaluated prHeadSha; if either the PR head or the
  // worktree head has since changed, the evaluated state is no longer the merged state,
  // and advancing to ready-to-deploy would bless an unvalidated head.
  if (prHeadSha !== null && prNumber !== null) {
    let postReviewPrHeadSha: string;
    try {
      const finalPrDetail = await getPrDetailFn(cfg, prNumber);
      postReviewPrHeadSha = finalPrDetail.head_sha;
    } catch (err) {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate: post-review PR head re-fetch failed: ${err}`);
      await setBlockedFn(
        cfg, issueNumber,
        `Shipcheck gate: could not re-verify PR head after review: ${String(err)}`,
        "shipcheck-gate", "needs-human" as BlockerKind,
      );
      await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "post_review_head_error");
      return { advanced: false, status: "blocked", reason: "shipcheck: post-review PR head re-fetch failed", blockerKind: "needs-human" as BlockerKind };
    }
    if (postReviewPrHeadSha !== prHeadSha) {
      const driftNotice =
        `**Shipcheck head-drift notice**: The PR head changed from \`${prHeadSha.slice(0, 8)}\` to \`${postReviewPrHeadSha.slice(0, 8)}\` while the reviewer was running. Routing back to pre-merge to re-validate the new head.`;
      await postCommentFn(cfg, issueNumber, driftNotice);
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate: PR head drifted post-review (was=${prHeadSha.slice(0, 8)} now=${postReviewPrHeadSha.slice(0, 8)}); routing to pre-merge`);
      await transitionFn(cfg, issueNumber, "shipcheck-gate", "pre-merge", `PR head drifted during reviewer run (${prHeadSha.slice(0, 8)} → ${postReviewPrHeadSha.slice(0, 8)}); re-validating.`);
      return { advanced: true, from: "shipcheck-gate", to: "pre-merge", summary: `shipcheck: post-review head drift, re-routing to pre-merge (${prHeadSha.slice(0, 8)} → ${postReviewPrHeadSha.slice(0, 8)})` };
    }
    if (wt !== null) {
      let postReviewWorktreeHead: string;
      try {
        postReviewWorktreeHead = await getWorktreeHeadFn(wt.path);
      } catch (err) {
        console.log(`[pipeline] #${issueNumber}: shipcheck-gate: post-review worktree head re-read failed: ${err}`);
        await setBlockedFn(
          cfg, issueNumber,
          `Shipcheck gate: could not re-verify worktree head after review: ${String(err)}`,
          "shipcheck-gate", "needs-human" as BlockerKind,
        );
        await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "post_review_worktree_head_error");
        return { advanced: false, status: "blocked", reason: "shipcheck: post-review worktree head re-read failed", blockerKind: "needs-human" as BlockerKind };
      }
      if (postReviewWorktreeHead !== prHeadSha) {
        const driftReason = `Shipcheck gate: worktree HEAD (${postReviewWorktreeHead}) drifted from the evaluated PR head (${prHeadSha}) during the reviewer run. Push the local commits so the PR head includes the fix before re-running.`;
        console.log(`[pipeline] #${issueNumber}: shipcheck-gate: worktree head drifted post-review (worktree=${postReviewWorktreeHead.slice(0, 8)} pr=${prHeadSha.slice(0, 8)}); blocking`);
        await setBlockedFn(cfg, issueNumber, driftReason, "shipcheck-gate", "head-drift" as BlockerKind);
        await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "post_review_head_drift");
        return { advanced: false, status: "blocked", reason: "shipcheck: worktree head drifted post-review", blockerKind: "head-drift" as BlockerKind };
      }
    }
  }
  // ---- END POST-REVIEW HEAD-COHERENCE RECHECK ----

  // If all rounds produced parse failures, handle per mode.
  if (parseFailure && verdict && verdict.verdict === "fail" && verdict.criteria.length === 0) {
    if (cfg.shipcheck_gate.mode === "gate") {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate parse failure after ${maxRounds} rounds (gate mode); blocking`);
      await setBlockedFn(
        cfg,
        issueNumber,
        `Shipcheck gate: could not parse a valid verdict from the reviewer after ${maxRounds} round(s). Raw output:\n\n${verdict.summary}`,
        "shipcheck-gate",
        "needs-human" as BlockerKind,
      );
      await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "parse_failure");
      return { advanced: false, status: "blocked", reason: "shipcheck parse failure after max rounds", blockerKind: "needs-human" as BlockerKind };
    }
    // Advisory: warn and advance.
    console.warn(`[pipeline] #${issueNumber}: shipcheck-gate parse failure (advisory mode); advancing`);
    const eligibilitySuffixPf = await maybeRunEligibilityGate(cfg, issueNumber, prNumber, worktreeDir, opts, deps);
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "Shipcheck parse failure (advisory mode); advancing.");
    await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "parse_failure");
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: `shipcheck parse failure (advisory)${eligibilitySuffixPf}` };
  }

  if (!verdict) {
    // Harness produced no output at all.
    if (cfg.shipcheck_gate.mode === "gate") {
      await setBlockedFn(cfg, issueNumber, "Shipcheck gate: reviewer harness produced no output.", "shipcheck-gate", "needs-human" as BlockerKind);
      await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "no_output");
      return { advanced: false, status: "blocked", reason: "shipcheck: no harness output", blockerKind: "needs-human" as BlockerKind };
    }
    const eligibilitySuffixNo = await maybeRunEligibilityGate(cfg, issueNumber, prNumber, worktreeDir, opts, deps);
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "Shipcheck: no harness output (advisory); advancing.");
    await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode, "no_output");
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: `shipcheck no output (advisory)${eligibilitySuffixNo}` };
  }

  // Post verdict comment. Issue comment is authoritative; PR mirror is best-effort
  // so a transient PR API failure cannot strand the gate before it blocks/advances.
  // Embed prHeadSha so the next entry can detect post-verdict developer commits.
  const comment = formatShipcheckComment(verdict, cfg.shipcheck_gate.mode, prHeadSha ?? undefined);
  await postCommentFn(cfg, issueNumber, comment);
  if (prNumber) {
    try {
      await postPrCommentFn(cfg, prNumber, comment);
    } catch (err) {
      console.warn(`[pipeline] #${issueNumber}: shipcheck-gate: PR mirror comment failed (non-fatal): ${String(err)}`);
    }
  }

  // Route based on mode and verdict.
  if (cfg.shipcheck_gate.mode === "advisory") {
    console.log(`[pipeline] #${issueNumber}: shipcheck-gate verdict=${verdict.verdict} (advisory mode); advancing`);
    const eligibilitySuffix = await maybeRunEligibilityGate(cfg, issueNumber, prNumber, worktreeDir, opts, deps);
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", `Shipcheck verdict: ${verdict.verdict} (advisory mode).`);
    await recordGateResult(opts, verdict.verdict, cfg.shipcheck_gate.mode);
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: `shipcheck ${verdict.verdict} (advisory)${eligibilitySuffix}` };
  }

  // Gate mode.
  if (verdict.verdict === "pass") {
    console.log(`[pipeline] #${issueNumber}: shipcheck-gate passed; advancing`);
    const eligibilitySuffix = await maybeRunEligibilityGate(cfg, issueNumber, prNumber, worktreeDir, opts, deps);
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "Shipcheck passed.");
    await recordGateResult(opts, "pass", cfg.shipcheck_gate.mode);
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: `shipcheck passed${eligibilitySuffix}` };
  }

  if (verdict.verdict === "partial") {
    if (cfg.shipcheck_gate.block_on_partial) {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate partial verdict + block_on_partial; blocking`);
      await setBlockedFn(cfg, issueNumber, `Shipcheck gate: partial verdict.\n\n${verdict.summary}`, "shipcheck-gate", "shipcheck-failed" as BlockerKind);
      await recordGateResult(opts, "partial", cfg.shipcheck_gate.mode);
      return { advanced: false, status: "blocked", reason: "shipcheck partial verdict", blockerKind: "shipcheck-failed" as BlockerKind };
    }
    console.log(`[pipeline] #${issueNumber}: shipcheck-gate partial verdict (block_on_partial=false); advancing`);
    const eligibilitySuffix = await maybeRunEligibilityGate(cfg, issueNumber, prNumber, worktreeDir, opts, deps);
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "Shipcheck partial verdict (block_on_partial: false).");
    await recordGateResult(opts, "partial", cfg.shipcheck_gate.mode);
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: `shipcheck partial (not blocking)${eligibilitySuffix}` };
  }

  // Fail verdict in gate mode.
  console.log(`[pipeline] #${issueNumber}: shipcheck-gate failed (gate mode); blocking`);
  await setBlockedFn(cfg, issueNumber, `Shipcheck gate failed.\n\n${verdict.summary}`, "shipcheck-gate", "shipcheck-failed" as BlockerKind);
  await recordGateResult(opts, "fail", cfg.shipcheck_gate.mode);
  return { advanced: false, status: "blocked", reason: "shipcheck fail verdict", blockerKind: "shipcheck-failed" as BlockerKind };
}

// ---------------------------------------------------------------------------
// Eligibility gate integration (#306)
// ---------------------------------------------------------------------------

/**
 * Invoke the auto-merge eligibility gate when enabled (config.auto_merge_eligibility.enabled).
 * Called on every path that advances to `ready-to-deploy`.
 * Returns a summary suffix string for the stage summary comment, or "" when disabled.
 * Errors are caught and logged — gate failures NEVER block ready-to-deploy.
 */
async function maybeRunEligibilityGate(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number | null,
  worktreeDir: string,
  opts: AdvanceShipcheckOpts,
  deps: ShipcheckDeps,
): Promise<string> {
  if (!cfg.auto_merge_eligibility?.enabled) return "";
  if (!prNumber) {
    console.log(`[pipeline] #${issueNumber}: auto-merge-eligibility: no PR linked; skipping`);
    return "";
  }
  try {
    console.log(`[pipeline] #${issueNumber}: auto-merge-eligibility: running eligibility gate`);
    // Read actual review verdict from evidence bundle (not synthetic).
    let actualReviewVerdict: { verdict: string; findingCount: number; recordedAt: string } | null = null;
    let actualRunId: string = opts.runDir ?? "";
    if (opts.stateDir) {
      const readBundleFn = deps.readEvidenceBundle ?? defaultReadBundle;
      const bundle = await readBundleFn(opts.stateDir, issueNumber).catch(() => null);
      if (bundle && bundle.reviews.length > 0) {
        const latest = bundle.reviews.reduce((a, b) => (b.round > a.round ? b : a));
        actualReviewVerdict = {
          verdict: latest.verdict,
          findingCount: Object.values(latest.findingCounts).reduce((s, n) => s + n, 0),
          recordedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        };
      }
      if (bundle?.runId) actualRunId = bundle.runId;
      // Refresh bundle PR identity when the bundle was created before the PR existed
      // (bundle.pr is null at run-start; the finalizer patches it only after all stages
      // complete, but shipcheck runs before that). Refresh now so the eligibility gate
      // identity check (bundle.pr === prNumber) can pass.
      if (bundle !== null && (bundle.pr === null || bundle.pr === undefined)) {
        const patchFn = deps.patchBundleIdentityFn ?? defaultPatchBundleIdentity;
        await patchFn(opts.stateDir, issueNumber, { pr: prNumber }).catch((e: unknown) => {
          console.warn(
            `[pipeline] #${issueNumber}: auto-merge-eligibility: failed to refresh bundle PR identity (non-fatal): ${(e as Error).message}`,
          );
        });
      }
    }
    const gateFn = deps.runEligibilityGateFn ?? runEligibilityGate;
    const artifact = await gateFn(
      cfg,
      issueNumber,
      prNumber,
      {
        stateDir: opts.stateDir,
        worktreeDir,
        runId: actualRunId,
        reviewVerdict: actualReviewVerdict,
        issueScope: "(see issue body)",
      },
      deps.eligibilityGateDeps ?? {},
    );
    const line = formatEligibilityVerdict(artifact);
    console.log(`[pipeline] #${issueNumber}: ${line}`);
    return `\n${line}`;
  } catch (err) {
    console.warn(
      `[pipeline] #${issueNumber}: auto-merge-eligibility: gate error (non-fatal): ${(err as Error).message}`,
    );
    return "";
  }
}

// ---------------------------------------------------------------------------
// Rubric loading
// ---------------------------------------------------------------------------

/**
 * Load the rubric from the configured file path. When absent, logs a warning
 * and returns the provided fallback text (typically the issue's acceptance
 * criteria section or full body).
 *
 * Rejects absolute rubric_path values and paths that normalize outside the repo
 * root to prevent local file disclosure via a malicious .github/pipeline.yml.
 * Also resolves symlinks (via realpathFn) and rejects rubric files whose real
 * path exits the repo boundary — closing the symlink-escape class.
 */
function loadRubric(cfg: PipelineConfig, deps: ShipcheckDeps, fallback: string): string {
  const repoDir = path.resolve(cfg.repo_dir);
  const rubricPath = path.resolve(cfg.repo_dir, cfg.shipcheck_gate.rubric_path);

  // Check at the file-read boundary: reject absolute rubric_path and any path
  // that normalizes to outside the repo root (e.g. "../../etc/passwd").
  if (
    path.isAbsolute(cfg.shipcheck_gate.rubric_path) ||
    !rubricPath.startsWith(repoDir + path.sep)
  ) {
    console.warn(
      `[pipeline] shipcheck: rubric_path "${cfg.shipcheck_gate.rubric_path}" resolves outside the repo root; using issue acceptance criteria as rubric.`,
    );
    return fallback;
  }

  // Resolve symlinks: a repo-local path could be a symlink whose target exits
  // the repo (e.g. .github/shipcheck-rubric.md → /etc/passwd). Call realpathFn
  // on both repo and rubric to get canonical paths, then recheck the boundary.
  // When realpathFn throws (file not found, dir not found) we fall through to
  // readFileFn which returns null for missing files — no change in that path.
  const realpathFn = deps.realpathFn ?? ((p: string) => fs.realpathSync(p) as string);
  try {
    const realRepo = realpathFn(repoDir);
    const realRubric = realpathFn(rubricPath);
    if (!realRubric.startsWith(realRepo + path.sep) && realRubric !== realRepo) {
      console.warn(
        `[pipeline] shipcheck: rubric_path "${cfg.shipcheck_gate.rubric_path}" resolves via symlink to a path outside the repo; using issue acceptance criteria as rubric.`,
      );
      return fallback;
    }
  } catch {
    // realpathFn threw (file or dir does not exist) — fall through to readFileFn.
  }

  const readFileFn = deps.readFile ?? defaultReadFile;
  const contents = readFileFn(rubricPath);
  if (contents !== null) return contents;

  console.warn(
    `[pipeline] shipcheck: rubric file not found at ${rubricPath}; using issue acceptance criteria as rubric.`,
  );
  return fallback;
}

function defaultReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context assembly helpers
// ---------------------------------------------------------------------------

/**
 * Extract an acceptance-criteria section from an issue body, or return "".
 * Looks for a heading matching /acceptance crit/i or /^## ac$/i.
 */
export function extractAcceptanceCriteria(body: string): string {
  const m = body.match(
    /(?:^|\n)(#{1,3} (?:[Aa]cceptance [Cc]riteria|AC)\b[\s\S]*?)(?=\n#{1,3} |\n---|\n\*{3}|$)/,
  );
  return m ? m[1].trim() : "";
}

/**
 * Extract the implementation plan + ACs from the issue's comment history.
 * Scans newest-first so that a "## Revised Implementation Plan" posted after
 * plan-review takes precedence over the stale original plan.
 */
function extractPlanFromComments(
  comments: { author: string; body: string; createdAt: string }[],
): string {
  const reversed = [...comments].reverse();
  // Prefer the revised plan posted after plan-review.
  for (const c of reversed) {
    if (c.body.startsWith("## Revised Implementation Plan")) {
      return c.body.slice(0, 4000);
    }
  }
  // Fall back to the latest original plan.
  for (const c of reversed) {
    if (c.body.startsWith("## Implementation Plan")) {
      return c.body.slice(0, 4000);
    }
  }
  return "(not available)";
}

/**
 * Build a changed-files summary from the PR diff, including per-file line-count
 * deltas (additions/deletions) parsed from the unified diff body.
 * Falls back gracefully when no PR is linked or the diff fetch fails.
 */
async function gatherChangedFiles(
  cfg: PipelineConfig,
  prNumber: number | null,
  getPrDiffFn: typeof defaultGetPrDiff,
): Promise<string> {
  if (!prNumber) return "(no PR linked)";
  try {
    const diff = await getPrDiffFn(cfg, prNumber);
    const files: { filePath: string; additions: number; deletions: number }[] = [];
    let current: { filePath: string; additions: number; deletions: number } | null = null;

    for (const line of diff.split("\n")) {
      const m = line.match(/^diff --git a\/(.*) b\//);
      if (m) {
        if (current) files.push(current);
        current = { filePath: m[1], additions: 0, deletions: 0 };
      } else if (current) {
        // Count added/removed lines; skip the unified diff header lines (+++ / ---).
        if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
      }
    }
    if (current) files.push(current);

    if (!files.length) return "(no files changed)";
    return files.map((f) => `${f.filePath} (+${f.additions} -${f.deletions})`).join("\n");
  } catch {
    return "(changed files: see PR diff)";
  }
}

/**
 * Extract an eval summary from the evidence bundle at stateDir.
 * Returns a short human-readable string or undefined when unavailable.
 */
async function gatherEvalSummary(
  stateDir: string,
  issueNumber: number,
  readBundleFn: (stateDir: string, issue: number) => Promise<EvidenceBundle | null>,
): Promise<string | undefined> {
  try {
    const bundle = await readBundleFn(stateDir, issueNumber);
    if (!bundle) return undefined;
    const evalStage = bundle.stages.find((s) => s.stage === "eval-gate");
    if (!evalStage) return undefined;
    const lastCmd = evalStage.commands[evalStage.commands.length - 1];
    if (!lastCmd) return undefined;
    const outcome = lastCmd.exitCode === 0 ? "PASS" : "FAIL";
    return `eval-gate: ${outcome}\n${lastCmd.outputExcerpt}`;
  } catch {
    return undefined;
  }
}

/**
 * Archive change dir names referenced by a list of repo-relative diff paths.
 * Matches `openspec/changes/archive/<name>/…` and returns the full dir name
 * (which is date-prefixed in this repo, e.g. "2026-06-08-add-eval-gate").
 * Pure; exported for tests.
 */
export function archiveNamesFromPaths(paths: string[]): string[] {
  const names = new Set<string>();
  for (const p of paths) {
    const m = p.replace(/\\/g, "/").match(/(?:^|\/)openspec\/changes\/archive\/([^/]+)\//);
    if (m) names.add(m[1]);
  }
  return [...names];
}

/**
 * Derive OpenSpec spec deltas from the worktree's branch diff.
 *
 * Pre-merge archives active change dirs before routing to shipcheck, so the
 * normal active-path check inside openspecContextFromDiff returns nothing for
 * those changes. The diff then shows `openspec/changes/archive/<date>-<id>/…`
 * paths instead — we extract the full (date-prefixed) archive dir name from
 * those paths and read the spec deltas directly from the archive location.
 *
 * Two bugs in the prior implementation:
 *   1. changeIdsFromPaths explicitly ignores archive paths (m[1] !== "archive").
 *   2. Even if IDs were found, "archive/<id>" skipped the date prefix so the
 *      lookup dir didn't exist (real path is "archive/<date>-<id>").
 * archiveNamesFromPaths fixes both by extracting the full archive dir name.
 */
async function gatherOpenspecDeltas(
  cfg: PipelineConfig,
  wtPath: string,
  gitDiffNamesFn: (wtPath: string, base: string) => Promise<string[]>,
  readSpecDeltasFn: (wtPath: string, name: string) => string,
): Promise<string | undefined> {
  try {
    const diffPaths = await gitDiffNamesFn(wtPath, cfg.base_branch);

    // Try active change dirs first (the normal pre-archive path).
    const activeDeltas = openspecContextFromDiff(cfg, wtPath, diffPaths);
    if (activeDeltas) return activeDeltas;

    // After pre-merge archives the change, active dirs are gone and the diff
    // shows `openspec/changes/archive/<date>-<id>/…` paths. Respect explicit
    // opt-out; presence of archive paths in the diff implies the integration
    // is otherwise active for this repo.
    if (cfg.openspec?.enabled === "off") return undefined;
    const archiveNames = archiveNamesFromPaths(diffPaths);
    if (!archiveNames.length) return undefined;
    const archivedParts = archiveNames
      .map((name) => readSpecDeltasFn(wtPath, `archive/${name}`))
      .filter(Boolean);
    return archivedParts.length ? archivedParts.join("\n\n") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns true when the comment body is a shipcheck verdict comment (gate or advisory),
 * regardless of whether it carries the `shipcheck-sha` sentinel. Used to detect legacy
 * verdict comments posted before the sentinel was added (#317 Finding 2, review-2).
 */
function isShipcheckVerdictBody(body: string): boolean {
  return body.startsWith("## Shipcheck\n") || body.startsWith("## Shipcheck (advisory)\n");
}

/** Default git diff --name-only implementation. */
async function defaultGitDiffNames(wtPath: string, base: string): Promise<string[]> {
  const result = await defaultGitInWorktree(
    wtPath,
    ["diff", "--name-only", `origin/${base}...HEAD`],
    { ignoreFailure: true },
  );
  return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Default worktree HEAD reader. Throws when git returns a non-40-char SHA. */
async function defaultGetWorktreeHead(wtPath: string): Promise<string> {
  const result = await defaultGitInWorktree(wtPath, ["rev-parse", "HEAD"], { ignoreFailure: true });
  const sha = result.stdout.trim();
  if (sha.length !== 40) {
    throw new Error(`git rev-parse HEAD in ${wtPath} returned invalid SHA: "${sha}"`);
  }
  return sha;
}
