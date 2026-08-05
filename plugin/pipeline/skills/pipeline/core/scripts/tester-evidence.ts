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
  /** Reserved for #692; absent in v1. Readers ignore unknown fields. */
  evidence_subject?: Record<string, unknown>;
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
  /** Rendered prompt section (always present when review proceeds). */
  section: string;
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

/**
 * Sole review acquisition helper: load + validate + SHA match + on_missing.
 * Does **not** regenerate or run tests. Never implies pass on non-current evidence.
 */
export function loadTesterEvidenceForReviewSync(
  readResult:
    | { status: "missing" }
    | { status: "malformed"; reason: string }
    | { status: "ok"; evidence: TesterEvidence },
  candidateSha: string,
  onMissing: TesterOnMissing = "fail_closed",
): TesterAcquisitionResult {
  if (readResult.status === "missing") {
    const reason =
      "No Tester suite evidence file for this run (missing tester-evidence.json).";
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
  if (!candidateShaMatches(evidence.candidate_sha, candidateSha)) {
    const reason =
      `Tester suite evidence is stale: artifact candidate_sha=` +
      `${evidence.candidate_sha} does not match review HEAD ${candidateSha}. ` +
      `Stale evidence cannot support suite success for the current candidate.`;
    const base: TesterAcquisitionResult = {
      classification: "stale",
      artifact: evidence,
      withholdInvoke: onMissing === "fail_closed",
      reason,
      section: "",
    };
    base.section = renderTesterEvidenceSection(base);
    return base;
  }
  // Current — including disabled/not_run (explicit non-suite states).
  const base: TesterAcquisitionResult = {
    classification: "current",
    artifact: evidence,
    withholdInvoke: false,
    reason: `current Tester evidence for ${evidence.candidate_sha}`,
    section: "",
  };
  base.section = renderTesterEvidenceSection(base);
  return base;
}

export async function loadTesterEvidenceForReview(
  runDir: string | undefined,
  candidateSha: string,
  cfg: Pick<PipelineConfig, "tester_evidence"> | { tester_evidence?: TesterEvidenceConfig },
  io: TesterEvidenceIoDeps = defaultIoDeps,
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
    );
    acq.reason =
      "No run directory provided — Tester suite evidence cannot be loaded for this invocation.";
    acq.section = renderTesterEvidenceSection(acq);
    return acq;
  }
  const read = await readTesterEvidence(runDir, io);
  return loadTesterEvidenceForReviewSync(read, candidateSha, onMissing);
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
  const evidence: TesterEvidence = {
    schema_version: TESTER_EVIDENCE_SCHEMA_VERSION,
    kind: TESTER_EVIDENCE_KIND,
    candidate_sha: normalizeCandidateSha(input.candidateSha) ?? input.candidateSha,
    run_id: input.runId,
    issue: input.issue,
    pr: input.pr ?? null,
    worktree_id: worktreeIdFromPath(input.wtPath),
    config_digest: computeConfigDigest({
      command_identity: input.commandIdentity,
      enabled: input.enabled,
      timeout: input.timeoutSec,
      max_output_chars: max,
    }),
    toolchain_fingerprint: input.toolchain ?? buildToolchainFingerprint(),
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
  return evidence;
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
