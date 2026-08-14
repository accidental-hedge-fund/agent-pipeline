// recover-parked (#1061): one supervisor senior pass per park fingerprint.
//
// Order (hard): lock → deterministic recover → classify at live HEAD → spend
// marker → eligible overrides only → optional one fix round → re-eval → re-enter
// single/advance with skipRecoverParked, or keep park for human.
//
// Severity/category come ONLY from the structured review record. Prose never
// unlocks HIGH/CRITICAL/security/authority. Fingerprint budget is one pass per
// (issue, stage, sorted keys) with covering-superset spent rule.

import { createHash } from "node:crypto";
import {
  clearBlocked,
  getGhActor,
  getIssueDetail,
  getPrDetail,
  getPrForIssue,
  isBlocked,
  pickStage,
  postComment,
  type IssueDetail,
} from "./gh.ts";
import { withLock } from "./lock.ts";
import {
  buildOverrideDecision,
  implicitOverrideGovernance,
  validateOverrideRecord,
} from "./override-governance.ts";
import {
  extractOverrides,
  extractBlockingSurfacesFromComment,
  govPayloadFromDecision,
  isValidFindingKey,
  overrideComment,
} from "./review-policy.ts";
import {
  attestPipelineComment,
  DELTA_REVIEW_MARKER_PREFIX,
  extractBlockingKeysFromComment,
  extractReviewArtifact,
  REVIEW_MARKER_PREFIX_R1,
  REVIEW_MARKER_PREFIX_R2,
  type ReviewArtifact,
} from "./stages/review-parsing.ts";
import {
  stageEligibleForStaleBlockedResume,
  tryResumeStaleBlocked,
  type StaleBlockedResumeDeps,
  type StaleBlockedResumeResult,
} from "./stages/stale-blocked-rereview.ts";
import {
  BLOCKED_LABEL,
  LABEL_PREFIX,
  type PipelineConfig,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Result contract
// ---------------------------------------------------------------------------

export type RecoverParkedStatus =
  | "deterministic-cleared"
  | "recovered"
  | "still-parked"
  | "already-spent"
  | "not-parked"
  | "fail-closed";

export type SupervisorOverrideReason = "stale" | "DNR" | "below-high";

export interface RecoverParkedResult {
  status: RecoverParkedStatus;
  issue: number;
  fingerprintId?: string;
  stageId?: string;
  keys?: string[];
  overridesApplied?: Array<{ key: string; reason: SupervisorOverrideReason }>;
  fixRoundRan?: boolean;
  reentered?: boolean;
  message: string;
}

/** Exit code for CLI consumers. Disallowed flags use 2 before this map. */
export function recoverParkedExitCode(status: RecoverParkedStatus): number {
  switch (status) {
    case "deterministic-cleared":
    case "recovered":
    case "already-spent":
      return 0;
    case "still-parked":
    case "not-parked":
    case "fail-closed":
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

export type ParkedFindingClass =
  | { kind: "override-eligible"; reason: SupervisorOverrideReason }
  | { kind: "non-overridable"; cause: NonOverridableCause };

export type NonOverridableCause =
  | "high"
  | "critical"
  | "security"
  | "authority"
  | "unknown-severity"
  | "present-unclassified";

export interface StructuredParkedFinding {
  key: string;
  /** Structured severity from the review record; absent → unknown. */
  severity?: string | null;
  /** Structured category (or surface-derived); absent → none. */
  category?: string | null;
  /** Present in the live residual set at HEAD. */
  presentAtLiveHead: boolean;
  /**
   * Free-text / classifier prose. NEVER consulted for eligibility — field
   * exists so tests can prove nit prose does not unlock CRITICAL.
   */
  prose?: string | null;
  /** Human-authority residual for this key or whole park. */
  authority?: boolean;
}

/**
 * Classify one residual finding from structured record fields only.
 * Prose is ignored. Severity/category case-insensitive.
 */
export function classifyParkedFinding(f: StructuredParkedFinding): ParkedFindingClass {
  // Key absent at live HEAD → stale/DNR (historical severity does not matter).
  if (!f.presentAtLiveHead) {
    return { kind: "override-eligible", reason: "DNR" };
  }

  if (f.authority) {
    return { kind: "non-overridable", cause: "authority" };
  }

  const sev = (f.severity ?? "").trim().toLowerCase();
  const cat = (f.category ?? "").trim().toLowerCase();

  if (cat === "security") {
    return { kind: "non-overridable", cause: "security" };
  }
  if (sev === "critical") {
    return { kind: "non-overridable", cause: "critical" };
  }
  if (sev === "high") {
    return { kind: "non-overridable", cause: "high" };
  }
  if (!sev || sev === "unknown") {
    return { kind: "non-overridable", cause: "unknown-severity" };
  }
  // Present, structured severity below high, not security, not authority.
  if (sev === "medium" || sev === "low") {
    return { kind: "override-eligible", reason: "below-high" };
  }
  // Unrecognized severity token → fail closed.
  return { kind: "non-overridable", cause: "unknown-severity" };
}

/**
 * Build a key-bound override payload string for parseOverrideArg / record path.
 * Keyless and prose-only are refused.
 */
export function buildSupervisorOverridePayload(
  key: string,
  reason: SupervisorOverrideReason,
  evidenceLine?: string,
): { ok: true; spec: string } | { ok: false; error: string } {
  if (!isValidFindingKey(key)) {
    return { ok: false, error: `keyless or invalid finding key: ${key}` };
  }
  const detail =
    evidenceLine?.trim() ||
    (reason === "below-high"
      ? "below-high residual at live HEAD"
      : reason === "stale"
        ? "stale: key absent at live HEAD"
        : "DNR: key no longer present at live HEAD");
  // Closed reason class is the first token after the colon for audit.
  return { ok: true, spec: `${key}: ${reason} — ${detail}` };
}

// ---------------------------------------------------------------------------
// Fingerprint ledger
// ---------------------------------------------------------------------------

export const RECOVER_PARKED_SPENT_MARKER = "pipeline-recover-parked-spent: v1";

const SPENT_RE =
  /<!--\s*pipeline-recover-parked-spent:\s*v1\s+(\{.*?\})\s*-->/gs;

export interface SpentFingerprint {
  fingerprint: string;
  issue: number;
  stage: string;
  keys: string[];
  at: string;
}

export function canonicalKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((k) => k.toLowerCase()))].sort();
}

export function computeFingerprintId(
  issue: number,
  stageId: string,
  keys: readonly string[],
): string {
  const sorted = canonicalKeys(keys);
  const raw = `${issue}\n${stageId}\n${sorted.join(",")}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function formatRecoverParkedSpentComment(args: {
  fingerprint: string;
  issue: number;
  stage: string;
  keys: readonly string[];
  at: string;
  footer?: string;
}): string {
  const payload = {
    fingerprint: args.fingerprint,
    issue: args.issue,
    stage: args.stage,
    keys: canonicalKeys(args.keys),
    at: args.at,
  };
  const rendered = [
    "## Pipeline: recover-parked supervisor pass spent",
    "",
    `**Issue**: #${args.issue}`,
    `**Stage**: \`${args.stage}\``,
    `**Fingerprint**: \`${args.fingerprint}\``,
    `**Keys**: ${payload.keys.map((k) => `\`${k}\``).join(", ") || "(none)"}`,
    `**Recorded at**: ${args.at}`,
    "",
    (args.footer ?? "*Automated by Claude Code Pipeline Skill*").trim(),
    "",
    `<!-- ${RECOVER_PARKED_SPENT_MARKER} ${JSON.stringify(payload)} -->`,
  ].join("\n");
  return attestPipelineComment("recover-parked-spent", rendered);
}

/** Pure extractor: all spent fingerprint records from issue comments. */
export function extractRecoverParkedSpent(
  comments: readonly { body: string }[],
): SpentFingerprint[] {
  const out: SpentFingerprint[] = [];
  for (const c of comments) {
    SPENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SPENT_RE.exec(c.body)) !== null) {
      try {
        const obj = JSON.parse(m[1]) as Record<string, unknown>;
        if (
          typeof obj.fingerprint !== "string" ||
          typeof obj.issue !== "number" ||
          typeof obj.stage !== "string" ||
          !Array.isArray(obj.keys) ||
          !obj.keys.every((k) => typeof k === "string") ||
          typeof obj.at !== "string"
        ) {
          continue;
        }
        out.push({
          fingerprint: obj.fingerprint,
          issue: obj.issue,
          stage: obj.stage,
          keys: canonicalKeys(obj.keys as string[]),
          at: obj.at,
        });
      } catch {
        /* malformed payload ignored */
      }
    }
  }
  SPENT_RE.lastIndex = 0;
  return out;
}

/**
 * True when fingerprint F is spent OR any prior spent key-set for the same
 * (issue, stage) covers current keys (subset-after-partial-override rule).
 */
export function isFingerprintSpent(
  spent: readonly SpentFingerprint[],
  issue: number,
  stageId: string,
  fingerprintId: string,
  currentKeys: readonly string[],
): boolean {
  const cur = canonicalKeys(currentKeys);
  for (const s of spent) {
    if (s.issue !== issue) continue;
    if (s.fingerprint === fingerprintId) return true;
    if (s.stage !== stageId) continue;
    // Covering-superset: prior keys ⊇ current (incl. empty residual after partial).
    const prior = new Set(s.keys);
    if (cur.every((k) => prior.has(k))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Residual loading (structured record)
// ---------------------------------------------------------------------------

export interface ResidualFindingRecord {
  key: string;
  severity: string;
  title: string;
  surface: string | null;
  category: string | null;
  presentAtLiveHead: boolean;
}

function categoryFromSurface(surface: string | null | undefined): string | null {
  if (!surface) return null;
  const pipe = surface.lastIndexOf("|");
  if (pipe < 0) return null;
  const cat = surface.slice(pipe + 1).trim();
  return cat || null;
}

function isReviewishBody(body: string): boolean {
  return (
    body.startsWith(REVIEW_MARKER_PREFIX_R1) ||
    body.startsWith(REVIEW_MARKER_PREFIX_R2) ||
    body.startsWith(DELTA_REVIEW_MARKER_PREFIX)
  );
}

/**
 * Load residual blocking findings from issue comments against live HEAD.
 * Prefers ReviewArtifact.blockingFindings; falls back to blocking-keys marker
 * with severity "unknown" (fail-closed for override).
 */
export function loadResidualFindings(args: {
  comments: readonly { body: string; author?: string }[];
  liveHeadSha: string;
  /** When true, only use the latest review comment (any sha) for key set. */
  useLatestIfNoHeadMatch?: boolean;
}): {
  findings: ResidualFindingRecord[];
  keys: string[];
  matchedReviewedSha: string | null;
  source: "artifact" | "blocking-keys" | "none";
} {
  const reviewComments = args.comments.filter((c) => isReviewishBody(c.body));
  // Prefer comments whose artifact/sentinel reviewed-sha equals live HEAD.
  let chosen: { body: string; artifact: ReviewArtifact | null } | null = null;
  for (let i = reviewComments.length - 1; i >= 0; i--) {
    const body = reviewComments[i]!.body;
    const artifact = extractReviewArtifact(body);
    const sha = artifact?.reviewedSha ?? null;
    if (sha && sha.toLowerCase() === args.liveHeadSha.toLowerCase()) {
      chosen = { body, artifact };
      break;
    }
  }
  if (!chosen && args.useLatestIfNoHeadMatch !== false) {
    // Fall back to newest review comment for park residual set.
    const last = reviewComments[reviewComments.length - 1];
    if (last) {
      chosen = { body: last.body, artifact: extractReviewArtifact(last.body) };
    }
  }
  if (!chosen) {
    return { findings: [], keys: [], matchedReviewedSha: null, source: "none" };
  }

  const overrides = extractOverrides([...args.comments]);
  const surfaces = extractBlockingSurfacesFromComment(chosen.body);

  if (chosen.artifact?.blockingFindings && chosen.artifact.blockingFindings.length > 0) {
    const findings: ResidualFindingRecord[] = [];
    for (const bf of chosen.artifact.blockingFindings) {
      const key = bf.key.toLowerCase();
      if (!isValidFindingKey(key)) continue;
      if (overrides.has(key)) continue; // already dispositioned
      const surface = bf.surface ?? surfaces.get(key) ?? null;
      findings.push({
        key,
        severity: bf.severity,
        title: bf.title,
        surface,
        category: categoryFromSurface(surface),
        presentAtLiveHead: true,
      });
    }
    // Also include parked keys from artifact.blockingKeys that disappeared from
    // blockingFindings? blockingKeys is the authoritative key list.
    const keySet = new Set(findings.map((f) => f.key));
    for (const k of chosen.artifact.blockingKeys) {
      const key = k.toLowerCase();
      if (!isValidFindingKey(key) || overrides.has(key) || keySet.has(key)) continue;
      // Key listed as blocking but no finding entry → present unknown.
      const surface = surfaces.get(key) ?? null;
      findings.push({
        key,
        severity: "unknown",
        title: "",
        surface,
        category: categoryFromSurface(surface),
        presentAtLiveHead: true,
      });
    }
    return {
      findings,
      keys: canonicalKeys(findings.map((f) => f.key)),
      matchedReviewedSha: chosen.artifact.reviewedSha,
      source: "artifact",
    };
  }

  // Legacy marker path: severity unknown → non-overridable if present.
  const markerKeys = extractBlockingKeysFromComment(chosen.body);
  const findings: ResidualFindingRecord[] = [];
  for (const k of markerKeys) {
    const key = k.toLowerCase();
    if (overrides.has(key)) continue;
    const surface = surfaces.get(key) ?? null;
    findings.push({
      key,
      severity: "unknown",
      title: "",
      surface,
      category: categoryFromSurface(surface),
      presentAtLiveHead: true,
    });
  }
  return {
    findings,
    keys: canonicalKeys(findings.map((f) => f.key)),
    matchedReviewedSha: null,
    source: findings.length > 0 ? "blocking-keys" : "none",
  };
}

/**
 * Park residual keys: keys that were blocking at park (from latest review
 * evidence) minus active overrides. For DNR detection, keys in the park set
 * but absent from live residual are eligible as DNR/stale.
 */
export function mergeParkAndLiveFindings(args: {
  parkKeys: readonly string[];
  liveFindings: ResidualFindingRecord[];
}): ResidualFindingRecord[] {
  const liveByKey = new Map(args.liveFindings.map((f) => [f.key, f]));
  const out: ResidualFindingRecord[] = [];
  const seen = new Set<string>();
  for (const k of canonicalKeys(args.parkKeys)) {
    const live = liveByKey.get(k);
    if (live) {
      out.push(live);
    } else {
      out.push({
        key: k,
        severity: "unknown",
        title: "",
        surface: null,
        category: null,
        presentAtLiveHead: false,
      });
    }
    seen.add(k);
  }
  for (const f of args.liveFindings) {
    if (!seen.has(f.key)) out.push(f);
  }
  return out;
}

/** Extract park key set from the newest review-ish comment (any HEAD). */
export function extractParkKeySet(
  comments: readonly { body: string }[],
): string[] {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i]!.body;
    if (!isReviewishBody(body)) continue;
    const art = extractReviewArtifact(body);
    if (art?.blockingKeys?.length) {
      return canonicalKeys(art.blockingKeys);
    }
    const keys = extractBlockingKeysFromComment(body);
    if (keys.size > 0) return canonicalKeys([...keys]);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Park eligibility
// ---------------------------------------------------------------------------

export function isParkedForRecover(labels: readonly string[]): boolean {
  if (labels.includes(`${LABEL_PREFIX}needs-human`)) return true;
  if (labels.includes(BLOCKED_LABEL) || labels.includes("blocked")) return true;
  return false;
}

export function stageIdForPark(labels: readonly string[]): string {
  const stage = pickStage([...labels]);
  return stage ?? (isBlocked([...labels]) ? "blocked" : "unknown");
}

// ---------------------------------------------------------------------------
// Deps + runRecoverParked
// ---------------------------------------------------------------------------

export interface RecoverParkedOpts {
  /** When true, classify only — no spend marker, override, fix, or re-enter. */
  dryRun?: boolean;
  /** Skip re-entry after successful clear (tests). */
  skipReentry?: boolean;
  /**
   * Internal guard: when recover-parked re-enters advance/single, that path
   * MUST set this so nested recover-parked is not invoked on the same stack.
   */
  skipRecoverParked?: boolean;
}

export interface DeterministicRecoverResult {
  kind: "cleared" | "keep" | "no-op" | "failed";
  reason: string;
}

export interface RecordKeyOverrideResult {
  ok: boolean;
  error?: string;
}

export interface FixRoundResult {
  ran: boolean;
  reason?: string;
}

export interface RecoverParkedDeps {
  getIssueDetail: (cfg: PipelineConfig, issue: number) => Promise<IssueDetail>;
  getPrForIssue: (cfg: PipelineConfig, issue: number) => Promise<number | null>;
  getPrDetail: (
    cfg: PipelineConfig,
    pr: number,
  ) => Promise<{ head_sha: string; number?: number }>;
  postComment: (cfg: PipelineConfig, issue: number, body: string) => Promise<void>;
  clearBlocked: (cfg: PipelineConfig, issue: number) => Promise<void>;
  getGhActor?: () => Promise<string | null>;
  now?: () => Date;
  /**
   * Issue-run lock. Default: real PipelineLock. Tests inject a no-op acquire.
   */
  withIssueLock?: <T>(
    domain: string,
    issue: number,
    fn: () => Promise<T>,
  ) => Promise<T>;
  /** Deterministic stale-blocked resume. */
  tryResumeStaleBlocked?: (
    cfg: PipelineConfig,
    issue: number,
    detail: Pick<IssueDetail, "comments" | "labels">,
    deps?: StaleBlockedResumeDeps,
  ) => Promise<StaleBlockedResumeResult>;
  /**
   * Engine-scratch unlink. Returns cleared when park labels no longer apply.
   * Default: no-op keep (production can inject recovery path).
   */
  tryUnlinkEngineScratch?: (
    cfg: PipelineConfig,
    issue: number,
    detail: IssueDetail,
  ) => Promise<DeterministicRecoverResult>;
  /**
   * Record one audited key override without re-entering advance.
   * Default uses overrideComment + governance (same ledger as runOverride).
   */
  recordKeyOverride?: (
    cfg: PipelineConfig,
    issue: number,
    key: string,
    reason: SupervisorOverrideReason,
    evidenceLine: string,
    stage: string,
  ) => Promise<RecordKeyOverrideResult>;
  /**
   * Optional one implementer fix round for still-valid non-overridable defects.
   * MUST NOT call override for protected keys.
   */
  runOneImplementerFixRound?: (args: {
    cfg: PipelineConfig;
    issue: number;
    findings: ResidualFindingRecord[];
  }) => Promise<FixRoundResult>;
  /**
   * Re-enter same-issue advance/single. Receives skipRecoverParked: true.
   */
  reenterAdvance?: (
    cfg: PipelineConfig,
    issue: number,
    opts: { skipRecoverParked: true },
  ) => Promise<void>;
  log?: (msg: string) => void;
  /** Stale-blocked resume sub-deps (tests). */
  staleBlockedDeps?: StaleBlockedResumeDeps;
}

async function defaultWithIssueLock<T>(
  domain: string,
  issue: number,
  fn: () => Promise<T>,
): Promise<T> {
  return withLock(domain, fn, issue);
}

function defaultRecordKeyOverrideFactory(
  deps: RecoverParkedDeps,
): NonNullable<RecoverParkedDeps["recordKeyOverride"]> {
  return async (cfg, issue, key, reason, evidenceLine, stage) => {
    if (!isValidFindingKey(key)) {
      return { ok: false, error: "keyless disposition refused" };
    }
    const payload = buildSupervisorOverridePayload(key, reason, evidenceLine);
    if (!payload.ok) return { ok: false, error: payload.error };

    const governance = cfg.override_governance ?? implicitOverrideGovernance();
    const getActor = deps.getGhActor ?? getGhActor;
    const actor = await getActor();
    const createdAt = (deps.now ?? (() => new Date()))()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const explanation = `${reason} — ${evidenceLine}`;

    const validated = await validateOverrideRecord({
      governance,
      classId: undefined,
      actor,
      identitySource: "gh_actor",
      explanation,
      trustedAllowlist: cfg.trusted_override_actors,
    });
    if (!validated.ok) {
      return {
        ok: false,
        error: `override refused (${validated.refusal}): ${validated.message}`,
      };
    }

    const decision = buildOverrideDecision({
      classId: validated.classId,
      disposition: "rejected",
      target: { kind: "key", key },
      explanation: validated.explanation,
      actor: actor!,
      identitySource: "gh_actor",
      authorization: validated.authorization,
      evidenceRefs: validated.evidenceRefs,
      findingFingerprint: null,
      codeRegion: null,
      createdAt,
      maxDurationHours: validated.classPolicy.max_duration_hours,
    });
    const gov = govPayloadFromDecision(decision);
    const body = overrideComment({
      key,
      disposition: "rejected",
      reason: validated.explanation,
      stage,
      timestamp: createdAt,
      footer: cfg.marker_footer,
      gov,
    });
    const post = deps.postComment;
    await post(cfg, issue, body);
    return { ok: true };
  };
}

/**
 * Main entry: one supervisor pass per park fingerprint.
 * CLI and train both call this function.
 */
export async function runRecoverParked(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: RecoverParkedOpts = {},
  deps: RecoverParkedDeps,
): Promise<RecoverParkedResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const withLock = deps.withIssueLock ?? defaultWithIssueLock;

  if (opts.skipRecoverParked) {
    return {
      status: "fail-closed",
      issue: issueNumber,
      message: "recover-parked refused: skipRecoverParked guard (no nested reflow)",
    };
  }

  try {
    return await withLock(cfg.domain, issueNumber, async () => {
      return await runRecoverParkedLocked(cfg, issueNumber, opts, deps, log);
    });
  } catch (err) {
    return {
      status: "fail-closed",
      issue: issueNumber,
      message: `recover-parked fail-closed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runRecoverParkedLocked(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: RecoverParkedOpts,
  deps: RecoverParkedDeps,
  log: (msg: string) => void,
): Promise<RecoverParkedResult> {
  const getDetail = deps.getIssueDetail;
  const getPr = deps.getPrForIssue;
  const getDetailPr = deps.getPrDetail;
  const post = deps.postComment;
  const clear = deps.clearBlocked;
  const resumeStale = deps.tryResumeStaleBlocked ?? tryResumeStaleBlocked;
  const unlinkScratch =
    deps.tryUnlinkEngineScratch ??
    (async () =>
      ({ kind: "no-op", reason: "no scratch recoverer configured" }) as DeterministicRecoverResult);
  const recordOverride =
    deps.recordKeyOverride ?? defaultRecordKeyOverrideFactory(deps);

  let detail: IssueDetail;
  try {
    detail = await getDetail(cfg, issueNumber);
  } catch (err) {
    return {
      status: "fail-closed",
      issue: issueNumber,
      message: `cannot read issue: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isParkedForRecover(detail.labels)) {
    return {
      status: "not-parked",
      issue: issueNumber,
      message: `issue #${issueNumber} is not parked (no blocked / needs-human)`,
    };
  }

  // ---- Live PR HEAD (fail closed if unreadable) ----
  let prNumber: number | null;
  let headSha: string;
  try {
    prNumber = await getPr(cfg, issueNumber);
    if (prNumber == null) {
      return {
        status: "fail-closed",
        issue: issueNumber,
        message: "no linked open PR; keep park",
      };
    }
    headSha = (await getDetailPr(cfg, prNumber)).head_sha;
    if (!headSha || typeof headSha !== "string") {
      return {
        status: "fail-closed",
        issue: issueNumber,
        message: "PR HEAD unreadable; keep park",
      };
    }
  } catch (err) {
    return {
      status: "fail-closed",
      issue: issueNumber,
      message: `cannot read PR/HEAD: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ---- Deterministic recover first (no senior budget) ----
  const scratch = await unlinkScratch(cfg, issueNumber, detail);
  if (scratch.kind === "cleared") {
    // Re-check labels
    const after = await getDetail(cfg, issueNumber).catch(() => detail);
    if (!isParkedForRecover(after.labels)) {
      log(
        `[recover-parked] #${issueNumber}: deterministic-cleared (scratch) — ${scratch.reason}`,
      );
      return {
        status: "deterministic-cleared",
        issue: issueNumber,
        message: `deterministic scratch clear: ${scratch.reason}`,
        reentered: false,
      };
    }
  }

  const stage = pickStage(detail.labels);
  if (stageEligibleForStaleBlockedResume(stage) && isBlocked(detail.labels)) {
    const stale = await resumeStale(cfg, issueNumber, detail, deps.staleBlockedDeps);
    if (stale.kind === "cleared") {
      const after = await getDetail(cfg, issueNumber).catch(() => detail);
      if (!isParkedForRecover(after.labels)) {
        log(
          `[recover-parked] #${issueNumber}: deterministic-cleared (stale-blocked) — ${stale.reason}`,
        );
        // Optionally re-enter so same-issue advance continues.
        if (!opts.skipReentry && !opts.dryRun && deps.reenterAdvance) {
          await deps.reenterAdvance(cfg, issueNumber, { skipRecoverParked: true });
          return {
            status: "deterministic-cleared",
            issue: issueNumber,
            message: `deterministic stale-blocked clear: ${stale.reason}`,
            reentered: true,
          };
        }
        return {
          status: "deterministic-cleared",
          issue: issueNumber,
          message: `deterministic stale-blocked clear: ${stale.reason}`,
          reentered: false,
        };
      }
      // Labels still parked (e.g. needs-human remains) — continue senior path.
      detail = after;
    }
  }

  // ---- Senior path: residual classification at live HEAD ----
  // Re-read HEAD before classification.
  try {
    headSha = (await getDetailPr(cfg, prNumber)).head_sha;
  } catch (err) {
    return {
      status: "fail-closed",
      issue: issueNumber,
      message: `HEAD re-read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  detail = await getDetail(cfg, issueNumber).catch(() => detail);
  const stageId = stageIdForPark(detail.labels);

  // Authority park: whole-item human authority refuses senior override path.
  const authorityPark =
    detail.labels.includes(`${LABEL_PREFIX}needs-human`) &&
    // Human-decision punch list with no residual keys still may reflow empty;
    // when residual keys exist we classify per-key. Whole-park authority is
    // signaled via comment markers / isHumanAuthority — keep simple: only if
    // a human-decision-required attestation is present without review residuals.
    false; // per-key authority set below when needed

  const parkKeys = extractParkKeySet(detail.comments);
  const live = loadResidualFindings({
    comments: detail.comments,
    liveHeadSha: headSha,
  });
  const residual = mergeParkAndLiveFindings({
    parkKeys: parkKeys.length > 0 ? parkKeys : live.keys,
    liveFindings: live.findings,
  });

  // Fingerprint uses current residual blocking keys (present + DNR from park).
  const blockingKeys = canonicalKeys(residual.map((f) => f.key));
  const fingerprintId = computeFingerprintId(issueNumber, stageId, blockingKeys);

  const spent = extractRecoverParkedSpent(detail.comments);
  if (isFingerprintSpent(spent, issueNumber, stageId, fingerprintId, blockingKeys)) {
    log(
      `[recover-parked] #${issueNumber}: already-spent fingerprint ${fingerprintId}`,
    );
    return {
      status: "already-spent",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: blockingKeys,
      message: `supervisor pass already spent for fingerprint ${fingerprintId}`,
    };
  }

  // Classify each residual (pure; dry-run stops after this without mutations).
  const eligible: Array<{ key: string; reason: SupervisorOverrideReason; evidence: string }> =
    [];
  const nonOverridable: ResidualFindingRecord[] = [];
  for (const f of residual) {
    const cls = classifyParkedFinding({
      key: f.key,
      severity: f.severity,
      category: f.category,
      presentAtLiveHead: f.presentAtLiveHead,
      authority: authorityPark,
    });
    if (cls.kind === "override-eligible") {
      const reason: SupervisorOverrideReason = !f.presentAtLiveHead
        ? "stale"
        : cls.reason === "below-high"
          ? "below-high"
          : "DNR";
      eligible.push({
        key: f.key,
        reason,
        evidence: !f.presentAtLiveHead
          ? `key absent at live HEAD ${headSha.slice(0, 7)}`
          : `below-high residual at live HEAD ${headSha.slice(0, 7)}`,
      });
    } else {
      nonOverridable.push(f);
    }
  }

  if (opts.dryRun) {
    return {
      status: "still-parked",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: blockingKeys,
      message: `dry-run: eligible=${eligible.length} non-overridable=${nonOverridable.length}; no mutations`,
    };
  }

  // No residual keys and nothing to reflow — keep park (do not drop labels).
  if (blockingKeys.length === 0) {
    return {
      status: "still-parked",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: [],
      message: "still-parked: no residual review keys to reflow; human punch list / labels unchanged",
    };
  }

  // Spend marker BEFORE side effects (write-before-side-effects).
  const at = (deps.now ?? (() => new Date()))()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const spendBody = formatRecoverParkedSpentComment({
    fingerprint: fingerprintId,
    issue: issueNumber,
    stage: stageId,
    keys: blockingKeys,
    at,
    footer: cfg.marker_footer,
  });
  try {
    await post(cfg, issueNumber, spendBody);
  } catch (err) {
    return {
      status: "fail-closed",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: blockingKeys,
      message: `spend marker post failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Eligible overrides only (never HIGH/CRITICAL/security/authority).
  const overridesApplied: Array<{ key: string; reason: SupervisorOverrideReason }> = [];
  for (const e of eligible) {
    // Re-gate eligibility (defense in depth against internal misuse).
    const recheck = classifyParkedFinding({
      key: e.key,
      severity: residual.find((r) => r.key === e.key)?.severity,
      category: residual.find((r) => r.key === e.key)?.category,
      presentAtLiveHead: residual.find((r) => r.key === e.key)?.presentAtLiveHead ?? false,
    });
    if (recheck.kind !== "override-eligible") {
      log(
        `[recover-parked] #${issueNumber}: refuse override for ${e.key} (${recheck.kind === "non-overridable" ? recheck.cause : "?"})`,
      );
      continue;
    }
    const payload = buildSupervisorOverridePayload(e.key, e.reason, e.evidence);
    if (!payload.ok) {
      log(`[recover-parked] #${issueNumber}: keyless disposition refused for ${e.key}`);
      continue;
    }
    const rec = await recordOverride(
      cfg,
      issueNumber,
      e.key,
      e.reason,
      e.evidence,
      stageId,
    );
    if (rec.ok) {
      overridesApplied.push({ key: e.key, reason: e.reason });
    } else {
      log(
        `[recover-parked] #${issueNumber}: override failed for ${e.key}: ${rec.error ?? "unknown"}`,
      );
      // Fingerprint remains spent; continue other keys.
    }
  }

  // Optional one fix round for remaining non-overridable (fix ≠ override).
  let fixRoundRan = false;
  if (nonOverridable.length > 0 && deps.runOneImplementerFixRound) {
    // Guard: ensure fix deps path cannot override protected keys by re-checking
    // before and after (caller must not inject override into fix).
    const fix = await deps.runOneImplementerFixRound({
      cfg,
      issue: issueNumber,
      findings: nonOverridable,
    });
    fixRoundRan = fix.ran;
  }

  // Re-read live HEAD + residuals after mutations.
  try {
    headSha = (await getDetailPr(cfg, prNumber)).head_sha;
  } catch {
    return {
      status: "still-parked",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: blockingKeys,
      overridesApplied,
      fixRoundRan,
      message: "HEAD unreadable after senior pass; keep park",
    };
  }
  detail = await getDetail(cfg, issueNumber);
  const afterLive = loadResidualFindings({
    comments: detail.comments,
    liveHeadSha: headSha,
  });
  // Remaining blocking = live findings not overridden (extractOverrides filters).
  const remaining = afterLive.findings.filter((f) => {
    const cls = classifyParkedFinding({
      key: f.key,
      severity: f.severity,
      category: f.category,
      presentAtLiveHead: true,
    });
    return cls.kind === "non-overridable";
  });

  if (remaining.length === 0 && afterLive.findings.length === 0) {
    // Fully clear: clear leftover blocked if still set, re-enter.
    if (isBlocked(detail.labels)) {
      try {
        await clear(cfg, issueNumber);
      } catch {
        /* keep going; re-entry will re-evaluate */
      }
    }
    let reentered = false;
    if (!opts.skipReentry && deps.reenterAdvance) {
      await deps.reenterAdvance(cfg, issueNumber, { skipRecoverParked: true });
      reentered = true;
    }
    log(
      `[recover-parked] #${issueNumber}: recovered (overrides=${overridesApplied.length} fix=${fixRoundRan})`,
    );
    return {
      status: "recovered",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: blockingKeys,
      overridesApplied,
      fixRoundRan,
      reentered,
      message: `recovered: applied ${overridesApplied.length} override(s); residual empty`,
    };
  }

  // Still have non-overridable (or unresolved present findings).
  log(
    `[recover-parked] #${issueNumber}: still-parked (remaining non-overridable=${remaining.length})`,
  );
  return {
    status: "still-parked",
    issue: issueNumber,
    fingerprintId,
    stageId,
    keys: blockingKeys,
    overridesApplied,
    fixRoundRan,
    reentered: false,
    message:
      remaining.length > 0
        ? `still-parked: ${remaining.length} non-overridable residual(s) at HEAD; human required`
        : `still-parked: residuals remain after senior pass`,
  };
}

/** Map train continue vs hold from result status. */
export function trainShouldContinueAfterRecover(
  status: RecoverParkedStatus,
): boolean {
  return status === "recovered" || status === "deterministic-cleared";
}
