import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FactoryController, FactoryStop, validateProductionPinRecord } from "../lib/controller.mjs";
import { CommandError } from "../lib/runtime.mjs";
import { durableCommandPaths, durableUnitName } from "../lib/durable-command.mjs";
import { admittedJournal, config, fail, NOW, ok } from "./helpers.mjs";

function controllerHarness({
  exec,
  getStopReason = async () => null,
  notices = null,
  now = () => NOW,
  unlink = null,
  configOverrides = {},
  envelopeOverrides = {},
} = {}) {
  return admittedJournal(configOverrides, envelopeOverrides).then(({ fs, store, grant, journal }) => {
    const machine = config(configOverrides);
    const sent = [];
    const sink = notices ?? {
      async send(kind, fields, options) { sent.push({ kind, fields, options }); return { delivered: true }; },
      async heartbeat() { return { delivered: false, skipped: true }; },
      async flushPending() { return { delivered: 0, pending: 0 }; },
    };
    const controller = new FactoryController({
      config: machine,
      configPath: "/config.json",
      validated: grant,
      store,
      journal,
      exec: exec ?? (async () => ok()),
      readFile: fs.deps.readFile,
      writeFile: fs.deps.writeFile,
      mkdir: fs.deps.mkdir,
      unlink: unlink ?? (async (path) => { fs.files.delete(path); }),
      now,
      sleep: async () => {},
      getStopReason,
      notices: sink,
      envFor: (role) => role === "pipeline"
        ? { PATH: "/usr/bin", HOME: "/home/user", GH_TOKEN: "gh-canary" }
        : { PATH: "/usr/bin", HOME: "/home/user" },
      probeGrokModel: async () => ({ effective_model: "grok-4.5" }),
    });
    return { controller, machine, fs, store, grant, journal, sent };
  });
}

function recordPromotion(harness, previousPin, mergeOid = "2".repeat(40)) {
  harness.journal.actions.promoted = {
    action_id: "promoted",
    kind: "pin_promote",
    target: { version: harness.grant.grant.release_version, merge_oid: mergeOid },
    state: "completed",
    observed: { previous_pin: previousPin },
    result: { version: harness.grant.grant.release_version, tag: `v${harness.grant.grant.release_version}`, git_sha: mergeOid },
  };
}

test("production pin reads the machine file and expands its verified tag commit", async () => {
  const harness = await controllerHarness();
  const resolved = "f".repeat(40);
  harness.fs.files.set(harness.machine.production_pin_file, JSON.stringify({
    schema_version: 1,
    version: "1.31.1",
    tag: "v1.31.1",
    git_sha: resolved.slice(0, 10),
  }));
  harness.controller.pipeline = async () => {
    throw new Error("the installed Pipeline CLI must not be used to read the pin");
  };
  harness.controller.git = async (args) => {
    assert.deepEqual(args, ["rev-parse", "refs/tags/v1.31.1^{}"]);
    return ok(`${resolved}\n`);
  };

  assert.deepEqual(await harness.controller.readProductionPin(), {
    version: "1.31.1",
    tag: "v1.31.1",
    git_sha: resolved,
  });
});

test("production pin rejects an abbreviated commit that does not match the tag", () => {
  assert.throws(
    () => validateProductionPinRecord({
      schema_version: 1,
      version: "1.31.1",
      tag: "v1.31.1",
      git_sha: "a".repeat(10),
    }, "b".repeat(40)),
    /production pin is missing or invalid/,
  );
});

test("pin mutation commands stay compatible with the pinned v1.31.1 CLI", async () => {
  const harness = await controllerHarness();
  const promote = harness.controller.factoryPinPromoteArgs("1.33.0", "c".repeat(40));
  const rollback = harness.controller.factoryPinRollbackArgs("1.31.1");
  assert.deepEqual(promote.slice(0, 4), ["factory-pin", "promote", "--for", "1.33.0"]);
  assert.deepEqual(rollback.slice(0, 4), ["factory-pin", "rollback", "--to", "1.31.1"]);
  assert.equal(promote.includes("--json"), false);
  assert.equal(rollback.includes("--json"), false);
});

async function authorityLossCompensationHarness({ getStopReason, now }) {
  const previous = { version: "1.32.0", tag: "v1.32.0", git_sha: "1".repeat(40) };
  const priorArtifactLauncher = "/artifact/plugin/pipeline/skills/pipeline/scripts/pipeline.mjs";
  const liveLauncher = "/home/user/.codex/skills/pipeline/scripts/pipeline.mjs";
  const launches = [];
  const directCompensationCalls = [];
  let installedVersion = previous.version;
  let harnessFs;
  const harness = await controllerHarness({
    getStopReason,
    now,
    exec: async (command, args, options) => {
      if (command === "/usr/bin/systemd-run") {
        launches.push(args);
        assert.equal(await options.shouldStop(), null, "journal-bound compensation must ignore later stop state");
        if (args.includes("factory-pin") || args.includes("doctor")) {
          assert.ok(args.includes(priorArtifactLauncher));
          assert.ok(!args.includes(liveLauncher));
        }
        if (args.includes("doctor")) {
          const output = args.find((arg) => arg.startsWith("--property=StandardOutput=append:"));
          const outputPath = output.slice("--property=StandardOutput=append:".length);
          harnessFs.files.set(outputPath, JSON.stringify({
            schema_version: "1",
            status: "ok",
            version: previous.version,
            checks: [
              { name: "harness-smoke:grok:implementer:grok-4.5", ok: true },
              { name: "harness-smoke:codex:reviewer", ok: true },
            ],
          }));
        }
        if (args.includes("/artifact/scripts/install.mjs")) installedVersion = previous.version;
        return ok();
      }
      if (command === "/usr/bin/systemctl") {
        if (args.includes("show")) {
          return ok("LoadState=loaded\nActiveState=inactive\nSubState=exited\nResult=success\nExecMainStatus=0\n");
        }
        return ok();
      }
      if (command === "/usr/bin/git") {
        directCompensationCalls.push({ command, args });
        assert.equal(await options.shouldStop(), null);
        if (args[0] === "status") return ok();
        if (args[0] === "cat-file") return ok("tag\n");
        if (args[0] === "rev-parse") return ok(`${previous.git_sha}\n`);
        return ok();
      }
      if (command === "/usr/bin/node") {
        directCompensationCalls.push({ command, args });
        assert.equal(await options.shouldStop(), null);
        assert.equal(args[0], priorArtifactLauncher, "compensation must not depend on the replaced live launcher");
        if (args.includes("factory-pin") && args.includes("show")) {
          return ok(JSON.stringify({ kind: "ok", pin: previous }));
        }
        if (args.includes("--version")) return ok(`${installedVersion}\n`);
      }
      throw new Error(`unexpected compensation command: ${command} ${args.join(" ")}`);
    },
  });
  harnessFs = harness.fs;
  harnessFs.files.set(harness.machine.production_pin_file, JSON.stringify({
    schema_version: 1,
    ...previous,
  }));
  recordPromotion(harness, previous);
  return {
    ...harness,
    previous,
    priorArtifactLauncher,
    liveLauncher,
    launches,
    directCompensationCalls,
    setInstalledVersion(value) { installedVersion = value; },
  };
}

test("durable command records one transient unit and passes secrets only through its private env file", async () => {
  const calls = [];
  const harness = await controllerHarness({
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "/usr/bin/systemctl") {
        return ok("LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\n");
      }
      return ok();
    },
  });
  const started = await harness.store.beginAction(harness.journal, "issue_advance", { issue: 905 });
  const result = await harness.controller.durableCommand(
    started.id,
    "issue-advance",
    "/usr/bin/node",
    ["/pipeline.mjs", "single", "905"],
  );
  assert.equal(result.code, 0);
  const record = harness.journal.actions[started.id];
  assert.match(record.observed.service_unit, /^hermes-factory-/);
  assert.equal(record.observed.unit_result, "complete");
  const launch = calls.find((call) => call.command === "/usr/bin/systemd-run");
  assert.ok(launch);
  assert.equal(launch.options.env.GH_TOKEN, undefined);
  assert.doesNotMatch(JSON.stringify(launch.args), /gh-canary/);
});

test("restart reconciles the same unit and forwards each material event once", async () => {
  const calls = [];
  const eventLine = JSON.stringify({ seq: 1, time: "2026-08-08T12:00:00Z", kind: "loop_item_stage_progress", data: { item_id: "905", stage: "review", round: 1, at: "2026-08-08T12:00:00Z" } });
  const harness = await controllerHarness({
    exec: async (command, args) => {
      calls.push(command);
      if (command === "/usr/bin/node" && args.some((arg) => arg.endsWith("material-filter.mjs"))) {
        return ok(`${eventLine}\n`);
      }
      return ok("LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\n");
    },
  });
  const started = await harness.store.beginAction(harness.journal, "issue_advance", { issue: 905 });
  const unit = durableUnitName(harness.grant.fingerprint, "issue_advance", started.id);
  const paths = durableCommandPaths(harness.machine.state_dir, harness.grant.fingerprint, started.id);
  const runId = "pipeline-loop-905";
  const eventsPath = `${harness.machine.pipeline_loop_state_dir}/${runId}/events.jsonl`;
  harness.fs.files.set(paths.output, `${JSON.stringify({ kind: "loop_run_handoff", run_id: runId, run_dir: `${harness.machine.pipeline_loop_state_dir}/${runId}`, events: eventsPath })}\n`);
  harness.fs.files.set(eventsPath, `${eventLine}\n`);
  await harness.store.observeAction(harness.journal, started.id, {
    service_unit: unit,
    output_path: paths.output,
    diagnostic_path: paths.diagnostic,
    last_event_cursor: 0,
    launch_digest: createHash("sha256")
      .update(JSON.stringify({ command: "/usr/bin/node", args: ["ignored"], env_role: "pipeline" }))
      .digest("hex"),
    launch_ack: true,
  });
  await harness.controller.durableCommand(started.id, "issue-advance", "/usr/bin/node", ["ignored"]);
  await harness.controller.monitorDurableCommand(started.id);
  assert.equal(calls.includes("/usr/bin/systemd-run"), false);
  assert.equal(harness.sent.filter((notice) => notice.kind === "stage_change").length, 1);
  assert.equal(harness.journal.actions[started.id].observed.last_event_cursor, 1);
});

test("material event cursor advances only after notice delivery acknowledgment", async () => {
  const eventLine = JSON.stringify({ seq: 1, time: "2026-08-08T12:00:00Z", kind: "loop_item_stage_progress", data: { item_id: "905", stage: "review", round: 1, at: "2026-08-08T12:00:00Z" } });
  let acknowledge = false;
  let sends = 0;
  const harness = await controllerHarness({
    notices: {
      async send() { sends += 1; return acknowledge ? { delivered: true } : { delivered: false }; },
      async heartbeat() { return { skipped: true }; },
      async flushPending() { return { delivered: 0, pending: 0 }; },
    },
    exec: async (command, args) => command === "/usr/bin/node" && args.some((arg) => arg.endsWith("material-filter.mjs"))
      ? ok(`${eventLine}\n`)
      : ok(),
  });
  const started = await harness.store.beginAction(harness.journal, "issue_advance", { issue: 905 });
  const paths = durableCommandPaths(harness.machine.state_dir, harness.grant.fingerprint, started.id);
  const runId = "pipeline-loop-905";
  const eventsPath = `${harness.machine.pipeline_loop_state_dir}/${runId}/events.jsonl`;
  harness.fs.files.set(paths.output, `${JSON.stringify({ kind: "loop_run_handoff", run_id: runId, run_dir: `${harness.machine.pipeline_loop_state_dir}/${runId}`, events: eventsPath })}\n`);
  harness.fs.files.set(eventsPath, `${eventLine}\n`);
  await harness.store.observeAction(harness.journal, started.id, { output_path: paths.output, last_event_cursor: 0 });
  await harness.controller.monitorDurableCommand(started.id);
  assert.equal(harness.journal.actions[started.id].observed.last_event_cursor, 0);
  acknowledge = true;
  await harness.controller.monitorDurableCommand(started.id);
  assert.equal(harness.journal.actions[started.id].observed.last_event_cursor, 1);
  assert.equal(sends, 2);
});

test("durable unit identity always uses the journal action kind", async () => {
  const calls = [];
  const harness = await controllerHarness({
    exec: async (command, args) => {
      calls.push({ command, args });
      if (command === "/usr/bin/systemctl") {
        return ok("LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\n");
      }
      return ok();
    },
  });
  const started = await harness.store.beginAction(harness.journal, "issue_pr_merge", { issue: 905, pr: 44 });
  await harness.controller.durableCommand(started.id, "issue-merge", "/usr/bin/node", ["ignored"]);
  const expected = durableUnitName(harness.grant.fingerprint, "issue_pr_merge", started.id);
  assert.equal(harness.journal.actions[started.id].observed.service_unit, expected);
  assert.ok(calls.some((call) => call.command === "/usr/bin/systemd-run" && call.args.includes(`--unit=${expected}`)));
});

test("systemd observation and stop failures never claim that a mutating unit stopped", async () => {
  const observeFailure = await controllerHarness({ exec: async () => fail("D-Bus unavailable") });
  await assert.rejects(() => observeFailure.controller.unitState("hermes-factory-test"), /could not prove/);

  const stopFailure = await controllerHarness({ exec: async () => fail("access denied") });
  await assert.rejects(() => stopFailure.controller.stopUnit("hermes-factory-test"), /could not prove|did not confirm stop/);
});

test("a missing unit relaunches only an explicitly idempotent action", async () => {
  for (const [safeRetry, shouldRelaunch] of [[true, true], [false, false]]) {
    const harness = await controllerHarness({
      exec: async () => ok("LoadState=not-found\nActiveState=inactive\nResult=success\nExecMainStatus=0\n"),
    });
    const target = { issue: 905 };
    const started = await harness.store.beginAction(harness.journal, "issue_advance", target);
    const paths = durableCommandPaths(harness.machine.state_dir, harness.grant.fingerprint, started.id);
    await harness.store.observeAction(harness.journal, started.id, {
      service_unit: durableUnitName(harness.grant.fingerprint, "issue_advance", started.id),
      output_path: paths.output,
      diagnostic_path: paths.diagnostic,
      launch_digest: "a".repeat(64),
      launch_ack: false,
    });
    let invoked = false;
    const operation = harness.controller.runAction("issue_advance", target, {
      safeRetry,
      invoke: async () => { invoked = true; },
      reconcile: async () => invoked
        ? { state: "complete", result: { issue: 905 } }
        : { state: "not_done" },
    });
    if (shouldRelaunch) {
      assert.deepEqual(await operation, { issue: 905 });
      assert.equal(invoked, true);
    } else {
      await assert.rejects(() => operation, /safe restart result/);
      assert.equal(invoked, false);
    }
  }
});

test("run records child stop and revoke as terminal states", async () => {
  for (const [reason, expected] of [["stop: requested", "stopped"], ["revoke: requested", "revoked"]]) {
    const harness = await controllerHarness();
    harness.controller.preflight = async () => {
      throw new CommandError("stopped", { command: "unit", code: 1, stopped: reason });
    };
    await assert.rejects(() => harness.controller.run(), CommandError);
    assert.equal(harness.journal.status, expected);
  }
});

test("run preserves a successful rollback instead of overwriting it with failed", async () => {
  const harness = await controllerHarness();
  harness.controller.preflight = async () => {
    await harness.store.markStatus(harness.journal, "rolled_back");
    throw new FactoryStop("install-rolled-back", "restored");
  };
  await assert.rejects(() => harness.controller.run(), /restored/);
  assert.equal(harness.journal.status, "rolled_back");
});

test("merge frontier stops when origin base contains an ungranted commit", async () => {
  const harness = await controllerHarness();
  harness.controller.containsInBase = async () => true;
  harness.controller.fetchedBaseTip = async () => "f".repeat(40);
  await assert.rejects(() => harness.controller.verifyPriorIssueMerges(0), /outside the granted merge train/);
  harness.controller.fetchedBaseTip = async () => harness.machine.bootstrap_base_git_sha;
  await assert.doesNotReject(() => harness.controller.verifyPriorIssueMerges(0));
});

test("issue merge reconciliation keeps the reviewed head and requires merge result as exact base tip", async () => {
  const mergeOid = "e".repeat(40);
  const baseOid = "d".repeat(40);
  let baseTip = mergeOid;
  const harness = await controllerHarness({
    exec: async (command, args) => {
      if (command === "/usr/bin/gh" && args[0] === "pr") {
        return ok(JSON.stringify({
          number: 44,
          state: "MERGED",
          isDraft: false,
          headRefName: "pipeline/905-change",
          headRefOid: "a".repeat(40),
          baseRefName: "main",
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
          mergeCommit: { oid: mergeOid },
          title: "change",
          body: "",
          changedFiles: 0,
        }));
      }
      if (command === "/usr/bin/gh" && args[0] === "api" && args[1].includes("/pulls/44/files")) {
        return ok("[[]]");
      }
      if (command === "/usr/bin/git" && args[0] === "rev-parse") {
        return ok(`${args[1].endsWith("^") ? baseOid : baseTip}\n`);
      }
      return ok();
    },
  });
  const exact = await harness.controller.reconcileIssueMerge({ issue: 905, pr: 44, head_oid: "a".repeat(40), base_oid: baseOid });
  assert.equal(exact.state, "complete");
  assert.equal(exact.result.merge_oid, mergeOid);
  const headDrift = await harness.controller.reconcileIssueMerge({ issue: 905, pr: 44, head_oid: "b".repeat(40), base_oid: baseOid });
  assert.equal(headDrift.state, "unsafe");
  baseTip = "f".repeat(40);
  const scopeDrift = await harness.controller.reconcileIssueMerge({ issue: 905, pr: 44, head_oid: "a".repeat(40), base_oid: baseOid });
  assert.equal(scopeDrift.state, "unsafe");
  assert.match(scopeDrift.detail, /exactly/);
});

test("ready issue observation rejects a closed issue and a draft linked PR", async () => {
  const head = "a".repeat(40);
  for (const [issueState, isDraft, expected] of [["CLOSED", false, /not open/], ["OPEN", true, /draft/]]) {
    const harness = await controllerHarness({
      exec: async (command, args) => {
        if (command === "/usr/bin/gh" && args[0] === "issue") {
          return ok(JSON.stringify({
            number: 905,
            state: issueState,
            labels: [{ name: "pipeline:ready-to-deploy" }],
            milestone: { title: "v1.32.1" },
            comments: [
              { author: { login: "factory-operator" }, body: "## Plan Review\n**Reviewer**: codex" },
              { author: { login: "factory-operator" }, body: `## Review 2\n**Reviewer**: codex\n<!-- reviewed-sha: ${head} -->` },
            ],
          }));
        }
        if (command === "/usr/bin/gh" && args[0] === "api") {
          return ok(JSON.stringify({ data: { repository: { pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              number: 44,
              state: "OPEN",
              isDraft,
              headRefName: "pipeline/905-change",
              headRefOid: head,
              baseRefName: "main",
              isCrossRepository: false,
              closingIssuesReferences: { nodes: [{ number: 905, repository: { name: "repo", owner: { login: "owner" } } }] },
            }],
          } } } }));
        }
        return ok();
      },
    });
    harness.controller.githubActor = "factory-operator";
    harness.controller.proveIssueRun = async () => ({ run_id: "905-run", reviewed_head: head });
    const result = await harness.controller.observeReadyIssue(905);
    assert.equal(result.state, "unsafe");
    assert.match(result.detail, expected);
  }
});

test("issue waves refresh, validate, advance, and merge in the granted order", async () => {
  const harness = await controllerHarness();
  const calls = [];
  harness.controller.refreshBase = async () => calls.push("refresh");
  harness.controller.verifyPriorIssueMerges = async (index) => { calls.push(`frontier:${index}`); return harness.machine.bootstrap_base_git_sha; };
  harness.controller.validateProductionRuntime = async () => calls.push("runtime");
  harness.controller.driveIssue = async (issue) => { calls.push(`advance:${issue}`); return { issue, pr: issue + 1000, head_oid: "a".repeat(40) }; };
  harness.controller.mergeIssue = async (candidate) => { calls.push(`merge:${candidate.issue}`); return { ...candidate, merge_oid: "b".repeat(40) }; };
  await harness.controller.driveIssues();
  assert.deepEqual(calls, [
    "refresh", "frontier:0", "runtime", "advance:905", "merge:905", "refresh",
    "refresh", "frontier:1", "runtime", "advance:874", "merge:874", "refresh",
    "refresh", "frontier:2", "runtime", "advance:870", "merge:870", "refresh",
  ]);
});

test("restart skips a contiguous completed train and rejects a journal gap", async () => {
  const harness = await controllerHarness();
  for (const issue of [905, 874, 870]) {
    harness.journal.actions[`merge-${issue}`] = {
      kind: "issue_pr_merge",
      target: { issue },
      state: "completed",
      result: { merge_oid: String(issue).padEnd(40, "a") },
    };
  }
  const calls = [];
  harness.controller.refreshBase = async () => calls.push("refresh");
  harness.controller.verifyPriorIssueMerges = async (index) => calls.push(`frontier:${index}`);
  harness.controller.driveIssue = async () => { throw new Error("must not rerun"); };
  await harness.controller.driveIssues();
  assert.deepEqual(calls, ["refresh", "frontier:3"]);

  harness.journal.actions["merge-874"].state = "failed";
  await assert.rejects(() => harness.controller.driveIssues(), /non-contiguous/);
});

test("integrated candidate binds the freshly fetched final train tip, not the bootstrap wrapper commit", async () => {
  const harness = await controllerHarness();
  const finalTip = "e".repeat(40);
  harness.journal.actions["merge-870"] = {
    kind: "issue_pr_merge",
    target: { issue: 870 },
    state: "completed",
    result: { merge_oid: finalTip },
  };
  harness.controller.refreshBase = async () => {};
  let observedHead = finalTip;
  harness.controller.git = async (args) => {
    if (args[0] === "rev-parse") return ok(`${observedHead}\n`);
    if (args[0] === "status") return ok("");
    return ok();
  };
  harness.controller.candidatePipeline = async () => ok("1.32.0\n");
  const candidate = await harness.controller.bindIntegratedCandidate();
  assert.deepEqual(candidate, { git_sha: finalTip, version: "1.32.0" });
  assert.notEqual(candidate.git_sha, harness.machine.wrapper_git_sha);
  const record = Object.values(harness.journal.actions).find((action) => action.kind === "integrated_candidate");
  assert.equal(record.result.git_sha, finalTip);
  observedHead = "f".repeat(40);
  await assert.rejects(() => harness.controller.bindIntegratedCandidate(), /last granted merge result/);
});

test("later release uses one unchanged request across checkpoint, trusted attestation, and completion", async () => {
  const productionPin = { version: "1.33.0", tag: "v1.33.0", git_sha: "1".repeat(40) };
  const mergeOids = ["2".repeat(40), "3".repeat(40), "4".repeat(40)];
  const candidate = { git_sha: mergeOids[2], version: "1.33.0" };
  const harness = await controllerHarness({
    envelopeOverrides: {
      grant: { release_version: "1.34.0", milestone: "v1.34.0", nonce: "release-1.34.0-run-001" },
    },
  });
  harness.journal.actions.frontier = {
    action_id: "frontier",
    kind: "starting_frontier",
    state: "completed",
    result: {
      release_version: "1.34.0",
      git_sha: productionPin.git_sha,
      candidate_version: productionPin.version,
      production_pin: productionPin,
      pilot: false,
    },
  };
  harness.grant.grant.ordered_issues.forEach((issue, index) => {
    harness.journal.actions[`merge-${issue}`] = {
      action_id: `merge-${issue}`,
      kind: "issue_pr_merge",
      target: { issue },
      state: "completed",
      result: {
        issue,
        pr: 100 + index,
        head_oid: String(index + 6).repeat(40),
        base_oid: index === 0 ? productionPin.git_sha : mergeOids[index - 1],
        merge_oid: mergeOids[index],
      },
    };
  });

  const signedBody = "signed FRG evidence\n";
  const signedDigest = createHash("sha256").update(signedBody).digest("hex");
  const evidencePath = "/repo/.agent-pipeline/frg/1.34.0/frg-134/evidence.json";
  const latestPath = "/repo/.agent-pipeline/frg/1.34.0/latest.json";
  harness.fs.files.set(evidencePath, signedBody);
  harness.fs.files.set(latestPath, signedBody);
  const calls = [];
  let requestPath = null;
  let checkpoint = null;
  let handoff = null;
  harness.controller.durableCommand = async (actionId, kind, command, args, options = {}) => {
    calls.push({ actionId, kind, command, args, options });
    if (kind === "native-release-checkpoint") {
      requestPath = args[args.indexOf("--request") + 1];
      const request = JSON.parse(harness.fs.files.get(requestPath));
      checkpoint = {
        schema_version: 1,
        kind: "factory_release_frg_checkpoint",
        status: "awaiting_frg_attestation",
        action_id: request.action_id,
        grant_fingerprint: request.grant_fingerprint,
        repository: request.repository,
        base_branch: request.base_branch,
        target_version: request.target_version,
        candidate_git_sha: request.integrated_candidate.git_sha,
        checkpoint: "unsigned-134",
        frg: {
          pack_id: request.frg_manifest.pack_id,
          manifest_path: "/repo/core/scripts/frg-packs/factory-gate-v1/manifest.json",
          manifest_sha256: request.frg_manifest.sha256,
          pack_run_id: "pack-134",
          loop_run_id: "loop-134",
          frg_run_id: "frg-134",
          evidence_created_at: NOW.toISOString(),
          observations: { path: "/state/native/observations.json", sha256: "1".repeat(64) },
          evidence_bundle: { path: "/state/native/evidence-bundle.json", sha256: "2".repeat(64) },
          contract: { path: "/state/native/contract.json", sha256: "3".repeat(64) },
          ledger: { path: "/state/native/ledger.jsonl", sha256: "4".repeat(64) },
          events: { path: "/state/native/events.jsonl", sha256: "5".repeat(64) },
          action_evidence: { path: "/state/native/action-evidence.json", sha256: "6".repeat(64) },
        },
      };
      return ok(JSON.stringify(checkpoint));
    }
    if (kind === "native-release-attest") {
      assert.deepEqual(args.slice(-4), ["--checkpoint", `${requestPath.replace(/\.request\.json$/, ".checkpoint.json")}`, "--config", "/config.json"]);
      assert.equal(options.envRole, "frg_runner");
      handoff = {
        schema_version: 1,
        kind: "frg_attestation_handoff",
        status: "complete",
        action_id: checkpoint.action_id,
        grant_fingerprint: checkpoint.grant_fingerprint,
        checkpoint: checkpoint.checkpoint,
        version: checkpoint.target_version,
        candidate_git_sha: checkpoint.candidate_git_sha,
        manifest_sha256: checkpoint.frg.manifest_sha256,
        pack_run_id: checkpoint.frg.pack_run_id,
        loop_run_id: checkpoint.frg.loop_run_id,
        frg_run_id: checkpoint.frg.frg_run_id,
        signer: {
          mode: "installed-production",
          version: productionPin.version,
          tag: productionPin.tag,
          git_sha: productionPin.git_sha,
          policy_id: "factory-gate-v2",
          policy_sha256: "7".repeat(64),
        },
        attestation_payload_sha256: "8".repeat(64),
        frg_evidence_path: evidencePath,
        frg_evidence_sha256: signedDigest,
        frg_latest_path: latestPath,
        frg_latest_sha256: signedDigest,
      };
      return ok(JSON.stringify(handoff));
    }
    assert.equal(kind, "native-release-prepare");
    assert.equal(args[args.indexOf("--request") + 1], requestPath, "both candidate calls use one unchanged request");
    const request = JSON.parse(harness.fs.files.get(requestPath));
    return ok(JSON.stringify({
      schema_version: 1,
      kind: "factory_release_prepared",
      status: "complete",
      action_id: request.action_id,
      grant_fingerprint: request.grant_fingerprint,
      repository: request.repository,
      base_branch: request.base_branch,
      target_version: request.target_version,
      milestone: request.milestone,
      candidate_git_sha: request.integrated_candidate.git_sha,
      frg: {
        pack_id: checkpoint.frg.pack_id,
        pack_run_id: checkpoint.frg.pack_run_id,
        loop_run_id: checkpoint.frg.loop_run_id,
        run_id: checkpoint.frg.frg_run_id,
        manifest_sha256: checkpoint.frg.manifest_sha256,
        evidence_sha256: handoff.frg_evidence_sha256,
      },
      release_pr: { number: 1340, head_oid: "f".repeat(40), base_oid: candidate.git_sha },
      checkpoint: "prepared-134",
    }));
  };
  harness.controller.reconcileNativeReleasePrepare = async (request, record) => {
    assert.equal(record.observed.native_result.action_id, request.action_id);
    return {
      state: "complete",
      result: {
        version: request.target_version,
        pr: 1340,
        head_oid: "f".repeat(40),
        frg_run_id: checkpoint.frg.frg_run_id,
        base_oid: candidate.git_sha,
        native_checkpoint: "prepared-134",
        frg_evidence_sha256: handoff.frg_evidence_sha256,
      },
    };
  };

  const result = await harness.controller.prepareNativeRelease(candidate);
  assert.equal(result.pr, 1340);
  assert.deepEqual(calls.map((call) => call.kind), [
    "native-release-checkpoint",
    "native-release-attest",
    "native-release-prepare",
  ]);
  const firstRequest = calls[0].args[calls[0].args.indexOf("--request") + 1];
  const secondRequest = calls[2].args[calls[2].args.indexOf("--request") + 1];
  assert.equal(firstRequest, secondRequest);
  assert.equal(calls.filter((call) => call.kind === "native-release-attest").length, 1);

  await harness.controller.prepareNativeRelease(candidate);
  assert.equal(calls.length, 3, "completed phases reconcile without another candidate or attestor process");
});

test("release finalization passes the inspected release head to GitHub match-head-commit", async () => {
  const calls = [];
  const releaseHead = "a".repeat(40);
  const baseOid = "d".repeat(40);
  const harness = await controllerHarness({
    exec: async (command, args) => {
      calls.push({ command, args });
      if (command === "/usr/bin/gh" && args[0] === "pr" && args[1] === "view") {
        return ok(JSON.stringify({
          number: 77,
          state: "OPEN",
          isDraft: false,
          headRefName: "release/v1.32.1",
          headRefOid: releaseHead,
          baseRefName: "main",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          mergeCommit: null,
          title: "release: 1.32.1 — factory",
          body: "## Release: v1.32.1 — factory\nFRG run_id:** `frg-1`",
          changedFiles: 3,
        }));
      }
      if (command === "/usr/bin/gh" && args[0] === "api" && args[1].includes("/pulls/77/files")) {
        return ok(JSON.stringify([[
          { filename: "package.json" },
          { filename: "core/package.json" },
          { filename: ".agent-pipeline/frg/1.32.1/evidence.json" },
        ]]));
      }
      if (command === "/usr/bin/gh" && args[0] === "pr" && args[1] === "checks") {
        return ok(JSON.stringify([{ name: "ci", bucket: "pass" }]));
      }
      return ok();
    },
  });
  harness.controller.runAction = async (_kind, _target, operations) => {
    await operations.invoke("not-used");
    return { merged: true };
  };
  harness.controller.fetchedBaseTip = async () => baseOid;
  await harness.controller.finalizeRelease({
    version: "1.32.1",
    pr: 77,
    head_oid: releaseHead,
    frg_run_id: "frg-1",
    base_oid: baseOid,
  });
  const merge = calls.find((call) => call.args[0] === "pr" && call.args[1] === "merge");
  assert.ok(merge);
  assert.ok(merge.args.includes("--squash"));
  assert.equal(merge.args[merge.args.indexOf("--match-head-commit") + 1], releaseHead);
});

test("a crash after pin promotion reuses the stored pre-promotion pin for rollback", async () => {
  const harness = await controllerHarness();
  const previous = { version: "1.32.0", tag: "v1.32.0", git_sha: "1".repeat(40) };
  harness.journal.actions.promoted = {
    kind: "pin_promote",
    target: { version: "1.32.1" },
    state: "completed",
    observed: { previous_pin: previous },
  };
  harness.controller.readProductionPin = async () => ({ version: "1.32.1", tag: "v1.32.1", git_sha: "2".repeat(40) });
  harness.controller.promotePin = async (_publication, baseline) => {
    assert.deepEqual(baseline, previous);
    return { version: "1.32.1", tag: "v1.32.1", git_sha: "2".repeat(40), previous_pin: previous };
  };
  harness.controller.runAction = async () => { throw new Error("install failed"); };
  harness.controller.rollback = async (baseline) => {
    assert.deepEqual(baseline, previous);
    return { version: previous.version, restored_tag: previous.tag };
  };
  await assert.rejects(() => harness.controller.promoteAndInstall({ merge_oid: "2".repeat(40) }), /previous verified pin was restored/);
  assert.equal(harness.journal.status, "rolled_back");
});

test("rollback resumes after the pin was restored and binds the prior git commit", async () => {
  const harness = await controllerHarness();
  const previous = { version: "1.32.0", tag: "v1.32.0", git_sha: "1".repeat(40) };
  recordPromotion(harness, previous);
  const started = await harness.store.beginAction(harness.journal, "rollback", previous);
  assert.equal(started.state, "started");
  let installed = false;
  let restoreCalls = 0;
  let installCalls = 0;
  harness.controller.guard = async () => {};
  harness.controller.checkoutArtifact = async (tag, oid, options) => {
    assert.deepEqual([tag, oid, options.compensationPin], [previous.tag, previous.git_sha, previous]);
  };
  harness.controller.restoreProductionPin = async (pin) => {
    restoreCalls += 1;
    assert.deepEqual(pin, previous);
  };
  harness.controller.installTag = async (tag, oid, action) => {
    installCalls += 1;
    assert.deepEqual([tag, oid, action], [previous.tag, previous.git_sha, "rollback"]);
    installed = true;
  };
  harness.controller.observeInstalled = async () => installed ? { version: previous.version, doctor: "ok" } : null;
  harness.controller.readProductionPin = async () => previous;
  const result = await harness.controller.rollback(previous, new Error("install failed"));
  assert.equal(restoreCalls, 1);
  assert.equal(installCalls, 1);
  assert.equal(result.restored_git_sha, previous.git_sha);
  assert.equal(harness.journal.actions[started.id].state, "completed");
});

test("a stop after pin promotion runs exact journal-bound compensation", async () => {
  const harness = await authorityLossCompensationHarness({
    getStopReason: async () => "stop: operator requested",
    now: () => NOW,
  });

  await assert.rejects(() => harness.controller.run(), /stop: operator requested/);
  assert.equal(harness.journal.status, "rolled_back");
  assert.equal(
    harness.launches.filter((args) => !args.includes("doctor")).length,
    2,
    "rollback launches only pin restore and prior-tag install mutations",
  );
  const launched = harness.launches.flat().join(" ");
  assert.match(launched, /factory-pin rollback --to 1\.32\.0/);
  assert.match(launched, /scripts\/install\.mjs install --host codex/);
  assert.match(launched, new RegExp(harness.priorArtifactLauncher.replaceAll("/", "\\/")));
  assert.doesNotMatch(launched, new RegExp(harness.liveLauncher.replaceAll("/", "\\/")));
  assert.doesNotMatch(launched, /factory-pin promote|v1\.32\.1/);
  assert.ok(harness.directCompensationCalls.some((call) => call.args.includes(`refs/tags/${harness.previous.tag}^{}`)));
  assert.ok(harness.sent.some((notice) => notice.kind === "rollback"));
});

test("grant expiry after pin promotion cannot block exact prior-pin compensation", async () => {
  const harness = await authorityLossCompensationHarness({
    getStopReason: async () => null,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });

  await assert.rejects(() => harness.controller.run(), /grant expired/);
  assert.equal(harness.journal.status, "rolled_back");
  const rollback = Object.values(harness.journal.actions).find((action) => action.kind === "rollback");
  assert.equal(rollback.state, "completed");
  assert.deepEqual(rollback.target, harness.previous);
  assert.equal(rollback.result.version, harness.previous.version);
  assert.equal(rollback.result.doctor, "ok");
  assert.equal(rollback.result.restored_tag, harness.previous.tag);
  assert.equal(rollback.result.restored_git_sha, harness.previous.git_sha);
});

test("terminal durable cleanup retries a private-env unlink failure before recording cleanup", async () => {
  let failUnlink = true;
  let harness;
  harness = await controllerHarness({
    unlink: async (path) => {
      if (failUnlink) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      harness.fs.files.delete(path);
    },
    exec: async (command, args) => {
      if (command === "/usr/bin/systemctl" && args.includes("show")) {
        return ok("LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\n");
      }
      return ok();
    },
  });
  const started = await harness.store.beginAction(harness.journal, "issue_advance", { issue: 905 });
  const paths = durableCommandPaths(harness.machine.state_dir, harness.grant.fingerprint, started.id);
  harness.fs.files.set(paths.env, "PATH=/usr/bin\n");
  await harness.store.observeAction(harness.journal, started.id, {
    service_unit: durableUnitName(harness.grant.fingerprint, "issue_advance", started.id),
    output_path: paths.output,
    diagnostic_path: paths.diagnostic,
    unit_result: "complete",
    unit_exit_code: 0,
  });
  await assert.rejects(() => harness.controller.waitForDurableCommand(started.id), /private child environment/);
  assert.notEqual(harness.journal.actions[started.id].observed.unit_cleanup, true);
  assert.equal(harness.fs.files.has(paths.env), true);
  failUnlink = false;
  await harness.controller.settleTerminalDurableCleanup();
  assert.equal(harness.journal.actions[started.id].observed.unit_cleanup, true);
  assert.equal(harness.fs.files.has(paths.env), false);
});

test("a systemd client error observes and drains an accepted transient unit", async () => {
  const calls = [];
  const harness = await controllerHarness({
    exec: async (command, args) => {
      calls.push({ command, args });
      if (command === "/usr/bin/systemd-run") return fail("D-Bus reply was lost");
      if (command === "/usr/bin/systemctl" && args.includes("show")) {
        return ok("LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\n");
      }
      return ok();
    },
  });
  const started = await harness.store.beginAction(harness.journal, "issue_advance", { issue: 905 });
  const result = await harness.controller.durableCommand(started.id, "issue-advance", "/usr/bin/node", ["ignored"]);
  assert.equal(result.code, 0);
  assert.equal(harness.journal.actions[started.id].observed.launch_ack, true);
  assert.equal(harness.journal.actions[started.id].observed.unit_cleanup, true);
  assert.ok(calls.some((call) => call.command === "/usr/bin/systemctl" && call.args.includes("stop")));
});

test("a failed promotion remains rollback-eligible when its mutation could not be reconciled", async () => {
  const harness = await authorityLossCompensationHarness({
    getStopReason: async () => "stop: promotion exited nonzero after mutating the pin",
    now: () => NOW,
  });
  Object.assign(harness.journal.actions.promoted, {
    state: "failed",
    error: "the promotion command exited nonzero and the reconciliation read failed",
    observed: {
      previous_pin: harness.previous,
      launch_ack: true,
      unit_result: "failed",
      unit_exit_code: 1,
    },
  });
  assert.equal(harness.controller.hasPromotionStarted(), true);

  await assert.rejects(() => harness.controller.run(), /promotion exited nonzero/);
  assert.equal(harness.journal.status, "rolled_back");
  assert.ok(harness.launches.some((args) => args.includes("rollback")));
  assert.ok(harness.launches.some((args) => args.includes(harness.priorArtifactLauncher)));
  assert.ok(harness.launches.every((args) => !args.includes(harness.liveLauncher)));
});

test("a restart after pin restore resumes only the exact prior-tag compensation", async () => {
  const harness = await authorityLossCompensationHarness({
    getStopReason: async () => null,
    now: () => NOW,
  });
  harness.setInstalledVersion("1.32.1");
  const rollback = await harness.store.beginAction(harness.journal, "rollback", harness.previous);
  const restoredPin = await harness.store.beginAction(harness.journal, "rollback_pin", harness.previous);
  await harness.store.completeAction(harness.journal, restoredPin.id, harness.previous);
  let preflightCalls = 0;
  harness.controller.preflight = async () => { preflightCalls += 1; };

  await assert.rejects(() => harness.controller.run(), /forward work remains stopped/);
  assert.equal(preflightCalls, 0);
  assert.equal(harness.journal.status, "rolled_back");
  assert.equal(harness.journal.actions[rollback.id].state, "completed");
  const launched = harness.launches.flat().join(" ");
  assert.match(launched, /scripts\/install\.mjs install --host codex/);
  assert.doesNotMatch(launched, /factory-pin promote|v1\.32\.1/);
  assert.ok(harness.sent.some((notice) => notice.kind === "rollback"));
});

test("a restart after completed rollback records status and notice without forward work", async () => {
  const harness = await authorityLossCompensationHarness({
    getStopReason: async () => null,
    now: () => NOW,
  });
  const completed = await harness.store.beginAction(harness.journal, "rollback", harness.previous);
  await harness.store.completeAction(harness.journal, completed.id, {
    version: harness.previous.version,
    doctor: "ok",
    effective_model: "grok-4.5",
    restored_tag: harness.previous.tag,
    restored_git_sha: harness.previous.git_sha,
    cause: "install failed",
  });
  let preflightCalls = 0;
  harness.controller.preflight = async () => { preflightCalls += 1; };

  await assert.rejects(() => harness.controller.run(), /forward work remains stopped/);
  assert.equal(preflightCalls, 0);
  assert.equal(harness.journal.status, "rolled_back");
  assert.equal(harness.launches.length, 0);
  assert.equal(harness.directCompensationCalls.length, 0);
  assert.equal(
    Object.values(harness.journal.actions).some(
      (action) => action.kind === "install_host" && action.target?.action !== "rollback",
    ),
    false,
  );
  const rollbackNotices = harness.sent.filter((notice) => notice.kind === "rollback");
  assert.equal(rollbackNotices.length, 1);
  assert.equal(rollbackNotices[0].options.dedupeId, `${harness.grant.fingerprint}:rollback`);
});
