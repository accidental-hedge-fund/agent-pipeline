import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  INSTALLED_CLI_PROBE_SCHEMA,
  installedCliQualificationArtifactDigest,
  parseInstalledCliQualificationArtifact,
  qualificationArtifactPath,
  runInstalledCliQualification,
} from "../core/scripts/installed-cli-qualification.ts";
import {
  bindExecutedMatrixRowsForCandidate,
} from "../core/scripts/fault-recovery-matrix.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const launcher = path.join(repoRoot, "scripts", "pipeline-launcher.mjs");
const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
let artifact = null;
let root = null;

test("real candidate launcher produces complete parent-observed qualification", { timeout: 360_000 }, () => {
  root = mkdtempSync(path.join(tmpdir(), "pipeline-real-installed-qualification-"));
  artifact = runInstalledCliQualification({
    candidateSha: candidate,
    launcherPath: launcher,
    repoDir: root,
    nodePath: process.execPath,
    timeoutMs: 100,
    now: () => new Date("2026-09-07T01:00:00.000Z"),
  });
  assert.equal(artifact.rows.length, 15, "one observed representative per lifecycle class and layer");
  assert.equal(artifact.rows.every((row) => row.passed), true);
  assert.equal(bindExecutedMatrixRowsForCandidate(artifact.rows, candidate).length, artifact.rows.length);
  assert.ok(artifact.proofs.some((proof) => proof.signal === "SIGTERM"));
  assert.ok(artifact.proofs.some((proof) => proof.timed_out));
  assert.ok(artifact.proofs.some((proof) => proof.observations?.length));
  assert.ok(artifact.proofs.some((proof) => proof.operation === "candidate-core-suite"));
  assert.ok(artifact.proofs.some((proof) => proof.operation === "adapter-contract-suite"));
  assert.ok(artifact.proofs.some((proof) => proof.operation === "host-conformance-suite"));
  assert.ok(artifact.proofs.some((proof) => proof.operation === "frg-detached-startup-suite"));
  assert.ok(
    artifact.proofs
      .filter((proof) => !proof.operation.endsWith("-suite"))
      .every((proof) => proof.argv[0].includes("/package/scripts/pipeline-launcher.mjs")),
  );
  const stored = JSON.parse(readFileSync(qualificationArtifactPath(root, candidate), "utf8"));
  assert.ok(parseInstalledCliQualificationArtifact(stored, candidate));
  const reused = runInstalledCliQualification({
    candidateSha: candidate,
    launcherPath: launcher,
    repoDir: root,
    nodePath: "/path/that-must-not-run",
  });
  assert.deepEqual(reused, artifact);
});

test("re-digested unsafe or uncorrelated proof is rejected", () => {
  assert.ok(artifact);
  const unsafe = structuredClone(artifact);
  const proof = unsafe.proofs.find((candidateProof) => candidateProof.observations?.length);
  assert.ok(proof);
  proof.observations[0].false_human = true;
  const { digest_sha256: _unsafeDigest, ...unsafeUnsigned } = unsafe;
  unsafe.digest_sha256 = installedCliQualificationArtifactDigest(unsafeUnsigned);
  assert.equal(parseInstalledCliQualificationArtifact(unsafe, candidate), null);

  const uncorrelated = structuredClone(artifact);
  const observed = uncorrelated.proofs.find(
    (candidateProof) => candidateProof.observations?.length && candidateProof.cell_keys.length > 0,
  );
  assert.ok(observed);
  observed.cell_keys = observed.cell_keys.slice(1);
  const { digest_sha256: _uncorrelatedDigest, ...uncorrelatedUnsigned } = uncorrelated;
  uncorrelated.digest_sha256 = installedCliQualificationArtifactDigest(uncorrelatedUnsigned);
  assert.equal(parseInstalledCliQualificationArtifact(uncorrelated, candidate), null);

  const missingRoute = structuredClone(artifact);
  const omittedIndex = missingRoute.proofs.findIndex(
    (candidateProof) =>
      candidateProof.operation !== "drive" &&
      candidateProof.operation !== "candidate-core-suite" &&
      candidateProof.operation !== "adapter-contract-suite" &&
      candidateProof.operation !== "host-conformance-suite" &&
      candidateProof.operation !== "frg-detached-startup-suite",
  );
  assert.notEqual(omittedIndex, -1);
  missingRoute.proofs.splice(omittedIndex, 1);
  const { digest_sha256: _missingRouteDigest, ...missingRouteUnsigned } = missingRoute;
  missingRoute.digest_sha256 = installedCliQualificationArtifactDigest(missingRouteUnsigned);
  assert.equal(parseInstalledCliQualificationArtifact(missingRoute, candidate), null);

  const missingDetachedStartup = structuredClone(artifact);
  missingDetachedStartup.proofs = missingDetachedStartup.proofs.filter(
    (candidateProof) => candidateProof.operation !== "frg-detached-startup-suite",
  );
  const { digest_sha256: _missingDetachedDigest, ...missingDetachedUnsigned } =
    missingDetachedStartup;
  missingDetachedStartup.digest_sha256 = installedCliQualificationArtifactDigest(
    missingDetachedUnsigned,
  );
  assert.equal(parseInstalledCliQualificationArtifact(missingDetachedStartup, candidate), null);

  const forgedDetachedStartup = structuredClone(artifact);
  const detachedProof = forgedDetachedStartup.proofs.find(
    (candidateProof) => candidateProof.operation === "frg-detached-startup-suite",
  );
  assert.ok(detachedProof);
  detachedProof.argv[2] = path.join(root, "untrusted-detached-startup.test.mjs");
  const { digest_sha256: _forgedDetachedDigest, ...forgedDetachedUnsigned } =
    forgedDetachedStartup;
  forgedDetachedStartup.digest_sha256 = installedCliQualificationArtifactDigest(
    forgedDetachedUnsigned,
  );
  assert.equal(parseInstalledCliQualificationArtifact(forgedDetachedStartup, candidate), null);

  const forgedArgv = structuredClone(artifact);
  const routeProof = forgedArgv.proofs.find((candidateProof) => candidateProof.operation === "drive");
  assert.ok(routeProof);
  routeProof.argv = ["/bin/true"];
  const { digest_sha256: _forgedArgvDigest, ...forgedArgvUnsigned } = forgedArgv;
  forgedArgv.digest_sha256 = installedCliQualificationArtifactDigest(forgedArgvUnsigned);
  assert.equal(parseInstalledCliQualificationArtifact(forgedArgv, candidate), null);

  const duplicateSuite = structuredClone(artifact);
  const layerSuite = duplicateSuite.proofs.find(
    (candidateProof) => candidateProof.operation === "adapter-contract-suite",
  );
  assert.ok(layerSuite);
  duplicateSuite.proofs.push(structuredClone(layerSuite));
  const { digest_sha256: _duplicateSuiteDigest, ...duplicateSuiteUnsigned } = duplicateSuite;
  duplicateSuite.digest_sha256 = installedCliQualificationArtifactDigest(duplicateSuiteUnsigned);
  assert.equal(parseInstalledCliQualificationArtifact(duplicateSuite, candidate), null);
});

test("closed probe rejects relative, malformed, route-mismatched, and credential-bearing fixtures", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pipeline-qualification-refusal-"));
  try {
    const fixturePath = path.join(fixtureRoot, "fixture.json");
    const valid = {
      schema: INSTALLED_CLI_PROBE_SCHEMA,
      nonce: "1".repeat(32),
      operation: "single",
      fault_states: ["authentication"],
      mode: "recovery",
    };
    writeFileSync(fixturePath, JSON.stringify(valid));
    const invoke = (args, extraEnv = {}) =>
      spawnSync(process.execPath, [launcher, ...args], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: fixtureRoot,
          AGENT_PIPELINE_NODE: process.execPath,
          ...extraEnv,
        },
      });
    assert.equal(invoke(["single", "--qualification-probe", "relative.json"]).status, 64);
    assert.equal(invoke(["loop", "--qualification-probe", fixturePath]).status, 64);
    writeFileSync(fixturePath, "not-json");
    assert.equal(invoke(["single", "--qualification-probe", fixturePath]).status, 64);
    writeFileSync(fixturePath, JSON.stringify(valid));
    assert.equal(
      invoke(["single", "--qualification-probe", fixturePath], { GH_TOKEN: "secret" }).status,
      64,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test.after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
