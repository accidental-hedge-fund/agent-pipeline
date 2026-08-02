// Shared pure helpers for pre-merge domain modules (#628).
// Leaf module: no imports from other pre-merge domain modules or the facade.

import { appendEvent, RUN_SCHEMA_VERSION } from "../run-store.ts";
import type { GateResultEvent, RunStoreDeps } from "../run-store.ts";
import type { Outcome } from "../types.ts";
import type { BlockerKind } from "../types.ts";
import type { PreMergeOfframpPathTag } from "../pre-merge-offramp.ts";
import type { StageDiagnostic } from "../stage-diagnostic.ts";

/**
 * Best-effort `gate_result` append for pre-merge observability (#682). Never
 * throws; never changes gate decisions. Used so the loop progress mirror can
 * map CI / delta / auto-fix outcomes without inventing event shapes.
 */
export async function recordPreMergeGateResult(
  deps: { runDir?: string; runStoreDeps?: RunStoreDeps },
  gate: string,
  result: GateResultEvent["result"],
  reason?: string,
  extra?: { mode?: string },
): Promise<void> {
  if (!deps.runDir) return;
  const event: GateResultEvent = {
    schema_version: RUN_SCHEMA_VERSION,
    type: "gate_result",
    at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    gate,
    result,
    ...(reason !== undefined ? { reason } : {}),
    ...(extra?.mode !== undefined ? { mode: extra.mode } : {}),
  };
  await appendEvent(deps.runDir, event, deps.runStoreDeps).catch(() => {});
}

/**
 * Build a pre-merge blocked Outcome with explicit kind (+ optional path tag for
 * scoreboard offramp_class mapping when kind alone is too coarse — #683).
 */
export function preMergeBlocked(
  reason: string,
  kind: BlockerKind,
  pathTag?: PreMergeOfframpPathTag,
  diagnostic?: StageDiagnostic,
): Extract<Outcome, { status: "blocked" }> {
  return {
    advanced: false,
    status: "blocked",
    reason,
    blockerKind: kind,
    ...(pathTag !== undefined ? { offrampPathTag: pathTag } : {}),
    ...(diagnostic !== undefined ? { diagnostic } : {}),
  };
}
