#!/usr/bin/env node
// Post-tag CHANGELOG / generator-owned docs refresh entry (#978).
//
// Invoked by auto-tag-release.yml after a successful annotated version tag
// push, and available for operator heal:
//
//   node scripts/release-docs-refresh.mjs --version 1.34.0
//   node scripts/release-docs-refresh.mjs --version 1.34.0 --push
//
// Does not create, rewrite, or delete tags. Exit non-zero on generate/commit/push
// failure so the auto-tag job fails closed when CHANGELOG stays stale.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CORE_SCRIPTS = join(REPO_ROOT, "core", "scripts");

function parseArgs(argv) {
  let version = null;
  let push = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version" || a === "-v") {
      version = argv[++i] ?? null;
      continue;
    }
    if (a === "--push") {
      push = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/release-docs-refresh.mjs --version <X.Y.Z> [--push]\n" +
          "\n" +
          "Regenerate generator-owned docs (including CHANGELOG.md) after tag vX.Y.Z\n" +
          "exists, and commit dirt. With --push, also push the current branch.\n" +
          "No-op success when generation produces no generator-owned diff.",
      );
      process.exit(0);
    }
    console.error(`release-docs-refresh: unknown argument ${JSON.stringify(a)}`);
    process.exit(2);
  }
  return { version, push };
}

async function importCore(relName) {
  const abs = join(CORE_SCRIPTS, relName);
  return import(pathToFileURL(abs).href);
}

async function main() {
  const { version, push } = parseArgs(process.argv.slice(2));
  if (!version) {
    console.error(
      "release-docs-refresh: --version <X.Y.Z> is required.\n" +
        "  Usage: node scripts/release-docs-refresh.mjs --version 1.34.0 [--push]",
    );
    process.exit(2);
  }

  const coreNodeModules = join(REPO_ROOT, "core", "node_modules");
  if (!existsSync(coreNodeModules)) {
    console.error(
      "release-docs-refresh: core/node_modules missing — run `cd core && npm ci` first",
    );
    process.exit(1);
  }
  if (!process.env.NODE_PATH?.includes(coreNodeModules)) {
    process.env.NODE_PATH = [coreNodeModules, process.env.NODE_PATH]
      .filter(Boolean)
      .join(":");
  }

  const {
    refreshPostTagDocs,
    realReleaseDocsRefreshDeps,
    docsGeneratorPresent,
    localTagExists,
  } = await importCore("release-docs-refresh.ts");

  if (!docsGeneratorPresent(REPO_ROOT)) {
    console.error(
      "release-docs-refresh: scripts/generate-docs.mjs is missing — cannot regenerate docs",
    );
    process.exit(1);
  }

  const ver = String(version).replace(/^v/, "");
  if (!localTagExists(REPO_ROOT, ver)) {
    console.error(
      `release-docs-refresh: annotated tag v${ver} is not visible in this checkout.\n` +
        `  Fetch tags (git fetch --tags) and re-run after the tag exists.`,
    );
    process.exit(1);
  }

  const deps = realReleaseDocsRefreshDeps({
    push,
    log: (msg) => console.error(msg),
  });
  const result = await refreshPostTagDocs(REPO_ROOT, ver, deps);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.committed) {
    console.log(
      `release-docs-refresh: committed ${result.commitMessage} ` +
        `(${result.paths.join(", ")})${push ? " and pushed" : ""}`,
    );
  } else {
    console.log(`release-docs-refresh: already fresh for v${ver} — no commit`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
