// Regression: the supervisor shell must stay a thin adapter over `pipeline
// ship`; it must not reimplement the ship lifecycle or detached supervision.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const script = path.join(repoRoot, "examples/supervisor/shell/ship-milestone.sh");

function fixture(): {
  root: string;
  repo: string;
  auth: string;
  pipeline: string;
  capture: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ship-adapter-"));
  const repo = path.join(root, "repo");
  const auth = path.join(root, "authorization.json");
  const pipeline = path.join(root, "pipeline");
  const capture = path.join(root, "capture");
  fs.mkdirSync(repo);
  fs.writeFileSync(auth, "{}\n");
  fs.writeFileSync(
    pipeline,
    `#!/bin/sh
printf '%s\\n' "$PWD" >"$CAPTURE.cwd"
printf '%s\\n' "$@" >"$CAPTURE.args"
printf '{"kind":"ship_status"}\\n'
`,
    { mode: 0o755 },
  );
  return { root, repo, auth, pipeline, capture };
}

function run(
  f: ReturnType<typeof fixture>,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
) {
  return spawnSync("bash", [script, ...args], {
    env: {
      ...process.env,
      REPO_DIR: f.repo,
      PIPELINE: f.pipeline,
      CAPTURE: f.capture,
      ALLOW_MERGE: "1",
      ...extra,
    },
    encoding: "utf8",
  });
}

test("foreground adapter forwards one authorized ship request exactly", () => {
  const f = fixture();
  const r = run(f, [
    "--milestone",
    "v1.34.0",
    "--authorization",
    f.auth,
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(fs.readFileSync(`${f.capture}.args`, "utf8").trim().split("\n"), [
    "ship",
    "--milestone",
    "v1.34.0",
    "--for",
    "1.34.0",
    "--authorization",
    f.auth,
    "--json",
  ]);
  assert.equal(fs.readFileSync(`${f.capture}.cwd`, "utf8").trim(), fs.realpathSync(f.repo));
});

test("status adapter asks Pipeline for typed ship status without authorization", () => {
  const f = fixture();
  const r = run(f, ["--milestone", "release-34", "--for", "1.34.0", "--status"], {
    ALLOW_MERGE: "0",
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(fs.readFileSync(`${f.capture}.args`, "utf8").trim().split("\n"), [
    "ship",
    "status",
    "--milestone",
    "release-34",
    "--for",
    "1.34.0",
    "--json",
  ]);
});

test("detach delegates one exact command to user systemd", () => {
  const f = fixture();
  const systemd = path.join(f.root, "systemd-run");
  fs.writeFileSync(
    systemd,
    `#!/bin/sh
printf '%s\\n' "$@" >"$CAPTURE.systemd"
`,
    { mode: 0o755 },
  );
  const r = run(
    f,
    ["--milestone", "v1.34.0", "--for", "1.34.0", "--authorization", f.auth, "--detach"],
    { SYSTEMD_RUN: systemd },
  );
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const args = fs.readFileSync(`${f.capture}.systemd`, "utf8").trim().split("\n");
  assert.deepEqual(args.slice(0, 2), ["--user", "--collect"]);
  assert.equal(args[2], "--unit");
  assert.match(
    args[3]!,
    /^pipeline-ship-v1\.34\.0-1\.34\.0-[0-9]+$/,
    "the stable unit must include a repo-scoped coordinate checksum",
  );
  assert.deepEqual(args.slice(4, 16), [
    "--property",
    "Restart=on-abnormal",
    "--property",
    "RestartSec=5s",
    "--property",
    "StartLimitIntervalSec=60s",
    "--property",
    "StartLimitBurst=3",
    "--working-directory",
    fs.realpathSync(f.repo),
    f.pipeline,
    "ship",
  ]);
  assert.deepEqual(args.slice(16), [
    "--milestone",
    "v1.34.0",
    "--for",
    "1.34.0",
    "--authorization",
    f.auth,
    "--json",
  ]);

  const other = fixture();
  const otherSystemd = path.join(other.root, "systemd-run");
  fs.writeFileSync(
    otherSystemd,
    `#!/bin/sh
printf '%s\\n' "$@" >"$CAPTURE.systemd"
`,
    { mode: 0o755 },
  );
  const otherRun = run(
    other,
    ["--milestone", "v1.34.0", "--for", "1.34.0", "--authorization", other.auth, "--detach"],
    { SYSTEMD_RUN: otherSystemd },
  );
  assert.equal(otherRun.status, 0, `stderr=${otherRun.stderr}`);
  const otherArgs = fs.readFileSync(`${other.capture}.systemd`, "utf8").trim().split("\n");
  assert.notEqual(args[3], otherArgs[3], "the same milestone in another repo needs another unit");
});

test("adapter rejects missing authority and host-side milestone batching", () => {
  const f = fixture();
  const noAuth = run(f, ["--milestone", "v1.34.0"]);
  assert.equal(noAuth.status, 2);
  assert.match(noAuth.stderr, /--authorization is required/);

  const batch = run(f, ["--milestones", "v1.34.0", "v1.35.0"]);
  assert.equal(batch.status, 2);
  assert.match(batch.stderr, /one authorized Pipeline ship per milestone/);
});

test("adapter source contains no lifecycle implementation or global event scan", () => {
  const body = fs.readFileSync(script, "utf8");
  assert.match(body, /ship status/);
  assert.match(body, /systemd-run/);
  assert.doesNotMatch(body, /pipeline"? train|release finish|engine-promote|gh release view|AGENT_PIPELINE_LOOP_ROOT/);
});
