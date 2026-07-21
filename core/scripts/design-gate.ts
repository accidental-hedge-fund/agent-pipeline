// Risk-triggered design-interrogation gate (#436) — pure logic shared by the
// `design-gate` stage handler: deterministic trigger evaluation, decision-record
// validation/bounding/redaction, the challenge-verdict schema + stable challenge
// identity, and the resumable-state artifact codec. No network/git/subprocess
// calls anywhere in this file (mirrors review-policy.ts's purity contract).

import { createHash } from "node:crypto";
import { redactSecrets, sanitize, sanitizeDeep } from "./artifact-sanitize.ts";
import { normalizeTitle, severityRank } from "./review-policy.ts";
import {
  DESIGN_GATE_TRIGGER_CLASSES,
  type DesignChallenge,
  type DesignChallengeResponse,
  type DesignDecision,
  type DesignDecisionRecord,
  type DesignDecisionRecordBounding,
  type DesignGateReviewerIdentity,
  type DesignGateRound,
  type DesignGateState,
  type DesignGateTriggerClass,
  type DesignGateTriggerMatch,
  type DesignGateTriggerResult,
  type DesignInterrogationVerdict,
  type PipelineConfig,
} from "./types.ts";

export const DESIGN_DECISION_RECORD_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Trigger evaluation (#436 D2) — pure over changed paths, labels, and diff size.
// ---------------------------------------------------------------------------

/** Built-in path globs per trigger class. */
const TRIGGER_GLOBS: Record<DesignGateTriggerClass, string[]> = {
  concurrency: [
    "**/*lock*.*",
    "**/*mutex*.*",
    "**/*semaphore*.*",
    "**/*scheduler*.*",
    "**/*worker*.*",
    "**/*queue*.*",
    "**/*concurren*.*",
    "**/*goroutine*.*",
    "**/*thread*.*",
  ],
  storage: [
    "**/*migration*.*",
    "**/*schema*.*",
    "**/models/**",
    "**/*.sql",
    "**/db/**",
    "**/database/**",
    "**/*repository*.*",
  ],
  auth: [
    "**/*auth*.*",
    "**/*session*.*",
    "**/*token*.*",
    "**/*permission*.*",
    "**/*rbac*.*",
    "**/*credential*.*",
  ],
  migration: ["**/migrations/**", "**/*migration*.*", "**/*.sql"],
  infrastructure: [
    "**/Dockerfile*",
    "**/*.tf",
    "**/docker-compose*.*",
    "**/.github/workflows/**",
    "**/k8s/**",
    "**/kubernetes/**",
    "**/terraform/**",
    "**/infra/**",
  ],
  "public-api": [
    "**/api/**",
    "**/*controller*.*",
    "**/routes/**",
    "**/*route*.*",
    "**/openapi*.*",
    "**/*.proto",
    "**/graphql/**",
  ],
  architecture: ["**/architecture*.*", "**/ARCHITECTURE.md", "**/design/**"],
};

/** Size threshold for the "architecture" class's non-path trigger (#436 D2). */
export const ARCHITECTURE_FILE_THRESHOLD = 15;
export const ARCHITECTURE_LINE_THRESHOLD = 500;

function globToRegExp(pattern: string): RegExp {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§§/g, ".*");
  return new RegExp(`^${regexStr}$`, "i");
}

function matchesAnyGlob(filePath: string, patterns: string[]): string | null {
  for (const p of patterns) {
    try {
      if (globToRegExp(p).test(filePath)) return p;
    } catch {
      // malformed pattern: never matches
    }
  }
  return null;
}

export interface DesignGateTriggerInputs {
  changedFiles: string[];
  labels: string[];
  diffAdditions: number;
  diffDeletions: number;
}

/**
 * Pure trigger evaluator (#436): no network/git/subprocess access, identical
 * output for identical input. `cfg.design_gate.triggers` selects which
 * built-in classes are armed; `extra_triggers` merges additional globs into a
 * class. A changed path or an issue label matching a class's name fires it;
 * "architecture" additionally fires on a changed-file-count or changed-line
 * threshold.
 */
export function evaluateDesignGateTrigger(
  cfg: Pick<PipelineConfig, "design_gate">,
  inputs: DesignGateTriggerInputs,
): DesignGateTriggerResult {
  if (!cfg.design_gate.enabled) {
    return { triggered: false, matched: [], reason: "gate-disabled" };
  }

  const armed = new Set(cfg.design_gate.triggers);
  const matched: DesignGateTriggerMatch[] = [];
  const labelSet = new Set(inputs.labels.map((l) => l.toLowerCase()));

  for (const trigger of DESIGN_GATE_TRIGGER_CLASSES) {
    if (!armed.has(trigger)) continue;
    const globs = [...TRIGGER_GLOBS[trigger], ...(cfg.design_gate.extra_triggers[trigger] ?? [])];
    for (const file of inputs.changedFiles) {
      const matchedGlob = matchesAnyGlob(file, globs);
      if (matchedGlob) {
        matched.push({ trigger, evidence: `path "${file}" matched glob "${matchedGlob}"` });
      }
    }
    if (labelSet.has(trigger) || labelSet.has(`risk:${trigger}`)) {
      matched.push({ trigger, evidence: `issue label "${trigger}"` });
    }
    if (trigger === "architecture") {
      const totalLines = inputs.diffAdditions + inputs.diffDeletions;
      if (inputs.changedFiles.length > ARCHITECTURE_FILE_THRESHOLD) {
        matched.push({
          trigger,
          evidence: `changed-file count ${inputs.changedFiles.length} exceeds threshold ${ARCHITECTURE_FILE_THRESHOLD}`,
        });
      }
      if (totalLines > ARCHITECTURE_LINE_THRESHOLD) {
        matched.push({
          trigger,
          evidence: `changed-line count ${totalLines} exceeds threshold ${ARCHITECTURE_LINE_THRESHOLD}`,
        });
      }
    }
  }

  if (matched.length === 0) {
    return { triggered: false, matched: [], reason: "no-trigger-matched" };
  }
  return { triggered: true, matched, reason: "triggered" };
}

// ---------------------------------------------------------------------------
// Decision record — validation, bounding/truncation, redaction (#436 D3).
// ---------------------------------------------------------------------------

const TRUNCATION_MARKER = "…[truncated]";

export interface DecisionRecordValidation {
  ok: boolean;
  /** Populated when ok is false: the specific missing/invalid field(s). */
  errors: string[];
}

/** Validate a raw (untrusted, parsed-from-model-output) decision record
 *  candidate against the full contract: recognized `schema_version`, at least
 *  one decision, and every required field on every decision, including a
 *  non-empty `alternatives` array. Never accepts a partial record. */
export function validateDesignDecisionRecord(candidate: unknown): DecisionRecordValidation {
  const errors: string[] = [];
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, errors: ["record is not an object"] };
  }
  const r = candidate as Record<string, unknown>;
  if (r.schema_version !== DESIGN_DECISION_RECORD_SCHEMA_VERSION) {
    errors.push(`unrecognized schema_version "${String(r.schema_version)}"`);
    return { ok: false, errors };
  }
  if (!Array.isArray(r.decisions) || r.decisions.length === 0) {
    return { ok: false, errors: ["decisions must be a non-empty array"] };
  }
  const requiredStringFields = [
    "id",
    "title",
    "surface",
    "generalization_boundary",
    "uncertainty",
  ] as const;
  const requiredArrayFields = ["assumptions", "invariants", "evidence"] as const;
  r.decisions.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      errors.push(`decisions[${i}] is not an object`);
      return;
    }
    const d = raw as Record<string, unknown>;
    for (const field of requiredStringFields) {
      if (typeof d[field] !== "string" || (d[field] as string).trim() === "") {
        errors.push(`decisions[${i}].${field} is missing or empty`);
      }
    }
    for (const field of requiredArrayFields) {
      if (!Array.isArray(d[field]) || !(d[field] as unknown[]).every((v) => typeof v === "string")) {
        errors.push(`decisions[${i}].${field} must be a string array`);
      }
    }
    if (!Array.isArray(d.alternatives) || d.alternatives.length === 0) {
      errors.push(`decisions[${i}].alternatives must be a non-empty array`);
    } else {
      d.alternatives.forEach((raw2, j) => {
        if (typeof raw2 !== "object" || raw2 === null) {
          errors.push(`decisions[${i}].alternatives[${j}] is not an object`);
          return;
        }
        const alt = raw2 as Record<string, unknown>;
        if (typeof alt.option !== "string" || alt.option.trim() === "") {
          errors.push(`decisions[${i}].alternatives[${j}].option is missing or empty`);
        }
        if (typeof alt.rejected_because !== "string" || alt.rejected_because.trim() === "") {
          errors.push(`decisions[${i}].alternatives[${j}].rejected_because is missing or empty`);
        }
      });
    }
  });
  return { ok: errors.length === 0, errors };
}

/** Parse a decision record from raw harness output (fenced JSON or an inline
 *  object), then validate it. Returns `null` on any parse or validation
 *  failure — never a partial/defaulted record (design-decision-record spec:
 *  "rejected and re-requested rather than accepted"). */
export function parseDesignDecisionRecord(output: string): { record: DesignDecisionRecord; errors: [] } | { record: null; errors: string[] } {
  const fenceMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates: string[] = [];
  if (fenceMatch) candidates.push(fenceMatch[1]);
  const inlineMatch = output.match(/\{[\s\S]*"schema_version"[\s\S]*\}/);
  if (inlineMatch) candidates.push(inlineMatch[0]);

  let lastErrors: string[] = ["no parseable JSON object found in output"];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      lastErrors = ["candidate JSON failed to parse"];
      continue;
    }
    const validation = validateDesignDecisionRecord(parsed);
    if (validation.ok) {
      return { record: parsed as DesignDecisionRecord, errors: [] };
    }
    lastErrors = validation.errors;
  }
  return { record: null, errors: lastErrors };
}

/** Thrown when `design_gate.limits.max_artifact_bytes` is too small to encode
 *  even a single minimally-shrunk decision, so the ceiling cannot be honored
 *  without silently dropping the last decision (never allowed). */
export class DesignRecordLimitsError extends Error {}

/** Truncate `s` to at most `maxLen` bytes-of-intent (chars), reserving room
 *  for `TRUNCATION_MARKER` *within* that budget so the returned string never
 *  exceeds `maxLen` chars once the marker is appended. */
function truncateWithMarker(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const budget = Math.max(0, maxLen - TRUNCATION_MARKER.length);
  return s.slice(0, budget) + TRUNCATION_MARKER;
}

function byteSize(record: DesignDecisionRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

/** Re-clip every free-text field and cap every array field's length on a
 *  decision, using the given per-field char cap and per-array entry cap.
 *  Used for the deterministic artifact-byte-ceiling shrink pass below. */
function reclipDecision(d: DesignDecision, fieldCap: number, arrayCap: number): DesignDecision {
  const clip = (s: string) => truncateWithMarker(s, fieldCap);
  return {
    id: d.id,
    title: clip(d.title),
    surface: clip(d.surface),
    alternatives: d.alternatives
      .slice(0, Math.max(1, arrayCap))
      .map((a) => ({ option: clip(a.option), rejected_because: clip(a.rejected_because) })),
    assumptions: d.assumptions.slice(0, Math.max(1, arrayCap)).map(clip),
    invariants: d.invariants.slice(0, Math.max(1, arrayCap)).map(clip),
    evidence: d.evidence.slice(0, Math.max(1, arrayCap)).map(clip),
    generalization_boundary: clip(d.generalization_boundary),
    uncertainty: clip(d.uncertainty),
  };
}

/** Apply `design_gate.limits` bounding to a VALID decision record: cap the
 *  decision count, truncate over-long free-text fields with an explicit
 *  marker, then deterministically shrink until the serialized artifact never
 *  exceeds `max_artifact_bytes`. Truncation is always recorded — never
 *  silent. Throws `DesignRecordLimitsError` if `max_artifact_bytes` is too
 *  small to encode even one minimally-shrunk decision. */
export function boundDesignDecisionRecord(
  record: DesignDecisionRecord,
  limits: PipelineConfig["design_gate"]["limits"],
): { record: DesignDecisionRecord; bounding: DesignDecisionRecordBounding } {
  let fieldsTruncated = 0;
  const truncateField = (s: string): string => {
    if (s.length <= limits.max_field_chars) return s;
    fieldsTruncated++;
    return truncateWithMarker(s, limits.max_field_chars);
  };
  const decisionsDropped = Math.max(0, record.decisions.length - limits.max_decisions);
  const kept = record.decisions.slice(0, limits.max_decisions);

  const boundedDecisions: DesignDecision[] = kept.map((d) => ({
    id: d.id,
    title: truncateField(d.title),
    surface: truncateField(d.surface),
    alternatives: d.alternatives.map((a) => ({
      option: truncateField(a.option),
      rejected_because: truncateField(a.rejected_because),
    })),
    assumptions: d.assumptions.map(truncateField),
    invariants: d.invariants.map(truncateField),
    evidence: d.evidence.map(truncateField),
    generalization_boundary: truncateField(d.generalization_boundary),
    uncertainty: truncateField(d.uncertainty),
  }));

  let bounded: DesignDecisionRecord = { schema_version: record.schema_version, decisions: boundedDecisions };
  let artifactBytesTruncated = false;

  // Cheapest reduction first: drop whole trailing decisions while more than
  // one remains.
  while (byteSize(bounded) > limits.max_artifact_bytes && bounded.decisions.length > 1) {
    artifactBytesTruncated = true;
    bounded = { ...bounded, decisions: bounded.decisions.slice(0, -1) };
  }

  // Still over budget with the last decision(s) remaining: cap every array
  // field to a single entry, then geometrically shrink every free-text field
  // budget until the ceiling is met or the minimum encodable size is reached.
  if (byteSize(bounded) > limits.max_artifact_bytes) {
    artifactBytesTruncated = true;
    bounded = { ...bounded, decisions: bounded.decisions.map((d) => reclipDecision(d, limits.max_field_chars, 1)) };

    const minFieldCap = TRUNCATION_MARKER.length;
    let fieldCap = limits.max_field_chars;
    while (byteSize(bounded) > limits.max_artifact_bytes && fieldCap > minFieldCap) {
      fieldCap = Math.max(minFieldCap, Math.floor(fieldCap / 2));
      bounded = { ...bounded, decisions: bounded.decisions.map((d) => reclipDecision(d, fieldCap, 1)) };
    }

    if (byteSize(bounded) > limits.max_artifact_bytes) {
      throw new DesignRecordLimitsError(
        `design_gate.limits.max_artifact_bytes (${limits.max_artifact_bytes}) is too small to encode ` +
          `a minimally valid decision record (minimum achievable size is ${byteSize(bounded)} bytes)`,
      );
    }
  }

  return {
    record: bounded,
    bounding: { fieldsTruncated, decisionsDropped, artifactBytesTruncated },
  };
}

/** Redact secrets from every free-text field of a decision record before
 *  persistence or embedding (design-decision-record spec: reuses the engine's
 *  existing secret-redaction rules). */
export function redactDesignDecisionRecord(record: DesignDecisionRecord): DesignDecisionRecord {
  const clean = (s: string): string => sanitize(redactSecrets(s));
  return {
    schema_version: record.schema_version,
    decisions: record.decisions.map((d) => ({
      id: d.id,
      title: clean(d.title),
      surface: clean(d.surface),
      alternatives: d.alternatives.map((a) => ({ option: clean(a.option), rejected_because: clean(a.rejected_because) })),
      assumptions: d.assumptions.map(clean),
      invariants: d.invariants.map(clean),
      evidence: d.evidence.map(clean),
      generalization_boundary: clean(d.generalization_boundary),
      uncertainty: clean(d.uncertainty),
    })),
  };
}

// ---------------------------------------------------------------------------
// Challenge identity + blocking partition (#436 D6/D7)
// ---------------------------------------------------------------------------

/** `challengeKey = sha1(severity | decision_id | normalize(title))` truncated
 *  to 8 hex — deliberately parallel to `findingKey`, including the same title
 *  normalization, so a reworded title at the same decision/severity keeps the
 *  same key while a different decision or severity produces a different one. */
export function challengeKey(c: Pick<DesignChallenge, "severity" | "decision_id" | "title">): string {
  const basis = `${c.severity}|${c.decision_id}|${normalizeTitle(c.title)}`;
  return createHash("sha1").update(basis).digest("hex").slice(0, 8);
}

export interface DesignChallengePolicy {
  block_threshold: "critical" | "high" | "medium" | "low";
  min_confidence: number;
}

/** True when a challenge blocks under the configured policy: severity at/above
 *  `block_threshold` AND confidence at/above `min_confidence`. */
export function isBlockingChallenge(c: Pick<DesignChallenge, "severity" | "confidence">, policy: DesignChallengePolicy): boolean {
  return severityRank(c.severity) >= severityRank(policy.block_threshold) && c.confidence >= policy.min_confidence;
}

// ---------------------------------------------------------------------------
// Verdict / response parsing — conservative, mirrors parseStructuredVerdict
// (#436 D5): malformed or out-of-band output never counts as approval.
// ---------------------------------------------------------------------------

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const VALID_REQUIRED_ACTIONS = new Set(["defend", "revise", "accept-uncertainty"]);

function validateChallenge(candidate: unknown): DesignChallenge | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const c = candidate as Record<string, unknown>;
  if (typeof c.decision_id !== "string" || c.decision_id.trim() === "") return null;
  if (typeof c.title !== "string" || c.title.trim() === "") return null;
  if (typeof c.severity !== "string" || !VALID_SEVERITIES.has(c.severity)) return null;
  if (typeof c.confidence !== "number" || !Number.isFinite(c.confidence) || c.confidence < 0 || c.confidence > 1) return null;
  if (typeof c.falsifier !== "string") return null;
  if (typeof c.evidence_request !== "string") return null;
  if (typeof c.required_action !== "string" || !VALID_REQUIRED_ACTIONS.has(c.required_action)) return null;
  return {
    decision_id: c.decision_id,
    title: c.title,
    severity: c.severity as DesignChallenge["severity"],
    confidence: c.confidence,
    falsifier: c.falsifier,
    evidence_request: c.evidence_request,
    required_action: c.required_action as DesignChallenge["required_action"],
  };
}

/** Parse the interrogation reviewer's output into a validated verdict.
 *  Returns `null` — never a synthetic approval — when the output cannot be
 *  parsed into `approve` (zero challenges) or `needs-attention` with exactly
 *  3–7 valid challenges (design-interrogation-gate spec: "challenge count
 *  outside the 3–7 band ... treated as malformed"). */
export function parseDesignVerdict(output: string): DesignInterrogationVerdict | null {
  const fenceMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates: string[] = [];
  if (fenceMatch) candidates.push(fenceMatch[1]);
  const inlineMatch = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (inlineMatch) candidates.push(inlineMatch[0]);

  for (const candidate of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null) continue;
    const o = data as Record<string, unknown>;
    if (o.verdict === "approve") {
      const challenges = Array.isArray(o.challenges) ? o.challenges : [];
      if (challenges.length === 0) return { verdict: "approve", challenges: [] };
      continue; // approve with challenges is malformed — try next candidate
    }
    if (o.verdict !== "needs-attention") continue;
    if (!Array.isArray(o.challenges)) continue;
    if (o.challenges.length < 3 || o.challenges.length > 7) continue;
    const validated: DesignChallenge[] = [];
    let allValid = true;
    for (const raw of o.challenges) {
      const c = validateChallenge(raw);
      if (!c) { allValid = false; break; }
      validated.push(c);
    }
    if (!allValid) continue;
    return { verdict: "needs-attention", challenges: validated };
  }
  return null;
}

const VALID_DISPOSITIONS = new Set(["defended", "revised", "uncertainty-accepted", "out-of-scope"]);

export interface DesignResponsePayload {
  responses: DesignChallengeResponse[];
  /** The re-emitted (possibly revised) decision record, or `null` when the
   *  implementer's output did not include a validly-shaped one. */
  revisedRecord: DesignDecisionRecord | null;
}

/** Parse the implementer's response-round output into per-challenge
 *  dispositions plus the re-emitted decision record. Unlike the verdict
 *  parser this never fails the whole round — it returns whatever valid
 *  entries it finds; challenges with no valid entry simply stay unresolved
 *  (design-interrogation-gate spec: "a disposition without the required
 *  evidence ... is rejected and the challenge remains unresolved"). A
 *  disposition with empty evidence is rejected. */
export function parseDesignResponses(output: string): DesignResponsePayload {
  const fenceMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates: string[] = [];
  if (fenceMatch) candidates.push(fenceMatch[1]);
  const inlineMatch = output.match(/\{[\s\S]*"responses"[\s\S]*\}/);
  if (inlineMatch) candidates.push(inlineMatch[0]);

  for (const candidate of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null) continue;
    const o = data as Record<string, unknown>;
    if (!Array.isArray(o.responses)) continue;
    const out: DesignChallengeResponse[] = [];
    for (const raw of o.responses) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.challengeKey !== "string" || !/^[0-9a-f]{8}$/.test(r.challengeKey)) continue;
      if (typeof r.disposition !== "string" || !VALID_DISPOSITIONS.has(r.disposition)) continue;
      if (typeof r.evidence !== "string" || r.evidence.trim() === "") continue; // unsupported disposition — rejected
      out.push({ challengeKey: r.challengeKey, disposition: r.disposition as DesignChallengeResponse["disposition"], evidence: r.evidence });
    }
    const validation = validateDesignDecisionRecord(o.decision_record);
    return { responses: out, revisedRecord: validation.ok ? (o.decision_record as DesignDecisionRecord) : null };
  }
  return { responses: [], revisedRecord: null };
}

// ---------------------------------------------------------------------------
// Resumable state artifact codec (#436 D8) — hidden base64 block embedded in
// the gate's issue comment, mirroring `ReviewArtifact`'s dual persistence.
// ---------------------------------------------------------------------------

const DESIGN_GATE_ARTIFACT_RE = /^<!-- design-gate-state: ([A-Za-z0-9_-]+) -->$/gm;

/** Encode a full `DesignGateState` snapshot as a hidden HTML-comment sentinel
 *  line. Secrets are redacted just-in-time (defense in depth alongside the
 *  redaction already applied when the decision record was first bounded). */
export function encodeDesignGateState(state: DesignGateState): string {
  const cleaned = sanitizeDeep(state);
  const json = JSON.stringify(cleaned);
  const b64 = Buffer.from(json).toString("base64url");
  return `<!-- design-gate-state: ${b64} -->`;
}

/** Decode the LAST `design-gate-state` artifact from a comment body — the
 *  whole state is re-embedded on every posted comment, so only the most
 *  recent one is needed to fully rehydrate. Returns `null` when absent or
 *  malformed (never throws). */
export function decodeDesignGateState(body: string): DesignGateState | null {
  DESIGN_GATE_ARTIFACT_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = DESIGN_GATE_ARTIFACT_RE.exec(body)) !== null) lastMatch = cur;
  DESIGN_GATE_ARTIFACT_RE.lastIndex = 0;
  if (lastMatch === null) return null;
  try {
    const json = Buffer.from(lastMatch[1], "base64url").toString("utf8");
    const obj = JSON.parse(json);
    if (typeof obj !== "object" || obj === null || !Array.isArray(obj.decisionRecordVersions) || !Array.isArray(obj.rounds)) {
      return null;
    }
    return obj as DesignGateState;
  } catch {
    return null;
  }
}

export const DESIGN_GATE_COMMENT_HEADING = "## Design Interrogation";
