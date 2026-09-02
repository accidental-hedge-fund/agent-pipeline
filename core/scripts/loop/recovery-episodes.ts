// Recovery Episodes (#1325): persist candidate-scoped recovery state on the
// shared recovery-attempt / operation-claim family. Strategy cursor, per-strategy
// bounds, Cooling, write-ahead fenced claims, and generation-quarantine helpers.
//
// This is not a second durable scheduler, RecoveryEpisode database, or public
// CLI verb. Production authority stays LoopRecoveryAttempt + LoopCoolingRecord
// + operation claims.

import * as crypto from "node:crypto";
import {
  LoopError,
  type LoopCoolingRecord,
  type LoopLedger,
  type LoopRecoveryAttempt,
  type LoopStopRecord,
  type RecoveryBackoff,
  type RecoveryPolicyEntry,
  type RecoveryRecipe,
} from "./types.ts";


export const RECOVERY_EPISODE_REQUIRED_FIELDS = [
  "invariant",
  "candidate_epoch",
  "evidence_identity",
  "attempts_per_strategy",
  "strategy_cursor",
  "next_eligible_at",
] as const;

export type RecoveryEpisodeRequiredField = (typeof RECOVERY_EPISODE_REQUIRED_FIELDS)[number];

export const MECHANICAL_LIFECYCLE_STOP_REASONS = [
  "run_fatal",
  "recovery_exhausted",
  "repeated_no_progress",
  "supervisor_no_progress",
  "supervisor_cycle_cap",
  "worktree_capacity",
] as const;

export type MechanicalLifecycleStopReason = (typeof MECHANICAL_LIFECYCLE_STOP_REASONS)[number];

export const PRIVATE_EPISODE_SCHEMA_BASENAME = "recovery-episodes.json";

export interface RecoveryEpisodeRecord {
  episode_id: string;
  operation: string;
  invariant: string;
  candidate_epoch: string;
  evidence_identity: string;
  attempts_per_strategy: Record<string, number>;
  strategy_cursor: number;
  next_eligible_at: string;
  skipped_strategies: RecoveryRecipe[];
  fence_token?: string;
}

export interface RecoveryEpisodeKey {
  operation: string;
  invariant: string;
  candidate_epoch: string;
  evidence_identity: string;
}

export type SideEffectObserverResult = "known_complete" | "known_absent" | "uncertain";

export interface SelectStrategyInput {
  recipes: readonly RecoveryRecipe[];
  cursor: number;
  attemptsPerStrategy: Record<string, number>;
  strategyBound: (recipe: RecoveryRecipe) => number;
  isApplicable: (recipe: RecoveryRecipe) => boolean;
}

export type SelectStrategyResult =
  | { kind: "claim"; action: RecoveryRecipe; cursor: number; skipped: RecoveryRecipe[] }
  | { kind: "exhausted"; skipped: RecoveryRecipe[] };

export function recoveryEpisodeId(key: RecoveryEpisodeKey): string {
  const canonical = [
    "pipeline-recovery-episode@1",
    key.operation,
    key.invariant,
    key.candidate_epoch,
    key.evidence_identity,
  ].join("\0");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Same purity contract as {@link fingerprintEvidence}: incidental formatting
 *  does not change identity; material evidence does. Kept here to avoid a
 *  circular import with recovery.ts. */
export function normalizeEvidenceIdentity(evidence: string): string {
  const normalized = evidence
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hash>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function assertRecoveryEpisodeFields(
  record: Partial<RecoveryEpisodeRecord> | LoopRecoveryAttempt | null | undefined,
): asserts record is RecoveryEpisodeRecord {
  if (!record || typeof record !== "object") {
    throw new LoopError("validation", "Recovery Episode missing required fields: record is absent");
  }
  const missing: string[] = [];
  for (const field of RECOVERY_EPISODE_REQUIRED_FIELDS) {
    const value = (record as Record<string, unknown>)[field];
    if (value === undefined || value === null) missing.push(field);
  }
  if (missing.length > 0) {
    throw new LoopError("validation", `Recovery Episode missing required field(s): ${missing.join(", ")}`);
  }
}

export function isMechanicalLifecycleStopReason(reason: string | undefined): reason is MechanicalLifecycleStopReason {
  return (
    typeof reason === "string" &&
    (MECHANICAL_LIFECYCLE_STOP_REASONS as readonly string[]).includes(reason)
  );
}

export function assertNoMechanicalLifecycleStop(stop: LoopStopRecord | null | undefined): void {
  if (stop && isMechanicalLifecycleStopReason(stop.reason)) {
    throw new LoopError(
      "validation",
      `mechanical lifecycle stop "${stop.reason}" is not a live ownership terminal — persist Cooling or an external-condition wait`,
    );
  }
}

export function perStrategyBound(entry: RecoveryPolicyEntry, _recipe?: RecoveryRecipe): number {
  if (typeof entry.per_strategy_bound === "number" && Number.isFinite(entry.per_strategy_bound) && entry.per_strategy_bound >= 0) {
    return entry.per_strategy_bound;
  }
  return entry.retry_budget;
}

export function countChargedStrategyAttempts(
  attempts: readonly LoopRecoveryAttempt[],
  key: RecoveryEpisodeKey,
  recipe: RecoveryRecipe,
): number {
  return attempts.filter(
    (attempt) =>
      attempt.episode_id === recoveryEpisodeId(key) &&
      attempt.action === recipe &&
      attempt.outcome !== "skipped" &&
      attempt.outcome !== "superseded",
  ).length;
}

export function resumeEpisodeFromAttempts(
  attempts: readonly LoopRecoveryAttempt[],
  key: RecoveryEpisodeKey,
): RecoveryEpisodeRecord | null {
  const episodeId = recoveryEpisodeId(key);
  const matching = attempts.filter((attempt) => attempt.episode_id === episodeId);
  if (matching.length === 0) {
    const byFields = attempts.filter(
      (attempt) =>
        attempt.invariant === key.invariant &&
        attempt.candidate_epoch === key.candidate_epoch &&
        (attempt.evidence_identity ?? attempt.evidence_fingerprint) === key.evidence_identity,
    );
    if (byFields.length === 0) return null;
    return projectEpisode(byFields, key);
  }
  return projectEpisode(matching, key);
}

function projectEpisode(matching: LoopRecoveryAttempt[], key: RecoveryEpisodeKey): RecoveryEpisodeRecord {
  const latest = matching[matching.length - 1]!;
  const attempts_per_strategy: Record<string, number> = { ...(latest.attempts_per_strategy ?? {}) };
  const skipped: RecoveryRecipe[] = [];
  if (Object.keys(attempts_per_strategy).length === 0) {
    for (const attempt of matching) {
      if (attempt.outcome === "skipped") {
        skipped.push(attempt.action);
        continue;
      }
      if (attempt.outcome === "superseded") continue;
      attempts_per_strategy[attempt.action] = (attempts_per_strategy[attempt.action] ?? 0) + 1;
    }
  } else {
    for (const attempt of matching) {
      if (attempt.outcome === "skipped") skipped.push(attempt.action);
    }
  }
  return {
    episode_id: latest.episode_id ?? recoveryEpisodeId(key),
    operation: latest.operation ?? key.operation,
    invariant: latest.invariant ?? key.invariant,
    candidate_epoch: latest.candidate_epoch ?? key.candidate_epoch,
    evidence_identity: latest.evidence_identity ?? key.evidence_identity,
    attempts_per_strategy,
    strategy_cursor: latest.strategy_cursor ?? 0,
    next_eligible_at: latest.next_eligible_at ?? latest.not_before ?? latest.time,
    skipped_strategies: skipped,
    fence_token: latest.fence_token,
  };
}

export function emptyEpisode(key: RecoveryEpisodeKey, nextEligibleAt: string): RecoveryEpisodeRecord {
  return {
    episode_id: recoveryEpisodeId(key),
    operation: key.operation,
    invariant: key.invariant,
    candidate_epoch: key.candidate_epoch,
    evidence_identity: key.evidence_identity,
    attempts_per_strategy: {},
    strategy_cursor: 0,
    next_eligible_at: nextEligibleAt,
    skipped_strategies: [],
  };
}

export function selectNextApplicableStrategy(input: SelectStrategyInput): SelectStrategyResult {
  const skipped: RecoveryRecipe[] = [];
  let cursor = Math.max(0, input.cursor);
  while (cursor < input.recipes.length) {
    const recipe = input.recipes[cursor]!;
    if (!input.isApplicable(recipe)) {
      skipped.push(recipe);
      cursor += 1;
      continue;
    }
    const spent = input.attemptsPerStrategy[recipe] ?? 0;
    if (spent >= input.strategyBound(recipe)) {
      cursor += 1;
      continue;
    }
    return { kind: "claim", action: recipe, cursor, skipped };
  }
  return { kind: "exhausted", skipped };
}

export function coolingDeadline(nowIso: string, backoff: RecoveryBackoff, generation: number): string {
  const exp = Math.max(0, generation);
  const seconds = Math.min(
    backoff.max_seconds,
    backoff.initial_seconds * Math.pow(backoff.multiplier, exp),
  );
  return new Date(Date.parse(nowIso) + seconds * 1000).toISOString();
}

export function buildCoolingRecord(input: {
  reason: LoopCoolingRecord["reason"];
  time: string;
  nextEligibleAt: string;
  itemId?: string;
  theme?: string;
  historicalEvidence?: LoopCoolingRecord["historical_evidence"];
}): LoopCoolingRecord {
  return {
    reason: input.reason,
    time: input.time,
    next_eligible_at: input.nextEligibleAt,
    ...(input.itemId ? { item_id: input.itemId } : {}),
    ...(input.theme ? { theme: input.theme } : {}),
    ...(input.historicalEvidence ? { historical_evidence: input.historicalEvidence } : {}),
  };
}

export function coolingIsActive(cooling: LoopCoolingRecord | null | undefined, nowIso: string): boolean {
  if (!cooling) return false;
  if (!cooling.next_eligible_at) return true;
  return Date.parse(cooling.next_eligible_at) > Date.parse(nowIso);
}

/** Per-item Cooling, falling back to the run-level projection only when it names this item. */
export function coolingRecordForItem(
  ledger: Pick<LoopLedger, "cooling" | "item_cooling">,
  itemId: string,
): LoopCoolingRecord | null {
  const perItem = ledger.item_cooling?.[itemId];
  if (perItem) return perItem;
  if (ledger.cooling?.item_id === itemId) return ledger.cooling;
  return null;
}

/** Stamp `next_eligible_at` on every attempt that shares the item's latest episode id. */
export function stampEpisodeNextEligibleAt(
  attempts: readonly LoopRecoveryAttempt[],
  itemId: string,
  nextEligibleAt: string,
): LoopRecoveryAttempt[] {
  let episodeId: string | undefined;
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i]!.item_id === itemId && attempts[i]!.episode_id) {
      episodeId = attempts[i]!.episode_id;
      break;
    }
  }
  if (!episodeId) return [...attempts];
  return attempts.map((attempt) =>
    attempt.episode_id === episodeId ? { ...attempt, next_eligible_at: nextEligibleAt } : attempt,
  );
}

export function attachEpisodeFields(
  attempt: LoopRecoveryAttempt,
  episode: RecoveryEpisodeRecord,
  fenceToken?: string,
): LoopRecoveryAttempt {
  const next: LoopRecoveryAttempt = {
    ...attempt,
    episode_id: episode.episode_id,
    operation: episode.operation,
    invariant: episode.invariant,
    candidate_epoch: episode.candidate_epoch,
    evidence_identity: episode.evidence_identity,
    attempts_per_strategy: { ...episode.attempts_per_strategy },
    strategy_cursor: episode.strategy_cursor,
    next_eligible_at: episode.next_eligible_at,
    side_effect_certainty: attempt.side_effect_certainty ?? (attempt.outcome === "started" ? "uncertain" : attempt.side_effect_certainty),
  };
  if (fenceToken) next.fence_token = fenceToken;
  assertRecoveryEpisodeFields(next);
  return next;
}

export function applyClaimToEpisode(
  episode: RecoveryEpisodeRecord,
  recipe: RecoveryRecipe,
  nextEligibleAt: string,
): RecoveryEpisodeRecord {
  const attempts = { ...episode.attempts_per_strategy };
  attempts[recipe] = (attempts[recipe] ?? 0) + 1;
  return {
    ...episode,
    attempts_per_strategy: attempts,
    next_eligible_at: nextEligibleAt,
  };
}

export function applySkipToEpisode(
  episode: RecoveryEpisodeRecord,
  recipe: RecoveryRecipe,
  nextCursor: number,
): RecoveryEpisodeRecord {
  return {
    ...episode,
    strategy_cursor: nextCursor,
    skipped_strategies: [...episode.skipped_strategies, recipe],
  };
}

export function advanceCursor(episode: RecoveryEpisodeRecord, nextCursor: number, nextEligibleAt: string): RecoveryEpisodeRecord {
  return {
    ...episode,
    strategy_cursor: nextCursor,
    next_eligible_at: nextEligibleAt,
  };
}

export function sameEpisodeKey(a: RecoveryEpisodeKey, b: RecoveryEpisodeKey): boolean {
  return (
    a.operation === b.operation &&
    a.invariant === b.invariant &&
    a.candidate_epoch === b.candidate_epoch &&
    a.evidence_identity === b.evidence_identity
  );
}

export function episodeKeyFromAttempt(attempt: LoopRecoveryAttempt, fallbackOperation = "loop_recovery"): RecoveryEpisodeKey {
  return {
    operation: attempt.operation ?? fallbackOperation,
    invariant: attempt.invariant ?? attempt.class,
    candidate_epoch: attempt.candidate_epoch ?? attempt.candidate_identity,
    evidence_identity: attempt.evidence_identity ?? attempt.evidence_fingerprint,
  };
}

export function reconcileUncertainClaim(
  certainty: SideEffectObserverResult,
): "reconcile_forward" | "replay" | "wait" {
  if (certainty === "known_complete") return "reconcile_forward";
  if (certainty === "known_absent") return "replay";
  return "wait";
}

export function isTempWriteBasename(name: string): boolean {
  return name.endsWith(".tmp") || /(^|\.)[0-9a-f-]{8,}\.tmp$/i.test(name);
}

export function lastValidPathFor(publishedPath: string): string {
  return `${publishedPath}.last-valid`;
}

export function quarantinePathFor(publishedPath: string, nowIso: string): string {
  const stamp = nowIso.replace(/[:.]/g, "-");
  return `${publishedPath}.quarantine.${stamp}`;
}

export function competingPrivateEpisodePath(runDirectory: string): string {
  return `${runDirectory.replace(/\/$/, "")}/${PRIVATE_EPISODE_SCHEMA_BASENAME}`;
}

/** True when a live ledger.stop would illegally end ownership for a mechanical class. */
export function liveStopEndsOwnershipIllegally(stop: LoopStopRecord | null | undefined): boolean {
  return !!stop && isMechanicalLifecycleStopReason(stop.reason);
}

export function chargedAttemptsForStrategy(episode: RecoveryEpisodeRecord, recipe: RecoveryRecipe): number {
  return episode.attempts_per_strategy[recipe] ?? 0;
}

export function classWideRemainingProjection(
  classRemaining: number,
  chargedThisClaim: boolean,
): number {
  if (!chargedThisClaim) return classRemaining;
  return Math.max(0, classRemaining - 1);
}
