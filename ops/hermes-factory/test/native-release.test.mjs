import assert from "node:assert/strict";
import test from "node:test";
import { deriveStartingFrontier, HYBRID_PILOT_VERSION } from "../lib/controller.mjs";
import {
  buildNativeReleaseRequest,
  validateNativeFrgAttestationHandoff,
  validateNativeReleaseCheckpoint,
  validateNativeReleaseRequest,
  validateNativeReleaseResult,
} from "../lib/native-release.mjs";
import { config, validated } from "./helpers.mjs";

const bootstrap = "d".repeat(40);
const release133 = "1".repeat(40);
const candidate134 = "8".repeat(40);

test("stable wrapper moves from the v1.33 hybrid base to the verified installed pin for the next release", () => {
  const machine = config({ bootstrap_base_git_sha: bootstrap, candidate_version: "1.32.0" });
  const pilot = deriveStartingFrontier({
    releaseVersion: HYBRID_PILOT_VERSION,
    config: machine,
    productionPin: { version: "1.31.1", tag: "v1.31.1", git_sha: "0".repeat(40) },
    fetchedBaseTip: bootstrap,
  });
  assert.deepEqual({ sha: pilot.git_sha, version: pilot.candidate_version, pilot: pilot.pilot }, {
    sha: bootstrap,
    version: "1.32.0",
    pilot: true,
  });

  const next = deriveStartingFrontier({
    releaseVersion: "1.34.0",
    config: machine,
    productionPin: { version: "1.33.0", tag: "v1.33.0", git_sha: release133 },
    fetchedBaseTip: release133,
  });
  assert.deepEqual({ sha: next.git_sha, version: next.candidate_version, pilot: next.pilot }, {
    sha: release133,
    version: "1.33.0",
    pilot: false,
  });
  assert.throws(() => deriveStartingFrontier({
    releaseVersion: "1.34.0",
    config: machine,
    productionPin: { version: "1.33.0", tag: "v1.33.0", git_sha: release133 },
    fetchedBaseTip: "f".repeat(40),
  }), /exact current production pin/);
});

test("candidate-native v1.34 request and result bind the full handoff without merge authority", () => {
  const machine = config();
  const grant = validated({}, {
    grant: { release_version: "1.34.0", milestone: "v1.34.0", nonce: "release-1.34.0-run-001" },
  });
  const mergeResults = grant.grant.ordered_issues.map((issue, index) => ({
    issue,
    pr: 100 + index,
    head_oid: String(index + 3).repeat(40),
    merge_oid: String(index + 6).repeat(40),
    base_oid: index === 0 ? release133 : String(index + 5).repeat(40),
  }));
  const request = buildNativeReleaseRequest({
    validated: grant,
    config: machine,
    actionId: "a".repeat(64),
    integratedCandidate: { git_sha: candidate134, version: "1.33.0" },
    productionPin: { version: "1.33.0", tag: "v1.33.0", git_sha: release133 },
    mergeResults,
  });
  validateNativeReleaseRequest(request);
  assert.equal(request.target_version, "1.34.0");
  assert.equal(request.ordered_merges.length, 3);
  assert.equal("merge_authority" in request, false);

  const checkpoint = {
    schema_version: 1,
    kind: "factory_release_frg_checkpoint",
    status: "awaiting_frg_attestation",
    action_id: request.action_id,
    grant_fingerprint: request.grant_fingerprint,
    repository: request.repository,
    base_branch: request.base_branch,
    target_version: request.target_version,
    candidate_git_sha: request.integrated_candidate.git_sha,
    checkpoint: "unsigned-134",
    frg: {
      pack_id: request.frg_manifest.pack_id,
      manifest_path: "/candidate/core/scripts/frg-packs/factory-gate-v1/manifest.json",
      manifest_sha256: request.frg_manifest.sha256,
      pack_run_id: "pack-134",
      loop_run_id: "loop-134",
      frg_run_id: "frg-134",
      evidence_created_at: "2026-08-08T12:00:00.000Z",
      observations: { path: "/state/native/observations.json", sha256: "1".repeat(64) },
      evidence_bundle: { path: "/state/native/evidence-bundle.json", sha256: "2".repeat(64) },
      contract: { path: "/state/native/contract.json", sha256: "3".repeat(64) },
      ledger: { path: "/state/native/ledger.jsonl", sha256: "4".repeat(64) },
      events: { path: "/state/native/events.jsonl", sha256: "5".repeat(64) },
      action_evidence: { path: "/state/native/action-evidence.json", sha256: "6".repeat(64) },
    },
  };
  assert.equal(validateNativeReleaseCheckpoint(checkpoint, request).checkpoint, "unsigned-134");
  assert.throws(
    () => validateNativeReleaseCheckpoint({ ...checkpoint, pass: true }, request),
    /fields are not exact/,
  );
  assert.throws(
    () => validateNativeReleaseCheckpoint({ ...checkpoint, candidate_git_sha: "0".repeat(40) }, request),
    /does not match/,
  );

  const handoff = {
    schema_version: 1,
    kind: "frg_attestation_handoff",
    status: "complete",
    action_id: request.action_id,
    grant_fingerprint: request.grant_fingerprint,
    checkpoint: checkpoint.checkpoint,
    version: request.target_version,
    candidate_git_sha: request.integrated_candidate.git_sha,
    manifest_sha256: checkpoint.frg.manifest_sha256,
    pack_run_id: checkpoint.frg.pack_run_id,
    loop_run_id: checkpoint.frg.loop_run_id,
    frg_run_id: checkpoint.frg.frg_run_id,
    signer: {
      mode: "installed-production",
      version: request.production_pin.version,
      tag: request.production_pin.tag,
      git_sha: request.production_pin.git_sha,
      policy_id: "factory-gate-v2",
      policy_sha256: "7".repeat(64),
    },
    attestation_payload_sha256: "8".repeat(64),
    frg_evidence_path: "/candidate/.agent-pipeline/frg/1.34.0/frg-134/evidence.json",
    frg_evidence_sha256: "9".repeat(64),
    frg_latest_path: "/candidate/.agent-pipeline/frg/1.34.0/latest.json",
    frg_latest_sha256: "9".repeat(64),
  };
  assert.equal(validateNativeFrgAttestationHandoff(handoff, checkpoint, request).frg_run_id, "frg-134");
  assert.throws(
    () => validateNativeFrgAttestationHandoff({ ...handoff, signer: { ...handoff.signer, git_sha: "0".repeat(40) } }, checkpoint, request),
    /current production engine/,
  );

  const result = {
    schema_version: 1,
    kind: "factory_release_prepared",
    status: "complete",
    action_id: request.action_id,
    grant_fingerprint: request.grant_fingerprint,
    repository: request.repository,
    base_branch: request.base_branch,
    target_version: request.target_version,
    milestone: request.milestone,
    candidate_git_sha: request.integrated_candidate.git_sha,
    frg: {
      pack_id: "factory-gate-v1",
      pack_run_id: "pack-134",
      loop_run_id: "loop-134",
      run_id: "frg-134",
      manifest_sha256: request.frg_manifest.sha256,
      evidence_sha256: "e".repeat(64),
    },
    release_pr: { number: 1340, head_oid: "f".repeat(40), base_oid: candidate134 },
    checkpoint: "prepared-134",
  };
  assert.equal(validateNativeReleaseResult(result, request).release_pr.number, 1340);
  assert.throws(
    () => validateNativeReleaseResult({ ...result, candidate_git_sha: "0".repeat(40) }, request),
    /does not match/,
  );
});
