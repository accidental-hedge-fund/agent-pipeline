// Immutable evidence_subject contract (#692).
//
// One versioned identity object shared by readiness-relevant assurance
// artifacts (review, tester, correction, bundle rows). Producers build it from
// authoritative runtime inputs only — never harness prose or model JSON.
// Consumers compare with pure helpers (no network/git/filesystem).
//
// Digest field inputs (v1 documentation — keep tests in sync):
//
//   policy_hash
//     sha256 hex of stable sorted-key JSON over the acceptance-relevant policy
//     / config slice for the producing family. Review family: effective
//     review_policy fields (block_threshold, min_confidence, max_adversarial_rounds,
//     max_delta_rounds, ceiling_action, surface_recurrence_rounds). Tester family:
//     the same material as tester config_digest (command_identity, test_gate.enabled,
//     test_gate.timeout, max_output_chars). Callers may pass any already-computed
//     digest; buildPolicyHash only defines the default folding for structured inputs.
//
//   engine_fingerprint
//     sha256 hex of stable sorted-key JSON { version, templates_fingerprint,
//     commit_sha? } from engine-identity. Omitted commit_sha when unknown — never
//     invented. When engine identity is unavailable, producers must not invent a
//     subject that claims a fabricated engine pin (fail closed / omit readiness).
//
//   verifier_fingerprint
//     sha256 hex of the family verifier/prompt surface. Review: sorted prompt
//     template names + content hashes for review-related templates when known, or
//     a documented derivation equal to engine_fingerprint when no distinct surface
//     is available. Tester: stable JSON of toolchain_fingerprint + command identity
//     (or engine_fingerprint when no distinct toolchain). Always present on a
//     well-formed v1 subject.
//
//   required_evidence_set_revision
//     sha256 hex of stable JSON { kinds: string[] } with kinds sorted uniquely —
//     the set of evidence kinds required for readiness composition at production
//     time (e.g. ["review","tester"]). Changing the set revises the digest and
//     invalidates composition even when individual family subjects still match
//     on candidate identity.
//
// Invalidation matrix (consumers): candidate_sha / diff_hash product move →
// non-current readiness evidence; policy_hash → policy-bound acceptance non-current;
// engine_fingerprint / verifier_fingerprint → surface-bound evidence non-current;
// required_evidence_set_revision → composition non-current. run_id alone is never
// sufficient readiness identity.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const EVIDENCE_SUBJECT_SCHEMA_VERSION = 1 as const;

/** Fixed field order for v1 canonicalization (stable serialization). */
export const EVIDENCE_SUBJECT_V1_FIELD_ORDER = [
  "schema_version",
  "domain",
  "issue",
  "pr",
  "run_id",
  "candidate_sha",
  "diff_hash",
  "policy_hash",
  "engine_fingerprint",
  "verifier_fingerprint",
  "required_evidence_set_revision",
] as const;

/** Identity dimensions compared for match/mismatch (excludes schema_version). */
export const EVIDENCE_SUBJECT_COMPARE_FIELDS = [
  "domain",
  "issue",
  "pr",
  "run_id",
  "candidate_sha",
  "diff_hash",
  "policy_hash",
  "engine_fingerprint",
  "verifier_fingerprint",
  "required_evidence_set_revision",
] as const;

export type EvidenceSubjectCompareField =
  (typeof EVIDENCE_SUBJECT_COMPARE_FIELDS)[number];

export interface EvidenceSubjectV1 {
  schema_version: typeof EVIDENCE_SUBJECT_SCHEMA_VERSION;
  domain: string;
  issue: number;
  pr: number | null;
  run_id: string;
  /** Full 40-char lowercase hex candidate SHA. */
  candidate_sha: string;
  /** Canonical diff hash (same family as review diffHash), or null when unavailable. */
  diff_hash: string | null;
  policy_hash: string;
  engine_fingerprint: string;
  verifier_fingerprint: string;
  required_evidence_set_revision: string;
}

export type EvidenceSubjectComparisonOutcome =
  | "match"
  | "mismatch"
  | "malformed"
  | "legacy_unbound";

export interface EvidenceSubjectComparison {
  outcome: EvidenceSubjectComparisonOutcome;
  /** Field names that differ under canonicalization; empty on match / legacy / malformed. */
  mismatched_fields: EvidenceSubjectCompareField[];
  /** Whether the artifact side presented a subject object (possibly malformed). */
  subject_present: boolean;
}

/** Default readiness evidence kinds for v1 composition when caller does not override. */
export const DEFAULT_REQUIRED_EVIDENCE_KINDS = ["review", "tester"] as const;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const HEX_DIGEST_RE = /^[0-9a-f]+$/i;

// ---------------------------------------------------------------------------
// Pure digests (injectable inputs only)
// ---------------------------------------------------------------------------

/** Deterministic JSON with sorted object keys (arrays preserve order). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortKeysDeep(obj[k]);
    }
    return out;
  }
  return value;
}

/** sha256 hex of utf8 payload. */
export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * policy_hash from a structured acceptance-relevant policy/config slice.
 * Callers pass only the fields that govern readiness for that family.
 */
export function buildPolicyHash(policySlice: Record<string, unknown>): string {
  return sha256Hex(stableStringify(policySlice));
}

/**
 * engine_fingerprint from engine-identity surface fields.
 * `commit_sha` is included only when provided (never invented).
 */
export function buildEngineFingerprint(input: {
  version: string;
  templates_fingerprint: string;
  commit_sha?: string;
}): string {
  const payload: Record<string, unknown> = {
    version: input.version,
    templates_fingerprint: input.templates_fingerprint,
  };
  if (typeof input.commit_sha === "string" && input.commit_sha) {
    payload.commit_sha = input.commit_sha.toLowerCase();
  }
  return sha256Hex(stableStringify(payload));
}

/**
 * verifier_fingerprint from a structured verifier/prompt surface.
 * When a family has no distinct surface, pass `{ derived_from: "engine", engine_fingerprint }`
 * or call with the engine fingerprint string via {@link verifierFingerprintFromEngine}.
 */
export function buildVerifierFingerprint(surface: Record<string, unknown>): string {
  return sha256Hex(stableStringify(surface));
}

/** Documented derivation when no distinct verifier surface exists. */
export function verifierFingerprintFromEngine(engineFingerprint: string): string {
  return buildVerifierFingerprint({
    derived_from: "engine",
    engine_fingerprint: engineFingerprint,
  });
}

/**
 * required_evidence_set_revision from the set of evidence kinds required for
 * readiness at production time. Kinds are lowercased, de-duplicated, sorted.
 */
export function buildRequiredEvidenceSetRevision(
  kinds: readonly string[] = DEFAULT_REQUIRED_EVIDENCE_KINDS,
): string {
  const normalized = [
    ...new Set(
      kinds
        .map((k) => (typeof k === "string" ? k.trim().toLowerCase() : ""))
        .filter((k) => k.length > 0),
    ),
  ].sort();
  return sha256Hex(stableStringify({ kinds: normalized }));
}

/** Review-family policy slice → policy_hash (effective review_policy acceptance fields). */
export function buildReviewPolicyHash(policy: {
  block_threshold: string;
  min_confidence: number;
  max_adversarial_rounds?: number;
  max_delta_rounds?: number;
  ceiling_action?: string;
  surface_recurrence_rounds?: number | null;
}): string {
  return buildPolicyHash({
    "review_policy.block_threshold": policy.block_threshold,
    "review_policy.min_confidence": policy.min_confidence,
    "review_policy.max_adversarial_rounds": policy.max_adversarial_rounds ?? null,
    "review_policy.max_delta_rounds": policy.max_delta_rounds ?? null,
    "review_policy.ceiling_action": policy.ceiling_action ?? null,
    "review_policy.surface_recurrence_rounds":
      policy.surface_recurrence_rounds ?? null,
  });
}

/** Tester-family policy slice → policy_hash (mirrors tester config_digest material). */
export function buildTesterPolicyHash(input: {
  command_identity: string | null;
  enabled: boolean;
  timeout: number;
  max_output_chars: number;
}): string {
  return buildPolicyHash({
    command_identity: input.command_identity,
    "test_gate.enabled": input.enabled,
    "test_gate.timeout": input.timeout,
    max_output_chars: input.max_output_chars,
  });
}

// ---------------------------------------------------------------------------
// Normalize / validate / build
// ---------------------------------------------------------------------------

/** Normalize a full 40-char commit SHA to lowercase hex, or null if invalid. */
export function normalizeSubjectSha(sha: string | null | undefined): string | null {
  if (typeof sha !== "string") return null;
  const t = sha.trim();
  if (!FULL_SHA_RE.test(t)) return null;
  return t.toLowerCase();
}

/** Normalize a digest/hash string to lowercase hex, or null if empty/non-hex. */
export function normalizeDigest(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  if (!t || !HEX_DIGEST_RE.test(t)) return null;
  return t;
}

export interface BuildEvidenceSubjectInput {
  domain: string;
  issue: number;
  pr?: number | null;
  run_id: string;
  candidate_sha: string;
  diff_hash?: string | null;
  policy_hash: string;
  engine_fingerprint: string;
  verifier_fingerprint: string;
  required_evidence_set_revision: string;
}

/**
 * Build a well-formed v1 subject from runtime inputs. Throws when a required
 * non-nullable field cannot be resolved (fail closed — no fabricated identity).
 */
export function buildEvidenceSubject(input: BuildEvidenceSubjectInput): EvidenceSubjectV1 {
  const domain = typeof input.domain === "string" ? input.domain.trim() : "";
  if (!domain) {
    throw new Error("evidence_subject: domain is required");
  }
  if (typeof input.issue !== "number" || !Number.isFinite(input.issue)) {
    throw new Error("evidence_subject: issue must be a finite number");
  }
  const runId = typeof input.run_id === "string" ? input.run_id.trim() : "";
  if (!runId) {
    throw new Error("evidence_subject: run_id is required");
  }
  const candidateSha = normalizeSubjectSha(input.candidate_sha);
  if (!candidateSha) {
    throw new Error(
      "evidence_subject: candidate_sha must be a full 40-character hex SHA",
    );
  }
  const policyHash = normalizeDigest(input.policy_hash);
  if (!policyHash) {
    throw new Error("evidence_subject: policy_hash must be a non-empty hex digest");
  }
  const engineFp = normalizeDigest(input.engine_fingerprint);
  if (!engineFp) {
    throw new Error(
      "evidence_subject: engine_fingerprint must be a non-empty hex digest",
    );
  }
  const verifierFp = normalizeDigest(input.verifier_fingerprint);
  if (!verifierFp) {
    throw new Error(
      "evidence_subject: verifier_fingerprint must be a non-empty hex digest",
    );
  }
  const reqRev = normalizeDigest(input.required_evidence_set_revision);
  if (!reqRev) {
    throw new Error(
      "evidence_subject: required_evidence_set_revision must be a non-empty hex digest",
    );
  }
  let diffHash: string | null = null;
  if (input.diff_hash !== undefined && input.diff_hash !== null) {
    const d = typeof input.diff_hash === "string" ? input.diff_hash.trim().toLowerCase() : "";
    if (!d || !HEX_DIGEST_RE.test(d)) {
      throw new Error(
        "evidence_subject: diff_hash must be hex digest or null when unavailable",
      );
    }
    diffHash = d;
  }
  const pr =
    input.pr === undefined || input.pr === null
      ? null
      : typeof input.pr === "number" && Number.isFinite(input.pr)
        ? input.pr
        : null;
  if (input.pr !== undefined && input.pr !== null && pr === null) {
    throw new Error("evidence_subject: pr must be a number or null");
  }

  return {
    schema_version: EVIDENCE_SUBJECT_SCHEMA_VERSION,
    domain,
    issue: input.issue,
    pr,
    run_id: runId,
    candidate_sha: candidateSha,
    diff_hash: diffHash,
    policy_hash: policyHash,
    engine_fingerprint: engineFp,
    verifier_fingerprint: verifierFp,
    required_evidence_set_revision: reqRev,
  };
}

/**
 * Parse/validate an unknown value as EvidenceSubjectV1.
 * Returns null when missing/null/undefined (legacy path) or when malformed.
 * Distinguishes "absent" vs "malformed" via {@link parseEvidenceSubjectDetailed}.
 */
export function parseEvidenceSubject(value: unknown): EvidenceSubjectV1 | null {
  const d = parseEvidenceSubjectDetailed(value);
  return d.status === "ok" ? d.subject : null;
}

export type ParseEvidenceSubjectResult =
  | { status: "absent" }
  | { status: "malformed"; reason: string }
  | { status: "ok"; subject: EvidenceSubjectV1 };

export function parseEvidenceSubjectDetailed(
  value: unknown,
): ParseEvidenceSubjectResult {
  if (value === undefined || value === null) {
    return { status: "absent" };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { status: "malformed", reason: "evidence_subject is not an object" };
  }
  const v = value as Record<string, unknown>;
  if (v.schema_version !== 1) {
    return {
      status: "malformed",
      reason: `unsupported schema_version: ${String(v.schema_version)}`,
    };
  }
  if (typeof v.domain !== "string" || !v.domain.trim()) {
    return { status: "malformed", reason: "domain required string" };
  }
  if (typeof v.issue !== "number" || !Number.isFinite(v.issue)) {
    return { status: "malformed", reason: "issue must be a finite number" };
  }
  if (v.pr !== null && typeof v.pr !== "number") {
    return { status: "malformed", reason: "pr must be number or null" };
  }
  if (typeof v.run_id !== "string" || !v.run_id.trim()) {
    return { status: "malformed", reason: "run_id required string" };
  }
  const candidateSha = normalizeSubjectSha(
    typeof v.candidate_sha === "string" ? v.candidate_sha : null,
  );
  if (!candidateSha) {
    return {
      status: "malformed",
      reason: "candidate_sha must be a full 40-char hex SHA",
    };
  }
  let diffHash: string | null = null;
  if (v.diff_hash !== null && v.diff_hash !== undefined) {
    if (typeof v.diff_hash !== "string") {
      return { status: "malformed", reason: "diff_hash must be string or null" };
    }
    const d = v.diff_hash.trim().toLowerCase();
    if (!d || !HEX_DIGEST_RE.test(d)) {
      return { status: "malformed", reason: "diff_hash must be hex or null" };
    }
    diffHash = d;
  }
  const policyHash = normalizeDigest(
    typeof v.policy_hash === "string" ? v.policy_hash : null,
  );
  if (!policyHash) {
    return { status: "malformed", reason: "policy_hash required hex digest" };
  }
  const engineFp = normalizeDigest(
    typeof v.engine_fingerprint === "string" ? v.engine_fingerprint : null,
  );
  if (!engineFp) {
    return {
      status: "malformed",
      reason: "engine_fingerprint required hex digest",
    };
  }
  const verifierFp = normalizeDigest(
    typeof v.verifier_fingerprint === "string" ? v.verifier_fingerprint : null,
  );
  if (!verifierFp) {
    return {
      status: "malformed",
      reason: "verifier_fingerprint required hex digest",
    };
  }
  const reqRev = normalizeDigest(
    typeof v.required_evidence_set_revision === "string"
      ? v.required_evidence_set_revision
      : null,
  );
  if (!reqRev) {
    return {
      status: "malformed",
      reason: "required_evidence_set_revision required hex digest",
    };
  }
  return {
    status: "ok",
    subject: {
      schema_version: 1,
      domain: v.domain.trim(),
      issue: v.issue,
      pr: v.pr === null ? null : (v.pr as number),
      run_id: v.run_id.trim(),
      candidate_sha: candidateSha,
      diff_hash: diffHash,
      policy_hash: policyHash,
      engine_fingerprint: engineFp,
      verifier_fingerprint: verifierFp,
      required_evidence_set_revision: reqRev,
    },
  };
}

/**
 * Canonical object form: fixed key order, lowercase hex digests/SHAs,
 * explicit null for nullable fields. Pure — no I/O.
 */
export function canonicalizeEvidenceSubject(
  subject: EvidenceSubjectV1,
): EvidenceSubjectV1 {
  return {
    schema_version: 1,
    domain: subject.domain.trim(),
    issue: subject.issue,
    pr: subject.pr === null || subject.pr === undefined ? null : subject.pr,
    run_id: subject.run_id.trim(),
    candidate_sha:
      normalizeSubjectSha(subject.candidate_sha) ?? subject.candidate_sha.toLowerCase(),
    diff_hash:
      subject.diff_hash === null || subject.diff_hash === undefined
        ? null
        : subject.diff_hash.trim().toLowerCase(),
    policy_hash: subject.policy_hash.trim().toLowerCase(),
    engine_fingerprint: subject.engine_fingerprint.trim().toLowerCase(),
    verifier_fingerprint: subject.verifier_fingerprint.trim().toLowerCase(),
    required_evidence_set_revision:
      subject.required_evidence_set_revision.trim().toLowerCase(),
  };
}

/** Byte-stable JSON for a v1 subject (canonical key order, no timestamps). */
export function serializeEvidenceSubjectCanonical(subject: EvidenceSubjectV1): string {
  const c = canonicalizeEvidenceSubject(subject);
  // Fixed key order — do not use free-form stableStringify which re-sorts alphabetically
  // (same keys, but document explicit order for digest stability across versions).
  const ordered: Record<string, unknown> = {};
  for (const k of EVIDENCE_SUBJECT_V1_FIELD_ORDER) {
    ordered[k] = c[k];
  }
  return JSON.stringify(ordered);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare an artifact's subject against an evaluation pin subject.
 *
 * - absent artifact subject → legacy_unbound
 * - malformed artifact or pin → malformed
 * - well-formed both, all dimensions equal → match
 * - well-formed both, any dimension differs → mismatch + field list
 *
 * Pure with respect to inputs (no network, git, or filesystem).
 */
export function compareEvidenceSubjects(
  artifactSubject: unknown,
  pinSubject: unknown,
): EvidenceSubjectComparison {
  const artifact = parseEvidenceSubjectDetailed(artifactSubject);
  if (artifact.status === "absent") {
    return {
      outcome: "legacy_unbound",
      mismatched_fields: [],
      subject_present: false,
    };
  }
  if (artifact.status === "malformed") {
    return {
      outcome: "malformed",
      mismatched_fields: [],
      subject_present: true,
    };
  }

  const pin = parseEvidenceSubjectDetailed(pinSubject);
  if (pin.status === "absent" || pin.status === "malformed") {
    return {
      outcome: "malformed",
      mismatched_fields: [],
      subject_present: true,
    };
  }

  const a = canonicalizeEvidenceSubject(artifact.subject);
  const p = canonicalizeEvidenceSubject(pin.subject);
  const mismatched: EvidenceSubjectCompareField[] = [];
  for (const field of EVIDENCE_SUBJECT_COMPARE_FIELDS) {
    if (a[field] !== p[field]) {
      mismatched.push(field);
    }
  }
  if (mismatched.length === 0) {
    return {
      outcome: "match",
      mismatched_fields: [],
      subject_present: true,
    };
  }
  return {
    outcome: "mismatch",
    mismatched_fields: mismatched,
    subject_present: true,
  };
}

/**
 * Classify subject currency for readiness: non-current when mismatch on any of
 * the named governing fields (default: all compare fields). Match → current;
 * legacy_unbound / malformed → not current under subject rules (caller may
 * apply family legacy field fallbacks for legacy_unbound).
 */
export function subjectIsCurrentForFields(
  comparison: EvidenceSubjectComparison,
  governingFields: readonly EvidenceSubjectCompareField[] = EVIDENCE_SUBJECT_COMPARE_FIELDS,
): boolean {
  if (comparison.outcome === "match") return true;
  if (comparison.outcome !== "mismatch") return false;
  return !comparison.mismatched_fields.some((f) =>
    (governingFields as readonly string[]).includes(f),
  );
}

/** Candidate-currency governing fields (product HEAD move). */
export const CANDIDATE_CURRENCY_FIELDS: readonly EvidenceSubjectCompareField[] = [
  "candidate_sha",
];

/** Suite-currency fields for Tester evidence. */
export const TESTER_CURRENCY_FIELDS: readonly EvidenceSubjectCompareField[] = [
  "candidate_sha",
  "policy_hash",
  "engine_fingerprint",
  "verifier_fingerprint",
];

// ---------------------------------------------------------------------------
// Bundle diagnostics
// ---------------------------------------------------------------------------

export interface EvidenceSubjectDiagnostic {
  /** Artifact kind (e.g. "review", "tester", "override", "correction"). */
  kind: string;
  /** Optional reference (round number, key, correction_id, path). */
  ref?: string;
  subject_present: boolean;
  outcome: EvidenceSubjectComparisonOutcome;
  mismatched_fields: EvidenceSubjectCompareField[];
  /**
   * Echo of artifact subject identity dimensions when present and parseable —
   * lets Warrant see which values differed without recomputing digests.
   * Omitted when absent or unparseable.
   */
  artifact_subject?: EvidenceSubjectV1;
  /** Echo of the evaluation pin when comparison used a well-formed pin. */
  pin_subject?: EvidenceSubjectV1;
}

export interface DiagnosticArtifactInput {
  kind: string;
  ref?: string;
  /** Nested evidence_subject or undefined/null for legacy. */
  evidence_subject?: unknown;
}

/**
 * Build per-artifact subject diagnostics against an evaluation pin.
 * When `pin` is null, well-formed subjects are still validated but cannot match
 * a pin — they report `malformed` only when the subject itself is bad; when the
 * subject is well-formed and pin is missing, outcome is `legacy_unbound` for
 * absent subjects and `mismatch` is not invented. For present well-formed
 * subjects with no pin, outcome is `malformed` is wrong — we use comparison
 * with pin=null → pin absent yields `malformed` on the pin side.
 *
 * Prefer always supplying a pin derived from authoritative runtime state or
 * from the best-known subject on the run (see {@link selectEvaluationPinSubject}).
 */
export function buildEvidenceSubjectDiagnostics(
  pin: EvidenceSubjectV1 | null,
  artifacts: readonly DiagnosticArtifactInput[],
): EvidenceSubjectDiagnostic[] {
  const out: EvidenceSubjectDiagnostic[] = [];
  for (const art of artifacts) {
    const parsed = parseEvidenceSubjectDetailed(art.evidence_subject);
    if (parsed.status === "absent") {
      out.push({
        kind: art.kind,
        ...(art.ref !== undefined ? { ref: art.ref } : {}),
        subject_present: false,
        outcome: "legacy_unbound",
        mismatched_fields: [],
      });
      continue;
    }
    if (parsed.status === "malformed") {
      out.push({
        kind: art.kind,
        ...(art.ref !== undefined ? { ref: art.ref } : {}),
        subject_present: true,
        outcome: "malformed",
        mismatched_fields: [],
      });
      continue;
    }
    if (pin === null) {
      // Present well-formed subject but no evaluation pin: cannot claim match.
      // Surface as mismatch on all dimensions vs an empty comparison is wrong;
      // report malformed pin side as outcome mismatch with empty fields is also
      // wrong. Documented rule: without a pin, label as mismatch with empty
      // fields is insufficient. Use outcome "malformed" only for bad subjects.
      // Spec wants diagnostics vs pin — pin missing means we still echo the
      // artifact subject and set outcome to "legacy_unbound" is incorrect.
      // Practical rule: treat as mismatch with mismatched_fields listing that
      // comparison was pin-unavailable — but that invents a field. Instead:
      // outcome remains structural validity only via compare with pin absent →
      // compareEvidenceSubjects returns malformed when pin absent.
      const cmp = compareEvidenceSubjects(parsed.subject, null);
      out.push({
        kind: art.kind,
        ...(art.ref !== undefined ? { ref: art.ref } : {}),
        subject_present: true,
        outcome: cmp.outcome,
        mismatched_fields: cmp.mismatched_fields,
        artifact_subject: canonicalizeEvidenceSubject(parsed.subject),
      });
      continue;
    }
    const cmp = compareEvidenceSubjects(parsed.subject, pin);
    out.push({
      kind: art.kind,
      ...(art.ref !== undefined ? { ref: art.ref } : {}),
      subject_present: true,
      outcome: cmp.outcome,
      mismatched_fields: cmp.mismatched_fields,
      artifact_subject: canonicalizeEvidenceSubject(parsed.subject),
      pin_subject: canonicalizeEvidenceSubject(pin),
    });
  }
  return out;
}

/**
 * Prefer the last well-formed subject among readiness artifacts as the
 * best-known evaluation pin when an explicit pin was not supplied.
 * Never invents a subject from free text.
 */
export function selectEvaluationPinSubject(
  artifacts: readonly DiagnosticArtifactInput[],
): EvidenceSubjectV1 | null {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const parsed = parseEvidenceSubjectDetailed(artifacts[i].evidence_subject);
    if (parsed.status === "ok") {
      return canonicalizeEvidenceSubject(parsed.subject);
    }
  }
  return null;
}

/**
 * Collect diagnostic artifact inputs from a finalized-shaped bundle (reviews,
 * overrides, corrections) plus optional tester evidence subject.
 */
export function collectDiagnosticArtifactsFromBundle(input: {
  reviews?: ReadonlyArray<{
    round?: number;
    sha?: string;
    evidence_subject?: unknown;
  }>;
  overrides?: ReadonlyArray<{ key?: string; evidence_subject?: unknown }>;
  corrections?: ReadonlyArray<{
    correction_id?: string;
    evidence_subject?: unknown;
  }>;
  tester_evidence_subject?: unknown;
  /** When true, include a tester row even if subject is absent (legacy label). */
  include_tester_row?: boolean;
}): DiagnosticArtifactInput[] {
  const arts: DiagnosticArtifactInput[] = [];
  for (const r of input.reviews ?? []) {
    arts.push({
      kind: "review",
      ref:
        r.round !== undefined
          ? `round:${r.round}${r.sha ? `@${String(r.sha).slice(0, 7)}` : ""}`
          : r.sha
            ? `sha:${String(r.sha).slice(0, 7)}`
            : undefined,
      evidence_subject: r.evidence_subject,
    });
  }
  for (const o of input.overrides ?? []) {
    arts.push({
      kind: "override",
      ref: o.key,
      evidence_subject: o.evidence_subject,
    });
  }
  for (const c of input.corrections ?? []) {
    arts.push({
      kind: "correction",
      ref: c.correction_id,
      evidence_subject: c.evidence_subject,
    });
  }
  if (
    input.include_tester_row ||
    input.tester_evidence_subject !== undefined
  ) {
    arts.push({
      kind: "tester",
      ref: "tester-evidence.json",
      evidence_subject: input.tester_evidence_subject,
    });
  }
  return arts;
}
