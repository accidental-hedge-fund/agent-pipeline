// Tugboat (thin ship composer, #1001 / #927) decision helpers + structural guards.
// Lessons locked in: bare release version (no leading v), train complete gate,
// failure detail, promote --host all, gh checks bucket schema, PR reuse,
// serial multi-milestone, status no-side-effect, install-parity markers.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  evaluateInstalledTugboatParity,
  missingTugboatThinMarkers,
  tugboatHasCriticalThinMarkers,
  tugboatHasForbiddenSecondBrainMarkers,
} from "../scripts/tugboat-install-parity.ts";

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
  // Resume must not re-fail the complete gate on a failed capture file.
  assert.match(body, /train_resumed/);
  assert.match(body, /cd "\$REPO_DIR"/);
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
  // Serial: one ship_one per milestone in order; promote lives inside ship_one.
  assert.match(
    body,
    /for version in "\$\{milestones\[@\]\}"; do\s*\n\s*ship_one "\$version"/,
  );
  const shipOneStart = body.indexOf("ship_one() {");
  const shipOneEnd = body.indexOf("\n# ---------- run serial multi-milestone");
  assert.ok(shipOneStart >= 0 && shipOneEnd > shipOneStart);
  const shipOneBody = body.slice(shipOneStart, shipOneEnd);
  assert.match(shipOneBody, /engine-promote --for "\$version"/);
  // No parallel fan-out of milestones (ignore prose comments about "ship brain").
  assert.doesNotMatch(body, /xargs\s+-P/);
  assert.doesNotMatch(body, /&\s*ship_one\b/);
  assert.doesNotMatch(body, /\bGNU\s+parallel\b|\bparallel\s+--/);
});

test("tugboat version rules: train v-prefix, release bare, promote bare, gh release v-prefix", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  assert.match(body, /train --milestone "v\$version"/);
  assert.match(body, /release "\$version"/);
  assert.match(body, /engine-promote --for "\$version"/);
  assert.match(body, /gh release view "v\$version"/);
});

test("tugboat reuses existing open release PR (idempotent prepare)", () => {
  // Without find_open_release_pr + reuse branch, a second ship of the same
  // version would fail closed even when the release PR is already open.
  const body = fs.readFileSync(tugboat, "utf8");
  assert.match(body, /find_open_release_pr\(\)/);
  assert.match(body, /release: \{version\}|release: v\{version\}|startswith\(f"release: /);
  assert.match(body, /existing open release PR #\$pr reused \(idempotent\)/);
  assert.match(body, /could not determine release PR number/);
});

test("tugboat --status reads state without starting ship phases", () => {
  // Status must exit before train/release/promote; regression if someone
  // reorders the status branch after ship_one.
  const body = fs.readFileSync(tugboat, "utf8");
  const statusIdx = body.indexOf('if [[ "$do_status" == "1" ]]; then');
  const detachIdx = body.indexOf('if [[ "$do_detach" == "1" ]]; then');
  const trainIdx = body.indexOf('write_state "train" "running"');
  assert.ok(statusIdx >= 0, "status branch missing");
  assert.ok(detachIdx > statusIdx, "status must appear before detach");
  assert.ok(trainIdx > detachIdx, "status/detach must appear before train phase");
  // Only the status if-block — not the later ship_one definition.
  const statusBlock = body.slice(statusIdx, detachIdx);
  assert.match(statusBlock, /cat "\$STATE_FILE"/);
  assert.match(statusBlock, /exit 0/);
  assert.doesNotMatch(statusBlock, /ship_one|train --milestone|release finish/);
  assert.doesNotMatch(statusBlock, /"\$PIPELINE" train|"\$PIPELINE" release/);
});

test("tugboat install-parity helper: repo source passes; stripped source fails", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  assert.equal(tugboatHasCriticalThinMarkers(body), true);
  assert.equal(tugboatHasForbiddenSecondBrainMarkers(body), false);
  assert.deepEqual(missingTugboatThinMarkers(body), []);
  const pass = evaluateInstalledTugboatParity(body, {
    pathLabel: "/tmp/tugboat",
  });
  assert.equal(pass.status, "pass");

  // Prove each marker is required: drop promote default → fail.
  const noPromote = body.replace(/ENGINE_PROMOTE_HOST:-all/g, "ENGINE_PROMOTE_HOST:-codex");
  const failPromote = evaluateInstalledTugboatParity(noPromote, {
    pathLabel: "/tmp/tugboat",
  });
  assert.equal(failPromote.status, "fail");
  if (failPromote.status === "fail") {
    assert.match(failPromote.detail, /promote_all_default/);
    assert.match(failPromote.remediation, /install -m 0755|#927|#1001/);
  }

  // Null → skip (host does not use Option 1).
  const skipped = evaluateInstalledTugboatParity(null);
  assert.equal(skipped.status, "skip");

  // Forbidden second brain → fail even if other markers present.
  const secondBrain = body + "\npipeline ship --milestone v1.0.0\n";
  const failBrain = evaluateInstalledTugboatParity(secondBrain);
  assert.equal(failBrain.status, "fail");
});
