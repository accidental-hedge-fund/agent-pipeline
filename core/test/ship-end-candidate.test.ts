// Candidate-engine resolution and ship-end argv (#1151). Injected fs/git only.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  assertShipEndLeafArgv,
  attestorChildEnv,
  pinShaDiffersFromCandidate,
  resolveCandidateEngine,
  shipEndCliPrefix,
  shipEndLeafArgv,
  uncredentialedPrepareEnv,
  type ResolveCandidateEngineDeps,
} from "../scripts/ship-end-candidate.ts";

const SHA = "b".repeat(40);
const OTHER = "d".repeat(40);

function deps(opts: {
  roots: Record<string, { head: string | null; porcelain: string | null; files?: string[] }>;
  fetchOk?: boolean;
  addOk?: boolean;
}): ResolveCandidateEngineDeps {
  const fetchCalls: string[] = [];
  const addCalls: string[] = [];
  return {
    isDirectory: (p) => opts.roots[p] != null,
    fileExists: (p) => {
      for (const [root, st] of Object.entries(opts.roots)) {
        const files = st.files ?? [
          path.join(root, "core/scripts/pipeline.ts"),
          path.join(root, "scripts/pipeline-launcher.mjs"),
        ];
        if (files.includes(p)) return true;
      }
      return false;
    },
    revParseHead: (cwd) => opts.roots[cwd]?.head ?? null,
    porcelain: (cwd) => opts.roots[cwd]?.porcelain ?? null,
    fetchSha: (repo, sha) => {
      fetchCalls.push(`${repo}:${sha}`);
      return opts.fetchOk === true;
    },
    worktreeAdd: (repo, dest, sha) => {
      addCalls.push(`${repo}:${dest}:${sha}`);
      return opts.addOk === true;
    },
  };
}

test("resolveCandidateEngine uses clean REPO_DIR when HEAD equals SHA", () => {
  const repo = "/repo";
  const r = resolveCandidateEngine(
    { repoDir: repo, candidateSha: SHA },
    deps({
      roots: {
        [repo]: { head: SHA, porcelain: "" },
      },
    }),
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.engine.commitSha, SHA);
    assert.equal(r.engine.engineRoot, repo);
    assert.equal(r.engine.launcherPath, path.join(repo, "scripts/pipeline-launcher.mjs"));
  }
});

test("resolveCandidateEngine uses PIPELINE_CANDIDATE_ENGINE_ROOT when REPO_DIR HEAD differs", () => {
  const repo = "/repo";
  const cand = "/opt/candidate";
  const r = resolveCandidateEngine(
    { repoDir: repo, candidateSha: SHA, candidateEngineRootEnv: cand },
    deps({
      roots: {
        [repo]: { head: OTHER, porcelain: "" },
        [cand]: { head: SHA, porcelain: "" },
      },
    }),
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.engine.engineRoot, cand);
});

test("resolveCandidateEngine fails closed when no root matches", () => {
  const r = resolveCandidateEngine(
    { repoDir: "/repo", candidateSha: SHA },
    deps({
      roots: {
        "/repo": { head: OTHER, porcelain: "" },
      },
    }),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /cannot resolve candidate engine/);
});

test("resolveCandidateEngine rejects abbreviated SHA", () => {
  const r = resolveCandidateEngine(
    { repoDir: "/repo", candidateSha: SHA.slice(0, 12) },
    deps({ roots: {} }),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /40-hex/);
});

test("resolveCandidateEngine rejects dirty tree even when HEAD matches", () => {
  const repo = "/repo";
  const r = resolveCandidateEngine(
    { repoDir: repo, candidateSha: SHA },
    deps({
      roots: {
        [repo]: { head: SHA, porcelain: " M core/scripts/release.ts" },
      },
    }),
  );
  assert.equal(r.ok, false);
});

test("resolveCandidateEngine rejects relative PIPELINE_CANDIDATE_ENGINE_ROOT", () => {
  const r = resolveCandidateEngine(
    { repoDir: "/repo", candidateSha: SHA, candidateEngineRootEnv: "not/absolute" },
    deps({
      roots: {
        "/repo": { head: OTHER, porcelain: "" },
      },
    }),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /absolute/);
});

test("ship-end leaf argv never re-enters ship or train", () => {
  const prepare = shipEndLeafArgv("factory-release-prepare", {
    requestPath: "/abs/req.json",
  });
  assert.deepEqual(prepare, [
    "factory-release",
    "prepare",
    "--request",
    "/abs/req.json",
    "--json",
  ]);
  assert.doesNotMatch(prepare.join(" "), /\bship\b|\btrain\b/);
  assertShipEndLeafArgv(prepare);

  const release = shipEndLeafArgv("release", { version: "1.39.5" });
  assert.deepEqual(release, ["release", "1.39.5", "--no-edit"]);
  assertShipEndLeafArgv(release);

  const finish = shipEndLeafArgv("release-finish", { pr: 42 });
  assert.deepEqual(finish, ["release", "finish", "42", "--json"]);

  const gate = shipEndLeafArgv("factory-gate", {
    version: "1.39.5",
    loopRunId: "loop-L",
  });
  assert.deepEqual(gate, ["factory-gate", "--for", "1.39.5", "--from-run", "loop-L"]);
  assert.ok(!gate.includes("--observations"));

  assert.throws(
    () => assertShipEndLeafArgv(["ship", "--milestone", "v1.39.5"]),
    /must not re-enter/,
  );
  assert.throws(
    () => assertShipEndLeafArgv(["train", "--milestone", "v1.39.5", "--merge"]),
    /must not rerun train/,
  );
});

test("prepare env unsets KEY and KEY_FILE; attestor unsets KEY_FILE only", () => {
  const parent: NodeJS.ProcessEnv = {
    PIPELINE_FRG_ATTESTATION_KEY: "secret",
    PIPELINE_FRG_ATTESTATION_KEY_FILE: "/keys/frg",
    PATH: "/usr/bin",
  };
  const prep = uncredentialedPrepareEnv(parent);
  assert.equal(prep.PIPELINE_FRG_ATTESTATION_KEY, undefined);
  assert.equal(prep.PIPELINE_FRG_ATTESTATION_KEY_FILE, undefined);
  assert.equal(parent.PIPELINE_FRG_ATTESTATION_KEY, "secret");
  const att = attestorChildEnv(parent);
  assert.equal(att.PIPELINE_FRG_ATTESTATION_KEY, "secret");
  assert.equal(att.PIPELINE_FRG_ATTESTATION_KEY_FILE, undefined);
});

test("pinShaDiffersFromCandidate: matching version is irrelevant; SHA decides", () => {
  assert.equal(pinShaDiffersFromCandidate(SHA, SHA), false);
  assert.equal(pinShaDiffersFromCandidate(OTHER, SHA), true);
  assert.equal(pinShaDiffersFromCandidate(null, SHA), true);
});

test("shipEndCliPrefix uses the candidate launcher, not PATH pipeline", () => {
  const prefix = shipEndCliPrefix({
    engineRoot: "/cand",
    launcherPath: "/cand/scripts/pipeline-launcher.mjs",
    commitSha: SHA,
  });
  assert.deepEqual(prefix, ["node", "/cand/scripts/pipeline-launcher.mjs"]);
  assert.ok(!prefix.includes("pipeline"));
});
