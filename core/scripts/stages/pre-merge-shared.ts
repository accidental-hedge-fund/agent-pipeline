// Shared pure helpers for pre-merge domain modules (#628).
// Leaf module: no imports from other pre-merge domain modules or the facade.

import { appendEvent, RUN_SCHEMA_VERSION } from "../run-store.ts";
import type { GateResultEvent, RunStoreDeps } from "../run-store.ts";
import type { Outcome } from "../types.ts";
import type { BlockerKind } from "../types.ts";
import type { PreMergeOfframpPathTag } from "../pre-merge-offramp.ts";
import type { StageDiagnostic } from "../stage-diagnostic.ts";
import { normalizeCandidateSha } from "../tester-evidence.ts";

// ---------------------------------------------------------------------------
// Live-head SHA currency pin (#1010)
// ---------------------------------------------------------------------------

/**
 * Whether a recorded candidate / test / reviewed SHA is current for the live
 * open PR head pin used by pre-merge tester, CI, and delta residual authority.
 *
 * - `current` — both are full SHAs and equal (case-normalized)
 * - `stale`   — recorded SHA is absent, malformed, or differs from the live pin
 * - `unknown` — live head pin itself is missing/malformed (cannot authorize)
 */
export type RecordedShaCurrencyStatus = "current" | "stale" | "unknown";

export interface RecordedShaCurrency {
  status: RecordedShaCurrencyStatus;
  recordedSha: string | null;
  liveHead: string | null;
}

/**
 * Pure classifier: recorded evidence/test/reviewed SHA vs the live-head pin.
 * Callers MUST NOT grant fail / residual-block authority when status ≠ current.
 */
export function classifyRecordedShaAgainstLiveHead(
  recordedSha: string | null | undefined,
  liveHead: string | null | undefined,
): RecordedShaCurrency {
  const rec = normalizeCandidateSha(recordedSha);
  const live = normalizeCandidateSha(liveHead);
  if (live == null) {
    return { status: "unknown", recordedSha: rec, liveHead: live };
  }
  if (rec == null) {
    return { status: "stale", recordedSha: rec, liveHead: live };
  }
  if (rec === live) {
    return { status: "current", recordedSha: rec, liveHead: live };
  }
  return { status: "stale", recordedSha: rec, liveHead: live };
}

/** True only when the recorded SHA is a full SHA equal to the live-head pin. */
export function recordedShaIsCurrentForLiveHead(
  recordedSha: string | null | undefined,
  liveHead: string | null | undefined,
): boolean {
  return classifyRecordedShaAgainstLiveHead(recordedSha, liveHead).status === "current";
}

/**
 * Append dual-SHA disclosure when residual escalate involves a prior candidate
 * SHA distinct from the live head (#1010). Does not auto-override findings.
 */
export function appendDualShaEscalationDisclosure(
  reason: string,
  liveHead: string,
  priorCandidateSha?: string | null,
  overrideRequired = true,
): string {
  const live = normalizeCandidateSha(liveHead);
  const prior = normalizeCandidateSha(priorCandidateSha);
  if (!live) return reason;
  const parts: string[] = [reason.replace(/\s+$/, "")];
  if (prior && prior !== live) {
    parts.push(
      `Prior candidate SHA \`${prior}\` is superseded; live open PR head is \`${live}\`.`,
    );
  } else {
    parts.push(`Live open PR head: \`${live}\`.`);
  }
  if (overrideRequired) {
    parts.push(
      "Audited `pipeline override` of residual finding keys at the live head is required if they still block after re-evaluation.",
    );
  }
  return parts.join(" ");
}

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
