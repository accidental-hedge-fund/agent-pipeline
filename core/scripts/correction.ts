// Structured correction_event ledger (#499): a first-class, append-only
// contract for observable operator corrections and recovered failures. The
// event answers "what expert correction changed this run, and is that
// correction reusable?" — it records only accepted actions/dispositions,
// never a bare detection (a finding, a blocker, a retry attempt).
//
// Emission is routed through `appendEvent` (run-store.ts) so a correction_event
// inherits `--json-events` streaming, byte-identical event-sink delivery, and
// `summaryEvents` accumulation for free — the same delivery guarantees
// `emitHumanIntervention` (intervention.ts) currently bypasses.

import { createHash } from "node:crypto";
import { redactSecrets, sanitize } from "./artifact-sanitize.ts";
import {
  appendEvent,
  defaultRunStoreDeps,
  RUN_SCHEMA_VERSION,
  type RunId,
  type RunStoreDeps,
} from "./run-store.ts";

// ---------------------------------------------------------------------------
// Bounded enums (closed string unions)
// ---------------------------------------------------------------------------

export const CORRECTION_SOURCE_KINDS = [
  "override",
  "rejection",
  "retry",
  "repair",
  "unblock",
  "manual",
] as const;
export type CorrectionSourceKind = (typeof CORRECTION_SOURCE_KINDS)[number];

export const CORRECTION_FAILURE_CLASSES = [
  "review-finding",
  "blocker",
  "harness-crash",
  "test-build-failure",
  "eval-shipcheck-failure",
  "merge-conflict",
  "spec-defect",
  "env-tooling",
  "other",
] as const;
export type CorrectionFailureClass = (typeof CORRECTION_FAILURE_CLASSES)[number];

export const CORRECTION_ACTOR_KINDS = ["human", "pipeline"] as const;
export type CorrectionActorKind = (typeof CORRECTION_ACTOR_KINDS)[number];

export const CORRECTION_REUSABLE = ["yes", "no", "unknown"] as const;
export type CorrectionReusable = (typeof CORRECTION_REUSABLE)[number];

export const CORRECTION_PROPOSED_CONTROLS = [
  "instruction",
  "skill-rubric",
  "eval",
  "deterministic-gate",
  "human-judgment",
] as const;
export type CorrectionProposedControl = (typeof CORRECTION_PROPOSED_CONTROLS)[number];

export const EVIDENCE_REF_KINDS = ["finding", "blocker", "event", "comment", "artifact"] as const;
export type EvidenceRefKind = (typeof EVIDENCE_REF_KINDS)[number];

export interface EvidenceRef {
  kind: EvidenceRefKind;
  id: string;
}

// ---------------------------------------------------------------------------
// Event shape
// ---------------------------------------------------------------------------

export interface CorrectionEvent {
  schema_version: 1;
  type: "correction_event";
  at: string;
  correction_id: string;
  correction_key: string;
  source_kind: CorrectionSourceKind;
  failure_class: CorrectionFailureClass;
  actor_kind: CorrectionActorKind;
  issue: number;
  repo: string;
  run_id: RunId;
  stage: string | null;
  reviewed_sha: string | null;
  head_sha: string | null;
  evidence_ref: EvidenceRef;
  correction: string;
  reusable: CorrectionReusable;
  proposed_control?: CorrectionProposedControl;
}

// ---------------------------------------------------------------------------
// Deterministic derivation
// ---------------------------------------------------------------------------

/** Field separator matching the spec's ␟ (unit separator) notation. */
const FS = "\x1f";

/**
 * Deterministic recurrence key: a pure function of `source_kind` +
 * `failure_class` + `stage` only. Never reads raw free text, issue number, PR
 * number, SHA, or a model-generated paraphrase — two corrections that agree on
 * these three bounded fields always share a `correction_key`, so a downstream
 * consumer can match recurrence deterministically. Single source — do not
 * reimplement this derivation elsewhere.
 */
export function deriveCorrectionKey(args: {
  source_kind: CorrectionSourceKind;
  failure_class: CorrectionFailureClass;
  stage: string | null;
}): string {
  const basis = [args.source_kind, args.failure_class, args.stage ?? ""].join(FS);
  return createHash("sha1").update(basis).digest("hex").slice(0, 8);
}

/**
 * Stable replay/dedup key: reproducible for the same logical correction (e.g.
 * a re-emission after a crash-and-retry), so a downstream consumer deduping by
 * `correction_id` collapses duplicate deliveries/replays to one.
 */
export function deriveCorrectionId(args: {
  run_id: RunId;
  source_kind: CorrectionSourceKind;
  evidence_ref: EvidenceRef;
  reviewed_sha: string | null;
}): string {
  const basis = [
    args.run_id,
    args.source_kind,
    args.evidence_ref.kind,
    args.evidence_ref.id,
    args.reviewed_sha ?? "",
  ].join(FS);
  return createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

/** Operator-driven surfaces record a human actor; autonomous-recovery
 *  surfaces record a pipeline actor — derived from `source_kind` only, never
 *  from inferred identity or prose. */
export function actorKindForSourceKind(sourceKind: CorrectionSourceKind): CorrectionActorKind {
  switch (sourceKind) {
    case "retry":
    case "repair":
      return "pipeline";
    default:
      return "human";
  }
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

export interface EmitCorrectionEventPayload {
  issue: number;
  repo: string;
  run_id: RunId;
  stage: string | null;
  source_kind: CorrectionSourceKind;
  failure_class: CorrectionFailureClass;
  reviewed_sha?: string | null;
  head_sha?: string | null;
  evidence_ref: EvidenceRef;
  correction: string;
  reusable: CorrectionReusable;
  proposed_control?: CorrectionProposedControl;
  /** Override the `actor_kind` normally derived from `source_kind` (#499
   *  correction-record-command: the `pipeline correction record` CLI always
   *  forces `"human"`, regardless of the chosen `source_kind`). */
  actor_kind?: CorrectionActorKind;
}

const CORRECTION_TEXT_CAP = 500;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Build, sanitize, and append one `correction_event` via `appendEvent`, so it
 * inherits `--json-events` streaming, byte-identical event-sink delivery, and
 * `summaryEvents` accumulation. Non-fatal: an append failure (including a
 * throwing/rejecting `appendEvent`) is caught and logged as a warning and never
 * propagates, matching every other run-store emitter.
 */
export async function emitCorrectionEvent(
  runDir: string,
  payload: EmitCorrectionEventPayload,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<void> {
  try {
    const reviewedSha = payload.reviewed_sha ?? null;
    const evidenceRef: EvidenceRef = {
      kind: payload.evidence_ref.kind,
      id: sanitize(redactSecrets(payload.evidence_ref.id)),
    };
    const correctionText = sanitize(
      redactSecrets(payload.correction.slice(0, CORRECTION_TEXT_CAP)),
    );
    const event: CorrectionEvent = {
      schema_version: RUN_SCHEMA_VERSION as 1,
      type: "correction_event",
      at: nowIso(),
      correction_id: deriveCorrectionId({
        run_id: payload.run_id,
        source_kind: payload.source_kind,
        evidence_ref: payload.evidence_ref,
        reviewed_sha: reviewedSha,
      }),
      correction_key: deriveCorrectionKey({
        source_kind: payload.source_kind,
        failure_class: payload.failure_class,
        stage: payload.stage,
      }),
      source_kind: payload.source_kind,
      failure_class: payload.failure_class,
      actor_kind: payload.actor_kind ?? actorKindForSourceKind(payload.source_kind),
      issue: payload.issue,
      repo: payload.repo,
      run_id: payload.run_id,
      stage: payload.stage,
      reviewed_sha: reviewedSha,
      head_sha: payload.head_sha ?? null,
      evidence_ref: evidenceRef,
      correction: correctionText,
      reusable: payload.reusable,
      ...(payload.proposed_control !== undefined
        ? { proposed_control: payload.proposed_control }
        : {}),
    };
    await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] correction: emitCorrectionEvent failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Report-side visible failure (#499): validate before a consumer trusts a
// correction_event record read back from events.jsonl/summary.json.
// ---------------------------------------------------------------------------

export type CorrectionEventValidation =
  | { ok: true; event: CorrectionEvent }
  | { ok: false; error: string };

/**
 * Validate a `correction_event` record read back from storage (events.jsonl or
 * summary.json). A malformed record or an unrecognized `schema_version` is
 * returned as a visible `{ ok: false, error }` result rather than thrown —
 * callers (reports/consumers) surface `error` without aborting the read or the
 * run. Well-formed records with an unrecognized `failure_class` are still
 * valid (the closed enum's `other` escape hatch — an unrecognized string is
 * the raw record's problem for the consumer to bucket, not a validation
 * failure here).
 */
export function validateCorrectionEvent(raw: unknown): CorrectionEventValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "correction_event is not an object" };
  }
  const r = raw as Record<string, unknown>;
  if (r.type !== "correction_event") {
    return { ok: false, error: `expected type "correction_event", got ${JSON.stringify(r.type)}` };
  }
  if (r.schema_version !== 1) {
    return { ok: false, error: `unknown correction_event schema_version: ${JSON.stringify(r.schema_version)}` };
  }
  const requiredStrings: (keyof CorrectionEvent)[] = [
    "at", "correction_id", "correction_key", "source_kind", "failure_class",
    "actor_kind", "repo", "run_id", "evidence_ref", "correction", "reusable",
  ];
  for (const field of requiredStrings) {
    if (r[field] === undefined || r[field] === null) {
      return { ok: false, error: `correction_event missing required field "${field}"` };
    }
  }
  if (typeof r.issue !== "number") {
    return { ok: false, error: 'correction_event field "issue" must be a number' };
  }
  if (!(CORRECTION_SOURCE_KINDS as readonly string[]).includes(r.source_kind as string)) {
    return { ok: false, error: `correction_event has an invalid source_kind: ${JSON.stringify(r.source_kind)}` };
  }
  if (!(CORRECTION_ACTOR_KINDS as readonly string[]).includes(r.actor_kind as string)) {
    return { ok: false, error: `correction_event has an invalid actor_kind: ${JSON.stringify(r.actor_kind)}` };
  }
  if (!(CORRECTION_REUSABLE as readonly string[]).includes(r.reusable as string)) {
    return { ok: false, error: `correction_event has an invalid reusable value: ${JSON.stringify(r.reusable)}` };
  }
  const evidenceRef = r.evidence_ref as Record<string, unknown> | null;
  if (!evidenceRef || typeof evidenceRef !== "object" || typeof evidenceRef.id !== "string" ||
    !(EVIDENCE_REF_KINDS as readonly string[]).includes(evidenceRef.kind as string)) {
    return { ok: false, error: "correction_event has a malformed evidence_ref" };
  }
  return { ok: true, event: raw as CorrectionEvent };
}
