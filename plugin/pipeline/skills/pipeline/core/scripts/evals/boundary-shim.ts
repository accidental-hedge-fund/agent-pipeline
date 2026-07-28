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
//
// The interceptor directory and denial log live in a sibling control
// directory *next to* the cell worktree, never inside it (review 1 finding
// 759fe7a3): the worktree is the treatment's own writable working tree, and a
// treatment that `rm -rf`s or `git clean`s its tree must not also destroy the
// boundary's evidence. This is a same-uid child process, not a container, so
// it is not proof against a treatment that deliberately inspects its `PATH`/
// `EVAL_BOUNDARY_DENIAL_LOG` env vars and targets that path directly — real
// tamper-proofing needs OS-level sandboxing (a different uid or a read-only
// mount) this engine does not have. Moving the control plane out of the
// worktree closes the common case (ordinary working-tree operations) without
// claiming to close that residual one.

import * as fs from "node:fs";
import * as path from "node:path";
import type { BoundaryDenial } from "./types.ts";

const SHIM_DIR_NAME = "shim";
const DENIAL_LOG_NAME = "denials.jsonl";

/** The cell-scoped control directory the boundary writes into, a sibling of
 *  the cell worktree (never a path inside it) — a pure function of
 *  `worktreeDir` so it stays deterministic per cell and never collides
 *  across cells, matching `allocateCellIdentity`'s determinism. */
function controlDir(worktreeDir: string): string {
  return `${worktreeDir}.eval-boundary`;
}

export function boundaryShimDir(worktreeDir: string): string {
  return path.join(controlDir(worktreeDir), SHIM_DIR_NAME);
}

export function boundaryDenialLogPath(worktreeDir: string): string {
  return path.join(controlDir(worktreeDir), DENIAL_LOG_NAME);
}

function denyAllScript(command: string, category: string): string {
  return `#!${process.execPath}
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
 *  never a hardcoded absolute path, so it stays portable.
 *
 *  The subcommand is resolved by skipping git's own global options first
 *  (review 1 finding 47b5f59b) — git accepts these *before* the subcommand
 *  (`git -C . push`, `git -c foo.bar=baz commit -m x`, `git --no-pager
 *  worktree add ...`), and classifying from `argv[0]` alone let all three
 *  through as an unrecognized "subcommand". `resolveSubcommand` walks argv,
 *  skipping recognized global flags (and the separate value some of them
 *  take) until it finds the first non-option token. */
function gitShimScript(): string {
  return `#!${process.execPath}
const fs = require("fs");
const { spawnSync } = require("child_process");
const argv = process.argv.slice(2);
const DENIED = { worktree: "nested-worktree", commit: "commit", push: "push", remote: "remote-mutation" };
const GLOBAL_OPTS_WITH_VALUE = new Set(["-C", "-c", "--exec-path", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
function resolveSubcommand(args) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith("-")) return arg;
    const eqIdx = arg.indexOf("=");
    const optName = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    i += (eqIdx < 0 && GLOBAL_OPTS_WITH_VALUE.has(optName)) ? 2 : 1;
  }
  return undefined;
}
const sub = resolveSubcommand(argv);
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

/** A treatment can bypass the `pipeline` PATH shim by invoking the TypeScript
 * entrypoint through Node directly (`node core/scripts/pipeline.ts …`). Node
 * itself remains usable for tests and local tooling; this interceptor denies
 * only an argv that names that entrypoint. The other shim scripts use the
 * absolute current Node executable in their shebangs so this shim cannot
 * recurse through `/usr/bin/env node`. */
function nodeShimScript(): string {
  return `#!${process.execPath}
const fs = require("fs");
const { spawnSync } = require("child_process");
const argv = process.argv.slice(2);
const isPipelineEntrypoint = argv.some((arg) => {
  if (typeof arg !== "string" || arg.startsWith("-")) return false;
  const normalized = arg.replace(/\\\\/g, "/");
  return normalized === "core/scripts/pipeline.ts" || normalized.endsWith("/core/scripts/pipeline.ts");
});
if (isPipelineEntrypoint) {
  const entry = { command: "node", argv, category: "pipeline-advance", at: new Date().toISOString() };
  const logPath = process.env.EVAL_BOUNDARY_DENIAL_LOG;
  if (logPath) { try { fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n"); } catch {} }
  process.stderr.write("eval-boundary: node execution of core/scripts/pipeline.ts is denied inside an evaluation cell (category: pipeline-advance)\\n");
  process.exit(1);
}
const shimDir = __dirname;
const restPath = (process.env.PATH || "").split(":").filter((p) => p && p !== shimDir).join(":");
const result = spawnSync("node", argv, { stdio: "inherit", env: Object.assign({}, process.env, { PATH: restPath }) });
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
 *  remote, pass everything else through). Returns the shim directory path.
 *  `io.mkdir`'s recursive create also creates the sibling control directory
 *  itself (`boundaryShimDir`'s parent), since it lives outside `worktreeDir`
 *  and nothing else provisions it. */
export function installBoundaryShim(worktreeDir: string, io: BoundaryShimIO = defaultShimIO): string {
  const dir = boundaryShimDir(worktreeDir);
  io.mkdir(dir);
  const files: Record<string, string> = {
    gh: denyAllScript("gh", "github-write"),
    pipeline: denyAllScript("pipeline", "pipeline-advance"),
    git: gitShimScript(),
    node: nodeShimScript(),
  };
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    io.writeFile(filePath, content);
    io.chmod(filePath, 0o755);
  }
  return dir;
}

/** Remove the cell's boundary control directory (shim + denial log) once the
 *  cell is done. Not covered by worktree removal — the control directory is
 *  a sibling of the worktree, not inside it — so a caller must invoke this
 *  separately during cell teardown to avoid stranding it. Best-effort: a
 *  missing directory is not an error. */
export function removeBoundaryShim(worktreeDir: string, rm: (dir: string) => void = (dir) => fs.rmSync(dir, { recursive: true, force: true })): void {
  rm(controlDir(worktreeDir));
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
    } catch (err) {
      // ENOENT means no denial was ever recorded — a normal, expected state
      // that must read as "no denials", never as a collection failure. Any
      // other error (e.g. EACCES) means collection genuinely failed and must
      // propagate rather than be silently folded into "no denials occurred"
      // (review 1 finding 759fe7a3) — the caller (executor.ts's `finish()`)
      // already catches this and records it as `boundary_evidence_error`.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
};

/** Parse the cell's denial log into structured entries. An absent log (no
 *  denial ever occurred) returns an empty array. A genuine read failure
 *  (anything other than the log not existing) throws rather than being
 *  mapped to `[]`, so it is never mistaken for "no denials occurred"; a
 *  malformed individual line is still skipped rather than failing the whole
 *  read. */
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
