#!/usr/bin/env node
// Regression tests for scripts/run-scripts-tests.mjs (#681).
//
// Guards the structural fix for the Node multi-file test-runner IPC deserialize
// flake: `ci:scripts` must not use the abandoned single-parent form
// `node --test scripts/*.test.mjs`.

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
import {
  childTestEnv,
  listScriptsTestFiles,
  runScriptsTests,
} from "./run-scripts-tests.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const WRAPPER = join(REPO_ROOT, "scripts", "run-scripts-tests.mjs");
const ABANDONED_MULTI_FILE = "node --test scripts/*.test.mjs";

function readPkgScripts() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  return pkg.scripts ?? {};
}

// ---------------------------------------------------------------------------
// package.json wiring — structural entry point, not abandoned multi-file form
// ---------------------------------------------------------------------------

test("ci:scripts is wired to the per-file structural wrapper", () => {
  const scripts = readPkgScripts();
  const ciScripts = scripts["ci:scripts"];
  assert.equal(typeof ciScripts, "string", "package.json must define ci:scripts");
  assert.match(
    ciScripts,
    /run-scripts-tests\.mjs/,
    `ci:scripts must invoke run-scripts-tests.mjs; got: ${ciScripts}`,
  );
  assert.notEqual(
    ciScripts.trim(),
    ABANDONED_MULTI_FILE,
    "ci:scripts must not use the abandoned multi-file IPC form",
  );
  assert.ok(
    !/^node\s+--test\s+scripts\/\*\.test\.mjs\s*$/.test(ciScripts.trim()),
    `ci:scripts must not be bare multi-file node --test; got: ${ciScripts}`,
  );
});

test("npm test scripts half uses the same structural wrapper (local/CI parity)", () => {
  const scripts = readPkgScripts();
  const testScript = scripts.test;
  assert.equal(typeof testScript, "string", "package.json must define test");
  assert.match(
    testScript,
    /run-scripts-tests\.mjs/,
    `npm test must invoke run-scripts-tests.mjs for scripts tests; got: ${testScript}`,
  );
  assert.ok(
    !testScript.includes(ABANDONED_MULTI_FILE),
    `npm test must not use abandoned multi-file form; got: ${testScript}`,
  );
});

test("ci gate still includes ci:scripts (scripts suite not dropped)", () => {
  const scripts = readPkgScripts();
  assert.ok(
    scripts.ci?.includes("ci:scripts"),
    `package.json 'ci' must include ci:scripts; got: ${scripts.ci}`,
  );
});

test("ci:scripts is not a no-op", () => {
  const scripts = readPkgScripts();
  const ciScripts = scripts["ci:scripts"] ?? "";
  assert.ok(ciScripts.length > 0, "ci:scripts must not be empty");
  assert.ok(
    !/^(true|echo|:)\b/.test(ciScripts.trim()),
    `ci:scripts must not be a no-op; got: ${ciScripts}`,
  );
});

// ---------------------------------------------------------------------------
// wrapper behavior — discovery + one process per file + exit aggregation
// ---------------------------------------------------------------------------

test("listScriptsTestFiles discovers install.test.mjs (sorted, deterministic)", () => {
  const scriptsDir = join(REPO_ROOT, "scripts");
  const files = listScriptsTestFiles(scriptsDir);
  const basenames = files.map((f) => f.split("/").pop());
  assert.ok(
    basenames.includes("install.test.mjs"),
    `suite must include install.test.mjs; got: ${basenames.join(", ")}`,
  );
  assert.ok(
    basenames.includes("run-scripts-tests.test.mjs"),
    "suite must include this regression file",
  );
  // Sorted by basename
  const sorted = [...basenames].sort();
  assert.deepEqual(basenames, sorted, "test files must be listed in sorted order");
  // Absolute paths under scripts/
  for (const f of files) {
    assert.ok(f.startsWith(scriptsDir), `expected under scriptsDir: ${f}`);
    assert.ok(f.endsWith(".test.mjs"), `expected *.test.mjs: ${f}`);
  }
});

test("runScriptsTests spawns one top-level node --test process per file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "run-scripts-tests-"));
  try {
    writeFileSync(join(tmp, "a.test.mjs"), "import { test } from 'node:test';\ntest('a', () => {});\n");
    writeFileSync(join(tmp, "b.test.mjs"), "import { test } from 'node:test';\ntest('b', () => {});\n");
    writeFileSync(join(tmp, "not-a-test.mjs"), "// ignored\n");

    /** @type {Array<{ cmd: string, args: string[], opts: object }>} */
    const calls = [];
    const fakeSpawn = (cmd, args, opts) => {
      calls.push({ cmd, args: [...args], opts });
      return { status: 0 };
    };

    const code = runScriptsTests({
      scriptsDir: tmp,
      nodePath: NODE,
      spawn: fakeSpawn,
      stdio: "pipe",
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: "child-v8",
        NODE_TEST_WORKER_ID: "9",
      },
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 2, "exactly one spawn per *.test.mjs file");
    for (const call of calls) {
      assert.equal(call.cmd, NODE);
      assert.equal(call.args[0], "--test");
      assert.equal(call.args.length, 2, "one file only — not multi-file parent aggregation");
      assert.ok(call.args[1].endsWith(".test.mjs"));
      assert.equal(
        call.opts.env?.NODE_TEST_CONTEXT,
        undefined,
        "child env must not inherit NODE_TEST_CONTEXT (avoids recursive skip)",
      );
      assert.equal(call.opts.env?.NODE_TEST_WORKER_ID, undefined);
    }
    // Sorted order: a then b
    assert.ok(calls[0].args[1].endsWith("a.test.mjs"));
    assert.ok(calls[1].args[1].endsWith("b.test.mjs"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("childTestEnv strips parent test-runner context", () => {
  const cleaned = childTestEnv({
    PATH: "/usr/bin",
    NODE_TEST_CONTEXT: "child-v8",
    NODE_TEST_WORKER_ID: "1",
    KEEP: "yes",
  });
  assert.equal(cleaned.NODE_TEST_CONTEXT, undefined);
  assert.equal(cleaned.NODE_TEST_WORKER_ID, undefined);
  assert.equal(cleaned.KEEP, "yes");
  assert.equal(cleaned.PATH, "/usr/bin");
});

test("runScriptsTests returns non-zero when any file's process fails", () => {
  const tmp = mkdtempSync(join(tmpdir(), "run-scripts-tests-fail-"));
  try {
    writeFileSync(join(tmp, "ok.test.mjs"), "import { test } from 'node:test';\ntest('ok', () => {});\n");
    writeFileSync(join(tmp, "bad.test.mjs"), "import { test } from 'node:test';\ntest('bad', () => {});\n");

    let n = 0;
    const fakeSpawn = (_cmd, args) => {
      n += 1;
      // Fail the second file
      const file = args[1] ?? "";
      return { status: file.endsWith("ok.test.mjs") ? 0 : 1 };
    };

    const code = runScriptsTests({
      scriptsDir: tmp,
      spawn: fakeSpawn,
      stdio: "pipe",
    });
    assert.equal(code, 1, "must fail the suite when any child exits non-zero");
    assert.equal(n, 2, "must still attempt both files (no silent skip)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("product assertion failure in a scripts test fails the wrapper with runner output", () => {
  const tmp = mkdtempSync(join(tmpdir(), "run-scripts-tests-assert-"));
  try {
    const failing = join(tmp, "failing.test.mjs");
    writeFileSync(
      failing,
      [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('deliberate product assertion failure', () => {",
        "  assert.equal(1, 2, 'expected inequality for regression smoke');",
        "});",
        "",
      ].join("\n"),
    );

    const result = spawnSync(NODE, [WRAPPER], {
      cwd: REPO_ROOT,
      // childTestEnv: if this regression itself runs under node --test process
      // isolation, do not leak NODE_TEST_CONTEXT into the wrapper (and its
      // nested node --test children).
      env: { ...childTestEnv(process.env), RUN_SCRIPTS_TESTS_DIR: tmp },
      encoding: "utf8",
      stdio: "pipe",
    });
    assert.notEqual(
      result.status,
      0,
      `wrapper must exit non-zero on product assertion failure; status=${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.match(
      out,
      /deliberate product assertion failure|expected inequality for regression smoke|AssertionError/i,
      `output must identify the failing test, not only an IPC host error; got:\n${out}`,
    );
    assert.ok(
      !/Unable to deserialize cloned data/i.test(out),
      "must not surface the multi-file IPC deserialize host error for a single-file failure",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("wrapper exits 1 when scripts dir has no test files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "run-scripts-tests-empty-"));
  try {
    mkdirSync(join(tmp, "nested"), { recursive: true });
    const result = spawnSync(NODE, [WRAPPER], {
      cwd: REPO_ROOT,
      env: { ...process.env, RUN_SCRIPTS_TESTS_DIR: tmp },
      encoding: "utf8",
      stdio: "pipe",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr ?? "",
      /no \*\.test\.mjs|no \*\.test\.mjs files/i,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
