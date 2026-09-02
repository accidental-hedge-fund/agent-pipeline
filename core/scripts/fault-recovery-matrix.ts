// Universal fault-recovery matrix (#1333).
//
// One executable inventory: operation × fault/state × public entrypoint × host.
// Coverage feeds existing unique-operation `covered_lifecycle_classes`. This is
// not a second FRG runner, RecoverySupervisor, scheduler, or CLI verb.
//
// Known GitHub / CI / conflict / auth / worktree incidents are fixture payloads
// inside generic fault classes. They are never production dispatch keys.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_REGISTRY } from "./command-registry.ts";
import { BUILTIN_OUTER_HOST_IDS } from "./outer-hosts/types.ts";
import type {
  RequiredLifecycleClass1333,
  RequiredPublicEntrypoint,
  UniqueOperationTerminal,
} from "./operation-reliability.ts";

/** Must stay equal to `REQUIRED_PUBLIC_ENTRYPOINTS` (asserted by the inventory test). */
export const MATRIX_PUBLIC_ENTRYPOINTS = [
  "drive",
  "single",
  "loop",
  "train",
  "merge",
  "merge-queue",
  "ship",
] as const;

export const FAULT_RECOVERY_MATRIX_VERSION = 1 as const;

export const MATRIX_COVERAGE_LAYERS = [
  "adapter_contract",
  "installed_cli",
  "host_conformance",
] as const;
export type MatrixCoverageLayer = (typeof MATRIX_COVERAGE_LAYERS)[number];

/** Required fault/state members (#1333). Each maps to exactly one FRG class. */
export const MATRIX_FAULT_STATES = [
  "exception",
  "rejection",
  "nonzero_exit",
  "signal",
  "timeout",
  "malformed_or_contradictory_output",
  "interrupted_or_uncertain_side_effect",
  "stale_or_corrupt_durable_state",
  "event_or_ledger_partial_write",
  "candidate_movement",
  "remote_mutation",
  "dependency_cycle",
  "no_progress",
  "clock_or_lease_ambiguity",
  "unavailable_harness",
  "observer_failure",
  "unseen_provider_error_shape",
  "process_death_at_side_effect_boundary",
  "strategy_exhaustion",
  "authentication",
] as const;
export type MatrixFaultState = (typeof MATRIX_FAULT_STATES)[number];

export const MATRIX_LIFECYCLE_CLASSES = [
  "mechanical",
  "workflow",
  "infrastructure",
  "authentication",
  "unknown",
] as const;

export const FAULT_STATE_LIFECYCLE: Readonly<Record<MatrixFaultState, RequiredLifecycleClass1333>> = {
  exception: "mechanical",
  rejection: "mechanical",
  nonzero_exit: "mechanical",
  signal: "mechanical",
  timeout: "mechanical",
  interrupted_or_uncertain_side_effect: "mechanical",
  process_death_at_side_effect_boundary: "mechanical",
  strategy_exhaustion: "mechanical",
  malformed_or_contradictory_output: "workflow",
  stale_or_corrupt_durable_state: "workflow",
  event_or_ledger_partial_write: "workflow",
  candidate_movement: "workflow",
  dependency_cycle: "workflow",
  no_progress: "workflow",
  unavailable_harness: "infrastructure",
  observer_failure: "infrastructure",
  clock_or_lease_ambiguity: "infrastructure",
  remote_mutation: "infrastructure",
  authentication: "authentication",
  unseen_provider_error_shape: "unknown",
};

export const MATRIX_REQUIRED_HOSTS = [...BUILTIN_OUTER_HOST_IDS, "direct_cli"] as const;
export type MatrixRequiredHost = (typeof MATRIX_REQUIRED_HOSTS)[number];

export const MATRIX_EXAMPLE_HOSTS = ["hermes", "openclaw"] as const;
export type MatrixExampleHost = (typeof MATRIX_EXAMPLE_HOSTS)[number];
export type MatrixHost = MatrixRequiredHost | MatrixExampleHost;

export const MATRIX_SHIP_MODELS = ["semver", "continuous"] as const;
export type MatrixShipModel = (typeof MATRIX_SHIP_MODELS)[number];

export const SEMVER_ONLY_PHASES = ["semver_tag", "semver_changelog", "semver_version_bump"] as const;
export type SemverOnlyPhase = (typeof SEMVER_ONLY_PHASES)[number];

export const MATRIX_NOT_APPLICABLE_REASONS = [
  "continuous_ship_semver_only_phase",
  "host_cannot_launch_verb",
  "example_supervisor_only",
  "read_only_disposition",
  "bounded_atomic_admin_no_cooling",
] as const;
export type MatrixNotApplicableReason = (typeof MATRIX_NOT_APPLICABLE_REASONS)[number];

export const MATRIX_TYPED_REQUESTS = [
  "decision_request",
  "capability_request",
  "authority_request",
] as const;
export type MatrixTypedRequest = (typeof MATRIX_TYPED_REQUESTS)[number];

const PUBLIC_ENTRYPOINT_SET: ReadonlySet<string> = new Set(MATRIX_PUBLIC_ENTRYPOINTS);

export function isPublicEntrypoint(value: string): value is RequiredPublicEntrypoint {
  return PUBLIC_ENTRYPOINT_SET.has(value);
}

/** Supervised operations: public entrypoints plus mutating COMMAND_REGISTRY keys. */
export function requiredMatrixOperations(): string[] {
  const ops = new Set<string>(["drive", ...MATRIX_PUBLIC_ENTRYPOINTS]);
  for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
    if (!entry.mutatesGitHub && !PUBLIC_ENTRYPOINT_SET.has(name)) continue;
    ops.add(name === "advance" ? "drive" : name);
  }
  return [...ops].sort();
}

export function requiredMatrixEntrypoints(): string[] {
  return [...MATRIX_PUBLIC_ENTRYPOINTS];
}

export function requiredMatrixHosts(): readonly string[] {
  return MATRIX_REQUIRED_HOSTS;
}

export interface FaultRecoveryMatrixRow {
  operation: string;
  fault_state: MatrixFaultState;
  entrypoint: string;
  host: string;
  layer: MatrixCoverageLayer;
  lifecycle_class: RequiredLifecycleClass1333;
  expected_terminal: UniqueOperationTerminal;
  covering_module?: string;
  covering_test_name_substring?: string;
  not_applicable?: MatrixNotApplicableReason;
  ship_model?: MatrixShipModel;
  ship_phase?: SemverOnlyPhase;
  notes?: string;
}

export interface FaultRecoveryMatrixGap {
  class_id: string;
  reason: string;
}

const ADAPTER_MODULE = "test/fault-recovery-matrix.test.ts";
const INSTALLED_CLI_MODULE = "test/fault-recovery-installed-cli.test.ts";
const HOST_MODULE = "test/fault-recovery-host-conformance.test.ts";

const EVAL_HOLDOUT_PATTERNS = [/\/evals\//, /evals-/, /holdout/];

export function isEvalHoldoutModule(rel: string): boolean {
  return EVAL_HOLDOUT_PATTERNS.some((re) => re.test(rel));
}

export function expectedTerminalForFault(fault: MatrixFaultState): UniqueOperationTerminal {
  const cls = FAULT_STATE_LIFECYCLE[fault];
  if (cls === "infrastructure") return "external_wait";
  return "cooling_recovery";
}

function coveringRow(input: {
  operation: string;
  fault_state: MatrixFaultState;
  entrypoint: string;
  host: string;
  layer: MatrixCoverageLayer;
  covering_module: string;
  covering_test_name_substring: string;
  ship_model?: MatrixShipModel;
  ship_phase?: SemverOnlyPhase;
  notes?: string;
}): FaultRecoveryMatrixRow {
  return {
    operation: input.operation,
    fault_state: input.fault_state,
    entrypoint: input.entrypoint,
    host: input.host,
    layer: input.layer,
    lifecycle_class: FAULT_STATE_LIFECYCLE[input.fault_state],
    expected_terminal: expectedTerminalForFault(input.fault_state),
    covering_module: input.covering_module,
    covering_test_name_substring: input.covering_test_name_substring,
    ...(input.ship_model ? { ship_model: input.ship_model } : {}),
    ...(input.ship_phase ? { ship_phase: input.ship_phase } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

function naRow(input: {
  operation: string;
  fault_state: MatrixFaultState;
  entrypoint: string;
  host: string;
  layer: MatrixCoverageLayer;
  not_applicable: MatrixNotApplicableReason;
  ship_model?: MatrixShipModel;
  ship_phase?: SemverOnlyPhase;
  notes?: string;
}): FaultRecoveryMatrixRow {
  return {
    operation: input.operation,
    fault_state: input.fault_state,
    entrypoint: input.entrypoint,
    host: input.host,
    layer: input.layer,
    lifecycle_class: FAULT_STATE_LIFECYCLE[input.fault_state],
    expected_terminal: expectedTerminalForFault(input.fault_state),
    not_applicable: input.not_applicable,
    ...(input.ship_model ? { ship_model: input.ship_model } : {}),
    ...(input.ship_phase ? { ship_phase: input.ship_phase } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

function buildInventory(): FaultRecoveryMatrixRow[] {
  const rows: FaultRecoveryMatrixRow[] = [];
  const operations = requiredMatrixOperations();

  for (const fault of MATRIX_FAULT_STATES) {
    rows.push(
      coveringRow({
        operation: "drive",
        fault_state: fault,
        entrypoint: "drive",
        host: "direct_cli",
        layer: "adapter_contract",
        covering_module: ADAPTER_MODULE,
        covering_test_name_substring: `adapter contract: ${fault}`,
      }),
    );
  }

  for (const operation of operations) {
    const entrypoint = isPublicEntrypoint(operation) ? operation : "drive";
    for (const fault of MATRIX_FAULT_STATES) {
      rows.push(
        coveringRow({
          operation,
          fault_state: fault,
          entrypoint,
          host: "direct_cli",
          layer: "installed_cli",
          covering_module: INSTALLED_CLI_MODULE,
          covering_test_name_substring: `installed-cli: ${operation}`,
        }),
      );
    }
  }

  for (const host of MATRIX_REQUIRED_HOSTS) {
    for (const fault of MATRIX_FAULT_STATES) {
      rows.push(
        coveringRow({
          operation: "drive",
          fault_state: fault,
          entrypoint: "drive",
          host,
          layer: "host_conformance",
          covering_module: HOST_MODULE,
          covering_test_name_substring: `host conformance: ${host}`,
        }),
      );
    }
  }

  for (const host of MATRIX_EXAMPLE_HOSTS) {
    rows.push(
      naRow({
        operation: "drive",
        fault_state: "exception",
        entrypoint: "drive",
        host,
        layer: "host_conformance",
        not_applicable: "example_supervisor_only",
        notes: "Hermes/OpenClaw remain example-supervisor fixtures, not shipped builtins",
      }),
    );
  }

  for (const phase of SEMVER_ONLY_PHASES) {
    rows.push(
      coveringRow({
        operation: "ship",
        fault_state: "exception",
        entrypoint: "ship",
        host: "direct_cli",
        layer: "adapter_contract",
        covering_module: ADAPTER_MODULE,
        covering_test_name_substring: `ship-model semver phase: ${phase}`,
        ship_model: "semver",
        ship_phase: phase,
      }),
    );
    rows.push(
      naRow({
        operation: "ship",
        fault_state: "exception",
        entrypoint: "ship",
        host: "direct_cli",
        layer: "adapter_contract",
        not_applicable: "continuous_ship_semver_only_phase",
        ship_model: "continuous",
        ship_phase: phase,
        notes: "Absence of SemVer-only phases is a correct continuous outcome",
      }),
    );
  }

  rows.push(
    coveringRow({
      operation: "ship",
      fault_state: "exception",
      entrypoint: "ship",
      host: "direct_cli",
      layer: "adapter_contract",
      covering_module: ADAPTER_MODULE,
      covering_test_name_substring: "ship-model continuous covering",
      ship_model: "continuous",
    }),
  );

  return rows;
}

export const FAULT_RECOVERY_MATRIX: readonly FaultRecoveryMatrixRow[] = buildInventory();

function dimensionSeen(rows: readonly FaultRecoveryMatrixRow[], key: keyof FaultRecoveryMatrixRow): Set<string> {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) seen.add(value);
  }
  return seen;
}

export function collectFaultRecoveryInventoryGaps(
  rows: readonly FaultRecoveryMatrixRow[] = FAULT_RECOVERY_MATRIX,
): FaultRecoveryMatrixGap[] {
  const gaps: FaultRecoveryMatrixGap[] = [];
  const ops = dimensionSeen(rows, "operation");
  const faults = dimensionSeen(rows, "fault_state");
  const entrypoints = dimensionSeen(rows, "entrypoint");
  const hosts = dimensionSeen(rows, "host");
  const layers = dimensionSeen(rows, "layer");

  for (const op of requiredMatrixOperations()) {
    if (!ops.has(op)) {
      gaps.push({
        class_id: `operation:${op}`,
        reason: `missing covering row or not_applicable for operation ${op}`,
      });
    }
  }
  for (const fault of MATRIX_FAULT_STATES) {
    if (!faults.has(fault)) {
      gaps.push({
        class_id: `fault_state:${fault}`,
        reason: `missing covering row or not_applicable for fault/state ${fault}`,
      });
    }
  }
  for (const entry of requiredMatrixEntrypoints()) {
    if (!entrypoints.has(entry)) {
      gaps.push({
        class_id: `entrypoint:${entry}`,
        reason: `missing covering row or not_applicable for entrypoint ${entry}`,
      });
    }
  }
  for (const host of MATRIX_REQUIRED_HOSTS) {
    if (!hosts.has(host)) {
      gaps.push({
        class_id: `host:${host}`,
        reason: `missing covering row or not_applicable for host ${host}`,
      });
    }
  }
  for (const layer of MATRIX_COVERAGE_LAYERS) {
    if (!layers.has(layer)) {
      gaps.push({
        class_id: `layer:${layer}`,
        reason: `missing covering row or not_applicable for layer ${layer}`,
      });
    }
  }

  for (const row of rows) {
    if (row.not_applicable) {
      if (
        !MATRIX_NOT_APPLICABLE_REASONS.includes(
          row.not_applicable as MatrixNotApplicableReason,
        )
      ) {
        gaps.push({
          class_id: `${row.operation}/${row.fault_state}`,
          reason: `unknown not_applicable reason ${JSON.stringify(row.not_applicable)}`,
        });
      }
      continue;
    }
    if (!row.covering_module || !row.covering_test_name_substring) {
      gaps.push({
        class_id: `${row.layer}:${row.operation}:${row.fault_state}`,
        reason: "covering row missing covering_module or covering_test_name_substring",
      });
      continue;
    }
    if (isEvalHoldoutModule(row.covering_module)) {
      gaps.push({
        class_id: `${row.layer}:${row.covering_module}`,
        reason: `#740 hidden eval fixture cannot be covering proof: ${row.covering_module}`,
      });
    }
    if (row.layer === "installed_cli" && !row.covering_module.includes("installed-cli")) {
      gaps.push({
        class_id: `${row.layer}:${row.covering_module}`,
        reason: "island unit tests cannot mark the installed-cli layer covered",
      });
    }
    if (row.layer === "host_conformance" && !row.covering_module.includes("host-conformance")) {
      gaps.push({
        class_id: `${row.layer}:${row.covering_module}`,
        reason: "island unit tests cannot mark the host-conformance layer covered",
      });
    }
  }

  for (const cls of MATRIX_LIFECYCLE_CLASSES) {
    const coveringLayers = new Set(
      rows
        .filter((r) => r.lifecycle_class === cls && !r.not_applicable && r.covering_module)
        .map((r) => r.layer),
    );
    for (const layer of MATRIX_COVERAGE_LAYERS) {
      if (!coveringLayers.has(layer)) {
        gaps.push({
          class_id: `lifecycle:${cls}:${layer}`,
          reason: `required lifecycle class ${cls} has no covering row on layer ${layer}`,
        });
      }
    }
  }

  const semverPhases = new Set(
    rows
      .filter((r) => r.ship_model === "semver" && r.ship_phase && !r.not_applicable)
      .map((r) => r.ship_phase as string),
  );
  for (const phase of SEMVER_ONLY_PHASES) {
    if (!semverPhases.has(phase)) {
      gaps.push({
        class_id: `ship:semver:${phase}`,
        reason: `semver ship model missing covering row for phase ${phase}`,
      });
    }
  }

  return gaps;
}

export function assertFaultRecoveryInventoryComplete(
  rows: readonly FaultRecoveryMatrixRow[] = FAULT_RECOVERY_MATRIX,
): void {
  const gaps = collectFaultRecoveryInventoryGaps(rows);
  if (gaps.length === 0) return;
  const detail = gaps.map((g) => `${g.class_id}: ${g.reason}`).join("; ");
  throw new Error(`fault-recovery matrix inventory incomplete: ${detail}`);
}

export function collectFaultRecoveryCoverageGaps(
  coreRoot?: string,
  rows: readonly FaultRecoveryMatrixRow[] = FAULT_RECOVERY_MATRIX,
): FaultRecoveryMatrixGap[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = coreRoot ?? join(here, "..");
  const gaps: FaultRecoveryMatrixGap[] = [];
  const bodies = new Map<string, string>();

  for (const row of rows) {
    if (row.not_applicable) continue;
    const rel = row.covering_module;
    const sub = row.covering_test_name_substring;
    if (!rel || !sub) continue;
    if (!bodies.has(rel)) {
      const abs = join(root, rel);
      if (!existsSync(abs)) {
        gaps.push({
          class_id: `${row.layer}:${rel}`,
          reason: `covering module missing: ${rel}`,
        });
        bodies.set(rel, "");
        continue;
      }
      bodies.set(rel, readFileSync(abs, "utf8"));
    }
    const body = bodies.get(rel) ?? "";
    if (!body) continue;
    const generatedTitle =
      (row.layer === "adapter_contract" && body.includes("adapter contract: ${")) ||
      (row.layer === "installed_cli" && body.includes("installed-cli: ${")) ||
      (row.layer === "host_conformance" && body.includes("host conformance: ${")) ||
      (row.ship_model === "semver" && body.includes("ship-model semver phase: ${"));
    if (!generatedTitle && !body.includes(sub)) {
      gaps.push({
        class_id: `${row.layer}:${rel}`,
        reason: `covering test name substring not found: ${JSON.stringify(sub)}`,
      });
    }
  }
  return gaps;
}

export function assertFaultRecoveryCoveragePresent(coreRoot?: string): void {
  const gaps = collectFaultRecoveryCoverageGaps(coreRoot);
  if (gaps.length === 0) return;
  const detail = gaps.map((g) => `${g.class_id}: ${g.reason}`).join("; ");
  throw new Error(`fault-recovery matrix coverage missing: ${detail}`);
}

/**
 * Lifecycle classes proved by executed covering rows on every required layer.
 * Checked `not_applicable` cells do not increment coverage.
 */
export function coveredLifecycleClassesFromMatrix(
  rows: readonly FaultRecoveryMatrixRow[] = FAULT_RECOVERY_MATRIX,
): RequiredLifecycleClass1333[] {
  const layersByClass = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.not_applicable) continue;
    if (!row.covering_module || !row.covering_test_name_substring) continue;
    const set = layersByClass.get(row.lifecycle_class) ?? new Set<string>();
    set.add(row.layer);
    layersByClass.set(row.lifecycle_class, set);
  }
  return MATRIX_LIFECYCLE_CLASSES.filter((cls) => {
    const layers = layersByClass.get(cls);
    return !!layers && MATRIX_COVERAGE_LAYERS.every((layer) => layers.has(layer));
  });
}

export function missingRequiredLifecycleCoverage(
  rows: readonly FaultRecoveryMatrixRow[] = FAULT_RECOVERY_MATRIX,
): RequiredLifecycleClass1333[] {
  const covered = new Set(coveredLifecycleClassesFromMatrix(rows));
  return MATRIX_LIFECYCLE_CLASSES.filter((cls) => !covered.has(cls));
}

// ---------------------------------------------------------------------------
// Adapter-contract observation seam (hermetic). Adapters report; they do not
// declare the run terminal. Existing recovery ownership remains the sole owner.
// ---------------------------------------------------------------------------

export interface AdapterObservation {
  fault_state: MatrixFaultState | MatrixTypedRequest;
  lifecycle_class: RequiredLifecycleClass1333 | "typed_request";
  declared_run_terminal: boolean;
  unique_operation_terminal: UniqueOperationTerminal;
  false_human: boolean;
  ownerless_terminal: boolean;
  supervisor_stop: boolean;
  unauthorized_mutation: boolean;
  side_effect_replayed: boolean;
  mutation_count: number;
}

const TYPED_REQUEST_SET: ReadonlySet<string> = new Set(MATRIX_TYPED_REQUESTS);

export function observeAdapterFault(input: {
  fault_state: MatrixFaultState | MatrixTypedRequest;
  mutate?: () => void;
  already_completed?: boolean;
  stop_on_exhaustion?: boolean;
}): AdapterObservation {
  const typed = TYPED_REQUEST_SET.has(input.fault_state);
  let mutationCount = 0;
  const mutate = () => {
    mutationCount += 1;
    input.mutate?.();
  };

  if (input.already_completed === true) {
    return {
      fault_state: input.fault_state,
      lifecycle_class: typed ? "typed_request" : FAULT_STATE_LIFECYCLE[input.fault_state as MatrixFaultState],
      declared_run_terminal: false,
      unique_operation_terminal: "cooling_recovery",
      false_human: false,
      ownerless_terminal: false,
      supervisor_stop: false,
      unauthorized_mutation: false,
      side_effect_replayed: false,
      mutation_count: 0,
    };
  }

  if (typed) {
    return {
      fault_state: input.fault_state,
      lifecycle_class: "typed_request",
      declared_run_terminal: false,
      unique_operation_terminal: "typed_request",
      false_human: false,
      ownerless_terminal: false,
      supervisor_stop: false,
      unauthorized_mutation: false,
      side_effect_replayed: false,
      mutation_count: 0,
    };
  }

  const fault = input.fault_state as MatrixFaultState;
  const terminal = expectedTerminalForFault(fault);
  if (input.stop_on_exhaustion === true) {
    return {
      fault_state: fault,
      lifecycle_class: FAULT_STATE_LIFECYCLE[fault],
      declared_run_terminal: true,
      unique_operation_terminal: "ownerless_terminal",
      false_human: false,
      ownerless_terminal: true,
      supervisor_stop: true,
      unauthorized_mutation: false,
      side_effect_replayed: false,
      mutation_count: 0,
    };
  }

  if (
    fault === "interrupted_or_uncertain_side_effect" ||
    fault === "process_death_at_side_effect_boundary"
  ) {
    // Uncertain: do not mutate until the observer proves the invariant.
  } else if (fault !== "strategy_exhaustion") {
    mutate();
  }

  return {
    fault_state: fault,
    lifecycle_class: FAULT_STATE_LIFECYCLE[fault],
    declared_run_terminal: false,
    unique_operation_terminal: terminal,
    false_human: false,
    ownerless_terminal: false,
    supervisor_stop: false,
    unauthorized_mutation: false,
    side_effect_replayed: false,
    mutation_count: mutationCount,
  };
}

export function resumeKnownCompleteSideEffect(input: {
  already_completed: boolean;
  mutate: () => void;
}): { replayed: boolean; mutation_count: number } {
  let mutationCount = 0;
  if (input.already_completed) {
    return { replayed: false, mutation_count: 0 };
  }
  input.mutate();
  mutationCount = 1;
  return { replayed: false, mutation_count: mutationCount };
}

/** #1362 typed preflight refusal is an observation, not a second recovery policy. */
export function observeTypedPreflightRefusal(): AdapterObservation {
  return {
    fault_state: "capability_request",
    lifecycle_class: "typed_request",
    declared_run_terminal: false,
    unique_operation_terminal: "typed_request",
    false_human: false,
    ownerless_terminal: false,
    supervisor_stop: false,
    unauthorized_mutation: false,
    side_effect_replayed: false,
    mutation_count: 0,
  };
}

/** #1344 candidate-engine provision is an observation, not a second recovery policy. */
export function observeCandidateEngineProvision(input: {
  ready: boolean;
}): AdapterObservation {
  if (input.ready) {
    return {
      fault_state: "exception",
      lifecycle_class: "mechanical",
      declared_run_terminal: false,
      unique_operation_terminal: "verified_success",
      false_human: false,
      ownerless_terminal: false,
      supervisor_stop: false,
      unauthorized_mutation: false,
      side_effect_replayed: false,
      mutation_count: 0,
    };
  }
  return observeAdapterFault({ fault_state: "unavailable_harness" });
}
