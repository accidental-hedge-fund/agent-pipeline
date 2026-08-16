import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectFrgPackObservations,
  defaultFrgPackRoot,
  FRG_HYBRID_LAYER_A_PROBE_IDS,
  FRG_HYBRID_PILOT_POLICY_ID,
  FRG_HYBRID_REPLACEMENT_ISSUE,
  FRG_HYBRID_V1_MANIFEST_SHA256,
  FRG_HYBRID_V2_MANIFEST_SHA256,
  FRG_HYBRID_V2_POLICY_ID,
  isFrgRequiredLiveCompositionId,
  isFrgRequiredLiveScenarioId,
  loadFrgPack,
  renderFrgPackIssues,
  serializeFrgPackObservations,
  type LoadedFrgPack,
  type VerifiedFrgPackRun,
} from "../scripts/frg-pack-observations.ts";
import {
  FRG_COMPOSITION_DIMENSION_IDS,
  FRG_PACK_MANIFEST,
  FRG_SCENARIO_IDS,
  FRG_UNIT_TEST_ATTESTATION_KEY,
  computeFrgEvidence,
  hybridPilotProofValid,
  parseFrgEvidence,
  parseFrgObservationsFile,
  verifyFrgAttestation,
} from "../scripts/factory-reliability-gate.ts";

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function makeEvidenceBundle(
  pack: LoadedFrgPack,
  releaseVersion = "1.33.0",
): VerifiedFrgPackRun {
  const packRunId = "frg-pack-run-a";
  const loopRunId = "loop-frg-a";
  const candidateGitSha = "a".repeat(40);
  const startedAt = "2026-08-08T12:00:00.000Z";
  const rendered = renderFrgPackIssues(pack, {
    release_version: releaseVersion,
    pack_run_id: packRunId,
  });
  const issueNumbers = rendered.map((_, index) => 1001 + index);
  return {
    schema_version: 1,
    policy_id: pack.manifest.pilot_policy.id,
    pack_id: pack.manifest.pack_id,
    manifest_version: pack.manifest.manifest_version,
    manifest_sha256: pack.manifest_sha256,
    release_version: releaseVersion,
    candidate_git_sha: candidateGitSha,
    pack_run_id: packRunId,
    loop_run_id: loopRunId,
    repository: "owner/repo",
    base_branch: "main",
    started_at: startedAt,
    contract: {
      artifact_sha256: digest("contract"),
      selector: { ...pack.manifest.selector },
      issue_numbers: issueNumbers,
      items: issueNumbers.map((issueNumber) => ({ issue_number: issueNumber, depends_on: [] })),
    },
    ledger: {
      artifact_sha256: digest("ledger"),
      items: issueNumbers.map((issueNumber, index) => ({
        issue_number: issueNumber,
        state: "ready",
        advance_run_id: `advance-${index + 1}`,
        blocked_theme: null,
      })),
    },
    events: {
      artifact_sha256: digest("events"),
      event_ids: issueNumbers.map((issueNumber, index) => `event:${index + 1}:item-${issueNumber}`),
      issue_numbers: issueNumbers,
    },
    action_evidence: {
      artifact_sha256: digest("actions"),
      action_ids: issueNumbers.map((issueNumber, index) => `action:${index + 1}:item-${issueNumber}`),
      issue_numbers: issueNumbers,
    },
    issues: rendered.map((issue, index) => {
      const issueNumber = issueNumbers[index]!;
      const head = String(index + 1).repeat(40);
      const files = issue.provenance.template_id === "clean-openspec"
        ? [
            "openspec/changes/archive/2026-08-08-frg/proposal.md",
            "openspec/specs/frg/spec.md",
          ]
        : ["docs/frg-fixture.md"];
      return {
        issue_number: issueNumber,
        issue_node_id: `ISSUE_${issueNumber}`,
        created_at: `2026-08-08T12:00:0${index + 1}.000Z`,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels, "pipeline:ready-to-deploy"],
        template_id: issue.provenance.template_id,
        template_sha256: issue.provenance.template_sha256,
        pr: {
          number: 2001 + index,
          node_id: `PR_${2001 + index}`,
          head_sha: head,
          base_branch: "main",
          files,
          checks: [
            {
              id: `CHECK_${issueNumber}`,
              name: "ci",
              head_sha: head,
              conclusion: "success",
            },
          ],
        },
      };
    }),
    probes: pack.manifest.pilot_policy.layer_a_probes.map((probe, index) => ({
      id: probe.id,
      candidate_git_sha: candidateGitSha,
      test_file: probe.test_file,
      test_name: probe.test_name,
      command_argv_sha256: digest(`argv:${probe.id}`),
      stdout_sha256: digest(`stdout:${probe.id}`),
      stderr_sha256: digest(`stderr:${probe.id}`),
      started_at: `2026-08-08T12:01:${String(index).padStart(2, "0")}.000Z`,
      finished_at: `2026-08-08T12:01:${String(index).padStart(2, "0")}.500Z`,
    })),
  };
}

test("factory-gate-v1 manifest closes the durable hybrid v2 proof matrix", async () => {
  const pack = await loadFrgPack();
  assert.equal(pack.manifest.pack_id, "factory-gate-v1");
  assert.equal(pack.manifest.pilot_policy.id, FRG_HYBRID_V2_POLICY_ID);
  assert.equal(pack.manifest.pilot_policy.release_version, undefined);
  assert.equal(pack.manifest.pilot_policy.replacement_issue, undefined);
  assert.equal(pack.manifest_sha256, FRG_HYBRID_V2_MANIFEST_SHA256);
  assert.notEqual(pack.manifest_sha256, FRG_HYBRID_V1_MANIFEST_SHA256);
  assert.deepEqual(
    pack.manifest.pilot_policy.layer_a_probes.map((probe) => probe.id),
    [...FRG_HYBRID_LAYER_A_PROBE_IDS],
  );
  assert.deepEqual(pack.manifest.required_scenario_ids, [...FRG_SCENARIO_IDS]);
  assert.deepEqual(pack.manifest.required_composition_ids, [...FRG_COMPOSITION_DIMENSION_IDS]);
  assert.equal(pack.template_bodies.size, pack.manifest.templates.length);
  assert.equal(pack.recipes.size, pack.manifest.fault_recipes.length);
  assert.equal(pack.manifest.pilot_policy.layer_a_probes.length, 15);

  const templatePath = path.join(defaultFrgPackRoot(), pack.manifest.templates[0]!.file);
  await assert.rejects(
    () => loadFrgPack(defaultFrgPackRoot(), {
      readFile: async (filePath) => {
        const text = await fsp.readFile(filePath, "utf8");
        return filePath === templatePath ? `${text}\ntampered\n` : text;
      },
    }),
    /template .* hash does not match manifest/,
  );
});

test("issue rendering is deterministic and binds the exact v1.33.0 run", async () => {
  const pack = await loadFrgPack();
  const input = { release_version: "1.33.0", pack_run_id: "frg-pack-run-a" };
  const first = renderFrgPackIssues(pack, input);
  assert.deepEqual(first, renderFrgPackIssues(pack, input));
  assert.equal(first.length, pack.manifest.minimum_fresh_issues);
  for (const issue of first) {
    assert.ok(issue.labels.includes("factory-gate"));
    assert.match(issue.body, /manifest_sha256=[0-9a-f]{64}/);
    assert.match(issue.body, /release_version=1\.33\.0/);
    assert.match(issue.body, /pack_run_id=frg-pack-run-a/);
    assert.doesNotMatch(issue.body, /{{[a-z0-9_]+}}/i);
  }
});

test("collector derives outcomes from candidate-bound records and rejects caller claims", async () => {
  const pack = await loadFrgPack();
  const bundle = makeEvidenceBundle(pack);
  const observations = collectFrgPackObservations(pack, bundle);
  assert.equal(observations.scenarios.length, FRG_SCENARIO_IDS.length - 2);
  assert.equal(observations.composition.length, FRG_COMPOSITION_DIMENSION_IDS.length);
  assert.equal(observations.false_human_authority_count, 0);
  assert.equal(observations.pack_provenance.candidate_git_sha, bundle.candidate_git_sha);
  assert.ok(observations.pack_provenance.probes.every((probe) => probe.candidate_git_sha === bundle.candidate_git_sha));
  assert.equal(observations.composition.find((item) => item.id === "openspec-bearing-item")?.source, "live");
  assert.ok(observations.composition.filter((item) => item.id !== "openspec-bearing-item").every((item) => item.source === "layer_a"));

  for (const key of ["pass", "status", "result", "metrics"]) {
    const invented = structuredClone(bundle) as unknown as Record<string, unknown>;
    invented[key] = key === "metrics" ? [] : "pass";
    assert.throws(() => collectFrgPackObservations(pack, invented), /forbidden: the collector derives outcomes/);
  }
});

test("collector rejects stale, wrong-head, incomplete OpenSpec, and missing-probe evidence", async () => {
  const pack = await loadFrgPack();

  const stale = makeEvidenceBundle(pack);
  stale.issues[0]!.created_at = "2026-08-08T11:59:59.000Z";
  assert.throws(() => collectFrgPackObservations(pack, stale), /predates this pack run/);

  const wrongHead = makeEvidenceBundle(pack);
  wrongHead.issues[0]!.pr.checks[0]!.head_sha = "f".repeat(40);
  assert.throws(() => collectFrgPackObservations(pack, wrongHead), /bound to another head/);

  const incompleteOpenSpec = makeEvidenceBundle(pack);
  incompleteOpenSpec.issues.find((issue) => issue.template_id === "clean-openspec")!.pr.files = [
    "openspec/changes/active/proposal.md",
    "openspec/specs/frg/spec.md",
  ];
  assert.throws(() => collectFrgPackObservations(pack, incompleteOpenSpec), /must contain archived change and spec files/);

  const missingProbe = makeEvidenceBundle(pack);
  missingProbe.probes.pop();
  assert.throws(() => collectFrgPackObservations(pack, missingProbe), /must contain every exact Layer A probe once/);
});

test("collector refuses historical v1 policy, unknown Layer A probe, manifest, selector, or issue set", async () => {
  const pack = await loadFrgPack();
  const wrongPolicy = makeEvidenceBundle(pack);
  wrongPolicy.policy_id = FRG_HYBRID_PILOT_POLICY_ID;
  assert.throws(
    () => collectFrgPackObservations(pack, wrongPolicy),
    /historical factory-gate-v1-hybrid-v1 cannot score the current pack/,
  );

  const unknownProbe = makeEvidenceBundle(pack);
  unknownProbe.probes[0]!.id = "not-a-closed-probe";
  assert.throws(
    () => collectFrgPackObservations(pack, unknownProbe),
    /not on the closed Layer A-allowed probe list/,
  );

  const wrongManifest = makeEvidenceBundle(pack);
  wrongManifest.manifest_sha256 = "0".repeat(64);
  assert.throws(() => collectFrgPackObservations(pack, wrongManifest), /does not match the loaded manifest/);

  const wrongSelector = makeEvidenceBundle(pack);
  wrongSelector.contract.selector.value = "not-the-pack";
  assert.throws(() => collectFrgPackObservations(pack, wrongSelector), /selector does not match/);

  const extraIssue = makeEvidenceBundle(pack);
  extraIssue.contract.issue_numbers.push(9999);
  assert.throws(() => collectFrgPackObservations(pack, extraIssue), /contract items must equal the fresh manifest issue set/);
});

test("collector projection is deterministic and the FRG parser preserves proof provenance", async () => {
  const pack = await loadFrgPack();
  const first = collectFrgPackObservations(pack, makeEvidenceBundle(pack));
  const reordered = makeEvidenceBundle(pack);
  reordered.issues.reverse();
  reordered.probes.reverse();
  const second = collectFrgPackObservations(pack, reordered);
  assert.equal(serializeFrgPackObservations(first), serializeFrgPackObservations(second));

  const parsed = parseFrgObservationsFile(first);
  assert.deepEqual(parsed.pack_provenance, first.pack_provenance);
  assert.deepEqual(parsed.scenarios?.map((item) => item.source), first.scenarios.map((item) => item.source));
  assert.deepEqual(parsed.composition?.map((item) => item.proof_ids), first.composition.map((item) => item.proof_ids));
});

function scoreCollected(pack: LoadedFrgPack, releaseVersion: string) {
  const observations = parseFrgObservationsFile(
    collectFrgPackObservations(pack, makeEvidenceBundle(pack, releaseVersion)),
  );
  const issueIds = observations.pack_provenance!.issues.map((issue) => String(issue.issue_number));
  return {
    observations,
    evidence: computeFrgEvidence({
      version: releaseVersion,
      run_id: `frg-hybrid-${releaseVersion}`,
      loop_run_id: observations.pack_provenance!.loop_run_id,
      pack_id: FRG_PACK_MANIFEST.pack_id,
      items: issueIds.map((item_id) => ({ item_id, state: "ready", ready_clean: true })),
      scenario_overrides: observations.scenarios,
      composition_overrides: observations.composition,
      false_human_authority_count: observations.false_human_authority_count,
      pack_provenance: observations.pack_provenance,
      attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
      now: () => new Date("2026-08-08T12:10:00.000Z"),
    }),
  };
}

test("hybrid v2 evidence signs structured provenance and fails after provenance mutation", async () => {
  const pack = await loadFrgPack();
  const { observations, evidence } = scoreCollected(pack, "1.33.0");
  assert.equal(observations.pack_provenance!.policy_id, FRG_HYBRID_V2_POLICY_ID);
  assert.equal(evidence.pass, true);
  assert.ok(evidence.integrity.pack_provenance_fingerprint);
  assert.equal(verifyFrgAttestation(evidence, FRG_UNIT_TEST_ATTESTATION_KEY), true);
  assert.equal(parseFrgEvidence(evidence).pass, true);

  const mutated = structuredClone(evidence);
  mutated.pack_provenance!.probes[0]!.stdout_sha256 = "f".repeat(64);
  assert.equal(verifyFrgAttestation(mutated, FRG_UNIT_TEST_ATTESTATION_KEY), false);
  assert.throws(() => parseFrgEvidence(mutated), /pack_provenance_fingerprint/);
});

test("required-live not_observed fails overall pass even when Layer A TAP hashes are valid", async () => {
  const pack = await loadFrgPack();
  const { observations } = scoreCollected(pack, "1.34.0");
  const items = observations.pack_provenance!.issues.map((issue) => ({
    item_id: String(issue.issue_number),
    state: "ready" as const,
    ready_clean: true,
  }));
  const scenarios = observations.scenarios!.map((s) =>
    s.id === "empty-depends-on-stack-honesty"
      ? { ...s, status: "not_observed" as const, detail: "required-live missing" }
      : s,
  );
  const evidence = computeFrgEvidence({
    version: "1.34.0",
    run_id: "frg-hybrid-required-live-miss",
    loop_run_id: observations.pack_provenance!.loop_run_id,
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items,
    scenario_overrides: scenarios,
    composition_overrides: observations.composition,
    false_human_authority_count: 0,
    pack_provenance: observations.pack_provenance,
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(evidence.pass, false);
  assert.equal(
    evidence.scenarios.find((s) => s.id === "empty-depends-on-stack-honesty")?.status,
    "not_observed",
  );
  assert.ok(
    evidence.scenarios
      .filter((s) => !isFrgRequiredLiveScenarioId(s.id))
      .every((s) => s.status === "pass" && s.source === "layer_a"),
  );
});

test("Layer A TAP hash on the same candidate SHA can pass for a version other than 1.33.0", async () => {
  const pack = await loadFrgPack();
  const { observations, evidence } = scoreCollected(pack, "1.34.0");
  assert.equal(observations.pack_provenance!.policy_id, FRG_HYBRID_V2_POLICY_ID);
  assert.equal(observations.pack_provenance!.release_version, "1.34.0");
  assert.equal(evidence.version, "1.34.0");
  assert.equal(evidence.pass, true);
  assert.ok(
    evidence.scenarios
      .filter((s) => !isFrgRequiredLiveScenarioId(s.id))
      .every((s) => s.source === "layer_a" && s.status === "pass"),
  );
  assert.ok(
    evidence.composition.dimensions
      .filter((d) => !isFrgRequiredLiveCompositionId(d.id))
      .every((d) => d.source === "layer_a" && d.status === "pass"),
  );
  assert.equal(parseFrgEvidence(evidence).pass, true);
});

test("unknown or required-live id claimed as layer_a is refused", async () => {
  const pack = await loadFrgPack();
  const { observations } = scoreCollected(pack, "1.34.0");
  const items = observations.pack_provenance!.issues.map((issue) => ({
    item_id: String(issue.issue_number),
    state: "ready" as const,
    ready_clean: true,
  }));
  const common = {
    run_id: "frg-hybrid-refuse-layer-a",
    loop_run_id: observations.pack_provenance!.loop_run_id,
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items,
    false_human_authority_count: 0,
    pack_provenance: observations.pack_provenance,
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
  };

  assert.throws(
    () =>
      parseFrgObservationsFile({
        ...observations,
        composition: observations.composition!.map((item) =>
          item.id === "openspec-bearing-item"
            ? {
                ...item,
                source: "layer_a",
                proof_ids: [`probe:${pack.manifest.pilot_policy.layer_a_probes[0]!.id}`],
              }
            : item,
        ),
      }),
    /source layer_a is refused for required-live id openspec-bearing-item/,
  );

  const layerAOpenSpec = structuredClone(observations);
  const openSpec = layerAOpenSpec.composition!.find((item) => item.id === "openspec-bearing-item")!;
  openSpec.source = "layer_a";
  openSpec.proof_ids = [`probe:${pack.manifest.pilot_policy.layer_a_probes[0]!.id}`];
  assert.equal(
    computeFrgEvidence({
      ...common,
      version: "1.34.0",
      scenario_overrides: observations.scenarios,
      composition_overrides: layerAOpenSpec.composition,
    }).pass,
    false,
  );

  const layerAThroughput = structuredClone(observations.scenarios!);
  const throughput = {
    id: "clean-item-throughput" as const,
    status: "pass" as const,
    detail: "forged required-live as layer_a",
    source: "layer_a" as const,
    proof_ids: [`probe:${pack.manifest.pilot_policy.layer_a_probes[0]!.id}`],
    observed: 2,
    threshold: 2,
  };
  assert.throws(
    () => parseFrgObservationsFile({
      schema_version: 1,
      scenarios: [...layerAThroughput, throughput],
    }),
    /source layer_a is refused for required-live id clean-item-throughput/,
  );
});

test("v1.33.0 cannot pass without provenance and hybrid v1 cannot escape to 1.33.1", async () => {
  const pack = await loadFrgPack();
  const v2 = collectFrgPackObservations(pack, makeEvidenceBundle(pack, "1.33.0"));
  const items = v2.pack_provenance.issues.map((issue) => ({
    item_id: String(issue.issue_number),
    state: "ready" as const,
    ready_clean: true,
  }));
  const common = {
    run_id: "frg-hybrid-boundary",
    loop_run_id: v2.pack_provenance.loop_run_id,
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items,
    scenario_overrides: v2.scenarios,
    composition_overrides: v2.composition,
    false_human_authority_count: 0,
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
  };
  assert.equal(computeFrgEvidence({ ...common, version: "1.33.0" }).pass, false);
  assert.equal(
    computeFrgEvidence({
      ...common,
      version: "1.33.1",
      pack_provenance: v2.pack_provenance,
    }).pass,
    false,
    "v2 provenance collected for 1.33.0 cannot unlock 1.33.1",
  );

  const relabeledV2AsV1 = {
    ...v2.pack_provenance,
    policy_id: FRG_HYBRID_PILOT_POLICY_ID,
    replacement_issue: FRG_HYBRID_REPLACEMENT_ISSUE,
    release_version: "1.33.0",
  };
  assert.equal(
    computeFrgEvidence({
      ...common,
      version: "1.33.0",
      pack_provenance: relabeledV2AsV1,
    }).pass,
    false,
    "current v2 manifest SHA is not authentic historical v1 evidence",
  );
  assert.equal(
    computeFrgEvidence({
      ...common,
      version: "1.33.1",
      pack_provenance: relabeledV2AsV1,
    }).pass,
    false,
    "historical hybrid v1 cannot satisfy 1.33.1",
  );
  assert.throws(
    () => parseFrgObservationsFile({
      schema_version: 1,
      pack_provenance: { ...relabeledV2AsV1, release_version: "1.33.1" },
    }),
    /valid only for 1\.33\.0/,
  );
});

test("authentic historical v1.33.0 evidence with the frozen pre-v2 manifest SHA remains valid", async () => {
  const pack = await loadFrgPack();
  const v2 = collectFrgPackObservations(pack, makeEvidenceBundle(pack, "1.33.0"));
  const items = v2.pack_provenance.issues.map((issue) => ({
    item_id: String(issue.issue_number),
    state: "ready" as const,
    ready_clean: true,
  }));
  const historicalV1 = {
    ...v2.pack_provenance,
    policy_id: FRG_HYBRID_PILOT_POLICY_ID,
    replacement_issue: FRG_HYBRID_REPLACEMENT_ISSUE,
    release_version: "1.33.0",
    manifest_sha256: FRG_HYBRID_V1_MANIFEST_SHA256,
  };
  const common = {
    run_id: "frg-hybrid-historical-v1",
    loop_run_id: historicalV1.loop_run_id,
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items,
    scenario_overrides: v2.scenarios,
    composition_overrides: v2.composition,
    false_human_authority_count: 0,
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    pack_provenance: historicalV1,
  };
  const evidence = computeFrgEvidence({ ...common, version: "1.33.0" });
  assert.equal(historicalV1.manifest_sha256, FRG_HYBRID_V1_MANIFEST_SHA256);
  assert.notEqual(historicalV1.manifest_sha256, pack.manifest_sha256);
  assert.equal(evidence.pass, true);
  assert.equal(hybridPilotProofValid(evidence), true);
  assert.equal(parseFrgEvidence(evidence).pass, true);
  assert.equal(
    computeFrgEvidence({ ...common, version: "1.33.1" }).pass,
    false,
    "authentic historical v1 cannot satisfy 1.33.1",
  );
});

test("runbook states durable hybrid v2 as current policy", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runbook = await fsp.readFile(
    path.join(here, "../../docs/factory-reliability-gate-runbook.md"),
    "utf8",
  );
  assert.match(runbook, /Durable hybrid v2 \(current policy\)/);
  assert.match(runbook, /factory-gate-v1-hybrid-v2/);
  assert.match(runbook, /not_observed` fails \*\*required-live only\*\*/);
  assert.match(runbook, /this candidate SHA/);
  assert.match(runbook, /Historical note: v1\.33\.0 hybrid v1/);
  assert.doesNotMatch(
    runbook,
    /Hybrid Layer A provenance is refused for any version\s+other than exactly `1\.33\.0`/,
  );
});

test("production collector has no CLI or all-pass fixture import", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await fsp.readFile(path.join(here, "../scripts/frg-pack-observations.ts"), "utf8");
  for (const symbol of [
    "frgRequiredObservationOverrides",
    "frgRequiredCompositionOverrides",
    "process.argv",
  ]) {
    assert.ok(!source.includes(symbol), `production collector must not reference ${symbol}`);
  }
  const importSources = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(importSources.every((specifier) => specifier.startsWith("node:")));
});
