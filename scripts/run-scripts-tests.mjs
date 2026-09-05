#!/usr/bin/env node
// Structural runner for scripts/*.test.mjs (#681).
//
// Root cause / hypothesis: Node's multi-file `node --test a.mjs b.mjs …` parent
// aggregates child results over IPC (`#processRawBuffer`). Under Node 24 that path
// intermittently fails with:
//   Error: Unable to deserialize cloned data due to invalid or unsupported version.
// That is a test-runner *host* error, not a product assertion failure. Pre-merge
// treats any CI red as a hard block, so the flake becomes a human gate.
//
// Fix: run each scripts/*.test.mjs as its own top-level
// `node --test --test-isolation=none <file>` process (sorted, deterministic).
// One process per file preserves cross-file state isolation; isolation=none
// avoids the per-file process-isolation IPC deserialize path
// (`#processRawBuffer`) that can still fail for large files like install.test.mjs.
// Product failures still exit non-zero and print normal runner output.
//
// Wired from package.json as `ci:scripts` and the scripts half of `npm test`.
// Override the scripts directory with RUN_SCRIPTS_TESTS_DIR for unit tests.

import { readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

/** @typedef {(command: string, args: string[], options: object) => { status: number | null, error?: Error, signal?: string | null, stdout?: string | Buffer | null, stderr?: string | Buffer | null }} SpawnFn */

/**
 * Discover scripts unit-test files under `scriptsDir` (sorted by basename).
 * @param {string} scriptsDir
 * @returns {string[]} absolute paths
 */
export function listScriptsTestFiles(scriptsDir) {
  const names = readdirSync(scriptsDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort();
  return names.map((name) => join(scriptsDir, name));
}

/**
 * Env for a top-level `node --test` child. Strip parent test-runner context so
 * nested invocations (e.g. regression tests that spawn this wrapper under
 * `node --test`) do not hit "run() is being called recursively … skipping
 * running files" and silently exit 0. Also strip inherited candidate-process
 * bindings so a factory worker cannot fail scripts tests by treating this
 * checkout as outside the packed engine root.
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function childTestEnv(base = process.env) {
  const env = { ...base };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  for (const key of Object.keys(env)) {
    if (key.startsWith("PIPELINE_CANDIDATE_")) delete env[key];
  }
  return env;
}

/**
 * Run each discovered test file as its own top-level
 * `node --test --test-isolation=none <file>` process.
 * @param {{
 *   scriptsDir: string,
 *   nodePath?: string,
 *   spawn?: SpawnFn,
 *   stdio?: 'inherit' | 'pipe' | 'ignore' | Array,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 * @returns {number} 0 if every file exits 0; 1 otherwise
 */
export function runScriptsTests(opts) {
  const {
    scriptsDir,
    nodePath = process.execPath,
    spawn = spawnSync,
    stdio = "inherit",
    cwd = resolve(scriptsDir, ".."),
    env = process.env,
  } = opts;

  const files = listScriptsTestFiles(scriptsDir);
  if (files.length === 0) {
    console.error(
      `run-scripts-tests: no *.test.mjs files found under ${scriptsDir}`,
    );
    return 1;
  }

  const childEnv = childTestEnv(env);
  let failed = 0;
  for (const file of files) {
    // One top-level process per file — do not pass multiple files to a single
    // `node --test` parent (multi-file parent IPC aggregation).
    // --test-isolation=none: default isolation is `process`, which still starts
    // a runner child and deserializes results over IPC for that single file.
    const result = spawn(
      nodePath,
      ["--test", "--test-isolation=none", file],
      {
        cwd,
        env: childEnv,
        stdio,
        shell: false,
      },
    );
    if (result.error) {
      console.error(
        `run-scripts-tests: failed to spawn node --test for ${file}: ${result.error.message}`,
      );
      failed += 1;
      continue;
    }
    if (result.status !== 0) {
      failed += 1;
    }
  }
  return failed === 0 ? 0 : 1;
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
  const scriptsDir =
    process.env.RUN_SCRIPTS_TESTS_DIR ??
    dirname(fileURLToPath(import.meta.url));
  process.exitCode = runScriptsTests({ scriptsDir });
}
