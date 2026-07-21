// Factory scoreboard (#301): read-only aggregation over run-store artifacts.
//
// Inputs are limited to .agent-pipeline/runs/*/{run.json,events.jsonl,summary.json}.
// The reducer never writes files and never calls GitHub.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { runsDir } from "./run-store.ts";

type JsonRecord = Record<string, unknown>;

export type ScoreboardSeverity = "warning" | "error";

export interface ScoreboardDiagnostic {
  severity: ScoreboardSeverity;
  code: string;
  path: string;
  message: string;
}

export interface ScoreboardWindow {
  since: string;
  until: string;
  days: number | null;
}

export interface RateValue {
  numerator: number;
  denominator: number;
  ratio: number | null;
}

export interface DurationAggregate {
  count: number;
  total_ms: number;
  min_ms: number | null;
  max_ms: number | null;
  avg_ms: number | null;
}

export interface GatePassMetric {
  pass_rate: RateValue;
  passed: number;
  failed: number;
  skipped: number;
}

export interface CostMetric {
  value: number | null;
  denominator: number;
  total_usd: number;
  actual_usd: number;
  estimated_usd: number;
  actual_call_count: number;
  estimated_call_count: number;
  missing_call_count: number;
}

export interface CostAccountingTotals {
  invocation_count: number;
  total_duration_ms: number;
  command_count: number;
  subprocess_count: number;
  actual_cost_usd: number;
  estimated_cost_usd: number;
  unknown_cost_count: number;
  prompt_chars_total: number;
  prompt_chars_max: number;
  prompt_estimated_tokens_total: number;
}

export interface CostAccountingGroup extends CostAccountingTotals {
  issue: number;
  stage: string;
  harness: string;
  model_slot: string;
  model: string;
  outcome: string;
}

/** Cost-source coverage across the window's accounting records (#429) —
 *  distinct from `totals`' USD sums: this answers "how much of this window is
 *  measured, vs. guessed, vs. not known at all?" `actual_coverage` is `null`
 *  when there are no calls, matching the existing zero-denominator rule. */
export interface CostSourceCoverage {
  actual_calls: number;
  estimated_calls: number;
  unknown_calls: number;
  actual_coverage: number | null;
}

export interface CostAccountingMetric {
  totals: CostAccountingTotals;
  groups: CostAccountingGroup[];
  coverage: CostSourceCoverage;
}

/** Generic execution-identity grouping dimension for `--by` (#437). Distinct
 *  from `CostAccountingGroup`'s fixed six-key grouping: this collapses along
 *  exactly one recorded identity. `harness` groups on the record's harness
 *  field verbatim (the configured executor name for a delegated stage);
 *  `executor` groups on the record's executor provider — the two stay
 *  distinct identities over distinct fields. */
export type ScoreboardGroupBy = "harness" | "model" | "effort" | "executor";

export const SCOREBOARD_GROUP_BY_VALUES: ScoreboardGroupBy[] = ["harness", "model", "effort", "executor"];

/** One identity value's slice of the window's record-scoped metrics. The key
 *  is the recorded identity used verbatim, or the literal `unknown` (field
 *  absent/empty) or `not applicable` (dimension cannot apply to the record) —
 *  see design decision in openspec/changes/scoreboard-treatment-grouping. */
export interface ScoreboardGroupEntry extends CostAccountingTotals {
  key: string;
  actual_calls: number;
  estimated_calls: number;
  unknown_calls: number;
  actual_coverage: number | null;
  /** Distinct `executor_model` values observed in this group. Present only
   *  when grouping `--by executor`. */
  executor_models?: string[];
}

export interface ScoreboardGrouping {
  groups: ScoreboardGroupEntry[];
}

export interface ScoreboardMetrics {
  ready_to_deploy_without_human_intervention: RateValue;
  cost_per_ready_pr_usd: CostMetric;
  cost_accounting: CostAccountingMetric;
  full_run_duration_ms: DurationAggregate;
  stage_duration_ms: Record<string, DurationAggregate>;
  harness_calls_per_successful_pr: RateValue;
  retry_fix_rounds_per_pr: RateValue;
  blocker_rate_by_kind: {
    denominator: number;
    counts: Record<string, number>;
    rates: Record<string, RateValue>;
  };
  needs_human_rate: RateValue;
  same_harness_fallback_rate: RateValue;
  gate_pass_rates: {
    test: GatePassMetric;
    eval: GatePassMetric;
    shipcheck: GatePassMetric;
  };
}

export interface ScoreboardTotals {
  scanned_runs: number;
  included_runs: number;
  ready_runs: number;
  successful_prs: number;
  diagnostics: number;
}

export type ScoreboardBucket = "day" | "week";

export interface ScoreboardPeriod {
  start: string;
  end: string;
  totals: ScoreboardTotals;
  metrics: ScoreboardMetrics;
  by?: ScoreboardGroupBy;
  grouping?: ScoreboardGrouping;
}

export interface ScoreboardReport {
  schema_version: 1;
  window: ScoreboardWindow;
  totals: ScoreboardTotals;
  metrics: ScoreboardMetrics;
  diagnostics: ScoreboardDiagnostic[];
  bucket?: ScoreboardBucket;
  series?: ScoreboardPeriod[];
  by?: ScoreboardGroupBy;
  grouping?: ScoreboardGrouping;
}

export interface ScoreboardOpts {
  repoDir: string;
  since?: string;
  until?: string;
  days?: number;
  json?: boolean;
  estimateCost?: string[];
  bucket?: string;
  /** Raw `--by` flag values, collected repeatably so a repeated flag can be
   *  detected (not silently last-wins). Parsed by parseScoreboardGroupBy(). */
  by?: string[];
  /** Write a self-contained offline HTML export of the report to this path (#427). */
  html?: string;
  now?: Date;
}

export interface ScoreboardDeps {
  readFile: (p: string) => Promise<string>;
  readdir: (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  log: (msg: string) => void;
  /** Write seam for the `--html` export (#427): exclusively creates `p` (fails
   *  rather than following a pre-existing path, symlink or otherwise), then
   *  renamed onto the destination, so a mid-write failure never leaves a
   *  partial destination file. */
  writeFile: (p: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (p: string) => Promise<void>;
}

export function realScoreboardDeps(): ScoreboardDeps {
  return {
    readFile: (p) => fsp.readFile(p, "utf8"),
    readdir: async (p) => {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      return entries as Array<{ name: string; isDirectory(): boolean }>;
    },
    log: (msg) => process.stdout.write(`${msg}\n`),
    writeFile: (p, content) => fsp.writeFile(p, content, { encoding: "utf8", flag: "wx" }),
    rename: (from, to) => fsp.rename(from, to),
    unlink: (p) => fsp.unlink(p),
  };
}

interface IncludedRun {
  runId: string;
  dir: string;
  runJsonPath: string;
  eventsPath: string;
  summaryPath: string;
  runJson: JsonRecord | null;
  events: JsonRecord[];
  summary: JsonRecord | null;
  startAt: string;
  issue: number | null;
  pr: number | null;
  finalState: string | null;
}

interface ScanResult {
  scannedRuns: number;
  runs: IncludedRun[];
  diagnostics: ScoreboardDiagnostic[];
}

interface HarnessCall {
  harness: string;
  record: JsonRecord;
  path: string;
}

interface AccountingRecordRef {
  record: JsonRecord;
  path: string;
  index: number;
}

interface PrGroup {
  pr: number;
  runs: IncludedRun[];
}

type GateName = "test" | "eval" | "shipcheck";
type GateOutcome = "pass" | "fail" | "skipped";
type GateResult = { gate: GateName; outcome: GateOutcome };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseScoreboardWindow(
  opts: Pick<ScoreboardOpts, "since" | "until" | "days" | "now">,
): ScoreboardWindow {
  const now = opts.now ?? new Date();
  const days = opts.days;
  if (days !== undefined && (!Number.isInteger(days) || days <= 0)) {
    throw new Error(`--days must be a positive integer, got: ${String(days)}`);
  }

  const parsedSince = opts.since !== undefined ? parseDateArg(opts.since, "--since") : null;
  const parsedUntil = opts.until !== undefined ? parseDateArg(opts.until, "--until") : null;
  const effectiveDays = days ?? (parsedSince === null && parsedUntil === null ? 30 : null);

  let since: Date;
  let until: Date;
  if (parsedSince && parsedUntil) {
    since = parsedSince;
    until = parsedUntil;
  } else if (parsedSince && effectiveDays !== null) {
    since = parsedSince;
    until = new Date(parsedSince.getTime() + effectiveDays * MS_PER_DAY);
  } else if (parsedUntil && effectiveDays !== null) {
    until = parsedUntil;
    since = new Date(parsedUntil.getTime() - effectiveDays * MS_PER_DAY);
  } else if (parsedSince) {
    since = parsedSince;
    until = now;
  } else if (parsedUntil) {
    until = parsedUntil;
    since = new Date(parsedUntil.getTime() - 30 * MS_PER_DAY);
  } else {
    const span = effectiveDays ?? 30;
    until = now;
    since = new Date(now.getTime() - span * MS_PER_DAY);
  }

  if (since.getTime() > until.getTime()) {
    throw new Error(`scoreboard window is invalid: --since must be before --until`);
  }

  return {
    since: since.toISOString(),
    until: until.toISOString(),
    days: effectiveDays,
  };
}

function parseDateArg(value: string, flag: string): Date {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${flag} must be an ISO-8601 date, got: ${value}`);
  return new Date(ms);
}

export function parseScoreboardBucket(value: string | undefined): ScoreboardBucket | null {
  if (value === undefined) return null;
  if (value === "day" || value === "week") return value;
  throw new Error(`--bucket must be one of: day, week (got: ${value})`);
}

/** Validates `--by` before any artifact is read (spec requirement). `null`
 *  for an absent flag; throws naming all four dimensions for an unsupported
 *  value; throws stating that exactly one dimension is supported when the
 *  flag was supplied more than once. */
export function parseScoreboardGroupBy(values: string[] | undefined): ScoreboardGroupBy | null {
  if (values === undefined || values.length === 0) return null;
  if (values.length > 1) {
    throw new Error(`--by supports exactly one grouping dimension per invocation, got ${values.length}: ${values.join(", ")}`);
  }
  const value = values[0];
  if ((SCOREBOARD_GROUP_BY_VALUES as string[]).includes(value)) return value as ScoreboardGroupBy;
  throw new Error(`--by must be one of: ${SCOREBOARD_GROUP_BY_VALUES.join(", ")} (got: ${value})`);
}

export function parseEstimateCosts(values: string[] | undefined): Record<string, number> {
  const estimates: Record<string, number> = {};
  for (const raw of values ?? []) {
    const idx = raw.indexOf("=");
    if (idx <= 0 || idx === raw.length - 1) {
      throw new Error(`--estimate-cost must be <harness>=<usd-per-call>, got: ${raw}`);
    }
    const harness = raw.slice(0, idx).trim();
    const usdRaw = raw.slice(idx + 1).trim();
    const usd = Number(usdRaw);
    if (!harness || !Number.isFinite(usd) || usd < 0) {
      throw new Error(`--estimate-cost must be <harness>=<usd-per-call>, got: ${raw}`);
    }
    estimates[harness] = usd;
  }
  return estimates;
}

export async function buildScoreboardReport(
  opts: ScoreboardOpts,
  deps: Pick<ScoreboardDeps, "readFile" | "readdir"> = realScoreboardDeps(),
): Promise<ScoreboardReport> {
  const window = parseScoreboardWindow(opts);
  const bucket = parseScoreboardBucket(opts.bucket);
  const groupBy = parseScoreboardGroupBy(opts.by);
  const estimates = parseEstimateCosts(opts.estimateCost);
  const scan = await scanRunStore(opts.repoDir, window, deps);
  const report = aggregateRuns(window, scan, estimates, groupBy);
  if (bucket === null) return report;

  const periods = computePeriods(window, bucket);
  const assigned = assignRunsToPeriods(periods, scan.runs);
  const series: ScoreboardPeriod[] = periods.map((period, i) => buildPeriodEntry(period, assigned[i], estimates, groupBy));
  return { ...report, bucket, series };
}

interface PeriodBounds {
  start: string;
  end: string;
  startMs: number;
  endMs: number;
}

function floorToUTCDay(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

function floorToUTCWeekStart(ms: number): number {
  const dayFloor = floorToUTCDay(ms);
  const weekday = new Date(dayFloor).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (weekday + 6) % 7;
  return dayFloor - daysSinceMonday * MS_PER_DAY;
}

function computePeriods(window: ScoreboardWindow, bucket: ScoreboardBucket): PeriodBounds[] {
  const sinceMs = Date.parse(window.since);
  const untilMs = Date.parse(window.until);
  const stepMs = bucket === "day" ? MS_PER_DAY : 7 * MS_PER_DAY;

  const periods: PeriodBounds[] = [];
  let startMs = sinceMs;
  let boundary = bucket === "day" ? floorToUTCDay(sinceMs) : floorToUTCWeekStart(sinceMs);
  while (true) {
    const nextBoundary = boundary + stepMs;
    const endMs = nextBoundary >= untilMs ? untilMs : nextBoundary;
    periods.push({
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      startMs,
      endMs,
    });
    if (nextBoundary >= untilMs) break;
    startMs = nextBoundary;
    boundary = nextBoundary;
  }
  return periods;
}

function assignRunsToPeriods(periods: PeriodBounds[], runs: IncludedRun[]): IncludedRun[][] {
  const buckets: IncludedRun[][] = periods.map(() => []);
  for (const run of runs) {
    const ms = Date.parse(run.startAt);
    let idx = periods.length - 1;
    for (let i = 0; i < periods.length; i++) {
      if (ms < periods[i].endMs) {
        idx = i;
        break;
      }
    }
    buckets[idx].push(run);
  }
  return buckets;
}

function buildPeriodEntry(
  period: PeriodBounds,
  runs: IncludedRun[],
  costEstimates: Record<string, number>,
  groupBy: ScoreboardGroupBy | null,
): ScoreboardPeriod {
  const core = reduceRunsCore(runs, costEstimates, groupBy);
  return {
    start: period.start,
    end: period.end,
    totals: {
      scanned_runs: runs.length,
      included_runs: runs.length,
      ready_runs: core.readyRuns,
      successful_prs: core.successfulPrs,
      diagnostics: core.diagnostics.length,
    },
    metrics: core.metrics,
    ...(groupBy ? { by: groupBy, grouping: core.grouping } : {}),
  };
}

export async function runScoreboard(
  opts: ScoreboardOpts,
  deps: ScoreboardDeps = realScoreboardDeps(),
): Promise<void> {
  const report = await buildScoreboardReport(opts, deps);
  if (opts.json) {
    process.stdout.write(formatScoreboardJson(report) + "\n");
  } else {
    deps.log(formatScoreboardHuman(report));
  }
  if (opts.html) {
    const html = renderScoreboardHtml(report);
    await writeScoreboardHtmlExport(opts.html, html, deps);
  }
}

const HTML_EXPORT_TEMP_CREATE_ATTEMPTS = 5;

/** Atomic write for the `--html` export (#427): the full document is rendered
 *  in memory before any write occurs, then exclusively created under an
 *  unpredictable temporary name in the destination's own directory and
 *  renamed onto the destination. `writeFile` opens with `wx` (create-exclusive),
 *  so a pre-created path at the temp name — including a symlink planted by
 *  another local actor — is never opened or followed; a collision (or a
 *  same-process race on the same name) surfaces as EEXIST and is retried under
 *  a fresh random name. An invalid or unwritable destination (missing parent
 *  dir, destination is a directory, unwritable directory) fails the
 *  write/rename step and leaves no temp file behind — never creates missing
 *  parent directories. */
async function writeScoreboardHtmlExport(
  destPath: string,
  content: string,
  deps: Pick<ScoreboardDeps, "writeFile" | "rename" | "unlink">,
): Promise<void> {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  let tempPath = "";
  for (let attempt = 1; ; attempt++) {
    tempPath = path.join(dir, `.${base}.tmp-${crypto.randomBytes(12).toString("hex")}`);
    try {
      await deps.writeFile(tempPath, content);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        if (attempt < HTML_EXPORT_TEMP_CREATE_ATTEMPTS) continue;
        // EEXIST means this invocation never created the colliding file —
        // unlinking it would delete a pre-existing file (or symlink) some
        // other writer owns (#427 delta finding ada9497b).
        throw new Error(`cannot write HTML export to ${destPath}: ${(err as Error).message}`);
      }
      await deps.unlink(tempPath).catch(() => {});
      throw new Error(`cannot write HTML export to ${destPath}: ${(err as Error).message}`);
    }
  }
  try {
    await deps.rename(tempPath, destPath);
  } catch (err) {
    await deps.unlink(tempPath).catch(() => {});
    throw new Error(`cannot write HTML export to ${destPath}: ${(err as Error).message}`);
  }
}

export async function scanRunStore(
  repoDir: string,
  window: ScoreboardWindow,
  deps: Pick<ScoreboardDeps, "readFile" | "readdir"> = realScoreboardDeps(),
): Promise<ScanResult> {
  const root = runsDir(repoDir);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  const diagnostics: ScoreboardDiagnostic[] = [];
  try {
    entries = await deps.readdir(root);
  } catch (err) {
    diagnostics.push({
      severity: "warning",
      code: "missing_run_store",
      path: root,
      message:
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "Run store directory is missing."
          : `Run store directory could not be read: ${(err as Error).message}`,
    });
    return { scannedRuns: 0, runs: [], diagnostics };
  }

  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const runs: IncludedRun[] = [];
  for (const entry of dirs) {
    const runId = entry.name;
    const dir = path.join(root, runId);
    const runJsonPath = path.join(dir, "run.json");
    const eventsPath = path.join(dir, "events.jsonl");
    const summaryPath = path.join(dir, "summary.json");
    const runDiagnostics: ScoreboardDiagnostic[] = [];

    const runJson = await readJsonArtifact(deps, runJsonPath, {
      missing: "missing_run_json",
      corrupt: "corrupt_run_json",
      label: "run.json",
    }, runDiagnostics);

    let events: JsonRecord[] | null = null;
    const runJsonStart = isoFromUnknown(runJson?.["started_at"]);
    let startAt = runJsonStart;

    if (!startAt) {
      const eventRead = await readEventsArtifact(deps, eventsPath);
      events = eventRead.events;
      runDiagnostics.push(...eventRead.diagnostics);
      startAt = firstRunStart(events) ?? parseRunIdTimestamp(runId);
    }

    if (!startAt) {
      diagnostics.push(...runDiagnostics);
      diagnostics.push({
        severity: "warning",
        code: "missing_start_time",
        path: dir,
        message: "Run has no parseable run.json.started_at, run_start event, or run-id timestamp.",
      });
      continue;
    }

    if (!isInsideWindow(startAt, window)) continue;

    if (events === null) {
      const eventRead = await readEventsArtifact(deps, eventsPath);
      events = eventRead.events;
      runDiagnostics.push(...eventRead.diagnostics);
    }

    const summary = await readJsonArtifact(deps, summaryPath, {
      missing: "missing_summary",
      corrupt: "corrupt_summary",
      label: "summary.json",
    }, runDiagnostics);

    diagnostics.push(...runDiagnostics);
    runs.push({
      runId,
      dir,
      runJsonPath,
      eventsPath,
      summaryPath,
      runJson,
      events,
      summary,
      startAt,
      issue: resolveIssue(runJson, events, summary),
      pr: resolvePr(events, summary),
      finalState: resolveFinalState(events, summary),
    });
  }

  return { scannedRuns: dirs.length, runs, diagnostics };
}

async function readJsonArtifact(
  deps: Pick<ScoreboardDeps, "readFile">,
  filePath: string,
  codes: { missing: string; corrupt: string; label: string },
  diagnostics: ScoreboardDiagnostic[],
): Promise<JsonRecord | null> {
  let raw: string;
  try {
    raw = await deps.readFile(filePath);
  } catch (err) {
    diagnostics.push({
      severity: "warning",
      code: codes.missing,
      path: filePath,
      message:
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `${codes.label} is missing.`
          : `${codes.label} could not be read: ${(err as Error).message}`,
    });
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch (err) {
    diagnostics.push({
      severity: "warning",
      code: codes.corrupt,
      path: filePath,
      message: `${codes.label} contains invalid JSON: ${(err as Error).message}`,
    });
    return null;
  }
}

async function readEventsArtifact(
  deps: Pick<ScoreboardDeps, "readFile">,
  filePath: string,
): Promise<{ events: JsonRecord[]; diagnostics: ScoreboardDiagnostic[] }> {
  let raw: string;
  const diagnostics: ScoreboardDiagnostic[] = [];
  try {
    raw = await deps.readFile(filePath);
  } catch (err) {
    diagnostics.push({
      severity: "warning",
      code: "missing_events",
      path: filePath,
      message:
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "events.jsonl is missing."
          : `events.jsonl could not be read: ${(err as Error).message}`,
    });
    return { events: [], diagnostics };
  }

  const events: JsonRecord[] = [];
  const lines = raw.split("\n");
  const endedWithNewline = raw.endsWith("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) events.push(parsed);
    } catch (err) {
      const isPartialTail = i === lines.length - 1 && !endedWithNewline;
      diagnostics.push({
        severity: "warning",
        code: isPartialTail ? "partial_events_tail" : "corrupt_events_line",
        path: filePath,
        message: isPartialTail
          ? "events.jsonl ended with a partial JSON line; complete prior lines were used."
          : `events.jsonl contains an invalid JSON line: ${(err as Error).message}`,
      });
    }
  }
  return { events, diagnostics };
}

interface ReducedCore {
  readyRuns: number;
  successfulPrs: number;
  metrics: ScoreboardMetrics;
  diagnostics: ScoreboardDiagnostic[];
  grouping?: ScoreboardGrouping;
}

function aggregateRuns(
  window: ScoreboardWindow,
  scan: ScanResult,
  costEstimates: Record<string, number>,
  groupBy: ScoreboardGroupBy | null,
): ScoreboardReport {
  const core = reduceRunsCore(scan.runs, costEstimates, groupBy);
  const diagnostics = [...scan.diagnostics, ...core.diagnostics];

  return {
    schema_version: 1,
    window,
    totals: {
      scanned_runs: scan.scannedRuns,
      included_runs: scan.runs.length,
      ready_runs: core.readyRuns,
      successful_prs: core.successfulPrs,
      diagnostics: diagnostics.length,
    },
    metrics: core.metrics,
    diagnostics,
    ...(groupBy ? { by: groupBy, grouping: core.grouping } : {}),
  };
}

function reduceRunsCore(
  runs: IncludedRun[],
  costEstimates: Record<string, number>,
  groupBy: ScoreboardGroupBy | null = null,
): ReducedCore {
  const diagnostics: ScoreboardDiagnostic[] = [];
  const readyGroups = new Map<number, PrGroup>();
  let readyRuns = 0;
  for (const run of runs) {
    if (run.finalState !== "ready-to-deploy") continue;
    readyRuns++;
    if (run.pr === null) {
      diagnostics.push({
        severity: "warning",
        code: "missing_pr_for_ready_run",
        path: run.summaryPath,
        message: `Run ${run.runId} reached ready-to-deploy but no PR number could be proven.`,
      });
      continue;
    }
    const existing = readyGroups.get(run.pr);
    if (existing) existing.runs.push(run);
    else readyGroups.set(run.pr, { pr: run.pr, runs: [run] });
  }

  const fullRunDuration = newDurationBuilder();
  const stageDurations = new Map<string, ReturnType<typeof newDurationBuilder>>();
  const blockerCounts = new Map<string, number>();
  const gateCounts = {
    test: { passed: 0, failed: 0, skipped: 0 },
    eval: { passed: 0, failed: 0, skipped: 0 },
    shipcheck: { passed: 0, failed: 0, skipped: 0 },
  };
  let needsHuman = 0;
  let reviewRounds = 0;
  let sameHarnessFallbacks = 0;
  const { costAccounting, grouping } = aggregateCostAccounting(runs, diagnostics, groupBy);

  for (const run of runs) {
    const fullDuration = fullRunDurationMs(run);
    if (fullDuration !== null) {
      fullRunDuration.add(fullDuration);
    } else {
      diagnostics.push({
        severity: "warning",
        code: "partial_metric_coverage",
        path: run.dir,
        message: `Run ${run.runId} has no provable full-run duration.`,
      });
    }

    for (const sample of stageDurationSamples(run)) {
      if (!stageDurations.has(sample.stage)) stageDurations.set(sample.stage, newDurationBuilder());
      stageDurations.get(sample.stage)!.add(sample.durationMs);
    }

    for (const intervention of collectHumanInterventions(run)) {
      const kind = typeof intervention["kind"] === "string" ? intervention["kind"] : "unknown";
      blockerCounts.set(kind, (blockerCounts.get(kind) ?? 0) + 1);
    }

    if (run.finalState === "needs-human") needsHuman++;

    for (const review of collectReviewRecords(run)) {
      reviewRounds++;
      if (review.selfReview) sameHarnessFallbacks++;
    }

    for (const result of collectGateResults(run)) {
      const bucket = gateCounts[result.gate];
      if (result.outcome === "pass") bucket.passed++;
      else if (result.outcome === "fail") bucket.failed++;
      else bucket.skipped++;
    }
  }

  let autonomousReadyPrs = 0;
  let harnessCalls = 0;
  let retryFixRounds = 0;
  const cost = {
    actualUsd: 0,
    estimatedUsd: 0,
    actualCalls: 0,
    estimatedCalls: 0,
    missingCalls: 0,
  };
  const missingEstimateKeys = new Set<string>();

  for (const group of readyGroups.values()) {
    const interventions = group.runs.flatMap((run) => collectHumanInterventions(run));
    const overrides = group.runs.flatMap((run) => collectOverrides(run));
    if (interventions.length === 0 && overrides.length === 0) autonomousReadyPrs++;

    const groupCalls = group.runs.flatMap((run) => collectHarnessCalls(run));
    harnessCalls += groupCalls.length;
    if (groupCalls.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "partial_metric_coverage",
        path: group.runs[0].dir,
        message: `Ready PR #${group.pr} has no recorded harness invocation records.`,
      });
    }

    retryFixRounds += group.runs.reduce((sum, run) => sum + countRetryFixRounds(run), 0);

    for (const call of groupCalls) {
      const actual = actualCostUsd(call.record);
      if (actual !== null) {
        cost.actualUsd += actual;
        cost.actualCalls++;
        continue;
      }
      const estimate = costEstimates[call.harness];
      if (estimate !== undefined) {
        cost.estimatedUsd += estimate;
        cost.estimatedCalls++;
        continue;
      }
      cost.missingCalls++;
      const diagKey = `${call.harness}|${call.path}`;
      if (!missingEstimateKeys.has(diagKey)) {
        missingEstimateKeys.add(diagKey);
        diagnostics.push({
          severity: "warning",
          code: "missing_cost_estimate",
          path: call.path,
          message: `Harness call for '${call.harness}' has no actual cost and no --estimate-cost ${call.harness}=<usd> value was supplied.`,
        });
      }
    }
  }

  const successfulPrs = readyGroups.size;
  const stageDurationMetrics: Record<string, DurationAggregate> = {};
  for (const [stage, builder] of [...stageDurations.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    stageDurationMetrics[stage] = builder.value();
  }

  const blockerCountsObj: Record<string, number> = {};
  const blockerRates: Record<string, RateValue> = {};
  for (const [kind, count] of [...blockerCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    blockerCountsObj[kind] = count;
    blockerRates[kind] = rate(count, runs.length);
  }

  const costTotal = roundUsd(cost.actualUsd + cost.estimatedUsd);
  const costValue =
    successfulPrs === 0 || cost.missingCalls > 0
      ? null
      : roundUsd(costTotal / successfulPrs);

  const metrics: ScoreboardMetrics = {
    ready_to_deploy_without_human_intervention: rate(autonomousReadyPrs, successfulPrs),
    cost_per_ready_pr_usd: {
      value: costValue,
      denominator: successfulPrs,
      total_usd: costTotal,
      actual_usd: roundUsd(cost.actualUsd),
      estimated_usd: roundUsd(cost.estimatedUsd),
      actual_call_count: cost.actualCalls,
      estimated_call_count: cost.estimatedCalls,
      missing_call_count: cost.missingCalls,
    },
    cost_accounting: costAccounting,
    full_run_duration_ms: fullRunDuration.value(),
    stage_duration_ms: stageDurationMetrics,
    harness_calls_per_successful_pr: rate(harnessCalls, successfulPrs),
    retry_fix_rounds_per_pr: rate(retryFixRounds, successfulPrs),
    blocker_rate_by_kind: {
      denominator: runs.length,
      counts: blockerCountsObj,
      rates: blockerRates,
    },
    needs_human_rate: rate(needsHuman, runs.length),
    same_harness_fallback_rate: rate(sameHarnessFallbacks, reviewRounds),
    gate_pass_rates: {
      test: gateMetric(gateCounts.test),
      eval: gateMetric(gateCounts.eval),
      shipcheck: gateMetric(gateCounts.shipcheck),
    },
  };

  return { readyRuns, successfulPrs, metrics, diagnostics, grouping };
}

/** Resolves the group key an accounting record falls into for a single
 *  execution-identity dimension (#437). Values are used verbatim — never
 *  case-folded or aliased. `harness` and `executor` stay distinct identities
 *  over distinct recorded fields: `harness` is the record's harness value
 *  (the configured executor NAME for a delegated stage); `executor` is the
 *  record's executor provider, with a record carrying no executor evidence
 *  at all assigned to "not applicable" (rather than "unknown", which is
 *  reserved for a delegated record whose provider specifically wasn't
 *  recorded). */
export function resolveGroupIdentity(record: NormalizedAccountingRecord, dimension: ScoreboardGroupBy): string {
  switch (dimension) {
    case "harness":
      return record.harness;
    case "model":
      return record.model;
    case "effort":
      return record.effort;
    case "executor":
      if (record.executor_provider) return record.executor_provider;
      if (record.executor_model) return "unknown";
      return "not applicable";
  }
}

function aggregateCostAccounting(
  runs: IncludedRun[],
  diagnostics: ScoreboardDiagnostic[],
  groupBy: ScoreboardGroupBy | null,
): { costAccounting: CostAccountingMetric; grouping?: ScoreboardGrouping } {
  const groups = new Map<string, CostAccountingGroup>();
  const totals = newCostAccountingTotals();
  const unknownCostKeys = new Set<string>();
  let actualCalls = 0;
  let estimatedCalls = 0;
  let unknownCalls = 0;

  type GroupByEntry = ScoreboardGroupEntry & { actual_calls: number; estimated_calls: number; unknown_calls: number };
  const groupByGroups = new Map<string, GroupByEntry>();
  const executorModelsByKey = new Map<string, Set<string>>();

  for (const run of runs) {
    for (const ref of collectAccountingRecords(run)) {
      const normalized = normalizeAccountingRecord(ref.record, run);
      if (!normalized) {
        diagnostics.push({
          severity: "warning",
          code: "invalid_accounting_record",
          path: ref.path,
          message: `Stage accounting record ${ref.index} in run ${run.runId} is missing required grouping fields.`,
        });
        continue;
      }
      const key = [
        normalized.issue,
        normalized.stage,
        normalized.harness,
        normalized.model_slot,
        normalized.model,
        normalized.outcome,
      ].join("|");
      const group = groups.get(key) ?? {
        issue: normalized.issue,
        stage: normalized.stage,
        harness: normalized.harness,
        model_slot: normalized.model_slot,
        model: normalized.model,
        outcome: normalized.outcome,
        ...newCostAccountingTotals(),
      };
      addAccounting(group, normalized);
      addAccounting(totals, normalized);
      groups.set(key, group);

      if (normalized.cost_source === "actual") actualCalls++;
      else if (normalized.cost_source === "estimated") estimatedCalls++;
      else unknownCalls++;

      if (normalized.cost_source === "unknown") {
        const unknownKey = `${key}|${ref.path}`;
        if (!unknownCostKeys.has(unknownKey)) {
          unknownCostKeys.add(unknownKey);
          diagnostics.push({
            severity: "warning",
            code: "unknown_accounting_cost",
            path: ref.path,
            message: `Stage accounting for #${normalized.issue} ${normalized.stage}/${normalized.harness} has unknown cost; it is not counted as free.`,
          });
        }
      }

      if (groupBy) {
        const groupKey = resolveGroupIdentity(normalized, groupBy);
        const groupByEntry: GroupByEntry = groupByGroups.get(groupKey) ?? {
          key: groupKey,
          ...newCostAccountingTotals(),
          actual_calls: 0,
          estimated_calls: 0,
          unknown_calls: 0,
          actual_coverage: null,
        };
        addAccounting(groupByEntry, normalized);
        if (normalized.cost_source === "actual") groupByEntry.actual_calls++;
        else if (normalized.cost_source === "estimated") groupByEntry.estimated_calls++;
        else groupByEntry.unknown_calls++;
        groupByGroups.set(groupKey, groupByEntry);

        if (groupBy === "executor" && normalized.executor_model) {
          if (!executorModelsByKey.has(groupKey)) executorModelsByKey.set(groupKey, new Set());
          executorModelsByKey.get(groupKey)!.add(normalized.executor_model);
        }
      }
    }
  }

  const totalCalls = actualCalls + estimatedCalls + unknownCalls;

  const costAccounting: CostAccountingMetric = {
    totals: roundAccountingTotals(totals),
    coverage: {
      actual_calls: actualCalls,
      estimated_calls: estimatedCalls,
      unknown_calls: unknownCalls,
      actual_coverage: totalCalls === 0 ? null : roundUsd(actualCalls / totalCalls),
    },
    groups: [...groups.values()]
      .map(roundAccountingTotals)
      .sort((a, b) =>
        a.issue - b.issue ||
        a.stage.localeCompare(b.stage) ||
        a.harness.localeCompare(b.harness) ||
        a.model_slot.localeCompare(b.model_slot) ||
        a.model.localeCompare(b.model) ||
        a.outcome.localeCompare(b.outcome)
      ),
  };

  if (!groupBy) return { costAccounting };

  const groupingEntries: ScoreboardGroupEntry[] = [...groupByGroups.values()].map((entry) => {
    const groupTotalCalls = entry.actual_calls + entry.estimated_calls + entry.unknown_calls;
    const rounded = roundAccountingTotals(entry);
    const result: ScoreboardGroupEntry = {
      ...rounded,
      actual_coverage: groupTotalCalls === 0 ? null : roundUsd(entry.actual_calls / groupTotalCalls),
    };
    if (groupBy === "executor") {
      result.executor_models = [...(executorModelsByKey.get(entry.key) ?? [])].sort();
    }
    return result;
  });
  groupingEntries.sort((a, b) => b.invocation_count - a.invocation_count || a.key.localeCompare(b.key));

  return { costAccounting, grouping: { groups: groupingEntries } };
}

function collectAccountingRecords(run: IncludedRun): AccountingRecordRef[] {
  const summaryAccounting = isRecord(run.summary?.["accounting"]) ? run.summary?.["accounting"] : null;
  const summaryRecords = arrayRecords(summaryAccounting?.["records"]);
  if (summaryRecords.length > 0) {
    return summaryRecords.map((record, index) => ({ record, path: run.summaryPath, index }));
  }
  return run.events
    .map((record, index) => ({ record, path: run.eventsPath, index }))
    .filter((ref) => ref.record["type"] === "stage_accounting");
}

interface NormalizedAccountingRecord extends CostAccountingTotals {
  issue: number;
  stage: string;
  harness: string;
  model_slot: string;
  model: string;
  outcome: string;
  cost_source: string;
  cost_usd: number | null;
  /** Raw effort/executor identity (#437) — `effort` defaults to the literal
   *  "unknown" like `model`/`model_slot`; `executor_provider`/`executor_model`
   *  are left null/absent (not defaulted) so resolveGroupIdentity() can tell
   *  "no executor evidence at all" (not applicable) from "evidence but no
   *  provider" (unknown) apart from a normal missing field. */
  effort: string;
  executor_provider: string | null;
  executor_model: string | null;
}

function normalizeAccountingRecord(
  record: JsonRecord,
  run: IncludedRun,
): NormalizedAccountingRecord | null {
  const issue = numberField(record, "issue") ?? run.issue;
  const stage = stringField(record, "stage");
  const harness = stringField(record, "harness");
  const outcome = stringField(record, "outcome");
  if (issue === null || !stage || !harness || !outcome) return null;
  const source = stringField(record, "cost_source") ?? "unknown";
  const costUsd = numberField(record, "cost_usd");
  const normalized: NormalizedAccountingRecord = {
    issue,
    stage,
    harness,
    model_slot: stringField(record, "model_slot") ?? stringField(record, "modelSlot") ?? "unknown",
    model: stringField(record, "model") ?? "unknown",
    outcome,
    effort: stringField(record, "effort") ?? "unknown",
    executor_provider: stringField(record, "executor_provider") ?? stringField(record, "executorProvider"),
    executor_model: stringField(record, "executor_model") ?? stringField(record, "executorModel"),
    invocation_count: 1,
    total_duration_ms: Math.max(0, Math.round(numberField(record, "duration_ms") ?? numberField(record, "durationMs") ?? 0)),
    command_count: Math.max(0, Math.round(numberField(record, "command_count") ?? numberField(record, "commandCount") ?? 0)),
    subprocess_count: Math.max(0, Math.round(numberField(record, "subprocess_count") ?? numberField(record, "subprocessCount") ?? 0)),
    actual_cost_usd: 0,
    estimated_cost_usd: 0,
    unknown_cost_count: 0,
    prompt_chars_total: Math.max(0, Math.round(numberField(record, "prompt_chars") ?? numberField(record, "promptChars") ?? 0)),
    prompt_chars_max: Math.max(0, Math.round(numberField(record, "prompt_chars") ?? numberField(record, "promptChars") ?? 0)),
    prompt_estimated_tokens_total: Math.max(
      0,
      Math.round(numberField(record, "prompt_estimated_tokens") ?? numberField(record, "promptEstimatedTokens") ?? 0),
    ),
    cost_source: source,
    cost_usd: costUsd,
  };
  if (source === "actual" && costUsd !== null) normalized.actual_cost_usd = costUsd;
  else if (source === "estimated" && costUsd !== null) normalized.estimated_cost_usd = costUsd;
  else normalized.unknown_cost_count = 1;
  return normalized;
}

function newCostAccountingTotals(): CostAccountingTotals {
  return {
    invocation_count: 0,
    total_duration_ms: 0,
    command_count: 0,
    subprocess_count: 0,
    actual_cost_usd: 0,
    estimated_cost_usd: 0,
    unknown_cost_count: 0,
    prompt_chars_total: 0,
    prompt_chars_max: 0,
    prompt_estimated_tokens_total: 0,
  };
}

function addAccounting(target: CostAccountingTotals, source: CostAccountingTotals): void {
  target.invocation_count += source.invocation_count;
  target.total_duration_ms += source.total_duration_ms;
  target.command_count += source.command_count;
  target.subprocess_count += source.subprocess_count;
  target.actual_cost_usd += source.actual_cost_usd;
  target.estimated_cost_usd += source.estimated_cost_usd;
  target.unknown_cost_count += source.unknown_cost_count;
  target.prompt_chars_total += source.prompt_chars_total;
  target.prompt_chars_max = Math.max(target.prompt_chars_max, source.prompt_chars_max);
  target.prompt_estimated_tokens_total += source.prompt_estimated_tokens_total;
}

function roundAccountingTotals<T extends CostAccountingTotals>(value: T): T {
  return {
    ...value,
    actual_cost_usd: roundUsd(value.actual_cost_usd),
    estimated_cost_usd: roundUsd(value.estimated_cost_usd),
  };
}

function rate(numerator: number, denominator: number): RateValue {
  return {
    numerator,
    denominator,
    ratio: denominator === 0 ? null : numerator / denominator,
  };
}

function gateMetric(counts: { passed: number; failed: number; skipped: number }): GatePassMetric {
  return {
    pass_rate: rate(counts.passed, counts.passed + counts.failed),
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
  };
}

function newDurationBuilder() {
  const values: number[] = [];
  return {
    add(value: number): void {
      if (Number.isFinite(value) && value >= 0) values.push(Math.round(value));
    },
    value(): DurationAggregate {
      if (values.length === 0) {
        return { count: 0, total_ms: 0, min_ms: null, max_ms: null, avg_ms: null };
      }
      const total = values.reduce((sum, value) => sum + value, 0);
      return {
        count: values.length,
        total_ms: total,
        min_ms: Math.min(...values),
        max_ms: Math.max(...values),
        avg_ms: Math.round(total / values.length),
      };
    },
  };
}

function fullRunDurationMs(run: IncludedRun): number | null {
  for (let i = run.events.length - 1; i >= 0; i--) {
    const event = run.events[i];
    if (event["type"] !== "run_complete") continue;
    const elapsed = numberField(event, "elapsed_ms");
    if (elapsed !== null && elapsed >= 0) return elapsed;
  }

  const started = Date.parse(run.startAt);
  const completedEvent = [...run.events].reverse().find((event) => event["type"] === "run_complete");
  const completedAt = isoFromUnknown(completedEvent?.["at"]) ?? isoFromUnknown(run.summary?.["finalizedAt"]);
  if (Number.isFinite(started) && completedAt) {
    const completed = Date.parse(completedAt);
    if (Number.isFinite(completed) && completed >= started) return completed - started;
  }
  return null;
}

function stageDurationSamples(run: IncludedRun): Array<{ stage: string; durationMs: number }> {
  const samples: Array<{ stage: string; durationMs: number }> = [];
  const seen = new Set<string>();
  const starts = new Map<string, string[]>();

  for (const event of run.events) {
    const type = event["type"];
    const stage = stringField(event, "stage");
    if (!stage) continue;
    if (type === "stage_start") {
      const at = isoFromUnknown(event["at"]);
      if (!at) continue;
      if (!starts.has(stage)) starts.set(stage, []);
      starts.get(stage)!.push(at);
    } else if (type === "stage_complete") {
      const end = isoFromUnknown(event["at"]);
      const start = starts.get(stage)?.shift();
      if (!start || !end) continue;
      const durationMs = Date.parse(end) - Date.parse(start);
      addStageDurationSample(samples, seen, stage, start, end, durationMs);
    }
  }

  for (const stageRecord of arrayRecords(run.summary?.["stages"])) {
    const stage = stringField(stageRecord, "stage");
    const start = isoFromUnknown(stageRecord["enteredAt"]);
    const end = isoFromUnknown(stageRecord["exitedAt"]);
    if (!stage || !start || !end) continue;
    const durationMs = Date.parse(end) - Date.parse(start);
    addStageDurationSample(samples, seen, stage, start, end, durationMs);
  }

  return samples;
}

function addStageDurationSample(
  samples: Array<{ stage: string; durationMs: number }>,
  seen: Set<string>,
  stage: string,
  start: string,
  end: string,
  durationMs: number,
  suffix = "",
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const key = `${stage}|${start}|${end}|${suffix}`;
  if (seen.has(key)) return;
  seen.add(key);
  samples.push({ stage, durationMs });
}

function collectHumanInterventions(run: IncludedRun): JsonRecord[] {
  const items = new Map<string, JsonRecord>();
  for (const event of run.events) {
    if (event["type"] === "human_intervention") addRecord(items, event, interventionKey(event));
  }
  for (const item of arrayRecords(run.summary?.["interventions"])) {
    addRecord(items, item, interventionKey(item));
  }
  return [...items.values()];
}

function collectOverrides(run: IncludedRun): JsonRecord[] {
  return arrayRecords(run.summary?.["overrides"]);
}

function collectReviewRecords(run: IncludedRun): Array<{ selfReview: boolean }> {
  const reviews = new Map<string, { selfReview: boolean }>();
  for (const item of arrayRecords(run.summary?.["reviews"])) {
    const key = reviewKey(item);
    const selfReview = item["selfReview"] === true || item["self_review"] === true;
    reviews.set(key, { selfReview: (reviews.get(key)?.selfReview ?? false) || selfReview });
  }
  for (const event of run.events) {
    if (event["type"] !== "review_verdict") continue;
    const key = reviewKey(event);
    const selfReview = event["self_review"] === true || event["selfReview"] === true;
    reviews.set(key, { selfReview: (reviews.get(key)?.selfReview ?? false) || selfReview });
  }
  return [...reviews.values()];
}

function collectHarnessCalls(run: IncludedRun): HarnessCall[] {
  const calls = new Map<string, HarnessCall>();
  for (const [stageIndex, stage] of arrayRecords(run.summary?.["stages"]).entries()) {
    const stageName = stringField(stage, "stage") ?? `stage-${stageIndex}`;
    for (const [promptIndex, prompt] of arrayRecords(stage["prompts"]).entries()) {
      addHarnessCall(
        calls,
        `summary:prompt:${stageIndex}:${promptIndex}:${stageName}:${stringField(prompt, "kind") ?? ""}:${stringField(prompt, "harness") ?? ""}:${stringField(prompt, "hash") ?? ""}`,
        prompt,
        run.summaryPath,
      );
    }
  }

  for (const field of ["harness_calls", "harnessCalls", "harness_invocations", "harnessInvocations"]) {
    for (const [index, record] of arrayRecords(run.summary?.[field]).entries()) {
      addHarnessCall(calls, `summary:${field}:${index}`, record, run.summaryPath);
    }
  }

  for (const [index, event] of run.events.entries()) {
    const type = stringField(event, "type")?.toLowerCase() ?? "";
    const hasHarnessCallType =
      type === "harness_call" ||
      type === "harness_invocation" ||
      type === "model_call" ||
      type === "model_invocation" ||
      (type.includes("harness") && (type.includes("call") || type.includes("invocation")));
    const hasCostedReviewerEvent =
      type === "review_verdict" &&
      stringField(event, "reviewer_harness") !== null &&
      actualCostUsd(event) !== null;
    if (!hasHarnessCallType && !hasCostedReviewerEvent) continue;
    addHarnessCall(
      calls,
      `event:${index}:${type}:${stringField(event, "at") ?? ""}:${stringField(event, "harness") ?? stringField(event, "reviewer_harness") ?? ""}`,
      event,
      run.eventsPath,
      stringField(event, "reviewer_harness") ?? undefined,
    );
  }

  return [...calls.values()];
}

function addHarnessCall(
  calls: Map<string, HarnessCall>,
  key: string,
  record: JsonRecord,
  sourcePath: string,
  fallbackHarness?: string,
): void {
  const harness = stringField(record, "harness") ?? stringField(record, "reviewer_harness") ?? fallbackHarness ?? null;
  if (!harness) return;
  if (calls.has(key)) return;
  calls.set(key, { harness, record, path: sourcePath });
}

function countRetryFixRounds(run: IncludedRun): number {
  const keys = new Set<string>();
  const summaryFixStages = arrayRecords(run.summary?.["stages"]).filter((stage) => {
    const name = stringField(stage, "stage");
    return !!name && /^fix-\d+$/i.test(name);
  });
  for (const [index, stage] of summaryFixStages.entries()) {
    const name = stringField(stage, "stage") ?? "";
    keys.add(`fix:${index}:${name}:${stringField(stage, "enteredAt") ?? ""}`);
  }

  if (summaryFixStages.length === 0) {
    for (const [index, event] of run.events.entries()) {
      const type = stringField(event, "type") ?? "";
      const stage = stringField(event, "stage");
      if (type === "stage_start" && stage && /^fix-\d+$/i.test(stage)) {
        keys.add(`fix:${stage}:${stringField(event, "at") ?? index}`);
      }
    }
  }

  for (const [index, event] of run.events.entries()) {
    const type = stringField(event, "type") ?? "";
    if (type === "retry" || type === "recovery" || type === "auto_recovery" || type === "auto_recover") {
      keys.add(`event:retry:${stringField(event, "at") ?? index}:${stringField(event, "trigger") ?? ""}`);
    }
  }

  for (const [index, recovery] of arrayRecords(run.summary?.["recoveries"]).entries()) {
    keys.add(`summary:recovery:${index}:${stringField(recovery, "at") ?? ""}:${stringField(recovery, "trigger") ?? ""}`);
  }

  return keys.size;
}

function collectGateResults(run: IncludedRun): GateResult[] {
  const results: GateResult[] = [];
  const seen = new Set<string>();
  const structuredGates = new Set<GateName>();
  const coveredLifecycleStages = new Set<string>();

  for (const [index, event] of run.events.entries()) {
    const type = stringField(event, "type");
    if (type !== "gate_result" && type !== "gate_complete" && type !== "gate") continue;
    const gate = gateForName(stringField(event, "gate") ?? stringField(event, "stage"));
    const outcome = outcomeForGateVerdict(
      stringField(event, "verdict") ?? stringField(event, "result") ?? stringField(event, "outcome"),
    );
    if (!gate || !outcome) continue;
    structuredGates.add(gate);
    addGateResult(results, seen, gate, outcome, `event:gate:${index}:${stringField(event, "at") ?? ""}`);
  }

  for (const [index, stage] of arrayRecords(run.summary?.["stages"]).entries()) {
    const stageName = stringField(stage, "stage");
    const gate = gateForName(stageName);
    if (gate && !structuredGates.has(gate)) {
      const outcome = outcomeForStageRecord(gate, stage);
      if (outcome) {
        coveredLifecycleStages.add(`${gate}:${normalizeStageName(stageName)}`);
        addGateResult(results, seen, gate, outcome, `${gate}:${outcome}:${stageName}:${stringField(stage, "exitedAt") ?? stringField(stage, "enteredAt") ?? index}`);
      }
    }

    if (gate !== "test" && stageCanContainTestGateCommands(stageName) && !structuredGates.has("test")) {
      const outcome = outcomeFromCommands(arrayRecords(stage["commands"]));
      if (outcome) {
        addGateResult(results, seen, "test", outcome, `test:${outcome}:${stageName}:${stringField(stage, "exitedAt") ?? stringField(stage, "enteredAt") ?? index}`);
      }
    }
  }

  for (const [index, event] of run.events.entries()) {
    const type = stringField(event, "type");
    if (type === "stage_complete") {
      const stageName = stringField(event, "stage");
      const gate = gateForName(stageName);
      const lifecycleKey = `${gate}:${normalizeStageName(stageName)}`;
      const outcome = !gate || structuredGates.has(gate) || coveredLifecycleStages.has(lifecycleKey)
        ? null
        : outcomeForStageLifecycle(stringField(event, "outcome"));
      if (gate && outcome) {
        addGateResult(results, seen, gate, outcome, `${gate}:${outcome}:${stringField(event, "stage")}:${stringField(event, "at") ?? index}`);
      }
    }
  }

  return results;
}

function addGateResult(
  results: GateResult[],
  seen: Set<string>,
  gate: GateName,
  outcome: GateOutcome,
  key: string,
): void {
  if (seen.has(key)) return;
  seen.add(key);
  results.push({ gate, outcome });
}

function gateForName(value: string | null): GateName | null {
  if (!value) return null;
  const normalized = normalizeStageName(value);
  if (normalized.includes("shipcheck")) return "shipcheck";
  if (normalized.includes("eval")) return "eval";
  if (normalized.includes("test") || normalized.includes("build")) return "test";
  return null;
}

function normalizeStageName(value: string | null): string {
  return (value ?? "").toLowerCase().replace(/_/g, "-");
}

function outcomeForStageRecord(gate: GateName, stage: JsonRecord): GateOutcome | null {
  if (gate === "test" || gate === "eval") {
    const commandOutcome = outcomeFromCommands(arrayRecords(stage["commands"]));
    if (commandOutcome) return commandOutcome;
  }
  const explicitOutcome = outcomeForGateVerdict(
    stringField(stage, "verdict") ?? stringField(stage, "result"),
  );
  if (explicitOutcome) return explicitOutcome;
  return outcomeForStageLifecycle(stringField(stage, "outcome"));
}

function outcomeFromCommands(commands: JsonRecord[]): GateOutcome | null {
  if (commands.length === 0) return null;
  const last = commands[commands.length - 1];
  const exitCode = numberField(last, "exitCode") ?? numberField(last, "exit_code");
  if (exitCode === null) return null;
  return exitCode === 0 ? "pass" : "fail";
}

function stageCanContainTestGateCommands(value: string | null): boolean {
  const normalized = normalizeStageName(value);
  return normalized === "planning" || normalized === "implementing" || /^fix-\d+$/.test(normalized);
}

function outcomeForStageLifecycle(value: string | null): GateOutcome | null {
  const explicit = outcomeForGateVerdict(value);
  if (explicit) return explicit;
  if (value?.toLowerCase() === "advanced") return "skipped";
  return null;
}

function outcomeForGateVerdict(value: string | null): GateOutcome | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (["pass", "passed", "success", "ok"].includes(normalized)) return "pass";
  if (["blocked", "error", "fail", "failed", "failure", "partial"].includes(normalized)) return "fail";
  if (["skipped", "skip", "disabled", "not_applicable", "na"].includes(normalized)) return "skipped";
  return null;
}

function actualCostUsd(record: JsonRecord): number | null {
  const direct = numberField(record, "cost_usd");
  if (direct !== null) return direct;
  const usage = record["usage"];
  if (isRecord(usage)) return numberField(usage, "cost_usd");
  return null;
}

function resolveIssue(runJson: JsonRecord | null, events: JsonRecord[], summary: JsonRecord | null): number | null {
  return numberField(summary, "issue")
    ?? numberField(runJson, "issue")
    ?? firstNumberFromEvents(events, "issue");
}

function resolvePr(events: JsonRecord[], summary: JsonRecord | null): number | null {
  const summaryPr = numberField(summary, "pr");
  if (summaryPr !== null) return summaryPr;
  for (let i = events.length - 1; i >= 0; i--) {
    const pr = numberField(events[i], "pr");
    if (pr !== null) return pr;
  }
  return null;
}

function resolveFinalState(events: JsonRecord[], summary: JsonRecord | null): string | null {
  const summaryState = stringField(summary, "finalState") ?? stringField(summary, "final_state");
  if (summaryState) return summaryState;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event["type"] !== "run_complete") continue;
    const state = stringField(event, "final_state") ?? stringField(event, "finalState");
    if (state) return state;
  }
  return null;
}

function firstNumberFromEvents(events: JsonRecord[], field: string): number | null {
  for (const event of events) {
    const value = numberField(event, field);
    if (value !== null) return value;
  }
  return null;
}

function firstRunStart(events: JsonRecord[]): string | null {
  for (const event of events) {
    if (event["type"] !== "run_start") continue;
    const at = isoFromUnknown(event["at"]);
    if (at) return at;
  }
  return null;
}

function parseRunIdTimestamp(runId: string): string | null {
  const match = runId.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/);
  if (!match) return null;
  const [, date, hh, mm, ss, ms] = match;
  const iso = `${date}T${hh}:${mm}:${ss}${ms ? `.${ms}` : ""}Z`;
  return isoFromUnknown(iso);
}

function isInsideWindow(iso: string, window: ScoreboardWindow): boolean {
  const ts = Date.parse(iso);
  return ts >= Date.parse(window.since) && ts <= Date.parse(window.until);
}

function interventionKey(record: JsonRecord): string {
  return [
    stringField(record, "at") ?? "",
    stringField(record, "kind") ?? "unknown",
    stringField(record, "stage") ?? "",
    numberField(record, "issue") ?? "",
    stringField(record, "detail") ?? "",
  ].join("|");
}

function reviewKey(record: JsonRecord): string {
  return [
    numberField(record, "round") ?? "",
    stringField(record, "sha") ?? "",
    stringField(record, "verdict") ?? "",
  ].join("|");
}

function addRecord(items: Map<string, JsonRecord>, record: JsonRecord, key: string): void {
  if (!items.has(key)) items.set(key, record);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(record: JsonRecord | null | undefined, field: string): string | null {
  const value = record?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: JsonRecord | null | undefined, field: string): number | null {
  const value = record?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoFromUnknown(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function formatScoreboardJson(report: ScoreboardReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatScoreboardHuman(report: ScoreboardReport): string {
  const lines: string[] = [];
  lines.push("# pipeline scoreboard");
  lines.push("");
  lines.push(`Report window: ${report.window.since} to ${report.window.until}`);
  lines.push(`Included runs: ${report.totals.included_runs} of ${report.totals.scanned_runs} scanned`);
  lines.push(`Successful PRs: ${report.totals.successful_prs}`);
  lines.push(`Ready runs: ${report.totals.ready_runs}`);
  lines.push("");
  lines.push(`Ready-to-deploy without human intervention: ${formatRate(report.metrics.ready_to_deploy_without_human_intervention)}`);
  lines.push(`Cost per ready PR: ${formatCostMetric(report.metrics.cost_per_ready_pr_usd)}`);
  lines.push(`Cost-source coverage: ${formatCoverage(report.metrics.cost_accounting.coverage)}`);
  lines.push("Cost/accounting by group:");
  if (report.metrics.cost_accounting.groups.length === 0) {
    lines.push("  (no stage accounting records)");
  } else {
    lines.push(
      `  total: invocations ${report.metrics.cost_accounting.totals.invocation_count}; ` +
        `actual $${report.metrics.cost_accounting.totals.actual_cost_usd.toFixed(4)}; ` +
        `estimated $${report.metrics.cost_accounting.totals.estimated_cost_usd.toFixed(4)}; ` +
        `unknown ${report.metrics.cost_accounting.totals.unknown_cost_count}; ` +
        `prompt chars ${report.metrics.cost_accounting.totals.prompt_chars_total} ` +
        `(max ${report.metrics.cost_accounting.totals.prompt_chars_max}); ` +
        `est prompt tokens ${report.metrics.cost_accounting.totals.prompt_estimated_tokens_total}; ` +
        `duration ${formatMs(report.metrics.cost_accounting.totals.total_duration_ms)}; ` +
        `commands ${report.metrics.cost_accounting.totals.command_count}; ` +
        `subprocesses ${report.metrics.cost_accounting.totals.subprocess_count}`,
    );
    for (const group of report.metrics.cost_accounting.groups) {
      lines.push(`  ${formatAccountingGroup(group)}`);
    }
  }
  lines.push(`Full-run wall-clock duration: ${formatDuration(report.metrics.full_run_duration_ms)}`);
  lines.push("Stage wall-clock duration:");
  const stageEntries = Object.entries(report.metrics.stage_duration_ms);
  if (stageEntries.length === 0) {
    lines.push("  (no provable stage durations)");
  } else {
    for (const [stage, metric] of stageEntries) {
      lines.push(`  ${stage}: ${formatDuration(metric)}`);
    }
  }
  lines.push(`Harness calls per successful PR: ${formatRatioValue(report.metrics.harness_calls_per_successful_pr)}`);
  lines.push(`Retry/fix-round count per PR: ${formatRatioValue(report.metrics.retry_fix_rounds_per_pr)}`);
  lines.push("Blocker rate by kind:");
  const blockerEntries = Object.entries(report.metrics.blocker_rate_by_kind.counts);
  if (blockerEntries.length === 0) {
    lines.push("  (no human-intervention blockers recorded)");
  } else {
    for (const [kind, count] of blockerEntries) {
      lines.push(`  ${kind}: ${count} (${formatRate(report.metrics.blocker_rate_by_kind.rates[kind])})`);
    }
  }
  lines.push(`pipeline:needs-human rate: ${formatRate(report.metrics.needs_human_rate)}`);
  lines.push(`Same-harness fallback rate: ${formatRate(report.metrics.same_harness_fallback_rate)}`);
  lines.push(`Test pass rate: ${formatGate(report.metrics.gate_pass_rates.test)}`);
  lines.push(`Eval pass rate: ${formatGate(report.metrics.gate_pass_rates.eval)}`);
  lines.push(`Shipcheck pass rate: ${formatGate(report.metrics.gate_pass_rates.shipcheck)}`);

  if (report.by && report.grouping) {
    lines.push("");
    appendGroupingSection(lines, report.by, report.grouping);
  }

  if (report.diagnostics.length > 0) {
    lines.push("");
    lines.push("Diagnostics:");
    for (const diagnostic of report.diagnostics) {
      lines.push(`  [${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.path} - ${diagnostic.message}`);
    }
  }

  if (report.bucket && report.series) {
    lines.push("");
    lines.push(`Per-period breakdown (${report.bucket}):`);
    for (const period of report.series) {
      lines.push("");
      lines.push(`## ${period.start} to ${period.end}`);
      lines.push(`Included runs: ${period.totals.included_runs}`);
      lines.push(`Successful PRs: ${period.totals.successful_prs}`);
      lines.push(`Ready runs: ${period.totals.ready_runs}`);
      lines.push(`Ready-to-deploy without human intervention: ${formatRate(period.metrics.ready_to_deploy_without_human_intervention)}`);
      lines.push(`Cost per ready PR: ${formatCostMetric(period.metrics.cost_per_ready_pr_usd)}`);
      lines.push(`Full-run wall-clock duration: ${formatDuration(period.metrics.full_run_duration_ms)}`);
      lines.push(`Harness calls per successful PR: ${formatRatioValue(period.metrics.harness_calls_per_successful_pr)}`);
      lines.push(`Retry/fix-round count per PR: ${formatRatioValue(period.metrics.retry_fix_rounds_per_pr)}`);
      lines.push(`pipeline:needs-human rate: ${formatRate(period.metrics.needs_human_rate)}`);
      lines.push(`Same-harness fallback rate: ${formatRate(period.metrics.same_harness_fallback_rate)}`);
      lines.push(`Test pass rate: ${formatGate(period.metrics.gate_pass_rates.test)}`);
      lines.push(`Eval pass rate: ${formatGate(period.metrics.gate_pass_rates.eval)}`);
      lines.push(`Shipcheck pass rate: ${formatGate(period.metrics.gate_pass_rates.shipcheck)}`);
      if (period.by && period.grouping) {
        lines.push("");
        appendGroupingSection(lines, period.by, period.grouping);
      }
    }
  }

  return lines.join("\n");
}

function formatRate(value: RateValue): string {
  if (value.ratio === null) return `n/a (${value.numerator}/${value.denominator})`;
  return `${(value.ratio * 100).toFixed(1)}% (${value.numerator}/${value.denominator})`;
}

function formatRatioValue(value: RateValue): string {
  if (value.ratio === null) return `n/a (${value.numerator}/${value.denominator})`;
  return `${value.ratio.toFixed(2)} (${value.numerator}/${value.denominator})`;
}

function formatCostMetric(value: CostMetric): string {
  const rendered = value.value === null ? "n/a" : `$${value.value.toFixed(4)}`;
  return `${rendered} (actual $${value.actual_usd.toFixed(4)}, estimated $${value.estimated_usd.toFixed(4)}, missing calls ${value.missing_call_count}, denominator ${value.denominator})`;
}

function formatCoverage(coverage: CostSourceCoverage): string {
  const ratio = coverage.actual_coverage === null ? "n/a" : `${(coverage.actual_coverage * 100).toFixed(1)}%`;
  return (
    `actual ${coverage.actual_calls}; estimated ${coverage.estimated_calls}; ` +
    `unknown ${coverage.unknown_calls}; actual coverage ${ratio}`
  );
}

function formatAccountingGroup(group: CostAccountingGroup): string {
  return (
    `#${group.issue} ${group.stage} ${group.harness} ${group.model_slot} ${group.model} ${group.outcome}: ` +
    `invocations ${group.invocation_count}; ` +
    `actual $${group.actual_cost_usd.toFixed(4)}; ` +
    `estimated $${group.estimated_cost_usd.toFixed(4)}; ` +
    `unknown ${group.unknown_cost_count}; ` +
    `prompt chars ${group.prompt_chars_total} (max ${group.prompt_chars_max}); ` +
    `est prompt tokens ${group.prompt_estimated_tokens_total}; ` +
    `duration ${formatMs(group.total_duration_ms)}; ` +
    `commands ${group.command_count}; ` +
    `subprocesses ${group.subprocess_count}`
  );
}

function appendGroupingSection(lines: string[], by: ScoreboardGroupBy, grouping: ScoreboardGrouping): void {
  lines.push(`Grouped by ${by}:`);
  if (grouping.groups.length === 0) {
    lines.push("  (no stage accounting records)");
    return;
  }
  for (const group of grouping.groups) {
    lines.push(`  ${formatGroupEntry(group)}`);
  }
}

function formatGroupEntry(group: ScoreboardGroupEntry): string {
  const coverage = group.actual_coverage === null ? "n/a" : `${(group.actual_coverage * 100).toFixed(1)}%`;
  const models = group.executor_models && group.executor_models.length > 0 ? `; executor models ${group.executor_models.join(", ")}` : "";
  return (
    `${group.key}: invocations ${group.invocation_count}; ` +
    `actual $${group.actual_cost_usd.toFixed(4)} (${group.actual_calls} calls); ` +
    `estimated $${group.estimated_cost_usd.toFixed(4)} (${group.estimated_calls} calls); ` +
    `unknown ${group.unknown_cost_count} (${group.unknown_calls} calls); ` +
    `actual coverage ${coverage}; ` +
    `prompt chars ${group.prompt_chars_total} (max ${group.prompt_chars_max}); ` +
    `est prompt tokens ${group.prompt_estimated_tokens_total}; ` +
    `duration ${formatMs(group.total_duration_ms)}; ` +
    `commands ${group.command_count}; ` +
    `subprocesses ${group.subprocess_count}` +
    models
  );
}

function formatDuration(value: DurationAggregate): string {
  if (value.count === 0 || value.avg_ms === null) return "n/a";
  return `avg ${formatMs(value.avg_ms)}; min ${formatMs(value.min_ms ?? 0)}; max ${formatMs(value.max_ms ?? 0)}; count ${value.count}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function formatGate(value: GatePassMetric): string {
  return `${formatRate(value.pass_rate)}; skipped ${value.skipped}`;
}

// ---------------------------------------------------------------------------
// Self-contained offline HTML export (#427)
// ---------------------------------------------------------------------------

/** Escapes HTML metacharacters in run-derived strings so they render as text
 *  rather than markup. Applied to every interpolation point that carries a
 *  stage/harness/model/group-key/diagnostic string sourced from run artifacts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SCOREBOARD_HTML_STYLE = `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 2rem auto; max-width: 960px; color: #1a1a1a; background: #fff; line-height: 1.4; }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.15rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: 0.25rem; }
    h3 { font-size: 1rem; margin-top: 1.25rem; }
    table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; }
    th, td { text-align: left; padding: 0.25rem 0.6rem; border-bottom: 1px solid #eee; font-size: 0.9rem; vertical-align: top; }
    th { background: #f5f5f5; white-space: nowrap; }
    ul { margin: 0.25rem 0 1rem; padding-left: 1.25rem; }
    li { font-size: 0.9rem; margin: 0.15rem 0; }
    .meta { color: #555; font-size: 0.9rem; }
    .empty { color: #777; font-style: italic; }
    .diagnostic-warning { color: #8a6d00; }
    .diagnostic-error { color: #a30000; }
`;

function htmlRow(label: string, value: string): string {
  return `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`;
}

function htmlListOrEmpty(items: string[], emptyLabel: string): string {
  if (items.length === 0) return `<p class="empty">${escapeHtml(emptyLabel)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function formatAccountingTotalsLine(totals: CostAccountingTotals): string {
  return (
    `total: invocations ${totals.invocation_count}; ` +
    `actual $${totals.actual_cost_usd.toFixed(4)}; ` +
    `estimated $${totals.estimated_cost_usd.toFixed(4)}; ` +
    `unknown ${totals.unknown_cost_count}; ` +
    `prompt chars ${totals.prompt_chars_total} (max ${totals.prompt_chars_max}); ` +
    `est prompt tokens ${totals.prompt_estimated_tokens_total}; ` +
    `duration ${formatMs(totals.total_duration_ms)}; ` +
    `commands ${totals.command_count}; ` +
    `subprocesses ${totals.subprocess_count}`
  );
}

function renderFullMetricsSection(totals: ScoreboardTotals, metrics: ScoreboardMetrics): string {
  const stageEntries = Object.entries(metrics.stage_duration_ms);
  const blockerEntries = Object.entries(metrics.blocker_rate_by_kind.counts);
  const accountingLines =
    metrics.cost_accounting.groups.length === 0
      ? []
      : [formatAccountingTotalsLine(metrics.cost_accounting.totals), ...metrics.cost_accounting.groups.map(formatAccountingGroup)];

  return `<section>
<h2>Metrics</h2>
<table>
${htmlRow("Included runs", `${totals.included_runs} of ${totals.scanned_runs} scanned`)}
${htmlRow("Successful PRs", String(totals.successful_prs))}
${htmlRow("Ready runs", String(totals.ready_runs))}
${htmlRow("Ready-to-deploy without human intervention", formatRate(metrics.ready_to_deploy_without_human_intervention))}
${htmlRow("Cost per ready PR", formatCostMetric(metrics.cost_per_ready_pr_usd))}
${htmlRow("Cost-source coverage", formatCoverage(metrics.cost_accounting.coverage))}
${htmlRow("Full-run wall-clock duration", formatDuration(metrics.full_run_duration_ms))}
${htmlRow("Harness calls per successful PR", formatRatioValue(metrics.harness_calls_per_successful_pr))}
${htmlRow("Retry/fix-round count per PR", formatRatioValue(metrics.retry_fix_rounds_per_pr))}
${htmlRow("pipeline:needs-human rate", formatRate(metrics.needs_human_rate))}
${htmlRow("Same-harness fallback rate", formatRate(metrics.same_harness_fallback_rate))}
${htmlRow("Test pass rate", formatGate(metrics.gate_pass_rates.test))}
${htmlRow("Eval pass rate", formatGate(metrics.gate_pass_rates.eval))}
${htmlRow("Shipcheck pass rate", formatGate(metrics.gate_pass_rates.shipcheck))}
</table>
<h3>Cost/accounting by group</h3>
${htmlListOrEmpty(accountingLines, "(no stage accounting records)")}
<h3>Stage wall-clock duration</h3>
${htmlListOrEmpty(
  stageEntries.map(([stage, metric]) => `${stage}: ${formatDuration(metric)}`),
  "(no provable stage durations)",
)}
<h3>Blocker rate by kind</h3>
${htmlListOrEmpty(
  blockerEntries.map(([kind, count]) => `${kind}: ${count} (${formatRate(metrics.blocker_rate_by_kind.rates[kind])})`),
  "(no human-intervention blockers recorded)",
)}
</section>`;
}

function renderPeriodMetricsSection(period: ScoreboardPeriod): string {
  const metrics = period.metrics;
  return `<section>
<h3>${escapeHtml(period.start)} to ${escapeHtml(period.end)}</h3>
<table>
${htmlRow("Included runs", String(period.totals.included_runs))}
${htmlRow("Successful PRs", String(period.totals.successful_prs))}
${htmlRow("Ready runs", String(period.totals.ready_runs))}
${htmlRow("Ready-to-deploy without human intervention", formatRate(metrics.ready_to_deploy_without_human_intervention))}
${htmlRow("Cost per ready PR", formatCostMetric(metrics.cost_per_ready_pr_usd))}
${htmlRow("Full-run wall-clock duration", formatDuration(metrics.full_run_duration_ms))}
${htmlRow("Harness calls per successful PR", formatRatioValue(metrics.harness_calls_per_successful_pr))}
${htmlRow("Retry/fix-round count per PR", formatRatioValue(metrics.retry_fix_rounds_per_pr))}
${htmlRow("pipeline:needs-human rate", formatRate(metrics.needs_human_rate))}
${htmlRow("Same-harness fallback rate", formatRate(metrics.same_harness_fallback_rate))}
${htmlRow("Test pass rate", formatGate(metrics.gate_pass_rates.test))}
${htmlRow("Eval pass rate", formatGate(metrics.gate_pass_rates.eval))}
${htmlRow("Shipcheck pass rate", formatGate(metrics.gate_pass_rates.shipcheck))}
</table>
${period.by && period.grouping ? renderGroupingSection(period.by, period.grouping) : ""}
</section>`;
}

function renderGroupingSection(by: ScoreboardGroupBy, grouping: ScoreboardGrouping): string {
  return `<h3>Grouped by ${escapeHtml(by)}</h3>
${htmlListOrEmpty(grouping.groups.map(formatGroupEntry), "(no stage accounting records)")}`;
}

function renderDiagnosticsSection(diagnostics: ScoreboardDiagnostic[]): string {
  if (diagnostics.length === 0) return "";
  const items = diagnostics
    .map(
      (d) =>
        `<li class="diagnostic-${d.severity === "error" ? "error" : "warning"}">[${escapeHtml(d.severity)}] ${escapeHtml(d.code)}: ${escapeHtml(d.path)} - ${escapeHtml(d.message)}</li>`,
    )
    .join("");
  return `<section>
<h2>Diagnostics</h2>
<ul>${items}</ul>
</section>`;
}

function renderSeriesSection(bucket: ScoreboardBucket, series: ScoreboardPeriod[]): string {
  return `<section>
<h2>Per-period breakdown (${escapeHtml(bucket)})</h2>
${series.map(renderPeriodMetricsSection).join("\n")}
</section>`;
}

/** Renders one complete, self-contained, offline HTML document for a scoreboard
 *  report (#427): no external script/stylesheet/font/image reference, no
 *  `@import`, no absolute or protocol-relative URL, no `fetch`/`XMLHttpRequest`.
 *  Pure — takes only the already-computed report, no clock/randomness/env reads. */
export function renderScoreboardHtml(report: ScoreboardReport): string {
  const sections: string[] = [
    `<section>
<h2>Window</h2>
<table>
${htmlRow("Report window", `${escapeHtml(report.window.since)} to ${escapeHtml(report.window.until)}`)}
</table>
</section>`,
    renderFullMetricsSection(report.totals, report.metrics),
  ];
  if (report.by && report.grouping) {
    sections.push(`<section>${renderGroupingSection(report.by, report.grouping)}</section>`);
  }
  sections.push(renderDiagnosticsSection(report.diagnostics));
  if (report.bucket && report.series) {
    sections.push(renderSeriesSection(report.bucket, report.series));
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agent Pipeline Scoreboard</title>
<style>${SCOREBOARD_HTML_STYLE}</style>
</head>
<body>
<h1>Agent Pipeline Scoreboard</h1>
<p class="meta">Offline export — generated locally from run-store artifacts; makes no network requests.</p>
${sections.join("\n")}
</body>
</html>
`;
}
