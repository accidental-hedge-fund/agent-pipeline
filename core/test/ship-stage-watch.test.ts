// Regression: ship-stage-watch must not rebroadcast pre-ship history under a
// new ship label (v1.34 ship spam of leftover 1.33 FRG #938/#939).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const script = path.join(
  repoRoot,
  "examples/supervisor/shell/ship-stage-watch.sh",
);

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ship-stage-watch-"));
}

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
}

function runOnce(env: NodeJS.ProcessEnv, args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("bash", [script, ...args, "--once"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

test("ship-stage-watch script is executable and documents since scope", () => {
  assert.ok(fs.existsSync(script), "missing ship-stage-watch.sh");
  const body = fs.readFileSync(script, "utf8");
  assert.match(body, /--since/);
  assert.match(body, /session-since|ordered_issues|issues-file/);
  assert.match(body, /Fail closed|since watermark|pre-ship/i);
});

test("does not rebroadcast pre-since FRG history under a new ship label", () => {
  const root = mkTmp();
  const state = path.join(root, "state");
  const loopRoot = path.join(root, "loop", "runs");
  const loopDir = path.join(loopRoot, "loop-frg-old");
  fs.mkdirSync(loopDir, { recursive: true });
  fs.mkdirSync(state, { recursive: true });

  // Historical 1.33 FRG pack activity (hours before ship start)
  writeJsonl(path.join(loopDir, "events.jsonl"), [
    {
      kind: "loop_item_started",
      time: "2026-08-10T02:36:44.089Z",
      data: { item_id: "938" },
    },
    {
      kind: "loop_item_stage_progress",
      time: "2026-08-10T02:36:52Z",
      data: { item_id: "938", stage: "planning", at: "2026-08-10T02:36:52Z" },
    },
    {
      kind: "loop_item_stage_progress",
      time: "2026-08-10T02:50:31Z",
      data: {
        item_id: "938",
        stage: "ready-to-deploy",
        at: "2026-08-10T02:50:31Z",
      },
    },
    {
      kind: "loop_item_started",
      time: "2026-08-10T02:50:45.776Z",
      data: { item_id: "939" },
    },
    {
      kind: "loop_item_stage_progress",
      time: "2026-08-10T03:07:16Z",
      data: {
        item_id: "939",
        stage: "ready-to-deploy",
        at: "2026-08-10T03:07:16Z",
      },
    },
  ]);

  // Ship session starts much later; only #909 is on the train work list.
  const trainPath = path.join(state, "ship-v1.34.0", "train.json");
  fs.mkdirSync(path.dirname(trainPath), { recursive: true });
  fs.writeFileSync(
    trainPath,
    JSON.stringify({
      schema_version: 1,
      kind: "train_status",
      ordered_issues: [909],
      current_issue: 909,
      complete: false,
      blocker: "need pipeline:ready",
    }) + "\n",
    "utf8",
  );

  // Notify no-op: empty executable stub so emit path does not fail
  const notifyBin = path.join(root, "notify.sh");
  fs.writeFileSync(notifyBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const r = runOnce(
    {
      PIPELINE_SUPERVISOR_STATE: state,
      AGENT_PIPELINE_LOOP_ROOT: loopRoot,
      SHIP_NOTIFY_BIN: notifyBin,
      REPO_DIR: root,
    },
    [
      "--milestone",
      "v1.34.0",
      "--since",
      "2026-08-10T13:24:00Z",
      "--issues-file",
      trainPath,
      "--label",
      "ship v1.34.0",
    ],
  );

  assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
  assert.doesNotMatch(r.stdout, /#938/);
  assert.doesNotMatch(r.stdout, /#939/);
  assert.doesNotMatch(r.stdout, /ready-to-deploy/);
});

test("notifies only in-scope issue events after since", () => {
  const root = mkTmp();
  const state = path.join(root, "state");
  const loopRoot = path.join(root, "loop", "runs");
  const loopDir = path.join(loopRoot, "loop-train-new");
  fs.mkdirSync(loopDir, { recursive: true });

  writeJsonl(path.join(loopDir, "events.jsonl"), [
    // Old noise
    {
      kind: "loop_item_stage_progress",
      time: "2026-08-10T02:00:00Z",
      data: { item_id: "938", stage: "planning", at: "2026-08-10T02:00:00Z" },
    },
    // In-scope train issue after ship start
    {
      kind: "loop_item_precondition_excluded",
      time: "2026-08-10T13:24:10Z",
      data: {
        item_id: "909",
        required_stage: "pipeline:ready",
        observed_stage: "pipeline:backlog",
      },
    },
    // Concurrent noise on another issue after since — must not notify when
    // train ordered_issues is [909]
    {
      kind: "loop_item_stage_progress",
      time: "2026-08-10T13:24:11Z",
      data: { item_id: "777", stage: "implementing", at: "2026-08-10T13:24:11Z" },
    },
  ]);

  const trainPath = path.join(state, "ship-v1.34.0", "train.json");
  fs.mkdirSync(path.dirname(trainPath), { recursive: true });
  fs.writeFileSync(
    trainPath,
    JSON.stringify({
      schema_version: 1,
      kind: "train_status",
      ordered_issues: [909],
    }) + "\n",
    "utf8",
  );

  const notifyBin = path.join(root, "notify.sh");
  fs.writeFileSync(notifyBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const r = runOnce(
    {
      PIPELINE_SUPERVISOR_STATE: state,
      AGENT_PIPELINE_LOOP_ROOT: loopRoot,
      SHIP_NOTIFY_BIN: notifyBin,
      REPO_DIR: root,
    },
    [
      "--milestone",
      "v1.34.0",
      "--since",
      "2026-08-10T13:24:00Z",
      "--issues-file",
      trainPath,
      "--label",
      "ship v1.34.0",
    ],
  );

  assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
  assert.match(r.stdout, /#909/);
  assert.match(r.stdout, /not dispatchable/);
  assert.doesNotMatch(r.stdout, /#938/);
  assert.doesNotMatch(r.stdout, /#777/);
});

test("ship-milestone playbook binds stage-watch to --since and train.json", () => {
  const playbook = fs.readFileSync(
    path.join(repoRoot, "examples/supervisor/shell/ship-milestone.sh"),
    "utf8",
  );
  assert.match(playbook, /--since/);
  assert.match(playbook, /--issues-file/);
  assert.match(playbook, /train\.json/);
});
