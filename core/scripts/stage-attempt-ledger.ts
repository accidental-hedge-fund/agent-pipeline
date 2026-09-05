// Stage-attempt ledger (#759) — sole production authority for stage-local
// recovery one-shots (CI recovery, conflict rebase, autofix, OpenSpec repair,
// rematerialize, no-run recovery). Extends the #787 recovery-attempt record
// family rather than inventing a second schema: same identity fields, outcome
// lifecycle, budget charging, not_before eligibility, and claim-before-side-
// effect semantics. Callers MUST read/write attempts only through this API.
//
// Boundary: #761/#787 own scheduling and recipe execution. This module owns
// authoritative attempt state consolidation for stage-local recoveries.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RecoveryAttemptOutcome, RecoveryRecipe } from "./loop/types.ts";
import { recoveryAttemptId } from "./loop/recovery.ts";

// ---------------------------------------------------------------------------
// Stage actions + record family
// ---------------------------------------------------------------------------

/** Closed catalogue of stage-local recovery actions keyed with head SHA. */
export const STAGE_ACTIONS = [
  "ci_rebase",
  "ci_rerun",
  "ci_archive_fail_recovery",
  "ci_assertion_fix",
  "ci_docs_stale_heal",
  "conflict_rebase",
  /** Bounded conflict resolution after a clean auto-rebase miss (#1065). */
  "conflict_resolve",
  "pre_merge_autofix",
  "openspec_repair",
  "worktree_rematerialize",
  "no_run_recovery",
] as const;

export type StageAction = (typeof STAGE_ACTIONS)[number];

export function isStageAction(value: unknown): value is StageAction {
  return typeof value === "string" && (STAGE_ACTIONS as readonly string[]).includes(value);
}

/**
 * Attempt lifecycle status. Aligns with {@link RecoveryAttemptOutcome}:
 * `completed` maps to recovered/success terminal; `failed` / `superseded` /
 * `exhausted` match the recovery family.
 */
export type StageAttemptStatus =
  | "started"
  | "completed"
  | "failed"
  | "superseded"
  | "exhausted";

/** Terminal outcomes for a started attempt after reconcile. */
export type StageTerminalOutcome = "success" | "failed" | "superseded";

/**
 * One durable stage attempt. Field set is the recovery-attempt family with
 * stage-required extensions (head_sha, typed_reason, status, terminal_outcome,
 * next_attempt_at, idempotency_key). When a durable loop is present, supervisor
 * claims share identity via item_id + candidate_identity + evidence_fingerprint
 * + action.
 */
export interface StageAttemptRecord {
  /** Stable idempotency key — same string as `idempotency_key`. */
  attempt_id: string;
  idempotency_key: string;
  seq: number;
  time: string;
  /** Earliest eligibility time (recovery-family `not_before`). */
  not_before?: string;
  /** Alias of `not_before` for operator visibility (#759 upsert). */
  next_attempt_at?: string;
  completed_at?: string;
  /** Issue/item id when supervisor-shared; optional for raw advance. */
  item_id?: string;
  /** Durable blocker class when bound to supervisor recovery. */
  class?: string;
  /** Concrete candidate identity (head SHA or richer candidate key). */
  candidate_identity: string;
  /** PR head SHA binding for stage one-shots. */
  head_sha: string;
  action: StageAction;
  /** Recovery-family projection when mapped to a controller recipe. */
  recovery_action?: RecoveryRecipe;
  actions: StageAction[];
  evidence_fingerprint?: string;
  /** Recovery-family outcome field (started | recovered-as-completed | …). */
  outcome: StageAttemptStatus | RecoveryAttemptOutcome;
  /** Explicit action status (mirrors outcome for stage consumers). */
  status: StageAttemptStatus;
  terminal_outcome?: StageTerminalOutcome;
  /** Closed typed reason (#760 vocabulary when available). */
  typed_reason?: string;
  budget_remaining: number;
  /** Bounded non-sensitive last error (recovery-family `error`). */
  error?: string;
  last_error?: string;
  invariant?: string;
  candidate_epoch?: string;
  evidence_role?: "planning" | "implementation";
  artifact_identity?: string;
  evidence_identity?: string;
  attempts_per_strategy?: Record<string, number>;
  strategy_cursor?: number;
  next_eligible_at?: string;
  episode_id?: string;
}

export const STAGE_ATTEMPT_LEDGER_SCHEMA = 1 as const;

export interface StageAttemptLedger {
  schema_version: typeof STAGE_ATTEMPT_LEDGER_SCHEMA;
  attempts: StageAttemptRecord[];
  /**
   * Pre-archive PR head retained as diagnostic evidence (migrated from
   * legacy `pre-merge-ci-recovery.json`). Not an attempt authority.
   */
  preArchiveSha?: string;
  /**
   * Head SHAs for which a terminal ci/fail gate_result was already recorded
   * (#771). Diagnostic/idempotency for gate_result spam — not a recovery action.
   */
  ciTerminalFailRecordedShas?: string[];
}

export const STAGE_ATTEMPT_LEDGER_FILE = "stage-attempt-ledger.json";
/** Legacy host-local authority file — read once for migration only. */
export const LEGACY_CI_RECOVERY_MARKERS_FILE = "pre-merge-ci-recovery.json";

// ---------------------------------------------------------------------------
// Deps (injectable I/O)
// ---------------------------------------------------------------------------

export interface StageAttemptLedgerDeps {
  now?: () => Date;
  readText?: (filePath: string) => string | null;
  writeText?: (filePath: string, content: string) => void;
  mkdirp?: (dir: string) => void;
}

const defaultDeps: Required<StageAttemptLedgerDeps> = {
  now: () => new Date(),
  readText: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  writeText: (filePath, content) => {
    fs.writeFileSync(filePath, content, "utf8");
  },
  mkdirp: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
};

function resolveDeps(deps: StageAttemptLedgerDeps = {}): Required<StageAttemptLedgerDeps> {
  return {
    now: deps.now ?? defaultDeps.now,
    readText: deps.readText ?? defaultDeps.readText,
    writeText: deps.writeText ?? defaultDeps.writeText,
    mkdirp: deps.mkdirp ?? defaultDeps.mkdirp,
  };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Deterministic attempt id for stage one-shots keyed `(headSha, action)`.
 * When item/evidence bindings are present, delegates to the shared recovery
 * attempt-id formula so child-stage and supervisor claims share identity space.
 */
export function stageAttemptId(input: {
  headSha: string;
  action: StageAction;
  itemId?: string;
  candidateIdentity?: string;
  evidenceFingerprint?: string;
  recoveryAction?: RecoveryRecipe;
}): string {
  const head = input.headSha.trim().toLowerCase();
  const itemId = input.itemId?.trim();
  const evidence = input.evidenceFingerprint ?? "";
  if (itemId && input.recoveryAction) {
    return recoveryAttemptId({
      itemId,
      candidateIdentity: input.candidateIdentity?.trim() || head,
      evidenceFingerprint: evidence,
      action: input.recoveryAction,
    });
  }
  const canonical = [
    "pipeline-stage-attempt@1",
    head,
    input.action,
    itemId ?? "",
    input.candidateIdentity?.trim() || head,
    evidence,
  ].join("\0");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function emptyStageAttemptLedger(): StageAttemptLedger {
  return { schema_version: STAGE_ATTEMPT_LEDGER_SCHEMA, attempts: [] };
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

/** True when the attempt already charges budget / blocks free re-fire. */
export function isAttemptCharged(status: StageAttemptStatus | string): boolean {
  return (
    status === "started" ||
    status === "completed" ||
    status === "failed" ||
    status === "exhausted" ||
    status === "recovered" ||
    status === "repeated_no_progress" ||
    status === "needs_human" ||
    status === "human_authority"
  );
}

/** True when hasAttempted should treat the action as already consumed for head. */
export function hasAttemptedStatus(status: StageAttemptStatus | string): boolean {
  // Superseded frees the key for a new head lineage; charged/terminal outcomes block re-fire.
  return isAttemptCharged(status) && status !== "superseded";
}

function normalizeStatus(outcome: string | undefined, status?: string): StageAttemptStatus {
  const raw = status || outcome || "started";
  if (raw === "recovered") return "completed";
  if (
    raw === "started" ||
    raw === "completed" ||
    raw === "failed" ||
    raw === "superseded" ||
    raw === "exhausted"
  ) {
    return raw;
  }
  if (raw === "repeated_no_progress" || raw === "needs_human" || raw === "human_authority") {
    return "failed";
  }
  return "started";
}

// ---------------------------------------------------------------------------
// Hydration / persistence
// ---------------------------------------------------------------------------

export function stageAttemptLedgerPath(runDir: string): string {
  return path.join(runDir, STAGE_ATTEMPT_LEDGER_FILE);
}

export function legacyCiRecoveryMarkersPath(runDir: string): string {
  return path.join(runDir, LEGACY_CI_RECOVERY_MARKERS_FILE);
}

export type HydrateLedgerResult =
  | { ok: true; ledger: StageAttemptLedger; migratedFromLegacy: boolean }
  | { ok: false; reason: string };

function parseLedgerJson(raw: string): StageAttemptLedger | null {
  try {
    const parsed = JSON.parse(raw) as StageAttemptLedger;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.schema_version !== STAGE_ATTEMPT_LEDGER_SCHEMA) return null;
    if (!Array.isArray(parsed.attempts)) return null;
    return {
      schema_version: STAGE_ATTEMPT_LEDGER_SCHEMA,
      attempts: parsed.attempts.filter(isValidAttemptRecord),
      preArchiveSha:
        typeof parsed.preArchiveSha === "string" && parsed.preArchiveSha.length > 0
          ? parsed.preArchiveSha
          : undefined,
      ciTerminalFailRecordedShas: Array.isArray(parsed.ciTerminalFailRecordedShas)
        ? parsed.ciTerminalFailRecordedShas.filter(
            (s): s is string => typeof s === "string" && s.length > 0,
          )
        : undefined,
    };
  } catch {
    return null;
  }
}

function isValidAttemptRecord(value: unknown): value is StageAttemptRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as StageAttemptRecord;
  return (
    typeof r.attempt_id === "string" &&
    typeof r.head_sha === "string" &&
    isStageAction(r.action) &&
    typeof r.status === "string" &&
    typeof r.budget_remaining === "number"
  );
}

/** Legacy `pre-merge-ci-recovery.json` shape (migration input only). */
export interface LegacyCiRecoveryMarkers {
  preArchiveSha?: string;
  ciRebaseAttemptedShas?: string[];
  ciRerunAttemptedShas?: string[];
  ciArchiveFailRecoveryAttemptedShas?: string[];
  ciAssertionFixAttemptedShas?: string[];
  ciDocsStaleHealAttemptedShas?: string[];
  ciTerminalFailRecordedShas?: string[];
  ciRebaseAttemptedForSha?: string;
  ciRerunAttemptedForSha?: string;
  ciArchiveFailRecoveryAttemptedForSha?: string;
  ciAssertionFixAttemptedForSha?: string;
  ciTerminalFailRecordedForSha?: string;
}

function asShaList(set: string[] | undefined, scalar: string | undefined): string[] {
  const out: string[] = [];
  for (const s of set ?? []) {
    if (typeof s === "string" && s.length > 0 && !out.includes(s)) out.push(s);
  }
  if (typeof scalar === "string" && scalar.length > 0 && !out.includes(scalar)) out.push(scalar);
  return out;
}

/**
 * Project legacy CI recovery markers into stage attempt records (completed).
 * Pure — does not write. Terminal-fail SHAs are not attempt actions.
 */
export function migrateLegacyCiMarkersToAttempts(
  markers: LegacyCiRecoveryMarkers,
  nowIso: string,
): {
  attempts: StageAttemptRecord[];
  preArchiveSha?: string;
  ciTerminalFailRecordedShas?: string[];
} {
  const attempts: StageAttemptRecord[] = [];
  let seq = 0;
  const push = (headSha: string, action: StageAction) => {
    const attempt_id = stageAttemptId({ headSha, action });
    if (attempts.some((a) => a.attempt_id === attempt_id)) return;
    attempts.push({
      attempt_id,
      idempotency_key: attempt_id,
      seq: seq++,
      time: nowIso,
      completed_at: nowIso,
      candidate_identity: headSha,
      head_sha: headSha,
      action,
      actions: [action],
      outcome: "completed",
      status: "completed",
      terminal_outcome: "success",
      typed_reason: "migrated_from_legacy_ci_recovery_json",
      budget_remaining: 0,
    });
  };
  for (const sha of asShaList(markers.ciRebaseAttemptedShas, markers.ciRebaseAttemptedForSha)) {
    push(sha, "ci_rebase");
  }
  for (const sha of asShaList(markers.ciRerunAttemptedShas, markers.ciRerunAttemptedForSha)) {
    push(sha, "ci_rerun");
  }
  for (const sha of asShaList(
    markers.ciArchiveFailRecoveryAttemptedShas,
    markers.ciArchiveFailRecoveryAttemptedForSha,
  )) {
    push(sha, "ci_archive_fail_recovery");
  }
  for (const sha of asShaList(
    markers.ciAssertionFixAttemptedShas,
    markers.ciAssertionFixAttemptedForSha,
  )) {
    push(sha, "ci_assertion_fix");
  }
  for (const sha of asShaList(markers.ciDocsStaleHealAttemptedShas, undefined)) {
    push(sha, "ci_docs_stale_heal");
  }
  const preArchiveSha =
    typeof markers.preArchiveSha === "string" && markers.preArchiveSha.length > 0
      ? markers.preArchiveSha
      : undefined;
  const terminal = asShaList(
    markers.ciTerminalFailRecordedShas,
    markers.ciTerminalFailRecordedForSha,
  );
  return {
    attempts,
    preArchiveSha,
    ciTerminalFailRecordedShas: terminal.length > 0 ? terminal : undefined,
  };
}

/**
 * Hydrate the stage-attempt ledger from runDir. Prefer `stage-attempt-ledger.json`.
 * When absent, migrate once from legacy `pre-merge-ci-recovery.json` (read-only).
 * Corrupt primary ledger → fail closed.
 */
export function hydrateStageAttemptLedger(
  runDir: string | undefined,
  deps: StageAttemptLedgerDeps = {},
  opts?: {
    /** Additional attestation inputs (GH comments / commit subjects) already
     *  reduced to attempt records by the caller. */
    attestationAttempts?: StageAttemptRecord[];
  },
): HydrateLedgerResult {
  if (!runDir) {
    const ledger = emptyStageAttemptLedger();
    mergeAttestations(ledger, opts?.attestationAttempts);
    return { ok: true, ledger, migratedFromLegacy: false };
  }
  const d = resolveDeps(deps);
  const primaryPath = stageAttemptLedgerPath(runDir);
  let primaryRaw: string | null;
  try {
    primaryRaw = d.readText(primaryPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `stage-attempt ledger unreadable: ${msg}` };
  }

  if (primaryRaw !== null) {
    const parsed = parseLedgerJson(primaryRaw);
    if (!parsed) {
      return {
        ok: false,
        reason:
          "stage-attempt ledger is corrupt/unparseable; refusing empty budget that would re-open recovery",
      };
    }
    mergeAttestations(parsed, opts?.attestationAttempts);
    return { ok: true, ledger: parsed, migratedFromLegacy: false };
  }

  // Migration path: legacy CI recovery JSON only.
  const legacyPath = legacyCiRecoveryMarkersPath(runDir);
  let legacyRaw: string | null;
  try {
    legacyRaw = d.readText(legacyPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `legacy CI recovery markers unreadable: ${msg}` };
  }

  const ledger = emptyStageAttemptLedger();
  let migratedFromLegacy = false;
  if (legacyRaw !== null) {
    try {
      const markers = JSON.parse(legacyRaw) as LegacyCiRecoveryMarkers;
      if (!markers || typeof markers !== "object" || Array.isArray(markers)) {
        return {
          ok: false,
          reason:
            "legacy CI recovery markers file is malformed (not a JSON object); refusing empty budget",
        };
      }
      const nowIso = d.now().toISOString();
      const migrated = migrateLegacyCiMarkersToAttempts(markers, nowIso);
      ledger.attempts.push(...migrated.attempts);
      if (migrated.preArchiveSha) ledger.preArchiveSha = migrated.preArchiveSha;
      if (migrated.ciTerminalFailRecordedShas?.length) {
        ledger.ciTerminalFailRecordedShas = migrated.ciTerminalFailRecordedShas;
      }
      migratedFromLegacy = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: `legacy CI recovery markers file is corrupt/unparseable: ${msg}`,
      };
    }
  }
  mergeAttestations(ledger, opts?.attestationAttempts);
  return { ok: true, ledger, migratedFromLegacy };
}

function mergeAttestations(
  ledger: StageAttemptLedger,
  attestation: StageAttemptRecord[] | undefined,
): void {
  if (!attestation?.length) return;
  for (const incoming of attestation) {
    if (!isValidAttemptRecord(incoming)) continue;
    const existing = ledger.attempts.find((a) => a.attempt_id === incoming.attempt_id);
    if (!existing) {
      ledger.attempts.push(incoming);
      continue;
    }
    // GitHub-attested terminal outcomes win over incomplete host-local state.
    const incomingTerminal =
      hasAttemptedStatus(incoming.status) && incoming.status !== "started";
    const existingOnlyStarted = existing.status === "started";
    if (incomingTerminal && existingOnlyStarted) {
      Object.assign(existing, incoming);
    }
  }
}

export type PersistLedgerResult = { ok: true } | { ok: false; reason: string };

/**
 * Persist the stage-attempt ledger atomically (temp + rename + read-back).
 * Does NOT write legacy `pre-merge-ci-recovery.json` (authority retirement).
 */
export function persistStageAttemptLedger(
  runDir: string | undefined,
  ledger: StageAttemptLedger,
  deps: StageAttemptLedgerDeps = {},
): PersistLedgerResult {
  if (!runDir) {
    return { ok: false, reason: "runDir unavailable; cannot persist stage-attempt ledger" };
  }
  const d = resolveDeps(deps);
  const filePath = stageAttemptLedgerPath(runDir);
  const tmpPath = path.join(
    runDir,
    `.${STAGE_ATTEMPT_LEDGER_FILE}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    d.mkdirp(runDir);
    const content =
      JSON.stringify(
        {
          schema_version: STAGE_ATTEMPT_LEDGER_SCHEMA,
          attempts: ledger.attempts,
          ...(ledger.preArchiveSha ? { preArchiveSha: ledger.preArchiveSha } : {}),
          ...(ledger.ciTerminalFailRecordedShas?.length
            ? { ciTerminalFailRecordedShas: ledger.ciTerminalFailRecordedShas }
            : {}),
        },
        null,
        2,
      ) + "\n";
    d.writeText(tmpPath, content);
    // Atomic replace when on real fs; for injected writeText, write primary path.
    if (d.writeText === defaultDeps.writeText) {
      fs.renameSync(tmpPath, filePath);
      const raw = fs.readFileSync(filePath, "utf8");
      if (!parseLedgerJson(raw)) {
        return { ok: false, reason: "stage-attempt ledger read-back was not a valid ledger" };
      }
    } else {
      d.writeText(filePath, content);
      try {
        d.writeText(tmpPath, ""); // allow cleanup no-op
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  } catch (err) {
    try {
      if (d.writeText === defaultDeps.writeText) fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort */
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `failed to persist stage-attempt ledger: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Read / write API
// ---------------------------------------------------------------------------

export function findAttempt(
  ledger: StageAttemptLedger,
  headSha: string,
  action: StageAction,
  opts?: { itemId?: string; evidenceFingerprint?: string; recoveryAction?: RecoveryRecipe },
): StageAttemptRecord | undefined {
  const id = stageAttemptId({
    headSha,
    action,
    itemId: opts?.itemId,
    evidenceFingerprint: opts?.evidenceFingerprint,
    recoveryAction: opts?.recoveryAction,
  });
  return ledger.attempts.find((a) => a.attempt_id === id);
}

/** Whether `(headSha, action)` has a charged/completed attempt (not superseded). */
export function hasAttempted(
  ledger: StageAttemptLedger,
  headSha: string,
  action: StageAction,
  opts?: { itemId?: string; evidenceFingerprint?: string; recoveryAction?: RecoveryRecipe },
): boolean {
  const attempt = findAttempt(ledger, headSha, action, opts);
  if (!attempt) return false;
  return hasAttemptedStatus(attempt.status) || hasAttemptedStatus(String(attempt.outcome));
}

/** Project charged head SHAs for a stage action (CI gate SHA-set cache). */
export function attemptedShasForAction(
  ledger: StageAttemptLedger,
  action: StageAction,
): string[] {
  const out: string[] = [];
  for (const a of ledger.attempts) {
    if (a.action !== action) continue;
    if (!hasAttemptedStatus(a.status) && !hasAttemptedStatus(String(a.outcome))) continue;
    if (a.head_sha && !out.includes(a.head_sha)) out.push(a.head_sha);
  }
  return out;
}

export interface ClaimStageAttemptInput {
  headSha: string;
  action: StageAction;
  itemId?: string;
  candidateIdentity?: string;
  evidenceFingerprint?: string;
  recoveryAction?: RecoveryRecipe;
  typedReason?: string;
  /** Class budget remaining before this claim (default 1 → 0 after charge). */
  budgetBefore?: number;
  notBefore?: string;
  nextAttemptAt?: string;
  invariant?: string;
  candidateEpoch?: string;
  evidenceRole?: "planning" | "implementation";
  artifactIdentity?: string;
  evidenceIdentity?: string;
  attemptsPerStrategy?: Record<string, number>;
  strategyCursor?: number;
  nextEligibleAt?: string;
  episodeId?: string;
}

export type ClaimStageAttemptResult =
  | { ok: true; ledger: StageAttemptLedger; attempt: StageAttemptRecord; created: boolean }
  | { ok: false; reason: string; ledger: StageAttemptLedger; attempt?: StageAttemptRecord };

/**
 * Claim before side-effect: persist `started` and charge budget. Replaying the
 * same identity returns the existing attempt without a second charge.
 */
export function claimStageAttempt(
  ledger: StageAttemptLedger,
  input: ClaimStageAttemptInput,
  deps: StageAttemptLedgerDeps = {},
): ClaimStageAttemptResult {
  const d = resolveDeps(deps);
  const headSha = input.headSha.trim();
  if (!headSha) {
    return { ok: false, reason: "claim requires non-empty headSha", ledger };
  }
  if (!isStageAction(input.action)) {
    return { ok: false, reason: `unknown stage action: ${String(input.action)}`, ledger };
  }
  const attempt_id = stageAttemptId({
    headSha,
    action: input.action,
    itemId: input.itemId,
    candidateIdentity: input.candidateIdentity,
    evidenceFingerprint: input.evidenceFingerprint,
    recoveryAction: input.recoveryAction,
  });
  const existing = ledger.attempts.find((a) => a.attempt_id === attempt_id);
  if (existing) {
    return { ok: true, ledger, attempt: existing, created: false };
  }
  const budgetBefore = input.budgetBefore ?? 1;
  const outcome: StageAttemptStatus = budgetBefore <= 0 ? "exhausted" : "started";
  const budget_remaining = Math.max(0, budgetBefore - (outcome === "started" ? 1 : 0));
  const time = d.now().toISOString();
  const not_before = input.notBefore ?? input.nextAttemptAt;
  const attempt: StageAttemptRecord = {
    attempt_id,
    idempotency_key: attempt_id,
    seq: ledger.attempts.length,
    time,
    ...(not_before ? { not_before, next_attempt_at: not_before } : {}),
    ...(input.itemId ? { item_id: input.itemId } : {}),
    candidate_identity: input.candidateIdentity?.trim() || headSha,
    head_sha: headSha,
    action: input.action,
    ...(input.recoveryAction ? { recovery_action: input.recoveryAction } : {}),
    actions: [input.action],
    ...(input.evidenceFingerprint !== undefined
      ? { evidence_fingerprint: input.evidenceFingerprint }
      : {}),
    outcome,
    status: outcome,
    ...(input.typedReason ? { typed_reason: input.typedReason } : {}),
    budget_remaining,
    ...(outcome === "exhausted"
      ? {
          error: `stage budget exhausted before action "${input.action}" could start`,
          last_error: `stage budget exhausted before action "${input.action}" could start`,
          terminal_outcome: "failed" as const,
        }
      : {}),
    ...(input.invariant ? { invariant: input.invariant } : {}),
    ...(input.candidateEpoch ? { candidate_epoch: input.candidateEpoch } : {}),
    ...(input.evidenceRole ? { evidence_role: input.evidenceRole } : {}),
    ...(input.artifactIdentity ? { artifact_identity: input.artifactIdentity } : {}),
    ...(input.evidenceIdentity ? { evidence_identity: input.evidenceIdentity } : {}),
    ...(input.attemptsPerStrategy ? { attempts_per_strategy: input.attemptsPerStrategy } : {}),
    ...(input.strategyCursor !== undefined ? { strategy_cursor: input.strategyCursor } : {}),
    ...(input.nextEligibleAt ? { next_eligible_at: input.nextEligibleAt } : {}),
    ...(input.episodeId ? { episode_id: input.episodeId } : {}),
  };
  ledger.attempts.push(attempt);
  return { ok: true, ledger, attempt, created: true };
}

export interface CompleteStageAttemptInput {
  attemptId: string;
  succeeded: boolean;
  error?: string;
  typedReason?: string;
  terminalOutcome?: StageTerminalOutcome;
}

/**
 * Complete a started claim. Idempotent for already-terminal attempts.
 */
export function completeStageAttempt(
  ledger: StageAttemptLedger,
  input: CompleteStageAttemptInput,
  deps: StageAttemptLedgerDeps = {},
): ClaimStageAttemptResult {
  const d = resolveDeps(deps);
  const attempt = ledger.attempts.find((a) => a.attempt_id === input.attemptId);
  if (!attempt) {
    return { ok: false, reason: `attempt "${input.attemptId}" not found`, ledger };
  }
  if (attempt.status !== "started" && attempt.outcome !== "started") {
    return { ok: true, ledger, attempt, created: false };
  }
  const time = d.now().toISOString();
  attempt.completed_at = time;
  if (input.succeeded) {
    attempt.status = "completed";
    attempt.outcome = "completed";
    attempt.terminal_outcome = input.terminalOutcome ?? "success";
    delete attempt.error;
    delete attempt.last_error;
  } else {
    attempt.status = "failed";
    attempt.outcome = "failed";
    attempt.terminal_outcome = input.terminalOutcome ?? "failed";
    const err =
      input.error?.trim() || `stage action "${attempt.action}" failed without error detail`;
    attempt.error = err;
    attempt.last_error = err;
  }
  if (input.typedReason) attempt.typed_reason = input.typedReason;
  return { ok: true, ledger, attempt, created: false };
}

/**
 * Explicitly supersede a started (or charged) attempt — e.g. HEAD movement.
 * Superseded attempts do not block a fresh claim on a new head.
 */
export function supersedeStageAttempt(
  ledger: StageAttemptLedger,
  attemptId: string,
  reason?: string,
  deps: StageAttemptLedgerDeps = {},
): ClaimStageAttemptResult {
  const d = resolveDeps(deps);
  const attempt = ledger.attempts.find((a) => a.attempt_id === attemptId);
  if (!attempt) {
    return { ok: false, reason: `attempt "${attemptId}" not found`, ledger };
  }
  if (attempt.status === "superseded" || attempt.outcome === "superseded") {
    return { ok: true, ledger, attempt, created: false };
  }
  const time = d.now().toISOString();
  attempt.completed_at = time;
  attempt.status = "superseded";
  attempt.outcome = "superseded";
  attempt.terminal_outcome = "superseded";
  if (reason) {
    attempt.error = reason;
    attempt.last_error = reason;
  }
  return { ok: true, ledger, attempt, created: false };
}

/**
 * Claim + durable persist in one step (claim-before-side-effect). On persist
 * failure rolls back a newly created in-memory claim.
 */
export function claimAndPersistStageAttempt(
  runDir: string | undefined,
  ledger: StageAttemptLedger,
  input: ClaimStageAttemptInput,
  deps: StageAttemptLedgerDeps = {},
): ClaimStageAttemptResult {
  const claimed = claimStageAttempt(ledger, input, deps);
  if (!claimed.ok) return claimed;
  if (!claimed.created) return claimed;
  const persist = persistStageAttemptLedger(runDir, claimed.ledger, deps);
  if (!persist.ok) {
    // Roll back the in-memory push so a later retry can re-claim.
    claimed.ledger.attempts = claimed.ledger.attempts.filter(
      (a) => a.attempt_id !== claimed.attempt.attempt_id,
    );
    return { ok: false, reason: persist.reason, ledger: claimed.ledger };
  }
  return claimed;
}

export function completeAndPersistStageAttempt(
  runDir: string | undefined,
  ledger: StageAttemptLedger,
  input: CompleteStageAttemptInput,
  deps: StageAttemptLedgerDeps = {},
): ClaimStageAttemptResult {
  const completed = completeStageAttempt(ledger, input, deps);
  if (!completed.ok) return completed;
  const persist = persistStageAttemptLedger(runDir, completed.ledger, deps);
  if (!persist.ok) {
    return { ok: false, reason: persist.reason, ledger: completed.ledger, attempt: completed.attempt };
  }
  return completed;
}

// ---------------------------------------------------------------------------
// CI SHA-set projection (behavior-freeze cache over ledger authority)
// ---------------------------------------------------------------------------

export interface CiRecoveryProjection {
  preArchiveSha?: string;
  ciRebaseAttemptedShas?: string[];
  ciRerunAttemptedShas?: string[];
  ciArchiveFailRecoveryAttemptedShas?: string[];
  ciAssertionFixAttemptedShas?: string[];
  ciDocsStaleHealAttemptedShas?: string[];
  ciTerminalFailRecordedShas?: string[];
  noRunRecoveryAttemptedShas?: string[];
}

/** Project ledger attempts into the CI gate's SHA-set cache shape. */
export function projectCiRecoveryFromLedger(ledger: StageAttemptLedger): CiRecoveryProjection {
  const nonEmpty = (list: string[]): string[] | undefined =>
    list.length > 0 ? list : undefined;
  return {
    preArchiveSha: ledger.preArchiveSha,
    ciRebaseAttemptedShas: nonEmpty(attemptedShasForAction(ledger, "ci_rebase")),
    ciRerunAttemptedShas: nonEmpty(attemptedShasForAction(ledger, "ci_rerun")),
    ciArchiveFailRecoveryAttemptedShas: nonEmpty(
      attemptedShasForAction(ledger, "ci_archive_fail_recovery"),
    ),
    ciAssertionFixAttemptedShas: nonEmpty(attemptedShasForAction(ledger, "ci_assertion_fix")),
    ciDocsStaleHealAttemptedShas: nonEmpty(attemptedShasForAction(ledger, "ci_docs_stale_heal")),
    ciTerminalFailRecordedShas: nonEmpty(ledger.ciTerminalFailRecordedShas ?? []),
    noRunRecoveryAttemptedShas: nonEmpty(attemptedShasForAction(ledger, "no_run_recovery")),
  };
}

/**
 * Apply in-memory CI SHA-set cache into ledger claims (completed) so persist
 * does not drop session progress. Idempotent per (head, action).
 */
export function syncCiProjectionIntoLedger(
  ledger: StageAttemptLedger,
  projection: {
    preArchiveSha?: string;
    ciRebaseAttemptedShas?: string[];
    ciRerunAttemptedShas?: string[];
    ciArchiveFailRecoveryAttemptedShas?: string[];
    ciAssertionFixAttemptedShas?: string[];
    ciDocsStaleHealAttemptedShas?: string[];
    ciTerminalFailRecordedShas?: string[];
    noRunRecoveryAttemptedForSha?: string;
  },
  nowIso: string,
): StageAttemptLedger {
  if (projection.preArchiveSha && !ledger.preArchiveSha) {
    ledger.preArchiveSha = projection.preArchiveSha;
  } else if (projection.preArchiveSha) {
    ledger.preArchiveSha = projection.preArchiveSha;
  }
  const ensure = (shas: string[] | undefined, action: StageAction) => {
    for (const headSha of shas ?? []) {
      if (!headSha || hasAttempted(ledger, headSha, action)) continue;
      const claimed = claimStageAttempt(
        ledger,
        { headSha, action, typedReason: "synced_from_session_cache", budgetBefore: 1 },
        { now: () => new Date(nowIso) },
      );
      if (claimed.ok && claimed.created) {
        completeStageAttempt(
          ledger,
          { attemptId: claimed.attempt.attempt_id, succeeded: true },
          { now: () => new Date(nowIso) },
        );
      }
    }
  };
  ensure(projection.ciRebaseAttemptedShas, "ci_rebase");
  ensure(projection.ciRerunAttemptedShas, "ci_rerun");
  ensure(projection.ciArchiveFailRecoveryAttemptedShas, "ci_archive_fail_recovery");
  ensure(projection.ciAssertionFixAttemptedShas, "ci_assertion_fix");
  ensure(projection.ciDocsStaleHealAttemptedShas, "ci_docs_stale_heal");
  if (projection.noRunRecoveryAttemptedForSha) {
    ensure([projection.noRunRecoveryAttemptedForSha], "no_run_recovery");
  }
  if (projection.ciTerminalFailRecordedShas?.length) {
    const merged = [
      ...(ledger.ciTerminalFailRecordedShas ?? []),
      ...projection.ciTerminalFailRecordedShas,
    ];
    ledger.ciTerminalFailRecordedShas = [...new Set(merged)];
  }
  return ledger;
}

/** Map CI recovery class name used by the ladder to a stage action. */
export function ciRecoveryClassToAction(
  cls: "rebase" | "rerun" | "archive_fail" | "assertion_fix" | "docs_stale_heal",
): StageAction {
  switch (cls) {
    case "rebase":
      return "ci_rebase";
    case "rerun":
      return "ci_rerun";
    case "archive_fail":
      return "ci_archive_fail_recovery";
    case "assertion_fix":
      return "ci_assertion_fix";
    case "docs_stale_heal":
      return "ci_docs_stale_heal";
  }
}

/**
 * Build attestation attempt records from autofix comment SHAs (hydration input).
 * Callers pass these into hydrate — they are not a parallel attempt book.
 */
export function attestationAttemptsFromAutofixShas(
  attemptShas: string[],
  nowIso: string,
): StageAttemptRecord[] {
  return attemptShas
    .filter((s) => typeof s === "string" && s.length > 0)
    .map((headSha, i) => {
      const attempt_id = stageAttemptId({ headSha, action: "pre_merge_autofix" });
      return {
        attempt_id,
        idempotency_key: attempt_id,
        seq: i,
        time: nowIso,
        completed_at: nowIso,
        candidate_identity: headSha,
        head_sha: headSha,
        action: "pre_merge_autofix" as const,
        actions: ["pre_merge_autofix" as const],
        outcome: "completed" as const,
        status: "completed" as const,
        terminal_outcome: "success" as const,
        typed_reason: "attested_autofix_comment",
        budget_remaining: 0,
      };
    });
}

/** Normalize a raw record after JSON load (defensive). */
export function coerceStageAttemptRecord(raw: StageAttemptRecord): StageAttemptRecord {
  const status = normalizeStatus(String(raw.outcome), raw.status);
  return {
    ...raw,
    status,
    outcome: status,
    idempotency_key: raw.idempotency_key || raw.attempt_id,
    last_error: raw.last_error ?? raw.error,
    next_attempt_at: raw.next_attempt_at ?? raw.not_before,
    actions: raw.actions?.length ? raw.actions : [raw.action],
  };
}
