// Process-level command boundary for an eval cell's harness child process
// (#607 — eval-agent-isolation-boundary). Denies the high-risk command set —
// nested worktree creation, pipeline stage advancement, commit, push/remote
// mutation, and any `gh` invocation — by interposing on the child's PATH
// rather than relying on prompt text alone. Every denial is appended as a
// structured JSON line to a cell-scoped log; a permitted git operation is
// passed straight through to the real binary.
//
// Deliberately Node-shebang scripts (`#!/usr/bin/env node`), not POSIX sh —
// this engine already requires Node 24+ on PATH, and JSON.stringify gives
// reliable argv/structured-log encoding that hand-rolled shell escaping
// cannot.

import * as fs from "node:fs";
import * as path from "node:path";
import type { BoundaryDenial } from "./types.ts";

const SHIM_DIR_NAME = ".eval-boundary-shim";
const DENIAL_LOG_NAME = ".eval-boundary-denials.jsonl";

/** Repository-relative names the boundary itself writes into a cell
 *  worktree, excluded from changed-path evidence (executor.ts) so they are
 *  never attributed to the treatment. */
export const BOUNDARY_SHIM_PATHS = [SHIM_DIR_NAME, DENIAL_LOG_NAME] as const;

/** The shim directory's own name, so a caller can also exclude every file
 *  *inside* it (e.g. `.eval-boundary-shim/gh`) by prefix — `BOUNDARY_SHIM_PATHS`
 *  only names the directory itself. */
export const BOUNDARY_SHIM_DIR_NAME = SHIM_DIR_NAME;

export function boundaryShimDir(worktreeDir: string): string {
  return path.join(worktreeDir, SHIM_DIR_NAME);
}

export function boundaryDenialLogPath(worktreeDir: string): string {
  return path.join(worktreeDir, DENIAL_LOG_NAME);
}

function denyAllScript(command: string, category: string): string {
  return `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
const entry = { command: ${JSON.stringify(command)}, argv, category: ${JSON.stringify(category)}, at: new Date().toISOString() };
const logPath = process.env.EVAL_BOUNDARY_DENIAL_LOG;
if (logPath) { try { fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n"); } catch {} }
process.stderr.write("eval-boundary: " + ${JSON.stringify(command)} + " is denied inside an evaluation cell (category: " + ${JSON.stringify(category)} + ")\\n");
process.exit(1);
`;
}

/** git passes through to the real binary except for the denied subcommands
 *  (nested worktree creation, commit, push, remote mutation). Resolves the
 *  real `git` by stripping the shim's own directory from PATH before exec —
 *  never a hardcoded absolute path, so it stays portable. */
function gitShimScript(): string {
  return `#!/usr/bin/env node
const fs = require("fs");
const { spawnSync } = require("child_process");
const argv = process.argv.slice(2);
const DENIED = { worktree: "nested-worktree", commit: "commit", push: "push", remote: "remote-mutation" };
const sub = argv[0];
const category = sub ? DENIED[sub] : undefined;
if (category) {
  const entry = { command: "git", argv, category, at: new Date().toISOString() };
  const logPath = process.env.EVAL_BOUNDARY_DENIAL_LOG;
  if (logPath) { try { fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n"); } catch {} }
  process.stderr.write("eval-boundary: git " + sub + " is denied inside an evaluation cell (category: " + category + ")\\n");
  process.exit(1);
}
const shimDir = __dirname;
const restPath = (process.env.PATH || "").split(":").filter((p) => p && p !== shimDir).join(":");
const result = spawnSync("git", argv, { stdio: "inherit", env: Object.assign({}, process.env, { PATH: restPath }) });
process.exit(result.status === null || result.status === undefined ? 1 : result.status);
`;
}

export interface BoundaryShimIO {
  mkdir: (dir: string) => void;
  writeFile: (filePath: string, content: string) => void;
  chmod: (filePath: string, mode: number) => void;
}

const defaultShimIO: BoundaryShimIO = {
  mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
  writeFile: (filePath, content) => fs.writeFileSync(filePath, content, "utf8"),
  chmod: (filePath, mode) => fs.chmodSync(filePath, mode),
};

/** Materialize the cell-scoped deny-shim directory: interceptors for `gh`
 *  (deny all), `pipeline` (deny all), and `git` (deny worktree/commit/push/
 *  remote, pass everything else through). Returns the shim directory path. */
export function installBoundaryShim(worktreeDir: string, io: BoundaryShimIO = defaultShimIO): string {
  const dir = boundaryShimDir(worktreeDir);
  io.mkdir(dir);
  const files: Record<string, string> = {
    gh: denyAllScript("gh", "github-write"),
    pipeline: denyAllScript("pipeline", "pipeline-advance"),
    git: gitShimScript(),
  };
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    io.writeFile(filePath, content);
    io.chmod(filePath, 0o755);
  }
  return dir;
}

/** Env overrides that activate the boundary for a harness child process:
 *  prepend the shim directory to PATH (so `gh`/`pipeline`/`git` resolve to
 *  the interceptors first) and point the denial log at the cell-scoped
 *  file. Cell-scoped by construction — composes with, never replaces, other
 *  env overrides (e.g. isolatedGhEnv in executor.ts). */
export function boundaryEnv(worktreeDir: string): NodeJS.ProcessEnv {
  const dir = boundaryShimDir(worktreeDir);
  return {
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    EVAL_BOUNDARY_DENIAL_LOG: boundaryDenialLogPath(worktreeDir),
  };
}

export interface DenialLogIO {
  readFile: (filePath: string) => string | null;
}

const defaultDenialLogIO: DenialLogIO = {
  readFile: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  },
};

/** Parse the cell's denial log into structured entries. An absent log (no
 *  denial ever occurred) returns an empty array — never throws; a malformed
 *  line is skipped rather than failing the whole read. */
export function readBoundaryDenials(worktreeDir: string, io: DenialLogIO = defaultDenialLogIO): BoundaryDenial[] {
  const raw = io.readFile(boundaryDenialLogPath(worktreeDir));
  if (raw === null) return [];
  const denials: BoundaryDenial[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        parsed && typeof parsed === "object" &&
        typeof parsed.command === "string" &&
        typeof parsed.category === "string" &&
        Array.isArray(parsed.argv) &&
        typeof parsed.at === "string"
      ) {
        denials.push({ command: parsed.command, argv: parsed.argv as string[], category: parsed.category, at: parsed.at });
      }
    } catch {
      // Skip an unparseable line rather than failing the whole read.
    }
  }
  return denials;
}
