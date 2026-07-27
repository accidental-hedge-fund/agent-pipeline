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

test("installBoundaryShim: writes gh, pipeline, and git interceptors into the shim dir", () => {
  const worktreeDir = mkWorktree();
  const dir = installBoundaryShim(worktreeDir);
  assert.equal(dir, boundaryShimDir(worktreeDir));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["gh", "git", "pipeline"]);
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

test("boundaryEnv: is scoped to the given worktree's shim dir and denial log path", () => {
  const worktreeDir = mkWorktree();
  const env = boundaryEnv(worktreeDir);
  assert.match(env.PATH ?? "", new RegExp(`^${boundaryShimDir(worktreeDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
  assert.equal(env.EVAL_BOUNDARY_DENIAL_LOG, boundaryDenialLogPath(worktreeDir));
});
