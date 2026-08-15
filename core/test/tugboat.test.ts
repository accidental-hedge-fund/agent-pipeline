// Tugboat (thin ship composer, #1001 / #927) decision helpers + structural guards.
// Lessons locked in: bare release version (no leading v), train complete gate,
// failure detail, promote --host all, gh checks bucket schema, PR reuse,
// serial multi-milestone, status no-side-effect, install-parity markers.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  contentDigest,
  evaluateOption1PackParity,
  missingTugboatThinMarkers,
  tugboatHasCriticalThinMarkers,
  tugboatHasForbiddenSecondBrainMarkers,
  type Option1PackBodies,
} from "../scripts/tugboat-install-parity.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const tugboat = path.join(repoRoot, "examples/supervisor/shell/tugboat.sh");
const releaseChecksGreen = path.join(
  repoRoot,
  "examples/supervisor/shell/release-checks-green.py",
);
const trainStatusComplete = path.join(
  repoRoot,
  "examples/supervisor/shell/train-status-complete.py",
);

function repoOption1Pack(): Option1PackBodies {
  return {
    tugboat: fs.readFileSync(tugboat, "utf8"),
    "release-checks-green.py": fs.readFileSync(releaseChecksGreen, "utf8"),
    "train-status-complete.py": fs.readFileSync(trainStatusComplete, "utf8"),
  };
}

function extractFailureDetail(
  runDir: string,
  logFile: string,
  phase: string,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-fd-"));
  try {
    const src = fs.readFileSync(tugboat, "utf8");
    const helpers: string[] = [];
    for (const name of ["train_stderr_reason", "failure_detail"]) {
      const m = src.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
      assert.ok(m, `${name}() not found in tugboat.sh`);
      helpers.push(m[0]);
    }
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        `RUN_DIR=${JSON.stringify(runDir)}`,
        `LOG_FILE=${JSON.stringify(logFile)}`,
        ...helpers,
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
  assert.match(body, /try_acquire_ship_lock/);
  // Live-ship probe (not bare playbook.pid + kill -0) gates second detach (#1062).
  assert.match(body, /live_ship_probe/);
  assert.match(body, /cmdline_is_live_ship/);
  assert.doesNotMatch(body, /\bship_already_running\b/);
  // Lock before playbook.pid write (no steal race).
  assert.match(body, /NEVER write playbook\.pid before winning the lock/);
  assert.match(body, /Do NOT write playbook\.pid here/);
  assert.match(body, /ignored duplicate detach|already running/);
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

test("tugboat failure_detail prefers loop-lock stderr over generic exit code", () => {
  const dir = makeRunDir();
  try {
    fs.writeFileSync(
      path.join(dir, "train.json.blocker"),
      "advance failed for #1010: pipeline single exited with code 1",
    );
    fs.writeFileSync(
      path.join(dir, "train.stderr"),
      '[train] #1010: advancing…\npipeline single: loop run "loop-abc" lock is held by codex pid 4163931 on agent-ubuntu-us-den-01 and is not verifiably dead (not_stale) — refusing takeover\n[train] STOP: advance failed for #1010: pipeline single exited with code 1\n',
    );
    const out = extractFailureDetail(dir, "", "train");
    assert.match(out, /lock is held/);
    assert.doesNotMatch(out, /^advance failed for #1010: pipeline single exited with code 1$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat failure_detail (#1074): preserves train blocker stop class + issue", () => {
  const dir = makeRunDir();
  try {
    fs.writeFileSync(
      path.join(dir, "train.json.blocker"),
      "held: #1010: advance failed for #1010: supervisor_no_progress",
    );
    const out = extractFailureDetail(dir, "", "train");
    assert.match(out, /supervisor_no_progress/);
    assert.match(out, /1010/);
    assert.doesNotMatch(out, /^train exit 1$/);
    assert.doesNotMatch(
      out,
      /^advance failed for #1010: pipeline (?:single|advance) exited with code 1$/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat failure_detail (#1074): exit-only train blocker is not rewritten into a class", () => {
  const dir = makeRunDir();
  try {
    fs.writeFileSync(
      path.join(dir, "train.json.blocker"),
      "advance failed for #42: pipeline advance exited with code 1",
    );
    const out = extractFailureDetail(dir, "", "train");
    assert.match(out, /exited with code 1/);
    assert.doesNotMatch(out, /supervisor_no_progress|dependency_deadlock|recovery_exhausted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  assert.match(statusBlock, /emit_status_json/);
  assert.match(statusBlock, /exit 0/);
  assert.doesNotMatch(statusBlock, /ship_one|train --milestone|release finish/);
  assert.doesNotMatch(statusBlock, /"\$PIPELINE" train|"\$PIPELINE" release/);
  // Status rewrites dead-pid "running" → stale via live-ship probe (#1062).
  assert.match(body, /emit_status_json\s*\(/);
  assert.match(body, /live-ship probe not live|status.*=.*"stale"/);
});

test("tugboat install-parity helper: repo pack passes; content/helpers fail closed", () => {
  const canon = repoOption1Pack();
  assert.equal(tugboatHasCriticalThinMarkers(canon.tugboat!), true);
  assert.equal(tugboatHasForbiddenSecondBrainMarkers(canon.tugboat!), false);
  assert.deepEqual(missingTugboatThinMarkers(canon.tugboat!), []);

  const pass = evaluateOption1PackParity(canon, canon, {
    pathLabel: "/tmp/tugboat",
  });
  assert.equal(pass.status, "pass");
  if (pass.status === "pass") {
    assert.match(pass.detail, /content digests|matches repo examples/i);
  }

  // Content diverge on promote default → fail (not marker-only).
  const noPromote: Option1PackBodies = {
    ...canon,
    tugboat: canon.tugboat!.replace(
      /ENGINE_PROMOTE_HOST:-all/g,
      "ENGINE_PROMOTE_HOST:-codex",
    ),
  };
  const failPromote = evaluateOption1PackParity(noPromote, canon, {
    pathLabel: "/tmp/tugboat",
  });
  assert.equal(failPromote.status, "fail");
  if (failPromote.status === "fail") {
    assert.match(failPromote.detail, /tugboat/);
    assert.match(failPromote.remediation, /install -m 0755|#927|#1001/);
  }

  // Null tugboat → skip (host does not use Option 1). Absence only.
  const skipped = evaluateOption1PackParity(
    {
      tugboat: null,
      "release-checks-green.py": null,
      "train-status-complete.py": null,
    },
    canon,
  );
  assert.equal(skipped.status, "skip");

  // Present but unrecognized / arbitrary local fork at the documented path
  // must fail closed — not skip — so doctor cannot silently bypass (#927 r1).
  const unrecognized: Option1PackBodies = {
    tugboat: "#!/usr/bin/env bash\n# older host ship wrapper\necho ship\n",
    "release-checks-green.py": canon["release-checks-green.py"],
    "train-status-complete.py": canon["train-status-complete.py"],
  };
  const failUnrecognized = evaluateOption1PackParity(unrecognized, canon, {
    pathLabel: "/tmp/home/.local/bin/tugboat",
  });
  assert.equal(failUnrecognized.status, "fail");
  if (failUnrecognized.status === "fail") {
    assert.match(failUnrecognized.detail, /diverges|content mismatch|tugboat/i);
    assert.match(failUnrecognized.remediation, /install -m 0755|tugboat\.sh|#927/);
  }

  // Forbidden second brain → fail.
  const secondBrain: Option1PackBodies = {
    ...canon,
    tugboat: canon.tugboat! + "\npipeline ship --milestone v1.0.0\n",
  };
  const failBrain = evaluateOption1PackParity(secondBrain, canon);
  assert.equal(failBrain.status, "fail");

  // #927 review 2: marker-complete body that changes active promote/CI path
  // must fail content parity (markers alone are not enough).
  const markerCompleteDivergent = [
    "#!/usr/bin/env bash",
    "# Tugboat — thin ship composer (Option 1, #1001).",
    'ENGINE_PROMOTE_HOST="${ENGINE_PROMOTE_HOST:-all}"',
    "failure_detail() { :; }",
    '# dead/commented: gh pr checks "$pr" --json name,state,bucket',
    'gh pr checks "$pr" --json name,state,bucket',
    '"kind": "tugboat_ship"',
    'pipeline engine-promote --for "$version" --host codex --skip-frg',
    "",
  ].join("\n");
  assert.equal(
    tugboatHasCriticalThinMarkers(markerCompleteDivergent),
    true,
    "fixture retains every recognizer marker",
  );
  assert.notEqual(
    contentDigest(markerCompleteDivergent),
    contentDigest(canon.tugboat!),
  );
  const failMarkersOnly: Option1PackBodies = {
    ...canon,
    tugboat: markerCompleteDivergent,
  };
  const failMarkerComplete = evaluateOption1PackParity(failMarkersOnly, canon, {
    pathLabel: "/tmp/tugboat",
  });
  assert.equal(failMarkerComplete.status, "fail");
  if (failMarkerComplete.status === "fail") {
    assert.match(failMarkerComplete.detail, /tugboat/);
  }

  // Divergent release-checks-green helper with matching tugboat → fail.
  const badGreen: Option1PackBodies = {
    ...canon,
    "release-checks-green.py":
      canon["release-checks-green.py"]! +
      "\n# local fork: always green\ndef classify(checks):\n    return 1\n",
  };
  const failGreen = evaluateOption1PackParity(badGreen, canon);
  assert.equal(failGreen.status, "fail");
  if (failGreen.status === "fail") {
    assert.match(failGreen.detail, /release-checks-green\.py/);
  }

  // Missing train-status-complete helper → fail.
  const missingTrain: Option1PackBodies = {
    ...canon,
    "train-status-complete.py": null,
  };
  const failTrain = evaluateOption1PackParity(missingTrain, canon);
  assert.equal(failTrain.status, "fail");
  if (failTrain.status === "fail") {
    assert.match(failTrain.detail, /train-status-complete\.py \(missing\)/);
  }
});

// ---------- #1062 live-ship probe + REPO_DIR refuse --------------------------

/** Extract pure cmdline_is_live_ship() from tugboat and evaluate one cmdline. */
function evalCmdlineIsLiveShip(cmdline: string, version: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-probe-"));
  try {
    const src = fs.readFileSync(tugboat, "utf8");
    const m = src.match(/^cmdline_is_live_ship\(\) \{[\s\S]*?\n\}/m);
    assert.ok(m, "cmdline_is_live_ship() not found in tugboat.sh");
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        m[0],
        `if cmdline_is_live_ship ${JSON.stringify(cmdline)} ${JSON.stringify(version)}; then echo LIVE; else echo NOT_LIVE; fi`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(r.status, 0, `probe runner exited ${r.status}: ${r.stderr}`);
    return r.stdout.trim() === "LIVE";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("live-ship probe (#1062): train --merge cmdline is live; bare pid / single / status are not", () => {
  // Live: detached train ship for the milestone.
  assert.equal(
    evalCmdlineIsLiveShip(
      "/home/u/.local/bin/pipeline train --milestone v1.39.0 --merge --json",
      "1.39.0",
    ),
    true,
    "train --merge for milestone must be live",
  );
  assert.equal(
    evalCmdlineIsLiveShip(
      "node pipeline.mjs train --milestone v1.39.0 --merge",
      "1.39.0",
    ),
    true,
  );
  // Live: owning tugboat composer (no --status / --detach).
  assert.equal(
    evalCmdlineIsLiveShip(
      "/home/u/.local/bin/tugboat --milestone v1.39.0",
      "1.39.0",
    ),
    true,
    "owning tugboat must be live",
  );
  assert.equal(
    evalCmdlineIsLiveShip(
      "bash /path/tugboat.sh --milestones v1.39.0 v1.40.0",
      "1.39.0",
    ),
    true,
  );

  // NOT live: status / detach wrappers.
  assert.equal(
    evalCmdlineIsLiveShip(
      "/home/u/.local/bin/tugboat --milestone v1.39.0 --status",
      "1.39.0",
    ),
    false,
    "--status must not look like a live ship",
  );
  assert.equal(
    evalCmdlineIsLiveShip(
      "/home/u/.local/bin/tugboat --milestone v1.39.0 --detach",
      "1.39.0",
    ),
    false,
  );

  // NOT live: bare sleep / recycled pid that happens to be alive (playbook.pid case).
  assert.equal(
    evalCmdlineIsLiveShip("/bin/sleep 3600", "1.39.0"),
    false,
    "bare kill -0 pid without train/tugboat cmdline is not live",
  );
  assert.equal(
    evalCmdlineIsLiveShip("bash -c 'while true; do :; done'", "1.39.0"),
    false,
  );

  // NOT live: per-issue pipeline N / pipeline single N lock holders.
  assert.equal(
    evalCmdlineIsLiveShip(
      "/home/u/.local/bin/pipeline single 702",
      "1.39.0",
    ),
    false,
    "pipeline single N is not a live ship",
  );
  assert.equal(
    evalCmdlineIsLiveShip("/home/u/.local/bin/pipeline 702", "1.39.0"),
    false,
  );
  assert.equal(
    evalCmdlineIsLiveShip(
      "node pipeline.mjs advance 702 --json",
      "1.39.0",
    ),
    false,
  );

  // NOT live: train for a different milestone, or train without --merge.
  assert.equal(
    evalCmdlineIsLiveShip(
      "pipeline train --milestone v1.38.0 --merge --json",
      "1.39.0",
    ),
    false,
    "other milestone train is not live for this ship",
  );
  assert.equal(
    evalCmdlineIsLiveShip(
      "pipeline train --milestone v1.39.0 --json",
      "1.39.0",
    ),
    false,
    "train without --merge is not Option 1 live ship",
  );
});

test("ship lock (#1062): stale lock pid for other-milestone train is reclaimed", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  // Mutex must gate on cmdline_is_live_ship for the requested version (not any train --merge).
  const lockFn = body.match(/^try_acquire_ship_lock\(\) \{[\s\S]*?\n\}/m);
  assert.ok(lockFn, "try_acquire_ship_lock missing");
  assert.match(lockFn[0], /cmdline_is_live_ship "\$holder_cmd" "\$version"/);
  assert.match(lockFn[0], /local version=\$2/);
  // Loose any-tugboat / any-train--merge check must not remain as the retain gate.
  assert.doesNotMatch(
    lockFn[0],
    /\[\[\s*"\$holder_cmd"\s*==\s*\*tugboat\*\s*\]\]\s*\|\|/,
  );
  assert.match(body, /try_acquire_ship_lock "\$RUN_DIR" "\$version"/);

  // Behavioral: lock/pid for ship-v1.39.0 points at a live train --merge for v1.40.0.
  // try_acquire for 1.39.0 must reclaim (not refuse as if it owns 1.39.0).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-lock-"));
  const fakeBin = path.join(dir, "pipeline");
  let childPid: number | undefined;
  try {
    fs.writeFileSync(
      fakeBin,
      "#!/usr/bin/env bash\n# stub train holder for lock reclaim regression\nsleep 3600\n",
    );
    fs.chmodSync(fakeBin, 0o755);
    // Detached so the stub survives after spawn returns; argv must look like train --merge v1.40.0.
    const child = spawn(
      fakeBin,
      ["train", "--milestone", "v1.40.0", "--merge", "--json"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    childPid = child.pid;
    assert.ok(
      childPid !== undefined && Number.isFinite(childPid) && childPid > 0,
      `bad stub pid: ${String(childPid)}`,
    );

    // Confirm /proc cmdline is the other-milestone train (so the old loose check would refuse).
    const cmdline = fs
      .readFileSync(`/proc/${childPid}/cmdline`)
      .toString("utf8")
      .replace(/\0/g, " ");
    assert.match(cmdline, /train/);
    assert.match(cmdline, /--merge/);
    assert.match(cmdline, /v1\.40\.0/);
    assert.equal(
      evalCmdlineIsLiveShip(cmdline, "1.39.0"),
      false,
      "v1.40 train must not be live ship for 1.39.0",
    );
    assert.equal(
      evalCmdlineIsLiveShip(cmdline, "1.40.0"),
      true,
      "v1.40 train must be live ship for 1.40.0",
    );

    const runDir = path.join(dir, "ship-v1.39.0");
    const lockDir = path.join(runDir, "lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "pid"), `${childPid}\n`);

    const src = fs.readFileSync(tugboat, "utf8");
    const probeFn = src.match(/^cmdline_is_live_ship\(\) \{[\s\S]*?\n\}/m);
    assert.ok(probeFn, "cmdline_is_live_ship missing");
    const runner = path.join(dir, "acquire.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        probeFn[0],
        lockFn[0],
        `if out=$(try_acquire_ship_lock ${JSON.stringify(runDir)} "1.39.0"); then`,
        '  echo "ACQUIRED:$$"',
        "  exit 0",
        "else",
        '  echo "REFUSED:$out"',
        "  exit 1",
        "fi",
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(
      r.status,
      0,
      `expected reclaim of wrong-milestone lock, got status=${r.status} out=${r.stdout} err=${r.stderr}`,
    );
    assert.match(r.stdout, /^ACQUIRED:/);
    // Lock now held by the acquirer, not the v1.40 train pid.
    const newHolder = fs.readFileSync(path.join(lockDir, "pid"), "utf8").trim();
    assert.notEqual(newHolder, String(childPid));
    assert.match(r.stdout, new RegExp(`ACQUIRED:${newHolder}`));
  } finally {
    if (childPid !== undefined) {
      try {
        process.kill(-childPid, "SIGTERM");
      } catch {
        try {
          process.kill(childPid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("live-ship probe (#1062): detach path uses probe only; not bare playbook.pid", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  // Detach refuse must call live_ship_probe — not ship_already_running / bare kill -0 on pid file.
  const detachFn = body.match(/detach_self\(\) \{[\s\S]*?\n\}/);
  assert.ok(detachFn, "detach_self missing");
  assert.match(detachFn[0], /live_ship_probe/);
  assert.match(detachFn[0], /emit_status_json/);
  // Executable refuse path must not use the old helpers (comments may mention them).
  assert.doesNotMatch(detachFn[0], /\bship_already_running\b/);
  assert.doesNotMatch(
    detachFn[0],
    /^\s*[^#\n]*kill -0 "\$\{?holder\}?"/m,
  );
  assert.doesNotMatch(
    detachFn[0],
    /^\s*[^#\n]*playbook\.pid/m,
  );
  // Documented class law in source (regression if someone restores pid-only refuse).
  assert.match(body, /Bare playbook\.pid \+ kill -0/);
  assert.match(body, /per-issue pipeline N locks/);
  assert.match(body, /no paste detector/i);
});

test("tugboat REPO_DIR (#1062): pin at start; refuse factory-control", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  assert.match(body, /pin_repo_dir/);
  assert.match(body, /\*factory-control\*/);
  assert.match(body, /REPO_DIR refused|refused — path matches \*factory-control\*/);
  assert.match(body, /pwd -P/);
  // pin is invoked before status/detach/ship (process start).
  const pinDef = body.indexOf("pin_repo_dir() {");
  const pinCall = body.indexOf("pin_repo_dir\n");
  const statusIdx = body.indexOf('if [[ "$do_status" == "1" ]]; then');
  assert.ok(pinDef >= 0 && pinCall > pinDef);
  assert.ok(pinCall < statusIdx, "pin_repo_dir must run before status/detach");

  // Behavioral: factory-control path fails closed without detaching.
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "factory-control-"));
  try {
    // Ensure path contains the refused segment.
    const refuseDir = path.join(badRoot, "agent-pipeline-factory-control");
    fs.mkdirSync(refuseDir, { recursive: true });
    const r = spawnSync(
      "bash",
      [tugboat, "--milestone", "v1.39.0", "--detach"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          REPO_DIR: refuseDir,
          ALLOW_MERGE: "1",
          SHIP_NOTIFY: "0",
          PIPELINE_SUPERVISOR_STATE: path.join(badRoot, "state"),
        },
      },
    );
    assert.notEqual(r.status, 0, "factory-control REPO_DIR must fail closed");
    assert.match(
      `${r.stdout}\n${r.stderr}`,
      /factory-control|refused/i,
      "error must name the refused plane",
    );
    assert.doesNotMatch(
      `${r.stdout}\n${r.stderr}`,
      /detached tugboat ship/,
      "must not detach when REPO_DIR is factory-control",
    );
  } finally {
    fs.rmSync(badRoot, { recursive: true, force: true });
  }
});

test("hermes env.example (#1062): REPO_DIR does not default to factory-control", () => {
  const envExample = path.join(
    repoRoot,
    "examples/supervisor/hermes/env.example",
  );
  const body = fs.readFileSync(envExample, "utf8");
  const repoLine = body
    .split("\n")
    .find((l) => /^\s*REPO_DIR=/.test(l) && !l.trim().startsWith("#"));
  assert.ok(repoLine, "REPO_DIR assignment required in env.example");
  assert.doesNotMatch(
    repoLine,
    /factory-control/,
    "env.example must not default REPO_DIR to *factory-control*",
  );
});

test("tugboat status (#1062): dead pid / stale running → not running", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-status-"));
  const runDir = path.join(stateRoot, "ship-v9.9.9");
  fs.mkdirSync(runDir, { recursive: true });
  // Stale "running" state with a dead pid — no live train/tugboat for v9.9.9.
  fs.writeFileSync(
    path.join(runDir, "state.json"),
    JSON.stringify({
      schema_version: 1,
      kind: "tugboat_ship",
      milestone: "v9.9.9",
      version: "9.9.9",
      phase: "train",
      status: "running",
      detail: "pipeline train --milestone v9.9.9 --merge --json",
      updated_at: "2020-01-01T00:00:00Z",
      log: path.join(runDir, "playbook.log"),
      pid: 1, // init/special; cmdline will not match train --merge for v9.9.9
    }),
  );
  fs.writeFileSync(path.join(runDir, "playbook.pid"), "1\n");
  try {
    const r = spawnSync(
      "bash",
      [tugboat, "--milestone", "v9.9.9", "--status"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PIPELINE_SUPERVISOR_STATE: stateRoot,
          SHIP_NOTIFY: "0",
          // Unset REPO_DIR so pin does not require a real checkout for status.
          REPO_DIR: "",
        },
      },
    );
    assert.equal(r.status, 0, `status exited ${r.status}: ${r.stderr}`);
    const out = r.stdout.trim();
    assert.doesNotMatch(
      out,
      /"status"\s*:\s*"running"/,
      "status must not claim running from dead/stale state alone",
    );
    assert.match(out, /"status"\s*:\s*"(stale|none|failed|ok)"/);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
