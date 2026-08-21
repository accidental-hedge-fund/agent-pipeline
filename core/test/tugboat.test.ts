// Tugboat (thin ship composer, #1001 / #927) decision helpers + structural guards.
// Lessons locked in: bare release version (no leading v), train complete gate,
// failure detail, promote --host all, gh checks bucket schema, PR reuse,
// serial multi-milestone, status no-side-effect, install-parity markers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isThinPlaybookLauncher } from "../scripts/ship-end-identity.ts";
import {
  contentDigest,
  evaluateOption1PackParity,
  missingTugboatThinMarkers,
  tugboatHasCriticalThinMarkers,
  tugboatHasForbiddenSecondBrainMarkers,
  type Option1PackBodies,
} from "../scripts/tugboat-install-parity.ts";
import { LOOP_LEDGER_SCHEMA } from "../scripts/loop/types.ts";

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

test("tugboat failure_detail release-finish: checks sidecar beats tester-evidence warn", () => {
  const dir = makeRunDir();
  try {
    fs.writeFileSync(
      path.join(dir, "release-checks.fail.json"),
      JSON.stringify({
        pr: "1109",
        check_name: "test",
        bucket: "fail",
        link: "https://github.com/o/r/actions/runs/32075787450",
        reason:
          "PR #1109 check test fail https://github.com/o/r/actions/runs/32075787450",
      }),
    );
    const logFile = path.join(dir, "playbook.log");
    fs.writeFileSync(
      logFile,
      "[pipeline] tester-evidence: trusted-surface blocked prevents readiness subject emission (fail closed)\n",
    );
    const out = extractFailureDetail(dir, logFile, "release-finish");
    assert.match(out, /PR #1109/);
    assert.match(out, /\btest\b/);
    assert.match(out, /32075787450/);
    assert.doesNotMatch(out, /^\[pipeline\] tester-evidence:/);
    assert.doesNotMatch(out, /^trusted-surface blocked/);
    assert.doesNotMatch(out, /tester-evidence/);
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
  assert.doesNotMatch(body, /owns merge order|second ship ledger|never in-engine ship/i);
  assert.match(body, /factory-release prepare --request/);
  assert.match(body, /engine-promote/);
  assert.match(body, /ENGINE_PROMOTE_HOST:-all/);
});

test("tugboat release uses bare X.Y.Z (leading v is invalid to pipeline release)", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  // Must call release with bare $version, never v$version. Post-train uses SHIP_END_CLI.
  assert.match(body, /"\$\{SHIP_END_CLI\[@\]\}" release "\$version"/);
  assert.doesNotMatch(body, /"\$PIPELINE" release "\$version"/);
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
  assert.match(m[1], /\blink\b/);
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
  assert.match(shipOneBody, /SHIP_END_CLI\[@\]\}" release "\$version" --no-edit "\$\{SKIP_FRG_ARGS\[@\]\}"/);
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
  // #1127: factory pin export so promote and next-train doctor share one path.
  assert.match(body, /export_factory_production_pin/);
  assert.match(
    body,
    /export AGENT_PIPELINE_PRODUCTION_PIN="\$REPO_DIR\/\.agent-pipeline\/production-engine-pin\.json"/,
  );
  assert.match(body, /if \[\[ -n "\$\{AGENT_PIPELINE_PRODUCTION_PIN:-\}" \]\]/);
  assert.match(body, /AGENT_PIPELINE_PRODUCTION_PIN="\$\{AGENT_PIPELINE_PRODUCTION_PIN:-\}"/);
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
  // After a waiter STOP (#1110), Re-Ship still reuses that open PR.
  const body = fs.readFileSync(tugboat, "utf8");
  assert.match(body, /find_open_release_pr\(\)/);
  assert.match(body, /release: \{version\}|release: v\{version\}|startswith\(f"release: /);
  assert.match(body, /existing open release PR #\$pr reused \(idempotent\)/);
  assert.match(body, /could not determine release PR number/);
  assert.match(body, /after a prior waiter STOP still reuses this PR/);
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
    tugboat: canon.tugboat! + "\ngrant_factory\n",
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
    '# dead/commented: gh pr checks "$pr" --json name,state,bucket,link',
    'gh pr checks "$pr" --json name,state,bucket,link',
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

test("ship lock (#1062): stale lock pid for other-milestone train is reclaimed", async () => {
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
      "#!/bin/bash\n# stub train holder for lock reclaim regression\nsleep 3600\n",
    );
    fs.chmodSync(fakeBin, 0o755);
    // Detached so the stub survives after spawn returns; argv must look like train --merge v1.40.0.
    // Exec /bin/bash directly. A `#!/usr/bin/env bash` shebang briefly publishes
    // cmdline as `env bash` with no `train` token (flake under full-suite load).
    const child = spawn(
      "/bin/bash",
      [fakeBin, "train", "--milestone", "v1.40.0", "--merge", "--json"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    childPid = child.pid;
    assert.ok(
      childPid !== undefined && Number.isFinite(childPid) && childPid > 0,
      `bad stub pid: ${String(childPid)}`,
    );

    // spawn() returns before exec. Wait for structured /proc argv, not the
    // pre-exec cmdline.
    let argv: string[] = [];
    await waitUntil(
      () => {
        try {
          argv = fs
            .readFileSync(`/proc/${childPid}/cmdline`)
            .toString("utf8")
            .split("\0")
            .filter((s) => s.length > 0);
          return (
            argv.includes("train") &&
            argv.includes("--merge") &&
            argv.includes("v1.40.0")
          );
        } catch {
          return false;
        }
      },
      5_000,
      `stub train argv for pid ${childPid}`,
    );
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
  // Race-safe: flock admission lock serializes probe-and-spawn; re-probe under lock.
  assert.match(detachFn[0], /acquire_admission_lock/);
  assert.match(detachFn[0], /cleanup_detach_admission/);
  assert.match(detachFn[0], /wait_until_live_ship/);
  assert.match(detachFn[0], /reap_unconfirmed_detach_child/);
  assert.match(detachFn[0], /record_pending_unconfirmed_child/);
  assert.match(detachFn[0], /setsid nohup/);
  assert.match(detachFn[0], /trap 'cleanup_detach_admission; exit 130' INT/);
  assert.match(detachFn[0], /trap 'cleanup_detach_admission; exit 143' TERM/);
  assert.match(body, /acquire_admission_lock\(\)/);
  assert.match(body, /reap_unconfirmed_detach_child\(\)/);
  assert.match(body, /cleanup_detach_admission\(\)/);
  assert.match(body, /setsid is required to isolate the detached child process group/);
  assert.match(body, /admission\/\$\{token\}\/v/);
  assert.match(body, /flock -w/);
  assert.match(body, /flock is required for detach admission \(no mkdir-gate fallback\)/);
  assert.doesNotMatch(body, /try_acquire_detach_gate/);
  // Empty-pid mkdir reclaim was the #1109 hole; must not remain as live code.
  assert.doesNotMatch(
    body,
    /^\s*if \[\[ -z "\$holder" \]\] \|\| ! kill -0 "\$holder"/m,
  );
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

function admissionLockPath(
  stateRoot: string,
  repoDir: string,
  version: string,
): string {
  const real = fs.realpathSync(repoDir);
  const token = createHash("sha256").update(real, "utf8").digest("hex");
  return path.join(stateRoot, "admission", token, `v${version.toLowerCase()}.lock`);
}

function countDetachLines(combined: string): number {
  return (combined.match(/detached tugboat ship/g) || []).length;
}

function countAlreadyRunningLines(combined: string): number {
  return (combined.match(/already running.*not detaching a second copy/g) || [])
    .length;
}

/** Processes whose cmdline contains NEEDLE (NUL-insensitive). */
function procsWithNeedle(needle: string): Array<{ pid: number; argv: string[] }> {
  const out: Array<{ pid: number; argv: string[] }> = [];
  for (const ent of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const raw = fs.readFileSync(`/proc/${ent}/cmdline`).toString("utf8");
      if (!raw.includes(needle)) continue;
      out.push({
        pid: Number(ent),
        argv: raw.split("\0").filter(Boolean),
      });
    } catch {
      /* gone */
    }
  }
  return out;
}

function isOwningTugboatArgv(argv: string[], version: string): boolean {
  const tag = `v${version}`;
  const isTug = argv.some((a) => {
    const base = a.split("/").pop() || "";
    return base === "tugboat" || base === "tugboat.sh";
  });
  if (!isTug || argv.includes("--detach") || argv.includes("--status")) {
    return false;
  }
  for (let i = 0; i < argv.length; i++) {
    if (
      (argv[i] === "--milestone" || argv[i] === "-m") &&
      (argv[i + 1] === tag || argv[i + 1] === version)
    ) {
      return true;
    }
  }
  return false;
}

/** Shared assertion for the concurrent two-spawn fixture. Two detach lines fail. */
function assertSingleDetachAdmission(opts: {
  combined: string;
  statuses: Array<number | null>;
}): void {
  const detachCount = countDetachLines(opts.combined);
  const alreadyCount = countAlreadyRunningLines(opts.combined);
  assert.equal(
    detachCount,
    1,
    `expected exactly one detach, got ${detachCount}:\n${opts.combined}`,
  );
  assert.equal(
    alreadyCount,
    1,
    `expected exactly one already-running line, got ${alreadyCount}:\n${opts.combined}`,
  );
  assert.doesNotMatch(
    opts.combined,
    /admission lock|lock file|detach\.gate/i,
    `loser must refuse via live-ship probe, not lock presence:\n${opts.combined}`,
  );
  assert.equal(
    opts.statuses[0],
    0,
    `first detach status: ${opts.statuses[0]}`,
  );
  assert.equal(
    opts.statuses[1],
    0,
    `second detach status: ${opts.statuses[1]}`,
  );
}

async function waitUntil(
  pred: () => boolean,
  ms: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function spawnDetachViaBarrier(opts: {
  id: string;
  barrierDir: string;
  goFile: string;
  version: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ status: number | null; out: string }> {
  const readyFile = path.join(opts.barrierDir, `${opts.id}.ready`);
  const wrapper = path.join(opts.barrierDir, `${opts.id}.wrapper.sh`);
  fs.writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf 'ready\\n' > ${JSON.stringify(readyFile)}`,
      `while [[ ! -f ${JSON.stringify(opts.goFile)} ]]; do`,
      "  # start barrier — not the admission pass condition",
      "  sleep 0.01",
      "done",
      `exec bash ${JSON.stringify(tugboat)} --milestone ${JSON.stringify(`v${opts.version}`)} --detach`,
      "",
    ].join("\n"),
  );
  fs.chmodSync(wrapper, 0o755);
  return new Promise((resolve) => {
    const child = spawn("bash", [wrapper], {
      env: opts.env,
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
}

function reapDetachFixture(dir: string, stateRoot: string, version: string): void {
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
}

function writeLongLivedPipelineStub(fakePipeline: string): void {
  fs.writeFileSync(
    fakePipeline,
    "#!/usr/bin/env bash\n# long-lived train stub for concurrent detach\nsleep 3600\n",
  );
  fs.chmodSync(fakePipeline, 0o755);
}

test("detach race (#1062 R2): concurrent Ship detaches exactly once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-race-"));
  const stateRoot = path.join(dir, "state");
  const repo = path.join(dir, "repo");
  const fakePipeline = path.join(dir, "pipeline");
  const barrierDir = path.join(dir, "barrier");
  const goFile = path.join(barrierDir, "go");
  // live_ship_probe is host-global per milestone. A shared real version
  // (v1.39.0) collides with leftover test stubs and any live ship on the host.
  const version = `9.99.${process.pid}.${Date.now()}`;
  try {
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(barrierDir, { recursive: true });
    writeLongLivedPipelineStub(fakePipeline);

    const env = {
      ...process.env,
      REPO_DIR: repo,
      PIPELINE: fakePipeline,
      ALLOW_MERGE: "1",
      SHIP_NOTIFY: "0",
      PIPELINE_SUPERVISOR_STATE: stateRoot,
    };

    const pendingA = spawnDetachViaBarrier({
      id: "a",
      barrierDir,
      goFile,
      version,
      env,
    });
    const pendingB = spawnDetachViaBarrier({
      id: "b",
      barrierDir,
      goFile,
      version,
      env,
    });
    const readyA = path.join(barrierDir, "a.ready");
    const readyB = path.join(barrierDir, "b.ready");
    await waitUntil(
      () => fs.existsSync(readyA) && fs.existsSync(readyB),
      10_000,
      "both detach wrappers ready",
    );
    fs.writeFileSync(goFile, "go\n");
    const [a, b] = await Promise.all([pendingA, pendingB]);
    const combined = `${a.out}\n${b.out}`;
    assertSingleDetachAdmission({
      combined,
      statuses: [a.status, b.status],
    });
  } finally {
    // Reap before rmSync. Collecting only after asserts leaked sleep 3600
    // stubs whose argv still matched train --merge for the old milestone.
    reapDetachFixture(dir, stateRoot, version);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detach race fixture: two detach lines fail the assertion", () => {
  assert.throws(
    () =>
      assertSingleDetachAdmission({
        combined:
          "detached tugboat ship 9.99.1 (pid 1)\ndetached tugboat ship 9.99.1 (pid 2)\n",
        statuses: [0, 0],
      }),
    /expected exactly one detach, got 2/,
  );
});

test("detach race fixture stays enabled (not skipped or flaky)", () => {
  const src = fs.readFileSync(path.join(here, "tugboat.test.ts"), "utf8");
  const needle =
    'test("detach race (#1062 R2): concurrent Ship detaches exactly once"';
  const idx = src.indexOf(needle);
  assert.ok(idx >= 0, "concurrent detach fixture must remain in tugboat.test.ts");
  const head = src.slice(Math.max(0, idx - 80), idx + needle.length);
  assert.doesNotMatch(head, /test\.skip|describe\.skip|\.todo\(|flaky/i);
  assert.match(src, /spawnDetachViaBarrier/);
  assert.match(src, /assertSingleDetachAdmission/);
});

test("admission lock leftover file is not a live ship", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-stale-lock-"));
  const stateRoot = path.join(dir, "state");
  const repo = path.join(dir, "repo");
  const fakePipeline = path.join(dir, "pipeline");
  const version = `9.99.${process.pid}.${Date.now()}.stale`;
  try {
    fs.mkdirSync(repo, { recursive: true });
    writeLongLivedPipelineStub(fakePipeline);
    const lockPath = admissionLockPath(stateRoot, repo, version);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Dead/absent owner, no live flock holder.
    fs.writeFileSync(lockPath, "1 0\n");

    const r = spawnSync(
      "bash",
      [tugboat, "--milestone", `v${version}`, "--detach"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          REPO_DIR: repo,
          PIPELINE: fakePipeline,
          ALLOW_MERGE: "1",
          SHIP_NOTIFY: "0",
          PIPELINE_SUPERVISOR_STATE: stateRoot,
        },
      },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, `stale lock detach status=${r.status} out=${out}`);
    assert.match(out, /detached tugboat ship/);
    assert.doesNotMatch(out, /already running.*not detaching a second copy/);
    assert.doesNotMatch(out, /admission lock|lock file/i);
  } finally {
    reapDetachFixture(dir, stateRoot, version);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failed wait-for-live reaps delayed child so a later detach is the only ship", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delay-reap-"));
  const stateRoot = path.join(dir, "state");
  const repo = path.join(dir, "repo");
  const fakePipeline = path.join(dir, "pipeline");
  const version = `9.99.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  const marker = `DELAY_REAP_MARKER=${version}`;
  const delayMs = 1500;
  const delayChild = path.join(dir, "delay-child.sh");
  const patched = path.join(dir, "patched.sh");
  try {
    fs.mkdirSync(repo, { recursive: true });
    writeLongLivedPipelineStub(fakePipeline);

    const wokeFile = path.join(dir, "delay.woke");
    const pidFile = path.join(dir, "delay.pid");
    fs.writeFileSync(
      delayChild,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `export DELAY_REAP_MARKER=${JSON.stringify(version)}`,
        `printf '%s\\n' "$$" > ${JSON.stringify(pidFile)}`,
        `sleep ${delayMs / 1000}`,
        `printf 'woke\\n' > ${JSON.stringify(wokeFile)}`,
        `exec bash ${JSON.stringify(tugboat)} "$@"`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(delayChild, 0o755);

    const src = fs.readFileSync(tugboat, "utf8");
    const needle = 'self=$(readlink -f "$0")';
    assert.ok(src.includes(needle), "detach_self self= assign missing");
    const patchedSrc = src
      .replace(needle, `self=${JSON.stringify(delayChild)}`)
      .replace(
        'ADMISSION_LIVE_WAIT_ATTEMPTS="${ADMISSION_LIVE_WAIT_ATTEMPTS:-50}"',
        "ADMISSION_LIVE_WAIT_ATTEMPTS=2",
      )
      .replace(
        'ADMISSION_LIVE_WAIT_SLEEP_S="${ADMISSION_LIVE_WAIT_SLEEP_S:-0.1}"',
        "ADMISSION_LIVE_WAIT_SLEEP_S=0.05",
      );
    assert.notEqual(patchedSrc, src, "must patch detach child path and wait bound");
    fs.writeFileSync(patched, patchedSrc);
    fs.chmodSync(patched, 0o755);

    const baseEnv = {
      ...process.env,
      REPO_DIR: repo,
      PIPELINE: fakePipeline,
      ALLOW_MERGE: "1",
      SHIP_NOTIFY: "0",
      PIPELINE_SUPERVISOR_STATE: stateRoot,
    };

    const firstStarted = Date.now();
    const first = spawnSync(
      "bash",
      [patched, "--milestone", `v${version}`, "--detach"],
      {
        encoding: "utf8",
        env: {
          ...baseEnv,
          ADMISSION_LIVE_WAIT_ATTEMPTS: "2",
          ADMISSION_LIVE_WAIT_SLEEP_S: "0.05",
        },
      },
    );
    const firstOut = `${first.stdout}\n${first.stderr}`;
    assert.notEqual(
      first.status,
      0,
      `first detach must fail wait-for-live, status=${first.status} out=${firstOut}`,
    );
    assert.doesNotMatch(firstOut, /detached tugboat ship/);
    assert.match(firstOut, /did not become a live ship/);

    let delayedPid: number | undefined;
    if (fs.existsSync(pidFile)) {
      delayedPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(delayedPid) && delayedPid > 0) {
        assert.throws(
          () => process.kill(delayedPid, 0),
          /ESRCH/,
          `delayed child pid ${delayedPid} must be dead before later detach`,
        );
      } else {
        delayedPid = undefined;
      }
    }

    const second = spawnSync(
      "bash",
      [tugboat, "--milestone", `v${version}`, "--detach"],
      { encoding: "utf8", env: baseEnv },
    );
    const secondOut = `${second.stdout}\n${second.stderr}`;
    assert.equal(
      second.status,
      0,
      `later detach status=${second.status} out=${secondOut}`,
    );
    assert.match(secondOut, /detached tugboat ship/);
    assert.equal(
      countDetachLines(secondOut),
      1,
      `later detach must emit one ship line:\n${secondOut}`,
    );

    const remaining = delayMs + 400 - (Date.now() - firstStarted);
    if (remaining > 0) {
      await new Promise((r) => setTimeout(r, remaining));
    }

    assert.equal(
      fs.existsSync(wokeFile),
      false,
      "delayed child must be reaped before it becomes a live ship",
    );
    if (delayedPid !== undefined) {
      assert.throws(
        () => process.kill(delayedPid, 0),
        /ESRCH/,
        `delayed child pid ${delayedPid} must stay dead after the delay window`,
      );
    }
    const marked = procsWithNeedle(version).filter((p) => {
      try {
        const env = fs.readFileSync(`/proc/${p.pid}/environ`).toString("utf8");
        return env.includes(marker);
      } catch {
        return false;
      }
    });
    const markedOwners = marked.filter((p) => isOwningTugboatArgv(p.argv, version));
    assert.equal(
      markedOwners.length,
      0,
      `delayed child must not become a live ship after admission release:\n${markedOwners
        .map((p) => `${p.pid} ${JSON.stringify(p.argv)}`)
        .join("\n")}`,
    );
    const owners = procsWithNeedle(version).filter((p) =>
      isOwningTugboatArgv(p.argv, version),
    );
    assert.ok(
      owners.length >= 1,
      `later detach must leave a live owning tugboat for v${version}`,
    );
  } finally {
    reapDetachFixture(dir, stateRoot, version);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGTERM during wait-for-live reaps the unconfirmed child before unlock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "term-reap-"));
  const stateRoot = path.join(dir, "state");
  const repo = path.join(dir, "repo");
  const fakePipeline = path.join(dir, "pipeline");
  const version = `9.99.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  const marker = `TERM_REAP_MARKER=${version}`;
  const delayChild = path.join(dir, "delay-child.sh");
  const patched = path.join(dir, "patched.sh");
  try {
    fs.mkdirSync(repo, { recursive: true });
    writeLongLivedPipelineStub(fakePipeline);

    const wokeFile = path.join(dir, "delay.woke");
    const pidFile = path.join(dir, "delay.pid");
    fs.writeFileSync(
      delayChild,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `export TERM_REAP_MARKER=${JSON.stringify(version)}`,
        `printf '%s\\n' "$$" > ${JSON.stringify(pidFile)}`,
        "sleep 30",
        `printf 'woke\\n' > ${JSON.stringify(wokeFile)}`,
        `exec bash ${JSON.stringify(tugboat)} "$@"`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(delayChild, 0o755);

    const src = fs.readFileSync(tugboat, "utf8");
    const needle = 'self=$(readlink -f "$0")';
    assert.ok(src.includes(needle), "detach_self self= assign missing");
    const patchedSrc = src.replace(needle, `self=${JSON.stringify(delayChild)}`);
    assert.notEqual(patchedSrc, src, "must patch detach child path");
    fs.writeFileSync(patched, patchedSrc);
    fs.chmodSync(patched, 0o755);

    const baseEnv = {
      ...process.env,
      REPO_DIR: repo,
      PIPELINE: fakePipeline,
      ALLOW_MERGE: "1",
      SHIP_NOTIFY: "0",
      PIPELINE_SUPERVISOR_STATE: stateRoot,
    };

    const child = spawn("bash", [patched, "--milestone", `v${version}`, "--detach"], {
      env: baseEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => {
      out += String(b);
    });
    child.stderr.on("data", (b) => {
      out += String(b);
    });
    const finished = new Promise<{ status: number | null; out: string }>((resolve) => {
      child.on("close", (code) => resolve({ status: code, out }));
    });

    await waitUntil(() => fs.existsSync(pidFile), 10_000, "unconfirmed child pid file");
    const detachPid = child.pid;
    assert.ok(detachPid && detachPid > 0, "detach parent pid missing");
    let delayedPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isFinite(delayedPid) && delayedPid > 0, "delayed child pid missing");
    process.kill(delayedPid, 0);
    process.kill(detachPid, "SIGTERM");
    const first = await finished;
    const firstOut = first.out;
    assert.notEqual(
      first.status,
      0,
      `SIGTERM detach must fail closed, status=${first.status} out=${firstOut}`,
    );
    assert.doesNotMatch(firstOut, /detached tugboat ship/);

    assert.throws(
      () => process.kill(delayedPid, 0),
      /ESRCH/,
      `unconfirmed child pid ${delayedPid} must be dead after SIGTERM cleanup`,
    );
    assert.equal(fs.existsSync(wokeFile), false, "signaled child must not become a live ship");

    const second = spawnSync(
      "bash",
      [tugboat, "--milestone", `v${version}`, "--detach"],
      { encoding: "utf8", env: baseEnv },
    );
    const secondOut = `${second.stdout}\n${second.stderr}`;
    assert.equal(
      second.status,
      0,
      `later detach status=${second.status} out=${secondOut}`,
    );
    assert.match(secondOut, /detached tugboat ship/);
    assert.equal(
      countDetachLines(secondOut),
      1,
      `later detach must emit one ship line:\n${secondOut}`,
    );
    const owners = procsWithNeedle(version).filter((p) =>
      isOwningTugboatArgv(p.argv, version),
    );
    assert.ok(
      owners.length >= 1,
      `later detach must leave a live owning tugboat for v${version}`,
    );
    const marked = procsWithNeedle(version).filter((p) => {
      try {
        const env = fs.readFileSync(`/proc/${p.pid}/environ`).toString("utf8");
        return env.includes(marker);
      } catch {
        return false;
      }
    });
    assert.equal(
      marked.length,
      0,
      `SIGTERM path must not leave the unconfirmed child:\n${marked
        .map((p) => `${p.pid} ${JSON.stringify(p.argv)}`)
        .join("\n")}`,
    );
  } finally {
    reapDetachFixture(dir, stateRoot, version);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wait-for-live expiry reaps a re-parented descendant before unlock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reparent-reap-"));
  const stateRoot = path.join(dir, "state");
  const repo = path.join(dir, "repo");
  const fakePipeline = path.join(dir, "pipeline");
  const version = `9.99.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  const marker = `REPARENT_REAP_MARKER=${version}`;
  const delayChild = path.join(dir, "reparent-child.sh");
  const patched = path.join(dir, "patched.sh");
  try {
    fs.mkdirSync(repo, { recursive: true });
    writeLongLivedPipelineStub(fakePipeline);

    const wokeFile = path.join(dir, "reparent.woke");
    const pidFile = path.join(dir, "reparent.pid");
    const startedFile = path.join(dir, "reparent.started");
    // Sleep longer than wait-for-live + reap so a slow /proc probe cannot
    // let the descendant write woke before cleanup runs.
    const descendantSleepS = 8;
    fs.writeFileSync(
      delayChild,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `export REPARENT_REAP_MARKER=${JSON.stringify(version)}`,
        `export DELAY_PID_FILE=${JSON.stringify(pidFile)}`,
        `export DELAY_WOKE_FILE=${JSON.stringify(wokeFile)}`,
        `export DELAY_STARTED_FILE=${JSON.stringify(startedFile)}`,
        `export REAL_TUGBOAT=${JSON.stringify(tugboat)}`,
        "exec python3 - \"$@\" <<'PY'",
        "import os, sys, time",
        "pidfile = os.environ['DELAY_PID_FILE']",
        "woke = os.environ['DELAY_WOKE_FILE']",
        "started = os.environ['DELAY_STARTED_FILE']",
        "tug = os.environ['REAL_TUGBOAT']",
        "child = os.fork()",
        "if child > 0:",
        "    os._exit(0)",
        "os.setpgrp()",
        "with open(started, 'w', encoding='utf8') as f:",
        "    f.write('started\\n')",
        "with open(pidfile, 'w', encoding='utf8') as f:",
        "    f.write('%d\\n' % os.getpid())",
        `time.sleep(${descendantSleepS})`,
        "with open(woke, 'w', encoding='utf8') as f:",
        "    f.write('woke\\n')",
        "os.execvp('bash', ['bash', tug, *sys.argv[1:]])",
        "PY",
        "",
      ].join("\n"),
    );
    fs.chmodSync(delayChild, 0o755);

    const src = fs.readFileSync(tugboat, "utf8");
    const needle = 'self=$(readlink -f "$0")';
    assert.ok(src.includes(needle), "detach_self self= assign missing");
    const patchedSrc = src
      .replace(needle, `self=${JSON.stringify(delayChild)}`)
      .replace(
        'ADMISSION_LIVE_WAIT_ATTEMPTS="${ADMISSION_LIVE_WAIT_ATTEMPTS:-50}"',
        "ADMISSION_LIVE_WAIT_ATTEMPTS=2",
      )
      .replace(
        'ADMISSION_LIVE_WAIT_SLEEP_S="${ADMISSION_LIVE_WAIT_SLEEP_S:-0.1}"',
        "ADMISSION_LIVE_WAIT_SLEEP_S=0.05",
      );
    assert.notEqual(patchedSrc, src, "must patch detach child path and wait bound");
    fs.writeFileSync(patched, patchedSrc);
    fs.chmodSync(patched, 0o755);

    const baseEnv = {
      ...process.env,
      REPO_DIR: repo,
      PIPELINE: fakePipeline,
      ALLOW_MERGE: "1",
      SHIP_NOTIFY: "0",
      PIPELINE_SUPERVISOR_STATE: stateRoot,
    };

    const firstStarted = Date.now();
    const first = spawnSync(
      "bash",
      [patched, "--milestone", `v${version}`, "--detach"],
      {
        encoding: "utf8",
        env: {
          ...baseEnv,
          ADMISSION_LIVE_WAIT_ATTEMPTS: "2",
          ADMISSION_LIVE_WAIT_SLEEP_S: "0.05",
        },
      },
    );
    const firstOut = `${first.stdout}\n${first.stderr}`;
    assert.notEqual(
      first.status,
      0,
      `first detach must fail wait-for-live, status=${first.status} out=${firstOut}`,
    );
    assert.doesNotMatch(firstOut, /detached tugboat ship/);
    assert.match(firstOut, /did not become a live ship/);

    let delayedPid: number | undefined;
    if (!fs.existsSync(pidFile) && !fs.existsSync(startedFile)) {
      await waitUntil(
        () => fs.existsSync(pidFile) || fs.existsSync(startedFile),
        500,
        "re-parented descendant pid/started file (may already be reaped)",
      ).catch(() => undefined);
    }
    if (fs.existsSync(pidFile)) {
      delayedPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(delayedPid) && delayedPid > 0) {
        assert.throws(
          () => process.kill(delayedPid, 0),
          /ESRCH/,
          `re-parented descendant pid ${delayedPid} must be dead before later detach`,
        );
      } else {
        delayedPid = undefined;
      }
    }
    assert.equal(
      fs.existsSync(wokeFile),
      false,
      "re-parented descendant must not reach woke before later detach",
    );

    const second = spawnSync(
      "bash",
      [tugboat, "--milestone", `v${version}`, "--detach"],
      { encoding: "utf8", env: baseEnv },
    );
    const secondOut = `${second.stdout}\n${second.stderr}`;
    assert.equal(
      second.status,
      0,
      `later detach status=${second.status} out=${secondOut}`,
    );
    assert.match(secondOut, /detached tugboat ship/);
    assert.equal(
      countDetachLines(secondOut),
      1,
      `later detach must emit one ship line:\n${secondOut}`,
    );

    const remaining = descendantSleepS * 1000 + 400 - (Date.now() - firstStarted);
    if (remaining > 0) {
      await new Promise((r) => setTimeout(r, remaining));
    }

    assert.equal(
      fs.existsSync(wokeFile),
      false,
      "re-parented descendant must be reaped before it becomes a live ship",
    );
    if (delayedPid !== undefined) {
      assert.throws(
        () => process.kill(delayedPid, 0),
        /ESRCH/,
        `re-parented descendant pid ${delayedPid} must stay dead after the delay window`,
      );
    }
    const marked = procsWithNeedle(version).filter((p) => {
      try {
        const env = fs.readFileSync(`/proc/${p.pid}/environ`).toString("utf8");
        return env.includes(marker);
      } catch {
        return false;
      }
    });
    const markedOwners = marked.filter((p) => isOwningTugboatArgv(p.argv, version));
    assert.equal(
      markedOwners.length,
      0,
      `re-parented descendant must not become a live ship after admission release:\n${markedOwners
        .map((p) => `${p.pid} ${JSON.stringify(p.argv)}`)
        .join("\n")}`,
    );
    const owners = procsWithNeedle(version).filter((p) =>
      isOwningTugboatArgv(p.argv, version),
    );
    assert.ok(
      owners.length >= 1,
      `later detach must leave a live owning tugboat for v${version}`,
    );
  } finally {
    reapDetachFixture(dir, stateRoot, version);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failed wait-for-live releases admission for a later detach", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-fail-wait-"));
  const stateRoot = path.join(dir, "state");
  const repo = path.join(dir, "repo");
  const fakePipeline = path.join(dir, "pipeline");
  const version = `9.99.${process.pid}.${Date.now()}.failwait`;
  try {
    fs.mkdirSync(repo, { recursive: true });
    writeLongLivedPipelineStub(fakePipeline);

    const src = fs.readFileSync(tugboat, "utf8");
    const names = [
      "safe_of",
      "repo_admission_token",
      "admission_lock_path",
      "admission_owner_identity",
      "acquire_admission_lock",
      "release_admission_lock",
      "release_held_admission_locks",
      "wait_until_live_ship",
      "read_proc_argv",
      "argv_is_live_ship",
      "live_ship_probe",
    ];
    const helpers: string[] = [];
    for (const name of names) {
      const m = src.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
      assert.ok(m, `${name}() not found in tugboat.sh`);
      helpers.push(m[0]);
    }
    const runner = path.join(dir, "fail-wait.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `STATE_ROOT=${JSON.stringify(stateRoot)}`,
        `REPO_DIR=${JSON.stringify(fs.realpathSync(repo))}`,
        "ADMISSION_LOCK_WAIT_S=2",
        "ADMISSION_LIVE_WAIT_ATTEMPTS=1",
        "ADMISSION_LIVE_WAIT_SLEEP_S=0.01",
        "ADMISSION_LOCK_VERSIONS=()",
        "ADMISSION_LOCK_FDS=()",
        ...helpers,
        `acquire_admission_lock ${JSON.stringify(version)}`,
        // No ship exists; wait must fail closed. Trap-equivalent release.
        `if wait_until_live_ship ${JSON.stringify(version)}; then`,
        '  echo "UNEXPECTED_LIVE"',
        "  release_held_admission_locks",
        "  exit 2",
        "fi",
        "release_held_admission_locks",
        'echo "WAIT_FAILED_RELEASED"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const failed = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(
      failed.status,
      0,
      `fail-wait helper status=${failed.status} out=${failed.stdout} err=${failed.stderr}`,
    );
    assert.match(failed.stdout, /WAIT_FAILED_RELEASED/);
    assert.doesNotMatch(failed.stdout, /detached tugboat ship/);

    const r = spawnSync(
      "bash",
      [tugboat, "--milestone", `v${version}`, "--detach"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          REPO_DIR: repo,
          PIPELINE: fakePipeline,
          ALLOW_MERGE: "1",
          SHIP_NOTIFY: "0",
          PIPELINE_SUPERVISOR_STATE: stateRoot,
        },
      },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, `later detach status=${r.status} out=${out}`);
    assert.match(out, /detached tugboat ship/);
  } finally {
    reapDetachFixture(dir, stateRoot, version);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sequential second detach uses live-ship probe after first is live", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-seq-detach-"));
  const stateRoot = path.join(dir, "state");
  const repo = path.join(dir, "repo");
  const fakePipeline = path.join(dir, "pipeline");
  const version = `9.99.${process.pid}.${Date.now()}.seq`;
  try {
    fs.mkdirSync(repo, { recursive: true });
    writeLongLivedPipelineStub(fakePipeline);
    const env = {
      ...process.env,
      REPO_DIR: repo,
      PIPELINE: fakePipeline,
      ALLOW_MERGE: "1",
      SHIP_NOTIFY: "0",
      PIPELINE_SUPERVISOR_STATE: stateRoot,
    };
    const first = spawnSync(
      "bash",
      [tugboat, "--milestone", `v${version}`, "--detach"],
      { encoding: "utf8", env },
    );
    const firstOut = `${first.stdout}\n${first.stderr}`;
    assert.equal(first.status, 0, `first detach status=${first.status} out=${firstOut}`);
    assert.match(firstOut, /detached tugboat ship/);

    const second = spawnSync(
      "bash",
      [tugboat, "--milestone", `v${version}`, "--detach"],
      { encoding: "utf8", env },
    );
    const secondOut = `${second.stdout}\n${second.stderr}`;
    assert.equal(
      second.status,
      0,
      `second detach status=${second.status} out=${secondOut}`,
    );
    assert.match(secondOut, /already running.*not detaching a second copy/);
    assert.doesNotMatch(secondOut, /detached tugboat ship/);
    assert.doesNotMatch(secondOut, /admission lock|lock file|detach\.gate/i);
  } finally {
    reapDetachFixture(dir, stateRoot, version);
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
  for (const name of [
    "write_factory_release_request",
    "classify_frg_pack_tick",
    "invoke_factory_release_prepare",
    "frg_pack_loop_run_id",
    "invoke_frg_pack_attestor",
    "frg_pack_loop_is_live",
    "frg_pack_wait_decision",
  ]) {
    assert.equal(
      extractNamedFn(tug, name, "tugboat.sh"),
      extractNamedFn(help, name, "frg-pack-helpers.sh"),
      `${name} drifted between tugboat.sh and frg-pack-helpers.sh`,
    );
  }
  assert.doesNotMatch(
    extractNamedFn(help, "classify_frg_pack_tick", "frg-pack-helpers.sh"),
    /status == "awaiting_frg_attestation":\s*\n\s*print\("done"\)/,
    "playbook classifier must not treat awaiting_frg_attestation as done",
  );
  assert.doesNotMatch(
    extractNamedFn(help, "classify_frg_pack_tick", "frg-pack-helpers.sh"),
    /if pass_v is False:\s*\n\s*print\("fail"\)[\s\S]*status == "awaiting_frg_attestation"/,
    "must not fail-close on unsigned pass:false before awaiting/attest (#1147)",
  );
  assert.match(
    extractNamedFn(help, "classify_frg_pack_tick", "frg-pack-helpers.sh"),
    /has_unsigned_eligible_artifacts\(prep\)[\s\S]*if pass_v is False and hmac_present\(latest\)/,
    "in_progress unsigned-eligible must classify before signed latest pass:false (#1147)",
  );
  assert.doesNotMatch(
    extractNamedFn(help, "classify_frg_pack_tick", "frg-pack-helpers.sh"),
    /if pass_v is False and hmac_present\(latest\)[\s\S]*has_unsigned_eligible_artifacts/,
    "must not fail-close on signed latest pass:false before in_progress unsigned-eligible (#1147)",
  );
});

test("tugboat export_factory_production_pin sets factory pin when unset (#1127)", () => {
  const src = fs.readFileSync(tugboat, "utf8");
  const fn = extractNamedFn(src, "export_factory_production_pin", "tugboat.sh");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-pin-export-"));
  try {
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'REPO_DIR="/factory/control"',
        "unset AGENT_PIPELINE_PRODUCTION_PIN",
        fn,
        "export_factory_production_pin",
        'printf "%s" "$AGENT_PIPELINE_PRODUCTION_PIN"',
        "",
      ].join("\n"),
    );
    const r = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(r.status, 0, `export runner exited ${r.status}: ${r.stderr}`);
    assert.equal(
      r.stdout,
      "/factory/control/.agent-pipeline/production-engine-pin.json",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat export_factory_production_pin ignores an existing Hermes-state pin file (#1183)", () => {
  const src = fs.readFileSync(tugboat, "utf8");
  const fn = extractNamedFn(src, "export_factory_production_pin", "tugboat.sh");
  assert.doesNotMatch(fn, /hermes-factory\/production-engine-pin/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-pin-hermes-"));
  try {
    const home = path.join(dir, "home");
    const hermesDir = path.join(home, ".local/state/hermes-factory");
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.writeFileSync(
      path.join(hermesDir, "production-engine-pin.json"),
      JSON.stringify({ version: "1.39.6", git_sha: "a".repeat(40) }),
    );
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `HOME=${JSON.stringify(home)}`,
        'REPO_DIR="/factory/control"',
        "unset AGENT_PIPELINE_PRODUCTION_PIN",
        fn,
        "export_factory_production_pin",
        'printf "%s" "$AGENT_PIPELINE_PRODUCTION_PIN"',
        "",
      ].join("\n"),
    );
    const r = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(r.status, 0, `export runner exited ${r.status}: ${r.stderr}`);
    assert.equal(
      r.stdout,
      "/factory/control/.agent-pipeline/production-engine-pin.json",
    );
    assert.doesNotMatch(r.stdout, /hermes-factory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat export_factory_production_pin preserves operator override (#1127)", () => {
  const src = fs.readFileSync(tugboat, "utf8");
  const fn = extractNamedFn(src, "export_factory_production_pin", "tugboat.sh");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-pin-keep-"));
  try {
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'REPO_DIR="/factory/control"',
        'AGENT_PIPELINE_PRODUCTION_PIN="/custom/pin.json"',
        fn,
        "export_factory_production_pin",
        'printf "%s" "$AGENT_PIPELINE_PRODUCTION_PIN"',
        "",
      ].join("\n"),
    );
    const r = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(r.status, 0, `export runner exited ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout, "/custom/pin.json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scripts/pipeline-launcher.mjs exports factory pin when unset (#1127)", () => {
  const launcher = path.join(repoRoot, "scripts/pipeline-launcher.mjs");
  const body = fs.readFileSync(launcher, "utf8");
  assert.match(body, /AGENT_PIPELINE_PRODUCTION_PIN/);
  assert.match(body, /AGENT_PIPELINE_FACTORY_CONTROL/);
  assert.match(body, /production-engine-pin\.json/);
  assert.match(body, /Do not invent a pin for an ordinary product repo/);
});

test("host pipeline-launcher.sh exports factory pin when unset and preserves override (#1127)", () => {
  const launcher = path.join(repoRoot, "examples/supervisor/shell/pipeline-launcher.sh");
  const body = fs.readFileSync(launcher, "utf8");
  assert.match(body, /AGENT_PIPELINE_PRODUCTION_PIN/);
  assert.match(body, /AGENT_PIPELINE_FACTORY_CONTROL/);
  assert.match(
    body,
    /export AGENT_PIPELINE_PRODUCTION_PIN="\$REPO_DIR\/\.agent-pipeline\/production-engine-pin\.json"/,
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-pin-"));
  try {
    const snippet = body.match(
      /# Factory control plane[\s\S]*?fi\nfi/,
    );
    assert.ok(snippet, "launcher factory-pin export block missing");
    const unsetRunner = path.join(dir, "unset.sh");
    fs.writeFileSync(
      unsetRunner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "unset AGENT_PIPELINE_PRODUCTION_PIN",
        'REPO_DIR="/factory/control"',
        snippet[0],
        'printf "%s" "$AGENT_PIPELINE_PRODUCTION_PIN"',
        "",
      ].join("\n"),
    );
    const unset = spawnSync("bash", [unsetRunner], { encoding: "utf8" });
    assert.equal(unset.status, 0, unset.stderr);
    assert.equal(
      unset.stdout,
      "/factory/control/.agent-pipeline/production-engine-pin.json",
    );
    const keepRunner = path.join(dir, "keep.sh");
    fs.writeFileSync(
      keepRunner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'AGENT_PIPELINE_PRODUCTION_PIN="/custom/pin.json"',
        'REPO_DIR="/factory/control"',
        snippet[0],
        'printf "%s" "$AGENT_PIPELINE_PRODUCTION_PIN"',
        "",
      ].join("\n"),
    );
    const keep = spawnSync("bash", [keepRunner], { encoding: "utf8" });
    assert.equal(keep.status, 0, keep.stderr);
    assert.equal(keep.stdout, "/custom/pin.json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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

function writeFakeGit(binDir: string, body: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const git = path.join(binDir, "git");
  fs.writeFileSync(git, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  fs.chmodSync(git, 0o755);
}

function envWithoutCandidate(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.TUGBOAT_CANDIDATE_SHA;
  return env;
}

function envWithoutBase(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = envWithoutCandidate(extra);
  delete env.TUGBOAT_BASE_BRANCH;
  return env;
}

function writePipelineYml(repoDir: string, baseBranch: string): void {
  writePipelineYmlRaw(repoDir, `base_branch: ${baseBranch} # integration branch\n`);
}

function writePipelineYmlRaw(repoDir: string, body: string): void {
  const dir = path.join(repoDir, ".github");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pipeline.yml"), body);
}

function runWriteRequest(dir: string, gitScript: string): {
  status: number | null;
  stdout: string;
  stderr: string;
  dest: string;
} {
  const binDir = path.join(dir, "bin");
  writeFakeGit(binDir, gitScript);
  const manifest = path.join(dir, "manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({ schema_version: 1, pack_id: "factory-gate-v1" }),
  );
  const dest = path.join(dir, "req.json");
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
    env: envWithoutBase({
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TUGBOAT_REPOSITORY: "accidental-hedge-fund/agent-pipeline",
      TUGBOAT_FRG_MANIFEST_PATH: manifest,
    }),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, dest };
}

test("write_factory_release_request: binds origin/<base> tip, not local HEAD", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-req-tip-"));
  try {
    const localHead = "a".repeat(40);
    const remoteTip = "b".repeat(40);
    const binDir = path.join(dir, "bin");
    const calls = path.join(dir, "git-calls.txt");
    writeFakeGit(
      binDir,
      [
        `echo "$*" >> ${JSON.stringify(calls)}`,
        'args=("$@")',
        'if [[ "${args[0]:-}" == "-C" ]]; then args=("${args[@]:2}"); fi',
        'cmd="${args[0]:-}"',
        "case \"$cmd\" in",
        "  ls-remote)",
        `    printf '%s\\t%s\\n' ${JSON.stringify(remoteTip)} refs/heads/main`,
        "    exit 0",
        "    ;;",
        "  fetch) exit 0 ;;",
        "  rev-parse)",
        '    joined="${args[*]}"',
        '    if [[ "$joined" == *origin/main* || "$joined" == *refs/remotes/origin/main* ]]; then',
        `      echo ${JSON.stringify(remoteTip)}`,
        "      exit 0",
        "    fi",
        '    if [[ "$joined" == *HEAD* ]]; then',
        `      echo ${JSON.stringify(localHead)}`,
        "      exit 0",
        "    fi",
        "    ;;",
        "esac",
        'echo "unexpected git ${args[*]}" >&2',
        "exit 1",
      ].join("\n"),
    );
    const manifest = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ schema_version: 1, pack_id: "factory-gate-v1" }),
    );
    const dest = path.join(dir, "req.json");
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
      env: envWithoutCandidate({
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        TUGBOAT_REPOSITORY: "accidental-hedge-fund/agent-pipeline",
        TUGBOAT_BASE_BRANCH: "main",
        TUGBOAT_FRG_MANIFEST_PATH: manifest,
      }),
    });
    assert.equal(r.status, 0, `writer exited ${r.status}: ${r.stderr}`);
    const req = JSON.parse(fs.readFileSync(dest, "utf8")) as {
      integrated_candidate: { git_sha: string };
    };
    assert.equal(req.integrated_candidate.git_sha, remoteTip);
    assert.notEqual(req.integrated_candidate.git_sha, localHead);
    const helperSrc = fs.readFileSync(tugboat, "utf8");
    assert.match(helperSrc, /ls-remote/);
    assert.doesNotMatch(helperSrc, /rev-parse", "HEAD"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write_factory_release_request: uses pipeline.yml base_branch not origin/HEAD", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-req-staging-"));
  try {
    const localHead = "a".repeat(40);
    const mainTip = "b".repeat(40);
    const stagingTip = "c".repeat(40);
    const binDir = path.join(dir, "bin");
    const calls = path.join(dir, "git-calls.txt");
    writePipelineYml(dir, "staging");
    writeFakeGit(
      binDir,
      [
        `echo "$*" >> ${JSON.stringify(calls)}`,
        'args=("$@")',
        'if [[ "${args[0]:-}" == "-C" ]]; then args=("${args[@]:2}"); fi',
        'cmd="${args[0]:-}"',
        "case \"$cmd\" in",
        "  symbolic-ref)",
        "    echo origin/main",
        "    exit 0",
        "    ;;",
        "  ls-remote)",
        '    joined="${args[*]}"',
        '    if [[ "$joined" == *refs/heads/staging* ]]; then',
        `      printf '%s\\t%s\\n' ${JSON.stringify(stagingTip)} refs/heads/staging`,
        "      exit 0",
        "    fi",
        '    if [[ "$joined" == *refs/heads/main* ]]; then',
        `      printf '%s\\t%s\\n' ${JSON.stringify(mainTip)} refs/heads/main`,
        "      exit 0",
        "    fi",
        "    exit 2",
        "    ;;",
        "  fetch) exit 0 ;;",
        "  rev-parse)",
        '    joined="${args[*]}"',
        '    if [[ "$joined" == *origin/staging* || "$joined" == *refs/remotes/origin/staging* ]]; then',
        `      echo ${JSON.stringify(stagingTip)}`,
        "      exit 0",
        "    fi",
        '    if [[ "$joined" == *HEAD* ]]; then',
        `      echo ${JSON.stringify(localHead)}`,
        "      exit 0",
        "    fi",
        "    ;;",
        "esac",
        'echo "unexpected git ${args[*]}" >&2',
        "exit 1",
      ].join("\n"),
    );
    const manifest = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ schema_version: 1, pack_id: "factory-gate-v1" }),
    );
    const dest = path.join(dir, "req.json");
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
      env: envWithoutBase({
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        TUGBOAT_REPOSITORY: "accidental-hedge-fund/agent-pipeline",
        TUGBOAT_FRG_MANIFEST_PATH: manifest,
      }),
    });
    assert.equal(r.status, 0, `writer exited ${r.status}: ${r.stderr}`);
    const req = JSON.parse(fs.readFileSync(dest, "utf8")) as {
      base_branch: string;
      integrated_candidate: { git_sha: string };
    };
    assert.equal(req.base_branch, "staging");
    assert.equal(req.integrated_candidate.git_sha, stagingTip);
    assert.notEqual(req.integrated_candidate.git_sha, mainTip);
    const gitCalls = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
    assert.doesNotMatch(gitCalls, /symbolic-ref/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write_factory_release_request: quoted pipeline.yml key binds staging not main", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-req-quoted-key-"));
  try {
    const mainTip = "b".repeat(40);
    const stagingTip = "c".repeat(40);
    writePipelineYmlRaw(dir, '"base_branch": staging\n');
    const r = runWriteRequest(
      dir,
      [
        'args=("$@")',
        'if [[ "${args[0]:-}" == "-C" ]]; then args=("${args[@]:2}"); fi',
        'cmd="${args[0]:-}"',
        "case \"$cmd\" in",
        "  ls-remote)",
        '    joined="${args[*]}"',
        '    if [[ "$joined" == *refs/heads/staging* ]]; then',
        `      printf '%s\\t%s\\n' ${JSON.stringify(stagingTip)} refs/heads/staging`,
        "      exit 0",
        "    fi",
        '    if [[ "$joined" == *refs/heads/main* ]]; then',
        `      printf '%s\\t%s\\n' ${JSON.stringify(mainTip)} refs/heads/main`,
        "      exit 0",
        "    fi",
        "    exit 2",
        "    ;;",
        "esac",
        'echo "unexpected git ${args[*]}" >&2',
        "exit 1",
      ].join("\n"),
    );
    assert.equal(r.status, 0, `writer exited ${r.status}: ${r.stderr}`);
    const req = JSON.parse(fs.readFileSync(r.dest, "utf8")) as {
      base_branch: string;
      integrated_candidate: { git_sha: string };
    };
    assert.equal(req.base_branch, "staging");
    assert.equal(req.integrated_candidate.git_sha, stagingTip);
    assert.notEqual(req.integrated_candidate.git_sha, mainTip);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write_factory_release_request: preserves embedded # in pipeline.yml branch name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-req-hash-"));
  try {
    const hashTip = "e".repeat(40);
    const deployTip = "f".repeat(40);
    writePipelineYmlRaw(dir, "base_branch: deploy#blue\n");
    const r = runWriteRequest(
      dir,
      [
        'args=("$@")',
        'if [[ "${args[0]:-}" == "-C" ]]; then args=("${args[@]:2}"); fi',
        'cmd="${args[0]:-}"',
        "case \"$cmd\" in",
        "  ls-remote)",
        '    joined="${args[*]}"',
        `    if [[ "$joined" == *${JSON.stringify("refs/heads/deploy#blue")}* ]]; then`,
        `      printf '%s\\t%s\\n' ${JSON.stringify(hashTip)} ${JSON.stringify("refs/heads/deploy#blue")}`,
        "      exit 0",
        "    fi",
        '    if [[ "$joined" == *refs/heads/deploy* ]]; then',
        `      printf '%s\\t%s\\n' ${JSON.stringify(deployTip)} refs/heads/deploy`,
        "      exit 0",
        "    fi",
        "    exit 2",
        "    ;;",
        "esac",
        'echo "unexpected git ${args[*]}" >&2',
        "exit 1",
      ].join("\n"),
    );
    assert.equal(r.status, 0, `writer exited ${r.status}: ${r.stderr}`);
    const req = JSON.parse(fs.readFileSync(r.dest, "utf8")) as {
      base_branch: string;
      integrated_candidate: { git_sha: string };
    };
    assert.equal(req.base_branch, "deploy#blue");
    assert.equal(req.integrated_candidate.git_sha, hashTip);
    assert.notEqual(req.base_branch, "deploy");
    assert.notEqual(req.integrated_candidate.git_sha, deployTip);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write_factory_release_request: preserves slash-containing branch names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-req-slash-"));
  try {
    const remoteTip = "d".repeat(40);
    const binDir = path.join(dir, "bin");
    writeFakeGit(
      binDir,
      [
        'args=("$@")',
        'if [[ "${args[0]:-}" == "-C" ]]; then args=("${args[@]:2}"); fi',
        'cmd="${args[0]:-}"',
        "case \"$cmd\" in",
        "  ls-remote)",
        '    joined="${args[*]}"',
        '    if [[ "$joined" == *refs/heads/release/1.39* ]]; then',
        `      printf '%s\\t%s\\n' ${JSON.stringify(remoteTip)} refs/heads/release/1.39`,
        "      exit 0",
        "    fi",
        "    exit 2",
        "    ;;",
        "esac",
        'echo "unexpected git ${args[*]}" >&2',
        "exit 1",
      ].join("\n"),
    );
    const manifest = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ schema_version: 1, pack_id: "factory-gate-v1" }),
    );
    const dest = path.join(dir, "req.json");
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
      env: envWithoutCandidate({
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        TUGBOAT_REPOSITORY: "accidental-hedge-fund/agent-pipeline",
        TUGBOAT_BASE_BRANCH: "origin/release/1.39",
        TUGBOAT_FRG_MANIFEST_PATH: manifest,
      }),
    });
    assert.equal(r.status, 0, `writer exited ${r.status}: ${r.stderr}`);
    const req = JSON.parse(fs.readFileSync(dest, "utf8")) as {
      base_branch: string;
      integrated_candidate: { git_sha: string };
    };
    assert.equal(req.base_branch, "release/1.39");
    assert.equal(req.integrated_candidate.git_sha, remoteTip);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write_factory_release_request: missing pipeline.yml and unset TUGBOAT_BASE_BRANCH fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-req-no-base-"));
  try {
    const binDir = path.join(dir, "bin");
    writeFakeGit(
      binDir,
      [
        'args=("$@")',
        'if [[ "${args[0]:-}" == "-C" ]]; then args=("${args[@]:2}"); fi',
        'cmd="${args[0]:-}"',
        "case \"$cmd\" in",
        "  symbolic-ref)",
        "    echo origin/main",
        "    exit 0",
        "    ;;",
        "esac",
        "exit 1",
      ].join("\n"),
    );
    const manifest = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ schema_version: 1, pack_id: "factory-gate-v1" }),
    );
    const dest = path.join(dir, "req.json");
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
      env: envWithoutBase({
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        TUGBOAT_REPOSITORY: "accidental-hedge-fund/agent-pipeline",
        TUGBOAT_FRG_MANIFEST_PATH: manifest,
      }),
    });
    assert.notEqual(r.status, 0, "missing base_branch source must fail closed");
    assert.match(`${r.stdout}\n${r.stderr}`, /TUGBOAT_BASE_BRANCH|pipeline\.yml|origin\/HEAD/);
    assert.equal(fs.existsSync(dest), false, "must not write a request on the wrong branch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write_factory_release_request: missing remote tip fails closed (does not use HEAD)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-req-no-tip-"));
  try {
    const localHead = "c".repeat(40);
    const binDir = path.join(dir, "bin");
    writeFakeGit(
      binDir,
      [
        'args=("$@")',
        'if [[ "${args[0]:-}" == "-C" ]]; then args=("${args[@]:2}"); fi',
        'cmd="${args[0]:-}"',
        "case \"$cmd\" in",
        "  ls-remote) exit 2 ;;",
        "  fetch) exit 1 ;;",
        "  rev-parse)",
        '    joined="${args[*]}"',
        '    if [[ "$joined" == *HEAD* ]]; then',
        `      echo ${JSON.stringify(localHead)}`,
        "      exit 0",
        "    fi",
        "    exit 1",
        "    ;;",
        "esac",
        "exit 1",
      ].join("\n"),
    );
    const manifest = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ schema_version: 1, pack_id: "factory-gate-v1" }),
    );
    const dest = path.join(dir, "req.json");
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
      env: envWithoutCandidate({
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        TUGBOAT_REPOSITORY: "accidental-hedge-fund/agent-pipeline",
        TUGBOAT_BASE_BRANCH: "main",
        TUGBOAT_FRG_MANIFEST_PATH: manifest,
      }),
    });
    assert.notEqual(r.status, 0, "missing remote tip must fail closed");
    assert.match(`${r.stdout}\n${r.stderr}`, /origin\/main tip after train|git object id/);
    if (fs.existsSync(dest)) {
      const req = JSON.parse(fs.readFileSync(dest, "utf8")) as {
        integrated_candidate?: { git_sha?: string };
      };
      assert.notEqual(req.integrated_candidate?.git_sha, localHead);
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
        'classify_frg_pack_tick "$1" "$2" "$3" "${4:-}"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const run = (
      prep: unknown,
      latest: unknown | null,
      ec: number,
      extraEnv: NodeJS.ProcessEnv = {},
      request: unknown | null = null,
    ): string => {
      const prepPath = path.join(dir, "prep.json");
      const latestPath = path.join(dir, "latest.json");
      const reqPath = path.join(dir, "request.json");
      fs.writeFileSync(prepPath, JSON.stringify(prep));
      if (latest === null) {
        if (fs.existsSync(latestPath)) fs.rmSync(latestPath);
      } else {
        fs.writeFileSync(latestPath, JSON.stringify(latest));
      }
      if (request === null) {
        if (fs.existsSync(reqPath)) fs.rmSync(reqPath);
      } else {
        fs.writeFileSync(reqPath, JSON.stringify(request));
      }
      const env = { ...process.env, ...extraEnv };
      delete env.TUGBOAT_OPEN_RELEASE_PR;
      Object.assign(env, extraEnv);
      const argv = [runner, prepPath, latestPath, String(ec)];
      if (request !== null) argv.push(reqPath);
      const r = spawnSync("bash", argv, {
        encoding: "utf8",
        env,
      });
      assert.equal(r.status, 0, `classifier exited ${r.status}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const completePrep = {
      status: "complete",
      target_version: "1.39.0",
      release_pr: { number: 12, head_oid: "a".repeat(40), base_oid: "b".repeat(40) },
    };
    const shaOld = "a".repeat(40);
    const shaNew = "b".repeat(40);
    const reqNew = {
      target_version: "1.39.0",
      action_id: "tugboat-ship-1.39.0",
      integrated_candidate: { git_sha: shaNew },
    };
    const latestFor = (sha: string, extra: Record<string, unknown> = {}) => ({
      pass: true,
      version: "1.39.0",
      pack_provenance: { candidate_git_sha: sha, release_version: "1.39.0" },
      ...extra,
    });
    assert.equal(
      run({ status: "awaiting_frg_attestation" }, null, 0),
      "attest",
    );
    assert.equal(
      run({ status: "awaiting_frg_attestation" }, latestFor(shaOld), 0, {}, reqNew),
      "attest",
    );
    assert.equal(
      run({ status: "awaiting_frg_attestation" }, latestFor(shaNew), 0, {}, reqNew),
      "done",
    );
    assert.equal(run({ status: "in_progress" }, null, 0), "retry");
    const unsignedFrg = {
      pack_id: "factory-gate-v1",
      loop_run_id: "loop-L",
      observations: { path: "/tmp/obs.json", sha256: "1".repeat(64) },
      evidence_bundle: { path: "/tmp/ev.json", sha256: "2".repeat(64) },
    };
    assert.equal(
      run(
        { status: "in_progress", loop_run_id: "loop-L", frg: unsignedFrg },
        null,
        0,
      ),
      "attest",
      "in_progress + closed unsigned frg must attest, not sleep as retry",
    );
    assert.equal(
      run(
        { status: "in_progress", loop_run_id: "loop-L", unsigned: unsignedFrg },
        null,
        0,
      ),
      "attest",
    );
    assert.equal(
      run(
        {
          status: "in_progress",
          loop_run_id: "loop-L",
          frg: {
            loop_run_id: "loop-L",
            observations: { path: "/dev/null", sha256: "0".repeat(64) },
            evidence_bundle: { path: "/dev/null", sha256: "0".repeat(64) },
          },
        },
        null,
        0,
      ),
      "retry",
      "refused placeholder frg on in_progress is not unsigned-eligible",
    );
    assert.equal(run({ status: "complete" }, null, 0), "fail");
    assert.equal(run(completePrep, null, 0), "fail");
    assert.equal(
      run(completePrep, null, 0, { TUGBOAT_OPEN_RELEASE_PR: "12" }),
      "done",
    );
    assert.equal(
      run(completePrep, { pass: false }, 0, { TUGBOAT_OPEN_RELEASE_PR: "12" }),
      "fail",
    );
    assert.equal(run({ status: "failed" }, null, 1), "fail");
    assert.equal(
      run({ status: "in_progress" }, { pass: true }, 0, {}, reqNew),
      "retry",
    );
    assert.equal(
      run({ status: "in_progress" }, latestFor(shaOld), 0, {}, reqNew),
      "retry",
    );
    assert.equal(
      run({ status: "in_progress" }, latestFor(shaNew), 0, {}, reqNew),
      "done",
    );
    assert.equal(run({ status: "complete" }, { pass: false }, 0), "fail");
    assert.equal(
      run({ status: "awaiting_frg_attestation" }, { pass: false }, 0),
      "attest",
      "unsigned eligible omitted-HMAC pass:false is attest, not fail (#1147)",
    );
    assert.equal(run({ status: "failed" }, { pass: false }, 1), "fail");
    assert.equal(
      run(
        { status: "awaiting_frg_attestation" },
        {
          pass: false,
          integrity: { attestation: { alg: "hmac-sha256-v1", mac: "a".repeat(64) } },
        },
        0,
      ),
      "fail",
      "attested HMAC pass:false remains pack-fail",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat pack phase composes factory-gate --from-run and does not finalize", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  const shipOneStart = body.indexOf("ship_one() {");
  const shipOneEnd = body.indexOf("\n# ---------- run serial multi-milestone");
  const shipOneBody = body.slice(shipOneStart, shipOneEnd);
  const packStart = shipOneBody.indexOf("A2: FRG pack");
  const releaseStart = shipOneBody.indexOf("B: release prepare");
  assert.ok(packStart >= 0 && releaseStart > packStart, "frg-pack phase missing");
  const pack = shipOneBody.slice(packStart, releaseStart);
  assert.match(pack, /factory-release prepare --request/);
  assert.match(pack, /invoke_factory_release_prepare/);
  assert.match(pack, /invoke_frg_pack_attestor/);
  assert.match(pack, /factory-gate --for \$version --from-run/);
  assert.doesNotMatch(pack, /--observations/);
  assert.doesNotMatch(pack, /"\$PIPELINE" factory-release prepare/);
  assert.match(shipOneBody, /resolve_ship_end_cli/);
  assert.match(shipOneBody, /SHIP_END_CLI/);
  assert.doesNotMatch(shipOneBody, /"\$PIPELINE" release finish/);
  assert.match(shipOneBody, /"\$PIPELINE" train --milestone/);
  assert.match(shipOneBody, /"\$PIPELINE" engine-promote --for "\$version"/);
  assert.doesNotMatch(pack, /grant[\/_]factory|factory\.mjs/);
  assert.doesNotMatch(pack, /release finish|engine-promote|git tag|gh release create/);
  assert.doesNotMatch(pack, /pass:\s*true|"pass": true/);
  assert.doesNotMatch(pack, /HMAC/);
  const stateFn = extractNamedFn(body, "write_state", "tugboat.sh");
  assert.doesNotMatch(stateFn, /PIPELINE_FRG_ATTESTATION_KEY/);
});

function writeFakePipeline(binDir: string, recordDir: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(recordDir, { recursive: true });
  const bin = path.join(binDir, "pipeline");
  const argvPath = JSON.stringify(path.join(recordDir, "argv"));
  const envPath = JSON.stringify(path.join(recordDir, "env"));
  fs.writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\n' "$@" > ${argvPath}`,
      "{",
      '  if [[ -n "${PIPELINE_FRG_ATTESTATION_KEY+x}" ]]; then',
      '    printf "KEY=%s\\n" "$PIPELINE_FRG_ATTESTATION_KEY"',
      "  else",
      '    printf "KEY_UNSET\\n"',
      "  fi",
      '  if [[ -n "${PIPELINE_FRG_ATTESTATION_KEY_FILE+x}" ]]; then',
      '    printf "KEY_FILE=%s\\n" "$PIPELINE_FRG_ATTESTATION_KEY_FILE"',
      "  else",
      '    printf "KEY_FILE_UNSET\\n"',
      "  fi",
      `} > ${envPath}`,
      "",
    ].join("\n"),
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("prepare child unsets KEY and KEY_FILE (#1133)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-prep-env-"));
  try {
    const binDir = path.join(dir, "bin");
    const recordDir = path.join(dir, "record");
    const pipeline = writeFakePipeline(binDir, recordDir);
    const req = path.join(dir, "req.json");
    const out = path.join(dir, "out.json");
    const err = path.join(dir, "err.txt");
    fs.writeFileSync(req, "{}\n");
    const keyFile = path.join(dir, "key.file");
    fs.writeFileSync(keyFile, "parent-file-secret\n");
    const fn = extractNamedFn(
      fs.readFileSync(frgHelpers, "utf8"),
      "invoke_factory_release_prepare",
      "frg-pack-helpers.sh",
    );
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        fn,
        `SHIP_END_CLI=(${JSON.stringify(pipeline)})`,
        `invoke_factory_release_prepare ${JSON.stringify(req)} ${JSON.stringify(out)} ${JSON.stringify(err)}`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PIPELINE: pipeline,
        PIPELINE_FRG_ATTESTATION_KEY: "parent-key-secret",
        PIPELINE_FRG_ATTESTATION_KEY_FILE: keyFile,
      },
    });
    assert.equal(r.status, 0, `prepare helper exited ${r.status}: ${r.stderr}`);
    const childEnv = fs.readFileSync(path.join(recordDir, "env"), "utf8");
    assert.match(childEnv, /^KEY_UNSET$/m);
    assert.match(childEnv, /^KEY_FILE_UNSET$/m);
    assert.doesNotMatch(childEnv, /parent-key-secret|parent-file-secret/);
    const argv = fs.readFileSync(path.join(recordDir, "argv"), "utf8");
    assert.match(argv, /^factory-release$/m);
    assert.match(argv, /^prepare$/m);
    assert.match(argv, /^--request$/m);
    assert.match(argv, /^--json$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attestor child presents KEY_FILE as KEY and omits --observations (#1133)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-attest-env-"));
  try {
    const binDir = path.join(dir, "bin");
    const recordDir = path.join(dir, "record");
    const pipeline = writeFakePipeline(binDir, recordDir);
    const out = path.join(dir, "out.json");
    const err = path.join(dir, "err.txt");
    const keyFile = path.join(dir, "key.file");
    const keyBody = "unit-test-frg-key-body-not-for-production";
    fs.writeFileSync(keyFile, `${keyBody}\n`);
    const fn = extractNamedFn(
      fs.readFileSync(frgHelpers, "utf8"),
      "invoke_frg_pack_attestor",
      "frg-pack-helpers.sh",
    );
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        fn,
        `SHIP_END_CLI=(${JSON.stringify(pipeline)})`,
        `invoke_frg_pack_attestor "1.39.0" "loop-L" ${JSON.stringify(out)} ${JSON.stringify(err)}`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PIPELINE: pipeline,
      PIPELINE_FRG_ATTESTATION_KEY_FILE: keyFile,
    };
    delete env.PIPELINE_FRG_ATTESTATION_KEY;
    const r = spawnSync("bash", [runner], {
      encoding: "utf8",
      env,
    });
    assert.equal(r.status, 0, `attestor helper exited ${r.status}: ${r.stderr}`);
    const childEnv = fs.readFileSync(path.join(recordDir, "env"), "utf8");
    assert.match(childEnv, new RegExp(`^KEY=${keyBody}$`, "m"));
    assert.match(childEnv, /^KEY_FILE_UNSET$/m);
    const argv = fs.readFileSync(path.join(recordDir, "argv"), "utf8").trim().split("\n");
    assert.deepEqual(argv, ["factory-gate", "--for", "1.39.0", "--from-run", "loop-L"]);
    assert.ok(!argv.includes("--observations"));
    const stray = fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((rel) => rel !== "key.file" && !rel.startsWith("record/"))
      .map((rel) => path.join(dir, rel))
      .filter((p) => fs.statSync(p).isFile())
      .filter((p) => fs.readFileSync(p, "utf8").includes(keyBody));
    assert.deepEqual(stray, [], "attestor must not persist the key body to pack files");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attestor child fails closed without producer credential (#1133)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-attest-miss-"));
  try {
    const fn = extractNamedFn(
      fs.readFileSync(frgHelpers, "utf8"),
      "invoke_frg_pack_attestor",
      "frg-pack-helpers.sh",
    );
    const err = path.join(dir, "err.txt");
    const out = path.join(dir, "out.json");
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        fn,
        'SHIP_END_CLI=("pipeline")',
        `invoke_frg_pack_attestor "1.39.0" "loop-L" ${JSON.stringify(out)} ${JSON.stringify(err)}`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const env = { ...process.env };
    delete env.PIPELINE_FRG_ATTESTATION_KEY;
    delete env.PIPELINE_FRG_ATTESTATION_KEY_FILE;
    const r = spawnSync("bash", [runner], { encoding: "utf8", env });
    assert.notEqual(r.status, 0, "missing credential must fail closed");
    assert.match(fs.readFileSync(err, "utf8"), /missing_attestor_credential/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /--skip-frg/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("classify_frg_pack_tick: unsigned eligible omitted-HMAC pass false is attest (#1147)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-tick-unsigned-"));
  try {
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `. ${JSON.stringify(frgHelpers)}`,
        'classify_frg_pack_tick "$1" "$2" "$3" "${4:-}"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const prepPath = path.join(dir, "prep.json");
    const latestPath = path.join(dir, "latest.json");
    const reqPath = path.join(dir, "request.json");
    const sha = "a949c581".padEnd(40, "0");
    fs.writeFileSync(
      prepPath,
      JSON.stringify({
        status: "awaiting_frg_attestation",
        frg: {
          pack_id: "factory-gate-v1",
          loop_run_id: "loop-c6abf57f55524c81",
          observations: { path: "/tmp/obs.json", sha256: "1".repeat(64) },
          evidence_bundle: { path: "/tmp/ev.json", sha256: "2".repeat(64) },
        },
      }),
    );
    fs.writeFileSync(
      latestPath,
      JSON.stringify({
        pass: false,
        version: "1.39.5",
        pack_id: "factory-gate-v1",
        loop_run_id: "loop-c6abf57f55524c81",
        pack_provenance: { candidate_git_sha: sha, release_version: "1.39.5" },
        integrity: { producer: "pipeline-factory-gate" },
      }),
    );
    fs.writeFileSync(
      reqPath,
      JSON.stringify({
        target_version: "1.39.5",
        integrated_candidate: { git_sha: sha },
      }),
    );
    const r = spawnSync("bash", [runner, prepPath, latestPath, "0", reqPath], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `classifier exited ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "attest");
    assert.notEqual(r.stdout.trim(), "fail");
    assert.notEqual(r.stdout.trim(), "done");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("classify_frg_pack_tick: stale signed pass:false does not fail current unsigned-eligible tick (#1147)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-tick-stale-signed-"));
  try {
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `. ${JSON.stringify(frgHelpers)}`,
        'classify_frg_pack_tick "$1" "$2" "$3" "${4:-}"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const prepPath = path.join(dir, "prep.json");
    const latestPath = path.join(dir, "latest.json");
    const reqPath = path.join(dir, "request.json");
    const shaOld = "a".repeat(40);
    const shaNew = "b".repeat(40);
    fs.writeFileSync(
      prepPath,
      JSON.stringify({
        status: "in_progress",
        loop_run_id: "loop-new",
        frg: {
          pack_id: "factory-gate-v1",
          loop_run_id: "loop-new",
          observations: { path: "/tmp/obs.json", sha256: "1".repeat(64) },
          evidence_bundle: { path: "/tmp/ev.json", sha256: "2".repeat(64) },
        },
      }),
    );
    fs.writeFileSync(
      latestPath,
      JSON.stringify({
        pass: false,
        version: "1.39.5",
        pack_provenance: {
          candidate_git_sha: shaOld,
          release_version: "1.39.5",
        },
        integrity: {
          attestation: { alg: "hmac-sha256-v1", mac: "c".repeat(64) },
        },
      }),
    );
    fs.writeFileSync(
      reqPath,
      JSON.stringify({
        target_version: "1.39.5",
        integrated_candidate: { git_sha: shaNew },
      }),
    );
    const r = spawnSync("bash", [runner, prepPath, latestPath, "0", reqPath], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `classifier exited ${r.status}: ${r.stderr}`);
    assert.equal(
      r.stdout.trim(),
      "attest",
      "stale signed pass:false latest must not fail current in_progress unsigned-eligible tick",
    );
    assert.notEqual(r.stdout.trim(), "fail");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("classify_frg_pack_tick: in_progress unsigned eligible artifacts are attest (#1133)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-tick-inprog-"));
  try {
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `. ${JSON.stringify(frgHelpers)}`,
        'classify_frg_pack_tick "$1" "$2" "$3" "${4:-}"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const prepPath = path.join(dir, "prep.json");
    const latestPath = path.join(dir, "latest.json");
    fs.writeFileSync(
      prepPath,
      JSON.stringify({
        status: "in_progress",
        loop_run_id: "loop-from-in-progress",
        frg: {
          pack_id: "factory-gate-v1",
          loop_run_id: "loop-from-in-progress",
          observations: { path: "/work/unsigned/observations.json", sha256: "a".repeat(64) },
          evidence_bundle: { path: "/work/unsigned/evidence-bundle.json", sha256: "b".repeat(64) },
        },
      }),
    );
    const r = spawnSync("bash", [runner, prepPath, latestPath, "0"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `classifier exited ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "attest");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("frg_pack_loop_run_id reads awaiting frg.loop_run_id (#1133)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-loop-id-"));
  try {
    const fn = extractNamedFn(
      fs.readFileSync(frgHelpers, "utf8"),
      "frg_pack_loop_run_id",
      "frg-pack-helpers.sh",
    );
    const prep = path.join(dir, "prep.json");
    fs.writeFileSync(
      prep,
      JSON.stringify({
        status: "awaiting_frg_attestation",
        frg: { loop_run_id: "loop-from-frg" },
        loop_run_id: "should-not-win",
      }),
    );
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        fn,
        `frg_pack_loop_run_id ${JSON.stringify(prep)}`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(r.status, 0, `loop-id helper exited ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "loop-from-frg");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("frg_pack_loop_run_id reads in_progress loop_run_id (#1133)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-loop-id-inprog-"));
  try {
    const fn = extractNamedFn(
      fs.readFileSync(frgHelpers, "utf8"),
      "frg_pack_loop_run_id",
      "frg-pack-helpers.sh",
    );
    const prep = path.join(dir, "prep.json");
    fs.writeFileSync(
      prep,
      JSON.stringify({
        status: "in_progress",
        loop_run_id: "loop-from-in-progress",
        frg: { loop_run_id: "should-not-win" },
      }),
    );
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        fn,
        `frg_pack_loop_run_id ${JSON.stringify(prep)}`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(r.status, 0, `loop-id helper exited ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "loop-from-in-progress");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("playbook is a thin launcher to repo tugboat.sh (#1151)", () => {
  const playbook = path.join(
    repoRoot,
    "examples/supervisor/shell/pipeline-ship-playbook.sh",
  );
  const body = fs.readFileSync(playbook, "utf8");
  assert.equal(isThinPlaybookLauncher(body), true);
  assert.doesNotMatch(body, /factory-release prepare/);
  assert.doesNotMatch(body, /invoke_factory_release_prepare/);
  assert.doesNotMatch(body, /"\$PIPELINE" release/);
  assert.doesNotMatch(body, /FRG_WAIT_ATTEMPTS/);
  assert.doesNotMatch(body, /RELEASE_WAIT_ATTEMPTS/);
});

function runFrgPackWaitDecision(
  tick: string,
  live: "0" | "1" | "unknown",
  attempt: number,
  cap: number,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-wait-dec-"));
  try {
    const fn = extractNamedFn(
      fs.readFileSync(frgHelpers, "utf8"),
      "frg_pack_wait_decision",
      "frg-pack-helpers.sh",
    );
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        fn,
        `frg_pack_wait_decision ${JSON.stringify(tick)} ${live} ${attempt} ${cap}`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(r.status, 0, `wait decision exited ${r.status}: ${r.stderr}`);
    return r.stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("frg_pack_wait_decision: in_progress plus live loop at cap N is continue (#1150)", () => {
  const cap = 2;
  assert.equal(runFrgPackWaitDecision("retry", "1", 1, cap), "continue");
  assert.equal(
    runFrgPackWaitDecision("retry", "1", cap, cap),
    "continue",
    "live bound loop must outlive the numeric attempt cap",
  );
  assert.equal(
    runFrgPackWaitDecision("retry", "0", cap, cap),
    "fail",
    "not-live in_progress at cap remains fail-closed",
  );
  assert.equal(
    runFrgPackWaitDecision("retry", "unknown", cap, cap),
    "continue",
    "unreadable liveness at cap must not fail-closed",
  );
  assert.equal(runFrgPackWaitDecision("retry", "0", 1, cap), "continue");
});

test("frg_pack_loop_is_live: lock pid or non-terminal ledger (#1150)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-loop-live-"));
  try {
    const fn = extractNamedFn(
      fs.readFileSync(frgHelpers, "utf8"),
      "frg_pack_loop_is_live",
      "frg-pack-helpers.sh",
    );
    const home = path.join(dir, "state");
    const liveRun = path.join(home, "runs", "loop-live");
    const deadRun = path.join(home, "runs", "loop-dead");
    const corruptRun = path.join(home, "runs", "loop-corrupt");
    const ioFailRun = path.join(home, "runs", "loop-iofail");
    fs.mkdirSync(liveRun, { recursive: true });
    fs.mkdirSync(deadRun, { recursive: true });
    fs.mkdirSync(corruptRun, { recursive: true });
    fs.mkdirSync(ioFailRun, { recursive: true });
    fs.writeFileSync(
      path.join(liveRun, "ledger.json"),
      JSON.stringify({ schema: LOOP_LEDGER_SCHEMA, run_id: "loop-live", stop: null }),
    );
    fs.writeFileSync(
      path.join(deadRun, "ledger.json"),
      JSON.stringify({
        schema: LOOP_LEDGER_SCHEMA,
        run_id: "loop-dead",
        stop: { reason: "supervisor_cycle_cap", time: "2026-08-20T00:00:00.000Z" },
      }),
    );
    fs.writeFileSync(
      path.join(deadRun, "lock.json"),
      JSON.stringify({ pid: 1_000_000_007, run_id: "loop-dead" }),
    );
    fs.writeFileSync(path.join(corruptRun, "lock.json"), "{");
    fs.mkdirSync(path.join(ioFailRun, "lock.json"));
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        fn,
        'printf "live=%s\\n" "$(frg_pack_loop_is_live loop-live)"',
        'printf "dead=%s\\n" "$(frg_pack_loop_is_live loop-dead)"',
        'printf "missing=%s\\n" "$(frg_pack_loop_is_live loop-missing)"',
        'printf "unsafe=%s\\n" "$(frg_pack_loop_is_live ../escape)"',
        'printf "corrupt=%s\\n" "$(frg_pack_loop_is_live loop-corrupt)"',
        'printf "iofail=%s\\n" "$(frg_pack_loop_is_live loop-iofail)"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_PIPELINE_STATE_HOME: home,
      },
    });
    assert.equal(r.status, 0, `liveness helper exited ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /^live=1$/m);
    assert.match(r.stdout, /^dead=0$/m);
    assert.match(r.stdout, /^missing=0$/m);
    assert.match(r.stdout, /^unsafe=0$/m);
    assert.match(r.stdout, /^corrupt=unknown$/m);
    assert.match(r.stdout, /^iofail=unknown$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("frg_pack_loop_is_live: schema-invalid or undecodable state is unknown at cap (#1150)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-loop-schema-"));
  try {
    const helpers = fs.readFileSync(frgHelpers, "utf8");
    const fnLive = extractNamedFn(helpers, "frg_pack_loop_is_live", "frg-pack-helpers.sh");
    const fnWait = extractNamedFn(helpers, "frg_pack_wait_decision", "frg-pack-helpers.sh");
    const home = path.join(dir, "state");
    const emptyLock = path.join(home, "runs", "loop-empty-lock");
    const badPid = path.join(home, "runs", "loop-bad-pid");
    const blankLedger = path.join(home, "runs", "loop-blank-ledger");
    const badStop = path.join(home, "runs", "loop-bad-stop");
    const emptyStop = path.join(home, "runs", "loop-empty-stop");
    const malformedStop = path.join(home, "runs", "loop-malformed-stop");
    const badUtf8Lock = path.join(home, "runs", "loop-bad-utf8-lock");
    const badUtf8Ledger = path.join(home, "runs", "loop-bad-utf8-ledger");
    for (const p of [emptyLock, badPid, blankLedger, badStop, emptyStop, malformedStop, badUtf8Lock, badUtf8Ledger]) {
      fs.mkdirSync(p, { recursive: true });
    }
    fs.writeFileSync(path.join(emptyLock, "lock.json"), "{}");
    fs.writeFileSync(path.join(badPid, "lock.json"), JSON.stringify({ pid: "bad" }));
    fs.writeFileSync(path.join(blankLedger, "ledger.json"), "  \n\t");
    fs.writeFileSync(path.join(badStop, "lock.json"), JSON.stringify({ pid: 1_000_000_007 }));
    fs.writeFileSync(
      path.join(badStop, "ledger.json"),
      JSON.stringify({ schema: LOOP_LEDGER_SCHEMA, run_id: "loop-bad-stop", stop: true }),
    );
    fs.writeFileSync(path.join(emptyStop, "lock.json"), JSON.stringify({ pid: 1_000_000_007 }));
    fs.writeFileSync(
      path.join(emptyStop, "ledger.json"),
      JSON.stringify({ schema: LOOP_LEDGER_SCHEMA, run_id: "loop-empty-stop", stop: {} }),
    );
    fs.writeFileSync(path.join(malformedStop, "lock.json"), JSON.stringify({ pid: 1_000_000_007 }));
    fs.writeFileSync(
      path.join(malformedStop, "ledger.json"),
      JSON.stringify({
        schema: LOOP_LEDGER_SCHEMA,
        run_id: "loop-malformed-stop",
        stop: { reason: "not-a-terminal-reason", time: "2026-08-20T00:00:00.000Z" },
      }),
    );
    fs.writeFileSync(path.join(badUtf8Lock, "lock.json"), Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
    fs.writeFileSync(path.join(badUtf8Ledger, "ledger.json"), Buffer.from([0x80, 0x81, 0x82]));
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        fnLive,
        fnWait,
        "probe_wait() {",
        '  local id=$1',
        '  local live',
        '  live=$(frg_pack_loop_is_live "$id")',
        '  printf "%s=%s\\n" "$id" "$live"',
        '  printf "%s_wait=%s\\n" "$id" "$(frg_pack_wait_decision retry "$live" 2 2)"',
        "}",
        "probe_wait loop-empty-lock",
        "probe_wait loop-bad-pid",
        "probe_wait loop-blank-ledger",
        "probe_wait loop-bad-stop",
        "probe_wait loop-empty-stop",
        "probe_wait loop-malformed-stop",
        "probe_wait loop-bad-utf8-lock",
        "probe_wait loop-bad-utf8-ledger",
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_PIPELINE_STATE_HOME: home,
      },
    });
    assert.equal(r.status, 0, `liveness helper exited ${r.status}: ${r.stderr}`);
    for (const id of [
      "loop-empty-lock",
      "loop-bad-pid",
      "loop-blank-ledger",
      "loop-bad-stop",
      "loop-empty-stop",
      "loop-malformed-stop",
      "loop-bad-utf8-lock",
      "loop-bad-utf8-ledger",
    ]) {
      assert.match(r.stdout, new RegExp(`^${id}=unknown$`, "m"), `${id} must be unknown`);
      assert.match(
        r.stdout,
        new RegExp(`^${id}_wait=continue$`, "m"),
        `${id} must wait-continue at cap`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("frg_pack_loop_is_live: explicit JSON null outstanding_ready is unknown, not terminal (#1150)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-loop-null-ready-"));
  try {
    const helpers = fs.readFileSync(frgHelpers, "utf8");
    const fnLive = extractNamedFn(helpers, "frg_pack_loop_is_live", "frg-pack-helpers.sh");
    const fnWait = extractNamedFn(helpers, "frg_pack_wait_decision", "frg-pack-helpers.sh");
    const home = path.join(dir, "state");
    const nullReady = path.join(home, "runs", "loop-null-ready");
    const omittedReady = path.join(home, "runs", "loop-omitted-ready");
    const terminalStop = {
      reason: "supervisor_cycle_cap",
      time: "2026-08-20T00:00:00.000Z",
    };
    for (const p of [nullReady, omittedReady]) {
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, "lock.json"), JSON.stringify({ pid: 1_000_000_007 }));
    }
    fs.writeFileSync(
      path.join(nullReady, "ledger.json"),
      JSON.stringify({
        schema: LOOP_LEDGER_SCHEMA,
        run_id: "loop-null-ready",
        stop: { ...terminalStop, outstanding_ready: null },
      }),
    );
    fs.writeFileSync(
      path.join(omittedReady, "ledger.json"),
      JSON.stringify({
        schema: LOOP_LEDGER_SCHEMA,
        run_id: "loop-omitted-ready",
        stop: terminalStop,
      }),
    );
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        fnLive,
        fnWait,
        "probe_wait() {",
        "  local id=$1",
        "  local live",
        '  live=$(frg_pack_loop_is_live "$id")',
        '  printf "%s=%s\\n" "$id" "$live"',
        '  printf "%s_wait=%s\\n" "$id" "$(frg_pack_wait_decision retry "$live" 2 2)"',
        "}",
        "probe_wait loop-null-ready",
        "probe_wait loop-omitted-ready",
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_PIPELINE_STATE_HOME: home,
      },
    });
    assert.equal(r.status, 0, `liveness helper exited ${r.status}: ${r.stderr}`);
    assert.match(
      r.stdout,
      /^loop-null-ready=unknown$/m,
      "explicit null outstanding_ready must be unknown, not not-live",
    );
    assert.match(
      r.stdout,
      /^loop-null-ready_wait=continue$/m,
      "explicit null outstanding_ready must wait-continue at cap",
    );
    assert.match(
      r.stdout,
      /^loop-omitted-ready=0$/m,
      "omitted outstanding_ready on a valid ledger remains a terminal stop",
    );
    assert.match(
      r.stdout,
      /^loop-omitted-ready_wait=fail$/m,
      "omitted outstanding_ready on a valid ledger at cap remains fail-closed",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("frg_pack_loop_is_live: missing or mismatched ledger identity is unknown at cap (#1150)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-loop-identity-"));
  try {
    const helpers = fs.readFileSync(frgHelpers, "utf8");
    const fnLive = extractNamedFn(helpers, "frg_pack_loop_is_live", "frg-pack-helpers.sh");
    const fnWait = extractNamedFn(helpers, "frg_pack_wait_decision", "frg-pack-helpers.sh");
    const home = path.join(dir, "state");
    const stopOnly = path.join(home, "runs", "loop-stop-only");
    const missingSchema = path.join(home, "runs", "loop-missing-schema");
    const numericSchema = path.join(home, "runs", "loop-numeric-schema");
    const mismatchedId = path.join(home, "runs", "loop-mismatched-id");
    const terminalStop = {
      reason: "supervisor_cycle_cap",
      time: "2026-08-20T00:00:00.000Z",
    };
    for (const p of [stopOnly, missingSchema, numericSchema, mismatchedId]) {
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, "lock.json"), JSON.stringify({ pid: 1_000_000_007 }));
    }
    fs.writeFileSync(
      path.join(stopOnly, "ledger.json"),
      JSON.stringify({ stop: terminalStop }),
    );
    fs.writeFileSync(
      path.join(missingSchema, "ledger.json"),
      JSON.stringify({ run_id: "loop-missing-schema", stop: terminalStop }),
    );
    fs.writeFileSync(
      path.join(numericSchema, "ledger.json"),
      JSON.stringify({ schema: 1, run_id: "loop-numeric-schema", stop: terminalStop }),
    );
    fs.writeFileSync(
      path.join(mismatchedId, "ledger.json"),
      JSON.stringify({
        schema: LOOP_LEDGER_SCHEMA,
        run_id: "other-loop",
        stop: terminalStop,
      }),
    );
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        fnLive,
        fnWait,
        "probe_wait() {",
        "  local id=$1",
        "  local live",
        '  live=$(frg_pack_loop_is_live "$id")',
        '  printf "%s=%s\\n" "$id" "$live"',
        '  printf "%s_wait=%s\\n" "$id" "$(frg_pack_wait_decision retry "$live" 2 2)"',
        "}",
        "probe_wait loop-stop-only",
        "probe_wait loop-missing-schema",
        "probe_wait loop-numeric-schema",
        "probe_wait loop-mismatched-id",
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_PIPELINE_STATE_HOME: home,
      },
    });
    assert.equal(r.status, 0, `liveness helper exited ${r.status}: ${r.stderr}`);
    for (const id of [
      "loop-stop-only",
      "loop-missing-schema",
      "loop-numeric-schema",
      "loop-mismatched-id",
    ]) {
      assert.match(r.stdout, new RegExp(`^${id}=unknown$`, "m"), `${id} must be unknown`);
      assert.match(
        r.stdout,
        new RegExp(`^${id}_wait=continue$`, "m"),
        `${id} must wait-continue at cap`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat FRG wait: live in_progress is not pack-fail and heartbeats (#1150)", () => {
  const src = fs.readFileSync(tugboat, "utf8");
  const packStart = src.indexOf("# ----- A2: FRG pack");
  const packEnd = src.indexOf("# ----- B: release prepare");
  assert.ok(packStart >= 0 && packEnd > packStart, "FRG pack phase block missing");
  const pack = src.slice(packStart, packEnd);
  assert.match(pack, /frg_pack_wait_decision/);
  assert.match(pack, /frg_pack_loop_is_live/);
  assert.match(pack, /write_state "frg-pack" "running".*in_progress wait tick/);
  assert.match(pack, /phase frg-pack: heartbeat in_progress/);
  assert.match(pack, /while \[\[ "\$pack_done" -ne 1 \]\]/);
  assert.doesNotMatch(pack, /for i in \$\(seq 1 "\$FRG_WAIT_ATTEMPTS"\)/);
  assert.match(
    pack,
    /wait_decision.*"fail"[\s\S]*FRG pack still in_progress within wait budget/,
  );
  assert.doesNotMatch(pack, /kill .*loop/i);
  assert.doesNotMatch(
    src,
    /FRG_WAIT_ATTEMPTS="\$\{FRG_WAIT_ATTEMPTS:-\$RELEASE_WAIT_ATTEMPTS\}"[\s\S]{0,400}for i in \$\(seq 1 "\$FRG_WAIT_ATTEMPTS"\)/,
  );
});

function installCandidateComposer(candRoot: string): void {
  const dest = path.join(candRoot, "examples/supervisor/shell");
  fs.mkdirSync(dest, { recursive: true });
  for (const name of [
    "tugboat.sh",
    "release-checks-green.py",
    "train-status-complete.py",
    "ship-notify.sh",
  ]) {
    const src = path.join(repoRoot, "examples/supervisor/shell", name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, name));
  }
}

test("tugboat after train-complete records candidate argv not pin argv (#1151)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-ship-end-"));
  try {
    const sha = "c".repeat(40);
    const pinDir = path.join(dir, "pin-bin");
    const pinRecord = path.join(dir, "pin-record");
    const candRoot = path.join(dir, "candidate");
    const candRecord = path.join(dir, "cand-record");
    fs.mkdirSync(path.join(candRoot, "core/scripts"), { recursive: true });
    fs.mkdirSync(path.join(candRoot, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(candRoot, "core/scripts/pipeline.ts"), "// candidate\n");
    installCandidateComposer(candRoot);
    const launcher = path.join(candRoot, "scripts/pipeline-launcher.mjs");
    fs.writeFileSync(
      launcher,
      [
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        `const rec = ${JSON.stringify(candRecord)};`,
        "appendFileSync(rec + '/argv', process.argv.slice(2).join('\\n') + '\\n---\\n');",
        "const envLines = [];",
        "envLines.push(process.env.PIPELINE_FRG_ATTESTATION_KEY === undefined ? 'KEY_UNSET' : 'KEY=' + process.env.PIPELINE_FRG_ATTESTATION_KEY);",
        "envLines.push(process.env.PIPELINE_FRG_ATTESTATION_KEY_FILE === undefined ? 'KEY_FILE_UNSET' : 'KEY_FILE=' + process.env.PIPELINE_FRG_ATTESTATION_KEY_FILE);",
        "writeFileSync(rec + '/env', envLines.join('\\n') + '\\n');",
        "if (process.argv.includes('factory-release')) {",
        "  process.stdout.write(JSON.stringify({ status: 'complete', release_pr: { number: 12 } }) + '\\n');",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    fs.mkdirSync(candRecord, { recursive: true });
    const pin = writeFakePipeline(pinDir, pinRecord);
    fs.writeFileSync(
      pin,
      fs.readFileSync(pin, "utf8") +
        [
          'if [[ "$1" == "train" ]]; then',
          "  printf '%s\\n' '{\"schema_version\":1,\"kind\":\"train_status\",\"complete\":true}'",
          "  exit 0",
          "fi",
          'if [[ "$1" == "--version" ]]; then echo 1.39.4; exit 0; fi',
          'echo "PIN_RELEASE" >&2; exit 2',
          "",
        ].join("\n"),
    );
    const gitBin = path.join(dir, "git");
    fs.writeFileSync(
      gitBin,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'cwd=""',
        'if [[ "${1:-}" == "-C" ]]; then cwd=$2; shift 2; fi',
        'if [[ "${1:-}" == "rev-parse" ]]; then',
        `  if [[ "$cwd" == ${JSON.stringify(candRoot)} ]]; then echo ${sha}; exit 0; fi`,
        "  echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; exit 0",
        "fi",
        'if [[ "${1:-}" == "status" ]]; then exit 0; fi',
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(gitBin, 0o755);
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "core/scripts/frg-packs/factory-gate-v1"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "core/scripts/frg-packs/factory-gate-v1/manifest.json"),
      JSON.stringify({ schema_version: 1, pack_id: "factory-gate-v1" }),
    );
    const state = path.join(dir, "state");
    const r = spawnSync("bash", [tugboat, "--milestone", "v1.39.5"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${pinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PIPELINE: pin,
        REPO_DIR: repo,
        ALLOW_MERGE: "1",
        SHIP_NOTIFY: "0",
        PIPELINE_SUPERVISOR_STATE: state,
        PIPELINE_CANDIDATE_ENGINE_ROOT: candRoot,
        TUGBOAT_CANDIDATE_SHA: sha,
        TUGBOAT_REPOSITORY: "accidental-hedge-fund/agent-pipeline",
        TUGBOAT_BASE_BRANCH: "main",
        TUGBOAT_OPEN_RELEASE_PR: "12",
        SHIP_END_NODE: process.execPath,
        FRG_WAIT_ATTEMPTS: "1",
        RELEASE_WAIT_ATTEMPTS: "1",
        RELEASE_WAIT_SLEEP_S: "0",
        FRG_WAIT_SLEEP_S: "0",
      },
    });
    const candArgv = fs.existsSync(path.join(candRecord, "argv"))
      ? fs.readFileSync(path.join(candRecord, "argv"), "utf8")
      : "";
    assert.match(candArgv, /factory-release/);
    assert.doesNotMatch(candArgv, /train/);
    const pinArgv = fs.existsSync(path.join(pinRecord, "argv"))
      ? fs.readFileSync(path.join(pinRecord, "argv"), "utf8")
      : "";
    assert.match(pinArgv, /train/);
    assert.doesNotMatch(pinArgv, /factory-release/);
    const candEnv = fs.existsSync(path.join(candRecord, "env"))
      ? fs.readFileSync(path.join(candRecord, "env"), "utf8")
      : "";
    assert.match(candEnv, /KEY_UNSET/);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /PIN_RELEASE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeTugboatFrgFixture(dir: string, opts: {
  launcherBody: string[];
}): { sha: string; candRoot: string; candRecord: string; repo: string; state: string; pin: string } {
  const sha = "c".repeat(40);
  const pinDir = path.join(dir, "pin-bin");
  const pinRecord = path.join(dir, "pin-record");
  const candRoot = path.join(dir, "candidate");
  const candRecord = path.join(dir, "cand-record");
  fs.mkdirSync(path.join(candRoot, "core/scripts"), { recursive: true });
  fs.mkdirSync(path.join(candRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(candRoot, "core/scripts/pipeline.ts"), "// candidate\n");
  installCandidateComposer(candRoot);
  const launcher = path.join(candRoot, "scripts/pipeline-launcher.mjs");
  fs.writeFileSync(launcher, opts.launcherBody.join("\n"));
  fs.mkdirSync(candRecord, { recursive: true });
  const pin = writeFakePipeline(pinDir, pinRecord);
  fs.writeFileSync(
    pin,
    fs.readFileSync(pin, "utf8") +
      [
        'if [[ "$1" == "train" ]]; then',
        "  printf '%s\\n' '{\"schema_version\":1,\"kind\":\"train_status\",\"complete\":true}'",
        "  exit 0",
        "fi",
        'if [[ "$1" == "--version" ]]; then echo 1.39.4; exit 0; fi',
        'echo "PIN_RELEASE" >&2; exit 2',
        "",
      ].join("\n"),
  );
  const gitBin = path.join(dir, "git");
  fs.writeFileSync(
    gitBin,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'cwd=""',
      'if [[ "${1:-}" == "-C" ]]; then cwd=$2; shift 2; fi',
      'if [[ "${1:-}" == "rev-parse" ]]; then',
      `  if [[ "$cwd" == ${JSON.stringify(candRoot)} ]]; then echo ${sha}; exit 0; fi`,
      "  echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; exit 0",
      "fi",
      'if [[ "${1:-}" == "status" ]]; then exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  fs.chmodSync(gitBin, 0o755);
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "core/scripts/frg-packs/factory-gate-v1"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "core/scripts/frg-packs/factory-gate-v1/manifest.json"),
    JSON.stringify({ schema_version: 1, pack_id: "factory-gate-v1" }),
  );
  return {
    sha,
    candRoot,
    candRecord,
    repo,
    state: path.join(dir, "state"),
    pin,
  };
}

test("tugboat live in_progress at cap 1 keeps ticking prepare (#1150)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-live-wait-"));
  try {
    const loopHome = path.join(dir, "loop-home");
    const loopRun = path.join(loopHome, "runs", "loop-live");
    fs.mkdirSync(loopRun, { recursive: true });
    fs.writeFileSync(
      path.join(loopRun, "ledger.json"),
      JSON.stringify({ schema: LOOP_LEDGER_SCHEMA, run_id: "loop-live", stop: null }),
    );
    const ticksPath = path.join(dir, "prepare-ticks");
    const fx = writeTugboatFrgFixture(dir, {
      launcherBody: [
        "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
        `const rec = ${JSON.stringify(path.join(dir, "cand-record"))};`,
        `const ticksPath = ${JSON.stringify(ticksPath)};`,
        "appendFileSync(rec + '/argv', process.argv.slice(2).join('\\n') + '\\n---\\n');",
        "if (process.argv.includes('factory-release')) {",
        "  let n = 0;",
        "  try { n = Number(readFileSync(ticksPath, 'utf8')); } catch {}",
        "  n += 1;",
        "  writeFileSync(ticksPath, String(n));",
        "  if (n === 1) {",
        "    process.stdout.write(JSON.stringify({ status: 'in_progress', loop_run_id: 'loop-live' }) + '\\n');",
        "  } else {",
        "    process.stdout.write(JSON.stringify({ status: 'complete', release_pr: { number: 12 } }) + '\\n');",
        "  }",
        "}",
        "process.exit(0);",
        "",
      ],
    });
    const r = spawnSync("bash", [tugboat, "--milestone", "v1.39.5"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${path.dirname(fx.pin)}${path.delimiter}${process.env.PATH ?? ""}`,
        PIPELINE: fx.pin,
        REPO_DIR: fx.repo,
        ALLOW_MERGE: "1",
        SHIP_NOTIFY: "0",
        PIPELINE_SUPERVISOR_STATE: fx.state,
        PIPELINE_CANDIDATE_ENGINE_ROOT: fx.candRoot,
        TUGBOAT_CANDIDATE_SHA: fx.sha,
        TUGBOAT_REPOSITORY: "accidental-hedge-fund/agent-pipeline",
        TUGBOAT_BASE_BRANCH: "main",
        TUGBOAT_OPEN_RELEASE_PR: "12",
        SHIP_END_NODE: process.execPath,
        AGENT_PIPELINE_STATE_HOME: loopHome,
        FRG_WAIT_ATTEMPTS: "1",
        RELEASE_WAIT_ATTEMPTS: "1",
        RELEASE_WAIT_SLEEP_S: "0",
        FRG_WAIT_SLEEP_S: "0",
      },
    });
    const log = fs.readFileSync(path.join(fx.state, "ship-v1.39.5", "playbook.log"), "utf8");
    const stateJson = JSON.parse(
      fs.readFileSync(path.join(fx.state, "ship-v1.39.5", "state.json"), "utf8"),
    ) as { phase: string; status: string; detail?: string };
    const ticks = Number(fs.readFileSync(ticksPath, "utf8"));
    assert.equal(ticks, 2, "live wait at cap 1 must re-invoke prepare");
    assert.match(log, /heartbeat in_progress/);
    assert.match(log, /phase frg-pack: pack-done/);
    assert.doesNotMatch(log, /FRG pack still in_progress within wait budget/);
    assert.doesNotMatch(stateJson.detail ?? "", /still in_progress within wait budget/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}\n${log}`, /FRG pack still in_progress within wait budget/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat not-live in_progress at cap 1 fails closed (#1150)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-dead-wait-"));
  try {
    const ticksPath = path.join(dir, "prepare-ticks");
    const fx = writeTugboatFrgFixture(dir, {
      launcherBody: [
        "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
        `const rec = ${JSON.stringify(path.join(dir, "cand-record"))};`,
        `const ticksPath = ${JSON.stringify(ticksPath)};`,
        "appendFileSync(rec + '/argv', process.argv.slice(2).join('\\n') + '\\n---\\n');",
        "if (process.argv.includes('factory-release')) {",
        "  let n = 0;",
        "  try { n = Number(readFileSync(ticksPath, 'utf8')); } catch {}",
        "  n += 1;",
        "  writeFileSync(ticksPath, String(n));",
        "  process.stdout.write(JSON.stringify({ status: 'in_progress', loop_run_id: 'loop-dead' }) + '\\n');",
        "}",
        "process.exit(0);",
        "",
      ],
    });
    const r = spawnSync("bash", [tugboat, "--milestone", "v1.39.5"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${path.dirname(fx.pin)}${path.delimiter}${process.env.PATH ?? ""}`,
        PIPELINE: fx.pin,
        REPO_DIR: fx.repo,
        ALLOW_MERGE: "1",
        SHIP_NOTIFY: "0",
        PIPELINE_SUPERVISOR_STATE: fx.state,
        PIPELINE_CANDIDATE_ENGINE_ROOT: fx.candRoot,
        TUGBOAT_CANDIDATE_SHA: fx.sha,
        TUGBOAT_REPOSITORY: "accidental-hedge-fund/agent-pipeline",
        TUGBOAT_BASE_BRANCH: "main",
        TUGBOAT_OPEN_RELEASE_PR: "12",
        SHIP_END_NODE: process.execPath,
        AGENT_PIPELINE_STATE_HOME: path.join(dir, "empty-loop-home"),
        FRG_WAIT_ATTEMPTS: "1",
        RELEASE_WAIT_ATTEMPTS: "1",
        RELEASE_WAIT_SLEEP_S: "0",
        FRG_WAIT_SLEEP_S: "0",
      },
    });
    const log = fs.existsSync(path.join(fx.state, "ship-v1.39.5", "playbook.log"))
      ? fs.readFileSync(path.join(fx.state, "ship-v1.39.5", "playbook.log"), "utf8")
      : `${r.stdout}\n${r.stderr}`;
    const stateJson = JSON.parse(
      fs.readFileSync(path.join(fx.state, "ship-v1.39.5", "state.json"), "utf8"),
    ) as { phase: string; status: string };
    assert.notEqual(r.status, 0);
    assert.match(log, /FRG pack still in_progress within wait budget/);
    assert.equal(stateJson.phase, "frg-pack");
    assert.equal(stateJson.status, "failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat fails closed when candidate engine is unavailable (#1151)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-no-cand-"));
  try {
    const pinDir = path.join(dir, "pin-bin");
    const pinRecord = path.join(dir, "pin-record");
    const pin = writeFakePipeline(pinDir, pinRecord);
    fs.appendFileSync(
      pin,
      [
        'if [[ "$1" == "train" ]]; then',
        "  printf '%s\\n' '{\"schema_version\":1,\"kind\":\"train_status\",\"complete\":true}'",
        "  exit 0",
        "fi",
        "",
      ].join("\n"),
    );
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "core/scripts/frg-packs/factory-gate-v1"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "core/scripts/frg-packs/factory-gate-v1/manifest.json"),
      JSON.stringify({ schema_version: 1, pack_id: "factory-gate-v1" }),
    );
    const r = spawnSync("bash", [tugboat, "--milestone", "v1.39.5"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${pinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PIPELINE: pin,
        REPO_DIR: repo,
        ALLOW_MERGE: "1",
        SHIP_NOTIFY: "0",
        PIPELINE_SUPERVISOR_STATE: path.join(dir, "state"),
        TUGBOAT_CANDIDATE_SHA: "c".repeat(40),
        TUGBOAT_REPOSITORY: "accidental-hedge-fund/agent-pipeline",
        TUGBOAT_BASE_BRANCH: "main",
      },
    });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /candidate-engine identity defect|cannot resolve candidate engine/);
    const pinArgv = fs.existsSync(path.join(pinRecord, "argv"))
      ? fs.readFileSync(path.join(pinRecord, "argv"), "utf8")
      : "";
    assert.doesNotMatch(pinArgv, /factory-release/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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

function tugboatShipOneBody(): string {
  const body = fs.readFileSync(tugboat, "utf8");
  const shipOneStart = body.indexOf("ship_one() {");
  const shipOneEnd = body.indexOf("\n# ---------- run serial multi-milestone");
  assert.ok(shipOneStart >= 0 && shipOneEnd > shipOneStart);
  return body.slice(shipOneStart, shipOneEnd);
}

test("tugboat post-finish path invokes ensure-tag before wait-release (#1149)", () => {
  const shipOneBody = tugboatShipOneBody();
  const finishOk = shipOneBody.indexOf('write_state "release-finish" "ok"');
  const ensure = shipOneBody.indexOf("invoke_release_ensure_tag");
  const wait = shipOneBody.indexOf('write_state "wait-release" "running"');
  assert.ok(finishOk >= 0, "release-finish ok write missing");
  assert.ok(
    ensure > finishOk,
    "candidate release ensure-tag must run after release finish",
  );
  assert.ok(wait > ensure, "wait-release must run after ensure-tag");
  assert.match(shipOneBody, /invoke_release_ensure_tag "\$version"/);
  assert.doesNotMatch(shipOneBody, /\bgit tag\b/);
  assert.doesNotMatch(shipOneBody, /gh release create/);
  const packStart = shipOneBody.indexOf("A2: FRG pack");
  const releaseStart = shipOneBody.indexOf("B: release prepare");
  const pack = shipOneBody.slice(packStart, releaseStart);
  assert.doesNotMatch(pack, /ensure-tag/);
});

test("playbook stays a thin launcher and does not shell git tag (#1149)", () => {
  const playbook = fs.readFileSync(
    path.join(repoRoot, "examples/supervisor/shell/pipeline-ship-playbook.sh"),
    "utf8",
  );
  assert.equal(isThinPlaybookLauncher(playbook), true);
  assert.match(playbook, /tugboat\.sh/);
  const executable = playbook
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(executable, /\bgit tag\b/);
  assert.doesNotMatch(executable, /gh release create/);
});

test("tugboat ensure-tag helper: pack-done merge invokes candidate ensure-tag (#1149)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-ensure-tag-"));
  try {
    const binDir = path.join(dir, "bin");
    const recordPath = path.join(dir, "cli.log");
    fs.mkdirSync(binDir, { recursive: true });
    const cli = path.join(binDir, "pipeline");
    fs.writeFileSync(
      cli,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$@" >> ${JSON.stringify(recordPath)}`,
        `printf -- '---\\n' >> ${JSON.stringify(recordPath)}`,
        'if [[ "${1:-}" == "release" && "${2:-}" == "ensure-tag" ]]; then',
        `  exit "\${ENSURE_TAG_EXIT:-0}"`,
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(cli, 0o755);
    const gh = path.join(binDir, "gh");
    fs.writeFileSync(
      gh,
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" >> ${JSON.stringify(path.join(dir, "gh.log"))}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(gh, 0o755);

    const packed = "a".repeat(40);
    const merge = "c".repeat(40);
    const finishJson = path.join(dir, "release-finish.json");
    fs.writeFileSync(
      finishJson,
      JSON.stringify({
        schema_version: 1,
        kind: "release_finish",
        mergeCommitOid: merge,
      }),
    );
    const src = fs.readFileSync(tugboat, "utf8");
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        extractNamedFn(src, "is_exact_git_sha", "tugboat.sh"),
        extractNamedFn(src, "read_merge_commit_oid_from_finish_json", "tugboat.sh"),
        extractNamedFn(src, "invoke_release_ensure_tag", "tugboat.sh"),
        `SHIP_END_CLI=(${JSON.stringify(cli)})`,
        `SHIP_END_CANDIDATE_SHA=${JSON.stringify(packed)}`,
        `REPO_DIR=${JSON.stringify(dir)}`,
        `invoke_release_ensure_tag "1.39.5" ${JSON.stringify(finishJson)}`,
        'gh release view "v1.39.5"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PIPELINE_FRG_ATTESTATION_KEY: "unit-test-ensure-tag-key-not-for-production",
      },
    });
    assert.equal(r.status, 0, `ensure-tag helper exited ${r.status}: ${r.stderr}`);
    const argv = fs.readFileSync(recordPath, "utf8");
    assert.match(argv, /^release\nensure-tag\n1\.39\.5\n/);
    assert.match(argv, new RegExp(`^${merge}$`, "m"));
    assert.match(argv, /^--packed-candidate$/m);
    assert.match(argv, new RegExp(`^${packed}$`, "m"));
    assert.match(argv, /^--repo-path$/m);
    assert.match(argv, new RegExp(`^${dir}$`, "m"));
    assert.match(fs.readFileSync(path.join(dir, "gh.log"), "utf8"), /release\nview/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat ensure-tag helper: missing mergeCommitOid fails before gh release view (#1149)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-ensure-tag-miss-"));
  try {
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const gh = path.join(binDir, "gh");
    fs.writeFileSync(
      gh,
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" >> ${JSON.stringify(path.join(dir, "gh.log"))}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(gh, 0o755);
    const finishJson = path.join(dir, "release-finish.json");
    fs.writeFileSync(finishJson, JSON.stringify({ kind: "release_finish" }));
    const src = fs.readFileSync(tugboat, "utf8");
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        extractNamedFn(src, "is_exact_git_sha", "tugboat.sh"),
        extractNamedFn(src, "read_merge_commit_oid_from_finish_json", "tugboat.sh"),
        extractNamedFn(src, "invoke_release_ensure_tag", "tugboat.sh"),
        'SHIP_END_CLI=("pipeline")',
        `SHIP_END_CANDIDATE_SHA=${JSON.stringify("a".repeat(40))}`,
        `REPO_DIR=${JSON.stringify(dir)}`,
        `invoke_release_ensure_tag "1.39.5" ${JSON.stringify(finishJson)}`,
        'gh release view "v1.39.5"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    assert.notEqual(r.status, 0, "missing mergeCommitOid must fail closed");
    assert.equal(fs.existsSync(path.join(dir, "gh.log")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat ensure-tag helper: non-zero ensure-tag prevents wait-release (#1149)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-ensure-tag-fail-"));
  try {
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const cli = path.join(binDir, "pipeline");
    fs.writeFileSync(
      cli,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "exit 7",
        "",
      ].join("\n"),
    );
    fs.chmodSync(cli, 0o755);
    const gh = path.join(binDir, "gh");
    fs.writeFileSync(
      gh,
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" >> ${JSON.stringify(path.join(dir, "gh.log"))}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(gh, 0o755);
    const finishJson = path.join(dir, "release-finish.json");
    fs.writeFileSync(
      finishJson,
      JSON.stringify({ mergeCommitOid: "c".repeat(40) }),
    );
    const src = fs.readFileSync(tugboat, "utf8");
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        extractNamedFn(src, "is_exact_git_sha", "tugboat.sh"),
        extractNamedFn(src, "read_merge_commit_oid_from_finish_json", "tugboat.sh"),
        extractNamedFn(src, "invoke_release_ensure_tag", "tugboat.sh"),
        `SHIP_END_CLI=(${JSON.stringify(cli)})`,
        `SHIP_END_CANDIDATE_SHA=${JSON.stringify("a".repeat(40))}`,
        `REPO_DIR=${JSON.stringify(dir)}`,
        `invoke_release_ensure_tag "1.39.5" ${JSON.stringify(finishJson)}`,
        'gh release view "v1.39.5"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PIPELINE_FRG_ATTESTATION_KEY: "unit-test-ensure-tag-key-not-for-production",
      },
    });
    assert.equal(r.status, 7, `expected ensure-tag exit 7, got ${r.status}: ${r.stderr}`);
    assert.equal(fs.existsSync(path.join(dir, "gh.log")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat resolve_ship_end_node skips PATH node 22 for a later node 24 (#1162)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-node24-"));
  try {
    const bin22 = path.join(dir, "n22");
    const bin24 = path.join(dir, "n24");
    fs.mkdirSync(bin22);
    fs.mkdirSync(bin24);
    const writeNode = (file: string, major: string) => {
      fs.writeFileSync(
        file,
        ["#!/usr/bin/env bash", `if [[ "$1" == "-p" ]]; then echo ${major}; exit 0; fi`, "exit 0", ""].join("\n"),
      );
      fs.chmodSync(file, 0o755);
    };
    writeNode(path.join(bin22, "node"), "22");
    writeNode(path.join(bin24, "node"), "24");
    const src = fs.readFileSync(tugboat, "utf8");
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "SHIP_END_NODE=",
        extractNamedFn(src, "resolve_ship_end_node", "tugboat.sh"),
        "resolve_ship_end_node",
        'printf "%s" "$SHIP_END_NODE"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("/bin/bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin22}${path.delimiter}${bin24}${path.delimiter}${process.env.PATH ?? "/usr/bin"}`,
        SHIP_END_NODE: "",
      },
    });
    assert.equal(r.status, 0, `resolve_ship_end_node exited ${r.status}: ${r.stderr}\n${r.error ?? ""}`);
    assert.equal(r.stdout, path.join(bin24, "node"));
    assert.match(r.stderr, /ship-end-node: .*n24\/node \(major=24\)/);
    assert.doesNotMatch(r.stdout, /n22/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat ensure-tag argv requires --repo-path (#1163)", () => {
  const src = fs.readFileSync(tugboat, "utf8");
  const fn = extractNamedFn(src, "invoke_release_ensure_tag", "tugboat.sh");
  assert.match(fn, /--repo-path "\$REPO_DIR"/);
  assert.match(fn, /REPO_DIR required for release ensure-tag --repo-path/);
});

function writeEnsureTagFinishJson(dir: string, mergeOid = "c".repeat(40)): string {
  const finishJson = path.join(dir, "release-finish.json");
  fs.writeFileSync(
    finishJson,
    JSON.stringify({
      schema_version: 1,
      kind: "release_finish",
      mergeCommitOid: mergeOid,
    }),
  );
  return finishJson;
}

function extractEnsureTagStack(src: string): string {
  return [
    extractNamedFn(src, "is_exact_git_sha", "tugboat.sh"),
    extractNamedFn(src, "read_merge_commit_oid_from_finish_json", "tugboat.sh"),
    extractNamedFn(src, "invoke_release_ensure_tag", "tugboat.sh"),
  ].join("\n");
}

function spawnEnsureTagHelper(opts: {
  dir: string;
  env: NodeJS.ProcessEnv;
}): {
  status: number | null;
  stdout: string;
  stderr: string;
  recordDir: string;
  argvPath: string;
  envPath: string;
  finishJson: string;
} {
  const binDir = path.join(opts.dir, "bin");
  const recordDir = path.join(opts.dir, "record");
  const pipeline = writeFakePipeline(binDir, recordDir);
  const packed = "a".repeat(40);
  const finishJson = writeEnsureTagFinishJson(opts.dir);
  const src = fs.readFileSync(tugboat, "utf8");
  const runner = path.join(opts.dir, "run.sh");
  fs.writeFileSync(
    runner,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractEnsureTagStack(src),
      `SHIP_END_CLI=(${JSON.stringify(pipeline)})`,
      `SHIP_END_CANDIDATE_SHA=${JSON.stringify(packed)}`,
      `REPO_DIR=${JSON.stringify(opts.dir)}`,
      `invoke_release_ensure_tag "1.39.6" ${JSON.stringify(finishJson)}`,
      'printf "PARENT_KEY_FILE=%s\\n" "${PIPELINE_FRG_ATTESTATION_KEY_FILE-UNSET}"',
      'printf "PARENT_KEY=%s\\n" "${PIPELINE_FRG_ATTESTATION_KEY-UNSET}"',
      "",
    ].join("\n"),
  );
  fs.chmodSync(runner, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    PIPELINE: pipeline,
  };
  if (!Object.prototype.hasOwnProperty.call(opts.env, "PIPELINE_FRG_ATTESTATION_KEY")) {
    delete env.PIPELINE_FRG_ATTESTATION_KEY;
  }
  if (!Object.prototype.hasOwnProperty.call(opts.env, "PIPELINE_FRG_ATTESTATION_KEY_FILE")) {
    delete env.PIPELINE_FRG_ATTESTATION_KEY_FILE;
  }
  const r = spawnSync("bash", [runner], { encoding: "utf8", env });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    recordDir,
    argvPath: path.join(recordDir, "argv"),
    envPath: path.join(recordDir, "env"),
    finishJson,
  };
}

function assertEnsureTagDidNotSpawn(argvPath: string, envPath: string): void {
  assert.equal(fs.existsSync(argvPath), false, "must not spawn release ensure-tag");
  assert.equal(fs.existsSync(envPath), false, "must not spawn the ship-end CLI");
}

test("ensure-tag and attestor children present KEY_FILE as KEY (#1174)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-hmac-key-file-"));
  try {
    const src = fs.readFileSync(tugboat, "utf8");
    const attestorFn = extractNamedFn(src, "invoke_frg_pack_attestor", "tugboat.sh");
    const keyFile = path.join(dir, "key.file");
    const keyBody = "dummy-key";
    fs.writeFileSync(keyFile, keyBody);
    const attestBin = path.join(dir, "attest-bin");
    const attestRecord = path.join(dir, "attest-record");
    const attestCli = writeFakePipeline(attestBin, attestRecord);
    const ensureBin = path.join(dir, "ensure-bin");
    const ensureRecord = path.join(dir, "ensure-record");
    const ensureCli = writeFakePipeline(ensureBin, ensureRecord);
    const attestOut = path.join(dir, "attest-out.json");
    const attestErr = path.join(dir, "attest-err.txt");
    const packed = "a".repeat(40);
    const merge = "c".repeat(40);
    const finishJson = writeEnsureTagFinishJson(dir, merge);
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        attestorFn,
        extractEnsureTagStack(src),
        `SHIP_END_CLI=(${JSON.stringify(attestCli)})`,
        `invoke_frg_pack_attestor "1.39.6" "loop-L" ${JSON.stringify(attestOut)} ${JSON.stringify(attestErr)}`,
        `SHIP_END_CLI=(${JSON.stringify(ensureCli)})`,
        `SHIP_END_CANDIDATE_SHA=${JSON.stringify(packed)}`,
        `REPO_DIR=${JSON.stringify(dir)}`,
        `invoke_release_ensure_tag "1.39.6" ${JSON.stringify(finishJson)}`,
        'printf "PARENT_KEY_FILE=%s\\n" "${PIPELINE_FRG_ATTESTATION_KEY_FILE-UNSET}"',
        'printf "PARENT_KEY=%s\\n" "${PIPELINE_FRG_ATTESTATION_KEY-UNSET}"',
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${attestBin}${path.delimiter}${ensureBin}${path.delimiter}${process.env.PATH ?? ""}`,
      PIPELINE_FRG_ATTESTATION_KEY_FILE: keyFile,
    };
    delete env.PIPELINE_FRG_ATTESTATION_KEY;
    const r = spawnSync("bash", [runner], { encoding: "utf8", env });
    assert.equal(r.status, 0, `hmac helpers exited ${r.status}: ${r.stderr}`);
    const attestEnv = fs.readFileSync(path.join(attestRecord, "env"), "utf8");
    const ensureEnv = fs.readFileSync(path.join(ensureRecord, "env"), "utf8");
    assert.match(attestEnv, new RegExp(`^KEY=${keyBody}$`, "m"));
    assert.match(attestEnv, /^KEY_FILE_UNSET$/m);
    assert.match(ensureEnv, new RegExp(`^KEY=${keyBody}$`, "m"));
    assert.match(ensureEnv, /^KEY_FILE_UNSET$/m);
    const hasKey = /^KEY=.+$/m.test(ensureEnv) && !/^KEY_UNSET$/m.test(ensureEnv);
    const hasKeyFile = /^KEY_FILE=.+$/m.test(ensureEnv) && !/^KEY_FILE_UNSET$/m.test(ensureEnv);
    assert.ok(
      hasKey || hasKeyFile,
      "ensure-tag child must present KEY or KEY_FILE (1.39.6 helper left HMAC verify with neither presented as KEY)",
    );
    const argv = fs.readFileSync(path.join(ensureRecord, "argv"), "utf8");
    assert.match(argv, /^release\nensure-tag\n1\.39\.6\n/);
    assert.match(argv, new RegExp(`^${merge}$`, "m"));
    assert.match(argv, /^--packed-candidate$/m);
    assert.match(argv, new RegExp(`^${packed}$`, "m"));
    assert.match(argv, /^--repo-path$/m);
    assert.match(argv, new RegExp(`^${dir}$`, "m"));
    assert.match(r.stdout, new RegExp(`PARENT_KEY_FILE=${keyFile}`));
    assert.match(r.stdout, /^PARENT_KEY=UNSET$/m);
    assert.doesNotMatch(fs.readFileSync(finishJson, "utf8"), new RegExp(keyBody));
    const stray = fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter(
        (rel) =>
          rel !== "key.file" &&
          !rel.startsWith("attest-record/") &&
          !rel.startsWith("ensure-record/"),
      )
      .map((rel) => path.join(dir, rel))
      .filter((p) => fs.statSync(p).isFile())
      .filter((p) => fs.readFileSync(p, "utf8").includes(keyBody));
    assert.deepEqual(stray, [], "ensure-tag must not persist the key body to finish JSON or ship files");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure-tag inherits KEY and unsets KEY_FILE (#1174)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-ensure-tag-inherit-"));
  try {
    const keyFile = path.join(dir, "key.file");
    fs.writeFileSync(keyFile, "file-body-must-not-win\n");
    const r = spawnEnsureTagHelper({
      dir,
      env: {
        PIPELINE_FRG_ATTESTATION_KEY: "inline-key",
        PIPELINE_FRG_ATTESTATION_KEY_FILE: keyFile,
      },
    });
    assert.equal(r.status, 0, `ensure-tag helper exited ${r.status}: ${r.stderr}`);
    const childEnv = fs.readFileSync(r.envPath, "utf8");
    assert.match(childEnv, /^KEY=inline-key$/m);
    assert.match(childEnv, /^KEY_FILE_UNSET$/m);
    assert.doesNotMatch(childEnv, /file-body-must-not-win/);
    assert.match(r.stdout, /^PARENT_KEY=inline-key$/m);
    assert.match(r.stdout, new RegExp(`PARENT_KEY_FILE=${keyFile}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure-tag fails closed without producer credential (#1174)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-ensure-tag-miss-"));
  try {
    const r = spawnEnsureTagHelper({ dir, env: {} });
    assert.notEqual(r.status, 0, "missing credential must fail closed");
    assert.match(`${r.stdout}\n${r.stderr}`, /missing_attestor_credential/);
    assertEnsureTagDidNotSpawn(r.argvPath, r.envPath);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /--skip-frg/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure-tag fails closed on empty KEY_FILE env (#1174)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-ensure-tag-empty-env-"));
  try {
    const r = spawnEnsureTagHelper({
      dir,
      env: { PIPELINE_FRG_ATTESTATION_KEY_FILE: "" },
    });
    assert.notEqual(r.status, 0, "empty KEY_FILE env must fail closed");
    assert.match(`${r.stdout}\n${r.stderr}`, /missing_attestor_credential/);
    assertEnsureTagDidNotSpawn(r.argvPath, r.envPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure-tag fails closed on unreadable KEY_FILE (#1174)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-ensure-tag-unreadable-"));
  const keyFile = path.join(dir, "key.file");
  try {
    fs.writeFileSync(keyFile, "secret-must-not-be-read\n");
    fs.chmodSync(keyFile, 0o000);
    const r = spawnEnsureTagHelper({
      dir,
      env: { PIPELINE_FRG_ATTESTATION_KEY_FILE: keyFile },
    });
    assert.notEqual(r.status, 0, "unreadable KEY_FILE must fail closed");
    assert.match(`${r.stdout}\n${r.stderr}`, /unreadable_attestor_key_file/);
    assertEnsureTagDidNotSpawn(r.argvPath, r.envPath);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /secret-must-not-be-read/);
  } finally {
    try {
      fs.chmodSync(keyFile, 0o644);
    } catch {
      // best-effort restore so rmSync can delete
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure-tag fails closed on empty KEY_FILE (#1174)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-ensure-tag-empty-file-"));
  try {
    const keyFile = path.join(dir, "key.file");
    fs.writeFileSync(keyFile, "");
    const r = spawnEnsureTagHelper({
      dir,
      env: { PIPELINE_FRG_ATTESTATION_KEY_FILE: keyFile },
    });
    assert.notEqual(r.status, 0, "empty KEY_FILE must fail closed");
    assert.match(`${r.stdout}\n${r.stderr}`, /missing_attestor_credential/);
    assertEnsureTagDidNotSpawn(r.argvPath, r.envPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat after train re-execs candidate tugboat.sh and skip-train omits train (#1164)", () => {
  const src = fs.readFileSync(tugboat, "utf8");
  const shipOne = tugboatShipOneBody();
  assert.match(shipOne, /maybe_reexec_candidate_composer/);
  assert.match(shipOne, /TUGBOAT_SKIP_TRAIN/);
  const reexec = extractNamedFn(src, "maybe_reexec_candidate_composer", "tugboat.sh");
  assert.match(reexec, /examples\/supervisor\/shell\/tugboat\.sh/);
  assert.match(reexec, /exec bash "\$cand"/);
  assert.match(reexec, /TUGBOAT_SKIP_TRAIN=1/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-reexec-"));
  try {
    const candRoot = path.join(dir, "candidate");
    const dest = path.join(candRoot, "examples/supervisor/shell");
    fs.mkdirSync(dest, { recursive: true });
    const marker = path.join(dir, "reexec.marker");
    fs.writeFileSync(
      path.join(dest, "tugboat.sh"),
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' \"reexec skip=${TUGBOAT_SKIP_TRAIN:-}\" > " + JSON.stringify(marker),
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(path.join(dest, "tugboat.sh"), 0o755);
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "TUGBOAT_INVOKE_ARGV=(--milestone v1.39.6)",
        `SHIP_END_ENGINE_ROOT=${JSON.stringify(candRoot)}`,
        `SHIP_END_CANDIDATE_SHA=${JSON.stringify("c".repeat(40))}`,
        extractNamedFn(src, "is_exact_git_sha", "tugboat.sh"),
        extractNamedFn(src, "maybe_reexec_candidate_composer", "tugboat.sh"),
        "maybe_reexec_candidate_composer",
        "echo DID_NOT_EXEC",
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(r.status, 0, `re-exec helper exited ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /DID_NOT_EXEC/);
    const markerText = fs.readFileSync(marker, "utf8");
    assert.match(markerText, /reexec skip=1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat composer re-exec retains ship lock held by same PID (#1164)", () => {
  const src = fs.readFileSync(tugboat, "utf8");
  const shipOne = tugboatShipOneBody();
  const lockFn = src.match(/^try_acquire_ship_lock\(\) \{[\s\S]*?\n\}/m);
  assert.ok(lockFn, "try_acquire_ship_lock missing");
  assert.match(
    shipOne,
    /cat "\$lock_dir\/pid"[\s\S]*?== "\$\$"/,
    "retain-lock must compare lock/pid to current $$",
  );
  assert.match(shipOne, /retained after composer re-exec pid=\$\$/);
  assert.match(
    lockFn[0],
    /"\$holder" == "\$\$"/,
    "try_acquire must retain a lock already held by $$",
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugboat-lock-reexec-"));
  try {
    const runDir = path.join(dir, "ship-v1.39.6");
    const lockDir = path.join(runDir, "lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const logFile = path.join(runDir, "playbook.log");
    const parent = path.join(dir, "parent.sh");
    const child = path.join(dir, "tugboat.sh");
    const helpers = [
      extractLiveShipHelpers(src),
      lockFn[0],
    ].join("\n");
    fs.writeFileSync(
      child,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `RUN_DIR=${JSON.stringify(runDir)}`,
        `LOG_FILE=${JSON.stringify(logFile)}`,
        "lock_dir=\"$RUN_DIR/lock\"",
        "version=1.39.6",
        "log() { printf '%s\\n' \"$*\" | tee -a \"$LOG_FILE\" >/dev/null; echo \"$*\"; }",
        helpers,
        "if [[ \"${TUGBOAT_SKIP_TRAIN:-}\" == \"1\" ]] && [[ -f \"$lock_dir/pid\" ]] \\",
        "  && [[ \"$(cat \"$lock_dir/pid\" 2>/dev/null || true)\" == \"$$\" ]]; then",
        "  log \"phase lock: retained after composer re-exec pid=$$\"",
        "  echo \"RETAINED:$$:$(cat \"$lock_dir/pid\")\"",
        "elif ! holder=$(try_acquire_ship_lock \"$RUN_DIR\" \"$version\"); then",
        "  log \"another tugboat holds the lock (pid ${holder:-?}) — refusing duplicate ship\"",
        "  echo \"REFUSED:${holder:-?}:$$\"",
        "  exit 0",
        "else",
        "  echo \"ACQUIRED:$$:$(cat \"$lock_dir/pid\")\"",
        "fi",
        "",
      ].join("\n"),
    );
    fs.chmodSync(child, 0o755);
    fs.writeFileSync(
      parent,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `RUN_DIR=${JSON.stringify(runDir)}`,
        "mkdir -p \"$RUN_DIR/lock\"",
        "printf '%s\\n' \"$$\" >\"$RUN_DIR/lock/pid\"",
        "printf '%s\\n' \"$$\" >\"$RUN_DIR/playbook.pid\"",
        "export TUGBOAT_SKIP_TRAIN=1",
        `exec bash ${JSON.stringify(child)} --milestone v1.39.6`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(parent, 0o755);
    const r = spawnSync("bash", [parent], { encoding: "utf8" });
    assert.equal(r.status, 0, `re-exec lock path exited ${r.status}: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^RETAINED:/m);
    assert.doesNotMatch(r.stdout, /REFUSED:/);
    assert.doesNotMatch(r.stdout, /ACQUIRED:/);
    assert.match(r.stdout, /retained after composer re-exec pid=/);
    const holder = fs.readFileSync(path.join(lockDir, "pid"), "utf8").trim();
    const retained = r.stdout.match(/^RETAINED:(\d+):(\d+)/m);
    assert.ok(retained, `expected RETAINED:pid:pid, got ${r.stdout}`);
    assert.equal(retained[1], retained[2], "exec must keep the same PID as lock/pid");
    assert.equal(holder, retained[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tugboat wait-release polls gh release view and never creates the Release (#1167)", () => {
  const shipOne = tugboatShipOneBody();
  assert.match(shipOne, /gh release view "v\$version"/);
  assert.doesNotMatch(shipOne, /gh release create/);
  assert.doesNotMatch(shipOne, /\bgit tag\b/);
  const wait = shipOne.slice(shipOne.indexOf("wait-release"));
  assert.match(wait, /gh release view/);
  assert.doesNotMatch(wait, /gh release create/);
});
