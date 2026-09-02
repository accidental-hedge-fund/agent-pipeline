// Universal fault-recovery matrix (#1333) — inventory guard + adapter-contract layer.
// Zero real network, git, or subprocess.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  FAULT_RECOVERY_MATRIX,
  FAULT_STATE_LIFECYCLE,
  MATRIX_COVERAGE_LAYERS,
  MATRIX_FAULT_STATES,
  MATRIX_LIFECYCLE_CLASSES,
  MATRIX_NOT_APPLICABLE_REASONS,
  MATRIX_PUBLIC_ENTRYPOINTS,
  SEMVER_ONLY_PHASES,
  adapterResponseFromFault,
  assertFaultRecoveryCoveragePresent,
  assertFaultRecoveryInventoryComplete,
  collectFaultRecoveryInventoryGaps,
  bindExecutedMatrixRowsForCandidate,
  coveredLifecycleClassesFromExecutedRows,
  coveredLifecycleClassesFromMatrix,
  injectOperationAdapterFault,
  isEvalHoldoutModule,
  missingRequiredLifecycleCoverage,
  observeAdapterFault,
  observeCandidateEngineProvision,
  observeTypedPreflightRefusal,
  requiredMatrixOperations,
  resumeKnownCompleteSideEffect,
  type ExecutedMatrixRow,
  type FaultRecoveryMatrixRow,
} from "../scripts/fault-recovery-matrix.ts";
import { driveSupervisor, type SupervisorDeps } from "../scripts/loop/supervisor.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import { initRun, type LoopStoreDeps } from "../scripts/loop/store.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopLedger,
} from "../scripts/loop/types.ts";
import {
  REQUIRED_LIFECYCLE_CLASSES_1333,
  REQUIRED_PUBLIC_ENTRYPOINTS,
  aggregateUniqueOperationReliability,
  passingUniqueOperationAttempts,
  passingUniqueOperationManifest,
} from "../scripts/operation-reliability.ts";
import {
  computeFrgEvidence,
  FRG_PACK_MANIFEST,
  FRG_UNIT_TEST_ATTESTATION_KEY,
  frgRequiredCompositionOverrides,
  frgRequiredObservationOverrides,
  isReleaseEligibleFrgPass,
  validateReleaseEligibleFrgEvidence,
} from "../scripts/factory-reliability-gate.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(__dirname, "..");
const EXECUTED_SHA = "b".repeat(40);

function executedRowsForSha(
  sha: string,
  classes: readonly string[] = MATRIX_LIFECYCLE_CLASSES,
  passed = true,
): ExecutedMatrixRow[] {
  const rows: ExecutedMatrixRow[] = [];
  for (const cls of classes) {
    for (const layer of MATRIX_COVERAGE_LAYERS) {
      const cell = FAULT_RECOVERY_MATRIX.find(
        (r) => !r.not_applicable && r.lifecycle_class === cls && r.layer === layer,
      );
      if (!cell) continue;
      rows.push({
        candidate_sha: sha,
        layer: cell.layer,
        lifecycle_class: cell.lifecycle_class,
        operation: cell.operation,
        fault_state: cell.fault_state,
        entrypoint: cell.entrypoint,
        host: cell.host,
        observed_terminal: cell.expected_terminal,
        passed,
      });
    }
  }
  return rows;
}

function inMemoryLoopStore(): LoopStoreDeps {
  const files = new Map<string, string>();
  let clock = Date.parse("2026-07-23T00:00:00.000Z");
  let uuid = 0;
  return {
    async fsExists(p) {
      return files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`));
    },
    async readTextFile(p) {
      return files.get(p) ?? null;
    },
    async writeFileAtomic(p, content) {
      files.set(p, content);
    },
    async createFileExclusive(p, content) {
      if (files.has(p)) return false;
      files.set(p, content);
      return true;
    },
    async removeFile(p) {
      files.delete(p);
    },
    async removeFileIfMatches(p, expected) {
      if (files.get(p) !== expected) return false;
      files.delete(p);
      return true;
    },
    async appendLine(p, line) {
      files.set(p, `${files.get(p) ?? ""}${line}\n`);
    },
    async mkdirp() {},
    async renameDirExclusive(from, to) {
      const prefix = `${from}/`;
      if ([...files.keys()].some((k) => k === to || k.startsWith(`${to}/`))) return false;
      for (const k of [...files.keys()]) {
        if (k.startsWith(prefix)) {
          files.set(`${to}/${k.slice(prefix.length)}`, files.get(k)!);
          files.delete(k);
        }
      }
      return true;
    },
    async listDir(p) {
      const prefix = `${p}/`;
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]);
    },
    async isPidAlive() {
      return false;
    },
    hostname: () => "host-a",
    pid: () => 111,
    now: () => new Date((clock += 1000)),
    uuid: () => `uuid-${uuid++}`,
    env: { AGENT_PIPELINE_STATE_HOME: `/state-frg-adapter-${uuid}` },
  };
}

async function consumeAtSupervisor(fault: Parameters<typeof adapterResponseFromFault>[0]["fault_state"]) {
  const { raw, response } = adapterResponseFromFault({ fault_state: fault, item_id: "100", run_id: "run-1" });
  const store = inMemoryLoopStore();
  const contract: LoopContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "run-1",
    engine: "claude",
    repo: { name: "acme/widgets", base_branch: "main" },
    selector: { type: "milestone", value: "v2" },
    objective: "adapter contract",
    worktree_policy: "default",
    done_definition: "pipeline:ready-to-deploy",
    authority_grants: ["push_pr", "merge", "release", "deploy"],
    recovery_budgets: { default: 3 },
    recovery_policy: Object.fromEntries(
      Object.entries(DEFAULT_RECOVERY_POLICY).map(([k, v]) => [
        k,
        { ...v, backoff: { initial_seconds: 0, multiplier: 1, max_seconds: 0 } },
      ]),
    ) as typeof DEFAULT_RECOVERY_POLICY,
    consecutive_blocked_limit: 3,
    verification: null,
    report_format: "markdown",
    ordering: "dependency_sequential",
    max_active_items: 1,
    concurrency_model: "exclusive_lock_single_engine",
    items: [{ id: "100", depends_on: [] }],
    canonical_hash: "deadbeef",
  };
  const ledger: LoopLedger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-1",
    items: { "100": { id: "100", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } } },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
  await initRun(store, contract, ledger);
  const dispatchItem: SupervisorDeps["dispatchItem"] = async () => response;
  const result = await driveSupervisor(
    {
      store,
      observe: {
        async getIssueStateAndLabels() {
          return { state: "open", labels: ["pipeline:ready"] };
        },
        async findPrForIssue() {
          return null;
        },
        async getPrDetail() {
          return null;
        },
        async getPrChecks() {
          return [];
        },
        async getLocalHead() {
          return null;
        },
        async baseBranchContainsSha() {
          return null;
        },
        async getLabelEvents() {
          return [];
        },
        async getExternalDependencyIssueState() {
          return null;
        },
        now: () => new Date("2026-07-23T00:00:00.000Z"),
      },
      dispatchItem,
      executeRecovery: async () => ({ succeeded: false, evidence: "injected adapter fault", error: "injected" }),
      probeLiveAdvance: () => ({ live: false as const }),
      acquireItemAdvanceLock: async () => ({ release() {} }),
    },
    { runId: "run-1", engine: "claude", maxCycles: 20 },
  );
  return { raw, response, result };
}

test("matrix public entrypoints match REQUIRED_PUBLIC_ENTRYPOINTS", () => {
  assert.deepEqual([...MATRIX_PUBLIC_ENTRYPOINTS], [...REQUIRED_PUBLIC_ENTRYPOINTS]);
});

test("matrix lifecycle classes match REQUIRED_LIFECYCLE_CLASSES_1333", () => {
  assert.deepEqual([...MATRIX_LIFECYCLE_CLASSES], [...REQUIRED_LIFECYCLE_CLASSES_1333]);
});

test("fault-recovery matrix inventory is complete (#1333)", () => {
  assertFaultRecoveryInventoryComplete();
  assertFaultRecoveryCoveragePresent(CORE_ROOT);
  assert.deepEqual(collectFaultRecoveryInventoryGaps(), []);
});

test("required fault/state class without covering row fails the inventory guard", () => {
  const incomplete: FaultRecoveryMatrixRow[] = FAULT_RECOVERY_MATRIX.filter(
    (row) => row.fault_state !== "unseen_provider_error_shape",
  );
  const gaps = collectFaultRecoveryInventoryGaps(incomplete);
  assert.ok(
    gaps.some((g) => g.class_id.includes("unseen_provider_error_shape")),
    `expected missing unseen_provider_error_shape, got ${JSON.stringify(gaps)}`,
  );
});

test("new required dimension value without a row fails the inventory guard", () => {
  const withoutTrain = FAULT_RECOVERY_MATRIX.filter((row) => row.operation !== "train");
  const gaps = collectFaultRecoveryInventoryGaps(withoutTrain);
  assert.ok(
    gaps.some((g) => g.class_id === "operation:train"),
    `expected missing operation:train, got ${JSON.stringify(gaps)}`,
  );
});

test("checked not_applicable cells do not increment covered or missing lifecycle classes", () => {
  const onlyNa: FaultRecoveryMatrixRow[] = FAULT_RECOVERY_MATRIX.filter((row) => row.not_applicable);
  assert.ok(onlyNa.length > 0);
  assert.ok(onlyNa.every((row) => MATRIX_NOT_APPLICABLE_REASONS.includes(row.not_applicable!)));
  assert.deepEqual(coveredLifecycleClassesFromMatrix(onlyNa), []);
  assert.deepEqual(missingRequiredLifecycleCoverage(onlyNa), [...MATRIX_LIFECYCLE_CLASSES]);
});

test("continuous SemVer-only phases are checked not_applicable", () => {
  for (const phase of SEMVER_ONLY_PHASES) {
    const row = FAULT_RECOVERY_MATRIX.find(
      (r) => r.ship_model === "continuous" && r.ship_phase === phase,
    );
    assert.ok(row, `missing continuous NA row for ${phase}`);
    assert.equal(row.not_applicable, "continuous_ship_semver_only_phase");
  }
});

test("semver ship model requires phase rows", () => {
  const withoutSemver = FAULT_RECOVERY_MATRIX.filter((row) => row.ship_model !== "semver");
  const gaps = collectFaultRecoveryInventoryGaps(withoutSemver);
  assert.ok(gaps.some((g) => g.class_id.startsWith("ship:semver:")));
});

test("eval holdout covering module fails the inventory guard", () => {
  assert.equal(isEvalHoldoutModule("scripts/evals/fixture.ts"), true);
  const withHoldout: FaultRecoveryMatrixRow[] = [
    ...FAULT_RECOVERY_MATRIX,
    {
      operation: "drive",
      fault_state: "exception",
      entrypoint: "drive",
      host: "direct_cli",
      layer: "adapter_contract",
      lifecycle_class: "mechanical",
      expected_terminal: "cooling_recovery",
      covering_module: "scripts/evals/holdout-restart.ts",
      covering_test_name_substring: "hidden eval",
    },
  ];
  const gaps = collectFaultRecoveryInventoryGaps(withHoldout);
  assert.ok(gaps.some((g) => /#740 hidden eval/.test(g.reason)));
});

test("island unit test cannot mark the installed-cli layer covered", () => {
  const island: FaultRecoveryMatrixRow[] = [
    {
      operation: "drive",
      fault_state: "exception",
      entrypoint: "drive",
      host: "direct_cli",
      layer: "installed_cli",
      lifecycle_class: "mechanical",
      expected_terminal: "cooling_recovery",
      covering_module: "test/fault-recovery-matrix.test.ts",
      covering_test_name_substring: "adapter contract: exception",
    },
  ];
  const gaps = collectFaultRecoveryInventoryGaps(island);
  assert.ok(gaps.some((g) => /island unit tests cannot mark the installed-cli/.test(g.reason)));
});

test("helper stamp without matrix rows fails coverage", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: passingUniqueOperationAttempts().map((a) => ({
      ...a,
      covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
    })),
    manifest: {
      ...passingUniqueOperationManifest({ release_identity: "1.30.0" }),
      covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
    },
    matrix_covered_lifecycle_classes: [],
  });
  assert.ok(report.integrity.missing_required_coverage > 0);
  assert.equal(report.exclusions.length, 0);
});

test("passing helpers do not hardcode all five lifecycle classes", () => {
  const src = readFileSync(join(CORE_ROOT, "scripts/operation-reliability.ts"), "utf8");
  assert.doesNotMatch(
    src,
    /covered_lifecycle_classes:\s*\[\s*\.\.\.REQUIRED_LIFECYCLE_CLASSES_1333\s*\]/,
  );
});

test("matrix row covers only the classes it proved", () => {
  const mechanicalOnly = FAULT_RECOVERY_MATRIX.filter(
    (row) =>
      !row.not_applicable &&
      row.covering_module &&
      FAULT_STATE_LIFECYCLE[row.fault_state] === "mechanical",
  );
  const covered = coveredLifecycleClassesFromMatrix(mechanicalOnly);
  assert.deepEqual(covered, ["mechanical"]);
});

test("stamped helper coverage fails FRG promotion", () => {
  const evidence = computeFrgEvidence({
    version: "1.30.0",
    run_id: "frg-stamp",
    loop_run_id: "loop-stamp",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    unique_operations: passingUniqueOperationAttempts().map((a) => ({
      ...a,
      covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
    })),
    unique_operation_manifest: {
      ...passingUniqueOperationManifest({ release_identity: "1.30.0" }),
      covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
    },
    matrix_covered_lifecycle_classes: [],
  });
  assert.equal(evidence.pass, false);
  assert.ok(evidence.operation_reliability!.integrity.missing_required_coverage > 0);
  assert.equal(isReleaseEligibleFrgPass(evidence), false);
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(JSON.parse(JSON.stringify(evidence)), "1.30.0", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /missing required coverage/,
  );
});

test("executed matrix rows satisfy #1333 coverage", () => {
  const covered = coveredLifecycleClassesFromExecutedRows(executedRowsForSha(EXECUTED_SHA), EXECUTED_SHA);
  assert.deepEqual(covered, [...MATRIX_LIFECYCLE_CLASSES]);
});

test("static inventory is not executed coverage for a scored candidate", () => {
  assert.deepEqual(coveredLifecycleClassesFromExecutedRows([], EXECUTED_SHA), []);
  assert.deepEqual(
    coveredLifecycleClassesFromExecutedRows(executedRowsForSha("c".repeat(40)), EXECUTED_SHA),
    [],
  );
  const report = aggregateUniqueOperationReliability({
    attempts: passingUniqueOperationAttempts(),
    manifest: passingUniqueOperationManifest({ candidate_sha: EXECUTED_SHA, release_identity: "1.30.0" }),
    candidate_sha: EXECUTED_SHA,
  });
  assert.ok(report.integrity.missing_required_coverage > 0);
});

test("failed executed rows do not cover a lifecycle class", () => {
  assert.deepEqual(
    coveredLifecycleClassesFromExecutedRows(executedRowsForSha(EXECUTED_SHA, ["mechanical"], false), EXECUTED_SHA),
    [],
  );
});

function fabricatedClassLayerRows(sha: string): ExecutedMatrixRow[] {
  const fabricated: ExecutedMatrixRow[] = [];
  for (const cls of MATRIX_LIFECYCLE_CLASSES) {
    for (const layer of MATRIX_COVERAGE_LAYERS) {
      fabricated.push({
        candidate_sha: sha,
        layer,
        lifecycle_class: cls,
        operation: "drive",
        fault_state: "exception",
        entrypoint: "drive",
        host: "direct_cli",
        observed_terminal: "cooling_recovery",
        passed: true,
      });
    }
  }
  return fabricated;
}

test("fabricated class/layer executed rows do not satisfy #1333 coverage", () => {
  const fabricated = fabricatedClassLayerRows(EXECUTED_SHA);
  assert.deepEqual(coveredLifecycleClassesFromExecutedRows(fabricated, EXECUTED_SHA), ["mechanical"]);
  assert.equal(bindExecutedMatrixRowsForCandidate(fabricated, EXECUTED_SHA).length, MATRIX_COVERAGE_LAYERS.length);
});

test("fabricated executed rows fail FRG promotion as missing required coverage", () => {
  const evidence = computeFrgEvidence({
    version: "1.30.0",
    run_id: "frg-fabricated-rows",
    loop_run_id: "loop-fabricated",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    unique_operations: passingUniqueOperationAttempts().map((a) => ({
      ...a,
      candidate_sha: EXECUTED_SHA,
    })),
    unique_operation_manifest: passingUniqueOperationManifest({
      candidate_sha: EXECUTED_SHA,
      release_identity: "1.30.0",
    }),
    executed_matrix_rows: fabricatedClassLayerRows(EXECUTED_SHA),
  });
  assert.equal(evidence.pass, false);
  assert.ok(evidence.operation_reliability!.integrity.missing_required_coverage > 0);
  assert.equal(evidence.operation_reliability!.exclusions.length, 0);
});

test("class/layer-only executed records are not matrix cells", () => {
  const stamped = MATRIX_LIFECYCLE_CLASSES.flatMap((cls) =>
    MATRIX_COVERAGE_LAYERS.map((layer) => ({
      candidate_sha: EXECUTED_SHA,
      layer,
      lifecycle_class: cls,
      passed: true,
    })),
  ) as ExecutedMatrixRow[];
  assert.deepEqual(coveredLifecycleClassesFromExecutedRows(stamped, EXECUTED_SHA), []);
});

test("executed row with mismatched expected terminal does not cover", () => {
  const cell = FAULT_RECOVERY_MATRIX.find(
    (r) => !r.not_applicable && r.lifecycle_class === "mechanical" && r.layer === "adapter_contract",
  );
  assert.ok(cell);
  const rows: ExecutedMatrixRow[] = MATRIX_COVERAGE_LAYERS.map((layer) => {
    const layerCell = FAULT_RECOVERY_MATRIX.find(
      (r) => !r.not_applicable && r.lifecycle_class === "mechanical" && r.layer === layer,
    )!;
    return {
      candidate_sha: EXECUTED_SHA,
      layer: layerCell.layer,
      lifecycle_class: layerCell.lifecycle_class,
      operation: layerCell.operation,
      fault_state: layerCell.fault_state,
      entrypoint: layerCell.entrypoint,
      host: layerCell.host,
      observed_terminal: "false_human_projection",
      passed: true,
    };
  });
  assert.deepEqual(coveredLifecycleClassesFromExecutedRows(rows, EXECUTED_SHA), []);
});

test("not_applicable inventory cells do not bind as executed coverage", () => {
  const na = FAULT_RECOVERY_MATRIX.find((r) => r.not_applicable);
  assert.ok(na);
  const rows: ExecutedMatrixRow[] = [
    {
      candidate_sha: EXECUTED_SHA,
      layer: na.layer,
      lifecycle_class: na.lifecycle_class,
      operation: na.operation,
      fault_state: na.fault_state,
      entrypoint: na.entrypoint,
      host: na.host,
      observed_terminal: na.expected_terminal,
      passed: true,
    },
  ];
  assert.deepEqual(bindExecutedMatrixRowsForCandidate(rows, EXECUTED_SHA), []);
});

test("host × public entrypoint × fault host_conformance cells are inventoried", () => {
  const row = FAULT_RECOVERY_MATRIX.find(
    (r) =>
      r.host === "codex" &&
      r.entrypoint === "single" &&
      r.fault_state === "timeout" &&
      r.layer === "host_conformance",
  );
  assert.ok(row, "expected codex × single × timeout × host_conformance covering row");
});

test("missing host × entrypoint cell fails the inventory guard", () => {
  const without = FAULT_RECOVERY_MATRIX.filter(
    (r) => !(r.host === "codex" && r.entrypoint === "single" && r.layer === "host_conformance"),
  );
  const gaps = collectFaultRecoveryInventoryGaps(without);
  assert.ok(
    gaps.some((g) => g.class_id.includes("codex") && g.class_id.includes("single")),
    `expected missing codex × single cell, got ${JSON.stringify(gaps.slice(0, 5))}`,
  );
});

for (const layer of MATRIX_COVERAGE_LAYERS) {
  test(`matrix inventory includes layer ${layer}`, () => {
    assert.ok(FAULT_RECOVERY_MATRIX.some((row) => row.layer === layer && !row.not_applicable));
  });
}

for (const fault of MATRIX_FAULT_STATES) {
  test(`adapter contract: ${fault}`, async () => {
    const raw = injectOperationAdapterFault({ fault_state: fault });
    assert.equal(raw.declared_run_terminal, false, `${fault} adapter declared terminal`);
    const { response, result } = await consumeAtSupervisor(fault);
    assert.notEqual(response.outcome, undefined);
    assert.equal(result.stop, null, `${fault} RecoverySupervisor STOP`);
    const obs = observeAdapterFault({
      fault_state: fault,
      supervisor: { stop: result.stop, cooling: result.cooling ?? null },
    });
    assert.equal(obs.declared_run_terminal, false);
    assert.equal(obs.false_human, false);
    assert.equal(obs.ownerless_terminal, false);
    assert.equal(obs.supervisor_stop, false);
    assert.equal(obs.lifecycle_class, FAULT_STATE_LIFECYCLE[fault]);
    if (FAULT_STATE_LIFECYCLE[fault] === "infrastructure") {
      assert.equal(obs.unique_operation_terminal, "external_wait");
    } else {
      assert.equal(obs.unique_operation_terminal, "cooling_recovery");
    }
  });
}

test("STOP-on-exhaustion stub fails mechanical adapter rows", () => {
  const obs = observeAdapterFault({
    fault_state: "strategy_exhaustion",
    stop_on_exhaustion: true,
  });
  assert.equal(obs.supervisor_stop, true);
  assert.equal(obs.ownerless_terminal, true);
  assert.notEqual(obs.unique_operation_terminal, "cooling_recovery");
});

test("adapter contract: decision_request stops before unauthorized action", () => {
  let mutated = 0;
  const obs = observeAdapterFault({
    fault_state: "decision_request",
    mutate: () => {
      mutated += 1;
    },
  });
  assert.equal(obs.unique_operation_terminal, "typed_request");
  assert.equal(obs.unauthorized_mutation, false);
  assert.equal(obs.false_human, false);
  assert.equal(mutated, 0);
});

test("adapter contract: capability_request stops before unauthorized action", () => {
  const obs = observeAdapterFault({ fault_state: "capability_request" });
  assert.equal(obs.unique_operation_terminal, "typed_request");
  assert.equal(obs.unauthorized_mutation, false);
});

test("adapter contract: authority_request stops before unauthorized action", () => {
  const obs = observeAdapterFault({ fault_state: "authority_request" });
  assert.equal(obs.unique_operation_terminal, "typed_request");
  assert.equal(obs.mutation_count, 0);
});

test("fresh-process resume does not replay a known-complete side effect", () => {
  let mutations = 0;
  const first = resumeKnownCompleteSideEffect({
    already_completed: false,
    mutate: () => {
      mutations += 1;
    },
  });
  assert.equal(first.mutation_count, 1);
  const resume = resumeKnownCompleteSideEffect({
    already_completed: true,
    mutate: () => {
      mutations += 1;
    },
  });
  assert.equal(resume.replayed, false);
  assert.equal(resume.mutation_count, 0);
  assert.equal(mutations, 1);
});

test("#1362 typed preflight refusal is an observation not a second recovery policy", () => {
  const obs = observeTypedPreflightRefusal();
  assert.equal(obs.unique_operation_terminal, "typed_request");
  assert.equal(obs.declared_run_terminal, false);
  assert.equal(obs.supervisor_stop, false);
});

test("#1344 candidate-engine provision is an observation not a second recovery policy", () => {
  const ready = observeCandidateEngineProvision({ ready: true });
  assert.equal(ready.unique_operation_terminal, "verified_success");
  const missing = observeCandidateEngineProvision({ ready: false });
  assert.equal(missing.unique_operation_terminal, "external_wait");
  assert.equal(missing.false_human, false);
});

for (const phase of SEMVER_ONLY_PHASES) {
  test(`ship-model semver phase: ${phase}`, () => {
    const row = FAULT_RECOVERY_MATRIX.find(
      (r) => r.ship_model === "semver" && r.ship_phase === phase && !r.not_applicable,
    );
    assert.ok(row, `semver covering row missing for ${phase}`);
  });
}

test("ship-model continuous covering", () => {
  const row = FAULT_RECOVERY_MATRIX.find(
    (r) => r.ship_model === "continuous" && !r.ship_phase && !r.not_applicable,
  );
  assert.ok(row);
});
