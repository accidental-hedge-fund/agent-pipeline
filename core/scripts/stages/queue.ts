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
import { runsDir } from "../run-store.ts";

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
  log(msg: string): void;
  clock(): number;
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
      const pipelineScript = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../pipeline.ts",
      );
      const args: string[] = [
        "--experimental-strip-types",
        pipelineScript,
        String(issueNumber),
      ];
      if (opts.profile) args.push("--profile", opts.profile);
      if (opts.repoPath) args.push("--repo-path", opts.repoPath);

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

      // Read the final state and cost from the most recent run summary.
      let finalState = exitCode === 0 ? "ready-to-deploy" : "error";
      let costUsd: number | null = null;
      try {
        const entries = fs.readdirSync(runsDir(repoDir))
          .filter((e) => e.startsWith(`${issueNumber}-`))
          .sort();
        const latest = entries.at(-1);
        if (latest) {
          const raw = fs.readFileSync(
            path.join(runsDir(repoDir), latest, "summary.json"),
            "utf8",
          );
          const summary = JSON.parse(raw) as {
            finalState?: string;
            accounting?: { totals?: { actual_cost_usd?: number; estimated_cost_usd?: number } };
          };
          if (summary.finalState) finalState = summary.finalState;
          const totals = summary.accounting?.totals;
          if (totals) {
            costUsd = (totals.actual_cost_usd ?? 0) + (totals.estimated_cost_usd ?? 0);
          }
        }
      } catch {
        // Summary not available — use exit-code-based fallback
      }

      return {
        issueNumber,
        finalState,
        costUsd,
        durationMs,
        ...(exitCode !== 0 && finalState === "error" ? { error: `exit code ${exitCode}` } : {}),
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

    log: (msg: string) => process.stdout.write(msg + "\n"),
    clock: () => Date.now(),
  };
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
  let filtered = candidates;

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
    const p = deps.runPipeline(issue.number, { profile: opts.profile, repoPath: opts.repoDir })
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

  printHumanSummary(summary, artifactPath, deps);
  deps.log(`[pipeline queue] batch ${opts.batchId}: done`);
}
