// Honest post-1.33 FRG pass checker (#1038). Injectable I/O only.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  FRG_FROM_RUN_NOTE_PREFIX,
  FRG_NOT_PRODUCT_MILESTONE_NOTE,
  FRG_PACK_MANIFEST,
  FRG_SCORE_RECEIPT_KIND,
  FRG_UNIT_TEST_ATTESTATION_KEY,
  computeFrgEvidence,
  computeFrgScoreReceipt,
  frgLatestPath,
  frgStableFingerprint,
  isHonestPost133FrgPass,
  isReleaseEligibleFrgPass,
  latestJsonForHonestPost133Persist,
  lookupHonestPost133FrgPass,
  parseFrgEvidence,
  parseFrgObservationsFile,
} from "../scripts/factory-reliability-gate.ts";
import { frgPassUniqueOperations } from "./frg-pass-unique-operations.ts";
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
      score_source: "from-run",
      work_list: "factory-gate-pack",
      attestation_key:
        over.attestation_key === undefined ? FRG_UNIT_TEST_ATTESTATION_KEY : over.attestation_key,
      now: () => new Date("2026-08-16T12:10:00.000Z"),
      ...frgPassUniqueOperations(releaseVersion),
    }),
  };
}

function naivePassOnly(evidence: { pass: boolean }): boolean {
  return evidence.pass === true;
}

const HONEST_KEY = { attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY };

function receiptFields(
  evidence: {
    version?: string;
    run_id?: string;
    loop_run_id?: string | null;
    pack_id?: string | null;
    score_source?: "from-run" | "observations" | "unknown";
    work_list?: "factory-gate-pack" | "product-milestone" | "other";
    integrity?: {
      scoreboard_fingerprint?: string;
      composition_fingerprint?: string;
      pack_provenance_fingerprint?: string;
    };
  },
  pass: boolean,
) {
  return {
    pass,
    version: evidence.version,
    run_id: evidence.run_id,
    loop_run_id: evidence.loop_run_id,
    pack_id: evidence.pack_id,
    score_source: evidence.score_source,
    work_list: evidence.work_list,
    scoreboard_fingerprint: evidence.integrity?.scoreboard_fingerprint,
    composition_fingerprint: evidence.integrity?.composition_fingerprint,
    pack_provenance_fingerprint: evidence.integrity?.pack_provenance_fingerprint,
  };
}

/** Public SHA-256 remint of the receipt payload (the forge the HMAC blocks). */
function publicRemintReceipt(
  evidence: Parameters<typeof receiptFields>[0],
  pass: boolean,
): string {
  const fields = receiptFields(evidence, pass);
  return frgStableFingerprint({
    kind: FRG_SCORE_RECEIPT_KIND,
    pass: fields.pass,
    version: fields.version ?? null,
    run_id: fields.run_id ?? null,
    loop_run_id: fields.loop_run_id ?? null,
    pack_id: fields.pack_id ?? null,
    score_source: fields.score_source ?? null,
    work_list: fields.work_list ?? null,
    scoreboard_fingerprint: fields.scoreboard_fingerprint ?? null,
    composition_fingerprint: fields.composition_fingerprint ?? null,
    pack_provenance_fingerprint: fields.pack_provenance_fingerprint ?? null,
  });
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
    isHonestPost133FrgPass(evidence, { attestationKey: null }),
    false,
    "honest-pass fails closed when the producer key is not injected",
  );
  assert.equal(
    isHonestPost133FrgPass(evidence, HONEST_KEY),
    true,
    "production helper must accept a conforming from-run hybrid v2 pass",
  );
  assert.ok(evidence.integrity.score_receipt);
  assert.equal(
    evidence.integrity.score_receipt,
    computeFrgScoreReceipt({
      ...receiptFields(evidence, true),
      attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
    }),
  );
  // Unsigned structural twin: full attestation is optional, but flipping
  // pass — even with a reminted public receipt — is not proof.
  const { evidence: unsigned } = scoreCollected(pack, "1.39.0", { attestation_key: null });
  assert.equal(unsigned.pass, false);
  assert.equal(unsigned.integrity.score_receipt, undefined);
  assert.equal(
    isReleaseEligibleFrgPass(unsigned, { requireAttestation: false }),
    true,
    "HMAC-optional structural eligibility must ignore unsigned pass:false (#1147)",
  );
  assert.equal(
    isHonestPost133FrgPass({ ...unsigned, pass: true }, HONEST_KEY),
    false,
    "hand-edited pass:true on an unsigned fail must not satisfy honest-pass",
  );
  const remintedPublic = {
    ...unsigned,
    pass: true,
    integrity: {
      ...unsigned.integrity,
      score_receipt: publicRemintReceipt(unsigned, true),
    },
  };
  assert.equal(
    isHonestPost133FrgPass(remintedPublic, HONEST_KEY),
    false,
    "reminted public score_receipt after flipping pass must not satisfy honest-pass",
  );
  const remintedWrongKey = {
    ...unsigned,
    pass: true,
    integrity: {
      ...unsigned.integrity,
      score_receipt: computeFrgScoreReceipt({
        ...receiptFields(unsigned, true),
        attestationKey: "not-the-runner-attestation-key",
      }),
    },
  };
  assert.equal(
    isHonestPost133FrgPass(remintedWrongKey, HONEST_KEY),
    false,
    "score_receipt MAC under a different key must not satisfy honest-pass",
  );
});

test("isHonestPost133FrgPass rejects 1.33.0 pass:true as the skip-frg restore precondition", async () => {
  const pack = await loadFrgPack();
  const { evidence } = scoreCollected(pack, "1.33.0");
  assert.equal(evidence.pass, true, "1.33.0 hybrid v2 fixture is a structural pass");
  assert.equal(naivePassOnly(evidence), true);
  assert.equal(
    isHonestPost133FrgPass(evidence, HONEST_KEY),
    false,
    "without the post-1.33 helper, a 1.33.0 pass would unlock skip-frg restore",
  );
});

test("isHonestPost133FrgPass rejects required-live not_observed, unknown layer_a, other-commit TAP, observations, and product milestone", async () => {
  const pack = await loadFrgPack();
  const { observations, evidence } = scoreCollected(pack, "1.39.0");
  assert.equal(isHonestPost133FrgPass(evidence, HONEST_KEY), true);

  const notObserved = structuredClone(evidence);
  const honesty = notObserved.scenarios.find((s) => s.id === "empty-depends-on-stack-honesty");
  assert.ok(honesty);
  honesty.status = "not_observed";
  notObserved.pass = true;
  assert.equal(naivePassOnly(notObserved), true);
  assert.equal(isHonestPost133FrgPass(notObserved, HONEST_KEY), false);

  const unknownLayerA = structuredClone(evidence);
  const openSpec = unknownLayerA.composition.dimensions.find((d) => d.id === "openspec-bearing-item");
  assert.ok(openSpec);
  openSpec.source = "layer_a";
  openSpec.proof_ids = [`probe:${pack.manifest.pilot_policy.layer_a_probes[0]!.id}`];
  unknownLayerA.pass = true;
  assert.equal(isHonestPost133FrgPass(unknownLayerA, HONEST_KEY), false);

  const otherCommit = structuredClone(evidence);
  otherCommit.pack_provenance!.probes = otherCommit.pack_provenance!.probes.map((probe) => ({
    ...probe,
    candidate_git_sha: "b".repeat(40),
  }));
  otherCommit.integrity.pack_provenance_fingerprint = undefined;
  otherCommit.pass = true;
  assert.equal(isHonestPost133FrgPass(otherCommit, HONEST_KEY), false);

  const missingTap = structuredClone(evidence);
  const firstLayerA = missingTap.scenarios.find(
    (s) => s.source === "layer_a" && !isFrgRequiredLiveScenarioId(s.id),
  );
  assert.ok(firstLayerA);
  firstLayerA.proof_ids = [];
  missingTap.pass = true;
  assert.equal(isHonestPost133FrgPass(missingTap, HONEST_KEY), false);

  assert.equal(
    isHonestPost133FrgPass(evidence, { ...HONEST_KEY, usedObservationsFile: true }),
    false,
  );
  assert.equal(
    isHonestPost133FrgPass(evidence, { ...HONEST_KEY, scoreSource: "observations" }),
    false,
  );
  const obsNotes = {
    ...evidence,
    notes: [...(evidence.notes ?? []), "scored from observations file /tmp/obs.json"],
  };
  assert.equal(isHonestPost133FrgPass(obsNotes, HONEST_KEY), false);

  assert.equal(
    isHonestPost133FrgPass(evidence, { ...HONEST_KEY, workList: "product-milestone" }),
    false,
  );
  const milestoneNotes = {
    ...evidence,
    notes: ["Projected from durable loop run loop-milestone", "product v1.39 milestone work-list"],
  };
  assert.equal(isHonestPost133FrgPass(milestoneNotes, HONEST_KEY), false);

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
  assert.equal(isHonestPost133FrgPass(failed, HONEST_KEY), false);
  assert.equal(
    latestJsonForHonestPost133Persist(failed, HONEST_KEY).pass,
    false,
    "persist must keep the scorer's pass:false",
  );

  const requiredLiveFail = structuredClone(evidence);
  const tax = requiredLiveFail.scenarios.find((s) => s.id === "blocker-taxonomy");
  assert.ok(tax);
  tax.status = "not_observed";
  requiredLiveFail.pass = false;
  const persisted = latestJsonForHonestPost133Persist(requiredLiveFail, HONEST_KEY);
  assert.equal(persisted.pass, false);
  assert.equal(isHonestPost133FrgPass(persisted, HONEST_KEY), false);
});

test("isHonestPost133FrgPass rejects missing/other work-list and note-only from-run", async () => {
  const pack = await loadFrgPack();
  const { evidence } = scoreCollected(pack, "1.39.0");
  assert.equal(isHonestPost133FrgPass(evidence, HONEST_KEY), true);

  const { work_list: _work, ...noWorkList } = evidence;
  assert.equal(isHonestPost133FrgPass(noWorkList, HONEST_KEY), false);
  assert.equal(isHonestPost133FrgPass({ ...evidence, work_list: "other" }, HONEST_KEY), false);
  assert.equal(isHonestPost133FrgPass({ ...evidence, work_list: undefined }, HONEST_KEY), false);
  assert.equal(isHonestPost133FrgPass(evidence, { ...HONEST_KEY, workList: "other" }), false);
  assert.equal(
    isHonestPost133FrgPass({ ...noWorkList, notes: fromRunNotes("loop-frg-honest") }, HONEST_KEY),
    false,
  );

  const { score_source: _src, ...noSource } = evidence;
  assert.equal(isHonestPost133FrgPass(noSource, HONEST_KEY), false);
  assert.equal(isHonestPost133FrgPass({ ...evidence, score_source: "unknown" }, HONEST_KEY), false);
  assert.equal(isHonestPost133FrgPass(noSource, { ...HONEST_KEY, scoreSource: "from-run" }), false);
  const editedNotes = {
    ...noSource,
    notes: [`${FRG_FROM_RUN_NOTE_PREFIX}loop-frg-honest`, "hand-edited from-run claim"],
  };
  assert.equal(isHonestPost133FrgPass(editedNotes, HONEST_KEY), false);

  const persistFail = latestJsonForHonestPost133Persist(
    { ...evidence, pass: false },
    { ...HONEST_KEY, scoreSource: "from-run", workList: "factory-gate-pack" },
  );
  assert.equal(persistFail.pass, false);

  const persistOk = latestJsonForHonestPost133Persist(evidence, HONEST_KEY);
  assert.equal(persistOk.pass, true);
  assert.equal(persistOk.score_source, "from-run");
  assert.equal(persistOk.work_list, "factory-gate-pack");

  const persistStamped = latestJsonForHonestPost133Persist(noSource, {
    ...HONEST_KEY,
    scoreSource: "from-run",
    workList: "factory-gate-pack",
  });
  assert.equal(persistStamped.pass, false);
  assert.equal(persistStamped.score_source, undefined);
  assert.equal(persistStamped.work_list, "factory-gate-pack");

  const persistNoWork = latestJsonForHonestPost133Persist(noWorkList, {
    ...HONEST_KEY,
    scoreSource: "from-run",
    workList: "factory-gate-pack",
  });
  assert.equal(persistNoWork.pass, false);
  assert.equal(persistNoWork.work_list, undefined);
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

  const found = await lookupHonestPost133FrgPass("/repo", deps, HONEST_KEY);
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
