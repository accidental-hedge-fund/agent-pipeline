// Queue sub-command (#305): batch factory operation mode.
// Selects eligible issues from the GitHub backlog, dispatches them in
// concurrency-bounded parallel pipeline runs, enforces budget and failure-rate
// gates, and writes a machine-readable batch-summary.json artifact.
//
// All external I/O is injected via QueueDeps so unit tests use no real network,
// git, or subprocess calls.

import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { runsDir, runIdFor } from "../run-store.ts";
import { BLOCKED_LABEL } from "../types.ts";
import { autoFilePapercuts as realAutoFilePapercuts, realAutoFileDeps } from "./papercut.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IssueFilters {
  labels?: string[];
  milestone?: string;
  risk?: "low" | "medium" | "high";
}

export interface EligibleIssue {
  number: number;
  title: string;
  labels: string[];
  priorityScore: number;
  milestone?: string | null;
}

export interface RunOpts {
  profile?: string;
  repoPath?: string;
  base?: string;
}

export interface RunResult {
  issueNumber: number;
  finalState: string;
  costUsd: number | null;
  durationMs: number;
  error?: string;
}

export interface QueueOpts {
  maxIssues: number;
  budgetDollars: number | null;
  concurrency: number;
  maxFailureRate: number;
  filters: IssueFilters;
  repoDir: string;
  profile?: string;
  batchId: string;
  base?: string;
  /** Opt-in papercut auto-file settings (#421). Absent/auto_file:false → inert. */
  papercuts?: {
    auto_file: boolean;
    auto_file_window_hours: number;
    auto_file_max_per_window: number;
    auto_file_min_occurrences: number;
  };
}

export interface PerIssueSummary {
  number: number;
  title: string;
  final_state: string;
  cost_usd: number | null;
  duration_ms: number;
  error?: string;
}

export interface BatchSummary {
  schema_version: "1";
  batch_id: string;
  started_at: string;
  ended_at: string;
  halt_reason: "budget_exhausted" | "failure_rate_exceeded" | null;
  issues: PerIssueSummary[];
  excluded_count: number;
  aggregate: {
    total_issues: number;
    succeeded: number;
    failed: number;
    excluded_count: number;
    failure_rate: number;
    total_cost_usd: number;
    total_duration_ms: number;
  };
  limits: {
    max_issues: number;
    budget_dollars: number | null;
    concurrency: number;
    max_failure_rate: number;
  };
}

export interface QueueDeps {
  listEligibleIssues(filters: IssueFilters): Promise<EligibleIssue[]>;
  runPipeline(issueNumber: number, opts: RunOpts): Promise<RunResult>;
  readRunCost(issueNumber: number): Promise<number | null>;
  writeFile(filePath: string, content: string): Promise<void>;
  withQueueLock?<T>(repoDir: string, fn: () => Promise<T>): Promise<T>;
  /** Opt-in papercut auto-file (#421) at batch end. Injectable so tests never
   *  make a real gh/network call — the real impl delegates to
   *  `autoFilePapercuts` from `./papercut.ts`. */
  autoFilePapercuts(opts: {
    repoDir: string;
    windowHours: number;
    maxPerWindow: number;
    minOccurrences: number;
  }): Promise<void>;
  log(msg: string): void;
  clock(): number;
}

// ---------------------------------------------------------------------------
// CLI option validation
// ---------------------------------------------------------------------------

/**
 * Validate queue operator limits before dispatching.
 * Returns a user-facing error string if any value is invalid, or null if all ok.
 */
export function validateQueueOpts(
  maxIssues: number,
  budgetDollars: number | null,
  concurrency: number,
  maxFailureRate: number,
  risk?: string,
): string | null {
  if (!Number.isFinite(maxIssues) || !Number.isInteger(maxIssues) || maxIssues < 1) {
    return `--max-issues must be a positive integer (got: ${maxIssues})`;
  }
  if (!Number.isFinite(concurrency) || !Number.isInteger(concurrency) || concurrency < 1) {
    return `--concurrency must be a positive integer (got: ${concurrency})`;
  }
  if (budgetDollars !== null && (!Number.isFinite(budgetDollars) || budgetDollars < 0)) {
    return `--budget-dollars must be a non-negative number (got: ${budgetDollars})`;
  }
  if (!Number.isFinite(maxFailureRate) || maxFailureRate < 0 || maxFailureRate > 1) {
    return `--max-failure-rate must be in 0.0–1.0 (got: ${maxFailureRate})`;
  }
  if (risk !== undefined && !["low", "medium", "high"].includes(risk)) {
    return `--risk must be one of low|medium|high (got: ${risk})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Priority scoring formula (static constant — auditable without a model call)
// ---------------------------------------------------------------------------

// Higher score = dispatched first. pipeline:ready issues (the autonomous-eligible
// label state) receive the highest score. Stages further into the pipeline receive
// lower scores. This ordering is deterministic and defined here as the single source
// of truth; callers and tests import STAGE_PRIORITY_SCORE to verify ordering.
export const STAGE_PRIORITY_SCORE: Record<string, number> = {
  "ready": 100,
  "planning": 90,
  "plan-review": 85,
  "implementing": 80,
  "review-1": 70,
  "fix-1": 65,
  "review-2": 60,
  "fix-2": 55,
  "pre-merge": 50,
  "eval-gate": 45,
  "shipcheck-gate": 40,
  "needs-human": 10,
  "backlog": 0,
};

// Risk level ordering for --risk filter. "low" ≤ "medium" ≤ "high".
const RISK_LEVEL: Record<string, number> = { low: 1, medium: 2, high: 3 };

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

export function realQueueDeps(repoDir: string, _profile?: string): QueueDeps {
  return {
    listEligibleIssues: async (_filters: IssueFilters): Promise<EligibleIssue[]> => {
      // Fetch only issues with pipeline:ready (the autonomous-eligible label state).
      // Additional filters (milestone, risk, custom labels) are applied by selectIssues.
      const result = spawnSync(
        "gh",
        [
          "issue", "list",
          "--label", "pipeline:ready",
          "--state", "open",
          "--json", "number,title,labels,milestone",
          "--limit", "200",
        ],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[pipeline queue] gh issue list failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const items = JSON.parse(result.stdout.trim() || "[]") as Array<{
        number: number;
        title: string;
        labels: Array<{ name: string }>;
        milestone: { title: string } | null;
      }>;
      return items.map((item) => {
        const labels = item.labels.map((l) => l.name);
        return {
          number: item.number,
          title: item.title,
          labels,
          priorityScore: computePriorityScore(labels),
          milestone: item.milestone?.title ?? null,
        };
      });
    },

    runPipeline: async (issueNumber: number, opts: RunOpts): Promise<RunResult> => {
      const startMs = Date.now();
      // Pin the run-id before spawning so we read the exact summary.json this child
      // writes — not a stale artifact from a prior or concurrent run for the same issue.
      const runId = runIdFor(issueNumber, new Date());
      const pipelineScript = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../pipeline.ts",
      );
      const args: string[] = [
        "--experimental-strip-types",
        pipelineScript,
        String(issueNumber),
        "--run-id", runId,
      ];
      if (opts.profile) args.push("--profile", opts.profile);
      if (opts.repoPath) args.push("--repo-path", opts.repoPath);
      if (opts.base) args.push("--base", opts.base);

      const exitCode = await new Promise<number>((resolve) => {
        const child = spawn("node", args, {
          stdio: "inherit",
          cwd: repoDir,
          env: { ...process.env },
        });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
      });

      const durationMs = Date.now() - startMs;

      // Read final state and cost from the pinned run summary only.
      // If summary is missing or corrupt, record as "unknown" rather than
      // inferring ready-to-deploy from exit code 0 — a non-terminal stop can exit 0.
      let finalState: string;
      let costUsd: number | null = null;
      let errorMsg: string | undefined;
      try {
        const summaryPath = path.join(runsDir(repoDir), runId, "summary.json");
        const raw = fs.readFileSync(summaryPath, "utf8");
        const summary = JSON.parse(raw) as {
          finalState?: string;
          accounting?: { totals?: { actual_cost_usd?: number; estimated_cost_usd?: number } };
        };
        finalState = summary.finalState ?? "unknown";
        const totals = summary.accounting?.totals;
        if (totals) {
          costUsd = (totals.actual_cost_usd ?? 0) + (totals.estimated_cost_usd ?? 0);
        }
      } catch {
        finalState = "unknown";
        errorMsg = exitCode !== 0
          ? `exit code ${exitCode}, summary not found or unreadable`
          : "summary not found or unreadable";
      }

      return {
        issueNumber,
        finalState,
        costUsd,
        durationMs,
        ...(errorMsg !== undefined ? { error: errorMsg } : {}),
      };
    },

    readRunCost: async (issueNumber: number): Promise<number | null> => {
      try {
        const entries = fs.readdirSync(runsDir(repoDir))
          .filter((e) => e.startsWith(`${issueNumber}-`))
          .sort();
        const latest = entries.at(-1);
        if (!latest) return null;
        const raw = fs.readFileSync(
          path.join(runsDir(repoDir), latest, "summary.json"),
          "utf8",
        );
        const summary = JSON.parse(raw) as {
          accounting?: { totals?: { actual_cost_usd?: number; estimated_cost_usd?: number } };
        };
        const totals = summary.accounting?.totals;
        if (!totals) return null;
        return (totals.actual_cost_usd ?? 0) + (totals.estimated_cost_usd ?? 0);
      } catch {
        return null;
      }
    },

    writeFile: async (filePath: string, content: string): Promise<void> => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
    },

    withQueueLock: withQueueBatchLock,
    autoFilePapercuts: (autoFileOpts) => realAutoFilePapercuts(autoFileOpts, realAutoFileDeps(repoDir)),
    log: (msg: string) => process.stdout.write(msg + "\n"),
    clock: () => Date.now(),
  };
}

export function queueBatchLockPath(repoDir: string): string {
  return path.join(repoDir, ".agent-pipeline", "locks", "queue.lock");
}

export async function withQueueBatchLock<T>(
  repoDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = queueBatchLockPath(repoDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (!tryAcquireQueueBatchLock(lockPath)) {
    throw new Error(
      `pipeline queue: another queue batch is already active (${lockPath}). ` +
        "Wait for it to finish, or remove the lock if you are sure it is stale.",
    );
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }
  }
}

function tryAcquireQueueBatchLock(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "EEXIST") throw err;
    if (queueLockOwnerIsAlive(lockPath)) return false;
    try {
      fs.unlinkSync(lockPath);
    } catch (unlinkErr) {
      const u = unlinkErr as NodeJS.ErrnoException;
      if (u.code !== "ENOENT") throw unlinkErr;
    }
    return tryAcquireQueueBatchLock(lockPath);
  }
}

function queueLockOwnerIsAlive(lockPath: string): boolean {
  let pidText = "";
  try {
    pidText = fs.readFileSync(lockPath, "utf8").trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return false;
    throw err;
  }
  const pid = Number.parseInt(pidText, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return false;
    if (e.code === "EPERM") return true;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Compute priority score from an issue's label list. */
export function computePriorityScore(labels: string[]): number {
  for (const label of labels) {
    if (label.startsWith("pipeline:")) {
      const stage = label.slice("pipeline:".length);
      const score = STAGE_PRIORITY_SCORE[stage];
      if (score !== undefined) return score;
    }
  }
  return 0;
}

/**
 * Filter and rank eligible issues by caller-specified filters, then return up to
 * `maxIssues` sorted by priority score descending; ties broken by issue number
 * ascending (lower number = older = dispatched first — stable FIFO within same score).
 *
 * Filter semantics:
 *   - filters.labels: issue must carry ALL specified labels (intersection / AND)
 *   - filters.milestone: issue's milestone title must match exactly
 *   - filters.risk: issue must NOT carry a risk label above the specified level
 *     (e.g. "--risk medium" excludes any issue that has "risk:high")
 */
export function selectIssues(
  candidates: EligibleIssue[],
  filters: IssueFilters,
  maxIssues: number,
): EligibleIssue[] {
  // Blocked issues are not autonomous-eligible regardless of pipeline stage.
  let filtered = candidates.filter((issue) => !issue.labels.includes(BLOCKED_LABEL));

  if (filters.labels && filters.labels.length > 0) {
    filtered = filtered.filter((issue) =>
      filters.labels!.every((lbl) => issue.labels.includes(lbl)),
    );
  }

  if (filters.milestone) {
    const m = filters.milestone;
    filtered = filtered.filter((issue) => issue.milestone === m);
  }

  if (filters.risk) {
    const maxRiskLevel = RISK_LEVEL[filters.risk] ?? 3;
    filtered = filtered.filter((issue) => {
      for (const lbl of issue.labels) {
        if (lbl.startsWith("risk:")) {
          const riskLabel = lbl.slice("risk:".length);
          const level = RISK_LEVEL[riskLabel];
          if (level !== undefined && level > maxRiskLevel) return false;
        }
      }
      return true;
    });
  }

  // Sort descending by score, then ascending by issue number for FIFO within the same score.
  const sorted = [...filtered].sort((a, b) => {
    const scoreDiff = b.priorityScore - a.priorityScore;
    return scoreDiff !== 0 ? scoreDiff : a.number - b.number;
  });

  return sorted.slice(0, maxIssues);
}

// ---------------------------------------------------------------------------
// Batch summary builder
// ---------------------------------------------------------------------------

/**
 * Build a BatchSummary from the completed results.
 * `succeeded` = finalState is "ready-to-deploy" or "needs-human".
 * `failed` = everything else (for failure-rate and aggregate counts).
 */
export function buildBatchSummary(
  results: RunResult[],
  titles: Map<number, string>,
  opts: QueueOpts,
  haltReason: "budget_exhausted" | "failure_rate_exceeded" | null,
  excludedCount: number,
  startedAt: number,
  endedAt: number,
): BatchSummary {
  const succeeded = results.filter(
    (r) => r.finalState === "ready-to-deploy" || r.finalState === "needs-human",
  ).length;
  const failed = results.length - succeeded;
  const failureRate = results.length > 0 ? failed / results.length : 0;
  const totalCostUsd = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  return {
    schema_version: "1",
    batch_id: opts.batchId,
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    halt_reason: haltReason,
    issues: results.map((r) => {
      const entry: PerIssueSummary = {
        number: r.issueNumber,
        title: titles.get(r.issueNumber) ?? `#${r.issueNumber}`,
        final_state: r.finalState,
        cost_usd: r.costUsd,
        duration_ms: r.durationMs,
      };
      if (r.error !== undefined) entry.error = r.error;
      return entry;
    }),
    excluded_count: excludedCount,
    aggregate: {
      total_issues: results.length,
      succeeded,
      failed,
      excluded_count: excludedCount,
      failure_rate: failureRate,
      total_cost_usd: totalCostUsd,
      total_duration_ms: totalDurationMs,
    },
    limits: {
      max_issues: opts.maxIssues,
      budget_dollars: opts.budgetDollars,
      concurrency: opts.concurrency,
      max_failure_rate: opts.maxFailureRate,
    },
  };
}

// ---------------------------------------------------------------------------
// Human-readable summary printer
// ---------------------------------------------------------------------------

function printHumanSummary(
  summary: BatchSummary,
  artifactPath: string,
  deps: QueueDeps,
): void {
  deps.log("\n=== Batch Queue Summary ===\n");
  deps.log("| # | Title | Final State | Cost USD | Duration |");
  deps.log("|---|-------|-------------|----------|----------|");
  for (const issue of summary.issues) {
    const cost = issue.cost_usd !== null ? `$${issue.cost_usd.toFixed(4)}` : "—";
    const dur = `${(issue.duration_ms / 1000).toFixed(1)}s`;
    const title = issue.title.length > 40 ? issue.title.slice(0, 40) + "…" : issue.title;
    deps.log(`| #${issue.number} | ${title} | ${issue.final_state} | ${cost} | ${dur} |`);
  }
  deps.log("");
  const agg = summary.aggregate;
  deps.log(
    `Aggregate: ${agg.total_issues} issued, ${agg.succeeded} succeeded, ${agg.failed} failed, ` +
      `rate=${(agg.failure_rate * 100).toFixed(1)}%, cost=$${agg.total_cost_usd.toFixed(4)}, ` +
      `duration=${(agg.total_duration_ms / 1000).toFixed(1)}s`,
  );
  if (summary.halt_reason) {
    deps.log(`Batch halted: ${summary.halt_reason}`);
  }
  deps.log(`\nArtifact: ${artifactPath}`);
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the queue sub-command: select eligible issues from the GitHub backlog,
 * dispatch them in concurrency-bounded parallel pipeline runs, enforce budget
 * and failure-rate gates, and write a machine-readable batch-summary.json.
 */
export async function runQueue(opts: QueueOpts, deps: QueueDeps): Promise<void> {
  if (deps.withQueueLock) {
    return deps.withQueueLock(opts.repoDir, () => runQueueUnlocked(opts, deps));
  }
  return runQueueUnlocked(opts, deps);
}

async function runQueueUnlocked(opts: QueueOpts, deps: QueueDeps): Promise<void> {
  const startedAt = deps.clock();
  deps.log(`[pipeline queue] batch ${opts.batchId}: starting`);
  deps.log(
    `[pipeline queue] limits: maxIssues=${opts.maxIssues} ` +
      `budgetDollars=${opts.budgetDollars !== null ? `$${opts.budgetDollars}` : "unlimited"} ` +
      `concurrency=${opts.concurrency} ` +
      `maxFailureRate=${(opts.maxFailureRate * 100).toFixed(0)}%`,
  );

  const allEligible = await deps.listEligibleIssues(opts.filters);
  const selected = selectIssues(allEligible, opts.filters, opts.maxIssues);
  const excludedCount = allEligible.length - selected.length;

  deps.log(
    `[pipeline queue] ${allEligible.length} eligible, ${selected.length} selected, ` +
      `${excludedCount} excluded by filters/cap`,
  );

  // Pre-capture titles before consuming the queue so the summary has them.
  const titleMap = new Map<number, string>(selected.map((i) => [i.number, i.title]));

  const results: RunResult[] = [];
  let cumulativeCostUsd = 0;
  let haltReason: "budget_exhausted" | "failure_rate_exceeded" | null = null;

  // Concurrency-bounded dispatch.
  // Each entry: Promise<{ result: RunResult; issueNumber: number }>
  const active = new Map<number, Promise<{ result: RunResult; issueNumber: number }>>();
  const queue: EligibleIssue[] = [...selected];

  function fillSlot(issue: EligibleIssue): void {
    const slotStart = deps.clock();
    const p = deps.runPipeline(issue.number, { profile: opts.profile, repoPath: opts.repoDir, base: opts.base })
      .catch((err): RunResult => ({
        issueNumber: issue.number,
        finalState: "error",
        costUsd: null,
        durationMs: deps.clock() - slotStart,
        error: err instanceof Error ? err.message : String(err),
      }))
      .then((result) => ({ result, issueNumber: result.issueNumber }));
    active.set(issue.number, p);
    deps.log(
      `[pipeline queue] #${issue.number}: started (${active.size}/${opts.concurrency} slots used)`,
    );
  }

  async function waitForNext(): Promise<RunResult> {
    const { result, issueNumber } = await Promise.race([...active.values()]);
    active.delete(issueNumber);
    return result;
  }

  // Main drain loop: fill → wait → check → repeat.
  while (true) {
    // Fill available slots (only when not halted).
    while (!haltReason && active.size < opts.concurrency && queue.length > 0) {
      // Pre-launch budget guard: check before every fillSlot, including the first.
      if (opts.budgetDollars !== null && cumulativeCostUsd >= opts.budgetDollars) {
        haltReason = "budget_exhausted";
        deps.log(
          `[pipeline queue] budget exhausted: cumulative $${cumulativeCostUsd.toFixed(4)} >= ` +
            `$${opts.budgetDollars} — no further runs launched`,
        );
        break;
      }
      fillSlot(queue.shift()!);
    }

    // Done when no in-flight work remains.
    if (active.size === 0) break;

    const result = await waitForNext();

    // Accumulate cost: prefer result's costUsd, fall back to reading the run artifact.
    if (result.costUsd === null) {
      const cost = await deps.readRunCost(result.issueNumber).catch(() => null);
      if (cost !== null) result.costUsd = cost;
    }
    cumulativeCostUsd += result.costUsd ?? 0;
    results.push(result);

    const completedCount = results.length;
    const failedCount = results.filter(
      (r) => r.finalState !== "ready-to-deploy" && r.finalState !== "needs-human",
    ).length;

    deps.log(
      `[pipeline queue] #${result.issueNumber}: done ` +
        `(${result.finalState}, ` +
        `cost=${result.costUsd !== null ? `$${result.costUsd.toFixed(4)}` : "?"}, ` +
        `dur=${(result.durationMs / 1000).toFixed(1)}s)`,
    );

    // Check gates before the next fill attempt.
    if (!haltReason) {
      if (opts.budgetDollars !== null && cumulativeCostUsd >= opts.budgetDollars) {
        haltReason = "budget_exhausted";
        deps.log(
          `[pipeline queue] budget exhausted: cumulative $${cumulativeCostUsd.toFixed(4)} >= ` +
            `$${opts.budgetDollars} — no further runs launched`,
        );
      } else if (
        completedCount >= 3 &&
        failedCount / completedCount >= opts.maxFailureRate
      ) {
        haltReason = "failure_rate_exceeded";
        deps.log(
          `[pipeline queue] failure rate exceeded: ${failedCount}/${completedCount} ` +
            `(${((failedCount / completedCount) * 100).toFixed(1)}%) >= ` +
            `${(opts.maxFailureRate * 100).toFixed(1)}% — no further runs launched`,
        );
      }
    }
  }

  const endedAt = deps.clock();

  const summary = buildBatchSummary(
    results,
    titleMap,
    opts,
    haltReason,
    excludedCount,
    startedAt,
    endedAt,
  );

  const artifactDir = path.join(
    opts.repoDir,
    ".agent-pipeline",
    "runs",
    `batch-${opts.batchId}`,
  );
  const artifactPath = path.join(artifactDir, "batch-summary.json");
  await deps.writeFile(artifactPath, JSON.stringify(summary, null, 2));

  // Opt-in papercut auto-file (#421): best-effort, gated on resolved config,
  // wrapped so a failure here can never alter the batch's outcome or exit status.
  if (opts.papercuts?.auto_file) {
    await deps.autoFilePapercuts({
      repoDir: opts.repoDir,
      windowHours: opts.papercuts.auto_file_window_hours,
      maxPerWindow: opts.papercuts.auto_file_max_per_window,
      minOccurrences: opts.papercuts.auto_file_min_occurrences,
    }).catch(() => {});
  }

  printHumanSummary(summary, artifactPath, deps);
  deps.log(`[pipeline queue] batch ${opts.batchId}: done`);
}
