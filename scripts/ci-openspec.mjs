#!/usr/bin/env node
// CI guard: run `openspec validate --all` when this repo has an openspec/ workspace,
// then check that no unexpected OpenSpec change is left "active" on the default branch.
// Exits 0 (no-op) when no openspec/ directory is present, so repos and contexts
// that do not use OpenSpec (including the install smoke test) are unaffected.
//
// CLI resolution: tries the preinstalled binary first; falls back to
// `npx @fission-ai/openspec` so the step works on a fresh CI runner without
// a preinstalled `openspec` CLI.
//
// Default-branch active-change guard: a completed OpenSpec change is supposed to be
// archived (either automatically at pre-merge, or manually via `openspec archive <id>`).
// A change directory left active on the default branch means agents will keep treating
// shipped or abandoned proposals as current implementation intent. This step fails loudly
// when that happens, unless the change id is listed in openspec/active-allowlist.txt.
// The guard is inert on pull-request branches, which legitimately carry their own
// in-flight change.
//
// Called via `npm run ci:openspec` as part of the `npm run ci` gate.
// Override the root directory with CI_OPENSPEC_ROOT for test isolation.
// Override the hygiene mode with OPENSPEC_HYGIENE_MODE (`default-branch` | `pr` | `off`).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = process.env.CI_OPENSPEC_ROOT ?? process.cwd();

if (!existsSync(join(REPO_ROOT, "openspec"))) {
  // No openspec/ workspace — no-op so non-OpenSpec repos are unaffected.
  process.exit(0);
}

function runValidate(cmd, args) {
  return spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", shell: false });
}

function resolveDefaultBranchName(repoRoot) {
  const originHead = spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (originHead.status === 0 && originHead.stdout) {
    const match = originHead.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  }
  return "main";
}

// Resolution order: OPENSPEC_HYGIENE_MODE env var, then GitHub Actions environment,
// then the locally checked-out git branch, then inert (fail-open) if undetermined.
function resolveHygieneMode(repoRoot) {
  const envMode = process.env.OPENSPEC_HYGIENE_MODE;
  if (envMode === "default-branch" || envMode === "pr" || envMode === "off") {
    return envMode;
  }

  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName === "pull_request") return "pr";
  if (eventName === "push") {
    const defaultBranch = resolveDefaultBranchName(repoRoot);
    return process.env.GITHUB_REF === `refs/heads/${defaultBranch}` ? "default-branch" : "pr";
  }

  const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (branchResult.status === 0) {
    const branch = branchResult.stdout.trim();
    const defaultBranch = resolveDefaultBranchName(repoRoot);
    if (branch && branch === defaultBranch) return "default-branch";
  }

  return "off";
}

function listActiveChanges(repoRoot) {
  const changesDir = join(repoRoot, "openspec", "changes");
  if (!existsSync(changesDir)) return [];
  return readdirSync(changesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "archive")
    .map((entry) => entry.name)
    .sort();
}

function parseAllowlist(repoRoot) {
  const allowlistPath = join(repoRoot, "openspec", "active-allowlist.txt");
  if (!existsSync(allowlistPath)) return [];
  return readFileSync(allowlistPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function runHygieneCheck(repoRoot) {
  const mode = resolveHygieneMode(repoRoot);
  if (mode !== "default-branch") {
    // Inert off the default branch (pr mode) or when the mode cannot be determined.
    return 0;
  }

  const active = listActiveChanges(repoRoot);
  const allowlist = parseAllowlist(repoRoot);
  const allowSet = new Set(allowlist);
  const offenders = active.filter((id) => !allowSet.has(id));
  const staleAllowlistEntries = allowlist.filter((id) => !active.includes(id));

  if (offenders.length === 0 && staleAllowlistEntries.length === 0) {
    return 0;
  }

  if (offenders.length > 0) {
    process.stderr.write(
      "ci-openspec: unexpected active OpenSpec change(s) on the default branch:\n",
    );
    for (const id of offenders) {
      process.stderr.write(`  - ${id}\n`);
    }
    process.stderr.write(
      "Expected cleanup: these are archived automatically at pre-merge, or manually via `openspec archive <id>`.\n",
    );
  }

  if (staleAllowlistEntries.length > 0) {
    process.stderr.write(
      "ci-openspec: openspec/active-allowlist.txt names change id(s) that are not currently active:\n",
    );
    for (const id of staleAllowlistEntries) {
      process.stderr.write(`  - ${id}\n`);
    }
  }

  return 1;
}

let result = runValidate("openspec", ["validate", "--all"]);

if (result.error?.code === "ENOENT") {
  // openspec not on PATH — fall back to npx (works on fresh CI runners).
  // Version is pinned so the fallback is deterministic and cannot silently
  // execute changed or compromised code published under the @latest tag.
  result = runValidate("npx", [
    "--yes",
    "@fission-ai/openspec@1.4.1",
    "validate",
    "--all",
  ]);
}

if (result.error) {
  process.stderr.write(`ci-openspec: failed to spawn openspec: ${result.error.message}\n`);
  process.exit(1);
}

const validateStatus = result.status ?? 1;
const hygieneStatus = runHygieneCheck(REPO_ROOT);

process.exit(validateStatus !== 0 ? validateStatus : hygieneStatus);
