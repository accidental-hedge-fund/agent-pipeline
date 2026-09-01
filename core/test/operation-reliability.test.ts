// Unique-operation classifier (#1368). Injected events/run metas/manifest only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateUniqueOperationReliability,
  attemptsFromRunArtifacts,
  passingUniqueOperationAttempts,
  passingUniqueOperationManifest,
  reconcileCompletedSideEffect,
  uniqueOperationSloFailure,
} from "../scripts/operation-reliability.ts";
import {
  computeFrgEvidence,
  FRG_PACK_MANIFEST,
  FRG_UNIT_TEST_ATTESTATION_KEY,
  frgRequiredCompositionOverrides,
  frgRequiredObservationOverrides,
  isReleaseEligibleFrgPass,
  validateReleaseEligibleFrgEvidence,
  verifyFrgAttestation,
} from "../scripts/factory-reliability-gate.ts";

function packInput(over: Record<string, unknown> = {}) {
  return {
    version: "1.30.0",
    run_id: "frg-uop",
    loop_run_id: "loop-uop",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready" as const, ready_clean: true },
      { item_id: "2", state: "ready" as const, ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    unique_operations: passingUniqueOperationAttempts(),
    unique_operation_manifest: passingUniqueOperationManifest({ release_identity: "1.30.0" }),
    ...over,
  };
}

test("aggregator: two physical runs of one logical operation count once", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        postcondition_proof: true,
        nested: false,
        entrypoint: "single",
      },
      {
        run_id: "r2",
        logical_operation_id: "lop-L",
        postcondition_proof: true,
        nested: false,
        entrypoint: "single",
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.clean_completion.numerator, 1);
  assert.equal(report.clean_completion.denominator, 1);
  assert.equal(report.clean_completion.metric_kind, "unique_operation");
  assert.equal(report.operations.length, 1);
  assert.deepEqual(report.operations[0]!.run_ids, ["r1", "r2"]);
});

test("aggregator: zero-exit without postcondition proof is not verified success", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        process_exit_zero: true,
        run_complete: true,
        issue_closed: true,
        ready_to_deploy_label: true,
        nested: false,
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.clean_completion.numerator, 0);
  assert.equal(report.ownerless_terminal.numerator, 1);
  assert.equal(report.operations[0]!.terminal, "ownerless_terminal");
});

test("aggregator: undeclared wait is not a stable exclusion", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        terminal: "external_wait",
        fixture_id: "F",
        nested: false,
      },
    ],
    manifest: {
      required_entrypoints: [],
      required_lifecycle_classes: [],
      live_train_linkage_present: true,
    },
  });
  assert.equal(report.exclusions.length, 0);
  assert.equal(report.clean_completion.denominator, 1);
  assert.equal(report.clean_completion.numerator, 0);
});

test("aggregator: manifest-declared wait is a stable exclusion", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        terminal: "external_wait",
        fixture_id: "F",
        nested: false,
      },
    ],
    manifest: {
      expected_outcomes: { F: "external_wait" },
      required_entrypoints: [],
      required_lifecycle_classes: [],
      live_train_linkage_present: true,
    },
  });
  assert.equal(report.exclusions.length, 1);
  assert.equal(report.exclusions[0]!.reason, "external_wait");
  assert.equal(report.clean_completion.denominator, 0);
});

test("aggregator: missing logical_operation_id is missing correlation, not an exclusion", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [{ run_id: "historical", process_exit_zero: true }],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.integrity.missing_correlation, 1);
  assert.equal(report.exclusions.length, 0);
  assert.equal(report.clean_completion.denominator, 0);
});

test("aggregator: nested attempts do not increment unique-operation success by themselves", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "parent",
        logical_operation_id: "lop-L",
        nested: false,
        postcondition_proof: true,
        entrypoint: "train",
      },
      {
        run_id: "child-single",
        logical_operation_id: "lop-L",
        nested: true,
        postcondition_proof: true,
        entrypoint: "single",
      },
      {
        run_id: "attestation-tick",
        logical_operation_id: "lop-L",
        nested: true,
        postcondition_proof: true,
        entrypoint: "ship",
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.clean_completion.numerator, 1);
  assert.equal(report.clean_completion.denominator, 1);
});

test("aggregator: false-human from composition/blocker classification", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        nested: false,
        false_human: true,
        composition_false_human: true,
        terminal: "typed_request",
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
    composition_false_human_count: 1,
  });
  assert.equal(report.false_human_projection.numerator, 1);
  assert.equal(report.operations[0]!.terminal, "false_human_projection");
});

test("aggregator: ownerless terminal is not success, wait, or cancellation", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [{ run_id: "r1", logical_operation_id: "lop-L", nested: false }],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.ownerless_terminal.numerator, 1);
  assert.equal(report.clean_completion.numerator, 0);
  assert.notEqual(report.operations[0]!.terminal, "cancellation");
  assert.notEqual(report.operations[0]!.terminal, "external_wait");
  assert.notEqual(report.operations[0]!.terminal, "verified_success");
});

test("aggregator: retry keyed by run_id would double-count — keys by logical id", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      { run_id: "a", logical_operation_id: "lop-L", nested: false, postcondition_proof: true },
      { run_id: "b", logical_operation_id: "lop-L", nested: false, postcondition_proof: true },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.notEqual(report.clean_completion.denominator, 2, "must not key unique-operation success by run_id");
  assert.equal(report.clean_completion.denominator, 1);
});

test("reconcileCompletedSideEffect: later proof does not replay the mutation", () => {
  let mutations = 0;
  const first = reconcileCompletedSideEffect({
    alreadyCompleted: false,
    mutate: () => {
      mutations += 1;
      return "created";
    },
  });
  assert.equal(first.completed, true);
  assert.equal(first.replayed, false);
  assert.equal(mutations, 1);
  const second = reconcileCompletedSideEffect({
    alreadyCompleted: true,
    mutate: () => {
      mutations += 1;
      return "replay";
    },
  });
  assert.equal(second.completed, true);
  assert.equal(second.replayed, false);
  assert.equal(second.value, null);
  assert.equal(mutations, 1, "second mutation must not run");
});

test("aggregator: sibling halt on contained peer failure refuses independent-sibling rate", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "peer",
        logical_operation_id: "lop-peer",
        nested: false,
        independent_sibling_continuation: false,
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.independent_sibling_continuation.denominator, 1);
  assert.equal(report.independent_sibling_continuation.numerator, 0);
  assert.equal(report.independent_sibling_continuation.ratio, 0);
});

test("aggregator: applicable exact-candidate recovery at 100%", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        nested: false,
        postcondition_proof: true,
        exact_candidate_recovery: true,
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.exact_candidate_recovery.ratio, 1);
});

test("attemptsFromRunArtifacts: does not invent a logical id", () => {
  const attempts = attemptsFromRunArtifacts([
    {
      runId: "old",
      runJson: { run_id: "old" },
      events: [{ type: "run_start", run_id: "old" }],
      summary: { finalState: "ready-to-deploy" },
    },
  ]);
  assert.equal(attempts[0]!.logical_operation_id, null);
});

test("computeFrgEvidence: writes operation_reliability from durable fakes", () => {
  const evidence = computeFrgEvidence(packInput());
  assert.ok(evidence.operation_reliability);
  assert.equal(evidence.operation_reliability!.schema_version, 1);
  assert.equal(evidence.operation_reliability!.clean_completion.metric_kind, "unique_operation");
  assert.equal(evidence.pass, true);
});

test("missing correlation refuses release-eligible pass", () => {
  const evidence = computeFrgEvidence(
    packInput({
      unique_operations: [{ run_id: "no-id", process_exit_zero: true }],
      unique_operation_manifest: passingUniqueOperationManifest({ release_identity: "1.30.0" }),
    }),
  );
  assert.equal(evidence.pass, false);
  assert.ok(evidence.operation_reliability!.integrity.missing_correlation > 0);
  assert.equal(evidence.operation_reliability!.exclusions.length, 0);
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(JSON.parse(JSON.stringify(evidence)), "1.30.0", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /release-eligible|pass=false/i,
  );
});

test("false-human fixture refuses release-eligible pass and agrees with composition", () => {
  const evidence = computeFrgEvidence(
    packInput({
      false_human_authority_count: 1,
      unique_operations: [
        {
          run_id: "r1",
          logical_operation_id: "lop-L",
          nested: false,
          false_human: true,
          composition_false_human: true,
          entrypoint: "single",
        },
      ],
    }),
  );
  assert.ok(evidence.composition.false_human_authority_count > 0);
  assert.ok(evidence.operation_reliability!.false_human_projection.numerator > 0);
  assert.equal(evidence.pass, false);
});

test("ownerless terminal refuses release-eligible pass", () => {
  const evidence = computeFrgEvidence(
    packInput({
      unique_operations: [{ run_id: "r1", logical_operation_id: "lop-L", nested: false }],
      unique_operation_manifest: {
        ...passingUniqueOperationManifest({ release_identity: "1.30.0" }),
        required_entrypoints: [],
        required_lifecycle_classes: [],
      },
    }),
  );
  assert.ok(evidence.operation_reliability!.ownerless_terminal.numerator > 0);
  assert.equal(evidence.pass, false);
});

test("clean completion below 100% refuses pass", () => {
  const evidence = computeFrgEvidence(
    packInput({
      unique_operations: [
        {
          run_id: "r1",
          logical_operation_id: "lop-L",
          nested: false,
          postcondition_proof: true,
          manual_reinvocation: true,
          entrypoint: "single",
        },
      ],
      unique_operation_manifest: {
        ...passingUniqueOperationManifest({ release_identity: "1.30.0" }),
        required_entrypoints: ["single"],
        required_lifecycle_classes: [],
      },
    }),
  );
  assert.equal(evidence.pass, false);
  assert.notEqual(evidence.operation_reliability!.clean_completion.ratio, 1);
});

test("missing #1333 coverage is integrity failure not exclusion", () => {
  const evidence = computeFrgEvidence(
    packInput({
      unique_operations: passingUniqueOperationAttempts().map((a) => ({
        ...a,
        covered_lifecycle_classes: [],
      })),
      unique_operation_manifest: {
        ...passingUniqueOperationManifest({ release_identity: "1.30.0" }),
        covered_lifecycle_classes: [],
        required_lifecycle_classes: ["mechanical"],
      },
    }),
  );
  assert.ok(evidence.operation_reliability!.integrity.missing_required_coverage > 0);
  assert.equal(evidence.operation_reliability!.exclusions.length, 0);
  assert.equal(evidence.pass, false);
});

test("HMAC mutation of operation_reliability fails verification; public fingerprints stay intact", () => {
  const signed = computeFrgEvidence(packInput({ run_id: "frg-uop-mac" }));
  assert.equal(signed.pass, true);
  assert.equal(verifyFrgAttestation(signed, FRG_UNIT_TEST_ATTESTATION_KEY), true);
  const mutated = JSON.parse(JSON.stringify(signed));
  mutated.operation_reliability.clean_completion.numerator = 0;
  assert.equal(
    mutated.integrity.scoreboard_fingerprint,
    signed.integrity.scoreboard_fingerprint,
    "public scoreboard fingerprint must stay intact",
  );
  assert.equal(
    mutated.integrity.composition_fingerprint,
    signed.integrity.composition_fingerprint,
  );
  assert.equal(verifyFrgAttestation(mutated, FRG_UNIT_TEST_ATTESTATION_KEY), false);
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(mutated, "1.30.0", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /attestation MAC|forged|does not match/i,
  );
});

test("offline scoreInput without live provenance stays non-release-eligible even with operation_reliability", () => {
  const evidence = computeFrgEvidence(
    packInput({
      loop_run_id: null,
      pack_id: null,
    }),
  );
  assert.ok(evidence.operation_reliability);
  assert.equal(evidence.pass, false);
  assert.equal(isReleaseEligibleFrgPass(evidence), false);
});

test("passing #1333 mechanical fixtures yield zero false-human and zero ownerless", () => {
  const evidence = computeFrgEvidence(packInput());
  assert.equal(evidence.operation_reliability!.false_human_projection.numerator, 0);
  assert.equal(evidence.operation_reliability!.ownerless_terminal.numerator, 0);
  assert.equal(uniqueOperationSloFailure(evidence.operation_reliability), null);
  assert.equal(evidence.pass, true);
});
