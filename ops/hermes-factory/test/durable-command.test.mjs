import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRecordedCommand,
  durableCommandPaths,
  durableUnitName,
  maxEventSequence,
  parsePipelineHandoff,
  parseUnitProperties,
  projectSharedMaterialEvents,
  serializeEnvironment,
  systemdRunArgs,
} from "../lib/durable-command.mjs";
import { filterMaterialText } from "../../../core/scripts/material-filter.ts";

const fingerprint = "a".repeat(64);
const actionId = "b".repeat(64);

test("builds a deterministic transient unit with persistent output files", () => {
  const unit = durableUnitName(fingerprint, "issue_advance", actionId);
  const paths = durableCommandPaths("/state", fingerprint, actionId);
  const args = systemdRunArgs({
    unit,
    cwd: "/repo",
    outputPath: paths.output,
    diagnosticPath: paths.diagnostic,
    envFile: paths.env,
    cleanExecNode: "/usr/bin/node",
    cleanExecScript: "/factory/lib/clean-exec.mjs",
    command: "/usr/bin/node",
    args: ["/pipeline.mjs", "single", "905"],
  });
  assert.match(unit, /^hermes-factory-/);
  assert.ok(args.includes(`--property=StandardOutput=append:${paths.output}`));
  assert.ok(args.includes(`--property=StandardError=append:${paths.diagnostic}`));
  assert.equal(args.some((arg) => arg.includes("EnvironmentFile=")), false);
  assert.ok(args.includes("--property=RemainAfterExit=yes"));
  assert.equal(args.includes("--wait"), false);
  assert.deepEqual(args.slice(-9), [
    "/usr/bin/node", "/factory/lib/clean-exec.mjs", "--env-file", paths.env, "--",
    "/usr/bin/node", "/pipeline.mjs", "single", "905",
  ]);
});

test("serializes only the supplied child environment and rejects multiline values", () => {
  const body = serializeEnvironment({ HOME: "/home/user", GH_TOKEN: "secret-canary", PATH: "/usr/bin" });
  assert.match(body, /^GH_TOKEN="secret-canary"$/m);
  assert.doesNotMatch(body, /BUZZ_PRIVATE_KEY|PIPELINE_FRG_ATTESTATION_KEY/);
  assert.throws(() => serializeEnvironment({ PATH: "bad\nvalue" }), /single-line/);
});

test("parses running, successful, and failed unit states", () => {
  assert.deepEqual(parseUnitProperties("LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainStatus=0\n"), { state: "running", active_state: "active" });
  assert.deepEqual(parseUnitProperties("LoadState=loaded\nActiveState=active\nSubState=exited\nResult=success\nExecMainStatus=0\n"), { state: "complete", code: 0, active_state: "active" });
  assert.deepEqual(parseUnitProperties("LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\n"), { state: "complete", code: 0, active_state: "inactive" });
  assert.deepEqual(parseUnitProperties("LoadState=loaded\nActiveState=failed\nResult=exit-code\nExecMainStatus=1\n"), { state: "failed", code: 1, result: "exit-code", active_state: "failed" });
});

test("accepts only an exact Pipeline handoff under the configured loop store", () => {
  const line = JSON.stringify({
    kind: "loop_run_handoff",
    run_id: "run-905",
    run_dir: "/loop/runs/run-905",
    events: "/loop/runs/run-905/events.jsonl",
  });
  assert.deepEqual(parsePipelineHandoff(line, "/loop/runs"), {
    pipeline_run_id: "run-905",
    events_path: "/loop/runs/run-905/events.jsonl",
  });
  assert.throws(
    () => parsePipelineHandoff(line.replace("/loop/runs/run-905/events.jsonl", "/tmp/events.jsonl"), "/loop/runs"),
    /outside/,
  );
});

test("projects the exact shared material filter output for stage and lifecycle notices", () => {
  const body = [
    JSON.stringify({ seq: 1, time: "2026-08-08T12:00:00Z", kind: "run_initialized", data: {} }),
    JSON.stringify({ seq: 2, time: "2026-08-08T12:00:01Z", kind: "loop_item_stage_progress", data: { item_id: "905", stage: "implement", at: "2026-08-08T12:00:01Z" } }),
    JSON.stringify({ seq: 3, time: "2026-08-08T12:00:02Z", kind: "loop_item_blocked", data: { item_id: "905", reason: "CI failed" } }),
  ].join("\n");
  const shared = filterMaterialText(body, { jsonl: true });
  const projected = projectSharedMaterialEvents(shared, 0);
  assert.deepEqual(projected.map((event) => event.kind), ["loop_item_stage_progress", "loop_item_blocked"]);
  assert.equal(projected[0].fields.stage, "implement");
  assert.equal(projected[1].fields.reason, "CI failed");
  assert.equal(maxEventSequence(body), 3);
  assert.deepEqual(projectSharedMaterialEvents(shared, 3), []);
});

test("rejects a changed journal unit or output identity", () => {
  const unit = durableUnitName(fingerprint, "issue_advance", actionId);
  const paths = durableCommandPaths("/state", fingerprint, actionId);
  const record = { observed: { service_unit: unit, output_path: paths.output, diagnostic_path: paths.diagnostic } };
  assert.equal(assertRecordedCommand(record, { stateDir: "/state", fingerprint, actionId, kind: "issue_advance" }).unit, unit);
  record.observed.output_path = "/tmp/output.log";
  assert.throws(() => assertRecordedCommand(record, { stateDir: "/state", fingerprint, actionId, kind: "issue_advance" }), /identity/);
});
