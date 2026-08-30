#!/usr/bin/env node
// Tests for scripts/ci-config-validate.mjs (#1264).
// Run with: node --test scripts/ci-config-validate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runCiConfigValidate } from "./ci-config-validate.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const GUARD = join(REPO_ROOT, "scripts", "ci-config-validate.mjs");

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "ci-config-validate-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("ci npm script includes ci:config-validate step", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(
    pkg.scripts?.ci?.includes("ci:config-validate"),
    `package.json 'ci' script must include 'ci:config-validate'; got: ${pkg.scripts?.ci}`,
  );
  assert.ok(
    typeof pkg.scripts?.["ci:config-validate"] === "string",
    "package.json must define a 'ci:config-validate' script",
  );
  assert.match(
    pkg.scripts["ci:config-validate"],
    /ci-config-validate\.mjs/,
    `ci:config-validate must invoke scripts/ci-config-validate.mjs; got: ${pkg.scripts["ci:config-validate"]}`,
  );
});

test("drift-guard: removing ci:config-validate from a fixture ci chain fails the assertion shape", () => {
  const fixtureCi = "npm run ci:core && node scripts/build.mjs --check";
  assert.ok(
    !fixtureCi.includes("ci:config-validate"),
    "fixture without ci:config-validate is the regression shape",
  );
  assert.ok(
    JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts.ci
      .includes("ci:config-validate"),
    "live package.json must not match the regression shape",
  );
});

test("gate fails when the live pipeline.yml omits a required harness role", () => {
  const dir = makeTmp();
  try {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, ".github"), { recursive: true });
    mkdirSync(join(dir, "core", "scripts"), { recursive: true });
    writeFileSync(join(dir, ".github", "pipeline.yml"), "base_branch: main\n");
    writeFileSync(
      join(dir, "core", "scripts", "pipeline.ts"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "config" && args[1] === "validate") {
  console.log('  ERROR [harnesses]: harnesses.implementer and harnesses.reviewer are required');
  console.log('pipeline config: invalid');
  process.exit(1);
}
process.exit(2);
`,
    );
    const result = runCiConfigValidate(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /harnesses\.implementer/);
  } finally {
    cleanup(dir);
  }
});

test("this repository's live .github/pipeline.yml passes in-tree config validate", () => {
  const result = spawnSync(NODE, [GUARD], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, CI_CONFIG_VALIDATE_ROOT: REPO_ROOT },
  });
  assert.equal(
    result.status,
    0,
    `live config validate failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});
