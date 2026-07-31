// Host-local "is an advance already live for this issue?" probe and pure
// classifiers for loop/operator coexistence (#770).
//
// Unit tests inject the probe; production wires lock-file PID liveness,
// non-terminal run-store detection, and terminal-aware loop linkage.

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { RUNS_ARTIFACT, artifactSubdir } from "../artifact-ignore.ts";

export type LiveAdvanceEvidenceClass =
  | "lock_held"
  | "active_run_store"
  | "wrapper_pid"
  | "loop_linkage";

export type LiveAdvanceProbeResult =
  | { live: false }
  | {
      live: true;
      evidence: LiveAdvanceEvidenceClass;
      pipeline_run_id?: string;
      holder_pid?: number;
      events_path?: string;
    };

/** Match detach handshake / install race / already-running strings. Pure. */
export function isCoexistenceFailureEvidence(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    /already running/i.test(text) ||
    /is already running/i.test(text) ||
    /lock held by another process/i.test(text) ||
    /Pipeline lock held/i.test(text) ||
    /\.lock-failed/i.test(text) ||
    /install\/update is in progress/i.test(text) ||
    /an install\/update is in progress/i.test(text)
  );
}

/**
 * Non-fatal coexistence mid-exit helper. Coexistence classification is limited
 * to lock / already-running / install structured evidence and known message
 * patterns (#770 review 1 finding 929fc0ac) — generic mid-stage `skipped` /
 * `waiting` events alone MUST NOT reclassify a genuine engine crash.
 */
export function isNonFatalMidStageExit(
  eventsText: string | null | undefined,
  labels: readonly string[],
): boolean {
  if (!labels.some((l) => l.startsWith("pipeline:") && l !== "pipeline:ready-to-deploy")) {
    return false;
  }
  if (labels.includes("blocked") || labels.includes("pipeline:ready-to-deploy")) return false;
  return isCoexistenceFailureEvidence(eventsText);
}

/** Pure: events.jsonl body contains a terminal `run_complete` event. */
export function eventsTextIsTerminal(eventsText: string | null | undefined): boolean {
  if (!eventsText) return false;
  for (const line of eventsText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as { type?: string };
      if (ev.type === "run_complete") return true;
    } catch {
      /* skip malformed */
    }
  }
  return false;
}

/** Best-effort host-local text read; null when absent/unreadable. */
export function tryReadTextFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Read a lock file path; live when PID is parseable and `process.kill(pid, 0)` succeeds. */
export function isLockFileLive(lockPath: string): { live: boolean; pid?: number } {
  try {
    if (!fs.existsSync(lockPath)) return { live: false };
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    const pid = Number(raw.split(/\s+/)[0]);
    if (!Number.isFinite(pid) || pid <= 0) return { live: false };
    try {
      process.kill(pid, 0);
      return { live: true, pid };
    } catch {
      return { live: false };
    }
  } catch {
    return { live: false };
  }
}

export function issueLockPath(domain: string, issueNumber: number): string {
  return path.join("/tmp", `pipeline-${domain}-${issueNumber}.lock`);
}

export function advanceRunEventsPath(repoDir: string, pipelineRunId: string): string {
  return path.join(artifactSubdir(repoDir, RUNS_ARTIFACT), pipelineRunId, "events.jsonl");
}

/**
 * Resolve whether a linked advance is terminal.
 * - `true`  — proven terminal (`run_complete` or summary.json present)
 * - `false` — proven non-terminal (events exist without `run_complete`)
 * - `null`  — unresolvable (no path / missing store)
 */
export function resolveLinkageTerminalState(
  linkage: { pipeline_run_id: string; events?: string },
  opts?: { repoDir?: string; readText?: (p: string) => string | null },
): boolean | null {
  const read = opts?.readText ?? tryReadTextFile;
  const eventsPath =
    linkage.events ??
    (opts?.repoDir ? advanceRunEventsPath(opts.repoDir, linkage.pipeline_run_id) : null);
  if (!eventsPath) return null;
  const text = read(eventsPath);
  if (text !== null) return eventsTextIsTerminal(text);
  // summary.json is also terminal proof when events were cleaned or exclusive-sink
  const summaryPath = path.join(path.dirname(eventsPath), "summary.json");
  if (read(summaryPath) !== null) return true;
  return null;
}

/**
 * Freshness bound for treating a non-terminal run-store as live without a
 * corroborating lock/wrapper PID (#770 review 2 b48730b7). Stale crash stores
 * older than this are not coexistence evidence.
 */
export const ACTIVE_RUN_STORE_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Newest **fresh** non-terminal advance run-store for an issue under
 * `<repoDir>/.agent-pipeline/runs/<issue>-*`, or null when none.
 *
 * A non-terminal events file alone is not enough — require mtime within
 * {@link ACTIVE_RUN_STORE_MAX_AGE_MS} (or injectable nowMs) so crashed advances
 * that left `run_complete` missing do not block re-dispatch forever.
 */
export function findActiveRunStoreForIssue(
  repoDir: string,
  issueNumber: number,
  opts?: {
    readdirSync?: (dir: string) => string[];
    statMtimeMs?: (p: string) => number;
    readText?: (p: string) => string | null;
    nowMs?: () => number;
    maxAgeMs?: number;
  },
): { pipeline_run_id: string; events_path: string } | null {
  const readdir = opts?.readdirSync ?? ((dir: string) => fs.readdirSync(dir));
  const mtimeMs =
    opts?.statMtimeMs ??
    ((p: string) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    });
  const read = opts?.readText ?? tryReadTextFile;
  const now = opts?.nowMs?.() ?? Date.now();
  const maxAge = opts?.maxAgeMs ?? ACTIVE_RUN_STORE_MAX_AGE_MS;
  const runsRoot = artifactSubdir(repoDir, RUNS_ARTIFACT);
  let names: string[];
  try {
    names = readdir(runsRoot);
  } catch {
    return null;
  }
  const prefix = `${issueNumber}-`;
  const candidates = names
    .filter((n) => n.startsWith(prefix) && !n.includes("/") && n !== "." && n !== "..")
    .map((name) => ({ name, mtime: mtimeMs(path.join(runsRoot, name)) }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { name, mtime } of candidates) {
    if (mtime <= 0 || now - mtime > maxAge) continue; // stale crash store
    const events_path = path.join(runsRoot, name, "events.jsonl");
    const text = read(events_path);
    if (text === null) {
      // No events yet but run dir exists — treat as active only when run.json
      // is present (store initialized), summary is absent, and dir is fresh.
      const runJson = read(path.join(runsRoot, name, "run.json"));
      const summary = read(path.join(runsRoot, name, "summary.json"));
      if (runJson !== null && summary === null) {
        return { pipeline_run_id: name, events_path };
      }
      continue;
    }
    if (!eventsTextIsTerminal(text)) {
      return { pipeline_run_id: name, events_path };
    }
  }
  return null;
}

/**
 * Best-effort live wrapper PID for issue N from `~/.pipeline/runs/<N>/…-p<pid>`
 * directory names (detach launcher layout). Pure over injectable readdir + kill.
 */
export function findWrapperPidForIssue(
  issueNumber: number,
  opts?: {
    runsHome?: string;
    readdirSync?: (dir: string) => string[];
    isPidLive?: (pid: number) => boolean;
  },
): number | null {
  const home =
    opts?.runsHome ?? path.join(homedir(), ".pipeline", "runs", String(issueNumber));
  const readdir = opts?.readdirSync ?? ((dir: string) => fs.readdirSync(dir));
  const isLive =
    opts?.isPidLive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  let names: string[];
  try {
    names = readdir(home);
  } catch {
    return null;
  }
  // Prefer newest-looking dir names (lexicographic ISO timestamps sort well).
  const sorted = [...names].sort().reverse();
  for (const name of sorted) {
    const m = /-p(\d+)$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (isLive(pid)) return pid;
  }
  return null;
}

/**
 * Production probe: host-local lock PID, non-terminal run-store, optional
 * wrapper PID, and terminal-aware loop linkage.
 *
 * Loop linkage is live only when proven non-terminal. A retained
 * `advance_run_id` whose run already completed MUST NOT block re-admission
 * (#770 review 1 finding ce4794fb). Unresolvable linkage alone is not live;
 * lock / active run-store / wrapper evidence still apply.
 */
export function probeLiveAdvance(input: {
  domain: string;
  issueNumber: number;
  /** When the loop already has start-linkage for this item. */
  knownLinkage?: { pipeline_run_id: string; events?: string } | null;
  lockPathForTest?: string;
  /** Repo root for default run-store discovery under `.agent-pipeline/runs`. */
  repoDir?: string;
  /**
   * Injectable terminal resolution for linkage.
   * `true` = terminal, `false` = non-terminal, `null` = unresolvable.
   */
  resolveLinkageTerminal?: (linkage: {
    pipeline_run_id: string;
    events?: string;
  }) => boolean | null;
  /** Injectable non-terminal active run-store for the issue. */
  findActiveRunStore?: (issueNumber: number) => {
    pipeline_run_id: string;
    events_path?: string;
  } | null;
  /** Injectable live wrapper PID for the issue (null/absent = none). */
  findWrapperPid?: (issueNumber: number) => number | null;
}): LiveAdvanceProbeResult {
  // 1. Per-issue advisory lock held by a live process
  const lockPath = input.lockPathForTest ?? issueLockPath(input.domain, input.issueNumber);
  const held = isLockFileLive(lockPath);
  if (held.live) {
    return { live: true, evidence: "lock_held", holder_pid: held.pid };
  }

  // 2. Non-terminal loop linkage (terminal-aware — never treat terminal linkage as live)
  if (input.knownLinkage?.pipeline_run_id) {
    const terminal = input.resolveLinkageTerminal
      ? input.resolveLinkageTerminal(input.knownLinkage)
      : resolveLinkageTerminalState(input.knownLinkage, { repoDir: input.repoDir });
    if (terminal === false) {
      return {
        live: true,
        evidence: "loop_linkage",
        pipeline_run_id: input.knownLinkage.pipeline_run_id,
        events_path: input.knownLinkage.events,
      };
    }
    // terminal === true or null: fall through to other evidence sources
  }

  // 3. Active (non-terminal) advance run-store for this issue
  if (input.findActiveRunStore) {
    const active = input.findActiveRunStore(input.issueNumber);
    if (active) {
      return {
        live: true,
        evidence: "active_run_store",
        pipeline_run_id: active.pipeline_run_id,
        events_path: active.events_path,
      };
    }
  } else if (input.repoDir) {
    const active = findActiveRunStoreForIssue(input.repoDir, input.issueNumber);
    if (active) {
      return {
        live: true,
        evidence: "active_run_store",
        pipeline_run_id: active.pipeline_run_id,
        events_path: active.events_path,
      };
    }
  }

  // 4. Live wrapper / process identity for the issue
  const wrapperPid = input.findWrapperPid
    ? input.findWrapperPid(input.issueNumber)
    : findWrapperPidForIssue(input.issueNumber);
  if (wrapperPid != null && Number.isFinite(wrapperPid) && wrapperPid > 0) {
    try {
      process.kill(wrapperPid, 0);
      return { live: true, evidence: "wrapper_pid", holder_pid: wrapperPid };
    } catch {
      /* dead */
    }
  }

  return { live: false };
}
