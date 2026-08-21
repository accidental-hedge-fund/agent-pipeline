#!/usr/bin/env node
// Ensure CI and other npm scripts run under an engines-compliant Node (>=24).
//
// Multi-node factory hosts (Hermes Node 22 early on PATH + system Node 24) otherwise
// execute `npm run ci` on a too-old runtime. The shim and engines field require Node
// >=24; this wrapper resolves a compliant binary, prefers its directory on PATH, and
// runs the remainder of the command so process.execPath and `#!/usr/bin/env node`
// both land on the same major.
//
// Usage:
//   node scripts/ensure-engines-node.mjs -c "npm run ci:core && …"
//   node scripts/ensure-engines-node.mjs -- cmd arg1 arg2
//
// Override candidate: AGENT_PIPELINE_NODE=/path/to/node24

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @type {number} */
export const ENGINES_NODE_FLOOR_MAJOR = 24;

/**
 * Parse major from a node version string like "24.18.0".
 * @param {string} version
 * @returns {number | null}
 */
export function parseNodeMajor(version) {
  const major = Number.parseInt(String(version).trim().split(".")[0], 10);
  return Number.isFinite(major) ? major : null;
}

/**
 * Probe a node binary for its major version. Returns null on failure.
 * @param {string} nodePath
 * @param {{
 *   spawn?: (command: string, args: string[], options?: object) => { status: number | null, stdout?: string | Buffer | null },
 *   pathExists?: (p: string) => boolean,
 * }} [opts]
 * @returns {number | null}
 */
export function probeNodeMajor(nodePath, opts = {}) {
  const spawn = opts.spawn ?? spawnSync;
  const pathExists = opts.pathExists ?? existsSync;
  if (!nodePath || !pathExists(nodePath)) return null;
  const result = spawn(nodePath, ["-p", "process.versions.node"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return parseNodeMajor(String(result.stdout ?? ""));
}

/**
 * Resolve a Node binary whose major is >= floor.
 * Prefers process.execPath when it already satisfies the floor, then
 * AGENT_PIPELINE_NODE, well-known install locations, then PATH entries.
 *
 * @param {{
 *   floor?: number,
 *   execPath?: string,
 *   execVersion?: string,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   spawn?: typeof spawnSync,
 *   pathExists?: (p: string) => boolean,
 * }} [opts]
 * @returns {{ path: string, major: number } | null}
 */
export function resolveEnginesNode(opts = {}) {
  const floor = opts.floor ?? ENGINES_NODE_FLOOR_MAJOR;
  const env = opts.env ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  const execVersion = opts.execVersion ?? process.versions.node;
  const home = opts.home ?? homedir();
  const spawn = opts.spawn ?? spawnSync;
  const pathExists = opts.pathExists ?? existsSync;

  const execMajor = parseNodeMajor(execVersion);
  if (execMajor != null && execMajor >= floor && pathExists(execPath)) {
    return { path: execPath, major: execMajor };
  }

  /** @type {string[]} */
  const candidates = [];
  if (env.AGENT_PIPELINE_NODE) candidates.push(env.AGENT_PIPELINE_NODE);
  candidates.push("/usr/bin/node");
  candidates.push(join(home, ".local", "node-v24", "bin", "node"));
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push(join(dir, "node"));
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (!pathExists(candidate)) continue;
    // Avoid re-probing the already-too-old execPath.
    if (candidate === execPath && (execMajor == null || execMajor < floor)) continue;
    const major = probeNodeMajor(candidate, { spawn, pathExists });
    if (major != null && major >= floor) return { path: candidate, major };
  }
  return null;
}

/**
 * Build env with the engines node's bin dir first on PATH.
 * @param {string} nodePath
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function envPreferringNode(nodePath, base = process.env) {
  const binDir = dirname(nodePath);
  const rest = base.PATH ?? "";
  const pathValue = rest ? `${binDir}${delimiter}${rest}` : binDir;
  return {
    ...base,
    PATH: pathValue,
    AGENT_PIPELINE_ENGINES_NODE: nodePath,
    AGENT_PIPELINE_ENGINES_NODE_OK: "1",
  };
}

/** Composer-reexec flags. A parent Tugboat ship exports these; `npm run ci`
 *  is not that re-exec. Inheriting them fail-closes tugboat tests
 *  (`TUGBOAT_SKIP_TRAIN without train.complete.json or train.json`). */
export const TUGBOAT_PARENT_CONTROL_KEYS = [
  "TUGBOAT_SKIP_TRAIN",
  "TUGBOAT_CANDIDATE_COMPOSER",
];

/**
 * Drop inherited Tugboat composer-reexec flags from a child env.
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function envWithoutTugboatParentControl(base = {}) {
  const env = { ...base };
  for (const key of TUGBOAT_PARENT_CONTROL_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * Run argv under an engines-compliant Node (PATH rewritten).
 * @param {string[]} argv tokens after the script name
 * @param {{
 *   resolve?: typeof resolveEnginesNode,
 *   spawn?: typeof spawnSync,
 *   env?: NodeJS.ProcessEnv,
 *   floor?: number,
 *   stderr?: (s: string) => void,
 * }} [opts]
 * @returns {number} exit status
 */
export function runUnderEnginesNode(argv, opts = {}) {
  const floor = opts.floor ?? ENGINES_NODE_FLOOR_MAJOR;
  const resolve = opts.resolve ?? resolveEnginesNode;
  const spawn = opts.spawn ?? spawnSync;
  const baseEnv = opts.env ?? process.env;
  const stderr = opts.stderr ?? ((s) => process.stderr.write(s));

  const resolved = resolve({ floor, env: baseEnv });
  if (!resolved) {
    stderr(
      `pipeline: requires Node >= ${floor} for native TypeScript execution` +
        ` (found ${process.versions.node}).\n` +
        `         Install Node ${floor}+ (e.g. system Node at /usr/bin/node) and re-run.\n` +
        `         Or set AGENT_PIPELINE_NODE to a Node ${floor}+ binary.\n`,
    );
    return 1;
  }

  const env = envWithoutTugboatParentControl(
    envPreferringNode(resolved.path, baseEnv),
  );
  const tokens = [...argv];
  if (tokens[0] === "--") tokens.shift();

  if (tokens.length === 0) {
    stderr("pipeline: ensure-engines-node: missing command\n");
    return 2;
  }

  if (tokens[0] === "-c") {
    if (tokens.length < 2) {
      stderr("pipeline: ensure-engines-node: -c requires a command string\n");
      return 2;
    }
    const shell = process.platform === "win32" ? "cmd" : "bash";
    const shellArgs =
      process.platform === "win32" ? ["/d", "/s", "/c", tokens[1]] : ["-c", tokens[1]];
    const result = spawn(shell, shellArgs, { env, stdio: "inherit" });
    return result.status ?? 1;
  }

  const result = spawn(tokens[0], tokens.slice(1), { env, stdio: "inherit" });
  return result.status ?? 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = runUnderEnginesNode(process.argv.slice(2));
}
