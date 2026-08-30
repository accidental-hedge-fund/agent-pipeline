// Typed per-treatment harness-smoke failure artifact (#1265).
//
// Written before scratch cleanup so a trailer-miss / spawn / contract failure
// leaves inspectable, sanitized evidence. Codex `resolved_model` and #1272
// salvage publication are out of scope.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets, sanitize, sanitizeDeep } from "./artifact-sanitize.ts";

type SmokeRole = "implementer" | "reviewer";

export const HARNESS_SMOKE_FAILURE_SCHEMA = "pipeline/harness-smoke-failure@1" as const;
export type HarnessSmokeFailureSchema = typeof HARNESS_SMOKE_FAILURE_SCHEMA;

/** Per-field UTF-8 ceiling for stdout/stderr/porcelain/log excerpts. */
export const HARNESS_SMOKE_FAILURE_TEXT_MAX_BYTES = 32_768;

export interface HarnessSmokeFailureTreatment {
  adapter: string;
  role: SmokeRole;
  model?: string;
  effort?: string;
}

export interface HarnessSmokeFailureArtifact {
  schema: HarnessSmokeFailureSchema;
  treatment: HarnessSmokeFailureTreatment;
  stdout: string;
  stderr: string;
  before_porcelain: string;
  after_porcelain: string;
  head: string | null;
  log_excerpt: string;
  exit_code: number | null;
  timed_out: boolean;
  preflight_failed: boolean;
}

export interface HarnessSmokeFailureLocator {
  path: string;
  content_hash: string;
}

export type HarnessSmokeFailureParseResult =
  | { ok: true; artifact: HarnessSmokeFailureArtifact }
  | { ok: false; reason: string };

function boundHeadTail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const headBytes = Math.ceil(maxBytes / 2);
  const tailBytes = maxBytes - headBytes;
  const head = bytes.subarray(0, headBytes).toString("utf8");
  const tail = tailBytes > 0 ? bytes.subarray(bytes.length - tailBytes).toString("utf8") : "";
  const dropped = bytes.length - headBytes - tailBytes;
  return `${head}\n...[truncated ${dropped} bytes]...\n${tail}`;
}

function boundField(text: string): string {
  return boundHeadTail(text, HARNESS_SMOKE_FAILURE_TEXT_MAX_BYTES);
}

function isSmokeRole(value: unknown): value is SmokeRole {
  return value === "implementer" || value === "reviewer";
}

/** Reject payloads missing required `pipeline/harness-smoke-failure@1` fields. */
export function parseHarnessSmokeFailureArtifact(
  value: unknown,
): HarnessSmokeFailureParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "artifact must be a JSON object" };
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema !== HARNESS_SMOKE_FAILURE_SCHEMA) {
    return {
      ok: false,
      reason: `schema must be ${HARNESS_SMOKE_FAILURE_SCHEMA}`,
    };
  }
  const treatment = obj.treatment;
  if (typeof treatment !== "object" || treatment === null || Array.isArray(treatment)) {
    return { ok: false, reason: "treatment is required" };
  }
  const t = treatment as Record<string, unknown>;
  if (typeof t.adapter !== "string" || t.adapter.length === 0) {
    return { ok: false, reason: "treatment.adapter is required" };
  }
  if (!isSmokeRole(t.role)) {
    return { ok: false, reason: "treatment.role must be implementer or reviewer" };
  }
  const requiredStrings = [
    "stdout",
    "stderr",
    "before_porcelain",
    "after_porcelain",
    "log_excerpt",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof obj[key] !== "string") {
      return { ok: false, reason: `${key} is required` };
    }
  }
  if (obj.head !== null && typeof obj.head !== "string") {
    return { ok: false, reason: "head must be a string or null" };
  }
  if (obj.exit_code !== null && typeof obj.exit_code !== "number") {
    return { ok: false, reason: "exit_code must be a number or null" };
  }
  if (typeof obj.timed_out !== "boolean") {
    return { ok: false, reason: "timed_out is required" };
  }
  if (typeof obj.preflight_failed !== "boolean") {
    return { ok: false, reason: "preflight_failed is required" };
  }
  const artifact: HarnessSmokeFailureArtifact = {
    schema: HARNESS_SMOKE_FAILURE_SCHEMA,
    treatment: {
      adapter: t.adapter,
      role: t.role,
      ...(typeof t.model === "string" ? { model: t.model } : {}),
      ...(typeof t.effort === "string" ? { effort: t.effort } : {}),
    },
    stdout: obj.stdout as string,
    stderr: obj.stderr as string,
    before_porcelain: obj.before_porcelain as string,
    after_porcelain: obj.after_porcelain as string,
    head: obj.head as string | null,
    log_excerpt: obj.log_excerpt as string,
    exit_code: obj.exit_code as number | null,
    timed_out: obj.timed_out,
    preflight_failed: obj.preflight_failed,
  };
  return { ok: true, artifact };
}

export function buildHarnessSmokeFailureArtifact(input: {
  treatment: HarnessSmokeFailureTreatment;
  stdout: string;
  stderr: string;
  beforePorcelain: string;
  afterPorcelain: string;
  head: string | null;
  logExcerpt: string;
  exitCode: number | null;
  timedOut: boolean;
  preflightFailed: boolean;
}): HarnessSmokeFailureArtifact {
  return {
    schema: HARNESS_SMOKE_FAILURE_SCHEMA,
    treatment: {
      adapter: input.treatment.adapter,
      role: input.treatment.role,
      ...(input.treatment.model ? { model: input.treatment.model } : {}),
      ...(input.treatment.effort ? { effort: input.treatment.effort } : {}),
    },
    stdout: boundField(input.stdout),
    stderr: boundField(input.stderr),
    before_porcelain: boundField(input.beforePorcelain),
    after_porcelain: boundField(input.afterPorcelain),
    head: input.head,
    log_excerpt: boundField(input.logExcerpt),
    exit_code: input.exitCode,
    timed_out: input.timedOut,
    preflight_failed: input.preflightFailed,
  };
}

/** Sanitize, bound, and serialize. Secret-shaped tokens must not survive. */
export function serializeHarnessSmokeFailureArtifact(
  artifact: HarnessSmokeFailureArtifact,
): string {
  const cleaned = sanitizeDeep(artifact);
  return sanitize(redactSecrets(`${JSON.stringify(cleaned)}\n`));
}

export function harnessSmokeFailureDigest(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function harnessSmokeFailureDir(domain: string): string {
  return path.join("/tmp", `pipeline-${domain}-doctor-harness-smoke`);
}

export interface WriteHarnessSmokeFailureDeps {
  mkdir?: (dir: string) => Promise<void>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
}

export async function writeHarnessSmokeFailureArtifact(
  domain: string,
  artifact: HarnessSmokeFailureArtifact,
  deps: WriteHarnessSmokeFailureDeps = {},
): Promise<HarnessSmokeFailureLocator> {
  const parsed = parseHarnessSmokeFailureArtifact(artifact);
  if (!parsed.ok) {
    throw new Error(`invalid harness-smoke failure artifact: ${parsed.reason}`);
  }
  const serialized = serializeHarnessSmokeFailureArtifact(parsed.artifact);
  const contentHash = harnessSmokeFailureDigest(serialized);
  const dir = harnessSmokeFailureDir(domain);
  const absPath = path.join(dir, `${contentHash}.json`);
  const mkdirFn = deps.mkdir ?? ((d: string) => fs.promises.mkdir(d, { recursive: true }).then(() => undefined));
  const writeFn =
    deps.writeFile ??
    ((filePath: string, content: string) => fs.promises.writeFile(filePath, content, "utf8"));
  await mkdirFn(dir);
  await writeFn(absPath, serialized);
  return { path: absPath, content_hash: contentHash };
}

export function formatEvidenceSuffix(loc: HarnessSmokeFailureLocator): string {
  return ` [evidence ${loc.path} digest ${loc.content_hash}]`;
}
