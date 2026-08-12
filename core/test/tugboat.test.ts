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
