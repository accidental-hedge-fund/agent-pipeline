// Factory Reliability Gate (#723) — schema, scoring, evidence I/O, release lookup,
// and driver seams. Zero real network/git/subprocess; in-memory fs only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRG_SCHEMA_VERSION,
  FRG_SCENARIO_IDS,
  FRG_COMPOSITION_DIMENSION_IDS,
  FRG_LAYER_A_WAIVERS,
  FRG_SCENARIO_OWNERSHIP,
  FRG_PACK_MANIFEST,
  DEFAULT_FRG_THRESHOLDS,
  classifyFrgBlocker,
  computeAttestorRunId,
  computeFrgEvidence,
  computeEngineClassRate,
  parseFrgEvidence,
  parseFrgEvidenceJson,
  parseFrgObservationsJson,
  parseFrgScenarioCliToken,
  normalizeFrgVersion,
  frgLatestPath,
  frgRunEvidencePath,
  frgTrendLedgerPath,
  writeFrgEvidence,
  appendFrgTrendLedger,
  trendLedgerEntryFromEvidence,
  lookupFrgPass,
  requireFrgPassForRelease,
  factoryGateMissingFromRunUsage,
  formatMissingFrgRecoveryCommands,
  missingFrgPassDiagnostic,
  shipMissingFrgDiagnostic,
  formatFrgPrSection,
  formatEngineClassRateDisplay,
  runFactoryGate,
  itemsFromLoopLedger,
  projectFrgItemsWithGitHubOverlay,
  detectEmptyDependsOnStackHonesty,
  frgRequiredObservationOverrides,
  frgRequiredCompositionOverrides,
  validateFrgPackContract,
  isAllowedFrgPackSelector,
  enforceRequiredScenarioCriteria,
  frgAttestationPresent,
  isReleaseEligibleFrgPass,
  validateReleaseEligibleFrgEvidence,
  validateFrgEvidenceFileForTag,
  validateFrgEvidenceSnapshotForTag,
  FrgTagPathIneligibleError,
  isFrgTagPathIneligibleError,
  observeReleaseEligibleFrgEvidence,
  frgLatestRelPath,
  formatFrgPackCloseComment,
  parseFrgItemIssueNumber,
  packLabelFromSelector,
  selectReadyCleanPackIssueNumbers,
  closeFrgPackArtifacts,
  FRG_UNIT_TEST_ATTESTATION_KEY,
  FRG_ATTESTATION_KEY_ENV,
  signFrgIntegrity,
  verifyFrgAttestation,
  FRG_ATTESTOR_RUN_ID_PREFIX,
  buildFrgIntegrity,
  type FrgEvidence,
  type FrgFsDeps,
  type FrgPackCloseDeps,
} from "../scripts/factory-reliability-gate.ts";
import type { LoopContract, LoopLedger } from "../scripts/loop/types.ts";
import { LOOP_CONTRACT_SCHEMA, LOOP_LEDGER_SCHEMA } from "../scripts/loop/types.ts";
import {
  collectFrgPackObservations,
  loadFrgPack,
  renderFrgPackIssues,
  type CollectedFrgObservations,
  type FrgGitHubItemObservation,
} from "../scripts/frg-pack-observations.ts";
import {
  buildFactoryReleaseUnsignedDigestBinding,
  defaultScoreBoundPackLoop,
  type FactoryReleaseFrgPayload,
  type FactoryReleasePrepareRequest,
} from "../scripts/factory-release-prepare.ts";
import { presentFrgAttestorCredential } from "../scripts/ship-end-candidate.ts";
import {
  REQUIRED_LIFECYCLE_CLASSES_1333,
  passingUniqueOperationAttempts,
  passingUniqueOperationManifest,
} from "../scripts/operation-reliability.ts";
import { frgPassUniqueOperations } from "./frg-pass-unique-operations.ts";

/** Minimal full-pack pass scoring input (all scenarios + composition; K met; live loop). */
function fullPackPassInput(
  overrides: {
    version?: string;
    run_id?: string;
    loop_run_id?: string | null;
    pack_id?: string | null;
    /** When null, omit attestation (not release-eligible). Default: unit-test key. */
    attestation_key?: string | null;
  } = {},
) {
  return {
    version: overrides.version ?? "1.29.1",
    run_id: overrides.run_id ?? "frg-full-pass",
    // Release-eligible pass requires durable loop + fixed-pack provenance.
    loop_run_id:
      overrides.loop_run_id === undefined ? "loop-full-pass" : overrides.loop_run_id,
    pack_id:
      overrides.pack_id === undefined ? FRG_PACK_MANIFEST.pack_id : overrides.pack_id,
    items: [
      { item_id: "1", state: "ready" as const, ready_clean: true },
      { item_id: "2", state: "ready" as const, ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    // Release-eligible pass requires HMAC attestation (#757 / cca5f0f7).
    attestation_key:
      overrides.attestation_key === undefined
        ? FRG_UNIT_TEST_ATTESTATION_KEY
        : overrides.attestation_key,
    unique_operations: passingUniqueOperationAttempts(),
    unique_operation_manifest: passingUniqueOperationManifest({
      release_identity: overrides.version ?? "1.29.1",
    }),
    matrix_covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
  };
}

// ---------------------------------------------------------------------------
// In-memory fs
// ---------------------------------------------------------------------------

function memFs(): FrgFsDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(p) {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    async writeFile(p, data) {
      files.set(p, data);
    },
    async mkdir() {},
    async rename(from, to) {
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT rename ${from}`);
      files.set(to, v);
      files.delete(from);
    },
  };
}

// ---------------------------------------------------------------------------
// Schema / inventory
// ---------------------------------------------------------------------------

test("FRG scenario inventory is fixed and named", () => {
  assert.equal(FRG_SCENARIO_IDS.length, 10);
  assert.ok(FRG_SCENARIO_IDS.includes("capacity-blocked-retain"));
  assert.ok(FRG_SCENARIO_IDS.includes("empty-depends-on-stack-honesty"));
  for (const id of FRG_SCENARIO_IDS) {
    assert.ok(FRG_SCENARIO_OWNERSHIP[id], `ownership for ${id}`);
    assert.ok(FRG_SCENARIO_OWNERSHIP[id].pass_criteria.length > 0);
  }
});

test("Layer A waivers: empty inventory after #757 (former closed issues now have tests)", () => {
  assert.deepEqual(FRG_LAYER_A_WAIVERS, {});
  for (const [id, ownership] of Object.entries(FRG_SCENARIO_OWNERSHIP)) {
    if (ownership.layer_a === "waiver") {
      const issue = FRG_LAYER_A_WAIVERS[id as keyof typeof FRG_LAYER_A_WAIVERS];
      assert.ok(issue, `waiver for ${id} must name an open issue`);
      assert.match(issue!, /^#\d+$/);
      // Closed-only citations forbidden — inventory should not list closed #729/#730.
      assert.notEqual(issue, "#729");
      assert.notEqual(issue, "#730");
    } else {
      assert.equal(ownership.layer_a, "test", `${id} must be test-covered or waived`);
    }
  }
  // Formerly waived scenarios are now Layer A tests.
  assert.equal(FRG_SCENARIO_OWNERSHIP["pr-supersession"].layer_a, "test");
  assert.equal(FRG_SCENARIO_OWNERSHIP["release-plan-row"].layer_a, "test");
});

test("normalizeFrgVersion strips v prefix and rejects garbage", () => {
  assert.equal(normalizeFrgVersion("v1.29.1"), "1.29.1");
  assert.equal(normalizeFrgVersion("1.29.1"), "1.29.1");
  assert.throws(() => normalizeFrgVersion("42"), /Invalid FRG version/);
  assert.throws(() => normalizeFrgVersion("1.2"), /Invalid FRG version/);
});

test("classifyFrgBlocker taxonomy buckets", () => {
  assert.equal(classifyFrgBlocker("workflow-engine-defect"), "engine-class");
  assert.equal(classifyFrgBlocker("missing-authority"), "human-authority");
  assert.equal(classifyFrgBlocker("specification-decision"), "human-authority");
  assert.equal(classifyFrgBlocker("implementation-ci"), "product-class");
  assert.equal(classifyFrgBlocker("capacity-cascade"), "engine-class");
  assert.equal(classifyFrgBlocker(null), "engine-class");
  assert.equal(classifyFrgBlocker("totally-unknown-xyz"), "engine-class");
});

test("classifyFrgBlocker: environment-auth is product-class, not engine-class", () => {
  assert.equal(classifyFrgBlocker("environment-auth"), "product-class");
  assert.notEqual(classifyFrgBlocker("environment-auth"), "engine-class");
  assert.notEqual(classifyFrgBlocker("environment-auth"), "human-authority");
});

test("computeFrgEvidence: environment-auth theme increments product-class, not engine_class_count", () => {
  const evidence = computeFrgEvidence({
    version: "1.39.13",
    run_id: "frg-env-auth",
    loop_run_id: "loop-env-auth",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "blocked", blocker_theme: "environment-auth" },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
  });
  assert.equal(evidence.scoreboard.engine_class_count, 0);
  assert.equal(evidence.scoreboard.product_class_count, 1);
  assert.equal(evidence.scoreboard.engine_class_rate, 0);

  const misThemed = computeFrgEvidence({
    version: "1.39.13",
    run_id: "frg-env-auth-mis",
    loop_run_id: "loop-env-auth-mis",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "blocked", blocker_theme: "workflow-engine-defect" },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
  });
  assert.equal(misThemed.scoreboard.engine_class_count, 1);
  assert.equal(classifyFrgBlocker("workflow-engine-defect"), "engine-class");
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

test("computeFrgEvidence: green unit-shaped pass with K clean ready items + full pack observation", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-test-1",
    loop_run_id: "loop-test-1",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
      { item_id: "3", state: "waiting", blocker_theme: "missing-authority" },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    now: () => new Date("2026-07-30T12:00:00.000Z"),
    ...frgPassUniqueOperations("1.29.1"),
  });
  assert.equal(evidence.schema_version, FRG_SCHEMA_VERSION);
  assert.equal(evidence.version, "1.29.1");
  assert.equal(evidence.run_id, "frg-test-1");
  assert.equal(evidence.pass, true);
  assert.equal(evidence.loop_run_id, "loop-test-1");
  assert.equal(evidence.pack_id, FRG_PACK_MANIFEST.pack_id);
  assert.equal(evidence.scoreboard.ready_clean_count, 2);
  // 0 engine / 3 items = 0 (never null when item_count ≥ 1)
  assert.equal(evidence.scoreboard.engine_class_rate, 0);
  assert.equal(evidence.composition.missing.length, 0);
  assert.equal(evidence.integrity.producer, "pipeline-factory-gate");
  assert.ok(evidence.integrity.attestation?.mac);
  assert.equal(
    verifyFrgAttestation(evidence, FRG_UNIT_TEST_ATTESTATION_KEY),
    true,
  );
  assert.equal(evidence.thresholds.min_clean_ready_to_deploy, DEFAULT_FRG_THRESHOLDS.min_clean_ready_to_deploy);
  const throughput = evidence.scenarios.find((s) => s.id === "clean-item-throughput");
  assert.equal(throughput?.status, "pass");
  const capacity = evidence.scenarios.find((s) => s.id === "capacity-blocked-retain");
  assert.equal(capacity?.status, "pass");
  assert.ok((capacity?.observed ?? 0) >= DEFAULT_FRG_THRESHOLDS.capacity_stress_n);
  assert.ok(evidence.scenarios.every((s) => s.status !== "not_observed"));
});

test("computeFrgEvidence: offline score without loop_run_id cannot yield release pass", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-offline",
    loop_run_id: null,
    pack_id: null,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
  });
  assert.equal(evidence.pass, false, "no live loop → not release-eligible");
  assert.equal(evidence.loop_run_id, null);
  assert.equal(evidence.pack_id, null);
  // Scenario criteria alone may be green; pass still false without provenance.
  assert.ok(evidence.scenarios.every((s) => s.status !== "not_observed"));
});

test("computeFrgEvidence: capacity pass override without observed≥N is coerced to fail", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-cap-fake",
    loop_run_id: "loop-cap",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass").map((o) =>
      o.id === "capacity-blocked-retain"
        ? {
            id: "capacity-blocked-retain" as const,
            status: "pass" as const,
            detail: "claimed pass without capacity stress",
            observed: 0,
            threshold: DEFAULT_FRG_THRESHOLDS.capacity_stress_n,
          }
        : o,
    ),
  });
  assert.equal(evidence.pass, false);
  const capacity = evidence.scenarios.find((s) => s.id === "capacity-blocked-retain");
  assert.equal(capacity?.status, "fail");
  assert.equal(capacity?.observed, 0);
});

test("computeFrgEvidence: skip on required scenario fails overall pass", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-skip",
    loop_run_id: "loop-skip",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass").map((o) =>
      o.id === "resume-mid-flight"
        ? {
            id: "resume-mid-flight" as const,
            status: "skip" as const,
            detail: "skipped",
            observed: null,
            threshold: null,
          }
        : o,
    ),
  });
  assert.equal(evidence.pass, false);
  const resume = evidence.scenarios.find((s) => s.id === "resume-mid-flight");
  assert.equal(resume?.status, "fail");
  assert.match(resume?.detail ?? "", /cannot be skipped/);
});

test("enforceRequiredScenarioCriteria + isReleaseEligibleFrgPass: capacity N and live loop", () => {
  const thresholds = DEFAULT_FRG_THRESHOLDS;
  const bad = enforceRequiredScenarioCriteria(
    [
      {
        id: "capacity-blocked-retain",
        status: "pass",
        detail: "fake",
        observed: 0,
        threshold: thresholds.capacity_stress_n,
      },
    ],
    thresholds,
  );
  assert.equal(bad[0]?.status, "fail");

  const full = computeFrgEvidence(fullPackPassInput());
  assert.equal(full.pass, true);
  assert.equal(isReleaseEligibleFrgPass(full), true);
  assert.equal(isReleaseEligibleFrgPass({ ...full, loop_run_id: null }), false);
  assert.equal(isReleaseEligibleFrgPass({ ...full, pack_id: null }), false);
  assert.equal(isReleaseEligibleFrgPass({ ...full, pass: false }), false);

  const unsigned = computeFrgEvidence(fullPackPassInput({ attestation_key: null }));
  assert.equal(unsigned.pass, false, "unsigned mint must not invent pass:true");
  assert.equal(frgAttestationPresent(unsigned.integrity), false);
  assert.equal(
    isReleaseEligibleFrgPass(unsigned),
    false,
    "default eligibility still requires attested pass",
  );
  assert.equal(
    isReleaseEligibleFrgPass(unsigned, { requireAttestation: false }),
    true,
    "HMAC-optional structural eligibility must ignore unsigned pass:false (#1147)",
  );
  const missingComposition = {
    ...unsigned,
    composition: { dimensions: [], missing: ["openspec-bearing-item"] },
  };
  assert.equal(
    isReleaseEligibleFrgPass(missingComposition, { requireAttestation: false }),
    false,
    "real ineligible scoreboards stay fail-closed when HMAC is omitted",
  );
});

test("computeFrgEvidence: unobserved mandatory scenarios fail overall pass (not release evidence)", () => {
  // Ordinary loop with K clean ready items but no pack scenario observations.
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-unobserved",
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
  });
  assert.equal(evidence.pass, false, "not_observed required scenarios must not produce pass:true");
  const unobserved = evidence.scenarios.filter((s) => s.status === "not_observed");
  assert.ok(unobserved.length >= 1);
  assert.ok(unobserved.some((s) => s.id === "capacity-blocked-retain"));
  // Auto-scored scenarios still pass when thresholds are met.
  assert.equal(
    evidence.scenarios.find((s) => s.id === "clean-item-throughput")?.status,
    "pass",
  );
});

test("computeFrgEvidence: clean-item throughput below K fails the gate", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-test-k",
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
    thresholds: { ...DEFAULT_FRG_THRESHOLDS, min_clean_ready_to_deploy: 2 },
  });
  assert.equal(evidence.pass, false);
  const throughput = evidence.scenarios.find((s) => s.id === "clean-item-throughput");
  assert.equal(throughput?.status, "fail");
  assert.equal(throughput?.observed, 1);
  assert.equal(throughput?.threshold, 2);
});

test("computeFrgEvidence: engine-class rate above threshold fails the gate", () => {
  const evidence = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-test-engine",
    items: [
      { item_id: "1", state: "blocked", blocker_theme: "workflow-engine-defect" },
      { item_id: "2", state: "blocked", blocker_theme: "workflow-engine-defect" },
      { item_id: "3", state: "ready", ready_clean: true },
      { item_id: "4", state: "ready", ready_clean: true },
    ],
    thresholds: { ...DEFAULT_FRG_THRESHOLDS, max_engine_class_rate: 0.25, min_clean_ready_to_deploy: 2 },
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
  });
  // item_count denominator: 2 engine / 4 items = 0.5 > 0.25
  assert.equal(evidence.pass, false);
  const tax = evidence.scenarios.find((s) => s.id === "blocker-taxonomy");
  assert.equal(tax?.status, "fail");
  assert.ok(tax?.detail.includes("engine-class rate"));
  assert.equal(evidence.scoreboard.engine_class_rate, 0.5);
  assert.ok((evidence.scoreboard.engine_class_rate ?? 0) > 0.25);
});

test("computeFrgEvidence: clean multi-item pack reports engine_class_rate 0 (never null/n/a)", () => {
  const evidence = computeFrgEvidence(fullPackPassInput({ run_id: "frg-rate-zero" }));
  assert.equal(evidence.scoreboard.item_count, 2);
  assert.equal(evidence.scoreboard.engine_class_count, 0);
  assert.equal(evidence.scoreboard.engine_class_rate, 0);
  assert.equal(formatEngineClassRateDisplay(evidence.scoreboard), "0.0%");
  assert.equal(formatFrgPrSection(evidence).includes("n/a"), false);
});

test("computeFrgEvidence: mixed pack uses item_count denominator", () => {
  const evidence = computeFrgEvidence({
    version: "1.30.0",
    run_id: "frg-mixed-rate",
    loop_run_id: "loop-mixed",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "blocked", blocker_theme: "workflow-engine-defect" },
      { item_id: "2", state: "ready", ready_clean: true },
      { item_id: "3", state: "ready", ready_clean: true },
      { item_id: "4", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
  });
  assert.equal(evidence.scoreboard.item_count, 4);
  assert.equal(evidence.scoreboard.engine_class_count, 1);
  assert.equal(evidence.scoreboard.engine_class_rate, 0.25);
  assert.equal(computeEngineClassRate(1, 4), 0.25);
});

test("computeFrgEvidence: empty pack is not release-eligible", () => {
  const evidence = computeFrgEvidence({
    version: "1.30.0",
    run_id: "frg-empty",
    loop_run_id: "loop-empty",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
  });
  assert.equal(evidence.scoreboard.item_count, 0);
  assert.equal(evidence.scoreboard.engine_class_rate, null);
  assert.equal(evidence.pass, false);
});

test("computeFrgEvidence: clean-only pack fails representative composition", () => {
  const evidence = computeFrgEvidence({
    version: "1.30.0",
    run_id: "frg-clean-only",
    loop_run_id: "loop-clean",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
  });
  assert.equal(evidence.pass, false);
  assert.ok(evidence.composition.missing.length > 0);
  assert.ok(evidence.composition.missing.includes("fix-rereview-cycle"));
  assert.ok(evidence.composition.missing.includes("recovery-controller-one-item"));
});

test("computeFrgEvidence: false_human_authority_count fails release-eligible pass", () => {
  const evidence = computeFrgEvidence({
    ...fullPackPassInput({ run_id: "frg-false-ha" }),
    false_human_authority_count: 1,
  });
  assert.equal(evidence.pass, false);
  assert.equal(evidence.composition.false_human_authority_count, 1);
});

test("parseFrgEvidence rejects NaN/Infinity engine_class_rate", () => {
  const good = computeFrgEvidence(fullPackPassInput({ run_id: "frg-nan" }));
  const raw = JSON.parse(JSON.stringify(good));
  raw.scoreboard.engine_class_rate = Number.NaN;
  assert.throws(() => parseFrgEvidence(raw), /engine_class_rate|number/);
  raw.scoreboard.engine_class_rate = Number.POSITIVE_INFINITY;
  assert.throws(() => parseFrgEvidence(raw), /engine_class_rate|number/);
});

test("computeFrgEvidence: pass for one version does not imply another", () => {
  const a = computeFrgEvidence(fullPackPassInput({ version: "1.29.1", run_id: "frg-a" }));
  assert.equal(a.pass, true);
  assert.equal(a.version, "1.29.1");
  // Different version requires its own artifact — scoring for 1.30.0 is independent.
  const b = computeFrgEvidence({
    version: "1.30.0",
    run_id: "frg-b",
    items: [{ item_id: "1", state: "blocked", blocker_theme: "workflow-engine-defect" }],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
  });
  assert.equal(b.version, "1.30.0");
  assert.notEqual(b.version, a.version);
});

test("parseFrgEvidence rejects bad shapes", () => {
  assert.throws(() => parseFrgEvidence(null), /JSON object/);
  assert.throws(
    () => parseFrgEvidence({ schema_version: 99, version: "1.0.0", run_id: "x", pass: true }),
    /schema_version/,
  );
  assert.throws(
    () =>
      parseFrgEvidence({
        schema_version: 1,
        version: "1.0.0",
        run_id: "",
        pass: true,
        scenarios: [],
        scoreboard: {},
        thresholds: {},
      }),
    /run_id/,
  );
});

test("parseFrgEvidence rejects structurally incomplete pass artifacts (empty scenarios)", () => {
  // A latest.json with matching version, pass:true, empty scenarios must NOT parse.
  assert.throws(
    () =>
      parseFrgEvidence({
        schema_version: 1,
        version: "1.29.1",
        run_id: "frg-fake-pass",
        pass: true,
        scenarios: [],
        scoreboard: {},
        thresholds: {},
        loop_run_id: null,
        created_at: "2026-07-30T00:00:00Z",
        notes: [],
      }),
    /exactly 10 named outcomes|scenarios/,
  );
});

test("parseFrgEvidence rejects pass:true with not_observed scenarios", () => {
  const scored = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-inconsistent",
    loop_run_id: "loop-x",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
  });
  assert.equal(scored.pass, false);
  // Force pass:true while keeping not_observed statuses — must reject.
  assert.throws(
    () => parseFrgEvidence({ ...scored, pass: true }),
    /not release-eligible|fail or not_observed/,
  );
});

test("parseFrgEvidence rejects pass:true without live loop_run_id (offline not release-eligible)", () => {
  const scored = computeFrgEvidence(
    fullPackPassInput({ run_id: "frg-no-loop", loop_run_id: "loop-ok" }),
  );
  assert.equal(scored.pass, true);
  assert.throws(
    () =>
      parseFrgEvidence({
        ...scored,
        loop_run_id: null,
        pack_id: FRG_PACK_MANIFEST.pack_id,
        pass: true,
      }),
    /not release-eligible|loop_run_id/,
  );
  assert.throws(
    () =>
      parseFrgEvidence({
        ...scored,
        loop_run_id: "loop-ok",
        pack_id: null,
        pass: true,
      }),
    /not release-eligible|pack_id/,
  );
});

test("parseFrgEvidence rejects pass:true capacity with observed below N", () => {
  const scored = computeFrgEvidence(fullPackPassInput({ run_id: "frg-cap-parse" }));
  const scenarios = scored.scenarios.map((s) =>
    s.id === "capacity-blocked-retain"
      ? { ...s, status: "pass", observed: 0, detail: "forged" }
      : s,
  );
  assert.throws(
    () => parseFrgEvidence({ ...scored, scenarios, pass: true }),
    /not release-eligible|capacity/,
  );
});

test("parseFrgEvidence accepts complete computeFrgEvidence output", () => {
  const evidence = computeFrgEvidence(fullPackPassInput({ run_id: "frg-roundtrip" }));
  const parsed = parseFrgEvidence(JSON.parse(JSON.stringify(evidence)));
  assert.equal(parsed.pass, true);
  assert.equal(parsed.run_id, "frg-roundtrip");
  assert.equal(parsed.loop_run_id, "loop-full-pass");
  assert.equal(parsed.pack_id, FRG_PACK_MANIFEST.pack_id);
  assert.equal(parsed.scenarios.length, FRG_SCENARIO_IDS.length);
});

// ---------------------------------------------------------------------------
// Evidence I/O + lookup
// ---------------------------------------------------------------------------

test("writeFrgEvidence + lookupFrgPass: pass and fail distinguished from missing", async () => {
  const fs = memFs();
  const repo = "/repo";
  const passEv = computeFrgEvidence(fullPackPassInput({ version: "1.29.1", run_id: "frg-pass-1" }));
  await writeFrgEvidence(repo, passEv, fs);
  const look = await lookupFrgPass(repo, "1.29.1", fs);
  assert.equal(look.kind, "pass");
  if (look.kind === "pass") {
    assert.equal(look.evidence.run_id, "frg-pass-1");
    assert.equal(look.evidence.pass, true);
  }

  const miss = await lookupFrgPass(repo, "1.30.0", fs);
  assert.equal(miss.kind, "missing");
  if (miss.kind === "missing") {
    assert.equal(miss.version, "1.30.0");
    assert.ok(miss.path.includes("1.30.0"));
  }

  const failEv = computeFrgEvidence({
    version: "1.29.2",
    run_id: "frg-fail-1",
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
  });
  assert.equal(failEv.pass, false);
  await writeFrgEvidence(repo, failEv, fs);
  const lookFail = await lookupFrgPass(repo, "1.29.2", fs);
  assert.equal(lookFail.kind, "fail");
});

test("lookupFrgPass: incomplete pass:true latest.json is unparsable (does not unblock release)", async () => {
  const fs = memFs();
  await fs.writeFile(
    frgLatestPath("/repo", "1.29.1"),
    JSON.stringify({
      schema_version: 1,
      version: "1.29.1",
      run_id: "frg-incomplete",
      pass: true,
      scenarios: [],
      scoreboard: {},
      thresholds: {},
    }),
  );
  const look = await lookupFrgPass("/repo", "1.29.1", fs);
  assert.equal(look.kind, "unparsable");
  await assert.rejects(
    () => requireFrgPassForRelease("/repo", "1.29.1", fs),
    /unparsable|scenarios/,
  );
});

test("lookupFrgPass: unparsable evidence is distinguishable", async () => {
  const fs = memFs();
  const p = frgLatestPath("/repo", "1.0.0");
  await fs.writeFile(p, "{ not json");
  const look = await lookupFrgPass("/repo", "1.0.0", fs);
  assert.equal(look.kind, "unparsable");
});

function assertRunnableFrgRecovery(text: string, version: string): void {
  assert.match(text, /pipeline loop --label factory-gate --profile claude/);
  assert.match(
    text,
    new RegExp(`pipeline factory-gate --for ${version.replace(/\./g, "\\.")} --from-run`),
  );
  const loopIdx = text.indexOf("pipeline loop --label factory-gate --profile claude");
  const fromRunIdx = text.indexOf("--from-run");
  const skipIdx = text.indexOf("--skip-frg");
  assert.ok(loopIdx !== -1 && fromRunIdx !== -1);
  if (skipIdx !== -1) {
    assert.ok(
      loopIdx < skipIdx && fromRunIdx < skipIdx,
      "--skip-frg must not be the first or only named recovery",
    );
  }
  assert.doesNotMatch(
    text,
    /non-claude[\s\S]{0,80}--skip-frg|--skip-frg[\s\S]{0,80}non-claude profile/,
  );
}

test("requireFrgPassForRelease: missing / fail / empty run_id refuse; pass returns evidence", async () => {
  const fs = memFs();
  await assert.rejects(
    () => requireFrgPassForRelease("/repo", "1.29.1", fs),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /pass missing for version 1\.29\.1/);
      assertRunnableFrgRecovery(msg, "1.29.1");
      assert.doesNotMatch(
        msg,
        /^[\s\S]*Run: pipeline factory-gate --for 1\.29\.1\s*$/,
      );
      const skipIdx = msg.indexOf("--skip-frg");
      if (skipIdx !== -1) {
        assert.match(msg.slice(0, skipIdx), /Escape/);
      }
      return true;
    },
  );

  const failEv = computeFrgEvidence({
    version: "1.29.1",
    run_id: "frg-fail",
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
  });
  await writeFrgEvidence("/repo", failEv, fs);
  await assert.rejects(
    () => requireFrgPassForRelease("/repo", "1.29.1", fs),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /Gate FAILED for version 1\.29\.1/);
      assertRunnableFrgRecovery(msg, "1.29.1");
      return true;
    },
  );

  const passEv = computeFrgEvidence(fullPackPassInput({ version: "1.29.1", run_id: "frg-ok" }));
  await writeFrgEvidence("/repo", passEv, fs);
  const ok = await requireFrgPassForRelease("/repo", "1.29.1", fs);
  assert.equal(ok.run_id, "frg-ok");
  assert.equal(ok.pass, true);

  // Empty run_id must fail closed even if pass:true is claimed.
  const bad: FrgEvidence = { ...passEv, run_id: "   " };
  // Bypass parseFrgEvidence writer: write raw JSON that parse will reject on lookup.
  await fs.writeFile(
    frgLatestPath("/repo", "9.9.9"),
    JSON.stringify({
      schema_version: 1,
      version: "9.9.9",
      run_id: "",
      pass: true,
      scenarios: [],
      scoreboard: {},
      thresholds: DEFAULT_FRG_THRESHOLDS,
    }),
  );
  await assert.rejects(
    () => requireFrgPassForRelease("/repo", "9.9.9", fs),
    /unparsable|run_id/,
  );
  void bad;
});

test("missing-FRG diagnostics name pack loop, profile, and from-run (#1252)", () => {
  const missing = missingFrgPassDiagnostic({
    version: "1.39.13",
    path: "/repo/.agent-pipeline/frg/1.39.13/latest.json",
  });
  assertRunnableFrgRecovery(missing, "1.39.13");
  assert.match(missing, /expected \/repo\/\.agent-pipeline\/frg\/1\.39\.13\/latest\.json/);

  const usage = factoryGateMissingFromRunUsage();
  assert.match(usage, /pipeline loop --label factory-gate --profile claude/);
  assert.match(usage, /pipeline factory-gate --for <X\.Y\.Z> --from-run/);
  assert.ok(!usage.includes("--skip-frg") || usage.indexOf("--skip-frg") > usage.indexOf("--from-run"));

  const ship = shipMissingFrgDiagnostic({ version: "1.39.13", includePrepare: true });
  assertRunnableFrgRecovery(ship, "1.39.13");
  const loopIdx = ship.indexOf("pipeline loop --label factory-gate --profile claude");
  const prepareIdx = ship.indexOf("pipeline factory-release prepare");
  assert.ok(loopIdx !== -1 && prepareIdx !== -1 && loopIdx < prepareIdx);

  const block = formatMissingFrgRecoveryCommands({
    version: "1.39.13",
    includeSkipEscape: true,
  });
  assertRunnableFrgRecovery(block, "1.39.13");
  assert.match(block, /Escape \(non-production no-frg-\* pin/);
});

test("runFactoryGate without --from-run names pack loop and profile (#1252)", async () => {
  await assert.rejects(
    () =>
      runFactoryGate({
        version: "1.39.13",
        repoDir: "/repo",
        stdout: () => {},
        stderr: () => {},
      }),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /pipeline loop --label factory-gate --profile claude/);
      assert.match(msg, /pipeline factory-gate --for <X\.Y\.Z> --from-run/);
      assert.equal(msg, factoryGateMissingFromRunUsage());
      return true;
    },
  );
});

test("formatFrgPrSection includes run_id and pass for release PR surface", () => {
  const evidence = computeFrgEvidence(
    fullPackPassInput({ run_id: "frg-attach-1", loop_run_id: "loop-abc" }),
  );
  const section = formatFrgPrSection(evidence);
  assert.match(section, /Factory Reliability Gate/);
  assert.match(section, /frg-attach-1/);
  assert.match(section, /pass/);
  assert.match(section, /1\.29\.1/);
  assert.match(section, /loop-abc/);
});

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

test("runFactoryGate: scoreInput path does not persist evidence by default", async () => {
  const fs = memFs();
  const lines: string[] = [];
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      json: true,
      scoreInput: fullPackPassInput({ run_id: "frg-driver-1" }),
      stdout: (m) => lines.push(m),
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.pass, true);
  assert.equal(result.evidencePath, null, "offline scoreInput must not write by default");
  assert.equal(result.latestPath, null);
  assert.equal(fs.files.size, 0);
  const parsed = parseFrgEvidenceJson(lines.join("\n"));
  assert.equal(parsed.run_id, "frg-driver-1");
});

test("runFactoryGate: scoreInput without loop_run_id cannot produce release pass even if written", async () => {
  const fs = memFs();
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      writeEvidence: true,
      scoreInput: fullPackPassInput({
        run_id: "frg-offline-write",
        loop_run_id: null,
        pack_id: null,
      }),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.evidence.pass, false);
  // Even if a fail report is written, release lookup must not treat it as pass.
  if (result.evidencePath) {
    const look = await lookupFrgPass("/repo", "1.29.1", fs);
    assert.notEqual(look.kind, "pass");
  }
});

test("runFactoryGate: scoreInput with explicit writeEvidence + live provenance can persist", async () => {
  const fs = memFs();
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      writeEvidence: true,
      scoreInput: fullPackPassInput({ run_id: "frg-explicit-write" }),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.pass, true);
  assert.ok(result.evidencePath?.includes("frg-explicit-write"));
  const look = await lookupFrgPass("/repo", "1.29.1", fs);
  assert.equal(look.kind, "pass");
});

test("runFactoryGate: fail exits non-zero", async () => {
  const fs = memFs();
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      writeEvidence: true,
      scoreInput: {
        version: "1.29.1",
        run_id: "frg-driver-fail",
        items: [{ item_id: "1", state: "blocked", blocker_theme: "workflow-engine-defect" }],
      },
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.evidence.pass, false);
});

test("runFactoryGate: does not merge or tag (no side-effect hooks)", async () => {
  // Structural: driver only writes FRG evidence files — no merge/tag deps exist.
  const fs = memFs();
  await runFactoryGate(
    {
      version: "1.0.0",
      repoDir: "/repo",
      writeEvidence: true,
      scoreInput: fullPackPassInput({ version: "1.0.0", run_id: "frg-no-merge" }),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  for (const key of fs.files.keys()) {
    assert.ok(key.includes(".agent-pipeline/frg"), `only FRG paths written: ${key}`);
    assert.ok(!key.includes("tag"), key);
  }
});

test("runFactoryGate --from-run: refuses unrelated durable loop (non-pack selector)", async () => {
  const fs = memFs();
  const productContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-product",
    selector: { type: "milestone", value: "v2-product" },
    items: [
      { id: "1", depends_on: [], external_depends_on: [] },
      { id: "2", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-product",
    items: {
      "1": { state: "ready", history: [], recovery_attempts: [] },
      "2": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;

  await assert.rejects(
    () =>
      runFactoryGate(
        {
          version: "1.29.1",
          repoDir: "/repo",
          fromRun: "loop-product",
          loadLedger: async () => ledger,
          loadContract: async () => productContract,
          scenarioOverrides: frgRequiredObservationOverrides("pass"),
          stdout: () => {},
          stderr: () => {},
        },
        fs,
      ),
    /refused to score non-pack run|not an FRG fixed-pack selector/,
  );
  assert.equal(fs.files.size, 0, "must not write FRG evidence for non-pack runs");
});

test("runFactoryGate --from-run: accepts factory-gate label pack and scores", async () => {
  const fs = memFs();
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-frg",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-frg",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;

  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-frg",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      compositionOverrides: frgRequiredCompositionOverrides("pass"),
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      ...frgPassUniqueOperations("1.29.1"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.pass, true);
  assert.equal(result.evidence.loop_run_id, "loop-frg");
  assert.equal(result.evidence.pack_id, FRG_PACK_MANIFEST.pack_id);
  assert.equal(result.evidence.score_source, "from-run");
  assert.equal(result.evidence.work_list, "factory-gate-pack");
  assert.ok(
    result.evidence.notes.some((n) => n.includes(FRG_PACK_MANIFEST.pack_id)),
  );
  const capacity = result.evidence.scenarios.find((s) => s.id === "capacity-blocked-retain");
  assert.equal(capacity?.status, "pass");
  assert.ok((capacity?.observed ?? 0) >= DEFAULT_FRG_THRESHOLDS.capacity_stress_n);
});

test("runFactoryGate --from-run post-1.33: collects hybrid-v2 provenance when missing (#1118)", async () => {
  const fs = memFs();
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-frg-1392",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "1112", depends_on: [], external_depends_on: [] },
      { id: "1113", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-frg-1392",
    items: {
      "1112": { state: "ready", history: [], recovery_attempts: [], advance_run_id: "adv-1112" },
      "1113": { state: "ready", history: [], recovery_attempts: [], advance_run_id: "adv-1113" },
    },
  } as unknown as LoopLedger;

  const { loadFrgPack, collectFrgPackObservations, renderFrgPackIssues } = await import(
    "../scripts/frg-pack-observations.ts"
  );
  const pack = await loadFrgPack();
  const bundleBase = {
    schema_version: 1 as const,
    policy_id: pack.manifest.pilot_policy.id,
    pack_id: pack.manifest.pack_id,
    manifest_version: pack.manifest.manifest_version,
    manifest_sha256: pack.manifest_sha256,
    release_version: "1.39.2",
    candidate_git_sha: "a".repeat(40),
    pack_run_id: "pack-1392",
    loop_run_id: "loop-frg-1392",
    repository: "owner/repo",
    base_branch: "main",
    started_at: "2026-08-18T02:54:58.000Z",
  };
  const rendered = renderFrgPackIssues(pack, {
    release_version: "1.39.2",
    pack_run_id: "pack-1392",
  });
  const issueNumbers = [1112, 1113];
  const observations = collectFrgPackObservations(pack, {
    ...bundleBase,
    contract: {
      artifact_sha256: "b".repeat(64),
      selector: { type: "label", value: "factory-gate" },
      issue_numbers: issueNumbers,
      items: issueNumbers.map((n) => ({ issue_number: n, depends_on: [] })),
    },
    ledger: {
      artifact_sha256: "c".repeat(64),
      items: issueNumbers.map((n, i) => ({
        issue_number: n,
        state: "ready",
        advance_run_id: `adv-${n}`,
        blocked_theme: i === 0 ? "workflow-engine-defect" : null,
      })),
    },
    events: {
      artifact_sha256: "d".repeat(64),
      event_ids: issueNumbers.map((n) => `event:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    action_evidence: {
      artifact_sha256: "e".repeat(64),
      action_ids: issueNumbers.map((n) => `action:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    issues: rendered.map((issue, index) => {
      const issueNumber = issueNumbers[index]!;
      const head = String(index + 1).repeat(40);
      const files =
        issue.provenance.template_id === "clean-openspec"
          ? ["openspec/changes/archive/2026-08-18-x/proposal.md", "openspec/specs/frg/spec.md"]
          : ["docs/frg-fixture.md"];
      return {
        issue_number: issueNumber,
        issue_node_id: `ISSUE_${issueNumber}`,
        created_at: `2026-08-18T02:55:0${index}.000Z`,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels, "pipeline:ready-to-deploy"],
        template_id: issue.provenance.template_id,
        template_sha256: issue.provenance.template_sha256,
        pr: {
          number: 2100 + index,
          node_id: `PR_${2100 + index}`,
          head_sha: head,
          base_branch: "main",
          files,
          checks: [{ id: `CHECK_${issueNumber}`, name: "ci", head_sha: head, conclusion: "success" }],
        },
      };
    }),
    probes: pack.manifest.pilot_policy.layer_a_probes.map((probe, index) => ({
      id: probe.id,
      candidate_git_sha: "a".repeat(40),
      test_file: probe.test_file,
      test_name: probe.test_name,
      command_argv_sha256: "1".repeat(64),
      stdout_sha256: "2".repeat(64),
      stderr_sha256: "3".repeat(64),
      started_at: `2026-08-18T03:00:${String(index).padStart(2, "0")}.000Z`,
      finished_at: `2026-08-18T03:00:${String(index).padStart(2, "0")}.500Z`,
    })),
  });
  observations.github_item_observations = {
    "1112": r2dGreenObservation(2100),
    "1113": r2dGreenObservation(2101),
  };

  const result = await runFactoryGate(
    {
      version: "1.39.2",
      repoDir: "/repo",
      fromRun: "loop-frg-1392",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      collectHybridV2: async () => observations,
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      ...frgPassUniqueOperations("1.39.2"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.pass, true);
  assert.equal(result.evidence.pack_provenance?.policy_id, "factory-gate-v1-hybrid-v2");
  assert.equal(result.evidence.score_source, "from-run");
});

test("runFactoryGate --from-run forwards request packed candidate and writes latest.json under repoDir (#1298)", async () => {
  const fs = memFs();
  const packedC = "6670cee2b2659bc8350e98c1a2a34b53299b995b";
  const captured: Array<{ repoDir: string; requestCandidateGitSha?: string; fromRun: string }> = [];
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-frg-1298",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "1112", depends_on: [], external_depends_on: [] },
      { id: "1113", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-frg-1298",
    items: {
      "1112": { state: "ready", history: [], recovery_attempts: [], advance_run_id: "adv-1112" },
      "1113": { state: "ready", history: [], recovery_attempts: [], advance_run_id: "adv-1113" },
    },
  } as unknown as LoopLedger;

  const { loadFrgPack, collectFrgPackObservations, renderFrgPackIssues } = await import(
    "../scripts/frg-pack-observations.ts"
  );
  const pack = await loadFrgPack();
  const bundleBase = {
    schema_version: 1 as const,
    policy_id: pack.manifest.pilot_policy.id,
    pack_id: pack.manifest.pack_id,
    manifest_version: pack.manifest.manifest_version,
    manifest_sha256: pack.manifest_sha256,
    release_version: "1.39.15",
    candidate_git_sha: packedC,
    pack_run_id: "pack-1298",
    loop_run_id: "loop-frg-1298",
    repository: "owner/repo",
    base_branch: "main",
    started_at: "2026-08-18T02:54:58.000Z",
  };
  const rendered = renderFrgPackIssues(pack, {
    release_version: "1.39.15",
    pack_run_id: "pack-1298",
  });
  const issueNumbers = [1112, 1113];
  const observations = collectFrgPackObservations(pack, {
    ...bundleBase,
    contract: {
      artifact_sha256: "b".repeat(64),
      selector: { type: "label", value: "factory-gate" },
      issue_numbers: issueNumbers,
      items: issueNumbers.map((n) => ({ issue_number: n, depends_on: [] })),
    },
    ledger: {
      artifact_sha256: "c".repeat(64),
      items: issueNumbers.map((n) => ({
        issue_number: n,
        state: "ready",
        advance_run_id: `adv-${n}`,
        blocked_theme: null,
      })),
    },
    events: {
      artifact_sha256: "d".repeat(64),
      event_ids: issueNumbers.map((n) => `event:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    action_evidence: {
      artifact_sha256: "e".repeat(64),
      action_ids: issueNumbers.map((n) => `action:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    issues: rendered.map((issue, index) => {
      const issueNumber = issueNumbers[index]!;
      const head = String(index + 1).repeat(40);
      const files =
        issue.provenance.template_id === "clean-openspec"
          ? ["openspec/changes/archive/2026-08-18-x/proposal.md", "openspec/specs/frg/spec.md"]
          : ["docs/frg-fixture.md"];
      return {
        issue_number: issueNumber,
        issue_node_id: `ISSUE_${issueNumber}`,
        created_at: `2026-08-18T02:55:0${index}.000Z`,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels, "pipeline:ready-to-deploy"],
        template_id: issue.provenance.template_id,
        template_sha256: issue.provenance.template_sha256,
        pr: {
          number: 2100 + index,
          node_id: `PR_${2100 + index}`,
          head_sha: head,
          base_branch: "main",
          files,
          checks: [{ id: `CHECK_${issueNumber}`, name: "ci", head_sha: head, conclusion: "success" }],
        },
      };
    }),
    probes: pack.manifest.pilot_policy.layer_a_probes.map((probe, index) => ({
      id: probe.id,
      candidate_git_sha: packedC,
      test_file: probe.test_file,
      test_name: probe.test_name,
      command_argv_sha256: "1".repeat(64),
      stdout_sha256: "2".repeat(64),
      stderr_sha256: "3".repeat(64),
      started_at: `2026-08-18T03:00:${String(index).padStart(2, "0")}.000Z`,
      finished_at: `2026-08-18T03:00:${String(index).padStart(2, "0")}.500Z`,
    })),
  });
  observations.github_item_observations = {
    "1112": r2dGreenObservation(2100),
    "1113": r2dGreenObservation(2101),
  };

  const unsigned: FactoryReleaseFrgPayload = {
    pack_id: FRG_PACK_MANIFEST.pack_id,
    manifest_path: "/pack/manifest.json",
    manifest_sha256: pack.manifest_sha256,
    pack_run_id: "pack-1298",
    loop_run_id: "loop-frg-1298",
    frg_run_id: "frg-unsigned-1298",
    evidence_created_at: "2026-08-18T02:54:58Z",
    observations: { path: "/u/obs.json", sha256: "1".repeat(64) },
    evidence_bundle: { path: "/u/bundle.json", sha256: "2".repeat(64) },
    contract: { path: "/u/contract.json", sha256: "3".repeat(64) },
    ledger: { path: "/u/ledger.json", sha256: "4".repeat(64) },
    events: { path: "/u/events.json", sha256: "5".repeat(64) },
    action_evidence: { path: "/u/action.json", sha256: "6".repeat(64) },
  };
  const request: FactoryReleasePrepareRequest = {
    schema_version: 1,
    kind: "factory_release_prepare_request",
    action_id: "action-1298",
    repository: "owner/repo",
    base_branch: "main",
    target_version: "1.39.15",
    integrated_candidate: { git_sha: packedC, version: "1.39.14" },
    production_pin: { version: "1.39.14", tag: "v1.39.14", git_sha: "c".repeat(40) },
    frg_manifest: { pack_id: FRG_PACK_MANIFEST.pack_id, sha256: pack.manifest_sha256 },
  };
  const binding = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
  const expectedB = computeAttestorRunId(binding);
  const result = await runFactoryGate(
    {
      version: "1.39.15",
      repoDir: "/control-repo",
      fromRun: "loop-frg-1298",
      requestCandidateGitSha: packedC,
      resolveShipPathFromRun: async () => ({
        kind: "bound",
        binding,
        unsigned_frg_run_id: unsigned.frg_run_id,
      }),
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      collectHybridV2: async (args) => {
        captured.push({
          repoDir: args.repoDir,
          requestCandidateGitSha: args.requestCandidateGitSha,
          fromRun: args.fromRun,
        });
        return observations;
      },
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      ...frgPassUniqueOperations("1.39.15"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(captured, [
    {
      repoDir: "/control-repo",
      requestCandidateGitSha: packedC,
      fromRun: "loop-frg-1298",
    },
  ]);
  assert.equal(result.latestPath, "/control-repo/.agent-pipeline/frg/1.39.15/latest.json");
  assert.ok(fs.files.has("/control-repo/.agent-pipeline/frg/1.39.15/latest.json"));
  assert.equal(result.evidence.pack_provenance?.candidate_git_sha, packedC);
  assert.equal(result.evidence.run_id, expectedB);
  assert.notEqual(result.evidence.run_id, unsigned.frg_run_id);
  assert.deepEqual(result.evidence.factory_release_binding, binding);
  assert.equal(verifyFrgAttestation(result.evidence, FRG_UNIT_TEST_ATTESTATION_KEY), true);
});

test("ship-path from-run refuses HMAC when scored provenance D differs from bound candidate C (#1295)", async () => {
  const fs = memFs();
  const packedC = "b".repeat(40);
  const packedD = "d".repeat(40);
  const pack = await loadFrgPack();
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-frg-1295-cd",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "1112", depends_on: [], external_depends_on: [] },
      { id: "1113", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-frg-1295-cd",
    items: {
      "1112": { state: "ready", history: [], recovery_attempts: [], advance_run_id: "adv-1112" },
      "1113": { state: "ready", history: [], recovery_attempts: [], advance_run_id: "adv-1113" },
    },
  } as unknown as LoopLedger;
  const rendered = renderFrgPackIssues(pack, {
    release_version: "1.39.15",
    pack_run_id: "pack-1295-cd",
  });
  const issueNumbers = [1112, 1113];
  const observations = collectFrgPackObservations(pack, {
    schema_version: 1,
    policy_id: pack.manifest.pilot_policy.id,
    pack_id: pack.manifest.pack_id,
    manifest_version: pack.manifest.manifest_version,
    manifest_sha256: pack.manifest_sha256,
    release_version: "1.39.15",
    candidate_git_sha: packedD,
    pack_run_id: "pack-1295-cd",
    loop_run_id: "loop-frg-1295-cd",
    repository: "owner/repo",
    base_branch: "main",
    started_at: "2026-08-18T02:54:58.000Z",
    contract: {
      artifact_sha256: "b".repeat(64),
      selector: { type: "label", value: "factory-gate" },
      issue_numbers: issueNumbers,
      items: issueNumbers.map((n) => ({ issue_number: n, depends_on: [] })),
    },
    ledger: {
      artifact_sha256: "c".repeat(64),
      items: issueNumbers.map((n) => ({
        issue_number: n,
        state: "ready",
        advance_run_id: `adv-${n}`,
        blocked_theme: null,
      })),
    },
    events: {
      artifact_sha256: "d".repeat(64),
      event_ids: issueNumbers.map((n) => `event:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    action_evidence: {
      artifact_sha256: "e".repeat(64),
      action_ids: issueNumbers.map((n) => `action:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    issues: rendered.map((issue, index) => {
      const issueNumber = issueNumbers[index]!;
      const head = String(index + 1).repeat(40);
      const files =
        issue.provenance.template_id === "clean-openspec"
          ? ["openspec/changes/archive/2026-08-18-x/proposal.md", "openspec/specs/frg/spec.md"]
          : ["docs/frg-fixture.md"];
      return {
        issue_number: issueNumber,
        issue_node_id: `ISSUE_${issueNumber}`,
        created_at: `2026-08-18T02:55:0${index}.000Z`,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels, "pipeline:ready-to-deploy"],
        template_id: issue.provenance.template_id,
        template_sha256: issue.provenance.template_sha256,
        pr: {
          number: 2100 + index,
          node_id: `PR_${2100 + index}`,
          head_sha: head,
          base_branch: "main",
          files,
          checks: [{ id: `CHECK_${issueNumber}`, name: "ci", head_sha: head, conclusion: "success" }],
        },
      };
    }),
    probes: pack.manifest.pilot_policy.layer_a_probes.map((probe, index) => ({
      id: probe.id,
      candidate_git_sha: packedD,
      test_file: probe.test_file,
      test_name: probe.test_name,
      command_argv_sha256: "1".repeat(64),
      stdout_sha256: "2".repeat(64),
      stderr_sha256: "3".repeat(64),
      started_at: `2026-08-18T03:00:${String(index).padStart(2, "0")}.000Z`,
      finished_at: `2026-08-18T03:00:${String(index).padStart(2, "0")}.500Z`,
    })),
  });
  observations.github_item_observations = {
    "1112": r2dGreenObservation(2100),
    "1113": r2dGreenObservation(2101),
  };

  const unsigned: FactoryReleaseFrgPayload = {
    pack_id: FRG_PACK_MANIFEST.pack_id,
    manifest_path: "/pack/manifest.json",
    manifest_sha256: pack.manifest_sha256,
    pack_run_id: "pack-1295-cd",
    loop_run_id: "loop-frg-1295-cd",
    frg_run_id: "frg-unsigned-1295-cd",
    evidence_created_at: "2026-08-18T02:54:58Z",
    observations: { path: "/u/obs.json", sha256: "1".repeat(64) },
    evidence_bundle: { path: "/u/bundle.json", sha256: "2".repeat(64) },
    contract: { path: "/u/contract.json", sha256: "3".repeat(64) },
    ledger: { path: "/u/ledger.json", sha256: "4".repeat(64) },
    events: { path: "/u/events.json", sha256: "5".repeat(64) },
    action_evidence: { path: "/u/action.json", sha256: "6".repeat(64) },
  };
  const request: FactoryReleasePrepareRequest = {
    schema_version: 1,
    kind: "factory_release_prepare_request",
    action_id: "action-1295-cd",
    repository: "owner/repo",
    base_branch: "main",
    target_version: "1.39.15",
    integrated_candidate: { git_sha: packedC, version: "1.39.14" },
    production_pin: { version: "1.39.14", tag: "v1.39.14", git_sha: "c".repeat(40) },
    frg_manifest: { pack_id: FRG_PACK_MANIFEST.pack_id, sha256: pack.manifest_sha256 },
  };
  const binding = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
  assert.equal(binding.candidate_git_sha, packedC);
  assert.equal(observations.pack_provenance.candidate_git_sha, packedD);

  await assert.rejects(
    () =>
      runFactoryGate(
        {
          version: "1.39.15",
          repoDir: "/control-repo",
          fromRun: "loop-frg-1295-cd",
          requestCandidateGitSha: packedC,
          resolveShipPathFromRun: async () => ({
            kind: "bound",
            binding,
            unsigned_frg_run_id: unsigned.frg_run_id,
          }),
          loadLedger: async () => ledger,
          loadContract: async () => packContract,
          collectHybridV2: async () => observations,
          attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
          stdout: () => {},
          stderr: () => {},
        },
        fs,
      ),
    /scored pack_provenance\.candidate_git_sha=d+ does not match factory_release_binding\.candidate_git_sha=b+/,
  );
  assert.equal(fs.files.has("/control-repo/.agent-pipeline/frg/1.39.15/latest.json"), false);
});

test("runFactoryGate --from-run: requires loadContract (pack validation seam)", async () => {
  await assert.rejects(
    () =>
      runFactoryGate({
        version: "1.29.1",
        repoDir: "/repo",
        fromRun: "loop-x",
        loadLedger: async () =>
          ({
            schema: LOOP_LEDGER_SCHEMA,
            run_id: "loop-x",
            items: {},
          }) as unknown as LoopLedger,
        stdout: () => {},
        stderr: () => {},
      }),
    /requires a contract loader/,
  );
});

test("validateFrgPackContract: fixed-pack manifest enforces selector + multi-item", () => {
  assert.equal(isAllowedFrgPackSelector({ type: "label", value: "factory-gate" }), true);
  assert.equal(isAllowedFrgPackSelector({ type: "milestone", value: "v2" }), false);
  assert.equal(isAllowedFrgPackSelector({ type: "work-list", value: ["1", "2"] }), false);

  const ok = validateFrgPackContract({
    schema: LOOP_CONTRACT_SCHEMA,
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "1", depends_on: [], external_depends_on: [] },
      { id: "2", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract);
  assert.equal(ok.ok, true);

  const single = validateFrgPackContract({
    schema: LOOP_CONTRACT_SCHEMA,
    selector: { type: "label", value: "factory-gate" },
    items: [{ id: "1", depends_on: [], external_depends_on: [] }],
  } as unknown as LoopContract);
  assert.equal(single.ok, false);
  if (!single.ok) assert.match(single.detail, /≥2 items/);
});

test("itemsFromLoopLedger projects ready/blocked themes", () => {
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-1",
    items: {
      "10": {
        state: "ready",
        history: [],
        recovery_attempts: [],
      },
      "20": {
        state: "blocked",
        blocked_theme: "workflow-engine-defect",
        evidence_fingerprint: "abc",
        history: [],
        recovery_attempts: [],
      },
    },
  } as unknown as LoopLedger;
  const items = itemsFromLoopLedger(ledger);
  assert.equal(items.length, 2);
  assert.ok(items.some((i) => i.item_id === "10" && i.ready_clean === true));
  assert.ok(items.some((i) => i.item_id === "20" && i.blocker_theme === "workflow-engine-defect"));
});

const STALE_PACK_SIBLING = "1289";
const STALE_PACK_ITEM = "1290";
const STALE_PACK_STOP_TIME = "2026-08-29T19:00:00.000Z";

function staleBlockedPackLedger(): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-15af2f73748bf10e",
    items: {
      [STALE_PACK_SIBLING]: { state: "ready", history: [], recovery_attempts: [] },
      [STALE_PACK_ITEM]: {
        state: "blocked",
        blocked_theme: "implementation-ci",
        history: [],
        recovery_attempts: [],
      },
    },
    stop: {
      reason: "recovery_exhausted",
      time: STALE_PACK_STOP_TIME,
      item_id: STALE_PACK_ITEM,
      theme: "implementation-ci",
    },
  } as unknown as LoopLedger;
}

function staleBlockedPackContract(runId = "loop-15af2f73748bf10e"): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: runId,
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: STALE_PACK_SIBLING, depends_on: [], external_depends_on: [] },
      { id: STALE_PACK_ITEM, depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
}

function r2dGreenObservation(prNumber: number): FrgGitHubItemObservation {
  return {
    labels: ["factory-gate", "pipeline:ready-to-deploy"],
    pr_number: prNumber,
    checks: [{ conclusion: "success" }],
  };
}

async function hybridV2CollectForStaleBlockedPack(
  observations: Record<string, FrgGitHubItemObservation>,
): Promise<CollectedFrgObservations> {
  const pack = await loadFrgPack();
  const issueNumbers = [Number(STALE_PACK_SIBLING), Number(STALE_PACK_ITEM)];
  const bundleBase = {
    schema_version: 1 as const,
    policy_id: pack.manifest.pilot_policy.id,
    pack_id: pack.manifest.pack_id,
    manifest_version: pack.manifest.manifest_version,
    manifest_sha256: pack.manifest_sha256,
    release_version: "1.39.6",
    candidate_git_sha: "a".repeat(40),
    pack_run_id: "pack-1297",
    loop_run_id: "loop-15af2f73748bf10e",
    repository: "owner/repo",
    base_branch: "main",
    started_at: "2026-08-29T18:00:00.000Z",
  };
  const rendered = renderFrgPackIssues(pack, {
    release_version: "1.39.6",
    pack_run_id: "pack-1297",
  });
  const collected = collectFrgPackObservations(pack, {
    ...bundleBase,
    contract: {
      artifact_sha256: "b".repeat(64),
      selector: { type: "label", value: "factory-gate" },
      issue_numbers: issueNumbers,
      items: issueNumbers.map((n) => ({ issue_number: n, depends_on: [] })),
    },
    ledger: {
      artifact_sha256: "c".repeat(64),
      items: issueNumbers.map((n) => ({
        issue_number: n,
        state: "ready",
        advance_run_id: `adv-${n}`,
        blocked_theme: n === Number(STALE_PACK_ITEM) ? "implementation-ci" : null,
      })),
    },
    events: {
      artifact_sha256: "d".repeat(64),
      event_ids: issueNumbers.map((n) => `event:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    action_evidence: {
      artifact_sha256: "e".repeat(64),
      action_ids: issueNumbers.map((n) => `action:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    issues: rendered.map((issue, index) => {
      const issueNumber = issueNumbers[index]!;
      const head = String(index + 1).repeat(40);
      const files =
        issue.provenance.template_id === "clean-openspec"
          ? ["openspec/changes/archive/2026-08-18-x/proposal.md", "openspec/specs/frg/spec.md"]
          : ["docs/frg-fixture.md"];
      return {
        issue_number: issueNumber,
        issue_node_id: `ISSUE_${issueNumber}`,
        created_at: `2026-08-29T18:00:0${index}.000Z`,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels, "pipeline:ready-to-deploy"],
        template_id: issue.provenance.template_id,
        template_sha256: issue.provenance.template_sha256,
        pr: {
          number: 2100 + index,
          node_id: `PR_${2100 + index}`,
          head_sha: head,
          base_branch: "main",
          files,
          checks: [{ id: `CHECK_${issueNumber}`, name: "ci", head_sha: head, conclusion: "success" }],
        },
      };
    }),
    probes: pack.manifest.pilot_policy.layer_a_probes.map((probe, index) => ({
      id: probe.id,
      candidate_git_sha: "a".repeat(40),
      test_file: probe.test_file,
      test_name: probe.test_name,
      command_argv_sha256: "1".repeat(64),
      stdout_sha256: "2".repeat(64),
      stderr_sha256: "3".repeat(64),
      started_at: `2026-08-29T18:01:${String(index).padStart(2, "0")}.000Z`,
      finished_at: `2026-08-29T18:01:${String(index).padStart(2, "0")}.500Z`,
    })),
  });
  return { ...collected, github_item_observations: observations };
}

test("itemsFromLoopLedger stays a pure projector on blocked + recovery_exhausted (#1297)", () => {
  const items = itemsFromLoopLedger(staleBlockedPackLedger());
  const stale = items.find((i) => i.item_id === STALE_PACK_ITEM);
  assert.equal(stale?.state, "blocked");
  assert.equal(stale?.ready_clean, false);
  const sibling = items.find((i) => i.item_id === STALE_PACK_SIBLING);
  assert.equal(sibling?.ready_clean, true);
});

test("projectFrgItemsWithGitHubOverlay promotes blocked to ready_clean on bound R2D + green (#1297)", () => {
  const overlaid = projectFrgItemsWithGitHubOverlay(itemsFromLoopLedger(staleBlockedPackLedger()), {
    [STALE_PACK_SIBLING]: r2dGreenObservation(1288),
    [STALE_PACK_ITEM]: r2dGreenObservation(1292),
  });
  assert.equal(overlaid.filter((i) => i.ready_clean).length, 2);
  assert.equal(overlaid.find((i) => i.item_id === STALE_PACK_ITEM)?.state, "ready");
});

test("projectFrgItemsWithGitHubOverlay is fail-closed (#1297)", () => {
  const ledgerItems = itemsFromLoopLedger(staleBlockedPackLedger());
  const cases: Array<{ name: string; obs: FrgGitHubItemObservation | undefined }> = [
    {
      name: "missing R2D label",
      obs: {
        labels: ["factory-gate", "pipeline:ready"],
        pr_number: 1292,
        checks: [{ conclusion: "success" }],
      },
    },
    {
      name: "failed checks",
      obs: {
        labels: ["pipeline:ready-to-deploy"],
        pr_number: 1292,
        checks: [{ conclusion: "failure" }],
      },
    },
    {
      name: "pending checks",
      obs: {
        labels: ["pipeline:ready-to-deploy"],
        pr_number: 1292,
        checks: [{ conclusion: "pending" }],
      },
    },
    {
      name: "absent PR",
      obs: {
        labels: ["pipeline:ready-to-deploy"],
        pr_number: null,
        checks: [{ conclusion: "success" }],
      },
    },
    {
      name: "unreadable GitHub",
      obs: undefined,
    },
    {
      name: "needs-human without R2D",
      obs: {
        labels: ["pipeline:needs-human"],
        pr_number: 1292,
        checks: [{ conclusion: "success" }],
      },
    },
  ];
  for (const row of cases) {
    const observations: Record<string, FrgGitHubItemObservation> = {
      [STALE_PACK_SIBLING]: r2dGreenObservation(1288),
    };
    if (row.obs) observations[STALE_PACK_ITEM] = row.obs;
    const overlaid = projectFrgItemsWithGitHubOverlay(ledgerItems, observations);
    assert.equal(
      overlaid.find((i) => i.item_id === STALE_PACK_ITEM)?.ready_clean,
      false,
      row.name,
    );
  }
  const unboundOtherPr = projectFrgItemsWithGitHubOverlay(ledgerItems, {
    [STALE_PACK_SIBLING]: r2dGreenObservation(1288),
    "9999": r2dGreenObservation(9999),
  });
  assert.equal(unboundOtherPr.find((i) => i.item_id === STALE_PACK_ITEM)?.ready_clean, false);
});

test("projectFrgItemsWithGitHubOverlay fail-closes ledger-ready without GitHub (#1297)", () => {
  const ledgerItems = itemsFromLoopLedger(staleBlockedPackLedger());
  const sibling = ledgerItems.find((i) => i.item_id === STALE_PACK_SIBLING);
  assert.equal(sibling?.state, "ready");
  assert.equal(sibling?.ready_clean, true);

  const missing = projectFrgItemsWithGitHubOverlay(ledgerItems, {
    [STALE_PACK_ITEM]: r2dGreenObservation(1292),
  });
  assert.equal(missing.find((i) => i.item_id === STALE_PACK_SIBLING)?.ready_clean, false);
  assert.equal(missing.find((i) => i.item_id === STALE_PACK_SIBLING)?.state, "blocked");

  const unbound = projectFrgItemsWithGitHubOverlay(ledgerItems, {
    [STALE_PACK_SIBLING]: {
      labels: ["factory-gate", "pipeline:ready-to-deploy"],
      pr_number: null,
      checks: [{ conclusion: "success" }],
    },
    [STALE_PACK_ITEM]: r2dGreenObservation(1292),
  });
  assert.equal(unbound.find((i) => i.item_id === STALE_PACK_SIBLING)?.ready_clean, false);
  assert.equal(unbound.find((i) => i.item_id === STALE_PACK_SIBLING)?.state, "blocked");
});

test("projectFrgItemsWithGitHubOverlay fail-closes ledger merged and released without GitHub proof (#1297)", () => {
  const failClosed: Array<{ name: string; obs: FrgGitHubItemObservation | undefined }> = [
    { name: "missing", obs: undefined },
    {
      name: "unbound",
      obs: {
        labels: ["factory-gate", "pipeline:ready-to-deploy"],
        pr_number: null,
        checks: [{ conclusion: "success" }],
      },
    },
    {
      name: "non-R2D",
      obs: {
        labels: ["factory-gate", "pipeline:ready"],
        pr_number: 1292,
        checks: [{ conclusion: "success" }],
      },
    },
    {
      name: "failed checks",
      obs: {
        labels: ["pipeline:ready-to-deploy"],
        pr_number: 1292,
        checks: [{ conclusion: "failure" }],
      },
    },
    {
      name: "pending checks",
      obs: {
        labels: ["pipeline:ready-to-deploy"],
        pr_number: 1292,
        checks: [{ conclusion: "pending" }],
      },
    },
  ];
  for (const ledgerState of ["merged", "released"] as const) {
    const ledgerItems = itemsFromLoopLedger({
      schema: LOOP_LEDGER_SCHEMA,
      run_id: "loop-15af2f73748bf10e",
      items: {
        [STALE_PACK_ITEM]: { state: ledgerState, history: [], recovery_attempts: [] },
      },
    } as unknown as LoopLedger);
    assert.equal(ledgerItems[0]?.ready_clean, true, `${ledgerState} ledger-only`);
    for (const row of failClosed) {
      const observations: Record<string, FrgGitHubItemObservation> = {};
      if (row.obs) observations[STALE_PACK_ITEM] = row.obs;
      const overlaid = projectFrgItemsWithGitHubOverlay(ledgerItems, observations);
      assert.equal(
        overlaid[0]?.ready_clean,
        false,
        `${ledgerState} ${row.name} ready_clean`,
      );
      assert.equal(overlaid[0]?.state, "blocked", `${ledgerState} ${row.name} state`);
    }
    const proven = projectFrgItemsWithGitHubOverlay(ledgerItems, {
      [STALE_PACK_ITEM]: r2dGreenObservation(1292),
    });
    assert.equal(proven[0]?.ready_clean, true, `${ledgerState} proven ready_clean`);
    assert.equal(proven[0]?.state, ledgerState, `${ledgerState} proven preserves terminal`);
  }
});

test("factory-gate --from-run overlays GitHub R2D over recovery_exhausted blocked ledger (#1297)", async () => {
  const fs = memFs();
  const ledger = staleBlockedPackLedger();
  const projected = itemsFromLoopLedger(ledger);
  assert.equal(projected.filter((i) => i.ready_clean).length, 1);
  const collected = await hybridV2CollectForStaleBlockedPack({
    [STALE_PACK_SIBLING]: r2dGreenObservation(1288),
    [STALE_PACK_ITEM]: r2dGreenObservation(1292),
  });
  const result = await runFactoryGate(
    {
      version: "1.39.6",
      repoDir: "/repo",
      fromRun: "loop-15af2f73748bf10e",
      loadLedger: async () => ledger,
      loadContract: async () => staleBlockedPackContract(),
      collectHybridV2: async () => collected,
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      ...frgPassUniqueOperations("1.39.6"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  const throughput = result.evidence.scenarios.find((s) => s.id === "clean-item-throughput");
  assert.equal(result.evidence.scoreboard.ready_clean_count, 2);
  assert.equal(throughput?.observed, 2);
  assert.equal(throughput?.threshold, DEFAULT_FRG_THRESHOLDS.min_clean_ready_to_deploy);
  assert.notEqual(throughput?.observed, 1);
});

test("defaultScoreBoundPackLoop overlays GitHub R2D over recovery_exhausted blocked ledger (#1297)", async () => {
  const ledger = staleBlockedPackLedger();
  const collected = await hybridV2CollectForStaleBlockedPack({
    [STALE_PACK_SIBLING]: r2dGreenObservation(1288),
    [STALE_PACK_ITEM]: r2dGreenObservation(1292),
  });
  const pack = await loadFrgPack();
  const scored = await defaultScoreBoundPackLoop({
    version: "1.39.6",
    fromRun: "loop-15af2f73748bf10e",
    repoDir: "/repo",
    request: {
      schema_version: 1,
      kind: "factory_release_prepare_request",
      action_id: "action-1297",
      repository: "org/agent-pipeline",
      base_branch: "main",
      target_version: "1.39.6",
      milestone: "v1.39.6",
      integrated_candidate: { git_sha: "b".repeat(40), version: "1.39.5" },
      production_pin: { version: "1.39.5", tag: "v1.39.5", git_sha: "c".repeat(40) },
      frg_manifest: { pack_id: "factory-gate-v1", sha256: "a".repeat(64) },
    },
    loop: {
      loop_run_id: "loop-15af2f73748bf10e",
      contract_text: JSON.stringify(staleBlockedPackContract()),
      ledger_text: JSON.stringify(ledger),
      events_text: "\n",
      action_evidence_text: "{}\n",
    },
    pack,
    now: () => new Date("2026-08-29T19:00:00.000Z"),
    collectHybridV2: async () => collected,
  });
  const throughput = scored.evidence.scenarios.find((s) => s.id === "clean-item-throughput");
  assert.equal(scored.evidence.scoreboard.ready_clean_count, 2);
  assert.equal(throughput?.observed, 2);
  assert.notEqual(throughput?.observed, 1);
});

test("detectEmptyDependsOnStackHonesty warns on multi empty-depends_on", () => {
  const contract = {
    schema: LOOP_CONTRACT_SCHEMA,
    items: [
      { id: "1", depends_on: [] },
      { id: "2", depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = { schema: LOOP_LEDGER_SCHEMA, run_id: "r", items: {} } as unknown as LoopLedger;
  const o = detectEmptyDependsOnStackHonesty(contract, ledger);
  assert.ok(o);
  assert.equal(o!.id, "empty-depends-on-stack-honesty");
  assert.equal(o!.status, "warn");
});

test("paths are stable under .agent-pipeline/frg", () => {
  assert.equal(
    frgLatestPath("/repo", "1.2.3"),
    "/repo/.agent-pipeline/frg/1.2.3/latest.json",
  );
  assert.equal(
    frgRunEvidencePath("/repo", "1.2.3", "frg-x"),
    "/repo/.agent-pipeline/frg/1.2.3/frg-x/evidence.json",
  );
});

// ---------------------------------------------------------------------------
// Post-pass pack auto-close (#754)
// ---------------------------------------------------------------------------

function fakePackCloseDeps(opts: {
  issues?: Record<
    number,
    {
      state: "open" | "closed";
      labels: string[];
      /** Single open PR (convenience); prefer `prs` when multiple. */
      pr?: number | null;
      /** All open associated PRs for the issue (#754 multi-PR disposition). */
      prs?: number[];
    }
  >;
  closePrImpl?: (pr: number, comment: string) => Promise<void>;
  closeIssueImpl?: (issue: number, comment: string) => Promise<void>;
}): FrgPackCloseDeps & {
  closedPrs: { pr: number; comment: string }[];
  closedIssues: { issue: number; comment: string }[];
  mergeCalls: number;
} {
  const issues = opts.issues ?? {};
  const closedPrs: { pr: number; comment: string }[] = [];
  const closedIssues: { issue: number; comment: string }[] = [];
  return {
    closedPrs,
    closedIssues,
    mergeCalls: 0,
    getIssueStateAndLabels: async (n) => {
      const row = issues[n];
      if (!row) return null;
      return { state: row.state, labels: row.labels };
    },
    findOpenPrsForIssue: async (n) => {
      const row = issues[n];
      if (!row) return [];
      if (row.prs !== undefined) return [...row.prs];
      if (row.pr === undefined || row.pr === null) return [];
      return [row.pr];
    },
    closePr: async (pr, comment) => {
      if (opts.closePrImpl) return opts.closePrImpl(pr, comment);
      closedPrs.push({ pr, comment });
    },
    closeIssue: async (issue, comment) => {
      if (opts.closeIssueImpl) return opts.closeIssueImpl(issue, comment);
      closedIssues.push({ issue, comment });
    },
  };
}

test("formatFrgPackCloseComment is deterministic and cites version + run_id", () => {
  const c = formatFrgPackCloseComment("1.29.1", "frg-abc");
  assert.match(c, /FRG 1\.29\.1 pass \(run_id=frg-abc\)/);
  assert.match(c, /closing without merge/);
  assert.equal(c, formatFrgPackCloseComment("1.29.1", "frg-abc"));
});

test("parseFrgItemIssueNumber accepts positive integers only", () => {
  assert.equal(parseFrgItemIssueNumber("749"), 749);
  assert.equal(parseFrgItemIssueNumber(" 10 "), 10);
  assert.equal(parseFrgItemIssueNumber("0"), null);
  assert.equal(parseFrgItemIssueNumber("-1"), null);
  assert.equal(parseFrgItemIssueNumber("issue-10"), null);
  assert.equal(parseFrgItemIssueNumber(""), null);
});

test("packLabelFromSelector uses label value or factory-gate default", () => {
  assert.equal(packLabelFromSelector({ type: "label", value: "factory-gate" }), "factory-gate");
  assert.equal(packLabelFromSelector({ type: "milestone", value: "frg-pack" }), "factory-gate");
  assert.equal(packLabelFromSelector(null), "factory-gate");
});

test("selectReadyCleanPackIssueNumbers only includes ready_clean scored items", () => {
  const selected = selectReadyCleanPackIssueNumbers({
    item_count: 3,
    ready_clean_count: 1,
    engine_class_count: 0,
    product_class_count: 0,
    human_authority_count: 0,
    engine_class_rate: null,
    per_item: [
      { item_id: "10", state: "ready", ready_clean: true, blocker_theme: null, blocker_class: null },
      { item_id: "20", state: "blocked", ready_clean: false, blocker_theme: null, blocker_class: null },
      { item_id: "not-a-number", state: "ready", ready_clean: true, blocker_theme: null, blocker_class: null },
    ],
  });
  assert.deepEqual(selected, [{ item_id: "10", issueNumber: 10 }]);
});

test("closeFrgPackArtifacts: closes open pack PR+issue with standard comment", async () => {
  const evidence = computeFrgEvidence(fullPackPassInput({ run_id: "frg-close-1" }));
  assert.equal(evidence.pass, true);
  const deps = fakePackCloseDeps({
    issues: {
      1: { state: "open", labels: ["factory-gate"], pr: 101 },
      2: { state: "open", labels: ["factory-gate"], pr: 102 },
    },
  });
  const result = await closeFrgPackArtifacts(evidence, "factory-gate", deps);
  const comment = formatFrgPackCloseComment(evidence.version, evidence.run_id);
  assert.deepEqual(result.closedPrs.sort((a, b) => a - b), [101, 102]);
  assert.deepEqual(result.closedIssues.sort((a, b) => a - b), [1, 2]);
  assert.equal(result.errors.length, 0);
  assert.ok(deps.closedPrs.every((c) => c.comment === comment));
  assert.ok(deps.closedIssues.every((c) => c.comment === comment));
  assert.equal(deps.mergeCalls, 0);
});

test("closeFrgPackArtifacts: closes every open PR for one ready_clean issue (#754 multi-PR)", async () => {
  // fullPackPassInput scores items 1 and 2 ready_clean; multi-PR only on #1.
  const evidence = computeFrgEvidence(fullPackPassInput({ run_id: "frg-multi-pr" }));
  assert.equal(evidence.pass, true);
  const deps = fakePackCloseDeps({
    issues: {
      // Replacement PR + abandoned draft both still open for the same pack item.
      1: { state: "open", labels: ["factory-gate"], prs: [201, 202] },
      2: { state: "open", labels: ["factory-gate"], pr: 102 },
    },
  });
  const result = await closeFrgPackArtifacts(evidence, "factory-gate", deps);
  assert.deepEqual(result.closedPrs.sort((a, b) => a - b), [102, 201, 202]);
  assert.deepEqual(result.closedIssues.sort((a, b) => a - b), [1, 2]);
  assert.equal(result.errors.length, 0);
  // Fail-soft still closes remaining PRs when one of several fails for the same issue.
  const soft = fakePackCloseDeps({
    issues: {
      1: { state: "open", labels: ["factory-gate"], prs: [301, 302] },
      2: { state: "open", labels: ["factory-gate"], pr: 102 },
    },
  });
  soft.closePr = async (pr, comment) => {
    if (pr === 301) throw new Error("simulated close of first of two PRs");
    soft.closedPrs.push({ pr, comment });
  };
  const softResult = await closeFrgPackArtifacts(evidence, "factory-gate", soft);
  assert.ok(softResult.errors.some((e) => /PR #301/.test(e)));
  assert.deepEqual(softResult.closedPrs.sort((a, b) => a - b), [102, 302]);
  assert.deepEqual(softResult.closedIssues.sort((a, b) => a - b), [1, 2]);
});

test("closeFrgPackArtifacts: skips issues missing pack label (product never closed)", async () => {
  const evidence = computeFrgEvidence(fullPackPassInput());
  const deps = fakePackCloseDeps({
    issues: {
      1: { state: "open", labels: ["factory-gate"], pr: 101 },
      2: { state: "open", labels: ["pipeline:ready-to-deploy"], pr: 999 },
    },
  });
  const result = await closeFrgPackArtifacts(evidence, "factory-gate", deps);
  assert.deepEqual(result.closedPrs, [101]);
  assert.deepEqual(result.closedIssues, [1]);
  assert.ok(result.skipped.some((s) => s.issueNumber === 2 && /missing pack label/.test(s.reason)));
  assert.equal(deps.closedPrs.some((c) => c.pr === 999), false);
});

test("closeFrgPackArtifacts: already-closed resources skip without error", async () => {
  const evidence = computeFrgEvidence(fullPackPassInput());
  const deps = fakePackCloseDeps({
    issues: {
      1: { state: "closed", labels: ["factory-gate"], pr: null },
      2: { state: "open", labels: ["factory-gate"], pr: null },
    },
  });
  const result = await closeFrgPackArtifacts(evidence, "factory-gate", deps);
  assert.deepEqual(result.closedIssues, [2]);
  assert.ok(result.skipped.some((s) => s.issueNumber === 1 && /already closed/.test(s.reason)));
  assert.equal(result.errors.length, 0);
});

test("closeFrgPackArtifacts: close error is fail-soft (best-effort continues)", async () => {
  const evidence = computeFrgEvidence(fullPackPassInput({ run_id: "frg-soft" }));
  const deps = fakePackCloseDeps({
    issues: {
      1: { state: "open", labels: ["factory-gate"], pr: 101 },
      2: { state: "open", labels: ["factory-gate"], pr: 102 },
    },
  });
  deps.closePr = async (pr, comment) => {
    if (pr === 101) throw new Error("simulated gh pr close failure");
    deps.closedPrs.push({ pr, comment });
  };
  const result = await closeFrgPackArtifacts(evidence, "factory-gate", deps);
  assert.ok(result.errors.some((e) => /PR #101/.test(e)));
  assert.deepEqual(result.closedPrs, [102]);
  assert.deepEqual(result.closedIssues.sort((a, b) => a - b), [1, 2]);
});

test("runFactoryGate: release-eligible pass closes pack artifacts via injected deps", async () => {
  const fs = memFs();
  const deps = fakePackCloseDeps({
    issues: {
      10: { state: "open", labels: ["factory-gate"], pr: 751 },
      20: { state: "open", labels: ["factory-gate"], pr: 752 },
    },
  });
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-close",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-close",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;

  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-close",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      compositionOverrides: frgRequiredCompositionOverrides("pass"),
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      packCloseDeps: deps,
      ...frgPassUniqueOperations("1.29.1"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.pass, true);
  assert.ok(result.evidencePath);
  assert.ok(result.packClose);
  assert.deepEqual(result.packClose!.closedPrs.sort((a, b) => a - b), [751, 752]);
  assert.deepEqual(result.packClose!.closedIssues.sort((a, b) => a - b), [10, 20]);
  const comment = formatFrgPackCloseComment(result.evidence.version, result.evidence.run_id);
  assert.ok(deps.closedPrs.every((c) => c.comment === comment));
  // Evidence still on disk with pass true
  const latest = await fs.readFile(frgLatestPath("/repo", "1.29.1"));
  assert.equal(JSON.parse(latest).pass, true);
});

test("runFactoryGate: pass:false does not close pack artifacts", async () => {
  const fs = memFs();
  const deps = fakePackCloseDeps({
    issues: {
      10: { state: "open", labels: ["factory-gate"], pr: 1 },
      20: { state: "open", labels: ["factory-gate"], pr: 2 },
    },
  });
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-fail",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  // Only one ready item → clean-item-throughput fails K=2
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-fail",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "blocked", blocked_theme: "implementation-ci", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;

  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-fail",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      compositionOverrides: frgRequiredCompositionOverrides("pass"),
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      packCloseDeps: deps,
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.packClose, null);
  assert.equal(deps.closedPrs.length, 0);
  assert.equal(deps.closedIssues.length, 0);
});

test("runFactoryGate: non-release-eligible offline score does not close", async () => {
  const fs = memFs();
  const deps = fakePackCloseDeps({
    issues: {
      1: { state: "open", labels: ["factory-gate"], pr: 9 },
      2: { state: "open", labels: ["factory-gate"], pr: 10 },
    },
  });
  // scoreInput without writeEvidence: pass is false without loop/pack provenance
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      scoreInput: {
        version: "1.29.1",
        run_id: "offline",
        loop_run_id: null,
        pack_id: null,
        items: [
          { item_id: "1", state: "ready", ready_clean: true },
          { item_id: "2", state: "ready", ready_clean: true },
        ],
        scenario_overrides: frgRequiredObservationOverrides("pass"),
      },
      packCloseDeps: deps,
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, false);
  assert.equal(result.packClose, null);
  assert.equal(deps.closedPrs.length, 0);
});

test("runFactoryGate: --no-close-pack skips closes while keeping pass", async () => {
  const fs = memFs();
  const deps = fakePackCloseDeps({
    issues: {
      10: { state: "open", labels: ["factory-gate"], pr: 751 },
      20: { state: "open", labels: ["factory-gate"], pr: 752 },
    },
  });
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-optout",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-optout",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;
  const stderrLines: string[] = [];

  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-optout",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      compositionOverrides: frgRequiredCompositionOverrides("pass"),
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      noClosePack: true,
      packCloseDeps: deps,
      ...frgPassUniqueOperations("1.29.1"),
      stdout: () => {},
      stderr: (m) => stderrLines.push(m),
    },
    fs,
  );
  assert.equal(result.evidence.pass, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.packClose, null);
  assert.equal(deps.closedPrs.length, 0);
  assert.equal(deps.closedIssues.length, 0);
  assert.ok(stderrLines.some((l) => /--no-close-pack/.test(l)));
  assert.ok(fs.files.has(frgLatestPath("/repo", "1.29.1")));
});

test("runFactoryGate: close error leaves pass and evidence intact (fail-soft)", async () => {
  const fs = memFs();
  const deps = fakePackCloseDeps({
    issues: {
      10: { state: "open", labels: ["factory-gate"], pr: 751 },
      20: { state: "open", labels: ["factory-gate"], pr: 752 },
    },
  });
  deps.closePr = async () => {
    throw new Error("github unavailable");
  };
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-soft",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-soft",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;

  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-soft",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      compositionOverrides: frgRequiredCompositionOverrides("pass"),
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      packCloseDeps: deps,
      ...frgPassUniqueOperations("1.29.1"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, true);
  assert.equal(result.exitCode, 0);
  assert.ok(result.packClose);
  assert.ok(result.packClose!.errors.length >= 1);
  // Issues still closed (PR close failed but issue path continues)
  assert.deepEqual(result.packClose!.closedIssues.sort((a, b) => a - b), [10, 20]);
  const onDisk = JSON.parse(await fs.readFile(result.evidencePath!));
  assert.equal(onDisk.pass, true);
  assert.equal(onDisk.run_id, result.evidence.run_id);
});

test("runFactoryGate: without packCloseDeps, release pass does not call network (no-op close)", async () => {
  // Regression / bite: production hook is optional when deps omitted; pass still writes.
  const fs = memFs();
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-nodeps",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-nodeps",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-nodeps",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      compositionOverrides: frgRequiredCompositionOverrides("pass"),
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      ...frgPassUniqueOperations("1.29.1"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, true);
  assert.equal(result.packClose, null);
});

test("runFactoryGate: item absent from scoreboard never closed even if labeled factory-gate", async () => {
  const fs = memFs();
  // Scoreboard only has 10 and 20; issue 999 is labeled but not on the scored run.
  const lookedUp: number[] = [];
  const deps = fakePackCloseDeps({
    issues: {
      10: { state: "open", labels: ["factory-gate"], pr: 1 },
      20: { state: "open", labels: ["factory-gate"], pr: 2 },
      999: { state: "open", labels: ["factory-gate"], pr: 999 },
    },
  });
  const baseLookup = deps.getIssueStateAndLabels;
  deps.getIssueStateAndLabels = async (n) => {
    lookedUp.push(n);
    return baseLookup(n);
  };
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-scope",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-scope",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-scope",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      compositionOverrides: frgRequiredCompositionOverrides("pass"),
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      packCloseDeps: deps,
      ...frgPassUniqueOperations("1.29.1"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, true);
  assert.ok(!result.packClose!.closedIssues.includes(999));
  assert.ok(!result.packClose!.closedPrs.includes(999));
  assert.ok(!lookedUp.includes(999), "must not repo-wide sweep factory-gate issues");
  assert.deepEqual(result.packClose!.closedIssues.sort((a, b) => a - b), [10, 20]);
});

// ---------------------------------------------------------------------------
// #757: trend ledger, observations CLI parse, integrity, validate-tag
// ---------------------------------------------------------------------------

test("writeFrgEvidence appends trend ledger; duplicate (version,run_id) is idempotent", async () => {
  const fs = memFs();
  const a = computeFrgEvidence(fullPackPassInput({ version: "1.30.0", run_id: "frg-ledger-a" }));
  await writeFrgEvidence("/repo", a, fs);
  const ledgerPath = frgTrendLedgerPath("/repo");
  assert.ok(fs.files.has(ledgerPath));
  let body = await fs.readFile(ledgerPath);
  assert.equal(body.trim().split("\n").length, 1);
  const entry = JSON.parse(body.trim());
  assert.equal(entry.version, "1.30.0");
  assert.equal(entry.run_id, "frg-ledger-a");
  assert.equal(entry.engine_class_rate, 0);
  assert.ok(entry.thresholds);

  // Same key again → no-op
  await writeFrgEvidence("/repo", a, fs);
  body = await fs.readFile(ledgerPath);
  assert.equal(body.trim().split("\n").length, 1);

  // Multi-release history retained
  const b = computeFrgEvidence(fullPackPassInput({ version: "1.30.1", run_id: "frg-ledger-b" }));
  await writeFrgEvidence("/repo", b, fs);
  body = await fs.readFile(ledgerPath);
  const lines = body.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => l.includes("1.30.0")));
  assert.ok(lines.some((l) => l.includes("1.30.1")));
});

test("writeFrgEvidence: ledger I/O failure is fail-soft (evidence retained)", async () => {
  const base = memFs();
  const fs: FrgFsDeps = {
    readFile: base.readFile,
    writeFile: async (p, data) => {
      if (p.includes("trend-ledger")) throw new Error("simulated ledger write fail");
      return base.writeFile(p, data);
    },
    mkdir: base.mkdir,
    rename: async (from, to) => {
      if (to.includes("trend-ledger")) throw new Error("simulated ledger rename fail");
      return base.rename(from, to);
    },
  };
  const evidence = computeFrgEvidence(fullPackPassInput({ version: "1.30.0", run_id: "frg-soft-ledger" }));
  const ledgerErrors: string[] = [];
  const written = await writeFrgEvidence("/repo", evidence, fs, {
    onLedgerError: (e) => ledgerErrors.push(e.message),
  });
  assert.ok(written.evidencePath);
  assert.ok(written.latestPath);
  // Primary evidence must exist
  const latest = await base.readFile(frgLatestPath("/repo", "1.30.0"));
  assert.ok(latest.includes("frg-soft-ledger"));
  assert.ok(ledgerErrors.length >= 1);
});

test("parseFrgObservationsJson accepts schema and rejects unknown ids", () => {
  const ok = parseFrgObservationsJson(
    JSON.stringify({
      schema_version: 1,
      scenarios: [
        {
          id: "resume-mid-flight",
          status: "pass",
          detail: "resumed",
        },
      ],
      composition: [
        {
          id: "fix-rereview-cycle",
          status: "pass",
          detail: "saw fix cycle",
        },
      ],
      false_human_authority_count: 0,
    }),
  );
  assert.equal(ok.scenarios?.length, 1);
  assert.equal(ok.composition?.[0]?.id, "fix-rereview-cycle");

  assert.throws(
    () =>
      parseFrgObservationsJson(
        JSON.stringify({
          schema_version: 1,
          scenarios: [{ id: "not-a-real-scenario", status: "pass", detail: "x" }],
        }),
      ),
    /unknown/,
  );
  assert.throws(
    () =>
      parseFrgObservationsJson(
        JSON.stringify({
          schema_version: 1,
          composition: [{ id: "nope", status: "pass", detail: "x" }],
        }),
      ),
    /unknown/,
  );
});

test("parseFrgScenarioCliToken parses id=status:detail[:observed=N]", () => {
  const a = parseFrgScenarioCliToken("resume-mid-flight=pass:killed and resumed");
  assert.equal(a.id, "resume-mid-flight");
  assert.equal(a.status, "pass");
  assert.match(a.detail, /killed/);
  const b = parseFrgScenarioCliToken("capacity-blocked-retain=pass:ok:observed=2");
  assert.equal(b.observed, 2);
  assert.throws(() => parseFrgScenarioCliToken("bogus=pass:x"), /Unknown FRG scenario/);
});

test("validateReleaseEligibleFrgEvidence rejects forged/incomplete/wrong-version pass", () => {
  const good = computeFrgEvidence(fullPackPassInput({ version: "1.30.0", run_id: "frg-val" }));
  const parsed = validateReleaseEligibleFrgEvidence(
    JSON.parse(JSON.stringify(good)),
    "1.30.0",
    { attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY },
  );
  assert.equal(parsed.pass, true);

  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(JSON.parse(JSON.stringify(good)), "9.9.9", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /version/,
  );

  // Minimal forged pass:true
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(
        { pass: true, run_id: "x", schema_version: 1, version: "1.30.0" },
        "1.30.0",
        { attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY },
      ),
    /release-eligibility|schema|scenarios|composition/i,
  );

  // Tamper integrity fingerprint
  const tampered = JSON.parse(JSON.stringify(good));
  tampered.integrity.scoreboard_fingerprint = "deadbeef";
  assert.throws(() => parseFrgEvidence(tampered), /fingerprint/);

  // Missing composition dimension → compute path fails eligibility
  const incomplete = computeFrgEvidence({
    ...fullPackPassInput({ version: "1.30.0", run_id: "frg-missing-dim" }),
    composition_overrides: frgRequiredCompositionOverrides("pass").filter(
      (d) => d.id !== "recovery-controller-multi-item",
    ),
  });
  assert.equal(incomplete.pass, false);
  assert.ok(incomplete.composition.missing.includes("recovery-controller-multi-item"));
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(JSON.parse(JSON.stringify(incomplete)), "1.30.0", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /release-eligibility|missing composition/i,
  );
});

test("validateReleaseEligibleFrgEvidence rejects hand-authored self-consistent evidence without valid HMAC (cca5f0f7)", () => {
  // Full-schema forge: recompute public fingerprints and invent ids, but no producer key.
  const unsigned = computeFrgEvidence(
    fullPackPassInput({
      version: "1.30.0",
      run_id: "frg-hand-forge",
      attestation_key: null,
    }),
  );
  assert.equal(unsigned.pass, false, "without key, mint cannot be release-eligible");
  assert.equal(unsigned.integrity.attestation, undefined);

  // Hand-author: take a fully consistent document and attach a fake MAC (or strip signing).
  const honest = computeFrgEvidence(
    fullPackPassInput({ version: "1.30.0", run_id: "frg-hand-forge-honest" }),
  );
  assert.equal(honest.pass, true);

  // Wrong key / forged MAC
  const forged = JSON.parse(JSON.stringify(honest));
  forged.integrity.attestation = {
    alg: "hmac-sha256-v1",
    mac: "a".repeat(64),
  };
  // Structural parse may still accept presence; tag validator must reject MAC.
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(forged, "1.30.0", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /attestation MAC|forged|does not match/i,
  );

  // Missing key at validation time fails closed
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(JSON.parse(JSON.stringify(honest)), "1.30.0", {
        attestationKey: null,
      }),
    new RegExp(FRG_ATTESTATION_KEY_ENV),
  );

  // Re-sign with a different key fails under the real producer key
  const otherKey = "other-operator-key-not-matching";
  const resign = {
    ...honest,
    integrity: signFrgIntegrity({
      integrity: buildFrgIntegrity(honest.scoreboard, honest.composition),
      schema_version: honest.schema_version,
      version: honest.version,
      run_id: honest.run_id,
      loop_run_id: honest.loop_run_id!,
      pack_id: honest.pack_id!,
      pass: honest.pass,
      thresholds: honest.thresholds,
      scenarios: honest.scenarios,
      scoreboard: honest.scoreboard,
      composition: honest.composition,
      recovery_aggregates: honest.recovery_aggregates ?? null,
      operation_reliability: honest.operation_reliability ?? null,
      attestationKey: otherKey,
    }),
  };
  assert.equal(verifyFrgAttestation(resign, otherKey), true);
  assert.equal(verifyFrgAttestation(resign, FRG_UNIT_TEST_ATTESTATION_KEY), false);
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(resign, "1.30.0", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /attestation MAC|forged|does not match/i,
  );
});

test("HMAC binds pass/scenarios/thresholds — eligibility-field replay rejected (e951091b)", () => {
  // Signed failed attempt: composition/scoreboard OK, scenarios not observed → pass false.
  // Old bug: MAC covered only ids+fingerprints, so attacker could flip scenarios/pass.
  const signedFail = computeFrgEvidence({
    version: "1.30.0",
    run_id: "frg-eligibility-replay",
    loop_run_id: "loop-replay",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(signedFail.pass, false);
  assert.ok(
    signedFail.integrity.attestation?.mac,
    "failed attempts with a producer key still mint a MAC over the failure payload",
  );

  const honest = computeFrgEvidence(
    fullPackPassInput({ version: "1.30.0", run_id: "frg-eligibility-honest" }),
  );
  assert.equal(honest.pass, true);

  // Replay: keep the failed MAC, graft passing scenarios + pass:true + thresholds.
  const replay = JSON.parse(JSON.stringify(signedFail)) as FrgEvidence;
  replay.pass = true;
  replay.scenarios = JSON.parse(JSON.stringify(honest.scenarios));
  replay.thresholds = { ...honest.thresholds };
  replay.operation_reliability = JSON.parse(JSON.stringify(honest.operation_reliability));
  // Fingerprints still match scoreboard/composition (unchanged) — without field binding
  // the old MAC would still verify.
  assert.equal(
    verifyFrgAttestation(replay, FRG_UNIT_TEST_ATTESTATION_KEY),
    false,
    "MAC must fail when pass/scenarios/thresholds are mutated after signing",
  );
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(replay, "1.30.0", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /attestation MAC|forged|does not match/i,
  );

  // Threshold-only tamper on an otherwise honest document also fails MAC.
  const thr = JSON.parse(JSON.stringify(honest)) as FrgEvidence;
  thr.thresholds = { ...thr.thresholds, max_engine_class_rate: 0.99 };
  assert.equal(verifyFrgAttestation(thr, FRG_UNIT_TEST_ATTESTATION_KEY), false);
});

function assertTagPathRemediation(err: unknown, version: string): void {
  const message = err instanceof Error ? err.message : String(err);
  assert.ok(
    message.includes(frgLatestRelPath(version)),
    `expected ${frgLatestRelPath(version)} in: ${message}`,
  );
  assert.match(message, /factory-release prepare/);
  assert.match(message, /Tugboat FRG pack/);
  assert.equal(/optional|advisory/i.test(message), false, message);
}

test("validateFrgEvidenceFileForTag: missing fails closed; good pass succeeds", async () => {
  const fs = memFs();
  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.30.0", fs, {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /missing/,
  );
  const good = computeFrgEvidence(fullPackPassInput({ version: "1.30.0", run_id: "frg-tag" }));
  await writeFrgEvidence("/repo", good, fs);
  const ok = await validateFrgEvidenceFileForTag("/repo", "1.30.0", fs, {
    attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(ok.pass, true);
  assert.equal(ok.version, "1.30.0");

  const failEv = computeFrgEvidence({
    version: "1.30.1",
    run_id: "frg-tag-fail",
    loop_run_id: "loop",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(failEv.pass, false);
  await writeFrgEvidence("/repo", failEv, fs);
  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.30.1", fs, {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /release-eligibility|pass=false/i,
  );
});

test("validateFrgEvidenceFileForTag: missing latest.json names path and pack remediation", async () => {
  const fs = memFs();
  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.39.0", fs, {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    (err: unknown) => {
      assertTagPathRemediation(err, "1.39.0");
      assert.match((err as Error).message, /missing/);
      return true;
    },
  );
});

test("validateFrgEvidenceFileForTag: pass:false latest.json names path and pack remediation", async () => {
  const fs = memFs();
  const failEv = computeFrgEvidence({
    version: "1.39.0",
    run_id: "frg-tag-fail-139",
    loop_run_id: "loop",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(failEv.pass, false);
  await writeFrgEvidence("/repo", failEv, fs);
  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.39.0", fs, {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    (err: unknown) => {
      assertTagPathRemediation(err, "1.39.0");
      assert.match((err as Error).message, /pass=false/i);
      return true;
    },
  );
});

test("validateFrgEvidenceFileForTag: release-eligible pass does not emit fail-closed remediation", async () => {
  const fs = memFs();
  const good = computeFrgEvidence(fullPackPassInput({ version: "1.30.0", run_id: "frg-tag-pass-msg" }));
  assert.equal(good.pass, true);
  await writeFrgEvidence("/repo", good, fs);
  const ok = await validateFrgEvidenceFileForTag("/repo", "1.30.0", fs, {
    attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(ok.pass, true);
  assert.equal(ok.version, "1.30.0");
});

test("observe mapping: missing latest.json is not observed; tag path stays fail-closed (#1271)", async () => {
  const fs = memFs();
  const observed = await observeReleaseEligibleFrgEvidence("/repo", "1.39.14", fs, {
    attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(observed, null);

  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.39.14", fs, {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    (err: unknown) => {
      assert.equal(isFrgTagPathIneligibleError(err), true);
      assert.equal((err as FrgTagPathIneligibleError).kind, "missing");
      const message = (err as Error).message;
      assert.equal(message.includes("evidence missing"), false);
      assert.match(message, /missing at/);
      assert.match(message, /Cannot create or push tag v1\.39\.14/);
      assertTagPathRemediation(err, "1.39.14");
      return true;
    },
  );
});

test("observe mapping: unreadable and not-release-eligible latest.json are not observed (#1271)", async () => {
  const latestPath = frgLatestPath("/repo", "1.39.14");
  const unreadable: FrgFsDeps = {
    ...memFs(),
    async readFile() {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    },
  };
  assert.equal(
    await observeReleaseEligibleFrgEvidence("/repo", "1.39.14", unreadable, {
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
    }),
    null,
  );
  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.39.14", unreadable, {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    (err: unknown) => {
      assert.equal(isFrgTagPathIneligibleError(err), true);
      assert.equal((err as FrgTagPathIneligibleError).kind, "unreadable");
      assertTagPathRemediation(err, "1.39.14");
      return true;
    },
  );

  const fs = memFs();
  await fs.writeFile(latestPath, "{not-json");
  assert.equal(
    await observeReleaseEligibleFrgEvidence("/repo", "1.39.14", fs, {
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
    }),
    null,
  );

  const failEv = computeFrgEvidence({
    version: "1.39.14",
    run_id: "frg-observe-fail",
    loop_run_id: "loop",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(failEv.pass, false);
  await writeFrgEvidence("/repo", failEv, fs);
  assert.equal(
    await observeReleaseEligibleFrgEvidence("/repo", "1.39.14", fs, {
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
    }),
    null,
  );
  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.39.14", fs, {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    (err: unknown) => {
      assert.equal(isFrgTagPathIneligibleError(err), true);
      assert.equal((err as FrgTagPathIneligibleError).kind, "not_release_eligible");
      assertTagPathRemediation(err, "1.39.14");
      return true;
    },
  );
});

test("observe mapping: HMAC-invalid artifact is not observed; eligible pass is (#1271)", async () => {
  const fs = memFs();
  const signed = computeFrgEvidence({
    ...fullPackPassInput({ version: "1.30.0", run_id: "frg-observe-hmac" }),
    factory_release_binding: { candidate_git_sha: "a".repeat(40) },
  });
  assert.equal(signed.pass, true);
  const forged = {
    ...signed,
    factory_release_binding: { candidate_git_sha: "b".repeat(40) },
  };
  await fs.writeFile(frgLatestPath("/repo", "1.30.0"), `${JSON.stringify(forged)}\n`);
  assert.equal(
    await observeReleaseEligibleFrgEvidence("/repo", "1.30.0", fs, {
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
    }),
    null,
  );

  await writeFrgEvidence("/repo", signed, fs);
  const ok = await observeReleaseEligibleFrgEvidence("/repo", "1.30.0", fs, {
    attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(ok?.pass, true);
  assert.equal(ok?.version, "1.30.0");
});

test("observe mapping: missing attestor still throws and is not not-observed (#1271)", async () => {
  const fs = memFs();
  const good = computeFrgEvidence(fullPackPassInput({ version: "1.30.0", run_id: "frg-observe-cred" }));
  await writeFrgEvidence("/repo", good, fs);
  await assert.rejects(
    () => observeReleaseEligibleFrgEvidence("/repo", "1.30.0", fs, { env: {} }),
    /missing_attestor_credential/,
  );
});

test("observe mapping source does not substring-match tag-path formatter copy (#1271)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    fileURLToPath(new URL("../scripts/factory-reliability-gate.ts", import.meta.url)),
    "utf8",
  );
  const start = src.indexOf("export async function observeReleaseEligibleFrgEvidence");
  const end = src.indexOf("export async function validateFrgEvidenceSnapshotForTag");
  assert.ok(start !== -1 && end > start, "expected observe mapping helper");
  const body = src.slice(start, end);
  assert.equal(body.includes('includes("evidence missing")'), false);
  assert.equal(body.includes("includes('evidence missing')"), false);
  assert.equal(
    /includes\s*\(/.test(body),
    false,
    "observe mapping must not classify by formatter substring",
  );
  assert.match(body, /isFrgTagPathIneligibleError/);
});

test("HMAC rejects factory_release_binding overlay after sign (#1149)", () => {
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const signed = computeFrgEvidence({
    ...fullPackPassInput({ version: "1.30.0", run_id: "frg-binding-mac" }),
    factory_release_binding: { candidate_git_sha: shaA },
  });
  assert.equal(signed.pass, true);
  assert.equal(verifyFrgAttestation(signed, FRG_UNIT_TEST_ATTESTATION_KEY), true);

  const overlaid = {
    ...signed,
    factory_release_binding: { candidate_git_sha: shaB },
  };
  assert.equal(
    verifyFrgAttestation(overlaid, FRG_UNIT_TEST_ATTESTATION_KEY),
    false,
    "unsigned factory_release_binding overlay must fail HMAC",
  );
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(overlaid, "1.30.0", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /attestation MAC|forged|does not match/i,
  );

  const addedAfterMint = computeFrgEvidence(
    fullPackPassInput({ version: "1.30.0", run_id: "frg-binding-overlay" }),
  );
  assert.equal(addedAfterMint.pass, true);
  assert.equal(verifyFrgAttestation(addedAfterMint, FRG_UNIT_TEST_ATTESTATION_KEY), true);
  const retarget = {
    ...addedAfterMint,
    factory_release_binding: { candidate_git_sha: shaB },
  };
  assert.equal(verifyFrgAttestation(retarget, FRG_UNIT_TEST_ATTESTATION_KEY), false);
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(retarget, "1.30.0", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /attestation MAC|forged|does not match/i,
  );
});

test("validateFrgEvidenceSnapshotForTag returns HMAC SHA from the same file read (#1149)", async () => {
  const fs = memFs();
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const signedA = computeFrgEvidence({
    ...fullPackPassInput({ version: "1.30.0", run_id: "frg-snapshot" }),
    factory_release_binding: { candidate_git_sha: shaA },
  });
  const signedB = computeFrgEvidence({
    ...fullPackPassInput({ version: "1.30.0", run_id: "frg-snapshot-b" }),
    factory_release_binding: { candidate_git_sha: shaB },
  });
  assert.equal(signedA.pass, true);
  await writeFrgEvidence("/repo", signedA, fs);
  const latestPath = frgLatestPath("/repo", "1.30.0");
  let reads = 0;
  const mutating: FrgFsDeps = {
    ...fs,
    async readFile(p) {
      if (p !== latestPath) return fs.readFile(p);
      reads++;
      if (reads === 1) return JSON.stringify(signedA);
      return JSON.stringify(signedB);
    },
  };
  const { evidence, snapshot } = await validateFrgEvidenceSnapshotForTag(
    "/repo",
    "1.30.0",
    mutating,
    { attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY },
  );
  assert.equal(reads, 1);
  assert.equal(evidence.pass, true);
  assert.equal(
    (snapshot as { factory_release_binding: { candidate_git_sha: string } })
      .factory_release_binding.candidate_git_sha,
    shaA,
  );
});

test("HMAC-verify presents KEY_FILE as KEY when KEY is unset (#1181)", async () => {
  const dummy = "dummy-key";
  const fs = memFs();
  const good = computeFrgEvidence(
    fullPackPassInput({
      version: "1.30.0",
      run_id: "frg-key-file",
      attestation_key: dummy,
    }),
  );
  assert.equal(good.pass, true);
  await writeFrgEvidence("/repo", good, fs);
  const ok = await validateFrgEvidenceFileForTag("/repo", "1.30.0", fs, {
    env: { PIPELINE_FRG_ATTESTATION_KEY_FILE: "/keys/dummy" },
    presentAttestorCredential: {
      readFile: () => Buffer.from(dummy),
    },
  });
  assert.equal(ok.pass, true);
  assert.equal(verifyFrgAttestation(ok, dummy), true);
});

test("HMAC-verify strips KEY_FILE trailing LF and verifies with KEY (#1181)", async () => {
  const dummy = "dummy-key";
  const presented = presentFrgAttestorCredential(
    { PIPELINE_FRG_ATTESTATION_KEY_FILE: "/keys/dummy" },
    { readFile: () => Buffer.from(`${dummy}\n`) },
  );
  assert.equal(presented.ok, true);
  if (!presented.ok) return;
  const presentedKey = presented.env.PIPELINE_FRG_ATTESTATION_KEY;
  assert.equal(presentedKey, dummy);
  assert.equal(presented.env.PIPELINE_FRG_ATTESTATION_KEY_FILE, undefined);
  const fs = memFs();
  const good = computeFrgEvidence(
    fullPackPassInput({
      version: "1.30.0",
      run_id: "frg-key-file-lf",
      attestation_key: dummy,
    }),
  );
  assert.equal(good.pass, true);
  assert.equal(verifyFrgAttestation(good, presentedKey!), true);
  await writeFrgEvidence("/repo", good, fs);
  const ok = await validateFrgEvidenceFileForTag("/repo", "1.30.0", fs, {
    env: { PIPELINE_FRG_ATTESTATION_KEY_FILE: "/keys/dummy" },
    presentAttestorCredential: {
      readFile: () => Buffer.from(`${dummy}\n`),
    },
  });
  assert.equal(ok.pass, true);
  assert.equal(verifyFrgAttestation(ok, dummy), true);
});

test("HMAC-verify inherits KEY and does not read KEY_FILE (#1181)", async () => {
  const fs = memFs();
  const good = computeFrgEvidence(
    fullPackPassInput({ version: "1.30.0", run_id: "frg-inherit-key" }),
  );
  await writeFrgEvidence("/repo", good, fs);
  let reads = 0;
  const ok = await validateFrgEvidenceFileForTag("/repo", "1.30.0", fs, {
    env: {
      PIPELINE_FRG_ATTESTATION_KEY: FRG_UNIT_TEST_ATTESTATION_KEY,
      PIPELINE_FRG_ATTESTATION_KEY_FILE: "/keys/must-not-read",
    },
    presentAttestorCredential: {
      readFile() {
        reads++;
        throw new Error("KEY_FILE must not be read when KEY is set");
      },
    },
  });
  assert.equal(ok.pass, true);
  assert.equal(reads, 0);
});

test("HMAC-verify fails closed without a credential before KEY-required (#1181)", async () => {
  const fs = memFs();
  const good = computeFrgEvidence(
    fullPackPassInput({ version: "1.30.0", run_id: "frg-missing-cred" }),
  );
  await writeFrgEvidence("/repo", good, fs);
  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.30.0", fs, {
        env: {},
      }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /missing_attestor_credential/);
      assert.equal(
        message.includes(`${FRG_ATTESTATION_KEY_ENV} is required to verify integrity.attestation`),
        false,
      );
      return true;
    },
  );
});

test("HMAC-verify fails closed on unreadable or empty KEY_FILE (#1181)", async () => {
  const fs = memFs();
  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.30.0", fs, {
        env: { PIPELINE_FRG_ATTESTATION_KEY_FILE: "/keys/missing" },
        presentAttestorCredential: {
          readFile() {
            throw new Error("EACCES");
          },
        },
      }),
    /unreadable_attestor_key_file/,
  );
  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.30.0", fs, {
        env: { PIPELINE_FRG_ATTESTATION_KEY_FILE: "/keys/empty" },
        presentAttestorCredential: {
          readFile: () => Buffer.alloc(0),
        },
      }),
    /missing_attestor_credential/,
  );
});

test("factory-gate --from-run presents KEY_FILE as KEY (#1181)", async () => {
  const dummy = "dummy-key";
  const fs = memFs();
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-frg-key-file",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-frg-key-file",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-frg-key-file",
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      compositionOverrides: frgRequiredCompositionOverrides("pass"),
      env: { PIPELINE_FRG_ATTESTATION_KEY_FILE: "/keys/dummy" },
      presentAttestorCredential: {
        readFile: () => Buffer.from(dummy),
      },
      ...frgPassUniqueOperations("1.29.1"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.pass, true);
  assert.equal(verifyFrgAttestation(result.evidence, dummy), true);
  await assert.rejects(
    () =>
      runFactoryGate(
        {
          version: "1.29.1",
          repoDir: "/repo",
          fromRun: "loop-frg-key-file",
          loadLedger: async () => ledger,
          loadContract: async () => packContract,
          scenarioOverrides: frgRequiredObservationOverrides("pass"),
          compositionOverrides: frgRequiredCompositionOverrides("pass"),
          env: {},
          stdout: () => {},
          stderr: () => {},
        },
        fs,
      ),
    /missing_attestor_credential/,
  );
});

test("FRG composition inventory is frozen (#757)", () => {
  assert.equal(FRG_COMPOSITION_DIMENSION_IDS.length, 11);
  assert.ok(FRG_COMPOSITION_DIMENSION_IDS.includes("openspec-bearing-item"));
  assert.ok(FRG_COMPOSITION_DIMENSION_IDS.includes("recovery-controller-one-item"));
  assert.ok(FRG_COMPOSITION_DIMENSION_IDS.includes("recovery-controller-multi-item"));
});

test("appendFrgTrendLedger standalone + entry fields", async () => {
  const fs = memFs();
  const evidence = computeFrgEvidence(
    fullPackPassInput({ version: "2.0.0", run_id: "frg-agg" }),
  );
  evidence.recovery_aggregates = {
    by_reason: {
      "implementation-ci": { success: 1, exhaustion: 0, resumes: 0, elapsed_ms: 100 },
    },
  };
  const entry = trendLedgerEntryFromEvidence(evidence);
  assert.equal(entry.recovery_aggregates?.by_reason["implementation-ci"].success, 1);
  const r1 = await appendFrgTrendLedger("/repo", entry, fs);
  assert.equal(r1.appended, true);
  const r2 = await appendFrgTrendLedger("/repo", entry, fs);
  assert.equal(r2.appended, false);
});

test("appendFrgTrendLedger concurrent writers retain both entries (d178b8e5)", async () => {
  // In-memory mutex mirrors production withPathLock serialization.
  let chain: Promise<unknown> = Promise.resolve();
  const base = memFs();
  const fs: FrgFsDeps & { files: Map<string, string> } = {
    ...base,
    files: base.files,
    withPathLock: async <T>(_key: string, fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(() => fn());
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };

  const a = trendLedgerEntryFromEvidence(
    computeFrgEvidence(fullPackPassInput({ version: "1.40.0", run_id: "frg-conc-a" })),
  );
  const b = trendLedgerEntryFromEvidence(
    computeFrgEvidence(fullPackPassInput({ version: "1.40.1", run_id: "frg-conc-b" })),
  );

  const [rA, rB] = await Promise.all([
    appendFrgTrendLedger("/repo", a, fs),
    appendFrgTrendLedger("/repo", b, fs),
  ]);
  assert.equal(rA.appended, true);
  assert.equal(rB.appended, true);

  const body = await fs.readFile(frgTrendLedgerPath("/repo"));
  const lines = body
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  assert.equal(lines.length, 2, "both concurrent appends must be retained");
  assert.ok(lines.some((l) => l.includes("frg-conc-a")));
  assert.ok(lines.some((l) => l.includes("frg-conc-b")));
  assert.ok(lines.some((l) => l.includes("1.40.0")));
  assert.ok(lines.some((l) => l.includes("1.40.1")));
});

test("appendFrgTrendLedger without lock loses history under concurrent rewrite race", async () => {
  // Regression guard: the unlocked read–merge–write + shared-style race drops an entry.
  // Production always supplies withPathLock; this proves why the lock is required.
  const files = new Map<string, string>();
  let readGate: Promise<void> = Promise.resolve();
  let releaseRead: (() => void) | undefined;
  let readersWaiting = 0;

  const racingFs: FrgFsDeps = {
    async readFile(p) {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        // Coordinate: both writers observe empty ledger before either renames.
        readersWaiting += 1;
        if (readersWaiting === 1) {
          readGate = new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        } else if (readersWaiting >= 2 && releaseRead) {
          releaseRead();
        }
        await readGate;
        throw err;
      }
      return v;
    },
    async writeFile(p, data) {
      files.set(p, data);
    },
    async mkdir() {},
    async rename(from, to) {
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT rename ${from}`);
      files.set(to, v);
      files.delete(from);
    },
    // Intentionally no withPathLock — and bypass default by providing the field as undefined
    // is not enough (append falls back to defaultFrgPathLock). Override with passthrough.
    withPathLock: async (_key, fn) => fn(),
  };

  const a = trendLedgerEntryFromEvidence(
    computeFrgEvidence(fullPackPassInput({ version: "1.41.0", run_id: "frg-race-a" })),
  );
  const b = trendLedgerEntryFromEvidence(
    computeFrgEvidence(fullPackPassInput({ version: "1.41.1", run_id: "frg-race-b" })),
  );

  await Promise.all([
    appendFrgTrendLedger("/repo-race", a, racingFs),
    appendFrgTrendLedger("/repo-race", b, racingFs),
  ]);

  const body = files.get(frgTrendLedgerPath("/repo-race")) ?? "";
  const lines = body
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  // Last rename wins → only one complete ledger body (lost concurrent history).
  assert.equal(
    lines.length,
    1,
    "unlocked concurrent rewrite must drop one entry (proves the race)",
  );
});

test("computeAttestorRunId is deterministic, distinct from A, and changes with the binding (#1295)", () => {
  const unsignedA = "frg-cede01998b2bc2f0ef510840";
  const binding = {
    schema_version: 1,
    kind: "factory_release_unsigned_digest_binding",
    request_fingerprint: "fp-1",
    target_version: "1.39.15",
    candidate_git_sha: "b".repeat(40),
    pack_id: "factory-gate-v1",
    pack_run_id: "pack-1",
    loop_run_id: "loop-1",
    frg_run_id: unsignedA,
    artifacts: {
      observations_sha256: "1".repeat(64),
      evidence_bundle_sha256: "2".repeat(64),
      contract_sha256: "3".repeat(64),
      ledger_sha256: "4".repeat(64),
      events_sha256: "5".repeat(64),
      action_evidence_sha256: "6".repeat(64),
    },
  };
  const b1 = computeAttestorRunId(binding);
  const b2 = computeAttestorRunId({ ...binding });
  assert.equal(b1, b2);
  assert.notEqual(b1, unsignedA);
  assert.ok(b1.startsWith(FRG_ATTESTOR_RUN_ID_PREFIX));
  const bChanged = computeAttestorRunId({ ...binding, pack_run_id: "pack-2" });
  assert.notEqual(bChanged, b1);
});

test("ship-path from-run writes HMAC binding before sign and remints the same B (#1295)", async () => {
  const fs = memFs();
  const packedC = "b".repeat(40);
  const unsigned: FactoryReleaseFrgPayload = {
    pack_id: FRG_PACK_MANIFEST.pack_id,
    manifest_path: "/pack/manifest.json",
    manifest_sha256: "a".repeat(64),
    pack_run_id: "pack-1295",
    loop_run_id: "loop-1295",
    frg_run_id: "frg-unsigned-a",
    evidence_created_at: "2026-08-29T00:00:00Z",
    observations: { path: "/u/obs.json", sha256: "1".repeat(64) },
    evidence_bundle: { path: "/u/bundle.json", sha256: "2".repeat(64) },
    contract: { path: "/u/contract.json", sha256: "3".repeat(64) },
    ledger: { path: "/u/ledger.json", sha256: "4".repeat(64) },
    events: { path: "/u/events.json", sha256: "5".repeat(64) },
    action_evidence: { path: "/u/action.json", sha256: "6".repeat(64) },
  };
  const request: FactoryReleasePrepareRequest = {
    schema_version: 1,
    kind: "factory_release_prepare_request",
    action_id: "action-1295",
    repository: "owner/repo",
    base_branch: "main",
    target_version: "1.30.0",
    integrated_candidate: { git_sha: packedC, version: "1.29.1" },
    production_pin: { version: "1.29.1", tag: "v1.29.1", git_sha: "c".repeat(40) },
    frg_manifest: { pack_id: FRG_PACK_MANIFEST.pack_id, sha256: "a".repeat(64) },
  };
  const binding = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
  const expectedB = computeAttestorRunId(binding);
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-1295",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-1295",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;

  const first = await runFactoryGate(
    {
      version: "1.30.0",
      repoDir: "/repo",
      fromRun: "loop-1295",
      resolveShipPathFromRun: async () => ({
        kind: "bound",
        binding,
        unsigned_frg_run_id: unsigned.frg_run_id,
      }),
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      compositionOverrides: frgRequiredCompositionOverrides("pass"),
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      ...frgPassUniqueOperations("1.29.1"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(first.exitCode, 0);
  assert.equal(first.evidence.run_id, expectedB);
  assert.notEqual(first.evidence.run_id, unsigned.frg_run_id);
  assert.deepEqual(first.evidence.factory_release_binding, binding);
  assert.equal(verifyFrgAttestation(first.evidence, FRG_UNIT_TEST_ATTESTATION_KEY), true);
  const overlaid = {
    ...first.evidence,
    factory_release_binding: { ...binding, frg_run_id: "frg-tampered" },
  };
  assert.equal(
    verifyFrgAttestation(overlaid, FRG_UNIT_TEST_ATTESTATION_KEY),
    false,
    "overlay after sign must fail HMAC",
  );

  const second = await runFactoryGate(
    {
      version: "1.30.0",
      repoDir: "/repo",
      fromRun: "loop-1295",
      resolveShipPathFromRun: async () => ({
        kind: "bound",
        binding,
        unsigned_frg_run_id: unsigned.frg_run_id,
      }),
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      compositionOverrides: frgRequiredCompositionOverrides("pass"),
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      ...frgPassUniqueOperations("1.29.1"),
      stdout: () => {},
      stderr: () => {},
    },
    memFs(),
  );
  assert.equal(second.evidence.run_id, expectedB);
});

test("ship-path from-run without unsigned checkpoint fails closed and writes no latest.json (#1295)", async () => {
  const fs = memFs();
  await assert.rejects(
    () =>
      runFactoryGate(
        {
          version: "1.30.0",
          repoDir: "/repo",
          fromRun: "loop-missing",
          requestCandidateGitSha: "b".repeat(40),
          resolveShipPathFromRun: async () => ({
            kind: "fail",
            message:
              "pipeline factory-gate: ship-path --from-run loop-missing has no unsigned checkpoint for v1.30.0; refusing HMAC latest.json without factory_release_binding",
          }),
          loadLedger: async () =>
            ({
              schema: LOOP_LEDGER_SCHEMA,
              run_id: "loop-missing",
              items: {
                "10": { state: "ready", history: [], recovery_attempts: [] },
                "20": { state: "ready", history: [], recovery_attempts: [] },
              },
            }) as unknown as LoopLedger,
          loadContract: async () =>
            ({
              schema: LOOP_CONTRACT_SCHEMA,
              run_id: "loop-missing",
              selector: { type: "label", value: "factory-gate" },
              items: [
                { id: "10", depends_on: [], external_depends_on: [] },
                { id: "20", depends_on: [], external_depends_on: [] },
              ],
            }) as unknown as LoopContract,
          scenarioOverrides: frgRequiredObservationOverrides("pass"),
          compositionOverrides: frgRequiredCompositionOverrides("pass"),
          attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
          stdout: () => {},
          stderr: () => {},
        },
        fs,
      ),
    /no unsigned checkpoint/,
  );
  assert.equal(fs.files.has("/repo/.agent-pipeline/frg/1.30.0/latest.json"), false);
});

test("standalone unbound from-run still mints a fresh run_id without binding (#1295)", async () => {
  const fs = memFs();
  const packContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "loop-standalone",
    selector: { type: "label", value: "factory-gate" },
    items: [
      { id: "10", depends_on: [], external_depends_on: [] },
      { id: "20", depends_on: [], external_depends_on: [] },
    ],
  } as unknown as LoopContract;
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-standalone",
    items: {
      "10": { state: "ready", history: [], recovery_attempts: [] },
      "20": { state: "ready", history: [], recovery_attempts: [] },
    },
  } as unknown as LoopLedger;
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      fromRun: "loop-standalone",
      resolveShipPathFromRun: async () => ({ kind: "standalone" }),
      loadLedger: async () => ledger,
      loadContract: async () => packContract,
      scenarioOverrides: frgRequiredObservationOverrides("pass"),
      compositionOverrides: frgRequiredCompositionOverrides("pass"),
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      ...frgPassUniqueOperations("1.29.1"),
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence.factory_release_binding, undefined);
  assert.ok(typeof result.evidence.run_id === "string" && result.evidence.run_id.startsWith("frg-"));
  assert.equal(result.evidence.run_id.startsWith(FRG_ATTESTOR_RUN_ID_PREFIX), false);
});
