// Assumption and open-question lineage (#702).
//
// Stable assumption_id within a run; status updates reuse identity; current
// state is latest event per id; unresolved = open | deferred.

import { createHash } from "node:crypto";
import {
  ASSUMPTION_STATUSES,
  type AssumptionKind,
  type AssumptionLineagePayload,
  type AssumptionStatus,
  type DeliveryPhase,
  readAssumptionPayload,
  redactFreeText,
} from "./schema.ts";

/** Allocate a stable assumption_id unique within a run. */
export function allocateAssumptionId(args: {
  run_id: string;
  statement: string;
  ordinal?: number;
  kind?: AssumptionKind;
}): string {
  const ordinal = args.ordinal ?? 0;
  const kind = args.kind ?? "assumption";
  const base = `${args.run_id}\0${kind}\0${args.statement.trim()}\0${ordinal}`;
  const hash = createHash("sha256").update(base).digest("hex").slice(0, 16);
  return `A-${hash}`;
}

/**
 * Lowest free ordinal for a (run_id, kind, statement) identity key so default
 * allocation stays unique when producers omit assumption_id (#702).
 *
 * Scans ordinals 0,1,2,… and returns the first whose derived assumption_id is
 * absent from current state. Count-of-matches is wrong under sparse producer
 * ordinals (e.g. only ordinal 1 exists → next must be 0, not 1). Status
 * updates do not allocate and do not occupy extra ordinals.
 */
export function nextAssumptionOrdinal(args: {
  events: readonly unknown[];
  run_id: string;
  kind: AssumptionKind;
  statement: string;
}): number {
  const current = projectAssumptionCurrentState(args.events, args.run_id);
  for (let ordinal = 0; ; ordinal++) {
    const id = allocateAssumptionId({
      run_id: args.run_id,
      statement: args.statement,
      ordinal,
      kind: args.kind,
    });
    if (!current.has(id)) return ordinal;
  }
}

export function isUnresolvedStatus(status: AssumptionStatus): boolean {
  return status === "open" || status === "deferred";
}

/**
 * Current-state projection: latest event per assumption_id for a run.
 * History is retained in the full event list; this is last-write-wins.
 */
export function projectAssumptionCurrentState(
  events: readonly unknown[],
  runId?: string,
): Map<string, AssumptionLineagePayload> {
  const byId = new Map<string, AssumptionLineagePayload>();
  for (const raw of events) {
    const p = readAssumptionPayload(raw);
    if (!p) continue;
    if (runId != null && p.run_id !== runId) continue;
    // Last write wins (append-only stream order).
    byId.set(p.assumption_id, p);
  }
  return byId;
}

export function countAssumptionsByStatus(
  current: ReadonlyMap<string, AssumptionLineagePayload>,
): Record<AssumptionStatus, number> {
  const out: Record<AssumptionStatus, number> = {
    open: 0,
    resolved: 0,
    invalidated: 0,
    deferred: 0,
    unknown: 0,
  };
  for (const p of current.values()) {
    if (ASSUMPTION_STATUSES.includes(p.status)) out[p.status]++;
  }
  return out;
}

export function countUnresolved(
  current: ReadonlyMap<string, AssumptionLineagePayload>,
): number {
  let n = 0;
  for (const p of current.values()) {
    if (isUnresolvedStatus(p.status)) n++;
  }
  return n;
}

/** Build an open create payload (status open). */
export function createOpenAssumption(args: {
  run_id: string;
  issue?: number | null;
  assumption_id?: string;
  kind: AssumptionKind;
  statement: string;
  introduced_phase: DeliveryPhase;
  status_updated_at: string;
  ordinal?: number;
}): AssumptionLineagePayload {
  const assumption_id =
    args.assumption_id ??
    allocateAssumptionId({
      run_id: args.run_id,
      statement: args.statement,
      ordinal: args.ordinal,
      kind: args.kind,
    });
  return {
    record_schema_version: 1,
    type: "assumption_lineage",
    run_id: args.run_id,
    issue: args.issue ?? null,
    assumption_id,
    kind: args.kind,
    statement: redactFreeText(args.statement, 500),
    introduced_phase: args.introduced_phase,
    status: "open",
    status_updated_at: args.status_updated_at,
    resolution: null,
    evidence_refs: [],
  };
}

/**
 * Status transition preserving identity. Does not allocate a new id.
 */
export function updateAssumptionStatus(args: {
  prior: AssumptionLineagePayload;
  status: AssumptionStatus;
  status_updated_at: string;
  resolved_in_phase?: DeliveryPhase | null;
  resolution_note?: string | null;
  evidence_refs?: string[];
}): AssumptionLineagePayload {
  const resolved =
    args.status === "resolved" || args.status === "invalidated"
      ? {
          note: args.resolution_note
            ? redactFreeText(args.resolution_note, 300)
            : null,
          resolved_in_phase: args.resolved_in_phase ?? null,
        }
      : args.status === "open"
        ? null
        : args.prior.resolution ?? null;

  return {
    ...args.prior,
    // Identity frozen
    assumption_id: args.prior.assumption_id,
    run_id: args.prior.run_id,
    kind: args.prior.kind,
    introduced_phase: args.prior.introduced_phase,
    status: args.status,
    status_updated_at: args.status_updated_at,
    resolution: resolved,
    evidence_refs: args.evidence_refs ?? args.prior.evidence_refs ?? [],
  };
}
