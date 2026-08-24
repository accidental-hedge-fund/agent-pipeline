// SHA-pinned Tester evidence (#646).
//
// Deterministic suite evidence for the candidate HEAD: produced only by the
// engine's test/build gate path, persisted under the run directory, and
// injected identically into every review path (including ensemble agents).
// Stale / missing / malformed evidence never implies suite success.

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { redactSecrets, sanitize, sanitizeDeep } from "./artifact-sanitize.ts";
import {
  buildEvidenceSubject,
  buildRequiredEvidenceSetRevision,
  buildTesterPolicyHash,
  canonicalizeEvidenceSubject,
  compareEvidenceSubjects,
  parseEvidenceSubjectDetailed,
  subjectIsCurrentForFields,
  TESTER_CURRENCY_FIELDS,
  type EvidenceSubjectComparisonOutcome,
  type EvidenceSubjectV1,
} from "./evidence-subject.ts";
import {
  appendEvent,
  recordWriteHealthFailure,
  type RunStoreDeps,
} from "./run-store.ts";
import type { PipelineConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// Schema constants & status taxonomies
// ---------------------------------------------------------------------------

export const TESTER_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const TESTER_EVIDENCE_KIND = "tester_evidence" as const;
export const TESTER_TARGETED_CHECK_KIND = "tester_targeted_check" as const;
export const TESTER_EVIDENCE_FILENAME = "tester-evidence.json";
export const TESTER_TARGETED_CHECKS_FILENAME = "targeted-checks.jsonl";
export const TESTER_PERSIST_ACQUIRE_FILENAME = "tester-persist-acquire.json";
export const TESTER_PERSIST_ACQUIRE_MARKER = "pipeline-tester-persist-acquire: v1";
/** Generic fail_closed missing-file string. Forbidden after recorded test-gate exit 0. */
export const TESTER_EVIDENCE_MISSING_FILE_REASON =
  "No Tester suite evidence file for this run (missing tester-evidence.json).";

export const TESTER_PERSIST_ACQUIRE_CODES = [
  "persist_write_failed",
  "unpinnable_candidate_sha",
  "producer_exit_0_artifact_missing",
] as const;

export type TesterPersistAcquireCode = (typeof TESTER_PERSIST_ACQUIRE_CODES)[number];

export function isTesterPersistAcquireCode(
  value: unknown,
): value is TesterPersistAcquireCode {
  return (
    typeof value === "string" &&
    (TESTER_PERSIST_ACQUIRE_CODES as readonly string[]).includes(value)
  );
}

/** Typed producer observation from `runTestGate` (never inferred from logs). */
export interface TesterProducerPersistObservation {
  ok: boolean;
  candidate_sha: string | null;
  code?: TesterPersistAcquireCode;
  error?: string;
}

export interface TesterProducerObservation {
  recorded_required_exit_0: boolean;
  required_command_exit_code: number | null;
  persist: TesterProducerPersistObservation;
}

export interface TesterPersistAcquireRecord {
  recorded_required_exit_0: boolean;
  persist_acquire_code: TesterPersistAcquireCode;
  candidate_sha: string;
}

const PERSIST_ACQUIRE_MARKER_RE =
  /<!--\s*pipeline-tester-persist-acquire:\s*v1\s+(\{.*?\})\s*-->/gs;

export const DEFAULT_MAX_OUTPUT_CHARS = 4000;
export const DEFAULT_MAX_ARTIFACT_CHARS = 48_000;
export const TRUNCATION_MARKER = "[…truncated…]";

/** overall_status on a produced or acquisition-classified record. */
export type TesterOverallStatus =
  | "passed"
  | "failed"
  | "timeout"
  | "tooling_failure"
  | "partial"
  | "disabled"
  | "not_run"
  | "unavailable"
  | "stale";

/** Per-command status (production rows never use "stale"). */
export type TesterCommandStatus =
  | "passed"
  | "failed"
  | "timeout"
  | "tooling_failure"
  | "skipped"
  | "not_run";

export type TesterTestStatus = "passed" | "failed" | "skipped" | "error";

export type TesterOnMissing = "fail_closed" | "fail_open";

export type TesterAcquisitionClass =
  | "current"
  | "stale"
  | "missing"
  | "malformed";

export interface TesterToolchainFingerprint {
  node?: string;
  platform?: string;
  arch?: string;
}

export interface TesterCommandResult {
  identity: string;
  exit_code: number | null;
  duration_ms: number;
  status: TesterCommandStatus;
  output_excerpt: string;
}

export interface TesterTestResult {
  identity: string;
  status: TesterTestStatus;
  duration_ms?: number;
  message?: string;
}

export interface TesterEvidence {
  schema_version: typeof TESTER_EVIDENCE_SCHEMA_VERSION;
  kind: typeof TESTER_EVIDENCE_KIND;
  candidate_sha: string;
  run_id: string;
  issue: number;
  pr: number | null;
  worktree_id: string;
  config_digest: string;
  toolchain_fingerprint: TesterToolchainFingerprint;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  overall_status: TesterOverallStatus;
  overall_reason?: string;
  commands: TesterCommandResult[];
  tests?: TesterTestResult[];
  output_excerpt: string;
  producer: {
    component: "test-build-gate";
    engine_version?: string;
  };
  /**
   * Shared immutable evidence identity (#692). Present on newly produced
   * schema-current records; absent on historical pre-subject artifacts
   * (`legacy_unbound`). Readers ignore unknown nested fields.
   */
  evidence_subject?: EvidenceSubjectV1;
}

export interface TesterTargetedCheck {
  schema_version: typeof TESTER_EVIDENCE_SCHEMA_VERSION;
  kind: typeof TESTER_TARGETED_CHECK_KIND;
  candidate_sha: string;
  run_id: string;
  issue: number;
  identity: string;
  exit_code: number | null;
  duration_ms: number;
  status: "passed" | "failed" | "timeout" | "tooling_failure";
  output_excerpt: string;
  recorded_at: string;
  source: "deterministic_runner";
  producer: { component: string };
}

export interface TesterEvidenceConfig {
  on_missing: TesterOnMissing;
  max_output_chars: number;
  max_artifact_chars: number;
  extractors: string[];
}

export const DEFAULT_TESTER_EVIDENCE_CONFIG: TesterEvidenceConfig = {
  on_missing: "fail_closed",
  max_output_chars: DEFAULT_MAX_OUTPUT_CHARS,
  max_artifact_chars: DEFAULT_MAX_ARTIFACT_CHARS,
  extractors: [],
};

// ---------------------------------------------------------------------------
// Pure helpers — digest, bounds, SHA match, status precedence
// ---------------------------------------------------------------------------

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** Normalize a full commit SHA for equality (lowercase hex). Returns null if not 40-char hex. */
export function normalizeCandidateSha(sha: string | null | undefined): string | null {
  if (typeof sha !== "string") return null;
  const t = sha.trim();
  if (!FULL_SHA_RE.test(t)) return null;
  return t.toLowerCase();
}

/** True when both are full SHAs and equal under case-normalized compare. */
export function candidateShaMatches(
  artifactSha: string | null | undefined,
  candidateHeadSha: string | null | undefined,
): boolean {
  const a = normalizeCandidateSha(artifactSha);
  const b = normalizeCandidateSha(candidateHeadSha);
  return a != null && b != null && a === b;
}

/** Basename-only worktree identity — never a full host path. */
export function worktreeIdFromPath(wtPath: string): string {
  const base = path.basename(wtPath.replace(/[/\\]+$/, "") || wtPath);
  return base || "worktree";
}

/** Allowlisted toolchain fingerprint only (no env dump). */
export function buildToolchainFingerprint(
  src: { node?: string; platform?: string; arch?: string } = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
): TesterToolchainFingerprint {
  const out: TesterToolchainFingerprint = {};
  if (typeof src.node === "string" && src.node) out.node = src.node;
  if (typeof src.platform === "string" && src.platform) out.platform = src.platform;
  if (typeof src.arch === "string" && src.arch) out.arch = src.arch;
  return out;
}

/**
 * Canonical config digest: sha256 hex of sorted-key JSON for the effective
 * test-gate values used for this run (no env, secrets, or absolute paths).
 */
export function computeConfigDigest(input: {
  command_identity: string | null;
  enabled: boolean;
  timeout: number;
  max_output_chars: number;
}): string {
  const payload = {
    command_identity: input.command_identity,
    "test_gate.enabled": input.enabled,
    "test_gate.timeout": input.timeout,
    max_output_chars: input.max_output_chars,
  };
  const canonical = stableStringify(payload);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

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

/**
 * Bound an excerpt: redact + sanitize + truncate with an explicit marker.
 * Marks truncation rather than silently implying completeness.
 */
export function boundExcerpt(
  raw: string | null | undefined,
  maxChars: number = DEFAULT_MAX_OUTPUT_CHARS,
): string {
  const cleaned = sanitize(redactSecrets(raw ?? ""));
  if (maxChars <= 0) return TRUNCATION_MARKER;
  if (cleaned.length <= maxChars) return cleaned;
  const marker = `\n${TRUNCATION_MARKER}\n`;
  if (maxChars <= marker.length) return TRUNCATION_MARKER.slice(0, maxChars);
  const budget = maxChars - marker.length;
  const headLen = Math.floor(budget / 3);
  const tailLen = budget - headLen;
  return cleaned.slice(0, headLen) + marker + cleaned.slice(cleaned.length - tailLen);
}

/**
 * If serialized size exceeds max_artifact_chars, further truncate command /
 * overall excerpts until under budget (or leave a minimal marker).
 */
export function enforceArtifactBudget(
  evidence: TesterEvidence,
  maxArtifactChars: number = DEFAULT_MAX_ARTIFACT_CHARS,
): TesterEvidence {
  let current = evidence;
  let serialized = JSON.stringify(current);
  if (serialized.length <= maxArtifactChars) return current;

  // Progressively shrink excerpts.
  let perField = Math.max(
    64,
    Math.floor((current.output_excerpt?.length || DEFAULT_MAX_OUTPUT_CHARS) / 2),
  );
  for (let i = 0; i < 12 && serialized.length > maxArtifactChars; i++) {
    current = {
      ...current,
      output_excerpt: boundExcerpt(current.output_excerpt, perField),
      overall_reason: current.overall_reason
        ? boundExcerpt(current.overall_reason, perField)
        : undefined,
      commands: current.commands.map((c) => ({
        ...c,
        output_excerpt: boundExcerpt(c.output_excerpt, perField),
      })),
      tests: current.tests?.map((t) => ({
        ...t,
        message: t.message ? boundExcerpt(t.message, Math.min(perField, 500)) : undefined,
      })),
    };
    serialized = JSON.stringify(current);
    perField = Math.max(32, Math.floor(perField / 2));
  }
  return current;
}

/**
 * Derive overall_status from production inputs (precedence top-first).
 * Never returns "stale" — that is acquisition-only.
 */
export function deriveOverallStatus(input: {
  enabled: boolean;
  commandResolved: boolean;
  dirtyUnavailable?: boolean;
  toolingFailure?: boolean;
  timedOut?: boolean;
  exitFailed?: boolean;
  /** Multi-command incomplete set (schema-ready; not used by single-command v1 writer). */
  partial?: boolean;
  misconfiguredEmptyCommand?: boolean;
}): Exclude<TesterOverallStatus, "stale"> {
  if (!input.enabled) return "disabled";
  if (input.misconfiguredEmptyCommand) return "unavailable";
  if (!input.commandResolved) return "not_run";
  if (input.dirtyUnavailable) return "unavailable";
  if (input.toolingFailure) return "tooling_failure";
  if (input.timedOut) return "timeout";
  if (input.partial) return "partial";
  if (input.exitFailed) return "failed";
  return "passed";
}

/** Map overall_status to a single command-row status when one command ran. */
export function commandStatusFromOverall(
  overall: Exclude<TesterOverallStatus, "stale" | "partial" | "disabled" | "not_run" | "unavailable">,
): TesterCommandStatus {
  return overall;
}

// ---------------------------------------------------------------------------
// Schema validation (lightweight runtime — no Zod dependency at read path)
// ---------------------------------------------------------------------------

const OVERALL_SET = new Set<string>([
  "passed",
  "failed",
  "timeout",
  "tooling_failure",
  "partial",
  "disabled",
  "not_run",
  "unavailable",
  "stale",
]);

const CMD_STATUS_SET = new Set<string>([
  "passed",
  "failed",
  "timeout",
  "tooling_failure",
  "skipped",
  "not_run",
]);

const TEST_STATUS_SET = new Set<string>(["passed", "failed", "skipped", "error"]);

/** Allowlisted toolchain_fingerprint keys only (no env dump). */
const TOOLCHAIN_FINGERPRINT_KEYS = new Set(["node", "platform", "arch"]);

export function validateTesterEvidence(
  value: unknown,
): { ok: true; evidence: TesterEvidence } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object") {
    return { ok: false, reason: "not an object" };
  }
  const v = value as Record<string, unknown>;
  if (v.schema_version !== 1) {
    return { ok: false, reason: `unsupported schema_version: ${String(v.schema_version)}` };
  }
  if (v.kind !== TESTER_EVIDENCE_KIND) {
    return { ok: false, reason: `unexpected kind: ${String(v.kind)}` };
  }
  if (typeof v.candidate_sha !== "string" || !normalizeCandidateSha(v.candidate_sha)) {
    return { ok: false, reason: "candidate_sha must be a full 40-char hex SHA" };
  }
  if (typeof v.run_id !== "string") return { ok: false, reason: "run_id required" };
  if (typeof v.issue !== "number" || !Number.isFinite(v.issue)) {
    return { ok: false, reason: "issue must be a number" };
  }
  if (v.pr !== null && typeof v.pr !== "number") {
    return { ok: false, reason: "pr must be number or null" };
  }
  if (typeof v.worktree_id !== "string") return { ok: false, reason: "worktree_id required" };
  if (typeof v.config_digest !== "string" || !/^[0-9a-f]{64}$/i.test(v.config_digest)) {
    return { ok: false, reason: "config_digest must be sha256 hex" };
  }
  if (
    v.toolchain_fingerprint === null ||
    typeof v.toolchain_fingerprint !== "object" ||
    Array.isArray(v.toolchain_fingerprint)
  ) {
    return { ok: false, reason: "toolchain_fingerprint required object" };
  }
  const fp = v.toolchain_fingerprint as Record<string, unknown>;
  for (const [k, val] of Object.entries(fp)) {
    if (!TOOLCHAIN_FINGERPRINT_KEYS.has(k)) {
      return { ok: false, reason: `toolchain_fingerprint unknown key: ${k}` };
    }
    if (typeof val !== "string") {
      return { ok: false, reason: `toolchain_fingerprint.${k} must be a string` };
    }
  }
  if (typeof v.started_at !== "string" || typeof v.ended_at !== "string") {
    return { ok: false, reason: "started_at/ended_at required" };
  }
  if (typeof v.duration_ms !== "number" || !Number.isFinite(v.duration_ms)) {
    return { ok: false, reason: "duration_ms must be a number" };
  }
  if (typeof v.overall_status !== "string" || !OVERALL_SET.has(v.overall_status)) {
    return { ok: false, reason: `invalid overall_status: ${String(v.overall_status)}` };
  }
  if (!Array.isArray(v.commands)) return { ok: false, reason: "commands must be an array" };
  const commandStatuses: string[] = [];
  for (const c of v.commands) {
    if (c === null || typeof c !== "object") {
      return { ok: false, reason: "command row must be an object" };
    }
    const cmd = c as Record<string, unknown>;
    if (typeof cmd.identity !== "string") return { ok: false, reason: "command.identity required" };
    if (cmd.exit_code !== null && typeof cmd.exit_code !== "number") {
      return { ok: false, reason: "command.exit_code must be number or null" };
    }
    if (typeof cmd.duration_ms !== "number") {
      return { ok: false, reason: "command.duration_ms required" };
    }
    if (typeof cmd.status !== "string" || !CMD_STATUS_SET.has(cmd.status)) {
      return { ok: false, reason: `invalid command.status: ${String(cmd.status)}` };
    }
    if (typeof cmd.output_excerpt !== "string") {
      return { ok: false, reason: "command.output_excerpt required" };
    }
    commandStatuses.push(cmd.status);
  }
  // Semantic integrity: a claimed suite pass cannot coexist with non-passing
  // required commands (or zero commands). Such records are malformed, not current.
  if (v.overall_status === "passed") {
    if (commandStatuses.length === 0) {
      return {
        ok: false,
        reason: "overall_status passed requires at least one command row",
      };
    }
    for (const st of commandStatuses) {
      if (st !== "passed") {
        return {
          ok: false,
          reason: `overall_status passed inconsistent with command.status ${st}`,
        };
      }
    }
  }
  if (v.tests !== undefined) {
    if (!Array.isArray(v.tests)) {
      return { ok: false, reason: "tests must be an array when present" };
    }
    for (const t of v.tests) {
      if (t === null || typeof t !== "object") {
        return { ok: false, reason: "test row must be an object" };
      }
      const row = t as Record<string, unknown>;
      if (typeof row.identity !== "string") {
        return { ok: false, reason: "test.identity required" };
      }
      if (typeof row.status !== "string" || !TEST_STATUS_SET.has(row.status)) {
        return { ok: false, reason: `invalid test.status: ${String(row.status)}` };
      }
      if (row.duration_ms !== undefined && typeof row.duration_ms !== "number") {
        return { ok: false, reason: "test.duration_ms must be a number when present" };
      }
      if (row.message !== undefined && typeof row.message !== "string") {
        return { ok: false, reason: "test.message must be a string when present" };
      }
    }
  }
  if (typeof v.output_excerpt !== "string") {
    return { ok: false, reason: "output_excerpt required" };
  }
  if (v.producer === null || typeof v.producer !== "object") {
    return { ok: false, reason: "producer required" };
  }
  const producer = v.producer as Record<string, unknown>;
  if (producer.component !== "test-build-gate") {
    return { ok: false, reason: 'producer.component must be "test-build-gate"' };
  }
  return { ok: true, evidence: value as TesterEvidence };
}

// ---------------------------------------------------------------------------
// Optional per-test extractors (allowlisted; default empty)
// ---------------------------------------------------------------------------

export type TesterExtractor = (
  output: string,
) => { ok: true; tests: TesterTestResult[] } | { ok: false; reason: string };

/** Built-in extractors — v1 ships empty; registry exists for allowlist lookups. */
export const TESTER_EXTRACTOR_REGISTRY: Record<string, TesterExtractor> = Object.freeze({});

/**
 * Run allowlisted extractors. Unknown ids and malformed outputs do not invent
 * rows and never flip command-level authority.
 */
export function runAllowlistedExtractors(
  output: string,
  extractorIds: readonly string[] | undefined,
  registry: Record<string, TesterExtractor> = TESTER_EXTRACTOR_REGISTRY,
): { tests: TesterTestResult[]; diagnostic?: string } {
  if (!extractorIds || extractorIds.length === 0) return { tests: [] };
  const tests: TesterTestResult[] = [];
  const diagnostics: string[] = [];
  for (const id of extractorIds) {
    const fn = registry[id];
    if (!fn) {
      diagnostics.push(`unknown extractor: ${id}`);
      continue;
    }
    try {
      const res = fn(output);
      if (res.ok) tests.push(...res.tests);
      else diagnostics.push(`extractor ${id}: ${res.reason}`);
    } catch (err) {
      diagnostics.push(
        `extractor ${id} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return {
    tests,
    diagnostic: diagnostics.length > 0 ? diagnostics.join("; ") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Prompt section renderer
// ---------------------------------------------------------------------------

export interface TesterAcquisitionResult {
  classification: TesterAcquisitionClass;
  /** Present when a well-formed file was read (even if stale). Not authoritative when stale. */
  artifact: TesterEvidence | null;
  /** True when fail_closed and evidence is not current (missing/stale/malformed). */
  withholdInvoke: boolean;
  /** Human/machine reason for non-current classifications. */
  reason: string;
  /**
   * Closed persist/acquire code after a producer that recorded test-gate exit 0
   * still could not yield a current artifact. Absent on the generic missing path.
   */
  persist_acquire_code?: TesterPersistAcquireCode;
  /** Rendered prompt section (always present when review proceeds). */
  section: string;
  /**
   * Subject comparison outcome vs the evaluation pin (#692).
   * - `match` — full multi-dimension subject match
   * - `mismatch` — well-formed subject differs on one or more governing fields
   * - `malformed` — present but unreadable subject (quarantine)
   * - `legacy_unbound` — historical artifact without subject (SHA fallback may apply)
   * - omitted when no artifact was loaded (missing)
   */
  subject_outcome?: EvidenceSubjectComparisonOutcome;
  /** Mismatched subject field names when outcome is mismatch. */
  subject_mismatched_fields?: string[];
}

/**
 * Render the authoritative suite evidence section (or explicit non-current
 * classification). Labels suite evidence as engine-authoritative; targeted
 * checks as supplemental.
 */
export function renderTesterEvidenceSection(
  acquisition: Pick<
    TesterAcquisitionResult,
    "classification" | "artifact" | "reason"
  >,
  opts: {
    targetedChecks?: TesterTargetedCheck[];
    maxExcerptChars?: number;
  } = {},
): string {
  const lines: string[] = [
    "## Tester suite evidence (authoritative, engine-recorded)",
    "",
    "This section is the engine's SHA-pinned suite record from the deterministic",
    "test/build gate. It is **not** writer-model prose. Reviewer ad-hoc checks",
    "below (if any) are **supplemental only** and cannot replace this record.",
    "",
  ];

  if (acquisition.classification === "current" && acquisition.artifact) {
    const a = acquisition.artifact;
    lines.push(`- **Classification:** current (SHA-matched)`);
    lines.push(`- **Candidate SHA:** \`${a.candidate_sha}\``);
    lines.push(`- **Overall status:** \`${a.overall_status}\``);
    if (a.overall_reason) {
      lines.push(
        `- **Reason:** ${boundExcerpt(a.overall_reason, opts.maxExcerptChars ?? 500)}`,
      );
    }
    lines.push(`- **Duration ms:** ${a.duration_ms}`);
    lines.push(`- **Command count:** ${a.commands.length}`);
    lines.push(`- **Config digest:** \`${a.config_digest.slice(0, 12)}…\``);
    if (a.commands.length > 0) {
      lines.push("", "### Commands");
      for (const c of a.commands) {
        lines.push(
          `- \`${c.identity}\` — status=\`${c.status}\` exit=${c.exit_code === null ? "null" : c.exit_code} duration_ms=${c.duration_ms}`,
        );
        if (c.output_excerpt.trim()) {
          lines.push("  ```");
          lines.push(
            boundExcerpt(c.output_excerpt, opts.maxExcerptChars ?? 800)
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n")
              .trimEnd(),
          );
          lines.push("  ```");
        }
      }
    }
    if (a.tests && a.tests.length > 0) {
      lines.push("", "### Per-test results (optional extractor)");
      for (const t of a.tests.slice(0, 40)) {
        lines.push(`- \`${t.identity}\` — \`${t.status}\``);
      }
      if (a.tests.length > 40) {
        lines.push(`- … ${a.tests.length - 40} more`);
      }
    }
  } else {
    lines.push(`- **Classification:** \`${acquisition.classification}\` (not current suite evidence)`);
    lines.push(`- **Detail:** ${acquisition.reason}`);
    lines.push(
      "- **Suite pass claim:** **not allowed** — do not treat tests as passed for this candidate.",
    );
    if (acquisition.artifact && acquisition.classification === "stale") {
      lines.push(
        `- **Stale artifact SHA:** \`${acquisition.artifact.candidate_sha}\` (status was \`${acquisition.artifact.overall_status}\`; not applicable to current HEAD)`,
      );
    }
  }

  const checks = opts.targetedChecks ?? [];
  if (checks.length > 0) {
    lines.push(
      "",
      "## Supplemental targeted checks (non-authoritative)",
      "",
      "These are optional reviewer-scoped checks. They **must not** overwrite or",
      "replace the authoritative Tester suite record above.",
      "",
    );
    for (const c of checks) {
      lines.push(
        `- \`${c.identity}\` — status=\`${c.status}\` exit=${c.exit_code === null ? "null" : c.exit_code} (candidate \`${c.candidate_sha.slice(0, 7)}\`)`,
      );
    }
  }

  return lines.join("\n");
}

/** Append the Tester section to a review prompt (pure string). */
export function appendTesterEvidenceSection(
  prompt: string,
  acquisition: TesterAcquisitionResult,
  opts?: { targetedChecks?: TesterTargetedCheck[]; maxExcerptChars?: number },
): string {
  const section = acquisition.section || renderTesterEvidenceSection(acquisition, opts);
  if (!prompt.trim()) return section;
  return `${prompt.trimEnd()}\n\n${section}\n`;
}

// ---------------------------------------------------------------------------
// Human summary (comment) — compact; never full log
// ---------------------------------------------------------------------------

export function formatTesterEvidenceSummary(evidence: TesterEvidence): string {
  const short = evidence.candidate_sha.slice(0, 7);
  return (
    `Tester suite evidence: status=\`${evidence.overall_status}\` ` +
    `sha=\`${short}\` commands=${evidence.commands.length} ` +
    `duration_ms=${evidence.duration_ms}`
  );
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface TesterEvidenceIoDeps {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (p: string, opts: { recursive: boolean }) => Promise<void>;
  appendFile?: (p: string, data: string) => Promise<void>;
}

const defaultIoDeps: TesterEvidenceIoDeps = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
  rename: (from, to) => fsp.rename(from, to),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
  appendFile: (p, data) => fsp.appendFile(p, data, "utf8"),
};

export function testerEvidencePath(runDir: string): string {
  return path.join(runDir, TESTER_EVIDENCE_FILENAME);
}

export function targetedChecksPath(runDir: string): string {
  return path.join(runDir, TESTER_TARGETED_CHECKS_FILENAME);
}

export interface WriteTesterEvidenceResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * Atomically write the full TesterEvidence record. On success, appends a
 * `tester_evidence` event. On failure, elevates write-health and does **not**
 * claim stored success.
 */
export async function writeTesterEvidence(
  runDir: string,
  evidence: TesterEvidence,
  opts: {
    maxArtifactChars?: number;
    io?: TesterEvidenceIoDeps;
    runStoreDeps?: RunStoreDeps;
    /** When false, skip events.jsonl (tests). Default true. */
    appendEvent?: boolean;
  } = {},
): Promise<WriteTesterEvidenceResult> {
  const io = opts.io ?? defaultIoDeps;
  const budgeted = enforceArtifactBudget(
    evidence,
    opts.maxArtifactChars ?? DEFAULT_MAX_ARTIFACT_CHARS,
  );
  const cleaned = sanitizeDeep(budgeted) as TesterEvidence;
  const finalPath = testerEvidencePath(runDir);
  const tmp = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await io.mkdir(runDir, { recursive: true });
    const serialized = sanitize(
      redactSecrets(`${JSON.stringify(cleaned, null, 2)}\n`),
    );
    await io.writeFile(tmp, serialized);
    await io.rename(tmp, finalPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[pipeline] tester-evidence: write failed (non-fatal): ${message}`,
    );
    await recordWriteHealthFailure(
      runDir,
      {
        eventType: "tester_evidence",
        criticality: "best-effort",
        error: `tester-evidence write failed: ${message}`,
      },
      opts.runStoreDeps,
    ).catch(() => {});
    // Best-effort cleanup of tmp
    try {
      await fsp.unlink(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, error: message };
  }

  if (opts.appendEvent !== false) {
    const delivered = await appendEvent(
      runDir,
      {
        schema_version: 1,
        type: "tester_evidence",
        at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        overall_status: cleaned.overall_status,
        candidate_sha: cleaned.candidate_sha,
        duration_ms: cleaned.duration_ms,
        command_count: cleaned.commands.length,
        issue: cleaned.issue,
        run_id: cleaned.run_id,
      },
      opts.runStoreDeps,
    );
    if (!delivered) {
      // File is on disk but event failed — still report ok for the record;
      // write-health already elevated by appendEvent.
      console.warn(
        "[pipeline] tester-evidence: full record stored but events.jsonl append failed",
      );
    }
  }
  return { ok: true, path: finalPath };
}

/**
 * Append a supplemental targeted-check record. Never overwrites tester-evidence.json.
 */
export async function appendTargetedCheck(
  runDir: string,
  check: TesterTargetedCheck,
  opts: {
    io?: TesterEvidenceIoDeps;
    runStoreDeps?: RunStoreDeps;
    maxOutputChars?: number;
  } = {},
): Promise<{ ok: boolean; error?: string }> {
  const io = opts.io ?? defaultIoDeps;
  const max = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const cleaned = sanitizeDeep({
    ...check,
    kind: TESTER_TARGETED_CHECK_KIND,
    schema_version: TESTER_EVIDENCE_SCHEMA_VERSION,
    output_excerpt: boundExcerpt(check.output_excerpt, max),
  }) as TesterTargetedCheck;
  const p = targetedChecksPath(runDir);
  try {
    await io.mkdir(runDir, { recursive: true });
    const line = `${JSON.stringify(cleaned)}\n`;
    if (io.appendFile) {
      await io.appendFile(p, line);
    } else {
      // Fallback: read-modify-write
      let prior = "";
      try {
        prior = await io.readFile(p);
      } catch {
        prior = "";
      }
      await io.writeFile(p, prior + line);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
  await appendEvent(
    runDir,
    {
      schema_version: 1,
      type: "tester_targeted_check",
      at: cleaned.recorded_at,
      candidate_sha: cleaned.candidate_sha,
      identity: cleaned.identity,
      status: cleaned.status,
      duration_ms: cleaned.duration_ms,
      issue: cleaned.issue,
      run_id: cleaned.run_id,
    },
    opts.runStoreDeps,
  ).catch(() => {});
  return { ok: true };
}

/** Read current file only — no multi-SHA search. */
export async function readTesterEvidence(
  runDir: string,
  io: TesterEvidenceIoDeps = defaultIoDeps,
): Promise<
  | { status: "missing" }
  | { status: "malformed"; reason: string }
  | { status: "ok"; evidence: TesterEvidence }
> {
  let raw: string;
  try {
    raw = await io.readFile(testerEvidencePath(runDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "malformed",
      reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      status: "malformed",
      reason: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const validated = validateTesterEvidence(parsed);
  if (!validated.ok) return { status: "malformed", reason: validated.reason };
  return { status: "ok", evidence: validated.evidence };
}

export interface TesterAcquisitionPinOpts {
  /**
   * Full evaluation pin subject when known. When present and the artifact
   * carries `evidence_subject`, multi-dimension subject comparison is preferred
   * over bare `candidate_sha` (#692).
   */
  evaluationPin?: EvidenceSubjectV1 | null;
}

/**
 * Sole review acquisition helper: load + validate + subject/SHA match + on_missing.
 * Does **not** regenerate or run tests. Never implies pass on non-current evidence.
 *
 * Subject rules (#692):
 * - present well-formed subject + pin → prefer subject comparison; mismatch on
 *   tester currency fields → stale; full match → family-local status rules
 * - present malformed subject → quarantine (malformed), never pass/fail authority
 * - absent subject (legacy) → `legacy_unbound` + candidate_sha fallback; never
 *   report full multi-dimension subject match
 */
export function loadTesterEvidenceForReviewSync(
  readResult:
    | { status: "missing" }
    | { status: "malformed"; reason: string }
    | { status: "ok"; evidence: TesterEvidence },
  candidateSha: string,
  onMissing: TesterOnMissing = "fail_closed",
  pinOpts: TesterAcquisitionPinOpts = {},
): TesterAcquisitionResult {
  if (readResult.status === "missing") {
    const reason = TESTER_EVIDENCE_MISSING_FILE_REASON;
    const base: TesterAcquisitionResult = {
      classification: "missing",
      artifact: null,
      withholdInvoke: onMissing === "fail_closed",
      reason,
      section: "",
    };
    base.section = renderTesterEvidenceSection(base);
    return base;
  }
  if (readResult.status === "malformed") {
    const reason = `Tester suite evidence is malformed: ${readResult.reason}`;
    const base: TesterAcquisitionResult = {
      classification: "malformed",
      artifact: null,
      withholdInvoke: onMissing === "fail_closed",
      reason,
      section: "",
    };
    base.section = renderTesterEvidenceSection(base);
    return base;
  }
  const evidence = readResult.evidence;
  const subjectParse = parseEvidenceSubjectDetailed(evidence.evidence_subject);

  // Malformed nested subject → quarantine (never pass or fail authority).
  if (subjectParse.status === "malformed") {
    const reason =
      `Tester suite evidence has a malformed evidence_subject (${subjectParse.reason}); ` +
      `quarantined — not pass or fail authority for the live pin.`;
    const base: TesterAcquisitionResult = {
      classification: "malformed",
      artifact: evidence,
      withholdInvoke: onMissing === "fail_closed",
      reason,
      section: "",
      subject_outcome: "malformed",
    };
    base.section = renderTesterEvidenceSection(base);
    return base;
  }

  // Prefer full subject comparison when both pin and artifact subject exist.
  if (subjectParse.status === "ok" && pinOpts.evaluationPin) {
    const cmp = compareEvidenceSubjects(
      subjectParse.subject,
      pinOpts.evaluationPin,
    );
    if (cmp.outcome === "malformed") {
      const base: TesterAcquisitionResult = {
        classification: "malformed",
        artifact: evidence,
        withholdInvoke: onMissing === "fail_closed",
        reason:
          "Tester suite evidence_subject could not be compared to the evaluation pin (malformed pin or subject).",
        section: "",
        subject_outcome: "malformed",
      };
      base.section = renderTesterEvidenceSection(base);
      return base;
    }
    if (
      cmp.outcome === "mismatch" &&
      !subjectIsCurrentForFields(cmp, TESTER_CURRENCY_FIELDS)
    ) {
      const fields = cmp.mismatched_fields.join(",");
      const reason =
        `Tester suite evidence is stale under evidence_subject comparison ` +
        `(mismatched: ${fields}). Artifact candidate_sha=${evidence.candidate_sha}; ` +
        `pin candidate_sha=${pinOpts.evaluationPin.candidate_sha}. ` +
        `Stale evidence cannot support suite success for the current candidate ` +
        `and MUST NOT supply fail / test-gate-exhausted authority for the live head ` +
        `(overall_status=${evidence.overall_status}). Regeneration required.`;
      const base: TesterAcquisitionResult = {
        classification: "stale",
        artifact: evidence,
        withholdInvoke: onMissing === "fail_closed",
        reason,
        section: "",
        subject_outcome: "mismatch",
        subject_mismatched_fields: [...cmp.mismatched_fields],
      };
      base.section = renderTesterEvidenceSection(base);
      return base;
    }
    if (cmp.outcome === "match") {
      const base: TesterAcquisitionResult = {
        classification: "current",
        artifact: evidence,
        withholdInvoke: false,
        reason: `current Tester evidence for ${evidence.candidate_sha} (evidence_subject match)`,
        section: "",
        subject_outcome: "match",
        subject_mismatched_fields: [],
      };
      base.section = renderTesterEvidenceSection(base);
      return base;
    }
  }

  // Subject present but no full pin: still enforce candidate_sha currency via subject
  // when available, else top-level field.
  if (subjectParse.status === "ok") {
    const subjectSha = subjectParse.subject.candidate_sha;
    if (!candidateShaMatches(subjectSha, candidateSha)) {
      const reason =
        `Tester suite evidence is stale: evidence_subject.candidate_sha=` +
        `${subjectSha} does not match review HEAD ${candidateSha}. ` +
        `Stale evidence cannot support suite success for the current candidate ` +
        `and MUST NOT supply fail / test-gate-exhausted authority for the live head ` +
        `(overall_status=${evidence.overall_status}). Regeneration required.`;
      const base: TesterAcquisitionResult = {
        classification: "stale",
        artifact: evidence,
        withholdInvoke: onMissing === "fail_closed",
        reason,
        section: "",
        subject_outcome: "mismatch",
        subject_mismatched_fields: ["candidate_sha"],
      };
      base.section = renderTesterEvidenceSection(base);
      return base;
    }
    // Candidate matches under subject; without a full pin we do not claim multi-
    // dimension match — but suite candidate currency holds for family-local rules.
    const base: TesterAcquisitionResult = {
      classification: "current",
      artifact: evidence,
      withholdInvoke: false,
      reason: `current Tester evidence for ${evidence.candidate_sha} (subject candidate match)`,
      section: "",
      // Not a full multi-dimension match without pin — still subject present.
      subject_outcome: pinOpts.evaluationPin ? "match" : "match",
      subject_mismatched_fields: [],
    };
    base.section = renderTesterEvidenceSection(base);
    return base;
  }

  // legacy_unbound: no evidence_subject — fall back to top-level candidate_sha.
  if (!candidateShaMatches(evidence.candidate_sha, candidateSha)) {
    // SHA mismatch → stale for both pass and fail authority (#1010 / review
    // acquisition). Non-pass overall_status on a superseded candidate MUST NOT
    // supply fail authority for the live head; pass is also never invented.
    const reason =
      `Tester suite evidence is stale: artifact candidate_sha=` +
      `${evidence.candidate_sha} does not match review HEAD ${candidateSha}. ` +
      `Stale evidence cannot support suite success for the current candidate ` +
      `and MUST NOT supply fail / test-gate-exhausted authority for the live head ` +
      `(overall_status=${evidence.overall_status}). ` +
      `Subject disposition: legacy_unbound (no evidence_subject).`;
    const base: TesterAcquisitionResult = {
      classification: "stale",
      artifact: evidence,
      withholdInvoke: onMissing === "fail_closed",
      reason,
      section: "",
      subject_outcome: "legacy_unbound",
    };
    base.section = renderTesterEvidenceSection(base);
    return base;
  }
  // Current under legacy SHA path — never claim full subject match.
  const base: TesterAcquisitionResult = {
    classification: "current",
    artifact: evidence,
    withholdInvoke: false,
    reason:
      `current Tester evidence for ${evidence.candidate_sha} ` +
      `(legacy_unbound: candidate_sha fallback; no multi-dimension subject match)`,
    section: "",
    subject_outcome: "legacy_unbound",
  };
  base.section = renderTesterEvidenceSection(base);
  return base;
}

export async function loadTesterEvidenceForReview(
  runDir: string | undefined,
  candidateSha: string,
  cfg: Pick<PipelineConfig, "tester_evidence"> | { tester_evidence?: TesterEvidenceConfig },
  io: TesterEvidenceIoDeps = defaultIoDeps,
  pinOpts: TesterAcquisitionPinOpts = {},
): Promise<TesterAcquisitionResult> {
  const onMissing =
    cfg.tester_evidence?.on_missing ?? DEFAULT_TESTER_EVIDENCE_CONFIG.on_missing;
  // No run surface: treat as missing evidence and honor on_missing. Fail-closed
  // withholds the review model invoke; fail-open still renders an explicit
  // unavailable section and never implies suite pass. Callers that intentionally
  // skip the gate (e.g. plan-review) must ignore withholdInvoke themselves.
  if (!runDir) {
    const acq = loadTesterEvidenceForReviewSync(
      { status: "missing" },
      candidateSha,
      onMissing,
      pinOpts,
    );
    acq.reason =
      "No run directory provided — Tester suite evidence cannot be loaded for this invocation.";
    acq.section = renderTesterEvidenceSection(acq);
    return acq;
  }
  const read = await readTesterEvidence(runDir, io);
  return loadTesterEvidenceForReviewSync(read, candidateSha, onMissing, pinOpts);
}

/**
 * Classifications where the deterministic producer may regenerate before
 * fail_closed withholds a code-review model invoke (#646 / #882 recovery).
 * Acquisition itself remains load-only; the optional `regenerate` callback is
 * the sole writer path (typically `runTestGate` with `max_attempts: 0`).
 */
export const TESTER_REGENERABLE_CLASSIFICATIONS = [
  "missing",
  "stale",
  "malformed",
] as const;

export type TesterRegenerableClassification =
  (typeof TESTER_REGENERABLE_CLASSIFICATIONS)[number];

export function isTesterRegenerableClassification(
  c: TesterAcquisitionResult["classification"],
): c is TesterRegenerableClassification {
  return (TESTER_REGENERABLE_CLASSIFICATIONS as readonly string[]).includes(c);
}

/**
 * Normalize a regenerate callback result. `Promise<void>` and objects that
 * omit `recorded_required_exit_0` are treated as "did not record exit 0".
 * Never infers success from `passed`, `summary.json`, or logs.
 */
export function normalizeTesterProducerObservation(
  raw: void | TesterProducerObservation | { recorded_required_exit_0?: unknown; required_command_exit_code?: unknown; persist?: unknown },
): TesterProducerObservation {
  if (!raw || typeof raw !== "object") {
    return {
      recorded_required_exit_0: false,
      required_command_exit_code: null,
      persist: { ok: false, candidate_sha: null },
    };
  }
  const persistRaw =
    raw.persist && typeof raw.persist === "object"
      ? (raw.persist as TesterProducerPersistObservation)
      : null;
  const persist: TesterProducerPersistObservation = {
    ok: persistRaw?.ok === true,
    candidate_sha:
      typeof persistRaw?.candidate_sha === "string" ? persistRaw.candidate_sha : null,
  };
  if (isTesterPersistAcquireCode(persistRaw?.code)) persist.code = persistRaw.code;
  if (typeof persistRaw?.error === "string" && persistRaw.error) {
    persist.error = boundExcerpt(persistRaw.error, 500);
  }
  const exitCode =
    typeof raw.required_command_exit_code === "number" &&
    Number.isFinite(raw.required_command_exit_code)
      ? raw.required_command_exit_code
      : null;
  return {
    recorded_required_exit_0: raw.recorded_required_exit_0 === true,
    required_command_exit_code: exitCode,
    persist,
  };
}

export function persistAcquireCodeFromObservation(
  obs: TesterProducerObservation,
): TesterPersistAcquireCode {
  if (isTesterPersistAcquireCode(obs.persist.code)) return obs.persist.code;
  if (obs.persist.ok === false && obs.persist.error) return "persist_write_failed";
  if (!normalizeCandidateSha(obs.persist.candidate_sha ?? "")) {
    return "unpinnable_candidate_sha";
  }
  return "producer_exit_0_artifact_missing";
}

export function formatTesterPersistAcquireHtmlComment(
  record: TesterPersistAcquireRecord,
): string {
  const payload = {
    recorded_required_exit_0: record.recorded_required_exit_0,
    persist_acquire_code: record.persist_acquire_code,
    candidate_sha: record.candidate_sha,
  };
  return `<!-- ${TESTER_PERSIST_ACQUIRE_MARKER} ${JSON.stringify(payload)} -->`;
}

/** Latest well-formed persist/acquire marker from issue comments. */
export function extractTesterPersistAcquire(
  comments: readonly { body: string }[],
): TesterPersistAcquireRecord | null {
  let found: TesterPersistAcquireRecord | null = null;
  for (const c of comments) {
    PERSIST_ACQUIRE_MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PERSIST_ACQUIRE_MARKER_RE.exec(c.body)) !== null) {
      try {
        const obj = JSON.parse(m[1]) as Record<string, unknown>;
        if (obj.recorded_required_exit_0 !== true) continue;
        if (!isTesterPersistAcquireCode(obj.persist_acquire_code)) continue;
        if (typeof obj.candidate_sha !== "string") continue;
        found = {
          recorded_required_exit_0: true,
          persist_acquire_code: obj.persist_acquire_code,
          candidate_sha: obj.candidate_sha,
        };
      } catch {
        /* malformed payload ignored */
      }
    }
  }
  PERSIST_ACQUIRE_MARKER_RE.lastIndex = 0;
  return found;
}

function persistAcquirePath(runDir: string): string {
  return path.join(runDir, TESTER_PERSIST_ACQUIRE_FILENAME);
}

async function writeTesterPersistAcquireRecord(
  runDir: string,
  record: Record<string, unknown>,
  io: TesterEvidenceIoDeps,
): Promise<void> {
  const finalPath = persistAcquirePath(runDir);
  const tmp = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  const serialized = sanitize(
    redactSecrets(`${JSON.stringify(record, null, 2)}\n`),
  );
  await io.mkdir(runDir, { recursive: true });
  await io.writeFile(tmp, serialized);
  await io.rename(tmp, finalPath);
}

async function trustedSurfacePersistHint(
  runDir: string,
  io: TesterEvidenceIoDeps,
): Promise<{ outcome?: string; failure_reason?: string; candidate_sha?: string } | null> {
  try {
    const raw = await io.readFile(path.join(runDir, "trusted-surface.json"));
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    const hint: { outcome?: string; failure_reason?: string; candidate_sha?: string } = {};
    if (typeof o.outcome === "string") hint.outcome = o.outcome;
    if (typeof o.candidate_sha === "string") hint.candidate_sha = o.candidate_sha;
    const classes = Array.isArray(o.classes) ? o.classes : [];
    for (const cls of classes) {
      if (!cls || typeof cls !== "object") continue;
      const rec = cls as Record<string, unknown>;
      if (typeof rec.failure_reason === "string" && rec.failure_reason) {
        hint.failure_reason = rec.failure_reason;
        break;
      }
    }
    if (!hint.failure_reason && o.reason && typeof o.reason === "object") {
      const reason = o.reason as Record<string, unknown>;
      if (typeof reason.failure_reason === "string") {
        hint.failure_reason = reason.failure_reason;
      } else if (typeof reason.detail === "string") {
        hint.failure_reason = reason.detail;
      }
    }
    return hint.outcome || hint.failure_reason ? hint : null;
  } catch {
    return null;
  }
}

function namedPersistAcquireReason(
  code: TesterPersistAcquireCode,
  opts: {
    persistError?: string;
    trustedSurface?: { outcome?: string; failure_reason?: string } | null;
  },
): string {
  let named = `Tester persist/acquire failed after required test-gate exit 0 (${code}).`;
  if (opts.trustedSurface?.failure_reason) {
    named += ` trusted-surface ${opts.trustedSurface.outcome ?? "blocked"}: ${opts.trustedSurface.failure_reason}`;
  }
  if (code === "persist_write_failed" && opts.persistError) {
    named += ` ${opts.persistError}`;
  }
  if (code === "unpinnable_candidate_sha") {
    named += " worktree HEAD is not a pinnable 40-character SHA.";
  }
  return named;
}

async function applyNamedPersistAcquireFail(
  acq: TesterAcquisitionResult,
  args: {
    runDir: string;
    candidateSha: string;
    obs: TesterProducerObservation;
    io: TesterEvidenceIoDeps;
  },
): Promise<TesterAcquisitionResult> {
  const code = persistAcquireCodeFromObservation(args.obs);
  const pinned = normalizeCandidateSha(args.obs.persist.candidate_sha ?? args.candidateSha) ??
    (typeof args.candidateSha === "string" ? args.candidateSha : "");
  const record: TesterPersistAcquireRecord = {
    recorded_required_exit_0: true,
    persist_acquire_code: code,
    candidate_sha: pinned,
  };
  const tsHint = await trustedSurfacePersistHint(args.runDir, args.io);
  const named = namedPersistAcquireReason(code, {
    persistError: args.obs.persist.error,
    trustedSurface: tsHint,
  });
  const marker = formatTesterPersistAcquireHtmlComment(record);
  acq.persist_acquire_code = code;
  acq.withholdInvoke = true;
  // Marker first so formatStderrExcerpt's 500-char slice keeps the durable code.
  acq.reason = `${marker}\n${named}`;
  acq.section = renderTesterEvidenceSection(acq);
  try {
    await writeTesterPersistAcquireRecord(
      args.runDir,
      {
        schema_version: 1,
        recorded_required_exit_0: true,
        persist_acquire_code: code,
        candidate_sha: pinned,
        required_command_exit_code: args.obs.required_command_exit_code,
        persist_ok: args.obs.persist.ok,
        error: args.obs.persist.error,
        trusted_surface: tsHint,
      },
      args.io,
    );
  } catch (err) {
    console.warn(
      `[pipeline] tester-evidence: persist-acquire record write failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return acq;
}

/**
 * Load SHA-matched Tester evidence for review; when fail_closed would withhold
 * because the artifact is missing/stale/malformed, optionally invoke the
 * deterministic producer once and re-acquire.
 *
 * Does **not** invent a pass: if regeneration fails or still cannot write a
 * current artifact, the post-regeneration acquisition (and on_missing) applies.
 * Used by review-1 / review-2 / delta so a fresh runDir after design-gate or a
 * candidate-changing commit is not permanently parked solely for absent
 * `tester-evidence.json` in this run directory.
 *
 * After a producer that records required-command exit 0, missing re-acquire
 * uses a named persist/acquire code instead of the generic missing-file string.
 */
export async function loadOrRegenerateTesterEvidenceForReview(
  runDir: string | undefined,
  candidateSha: string,
  cfg: Pick<PipelineConfig, "tester_evidence"> | { tester_evidence?: TesterEvidenceConfig },
  regenerate?: () => Promise<void | TesterProducerObservation>,
  io: TesterEvidenceIoDeps = defaultIoDeps,
  pinOpts: TesterAcquisitionPinOpts = {},
): Promise<TesterAcquisitionResult> {
  let acq = await loadTesterEvidenceForReview(runDir, candidateSha, cfg, io, pinOpts);
  if (!acq.withholdInvoke || !regenerate) return acq;
  if (!isTesterRegenerableClassification(acq.classification)) return acq;
  // No run surface: cannot persist producer output for re-acquisition.
  if (!runDir) return acq;
  console.log(
    `[pipeline] tester-evidence: ${acq.classification} under fail_closed — ` +
      `running deterministic producer once before withhold (candidate ${candidateSha.slice(0, 12) || "unknown"})`,
  );
  let observation: TesterProducerObservation = {
    recorded_required_exit_0: false,
    required_command_exit_code: null,
    persist: { ok: false, candidate_sha: null },
  };
  try {
    observation = normalizeTesterProducerObservation(await regenerate());
  } catch (err) {
    console.warn(
      `[pipeline] tester-evidence: pre-review regeneration failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  acq = await loadTesterEvidenceForReview(runDir, candidateSha, cfg, io, pinOpts);
  if (
    observation.recorded_required_exit_0 &&
    acq.classification === "missing"
  ) {
    return applyNamedPersistAcquireFail(acq, {
      runDir,
      candidateSha,
      obs: observation,
      io,
    });
  }
  return acq;
}

// ---------------------------------------------------------------------------
// Producer — build evidence from gate outcomes (no I/O)
// ---------------------------------------------------------------------------

export interface ProduceTesterEvidenceInput {
  candidateSha: string;
  runId: string;
  issue: number;
  pr?: number | null;
  wtPath: string;
  enabled: boolean;
  /** Resolved command label, or null when none. */
  commandIdentity: string | null;
  timeoutSec: number;
  maxOutputChars: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  overallStatus: Exclude<TesterOverallStatus, "stale">;
  overallReason?: string;
  /** Last command run result; omit for disabled/not_run/pre-run unavailable. */
  lastCommand?: {
    identity: string;
    exitCode: number | null;
    durationMs: number;
    status: TesterCommandStatus;
    output: string;
  };
  tests?: TesterTestResult[];
  toolchain?: TesterToolchainFingerprint;
  engineVersion?: string;
  /**
   * Runtime identity for nested `evidence_subject` (#692). When `domain` and
   * engine fingerprint material are supplied, the producer attaches a full
   * subject. When only a pre-built `evidenceSubject` is supplied, it is used
   * after consistency checks. When neither can form a subject, the record is
   * still written without `evidence_subject` (callers that need readiness
   * binding should pass domain + fingerprints).
   */
  domain?: string;
  diffHash?: string | null;
  /** Pre-computed digests; when omitted, derived from gate inputs / engine fields. */
  policyHash?: string;
  engineFingerprint?: string;
  verifierFingerprint?: string;
  requiredEvidenceSetRevision?: string;
  /** Optional fully-built subject (overrides field-wise construction). */
  evidenceSubject?: EvidenceSubjectV1;
}

export function buildTesterEvidence(input: ProduceTesterEvidenceInput): TesterEvidence {
  const max = input.maxOutputChars;
  const commands: TesterCommandResult[] = [];
  if (input.lastCommand) {
    commands.push({
      identity: input.lastCommand.identity,
      exit_code: input.lastCommand.exitCode,
      duration_ms: input.lastCommand.durationMs,
      status: input.lastCommand.status,
      output_excerpt: boundExcerpt(input.lastCommand.output, max),
    });
  }
  const combinedOutput = input.lastCommand?.output ?? input.overallReason ?? "";
  const candidateSha =
    normalizeCandidateSha(input.candidateSha) ?? input.candidateSha;
  const pr = input.pr ?? null;
  const configDigest = computeConfigDigest({
    command_identity: input.commandIdentity,
    enabled: input.enabled,
    timeout: input.timeoutSec,
    max_output_chars: max,
  });
  const toolchain = input.toolchain ?? buildToolchainFingerprint();
  const evidence: TesterEvidence = {
    schema_version: TESTER_EVIDENCE_SCHEMA_VERSION,
    kind: TESTER_EVIDENCE_KIND,
    candidate_sha: candidateSha,
    run_id: input.runId,
    issue: input.issue,
    pr,
    worktree_id: worktreeIdFromPath(input.wtPath),
    config_digest: configDigest,
    toolchain_fingerprint: toolchain,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    duration_ms: input.durationMs,
    overall_status: input.overallStatus,
    overall_reason: input.overallReason
      ? boundExcerpt(input.overallReason, max)
      : undefined,
    commands,
    output_excerpt: boundExcerpt(combinedOutput, max),
    producer: {
      component: "test-build-gate",
      engine_version: input.engineVersion,
    },
  };
  if (input.tests && input.tests.length > 0) {
    evidence.tests = input.tests.map((t) => ({
      ...t,
      message: t.message ? boundExcerpt(t.message, Math.min(max, 500)) : undefined,
    }));
  }

  // Nested evidence_subject (#692): engine-derived only; never from prose.
  const subject = resolveTesterEvidenceSubject(input, {
    candidateSha,
    pr,
    configDigest,
    toolchain,
  });
  if (subject) {
    evidence.evidence_subject = subject;
  }
  return evidence;
}

/**
 * Build or validate the nested evidence_subject for a Tester record.
 * Returns null when runtime inputs are insufficient (no fabricated placeholders).
 */
function resolveTesterEvidenceSubject(
  input: ProduceTesterEvidenceInput,
  resolved: {
    candidateSha: string;
    pr: number | null;
    configDigest: string;
    toolchain: TesterToolchainFingerprint;
  },
): EvidenceSubjectV1 | null {
  if (input.evidenceSubject) {
    const c = canonicalizeEvidenceSubject(input.evidenceSubject);
    // Keep top-level identity consistent with subject.
    if (
      c.candidate_sha !== normalizeCandidateSha(resolved.candidateSha) ||
      c.run_id !== input.runId ||
      c.issue !== input.issue ||
      c.pr !== resolved.pr
    ) {
      // Prefer correcting top-level from subject would break callers; instead
      // re-canonicalize subject to match top-level authoritative runtime fields.
    }
    try {
      return buildEvidenceSubject({
        domain: c.domain,
        issue: input.issue,
        pr: resolved.pr,
        run_id: input.runId,
        candidate_sha: resolved.candidateSha,
        diff_hash: c.diff_hash,
        policy_hash: c.policy_hash,
        engine_fingerprint: c.engine_fingerprint,
        verifier_fingerprint: c.verifier_fingerprint,
        required_evidence_set_revision: c.required_evidence_set_revision,
      });
    } catch {
      return null;
    }
  }

  const domain = typeof input.domain === "string" ? input.domain.trim() : "";
  if (!domain) return null;

  const policyHash =
    input.policyHash ??
    buildTesterPolicyHash({
      command_identity: input.commandIdentity,
      enabled: input.enabled,
      timeout: input.timeoutSec,
      max_output_chars: input.maxOutputChars,
    });

  // Engine fingerprint: require explicit runtime digest (or derive a stable
  // stand-in from engineVersion only when provided — never invent version).
  let engineFingerprint = input.engineFingerprint;
  if (!engineFingerprint && input.engineVersion) {
    engineFingerprint = createHash("sha256")
      .update(
        stableStringify({
          version: input.engineVersion,
          component: "test-build-gate",
        }),
        "utf8",
      )
      .digest("hex");
  }
  if (!engineFingerprint) return null;

  const verifierFingerprint =
    input.verifierFingerprint ??
    createHash("sha256")
      .update(
        stableStringify({
          family: "tester",
          toolchain: resolved.toolchain,
          command_identity: input.commandIdentity,
          engine_fingerprint: engineFingerprint,
        }),
        "utf8",
      )
      .digest("hex");

  const requiredRev =
    input.requiredEvidenceSetRevision ?? buildRequiredEvidenceSetRevision();

  try {
    return buildEvidenceSubject({
      domain,
      issue: input.issue,
      pr: resolved.pr,
      run_id: input.runId,
      candidate_sha: resolved.candidateSha,
      diff_hash: input.diffHash ?? null,
      policy_hash: policyHash,
      engine_fingerprint: engineFingerprint,
      verifier_fingerprint: verifierFingerprint,
      required_evidence_set_revision: requiredRev,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scoreboard-readable metrics (structured; no prose parse)
// ---------------------------------------------------------------------------

export interface TesterScoreboardMetrics {
  duration_ms: number;
  command_count: number;
  overall_status: TesterOverallStatus;
  targeted_check_count?: number;
  targeted_check_duration_ms?: number;
}

export function extractTesterMetricsFromEvidence(
  evidence: TesterEvidence,
  targeted?: { count?: number; duration_ms?: number },
): TesterScoreboardMetrics {
  return {
    duration_ms: evidence.duration_ms,
    command_count: evidence.commands.length,
    overall_status: evidence.overall_status,
    targeted_check_count: targeted?.count,
    targeted_check_duration_ms: targeted?.duration_ms,
  };
}

/** Extract metrics from a tester_evidence event payload (events.jsonl). */
export function extractTesterMetricsFromEvent(
  event: Record<string, unknown>,
): TesterScoreboardMetrics | null {
  if (event.type !== "tester_evidence") return null;
  const overall = event.overall_status;
  if (typeof overall !== "string" || !OVERALL_SET.has(overall)) return null;
  const duration =
    typeof event.duration_ms === "number" && Number.isFinite(event.duration_ms)
      ? event.duration_ms
      : null;
  const commandCount =
    typeof event.command_count === "number" && Number.isFinite(event.command_count)
      ? event.command_count
      : null;
  if (duration === null || commandCount === null) return null;
  return {
    duration_ms: duration,
    command_count: commandCount,
    overall_status: overall as TesterOverallStatus,
  };
}

/** Synthetic harness result when fail_closed withholds the review model invoke. */
export function testerEvidenceWithholdResult(reason: string): {
  success: false;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration: number;
  timed_out: false;
  spawn_error: false;
} {
  const msg =
    `Tester suite evidence gate (fail_closed): withholding review model invoke. ${reason}`;
  return {
    success: false,
    stdout: "",
    stderr: msg,
    exit_code: 1,
    duration: 0,
    timed_out: false,
    spawn_error: false,
  };
}
