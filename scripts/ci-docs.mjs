#!/usr/bin/env node
// CI guard: run docs-generator freshness check when this worktree ships the
// repository docs generator (`scripts/generate-docs.mjs` and/or a generator-wired
// `docs:check` script). Exits 0 (no-op) when the generator is absent so main and
// install-smoke trees stay green without the #597 generator.
//
// Detection and check-mode resolution mirror `core/scripts/docs-freshness.ts`
// (`detectDocsGenerator` / `scriptIsDocsFreshnessCheck`) — keep them in lock-step.
// Write-mode-only `docs:check` is never treated as a freshness check; when the
// generator file exists we fall through to `node scripts/generate-docs.mjs --check`.
//
// Called via `npm run ci:docs` as part of the `npm run ci` gate (#756).
// Override the root directory with CI_DOCS_ROOT for test isolation.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.env.CI_DOCS_ROOT ?? process.cwd();
const GENERATOR_REL = join("scripts", "generate-docs.mjs");

/**
 * True when a package.json script value invokes the docs generator contract.
 * @param {string | undefined} scriptValue
 */
export function scriptInvokesDocsGenerator(scriptValue) {
  if (!scriptValue) return false;
  return /generate-docs(?:\.mjs)?\b/.test(scriptValue);
}

/**
 * Split a package.json script body into top-level shell command segments.
 * @param {string} scriptValue
 * @returns {string[]}
 */
function scriptCommandSegments(scriptValue) {
  return scriptValue
    .split(/(?:&&|\|\||[;|])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * True when a script body is a real check-mode docs freshness invocation.
 * @param {string | undefined} scriptValue
 */
export function scriptIsDocsFreshnessCheck(scriptValue) {
  if (!scriptValue) return false;
  const segments = scriptCommandSegments(scriptValue);
  let sawCheckModeGenerator = false;
  for (const seg of segments) {
    if (!scriptInvokesDocsGenerator(seg)) continue;
    if (!/--check\b/.test(seg)) return false;
    sawCheckModeGenerator = true;
  }
  return sawCheckModeGenerator;
}

/**
 * Detect docs-generator presence and which check command to run.
 * Mirrors core `detectDocsGenerator` (check-command half only).
 * @param {string} repoRoot
 * @returns {{ present: false } | { present: true, checkCommand: string }}
 */
export function detectDocsGeneratorForCi(repoRoot) {
  const generatorAbs = join(repoRoot, GENERATOR_REL);
  const hasGeneratorFile = existsSync(generatorAbs);

  /** @type {Record<string, string>} */
  let scripts = {};
  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg && typeof pkg.scripts === "object" && pkg.scripts) {
        scripts = pkg.scripts;
      }
    } catch {
      // Invalid package.json — treat scripts as empty.
    }
  }

  const docsCheckScript = scripts["docs:check"];
  const checkInvokes = scriptInvokesDocsGenerator(docsCheckScript);
  const docsCheckIsCheckMode = scriptIsDocsFreshnessCheck(docsCheckScript);

  if (!hasGeneratorFile && !checkInvokes) {
    return { present: false };
  }

  // Prefer npm docs:check only when its body is real check-mode. Otherwise use
  // the generator entry point with --check (even if docs:check is write-mode).
  const checkCommand = docsCheckIsCheckMode
    ? "npm run docs:check"
    : "node scripts/generate-docs.mjs --check";

  return { present: true, checkCommand };
}

/**
 * Run the resolved check command in `repoRoot`.
 * @param {string} repoRoot
 * @param {string} checkCommand
 * @param {{ spawn?: typeof spawnSync }} [opts]
 * @returns {number} exit status
 */
export function runDocsCheck(repoRoot, checkCommand, opts = {}) {
  const spawn = opts.spawn ?? spawnSync;
  // Shell so `npm run …` works the same as package.json scripts.
  const result = spawn(checkCommand, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  if (result.error) {
    process.stderr.write(
      `ci-docs: failed to spawn docs check (${checkCommand}): ${result.error.message}\n`,
    );
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Main entry: no-op when generator absent; check-mode when present.
 * @param {{ root?: string, spawn?: typeof spawnSync }} [opts]
 * @returns {number}
 */
export function runCiDocs(opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const surface = detectDocsGeneratorForCi(root);
  if (!surface.present) {
    return 0;
  }
  return runDocsCheck(root, surface.checkCommand, { spawn: opts.spawn });
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
  process.exitCode = runCiDocs();
}
