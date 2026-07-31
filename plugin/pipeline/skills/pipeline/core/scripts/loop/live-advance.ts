// Host-local "is an advance already live for this issue?" probe and pure
// classifiers for loop/operator coexistence (#770).
//
// Unit tests inject the probe; production wires lock-file PID liveness.

import * as fs from "node:fs";
import * as path from "node:path";

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
 * Non-fatal mid-pipeline exit: advance ended without ready/blocked/closed, but
 * events show waiting-like or incomplete progress rather than a crash with no
 * store. Pure over events text + labels.
 */
export function isNonFatalMidStageExit(
  eventsText: string | null | undefined,
  labels: readonly string[],
): boolean {
  if (!labels.some((l) => l.startsWith("pipeline:") && l !== "pipeline:ready-to-deploy")) {
    return false;
  }
  if (labels.includes("blocked") || labels.includes("pipeline:ready-to-deploy")) return false;
  if (!eventsText) return false;
  if (isCoexistenceFailureEvidence(eventsText)) return true;

  let lastStageComplete: { outcome?: string } | null = null;
  let sawRunComplete = false;
  for (const line of eventsText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as { type?: string; outcome?: string; reason?: string };
      if (ev.type === "stage_complete") lastStageComplete = { outcome: ev.outcome };
      if (ev.type === "run_complete") sawRunComplete = true;
      if (ev.type === "gate_result" && typeof ev.reason === "string") {
        if (/rebased; CI re-running|waiting for checks|CI re-triggered/i.test(ev.reason)) {
          return true;
        }
      }
    } catch {
      /* skip */
    }
  }
  if (lastStageComplete?.outcome === "skipped" || lastStageComplete?.outcome === "waiting") {
    return true;
  }
  // Child exited mid-stage with only stage_start (no complete) — treat as
  // non-fatal coexistence only when coexistence evidence was also present above.
  void sawRunComplete;
  return false;
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

/**
 * Production probe: host-local per-issue lock PID liveness. Optional
 * `knownLinkage` covers loop-owned non-terminal advances.
 */
export function probeLiveAdvance(input: {
  domain: string;
  issueNumber: number;
  /** When the loop already has non-terminal start-linkage for this item. */
  knownLinkage?: { pipeline_run_id: string; events?: string } | null;
  lockPathForTest?: string;
}): LiveAdvanceProbeResult {
  if (input.knownLinkage?.pipeline_run_id) {
    return {
      live: true,
      evidence: "loop_linkage",
      pipeline_run_id: input.knownLinkage.pipeline_run_id,
      events_path: input.knownLinkage.events,
    };
  }
  const lockPath = input.lockPathForTest ?? issueLockPath(input.domain, input.issueNumber);
  const held = isLockFileLive(lockPath);
  if (held.live) {
    return { live: true, evidence: "lock_held", holder_pid: held.pid };
  }
  return { live: false };
}
