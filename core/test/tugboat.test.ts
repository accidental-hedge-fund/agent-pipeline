// Tugboat (thin ship composer, #1001) decision helpers + structural guards.
// Lessons locked in: bare release version (no leading v), train complete gate,
// failure detail, promote --host all, gh checks bucket schema.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const tugboat = path.join(repoRoot, "examples/supervisor/shell/tugboat.sh");

function extractFailureDetail(
  runDir: string,
  logFile: string,
  phase: string,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-fd-"));
  try {
    const src = fs.readFileSync(tugboat, "utf8");
    const m = src.match(/^failure_detail\(\) \{[\s\S]*?\n\}/m);
    assert.ok(m, "failure_detail() not found in tugboat.sh");
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        `RUN_DIR=${JSON.stringify(runDir)}`,
        `LOG_FILE=${JSON.stringify(logFile)}`,
        m[0],
        `printf '%s' "$(failure_detail '${phase}')"`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(r.status, 0, `runner exited ${r.status}: ${r.stderr}`);
    return r.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-fd-run-"));
}

test("tugboat failure_detail train: reads blocker sidecar", () => {
  const dir = makeRunDir();
  try {
    fs.writeFileSync(
      path.join(dir, "train.json.blocker"),
      "advance failed for #838: dependency deadlock (838 waiting_on 822)",
    );
    const out = extractFailureDetail(dir, "", "train");
    assert.match(out, /dependency deadlock/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat failure_detail release-finish: surfaces pending checks line", () => {
  const dir = makeRunDir();
  try {
    fs.writeFileSync(
      path.join(dir, "release-finish.err"),
      "pipeline release finish: No required checks configured, but observable checks are not green:\n  - test (pending)\n",
    );
    const out = extractFailureDetail(dir, "", "release-finish");
    assert.match(out, /observable checks are not green/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat failure_detail: empty when no capture", () => {
  const dir = makeRunDir();
  try {
    assert.equal(
      extractFailureDetail(dir, path.join(dir, "nope.log"), "engine-promote"),
      "",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat is thin: no second ship brain / grant factory markers", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  assert.match(body, /Tugboat — thin ship composer/);
  assert.doesNotMatch(body, /grant[\/_]factory|factory\.mjs/);
  assert.doesNotMatch(body, /pipeline ship /);
  assert.match(body, /engine-promote/);
  assert.match(body, /ENGINE_PROMOTE_HOST:-all/);
});

test("tugboat release uses bare X.Y.Z (leading v is invalid to pipeline release)", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  // Must call release with bare $version, never v$version
  assert.match(body, /"\$PIPELINE" release "\$version"/);
  assert.doesNotMatch(body, /"\$PIPELINE" release "v\$version"/);
  assert.doesNotMatch(body, /"\$PIPELINE" release "v\$milestone"/);
  assert.match(body, /leading v is INVALID/);
});

test("tugboat train always gates on train-status-complete (not only exit code)", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  assert.match(body, /TRAIN_STATUS_COMPLETE_BIN/);
  assert.match(body, /train JSON not complete/);
  assert.match(body, /has no open issues/);
  assert.match(body, /train\.complete\.json/);
});

test("tugboat CI-wait uses valid gh pr checks fields (bucket, not conclusion)", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  const m = body.match(/gh pr checks "\$pr" --json ([a-z,]+)/);
  assert.ok(m, "CI-wait gh pr checks line not found");
  assert.doesNotMatch(m[1], /conclusion/);
  assert.match(m[1], /\bbucket\b/);
});

test("tugboat supports serial multi-milestone and single-host lock", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  assert.match(body, /--milestones/);
  assert.match(body, /ship_one/);
  assert.match(body, /lock_dir/);
});

test("tugboat version rules: train v-prefix, release bare, promote bare, gh release v-prefix", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  assert.match(body, /train --milestone "v\$version"/);
  assert.match(body, /release "\$version"/);
  assert.match(body, /engine-promote --for "\$version"/);
  assert.match(body, /gh release view "v\$version"/);
});
