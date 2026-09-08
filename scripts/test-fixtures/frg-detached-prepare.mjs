import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const packageRoot = process.env.FRG_DETACHED_PACKAGE_ROOT;
const fixtureRoot = process.env.FRG_DETACHED_FIXTURE_ROOT;
const artifacts = process.env.FRG_DETACHED_ARTIFACTS;
const runDir = process.env.FRG_DETACHED_RUN_DIR;
const target = process.env.FRG_DETACHED_TARGET;
const candidate = process.env.FRG_DETACHED_CANDIDATE_SHA;
if (!packageRoot || !fixtureRoot || !artifacts || !runDir || !target || !candidate) throw new Error("missing detached fixture environment");
const { defaultResumeBoundPackLoop, freezeCandidateInvocation } = await import(path.join(packageRoot, "core", "scripts", "factory-release-prepare.ts"));
const { candidateProcessGuardEnv } = await import(path.join(packageRoot, "core", "scripts", "ship-end-candidate.ts"));
const loopRunId = "frg-detached-loop";
const supervisor = () => {
  try {
    const pid = Number(readFileSync(path.join(artifacts, "spawned-pid"), "utf8"));
    return { pid, boot_id: "frg-detached-boot", started_at: "2026-09-07T00:00:00Z", token: "frg-detached-token" };
  } catch { return null; }
};
const result = await defaultResumeBoundPackLoop({
  repoDir: target, loop_run_id: loopRunId, requestCandidateSha: candidate,
  candidateInvocation: freezeCandidateInvocation({ executable: path.join(packageRoot, "scripts", "pipeline-launcher.mjs"), candidateSha: candidate, loopRunId }),
  candidateEnv: candidateProcessGuardEnv({ engineRoot: packageRoot, commitSha: candidate, readyRecordPath: path.join(artifacts, "ready.json"), lockfileDigest: "d".repeat(64), processLockPath: path.join(artifacts, "process.lock"), processLockDigest: "f".repeat(64) }),
}, {
  env: process.env, storeRunDir: runDir, observationMs: 3_000,
  spawn: (_command, _args, options) => spawn(process.execPath, [path.join(fixtureRoot, "scripts", "test-fixtures", "frg-detached-supervisor.mjs")], { ...options, env: process.env }),
  readSupervisor: async () => supervisor(),
  readHandoff: async () => {
    const observed = supervisor();
    return observed ? { schema_version: "1", kind: "loop_run_handoff", run_id: loopRunId, run_dir: runDir, events: path.join(runDir, "events.jsonl"), engine: "claude", resumed: true, selector: null, candidate_sha: candidate, supervisor: observed } : null;
  },
});
writeFileSync(path.join(artifacts, "spawn-result.json"), JSON.stringify(result), { mode: 0o600 });
process.exit(result.dispatch_state === "dispatched" ? 0 : 1);
