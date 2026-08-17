// Honest post-1.33 FRG pass checker (#1038). Injectable I/O only.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  FRG_FROM_RUN_NOTE_PREFIX,
  FRG_NOT_PRODUCT_MILESTONE_NOTE,
  FRG_PACK_MANIFEST,
  FRG_UNIT_TEST_ATTESTATION_KEY,
  computeFrgEvidence,
  frgLatestPath,
  isHonestPost133FrgPass,
  isReleaseEligibleFrgPass,
  latestJsonForHonestPost133Persist,
  lookupHonestPost133FrgPass,
  parseFrgEvidence,
  parseFrgObservationsFile,
} from "../scripts/factory-reliability-gate.ts";
import {
  collectFrgPackObservations,
  isFrgRequiredLiveCompositionId,
  isFrgRequiredLiveScenarioId,
  loadFrgPack,
  renderFrgPackIssues,
  type LoadedFrgPack,
  type VerifiedFrgPackRun,
} from "../scripts/frg-pack-observations.ts";

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fromRunNotes(loopRunId: string): string[] {
  return [
    `${FRG_FROM_RUN_NOTE_PREFIX}${loopRunId}`,
    `FRG fixed pack validated: pack_id=${FRG_PACK_MANIFEST.pack_id} selector=${JSON.stringify({ type: "label", value: "factory-gate" })}`,
    FRG_NOT_PRODUCT_MILESTONE_NOTE,
  ];
}

function makeEvidenceBundle(
  pack: LoadedFrgPack,
  releaseVersion: string,
): VerifiedFrgPackRun {
  const packRunId = "frg-pack-run-honest";
  const loopRunId = "loop-frg-honest";
  const candidateGitSha = "a".repeat(40);
  const startedAt = "2026-08-16T12:00:00.000Z";
  const rendered = renderFrgPackIssues(pack, {
    release_version: releaseVersion,
    pack_run_id: packRunId,
  });
  const issueNumbers = rendered.map((_, index) => 1101 + index);
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
            "openspec/changes/archive/2026-08-16-frg/proposal.md",
            "openspec/specs/frg/spec.md",
          ]
        : ["docs/frg-fixture.md"];
      return {
        issue_number: issueNumber,
        issue_node_id: `ISSUE_${issueNumber}`,
        created_at: `2026-08-16T12:00:0${index + 1}.000Z`,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels, "pipeline:ready-to-deploy"],
        template_id: issue.provenance.template_id,
        template_sha256: issue.provenance.template_sha256,
        pr: {
          number: 2101 + index,
          node_id: `PR_${2101 + index}`,
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
      started_at: `2026-08-16T12:01:${String(index).padStart(2, "0")}.000Z`,
      finished_at: `2026-08-16T12:01:${String(index).padStart(2, "0")}.500Z`,
    })),
  };
}

function scoreCollected(
  pack: LoadedFrgPack,
  releaseVersion: string,
  over: { attestation_key?: string | null; notes?: string[] } = {},
) {
  const observations = parseFrgObservationsFile(
    collectFrgPackObservations(pack, makeEvidenceBundle(pack, releaseVersion)),
  );
  const loopRunId = observations.pack_provenance!.loop_run_id;
  const issueIds = observations.pack_provenance!.issues.map((issue) => String(issue.issue_number));
  return {
    observations,
    evidence: computeFrgEvidence({
      version: releaseVersion,
      run_id: `frg-honest-${releaseVersion}`,
      loop_run_id: loopRunId,
      pack_id: FRG_PACK_MANIFEST.pack_id,
      items: issueIds.map((item_id) => ({ item_id, state: "ready", ready_clean: true })),
      scenario_overrides: observations.scenarios,
      composition_overrides: observations.composition,
      false_human_authority_count: observations.false_human_authority_count,
      pack_provenance: observations.pack_provenance,
      notes: over.notes ?? fromRunNotes(loopRunId),
      attestation_key:
        over.attestation_key === undefined ? FRG_UNIT_TEST_ATTESTATION_KEY : over.attestation_key,
      now: () => new Date("2026-08-16T12:10:00.000Z"),
    }),
  };
}

function naivePassOnly(evidence: { pass: boolean }): boolean {
  return evidence.pass === true;
}

test("isHonestPost133FrgPass accepts a fixture post-1.33 from-run pass (fails if helper is pass-only)", async () => {
  const pack = await loadFrgPack();
  const { evidence } = scoreCollected(pack, "1.39.0");
  assert.equal(evidence.pass, true);
  assert.equal(evidence.pack_id, "factory-gate-v1");
  assert.ok(evidence.loop_run_id);
  assert.ok(evidence.pack_provenance?.candidate_git_sha);
  assert.equal(isReleaseEligibleFrgPass(evidence, { requireAttestation: false }), true);
  assert.equal(
    isHonestPost133FrgPass(evidence),
    true,
    "production helper must accept a conforming from-run hybrid v2 pass",
  );
  // Unsigned structural twin: HMAC is not this issue's missing proof.
  const { evidence: unsigned } = scoreCollected(pack, "1.39.0", { attestation_key: null });
  assert.equal(unsigned.pass, false);
  assert.equal(isHonestPost133FrgPass({ ...unsigned, pass: true }), true);
});

test("isHonestPost133FrgPass rejects 1.33.0 pass:true as the skip-frg restore precondition", async () => {
  const pack = await loadFrgPack();
  const { evidence } = scoreCollected(pack, "1.33.0");
  assert.equal(evidence.pass, true, "1.33.0 hybrid v2 fixture is a structural pass");
  assert.equal(naivePassOnly(evidence), true);
  assert.equal(
    isHonestPost133FrgPass(evidence),
    false,
    "without the post-1.33 helper, a 1.33.0 pass would unlock skip-frg restore",
  );
});

test("isHonestPost133FrgPass rejects required-live not_observed, unknown layer_a, other-commit TAP, observations, and product milestone", async () => {
  const pack = await loadFrgPack();
  const { observations, evidence } = scoreCollected(pack, "1.39.0");
  assert.equal(isHonestPost133FrgPass(evidence), true);

  const notObserved = structuredClone(evidence);
  const honesty = notObserved.scenarios.find((s) => s.id === "empty-depends-on-stack-honesty");
  assert.ok(honesty);
  honesty.status = "not_observed";
  notObserved.pass = true;
  assert.equal(naivePassOnly(notObserved), true);
  assert.equal(isHonestPost133FrgPass(notObserved), false);

  const unknownLayerA = structuredClone(evidence);
  const openSpec = unknownLayerA.composition.dimensions.find((d) => d.id === "openspec-bearing-item");
  assert.ok(openSpec);
  openSpec.source = "layer_a";
  openSpec.proof_ids = [`probe:${pack.manifest.pilot_policy.layer_a_probes[0]!.id}`];
  unknownLayerA.pass = true;
  assert.equal(isHonestPost133FrgPass(unknownLayerA), false);

  const otherCommit = structuredClone(evidence);
  otherCommit.pack_provenance!.probes = otherCommit.pack_provenance!.probes.map((probe) => ({
    ...probe,
    candidate_git_sha: "b".repeat(40),
  }));
  otherCommit.integrity.pack_provenance_fingerprint = undefined;
  otherCommit.pass = true;
  assert.equal(isHonestPost133FrgPass(otherCommit), false);

  const missingTap = structuredClone(evidence);
  const firstLayerA = missingTap.scenarios.find(
    (s) => s.source === "layer_a" && !isFrgRequiredLiveScenarioId(s.id),
  );
  assert.ok(firstLayerA);
  firstLayerA.proof_ids = [];
  missingTap.pass = true;
  assert.equal(isHonestPost133FrgPass(missingTap), false);

  assert.equal(
    isHonestPost133FrgPass(evidence, { usedObservationsFile: true }),
    false,
  );
  assert.equal(
    isHonestPost133FrgPass(evidence, { scoreSource: "observations" }),
    false,
  );
  const obsNotes = {
    ...evidence,
    notes: [...(evidence.notes ?? []), "scored from observations file /tmp/obs.json"],
  };
  assert.equal(isHonestPost133FrgPass(obsNotes), false);

  assert.equal(
    isHonestPost133FrgPass(evidence, { workList: "product-milestone" }),
    false,
  );
  const milestoneNotes = {
    ...evidence,
    notes: ["Projected from durable loop run loop-milestone", "product v1.39 milestone work-list"],
  };
  assert.equal(isHonestPost133FrgPass(milestoneNotes), false);

  // Observations-file provenance must not become authority even when the
  // collector-shaped payload would otherwise be release-eligible.
  assert.ok(observations.pack_provenance);
  assert.equal(
    isFrgRequiredLiveCompositionId("openspec-bearing-item"),
    true,
  );
  assert.ok(
    evidence.composition.dimensions.every((d) =>
      isFrgRequiredLiveCompositionId(d.id) ? d.source !== "layer_a" : true,
    ),
  );
});

test("isHonestPost133FrgPass rejects pass:false and persist does not unlock a fail", async () => {
  const pack = await loadFrgPack();
  const { evidence } = scoreCollected(pack, "1.39.0");
  const failed = { ...evidence, pass: false };
  assert.equal(isHonestPost133FrgPass(failed), false);
  assert.equal(latestJsonForHonestPost133Persist(failed).pass, true, "unsigned-or-signed structural pass persists as true");

  const requiredLiveFail = structuredClone(evidence);
  const tax = requiredLiveFail.scenarios.find((s) => s.id === "blocker-taxonomy");
  assert.ok(tax);
  tax.status = "not_observed";
  requiredLiveFail.pass = false;
  const persisted = latestJsonForHonestPost133Persist(requiredLiveFail);
  assert.equal(persisted.pass, false);
  assert.equal(isHonestPost133FrgPass(persisted), false);
});

test("lookupHonestPost133FrgPass injects I/O and ignores 1.33.0 / fail / unparsable", async () => {
  const pack = await loadFrgPack();
  const { evidence: v133 } = scoreCollected(pack, "1.33.0");
  const { evidence: v139 } = scoreCollected(pack, "1.39.0");
  const { evidence: fail139 } = scoreCollected(pack, "1.39.1");
  const failWritten = { ...fail139, pass: false };

  const files = new Map<string, string>();
  files.set(frgLatestPath("/repo", "1.33.0"), JSON.stringify(v133));
  files.set(frgLatestPath("/repo", "1.39.1"), JSON.stringify(failWritten));
  files.set(frgLatestPath("/repo", "1.39.0"), JSON.stringify(v139));
  files.set("/repo/.agent-pipeline/frg/not-a-version/latest.json", "{}");

  const deps = {
    async readFile(p: string) {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    async readdir(dir: string) {
      if (dir !== "/repo/.agent-pipeline/frg") {
        const err = new Error(`ENOENT: ${dir}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return ["1.33.0", "1.39.1", "1.39.0", "trend-ledger.jsonl", "not-a-version"];
    },
  };

  const found = await lookupHonestPost133FrgPass("/repo", deps);
  assert.ok(found);
  assert.equal(found.version, "1.39.0");
  assert.equal(found.path, frgLatestPath("/repo", "1.39.0"));
  assert.equal(found.evidence.run_id, v139.run_id);
  assert.equal(parseFrgEvidence(found.evidence).pass, true);

  const onlyHistorical = await lookupHonestPost133FrgPass("/repo", {
    readFile: async (p) => {
      if (p === frgLatestPath("/repo", "1.33.0")) return JSON.stringify(v133);
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    readdir: async () => ["1.33.0"],
  });
  assert.equal(onlyHistorical, null);

  const missingRoot = await lookupHonestPost133FrgPass("/empty", {
    readFile: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readdir: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(missingRoot, null);
});
