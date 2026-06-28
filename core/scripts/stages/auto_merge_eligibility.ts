// Auto-merge eligibility gate (#306).
//
// Runs inside shipcheck-gate after all existing checks pass. Does NOT block
// ready-to-deploy — it only classifies the PR and writes a durable artifact.
//
// Flow:
//   1. Deterministic policy envelope — hard-deny on any high-risk category.
//   2. If all checks pass, invoke the LLM judge for a structured risk classification.
//   3. Validate judge output and check confidence threshold.
//   4. Write AutoMergeEligibilityArtifact to the evidence bundle.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPrChecks as defaultGetPrChecks,
  getPrDetail as defaultGetPrDetail,
  getPrDiff as defaultGetPrDiff,
  getUnresolvedReviewThreadCount as defaultGetUnresolvedThreadCount,
  parseChecksAggregate,
} from "../gh.ts";
import { invoke as defaultInvoke } from "../harness.ts";
import { substitute } from "../prompts/index.ts";
import { ELIGIBILITY_JUDGE_SCHEMA_BLOCK } from "../auto-merge-eligibility-schema.ts";
import type {
  AutoMergeEligibilityArtifact,
  CheckRun,
  EligibilityCheckResult,
  EligibilityJudgeOutput,
  PipelineConfig,
  PrDetail,
} from "../types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Built-in deny patterns — compile-time constant, NOT overridable by config.
// These represent high-risk categories where deterministic classification is
// more reliable than LLM judgment. Patterns match repo-relative file paths.
// ---------------------------------------------------------------------------

export const BUILT_IN_DENY_PATTERNS: readonly RegExp[] = [
  // Migrations
  /(?:^|\/)migrations?\//i,
  /\.migration\.[a-z]+$/i,
  // Auth / authorization
  /(?:^|\/)auth(?:entication|orization)?\//i,
  // Billing / payments
  /(?:^|\/)(?:billing|payment[s]?)\//i,
  // Security
  /(?:^|\/)security\//i,
  // Infrastructure / deployment config
  /(?:^|\/)(?:infra(?:structure)?|deploy(?:ment)?|terraform|kubernetes?|k8s)\//i,
  // Secrets / env files
  /(?:^|\/)secrets?\//i,
  /(?:^|\/)\.env(?:$|\.)/,
  // Dependency manifests and lock files at any path depth
  /(?:^|\/)package\.json$/,
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|Pipfile\.lock|Gemfile\.lock|composer\.lock)$/,
  // Cron / schedulers
  /(?:^|\/)cron(?:tab)?\//i,
  /(?:^|\/)schedulers?\//i,
  // Public API surface files
  /openapi\./i,
  /swagger\./i,
  /\.graphqls?(?:$|\.)/i,
  // CI / release workflows
  /(?:^|\/)\.github\/workflows?\//i,
  /^CHANGELOG/i,
  /(?:^|\/)releases?\//i,
  // Production config
  /\.prod\./i,
  /(?:^|\/)production\//i,
  /\.production\./i,
];

// ---------------------------------------------------------------------------
// Glob pattern matching for deny_paths / allow_paths config
// ---------------------------------------------------------------------------

function matchesGlob(filePath: string, pattern: string): boolean {
  // Convert simple glob to regex: ** matches any path segment(s), * matches non-slash chars
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§§/g, ".*");
  try {
    return new RegExp(`^${regexStr}$`).test(filePath);
  } catch {
    return false;
  }
}

function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(filePath, p));
}

// ---------------------------------------------------------------------------
// Diff parsing helpers
// ---------------------------------------------------------------------------

export function parseDiffFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/(.*) b\//);
    if (m) files.push(m[1]);
  }
  return files;
}

export function countDiffLines(diff: string): number {
  let count = 0;
  for (const line of diff.split("\n")) {
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Deterministic checks
// ---------------------------------------------------------------------------

export interface DeterministicCheckResult {
  passed: boolean;
  checks: EligibilityCheckResult[];
  denial_reasons: string[];
}

export function runDeterministicChecks(
  cfg: PipelineConfig,
  prDetail: PrDetail,
  changedFiles: string[],
  diffLines: number,
  ciPassed: boolean,
  ciSha: string,
  hasCleanReviewVerdict: boolean,
  hasEvidenceBundle: boolean,
  diffText: string,
  opts?: { unresolvedThreadCount?: number; noTestRationale?: string },
): DeterministicCheckResult {
  const checks: EligibilityCheckResult[] = [];
  const denial_reasons: string[] = [];

  function addCheck(check: string, passed: boolean, reason?: string) {
    checks.push({ check, passed, ...(reason !== undefined ? { reason } : {}) });
    if (!passed && reason) denial_reasons.push(reason);
  }

  // 1. Built-in deny path patterns
  for (const file of changedFiles) {
    for (const pattern of BUILT_IN_DENY_PATTERNS) {
      if (pattern.test(file)) {
        const label = patternLabel(pattern);
        addCheck("built_in_deny_patterns", false, `touches: ${label} (${file})`);
        // Only record one denial per file (first matching pattern wins)
        break;
      }
    }
  }
  // Record a single pass entry if no files triggered a built-in pattern
  const anyBuiltInDeny = checks.some((c) => c.check === "built_in_deny_patterns" && !c.passed);
  if (!anyBuiltInDeny) {
    addCheck("built_in_deny_patterns", true);
  }

  // 2. Diff line threshold
  const maxLines = cfg.auto_merge_eligibility.max_diff_lines;
  if (diffLines > maxLines) {
    addCheck("max_diff_lines", false, `diff_lines: ${diffLines} exceeds max ${maxLines}`);
  } else {
    addCheck("max_diff_lines", true);
  }

  // 3. File count threshold
  const maxFiles = cfg.auto_merge_eligibility.max_files;
  if (changedFiles.length > maxFiles) {
    addCheck("max_files", false, `file_count: ${changedFiles.length} exceeds max ${maxFiles}`);
  } else {
    addCheck("max_files", true);
  }

  // 4. Config deny_paths patterns
  const denyPaths = cfg.auto_merge_eligibility.deny_paths;
  if (denyPaths.length > 0) {
    for (const file of changedFiles) {
      if (matchesAnyGlob(file, denyPaths)) {
        addCheck("deny_paths", false, `deny_paths: ${file} matched configured pattern`);
        break;
      }
    }
    const anyDenyPathFail = checks.some((c) => c.check === "deny_paths" && !c.passed);
    if (!anyDenyPathFail) {
      addCheck("deny_paths", true);
    }
  } else {
    addCheck("deny_paths", true);
  }

  // 5. Config allow_paths (when non-empty, all files must be covered)
  const allowPaths = cfg.auto_merge_eligibility.allow_paths;
  if (allowPaths.length > 0) {
    const uncovered = changedFiles.filter((f) => !matchesAnyGlob(f, allowPaths));
    if (uncovered.length > 0) {
      addCheck(
        "allow_paths",
        false,
        `allow_paths: files not covered by allow list: ${uncovered.slice(0, 3).join(", ")}`,
      );
    } else {
      addCheck("allow_paths", true);
    }
  } else {
    addCheck("allow_paths", true);
  }

  // 6. CI success
  if (!ciPassed) {
    addCheck("ci_success", false, "ci: no passing run");
  } else {
    addCheck("ci_success", true);
  }

  // 7. Clean review verdict
  if (!hasCleanReviewVerdict) {
    addCheck("review_verdict", false, "review: verdict is not approved");
  } else {
    addCheck("review_verdict", true);
  }

  // 8. Evidence bundle completeness
  if (!hasEvidenceBundle) {
    addCheck("evidence_bundle", false, "missing_evidence: evidence bundle absent");
  } else {
    addCheck("evidence_bundle", true);
  }

  // 9. Behavioral change without tests check
  const sourceFiles = changedFiles.filter(
    (f) => !isTestFile(f) && isSourceFile(f),
  );
  const testFiles = changedFiles.filter((f) => isTestFile(f));
  const noTestRationale = opts?.noTestRationale;
  if (sourceFiles.length > 0 && testFiles.length === 0 && !noTestRationale) {
    addCheck(
      "behavioral_change_without_tests",
      false,
      "missing_tests: behavioral change without tests or rationale",
    );
  } else {
    addCheck("behavioral_change_without_tests", true);
  }

  // 10. Unresolved review comment threads
  const unresolvedCount = opts?.unresolvedThreadCount ?? 0;
  if (unresolvedCount > 0) {
    addCheck(
      "unresolved_review_comments",
      false,
      `unresolved_review_comments: ${unresolvedCount}`,
    );
  } else {
    addCheck("unresolved_review_comments", true);
  }

  const passed = denial_reasons.length === 0;
  return { passed, checks, denial_reasons };
}

function patternLabel(pattern: RegExp): string {
  const src = pattern.source;
  if (/migration/i.test(src)) return "migrations";
  if (/auth/i.test(src)) return "auth";
  if (/billing|payment/i.test(src)) return "billing";
  if (/security/i.test(src)) return "security";
  if (/infra|deploy|terraform|kubernetes|k8s/i.test(src)) return "infrastructure";
  if (/secret|\.env/i.test(src)) return "secrets";
  if (/package(?:\.json|-lock)|yarn\.lock|pnpm|Cargo\.lock|go\.sum|Pipfile|Gemfile|composer/i.test(src)) return "dependency_manifest";
  if (/cron|schedule/i.test(src)) return "cron_scheduler";
  if (/openapi|swagger|graphql/i.test(src)) return "public_api";
  if (/github\/workflow|CHANGELOG|release/i.test(src)) return "release_config";
  if (/prod/i.test(src)) return "production_config";
  return "high_risk_path";
}

function isTestFile(filePath: string): boolean {
  return (
    /\.test\.[jt]sx?$/.test(filePath) ||
    /\.spec\.[jt]sx?$/.test(filePath) ||
    /(?:^|\/)(?:test|tests|__tests__)\//.test(filePath) ||
    /(?:^|\/)(?:spec|specs)\//.test(filePath)
  );
}

function isSourceFile(filePath: string): boolean {
  return /\.[jt]sx?$/.test(filePath) || /\.py$/.test(filePath) || /\.go$/.test(filePath) ||
    /\.rb$/.test(filePath) || /\.rs$/.test(filePath) || /\.java$/.test(filePath) ||
    /\.cs$/.test(filePath) || /\.cpp$/.test(filePath) || /\.c$/.test(filePath);
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function loadJudgeTemplate(): string {
  return fs.readFileSync(
    path.join(here, "../prompts/auto_merge_eligibility_judge.md"),
    "utf8",
  );
}

export function buildJudgePrompt(opts: {
  prDiffSummary: string;
  fileList: string;
  reviewVerdict: string;
  ciStatus: string;
  evidenceMetadata: string;
  issueScope: string;
}): string {
  return substitute(loadJudgeTemplate(), {
    pr_diff_summary: opts.prDiffSummary,
    file_list: opts.fileList,
    review_verdict: opts.reviewVerdict,
    ci_status: opts.ciStatus,
    evidence_metadata: opts.evidenceMetadata,
    issue_scope: opts.issueScope,
    schema_block: ELIGIBILITY_JUDGE_SCHEMA_BLOCK,
  });
}

// ---------------------------------------------------------------------------
// Judge output parsing and validation
// ---------------------------------------------------------------------------

export type JudgeParseResult =
  | { ok: true; output: EligibilityJudgeOutput }
  | { ok: false; reason: string };

export function parseAndValidateJudgeOutput(raw: string): JudgeParseResult {
  // Try fenced block first, then bare JSON
  const fencedMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates = fencedMatch ? [fencedMatch[1], raw] : [raw];

  for (const candidate of candidates) {
    const jsonStart = candidate.indexOf("{");
    const jsonEnd = candidate.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.slice(jsonStart, jsonEnd + 1));
    } catch {
      continue;
    }
    const result = validateJudgeOutput(parsed);
    if (result.ok) return result;
  }

  return { ok: false, reason: "judge: schema validation failed" };
}

function validateJudgeOutput(parsed: unknown): JudgeParseResult {
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "judge: schema validation failed" };
  }
  const o = parsed as Record<string, unknown>;

  const scopeSizes = ["tiny", "small", "medium", "large"];
  const blastRadii = ["low", "medium", "high"];
  const semanticRisks = ["mechanical", "localized_behavior", "cross_cutting_behavior"];
  const reversibilities = ["trivial", "normal", "painful"];

  if (!scopeSizes.includes(o.scope_size as string)) {
    return { ok: false, reason: "judge: schema validation failed" };
  }
  if (!blastRadii.includes(o.blast_radius as string)) {
    return { ok: false, reason: "judge: schema validation failed" };
  }
  if (!semanticRisks.includes(o.semantic_risk as string)) {
    return { ok: false, reason: "judge: schema validation failed" };
  }
  if (!reversibilities.includes(o.reversibility as string)) {
    return { ok: false, reason: "judge: schema validation failed" };
  }
  if (typeof o.confidence !== "number" || o.confidence < 0 || o.confidence > 1) {
    return { ok: false, reason: "judge: schema validation failed" };
  }
  if (!Array.isArray(o.reasons) || o.reasons.length === 0) {
    return { ok: false, reason: "judge: schema validation failed" };
  }
  if (!Array.isArray(o.denial_reasons)) {
    return { ok: false, reason: "judge: schema validation failed" };
  }

  return {
    ok: true,
    output: {
      scope_size: o.scope_size as EligibilityJudgeOutput["scope_size"],
      blast_radius: o.blast_radius as EligibilityJudgeOutput["blast_radius"],
      semantic_risk: o.semantic_risk as EligibilityJudgeOutput["semantic_risk"],
      reversibility: o.reversibility as EligibilityJudgeOutput["reversibility"],
      confidence: o.confidence as number,
      reasons: o.reasons as string[],
      denial_reasons: o.denial_reasons as string[],
    },
  };
}

// ---------------------------------------------------------------------------
// Artifact builder
// ---------------------------------------------------------------------------

export function buildEligibilityArtifact(opts: {
  eligibility: AutoMergeEligibilityArtifact["eligibility"];
  evaluatedAt: string;
  deterministicChecks: EligibilityCheckResult[];
  denialReasons: string[];
  judgeOutput: EligibilityJudgeOutput | null;
  ciStatusSnapshot: AutoMergeEligibilityArtifact["ci_status_snapshot"];
  reviewVerdictSnapshot: AutoMergeEligibilityArtifact["review_verdict_snapshot"];
  linkedRunId: string;
  linkedIssue: number;
  linkedPr: number;
  headSha: string;
}): AutoMergeEligibilityArtifact {
  return {
    eligibility: opts.eligibility,
    evaluated_at: opts.evaluatedAt,
    deterministic_checks: opts.deterministicChecks,
    denial_reasons: opts.denialReasons,
    judge_output: opts.judgeOutput,
    ci_status_snapshot: opts.ciStatusSnapshot,
    review_verdict_snapshot: opts.reviewVerdictSnapshot,
    linked_run_id: opts.linkedRunId,
    linked_issue: opts.linkedIssue,
    linked_pr: opts.linkedPr,
    revert_note: `git revert ${opts.headSha}`,
  };
}

// ---------------------------------------------------------------------------
// Deps seam
// ---------------------------------------------------------------------------

export interface EligibilityGateDeps {
  getPrDetail?: typeof defaultGetPrDetail;
  getPrChecks?: typeof defaultGetPrChecks;
  getPrDiff?: typeof defaultGetPrDiff;
  /** Return the count of unresolved review-comment threads on the PR. */
  getPrUnresolvedThreadCount?: (
    cfg: PipelineConfig,
    prNumber: number,
  ) => Promise<number>;
  /** Read the evidence bundle for the run. Returns null when absent. */
  readEvidenceBundle?: (
    stateDir: string,
    issue: number,
  ) => Promise<{ runId: string; no_test_rationale?: string } | null>;
  /** Invoke the reviewer/judge harness. Returns stdout and success flag. */
  invokeJudge?: (
    prompt: string,
    worktreeDir: string,
    timeoutSec: number,
  ) => Promise<{ stdout: string; success: boolean; timed_out?: boolean }>;
  /** Write the eligibility artifact to the evidence bundle. */
  recordArtifact?: (
    stateDir: string,
    issue: number,
    artifact: AutoMergeEligibilityArtifact,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

export interface EligibilityGateOpts {
  /** Evidence-bundle state dir (for writing artifact). */
  stateDir?: string;
  /** Worktree dir for judge harness invocation. */
  worktreeDir: string;
  /** Pipeline run ID to embed in the artifact. */
  runId: string;
  /** Review verdict context (from issue comments or evidence bundle). */
  reviewVerdict: { verdict: string; findingCount: number; recordedAt: string } | null;
  /** Issue scope from the planning comment (for judge context). */
  issueScope: string;
}

/**
 * Run the auto-merge eligibility gate.
 * - Runs deterministic checks first.
 * - If all pass, invokes the LLM judge.
 * - Writes the artifact to the evidence bundle (when stateDir is set).
 * - Never throws — catches gate errors and returns a needs-human artifact.
 */
export async function runEligibilityGate(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  opts: EligibilityGateOpts,
  deps: EligibilityGateDeps = {},
): Promise<AutoMergeEligibilityArtifact> {
  const evaluatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const getPrDetailFn = deps.getPrDetail ?? defaultGetPrDetail;
  const getPrChecksFn = deps.getPrChecks ?? defaultGetPrChecks;
  const getPrDiffFn = deps.getPrDiff ?? defaultGetPrDiff;
  const getUnresolvedFn = deps.getPrUnresolvedThreadCount ?? defaultGetUnresolvedThreadCount;

  let prDetail: PrDetail;
  let diffText: string;
  let checks: CheckRun[];

  try {
    [prDetail, diffText, checks] = await Promise.all([
      getPrDetailFn(cfg, prNumber),
      getPrDiffFn(cfg, prNumber),
      getPrChecksFn(cfg, prNumber),
    ]);
  } catch (err) {
    const artifact = buildNeedsHumanArtifact(
      evaluatedAt,
      [],
      [`judge: harness error or timeout — fetch failed: ${(err as Error).message}`],
      null,
      issueNumber,
      prNumber,
      opts.runId,
      "",
      opts.reviewVerdict,
    );
    await tryRecordArtifact(cfg, opts, issueNumber, artifact, deps);
    return artifact;
  }

  // Finding 3: fetch unresolved review thread count; fail-safe deny on error.
  let unresolvedThreadCount: number;
  try {
    unresolvedThreadCount = await getUnresolvedFn(cfg, prNumber);
  } catch (err) {
    const artifact = buildEligibilityArtifact({
      eligibility: "needs-human",
      evaluatedAt,
      deterministicChecks: [],
      denialReasons: [`unresolved_review_comments: query failed — ${(err as Error).message}`],
      judgeOutput: null,
      ciStatusSnapshot: { sha: prDetail.head_sha, conclusion: "unknown", checked_at: evaluatedAt },
      reviewVerdictSnapshot: {
        verdict: opts.reviewVerdict?.verdict ?? "unknown",
        finding_count: opts.reviewVerdict?.findingCount ?? 0,
        recorded_at: opts.reviewVerdict?.recordedAt ?? evaluatedAt,
      },
      linkedRunId: opts.runId,
      linkedIssue: issueNumber,
      linkedPr: prNumber,
      headSha: prDetail.head_sha,
    });
    await tryRecordArtifact(cfg, opts, issueNumber, artifact, deps);
    return artifact;
  }

  // Finding 4: load and validate the evidence bundle before deterministic checks.
  let hasEvidenceBundle = false;
  let noTestRationale: string | undefined;
  if (opts.stateDir) {
    const readBundleFn = deps.readEvidenceBundle ?? (async (sd: string, iss: number) => {
      const { readBundle } = await import("../evidence-bundle.ts");
      return readBundle(sd, iss);
    });
    const bundle = await readBundleFn(opts.stateDir, issueNumber).catch(() => null);
    hasEvidenceBundle = bundle !== null && !!bundle.runId;
    noTestRationale = bundle?.no_test_rationale;
  }

  const headSha = prDetail.head_sha;
  const changedFiles = parseDiffFiles(diffText);
  const diffLines = countDiffLines(diffText);
  const ciAgg = parseChecksAggregate(checks);
  const checkedAt = evaluatedAt;

  // Finding 2: require at least one check-run to exist before treating CI as passing.
  const ciPassed = checks.length > 0 && ciAgg.passed;

  const ciStatusSnapshot = {
    sha: headSha,
    conclusion: ciPassed ? "success" : ciAgg.pending ? "pending" : "failure",
    checked_at: checkedAt,
  };
  const reviewVerdictSnapshot = {
    verdict: opts.reviewVerdict?.verdict ?? "unknown",
    finding_count: opts.reviewVerdict?.findingCount ?? 0,
    recorded_at: opts.reviewVerdict?.recordedAt ?? evaluatedAt,
  };

  const hasCleanReviewVerdict =
    opts.reviewVerdict?.verdict === "approve" || opts.reviewVerdict?.verdict === "approved";

  const detResult = runDeterministicChecks(
    cfg,
    prDetail,
    changedFiles,
    diffLines,
    ciPassed,
    headSha,
    hasCleanReviewVerdict,
    hasEvidenceBundle,
    diffText,
    { unresolvedThreadCount, noTestRationale },
  );

  if (!detResult.passed) {
    const artifact = buildEligibilityArtifact({
      eligibility: "needs-human",
      evaluatedAt,
      deterministicChecks: detResult.checks,
      denialReasons: detResult.denial_reasons,
      judgeOutput: null,
      ciStatusSnapshot,
      reviewVerdictSnapshot,
      linkedRunId: opts.runId,
      linkedIssue: issueNumber,
      linkedPr: prNumber,
      headSha,
    });
    await tryRecordArtifact(cfg, opts, issueNumber, artifact, deps);
    return artifact;
  }

  // All deterministic checks passed — invoke the LLM judge.
  const fileList = changedFiles.length
    ? changedFiles.map((f) => `- ${f}`).join("\n")
    : "(no files detected)";
  const diffSummary = buildDiffSummary(diffText, changedFiles);
  const ciStatusStr = ciAgg.passed ? "PASS — all checks green" : `PENDING/FAIL — ${JSON.stringify(ciAgg.failed)}`;
  const reviewStr = opts.reviewVerdict
    ? `verdict: ${opts.reviewVerdict.verdict}, findings: ${opts.reviewVerdict.findingCount}`
    : "(not available)";
  const evidenceMeta = opts.stateDir
    ? `state_dir: ${opts.stateDir}, issue: ${issueNumber}, pr: ${prNumber}`
    : "(no state dir)";

  const prompt = buildJudgePrompt({
    prDiffSummary: diffSummary,
    fileList,
    reviewVerdict: reviewStr,
    ciStatus: ciStatusStr,
    evidenceMetadata: evidenceMeta,
    issueScope: opts.issueScope || "(not provided)",
  });

  const timeoutSec = 300; // 5-minute judge invocation budget
  let judgeRaw: string;
  let judgeSuccess: boolean;

  try {
    let judgeResult: { stdout: string; success: boolean; timed_out?: boolean };
    if (deps.invokeJudge) {
      judgeResult = await deps.invokeJudge(prompt, opts.worktreeDir, timeoutSec);
    } else {
      const harnessResult = await defaultInvoke(cfg.harnesses.reviewer, opts.worktreeDir, prompt, {
        timeoutSec,
        model: cfg.models.review,
      });
      judgeResult = {
        stdout: harnessResult.stdout,
        success: harnessResult.success,
        timed_out: harnessResult.timed_out,
      };
    }
    judgeRaw = judgeResult.stdout;
    judgeSuccess = judgeResult.success;

    if (!judgeSuccess) {
      const artifact = buildEligibilityArtifact({
        eligibility: "needs-human",
        evaluatedAt,
        deterministicChecks: detResult.checks,
        denialReasons: ["judge: harness error or timeout"],
        judgeOutput: null,
        ciStatusSnapshot,
        reviewVerdictSnapshot,
        linkedRunId: opts.runId,
        linkedIssue: issueNumber,
        linkedPr: prNumber,
        headSha,
      });
      await tryRecordArtifact(cfg, opts, issueNumber, artifact, deps);
      return artifact;
    }
  } catch (err) {
    const artifact = buildEligibilityArtifact({
      eligibility: "needs-human",
      evaluatedAt,
      deterministicChecks: detResult.checks,
      denialReasons: ["judge: harness error or timeout"],
      judgeOutput: null,
      ciStatusSnapshot,
      reviewVerdictSnapshot,
      linkedRunId: opts.runId,
      linkedIssue: issueNumber,
      linkedPr: prNumber,
      headSha,
    });
    await tryRecordArtifact(cfg, opts, issueNumber, artifact, deps);
    return artifact;
  }

  const parseResult = parseAndValidateJudgeOutput(judgeRaw);
  if (!parseResult.ok) {
    const artifact = buildEligibilityArtifact({
      eligibility: "needs-human",
      evaluatedAt,
      deterministicChecks: detResult.checks,
      denialReasons: [parseResult.reason],
      judgeOutput: null,
      ciStatusSnapshot,
      reviewVerdictSnapshot,
      linkedRunId: opts.runId,
      linkedIssue: issueNumber,
      linkedPr: prNumber,
      headSha,
    });
    await tryRecordArtifact(cfg, opts, issueNumber, artifact, deps);
    return artifact;
  }

  const judgeOutput = parseResult.output;

  // Confidence threshold check
  const minConfidence = cfg.auto_merge_eligibility.min_confidence;
  if (judgeOutput.confidence < minConfidence) {
    const artifact = buildEligibilityArtifact({
      eligibility: "needs-human",
      evaluatedAt,
      deterministicChecks: detResult.checks,
      denialReasons: [
        `judge: confidence ${judgeOutput.confidence} below min_confidence ${minConfidence}`,
      ],
      judgeOutput,
      ciStatusSnapshot,
      reviewVerdictSnapshot,
      linkedRunId: opts.runId,
      linkedIssue: issueNumber,
      linkedPr: prNumber,
      headSha,
    });
    await tryRecordArtifact(cfg, opts, issueNumber, artifact, deps);
    return artifact;
  }

  // Judge denial reasons
  if (judgeOutput.denial_reasons.length > 0) {
    const artifact = buildEligibilityArtifact({
      eligibility: "needs-human",
      evaluatedAt,
      deterministicChecks: detResult.checks,
      denialReasons: judgeOutput.denial_reasons,
      judgeOutput,
      ciStatusSnapshot,
      reviewVerdictSnapshot,
      linkedRunId: opts.runId,
      linkedIssue: issueNumber,
      linkedPr: prNumber,
      headSha,
    });
    await tryRecordArtifact(cfg, opts, issueNumber, artifact, deps);
    return artifact;
  }

  // Finding 1: explicitly deny non-low blast_radius and cross-cutting semantic_risk.
  // The confidence and denial_reasons checks above are not sufficient — a judge that
  // returns an empty denial_reasons but high blast_radius would otherwise slip through.
  const judgeDenials: string[] = [];
  if (judgeOutput.blast_radius !== "low") {
    judgeDenials.push(`judge: blast_radius "${judgeOutput.blast_radius}" is not "low"`);
  }
  if (judgeOutput.semantic_risk === "cross_cutting_behavior") {
    judgeDenials.push(`judge: semantic_risk "cross_cutting_behavior" is not allowed`);
  }
  if (judgeDenials.length > 0) {
    const artifact = buildEligibilityArtifact({
      eligibility: "needs-human",
      evaluatedAt,
      deterministicChecks: detResult.checks,
      denialReasons: judgeDenials,
      judgeOutput,
      ciStatusSnapshot,
      reviewVerdictSnapshot,
      linkedRunId: opts.runId,
      linkedIssue: issueNumber,
      linkedPr: prNumber,
      headSha,
    });
    await tryRecordArtifact(cfg, opts, issueNumber, artifact, deps);
    return artifact;
  }

  // All checks pass and judge approves — eligible!
  const artifact = buildEligibilityArtifact({
    eligibility: "auto-merge-eligible",
    evaluatedAt,
    deterministicChecks: detResult.checks,
    denialReasons: [],
    judgeOutput,
    ciStatusSnapshot,
    reviewVerdictSnapshot,
    linkedRunId: opts.runId,
    linkedIssue: issueNumber,
    linkedPr: prNumber,
    headSha,
  });
  await tryRecordArtifact(cfg, opts, issueNumber, artifact, deps);
  return artifact;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildNeedsHumanArtifact(
  evaluatedAt: string,
  checks: EligibilityCheckResult[],
  denialReasons: string[],
  judgeOutput: EligibilityJudgeOutput | null,
  issueNumber: number,
  prNumber: number,
  runId: string,
  headSha: string,
  reviewVerdict: { verdict: string; findingCount: number; recordedAt: string } | null,
): AutoMergeEligibilityArtifact {
  return buildEligibilityArtifact({
    eligibility: "needs-human",
    evaluatedAt,
    deterministicChecks: checks,
    denialReasons,
    judgeOutput,
    ciStatusSnapshot: { sha: headSha, conclusion: "unknown", checked_at: evaluatedAt },
    reviewVerdictSnapshot: {
      verdict: reviewVerdict?.verdict ?? "unknown",
      finding_count: reviewVerdict?.findingCount ?? 0,
      recorded_at: reviewVerdict?.recordedAt ?? evaluatedAt,
    },
    linkedRunId: runId,
    linkedIssue: issueNumber,
    linkedPr: prNumber,
    headSha,
  });
}

async function tryRecordArtifact(
  cfg: PipelineConfig,
  opts: EligibilityGateOpts,
  issueNumber: number,
  artifact: AutoMergeEligibilityArtifact,
  deps: EligibilityGateDeps,
): Promise<void> {
  if (!opts.stateDir) return;
  try {
    if (deps.recordArtifact) {
      await deps.recordArtifact(opts.stateDir, issueNumber, artifact);
    } else {
      const { recordEligibilityArtifact } = await import("../evidence-bundle.ts");
      await recordEligibilityArtifact(opts.stateDir, issueNumber, artifact);
    }
  } catch (err) {
    console.warn(
      `[pipeline] auto-merge-eligibility: artifact write failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

function buildDiffSummary(diff: string, files: string[]): string {
  const lineCount = countDiffLines(diff);
  const truncated = diff.length > 2000 ? diff.slice(0, 2000) + "\n...(truncated)" : diff;
  return `${files.length} files changed, ${lineCount} lines diff\n\n${truncated}`;
}

/** Format the eligibility verdict for display in the stage summary. */
export function formatEligibilityVerdict(artifact: AutoMergeEligibilityArtifact): string {
  if (artifact.eligibility === "auto-merge-eligible") {
    return "Auto-merge eligibility: ELIGIBLE";
  }
  const reasons = artifact.denial_reasons.slice(0, 5).join("; ");
  return `Auto-merge eligibility: NEEDS HUMAN — ${reasons}`;
}
