#!/usr/bin/env node
// CI guard: run in-tree `pipeline config validate` against this repo's live
// `.github/pipeline.yml`. Fails the gate on any severity: "error" diagnostic.
// Does not use a globally installed `pipeline` binary (#1264).
//
// Called via `npm run ci:config-validate` as part of the `npm run ci` gate.
// Override the root directory with CI_CONFIG_VALIDATE_ROOT for test isolation.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Validate `.github/pipeline.yml` at `repoRoot` using the in-tree CLI.
 * @param {string} [repoRoot]
 * @param {{ nodePath?: string, spawn?: typeof spawnSync }} [opts]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function runCiConfigValidate(repoRoot = process.env.CI_CONFIG_VALIDATE_ROOT ?? DEFAULT_ROOT, opts = {}) {
  const nodePath = opts.nodePath ?? process.execPath;
  const spawn = opts.spawn ?? spawnSync;
  const cli = join(repoRoot, "core", "scripts", "pipeline.ts");
  const configPath = join(repoRoot, ".github", "pipeline.yml");
  if (!existsSync(cli)) {
    return {
      status: 1,
      stdout: "",
      stderr: `ci-config-validate: missing in-tree CLI at ${cli}\n`,
    };
  }
  if (!existsSync(configPath)) {
    return {
      status: 1,
      stdout: "",
      stderr: `ci-config-validate: missing ${configPath}\n`,
    };
  }
  const result = spawn(
    nodePath,
    ["--experimental-strip-types", cli, "config", "validate", "--repo-path", repoRoot],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, NODE_PATH: join(repoRoot, "core", "node_modules") } },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = runCiConfigValidate();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.stderr.write("ci-config-validate: pipeline config validate failed for this repo's .github/pipeline.yml\n");
  }
  process.exit(result.status === 0 ? 0 : 1);
}
