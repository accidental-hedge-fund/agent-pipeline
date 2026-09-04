// Unique-operation reliability classifier (#1368).
//
// Pure aggregator: deduplicates by logical_operation_id and classifies the
// closed terminal-outcome set. FRG `operation_reliability`, factory scoreboard,
// and production-outcome attribution consume this function. No store, CLI verb,
// or scheduler.

import * as crypto from "node:crypto";
import * as path from "node:path";
import { coveredLifecycleClassesFromExecutedRows, type ExecutedMatrixRow } from "./fault-recovery-matrix.ts";

function stableFingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(canonical);
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = canonical(o[k]);
    return out;
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export const UNIQUE_OPERATION_SCHEMA_VERSION = 1 as const;

export const REQUIRED_PUBLIC_ENTRYPOINTS = [
  "drive",
  "single",
  "loop",
  "train",
  "merge",
  "merge-queue",
  "ship",
] as const;
export type RequiredPublicEntrypoint = (typeof REQUIRED_PUBLIC_ENTRYPOINTS)[number];

/** #1333 mechanical fault-matrix lifecycle classes required for FRG promotion. */
export const REQUIRED_LIFECYCLE_CLASSES_1333 = [
  "mechanical",
  "workflow",
  "infrastructure",
  "authentication",
  "unknown",
] as const;
export type RequiredLifecycleClass1333 = (typeof REQUIRED_LIFECYCLE_CLASSES_1333)[number];

export const UNIQUE_OPERATION_TERMINALS = [
  "verified_success",
  "cooling_recovery",
  "external_wait",
  "typed_request",
  "cancellation",
  "false_human_projection",
  "ownerless_terminal",
] as const;
export type UniqueOperationTerminal = (typeof UNIQUE_OPERATION_TERMINALS)[number];

export type ManifestExpectedOutcome = "external_wait" | "typed_request" | "cancellation";

export interface UniqueOperationAttempt {
  run_id: string;
  logical_operation_id?: string | null;
  parent_logical_operation_id?: string | null;
  entrypoint?: string | null;
  /** Nested child of an admitted parent — does not mint or count a second success. */
  nested?: boolean;
  /** Authoritative exact-candidate postcondition proof. */
  postcondition_proof?: boolean;
  process_exit_zero?: boolean;
  run_complete?: boolean;
  issue_closed?: boolean;
  ready_to_deploy_label?: boolean;
  /** Caller-classified terminal when already known. */
  terminal?: UniqueOperationTerminal | "unknown" | null;
  /** Mechanical/workflow/infra/auth/unknown projected as human without matching grounds. */
  false_human?: boolean;
  composition_false_human?: boolean;
  exact_candidate_recovery?: boolean | null;
  independent_sibling_continuation?: boolean | null;
  /** #1301 live train_loop_linked identity present on this attempt. */
  train_loop_linked?: boolean;
  child_logical_operation_id?: string | null;
  /** Exact child loop run id from `train_loop_linked` when followable. */
  child_run_id?: string | null;
  /** Exact child events path from `train_loop_linked` when followable. */
  child_events_path?: string | null;
  /**
   * Authoritative candidate SHA bound on the durable artifact. Unbound
   * attempts must not be stamped with a later FRG candidate.
   */
  candidate_sha?: string | null;
  /** Release identity bound on the durable artifact when present. */
  release_identity?: string | null;
  /** Fixture / operation id used to look up manifest-declared expected outcomes. */
  fixture_id?: string | null;
  manual_reinvocation?: boolean;
  covered_lifecycle_classes?: readonly string[];
  /** Evidence refs (run.json path, event seq, proof id). */
  evidence_refs?: readonly string[];
  /**
   * Artifact identity sources disagreed (e.g. run.json vs run_start).
   * Preserved for diagnostics; aggregator increments contradictory_correlation.
   */
  contradictory_identity?: boolean;
  /**
   * How `logical_operation_id` was obtained. `"run_id_fallback"` is a
   * physical-run identity used for entrypoint observation only. Omitted or
   * `"minted"` is a durable logical id.
   */
  identity_provenance?: "minted" | "run_id_fallback";
  /**
   * Candidate/release binding. `"unbound_inflight"` is a missing-field keep
   * during in-flight ship: entrypoint observation only. Omitted or `"bound"`
   * is a scored-candidate/release match.
   */
  binding_provenance?: "bound" | "unbound_inflight";
}

export interface UniqueOperationManifest {
  expected_outcomes?: Readonly<Record<string, ManifestExpectedOutcome>>;
  required_entrypoints?: readonly string[];
  required_lifecycle_classes?: readonly string[];
  covered_lifecycle_classes?: readonly string[];
  live_train_linkage_present?: boolean;
  candidate_sha?: string;
  release_identity?: string;
  /**
   * When true, aggregation is scoring an FRG pack nested under an admitted
   * in-flight `ship`. Missing entrypoint `ship` is not missing required
   * coverage and is not a stable exclusion. A completed prior `ship` still
   * counts as observed coverage. Not part of the manifest fingerprint.
   */
  in_flight_ship?: boolean;
}

export interface UniqueOperationRate {
  numerator: number;
  denominator: number;
  ratio: number | null;
  /** Discriminator so attempt/run counts cannot be substituted silently. */
  metric_kind: "unique_operation";
}

export interface UniqueOperationExclusion {
  logical_operation_id: string;
  reason: ManifestExpectedOutcome;
  fixture_id: string | null;
}

export interface UniqueOperationIntegrityCounts {
  missing_correlation: number;
  contradictory_correlation: number;
  missing_required_coverage: number;
}

export interface UniqueOperationEvidenceRef {
  logical_operation_id: string;
  run_ids: string[];
  terminal: UniqueOperationTerminal | "unknown";
  nested: boolean;
  entrypoints: string[];
  evidence_refs: string[];
  manual_reinvocation: boolean;
  /** Per-operation candidate binding copied from durable artifacts, never stamped later. */
  candidate_sha?: string;
  /** Per-operation release binding copied from durable artifacts when present. */
  release_identity?: string;
}

export interface UniqueOperationReliability {
  schema_version: typeof UNIQUE_OPERATION_SCHEMA_VERSION;
  candidate_sha: string;
  release_identity: string;
  manifest_fingerprint: string;
  entrypoint_coverage: {
    required: string[];
    observed: string[];
    missing: string[];
  };
  clean_completion: UniqueOperationRate;
  false_human_projection: UniqueOperationRate;
  ownerless_terminal: UniqueOperationRate;
  exact_candidate_recovery: UniqueOperationRate;
  independent_sibling_continuation: UniqueOperationRate;
  exclusions: UniqueOperationExclusion[];
  integrity: UniqueOperationIntegrityCounts;
  operations: UniqueOperationEvidenceRef[];
  /**
   * Binder-accepted executed matrix rows that fed #1333 coverage for this
   * scored SHA. Omitted when no rows were attached.
   */
  executed_matrix_rows?: ExecutedMatrixRow[];
}

function rate(numerator: number, denominator: number): UniqueOperationRate {
  return {
    numerator,
    denominator,
    ratio: denominator === 0 ? null : numerator / denominator,
    metric_kind: "unique_operation",
  };
}

function classifyAttempt(attempt: UniqueOperationAttempt): UniqueOperationTerminal | "unknown" {
  if (attempt.false_human === true || attempt.composition_false_human === true) {
    return "false_human_projection";
  }
  if (attempt.terminal && attempt.terminal !== "unknown") {
    if (attempt.terminal === "verified_success" && attempt.postcondition_proof !== true) {
      // Process exit / run_complete / labels are not verified success.
      return "ownerless_terminal";
    }
    return attempt.terminal;
  }
  if (attempt.postcondition_proof === true) return "verified_success";
  if (attempt.terminal === "cooling_recovery") return "cooling_recovery";
  if (attempt.terminal === "external_wait") return "external_wait";
  if (attempt.terminal === "typed_request") return "typed_request";
  if (attempt.terminal === "cancellation") return "cancellation";
  // Zero-exit, run_complete, issue closure, and R2D labels are evidence, not success.
  return "ownerless_terminal";
}

function uniqueOpKey(id: string): string {
  return id.trim();
}

function nonEmptyTrimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function uniqueNonEmpty(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = nonEmptyTrimmed(value);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

const REQUIRED_PUBLIC_ENTRYPOINT_SET: ReadonlySet<string> = new Set(REQUIRED_PUBLIC_ENTRYPOINTS);

/** Map a stamped admission entrypoint or recognized run kind. Never coerce to `single`. */
export function mapPublicEntrypoint(kindOrEntrypoint: unknown): string | null {
  const value = nonEmptyTrimmed(kindOrEntrypoint);
  if (!value) return null;
  if (REQUIRED_PUBLIC_ENTRYPOINT_SET.has(value)) return value;
  return null;
}

export function uniqueOperationManifestFingerprint(manifest: {
  expected_outcomes?: Readonly<Record<string, ManifestExpectedOutcome>>;
  required_entrypoints?: readonly string[];
  required_lifecycle_classes?: readonly string[];
}): string {
  return stableFingerprint({
    expected_outcomes: manifest.expected_outcomes ?? {},
    required_entrypoints: [...(manifest.required_entrypoints ?? REQUIRED_PUBLIC_ENTRYPOINTS)],
    required_lifecycle_classes: [
      ...(manifest.required_lifecycle_classes ?? REQUIRED_LIFECYCLE_CLASSES_1333),
    ],
  });
}

/**
 * One pure aggregator. Deduplicates by logical_operation_id.
 * Nested attempts inherit the parent id and do not increment unique success.
 */
export function aggregateUniqueOperationReliability(input: {
  attempts: readonly UniqueOperationAttempt[];
  manifest?: UniqueOperationManifest | null;
  composition_false_human_count?: number;
  candidate_sha?: string;
  release_identity?: string;
  /**
   * Executed matrix coverage for the scored candidate. `undefined` reads
   * executed rows bound to the scored SHA. An explicit list (including empty)
   * is the test overlay. Static inventory never satisfies this field.
   */
  matrix_covered_lifecycle_classes?: readonly string[] | null;
  /** Executed matrix-row records keyed to candidate SHA and coverage layer. */
  executed_matrix_rows?: readonly ExecutedMatrixRow[];
  /**
   * FRG pack nested under an admitted in-flight `ship`. Same rule as
   * `manifest.in_flight_ship`.
   */
  in_flight_ship?: boolean;
}): UniqueOperationReliability {
  const manifest = input.manifest ?? {};
  const requiredEntrypoints = [...(manifest.required_entrypoints ?? REQUIRED_PUBLIC_ENTRYPOINTS)];
  const requiredLifecycle = [...(manifest.required_lifecycle_classes ?? REQUIRED_LIFECYCLE_CLASSES_1333)];
  const expectedOutcomes = manifest.expected_outcomes ?? {};

  let missingCorrelation = 0;
  let contradictoryCorrelation = 0;
  const observedEntrypoints = new Set<string>();
  const scoredSha = (manifest.candidate_sha ?? input.candidate_sha ?? "").trim();
  const matrixCovered = new Set<string>(
    input.matrix_covered_lifecycle_classes !== undefined
      ? input.matrix_covered_lifecycle_classes ?? []
      : coveredLifecycleClassesFromExecutedRows(input.executed_matrix_rows ?? [], scoredSha),
  );
  const claimedLifecycle = new Set<string>(manifest.covered_lifecycle_classes ?? []);
  const scoredRelease = (manifest.release_identity ?? input.release_identity ?? "").trim();
  const deferInFlightShip =
    input.in_flight_ship === true || manifest.in_flight_ship === true;

  const byId = new Map<
    string,
    {
      run_ids: string[];
      terminals: UniqueOperationTerminal[];
      nested: boolean;
      entrypoints: string[];
      evidence_refs: string[];
      manual_reinvocation: boolean;
      exact_candidate_recovery: boolean[];
      independent_sibling_continuation: boolean[];
      train_loop_linked: boolean;
      child_ids: string[];
      fixture_ids: string[];
      candidate_sha: string;
      release_identity: string;
      identity_provenance: "minted" | "run_id_fallback";
      binding_provenance: "bound" | "unbound_inflight";
    }
  >();

  for (const attempt of input.attempts) {
    const attemptSha =
      typeof attempt.candidate_sha === "string" ? attempt.candidate_sha.trim() : "";
    const attemptRelease =
      typeof attempt.release_identity === "string" ? attempt.release_identity.trim() : "";
    // Other-candidate artifacts must not satisfy the scored candidate's SLOs.
    if (scoredSha && attemptSha && attemptSha !== scoredSha) {
      continue;
    }
    if (scoredRelease && attemptRelease && attemptRelease !== scoredRelease) {
      continue;
    }
    const id = typeof attempt.logical_operation_id === "string" ? attempt.logical_operation_id.trim() : "";
    if (!id) {
      missingCorrelation += 1;
      continue;
    }
    const parent = typeof attempt.parent_logical_operation_id === "string"
      ? attempt.parent_logical_operation_id.trim()
      : "";
    if (attempt.contradictory_identity === true) {
      contradictoryCorrelation += 1;
    }
    if (parent && parent !== id) {
      contradictoryCorrelation += 1;
    }
    const child = typeof attempt.child_logical_operation_id === "string"
      ? attempt.child_logical_operation_id.trim()
      : "";
    const entry = byId.get(uniqueOpKey(id)) ?? {
      run_ids: [],
      terminals: [],
      nested: true,
      entrypoints: [],
      evidence_refs: [],
      manual_reinvocation: false,
      exact_candidate_recovery: [],
      independent_sibling_continuation: [],
      train_loop_linked: false,
      child_ids: [],
      fixture_ids: [],
      candidate_sha: "",
      release_identity: "",
      identity_provenance: "run_id_fallback",
      binding_provenance: "unbound_inflight",
    };
    if (attempt.identity_provenance !== "run_id_fallback") {
      entry.identity_provenance = "minted";
    }
    const unboundInflight = attemptIsUnboundInflight(
      attempt,
      scoredSha,
      scoredRelease,
      deferInFlightShip,
    );
    if (!unboundInflight) entry.binding_provenance = "bound";
    if (!entry.run_ids.includes(attempt.run_id)) entry.run_ids.push(attempt.run_id);
    // Unbound in-flight keeps are entrypoint observation only. Their terminals
    // must not mint verified success, exclusions, or ownerless SLO numerators.
    if (!unboundInflight) {
      entry.terminals.push(classifyAttempt(attempt));
    }
    if (attemptSha && !entry.candidate_sha) entry.candidate_sha = attemptSha;
    if (attemptRelease && !entry.release_identity) entry.release_identity = attemptRelease;
    // A logical operation is nested only when every physical attempt is nested.
    if (attempt.nested !== true) entry.nested = false;
    if (typeof attempt.entrypoint === "string" && attempt.entrypoint.trim()) {
      entry.entrypoints.push(attempt.entrypoint.trim());
      observedEntrypoints.add(attempt.entrypoint.trim());
    }
    if (attempt.evidence_refs) {
      for (const ref of attempt.evidence_refs) entry.evidence_refs.push(ref);
    } else {
      entry.evidence_refs.push(`run:${attempt.run_id}`);
    }
    if (attemptSha && !entry.evidence_refs.includes(`candidate:${attemptSha}`)) {
      entry.evidence_refs.push(`candidate:${attemptSha}`);
    }
    if (attemptRelease && !entry.evidence_refs.includes(`release:${attemptRelease}`)) {
      entry.evidence_refs.push(`release:${attemptRelease}`);
    }
    if (attempt.manual_reinvocation === true) entry.manual_reinvocation = true;
    if (!unboundInflight) {
      if (attempt.exact_candidate_recovery === true) entry.exact_candidate_recovery.push(true);
      if (attempt.exact_candidate_recovery === false) entry.exact_candidate_recovery.push(false);
      if (attempt.independent_sibling_continuation === true) {
        entry.independent_sibling_continuation.push(true);
      }
      if (attempt.independent_sibling_continuation === false) {
        entry.independent_sibling_continuation.push(false);
      }
    }
    if (attempt.train_loop_linked === true) entry.train_loop_linked = true;
    if (child) entry.child_ids.push(child);
    if (typeof attempt.fixture_id === "string" && attempt.fixture_id.trim()) {
      entry.fixture_ids.push(attempt.fixture_id.trim());
    }
    for (const cls of attempt.covered_lifecycle_classes ?? []) {
      if (cls) claimedLifecycle.add(cls);
    }
    byId.set(uniqueOpKey(id), entry);
  }

  const operations: UniqueOperationEvidenceRef[] = [];
  const exclusions: UniqueOperationExclusion[] = [];
  let cleanEligible = 0;
  let cleanSuccess = 0;
  let falseHuman = 0;
  let ownerless = 0;
  let recoveryDenom = 0;
  let recoveryNum = 0;
  let siblingDenom = 0;
  let siblingNum = 0;
  let liveLinkage = manifest.live_train_linkage_present === true;

  for (const [id, entry] of byId) {
    const hasFalseHuman = entry.terminals.includes("false_human_projection");
    const hasVerified = entry.terminals.includes("verified_success");
    const hasCooling = entry.terminals.includes("cooling_recovery");
    const hasWait = entry.terminals.includes("external_wait");
    const hasTyped = entry.terminals.includes("typed_request");
    const hasCancel = entry.terminals.includes("cancellation");
    const hasOwnerless = entry.terminals.includes("ownerless_terminal");
    const hasPermittedNonSuccess = hasCooling || hasWait || hasTyped || hasCancel;
    // A later verified proof must not erase an unresolved ownerless exit.
    const unresolvedOwnerless = hasOwnerless && !hasPermittedNonSuccess;
    let terminal: UniqueOperationTerminal | "unknown";
    if (hasFalseHuman) terminal = "false_human_projection";
    else if (unresolvedOwnerless) terminal = "ownerless_terminal";
    else if (hasVerified) terminal = "verified_success";
    else if (hasCooling) terminal = "cooling_recovery";
    else if (hasWait) terminal = "external_wait";
    else if (hasTyped) terminal = "typed_request";
    else if (hasCancel) terminal = "cancellation";
    else if (hasOwnerless) terminal = "ownerless_terminal";
    else terminal = "unknown";

    if (terminal === "unknown") terminal = "ownerless_terminal";

    operations.push({
      logical_operation_id: id,
      run_ids: [...entry.run_ids],
      terminal,
      nested: entry.nested,
      entrypoints: [...new Set(entry.entrypoints)],
      evidence_refs: [...entry.evidence_refs],
      manual_reinvocation: entry.manual_reinvocation,
      ...(entry.candidate_sha ? { candidate_sha: entry.candidate_sha } : {}),
      ...(entry.release_identity ? { release_identity: entry.release_identity } : {}),
    });

    // Live train-link: followable child logical id from the event or loaded child.
    if (entry.train_loop_linked && entry.child_ids.length > 0) {
      liveLinkage = true;
    }

    const fallbackIdentity = entry.identity_provenance === "run_id_fallback";
    const observationOnly =
      fallbackIdentity || entry.binding_provenance === "unbound_inflight";
    if (hasFalseHuman) falseHuman += 1;
    // Fallback-identity and unbound-inflight host artifacts observe
    // entrypoints only. They must not inflate ownerless-terminal or
    // clean-completion SLOs.
    if (!observationOnly && terminal === "ownerless_terminal") ownerless += 1;

    const fixtureId = entry.fixture_ids[0] ?? null;
    const declared = fixtureId ? expectedOutcomes[fixtureId] : undefined;
    const declaredOk =
      (declared === "external_wait" && hasWait) ||
      (declared === "typed_request" && hasTyped) ||
      (declared === "cancellation" && hasCancel);

    if (declaredOk && fixtureId && !observationOnly) {
      exclusions.push({
        logical_operation_id: id,
        reason: declared,
        fixture_id: fixtureId,
      });
    } else if (!entry.nested && !observationOnly) {
      cleanEligible += 1;
      if (hasVerified && !entry.manual_reinvocation && !unresolvedOwnerless) {
        cleanSuccess += 1;
      }
    }

    if (entry.exact_candidate_recovery.length > 0) {
      recoveryDenom += 1;
      if (!entry.exact_candidate_recovery.includes(false)) recoveryNum += 1;
    }
    if (entry.independent_sibling_continuation.length > 0) {
      siblingDenom += 1;
      if (!entry.independent_sibling_continuation.includes(false)) siblingNum += 1;
    }
  }

  // Composition false-human expands onto unique-operation grain when the
  // composition classifier already recorded a projection and no attempt flag
  // was supplied (same durable classification, not a second prose classifier).
  const compositionFalseHuman = input.composition_false_human_count ?? 0;
  if (compositionFalseHuman > falseHuman) {
    falseHuman = compositionFalseHuman;
  }

  const coveredLifecycle = new Set<string>(
    [...claimedLifecycle].filter((cls) => matrixCovered.has(cls)),
  );
  // Matrix-proved classes count even when helpers no longer stamp them.
  for (const cls of matrixCovered) coveredLifecycle.add(cls);

  const missingEntrypoints = requiredEntrypoints.filter((e) => {
    if (observedEntrypoints.has(e)) return false;
    if (deferInFlightShip && e === "ship") return false;
    return true;
  });
  const missingLifecycle = requiredLifecycle.filter((c) => !coveredLifecycle.has(c));
  let missingRequiredCoverage = 0;
  if (missingEntrypoints.length > 0) missingRequiredCoverage += missingEntrypoints.length;
  if (missingLifecycle.length > 0) missingRequiredCoverage += missingLifecycle.length;
  if (!liveLinkage && requiredEntrypoints.includes("train")) {
    missingRequiredCoverage += 1;
  }

  const uniqueCount = byId.size;
  const candidateSha = scoredSha;
  const releaseIdentity = scoredRelease;
  const manifestFingerprint = uniqueOperationManifestFingerprint({
    expected_outcomes: expectedOutcomes,
    required_entrypoints: requiredEntrypoints,
    required_lifecycle_classes: requiredLifecycle,
  });

  const boundExecutedRows = (input.executed_matrix_rows ?? []).filter(
    (row) => typeof row.candidate_sha === "string" && row.candidate_sha.trim() === scoredSha,
  );
  return {
    schema_version: UNIQUE_OPERATION_SCHEMA_VERSION,
    candidate_sha: candidateSha,
    release_identity: releaseIdentity,
    manifest_fingerprint: manifestFingerprint,
    entrypoint_coverage: {
      required: requiredEntrypoints,
      observed: [...observedEntrypoints].sort(),
      missing: missingEntrypoints,
    },
    clean_completion: rate(cleanSuccess, cleanEligible),
    false_human_projection: rate(falseHuman, uniqueCount),
    ownerless_terminal: rate(ownerless, uniqueCount),
    exact_candidate_recovery: rate(recoveryNum, recoveryDenom),
    independent_sibling_continuation: rate(siblingNum, siblingDenom),
    exclusions,
    integrity: {
      missing_correlation: missingCorrelation,
      contradictory_correlation: contradictoryCorrelation,
      missing_required_coverage: missingRequiredCoverage,
    },
    operations,
    ...(boundExecutedRows.length > 0 ? { executed_matrix_rows: boundExecutedRows } : {}),
  };
}

/**
 * Unique-operation SLO / integrity failure, or null when the section meets
 * release-eligible targets. Missing section is an integrity failure, never an
 * exclusion.
 */
export function uniqueOperationSloFailure(
  section: UniqueOperationReliability | null | undefined,
): string | null {
  if (!section) {
    return "missing operation_reliability section";
  }
  if (!section.candidate_sha.trim()) {
    return "operation_reliability.candidate_sha is empty";
  }
  if (!section.release_identity.trim()) {
    return "operation_reliability.release_identity is empty";
  }
  if (section.integrity.missing_correlation > 0) {
    return `missing correlation (${section.integrity.missing_correlation})`;
  }
  if (section.integrity.contradictory_correlation > 0) {
    return `contradictory correlation (${section.integrity.contradictory_correlation})`;
  }
  if (section.integrity.missing_required_coverage > 0) {
    return `missing required coverage (${section.integrity.missing_required_coverage})`;
  }
  if (section.false_human_projection.numerator > 0) {
    return `false-human projection count ${section.false_human_projection.numerator} > 0`;
  }
  if (section.ownerless_terminal.numerator > 0) {
    return `ownerless terminal count ${section.ownerless_terminal.numerator} > 0`;
  }
  if (
    section.clean_completion.denominator > 0 &&
    section.clean_completion.ratio !== 1
  ) {
    return (
      `clean completion ${section.clean_completion.numerator}/` +
      `${section.clean_completion.denominator} < 100%`
    );
  }
  if (
    section.exact_candidate_recovery.denominator > 0 &&
    section.exact_candidate_recovery.ratio !== 1
  ) {
    return "exact-candidate recovery below 100%";
  }
  if (
    section.independent_sibling_continuation.denominator > 0 &&
    section.independent_sibling_continuation.ratio !== 1
  ) {
    return "independent-sibling continuation below 100%";
  }
  return null;
}

/**
 * Candidate SHA, release identity, and manifest fingerprint must bind the
 * scored FRG evidence. Empty or mismatched bindings are not release-eligible.
 */
export function uniqueOperationReleaseBindingFailure(
  section: UniqueOperationReliability | null | undefined,
  binding: {
    candidate_sha?: string | null;
    release_identity?: string | null;
  },
): string | null {
  if (!section) {
    return "missing operation_reliability section";
  }
  if (!section.candidate_sha.trim()) {
    return "operation_reliability.candidate_sha is empty";
  }
  if (!section.release_identity.trim()) {
    return "operation_reliability.release_identity is empty";
  }
  const release = (binding.release_identity ?? "").trim();
  if (release && section.release_identity !== release) {
    return (
      `operation_reliability.release_identity ${section.release_identity} ` +
      `does not match ${release}`
    );
  }
  const sha = (binding.candidate_sha ?? "").trim();
  if (sha && section.candidate_sha !== sha) {
    return "operation_reliability.candidate_sha does not match the scored candidate";
  }
  const expectedOutcomes: Record<string, ManifestExpectedOutcome> = {};
  for (const exclusion of section.exclusions) {
    if (exclusion.fixture_id) expectedOutcomes[exclusion.fixture_id] = exclusion.reason;
  }
  const expectedFp = uniqueOperationManifestFingerprint({
    expected_outcomes: expectedOutcomes,
    required_entrypoints: REQUIRED_PUBLIC_ENTRYPOINTS,
    required_lifecycle_classes: REQUIRED_LIFECYCLE_CLASSES_1333,
  });
  if (section.manifest_fingerprint !== expectedFp) {
    return "operation_reliability.manifest_fingerprint does not match manifested reliability inputs";
  }
  return null;
}

type ScannedRunArtifact = {
  runId: string;
  runJson: Record<string, unknown> | null;
  events: readonly Record<string, unknown>[];
  summary: Record<string, unknown> | null;
  /** Absolute events.jsonl path this artifact was loaded from, when known. */
  eventsFilePath?: string | null;
};

function artifactLogicalId(run: ScannedRunArtifact): string | null {
  const start = run.events.find((e) => e.type === "run_start");
  return (
    uniqueNonEmpty([
      run.runJson?.logical_operation_id,
      run.summary?.logical_operation_id,
      start?.logical_operation_id,
    ])[0] ?? null
  );
}

function artifactCandidateSha(run: ScannedRunArtifact): string | null {
  const sources = uniqueNonEmpty([
    run.runJson?.candidate_sha,
    run.runJson?.candidate_git_sha,
    run.summary?.candidate_sha,
    run.summary?.candidate_git_sha,
    ...run.events.map((e) => e.candidate_sha),
    ...run.events.map((e) => e.candidate_git_sha),
  ]);
  return sources.length === 1 ? sources[0]! : null;
}

function artifactReleaseIdentity(run: ScannedRunArtifact): string | null {
  const sources = uniqueNonEmpty([
    run.runJson?.release_identity,
    run.runJson?.release_version,
    run.summary?.release_identity,
    run.summary?.release_version,
    ...run.events.map((e) => e.release_identity),
    ...run.events.map((e) => e.release_version),
  ]);
  return sources.length === 1 ? sources[0]! : null;
}

function trainLinkedEventRefs(event: Record<string, unknown>): {
  loopRunId: string | null;
  eventsPath: string | null;
} {
  return {
    loopRunId: nonEmptyTrimmed(event.loop_run_id),
    eventsPath: nonEmptyTrimmed(event.events) ?? nonEmptyTrimmed(event.events_path),
  };
}

function sameAbsoluteEventsPath(
  eventPath: string | null | undefined,
  artifactPath: string | null | undefined,
): boolean {
  const left = nonEmptyTrimmed(eventPath);
  const right = nonEmptyTrimmed(artifactPath);
  if (!left || !right) return false;
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  return path.resolve(left) === path.resolve(right);
}

function followableChildLogicalId(
  childMinted: string | null,
  eventLogical: string | null,
  trainLogical: string | null,
): string | null {
  if (childMinted && trainLogical && childMinted !== trainLogical) return childMinted;
  return eventLogical ?? childMinted;
}

function attemptIsUnboundInflight(
  attempt: UniqueOperationAttempt,
  scoredSha: string,
  scoredRelease: string,
  inFlightShip: boolean,
): boolean {
  if (attempt.binding_provenance === "unbound_inflight") return true;
  if (attempt.binding_provenance === "bound") return false;
  if (!inFlightShip) return false;
  const sha =
    typeof attempt.candidate_sha === "string" ? attempt.candidate_sha.trim() : "";
  if (scoredSha && !sha) return true;
  const release =
    typeof attempt.release_identity === "string" ? attempt.release_identity.trim() : "";
  if (scoredRelease && !release) return true;
  return false;
}

/**
 * Keep only attempts bound to the scored candidate/release. Other-candidate
 * and unbound artifacts are omitted so they cannot satisfy the current gate.
 * When `candidate_sha` is empty, the list is returned unchanged (scoreboard).
 * When `release_identity` is scored, missing and mismatched identities drop
 * unless `inFlightShip` is true: then missing-field attempts are kept as
 * `unbound_inflight` (entrypoint observation only) and present mismatches
 * still drop.
 */
export function filterAttemptsBoundToCandidate(
  attempts: readonly UniqueOperationAttempt[],
  binding: {
    candidate_sha?: string | null;
    release_identity?: string | null;
    inFlightShip?: boolean;
  },
): UniqueOperationAttempt[] {
  const scoredSha = (binding.candidate_sha ?? "").trim();
  const scoredRelease = (binding.release_identity ?? "").trim();
  const inFlightShip = binding.inFlightShip === true;
  if (!scoredSha) return [...attempts];
  const kept: UniqueOperationAttempt[] = [];
  for (const attempt of attempts) {
    const sha =
      typeof attempt.candidate_sha === "string" ? attempt.candidate_sha.trim() : "";
    if (inFlightShip) {
      if (sha && sha !== scoredSha) continue;
    } else if (sha !== scoredSha) {
      continue;
    }
    const release =
      typeof attempt.release_identity === "string" ? attempt.release_identity.trim() : "";
    if (scoredRelease) {
      if (inFlightShip) {
        if (release && release !== scoredRelease) continue;
      } else if (release !== scoredRelease) {
        continue;
      }
    }
    const unbound = inFlightShip && (!sha || (scoredRelease !== "" && !release));
    kept.push({
      ...attempt,
      binding_provenance: unbound ? "unbound_inflight" : "bound",
    });
  }
  return kept;
}

/**
 * Map a durable run-id prefix to a required public entrypoint. `merge-queue-`
 * and `mq-` are checked before remaining `merge-`. `merge-queue-repair-pr-*`
 * helper ids are not public `merge-queue`. Unrecognized ids stay null.
 */
export function mapPublicEntrypointFromRunId(runId: unknown): string | null {
  const id = nonEmptyTrimmed(runId);
  if (!id) return null;
  if (id.startsWith("merge-queue-repair-pr-")) return null;
  if (id.startsWith("merge-queue-") || id.startsWith("mq-")) return "merge-queue";
  if (id.startsWith("train-")) return "train";
  if (id.startsWith("loop-")) return "loop";
  if (id.startsWith("single-")) return "single";
  if (id.startsWith("merge-")) return "merge";
  // `runIdFor`: `<issue>-<YYYY-MM-DDTHH-MM-SS-mmmZ>`
  if (/^\d+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(id)) return "drive";
  return null;
}

/** Map scanned run artifacts into classifier attempts. Does not invent minted ids. */
export function attemptsFromRunArtifacts(
  runs: readonly ScannedRunArtifact[],
): UniqueOperationAttempt[] {
  const byId = new Map<string, ScannedRunArtifact>();
  for (const run of runs) byId.set(run.runId, run);
  return runs.map((run) => {
    const start = run.events.find((e) => e.type === "run_start");
    const identitySources = uniqueNonEmpty([
      run.runJson?.logical_operation_id,
      run.summary?.logical_operation_id,
      start?.logical_operation_id,
    ]);
    const contradictoryIdentity = identitySources.length > 1;
    const mintedLogical = identitySources[0] ?? null;
    const runIdFallback = nonEmptyTrimmed(run.runId);
    const logical = mintedLogical ?? runIdFallback;
    const identityProvenance: UniqueOperationAttempt["identity_provenance"] = mintedLogical
      ? "minted"
      : runIdFallback
        ? "run_id_fallback"
        : undefined;
    const complete = run.events.find((e) => e.type === "run_complete");
    const parentSources = uniqueNonEmpty([
      run.runJson?.parent_logical_operation_id,
      start?.parent_logical_operation_id,
    ]);
    const parent = parentSources[0] ?? null;
    const nested = run.runJson?.nested_logical_operation === true || start?.nested === true;
    const postcondition =
      run.summary?.verified_completion === true ||
      run.events.some((e) => e.type === "verified_completion" || e.exact_candidate_proof === true);
    const entrypoint =
      mapPublicEntrypoint(start?.entrypoint) ??
      mapPublicEntrypoint(run.runJson?.kind) ??
      mapPublicEntrypointFromRunId(run.runId);
    let trainLinked = false;
    let childLogical: string | null = null;
    let childRunId: string | null = null;
    let childEventsPath: string | null = null;
    for (const event of run.events) {
      if (event.type !== "train_loop_linked") continue;
      const refs = trainLinkedEventRefs(event);
      if (!refs.loopRunId || !refs.eventsPath) continue;
      if (!path.isAbsolute(refs.eventsPath)) continue;
      const child = byId.get(refs.loopRunId);
      if (!child) continue;
      if (!sameAbsoluteEventsPath(refs.eventsPath, child.eventsFilePath)) continue;
      const eventLogical = nonEmptyTrimmed(event.logical_operation_id);
      const childMinted = artifactLogicalId(child);
      const childId = followableChildLogicalId(childMinted, eventLogical, logical);
      if (!logical || !childId) continue;
      trainLinked = true;
      childLogical = childId;
      childRunId = refs.loopRunId;
      childEventsPath = refs.eventsPath;
      break;
    }
    const candidateSha = artifactCandidateSha(run);
    const releaseIdentity = artifactReleaseIdentity(run);
    const evidenceRefs = [`run:${run.runId}`];
    if (candidateSha) evidenceRefs.push(`candidate:${candidateSha}`);
    if (releaseIdentity) evidenceRefs.push(`release:${releaseIdentity}`);
    if (childRunId) evidenceRefs.push(`child-run:${childRunId}`);
    if (childEventsPath) evidenceRefs.push(`child-events:${childEventsPath}`);
    return {
      run_id: run.runId,
      logical_operation_id: logical,
      parent_logical_operation_id: parent,
      entrypoint,
      nested: nested === true,
      postcondition_proof: postcondition === true,
      process_exit_zero: complete != null,
      run_complete: complete != null,
      issue_closed: run.summary?.issue_closed === true,
      ready_to_deploy_label:
        run.summary?.finalState === "ready-to-deploy" ||
        run.summary?.final_state === "ready-to-deploy",
      train_loop_linked: trainLinked,
      child_logical_operation_id: childLogical,
      child_run_id: childRunId,
      child_events_path: childEventsPath,
      candidate_sha: candidateSha,
      release_identity: releaseIdentity,
      evidence_refs: evidenceRefs,
      contradictory_identity: contradictoryIdentity,
      ...(identityProvenance ? { identity_provenance: identityProvenance } : {}),
    };
  });
}

/**
 * Reconcile a completed side effect onto the original logical operation.
 * A later proof contributes one completion and MUST NOT replay the mutation.
 */
export function reconcileCompletedSideEffect<T>(input: {
  alreadyCompleted: boolean;
  mutate: () => T;
}): { replayed: boolean; completed: boolean; value: T | null } {
  if (input.alreadyCompleted) {
    return { replayed: false, completed: true, value: null };
  }
  return { replayed: false, completed: true, value: input.mutate() };
}

const PASSING_L = "lop-frg-required-coverage";

/** Hermetic passing unique-operation attempts for FRG unit fixtures. */
export function passingUniqueOperationAttempts(): UniqueOperationAttempt[] {
  return REQUIRED_PUBLIC_ENTRYPOINTS.map((entrypoint) => ({
    run_id: `run-${entrypoint}`,
    logical_operation_id: PASSING_L,
    parent_logical_operation_id: PASSING_L,
    entrypoint,
    nested: entrypoint !== "train",
    postcondition_proof: true,
    terminal: "verified_success" as const,
    train_loop_linked: entrypoint === "train" || entrypoint === "loop",
    child_logical_operation_id: PASSING_L,
    evidence_refs: [`run:run-${entrypoint}`],
  }));
}

function isRate(value: unknown): value is UniqueOperationRate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.numerator === "number" &&
    Number.isFinite(o.numerator) &&
    typeof o.denominator === "number" &&
    Number.isFinite(o.denominator) &&
    (o.ratio === null || (typeof o.ratio === "number" && Number.isFinite(o.ratio))) &&
    o.metric_kind === "unique_operation"
  );
}

export function parseUniqueOperationReliability(raw: unknown): UniqueOperationReliability {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("operation_reliability must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== UNIQUE_OPERATION_SCHEMA_VERSION) {
    throw new Error(
      `operation_reliability.schema_version must be ${UNIQUE_OPERATION_SCHEMA_VERSION}`,
    );
  }
  if (typeof o.candidate_sha !== "string") {
    throw new Error("operation_reliability.candidate_sha must be a string");
  }
  if (typeof o.release_identity !== "string") {
    throw new Error("operation_reliability.release_identity must be a string");
  }
  if (typeof o.manifest_fingerprint !== "string" || o.manifest_fingerprint.trim() === "") {
    throw new Error("operation_reliability.manifest_fingerprint must be a non-empty string");
  }
  const coverage = o.entrypoint_coverage;
  if (coverage === null || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new Error("operation_reliability.entrypoint_coverage must be an object");
  }
  const c = coverage as Record<string, unknown>;
  if (!Array.isArray(c.required) || !c.required.every((x) => typeof x === "string")) {
    throw new Error("operation_reliability.entrypoint_coverage.required must be a string array");
  }
  if (!Array.isArray(c.observed) || !c.observed.every((x) => typeof x === "string")) {
    throw new Error("operation_reliability.entrypoint_coverage.observed must be a string array");
  }
  if (!Array.isArray(c.missing) || !c.missing.every((x) => typeof x === "string")) {
    throw new Error("operation_reliability.entrypoint_coverage.missing must be a string array");
  }
  for (const key of [
    "clean_completion",
    "false_human_projection",
    "ownerless_terminal",
    "exact_candidate_recovery",
    "independent_sibling_continuation",
  ] as const) {
    if (!isRate(o[key])) {
      throw new Error(`operation_reliability.${key} must be a unique_operation rate`);
    }
  }
  if (!Array.isArray(o.exclusions)) {
    throw new Error("operation_reliability.exclusions must be an array");
  }
  const integrity = o.integrity;
  if (integrity === null || typeof integrity !== "object" || Array.isArray(integrity)) {
    throw new Error("operation_reliability.integrity must be an object");
  }
  const i = integrity as Record<string, unknown>;
  for (const k of ["missing_correlation", "contradictory_correlation", "missing_required_coverage"]) {
    if (typeof i[k] !== "number" || !Number.isFinite(i[k] as number) || (i[k] as number) < 0) {
      throw new Error(`operation_reliability.integrity.${k} must be a non-negative number`);
    }
  }
  if (!Array.isArray(o.operations)) {
    throw new Error("operation_reliability.operations must be an array");
  }
  return o as unknown as UniqueOperationReliability;
}

export function passingUniqueOperationManifest(input: {
  candidate_sha?: string;
  release_identity?: string;
} = {}): UniqueOperationManifest {
  return {
    required_entrypoints: [...REQUIRED_PUBLIC_ENTRYPOINTS],
    required_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
    covered_lifecycle_classes: [],
    live_train_linkage_present: true,
    candidate_sha: input.candidate_sha ?? "a".repeat(40),
    release_identity: input.release_identity ?? "",
  };
}
