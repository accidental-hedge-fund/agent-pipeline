// Host-local "is an advance already live for this issue?" probe and pure
// classifiers for loop/operator coexistence (#770).
//
// Unit tests inject the probe; production wires lock-file PID liveness,
// freshness-bounded non-terminal run-store detection, wrapper/process identity
// under ~/.pipeline/runs/<domain>/<issue>, and terminal-aware loop linkage.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RUNS_ARTIFACT, artifactSubdir } from "../artifact-ignore.ts";
import {
  LOCK_ACQUIRED_FILE,
  getProcessStartTime,
  issueRunsDir,
} from "../detach.ts";
import { issueRunLockPath } from "../lock.ts";
import { isSameProcessInstance } from "./lock-ownership.ts";

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

/**
 * Parse a detach identity marker (`pid starttime…`) into verifiable identity.
 * Bare PID (no starttime token) returns null — identity cannot be verified
 * against PID reuse (#770 review finding eff1796b).
 */
export function parseProcessIdentityText(
  raw: string | null | undefined,
): { pid: number; starttime: string } | null {
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const pid = Number(parts[0]);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isInteger(pid)) return null;
  // Remainder may contain spaces (Darwin `ps -o lstart=`).
  const starttime = parts.slice(1).join(" ").trim();
  if (!starttime) return null;
  return { pid, starttime };
}

/**
 * Live only when marker carries pid+starttime, the PID is alive, and host
 * starttime still matches the recorded token. Unverifiable markers are non-live.
 */
export function livePidFromIdentityMarker(
  raw: string | null | undefined,
  opts?: {
    isPidAlive?: (pid: number) => boolean;
    getStartTime?: (pid: number) => string | number | null | undefined;
  },
): number | null {
  const id = parseProcessIdentityText(raw);
  if (!id) return null;
  const alive = opts?.isPidAlive ?? isPidAlive;
  const getStart = opts?.getStartTime ?? getProcessStartTime;
  if (!alive(id.pid)) return null;
  if (!isSameProcessInstance(id.pid, id.starttime, getStart)) return null;
  return id.pid;
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

/** Shared issue-run lock path — same identity as advance and detach (#634). */
export function issueLockPath(domain: string, issueNumber: number): string {
  return issueRunLockPath(domain, issueNumber);
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
 * Host-local activity freshness for a path (events.jsonl or run dir).
 * Used for both active run-store discovery and non-terminal loop linkage
 * (#770 review 2 12e4c0fd) so crash artifacts age out.
 */
export function isActivityFresh(
  activityMs: number,
  opts?: { nowMs?: number; maxAgeMs?: number },
): boolean {
  if (!(activityMs > 0)) return false;
  const now = opts?.nowMs ?? Date.now();
  const maxAge = opts?.maxAgeMs ?? ACTIVE_RUN_STORE_MAX_AGE_MS;
  return now - activityMs <= maxAge;
}

/** Resolve events path for a linkage row (explicit events or repoDir default). */
export function linkageEventsPath(
  linkage: { pipeline_run_id: string; events?: string },
  repoDir?: string,
): string | null {
  return (
    linkage.events ??
    (repoDir ? advanceRunEventsPath(repoDir, linkage.pipeline_run_id) : null)
  );
}

/**
 * Whether a proven non-terminal linked store is still within the freshness
 * bound. Stale non-terminal crash linkage must not count as live forever
 * (#770 review 2 12e4c0fd). Missing path / unreadable mtime → not fresh.
 */
export function isNonTerminalLinkageFresh(
  linkage: { pipeline_run_id: string; events?: string },
  opts?: {
    repoDir?: string;
    statMtimeMs?: (p: string) => number;
    nowMs?: number;
    maxAgeMs?: number;
  },
): boolean {
  const eventsPath = linkageEventsPath(linkage, opts?.repoDir);
  if (!eventsPath) return false;
  const mtimeMs =
    opts?.statMtimeMs ??
    ((p: string) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    });
  let activityMs = mtimeMs(eventsPath);
  if (!(activityMs > 0)) {
    // Fall back to the run directory when events are absent but linkage points
    // at a store that still exists (initialized, no events yet).
    activityMs = mtimeMs(path.dirname(eventsPath));
  }
  return isActivityFresh(activityMs, { nowMs: opts?.nowMs, maxAgeMs: opts?.maxAgeMs });
}

/**
 * Evidence classes that prove a **concurrent holder** still owns the issue —
 * distinct from the just-failed dispatch's own non-terminal crash artifacts
 * (loop_linkage / active_run_store). Pass-2 coexistence reclassification
 * requires this or structured lock/already-running text (#770 12e4c0fd).
 */
export function isConcurrentHolderEvidence(
  evidence: LiveAdvanceEvidenceClass | undefined,
): boolean {
  return evidence === "lock_held" || evidence === "wrapper_pid";
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
 * Production wrapper / process-identity lookup for an issue (#770 / #634).
 * Host-local only — domain-scoped: reads the shared issue-run lock and newest
 * non-sentinel run dirs' `.lock-acquired` under
 * `~/.pipeline/runs/<domain>/<issue>/`. Returns a live PID only when the
 * marker's process-identity token (pid + starttime) still matches the host
 * process table — bare PID liveness alone is not sufficient (PID reuse after a
 * pre-sentinel crash must not suppress redispatch). Injectable FS / identity
 * for unit tests. Cross-domain locks do not count as live for this domain.
 */
export function findWrapperPidForIssue(
  issueNumber: number,
  opts: {
    /** Required: same domain key as the issue-run lock / advance. */
    domain: string;
    homedir?: string;
    readdirSync?: (dir: string) => string[];
    readText?: (p: string) => string | null;
    isPidAlive?: (pid: number) => boolean;
    getStartTime?: (pid: number) => string | number | null | undefined;
    statMtimeMs?: (p: string) => number;
    /** Override issue-run lock path (tests). Default: issueRunLockPath(domain, issue). */
    lockPath?: string;
  },
): number | null {
  const domain = opts.domain;
  if (!domain) return null;
  const home = opts.homedir ?? os.homedir();
  const readdir = opts.readdirSync ?? ((dir: string) => fs.readdirSync(dir));
  const read = opts.readText ?? tryReadTextFile;
  const alive = opts.isPidAlive ?? isPidAlive;
  const getStart = opts.getStartTime ?? getProcessStartTime;
  const mtimeMs =
    opts.statMtimeMs ??
    ((p: string) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    });
  const liveFrom = (raw: string | null | undefined): number | null =>
    livePidFromIdentityMarker(raw, { isPidAlive: alive, getStartTime: getStart });

  // 1. Shared issue-run lock (`/tmp/pipeline-{domain}-{N}.lock`) with identity
  const issueLock = opts.lockPath ?? issueRunLockPath(domain, issueNumber);
  const lockPid = liveFrom(read(issueLock));
  if (lockPid != null) return lockPid;

  // 2. Newest non-terminal detach run dirs with a verified `.lock-acquired`
  const issueDir = issueRunsDir(home, domain, issueNumber);
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
    const acquiredPid = liveFrom(read(path.join(dir, LOCK_ACQUIRED_FILE)));
    if (acquiredPid != null) return acquiredPid;
  }
  return null;
}

/**
 * Production probe: host-local lock PID, freshness-bounded non-terminal
 * run-store, optional wrapper PID, and terminal + freshness-aware loop linkage.
 *
 * Loop linkage is live only when proven non-terminal **and** the linked store
 * is still within {@link ACTIVE_RUN_STORE_MAX_AGE_MS} (or injectable bound).
 * A retained `advance_run_id` whose run already completed MUST NOT block
 * re-admission (#770 review 1 finding ce4794fb). An aged non-terminal crash
 * linkage MUST NOT count as live forever (#770 review 2 12e4c0fd).
 * Unresolvable linkage alone is not live; lock / active run-store / wrapper
 * evidence still apply.
 *
 * Optional `ignorePipelineRunIds` excludes those stores from linkage and
 * active-run-store evidence (Pass-2 uses this so the just-failed dispatch's
 * own crash artifacts cannot reclassify as coexistence without a concurrent
 * lock/wrapper holder — #770 12e4c0fd).
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
  /**
   * Injectable freshness check for non-terminal linkage. Default uses events
   * (or run-dir) mtime against {@link ACTIVE_RUN_STORE_MAX_AGE_MS}.
   */
  isLinkageFresh?: (linkage: {
    pipeline_run_id: string;
    events?: string;
  }) => boolean;
  /** Injectable non-terminal active run-store for the issue. */
  findActiveRunStore?: (issueNumber: number) => {
    pipeline_run_id: string;
    events_path?: string;
  } | null;
  /** Injectable live wrapper PID for the issue (null/absent = none). */
  findWrapperPid?: (issueNumber: number) => number | null;
  /**
   * Pipeline run ids that must not count as live store/linkage evidence
   * (typically the just-failed dispatch attempt on Pass-2).
   */
  ignorePipelineRunIds?: readonly string[];
  nowMs?: number;
  maxAgeMs?: number;
  statMtimeMs?: (p: string) => number;
}): LiveAdvanceProbeResult {
  const ignored = new Set(
    (input.ignorePipelineRunIds ?? []).filter((id) => typeof id === "string" && id.length > 0),
  );

  // 1. Per-issue advisory lock held by a live process
  const lockPath = input.lockPathForTest ?? issueLockPath(input.domain, input.issueNumber);
  const held = isLockFileLive(lockPath);
  if (held.live) {
    return { live: true, evidence: "lock_held", holder_pid: held.pid };
  }

  // 2. Non-terminal + fresh loop linkage (never terminal; never aged crash forever)
  if (input.knownLinkage?.pipeline_run_id) {
    const linkId = input.knownLinkage.pipeline_run_id;
    if (!ignored.has(linkId)) {
      const terminal = input.resolveLinkageTerminal
        ? input.resolveLinkageTerminal(input.knownLinkage)
        : resolveLinkageTerminalState(input.knownLinkage, { repoDir: input.repoDir });
      if (terminal === false) {
        const fresh = input.isLinkageFresh
          ? input.isLinkageFresh(input.knownLinkage)
          : isNonTerminalLinkageFresh(input.knownLinkage, {
              repoDir: input.repoDir,
              nowMs: input.nowMs,
              maxAgeMs: input.maxAgeMs,
              statMtimeMs: input.statMtimeMs,
            });
        if (fresh) {
          return {
            live: true,
            evidence: "loop_linkage",
            pipeline_run_id: linkId,
            events_path: input.knownLinkage.events,
          };
        }
        // Stale non-terminal crash linkage: fall through
      }
      // terminal === true or null: fall through to other evidence sources
    }
  }

  // 3. Active (fresh, non-terminal) advance run-store for this issue
  if (input.findActiveRunStore) {
    const active = input.findActiveRunStore(input.issueNumber);
    if (active && !ignored.has(active.pipeline_run_id)) {
      return {
        live: true,
        evidence: "active_run_store",
        pipeline_run_id: active.pipeline_run_id,
        events_path: active.events_path,
      };
    }
  } else if (input.repoDir) {
    const active = findActiveRunStoreForIssue(input.repoDir, input.issueNumber, {
      nowMs: input.nowMs,
      maxAgeMs: input.maxAgeMs,
      statMtimeMs: input.statMtimeMs,
    });
    if (active && !ignored.has(active.pipeline_run_id)) {
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
