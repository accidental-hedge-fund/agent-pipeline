import { canonicalJson } from "./grant.mjs";
import { sha256 } from "./artifact-proof.mjs";

const REQUEST_KEYS = [
  "schema_version", "kind", "action_id", "grant_fingerprint", "repository", "base_branch",
  "target_version", "milestone", "ordered_merges", "integrated_candidate", "production_pin",
  "controller_revision", "engine_fingerprint", "policy_fingerprint", "frg_manifest",
];
const RESULT_KEYS = [
  "schema_version", "kind", "status", "action_id", "grant_fingerprint", "repository", "base_branch",
  "target_version", "milestone", "candidate_git_sha", "frg", "release_pr", "checkpoint",
];
const CHECKPOINT_KEYS = [
  "schema_version", "kind", "status", "action_id", "grant_fingerprint", "repository", "base_branch",
  "target_version", "candidate_git_sha", "checkpoint", "frg",
];
const CHECKPOINT_FRG_KEYS = [
  "pack_id", "manifest_path", "manifest_sha256", "pack_run_id", "loop_run_id", "frg_run_id",
  "evidence_created_at", "observations", "evidence_bundle", "contract", "ledger", "events",
  "action_evidence",
];
const HANDOFF_KEYS = [
  "schema_version", "kind", "status", "action_id", "grant_fingerprint", "checkpoint", "version",
  "candidate_git_sha", "manifest_sha256", "pack_run_id", "loop_run_id", "frg_run_id", "signer",
  "attestation_payload_sha256", "frg_evidence_path", "frg_evidence_sha256", "frg_latest_path",
  "frg_latest_sha256",
];
const SIGNER_KEYS = ["mode", "version", "tag", "git_sha", "policy_id", "policy_sha256"];

function exactKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length || missing.length) {
    throw new Error(`${name} fields are not exact`);
  }
}

function oid(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function safeId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value) || value.includes("..")) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function buildNativeReleaseRequest({ validated, config, actionId, integratedCandidate, productionPin, mergeResults }) {
  if (!Array.isArray(mergeResults) || mergeResults.length !== validated.grant.ordered_issues.length) {
    throw new Error("native release request requires every ordered merge result");
  }
  const orderedMerges = mergeResults.map((result, index) => {
    const issue = validated.grant.ordered_issues[index];
    if (result?.issue !== issue) throw new Error("native release merge order does not match the grant");
    if (!Number.isSafeInteger(result.pr) || result.pr <= 0) throw new Error("native release merge PR is invalid");
    return {
      issue,
      pr: result.pr,
      candidate_head: oid(result.head_oid, "merge candidate head"),
      merge_oid: oid(result.merge_oid, "merge result"),
      base_oid: oid(result.base_oid, "merge base"),
    };
  });
  let expectedBase = productionPin.git_sha;
  for (const merge of orderedMerges) {
    if (merge.base_oid !== expectedBase) throw new Error("native release merge results are not one contiguous train");
    expectedBase = merge.merge_oid;
  }
  if (expectedBase !== integratedCandidate.git_sha) {
    throw new Error("native release merge train does not end at the integrated candidate");
  }
  const policyFingerprint = sha256(canonicalJson({
    actions: validated.grant.actions,
    model: validated.grant.model,
    manifest_sha256: config.frg_pack_manifest_sha256,
  }));
  const engineFingerprint = sha256(canonicalJson({
    candidate_git_sha: integratedCandidate.git_sha,
    production_pin: productionPin,
    candidate_command: config.candidate_pipeline_command,
  }));
  return {
    schema_version: 1,
    kind: "factory_release_prepare_request",
    action_id: safeId(actionId, "native release action_id"),
    grant_fingerprint: validated.fingerprint,
    repository: validated.grant.repository,
    base_branch: validated.grant.base_branch,
    target_version: validated.grant.release_version,
    milestone: validated.grant.milestone,
    ordered_merges: orderedMerges,
    integrated_candidate: { git_sha: oid(integratedCandidate.git_sha, "integrated candidate"), version: integratedCandidate.version },
    production_pin: { version: productionPin.version, tag: productionPin.tag, git_sha: oid(productionPin.git_sha, "production pin") },
    controller_revision: oid(config.wrapper_git_sha, "controller revision"),
    engine_fingerprint: engineFingerprint,
    policy_fingerprint: policyFingerprint,
    frg_manifest: { pack_id: "factory-gate-v1", sha256: config.frg_pack_manifest_sha256 },
  };
}

export function validateNativeReleaseRequest(request) {
  exactKeys(request, REQUEST_KEYS, "native release request");
  return request;
}

export function validateNativeReleaseCheckpoint(result, request) {
  exactKeys(result, CHECKPOINT_KEYS, "native release FRG checkpoint");
  if (
    result.schema_version !== 1 ||
    result.kind !== "factory_release_frg_checkpoint" ||
    result.status !== "awaiting_frg_attestation" ||
    result.action_id !== request.action_id ||
    result.grant_fingerprint !== request.grant_fingerprint ||
    result.repository !== request.repository ||
    result.base_branch !== request.base_branch ||
    result.target_version !== request.target_version ||
    result.candidate_git_sha !== request.integrated_candidate.git_sha
  ) {
    throw new Error("native release FRG checkpoint does not match its request");
  }
  safeId(result.checkpoint, "native release checkpoint");
  exactKeys(result.frg, CHECKPOINT_FRG_KEYS, "native release unsigned FRG checkpoint");
  if (
    result.frg.pack_id !== request.frg_manifest.pack_id ||
    result.frg.manifest_sha256 !== request.frg_manifest.sha256
  ) {
    throw new Error("native release FRG checkpoint has invalid manifest identity");
  }
  for (const [name, value] of [
    ["pack_run_id", result.frg.pack_run_id],
    ["loop_run_id", result.frg.loop_run_id],
    ["frg_run_id", result.frg.frg_run_id],
  ]) safeId(value, name);
  if (!Number.isFinite(Date.parse(result.frg.evidence_created_at ?? ""))) {
    throw new Error("native release FRG checkpoint evidence time is invalid");
  }
  absolutePath(result.frg.manifest_path, "FRG manifest path");
  digest(result.frg.manifest_sha256, "FRG manifest digest");
  for (const stem of ["observations", "evidence_bundle", "contract", "ledger", "events", "action_evidence"]) {
    exactKeys(result.frg[stem], ["path", "sha256"], `${stem} artifact`);
    absolutePath(result.frg[stem].path, `${stem} path`);
    digest(result.frg[stem].sha256, `${stem} digest`);
  }
  return result;
}

export function validateNativeFrgAttestationHandoff(handoff, checkpoint, request) {
  exactKeys(handoff, HANDOFF_KEYS, "native release FRG attestation handoff");
  if (
    handoff.schema_version !== 1 ||
    handoff.kind !== "frg_attestation_handoff" ||
    handoff.status !== "complete" ||
    handoff.action_id !== request.action_id ||
    handoff.grant_fingerprint !== request.grant_fingerprint ||
    handoff.checkpoint !== checkpoint.checkpoint ||
    handoff.version !== request.target_version ||
    handoff.candidate_git_sha !== request.integrated_candidate.git_sha ||
    handoff.manifest_sha256 !== checkpoint.frg.manifest_sha256 ||
    handoff.pack_run_id !== checkpoint.frg.pack_run_id ||
    handoff.loop_run_id !== checkpoint.frg.loop_run_id ||
    handoff.frg_run_id !== checkpoint.frg.frg_run_id
  ) {
    throw new Error("native release FRG attestation handoff does not match its checkpoint");
  }
  exactKeys(handoff.signer, SIGNER_KEYS, "native release FRG signer");
  if (
    handoff.signer.mode !== "installed-production" ||
    handoff.signer.version !== request.production_pin.version ||
    handoff.signer.tag !== request.production_pin.tag ||
    handoff.signer.git_sha !== request.production_pin.git_sha
  ) {
    throw new Error("native release FRG signer is not the verified current production engine");
  }
  safeId(handoff.signer.mode, "FRG signer mode");
  safeId(handoff.signer.version, "FRG signer version");
  safeId(handoff.signer.tag, "FRG signer tag");
  oid(handoff.signer.git_sha, "FRG signer commit");
  safeId(handoff.signer.policy_id, "FRG signer policy");
  digest(handoff.signer.policy_sha256, "FRG signer policy digest");
  digest(handoff.attestation_payload_sha256, "FRG attestation payload digest");
  absolutePath(handoff.frg_evidence_path, "FRG evidence path");
  digest(handoff.frg_evidence_sha256, "FRG evidence digest");
  absolutePath(handoff.frg_latest_path, "FRG latest path");
  digest(handoff.frg_latest_sha256, "FRG latest digest");
  return handoff;
}

export function validateNativeReleaseResult(result, request) {
  exactKeys(result, RESULT_KEYS, "native release result");
  if (
    result.schema_version !== 1 ||
    result.kind !== "factory_release_prepared" ||
    result.status !== "complete" ||
    result.action_id !== request.action_id ||
    result.grant_fingerprint !== request.grant_fingerprint ||
    result.repository !== request.repository ||
    result.base_branch !== request.base_branch ||
    result.target_version !== request.target_version ||
    result.milestone !== request.milestone ||
    result.candidate_git_sha !== request.integrated_candidate.git_sha
  ) {
    throw new Error("native release result does not match its request");
  }
  exactKeys(result.frg, ["pack_id", "pack_run_id", "loop_run_id", "run_id", "manifest_sha256", "evidence_sha256"], "native release FRG result");
  if (
    result.frg.pack_id !== request.frg_manifest.pack_id ||
    result.frg.manifest_sha256 !== request.frg_manifest.sha256 ||
    !/^[a-f0-9]{64}$/.test(result.frg.evidence_sha256 ?? "")
  ) {
    throw new Error("native release result has invalid FRG identity");
  }
  for (const [name, value] of [["pack_run_id", result.frg.pack_run_id], ["loop_run_id", result.frg.loop_run_id], ["frg run_id", result.frg.run_id]]) {
    safeId(value, name);
  }
  exactKeys(result.release_pr, ["number", "head_oid", "base_oid"], "native release PR result");
  if (!Number.isSafeInteger(result.release_pr.number) || result.release_pr.number <= 0) {
    throw new Error("native release PR number is invalid");
  }
  oid(result.release_pr.head_oid, "native release PR head");
  if (result.release_pr.base_oid !== request.integrated_candidate.git_sha) {
    throw new Error("native release PR base does not match the integrated candidate");
  }
  safeId(result.checkpoint, "native release checkpoint");
  return result;
}
