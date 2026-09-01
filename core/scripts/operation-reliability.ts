// Unique-operation reliability classifier (#1368).
//
// Pure aggregator: deduplicates by logical_operation_id and classifies the
// closed terminal-outcome set. FRG `operation_reliability`, factory scoreboard,
// and production-outcome attribution consume this function. No store, CLI verb,
// or scheduler.

import * as crypto from "node:crypto";

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
  /** Fixture / operation id used to look up manifest-declared expected outcomes. */
  fixture_id?: string | null;
  manual_reinvocation?: boolean;
  covered_lifecycle_classes?: readonly string[];
  /** Evidence refs (run.json path, event seq, proof id). */
  evidence_refs?: readonly string[];
}

export interface UniqueOperationManifest {
  expected_outcomes?: Readonly<Record<string, ManifestExpectedOutcome>>;
  required_entrypoints?: readonly string[];
  required_lifecycle_classes?: readonly string[];
  covered_lifecycle_classes?: readonly string[];
  live_train_linkage_present?: boolean;
  candidate_sha?: string;
  release_identity?: string;
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
}): UniqueOperationReliability {
  const manifest = input.manifest ?? {};
  const requiredEntrypoints = [...(manifest.required_entrypoints ?? REQUIRED_PUBLIC_ENTRYPOINTS)];
  const requiredLifecycle = [...(manifest.required_lifecycle_classes ?? REQUIRED_LIFECYCLE_CLASSES_1333)];
  const expectedOutcomes = manifest.expected_outcomes ?? {};

  let missingCorrelation = 0;
  let contradictoryCorrelation = 0;
  const observedEntrypoints = new Set<string>();
  const coveredLifecycle = new Set<string>(manifest.covered_lifecycle_classes ?? []);
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
    }
  >();

  for (const attempt of input.attempts) {
    const id = typeof attempt.logical_operation_id === "string" ? attempt.logical_operation_id.trim() : "";
    if (!id) {
      missingCorrelation += 1;
      continue;
    }
    const parent = typeof attempt.parent_logical_operation_id === "string"
      ? attempt.parent_logical_operation_id.trim()
      : "";
    if (parent && parent !== id) {
      contradictoryCorrelation += 1;
    }
    const child = typeof attempt.child_logical_operation_id === "string"
      ? attempt.child_logical_operation_id.trim()
      : "";
    if (attempt.train_loop_linked === true && child && child !== id) {
      contradictoryCorrelation += 1;
    }
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
    };
    if (!entry.run_ids.includes(attempt.run_id)) entry.run_ids.push(attempt.run_id);
    entry.terminals.push(classifyAttempt(attempt));
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
    if (attempt.manual_reinvocation === true) entry.manual_reinvocation = true;
    if (attempt.exact_candidate_recovery === true) entry.exact_candidate_recovery.push(true);
    if (attempt.exact_candidate_recovery === false) entry.exact_candidate_recovery.push(false);
    if (attempt.independent_sibling_continuation === true) {
      entry.independent_sibling_continuation.push(true);
    }
    if (attempt.independent_sibling_continuation === false) {
      entry.independent_sibling_continuation.push(false);
    }
    if (attempt.train_loop_linked === true) entry.train_loop_linked = true;
    if (child) entry.child_ids.push(child);
    if (typeof attempt.fixture_id === "string" && attempt.fixture_id.trim()) {
      entry.fixture_ids.push(attempt.fixture_id.trim());
    }
    for (const cls of attempt.covered_lifecycle_classes ?? []) {
      if (cls) coveredLifecycle.add(cls);
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
    let terminal: UniqueOperationTerminal | "unknown";
    if (hasFalseHuman) terminal = "false_human_projection";
    else if (hasVerified) terminal = "verified_success";
    else if (hasCooling) terminal = "cooling_recovery";
    else if (hasWait) terminal = "external_wait";
    else if (hasTyped) terminal = "typed_request";
    else if (hasCancel) terminal = "cancellation";
    else if (entry.terminals.includes("ownerless_terminal")) terminal = "ownerless_terminal";
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
    });

    if (entry.train_loop_linked && (entry.child_ids.length === 0 || entry.child_ids.includes(id))) {
      liveLinkage = true;
    }

    if (hasFalseHuman) falseHuman += 1;
    if (terminal === "ownerless_terminal") ownerless += 1;

    const fixtureId = entry.fixture_ids[0] ?? null;
    const declared = fixtureId ? expectedOutcomes[fixtureId] : undefined;
    const declaredOk =
      (declared === "external_wait" && hasWait) ||
      (declared === "typed_request" && hasTyped) ||
      (declared === "cancellation" && hasCancel);

    if (declaredOk && fixtureId) {
      exclusions.push({
        logical_operation_id: id,
        reason: declared,
        fixture_id: fixtureId,
      });
    } else if (!entry.nested) {
      cleanEligible += 1;
      if (hasVerified && !entry.manual_reinvocation) cleanSuccess += 1;
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

  const missingEntrypoints = requiredEntrypoints.filter((e) => !observedEntrypoints.has(e));
  const missingLifecycle = requiredLifecycle.filter((c) => !coveredLifecycle.has(c));
  let missingRequiredCoverage = 0;
  if (missingEntrypoints.length > 0) missingRequiredCoverage += missingEntrypoints.length;
  if (missingLifecycle.length > 0) missingRequiredCoverage += missingLifecycle.length;
  if (!liveLinkage && requiredEntrypoints.includes("train")) {
    missingRequiredCoverage += 1;
  }

  const uniqueCount = byId.size;
  const candidateSha = (manifest.candidate_sha ?? input.candidate_sha ?? "").trim();
  const releaseIdentity = (manifest.release_identity ?? input.release_identity ?? "").trim();
  const manifestFingerprint = stableFingerprint({
    expected_outcomes: expectedOutcomes,
    required_entrypoints: requiredEntrypoints,
    required_lifecycle_classes: requiredLifecycle,
  });

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

/** Map scanned run artifacts into classifier attempts. Does not invent ids. */
export function attemptsFromRunArtifacts(
  runs: readonly {
    runId: string;
    runJson: Record<string, unknown> | null;
    events: readonly Record<string, unknown>[];
    summary: Record<string, unknown> | null;
  }[],
): UniqueOperationAttempt[] {
  return runs.map((run) => {
    const fromJson =
      typeof run.runJson?.logical_operation_id === "string"
        ? run.runJson.logical_operation_id
        : null;
    const fromSummary =
      typeof run.summary?.logical_operation_id === "string"
        ? run.summary.logical_operation_id
        : null;
    const start = run.events.find((e) => e.type === "run_start");
    const fromEvent =
      typeof start?.logical_operation_id === "string" ? start.logical_operation_id : null;
    const logical = fromJson || fromSummary || fromEvent || null;
    const complete = run.events.find((e) => e.type === "run_complete");
    const parent =
      typeof run.runJson?.parent_logical_operation_id === "string"
        ? run.runJson.parent_logical_operation_id
        : typeof start?.parent_logical_operation_id === "string"
          ? start.parent_logical_operation_id
          : null;
    const nested = run.runJson?.nested_logical_operation === true || start?.nested === true;
    const postcondition =
      run.summary?.verified_completion === true ||
      run.events.some((e) => e.type === "verified_completion" || e.exact_candidate_proof === true);
    const entrypoint =
      typeof run.runJson?.kind === "string"
        ? run.runJson.kind === "train"
          ? "train"
          : "single"
        : typeof start?.entrypoint === "string"
          ? start.entrypoint
          : null;
    const trainLinked = run.events.some((e) => e.type === "train_loop_linked");
    const childId = run.events
      .filter((e) => e.type === "train_loop_linked")
      .map((e) => (typeof e.logical_operation_id === "string" ? e.logical_operation_id : null))
      .find((v) => v);
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
      child_logical_operation_id: childId ?? (trainLinked ? logical : null),
      evidence_refs: [`run:${run.runId}`],
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
    covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
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
    covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
    live_train_linkage_present: true,
    candidate_sha: input.candidate_sha ?? "a".repeat(40),
    release_identity: input.release_identity ?? "",
  };
}
