// Privacy-safe upstream product-fault reporting (#502): a distinct evidence
// class for *probable Agent Pipeline defects*, cleanly separated from
// `correction_event` (operator corrections), `papercut` (agent-reported minor
// friction), target-repository test/build failures, and host-environment/auth
// failures — none of which mean "Agent Pipeline itself is broken".
//
// This module holds:
//   - the classifier (`classifyProductFault`) and stable bounded fingerprint
//     (`computeProductFaultFingerprint`);
//   - the allowlist payload builder (`buildProductFaultPayload`) — never
//     accepts a raw error message/stack, only bounded structured fields;
//   - the `ProductFaultEvent` run-event shape and its emitter
//     (`emitProductFault`), routed through the shared `appendEvent` path so it
//     inherits redaction and external-sink delivery like every other event;
//   - the `pipeline report` command's orchestration (`runProductFaultReport`)
//     — default-inert, exact sanitized preview, explicit confirmation, local
//     consent/audit record, and a manual no-service fallback. The client
//     itself never creates an upstream GitHub issue.
//
// Reporting is opt-in and per-invocation only: nothing here runs unless an
// operator explicitly invokes `pipeline report` AND `product_fault.enabled`
// is set in `.github/pipeline.yml`. Background/automatic reporting is
// deliberately not implemented (see design.md decision 6 / tasks.md #6).

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { redactSecrets, sanitize } from "./artifact-sanitize.ts";
import { artifactSubdir, PRODUCT_FAULT_REPORTS_ARTIFACT } from "./artifact-ignore.ts";
import {
  appendEvent,
  defaultRunStoreDeps,
  listRunIds,
  readEvents,
  runDirPath,
  RUN_SCHEMA_VERSION,
  type RunStoreDeps,
} from "./run-store.ts";

export const PRODUCT_FAULT_PAYLOAD_SCHEMA_VERSION = 1;
export const PRODUCT_FAULT_AUDIT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export type ProductFaultConfidence = "low" | "medium" | "high";

/** Exit-state taxonomy for the allowlisted payload — never a raw exit code
 *  or message, always one of these bounded buckets. */
export type ProductFaultExitState = "crash" | "invariant_violation" | "schema_mismatch" | "unknown";

/** Defect-specific signal a caller (a stage/harness error path) has already
 *  observed. Deliberately does NOT include "a command exited non-zero" — that
 *  alone is never a defect signal (see `classifyProductFault`). Every field is
 *  a bounded boolean assertion the caller makes about what it just observed in
 *  Agent-Pipeline-owned code, never inferred from raw output. */
export interface ProductFaultSignal {
  /** An engine crash / uncaught exception with a stack trace rooted in
   *  Agent Pipeline's own code (not the target repo, not a harness CLI). */
  engineCrash?: boolean;
  /** An internal invariant the engine itself asserts was violated (e.g. a
   *  state-machine transition the engine believes is unreachable). */
  invariantViolation?: boolean;
  /** A schema/version inconsistency detected in the Pipeline's own artifacts
   *  (e.g. an unexpected `schema_version` in a file the engine itself wrote). */
  schemaVersionMismatch?: boolean;
}

export interface ClassifyProductFaultInput {
  /** Error class/name (e.g. "TypeError", "AssertionError") — never a raw message. */
  errorClass: string;
  /** Raw error message/stack — used ONLY to derive the bounded `fingerprint`;
   *  never copied into the payload verbatim (see `buildProductFaultPayload`). */
  errorMessage: string;
  stage: string;
  pipelineVersion: string;
  hostAdapter: string;
  signal: ProductFaultSignal;
}

export interface ProductFaultClassification {
  confidence: ProductFaultConfidence;
  rationale: string;
  fingerprint: string;
  exitState: ProductFaultExitState;
}

/** Path segment pattern — POSIX absolute paths and Windows drive paths. */
const PATH_RE = /(?:[A-Za-z]:)?[\\/](?:[^\s\\/:"'`]+[\\/])*[^\s\\/:"'`]+/g;
/** Secret/token formats — mirrors artifact-sanitize's SECRET_VALUE_RE. */
const TOKEN_RE = /(?:ghp|ghs|gho|ghr|github_pat)_[A-Za-z0-9_]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}/g;

/** Normalize a raw error message into a bounded, identity-free signature:
 *  strip filesystem paths and secret-token formats, then collapse digits
 *  (line numbers, PIDs, ports, timestamps) so the SAME defect surfaced by two
 *  different installations — with different paths/PIDs/line numbers — reduces
 *  to the SAME normalized shape. */
function normalizeErrorSignature(errorClass: string, message: string): string {
  const normalized = message
    .replace(PATH_RE, "<path>")
    .replace(TOKEN_RE, "<token>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return `${errorClass}\x1f${normalized}`;
}

/** Stable bounded fingerprint (#502): `sha1(normalized signature | version |
 *  host adapter | stage)` truncated to 16 hex chars — the same "hash a
 *  normalized signature, truncate" technique `findingKey`/`challengeKey` use
 *  for stable-finding-identity. A fixed-length hash can never itself contain
 *  the identifying substrings (paths, repo names, secrets) that may have
 *  appeared in the raw message it was derived from. */
export function computeProductFaultFingerprint(input: {
  errorClass: string;
  errorMessage: string;
  pipelineVersion: string;
  hostAdapter: string;
  stage: string;
}): string {
  const signature = normalizeErrorSignature(input.errorClass, input.errorMessage);
  const basis = [signature, input.pipelineVersion, input.hostAdapter, input.stage].join("\x1f");
  return createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

function exitStateForSignal(signal: ProductFaultSignal): ProductFaultExitState {
  if (signal.engineCrash) return "crash";
  if (signal.invariantViolation) return "invariant_violation";
  if (signal.schemaVersionMismatch) return "schema_mismatch";
  return "unknown";
}

/**
 * Classify a run's failure as a probable Agent Pipeline defect, or return
 * `null` when no defect-specific signal is present. A bare non-zero command/
 * harness/`gh` exit — with no `signal` set — is insufficient on its own and
 * classifies to nothing (no event is ever emitted for it): the classifier
 * requires an explicit engine-crash, invariant-violation, or schema-mismatch
 * signal from the caller before it will assert a defect at all.
 *
 * When a signal IS present, a `product_fault` event is always produced
 * (`emitProductFault` writes it locally via the standard `appendEvent` path,
 * which by itself performs no network I/O) — "low confidence stays local" is
 * enforced downstream, by `pipeline report` requiring explicit per-invocation
 * operator confirmation before any submission, not by suppressing the event.
 */
export function classifyProductFault(input: ClassifyProductFaultInput): ProductFaultClassification | null {
  const { signal, stage, errorClass } = input;
  let confidence: ProductFaultConfidence;
  let rationale: string;
  if (signal.engineCrash) {
    confidence = "high";
    rationale = `Agent Pipeline crashed with an uncaught ${errorClass} rooted in its own code at stage "${stage}".`;
  } else if (signal.invariantViolation) {
    confidence = "medium";
    rationale = `Agent Pipeline detected one of its own internal invariants was violated at stage "${stage}" (${errorClass}).`;
  } else if (signal.schemaVersionMismatch) {
    confidence = "low";
    rationale = `Agent Pipeline detected a schema/version inconsistency in its own artifacts at stage "${stage}" (${errorClass}).`;
  } else {
    // No defect-specific signal — including a bare non-zero exit — is never
    // classified as a product fault.
    return null;
  }
  return {
    confidence,
    rationale,
    fingerprint: computeProductFaultFingerprint(input),
    exitState: exitStateForSignal(signal),
  };
}

// ---------------------------------------------------------------------------
// ProductFaultEvent — the run-event shape (added to RunEvent in run-store.ts)
// ---------------------------------------------------------------------------

export interface ProductFaultEvent {
  schema_version: number;
  type: "product_fault";
  at: string;
  payload_schema_version: number;
  confidence: ProductFaultConfidence;
  rationale: string;
  fingerprint: string;
  pipeline_version: string;
  host_adapter: string;
  stage: string;
  error_class: string;
  exit_state: ProductFaultExitState;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export interface EmitProductFaultPayload {
  classification: ProductFaultClassification;
  pipelineVersion: string;
  hostAdapter: string;
  stage: string;
  errorClass: string;
}

/**
 * Build, sanitize, and append one `product_fault` event via the shared
 * `appendEvent` path — so it inherits `--json-events` streaming, byte-
 * identical event-sink delivery, and `summaryEvents` accumulation on
 * identical terms to `papercut`/`correction_event`. Non-fatal: an append
 * failure is caught and logged as a warning and never propagates, matching
 * every other run-store emitter.
 */
export async function emitProductFault(
  runDir: string,
  payload: EmitProductFaultPayload,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  try {
    const clean = (s: string): string => sanitize(redactSecrets(s));
    const event: ProductFaultEvent = {
      schema_version: RUN_SCHEMA_VERSION,
      type: "product_fault",
      at: nowIso(),
      payload_schema_version: PRODUCT_FAULT_PAYLOAD_SCHEMA_VERSION,
      confidence: payload.classification.confidence,
      rationale: clean(payload.classification.rationale),
      fingerprint: payload.classification.fingerprint,
      pipeline_version: clean(payload.pipelineVersion),
      host_adapter: clean(payload.hostAdapter),
      stage: clean(payload.stage),
      error_class: clean(payload.errorClass),
      exit_state: payload.classification.exitState,
    };
    await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] product-fault: emitProductFault failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Allowlist payload builder (#502) — the report-command's wire payload
// ---------------------------------------------------------------------------

export interface ProductFaultPayload {
  payload_schema_version: number;
  run_schema_version: number;
  pipeline_version: string;
  host_adapter: string;
  stage: string;
  error_class: string;
  fingerprint: string;
  exit_state: ProductFaultExitState;
  confidence: ProductFaultConfidence;
}

/**
 * Build the report payload from ONLY the fixed allowlist of bounded fields —
 * Pipeline version, host adapter, stage, error class, fingerprint, exit
 * state, confidence, and schema versions. There is deliberately no parameter
 * for a raw message/stack/output: a caller cannot leak one through this
 * function because it has no input slot for it. Every string field is passed
 * through the existing injection screen + secret redaction as defense in
 * depth, even though these fields are expected to already be bounded.
 */
export function buildProductFaultPayload(input: {
  pipelineVersion: string;
  hostAdapter: string;
  stage: string;
  errorClass: string;
  fingerprint: string;
  exitState: ProductFaultExitState;
  confidence: ProductFaultConfidence;
}): ProductFaultPayload {
  const clean = (s: string): string => sanitize(redactSecrets(s));
  return {
    payload_schema_version: PRODUCT_FAULT_PAYLOAD_SCHEMA_VERSION,
    run_schema_version: RUN_SCHEMA_VERSION,
    pipeline_version: clean(input.pipelineVersion),
    host_adapter: clean(input.hostAdapter),
    stage: clean(input.stage),
    error_class: clean(input.errorClass),
    fingerprint: input.fingerprint,
    exit_state: input.exitState,
    confidence: input.confidence,
  };
}

/** Byte-exact rendering of the payload — used as BOTH the operator-facing
 *  preview AND the literal bytes submitted, so the two can never diverge. */
export function renderProductFaultPreview(payload: ProductFaultPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// product_fault config gate — gh-free, non-throwing (mirrors papercutsEnabled)
// ---------------------------------------------------------------------------

export interface ProductFaultConfigBlock {
  enabled: boolean;
  intake_endpoint?: string;
  /** Name of an environment variable holding the submission-scoped intake
   *  credential — never the credential value itself, and never a GitHub token. */
  intake_auth_env?: string;
}

/** Best-effort, gh-free check of the `product_fault` config block in
 *  `<repoDir>/.github/pipeline.yml`. Deliberately does not call
 *  `resolveConfig()` (which shells out to `gh repo view`) — `pipeline report`
 *  must be able to determine "reporting is disabled" without any network or
 *  gh call. Any read/parse failure resolves to `{ enabled: false }`, matching
 *  the feature's inert-by-default contract. */
export async function resolveProductFaultConfig(
  repoDir: string,
  deps: Pick<ProductFaultReportDeps, "readFile">,
): Promise<ProductFaultConfigBlock> {
  try {
    const text = await deps.readFile(path.join(repoDir, ".github", "pipeline.yml"));
    const parsed = yaml.load(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { enabled: false };
    const block = (parsed as { product_fault?: unknown }).product_fault;
    if (!block || typeof block !== "object" || Array.isArray(block)) return { enabled: false };
    const b = block as Record<string, unknown>;
    return {
      enabled: b.enabled === true,
      ...(typeof b.intake_endpoint === "string" ? { intake_endpoint: b.intake_endpoint } : {}),
      ...(typeof b.intake_auth_env === "string" ? { intake_auth_env: b.intake_auth_env } : {}),
    };
  } catch {
    return { enabled: false };
  }
}

// ---------------------------------------------------------------------------
// Locate the most recent product_fault event across recent runs
// ---------------------------------------------------------------------------

async function runStoreAdapter(
  deps: Pick<ProductFaultReportDeps, "readFile" | "readdir" | "stat">,
): Promise<RunStoreDeps> {
  return { ...defaultRunStoreDeps, readFile: deps.readFile, readdir: deps.readdir, stat: deps.stat };
}

/** Scan run directories (most-recent first) for the latest `product_fault`
 *  event, or `null` when none exists. A single unreadable run is skipped
 *  rather than aborting the scan. */
export async function findLatestProductFault(
  repoDir: string,
  deps: Pick<ProductFaultReportDeps, "readFile" | "readdir" | "stat">,
): Promise<ProductFaultEvent | null> {
  const runStoreDeps = await runStoreAdapter(deps);
  let ids: string[];
  try {
    ids = await listRunIds(repoDir, runStoreDeps);
  } catch {
    return null;
  }
  for (const id of ids) {
    let events: Awaited<ReturnType<typeof readEvents>>;
    try {
      events = await readEvents(runDirPath(repoDir, id), runStoreDeps);
    } catch {
      continue;
    }
    const faults = events.filter((e): e is ProductFaultEvent => e.type === "product_fault");
    if (faults.length > 0) return faults[faults.length - 1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Local consent/audit record
// ---------------------------------------------------------------------------

export interface ProductFaultAuditRecord {
  schema_version: number;
  at: string;
  fingerprint: string;
  payload_hash: string;
  destination: string;
  confirmed: boolean;
  submitted: boolean;
}

export function productFaultAuditLogPath(repoDir: string): string {
  return artifactSubdir(repoDir, PRODUCT_FAULT_REPORTS_ARTIFACT);
}

export async function writeProductFaultAuditRecord(
  repoDir: string,
  record: ProductFaultAuditRecord,
  deps: Pick<ProductFaultReportDeps, "mkdir" | "appendFile">,
): Promise<void> {
  const p = productFaultAuditLogPath(repoDir);
  await deps.mkdir(path.dirname(p), { recursive: true });
  await deps.appendFile(p, `${JSON.stringify(record)}\n`);
}

// ---------------------------------------------------------------------------
// Manual no-service fallback (#502): a prefilled draft, never an auto-created issue
// ---------------------------------------------------------------------------

/** Canonical upstream repo for the manual fallback draft — the client only
 *  ever prepares a URL/draft here; it never calls `gh` or creates the issue
 *  itself. */
export const PRODUCT_FAULT_MANUAL_FALLBACK_REPO = "accidental-hedge-fund/agent-pipeline";

export interface ProductFaultManualDraft {
  url: string;
  title: string;
  body: string;
}

export function buildManualFallbackDraft(payload: ProductFaultPayload): ProductFaultManualDraft {
  const title = `[product-fault] ${payload.error_class} at ${payload.stage} (fingerprint ${payload.fingerprint})`;
  const body = [
    "Agent Pipeline detected a probable product defect during a run.",
    "Please review the sanitized diagnostic below before submitting this issue.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
  const params = new URLSearchParams({ title, body, labels: "product-fault" });
  return {
    url: `https://github.com/${PRODUCT_FAULT_MANUAL_FALLBACK_REPO}/issues/new?${params.toString()}`,
    title,
    body,
  };
}

// ---------------------------------------------------------------------------
// `pipeline report` orchestration
// ---------------------------------------------------------------------------

export interface ProductFaultReportDeps {
  readFile: (p: string) => Promise<string>;
  readdir: (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  stat: (p: string) => Promise<{ mtime: Date }>;
  appendFile: (p: string, data: string) => Promise<void>;
  mkdir: (p: string, opts: { recursive: boolean }) => Promise<void>;
  /** Network submission — the ONLY network I/O this feature performs, and
   *  only ever reached after explicit operator confirmation. Injectable so
   *  tests never touch a real network. */
  submit: (endpoint: string, authToken: string | undefined, body: string) => Promise<{ ok: boolean; status: number }>;
  /** Prompt the operator for explicit y/N confirmation before any submission. */
  confirm: (message: string) => Promise<boolean>;
  log: (msg: string) => void;
}

export function realProductFaultReportDeps(): ProductFaultReportDeps {
  return {
    readFile: (p) => fsp.readFile(p, "utf8"),
    readdir: async (p) => {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      return entries as Array<{ name: string; isDirectory(): boolean }>;
    },
    stat: (p) => fsp.stat(p),
    appendFile: (p, data) => fsp.appendFile(p, data, "utf8"),
    mkdir: async (p, opts) => {
      await fsp.mkdir(p, opts);
    },
    submit: async (endpoint, authToken, body) => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        },
        body,
      });
      return { ok: res.ok, status: res.status };
    },
    confirm: (message) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(message, (answer) => {
          rl.close();
          resolve(/^y(es)?$/i.test(answer.trim()));
        });
      }),
    log: (msg) => console.log(msg),
  };
}

export interface RunProductFaultReportOpts {
  repoDir: string;
  /** `--yes`: skip the interactive prompt, treated as explicit operator
   *  confirmation given on the command line itself. */
  assumeYes?: boolean;
}

export type RunProductFaultReportResult =
  | { outcome: "disabled" }
  | { outcome: "no-fault-found" }
  | { outcome: "declined"; payload: ProductFaultPayload }
  | { outcome: "manual-fallback"; payload: ProductFaultPayload; draftUrl: string }
  | { outcome: "submitted"; payload: ProductFaultPayload; ok: boolean; status: number };

/**
 * `pipeline report`'s full flow: resolve config (inert unless explicitly
 * enabled) → locate the latest local `product_fault` event → build the
 * sanitized payload → render the EXACT preview → require explicit
 * confirmation → submit (or prepare a manual fallback draft when no intake is
 * configured) → write a local consent/audit record. No step before an
 * explicit `confirm()` true performs any network I/O or filesystem write
 * beyond reading existing run/config files.
 */
export async function runProductFaultReport(
  opts: RunProductFaultReportOpts,
  deps: ProductFaultReportDeps,
): Promise<RunProductFaultReportResult> {
  const config = await resolveProductFaultConfig(opts.repoDir, deps);
  if (!config.enabled) {
    deps.log(
      "Product-fault reporting is disabled (product_fault.enabled is absent or false in " +
        ".github/pipeline.yml). No network reporting or GitHub write will occur.",
    );
    return { outcome: "disabled" };
  }

  const fault = await findLatestProductFault(opts.repoDir, deps);
  if (!fault) {
    deps.log("No product-fault event found in recent runs — nothing to report.");
    return { outcome: "no-fault-found" };
  }

  const payload = buildProductFaultPayload({
    pipelineVersion: fault.pipeline_version,
    hostAdapter: fault.host_adapter,
    stage: fault.stage,
    errorClass: fault.error_class,
    fingerprint: fault.fingerprint,
    exitState: fault.exit_state,
    confidence: fault.confidence,
  });
  const preview = renderProductFaultPreview(payload);
  deps.log("The following sanitized payload would be submitted:");
  deps.log(preview);

  const confirmed = opts.assumeYes ? true : await deps.confirm("Submit this sanitized product-fault report? [y/N] ");
  if (!confirmed) {
    deps.log("Not submitted — no operator confirmation.");
    return { outcome: "declined", payload };
  }

  const payloadHash = createHash("sha256").update(preview).digest("hex");
  const at = nowIso();

  if (!config.intake_endpoint) {
    const draft = buildManualFallbackDraft(payload);
    await writeProductFaultAuditRecord(
      opts.repoDir,
      {
        schema_version: PRODUCT_FAULT_AUDIT_SCHEMA_VERSION,
        at,
        fingerprint: payload.fingerprint,
        payload_hash: payloadHash,
        destination: "manual-fallback",
        confirmed: true,
        submitted: false,
      },
      deps,
    );
    deps.log(
      `No intake service is configured. Review and submit this draft yourself:\n${draft.url}`,
    );
    return { outcome: "manual-fallback", payload, draftUrl: draft.url };
  }

  const authToken = config.intake_auth_env ? process.env[config.intake_auth_env] : undefined;
  const result = await deps.submit(config.intake_endpoint, authToken, preview);
  await writeProductFaultAuditRecord(
    opts.repoDir,
    {
      schema_version: PRODUCT_FAULT_AUDIT_SCHEMA_VERSION,
      at,
      fingerprint: payload.fingerprint,
      payload_hash: payloadHash,
      destination: config.intake_endpoint,
      confirmed: true,
      submitted: result.ok,
    },
    deps,
  );
  deps.log(result.ok ? "Report submitted." : `Report submission failed (status ${result.status}).`);
  return { outcome: "submitted", payload, ok: result.ok, status: result.status };
}
