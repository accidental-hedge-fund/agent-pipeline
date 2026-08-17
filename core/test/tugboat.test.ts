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
  assert.match(body, /factory-release prepare --request/);
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
  // #1039: default release/promote argv omit --skip-frg and compose FRG pack.
  assert.match(shipOneBody, /release "\$version" --no-edit "\$\{SKIP_FRG_ARGS\[@\]\}"/);
  assert.doesNotMatch(shipOneBody, /release "\$version" --no-edit --skip-frg/);
  assert.match(
    shipOneBody,
    /engine-promote --for "\$version" --host "\$ENGINE_PROMOTE_HOST" "\$\{SKIP_FRG_ARGS\[@\]\}" --json/,
  );
  assert.doesNotMatch(
    shipOneBody,
    /engine-promote --for "\$version" --host "\$ENGINE_PROMOTE_HOST" --skip-frg --json/,
  );
  assert.match(shipOneBody, /factory-release prepare --request/);
  assert.match(shipOneBody, /write_factory_release_request/);
  // Escape still passes --skip-frg via SKIP_FRG_ARGS; pack is omitted.
  assert.match(shipOneBody, /SKIP_FRG_ARGS=\(--skip-frg\)/);
  assert.match(shipOneBody, /phase frg-pack: omitted \(skip-frg escape\)/);
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
  assert.doesNotMatch(statusBlock, /ship_one|train --milestone|release finish|factory-release/);
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

/** Extract argv_is_live_ship (+ optional helpers) and evaluate ARGV for version. */
function extractLiveShipHelpers(src: string): string {
  const names = [
    "argv_is_live_ship",
    "cmdline_is_live_ship",
    "read_proc_argv",
  ] as const;
  const parts: string[] = [];
  for (const name of names) {
    const m = src.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
    if (m) parts.push(m[0]);
  }
  assert.ok(
    parts.some((p) => p.startsWith("argv_is_live_ship")),
    "argv_is_live_ship() not found in tugboat.sh",
  );
  return parts.join("\n");
}

/** Structured argv match (production path). */
function evalArgvIsLiveShip(version: string, argv: string[]): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-probe-"));
  try {
    const src = fs.readFileSync(tugboat, "utf8");
    const helpers = extractLiveShipHelpers(src);
    const runner = path.join(dir, "run.sh");
    const quoted = argv.map((a) => JSON.stringify(a)).join(" ");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        helpers,
        `if argv_is_live_ship ${JSON.stringify(version)} ${quoted}; then echo LIVE; else echo NOT_LIVE; fi`,
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

/** Word-split convenience (tests historical space-separated forms). */
function evalCmdlineIsLiveShip(cmdline: string, version: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-probe-"));
  try {
    const src = fs.readFileSync(tugboat, "utf8");
    const helpers = extractLiveShipHelpers(src);
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        helpers,
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
  // Live: detached train ship for the milestone (exact argv tokens).
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "/home/u/.local/bin/pipeline",
      "train",
      "--milestone",
      "v1.39.0",
      "--merge",
      "--json",
    ]),
    true,
    "train --merge for milestone must be live",
  );
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "node",
      "pipeline.mjs",
      "train",
      "--milestone",
      "v1.39.0",
      "--merge",
    ]),
    true,
  );
  // Live: owning tugboat composer (no --status / --detach).
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "/home/u/.local/bin/tugboat",
      "--milestone",
      "v1.39.0",
    ]),
    true,
    "owning tugboat must be live",
  );
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "bash",
      "/path/tugboat.sh",
      "--milestones",
      "v1.39.0",
      "v1.40.0",
    ]),
    true,
  );

  // NOT live: status / detach wrappers.
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "/home/u/.local/bin/tugboat",
      "--milestone",
      "v1.39.0",
      "--status",
    ]),
    false,
    "--status must not look like a live ship",
  );
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "/home/u/.local/bin/tugboat",
      "--milestone",
      "v1.39.0",
      "--detach",
    ]),
    false,
  );

  // NOT live: bare sleep / recycled pid that happens to be alive (playbook.pid case).
  assert.equal(
    evalArgvIsLiveShip("1.39.0", ["/bin/sleep", "3600"]),
    false,
    "bare kill -0 pid without train/tugboat cmdline is not live",
  );
  assert.equal(
    evalArgvIsLiveShip("1.39.0", ["bash", "-c", "while true; do :; done"]),
    false,
  );

  // NOT live: spoofed single-arg text that only matches when flattened (R2 a6a5cb4a).
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "bash",
      "-c",
      "sleep 3600",
      "pipeline train --milestone v1.39.0 --merge",
    ]),
    false,
    "spoofed multi-word single argv must not be live",
  );
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "bash",
      "-c",
      "pipeline train --milestone v1.39.0 --merge; sleep 3600",
    ]),
    false,
    "spoofed -c script string must not be live",
  );
  // Flattened substring helper must also reject the spoof when word-split cannot
  // invent train/--merge as separate tokens from one quoted arg.
  assert.equal(
    evalCmdlineIsLiveShip(
      "bash -c sleep 3600 'pipeline train --milestone v1.39.0 --merge'",
      "1.39.0",
    ),
    false,
  );

  // NOT live: per-issue pipeline N / pipeline single N lock holders.
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "/home/u/.local/bin/pipeline",
      "single",
      "702",
    ]),
    false,
    "pipeline single N is not a live ship",
  );
  assert.equal(
    evalArgvIsLiveShip("1.39.0", ["/home/u/.local/bin/pipeline", "702"]),
    false,
  );
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "node",
      "pipeline.mjs",
      "advance",
      "702",
      "--json",
    ]),
    false,
  );

  // NOT live: train for a different milestone, or train without --merge.
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "pipeline",
      "train",
      "--milestone",
      "v1.38.0",
      "--merge",
      "--json",
    ]),
    false,
    "other milestone train is not live for this ship",
  );
  assert.equal(
    evalArgvIsLiveShip("1.39.0", [
      "pipeline",
      "train",
      "--milestone",
      "v1.39.0",
      "--json",
    ]),
    false,
    "train without --merge is not Option 1 live ship",
  );

  // Word-split back-compat for ordinary space-separated forms.
  assert.equal(
    evalCmdlineIsLiveShip(
      "/home/u/.local/bin/pipeline train --milestone v1.39.0 --merge --json",
      "1.39.0",
    ),
    true,
  );
});

test("ship lock (#1062): stale lock pid for other-milestone train is reclaimed", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  // Mutex must gate on argv_is_live_ship for the requested version (not any train --merge).
  const lockFn = body.match(/^try_acquire_ship_lock\(\) \{[\s\S]*?\n\}/m);
  assert.ok(lockFn, "try_acquire_ship_lock missing");
  assert.match(lockFn[0], /argv_is_live_ship "\$version" "\$\{__proc_argv\[@\]\}"/);
  assert.match(lockFn[0], /read_proc_argv "\$holder"/);
  assert.match(lockFn[0], /local version=\$2/);
  // Loose any-tugboat / any-train--merge / flattened substring check must not remain.
  assert.doesNotMatch(
    lockFn[0],
    /\[\[\s*"\$holder_cmd"\s*==\s*\*tugboat\*\s*\]\]\s*\|\|/,
  );
  assert.doesNotMatch(lockFn[0], /tr '\\0' ' '/);
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

    // Confirm /proc cmdline is the other-milestone train (structured argv).
    const raw = fs.readFileSync(`/proc/${childPid}/cmdline`);
    const argv = raw
      .toString("utf8")
      .split("\0")
      .filter((s) => s.length > 0);
    assert.ok(argv.includes("train"));
    assert.ok(argv.includes("--merge"));
    assert.ok(argv.includes("v1.40.0"));
    assert.equal(
      evalArgvIsLiveShip("1.39.0", argv),
      false,
      "v1.40 train must not be live ship for 1.39.0",
    );
    assert.equal(
      evalArgvIsLiveShip("1.40.0", argv),
      true,
      "v1.40 train must be live ship for 1.40.0",
    );

    const runDir = path.join(dir, "ship-v1.39.0");
    const lockDir = path.join(runDir, "lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "pid"), `${childPid}\n`);

    const src = fs.readFileSync(tugboat, "utf8");
    const helpers = extractLiveShipHelpers(src);
    const runner = path.join(dir, "acquire.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        helpers,
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
  // Race-safe: short-lived detach.gate serializes probe-and-spawn; re-probe under gate.
  assert.match(detachFn[0], /try_acquire_detach_gate/);
  assert.match(detachFn[0], /release_detach_gate|release_held_detach_gates/);
  assert.match(body, /try_acquire_detach_gate\(\)/);
  assert.match(body, /detach\.gate/);
  // Structured argv probe (not flattened tr '\\0' ' ' substring match).
  assert.match(body, /read_proc_argv/);
  assert.match(body, /argv_is_live_ship/);
  assert.match(body, /mapfile -d ''/);
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

/** /proc cmdline scan — used so failed assertions still reap sleep stubs. */
function pidsWithCmdlineNeedle(needle: string): number[] {
  const pids: number[] = [];
  for (const ent of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${ent}/cmdline`).toString("utf8");
      if (cmd.includes(needle)) pids.push(Number(ent));
    } catch {
      /* gone */
    }
  }
  return pids;
}

function killPids(pids: number[]): void {
  for (const p of pids) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

test("detach race (#1062 R2): concurrent Ship detaches exactly once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-race-"));
  const stateRoot = path.join(dir, "state");
  const repo = path.join(dir, "repo");
  const fakePipeline = path.join(dir, "pipeline");
  // live_ship_probe is host-global per milestone. A shared real version
  // (v1.39.0) collides with leftover test stubs and any live ship on the host.
  const version = `9.99.${process.pid}.${Date.now()}`;
  try {
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(
      fakePipeline,
      "#!/usr/bin/env bash\n# long-lived train stub for concurrent detach\nsleep 3600\n",
    );
    fs.chmodSync(fakePipeline, 0o755);

    const env = {
      ...process.env,
      REPO_DIR: repo,
      PIPELINE: fakePipeline,
      ALLOW_MERGE: "1",
      SHIP_NOTIFY: "0",
      PIPELINE_SUPERVISOR_STATE: stateRoot,
    };
    const args = [tugboat, "--milestone", `v${version}`, "--detach"];

    const runOne = () =>
      new Promise<{ status: number | null; out: string }>((resolve) => {
        const child = spawn("bash", args, {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (b) => {
          out += String(b);
        });
        child.stderr.on("data", (b) => {
          out += String(b);
        });
        child.on("close", (code) => {
          resolve({ status: code, out });
        });
      });

    const [a, b] = await Promise.all([runOne(), runOne()]);
    const combined = `${a.out}\n${b.out}`;
    const detachCount = (combined.match(/detached tugboat ship/g) || []).length;
    const alreadyCount = (
      combined.match(/already running.*not detaching a second copy/g) || []
    ).length;

    assert.equal(
      detachCount,
      1,
      `expected exactly one detach, got ${detachCount}:\n${combined}`,
    );
    assert.ok(
      alreadyCount >= 1 || a.status === 0,
      `expected second request to report already-running or exit 0:\n${combined}`,
    );
    assert.equal(a.status, 0, `first detach status: ${a.status} out=${a.out}`);
    assert.equal(b.status, 0, `second detach status: ${b.status} out=${b.out}`);
  } finally {
    // Reap before rmSync. Collecting only after asserts leaked sleep 3600
    // stubs whose argv still matched train --merge for the old milestone.
    killPids(pidsWithCmdlineNeedle(dir));
    killPids(pidsWithCmdlineNeedle(`--milestone v${version}`));
    try {
      const shipDir = path.join(stateRoot, `ship-v${version}`);
      const pidFile = path.join(shipDir, "playbook.pid");
      if (fs.existsSync(pidFile)) {
        const p = Number(fs.readFileSync(pidFile, "utf8").trim());
        if (Number.isFinite(p) && p > 0) {
          try {
            process.kill(p, "SIGTERM");
          } catch {
            /* gone */
          }
        }
      }
    } catch {
      /* ignore */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

const frgHelpers = path.join(
  repoRoot,
  "examples/supervisor/shell/frg-pack-helpers.sh",
);

function extractNamedFn(src: string, name: string, label: string): string {
  const m = src.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(m, `${name}() not found in ${label}`);
  return m[0];
}

test("playbook frg-pack-helpers.sh stays in sync with tugboat pack helpers", () => {
  const tug = fs.readFileSync(tugboat, "utf8");
  const help = fs.readFileSync(frgHelpers, "utf8");
  for (const name of ["write_factory_release_request", "classify_frg_pack_tick"]) {
    assert.equal(
      extractNamedFn(tug, name, "tugboat.sh"),
      extractNamedFn(help, name, "frg-pack-helpers.sh"),
      `${name} drifted between tugboat.sh and frg-pack-helpers.sh`,
    );
  }
});

test("tugboat skip-frg without reason fails closed before ship mutation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-skip-"));
  try {
    const r = spawnSync("bash", [tugboat, "--milestone", "v1.39.0", "--skip-frg"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHIP_NOTIFY: "0",
        PIPELINE_SUPERVISOR_STATE: path.join(dir, "state"),
        REPO_DIR: "",
        ALLOW_MERGE: "0",
      },
    });
    assert.notEqual(r.status, 0, "skip without reason must fail closed");
    assert.match(`${r.stdout}\n${r.stderr}`, /requires a non-empty/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /phase train|detached tugboat/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat TUGBOAT_SKIP_FRG=1 without reason fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-skip-env-"));
  try {
    const r = spawnSync("bash", [tugboat, "--milestone", "v1.39.0"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHIP_NOTIFY: "0",
        PIPELINE_SUPERVISOR_STATE: path.join(dir, "state"),
        REPO_DIR: "",
        ALLOW_MERGE: "0",
        TUGBOAT_SKIP_FRG: "1",
      },
    });
    assert.notEqual(r.status, 0, "env skip without reason must fail closed");
    assert.match(`${r.stdout}\n${r.stderr}`, /requires a non-empty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat skip-frg with reason is accepted before status (no ship start)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-skip-ok-"));
  try {
    const r = spawnSync(
      "bash",
      [
        tugboat,
        "--milestone",
        "v9.9.9",
        "--skip-frg",
        "--skip-frg-reason",
        "operator test escape",
        "--status",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SHIP_NOTIFY: "0",
          PIPELINE_SUPERVISOR_STATE: path.join(dir, "state"),
          REPO_DIR: "",
        },
      },
    );
    assert.equal(r.status, 0, `status+skip exited ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /"status"\s*:\s*"none"/);
    assert.doesNotMatch(r.stdout + r.stderr, /phase train|factory-release prepare/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write_factory_release_request: secret-free identity only (injected I/O)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-req-"));
  try {
    const manifest = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ schema_version: 1, pack_id: "factory-gate-v1" }),
    );
    const dest = path.join(dir, "req.json");
    const sha = "a".repeat(40);
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `. ${JSON.stringify(frgHelpers)}`,
        `write_factory_release_request ${JSON.stringify(dest)} "1.39.0" ${JSON.stringify(dir)}`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        TUGBOAT_CANDIDATE_SHA: sha,
        TUGBOAT_REPOSITORY: "accidental-hedge-fund/agent-pipeline",
        TUGBOAT_BASE_BRANCH: "main",
        TUGBOAT_FRG_MANIFEST_PATH: manifest,
      },
    });
    assert.equal(r.status, 0, `writer exited ${r.status}: ${r.stderr}`);
    const req = JSON.parse(fs.readFileSync(dest, "utf8")) as Record<string, unknown>;
    assert.equal(req.schema_version, 1);
    assert.equal(req.kind, "factory_release_prepare_request");
    assert.equal(req.target_version, "1.39.0");
    assert.equal(req.action_id, "tugboat-ship-1.39.0");
    assert.equal(req.repository, "accidental-hedge-fund/agent-pipeline");
    assert.equal(req.base_branch, "main");
    const cand = req.integrated_candidate as { git_sha: string };
    assert.equal(cand.git_sha, sha);
    const man = req.frg_manifest as { pack_id: string; sha256: string };
    assert.equal(man.pack_id, "factory-gate-v1");
    assert.match(man.sha256, /^[0-9a-f]{64}$/);
    for (const forbidden of [
      "pass",
      "status",
      "credential",
      "credentials",
      "secret",
      "executable",
      "attestation_key",
    ]) {
      assert.equal(req[forbidden], undefined, `request must not contain ${forbidden}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("classify_frg_pack_tick: done / retry / fail without live pack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-tick-"));
  try {
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `. ${JSON.stringify(frgHelpers)}`,
        'classify_frg_pack_tick "$1" "$2" "$3"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const run = (prep: unknown, latest: unknown | null, ec: number): string => {
      const prepPath = path.join(dir, "prep.json");
      const latestPath = path.join(dir, "latest.json");
      fs.writeFileSync(prepPath, JSON.stringify(prep));
      if (latest === null) {
        if (fs.existsSync(latestPath)) fs.rmSync(latestPath);
      } else {
        fs.writeFileSync(latestPath, JSON.stringify(latest));
      }
      const r = spawnSync("bash", [runner, prepPath, latestPath, String(ec)], {
        encoding: "utf8",
      });
      assert.equal(r.status, 0, `classifier exited ${r.status}: ${r.stderr}`);
      return r.stdout.trim();
    };
    assert.equal(
      run({ status: "awaiting_frg_attestation" }, null, 0),
      "done",
    );
    assert.equal(run({ status: "in_progress" }, null, 0), "retry");
    assert.equal(run({ status: "complete" }, null, 0), "done");
    assert.equal(run({ status: "failed" }, null, 1), "fail");
    assert.equal(run({ status: "in_progress" }, { pass: true }, 0), "done");
    assert.equal(run({ status: "complete" }, { pass: false }, 0), "done");
    assert.equal(run({ status: "failed" }, { pass: false }, 1), "fail");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat pack phase does not sign, merge, tag, promote, or install", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  const shipOneStart = body.indexOf("ship_one() {");
  const shipOneEnd = body.indexOf("\n# ---------- run serial multi-milestone");
  const shipOneBody = body.slice(shipOneStart, shipOneEnd);
  const packStart = shipOneBody.indexOf("A2: FRG pack");
  const releaseStart = shipOneBody.indexOf("B: release prepare");
  assert.ok(packStart >= 0 && releaseStart > packStart, "frg-pack phase missing");
  const pack = shipOneBody.slice(packStart, releaseStart);
  assert.match(pack, /factory-release prepare --request/);
  assert.doesNotMatch(pack, /attestation_key|HMAC|grant[\/_]factory|factory\.mjs/);
  assert.doesNotMatch(pack, /pipeline ship /);
  assert.doesNotMatch(pack, /release finish|engine-promote|git tag|gh release create/);
  assert.doesNotMatch(pack, /pass:\s*true|"pass": true/);
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
