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
import { classifyGhError, classifyHarnessFailure } from "./escalation-classify.ts";
import { LOOP_EXECUTION_CONTRACT_SCHEMA, type LoopExecutionResponse } from "./loop-execution-contract.ts";
import { BUILTIN_OUTER_HOST_IDS } from "./outer-hosts/types.ts";
import type {
  RequiredLifecycleClass1333,
  RequiredPublicEntrypoint,
  UniqueOperationTerminal,
} from "./operation-reliability.ts";
import { buildStageDiagnostic, type StageDiagnostic } from "./stage-diagnostic.ts";

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

export interface RequiredMatrixCell {
  operation: string;
  fault_state: MatrixFaultState;
  entrypoint: string;
  host: string;
  layer: MatrixCoverageLayer;
}

export function matrixCellKey(cell: {
  layer: string;
  operation: string;
  fault_state: string;
  entrypoint: string;
  host: string;
}): string {
  return `${cell.layer}|${cell.operation}|${cell.fault_state}|${cell.entrypoint}|${cell.host}`;
}

/**
 * Applicable cells: adapter-contract and installed-CLI bind to direct CLI;
 * host-conformance is every required host × every public entrypoint × fault.
 */
export function requiredApplicableMatrixCells(): RequiredMatrixCell[] {
  const cells: RequiredMatrixCell[] = [];
  const operations = requiredMatrixOperations();

  for (const operation of operations) {
    const entrypoint = isPublicEntrypoint(operation) ? operation : "drive";
    for (const fault of MATRIX_FAULT_STATES) {
      cells.push({
        operation,
        fault_state: fault,
        entrypoint,
        host: "direct_cli",
        layer: "adapter_contract",
      });
      cells.push({
        operation,
        fault_state: fault,
        entrypoint,
        host: "direct_cli",
        layer: "installed_cli",
      });
    }
  }

  for (const host of MATRIX_REQUIRED_HOSTS) {
    for (const entrypoint of MATRIX_PUBLIC_ENTRYPOINTS) {
      for (const fault of MATRIX_FAULT_STATES) {
        cells.push({
          operation: entrypoint,
          fault_state: fault,
          entrypoint,
          host,
          layer: "host_conformance",
        });
      }
    }
  }
  return cells;
}

function coveringModuleForLayer(layer: MatrixCoverageLayer): string {
  if (layer === "adapter_contract") return ADAPTER_MODULE;
  if (layer === "installed_cli") return INSTALLED_CLI_MODULE;
  return HOST_MODULE;
}

function coveringTestSubstring(cell: RequiredMatrixCell): string {
  if (cell.layer === "adapter_contract") return `adapter contract: ${cell.fault_state}`;
  if (cell.layer === "installed_cli") return `installed-cli: ${cell.operation}`;
  return `host conformance: ${cell.host} ${cell.entrypoint}`;
}

function buildInventory(): FaultRecoveryMatrixRow[] {
  const rows: FaultRecoveryMatrixRow[] = [];

  for (const cell of requiredApplicableMatrixCells()) {
    rows.push(
      coveringRow({
        ...cell,
        covering_module: coveringModuleForLayer(cell.layer),
        covering_test_name_substring: coveringTestSubstring(cell),
      }),
    );
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

  const seenCells = new Set(
    rows
      .filter((row) => !row.ship_phase)
      .map((row) => matrixCellKey(row)),
  );
  for (const cell of requiredApplicableMatrixCells()) {
    const key = matrixCellKey(cell);
    if (seenCells.has(key)) continue;
    gaps.push({
      class_id: `${cell.layer}:${cell.host}:${cell.entrypoint}:${cell.fault_state}`,
      reason: `missing covering row or not_applicable for ${cell.layer} ${cell.host} × ${cell.entrypoint} × ${cell.fault_state}`,
    });
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
 * Inventory-declared classes with a covering module on every required layer.
 * This is NOT FRG coverage — release evidence uses
 * {@link coveredLifecycleClassesFromExecutedRows} bound to a candidate SHA.
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

/** Executed matrix-row result bound to a scored candidate and coverage layer. */
export interface ExecutedMatrixRow {
  candidate_sha: string;
  layer: MatrixCoverageLayer;
  lifecycle_class: RequiredLifecycleClass1333;
  operation: string;
  fault_state: MatrixFaultState;
  entrypoint: string;
  host: string;
  passed: boolean;
}

/**
 * Lifecycle classes proved by passing executed rows for `candidateSha` on
 * every required layer. Absent SHA, failed rows, and other-candidate rows
 * do not count. Inventory declarations never satisfy this function.
 */
export function coveredLifecycleClassesFromExecutedRows(
  executed: readonly ExecutedMatrixRow[],
  candidateSha: string,
): RequiredLifecycleClass1333[] {
  const sha = candidateSha.trim();
  if (!sha) return [];
  const layersByClass = new Map<string, Set<string>>();
  for (const row of executed) {
    if (row.candidate_sha !== sha) continue;
    if (!row.passed) continue;
    const set = layersByClass.get(row.lifecycle_class) ?? new Set<string>();
    set.add(row.layer);
    layersByClass.set(row.lifecycle_class, set);
  }
  return MATRIX_LIFECYCLE_CLASSES.filter((cls) => {
    const layers = layersByClass.get(cls);
    return !!layers && MATRIX_COVERAGE_LAYERS.every((layer) => layers.has(layer));
  });
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

export interface AdapterRawResult {
  kind:
    | "exception"
    | "rejection"
    | "nonzero_exit"
    | "signal"
    | "timeout"
    | "malformed"
    | "spawn_error"
    | "auth"
    | "unknown_shape"
    | "typed_request"
    | "already_complete"
    | "illegal_terminal"
    | "other";
  declared_run_terminal: boolean;
  error?: Error;
  exit_code?: number | null;
  signal?: string;
  timed_out?: boolean;
  spawn_error?: boolean;
  stdout?: string;
  stderr?: string;
  mutation_count: number;
}

export interface SupervisorIngressResult {
  stop: { reason?: string } | null;
  cooling?: { reason?: string } | null;
}

/**
 * Inject a fault at the operation-adapter I/O seam. Throws/rejects/returns
 * exit/signal/timeout/malformed output. Never chooses lifecycle treatment.
 */
export function injectOperationAdapterFault(input: {
  fault_state: MatrixFaultState | MatrixTypedRequest;
  mutate?: () => void;
  already_completed?: boolean;
  stop_on_exhaustion?: boolean;
}): AdapterRawResult {
  if (input.already_completed === true) {
    return { kind: "already_complete", declared_run_terminal: false, mutation_count: 0 };
  }
  if (TYPED_REQUEST_SET.has(input.fault_state)) {
    return { kind: "typed_request", declared_run_terminal: false, mutation_count: 0 };
  }
  if (input.stop_on_exhaustion === true) {
    return { kind: "illegal_terminal", declared_run_terminal: true, mutation_count: 0 };
  }

  const fault = input.fault_state as MatrixFaultState;
  let mutationCount = 0;
  const mutate = () => {
    mutationCount += 1;
    input.mutate?.();
  };
  if (
    fault !== "interrupted_or_uncertain_side_effect" &&
    fault !== "process_death_at_side_effect_boundary" &&
    fault !== "strategy_exhaustion"
  ) {
    mutate();
  }

  try {
    switch (fault) {
      case "exception":
        throw new Error("adapter exception");
      case "rejection": {
        let captured: Error | undefined;
        void Promise.reject(new Error("adapter rejection")).catch((err: Error) => {
          captured = err;
        });
        return {
          kind: "rejection",
          declared_run_terminal: false,
          error: captured ?? new Error("adapter rejection"),
          mutation_count: mutationCount,
        };
      }
      case "nonzero_exit":
        return { kind: "nonzero_exit", declared_run_terminal: false, exit_code: 1, mutation_count: mutationCount };
      case "signal":
        return {
          kind: "signal",
          declared_run_terminal: false,
          exit_code: null,
          signal: "SIGTERM",
          mutation_count: mutationCount,
        };
      case "timeout":
        return { kind: "timeout", declared_run_terminal: false, timed_out: true, mutation_count: mutationCount };
      case "malformed_or_contradictory_output":
        return {
          kind: "malformed",
          declared_run_terminal: false,
          stdout: "{not-json",
          mutation_count: mutationCount,
        };
      case "unavailable_harness":
      case "observer_failure":
        return {
          kind: "spawn_error",
          declared_run_terminal: false,
          spawn_error: true,
          mutation_count: mutationCount,
        };
      case "authentication":
        return {
          kind: "auth",
          declared_run_terminal: false,
          stderr: "HTTP 401 authentication required",
          mutation_count: mutationCount,
        };
      case "unseen_provider_error_shape":
        return {
          kind: "unknown_shape",
          declared_run_terminal: false,
          stderr: "XYZ-UNSEEN-PROVIDER-SHAPE 999",
          mutation_count: mutationCount,
        };
      default:
        return { kind: "other", declared_run_terminal: false, mutation_count: mutationCount };
    }
  } catch (err) {
    return {
      kind: "exception",
      declared_run_terminal: false,
      error: err instanceof Error ? err : new Error(String(err)),
      mutation_count: mutationCount,
    };
  }
}

function diagnosticFromRaw(
  raw: AdapterRawResult,
  faultState: MatrixFaultState | MatrixTypedRequest,
): StageDiagnostic {
  if (TYPED_REQUEST_SET.has(faultState)) {
    return buildStageDiagnostic({
      reasonCode: faultState === "capability_request" ? "capability-refusal" : "human-decision-required",
      blockerKind: faultState === "authority_request" ? "human-decision-required" : "needs-human",
      reason: `typed ${faultState}`,
      stage: "adapter-contract",
      ...(faultState === "authority_request" || faultState === "decision_request"
        ? {
            authorityEvidence: [
              {
                category: faultState === "authority_request" ? "authority" : "product-decision",
                finding_key: "deadbeef",
                finding_fingerprint: "0123456789abcdef",
                reviewed_sha: "abc123",
              },
            ],
          }
        : {}),
    });
  }
  if (raw.kind === "auth") {
    const gh = classifyGhError(raw.stderr ?? "");
    return buildStageDiagnostic({
      reasonCode: gh.reason_code,
      blockerKind: "harness-failure",
      reason: raw.stderr ?? "authentication failure",
      stage: "adapter-contract",
    });
  }
  const reasonCode = classifyHarnessFailure({
    timed_out: raw.timed_out === true,
    spawn_error: raw.spawn_error === true,
    code:
      raw.exit_code ??
      (raw.kind === "nonzero_exit" ? 1 : raw.kind === "exception" || raw.kind === "rejection" ? 1 : null),
    stdout: raw.stdout,
    stderr: raw.stderr,
  });
  return buildStageDiagnostic({
    reasonCode,
    blockerKind: "harness-failure",
    reason: raw.error?.message ?? raw.stderr ?? raw.stdout ?? `adapter ${faultState}`,
    stage: "adapter-contract",
  });
}

/** Adapter reports a loop-execution observation. It never writes ledger.stop. */
export function adapterResponseFromFault(input: {
  fault_state: MatrixFaultState | MatrixTypedRequest;
  mutate?: () => void;
  already_completed?: boolean;
  stop_on_exhaustion?: boolean;
  item_id?: string;
  run_id?: string;
}): { raw: AdapterRawResult; response: LoopExecutionResponse } {
  const raw = injectOperationAdapterFault(input);
  const typed = TYPED_REQUEST_SET.has(input.fault_state);
  let outcome: LoopExecutionResponse["outcome"] = "blocked_recoverable";
  if (raw.declared_run_terminal) outcome = "failed";
  else if (typed) outcome = "blocked_needs_human";
  else if (raw.kind === "already_complete") outcome = "ready_to_deploy";
  return {
    raw,
    response: {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: input.item_id ?? "100",
      run_id: input.run_id ?? "run-adapter",
      outcome,
      evidence: { pr_number: null, pipeline_run_id: "adapter-contract" },
      diagnostic: diagnosticFromRaw(raw, input.fault_state),
    },
  };
}

export function observationFromAdapterRaw(
  raw: AdapterRawResult,
  faultState: MatrixFaultState | MatrixTypedRequest,
  supervisor?: SupervisorIngressResult,
): AdapterObservation {
  const typed = TYPED_REQUEST_SET.has(faultState);
  const lifecycle: RequiredLifecycleClass1333 | "typed_request" = typed
    ? "typed_request"
    : FAULT_STATE_LIFECYCLE[faultState as MatrixFaultState];
  const declared = raw.declared_run_terminal;
  const supervisorStop = declared || supervisor?.stop != null;
  const ownerless = declared || (supervisorStop && supervisor?.cooling == null);
  let terminal: UniqueOperationTerminal;
  if (declared || ownerless) terminal = "ownerless_terminal";
  else if (typed) terminal = "typed_request";
  else if (raw.kind === "already_complete") terminal = "verified_success";
  else terminal = expectedTerminalForFault(faultState as MatrixFaultState);
  return {
    fault_state: faultState,
    lifecycle_class: lifecycle,
    declared_run_terminal: declared,
    unique_operation_terminal: terminal,
    false_human: false,
    ownerless_terminal: ownerless,
    supervisor_stop: supervisorStop,
    unauthorized_mutation: false,
    side_effect_replayed: false,
    mutation_count: raw.mutation_count,
  };
}

export function observeAdapterFault(input: {
  fault_state: MatrixFaultState | MatrixTypedRequest;
  mutate?: () => void;
  already_completed?: boolean;
  stop_on_exhaustion?: boolean;
  supervisor?: SupervisorIngressResult;
}): AdapterObservation {
  const raw = injectOperationAdapterFault(input);
  return observationFromAdapterRaw(raw, input.fault_state, input.supervisor);
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
