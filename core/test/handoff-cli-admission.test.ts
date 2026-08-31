// CLI admission for documented `pipeline handoff <verb>` argv (#1349).
// Parser + shared maxPositionalsFor only. No git, network, or handler I/O.
// Materialization stays on existing injected-I/O seams
// (human-question-handoff.test.ts, grill-then-ready.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCmd, maxPositionalsFor, type CliOpts } from "../scripts/pipeline.ts";

const HANDOFF_ID = "hqh_test1349";
const ID_TAKING = ["show", "answer", "reject", "supersede"] as const;
const ALL_VERBS = ["list", "show", "answer", "reject", "supersede"] as const;
const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));

function parseHandoff(args: string[]) {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", ...args]);
  return cmd;
}

function underBudget(cmd: ReturnType<typeof buildCmd>): boolean {
  return cmd.args.length <= maxPositionalsFor(cmd.args[0], cmd.args);
}

function spawnPipeline(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, ...args],
    { encoding: "utf8" },
  );
}

// ---------------------------------------------------------------------------
// 1.1 Documented verbs through the real parser. These fail if the default
// positional cap of 1 still rejects the verb.
// ---------------------------------------------------------------------------

test("CLI: pipeline handoff list --issue N --json is under the positional budget (#1349)", () => {
  const cmd = parseHandoff(["handoff", "list", "--issue", "42", "--json"]);
  assert.deepEqual(cmd.args, ["handoff", "list"]);
  assert.ok(
    underBudget(cmd),
    "list verb must not be rejected as an extra positional",
  );
});

test("CLI: every documented handoff verb is under the positional budget (#1349)", () => {
  for (const verb of ALL_VERBS) {
    const argv =
      verb === "list"
        ? ["handoff", "list", "--issue", "42", "--json"]
        : ["handoff", verb, HANDOFF_ID, "--issue", "42"];
    const cmd = parseHandoff(argv);
    const expected = verb === "list" ? ["handoff", "list"] : ["handoff", verb, HANDOFF_ID];
    assert.deepEqual(cmd.args, expected, verb);
    assert.ok(
      underBudget(cmd),
      `${verb} must not be rejected as an extra positional (cap=${maxPositionalsFor(cmd.args[0], cmd.args)} args=${cmd.args.join(" ")})`,
    );
  }
});

// ---------------------------------------------------------------------------
// 1.2 Flags stay options, not positionals.
// ---------------------------------------------------------------------------

test("CLI: --issue and --json stay options for handoff list (#1349)", () => {
  const cmd = parseHandoff(["handoff", "list", "--issue", "42", "--json"]);
  const opts = cmd.opts<CliOpts>();
  assert.equal(opts.issue, 42);
  assert.equal(opts.json, true);
  assert.deepEqual(cmd.args, ["handoff", "list"]);
});

// ---------------------------------------------------------------------------
// 1.3 Inverse cases. Extra-token cases MUST be over budget.
// ---------------------------------------------------------------------------

test("maxPositionalsFor handoff: list=2, ID-taking=3, missing/unknown=2, no args=3 (#1349)", () => {
  assert.equal(maxPositionalsFor("handoff"), 3);
  assert.equal(maxPositionalsFor("handoff", ["handoff", "list"]), 2);
  assert.equal(maxPositionalsFor("handoff", ["handoff", "list", "extra"]), 2);
  for (const verb of ID_TAKING) {
    assert.equal(maxPositionalsFor("handoff", ["handoff", verb]), 3, verb);
    assert.equal(maxPositionalsFor("handoff", ["handoff", verb, HANDOFF_ID]), 3, verb);
    assert.equal(maxPositionalsFor("handoff", ["handoff", verb, HANDOFF_ID, "extra"]), 3, verb);
  }
  assert.equal(maxPositionalsFor("handoff", ["handoff"]), 2);
  assert.equal(maxPositionalsFor("handoff", ["handoff", "explode"]), 2);
  assert.equal(maxPositionalsFor("handoff", ["handoff", "explode", "extra"]), 2);
});

test("CLI: extra positional after handoff list is over budget (#1349)", () => {
  const cmd = parseHandoff(["handoff", "list", "extra"]);
  assert.deepEqual(cmd.args, ["handoff", "list", "extra"]);
  assert.ok(
    cmd.args.length > maxPositionalsFor(cmd.args[0], cmd.args),
    "list extra must be over budget before a list read",
  );
});

test("CLI: missing ID for show|answer|reject|supersede reaches dispatch (not extra-positionals) (#1349)", () => {
  for (const verb of ID_TAKING) {
    const cmd = parseHandoff(["handoff", verb, "--issue", "42"]);
    assert.deepEqual(cmd.args, ["handoff", verb], verb);
    assert.equal(cmd.args[2], undefined, verb);
    assert.ok(
      underBudget(cmd),
      `${verb} without ID must reach dispatch missing-id usage, not extra-positionals`,
    );
  }
});

test("CLI: extra positional after handoff <verb> <id> is over budget (#1349)", () => {
  for (const verb of ID_TAKING) {
    const cmd = parseHandoff(["handoff", verb, HANDOFF_ID, "extra"]);
    assert.deepEqual(cmd.args, ["handoff", verb, HANDOFF_ID, "extra"], verb);
    assert.ok(
      cmd.args.length > maxPositionalsFor(cmd.args[0], cmd.args),
      `${verb} extra must be over budget before a read or mutation`,
    );
  }
});

test("CLI: missing handoff verb is admitted to dispatch usage (budget 2) (#1349)", () => {
  const cmd = parseHandoff(["handoff"]);
  assert.deepEqual(cmd.args, ["handoff"]);
  assert.equal(maxPositionalsFor("handoff", cmd.args), 2);
  assert.ok(underBudget(cmd));
});

test("CLI: unknown handoff verb is admitted to dispatch usage (budget 2) (#1349)", () => {
  const cmd = parseHandoff(["handoff", "explode"]);
  assert.deepEqual(cmd.args, ["handoff", "explode"]);
  assert.equal(maxPositionalsFor("handoff", cmd.args), 2);
  assert.ok(underBudget(cmd));
});

test("CLI: extra token after unknown handoff verb is over budget (#1349)", () => {
  const cmd = parseHandoff(["handoff", "explode", "extra"]);
  assert.ok(cmd.args.length > maxPositionalsFor(cmd.args[0], cmd.args));
});

// ---------------------------------------------------------------------------
// 1.4 Spawn only guard-rejected extras. Do not spawn a valid handoff list.
// ---------------------------------------------------------------------------

test("CLI spawn: handoff list extra exits 2 with unexpected argument(s) (#1349)", () => {
  const r = spawnPipeline(["handoff", "list", "extra"]);
  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /unexpected argument\(s\): extra/);
  assert.doesNotMatch(r.stderr, /list,/);
});

test("CLI spawn: extra token after ID-taking handoff verb exits 2 before handler (#1349)", () => {
  for (const verb of ID_TAKING) {
    const r = spawnPipeline(["handoff", verb, HANDOFF_ID, "extra"]);
    assert.equal(r.status, 2, `${verb} stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /unexpected argument\(s\): extra/);
  }
});

test("main extra-positionals call site passes cmd.args so list extra stays over budget (#1349)", () => {
  const src = fs.readFileSync(PIPELINE_SCRIPT, "utf8");
  const call = "maxPositionalsFor(cmd.args[0], cmd.args)";
  assert.ok(src.includes(call), `main must pass cmd.args; missing ${call}`);
});
