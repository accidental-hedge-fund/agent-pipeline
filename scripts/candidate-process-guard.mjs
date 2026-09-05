#!/usr/bin/env node
// Child-side candidate proof. Candidate processes load this module before the
// requested entrypoint so a checkout that moved after parent preparation is
// refused inside the launched process while the parent-held lease is live.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENV = {
  required: "PIPELINE_CANDIDATE_PROCESS_GUARD",
  root: "PIPELINE_CANDIDATE_PROCESS_ROOT",
  sha: "PIPELINE_CANDIDATE_PROCESS_SHA",
  readyRecord: "PIPELINE_CANDIDATE_PROCESS_READY_RECORD",
  lockfileDigest: "PIPELINE_CANDIDATE_PROCESS_LOCKFILE_DIGEST",
  processLock: "PIPELINE_CANDIDATE_PROCESS_LOCK",
  processLockDigest: "PIPELINE_CANDIDATE_PROCESS_LOCK_DIGEST",
};

const READY_SCHEMA = "pipeline-candidate-readiness/v1";
const EXACT_SHA = /^[0-9a-f]{40}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  return result.status === 0 ? String(result.stdout ?? "") : null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ readFile?: typeof readFileSync, realpath?: typeof realpathSync, git?: typeof git }} deps
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function verifyCandidateProcessGuard(env = process.env, deps = {}) {
  if (env[ENV.required] !== "1") return { ok: true };
  const root = String(env[ENV.root] ?? "");
  const expectedSha = String(env[ENV.sha] ?? "").toLowerCase();
  const readyRecordPath = String(env[ENV.readyRecord] ?? "");
  const expectedLockfileDigest = String(env[ENV.lockfileDigest] ?? "");
  const processLockPath = String(env[ENV.processLock] ?? "");
  const expectedProcessLockDigest = String(env[ENV.processLockDigest] ?? "");
  if (!root || !EXACT_SHA.test(expectedSha)) {
    return { ok: false, error: "missing exact candidate root/SHA binding" };
  }
  if (!readyRecordPath || !expectedLockfileDigest || !processLockPath || !expectedProcessLockDigest) {
    return { ok: false, error: "missing readiness or process-lease binding" };
  }

  const readFile = deps.readFile ?? readFileSync;
  const realpath = deps.realpath ?? realpathSync;
  const runGit = deps.git ?? git;
  let canonicalRoot;
  let guardModule;
  let processLock;
  let readyRecord;
  let lockfile;
  try {
    canonicalRoot = realpath(root);
    guardModule = realpath(fileURLToPath(import.meta.url));
    processLock = readFile(processLockPath);
    readyRecord = JSON.parse(String(readFile(readyRecordPath)));
    lockfile = readFile(join(canonicalRoot, "core", "package-lock.json"));
  } catch (err) {
    return { ok: false, error: `cannot read candidate proof: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (canonicalRoot !== resolve(root)) return { ok: false, error: "candidate root is not canonical" };
  if (guardModule !== join(canonicalRoot, "scripts", "candidate-process-guard.mjs")) {
    return { ok: false, error: "guard module is outside the bound candidate root" };
  }
  if (sha256(processLock) !== expectedProcessLockDigest) {
    return { ok: false, error: "candidate process lease changed before child start" };
  }
  if (
    readyRecord?.schema !== READY_SCHEMA ||
    readyRecord.engineRoot !== canonicalRoot ||
    readyRecord.commitSha !== expectedSha ||
    readyRecord.lockfileDigest !== expectedLockfileDigest ||
    sha256(lockfile) !== expectedLockfileDigest
  ) {
    return { ok: false, error: "candidate readiness proof does not match the launched candidate" };
  }
  const head = runGit(canonicalRoot, ["rev-parse", "--verify", "HEAD"]);
  const porcelain = runGit(canonicalRoot, ["status", "--porcelain"]);
  if (head?.trim().toLowerCase() !== expectedSha || porcelain !== "") {
    return { ok: false, error: "candidate moved or became dirty before child start" };
  }
  return { ok: true };
}

const result = verifyCandidateProcessGuard();
if (!result.ok) {
  process.stderr.write(`pipeline candidate process guard: ${result.error}\n`);
  process.exit(78);
}
