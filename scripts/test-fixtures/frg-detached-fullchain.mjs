import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mock } from "node:test";
import * as cp from "node:child_process";
import { promisify } from "node:util";

const packageRoot = process.env.FRG_DETACHED_PACKAGE_ROOT;
const artifacts = process.env.FRG_DETACHED_ARTIFACTS;
const target = process.env.FRG_DETACHED_TARGET;
const candidate = process.env.FRG_DETACHED_CANDIDATE_SHA;
if (!packageRoot || !artifacts || !target || !candidate) throw new Error("missing detached fixture environment");
const source = path.join(packageRoot, "core", "scripts");
process.on("uncaughtExceptionMonitor", (error) => writeFileSync(path.join(artifacts, `uncaught-${process.pid}.json`), JSON.stringify({ code: error.code ?? null, message: error.message }), { mode: 0o600 }));
const realExecFile = promisify(cp.execFile);
function interceptedExecFile() { throw new Error("unexpected callback subprocess"); }
interceptedExecFile[promisify.custom] = async (binary, args, options) => {
  appendFileSync(path.join(artifacts, "subprocesses.log"), `${binary} ${args.slice(0, 3).join(" ")}\n`, { mode: 0o600 });
  if (binary === "gh") {
    if (args[0] === "issue" && args[1] === "view") return { stdout: JSON.stringify({ number: 9901547, title: "detached startup", body: "synthetic", state: "OPEN", url: "https://example.invalid/1547", labels: [{ name: "pipeline:ready" }], comments: [], milestone: null }), stderr: "" };
    if (args[0] === "issue" && args[1] === "edit") {
      writeFileSync(path.join(artifacts, "mutation-boundary"), "stopped\n", { mode: 0o600 });
      throw new Error("FRG_DETACHED_STOP_BEFORE_GITHUB_MUTATION");
    }
    throw new Error(`unexpected gh call: ${args.slice(0, 3).join(" ")}`);
  }
  if (binary === "git" && args.every((arg) => !["push", "commit", "checkout", "switch", "worktree", "reset", "merge", "fetch"].includes(arg))) return realExecFile(binary, args, options);
  throw new Error(`unexpected subprocess: ${binary}`);
};
mock.module("node:child_process", { namedExports: { ...cp, execFile: interceptedExecFile } });

const { runNestedAdvanceChild, runNestedWholeItemAdvance } = await import(path.join(source, "nested-advance.ts"));
const { dispatch } = await import(path.join(source, "pipeline-run.ts"));
const planning = await import(path.join(source, "stages", "planning.ts"));
const { DEFAULT_CONFIG } = await import(path.join(source, "types.ts"));
const { loadProfile } = await import(path.join(source, "profile.ts"));
const profile = loadProfile("claude", path.join(packageRoot, "core", "profiles"));
const cfg = {
  ...DEFAULT_CONFIG,
  profile_name: profile.name, invocation: profile.invocation, review_mode: profile.reviewMode,
  marker_footer: profile.markerFooter, implementation_ready_message: profile.implementationReadyMessage,
  conventions_default: profile.conventionsDefault,
  harnesses: { ...profile.harnesses, implementerSource: "repo-config", reviewerSource: "repo-config" },
  domain: `frg-detached-${process.pid}`, repo: "example/frg-detached-test", repo_dir: target,
  engine_track: "candidate", openspec: { enabled: "off", bootstrap: false },
  auto_loop: { enabled: false, max_rounds: 1, max_wallclock_minutes: 1, stages: [] },
};
const detail = { number: 9901547, type: "issue", title: "detached startup", body: "synthetic", state: "open", url: "https://example.invalid/1547", labels: ["pipeline:ready"], comments: [], milestone: null };
const deps = {
  resolvePinnedEngineIdentity: () => ({ version: "1.40.0", root: source, templates_fingerprint: "e".repeat(64), commit_sha: candidate }),
  probeEngineIdentity: () => null, enforceEngineTrack: async () => ({ ok: true, track: "candidate" }),
  resolveRunStoreRepoDir: async () => target,
  releaseParkedWorktree: async () => ({ action: "absent", reason: "test", branch: null, worktree: null }),
  ensurePipelineLabels: async () => {}, getIssueDetail: async () => detail, getGhActor: async () => "test",
  getPrForIssue: async () => null, getPrDetail: async () => null, getOnDiskForIssue: async () => null,
  gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
  trustedSurfaceObjectSource: { listChangedPaths: async () => ({ paths: [] }), resolveBaseSha: async () => candidate },
  setBlocked: async () => {}, postComment: async () => {}, postPrComment: async () => {}, transition: async () => {},
  dispatch: async (c, n, stage, opts, runId, stateDir, runDir, storeDeps) => dispatch(c, n, stage, opts, runId, stateDir, runDir, storeDeps, {
    evaluateIssueReadiness: async () => ({ kind: "ready" }), tryAcquireLivePlanningMarker: () => true, planningAdvance: planning.advance,
  }),
};
const stderr = [];
const code = await runNestedAdvanceChild(["9901547", "--repo-path", target, "--profile", "claude", "--engine-track", "candidate", "--base", "main", "--run-id", "frg-detached-fullchain", "--once"], {
  resolveConfig: () => cfg, isKillSwitchActive: () => false, writeStderr: (text) => stderr.push(text),
  runNestedWholeItemAdvance: (c, n, opts) => runNestedWholeItemAdvance(c, n, opts, deps),
});
writeFileSync(path.join(artifacts, "fullchain-result.json"), JSON.stringify({ code, stderr, uncaught: existsSync(path.join(artifacts, `uncaught-${process.pid}.json`)) }), { mode: 0o600 });
process.exit(existsSync(path.join(artifacts, "mutation-boundary")) ? 0 : 1);
