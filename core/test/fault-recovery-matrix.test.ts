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
  assertFaultRecoveryCoveragePresent,
  assertFaultRecoveryInventoryComplete,
  collectFaultRecoveryInventoryGaps,
  coveredLifecycleClassesFromMatrix,
  isEvalHoldoutModule,
  missingRequiredLifecycleCoverage,
  observeAdapterFault,
  observeCandidateEngineProvision,
  observeTypedPreflightRefusal,
  requiredMatrixOperations,
  resumeKnownCompleteSideEffect,
  type FaultRecoveryMatrixRow,
} from "../scripts/fault-recovery-matrix.ts";
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
  assert.deepEqual(coveredLifecycleClassesFromMatrix(), [...MATRIX_LIFECYCLE_CLASSES]);
  assert.deepEqual(missingRequiredLifecycleCoverage(), []);
});

for (const layer of MATRIX_COVERAGE_LAYERS) {
  test(`matrix inventory includes layer ${layer}`, () => {
    assert.ok(FAULT_RECOVERY_MATRIX.some((row) => row.layer === layer && !row.not_applicable));
  });
}

for (const fault of MATRIX_FAULT_STATES) {
  test(`adapter contract: ${fault}`, () => {
    const obs = observeAdapterFault({ fault_state: fault });
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
