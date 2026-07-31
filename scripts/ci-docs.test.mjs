#!/usr/bin/env node
// Tests for scripts/ci-docs.mjs and CI checkout/docs wiring (#756).
// Run with: node --test scripts/ci-docs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
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
import {
  detectDocsGeneratorForCi,
  runCiDocs,
  scriptIsDocsFreshnessCheck,
  scriptInvokesDocsGenerator,
} from "./ci-docs.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const GUARD = join(REPO_ROOT, "scripts", "ci-docs.mjs");
const CI_YML = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const RELEASE_YML = join(REPO_ROOT, ".github", "workflows", "release.yml");
const AUTO_TAG_YML = join(
  REPO_ROOT,
  ".github",
  "workflows",
  "auto-tag-release.yml",
);

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "ci-docs-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function runGuard(cwd, env = {}) {
  return spawnSync(NODE, [GUARD], {
    cwd,
    env: { ...process.env, ...env },
    stdio: "pipe",
    encoding: "utf8",
  });
}

function writePkg(dir, scripts) {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts }, null, 2) + "\n",
  );
}

function writeGenerator(dir, body) {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "generate-docs.mjs"), body);
}

// ---------------------------------------------------------------------------
// 4.2 Drift-guard: the `ci` npm script must include the conditional docs step
// ---------------------------------------------------------------------------

test("ci npm script includes ci:docs step", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(
    pkg.scripts?.ci?.includes("ci:docs"),
    `package.json 'ci' script must include 'ci:docs'; got: ${pkg.scripts?.ci}`,
  );
  assert.ok(
    typeof pkg.scripts?.["ci:docs"] === "string",
    "package.json must define a 'ci:docs' script",
  );
  assert.match(
    pkg.scripts["ci:docs"],
    /ci-docs\.mjs/,
    `ci:docs must invoke scripts/ci-docs.mjs; got: ${pkg.scripts["ci:docs"]}`,
  );
});

test("drift-guard: removing ci:docs from a fixture ci chain fails the assertion shape", () => {
  // Proves the structural assertion would bite if ci dropped the docs entry.
  const fixtureCi = "npm run ci:core && node scripts/build.mjs --check";
  assert.ok(
    !fixtureCi.includes("ci:docs"),
    "fixture without ci:docs is the regression shape",
  );
  assert.ok(
    JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts.ci
      .includes("ci:docs"),
    "live package.json must not match the regression shape",
  );
});

// ---------------------------------------------------------------------------
// 4.1 Structural: CI checkout fetches full history + tags
// ---------------------------------------------------------------------------

/**
 * Extract the checkout step block that precedes the Full CI gate in ci.yml.
 * Minimal YAML-ish parse — no network, no yaml lib.
 * @param {string} src
 */
export function extractCiCheckoutBlock(src) {
  const lines = src.split("\n");
  // Prefer the checkout step associated with the Full CI gate job.
  const gateIdx = lines.findIndex((l) => /name:\s*Full CI gate/.test(l));
  const searchEnd = gateIdx === -1 ? lines.length : gateIdx;
  let checkoutIdx = -1;
  for (let i = 0; i < searchEnd; i++) {
    if (/uses:\s*actions\/checkout@/.test(lines[i])) {
      checkoutIdx = i;
    }
  }
  if (checkoutIdx === -1) {
    throw new Error("could not find actions/checkout step in ci.yml");
  }
  const block = [lines[checkoutIdx]];
  const baseIndent = (lines[checkoutIdx].match(/^\s*/)?.[0].length ?? 0);
  for (let i = checkoutIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      block.push(line);
      continue;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    // Next step at same or lesser indent ends the block.
    if (indent <= baseIndent && !/^\s*#/.test(line)) break;
    block.push(line);
  }
  // Include immediately preceding comment lines attached to the step.
  for (let i = checkoutIdx - 1; i >= 0; i--) {
    if (/^\s*#/.test(lines[i]) || lines[i].trim() === "") {
      block.unshift(lines[i]);
    } else {
      break;
    }
  }
  return block.join("\n");
}

test("ci.yml checkout sets fetch-depth: 0 and fetch-tags: true", () => {
  const src = readFileSync(CI_YML, "utf8");
  const block = extractCiCheckoutBlock(src);
  assert.match(block, /fetch-depth:\s*0/, `checkout must set fetch-depth: 0\n${block}`);
  assert.match(
    block,
    /fetch-tags:\s*true/,
    `checkout must set fetch-tags: true\n${block}`,
  );
  assert.match(
    block,
    /generator|tag|parity|history/i,
    "checkout step must document why full history/tags are required",
  );
});

test("structural: bare checkout without depth fails the assertion shape", () => {
  const bare = "- uses: actions/checkout@v4\n";
  assert.doesNotMatch(bare, /fetch-depth:\s*0/);
  // Live workflow must not be bare.
  const live = extractCiCheckoutBlock(readFileSync(CI_YML, "utf8"));
  assert.match(live, /fetch-depth:\s*0/);
});

test("release.yml and auto-tag-release.yml retain fetch-depth: 0", () => {
  for (const path of [RELEASE_YML, AUTO_TAG_YML]) {
    const src = readFileSync(path, "utf8");
    assert.match(
      src,
      /fetch-depth:\s*0/,
      `${path} must keep full-history checkout`,
    );
  }
});

// ---------------------------------------------------------------------------
// Pure detection helpers
// ---------------------------------------------------------------------------

test("scriptIsDocsFreshnessCheck: check-mode vs write-mode", () => {
  assert.equal(
    scriptIsDocsFreshnessCheck("node scripts/generate-docs.mjs --check"),
    true,
  );
  assert.equal(
    scriptIsDocsFreshnessCheck("node scripts/generate-docs.mjs"),
    false,
  );
  assert.equal(
    scriptIsDocsFreshnessCheck(
      "node scripts/generate-docs.mjs && echo --check",
    ),
    false,
  );
  assert.equal(scriptInvokesDocsGenerator("markdownlint docs/"), false);
});

test("detectDocsGeneratorForCi: absent → not present", () => {
  const tmp = makeTmp();
  try {
    writePkg(tmp, { test: "echo ok" });
    assert.deepEqual(detectDocsGeneratorForCi(tmp), { present: false });
  } finally {
    cleanup(tmp);
  }
});

test("detectDocsGeneratorForCi: generator file → check-mode command", () => {
  const tmp = makeTmp();
  try {
    writePkg(tmp, {});
    writeGenerator(tmp, "process.exit(0);\n");
    const surface = detectDocsGeneratorForCi(tmp);
    assert.equal(surface.present, true);
    if (surface.present) {
      assert.equal(surface.checkCommand, "node scripts/generate-docs.mjs --check");
    }
  } finally {
    cleanup(tmp);
  }
});

test("detectDocsGeneratorForCi: write-mode docs:check still uses --check", () => {
  const tmp = makeTmp();
  try {
    writePkg(tmp, {
      "docs:check": "node scripts/generate-docs.mjs",
    });
    writeGenerator(tmp, "process.exit(0);\n");
    const surface = detectDocsGeneratorForCi(tmp);
    assert.equal(surface.present, true);
    if (surface.present) {
      assert.equal(
        surface.checkCommand,
        "node scripts/generate-docs.mjs --check",
        "write-mode docs:check must not be used as the freshness check",
      );
    }
  } finally {
    cleanup(tmp);
  }
});

test("detectDocsGeneratorForCi: check-mode docs:check is preferred", () => {
  const tmp = makeTmp();
  try {
    writePkg(tmp, {
      "docs:check": "node scripts/generate-docs.mjs --check",
    });
    writeGenerator(tmp, "process.exit(0);\n");
    const surface = detectDocsGeneratorForCi(tmp);
    assert.equal(surface.present, true);
    if (surface.present) {
      assert.equal(surface.checkCommand, "npm run docs:check");
    }
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// 4.3 Behavior: no-op / check-mode / stale fails
// ---------------------------------------------------------------------------

test("exits 0 (no-op) when generator is absent", () => {
  const tmp = makeTmp();
  try {
    writePkg(tmp, { test: "echo ok" });
    const result = runGuard(tmp);
    assert.equal(
      result.status,
      0,
      `guard must exit 0 without generator; got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  } finally {
    cleanup(tmp);
  }
});

test("CI_DOCS_ROOT env var overrides root directory check", () => {
  const tmp = makeTmp();
  try {
    writePkg(tmp, {});
    const result = runGuard(REPO_ROOT, { CI_DOCS_ROOT: tmp });
    assert.equal(
      result.status,
      0,
      "guard must exit 0 when CI_DOCS_ROOT points at a generator-absent tree",
    );
  } finally {
    cleanup(tmp);
  }
});

test("generator present + green check → exit 0 and invokes --check", () => {
  const tmp = makeTmp();
  try {
    writePkg(tmp, {});
    // Generator records argv and exits 0 only when --check is present.
    writeGenerator(
      tmp,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const args = process.argv.slice(2);",
        "writeFileSync(join(process.cwd(), 'argv.txt'), args.join(' '));",
        "process.exit(args.includes('--check') ? 0 : 2);",
        "",
      ].join("\n"),
    );
    const result = runGuard(tmp);
    assert.equal(
      result.status,
      0,
      `expected exit 0; stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
    const argv = readFileSync(join(tmp, "argv.txt"), "utf8");
    assert.match(argv, /--check/, `generator must be invoked with --check; got: ${argv}`);
  } finally {
    cleanup(tmp);
  }
});

test("generator present + stale check → exit non-zero", () => {
  const tmp = makeTmp();
  try {
    writePkg(tmp, {});
    writeGenerator(
      tmp,
      [
        "if (process.argv.includes('--check')) {",
        "  console.error('generate-docs --check: stale generated docs:');",
        "  console.error('  - CHANGELOG.md');",
        "  process.exit(1);",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const result = runGuard(tmp);
    assert.notEqual(
      result.status,
      0,
      "stale docs check must fail the ci-docs step",
    );
  } finally {
    cleanup(tmp);
  }
});

test("write-mode docs:check is not used; still runs generate-docs --check", () => {
  const tmp = makeTmp();
  try {
    writePkg(tmp, {
      // Miswired: write-mode under the docs:check name.
      "docs:check": "node scripts/generate-docs.mjs",
    });
    writeGenerator(
      tmp,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const args = process.argv.slice(2);",
        "writeFileSync(join(process.cwd(), 'mode.txt'), args.includes('--check') ? 'check' : 'write');",
        "process.exit(args.includes('--check') ? 0 : 3);",
        "",
      ].join("\n"),
    );
    const result = runGuard(tmp);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(
      readFileSync(join(tmp, "mode.txt"), "utf8"),
      "check",
      "must invoke check-mode, not write-mode docs:check",
    );
  } finally {
    cleanup(tmp);
  }
});

test("runCiDocs with injectable spawn records the check command", () => {
  const tmp = makeTmp();
  try {
    writePkg(tmp, {});
    writeGenerator(tmp, "process.exit(0);\n");
    /** @type {string[]} */
    const calls = [];
    const status = runCiDocs({
      root: tmp,
      spawn: (cmd) => {
        calls.push(String(cmd));
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /generate-docs\.mjs --check/);
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// Live tree: generator currently absent on main-shaped branch → no-op
// ---------------------------------------------------------------------------

test("live repo without generate-docs.mjs: ci-docs exits 0", () => {
  const genPath = join(REPO_ROOT, "scripts", "generate-docs.mjs");
  // If the generator has landed, skip this shape-specific assertion.
  if (existsSync(genPath)) return;
  const result = runGuard(REPO_ROOT);
  assert.equal(
    result.status,
    0,
    `live generator-absent tree must no-op; stderr: ${result.stderr}`,
  );
});
