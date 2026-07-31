// Host-local "is an advance already live for this issue?" probe and pure
// classifiers for loop/operator coexistence (#770).
//
// Unit tests inject the probe; production wires lock-file PID liveness,
// freshness-bounded non-terminal run-store detection, wrapper/process identity
// under ~/.pipeline/runs/<issue>, and terminal-aware loop linkage.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RUNS_ARTIFACT, artifactSubdir } from "../artifact-ignore.ts";
import { LOCK_ACQUIRED_FILE, issueRunsDir, lockFilePath } from "../detach.ts";

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

/**
 * Host-local freshness bound for non-terminal advance run-stores (#770 review 2
 * b48730b7). A crashed advance leaves exactly the non-terminal events shape;
 * without a bound those crash artifacts would look "live" forever and suppress
 * genuine re-dispatch / run_fatal classification. Long-running advances that
 * go quiet are covered by live lock / wrapper PID evidence instead.
 */
export const ACTIVE_RUN_STORE_MAX_AGE_MS = 30 * 60 * 1000;

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

/** True when `process.kill(pid, 0)` succeeds (process exists / EPERM). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Parse a lock / `.lock-acquired` body into a positive PID, or null. */
export function parsePidText(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const pid = Number(raw.trim().split(/\s+/)[0]);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return pid;
}

/** Read a lock file path; live when PID is parseable and `process.kill(pid, 0)` succeeds. */
export function isLockFileLive(lockPath: string): { live: boolean; pid?: number } {
  try {
    if (!fs.existsSync(lockPath)) return { live: false };
    const pid = parsePidText(fs.readFileSync(lockPath, "utf8"));
    if (pid == null) return { live: false };
    if (isPidAlive(pid)) return { live: true, pid };
    return { live: false };
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
 * Newest *fresh* non-terminal advance run-store for an issue under
 * `<repoDir>/.agent-pipeline/runs/<issue>-*`, or null when none.
 *
 * Freshness: events.jsonl (or the run dir when events are absent) must have
 * mtime within {@link ACTIVE_RUN_STORE_MAX_AGE_MS} of `nowMs`. Stale crash
 * artifacts without recent activity are not treated as live (#770 review 2
 * b48730b7) — live long-running advances are covered by lock / wrapper PID.
 */
export function findActiveRunStoreForIssue(
  repoDir: string,
  issueNumber: number,
  opts?: {
    readdirSync?: (dir: string) => string[];
    statMtimeMs?: (p: string) => number;
    readText?: (p: string) => string | null;
    nowMs?: number;
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
  const now = opts?.nowMs ?? Date.now();
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
  for (const { name, mtime: dirMtime } of candidates) {
    const events_path = path.join(runsRoot, name, "events.jsonl");
    const eventsMtime = mtimeMs(events_path);
    const activityMs = eventsMtime > 0 ? eventsMtime : dirMtime;
    // Stale non-terminal crash store: skip (do not treat as live forever).
    if (activityMs <= 0 || now - activityMs > maxAge) continue;

    const text = read(events_path);
    if (text === null) {
      // No events yet but run dir exists — treat as active only when run.json
      // is present (store initialized) and summary is absent.
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
 * Production wrapper / process-identity lookup for an issue (#770 review 2
 * 956d20df). Host-local only — reads the detach issue lock and newest
 * non-sentinel run dirs' `.lock-acquired` under `~/.pipeline/runs/<issue>/`.
 * Returns a live PID or null. Injectable FS / liveness for unit tests.
 */
export function findWrapperPidForIssue(
  issueNumber: number,
  opts?: {
    homedir?: string;
    readdirSync?: (dir: string) => string[];
    readText?: (p: string) => string | null;
    isPidAlive?: (pid: number) => boolean;
    statMtimeMs?: (p: string) => number;
  },
): number | null {
  const home = opts?.homedir ?? os.homedir();
  const readdir = opts?.readdirSync ?? ((dir: string) => fs.readdirSync(dir));
  const read = opts?.readText ?? tryReadTextFile;
  const alive = opts?.isPidAlive ?? isPidAlive;
  const mtimeMs =
    opts?.statMtimeMs ??
    ((p: string) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    });

  const issueDir = issueRunsDir(home, issueNumber);

  // 1. Detach issue-level advisory lock (`~/.pipeline/runs/<issue>/.lock`)
  const detachLock = lockFilePath(home, issueNumber);
  const lockPid = parsePidText(read(detachLock));
  if (lockPid != null && alive(lockPid)) return lockPid;

  // 2. Newest non-terminal detach run dirs with a live `.lock-acquired` PID
  let names: string[];
  try {
    names = readdir(issueDir);
  } catch {
    return null;
  }
  const candidates = names
    .filter((n) => n !== "." && n !== ".." && n !== ".lock" && !n.startsWith("."))
    .map((name) => ({ name, mtime: mtimeMs(path.join(issueDir, name)) }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { name } of candidates) {
    const dir = path.join(issueDir, name);
    // sentinel.json means the wrapper already exited — not live identity.
    if (read(path.join(dir, "sentinel.json")) !== null) continue;
    const acquiredPid = parsePidText(read(path.join(dir, LOCK_ACQUIRED_FILE)));
    if (acquiredPid != null && alive(acquiredPid)) return acquiredPid;
  }
  return null;
}

/**
 * Production probe: host-local lock PID, freshness-bounded non-terminal
 * run-store, optional wrapper PID, and terminal-aware loop linkage.
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

  // 3. Active (fresh, non-terminal) advance run-store for this issue
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
  if (input.findWrapperPid) {
    const pid = input.findWrapperPid(input.issueNumber);
    if (pid != null && Number.isFinite(pid) && pid > 0) {
      if (isPidAlive(pid)) {
        return { live: true, evidence: "wrapper_pid", holder_pid: pid };
      }
    }
  }

  return { live: false };
}
