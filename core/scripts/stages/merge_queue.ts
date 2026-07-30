// Human-invoked merge-queue dry-run (#673): select ordered ready-to-deploy PRs
// for a milestone and print a plan. NEVER merges; NEVER called from the advance
// loop. Sequential drive is a follow-up (#674) and will call `pipeline merge`.
//
// Rule #4: the pipeline never merges autonomously. This command only plans.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPrForIssue as ghGetPrForIssue } from "../gh.ts";
import type { PipelineConfig } from "../types.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const R2D_LABEL = "pipeline:ready-to-deploy";

/** Stable skip reason codes for dry-run reporting. */
export type MergeQueueSkipReason =
  | "missing-pr"
  | "non-mergeable"
  | "checks-not-green"
  | "empty-head-sha"
  | "wrong-base";

export type MergeQueuePlannedAction = "would-merge";

export interface MergeQueueIssue {
  number: number;
  labels: string[];
}

export interface RequiredCheck {
  name: string;
  bucket: string;
}

export interface MergeQueueDeps {
  /** Open issues belonging to the milestone (any stage). Labels included. */
  listMilestoneIssues(milestone: string): Promise<MergeQueueIssue[]>;
  /** Authoritative issue → open same-repo PR resolver (getPrForIssue semantics). */
  getPrForIssue(issueNumber: number): Promise<number | null>;
  /** `gh pr view` fields: mergeable, mergeStateStatus, headRefOid, baseRefName. */
  ghPrView(pr: number, fields: string[]): Promise<Record<string, unknown>>;
  /** `gh pr checks --required --json name,bucket`. */
  ghPrChecksRequired(pr: number): Promise<RequiredCheck[]>;
  /** All observable checks — fallback when no required checks configured. */
  ghPrChecksAll(pr: number): Promise<RequiredCheck[]>;
  log(msg: string): void;
}

export interface MergeQueueCandidate {
  issueNumber: number;
  prNumber: number;
  headRefOid: string;
  baseRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  checksSummary: string;
  plannedAction: MergeQueuePlannedAction;
}

export interface MergeQueueSkip {
  issueNumber: number;
  prNumber: number | null;
  reason: MergeQueueSkipReason;
  detail: string;
}

export interface MergeQueuePlan {
  milestone: string;
  mode: "dry-run";
  candidates: MergeQueueCandidate[];
  skips: MergeQueueSkip[];
}

export interface PlanMergeQueueOpts {
  milestone: string;
  /** Affirming default; reserved for future drive mode distinction. */
  dryRun?: boolean;
  /**
   * Configured integration base branch (from resolveConfig / --base).
   * When set, PRs whose baseRefName does not match are skipped with reason
   * `wrong-base` so release/backport targets never appear as would-merge.
   */
  baseBranch?: string;
}

// ---------------------------------------------------------------------------
// Production discovery helpers (pure + args — unit-tested; no network)
// ---------------------------------------------------------------------------

/** REST shape of one milestone from `gh api .../milestones` (paginated --slurp). */
export interface MilestoneApiRaw {
  number: number;
  title: string;
}

/**
 * REST shape of one issue from `gh api .../issues` (paginated --slurp).
 * `pull_request` is present on PRs listed under the issues endpoint.
 */
export interface MilestoneIssueApiRaw {
  number: number;
  labels?: Array<{ name: string }>;
  pull_request?: unknown;
}

/** `gh api` args: every milestone (open+closed) so a closed-milestone title still resolves. */
export function listMilestonesApiArgs(repo: string): string[] {
  return ["api", `repos/${repo}/milestones?state=all&per_page=100`, "--paginate", "--slurp"];
}

/** Resolve milestone title → number. Exact title match; null when absent. */
export function findMilestoneNumberByTitle(
  milestones: MilestoneApiRaw[],
  title: string,
): number | null {
  const hit = milestones.find((m) => m.title === title);
  return hit ? hit.number : null;
}

/**
 * Flatten `--slurp` milestone pages (`[[page1...], [page2...]]`).
 * Exported so multi-page milestone lists are regression-testable.
 */
export function parseMilestonesPages(pages: MilestoneApiRaw[][]): MilestoneApiRaw[] {
  return pages.flat();
}

/** `gh api` args: every open issue (and PR) in a milestone, paginated to completion. */
export function listMilestoneOpenIssuesApiArgs(repo: string, milestoneNumber: number): string[] {
  return [
    "api",
    `repos/${repo}/issues?state=open&milestone=${milestoneNumber}&per_page=100`,
    "--paginate",
    "--slurp",
  ];
}

/**
 * Flatten `--slurp` issue pages, drop PRs, map to {@link MergeQueueIssue}.
 * Must not cap at 500 — a fixed `--limit 500` on `gh issue list` silently
 * omitted selector-matched R2D issues (#673 review-2).
 */
export function parseMilestoneIssuesPages(pages: MilestoneIssueApiRaw[][]): MergeQueueIssue[] {
  return pages
    .flat()
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      labels: (item.labels ?? []).map((l) => l.name),
    }));
}

// ---------------------------------------------------------------------------
// Production deps
// ---------------------------------------------------------------------------

export function realMergeQueueDeps(repo: string): MergeQueueDeps {
  // Minimal config for the authoritative open-PR resolver (only `.repo` is read).
  const cfg = { repo } as PipelineConfig;

  return {
    async listMilestoneIssues(milestone) {
      // Resolve title → number, then page every open issue in that milestone.
      // Never use `gh issue list --limit 500` — that silently truncates.
      const { stdout: msOut } = await execFileAsync("gh", listMilestonesApiArgs(repo), {
        timeout: 60_000,
        maxBuffer: 50 * 1024 * 1024,
      });
      const msPages = JSON.parse(msOut.trim() || "[]") as MilestoneApiRaw[][];
      const milestoneNumber = findMilestoneNumberByTitle(parseMilestonesPages(msPages), milestone);
      if (milestoneNumber === null) return [];

      const { stdout } = await execFileAsync(
        "gh",
        listMilestoneOpenIssuesApiArgs(repo, milestoneNumber),
        { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 },
      );
      const issuePages = JSON.parse(stdout.trim() || "[]") as MilestoneIssueApiRaw[][];
      return parseMilestoneIssuesPages(issuePages);
    },

    async getPrForIssue(issueNumber) {
      // Authoritative paginated GraphQL resolver (#623). Propagates auth/API/
      // parse failures — null is reserved for an exhausted search with no match
      // (never a blanket catch → missing-pr, #673 review-2).
      return ghGetPrForIssue(cfg, issueNumber);
    },

    async ghPrView(pr, fields) {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "view", String(pr), "--json", fields.join(","), "-R", repo],
        { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 },
      );
      return JSON.parse(stdout) as Record<string, unknown>;
    },

    async ghPrChecksRequired(pr) {
      try {
        const { stdout } = await execFileAsync(
          "gh",
          ["pr", "checks", String(pr), "--required", "--json", "name,bucket", "-R", repo],
          { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 },
        );
        return JSON.parse(stdout) as RequiredCheck[];
      } catch (err) {
        // gh exits non-zero (e.g. code 8) when required checks are pending/failing,
        // but still writes the check JSON array to stdout. Recover that for the gate.
        const recovered = recoverGhPrChecksFromExecError(err);
        if (recovered) return recovered;
        throw err;
      }
    },

    async ghPrChecksAll(pr) {
      try {
        const { stdout } = await execFileAsync(
          "gh",
          ["pr", "checks", String(pr), "--json", "name,bucket", "-R", repo],
          { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 },
        );
        return JSON.parse(stdout) as RequiredCheck[];
      } catch (err) {
        const recovered = recoverGhPrChecksFromExecError(err);
        if (recovered) return recovered;
        throw err;
      }
    },

    log(msg) {
      console.log(msg);
    },
  };
}

// ---------------------------------------------------------------------------
// Gates (mirror pipeline merge — see stages/merge.ts)
// ---------------------------------------------------------------------------

/**
 * `gh pr checks` exits non-zero when any listed check is pending/fail/cancel
 * (documented exit code 8 for pending). `execFile` rejects, but stdout still
 * holds the JSON check array. Recover that so callers can classify as
 * checks-not-green instead of aborting the whole dry-run.
 *
 * Returns null when stdout is missing or not a JSON array (genuine command/API
 * failure — caller should rethrow).
 */
export function recoverGhPrChecksFromExecError(err: unknown): RequiredCheck[] | null {
  const e = err as { stdout?: unknown };
  if (typeof e.stdout !== "string") return null;
  const out = e.stdout.trim();
  if (!out) return null;
  try {
    const parsed: unknown = JSON.parse(out);
    if (Array.isArray(parsed)) return parsed as RequiredCheck[];
  } catch {
    return null;
  }
  return null;
}

/** True when mergeable/MERGEABLE and mergeStateStatus/CLEAN. */
export function isMergeableClean(mergeable: string, mergeStateStatus: string): boolean {
  return mergeable === "MERGEABLE" && mergeStateStatus === "CLEAN";
}

/**
 * Evaluate required checks the same way as `pipeline merge`:
 * - required list present: pass/skipping are non-blocking; fail/pending/cancel block
 * - no required checks configured ("no required checks reported"): fall back to all
 *   observable checks; fail/pending/cancel block; empty list is ok
 * - non-zero `gh pr checks` with JSON stdout (pending/fail exit): treat as check data
 */
export async function evaluateChecksGate(
  pr: number,
  deps: Pick<MergeQueueDeps, "ghPrChecksRequired" | "ghPrChecksAll">,
): Promise<{ ok: true; summary: string } | { ok: false; summary: string; detail: string }> {
  let requiredChecks: RequiredCheck[];
  let noRequiredChecksConfigured = false;
  try {
    requiredChecks = await deps.ghPrChecksRequired(pr);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const errText = `${e.stderr ?? ""} ${e.message ?? ""}`;
    if (errText.includes("no required checks reported")) {
      noRequiredChecksConfigured = true;
      requiredChecks = [];
    } else {
      // Production deps recover pending/fail stdout themselves; also accept the
      // rejected-process shape here so injected fakes and any raw exec error work.
      const recovered = recoverGhPrChecksFromExecError(err);
      if (recovered) {
        requiredChecks = recovered;
      } else {
        throw err;
      }
    }
  }

  if (noRequiredChecksConfigured) {
    let allChecks: RequiredCheck[];
    try {
      allChecks = await deps.ghPrChecksAll(pr);
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const errText = `${e.stderr ?? ""} ${e.message ?? ""}`;
      if (errText.includes("no checks reported")) {
        allChecks = [];
      } else {
        const recovered = recoverGhPrChecksFromExecError(err);
        if (recovered) {
          allChecks = recovered;
        } else {
          throw err;
        }
      }
    }
    const blocking: string[] = [];
    for (const check of allChecks) {
      const bucket = (check.bucket ?? "").toLowerCase();
      if (bucket === "fail" || bucket === "pending" || bucket === "cancel") {
        blocking.push(`${check.name ?? "unknown"} (${bucket})`);
      }
    }
    if (blocking.length > 0) {
      return {
        ok: false,
        summary: `fallback: ${blocking.length} blocking`,
        detail: blocking.join("; "),
      };
    }
    const n = allChecks.length;
    return {
      ok: true,
      summary: n === 0 ? "no required checks (none observable)" : `no required checks; ${n} observable green`,
    };
  }

  const blocking: string[] = [];
  for (const check of requiredChecks) {
    const name = check.name ?? "unknown";
    const bucket = (check.bucket ?? "").toLowerCase();
    if (bucket !== "pass" && bucket !== "skipping") {
      blocking.push(`${name} (${bucket || "unknown"})`);
    }
  }
  if (blocking.length > 0) {
    return {
      ok: false,
      summary: `${blocking.length}/${requiredChecks.length} required not green`,
      detail: blocking.join("; "),
    };
  }
  return {
    ok: true,
    summary:
      requiredChecks.length === 0
        ? "no required checks"
        : `${requiredChecks.length} required pass`,
  };
}

// ---------------------------------------------------------------------------
// Plan (pure selection given deps)
// ---------------------------------------------------------------------------

/**
 * Build a dry-run merge-queue plan for the given milestone.
 * Performs only read deps; never merges.
 */
export async function planMergeQueue(
  opts: PlanMergeQueueOpts,
  deps: MergeQueueDeps,
): Promise<MergeQueuePlan> {
  const milestone = opts.milestone.trim();
  if (!milestone) {
    throw new Error(
      "pipeline merge-queue: --milestone is required.\n" +
        '  Usage: pipeline merge-queue --milestone "<title>"\n' +
        '  Example: pipeline merge-queue --milestone "v1.28.2"',
    );
  }

  const issues = await deps.listMilestoneIssues(milestone);
  const r2dIssues = issues
    .filter((i) => i.labels.includes(R2D_LABEL))
    .slice()
    .sort((a, b) => a.number - b.number);

  const candidates: MergeQueueCandidate[] = [];
  const skips: MergeQueueSkip[] = [];

  for (const issue of r2dIssues) {
    const prNumber = await deps.getPrForIssue(issue.number);
    if (prNumber === null) {
      skips.push({
        issueNumber: issue.number,
        prNumber: null,
        reason: "missing-pr",
        detail: "no open linked PR via authoritative resolver",
      });
      continue;
    }

    const prData = await deps.ghPrView(prNumber, [
      "mergeable",
      "mergeStateStatus",
      "headRefOid",
      "baseRefName",
    ]);
    const mergeable = String(prData.mergeable ?? "UNKNOWN");
    const mergeStateStatus = String(prData.mergeStateStatus ?? "UNKNOWN");
    const headRefOid = String(prData.headRefOid ?? "");
    const baseRefName = String(prData.baseRefName ?? "");
    const configuredBase = (opts.baseBranch ?? "").trim();

    if (configuredBase && baseRefName !== configuredBase) {
      skips.push({
        issueNumber: issue.number,
        prNumber,
        reason: "wrong-base",
        detail: `baseRefName=${baseRefName || "(empty)"} configured=${configuredBase}`,
      });
      continue;
    }

    if (!isMergeableClean(mergeable, mergeStateStatus)) {
      skips.push({
        issueNumber: issue.number,
        prNumber,
        reason: "non-mergeable",
        detail: `mergeable=${mergeable} mergeStateStatus=${mergeStateStatus}`,
      });
      continue;
    }

    if (!headRefOid) {
      skips.push({
        issueNumber: issue.number,
        prNumber,
        reason: "empty-head-sha",
        detail: "headRefOid empty",
      });
      continue;
    }

    const checks = await evaluateChecksGate(prNumber, deps);
    if (!checks.ok) {
      skips.push({
        issueNumber: issue.number,
        prNumber,
        reason: "checks-not-green",
        detail: checks.detail,
      });
      continue;
    }

    candidates.push({
      issueNumber: issue.number,
      prNumber,
      headRefOid,
      baseRefName,
      mergeable,
      mergeStateStatus,
      checksSummary: checks.summary,
      plannedAction: "would-merge",
    });
  }

  // Candidates already visited in ascending issue order (r2dIssues sorted).
  return {
    milestone,
    mode: "dry-run",
    candidates,
    skips,
  };
}

// ---------------------------------------------------------------------------
// Formatter + CLI entry
// ---------------------------------------------------------------------------

export function formatMergeQueuePlan(plan: MergeQueuePlan, repo?: string): string {
  const lines: string[] = [];
  lines.push(`pipeline merge-queue — dry-run plan`);
  lines.push(`  selector: milestone="${plan.milestone}"`);
  if (repo) lines.push(`  repo: ${repo}`);
  lines.push(`  mode: ${plan.mode}`);
  lines.push("");

  if (plan.candidates.length === 0) {
    lines.push("Merge candidates: (none)");
  } else {
    lines.push(`Merge candidates (${plan.candidates.length}), ordered by issue number ascending:`);
    for (const c of plan.candidates) {
      lines.push(
        `  - issue #${c.issueNumber}  PR #${c.prNumber}  head ${c.headRefOid}` +
          (c.baseRefName ? `  base ${c.baseRefName}` : ""),
      );
      lines.push(
        `      mergeability: ${c.mergeable}/${c.mergeStateStatus}` +
          `  checks: ${c.checksSummary}` +
          `  action: ${c.plannedAction}`,
      );
    }
  }

  lines.push("");
  if (plan.skips.length === 0) {
    lines.push("Skipped: (none)");
  } else {
    lines.push(`Skipped (${plan.skips.length}):`);
    // Stable order: by issue number
    const ordered = plan.skips.slice().sort((a, b) => a.issueNumber - b.issueNumber);
    for (const s of ordered) {
      const prPart = s.prNumber !== null ? ` PR #${s.prNumber}` : "";
      lines.push(`  - issue #${s.issueNumber}${prPart}  reason: ${s.reason}  (${s.detail})`);
    }
  }

  lines.push("");
  lines.push(
    `Summary: ${plan.candidates.length} candidate(s), ${plan.skips.length} skipped. No merges were performed.`,
  );
  return lines.join("\n");
}

/**
 * CLI entry: plan + print. Always dry-run for this change.
 * Returns process exit code (0 on successful plan, including empty).
 */
export async function runMergeQueueDryRun(
  opts: {
    milestone: string | undefined;
    dryRun?: boolean;
    apply?: boolean;
    /** Configured base branch; forwarded to planMergeQueue for the base gate. */
    baseBranch?: string;
  },
  deps: MergeQueueDeps,
  print: (msg: string) => void = console.log,
  repo?: string,
): Promise<number> {
  if (opts.apply) {
    print(
      "pipeline merge-queue: drive/apply mode is not implemented yet.\n" +
        "  This change only supports dry-run planning (default).\n" +
        "  Sequential merge drive is tracked as a follow-up (#674).\n" +
        "  Usage: pipeline merge-queue --milestone \"<title>\" [--dry-run]",
    );
    return 2;
  }

  if (!opts.milestone || !opts.milestone.trim()) {
    print(
      "pipeline merge-queue: --milestone is required.\n" +
        '  Usage: pipeline merge-queue --milestone "<title>"\n' +
        '  Example: pipeline merge-queue --milestone "v1.28.2"\n' +
        "  Default mode is dry-run (no merges).",
    );
    return 2;
  }

  const plan = await planMergeQueue(
    { milestone: opts.milestone, dryRun: true, baseBranch: opts.baseBranch },
    deps,
  );
  print(formatMergeQueuePlan(plan, repo));
  return 0;
}
