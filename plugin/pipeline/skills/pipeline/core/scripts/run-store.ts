// Run-store (#155): stable run directory, append-only event log, and run artifacts.
//
// Layout: <repoDir>/.agent-pipeline/runs/<run-id>/
//   run.json      – immutable identity metadata (written once at initRunDir)
//   events.jsonl  – append-only O_APPEND event log (one JSON object per line)
//   terminal.log  – raw combined stdout/stderr (tee started after initRunDir)
//   summary.json  – finalized evidence bundle (written at finalizeRun)
//
// All writes are non-fatal: I/O errors are caught and logged. Readers tolerate
// missing files, corrupt tail lines, and unknown fields (forward-compat).

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ISSUE_HISTORY_SCHEMA_VERSION,
  type EvidenceBundle,
  type IssueHistoryEntry,
  type ReviewFindingRecord,
  type StageAccountingRecord,
} from "./types.ts";
import { redactSecrets, sanitize, sanitizeDeep } from "./artifact-sanitize.ts";
import { stageDurationMs } from "./evidence-bundle.ts";
import type { GhMetricsSummary } from "./gh.ts";
import type { HumanInterventionEvent } from "./intervention.ts";
import { accountingSummary, sanitizeStageAccountingRecord } from "./accounting.ts";
import { RUNS_ARTIFACT, HISTORY_ARTIFACT, artifactSubdir } from "./artifact-ignore.ts";

export const RUN_SCHEMA_VERSION = 1;

export type RunId = string;

/** Produce the run-id from issue number and dispatch start time.
 *  Format: `<issue>-<YYYY-MM-DDTHH-MM-SS-mmmZ>` (filesystem-safe; colons and the
 *  decimal point replaced with hyphens). Milliseconds are preserved so that two
 *  dispatches starting in the same second produce distinct directories. */
export function runIdFor(issue: number, startedAt: Date): RunId {
  const iso = startedAt.toISOString().replace(/:/g, "-").replace(/\.(\d+)Z$/, "-$1Z");
  return `${issue}-${iso}`;
}

/** Root directory that holds all run subdirectories for a repo. */
export function runsDir(repoDir: string): string {
  return artifactSubdir(repoDir, RUNS_ARTIFACT);
}

/** Absolute path of a single run's directory. */
export function runDirPath(repoDir: string, runId: RunId): string {
  return path.join(runsDir(repoDir), runId);
}

/** Root directory for the issue-level evidence-history artifacts (#377), a
 *  sibling of `runs/` under `.agent-pipeline/` — durable, reboot-safe storage,
 *  unlike the legacy `/tmp/pipeline-<repo>` state dir. */
export function issueHistoryDir(repoDir: string): string {
  return artifactSubdir(repoDir, HISTORY_ARTIFACT);
}

/** Absolute path of the append-only per-issue evidence-history JSONL. */
export function issueHistoryPath(repoDir: string, issue: number): string {
  return path.join(issueHistoryDir(repoDir), `issue-${issue}.jsonl`);
}

/** Recover `repoDir` from a run directory. Inverse of
 *  `runDirPath(repoDir, runId) === path.join(repoDir, ".agent-pipeline", "runs", runId)`:
 *  strip the run-id, then "runs", then ".agent-pipeline". */
function repoDirFromRunDir(runDir: string): string {
  return path.dirname(path.dirname(path.dirname(runDir)));
}

// ---------------------------------------------------------------------------
// Event types — all carry schema_version, type, at
// ---------------------------------------------------------------------------

interface RunEventBase {
  schema_version: number;
  type: string;
  at: string;
}

export interface RunStartEvent extends RunEventBase {
  type: "run_start";
  run_id: RunId;
  issue: number;
  repo: string;
}
export interface RunCompleteEvent extends RunEventBase {
  type: "run_complete";
  final_state: string;
  elapsed_ms: number;
}
export interface StageStartEvent extends RunEventBase {
  type: "stage_start";
  stage: string;
}
export interface StageCompleteEvent extends RunEventBase {
  type: "stage_complete";
  stage: string;
  outcome: string;
  commits?: string[];
}
export interface PrCreatedEvent extends RunEventBase {
  type: "pr_created";
  pr: number;
}
export interface PrUpdatedEvent extends RunEventBase {
  type: "pr_updated";
  pr: number;
}
export interface WorktreeCreatedEvent extends RunEventBase {
  type: "worktree_created";
  _localPath: string;
}
export interface WorktreeRemovedEvent extends RunEventBase {
  type: "worktree_removed";
  _localPath: string;
}
export interface ReviewVerdictEvent extends RunEventBase {
  type: "review_verdict";
  round: number;
  sha: string;
  verdict: string;
  finding_counts: Record<string, number>;
  /** Per-finding records (#209). Additive optional — absent on pre-#209 events. */
  findings?: ReviewFindingRecord[];
  /** Harness that actually reviewed this round (#209, #39 fallback). */
  reviewer_harness?: string;
  reviewer_model?: string;
  self_review?: boolean;
}
export interface GateResultEvent extends RunEventBase {
  type: "gate_result";
  gate: string;
  result: "pass" | "fail" | "partial" | "skipped";
  mode?: string;
  reason?: string;
}
export interface BlockerSetEvent extends RunEventBase {
  type: "blocker_set";
  reason: string;
}
export interface BlockerClearedEvent extends RunEventBase {
  type: "blocker_cleared";
}
export interface GhMetricsSummaryEvent extends RunEventBase {
  type: "gh_metrics_summary";
  call_count: number;
  total_ms: number;
  p50_ms: number;
  p95_ms: number;
  slowest_calls: { category: string; elapsed_ms: number }[];
}
export interface StageAccountingEvent extends RunEventBase, StageAccountingRecord {
  type: "stage_accounting";
}
/** Recorded at the instant a `runCapped` wall-clock cap fires (#398) — before,
 *  and independent of, the harness invocation's promise resolving — so a
 *  supervisor tailing events.jsonl can detect a wedged harness without process
 *  introspection. Additive: does not change `schema_version` or the meaning of
 *  `stage_start`/`stage_complete` stage-timeline filters, which exclude it. */
export interface HarnessTimeoutEvent extends RunEventBase {
  type: "harness_timeout";
  stage: string;
  timeout_sec: number;
}
/** A fix-round harness invocation failed (crash or timeout) and is being
 *  retried in place, worktree preserved (#486). `attempt` is the about-to-run
 *  attempt's 1-indexed number (>= 2); `limit` is `auto_recovery_max_retries`;
 *  `reason` is the failure that triggered this retry. */
export interface FixHarnessRetryEvent extends RunEventBase {
  type: "fix_harness_retry";
  stage: string;
  attempt: number;
  limit: number;
  reason: string;
}
/** Advisory warning (#445): a harness commit step left a gitignored file
 *  uncommitted that is referenced by name in the committed diff. Never blocks
 *  and never changes stage advance/blocking semantics — purely informational
 *  so the exclusion is diagnosed at the stage that caused it instead of at a
 *  downstream CI failure. */
export interface IgnoredArtifactWarningEvent extends RunEventBase {
  type: "ignored_artifact_warning";
  stage: string;
  files: Array<{ path: string; source: string | null; line: number | null; pattern: string | null }>;
}

/** A blocking finding was demoted to advisory because it re-raised, without an
 *  explicit `prior_round_acknowledgment`, a SPECIFIC finding a prior round
 *  already settled (#389, finding-level matching #464). Never blocks and
 *  never changes the finding's visibility — the finding is still recorded and
 *  posted, tagged `REVERSAL-UNACKNOWLEDGED`; this event is purely an audit
 *  record of the demotion. `settled_finding_key`/`settling_round`/`matched_by`
 *  identify which prior finding was matched and how (#464). */
export interface ReversalUnacknowledgedEvent extends RunEventBase {
  type: "reversal_unacknowledged";
  finding_key: string;
  surface: string;
  settled_finding_key: string;
  settling_round: number;
  matched_by: "key" | "title-similarity";
}

/** Agent-self-reported minor friction (#419), non-blocking. Flows through the
 *  same `appendEvent` path as every other run event, so it inherits redaction
 *  and external-sink delivery unchanged. See `emitPapercut`. */
export interface PapercutEvent extends RunEventBase {
  type: "papercut";
  run_id: RunId;
  issue: number;
  stage: string | null;
  harness: string | null;
  model: string | null;
  message: string;
}

/** Mid-run engine drift (#450): the on-disk engine version and/or template
 *  fingerprint no longer match the identity this run was pinned to at start —
 *  most likely an `install.mjs update` landed while this process was still
 *  running. Advisory only: the run continues against its pinned snapshot;
 *  this event exists so the discrepancy is attributable after the fact. */
export interface EngineDriftEvent extends RunEventBase {
  type: "engine_drift";
  stage: string;
  pinned: RunEngineIdentity;
  observed: RunEngineIdentity;
}

export type { HumanInterventionEvent };

export type RunEvent =
  | RunStartEvent
  | RunCompleteEvent
  | StageStartEvent
  | StageCompleteEvent
  | PrCreatedEvent
  | PrUpdatedEvent
  | WorktreeCreatedEvent
  | WorktreeRemovedEvent
  | ReviewVerdictEvent
  | GateResultEvent
  | BlockerSetEvent
  | BlockerClearedEvent
  | GhMetricsSummaryEvent
  | StageAccountingEvent
  | HarnessTimeoutEvent
  | FixHarnessRetryEvent
  | IgnoredArtifactWarningEvent
  | PapercutEvent
  | ReversalUnacknowledgedEvent
  | EngineDriftEvent
  | HumanInterventionEvent;

// ---------------------------------------------------------------------------
// Deps — injectable I/O seam; unit tests inject in-memory fakes
// ---------------------------------------------------------------------------

export interface RunStoreDeps {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  /** Append to file using O_APPEND semantics (create if absent). */
  appendFile: (p: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (p: string, opts: { recursive: boolean }) => Promise<void>;
  readdir: (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  stat: (p: string) => Promise<{ mtime: Date }>;
  /** When set, each appended event line is also passed here (--json-events mode). */
  stdoutWrite?: (line: string) => void;
  /** Optional external event sink (#343). When set, each appended event line is
   *  also delivered here (in addition to, or instead of, the local events.jsonl
   *  write — see `eventSinkMode`). Delivery is best-effort: appendEvent catches
   *  any throw/rejection and logs a non-fatal warning, never propagating it. */
  eventSink?: (line: string) => void | Promise<void>;
  /** Selects whether the local events.jsonl write happens alongside eventSink
   *  delivery ("additive", default) or is skipped entirely ("exclusive").
   *  Ignored when eventSink is unset. */
  eventSinkMode?: "additive" | "exclusive";
  /** Optional in-memory accumulator (#343): when set, every event appended via
   *  appendEvent is also pushed here, regardless of eventSinkMode. finalizeRun
   *  reads from this (when present) instead of re-reading events.jsonl, so
   *  stage_accounting/human_intervention data still reaches summary.json in
   *  exclusive mode, where events.jsonl is never written. */
  summaryEvents?: RunEvent[];
}

export const defaultRunStoreDeps: RunStoreDeps = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
  appendFile: (p, data) => fsp.appendFile(p, data, "utf8"),
  rename: (from, to) => fsp.rename(from, to),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
  readdir: async (p) => {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return entries as Array<{ name: string; isDirectory(): boolean }>;
  },
  stat: (p) => fsp.stat(p),
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// ---------------------------------------------------------------------------
// initRunDir
// ---------------------------------------------------------------------------

/** Identity of the engine snapshot a run is pinned to (#450): the engine
 *  version, its resolved root path, and a fingerprint of the pinned prompt-
 *  template set. Captured once at run start; omitted when resolution fails. */
export interface RunEngineIdentity {
  version: string;
  root: string;
  templates_fingerprint: string;
}

export interface RunMeta {
  schema_version: number;
  run_id: RunId;
  issue: number;
  repo: string;
  profile: string | null;
  started_at: string;
  /** Omitted when the engine identity cannot be resolved at run-directory
   *  creation (e.g. missing/malformed package.json) — the run still starts. */
  engine?: RunEngineIdentity;
}

export interface InitRunDirOpts {
  runDir: string;
  runId: RunId;
  issue: number;
  repo: string;
  profile: string | null;
  startedAt: string;
  engine?: RunEngineIdentity;
}

/** Create the run directory, write run.json, append run_start to events.jsonl.
 *  Idempotent: if run.json already exists (same run-id re-entered), returns
 *  immediately without touching run.json or events.jsonl.
 *  Non-fatal: I/O errors are caught and logged. */
export async function initRunDir(
  opts: InitRunDirOpts,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  try {
    await deps.mkdir(opts.runDir, { recursive: true });

    // Idempotency guard: if run.json already exists this directory was already
    // initialized. Do not overwrite run.json (written-once contract) and do not
    // truncate events.jsonl (append-only contract).
    try {
      await deps.stat(path.join(opts.runDir, "run.json"));
      return; // already initialized — leave all files untouched
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // ENOENT → first initialization, continue below
    }

    const meta: RunMeta = {
      schema_version: RUN_SCHEMA_VERSION,
      run_id: opts.runId,
      issue: opts.issue,
      repo: opts.repo,
      profile: opts.profile,
      started_at: opts.startedAt,
      ...(opts.engine ? { engine: opts.engine } : {}),
    };
    await deps.writeFile(
      path.join(opts.runDir, "run.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
    );

    // Create terminal.log up front (empty, append-mode so an existing file is not
    // truncated) so a `pipeline logs <id> --follow` started in the window between
    // run_start and the terminal tee attaching does not fail on a missing file (#155).
    await deps.appendFile(path.join(opts.runDir, "terminal.log"), "");

    // Append the run_start event (appendFile creates events.jsonl on first use)
    const event: RunStartEvent = {
      schema_version: RUN_SCHEMA_VERSION,
      type: "run_start",
      at: opts.startedAt,
      run_id: opts.runId,
      issue: opts.issue,
      repo: opts.repo,
    };
    await appendEvent(opts.runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: initRunDir failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

/** Resolve the engine identity a dispatch should pin, respecting `initRunDir`'s
 *  written-once contract (#450): when `runDir/run.json` already exists (a
 *  resumed dispatch re-entering the same run-id), reuse the identity already
 *  recorded there rather than re-resolving the current on-disk identity —
 *  `initRunDir` will not overwrite an existing run.json, so a freshly-resolved
 *  identity would silently diverge from what was actually written and suppress
 *  drift detection against the original pin. `resolveFresh` is only invoked
 *  when no run.json exists yet (first init for this run-id). */
export async function resolveRunEngineIdentity(
  runDir: string,
  resolveFresh: () => RunEngineIdentity | undefined,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<RunEngineIdentity | undefined> {
  try {
    const raw = await deps.readFile(path.join(runDir, "run.json"));
    const meta = JSON.parse(raw) as { engine?: RunEngineIdentity };
    return meta.engine;
  } catch {
    return resolveFresh();
  }
}

// ---------------------------------------------------------------------------
// appendEvent
// ---------------------------------------------------------------------------

/** Append a JSON event line to events.jsonl. Non-fatal on I/O error.
 *  If deps.stdoutWrite is set, also passes the line there (--json-events mode).
 *  If deps.eventSink is set (#343), also delivers the line to it: in "additive"
 *  mode (default) alongside the local write, in "exclusive" mode the local
 *  write is skipped entirely. Sink delivery failure is caught and logged as a
 *  non-fatal warning; it never affects the local write or throws out of here. */
export async function appendEvent(
  runDir: string,
  event: RunEvent,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  const hasSink = deps.eventSink !== undefined;
  const skipLocalWrite = hasSink && deps.eventSinkMode === "exclusive";

  if (deps.summaryEvents) {
    deps.summaryEvents.push(event);
  }

  if (!skipLocalWrite) {
    try {
      await deps.appendFile(path.join(runDir, "events.jsonl"), line);
    } catch (err) {
      console.warn(
        `[pipeline] run-store: appendEvent failed (non-fatal): ${(err as Error).message}`,
      );
      if (!hasSink) return;
    }
  }

  if (deps.stdoutWrite) {
    deps.stdoutWrite(line);
  }

  if (hasSink) {
    try {
      await deps.eventSink!(line);
    } catch (err) {
      console.warn(
        `[pipeline] run-store: eventSink delivery failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// readEvents
// ---------------------------------------------------------------------------

/** Read events.jsonl: missing file → []; corrupt or partial tail line → skipped;
 *  unknown fields → preserved unchanged (forward-compat). */
export async function readEvents(
  runDir: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<RunEvent[]> {
  let raw: string;
  try {
    raw = await deps.readFile(path.join(runDir, "events.jsonl"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const results: RunEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as RunEvent);
    } catch {
      // Partial or corrupt line (e.g. from a mid-write crash) — skip silently
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// emitGhMetrics
// ---------------------------------------------------------------------------

/** Append a gh_metrics_summary event to events.jsonl. Non-fatal on I/O error. */
export async function emitGhMetrics(
  runDir: string,
  summary: GhMetricsSummary,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  const event: GhMetricsSummaryEvent = {
    schema_version: RUN_SCHEMA_VERSION,
    type: "gh_metrics_summary",
    at: nowIso(),
    call_count: summary.call_count,
    total_ms: summary.total_ms,
    p50_ms: summary.p50_ms,
    p95_ms: summary.p95_ms,
    slowest_calls: summary.slowest_calls,
  };
  try {
    await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: emitGhMetrics failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// emitStageAccounting
// ---------------------------------------------------------------------------

/** Append a sanitized stage_accounting event to events.jsonl. Non-fatal on I/O
 *  error and streams via appendEvent's existing --json-events path. */
export async function emitStageAccounting(
  runDir: string,
  record: StageAccountingRecord,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  const event: StageAccountingEvent = {
    ...sanitizeStageAccountingRecord(record),
    type: "stage_accounting",
    at: nowIso(),
  };
  try {
    await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: emitStageAccounting failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// emitPapercut (#419)
// ---------------------------------------------------------------------------

/** Append a `papercut` event to events.jsonl via the standard `appendEvent`
 *  path (so it gets redaction + external event-sink delivery for free, on
 *  identical terms to `blocker_set`/`human_intervention`). Total function:
 *  never throws — any failure (including a thrown/rejecting `appendEvent`) is
 *  caught and logged as a non-fatal warning, mirroring `emitHumanIntervention`. */
export async function emitPapercut(
  runDir: string,
  payload: {
    run_id: RunId;
    issue: number;
    stage: string | null;
    harness: string | null;
    model: string | null;
    message: string;
  },
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  try {
    const event: PapercutEvent = {
      schema_version: RUN_SCHEMA_VERSION,
      type: "papercut",
      at: nowIso(),
      run_id: payload.run_id,
      issue: payload.issue,
      stage: payload.stage,
      harness: payload.harness,
      model: payload.model,
      message: sanitize(redactSecrets(payload.message)),
    };
    await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: emitPapercut failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// appendIssueHistory (#377)
// ---------------------------------------------------------------------------

/** Append one compact per-run entry to the issue-level evidence history JSONL
 *  at `.agent-pipeline/history/issue-<N>.jsonl` (create-on-first-write). Entries
 *  are serialized through the same `sanitizeDeep` + `redactSecrets` + `sanitize`
 *  chain used for `summary.json`, so no secret reaches the artifact. Non-fatal:
 *  an append error is caught, logged, and never propagates — resumed pipelines
 *  must not fail because a history write failed. */
export async function appendIssueHistory(
  repoDir: string,
  issue: number,
  entry: IssueHistoryEntry,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  try {
    const cleanedEntry = sanitizeDeep(entry);
    const line = sanitize(redactSecrets(`${JSON.stringify(cleanedEntry)}\n`));
    await deps.mkdir(issueHistoryDir(repoDir), { recursive: true });
    await deps.appendFile(issueHistoryPath(repoDir, issue), line);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: issue history append failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// finalizeRun
// ---------------------------------------------------------------------------

/** Finalize the run: append gh_metrics_summary + run_complete, write summary.json, write legacy evidence.json.
 *  summary.json and legacy write are atomic (tmp + rename). Legacy write failure is non-fatal. */
export async function finalizeRun(
  runDir: string,
  bundle: EvidenceBundle,
  stateDir: string,
  issue: number,
  startedAt: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
  ghMetrics?: GhMetricsSummary,
): Promise<void> {
  const now = nowIso();
  const startMs = Date.parse(startedAt);
  const elapsedMs = Number.isFinite(startMs) ? Date.parse(now) - startMs : 0;

  // Append gh_metrics_summary before run_complete (#257)
  if (ghMetrics) {
    await emitGhMetrics(runDir, ghMetrics, deps);
  }

  // Append run_complete before writing summary.json
  const completeEvent: RunCompleteEvent = {
    schema_version: RUN_SCHEMA_VERSION,
    type: "run_complete",
    at: now,
    final_state: bundle.finalState ?? "unknown",
    elapsed_ms: elapsedMs,
  };
  await appendEvent(runDir, completeEvent, deps);

  // Collect event-derived records to embed in summary.json. When the caller
  // supplies deps.summaryEvents (#343), use that in-memory accumulator so
  // exclusive sink mode — which never writes events.jsonl — still enriches
  // summary.json; otherwise fall back to re-reading events.jsonl. Non-fatal:
  // if the read fails, arrays stay empty.
  let interventions: HumanInterventionEvent[] = [];
  let accountingRecords: StageAccountingRecord[] = [];
  if (deps.summaryEvents) {
    interventions = deps.summaryEvents.filter(
      (e): e is HumanInterventionEvent => e.type === "human_intervention",
    );
    accountingRecords = deps.summaryEvents
      .filter((e): e is StageAccountingEvent => e.type === "stage_accounting")
      .map((e) => sanitizeStageAccountingRecord(e));
  } else {
    try {
      const eventsForSummary = await readEvents(runDir, deps);
      interventions = eventsForSummary.filter(
        (e): e is HumanInterventionEvent => e.type === "human_intervention",
      );
      accountingRecords = eventsForSummary
        .filter((e): e is StageAccountingEvent => e.type === "stage_accounting")
        .map((e) => sanitizeStageAccountingRecord(e));
    } catch {
      // Non-fatal: missing or unreadable events.jsonl → empty arrays
    }
  }

  // Serialize bundle — same sanitization as evidence-bundle.ts writeBundle.
  // run_id is the filesystem-safe directory name so consumers can join summary.json
  // to the run directory by a single stable identifier (the bundle's runId field
  // uses the commit-trailer format 155/..., which differs from the dir name 155-...).
  const fileRunId = path.basename(runDir);
  // Mutate the caller's bundle (not just the summary.json copy) so the harness
  // invocation durations reach `notifyBundlePath`, called right after
  // `finalizeRun` resolves with this same object reference, without a second
  // events.jsonl read (#377).
  bundle.accounting = accountingSummary(accountingRecords);
  const summaryWithVersion = {
    ...bundle,
    schema_version: RUN_SCHEMA_VERSION,
    run_id: fileRunId,
    interventions,
  };
  const cleanedBundle = sanitizeDeep(summaryWithVersion);
  const serialized = sanitize(redactSecrets(`${JSON.stringify(cleanedBundle, null, 2)}\n`));

  // Write summary.json atomically
  const summaryPath = path.join(runDir, "summary.json");
  try {
    const tmp = `${summaryPath}.tmp`;
    await deps.writeFile(tmp, serialized);
    await deps.rename(tmp, summaryPath);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: summary.json write failed (non-fatal): ${(err as Error).message}`,
    );
  }

  // Write legacy evidence.json (non-fatal; keeps existing consumers working)
  const legacyDir = path.join(stateDir, String(issue));
  const legacyPath = path.join(legacyDir, "evidence.json");
  try {
    await deps.mkdir(legacyDir, { recursive: true });
    const tmp = `${legacyPath}.tmp`;
    await deps.writeFile(tmp, serialized);
    await deps.rename(tmp, legacyPath);
  } catch (err) {
    console.warn(
      `[pipeline] run-store: legacy evidence.json write failed (non-fatal): ${(err as Error).message}`,
    );
  }

  // Append-only issue-level evidence history (#377): one compact per-run entry,
  // appended (never rewritten) after summary.json/evidence.json, so a re-run
  // never erases prior rounds' timing history. appendIssueHistory is itself
  // non-fatal on I/O error.
  const historyEntry: IssueHistoryEntry = {
    schema_version: ISSUE_HISTORY_SCHEMA_VERSION,
    run_id: fileRunId,
    issue,
    pr: bundle.pr,
    branch: bundle.branch,
    final_state: bundle.finalState,
    finalized_at: bundle.finalizedAt,
    stages: bundle.stages.map((s) => ({
      stage: s.stage,
      enteredAt: s.enteredAt,
      exitedAt: s.exitedAt,
      durationMs: stageDurationMs(s.enteredAt, s.exitedAt),
      outcome: s.outcome,
    })),
  };
  await appendIssueHistory(repoDirFromRunDir(runDir), issue, historyEntry, deps);
}

// ---------------------------------------------------------------------------
// listRunIds — for `pipeline logs` (no-arg form)
// ---------------------------------------------------------------------------

/** List run-ids available in .agent-pipeline/runs/, sorted by mtime descending.
 *  Returns [] when the directory is absent or empty. */
export async function listRunIds(
  repoDir: string,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<string[]> {
  const dir = runsDir(repoDir);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await deps.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const dirs = entries.filter((e) => e.isDirectory());
  const withMtime = await Promise.all(
    dirs.map(async (e) => {
      try {
        const st = await deps.stat(path.join(dir, e.name));
        return { name: e.name, mtime: st.mtime.getTime() };
      } catch {
        return { name: e.name, mtime: 0 };
      }
    }),
  );

  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.map((e) => e.name);
}

// ---------------------------------------------------------------------------
// latestSummaryForIssue — for `pipeline N --summary` run-directory-first read
// ---------------------------------------------------------------------------

/** Minimal runtime check for the EvidenceBundle shape required by formatSummary.
 *  Returns false if the value is not an object, any required array field is absent,
 *  or any nested stage/review entry is missing the fields that formatSummary accesses
 *  directly (stage.stage, stage.commands, review.sha, review.verdict, review.round,
 *  review.findingCounts).  Used to treat missing-required-fields summaries as absent
 *  for fallback purposes (spec §261). */
export function isValidSummaryBundle(parsed: unknown): parsed is EvidenceBundle {
  if (!parsed || typeof parsed !== "object") return false;
  const b = parsed as Record<string, unknown>;
  if (
    !Array.isArray(b.harnesses) ||
    !Array.isArray(b.stages) ||
    !Array.isArray(b.reviews) ||
    !Array.isArray(b.overrides) ||
    !Array.isArray(b.recoveries)
  ) return false;
  for (const s of b.stages as unknown[]) {
    if (!s || typeof s !== "object") return false;
    const sr = s as Record<string, unknown>;
    if (typeof sr.stage !== "string" || !Array.isArray(sr.commands)) return false;
    // formatSummary dereferences each command's cmd/exitCode/durationMs; a malformed
    // element (e.g. null, or missing fields) would crash the formatter, so a bundle with
    // any such command must be treated as absent for fallback (not a valid bundle).
    for (const c of sr.commands as unknown[]) {
      if (!c || typeof c !== "object") return false;
      const cr = c as Record<string, unknown>;
      if (typeof cr.cmd !== "string" || typeof cr.exitCode !== "number" || typeof cr.durationMs !== "number") return false;
    }
  }
  for (const r of b.reviews as unknown[]) {
    if (!r || typeof r !== "object") return false;
    const rr = r as Record<string, unknown>;
    if (
      typeof rr.sha !== "string" ||
      typeof rr.verdict !== "string" ||
      typeof rr.round !== "number" ||
      !rr.findingCounts ||
      typeof rr.findingCounts !== "object"
    ) return false;
  }
  // formatSummary also dereferences each override (o.key / o.reason) and recovery
  // (rec.trigger / rec.round / rec.at); validate those element shapes too.
  for (const o of b.overrides as unknown[]) {
    if (!o || typeof o !== "object") return false;
    const or = o as Record<string, unknown>;
    if (typeof or.key !== "string" || typeof or.reason !== "string") return false;
  }
  for (const rec of b.recoveries as unknown[]) {
    if (!rec || typeof rec !== "object") return false;
    const rr = rec as Record<string, unknown>;
    if (typeof rr.trigger !== "string" || typeof rr.round !== "number" || typeof rr.at !== "string") return false;
  }
  return true;
}

/** Return the EvidenceBundle from the most-recent `summary.json` for the given
 *  issue number, or `null` when none is found.
 *
 *  Scans all run directories whose run-id begins with `<issueNumber>-` (already
 *  sorted by mtime descending by `listRunIds`), reads `summary.json` from the
 *  first readable match, and parses it.  A missing file, unreadable file,
 *  corrupt JSON, or a file missing required fields is treated as absent and the
 *  next candidate is tried (so a single bad entry does not shadow a valid older run). */
export async function latestSummaryForIssue(
  repoDir: string,
  issueNumber: number,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<EvidenceBundle | null> {
  const allIds = await listRunIds(repoDir, deps);
  const prefix = `${issueNumber}-`;
  for (const id of allIds.filter((rid) => rid.startsWith(prefix))) {
    const summaryPath = path.join(runDirPath(repoDir, id), "summary.json");
    try {
      const raw = await deps.readFile(summaryPath);
      const parsed = JSON.parse(raw);
      if (isValidSummaryBundle(parsed)) return parsed;
    } catch {
      // Absent or corrupt — try next matching run
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// latestRunEventsSummaryForIssue — for the `possibly_wedged` status flag (#398)
// ---------------------------------------------------------------------------

export interface RunEventsSummary {
  /** True when events.jsonl contains a `run_complete` event. */
  finalized: boolean;
  /** The newest event's type/timestamp, or null when events.jsonl is empty. */
  lastEvent: { type: string; at: string } | null;
}

/** Return a finalized/last-event summary of the most-recent run's events.jsonl
 *  for the given issue, or null when no run directory exists for it. Unlike
 *  `latestSummaryForIssue`, this reads events.jsonl directly rather than
 *  summary.json, so a run that has not reached `finalizeRun` yet (including a
 *  wedged one) can still be inspected. Non-fatal: an unreadable events.jsonl is
 *  treated as absent. */
export async function latestRunEventsSummaryForIssue(
  repoDir: string,
  issueNumber: number,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<RunEventsSummary | null> {
  const allIds = await listRunIds(repoDir, deps);
  const prefix = `${issueNumber}-`;
  const matchId = allIds.find((rid) => rid.startsWith(prefix));
  if (!matchId) return null;
  try {
    const events = await readEvents(runDirPath(repoDir, matchId), deps);
    if (events.length === 0) return { finalized: false, lastEvent: null };
    const finalized = events.some((e) => e.type === "run_complete");
    const last = events[events.length - 1];
    return { finalized, lastEvent: { type: last.type, at: last.at } };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Terminal log tee — patches process.stdout/stderr to mirror output to a file.
// Separate from the injectable deps pattern: this operates on global process state.
// ---------------------------------------------------------------------------

export interface TerminalLogTee {
  /** Write directly to the original stdout, bypassing terminal.log.
   *  Used by --json-events mode so JSON event lines are not captured in terminal.log. */
  rawWrite: (chunk: string) => void;
  /** Restore the original write functions and close the log stream. */
  stop(): Promise<void>;
}

/** Start a tee that mirrors process.stdout and process.stderr to terminal.log at logPath.
 *  Returns a handle with rawWrite (for --json-events bypass) and stop().
 *  The logPath directory must exist before calling this function. */
export function startTerminalLogTee(logPath: string): TerminalLogTee {
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  // Save originals before patching
  const origStdoutWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
  const origStderrWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;

  // teeActive gates every write to logStream. The error handler flips it to false
  // and restores the original writes so a log-stream failure is non-fatal and does
  // not crash the pipeline via an unhandled 'error' event on the WriteStream.
  let teeActive = true;

  logStream.on("error", (err) => {
    if (!teeActive) return;
    teeActive = false;
    console.warn(`[pipeline] run-store: terminal.log stream error (non-fatal): ${err.message}`);
    (process.stdout as { write: typeof origStdoutWrite }).write = origStdoutWrite;
    (process.stderr as { write: typeof origStderrWrite }).write = origStderrWrite;
  });

  function makePatch(
    orig: typeof origStdoutWrite,
  ): typeof origStdoutWrite {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (...args: any[]): boolean {
      const [chunk, enc] = args;
      if (teeActive) {
        if (typeof chunk === "string") {
          logStream.write(chunk, typeof enc === "string" ? (enc as BufferEncoding) : "utf8");
        } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
          logStream.write(chunk as Buffer);
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return (orig as (...a: any[]) => boolean)(...args);
    } as typeof origStdoutWrite;
  }

  (process.stdout as { write: typeof origStdoutWrite }).write = makePatch(origStdoutWrite);
  (process.stderr as { write: typeof origStderrWrite }).write = makePatch(origStderrWrite);

  return {
    rawWrite(chunk: string): void {
      origStdoutWrite(chunk);
    },
    stop(): Promise<void> {
      teeActive = false;
      (process.stdout as { write: typeof origStdoutWrite }).write = origStdoutWrite;
      (process.stderr as { write: typeof origStderrWrite }).write = origStderrWrite;
      return new Promise<void>((resolve) => {
        logStream.end(() => resolve());
      });
    },
  };
}
