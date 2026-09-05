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
  isDurableBlockerClass,
  isRecoveryRecipe,
  type DurableBlockerClass,
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

/** True when a recovery attempt is keyed to `candidateEpoch` (HEAD SHA or `head=` identity). */
export function attemptBelongsToCandidateEpoch(
  attempt: { candidate_epoch?: string | null; candidate_identity?: string | null },
  candidateEpoch: string,
): boolean {
  const wanted = candidateEpoch.trim().toLowerCase();
  if (!wanted) return false;
  const epoch = (attempt.candidate_epoch ?? "").trim().toLowerCase();
  if (epoch === wanted) return true;
  if (epoch.includes(`head=${wanted}`)) return true;
  const identity = (attempt.candidate_identity ?? "").toLowerCase();
  return identity.includes(`head=${wanted}`);
}

/**
 * True when Cooling was recorded under a previous candidate epoch. A new HEAD
 * must not inherit S-episode exhaustion or Cooling as authority to skip review.
 */
export function coolingIsStaleForNewCandidateEpoch(
  cooling: LoopCoolingRecord | null | undefined,
  attempts: readonly Pick<
    LoopRecoveryAttempt,
    "item_id" | "candidate_epoch" | "candidate_identity" | "time" | "next_eligible_at"
  >[],
  itemId: string | undefined,
  candidateEpoch: string,
  candidateHead = candidateEpoch,
): boolean {
  if (!cooling || !itemId) return false;
  if (cooling.item_id && cooling.item_id !== itemId) return false;
  const wanted = candidateEpoch.trim();
  if (!wanted) return false;
  // New records bind Cooling directly to the epoch that created it. Do not
  // infer ownership from the latest attempt: once an H attempt is appended,
  // that inference would incorrectly make S-era Cooling current for H again.
  if (cooling.candidate_epoch) {
    return !attemptBelongsToCandidateEpoch(
      { candidate_epoch: cooling.candidate_epoch },
      wanted,
    );
  }
  // Backward compatibility for ledgers written before candidate_epoch was
  // persisted on Cooling. Bind to evidence that existed when Cooling was
  // created, never to the latest attempt: a later H attempt must not transfer
  // S-era Cooling authority onto H. If old evidence cannot identify an owner,
  // retain Cooling (fail closed against duplicate recovery) until its deadline.
  const coolingTime = Date.parse(cooling.time);
  const owner = [...attempts].reverse().find((attempt) => {
    if (attempt.item_id !== itemId) return false;
    if (cooling.next_eligible_at && attempt.next_eligible_at === cooling.next_eligible_at) return true;
    const attemptTime = Date.parse(attempt.time);
    return Number.isFinite(coolingTime) && Number.isFinite(attemptTime) && attemptTime <= coolingTime;
  });
  if (!owner) return false;
  // Legacy attempts predate logical epochs and identify their owner by the
  // raw observed HEAD. Compare them with the current raw HEAD so upgrading at
  // an internal-only tip does not invalidate an otherwise-current backoff.
  return !attemptBelongsToCandidateEpoch(owner, candidateHead.trim());
}

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

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Default configured recipe order and per-strategy bound per blocker class.
 * Must stay equal to {@link DEFAULT_RECOVERY_POLICY} recipes / retry_budget
 * (drift-guarded in recovery-episodes.test.ts). Used when validating a
 * ledger without the contract's compiled policy.
 */
const CLASS_RECOVERY_SEQUENCE: Record<DurableBlockerClass, { recipes: readonly RecoveryRecipe[]; bound: number }> = {
  "transient-rate-limit": { recipes: ["wait_and_retry"], bound: 5 },
  "workflow-state": { recipes: ["resync_workflow_state", "repair_pipeline_item"], bound: 3 },
  "implementation-ci": { recipes: ["verify_head_goal", "rerun_ci", "repair_pipeline_item"], bound: 3 },
  "review-findings": { recipes: ["unlink_engine_scratch", "repair_pipeline_item"], bound: 3 },
  "environment-auth": { recipes: ["verify_authentication"], bound: 2 },
  "specification-decision": { recipes: [], bound: 0 },
  "missing-authority": { recipes: [], bound: 0 },
  "upstream-dependency": { recipes: ["retry_upstream_check"], bound: 3 },
  "workflow-engine-defect": {
    recipes: [
      "unlink_engine_scratch",
      "checkpoint_owned_harness_dirt",
      "publish_unpublished_stage_commit",
      "restart_workflow_engine",
      "repair_pipeline_item",
    ],
    bound: 2,
  },
};

/** Configured recipe sequence and per-strategy bound for a blocker class. */
export function configuredRecoverySequence(
  blockerClass: unknown,
): { recipes: readonly RecoveryRecipe[]; bound: number } | undefined {
  if (!isDurableBlockerClass(blockerClass)) return undefined;
  return CLASS_RECOVERY_SEQUENCE[blockerClass];
}

function collectSkippedRecipes(
  value: Record<string, unknown>,
  history: readonly Record<string, unknown>[],
): Set<string> | null {
  const skipped = new Set<string>();
  if (value.skipped_strategies !== undefined) {
    if (!Array.isArray(value.skipped_strategies)) return null;
    if (!value.skipped_strategies.every((recipe) => isRecoveryRecipe(recipe))) return null;
    if (
      typeof value.strategy_cursor === "number" &&
      value.skipped_strategies.length > value.strategy_cursor
    ) {
      return null;
    }
    for (const recipe of value.skipped_strategies) skipped.add(recipe);
  }
  const rows = history.length > 0 ? history : [value];
  for (const row of rows) {
    if (value.episode_id != null && row.episode_id !== value.episode_id) continue;
    if (row.outcome === "skipped" && isRecoveryRecipe(row.action)) skipped.add(row.action);
  }
  return skipped;
}

function derivedAttemptCounts(
  episodeId: unknown,
  history: readonly Record<string, unknown>[],
): Record<string, number> {
  const derived: Record<string, number> = {};
  for (const sibling of history) {
    if (sibling.episode_id !== episodeId) continue;
    if (!isRecoveryRecipe(sibling.action)) continue;
    if (sibling.outcome === "skipped" || sibling.outcome === "superseded") continue;
    derived[sibling.action] = (derived[sibling.action] ?? 0) + 1;
  }
  return derived;
}

function countsMatchPersisted(
  persisted: Record<string, unknown>,
  derived: Record<string, number>,
): boolean {
  const keys = new Set([...Object.keys(persisted), ...Object.keys(derived)]);
  for (const recipe of keys) {
    const claimed = persisted[recipe];
    const actual = derived[recipe] ?? 0;
    if ((typeof claimed === "number" ? claimed : 0) !== actual) return false;
  }
  return true;
}

function numericCounts(persisted: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [recipe, count] of Object.entries(persisted)) {
    if (typeof count === "number") counts[recipe] = count;
  }
  return counts;
}

/** Prefix-proof cursor: every recipe below the cursor is skipped or bound-exhausted.
 *  A later recipe's attempts cannot justify skipping an unaccounted predecessor. */
function justifiedStrategyCursor(
  recipes: readonly RecoveryRecipe[],
  bound: number,
  counts: Record<string, number>,
  skipped: Set<string>,
): number {
  for (let i = 0; i < recipes.length; i++) {
    const recipe = recipes[i]!;
    const spent = counts[recipe] ?? 0;
    if (skipped.has(recipe) || (bound > 0 && spent >= bound)) continue;
    return i;
  }
  return recipes.length;
}

function sequenceFullyAccounted(
  recipes: readonly RecoveryRecipe[],
  bound: number,
  counts: Record<string, number>,
  skipped: Set<string>,
): boolean {
  for (const recipe of recipes) {
    if (skipped.has(recipe)) continue;
    const spent = counts[recipe] ?? 0;
    if (bound > 0 && spent >= bound) continue;
    return false;
  }
  return true;
}

/** Relational Recovery Episode checks used before a ledger is live authority.
 *  Primitive field presence is not enough: forged `episode_id`, cursor, or
 *  `attempts_per_strategy` counts must not be accepted. A cursor must be
 *  justified by the class-configured recipe sequence — every predecessor
 *  exhausted or skipped, never a terminal cursor with empty counters. */
export function isAuthoritativeEpisodeState(
  value: Record<string, unknown>,
  siblings: readonly Record<string, unknown>[] = [],
): boolean {
  if (!isNonEmptyText(value.operation)) return false;
  if (!isNonEmptyText(value.invariant)) return false;
  if (typeof value.candidate_epoch !== "string") return false;
  if (typeof value.evidence_identity !== "string") return false;
  if (!isNonEmptyText(value.episode_id)) return false;
  const expectedId = recoveryEpisodeId({
    operation: value.operation,
    invariant: value.invariant,
    candidate_epoch: value.candidate_epoch,
    evidence_identity: value.evidence_identity,
  });
  if (value.episode_id !== expectedId) return false;
  if (typeof value.strategy_cursor !== "number" || !Number.isInteger(value.strategy_cursor) || value.strategy_cursor < 0) {
    return false;
  }
  const sequence = configuredRecoverySequence(value.class) ?? configuredRecoverySequence(value.invariant);
  if (!sequence) return false;
  if (value.strategy_cursor > sequence.recipes.length) return false;
  const skipped = collectSkippedRecipes(value, siblings);
  if (skipped === null) return false;
  if (typeof value.attempts_per_strategy !== "object" || value.attempts_per_strategy === null || Array.isArray(value.attempts_per_strategy)) {
    return false;
  }
  const persisted = value.attempts_per_strategy as Record<string, unknown>;
  for (const [recipe, count] of Object.entries(persisted)) {
    if (!isRecoveryRecipe(recipe)) return false;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return false;
  }
  let counts = numericCounts(persisted);
  // Derived counts skip superseded rows. A superseded latest is a frozen closed
  // claim — matching those derived counts against this snapshot would reject it.
  if (siblings.length > 0 && value.outcome !== "superseded") {
    const derived = derivedAttemptCounts(value.episode_id, siblings);
    if (!countsMatchPersisted(persisted, derived)) return false;
    counts = derived;
  }
  if (value.strategy_cursor > justifiedStrategyCursor(sequence.recipes, sequence.bound, counts, skipped)) {
    return false;
  }
  if (
    value.strategy_cursor === sequence.recipes.length &&
    !sequenceFullyAccounted(sequence.recipes, sequence.bound, counts, skipped)
  ) {
    return false;
  }
  return true;
}

export function ledgerEpisodesAreAuthoritative(attempts: readonly Record<string, unknown>[]): boolean {
  const latestByEpisode = new Map<string, Record<string, unknown>>();
  for (const attempt of attempts) {
    if (typeof attempt.episode_id !== "string" || attempt.episode_id.length === 0) continue;
    latestByEpisode.set(attempt.episode_id, attempt);
  }
  for (const latest of latestByEpisode.values()) {
    if (!isAuthoritativeEpisodeState(latest, attempts)) return false;
  }
  return true;
}

/** Same purity contract as {@link fingerprintEvidence}: incidental formatting
 *  (whitespace, case) and explicitly identified incidental tokens (ISO
 *  timestamps, UUIDs, request IDs, git/hex hashes) do not change identity.
 *  Semantic values such as HTTP status and error codes are preserved. Kept
 *  here to avoid a circular import with recovery.ts. */
export function normalizeEvidenceIdentity(evidence: string): string {
  const normalized = evidence
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:\d{2})?/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
    .replace(/\b(?:x-request-id|x-github-request-id|request[-_]?id)[=:\s]+[0-9a-z._:-]+/g, "<reqid>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hash>")
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
        attempt.operation === key.operation &&
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
  candidateEpoch?: string;
  historicalEvidence?: LoopCoolingRecord["historical_evidence"];
  quarantinePath?: string;
}): LoopCoolingRecord {
  return {
    reason: input.reason,
    time: input.time,
    next_eligible_at: input.nextEligibleAt,
    ...(input.itemId ? { item_id: input.itemId } : {}),
    ...(input.theme ? { theme: input.theme } : {}),
    ...(input.candidateEpoch ? { candidate_epoch: input.candidateEpoch } : {}),
    ...(input.historicalEvidence ? { historical_evidence: input.historicalEvidence } : {}),
    ...(input.quarantinePath ? { quarantine_path: input.quarantinePath } : {}),
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
    skipped_strategies: [...episode.skipped_strategies],
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

const EPISODE_KEY_FIELDS = ["operation", "invariant", "candidate_epoch", "evidence_identity"] as const;

/** Rejects absent or partial keys so claim and treatment cannot default apart. */
export function assertCompleteRecoveryEpisodeKey(
  key: RecoveryEpisodeKey | null | undefined,
  context: string,
): RecoveryEpisodeKey {
  if (!key || typeof key !== "object") {
    throw new LoopError("validation", `${context} requires a complete RecoveryEpisodeKey`);
  }
  const missing = EPISODE_KEY_FIELDS.filter((field) => typeof key[field] !== "string" || key[field].trim() === "");
  if (missing.length > 0) {
    throw new LoopError(
      "validation",
      `${context} requires a complete RecoveryEpisodeKey (missing ${missing.join(", ")})`,
    );
  }
  return key;
}

export function assertCursorDoesNotRegress(previous: number, next: number): number {
  if (!Number.isFinite(next) || next < 0) {
    throw new LoopError("validation", `strategy cursor must be a non-negative number, got ${String(next)}`);
  }
  if (next < previous) {
    throw new LoopError("validation", `strategy cursor cannot regress from ${previous} to ${next}`);
  }
  return next;
}

/** Theme stamped on Cooling when a durable generation cannot be reconstructed. */
export const DURABLE_GENERATION_QUARANTINE_THEME = "durable_generation_quarantine";

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
