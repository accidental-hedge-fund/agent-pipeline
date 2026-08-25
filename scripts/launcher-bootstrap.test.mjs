#!/usr/bin/env node
// Layer B: actual launcher wiring for Node 18–23 bootstrap (#1236).
// Drives hosts/_shared/entry.template.mjs and scripts/pipeline-launcher.mjs
// (not only the helper). Injects process.versions.node via ESM --import.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(REPO_ROOT, "hosts", "_shared", "entry.template.mjs");
const LAUNCHER = join(REPO_ROOT, "scripts", "pipeline-launcher.mjs");
const ENSURE = join(REPO_ROOT, "scripts", "ensure-engines-node.mjs");
const PKG_VERSION = JSON.parse(
  readFileSync(join(REPO_ROOT, "core", "package.json"), "utf8"),
).version;
const PATCHED_VERSION = "22.23.2";

const LAUNCHERS = [
  { name: "entry.template.mjs", path: TEMPLATE },
  { name: "pipeline-launcher.mjs", path: LAUNCHER },
];

const FIXTURES = mkdtempSync(join(tmpdir(), "launcher-bootstrap-"));
const PATCH_FILE = join(FIXTURES, "patch-node-version.mjs");
writeFileSync(
  PATCH_FILE,
  `const v = process.env.AGENT_PIPELINE_TEST_NODE_VERSION || ${JSON.stringify(PATCHED_VERSION)};
try {
  Object.defineProperty(process.versions, "node", {
    value: v,
    configurable: true,
    enumerable: true,
  });
} catch {
  // ignore
}
`,
);

function patchSticks() {
  const r = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(PATCH_FILE).href, "-p", "process.versions.node"],
    {
      encoding: "utf8",
      env: { ...process.env, AGENT_PIPELINE_TEST_NODE_VERSION: PATCHED_VERSION },
    },
  );
  return r.status === 0 && String(r.stdout ?? "").trim() === PATCHED_VERSION;
}

const VERSION_PATCH_OK = patchSticks();
const PATCH_SKIP = VERSION_PATCH_OK
  ? false
  : "process.versions.node --import patch did not stick on this Node build";

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  env.AGENT_PIPELINE_TEST_NODE_VERSION =
    extra.AGENT_PIPELINE_TEST_NODE_VERSION ?? PATCHED_VERSION;
  return env;
}

function runPatched(scriptPath, args, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    ["--import", pathToFileURL(PATCH_FILE).href, scriptPath, ...args],
    {
      encoding: "utf8",
      env: childEnv(extraEnv),
      timeout: 20_000,
    },
  );
}

function writeFakeNode24(dir) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "node");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "-p" ]; then
  printf '%s\\n' "24.0.0"
  exit 0
fi
dir="$AGENT_PIPELINE_TEST_RECORD"
if [ -n "$dir" ]; then
  mkdir -p "$dir"
  printf '%s\\n' "$0" > "$dir/exec"
  printf '%s\\n' "$PATH" > "$dir/PATH"
  i=0
  for a in "$@"; do
    printf '%s\\n' "$a" > "$dir/arg.$i"
    i=$((i + 1))
  done
  printf '%s\\n' "$i" > "$dir/argc"
fi
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function stripFinalNewline(text) {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function readRecord(dir) {
  const argc = Number.parseInt(readFileSync(join(dir, "argc"), "utf8").trim(), 10);
  const argv = [];
  for (let i = 0; i < argc; i++) {
    argv.push(stripFinalNewline(readFileSync(join(dir, `arg.${i}`), "utf8")));
  }
  return {
    exec: stripFinalNewline(readFileSync(join(dir, "exec"), "utf8")),
    path: stripFinalNewline(readFileSync(join(dir, "PATH"), "utf8")),
    argv,
  };
}

// Child PATH for re-exec fixtures: keep the marker + invoking node dir first,
// but carry the parent PATH so the fake node's /bin/sh can resolve mkdir etc.
// A stripped PATH (marker + node dir only) breaks the fake's record write on
// runners whose node dir lacks shell utilities (CI toolcache, ~/.local/bin).
function reexecPath(marker = "") {
  const head = marker ? `${marker}${delimiter}` : "";
  return `${head}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
}

function writeCoreStub(root, version = PKG_VERSION) {
  const coreScripts = join(root, "core", "scripts");
  mkdirSync(coreScripts, { recursive: true });
  writeFileSync(
    join(root, "core", "package.json"),
    JSON.stringify({ name: "pipeline", version, type: "module" }),
  );
  writeFileSync(join(coreScripts, "pipeline.ts"), "// stub\n");
  writeFileSync(join(coreScripts, "path-cli.ts"), "// stub\n");
}

function copyLauncher(destDir, srcPath, { sibling } = {}) {
  const scriptsDir = join(destDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeCoreStub(destDir);
  const destName = srcPath === TEMPLATE ? "pipeline.mjs" : "pipeline-launcher.mjs";
  const dest = join(scriptsDir, destName);
  let src = readFileSync(srcPath, "utf8");
  if (srcPath === TEMPLATE) src = src.replaceAll("__PROFILE__", "test");
  writeFileSync(dest, src);
  if (sibling === "real") {
    writeFileSync(join(scriptsDir, "ensure-engines-node.mjs"), readFileSync(ENSURE, "utf8"));
  } else if (sibling === "throw") {
    writeFileSync(
      join(scriptsDir, "ensure-engines-node.mjs"),
      'throw new Error("resolver must not load for version introspection");\n',
    );
  } else if (sibling === "miss") {
    writeFileSync(
      join(scriptsDir, "ensure-engines-node.mjs"),
      `import { formatMissingEnginesNodeDiagnostic } from ${JSON.stringify(pathToFileURL(ENSURE).href)};
export function reexecOntoEnginesNode(opts = {}) {
  const msg = formatMissingEnginesNodeDiagnostic({
    invokingVersion: opts.execVersion ?? process.versions.node,
    floor: 24,
  });
  process.stderr.write(msg);
  return { action: "exit", status: 1 };
}
`,
    );
  }
  return dest;
}

test("source: both launchers have version-first wiring and no duplicated walker", () => {
  for (const launcher of LAUNCHERS) {
    const src = readFileSync(launcher.path, "utf8");
    const label = launcher.name;
    assert.doesNotMatch(
      src,
      /(?:^|\n)import\s+[^;\n]*ensure-engines-node/,
      `${label} must not static-import ensure-engines-node.mjs`,
    );
    const versionAt = src.indexOf('includes("--version")');
    const ensureAt = src.indexOf("ensure-engines-node");
    assert.ok(versionAt >= 0, `${label} must have version short-circuit`);
    assert.ok(ensureAt >= 0, `${label} must load ensure-engines-node after version`);
    assert.ok(
      versionAt < ensureAt,
      `${label} version short-circuit must appear before ensure-engines-node load`,
    );
    assert.equal(
      src.includes("nvm install 24"),
      false,
      `${label} must not tell the operator to nvm install 24`,
    );
    assert.equal(
      src.includes("import.meta.dirname"),
      false,
      `${label} must not use import.meta.dirname`,
    );
    assert.equal(
      src.includes("node-v24"),
      false,
      `${label} must not embed ~/.local/node-v24 walker`,
    );
    assert.doesNotMatch(
      src,
      /PATH\s*\.split|split\(\s*delimiter/,
      `${label} must not embed a PATH-split node walker`,
    );
  }
});

for (const launcher of LAUNCHERS) {
  for (const flag of ["--version", "-V"]) {
    test(`${launcher.name}: ${flag} on Node 22.23.2 prints package version`, { skip: PATCH_SKIP }, () => {
      const result = runPatched(launcher.path, [flag], { PATH: dirname(process.execPath) });
      assert.equal(result.status, 0, `${flag} stderr:\n${result.stderr}`);
      assert.equal(result.stdout.trim(), PKG_VERSION);
      assert.equal(
        result.stderr.includes("requires Node >= 24"),
        false,
        `${flag} stderr must not contain the engines gate: ${result.stderr}`,
      );
    });
  }

  test(`${launcher.name}: --version --json on Node 22.23.2 keeps commit_sha honest`, { skip: PATCH_SKIP }, () => {
    const emptyBin = join(FIXTURES, "no-git-bin");
    mkdirSync(emptyBin, { recursive: true });
    const result = runPatched(launcher.path, ["--version", "--json"], { PATH: emptyBin });
    assert.equal(result.status, 0, `--version --json stderr:\n${result.stderr}`);
    assert.equal(
      result.stderr.includes("requires Node >= 24"),
      false,
      `--version --json stderr must not contain the engines gate: ${result.stderr}`,
    );
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.version, PKG_VERSION);
    assert.ok("commit_sha" in parsed);
    assert.equal(parsed.commit_sha, null);
  });

  test(`${launcher.name}: status --version still short-circuits on Node 22`, { skip: PATCH_SKIP }, () => {
    const tmp = mkdtempSync(join(tmpdir(), "lb-mixed-ver-"));
    try {
      const dest = copyLauncher(tmp, launcher.path, { sibling: "throw" });
      const result = runPatched(dest, ["status", "--version"], { PATH: dirname(process.execPath) });
      assert.equal(result.status, 0, `status --version stderr:\n${result.stderr}`);
      assert.equal(result.stdout.trim(), PKG_VERSION);
      assert.equal(result.stderr.includes("requires Node >= 24"), false);
      assert.equal(
        result.stderr.includes("resolver must not load"),
        false,
        "--version must not load the resolver",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(`${launcher.name}: --version does not load the resolver`, { skip: PATCH_SKIP }, () => {
    const tmp = mkdtempSync(join(tmpdir(), "lb-ver-throw-"));
    try {
      const dest = copyLauncher(tmp, launcher.path, { sibling: "throw" });
      const result = runPatched(dest, ["--version"], { PATH: dirname(process.execPath) });
      assert.equal(result.status, 0, `--version with throwing sibling stderr:\n${result.stderr}`);
      assert.equal(result.stdout.trim(), PKG_VERSION);
      assert.equal(result.stderr.includes("resolver must not load"), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

for (const launcher of LAUNCHERS) {
  for (const userArgs of [["status"], ["train", "--milestone", "data-integrity"], ["path", "--json"]]) {
    const label = userArgs.join(" ");
    test(`${launcher.name}: ${label} on Node 22 re-execs fake Node 24 with argv preserved`, { skip: PATCH_SKIP }, () => {
      const tmp = mkdtempSync(join(tmpdir(), "lb-reexec-"));
      try {
        const fakeDir = join(tmp, "node24");
        const fake = writeFakeNode24(fakeDir);
        const recordDir = join(tmp, "record");
        const pathMarker = join(tmp, "keep-me-on-path");
        mkdirSync(pathMarker, { recursive: true });
        const result = runPatched(launcher.path, userArgs, {
          AGENT_PIPELINE_NODE: fake,
          AGENT_PIPELINE_TEST_RECORD: recordDir,
          PATH: reexecPath(pathMarker),
        });
        assert.equal(result.status, 0, `${label} stderr:\n${result.stderr}`);
        assert.equal(
          result.stderr.includes("requires Node >= 24"),
          false,
          `${label} must re-exec instead of exiting the gate: ${result.stderr}`,
        );
        const rec = readRecord(recordDir);
        assert.equal(rec.exec, fake);
        assert.equal(rec.argv[0], launcher.path);
        assert.deepEqual(rec.argv.slice(1), userArgs);
        assert.equal(rec.path.split(delimiter)[0], fakeDir);
        assert.ok(
          rec.path.split(delimiter).includes(pathMarker),
          `child PATH must keep parent remainder; got ${rec.path}`,
        );
        if (userArgs[0] === "path" && userArgs[1] === "--json") {
          assert.equal(
            result.stdout.trim(),
            "",
            "path --json on the Node 22 parent must not spawn path-cli.ts",
          );
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  test(`${launcher.name}: path --json on Node 22 is not version introspection`, { skip: PATCH_SKIP }, () => {
    const tmp = mkdtempSync(join(tmpdir(), "lb-path-json-"));
    try {
      const fakeDir = join(tmp, "node24");
      const fake = writeFakeNode24(fakeDir);
      const recordDir = join(tmp, "record");
      const result = runPatched(launcher.path, ["path", "--json"], {
        AGENT_PIPELINE_NODE: fake,
        AGENT_PIPELINE_TEST_RECORD: recordDir,
        PATH: reexecPath(),
      });
      assert.notEqual(result.stdout.trim(), PKG_VERSION);
      const rec = readRecord(recordDir);
      assert.deepEqual(rec.argv.slice(1), ["path", "--json"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(`${launcher.name}: status on Node 22 with no >=24 binary names AGENT_PIPELINE_NODE`, { skip: PATCH_SKIP }, () => {
    const tmp = mkdtempSync(join(tmpdir(), "lb-miss-"));
    try {
      const dest = copyLauncher(tmp, launcher.path, { sibling: "miss" });
      const result = runPatched(dest, ["status"], {
        PATH: join(tmp, "empty-bin"),
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /22\.23\.2/);
      assert.match(result.stderr, /AGENT_PIPELINE_NODE/);
      assert.match(result.stderr, /\/usr\/bin\/node/);
      assert.equal(result.stderr.includes("nvm install 24"), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("installed template with sibling resolver loads it for status", { skip: PATCH_SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "lb-installed-"));
  try {
    const dest = copyLauncher(tmp, TEMPLATE, { sibling: "real" });
    const fakeDir = join(tmp, "node24");
    const fake = writeFakeNode24(fakeDir);
    const recordDir = join(tmp, "record");
    const result = runPatched(dest, ["status"], {
      AGENT_PIPELINE_NODE: fake,
      AGENT_PIPELINE_TEST_RECORD: recordDir,
      PATH: reexecPath(),
    });
    assert.equal(result.status, 0, `installed status stderr:\n${result.stderr}`);
    const rec = readRecord(recordDir);
    assert.equal(rec.argv[0], dest);
    assert.deepEqual(rec.argv.slice(1), ["status"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("template --version without sibling does not fail module load", { skip: PATCH_SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "lb-nosib-"));
  try {
    const dest = copyLauncher(tmp, TEMPLATE, { sibling: false });
    const result = runPatched(dest, ["--version"], { PATH: dirname(process.execPath) });
    assert.equal(result.status, 0, `--version without sibling stderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), PKG_VERSION);
    assert.equal(result.stderr.includes("ERR_MODULE_NOT_FOUND"), false);
    assert.equal(result.stderr.includes("Cannot find module"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("repo template --version works from hosts/_shared path", { skip: PATCH_SKIP }, () => {
  const result = runPatched(TEMPLATE, ["--version"], { PATH: dirname(process.execPath) });
  assert.equal(result.status, 0, `repo template --version stderr:\n${result.stderr}`);
  assert.equal(result.stdout.trim(), PKG_VERSION);
});
