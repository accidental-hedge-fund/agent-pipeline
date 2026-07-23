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
import * as path from "node:path";
import { redactSecrets, sanitize } from "./artifact-sanitize.ts";
import { artifactSubdir, CONTROL_ATTRIBUTIONS_ARTIFACT } from "./artifact-ignore.ts";
import {
  appendEvent,
  defaultRunStoreDeps,
  readEvents,
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

/** Operator-driven source kinds — the only ones the manual `correction record`
 *  command may accept. `retry`/`repair` are reserved for the Pipeline-owned
 *  recovery and repair paths, which derive `actor_kind: "pipeline"`; letting a
 *  human invoke the manual command with either would misattribute an
 *  operator action as an autonomous pipeline recovery. */
export const CORRECTION_HUMAN_SOURCE_KINDS = [
  "override",
  "rejection",
  "unblock",
  "manual",
] as const satisfies readonly CorrectionSourceKind[];

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
 *
 * `occurrence` is a durable per-instance discriminator (#499 review-2 finding
 * 2d4be3a1): the count of prior `correction_event` records already durably
 * appended to this run whose identity basis (every field below, excluding
 * `occurrence` itself) is identical. Two accepted corrections that otherwise
 * agree on every field (e.g. the same stage blocked-then-unblocked twice with
 * the same answer) get distinct `occurrence` values and therefore distinct
 * ids, while a crash-and-retry of the same not-yet-durably-appended
 * correction recomputes the same occurrence count and so the same id.
 */
export function deriveCorrectionId(args: {
  run_id: RunId;
  source_kind: CorrectionSourceKind;
  evidence_ref: EvidenceRef;
  reviewed_sha: string | null;
  head_sha?: string | null;
  reusable?: CorrectionReusable;
  proposed_control?: CorrectionProposedControl;
  /** The durable disposition text (post-sanitize/truncate, matching what is
   *  actually persisted) — distinguishes two distinct corrections against the
   *  same evidence (e.g. two different override dispositions for one finding)
   *  while staying identical across a replay of the same correction. */
  correction: string;
  occurrence?: number;
}): string {
  const basis = [
    args.run_id,
    args.source_kind,
    args.evidence_ref.kind,
    args.evidence_ref.id,
    args.reviewed_sha ?? "",
    args.head_sha ?? "",
    args.reusable ?? "",
    args.proposed_control ?? "",
    args.correction,
    String(args.occurrence ?? 0),
  ].join(FS);
  return createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

/**
 * Count prior `correction_event` records in `runDir` sharing the same
 * identity basis `deriveCorrectionId` would otherwise collapse on, so the
 * emitter can pass a durable `occurrence` ordinal. Best-effort: a read
 * failure (e.g. no events.jsonl yet) resolves to 0, matching a first
 * occurrence.
 */
async function countPriorOccurrences(
  runDir: string,
  identity: {
    run_id: RunId;
    source_kind: CorrectionSourceKind;
    evidence_ref: EvidenceRef;
    reviewed_sha: string | null;
    head_sha: string | null;
    reusable: CorrectionReusable;
    proposed_control: CorrectionProposedControl | undefined;
    correction: string;
  },
  deps: RunStoreDeps,
): Promise<number> {
  let events: Awaited<ReturnType<typeof readEvents>>;
  try {
    events = await readEvents(runDir, deps);
  } catch {
    return 0;
  }
  let count = 0;
  for (const e of events) {
    if ((e as { type?: unknown }).type !== "correction_event") continue;
    const c = e as unknown as CorrectionEvent;
    if (
      c.run_id === identity.run_id &&
      c.source_kind === identity.source_kind &&
      c.evidence_ref?.kind === identity.evidence_ref.kind &&
      c.evidence_ref?.id === identity.evidence_ref.id &&
      (c.reviewed_sha ?? null) === identity.reviewed_sha &&
      (c.head_sha ?? null) === identity.head_sha &&
      c.reusable === identity.reusable &&
      c.proposed_control === identity.proposed_control &&
      c.correction === identity.correction
    ) {
      count++;
    }
  }
  return count;
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
 * propagates, matching every other run-store emitter. Returns whether the
 * event was actually durably appended, so a caller that must not report
 * success on a silent failure (e.g. the `correction record` CLI) can observe
 * it without changing the non-fatal contract for every other caller, which is
 * free to ignore the resolved value.
 */
export async function emitCorrectionEvent(
  runDir: string,
  payload: EmitCorrectionEventPayload,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<boolean> {
  try {
    const reviewedSha = payload.reviewed_sha ?? null;
    const evidenceRef: EvidenceRef = {
      kind: payload.evidence_ref.kind,
      id: sanitize(redactSecrets(payload.evidence_ref.id)),
    };
    const correctionText = sanitize(
      redactSecrets(payload.correction.slice(0, CORRECTION_TEXT_CAP)),
    );
    const headSha = payload.head_sha ?? null;
    const occurrence = await countPriorOccurrences(
      runDir,
      {
        run_id: payload.run_id,
        source_kind: payload.source_kind,
        evidence_ref: evidenceRef,
        reviewed_sha: reviewedSha,
        head_sha: headSha,
        reusable: payload.reusable,
        proposed_control: payload.proposed_control,
        correction: correctionText,
      },
      deps,
    );
    const event: CorrectionEvent = {
      schema_version: RUN_SCHEMA_VERSION as 1,
      type: "correction_event",
      at: nowIso(),
      correction_id: deriveCorrectionId({
        run_id: payload.run_id,
        source_kind: payload.source_kind,
        evidence_ref: evidenceRef,
        reviewed_sha: reviewedSha,
        head_sha: headSha,
        reusable: payload.reusable,
        proposed_control: payload.proposed_control,
        correction: correctionText,
        occurrence,
      }),
      correction_key: deriveCorrectionKey({
        source_kind: payload.source_kind,
        failure_class: payload.failure_class,
        stage: payload.stage,
      }),
      source_kind: payload.source_kind,
      failure_class: payload.failure_class,
      actor_kind: actorKindForSourceKind(payload.source_kind),
      issue: payload.issue,
      repo: payload.repo,
      run_id: payload.run_id,
      stage: payload.stage,
      reviewed_sha: reviewedSha,
      head_sha: headSha,
      evidence_ref: evidenceRef,
      correction: correctionText,
      reusable: payload.reusable,
      ...(payload.proposed_control !== undefined
        ? { proposed_control: payload.proposed_control }
        : {}),
    };
    return await appendEvent(runDir, event, deps);
  } catch (err) {
    console.warn(
      `[pipeline] correction: emitCorrectionEvent failed (non-fatal): ${(err as Error).message}`,
    );
    return false;
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

// ---------------------------------------------------------------------------
// control_attribution (#501): a durable, explicit, audited record linking a
// correction_key to the control that resolved it. Written only by the
// explicit `pipeline correction attribute` command — never inferred from an
// issue close or PR merge. Lives in its own repo-level, append-only ledger
// (`.agent-pipeline/control-attributions.jsonl`), not a per-run artifact,
// since attribution is a factory-level fact rather than something scoped to
// one run.
// ---------------------------------------------------------------------------

export const CONTROL_ATTRIBUTION_DISPOSITIONS = [
  "implemented",
  "human-owned",
  "rejected",
  "superseded",
] as const;
export type ControlAttributionDisposition = (typeof CONTROL_ATTRIBUTION_DISPOSITIONS)[number];

export interface ControlAttribution {
  schema_version: 1;
  type: "control_attribution";
  at: string;
  attribution_id: string;
  correction_key: string;
  control_type: CorrectionProposedControl;
  disposition: ControlAttributionDisposition;
  issue: number | null;
  pr: number | null;
  effective_commit: string | null;
  effective_release: string | null;
  effective_at: string | null;
  supersedes: string | null;
  evidence_ref: EvidenceRef;
  note: string;
}

/** Absolute path of the durable, repo-level control-attribution ledger. A
 *  single append-only file (not a per-run directory) — see the module
 *  comment above. */
export function controlAttributionsPath(repoDir: string): string {
  return artifactSubdir(repoDir, CONTROL_ATTRIBUTIONS_ARTIFACT);
}

/**
 * Pure hash of an attribution's identifying fields, so re-recording the same
 * attribution (crash-and-retry, replay) is idempotent — a consumer deduping
 * by `attribution_id` collapses the duplicates to one logical attribution.
 * Two attributions that differ in any identifying field produce distinct ids.
 */
export function deriveAttributionId(args: {
  correction_key: string;
  control_type: CorrectionProposedControl;
  disposition: ControlAttributionDisposition;
  issue?: number | null;
  pr?: number | null;
  effective_commit?: string | null;
  effective_release?: string | null;
}): string {
  const basis = [
    args.correction_key,
    args.control_type,
    args.disposition,
    String(args.issue ?? ""),
    String(args.pr ?? ""),
    args.effective_commit ?? "",
    args.effective_release ?? "",
  ].join(FS);
  return createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

const ATTRIBUTION_NOTE_CAP = 500;

/** An `effective_at` timestamp records the recurrence boundary — it is set
 *  only when this record ships an effective control: a plain `implemented`
 *  disposition, or a `superseded` record that itself names the replacement
 *  control's effective commit/release (recording the supersession and its
 *  own effective control in one append). `human-owned`/`rejected` (and a
 *  bare `superseded` record with no replacement-control evidence) set no
 *  boundary. */
function resolveEffectiveAt(
  disposition: ControlAttributionDisposition,
  effectiveCommit: string | null,
  effectiveRelease: string | null,
  at: string,
): string | null {
  if (disposition === "implemented") return at;
  if (disposition === "superseded" && (effectiveCommit !== null || effectiveRelease !== null)) return at;
  return null;
}

export interface EmitControlAttributionPayload {
  correction_key: string;
  control_type: CorrectionProposedControl;
  disposition: ControlAttributionDisposition;
  issue?: number | null;
  pr?: number | null;
  effective_commit?: string | null;
  effective_release?: string | null;
  supersedes?: string | null;
  evidence_ref?: EvidenceRef;
  note?: string;
}

/**
 * Build, sanitize, and append one `control_attribution` record to the
 * durable repo-level ledger. Mirrors `emitCorrectionEvent`'s sanitization and
 * non-fatal discipline: `note`/`evidence_ref.id` are screened through the
 * injection denylist and secret redaction, and an append failure is caught,
 * logged as a warning, and never propagates. Returns whether the record was
 * actually durably appended, so the `correction attribute` CLI can avoid
 * reporting success on a silent failure.
 */
export async function emitControlAttribution(
  repoDir: string,
  payload: EmitControlAttributionPayload,
  deps: RunStoreDeps = defaultRunStoreDeps,
): Promise<boolean> {
  try {
    const at = nowIso();
    const issue = payload.issue ?? null;
    const pr = payload.pr ?? null;
    const effectiveCommit = payload.effective_commit ?? null;
    const effectiveRelease = payload.effective_release ?? null;
    const rawEvidenceRef = payload.evidence_ref ?? { kind: "comment", id: "" };
    const evidenceRef: EvidenceRef = {
      kind: rawEvidenceRef.kind,
      id: sanitize(redactSecrets(rawEvidenceRef.id)),
    };
    const note = sanitize(redactSecrets((payload.note ?? "").slice(0, ATTRIBUTION_NOTE_CAP)));

    const record: ControlAttribution = {
      schema_version: RUN_SCHEMA_VERSION as 1,
      type: "control_attribution",
      at,
      attribution_id: deriveAttributionId({
        correction_key: payload.correction_key,
        control_type: payload.control_type,
        disposition: payload.disposition,
        issue,
        pr,
        effective_commit: effectiveCommit,
        effective_release: effectiveRelease,
      }),
      correction_key: payload.correction_key,
      control_type: payload.control_type,
      disposition: payload.disposition,
      issue,
      pr,
      effective_commit: effectiveCommit,
      effective_release: effectiveRelease,
      effective_at: resolveEffectiveAt(payload.disposition, effectiveCommit, effectiveRelease, at),
      supersedes: payload.supersedes ?? null,
      evidence_ref: evidenceRef,
      note,
    };

    const ledgerPath = controlAttributionsPath(repoDir);
    await deps.mkdir(path.dirname(ledgerPath), { recursive: true });
    await deps.appendFile(ledgerPath, `${JSON.stringify(record)}\n`);
    return true;
  } catch (err) {
    console.warn(
      `[pipeline] correction: emitControlAttribution failed (non-fatal): ${(err as Error).message}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Report-side visible failure (#501): validate a control_attribution record
// read back from the durable ledger before a consumer (the scoreboard) trusts
// it, mirroring validateCorrectionEvent's tolerant-but-visible discipline.
// ---------------------------------------------------------------------------

export type ControlAttributionValidation =
  | { ok: true; attribution: ControlAttribution }
  | { ok: false; error: string };

export function validateControlAttribution(raw: unknown): ControlAttributionValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "control_attribution is not an object" };
  }
  const r = raw as Record<string, unknown>;
  if (r.type !== "control_attribution") {
    return { ok: false, error: `expected type "control_attribution", got ${JSON.stringify(r.type)}` };
  }
  if (r.schema_version !== 1) {
    return { ok: false, error: `unknown control_attribution schema_version: ${JSON.stringify(r.schema_version)}` };
  }
  const requiredStrings: (keyof ControlAttribution)[] = [
    "at", "attribution_id", "correction_key", "control_type", "disposition", "evidence_ref",
  ];
  for (const field of requiredStrings) {
    if (r[field] === undefined || r[field] === null) {
      return { ok: false, error: `control_attribution missing required field "${field}"` };
    }
  }
  if (!(CORRECTION_PROPOSED_CONTROLS as readonly string[]).includes(r.control_type as string)) {
    return { ok: false, error: `control_attribution has an invalid control_type: ${JSON.stringify(r.control_type)}` };
  }
  if (!(CONTROL_ATTRIBUTION_DISPOSITIONS as readonly string[]).includes(r.disposition as string)) {
    return { ok: false, error: `control_attribution has an invalid disposition: ${JSON.stringify(r.disposition)}` };
  }
  const evidenceRef = r.evidence_ref as Record<string, unknown> | null;
  if (!evidenceRef || typeof evidenceRef !== "object" || typeof evidenceRef.id !== "string" ||
    !(EVIDENCE_REF_KINDS as readonly string[]).includes(evidenceRef.kind as string)) {
    return { ok: false, error: "control_attribution has a malformed evidence_ref" };
  }
  return { ok: true, attribution: raw as ControlAttribution };
}
