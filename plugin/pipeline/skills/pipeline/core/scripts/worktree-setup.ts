// Worktree dependency install step (#174, #1132): detect and run the package
// manager install (or a configured setup_command) in a freshly created
// worktree so binaries are available before the test/build gate runs.
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
  /** List first-level directory names under a path. Used after a root
   *  lockfile miss to find exactly one nested package root. A thrown list
   *  is treated as empty; `core/` is still probed. */
  listDir?: (p: string) => string[];
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

function isIgnoredFirstLevelName(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

function defaultListDir(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** First-level subdirectory names to probe after a root-lockfile miss.
 *  Listing is best-effort; a thrown list is treated as empty. `core/` is
 *  always included so existsSync-only fakes still cover this repo. */
function firstLevelCandidateNames(
  worktreePath: string,
  listDir?: (p: string) => string[],
): string[] {
  let listed: string[] = [];
  const listFn = listDir ?? defaultListDir;
  try {
    listed = listFn(worktreePath);
  } catch {
    listed = [];
  }
  const names = new Set<string>();
  for (const name of listed) {
    if (!isIgnoredFirstLevelName(name)) names.add(name);
  }
  names.add("core");
  return [...names];
}

function choosePackageRoot(
  worktreePath: string,
  existsFn: (p: string) => boolean,
  listDir?: (p: string) => string[],
): { packageRoot: string; lockfile: string; cmd: string; args: string[] } | null {
  const rootDetected = detectLockfile(worktreePath, existsFn);
  if (rootDetected) {
    return { packageRoot: worktreePath, ...rootDetected };
  }
  const hits: { packageRoot: string; lockfile: string; cmd: string; args: string[] }[] = [];
  for (const name of firstLevelCandidateNames(worktreePath, listDir)) {
    const dir = path.join(worktreePath, name);
    const detected = detectLockfile(dir, existsFn);
    if (detected) {
      hits.push({
        packageRoot: dir,
        lockfile: `${name}/${detected.lockfile}`,
        cmd: detected.cmd,
        args: detected.args,
      });
    }
  }
  if (hits.length !== 1) return null;
  return hits[0];
}

const MAX_CAPTURED = 100_000;
// Wall-clock cap for a single install/setup run. A hung `pnpm install` would
// otherwise hold the pipeline process and lock alive indefinitely.
const SETUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
// Maximum output included in a thrown error message. GitHub comments have a
// ~65 KB body limit; 8 KB keeps the blocker comment well within bounds
// while still giving operators enough context to diagnose the failure.
const MAX_ERROR_OUTPUT = 8_000;

function truncateOutput(s: string): string {
  if (s.length <= MAX_ERROR_OUTPUT) return s;
  return s.slice(0, MAX_ERROR_OUTPUT) + "\n\n[…output truncated]";
}

async function defaultSpawnCommand(
  cmd: string,
  args: string[],
  cwd: string,
  useShell: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // detached: true puts the child in its own process group so that a timeout
    // can kill the entire tree (shell + subprocesses) via process.kill(-pgid).
    const child = useShell
      ? spawn(cmd, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: true })
      : spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });

    let stdoutBuf = "";
    let stderrBuf = "";
    let done = false;
    let timedOut = false;

    const label = useShell ? cmd : [cmd, ...args].join(" ");

    // Hard deadline: fires after SIGTERM + 2 s SIGKILL grace, giving the
    // process group ~7 s total to exit before we give up waiting for close.
    const hardDeadlineMs = SETUP_TIMEOUT_MS + 7_000;
    const hardDeadlineTimer = setTimeout(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const timeoutMsg = `[setup-timeout: \`${label}\` did not complete within ${SETUP_TIMEOUT_MS / 1000}s]`;
      resolve({
        code: -1,
        stdout: stdoutBuf,
        stderr: [stderrBuf, timeoutMsg].map((s) => s.trim()).filter(Boolean).join("\n"),
      });
    }, hardDeadlineMs);

    const timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      // Kill the entire process group so subprocesses spawned by a shell
      // setup_command don't outlive the timeout and race against retries.
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => {
        if (!done) {
          try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* ignore */ }
        }
      }, 2_000);
      // Do NOT resolve here — let the close event resolve after the process
      // group exits. The hard deadline above is the fallback if close never fires.
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
      clearTimeout(hardDeadlineTimer);
      resolve({ code: -1, stdout: stdoutBuf, stderr: `spawn error: ${err.message}\n${stderrBuf}` });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(hardDeadlineTimer);
      if (timedOut) {
        const timeoutMsg = `[setup-timeout: \`${label}\` did not complete within ${SETUP_TIMEOUT_MS / 1000}s]`;
        resolve({
          code: -1,
          stdout: stdoutBuf,
          stderr: [stderrBuf, timeoutMsg].map((s) => s.trim()).filter(Boolean).join("\n"),
        });
      } else {
        resolve({ code: code ?? -1, stdout: stdoutBuf, stderr: stderrBuf });
      }
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
 *   2. `cfg.setup_command` (non-empty) → run via shell at the worktree root
 *      (overrides all detection)
 *   3. Choose package root: worktree root if it has a lockfile; else exactly
 *      one first-level subdirectory with a lockfile (always probe `core/`;
 *      ignore `.git`, `node_modules`, and names that start with `.`; two or
 *      more hits → skip)
 *   4. `<packageRoot>/node_modules` already present AND no `setup_command`
 *      set → skip (idempotent). A worktree-root `node_modules` does not skip
 *      a nested install.
 *   5. pnpm-lock.yaml → `pnpm install`
 *   6. yarn.lock → `yarn install`
 *   7. package-lock.json → `npm ci`
 *   8. No package root and no `setup_command` → skip
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
          (combined ? `\nOutput:\n${truncateOutput(combined)}` : ""),
      );
    }
    return { skipped: false, command: label, stdout: res.stdout, stderr: res.stderr };
  }

  // Choose package root before the node_modules skip so a leftover root
  // node_modules cannot suppress a nested core/ (or other first-level) install.
  const chosen = choosePackageRoot(worktreePath, existsFn, deps.listDir);
  if (!chosen) {
    return { skipped: true };
  }

  if (existsFn(path.join(chosen.packageRoot, "node_modules"))) {
    return { skipped: true };
  }

  const label = [chosen.cmd, ...chosen.args].join(" ");
  console.log(`[pipeline] worktree setup: running \`${label}\` (detected from ${chosen.lockfile})`);
  const res = await spawnFn(chosen.cmd, chosen.args, chosen.packageRoot, false);
  if (res.code !== 0) {
    const combined = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean).join("\n");
    throw new Error(
      `\`${label}\` exited with code ${res.code}` +
        (combined ? `\nOutput:\n${truncateOutput(combined)}` : ""),
    );
  }
  return { skipped: false, command: label, stdout: res.stdout, stderr: res.stderr };
}
