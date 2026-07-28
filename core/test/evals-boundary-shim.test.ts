// Tests for the process-level command boundary's deny-shim (#607 —
// eval-agent-isolation-boundary). The shim IS the security boundary — a
// fake standing in for it would prove nothing about whether a real child
// process is actually blocked, so these spawn the real generated shim
// scripts via node (this engine already requires Node 24+ on PATH), inside
// a real temp directory. No git, gh, network, or model call — only local
// script execution, matching the "no injected fake for the boundary itself"
// precedent in evals-executor.test.ts (defaultRunEnvironmentCommand).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  boundaryDenialLogPath,
  boundaryEnv,
  boundaryShimDir,
  installBoundaryShim,
  readBoundaryDenials,
  removeBoundaryShim,
} from "../scripts/evals/boundary-shim.ts";

const execFileAsync = promisify(execFile);

function mkWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-boundary-shim-"));
}

async function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { env, cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("installBoundaryShim: writes gh, pipeline, git, and node interceptors into the shim dir", () => {
  const worktreeDir = mkWorktree();
  const dir = installBoundaryShim(worktreeDir);
  assert.equal(dir, boundaryShimDir(worktreeDir));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["gh", "git", "node", "pipeline"]);
});

test("gh shim: denies every invocation, exits non-zero, and records a structured denial", async () => {
  const worktreeDir = mkWorktree();
  installBoundaryShim(worktreeDir);
  const env = { ...process.env, ...boundaryEnv(worktreeDir) };
  const result = await run("gh", ["pr", "create", "--title", "x"], env, worktreeDir);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /eval-boundary: gh is denied/);
  const denials = readBoundaryDenials(worktreeDir);
  assert.equal(denials.length, 1);
  assert.equal(denials[0].command, "gh");
  assert.equal(denials[0].category, "github-write");
  assert.deepEqual(denials[0].argv, ["pr", "create", "--title", "x"]);
});

test("pipeline shim: denies every invocation and records the pipeline-advance category", async () => {
  const worktreeDir = mkWorktree();
  installBoundaryShim(worktreeDir);
  const env = { ...process.env, ...boundaryEnv(worktreeDir) };
  const result = await run("pipeline", ["advance", "607"], env, worktreeDir);
  assert.notEqual(result.code, 0);
  const denials = readBoundaryDenials(worktreeDir);
  assert.equal(denials.length, 1);
  assert.equal(denials[0].command, "pipeline");
  assert.equal(denials[0].category, "pipeline-advance");
});

test("node shim: denies direct execution of the pipeline entrypoint but passes ordinary node commands", async () => {
  const worktreeDir = mkWorktree();
  installBoundaryShim(worktreeDir);
  const env = { ...process.env, ...boundaryEnv(worktreeDir) };
  const denied = await run("node", ["--experimental-strip-types", "core/scripts/pipeline.ts", "sweep", "--apply"], env, worktreeDir);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /pipeline\.ts is denied/);
  const permitted = await run("node", ["-e", "process.stdout.write('ok')"], env, worktreeDir);
  assert.equal(permitted.code, 0);
  assert.equal(permitted.stdout, "ok");
  const denials = readBoundaryDenials(worktreeDir);
  assert.equal(denials.length, 1);
  assert.equal(denials[0].command, "node");
  assert.equal(denials[0].category, "pipeline-advance");
});

test("git shim: denies worktree, commit, push, and remote, each with its own category", async () => {
  const worktreeDir = mkWorktree();
  installBoundaryShim(worktreeDir);
  const env = { ...process.env, ...boundaryEnv(worktreeDir) };
  const cases: Array<[string[], string]> = [
    [["worktree", "add", "../nested"], "nested-worktree"],
    [["commit", "-m", "x"], "commit"],
    [["push"], "push"],
    [["remote", "add", "x", "y"], "remote-mutation"],
  ];
  for (const [args, category] of cases) {
    const result = await run("git", args, env, worktreeDir);
    assert.notEqual(result.code, 0, `git ${args.join(" ")} must be denied`);
  }
  const denials = readBoundaryDenials(worktreeDir);
  assert.deepEqual(denials.map((d) => d.category), cases.map(([, category]) => category));
});

test("git shim: a permitted operation (git status) is passed through to the real git", async () => {
  const worktreeDir = mkWorktree();
  await execFileAsync("git", ["init", "-q"], { cwd: worktreeDir });
  installBoundaryShim(worktreeDir);
  const env = { ...process.env, ...boundaryEnv(worktreeDir) };
  const result = await run("git", ["status", "--short"], env, worktreeDir);
  assert.equal(result.code, 0, "a permitted git operation must succeed through the shim");
  const denials = readBoundaryDenials(worktreeDir);
  assert.equal(denials.length, 0, "a permitted operation must not be recorded as a denial");
});

test("readBoundaryDenials: an absent log means no denial occurred, not a collection failure", () => {
  const worktreeDir = mkWorktree();
  const denials = readBoundaryDenials(worktreeDir);
  assert.deepEqual(denials, []);
});

test("readBoundaryDenials: a genuine read failure propagates rather than being folded into an empty array", () => {
  const worktreeDir = mkWorktree();
  const failingIO = {
    readFile: () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    },
  };
  assert.throws(() => readBoundaryDenials(worktreeDir, failingIO), /permission denied/);
});

test("git shim: global options placed before the subcommand do not bypass denial (review 1 finding 47b5f59b)", async () => {
  const worktreeDir = mkWorktree();
  await execFileAsync("git", ["init", "-q"], { cwd: worktreeDir });
  installBoundaryShim(worktreeDir);
  const env = { ...process.env, ...boundaryEnv(worktreeDir) };
  const cases: Array<[string[], string]> = [
    [["-C", ".", "push"], "push"],
    [["-c", "foo.bar=baz", "commit", "-m", "x"], "commit"],
    [["--no-pager", "worktree", "add", "../nested"], "nested-worktree"],
  ];
  for (const [args, category] of cases) {
    const result = await run("git", args, env, worktreeDir);
    assert.notEqual(result.code, 0, `git ${args.join(" ")} must still be denied`);
  }
  const denials = readBoundaryDenials(worktreeDir);
  assert.deepEqual(denials.map((d) => d.category), cases.map(([, category]) => category));
});

test("boundary control directory lives outside the cell worktree, not as a path inside it", () => {
  const worktreeDir = mkWorktree();
  const dir = boundaryShimDir(worktreeDir);
  const logPath = boundaryDenialLogPath(worktreeDir);
  assert.ok(!dir.startsWith(`${worktreeDir}${path.sep}`), "shim dir must not be nested inside the worktree");
  assert.ok(!logPath.startsWith(`${worktreeDir}${path.sep}`), "denial log must not be nested inside the worktree");
});

test("a treatment that wipes its own worktree does not destroy already-recorded boundary evidence (review 1 finding 759fe7a3)", async () => {
  const worktreeDir = mkWorktree();
  installBoundaryShim(worktreeDir);
  const env = { ...process.env, ...boundaryEnv(worktreeDir) };
  await run("gh", ["pr", "create", "--title", "x"], env, worktreeDir);
  assert.equal(readBoundaryDenials(worktreeDir).length, 1);
  // Simulate a treatment nuking its entire working tree.
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  const denials = readBoundaryDenials(worktreeDir);
  assert.equal(denials.length, 1, "evidence recorded outside the worktree must survive the worktree being wiped");
});

test("removeBoundaryShim: removes the sibling control directory", () => {
  const worktreeDir = mkWorktree();
  installBoundaryShim(worktreeDir);
  assert.ok(fs.existsSync(boundaryShimDir(worktreeDir)));
  removeBoundaryShim(worktreeDir);
  assert.ok(!fs.existsSync(boundaryShimDir(worktreeDir)));
});

test("boundaryEnv: is scoped to the given worktree's shim dir and denial log path", () => {
  const worktreeDir = mkWorktree();
  const env = boundaryEnv(worktreeDir);
  assert.match(env.PATH ?? "", new RegExp(`^${boundaryShimDir(worktreeDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
  assert.equal(env.EVAL_BOUNDARY_DENIAL_LOG, boundaryDenialLogPath(worktreeDir));
});
