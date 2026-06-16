// Worktree dependency install step (#174): detect and run the package manager
// install (or a configured setup_command) in a freshly created worktree so
// binaries are available before the test/build gate runs.
//
// Invoked immediately after createWorktree in the planning stage. Failures
// throw an Error that the caller converts to a "worktree-setup-failed" block.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { PipelineConfig } from "./types.ts";

export interface SetupResult {
  skipped: boolean;
  command?: string;
  stdout?: string;
  stderr?: string;
}

export interface SetupDeps {
  existsSync?: (p: string) => boolean;
  /** Spawn a command and return its exit code + captured output. When
   *  `useShell` is true the full `cmd` string is passed to /bin/sh -c (for
   *  compound setup_command values). When false, `cmd` + `args` are spawned
   *  directly without a shell. */
  spawnCommand?: (
    cmd: string,
    args: string[],
    cwd: string,
    useShell: boolean,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function detectLockfile(
  worktreePath: string,
  existsFn: (p: string) => boolean,
): { lockfile: string; cmd: string; args: string[] } | null {
  if (existsFn(path.join(worktreePath, "pnpm-lock.yaml"))) {
    return { lockfile: "pnpm-lock.yaml", cmd: "pnpm", args: ["install"] };
  }
  if (existsFn(path.join(worktreePath, "yarn.lock"))) {
    return { lockfile: "yarn.lock", cmd: "yarn", args: ["install"] };
  }
  if (existsFn(path.join(worktreePath, "package-lock.json"))) {
    return { lockfile: "package-lock.json", cmd: "npm", args: ["ci"] };
  }
  return null;
}

const MAX_CAPTURED = 100_000;
// Wall-clock cap for a single install/setup run. A hung `pnpm install` would
// otherwise hold the pipeline process and lock alive indefinitely.
const SETUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function defaultSpawnCommand(
  cmd: string,
  args: string[],
  cwd: string,
  useShell: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = useShell
      ? spawn(cmd, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let stdoutBuf = "";
    let stderrBuf = "";
    let done = false;

    const label = useShell ? cmd : [cmd, ...args].join(" ");

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      // Escalate to SIGKILL if the process hasn't exited after a short grace period.
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
      const timeoutMsg = `[setup-timeout: \`${label}\` did not complete within ${SETUP_TIMEOUT_MS / 1000}s]`;
      resolve({
        code: -1,
        stdout: stdoutBuf,
        stderr: [stderrBuf, timeoutMsg].map((s) => s.trim()).filter(Boolean).join("\n"),
      });
    }, SETUP_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stdoutBuf.length < MAX_CAPTURED) stdoutBuf += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stderrBuf.length < MAX_CAPTURED) stderrBuf += text;
      process.stderr.write(text);
    });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: stdoutBuf, stderr: `spawn error: ${err.message}\n${stderrBuf}` });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdoutBuf, stderr: stderrBuf });
    });
  });
}

/**
 * Detect and run the package manager install step in a freshly created
 * worktree. Called immediately after `createWorktree` returns, before any
 * stage can invoke binaries that require installed dependencies.
 *
 * Precedence:
 *   1. `cfg.setup_command === ""` → skip (explicit opt-out)
 *   2. `cfg.setup_command` (non-empty) → run via shell (overrides all detection)
 *   3. `node_modules` already present AND no `setup_command` set → skip (idempotent)
 *   4. pnpm-lock.yaml → `pnpm install`
 *   5. yarn.lock → `yarn install`
 *   6. package-lock.json → `npm ci`
 *   7. No lockfile and no `setup_command` → skip
 *
 * Throws on non-zero exit so the caller can surface the failure with a clear
 * error message and block the pipeline before any stage runs.
 */
export async function detectAndInstall(
  worktreePath: string,
  cfg: Pick<PipelineConfig, "setup_command">,
  deps: SetupDeps = {},
): Promise<SetupResult> {
  const existsFn = deps.existsSync ?? fs.existsSync;
  const spawnFn = deps.spawnCommand ?? defaultSpawnCommand;

  // Explicit opt-out: setup_command: ""
  if (cfg.setup_command !== undefined && cfg.setup_command === "") {
    return { skipped: true };
  }

  // setup_command override: run via shell, bypasses idempotency check
  if (cfg.setup_command) {
    const label = cfg.setup_command;
    console.log(`[pipeline] worktree setup: running setup_command: ${label}`);
    const res = await spawnFn(label, [], worktreePath, true);
    if (res.code !== 0) {
      const combined = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean).join("\n");
      throw new Error(
        `setup_command exited with code ${res.code}\nCommand: ${label}` +
          (combined ? `\nOutput:\n${combined}` : ""),
      );
    }
    return { skipped: false, command: label, stdout: res.stdout, stderr: res.stderr };
  }

  // Idempotency: if node_modules already exists, skip auto-detection
  if (existsFn(path.join(worktreePath, "node_modules"))) {
    return { skipped: true };
  }

  // Auto-detect from lockfile
  const detected = detectLockfile(worktreePath, existsFn);
  if (!detected) {
    return { skipped: true };
  }

  const label = [detected.cmd, ...detected.args].join(" ");
  console.log(`[pipeline] worktree setup: running \`${label}\` (detected from ${detected.lockfile})`);
  const res = await spawnFn(detected.cmd, detected.args, worktreePath, false);
  if (res.code !== 0) {
    const combined = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean).join("\n");
    throw new Error(
      `\`${label}\` exited with code ${res.code}` +
        (combined ? `\nOutput:\n${combined}` : ""),
    );
  }
  return { skipped: false, command: label, stdout: res.stdout, stderr: res.stderr };
}
