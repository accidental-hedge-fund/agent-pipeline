// Human-intervention taxonomy and factory-debt recording (#302).
//
// Defines the closed `HumanInterventionKind` enum, the event shape, and the
// helpers for emitting events and summarizing them. Imported by stage files
// and run-store.ts; does NOT import from run-store.ts (avoids circular dep).

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { redactSecrets, sanitize } from "./artifact-sanitize.ts";
import { type BlockerKind } from "./types.ts";

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export const HUMAN_INTERVENTION_KINDS = [
  "ambiguous-issue",
  "product-judgment-required",
  "plan-review-feedback",
  "review-non-convergence",
  "test-build-failure",
  "eval-shipcheck-failure",
  "merge-conflict-or-branch-drift",
  "auth-tooling-preflight-failure",
  "human-risk-override",
  "reviewer-unavailable",
  "unknown",
] as const;

export type HumanInterventionKind = (typeof HUMAN_INTERVENTION_KINDS)[number];

// ---------------------------------------------------------------------------
// Event shape
// ---------------------------------------------------------------------------

export interface HumanInterventionEvent {
  schema_version: 1;
  type: "human_intervention";
  at: string;
  kind: HumanInterventionKind;
  stage: string | null;
  issue: number;
  detail: string;
  ref?: string | null;
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/** Minimal deps for appending an event line. Structurally compatible with
 *  `RunStoreDeps` so callers can pass `opts.runStoreDeps` directly. */
export interface EmitInterventionDeps {
  appendFile: (p: string, data: string) => Promise<void>;
  stdoutWrite?: (line: string) => void;
}

const defaultEmitDeps: EmitInterventionDeps = {
  appendFile: (p, data) => fsp.appendFile(p, data, "utf8"),
};

/**
 * Append a `human_intervention` event to `events.jsonl`.
 *
 * Non-fatal: any I/O failure is caught and logged as a warning — the calling
 * stage's outcome is never affected by a failed event write.
 * When `runDir` is undefined the call is a no-op.
 *
 * The `detail` and `ref` fields are subject to the write-time injection
 * denylist (same redaction applied to all run-artifact values).
 */
export async function emitHumanIntervention(
  runDir: string | undefined,
  payload: {
    kind: HumanInterventionKind;
    stage: string | null;
    issue: number;
    detail: string;
    ref?: string | null;
  },
  deps: EmitInterventionDeps = defaultEmitDeps,
): Promise<void> {
  if (!runDir) return;
  try {
    const event: HumanInterventionEvent = {
      schema_version: 1,
      type: "human_intervention",
      at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      kind: payload.kind,
      stage: payload.stage,
      issue: payload.issue,
      detail: sanitize(redactSecrets(payload.detail)),
      ...(payload.ref != null
        ? { ref: sanitize(redactSecrets(String(payload.ref))) }
        : {}),
    };
    const line = `${JSON.stringify(event)}\n`;
    await deps.appendFile(path.join(runDir, "events.jsonl"), line);
    if (deps.stdoutWrite) {
      deps.stdoutWrite(line);
    }
  } catch (err) {
    console.warn(
      `[pipeline] intervention: emitHumanIntervention failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Summary aggregation
// ---------------------------------------------------------------------------

export interface InterventionSummary {
  total: number;
  byKind: Record<HumanInterventionKind, number>;
  items: HumanInterventionEvent[];
}

/** Build a zero-initialized `byKind` record for all known kinds. */
function zeroByKind(): Record<HumanInterventionKind, number> {
  const out = {} as Record<HumanInterventionKind, number>;
  for (const k of HUMAN_INTERVENTION_KINDS) {
    out[k] = 0;
  }
  return out;
}

/**
 * Aggregate `human_intervention` events by kind over an optional time window.
 *
 * - Accepts the full event array from one or more `events.jsonl` files
 *   (unknown fields are preserved; non-`human_intervention` events are ignored).
 * - When `windowMs` is provided, only events whose `at` timestamp falls within
 *   the last `windowMs` milliseconds of the most recent event's timestamp are
 *   counted.
 * - Unrecognized `kind` strings are counted under `"unknown"`.
 * - An empty or all-filtered array returns a zero summary.
 */
export function summarizeInterventions(
  events: Record<string, unknown>[],
  windowMs?: number,
): InterventionSummary {
  // Filter for human_intervention events only.
  let items = events.filter(
    (e): e is HumanInterventionEvent =>
      e.type === "human_intervention" &&
      typeof e.at === "string" &&
      typeof e.issue === "number",
  ) as HumanInterventionEvent[];

  // Apply time-window filter when requested.
  if (windowMs !== undefined && windowMs >= 0 && items.length > 0) {
    const maxAt = items.reduce(
      (max, e) => Math.max(max, Date.parse(e.at) || 0),
      0,
    );
    const cutoff = maxAt - windowMs;
    items = items.filter((e) => (Date.parse(e.at) || 0) >= cutoff);
  }

  const byKind = zeroByKind();
  for (const item of items) {
    const k: HumanInterventionKind =
      HUMAN_INTERVENTION_KINDS.includes(item.kind as HumanInterventionKind)
        ? (item.kind as HumanInterventionKind)
        : "unknown";
    byKind[k]++;
  }

  return { total: items.length, byKind, items };
}

// ---------------------------------------------------------------------------
// Blocker-kind mapping
// ---------------------------------------------------------------------------

/**
 * Map a `BlockerKind` value to the closest `HumanInterventionKind` for emission
 * at the common `blocker_set` orchestrator point. Guarantees ordering:
 * `blocker_set` is written first by the orchestrator, then this function is
 * called to emit the `human_intervention` event immediately after.
 */
export function blockerKindToInterventionKind(kind: BlockerKind): HumanInterventionKind {
  switch (kind) {
    case "test-gate-exhausted":
    case "no-commits":
    case "push-failed":
    case "build-failed":
      return "test-build-failure";
    case "eval-gate-failed":
    case "eval-gate-misconfigured":
    case "shipcheck-failed":
      return "eval-shipcheck-failure";
    case "merge-conflict":
    case "head-drift":
      return "merge-conflict-or-branch-drift";
    case "worktree-missing":
    case "worktree-creation-failed":
    case "worktree-setup-failed":
    case "pr-creation-failed":
    case "plan-gen-failed":
      return "auth-tooling-preflight-failure";
    case "harness-failure":
      return "reviewer-unavailable";
    case "openspec-invalid":
    case "openspec-stale-delta":
    case "no-pull-request":
    case "needs-human":
    case "human-decision-required":
      return "product-judgment-required";
    default:
      return "unknown";
  }
}
