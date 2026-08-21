// Candidate-engine resolution and ship-end argv (#1151). Injected fs/git only.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  assertShipEndLeafArgv,
  attestorChildEnv,
  hmacVerifyChildEnv,
  pinShaDiffersFromCandidate,
  presentFrgAttestorCredential,
  requirePresentedFrgAttestationKey,
  resolveCandidateEngine,
  shipEndCliPrefix,
  shipEndLeafArgv,
  uncredentialedPrepareEnv,
  type PresentFrgAttestorCredentialDeps,
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

  const tag = shipEndLeafArgv("ensure-tag", {
    version: "1.39.5",
    mergeCommitOid: SHA,
    packedCandidate: OTHER,
  });
  assert.deepEqual(tag, [
    "release",
    "ensure-tag",
    "1.39.5",
    SHA,
    "--packed-candidate",
    OTHER,
  ]);
  assert.doesNotMatch(tag.join(" "), /\bship\b|\btrain\b/);
  assertShipEndLeafArgv(tag);
  assert.throws(
    () => shipEndLeafArgv("ensure-tag", { version: "1.39.5", mergeCommitOid: SHA.slice(0, 12), packedCandidate: OTHER }),
    /40-hex/,
  );
  assert.throws(
    () => shipEndLeafArgv("ensure-tag", { version: "1.39.5", mergeCommitOid: SHA }),
    /packed-candidate/,
  );

  assert.throws(
    () => assertShipEndLeafArgv(["ship", "--milestone", "v1.39.5"]),
    /must not re-enter/,
  );
  assert.throws(
    () => assertShipEndLeafArgv(["train", "--milestone", "v1.39.5", "--merge"]),
    /must not rerun train/,
  );
});

const DUMMY_KEY = "dummy-key";
const KEY_FILE_PATH = "/keys/frg-dummy";

function dummyFileDeps(
  files: Record<string, Buffer | "unreadable">,
): PresentFrgAttestorCredentialDeps {
  return {
    readFile(p) {
      const body = files[p];
      if (body === undefined || body === "unreadable") {
        throw new Error(`unreadable: ${p}`);
      }
      return body;
    },
  };
}

function assertHmacChildHasCredential(
  child: NodeJS.ProcessEnv,
  expectedKey: string,
): void {
  const hasKey = typeof child.PIPELINE_FRG_ATTESTATION_KEY === "string"
    && child.PIPELINE_FRG_ATTESTATION_KEY !== "";
  const hasKeyFile = typeof child.PIPELINE_FRG_ATTESTATION_KEY_FILE === "string"
    && child.PIPELINE_FRG_ATTESTATION_KEY_FILE !== "";
  assert.ok(
    hasKey || hasKeyFile,
    "HMAC child must present KEY or KEY_FILE when parent supplied a readable non-empty KEY_FILE",
  );
  assert.equal(child.PIPELINE_FRG_ATTESTATION_KEY, expectedKey);
  assert.equal(child.PIPELINE_FRG_ATTESTATION_KEY_FILE, undefined);
}

test("prepare env unsets KEY and KEY_FILE; HMAC children inherit KEY and unset KEY_FILE", () => {
  const parent: NodeJS.ProcessEnv = {
    PIPELINE_FRG_ATTESTATION_KEY: "secret",
    PIPELINE_FRG_ATTESTATION_KEY_FILE: "/keys/frg",
    PATH: "/usr/bin",
  };
  const prep = uncredentialedPrepareEnv(parent);
  assert.equal(prep.PIPELINE_FRG_ATTESTATION_KEY, undefined);
  assert.equal(prep.PIPELINE_FRG_ATTESTATION_KEY_FILE, undefined);
  assert.equal(parent.PIPELINE_FRG_ATTESTATION_KEY, "secret");
  assert.equal(parent.PIPELINE_FRG_ATTESTATION_KEY_FILE, "/keys/frg");
  const att = attestorChildEnv(parent);
  assert.equal(att.PIPELINE_FRG_ATTESTATION_KEY, "secret");
  assert.equal(att.PIPELINE_FRG_ATTESTATION_KEY_FILE, undefined);
  const tag = hmacVerifyChildEnv(parent);
  assert.equal(tag.PIPELINE_FRG_ATTESTATION_KEY, "secret");
  assert.equal(tag.PIPELINE_FRG_ATTESTATION_KEY_FILE, undefined);
});

test("HMAC children present KEY_FILE as KEY when KEY is unset (#1181)", () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    PIPELINE_FRG_ATTESTATION_KEY_FILE: KEY_FILE_PATH,
  };
  delete parent.PIPELINE_FRG_ATTESTATION_KEY;
  const deps = dummyFileDeps({ [KEY_FILE_PATH]: Buffer.from(DUMMY_KEY) });
  const att = hmacVerifyChildEnv(parent, deps);
  const tag = hmacVerifyChildEnv(parent, deps);
  assertHmacChildHasCredential(att, DUMMY_KEY);
  assertHmacChildHasCredential(tag, DUMMY_KEY);
  assert.equal(parent.PIPELINE_FRG_ATTESTATION_KEY, undefined);
  assert.equal(parent.PIPELINE_FRG_ATTESTATION_KEY_FILE, KEY_FILE_PATH);
  const prep = uncredentialedPrepareEnv(parent);
  assert.equal(prep.PIPELINE_FRG_ATTESTATION_KEY, undefined);
  assert.equal(prep.PIPELINE_FRG_ATTESTATION_KEY_FILE, undefined);
});

test("HMAC children inherit inline KEY over KEY_FILE body (#1181)", () => {
  const parent: NodeJS.ProcessEnv = {
    PIPELINE_FRG_ATTESTATION_KEY: "inline-key",
    PIPELINE_FRG_ATTESTATION_KEY_FILE: KEY_FILE_PATH,
  };
  const deps = dummyFileDeps({ [KEY_FILE_PATH]: Buffer.from("file-body-must-not-win") });
  const att = hmacVerifyChildEnv(parent, deps);
  const tag = hmacVerifyChildEnv(parent, deps);
  assertHmacChildHasCredential(att, "inline-key");
  assertHmacChildHasCredential(tag, "inline-key");
  assert.equal(parent.PIPELINE_FRG_ATTESTATION_KEY, "inline-key");
});

test("HMAC-verify fails closed without a credential and does not present env (#1181)", () => {
  const parent: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  delete parent.PIPELINE_FRG_ATTESTATION_KEY;
  delete parent.PIPELINE_FRG_ATTESTATION_KEY_FILE;
  const missing = presentFrgAttestorCredential(parent);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "missing_attestor_credential");
  assert.throws(() => hmacVerifyChildEnv(parent), /missing_attestor_credential/);
  assert.throws(() => hmacVerifyChildEnv({ PIPELINE_FRG_ATTESTATION_KEY_FILE: "" }), /missing_attestor_credential/);
  assert.throws(() => requirePresentedFrgAttestationKey(parent), /missing_attestor_credential/);
});

test("HMAC-verify fails closed on unreadable KEY_FILE (#1181)", () => {
  const parent: NodeJS.ProcessEnv = {
    PIPELINE_FRG_ATTESTATION_KEY_FILE: KEY_FILE_PATH,
  };
  const deps = dummyFileDeps({ [KEY_FILE_PATH]: "unreadable" });
  const presented = presentFrgAttestorCredential(parent, deps);
  assert.equal(presented.ok, false);
  if (!presented.ok) assert.equal(presented.reason, "unreadable_attestor_key_file");
  assert.throws(() => hmacVerifyChildEnv(parent, deps), /unreadable_attestor_key_file/);
  assert.throws(
    () => requirePresentedFrgAttestationKey(parent, deps),
    /unreadable_attestor_key_file/,
  );
});

test("HMAC-verify fails closed on empty KEY_FILE (#1181)", () => {
  const parent: NodeJS.ProcessEnv = {
    PIPELINE_FRG_ATTESTATION_KEY_FILE: KEY_FILE_PATH,
  };
  const deps = dummyFileDeps({ [KEY_FILE_PATH]: Buffer.alloc(0) });
  const presented = presentFrgAttestorCredential(parent, deps);
  assert.equal(presented.ok, false);
  if (!presented.ok) assert.equal(presented.reason, "missing_attestor_credential");
  assert.throws(() => hmacVerifyChildEnv(parent, deps), /missing_attestor_credential/);
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
