// Regression: ship playbook must wait for the release PR's observable checks
// to go green before `release finish`. `pipeline release finish` refuses to
// merge while checks are pending/failing, so without this wait the ship races
// the just-opened release PR's CI and fails release-finish with exit 1.
// The classification + bounded flake-eligible rerun live in
// release-checks-green.py (pure, testable). #1110: first `test` fail reruns.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const helper = path.join(
  repoRoot,
  "examples/supervisor/shell/release-checks-green.py",
);
const playbook = path.join(
  repoRoot,
  "examples/supervisor/shell/pipeline-ship-playbook.sh",
);
const tugboat = path.join(repoRoot, "examples/supervisor/shell/tugboat.sh");

const TEST_FAIL_LINK =
  "https://github.com/o/r/actions/runs/32075787450";

function classify(
  checks: unknown,
  extra: string[] = [],
): { token: string; sidecar: Record<string, unknown> | null; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-checks-green-"));
  const f = path.join(dir, "checks.json");
  const sidecar = path.join(dir, "sidecar.json");
  fs.writeFileSync(f, JSON.stringify(checks));
  const r = spawnSync("python3", [helper, f, "--sidecar", sidecar, ...extra], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `helper exited ${r.status}: ${r.stderr}`);
  let side: Record<string, unknown> | null = null;
  if (fs.existsSync(sidecar)) {
    side = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
  }
  return { token: r.stdout.trim(), sidecar: side, dir };
}

function classifyToken(checks: unknown, extra: string[] = []): string {
  const r = classify(checks, extra);
  fs.rmSync(r.dir, { recursive: true, force: true });
  return r.token;
}

test("release-checks-green: all success -> green (1)", () => {
  assert.equal(
    classifyToken([
      { name: "test", state: "SUCCESS", bucket: "pass" },
      { name: "lint", state: "SUCCESS", bucket: "pass" },
    ]),
    "1",
  );
});

// gh pr checks --json name,state,bucket,link is the real schema. `conclusion`
// is NOT an accepted JSON field (gh rejects it with exit 1: "Unknown JSON
// field"), which broke the playbook's CI-wait loop in the field. These assert
// gh's actual return shape.
test("release-checks-green: gh's real bucket schema -> green (1)", () => {
  assert.equal(
    classifyToken([{ name: "test", state: "SUCCESS", bucket: "pass" }]),
    "1",
  );
});

test("release-checks-green: success with null conclusion -> green (1)", () => {
  assert.equal(
    classifyToken([{ name: "test", state: "SUCCESS", conclusion: null }]),
    "1",
  );
});

test("release-checks-green: neutral/skipped -> green (1)", () => {
  assert.equal(
    classifyToken([{ name: "fmt", state: "SUCCESS", conclusion: "NEUTRAL" }]),
    "1",
  );
});

test("release-checks-green: pending -> waiting (0)", () => {
  assert.equal(
    classifyToken([{ name: "test", state: "PENDING", conclusion: "PENDING" }]),
    "0",
  );
});

test("release-checks-green: queued -> waiting (0)", () => {
  assert.equal(
    classifyToken([{ name: "test", state: "QUEUED", conclusion: null }]),
    "0",
  );
});

test("release-checks-green: mixed pending+success -> waiting (0)", () => {
  assert.equal(
    classifyToken([
      { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
      { name: "lint", state: "QUEUED", conclusion: null },
    ]),
    "0",
  );
});

test("release-checks-green: failure without run id -> failed (-1)", () => {
  // Missing link cannot rerun — fail closed rather than loop.
  assert.equal(
    classifyToken([{ name: "test", state: "FAILURE", conclusion: "FAILURE" }]),
    "-1",
  );
});

test("release-checks-green: cancelled -> failed (-1)", () => {
  assert.equal(
    classifyToken([{ name: "test", state: "CANCELLED", conclusion: "CANCELLED" }]),
    "-1",
  );
});

test("release-checks-green: empty checks -> green (1)", () => {
  assert.equal(classifyToken([]), "1");
});

test("release-checks-green: sole test fail with link -> rerun (2)", () => {
  const r = classify(
    [
      {
        name: "test",
        state: "FAILURE",
        bucket: "fail",
        link: TEST_FAIL_LINK,
      },
    ],
    ["--pr", "1109"],
  );
  try {
    assert.equal(r.token, "2");
    assert.ok(r.sidecar);
    assert.equal(r.sidecar!.check_name, "test");
    assert.equal(r.sidecar!.run_id, "32075787450");
    assert.match(String(r.sidecar!.reason), /PR #1109/);
    assert.match(String(r.sidecar!.link), /32075787450/);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("release-checks-green: non-test product fail -> fail (no rerun)", () => {
  const r = classify(
    [
      {
        name: "release-build",
        state: "FAILURE",
        bucket: "fail",
        link: TEST_FAIL_LINK,
      },
    ],
    ["--pr", "1109"],
  );
  try {
    assert.equal(r.token, "-1");
    assert.ok(r.sidecar);
    assert.equal(r.sidecar!.check_name, "release-build");
    assert.match(String(r.sidecar!.reason), /non-flake product fail/);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("release-checks-green: mixed test fail + product fail -> fail", () => {
  const r = classify([
    { name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK },
    {
      name: "release-build",
      state: "FAILURE",
      bucket: "fail",
      link: "https://github.com/o/r/actions/runs/1",
    },
  ]);
  try {
    assert.equal(r.token, "-1");
    assert.ok(r.sidecar);
    assert.equal(r.sidecar!.check_name, "release-build");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("release-checks-green: pending + fail in one capture is pending", () => {
  assert.equal(
    classifyToken([
      { name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK },
      { name: "lint", state: "PENDING", bucket: "pending" },
    ]),
    "0",
  );
});

test("release-checks-green: fail-before-pending still pending (whole-set)", () => {
  // Order-dependent classify used to STOP on the first FAILURE even when a
  // later check was still pending.
  assert.equal(
    classifyToken([
      { name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK },
      { name: "lint", state: "IN_PROGRESS", bucket: "pending" },
    ]),
    "0",
  );
});

test("release-checks-green: budget spent on test fail -> fail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-checks-budget-"));
  try {
    const budgetFile = path.join(dir, "release-checks.rerun");
    const rec = spawnSync(
      "python3",
      [
        helper,
        "--record-attempt",
        "--budget-file",
        budgetFile,
        "--pr",
        "1109",
        "--head-sha",
        "5606ec5b",
        "--run-id",
        "32075787450",
      ],
      { encoding: "utf8" },
    );
    assert.equal(rec.status, 0, rec.stderr);
    const r = classify(
      [
        {
          name: "test",
          state: "FAILURE",
          bucket: "fail",
          link: TEST_FAIL_LINK,
        },
      ],
      [
        "--pr",
        "1109",
        "--head-sha",
        "5606ec5b",
        "--budget",
        "1",
        "--budget-file",
        budgetFile,
      ],
    );
    assert.equal(r.token, "-1");
    assert.match(String(r.sidecar?.reason), /rerun budget spent/);
    assert.match(String(r.sidecar?.reason), /32075787450/);
    fs.rmSync(r.dir, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("release-checks-green: failed-log title is included in sidecar", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-checks-title-"));
  try {
    const logPath = path.join(dir, "failed.log");
    fs.writeFileSync(
      logPath,
      "some preamble\n✖ detach race (#1062 R2): concurrent Ship detaches exactly once\n",
    );
    const r = classify(
      [
        {
          name: "test",
          state: "FAILURE",
          bucket: "fail",
          link: TEST_FAIL_LINK,
        },
      ],
      ["--pr", "1109", "--failed-log", logPath, "--budget", "1"],
    );
    try {
      assert.match(
        String(r.sidecar?.failed_test_title),
        /detach race \(#1062 R2\)/,
      );
      assert.match(String(r.sidecar?.reason), /detach race \(#1062 R2\)/);
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: the playbook's CI-wait loop must call gh with a VALID --json
// field list. `gh pr checks --json name,state,conclusion` fails with exit 1
// ("Unknown JSON field: conclusion") — conclusion is not an accepted field —
// which made every poll error and the wait loop exhaust its budget without
// ever seeing green. gh's real schema uses `bucket`, not `conclusion`.
test("playbook CI-wait uses valid gh pr checks fields", () => {
  const body = fs.readFileSync(tugboat, "utf8");
  const m = body.match(/gh pr checks "\$pr" --json ([a-z,]+)/);
  assert.ok(m, "CI-wait gh pr checks line not found");
  assert.doesNotMatch(m[1], /conclusion/, "conclusion is not a valid gh field");
  assert.match(m[1], /\bbucket\b/, "gh pr checks --json should use bucket");
  assert.match(m[1], /\blink\b/, "gh pr checks --json should request link");
  const launcher = fs.readFileSync(playbook, "utf8");
  assert.match(launcher, /exec "\$REPO_DIR\/examples\/supervisor\/shell\/tugboat\.sh" "\$@"/);
});

function extractFn(src: string, name: string): string {
  const m = src.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(m, `${name}() not found`);
  return m[0];
}

function extractWaitHelpers(src: string): string {
  return [
    extractFn(src, "release_checks_rerun_budget"),
    extractFn(src, "release_pr_head_sha"),
    extractFn(src, "release_checks_sidecar_field"),
    extractFn(src, "apply_release_check_wait_tick"),
  ].join("\n");
}

function writeFakeGh(dir: string, rerunLog: string): string {
  const gh = path.join(dir, "gh");
  fs.writeFileSync(
    gh,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `if [[ "\${1:-}" == "pr" && "\${2:-}" == "view" ]]; then`,
      '  printf "%s\\n" "${FAKE_HEAD_SHA:-5606ec5bdeadbeef}"',
      "  exit 0",
      "fi",
      `if [[ "\${1:-}" == "run" && "\${2:-}" == "rerun" ]]; then`,
      `  printf '%s\\n' "$*" >> ${JSON.stringify(rerunLog)}`,
      '  exit "${GH_RERUN_EC:-0}"',
      "fi",
      `if [[ "\${1:-}" == "run" && "\${2:-}" == "view" ]]; then`,
      '  printf "%s\\n" "✖ detach race (#1062 R2): concurrent Ship detaches exactly once"',
      "  exit 0",
      "fi",
      'echo "unexpected gh $*" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  fs.chmodSync(gh, 0o755);
  return gh;
}

function runWaitTick(opts: {
  composer: "tugboat" | "playbook";
  capture: unknown;
  runDir: string;
  extraEnv?: NodeJS.ProcessEnv;
}): { verdict: string; status: number; stderr: string } {
  const src = fs.readFileSync(
    opts.composer === "tugboat" ? tugboat : playbook,
    "utf8",
  );
  const helpers = extractWaitHelpers(src);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ship-wait-tick-"));
  try {
    const rerunLog = path.join(opts.runDir, "gh-rerun.log");
    const gh = writeFakeGh(work, rerunLog);
    const capture = path.join(opts.runDir, "release-checks.json");
    fs.writeFileSync(capture, JSON.stringify(opts.capture));
    const runner = path.join(work, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `RUN_DIR=${JSON.stringify(opts.runDir)}`,
        `RELEASE_CHECKS_GREEN_BIN=${JSON.stringify(helper)}`,
        helpers,
        `printf '%s' "$(apply_release_check_wait_tick 1109 ${JSON.stringify(capture)})"`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${work}${path.delimiter}${process.env.PATH ?? ""}`,
        RELEASE_CHECKS_RERUN_BUDGET: "1",
        ...opts.extraEnv,
      },
    });
    return { verdict: r.stdout, status: r.status ?? 1, stderr: r.stderr };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const TEST_FAIL_CAPTURE = [
  {
    name: "test",
    state: "FAILURE",
    bucket: "fail",
    link: TEST_FAIL_LINK,
  },
];
const TEST_PASS_CAPTURE = [
  { name: "test", state: "SUCCESS", bucket: "pass", link: TEST_FAIL_LINK },
];

test("waiter first-fail-then-pass: one rerun then green proceeds", () => {
  // Would have caught the #1109 STOP: first settled `test` fail is not terminal.
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-wait-fftp-"));
  try {
    const first = runWaitTick({
      composer: "tugboat",
      capture: TEST_FAIL_CAPTURE,
      runDir,
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(
      first.verdict,
      "pending",
      "first test fail must rerun and keep waiting, not STOP",
    );
    const rerunLog = fs.readFileSync(path.join(runDir, "gh-rerun.log"), "utf8");
    assert.match(rerunLog, /run rerun 32075787450 --failed/);
    assert.equal(rerunLog.trim().split("\n").length, 1);

    const second = runWaitTick({
      composer: "tugboat",
      capture: TEST_PASS_CAPTURE,
      runDir,
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.verdict, "green");
    const rerunAfter = fs.readFileSync(path.join(runDir, "gh-rerun.log"), "utf8");
    assert.equal(rerunAfter.trim().split("\n").length, 1);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("waiter budget-exhausted test fail STOPs with check URL", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-wait-budget-"));
  try {
    const first = runWaitTick({
      composer: "tugboat",
      capture: TEST_FAIL_CAPTURE,
      runDir,
    });
    assert.equal(first.verdict, "pending");
    const second = runWaitTick({
      composer: "tugboat",
      capture: TEST_FAIL_CAPTURE,
      runDir,
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.verdict, "fail");
    const rerunLog = fs.readFileSync(path.join(runDir, "gh-rerun.log"), "utf8");
    assert.equal(rerunLog.trim().split("\n").length, 1);
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(runDir, "release-checks.fail.json"), "utf8"),
    ) as { reason?: string; check_name?: string };
    assert.equal(sidecar.check_name, "test");
    assert.match(String(sidecar.reason), /PR #1109/);
    assert.match(String(sidecar.reason), /test/);
    assert.match(String(sidecar.reason), /32075787450|fail/);
    assert.doesNotMatch(String(sidecar.reason), /tester-evidence/);
    assert.doesNotMatch(String(sidecar.reason), /trusted-surface/);
    assert.match(String(sidecar.reason), /detach race \(#1062 R2\)/);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("waiter non-test product fail does not request rerun", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-wait-product-"));
  try {
    const r = runWaitTick({
      composer: "tugboat",
      capture: [
        {
          name: "release-build",
          state: "FAILURE",
          bucket: "fail",
          link: TEST_FAIL_LINK,
        },
      ],
      runDir,
    });
    assert.equal(r.verdict, "fail");
    assert.equal(fs.existsSync(path.join(runDir, "gh-rerun.log")), false);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("both composers share the wait-tick recipe and do not STOP on raw -1", () => {
  const tug = fs.readFileSync(tugboat, "utf8");
  const book = fs.readFileSync(playbook, "utf8");
  assert.match(book, /exec "\$REPO_DIR\/examples\/supervisor\/shell\/tugboat\.sh" "\$@"/);
  const body = tug;
  const label = "tugboat";
  assert.match(body, /apply_release_check_wait_tick/, label);
  assert.match(body, /release-checks-green\.py/, label);
  assert.match(body, /gh run rerun "\$run_id" --failed/, label);
  assert.match(body, /verdict=\$\(apply_release_check_wait_tick/, label);
  assert.doesNotMatch(
    body,
    /\[\[ "\$green" == "-1" \]\]/,
    `${label} must not treat raw helper -1 as immediate exit 1`,
  );
  const waitIdx = body.indexOf("apply_release_check_wait_tick");
  const waitSlice = body.slice(waitIdx);
  assert.doesNotMatch(
    waitSlice.slice(0, 2500),
    /python3 "\$RELEASE_CHECKS_GREEN_BIN" "\$RUN_DIR\/release-checks\.json"\)\s*\n\s*if \[\[ "\$green" == "1"/,
  );
});
