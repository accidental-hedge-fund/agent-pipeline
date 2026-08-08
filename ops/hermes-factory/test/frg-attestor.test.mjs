import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  parseFrgAttestorCli,
  validateFrgAttestationRequest,
} from "../lib/frg-attestor.mjs";
import {
  submitFrgAttestation,
  validateFrgAttestationHandoff,
} from "../lib/frg-runner.mjs";
import { config as configFixture } from "./helpers.mjs";

const requestRoot = "/state/frg-scorer-requests";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function privateWrite(path, body, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, body, { mode });
  await chmod(path, mode);
}

function request(overrides = {}) {
  return {
    schema_version: 1,
    kind: "frg_attestation_request",
    request_id: "pack-133",
    grant_fingerprint: "f".repeat(64),
    action_id: "a".repeat(64),
    version: "1.33.0",
    repository: "owner/repo",
    base_branch: "main",
    candidate_git_sha: "c".repeat(40),
    manifest_sha256: "1".repeat(64),
    pack_run_id: "pack-133",
    loop_run_id: "loop-133",
    frg_run_id: "frg-133",
    evidence_created_at: "2026-08-08T12:00:00Z",
    observations_sha256: "2".repeat(64),
    evidence_bundle_sha256: "3".repeat(64),
    contract_sha256: "4".repeat(64),
    ledger_sha256: "5".repeat(64),
    events_sha256: "6".repeat(64),
    action_evidence_sha256: "7".repeat(64),
    ...overrides,
  };
}

test("credentialed attestor has no child-process or candidate-selected code surface", async () => {
  const source = await readFile(new URL("../lib/frg-attestor.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|runProcess|\bexec\s*\(|\bspawn\s*\(/);
  assert.doesNotMatch(source, /pathToFileURL|candidate_checkout|collector_path|pipeline_path|request\.(?:module|command|import)/);
  assert.deepEqual(
    parseFrgAttestorCli(["attest", "--request", "/state/frg-scorer-requests/pack-133.json"]),
    { mode: "attest", request: "/state/frg-scorer-requests/pack-133.json" },
  );
  assert.throws(
    () => parseFrgAttestorCli(["attest", "--request", "relative.json"]),
    /absolute-path/,
  );
});

test("attestation request is an exact path-free identity envelope", () => {
  const path = `${requestRoot}/pack-133.json`;
  assert.equal(validateFrgAttestationRequest(request(), path, requestRoot).action_id, "a".repeat(64));
  for (const forbidden of ["candidate_checkout", "collector_path", "pipeline_path", "result_path", "pass", "status", "metrics"]) {
    assert.throws(
      () => validateFrgAttestationRequest(request({ [forbidden]: forbidden }), path, requestRoot),
      /fields are not exact/,
    );
  }
  assert.throws(
    () => validateFrgAttestationRequest(request(), `${requestRoot}/replayed.json`, requestRoot),
    /filename does not match request_id/,
  );
});

test("later-release adapter submits one closed request, reconciles, and rejects replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frg-attest-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoDir = join(root, "repo");
  const stateDir = join(root, "state");
  const wrapperDir = join(root, "wrapper");
  const manifestPath = join(repoDir, "core", "scripts", "frg-packs", "factory-gate-v1", "manifest.json");
  const manifestText = "manifest-v2\n";
  await privateWrite(manifestPath, manifestText);
  const fingerprint = "f".repeat(64);
  const actionId = "a".repeat(64);
  const checkpointRoot = join(stateDir, "native-release", fingerprint, "1.34.0");
  const checkpointPath = join(checkpointRoot, `${actionId}.checkpoint.json`);
  const sourceRoot = join(stateDir, "native-source", actionId);
  const artifactNames = ["observations", "evidence_bundle", "contract", "ledger", "events", "action_evidence"];
  const artifacts = {};
  for (const name of artifactNames) {
    const path = join(sourceRoot, `${name}.data`);
    const body = `${name}:unsigned\n`;
    await privateWrite(path, body);
    artifacts[name] = { path, sha256: sha256(body) };
  }
  const productionPin = {
    schema_version: 1,
    version: "1.33.0",
    tag: "v1.33.0",
    git_sha: "b".repeat(40),
    frg_run_id: "frg-133",
    promoted_at: "2026-08-08T12:00:00Z",
  };
  const machine = configFixture({
    repo_dir: repoDir,
    state_dir: stateDir,
    inbox_dir: join(stateDir, "inbox"),
    active_grant_file: join(stateDir, "active-grant.json"),
    control_file: join(stateDir, "control.json"),
    artifact_checkout: join(stateDir, "artifact"),
    production_pin_file: join(stateDir, "production-engine.json"),
    wrapper_dir: wrapperDir,
    wrapper_manifest_file: join(wrapperDir, "pinned-artifacts.json"),
    frg_pack_manifest: manifestPath,
    frg_pack_manifest_sha256: sha256(manifestText),
    pipeline_loop_state_dir: join(stateDir, "pipeline-loops"),
    frg_scorer_request_dir: join(stateDir, "frg-scorer-requests"),
    candidate_pipeline_command: ["/usr/bin/node", "--experimental-strip-types", join(repoDir, "core", "scripts", "pipeline.ts")],
    frg_runner_command: ["/usr/bin/node", join(wrapperDir, "lib", "frg-runner.mjs")],
  });
  const configPath = join(root, "config.json");
  await privateWrite(configPath, `${JSON.stringify(machine)}\n`);
  await privateWrite(machine.production_pin_file, `${JSON.stringify(productionPin)}\n`);
  const checkpoint = {
    schema_version: 1,
    kind: "factory_release_frg_checkpoint",
    status: "awaiting_frg_attestation",
    action_id: actionId,
    grant_fingerprint: fingerprint,
    repository: machine.repository,
    base_branch: machine.base_branch,
    target_version: "1.34.0",
    candidate_git_sha: "c".repeat(40),
    checkpoint: "unsigned-134",
    frg: {
      pack_id: "factory-gate-v1",
      manifest_path: manifestPath,
      manifest_sha256: machine.frg_pack_manifest_sha256,
      pack_run_id: "pack-134",
      loop_run_id: "loop-134",
      frg_run_id: "frg-134",
      evidence_created_at: "2026-08-08T12:00:00.000Z",
      ...artifacts,
    },
  };
  await privateWrite(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
  let starts = 0;
  const deps = {
    env: { PATH: "/usr/bin", HOME: root },
    verifyNativeTrustRoot: async () => {},
    shouldStop: async () => null,
    sleep: async () => {},
    unitState: async () => ({ state: "missing", active_state: "inactive" }),
    stopUnit: async () => {},
    startScorer: async (requestPath) => {
      starts++;
      const closed = JSON.parse(await readFile(requestPath, "utf8"));
      assert.equal("candidate_checkout" in closed, false);
      assert.equal("pipeline_path" in closed, false);
      assert.equal("pass" in closed, false);
      const runDir = join(stateDir, "frg", fingerprint, closed.version, closed.pack_run_id);
      const evidence = {
        pass: true,
        version: closed.version,
        run_id: closed.frg_run_id,
        loop_run_id: closed.loop_run_id,
        pack_id: "factory-gate-v1",
        created_at: closed.evidence_created_at,
        scoreboard: { item_count: 2, ready_clean_count: 2, engine_class_count: 0, engine_class_rate: 0 },
        thresholds: { min_clean_ready_to_deploy: 2, max_engine_class_rate: 0.1 },
        composition: { missing: [], false_human_authority_count: 0 },
      };
      const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
      await privateWrite(join(runDir, "attested-evidence.json"), evidenceText);
      await privateWrite(join(runDir, "attestation-result.json"), `${JSON.stringify({
        schema_version: 1,
        kind: "frg_attestation_result",
        status: "complete",
        request_id: closed.request_id,
        grant_fingerprint: closed.grant_fingerprint,
        action_id: closed.action_id,
        version: closed.version,
        loop_run_id: closed.loop_run_id,
        pack_run_id: closed.pack_run_id,
        candidate_git_sha: closed.candidate_git_sha,
        manifest_sha256: closed.manifest_sha256,
        frg_run_id: closed.frg_run_id,
        signer: {
          mode: "installed-production",
          version: productionPin.version,
          tag: productionPin.tag,
          git_sha: productionPin.git_sha,
          policy_id: "factory-gate-v2",
          policy_sha256: "7".repeat(64),
        },
        attestation_payload_sha256: "8".repeat(64),
        attested_evidence_sha256: sha256(evidenceText),
      })}\n`);
    },
  };
  const context = { configPath, checkpointPath };
  const first = await submitFrgAttestation(checkpoint, context, deps);
  assert.equal(validateFrgAttestationHandoff(first).checkpoint, checkpoint.checkpoint);
  assert.equal(starts, 1);
  const second = await submitFrgAttestation(checkpoint, context, {
    ...deps,
    startScorer: async () => { throw new Error("reconciliation must not restart the attestor"); },
  });
  assert.deepEqual(second, first);
  assert.equal(starts, 1);

  const conflictBody = "observations:changed\n";
  await privateWrite(checkpoint.frg.observations.path, conflictBody);
  const conflict = {
    ...checkpoint,
    frg: {
      ...checkpoint.frg,
      observations: { ...checkpoint.frg.observations, sha256: sha256(conflictBody) },
    },
  };
  await privateWrite(checkpointPath, `${JSON.stringify(conflict)}\n`);
  await assert.rejects(
    () => submitFrgAttestation(conflict, context, deps),
    /refusing to replace different immutable artifact/,
  );

  const replay = { ...checkpoint, checkpoint: "replayed-134" };
  await privateWrite(checkpoint.frg.observations.path, "observations:unsigned\n");
  await privateWrite(checkpointPath, `${JSON.stringify(replay)}\n`);
  await assert.rejects(
    () => submitFrgAttestation(replay, context, deps),
    /invalid result identity/,
  );
});

test("credentialed attestor rejects a later request until #908 supplies its trusted policy", () => {
  const later = request({
    request_id: "frg-attest-later",
    pack_run_id: "pack-134",
    version: "1.34.0",
  });
  assert.throws(
    () => validateFrgAttestationRequest(
      later,
      `${requestRoot}/frg-attest-later.json`,
      requestRoot,
    ),
    /unsupported FRG attestation policy.*#908/,
  );
});
