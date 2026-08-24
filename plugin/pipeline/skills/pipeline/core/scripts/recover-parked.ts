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
  silentTransition,
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
import { getOnDiskForIssue, gitInWorktree } from "./worktree.ts";
import { classifyPorcelainForScratchRecover } from "./worktree-dirt.ts";
import {
  extractTesterPersistAcquire,
  type TesterPersistAcquireCode,
  type TesterPersistAcquireRecord,
} from "./tester-evidence.ts";

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
 *
 * Protected-class gate (authority / security / HIGH / CRITICAL) runs **before**
 * stale/DNR eligibility so a historical protected key absent from a later
 * residual artifact is never auto-overridden as DNR (#1061 review).
 */
export function classifyParkedFinding(f: StructuredParkedFinding): ParkedFindingClass {
  // Authority first — whole-park or per-key human-decision / missing-authority.
  if (f.authority) {
    return { kind: "non-overridable", cause: "authority" };
  }

  const sev = (f.severity ?? "").trim().toLowerCase();
  const cat = (f.category ?? "").trim().toLowerCase();

  // Category-encoded authority (human-decision-required / missing-authority /
  // product-decision / authority). Fail closed for these protected classes.
  if (
    cat === "human-decision-required" ||
    cat === "missing-authority" ||
    cat === "product-decision" ||
    cat === "authority"
  ) {
    return { kind: "non-overridable", cause: "authority" };
  }

  if (cat === "security") {
    return { kind: "non-overridable", cause: "security" };
  }
  if (sev === "critical") {
    return { kind: "non-overridable", cause: "critical" };
  }
  if (sev === "high") {
    return { kind: "non-overridable", cause: "high" };
  }

  // Only non-protected keys may use stale/DNR when absent at live HEAD.
  if (!f.presentAtLiveHead) {
    return { kind: "override-eligible", reason: "DNR" };
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

/** One supervisor pass per (issue, stage, persist_acquire_code, candidate_sha). */
export function computeTesterPersistAcquireFingerprintId(
  issue: number,
  stageId: string,
  code: TesterPersistAcquireCode,
  candidateSha: string,
): string {
  const raw = `${issue}\n${stageId}\n${code}\n${candidateSha.trim().toLowerCase()}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function testerPersistAcquireSpendKeys(
  record: TesterPersistAcquireRecord,
): string[] {
  return canonicalKeys([
    `tester-persist-acquire:${record.persist_acquire_code}`,
    record.candidate_sha.trim().toLowerCase(),
  ]);
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
  /**
   * Structured human-authority residual for this key (human-decision-required /
   * missing-authority / product-decision / authority). Absent/ambiguous signals
   * that cannot be proven non-authority remain false only when no authority
   * marker applies; explicit authority markers set true.
   */
  authority?: boolean;
}

function categoryFromSurface(surface: string | null | undefined): string | null {
  if (!surface) return null;
  const pipe = surface.lastIndexOf("|");
  if (pipe < 0) return null;
  const cat = surface.slice(pipe + 1).trim();
  return cat || null;
}

/** Categories that encode human-authority / missing-authority residuals. */
export function isAuthorityCategory(category: string | null | undefined): boolean {
  const cat = (category ?? "").trim().toLowerCase();
  return (
    cat === "human-decision-required" ||
    cat === "missing-authority" ||
    cat === "product-decision" ||
    cat === "authority"
  );
}

const HUMAN_DECISION_SENTINEL_RE =
  /<!--\s*pipeline-human-decision:\s*([0-9a-f]{8})\s+[0-9a-f]{16}\s+[0-9a-fA-F]{40}\s*-->/gi;

const HUMAN_DECISION_CATEGORY_LINE_RE =
  /\*\*Category\*\*:\s*(product-decision|authority|external-dependency)/i;

/**
 * Extract per-key human-authority signals from durable needs-human-decision
 * evidence comments. product-decision and authority are human-authority;
 * external-dependency is wait/retry (not auto-override, not human authority
 * override class for senior path — still non-overridable via authority flag
 * when the comment names a residual key so the senior path does not waive it).
 */
export function extractAuthorityKeysFromComments(
  comments: readonly { body: string }[],
): { keys: Set<string>; wholeParkAuthority: boolean } {
  const keys = new Set<string>();
  let wholeParkAuthority = false;
  for (const c of comments) {
    const body = c.body ?? "";
    if (
      body.includes("## Pipeline: Human decision required") ||
      body.includes("pipeline-human-decision:") ||
      body.includes("pipeline-needs-human-decision:")
    ) {
      // Any durable human-decision evidence makes whole-park authority refuse
      // senior override of residual keys that lack a clearer non-authority path.
      // Per-key keys are collected from the sentinel when present.
      const catLine = body.match(HUMAN_DECISION_CATEGORY_LINE_RE);
      const cat = catLine?.[1]?.toLowerCase() ?? null;
      // product-decision + authority are human authority; external-dependency
      // still blocks auto-override of the named key (fail closed for senior).
      const marksAuthority =
        cat === null ||
        cat === "product-decision" ||
        cat === "authority" ||
        cat === "external-dependency";
      if (marksAuthority) {
        wholeParkAuthority = wholeParkAuthority || cat === "product-decision" || cat === "authority" || cat === null;
        HUMAN_DECISION_SENTINEL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = HUMAN_DECISION_SENTINEL_RE.exec(body)) !== null) {
          keys.add(m[1]!.toLowerCase());
        }
        HUMAN_DECISION_SENTINEL_RE.lastIndex = 0;
        // Also parse harness declaration form when present on comments.
        const declRe =
          /<!--\s*pipeline-needs-human-decision:\s*(product-decision|authority|external-dependency)\s+([0-9a-f]{8})\s+/gi;
        let dm: RegExpExecArray | null;
        while ((dm = declRe.exec(body)) !== null) {
          const dcat = dm[1]!.toLowerCase();
          keys.add(dm[2]!.toLowerCase());
          if (dcat === "product-decision" || dcat === "authority") {
            wholeParkAuthority = true;
          }
        }
      }
    }
    // Blocker-kind attestation: human-decision-required is whole-park authority.
    const blocker = body.match(
      /<!--\s*pipeline-blocker-kind:\s*(human-decision-required)\s*-->/i,
    );
    if (blocker) wholeParkAuthority = true;
  }
  return { keys, wholeParkAuthority };
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
 *
 * Senior path MUST pass `useLatestIfNoHeadMatch: false` so DNR is never
 * invented from a SHA-mismatched fallback residual.
 */
export function loadResidualFindings(args: {
  comments: readonly { body: string; author?: string }[];
  liveHeadSha: string;
  /** When true, fall back to newest review of any SHA. Senior path: false. */
  useLatestIfNoHeadMatch?: boolean;
  /** Keys marked human-authority via durable decision evidence. */
  authorityKeys?: ReadonlySet<string>;
  /** Whole-park human-authority refuse (all residual keys). */
  wholeParkAuthority?: boolean;
}): {
  findings: ResidualFindingRecord[];
  keys: string[];
  matchedReviewedSha: string | null;
  source: "artifact" | "blocking-keys" | "none";
  /** True when a review comment's reviewedSha matched live HEAD. */
  headBound: boolean;
} {
  const authorityKeys = args.authorityKeys ?? new Set<string>();
  const wholeParkAuthority = args.wholeParkAuthority === true;
  const markAuthority = (key: string, category: string | null): boolean =>
    wholeParkAuthority ||
    authorityKeys.has(key) ||
    isAuthorityCategory(category);

  const reviewComments = args.comments.filter((c) => isReviewishBody(c.body));
  // Prefer comments whose artifact/sentinel reviewed-sha equals live HEAD.
  let chosen: { body: string; artifact: ReviewArtifact | null } | null = null;
  let headBound = false;
  for (let i = reviewComments.length - 1; i >= 0; i--) {
    const body = reviewComments[i]!.body;
    const artifact = extractReviewArtifact(body);
    const sha = artifact?.reviewedSha ?? null;
    if (sha && sha.toLowerCase() === args.liveHeadSha.toLowerCase()) {
      chosen = { body, artifact };
      headBound = true;
      break;
    }
  }
  if (!chosen && args.useLatestIfNoHeadMatch === true) {
    // Explicit opt-in fallback only (not used by senior recover-parked path).
    const last = reviewComments[reviewComments.length - 1];
    if (last) {
      chosen = { body: last.body, artifact: extractReviewArtifact(last.body) };
    }
  }
  if (!chosen) {
    return {
      findings: [],
      keys: [],
      matchedReviewedSha: null,
      source: "none",
      headBound: false,
    };
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
      const category = categoryFromSurface(surface);
      findings.push({
        key,
        severity: bf.severity,
        title: bf.title,
        surface,
        category,
        presentAtLiveHead: true,
        authority: markAuthority(key, category),
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
      const category = categoryFromSurface(surface);
      findings.push({
        key,
        severity: "unknown",
        title: "",
        surface,
        category,
        presentAtLiveHead: true,
        authority: markAuthority(key, category),
      });
    }
    return {
      findings,
      keys: canonicalKeys(findings.map((f) => f.key)),
      matchedReviewedSha: chosen.artifact.reviewedSha,
      source: "artifact",
      headBound,
    };
  }

  // Legacy marker path: severity unknown → non-overridable if present.
  const markerKeys = extractBlockingKeysFromComment(chosen.body);
  const findings: ResidualFindingRecord[] = [];
  for (const k of markerKeys) {
    const key = k.toLowerCase();
    if (overrides.has(key)) continue;
    const surface = surfaces.get(key) ?? null;
    const category = categoryFromSurface(surface);
    findings.push({
      key,
      severity: "unknown",
      title: "",
      surface,
      category,
      presentAtLiveHead: true,
      authority: markAuthority(key, category),
    });
  }
  return {
    findings,
    keys: canonicalKeys(findings.map((f) => f.key)),
    matchedReviewedSha: null,
    source: findings.length > 0 ? "blocking-keys" : "none",
    headBound,
  };
}

/**
 * Merge park-time structured findings with the live residual set.
 * Keys present only at park retain historical severity/category/authority and
 * are marked presentAtLiveHead=false (DNR candidate only if not protected).
 */
export function mergeParkAndLiveFindings(args: {
  parkKeys?: readonly string[];
  /** Preferred: structured park-time records (retains severity/category). */
  parkFindings?: readonly ResidualFindingRecord[];
  liveFindings: ResidualFindingRecord[];
}): ResidualFindingRecord[] {
  const parkByKey = new Map<string, ResidualFindingRecord>();
  if (args.parkFindings) {
    for (const f of args.parkFindings) {
      parkByKey.set(f.key, f);
    }
  }
  for (const k of args.parkKeys ?? []) {
    const key = k.toLowerCase();
    if (!parkByKey.has(key)) {
      parkByKey.set(key, {
        key,
        severity: "unknown",
        title: "",
        surface: null,
        category: null,
        presentAtLiveHead: false,
        authority: false,
      });
    }
  }
  const liveByKey = new Map(args.liveFindings.map((f) => [f.key, f]));
  const out: ResidualFindingRecord[] = [];
  const seen = new Set<string>();
  for (const k of canonicalKeys([...parkByKey.keys()])) {
    const live = liveByKey.get(k);
    const park = parkByKey.get(k)!;
    if (live) {
      // Live wins for presence; preserve authority if either side marks it.
      out.push({
        ...live,
        authority: live.authority === true || park.authority === true,
        // Prefer non-unknown severity when live is sparse but park had structure.
        severity:
          live.severity && live.severity !== "unknown"
            ? live.severity
            : park.severity || live.severity,
        category: live.category ?? park.category,
      });
    } else {
      // Retain historical structured severity/category/authority — never wipe
      // to unknown when the park record had structure (protected-class gate).
      out.push({
        key: k,
        severity: park.severity || "unknown",
        title: park.title || "",
        surface: park.surface,
        category: park.category,
        presentAtLiveHead: false,
        authority: park.authority === true || isAuthorityCategory(park.category),
      });
    }
    seen.add(k);
  }
  for (const f of args.liveFindings) {
    if (!seen.has(f.key)) out.push(f);
  }
  return out;
}

/**
 * Identify the single causal park review artifact.
 *
 * Causal park = the **oldest** review-ish comment whose reviewed-sha matches
 * the current park HEAD identity:
 * - when `liveHeadSha` is provided: that SHA (fail closed → null if none match)
 * - otherwise: the reviewed-sha of the newest review-ish comment
 *
 * Never unions findings across historical SHAs or unrelated earlier parks.
 * Within the matched SHA, oldest wins so a later incomplete residual at the
 * same HEAD still retains park-time structured severity for protected-class
 * DNR gating.
 */
export function selectCausalParkComment(
  comments: readonly { body: string }[],
  opts?: { liveHeadSha?: string | null },
): { body: string; artifact: ReviewArtifact | null } | null {
  const reviewish: Array<{ body: string; sha: string | null }> = [];
  for (const c of comments) {
    if (!isReviewishBody(c.body)) continue;
    const art = extractReviewArtifact(c.body);
    const sha = art?.reviewedSha?.toLowerCase() ?? null;
    reviewish.push({ body: c.body, sha });
  }
  if (reviewish.length === 0) return null;

  let targetSha: string | null =
    typeof opts?.liveHeadSha === "string" && opts.liveHeadSha.length > 0
      ? opts.liveHeadSha.toLowerCase()
      : null;
  if (!targetSha) {
    // Newest review's SHA defines the current park identity when HEAD is unknown.
    for (let i = reviewish.length - 1; i >= 0; i--) {
      if (reviewish[i]!.sha) {
        targetSha = reviewish[i]!.sha;
        break;
      }
    }
  }

  let matched: Array<{ body: string }> = [];
  if (targetSha) {
    matched = reviewish.filter((r) => r.sha === targetSha);
  }
  if (matched.length === 0) {
    // No SHA-bound match: fail closed when liveHeadSha was required; otherwise
    // fall back to the single newest review-ish comment only (never a union).
    if (opts?.liveHeadSha) return null;
    const last = reviewish[reviewish.length - 1]!;
    return { body: last.body, artifact: extractReviewArtifact(last.body) };
  }
  // Oldest matching comment = park-time full residual for this HEAD.
  const chosen = matched[0]!;
  return { body: chosen.body, artifact: extractReviewArtifact(chosen.body) };
}

/**
 * Extract structured park findings from the **causal** current-park review
 * artifact only. Historical reviews at other SHAs are ignored so a prior
 * code-fixed HIGH/CRITICAL cannot strand a later unrelated park.
 *
 * For keys in that artifact, structured severity/category/authority are
 * retained for protected-class gating when a later live residual at the same
 * HEAD drops them.
 */
export function extractParkFindings(
  comments: readonly { body: string }[],
  opts?: {
    authorityKeys?: ReadonlySet<string>;
    wholeParkAuthority?: boolean;
    /** Live PR HEAD — scopes causal park to reviews of this SHA. */
    liveHeadSha?: string | null;
  },
): ResidualFindingRecord[] {
  const overrides = extractOverrides([...comments]);
  const authorityKeys = opts?.authorityKeys ?? new Set<string>();
  const wholeParkAuthority = opts?.wholeParkAuthority === true;
  const causal = selectCausalParkComment(comments, {
    liveHeadSha: opts?.liveHeadSha,
  });
  if (!causal) return [];

  const body = causal.body;
  const art = causal.artifact;
  const surfaces = extractBlockingSurfacesFromComment(body);
  const byKey = new Map<string, ResidualFindingRecord>();
  const markAuthority = (key: string, category: string | null): boolean =>
    wholeParkAuthority ||
    authorityKeys.has(key) ||
    isAuthorityCategory(category);

  if (art?.blockingFindings && art.blockingFindings.length > 0) {
    for (const bf of art.blockingFindings) {
      const key = bf.key.toLowerCase();
      if (!isValidFindingKey(key) || overrides.has(key)) continue;
      const surface = bf.surface ?? surfaces.get(key) ?? null;
      const category = categoryFromSurface(surface);
      byKey.set(key, {
        key,
        severity: bf.severity,
        title: bf.title,
        surface,
        category,
        presentAtLiveHead: false,
        authority: markAuthority(key, category),
      });
    }
    for (const k of art.blockingKeys ?? []) {
      const key = k.toLowerCase();
      if (!isValidFindingKey(key) || overrides.has(key) || byKey.has(key)) continue;
      const surface = surfaces.get(key) ?? null;
      const category = categoryFromSurface(surface);
      byKey.set(key, {
        key,
        severity: "unknown",
        title: "",
        surface,
        category,
        presentAtLiveHead: false,
        authority: markAuthority(key, category),
      });
    }
    return [...byKey.values()];
  }

  const markerKeys = extractBlockingKeysFromComment(body);
  for (const k of markerKeys) {
    const key = k.toLowerCase();
    if (overrides.has(key) || byKey.has(key)) continue;
    const surface = surfaces.get(key) ?? null;
    const category = categoryFromSurface(surface);
    byKey.set(key, {
      key,
      severity: "unknown",
      title: "",
      surface,
      category,
      presentAtLiveHead: false,
      authority: markAuthority(key, category),
    });
  }
  return [...byKey.values()];
}

/** Extract park key set from the causal park artifact only. */
export function extractParkKeySet(
  comments: readonly { body: string }[],
  opts?: { liveHeadSha?: string | null },
): string[] {
  return canonicalKeys(
    extractParkFindings(comments, { liveHeadSha: opts?.liveHeadSha }).map(
      (f) => f.key,
    ),
  );
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
   * Default production path: {@link defaultTryUnlinkEngineScratch}. Tests inject
   * a no-op / fake; production CLI/train may omit this dep to use the default.
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
   * Invoked **after** the issue-run lock is released (never while held).
   */
  reenterAdvance?: (
    cfg: PipelineConfig,
    issue: number,
    opts: { skipRecoverParked: true },
  ) => Promise<void>;
  log?: (msg: string) => void;
  /** Stale-blocked resume sub-deps (tests). */
  staleBlockedDeps?: StaleBlockedResumeDeps;
  /** Injectable seams for default scratch unlink (tests). */
  scratchUnlinkDeps?: DefaultScratchUnlinkDeps;
}

/** Injectable seams for the production engine-scratch unlink default. */
export interface DefaultScratchUnlinkDeps {
  getOnDiskForIssue?: (
    cfg: PipelineConfig,
    issue: number,
  ) => Promise<{ path: string; slug: string } | null>;
  gitInWorktree?: (
    wtPath: string,
    args: string[],
    opts?: { ignoreFailure?: boolean },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  clearBlocked?: (cfg: PipelineConfig, issue: number) => Promise<void>;
  getIssueDetail?: (cfg: PipelineConfig, issue: number) => Promise<IssueDetail>;
}

/**
 * Production default for engine-scratch deterministic recover (#1020 / #1061).
 *
 * Safety scope: destructive `git clean -fd -- <path>` is limited to
 * **untracked engine-scratch paths inside the managed worktree root** returned
 * by `getOnDiskForIssue` for this issue only — never the primary checkout or
 * arbitrary paths.
 */
export async function defaultTryUnlinkEngineScratch(
  cfg: PipelineConfig,
  issueNumber: number,
  _detail: IssueDetail,
  scratchDeps: DefaultScratchUnlinkDeps = {},
): Promise<DeterministicRecoverResult> {
  const getWt = scratchDeps.getOnDiskForIssue ?? getOnDiskForIssue;
  const git = scratchDeps.gitInWorktree ?? gitInWorktree;
  const clear = scratchDeps.clearBlocked ?? clearBlocked;
  const getDetail = scratchDeps.getIssueDetail ?? getIssueDetail;

  const wt = await getWt(cfg, issueNumber);
  if (!wt) {
    return { kind: "no-op", reason: "no managed worktree for scratch unlink" };
  }
  // Managed worktree root only — all clean ops are relative to wt.path.
  const managedRoot = wt.path;
  const extraGlobs = cfg.test_gate?.non_product_dirty_globs ?? [];
  const status = await git(
    managedRoot,
    ["status", "--porcelain", "--untracked-files=all"],
    { ignoreFailure: true },
  );
  if (status.code !== 0) {
    return {
      kind: "failed",
      reason: `scratch unlink: git status failed (exit ${status.code})`,
    };
  }
  const classified = classifyPorcelainForScratchRecover(status.stdout, extraGlobs);
  if (classified.product.length > 0) {
    return {
      kind: "keep",
      reason: `scratch unlink: product dirt present (${classified.product.slice(0, 3).join(", ")})`,
    };
  }
  if (classified.untrackedScratch.length === 0) {
    return {
      kind: "no-op",
      reason: "scratch unlink: no current engine-scratch paths",
    };
  }
  const unlinked: string[] = [];
  for (const scratchPath of classified.untrackedScratch) {
    // Path is worktree-relative from porcelain; clean scoped to managed root.
    const clean = await git(
      managedRoot,
      ["clean", "-fd", "--", scratchPath],
      { ignoreFailure: true },
    );
    if (clean.code === 0) unlinked.push(scratchPath);
  }
  const afterStatus = await git(
    managedRoot,
    ["status", "--porcelain", "--untracked-files=all"],
    { ignoreFailure: true },
  );
  if (afterStatus.code !== 0) {
    return { kind: "failed", reason: "scratch unlink: post-clean status failed" };
  }
  const after = classifyPorcelainForScratchRecover(afterStatus.stdout, extraGlobs);
  if (after.product.length > 0) {
    return {
      kind: "failed",
      reason: `scratch unlink: product dirt after clean (${after.product.slice(0, 3).join(", ")})`,
    };
  }
  if (after.untrackedScratch.length > 0) {
    return {
      kind: "failed",
      reason: `scratch unlink: scratch remains (${after.untrackedScratch.join(", ")})`,
    };
  }
  let before: IssueDetail;
  try {
    before = await getDetail(cfg, issueNumber);
  } catch (err) {
    return {
      kind: "failed",
      reason: `scratch unlink: cannot re-read issue: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (before.labels.includes(BLOCKED_LABEL) || before.labels.includes("blocked")) {
    try {
      await clear(cfg, issueNumber);
    } catch (err) {
      return {
        kind: "failed",
        reason: `scratch unlink: clearBlocked failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  // Re-check: if still parked (e.g. needs-human remains), caller continues senior path.
  const afterDetail = await getDetail(cfg, issueNumber).catch(() => before);
  if (!isParkedForRecover(afterDetail.labels)) {
    return {
      kind: "cleared",
      reason: `unlinked engine scratch [${unlinked.join(", ")}] and park labels cleared`,
    };
  }
  // Scratch removed but park labels remain (e.g. needs-human) — not a full clear.
  return {
    kind: "keep",
    reason: `unlinked engine scratch [${unlinked.join(", ")}] but park labels remain`,
  };
}

/**
 * Shared re-entry helper for CLI and train (#1061).
 * Transitions needs-human → review-2 when present, then invokes advance.
 * Callers MUST invoke this only after releasing the recover-parked issue-run lock.
 *
 * Always stamps `skipRecoverParked: true` on the advance opts so a re-entered
 * advance that parks again cannot recursively invoke recover-parked on the
 * same stack (typed internal guard).
 */
export async function reenterAdvanceAfterRecoverParked(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: {
    getIssueDetail: (cfg: PipelineConfig, issue: number) => Promise<IssueDetail>;
    silentTransition?: (
      cfg: PipelineConfig,
      issue: number,
      from: string,
      to: string,
    ) => Promise<void>;
    runAdvance: (
      cfg: PipelineConfig,
      issue: number,
      opts?: { skipRecoverParked?: boolean; [k: string]: unknown },
    ) => Promise<unknown>;
  },
  advanceOpts?: { skipRecoverParked?: boolean; [k: string]: unknown },
): Promise<void> {
  const getDetail = deps.getIssueDetail;
  const transition = deps.silentTransition ?? silentTransition;
  const d = await getDetail(cfg, issueNumber);
  if (pickStage(d.labels) === "needs-human") {
    await transition(cfg, issueNumber, "needs-human", "review-2");
  }
  // Force the nested-recovery guard regardless of caller opts.
  const optsWithGuard = {
    ...(advanceOpts ?? {}),
    skipRecoverParked: true as const,
  };
  await deps.runAdvance(cfg, issueNumber, optsWithGuard);
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
 *
 * Issue-run lock is held for classification/overrides/spend only. Re-entry
 * advance runs **after** lock release so it does not self-conflict on the
 * unified issue-run lock (#1061 concurrency).
 */
export async function runRecoverParked(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: RecoverParkedOpts = {},
  deps: RecoverParkedDeps,
): Promise<RecoverParkedResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const withLockFn = deps.withIssueLock ?? defaultWithIssueLock;

  if (opts.skipRecoverParked) {
    return {
      status: "fail-closed",
      issue: issueNumber,
      message: "recover-parked refused: skipRecoverParked guard (no nested reflow)",
    };
  }

  let shouldReenter = false;
  let result: RecoverParkedResult;
  try {
    result = await withLockFn(cfg.domain, issueNumber, async () => {
      const locked = await runRecoverParkedLocked(cfg, issueNumber, opts, deps, log);
      shouldReenter = locked.shouldReenter;
      return locked.result;
    });
  } catch (err) {
    return {
      status: "fail-closed",
      issue: issueNumber,
      message: `recover-parked fail-closed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Re-enter only after lock release (preserves unified issue-run exclusion).
  if (
    shouldReenter &&
    !opts.skipReentry &&
    !opts.dryRun &&
    deps.reenterAdvance
  ) {
    try {
      await deps.reenterAdvance(cfg, issueNumber, { skipRecoverParked: true });
      return { ...result, reentered: true };
    } catch (err) {
      return {
        ...result,
        reentered: false,
        message: `${result.message}; re-entry failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return result;
}

async function runRecoverParkedLocked(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: RecoverParkedOpts,
  deps: RecoverParkedDeps,
  log: (msg: string) => void,
): Promise<{ result: RecoverParkedResult; shouldReenter: boolean }> {
  const getDetail = deps.getIssueDetail;
  const getPr = deps.getPrForIssue;
  const getDetailPr = deps.getPrDetail;
  const post = deps.postComment;
  const clear = deps.clearBlocked;
  const resumeStale = deps.tryResumeStaleBlocked ?? tryResumeStaleBlocked;
  const unlinkScratch =
    deps.tryUnlinkEngineScratch ??
    ((c, n, d) => defaultTryUnlinkEngineScratch(c, n, d, deps.scratchUnlinkDeps));
  const recordOverride =
    deps.recordKeyOverride ?? defaultRecordKeyOverrideFactory(deps);
  const wrap = (
    result: RecoverParkedResult,
    shouldReenter = false,
  ): { result: RecoverParkedResult; shouldReenter: boolean } => ({
    result,
    shouldReenter,
  });

  let detail: IssueDetail;
  try {
    detail = await getDetail(cfg, issueNumber);
  } catch (err) {
    return wrap({
      status: "fail-closed",
      issue: issueNumber,
      message: `cannot read issue: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (!isParkedForRecover(detail.labels)) {
    return wrap({
      status: "not-parked",
      issue: issueNumber,
      message: `issue #${issueNumber} is not parked (no blocked / needs-human)`,
    });
  }

  // ---- Live PR HEAD (fail closed if unreadable) ----
  let prNumber: number | null;
  let headSha: string;
  try {
    prNumber = await getPr(cfg, issueNumber);
    if (prNumber == null) {
      return wrap({
        status: "fail-closed",
        issue: issueNumber,
        message: "no linked open PR; keep park",
      });
    }
    headSha = (await getDetailPr(cfg, prNumber)).head_sha;
    if (!headSha || typeof headSha !== "string") {
      return wrap({
        status: "fail-closed",
        issue: issueNumber,
        message: "PR HEAD unreadable; keep park",
      });
    }
  } catch (err) {
    return wrap({
      status: "fail-closed",
      issue: issueNumber,
      message: `cannot read PR/HEAD: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // ---- Deterministic recover first (no senior budget) ----
  const scratch = await unlinkScratch(cfg, issueNumber, detail);
  if (scratch.kind === "cleared") {
    const after = await getDetail(cfg, issueNumber).catch(() => detail);
    if (!isParkedForRecover(after.labels)) {
      log(
        `[recover-parked] #${issueNumber}: deterministic-cleared (scratch) — ${scratch.reason}`,
      );
      // Schedule re-entry after lock release when a reenter dep is present.
      const wantReenter = !opts.skipReentry && !opts.dryRun && !!deps.reenterAdvance;
      return wrap(
        {
          status: "deterministic-cleared",
          issue: issueNumber,
          message: `deterministic scratch clear: ${scratch.reason}`,
          reentered: false,
        },
        wantReenter,
      );
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
        const wantReenter =
          !opts.skipReentry && !opts.dryRun && !!deps.reenterAdvance;
        return wrap(
          {
            status: "deterministic-cleared",
            issue: issueNumber,
            message: `deterministic stale-blocked clear: ${stale.reason}`,
            reentered: false,
          },
          wantReenter,
        );
      }
      // Labels still parked (e.g. needs-human remains) — continue senior path.
      detail = after;
    }
  }

  // ---- Senior path: residual classification at live HEAD ----
  try {
    headSha = (await getDetailPr(cfg, prNumber)).head_sha;
  } catch (err) {
    return wrap({
      status: "fail-closed",
      issue: issueNumber,
      message: `HEAD re-read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  detail = await getDetail(cfg, issueNumber).catch(() => detail);
  const stageId = stageIdForPark(detail.labels);

  // Human-authority: durable decision comments + blocker-kind + category.
  const authSignals = extractAuthorityKeysFromComments(detail.comments);
  const wholeParkAuthority = authSignals.wholeParkAuthority;

  // Causal park artifact is HEAD-scoped only — never union historical SHAs.
  const parkFindings = extractParkFindings(detail.comments, {
    authorityKeys: authSignals.keys,
    wholeParkAuthority,
    liveHeadSha: headSha,
  });
  // Senior residual MUST be HEAD-bound — never invent DNR from any-SHA fallback.
  const live = loadResidualFindings({
    comments: detail.comments,
    liveHeadSha: headSha,
    useLatestIfNoHeadMatch: false,
    authorityKeys: authSignals.keys,
    wholeParkAuthority,
  });
  if (!live.headBound) {
    const persistAcq = extractTesterPersistAcquire(detail.comments);
    if (
      persistAcq &&
      persistAcq.recorded_required_exit_0 &&
      persistAcq.persist_acquire_code
    ) {
      const persistKeys = testerPersistAcquireSpendKeys(persistAcq);
      const persistFingerprint = computeTesterPersistAcquireFingerprintId(
        issueNumber,
        stageId,
        persistAcq.persist_acquire_code,
        persistAcq.candidate_sha,
      );
      const persistSpent = extractRecoverParkedSpent(detail.comments);
      if (
        isFingerprintSpent(
          persistSpent,
          issueNumber,
          stageId,
          persistFingerprint,
          persistKeys,
        )
      ) {
        log(
          `[recover-parked] #${issueNumber}: already-spent tester persist/acquire fingerprint ${persistFingerprint}`,
        );
        return wrap({
          status: "already-spent",
          issue: issueNumber,
          fingerprintId: persistFingerprint,
          stageId,
          keys: persistKeys,
          message: `supervisor pass already spent for tester persist/acquire fingerprint ${persistFingerprint}`,
        });
      }
      if (opts.dryRun) {
        return wrap({
          status: "still-parked",
          issue: issueNumber,
          fingerprintId: persistFingerprint,
          stageId,
          keys: persistKeys,
          message:
            "dry-run: tester persist/acquire withhold is retryable; no mutations",
        });
      }
      const at = (deps.now ?? (() => new Date()))()
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
      const spendBody = formatRecoverParkedSpentComment({
        fingerprint: persistFingerprint,
        issue: issueNumber,
        stage: stageId,
        keys: persistKeys,
        at,
        footer: cfg.marker_footer,
      });
      try {
        await post(cfg, issueNumber, spendBody);
      } catch (err) {
        return wrap({
          status: "fail-closed",
          issue: issueNumber,
          fingerprintId: persistFingerprint,
          stageId,
          keys: persistKeys,
          message: `spend marker post failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      if (isBlocked(detail.labels)) {
        try {
          await clear(cfg, issueNumber);
        } catch {
          /* re-entry will re-evaluate */
        }
      }
      const wantReenter =
        !opts.skipReentry && !opts.dryRun && !!deps.reenterAdvance;
      log(
        `[recover-parked] #${issueNumber}: recovered (tester persist/acquire ${persistAcq.persist_acquire_code} retry)`,
      );
      return wrap(
        {
          status: "recovered",
          issue: issueNumber,
          fingerprintId: persistFingerprint,
          stageId,
          keys: persistKeys,
          reentered: false,
          message: `recovered: tester persist/acquire ${persistAcq.persist_acquire_code} — re-enter review (no HEAD-bound residual)`,
        },
        wantReenter,
      );
    }
    return wrap({
      status: "still-parked",
      issue: issueNumber,
      stageId,
      keys: canonicalKeys(parkFindings.map((f) => f.key)),
      message:
        "still-parked: no HEAD-bound residual review artifact; refuse DNR/stale overrides (fail closed)",
    });
  }
  // Fail closed when the causal park artifact cannot be identified at HEAD.
  if (parkFindings.length === 0 && live.findings.length === 0) {
    return wrap({
      status: "still-parked",
      issue: issueNumber,
      stageId,
      keys: [],
      message:
        "still-parked: causal park artifact empty at live HEAD; refuse senior reflow (fail closed)",
    });
  }
  const residual = mergeParkAndLiveFindings({
    parkFindings: parkFindings.length > 0 ? parkFindings : live.findings,
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
    return wrap({
      status: "already-spent",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: blockingKeys,
      message: `supervisor pass already spent for fingerprint ${fingerprintId}`,
    });
  }

  // Classify each residual (pure; dry-run stops after this without mutations).
  const eligible: Array<{ key: string; reason: SupervisorOverrideReason; evidence: string }> =
    [];
  const nonOverridable: ResidualFindingRecord[] = [];
  for (const f of residual) {
    const authority =
      f.authority === true ||
      wholeParkAuthority ||
      authSignals.keys.has(f.key) ||
      isAuthorityCategory(f.category);
    const cls = classifyParkedFinding({
      key: f.key,
      severity: f.severity,
      category: f.category,
      presentAtLiveHead: f.presentAtLiveHead,
      authority,
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
      nonOverridable.push({ ...f, authority });
    }
  }

  if (opts.dryRun) {
    return wrap({
      status: "still-parked",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: blockingKeys,
      message: `dry-run: eligible=${eligible.length} non-overridable=${nonOverridable.length}; no mutations`,
    });
  }

  // No residual keys and nothing to reflow — keep park (do not drop labels).
  if (blockingKeys.length === 0) {
    return wrap({
      status: "still-parked",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: [],
      message:
        "still-parked: no residual review keys to reflow; human punch list / labels unchanged",
    });
  }

  // Whole-park authority with residual keys: refuse senior override batch entirely.
  if (wholeParkAuthority && residual.some((f) => f.presentAtLiveHead)) {
    log(
      `[recover-parked] #${issueNumber}: still-parked (whole-park human-authority)`,
    );
    return wrap({
      status: "still-parked",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: blockingKeys,
      message:
        "still-parked: human-authority residual park; senior override path refused",
    });
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
    return wrap({
      status: "fail-closed",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: blockingKeys,
      message: `spend marker post failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Eligible overrides only (never HIGH/CRITICAL/security/authority).
  const overridesApplied: Array<{ key: string; reason: SupervisorOverrideReason }> = [];
  for (const e of eligible) {
    const recFinding = residual.find((r) => r.key === e.key);
    // Re-gate eligibility (defense in depth against internal misuse).
    const recheck = classifyParkedFinding({
      key: e.key,
      severity: recFinding?.severity,
      category: recFinding?.category,
      presentAtLiveHead: recFinding?.presentAtLiveHead ?? false,
      authority:
        recFinding?.authority === true ||
        wholeParkAuthority ||
        authSignals.keys.has(e.key) ||
        isAuthorityCategory(recFinding?.category),
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
    }
  }

  // Optional one fix round for remaining non-overridable (fix ≠ override).
  let fixRoundRan = false;
  if (nonOverridable.length > 0 && deps.runOneImplementerFixRound) {
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
    return wrap({
      status: "still-parked",
      issue: issueNumber,
      fingerprintId,
      stageId,
      keys: blockingKeys,
      overridesApplied,
      fixRoundRan,
      message: "HEAD unreadable after senior pass; keep park",
    });
  }
  detail = await getDetail(cfg, issueNumber);
  const afterAuth = extractAuthorityKeysFromComments(detail.comments);
  const afterLive = loadResidualFindings({
    comments: detail.comments,
    liveHeadSha: headSha,
    useLatestIfNoHeadMatch: false,
    authorityKeys: afterAuth.keys,
    wholeParkAuthority: afterAuth.wholeParkAuthority,
  });
  // Re-merge causal park + live so protected keys from the *current* park
  // artifact that stayed non-overridable (absent at HEAD) still keep the park.
  // Do not recover solely because the live residual artifact omitted them —
  // and do not re-import historical keys from unrelated earlier parks.
  const afterPark = extractParkFindings(detail.comments, {
    authorityKeys: afterAuth.keys,
    wholeParkAuthority: afterAuth.wholeParkAuthority,
    liveHeadSha: headSha,
  });
  const afterMerged = mergeParkAndLiveFindings({
    parkFindings: afterPark.length > 0 ? afterPark : afterLive.findings,
    liveFindings: afterLive.findings,
  });
  const remaining = afterMerged.filter((f) => {
    const cls = classifyParkedFinding({
      key: f.key,
      severity: f.severity,
      category: f.category,
      presentAtLiveHead: f.presentAtLiveHead,
      authority:
        f.authority === true ||
        afterAuth.wholeParkAuthority ||
        afterAuth.keys.has(f.key) ||
        isAuthorityCategory(f.category),
    });
    return cls.kind === "non-overridable";
  });

  if (remaining.length === 0 && afterLive.findings.length === 0) {
    // Fully clear: clear leftover blocked if still set; re-enter after lock.
    if (isBlocked(detail.labels)) {
      try {
        await clear(cfg, issueNumber);
      } catch {
        /* keep going; re-entry will re-evaluate */
      }
    }
    const wantReenter = !opts.skipReentry && !opts.dryRun && !!deps.reenterAdvance;
    log(
      `[recover-parked] #${issueNumber}: recovered (overrides=${overridesApplied.length} fix=${fixRoundRan})`,
    );
    return wrap(
      {
        status: "recovered",
        issue: issueNumber,
        fingerprintId,
        stageId,
        keys: blockingKeys,
        overridesApplied,
        fixRoundRan,
        reentered: false,
        message: `recovered: applied ${overridesApplied.length} override(s); residual empty`,
      },
      wantReenter,
    );
  }

  log(
    `[recover-parked] #${issueNumber}: still-parked (remaining non-overridable=${remaining.length})`,
  );
  return wrap({
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
  });
}

/** Map train continue vs hold from result status. */
export function trainShouldContinueAfterRecover(
  status: RecoverParkedStatus,
): boolean {
  return status === "recovered" || status === "deterministic-cleared";
}
