#!/usr/bin/env node

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { envForRole, validateMachineConfig } from "./lib/config.mjs";
import { FactoryController } from "./lib/controller.mjs";
import {
  canonicalJson,
  requireFullReleaseGrant,
  validateControlEnvelope,
  validateGrantEnvelope,
} from "./lib/grant.mjs";
import { JournalStore, journalPaths } from "./lib/journal.mjs";
import { probeEffectiveGrokModel } from "./lib/model-proof.mjs";
import { NoticeSink } from "./lib/notices.mjs";
import { assertNoSecret, secretValuesFromEnv } from "./lib/redaction.mjs";
import { requireSuccess, runProcess } from "./lib/runtime.mjs";

function usage() {
  return [
    "Usage:",
    "  factory.mjs validate --config <file> --grant <inbox-event.json>",
    "  factory.mjs validate-active --config <file> --grant <active-grant.json>",
    "  factory.mjs admit --config <file> --grant <inbox-event.json>",
    "  factory.mjs run --config <file> --grant <active-grant.json>",
    "  factory.mjs status --config <file>",
    "  factory.mjs control --config <file> --grant <active-grant.json> --event <inbox-control.json>",
    "  factory.mjs calibrate-notice --config <file> --grant <active-grant.json> --canary-env <NAME>",
  ].join("\n");
}

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const allowedVerbs = new Set(["validate", "validate-active", "admit", "run", "status", "control", "calibrate-notice"]);
  if (!allowedVerbs.has(verb)) throw new Error(usage());
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error(usage());
    const key = flag.slice(2);
    if (!["config", "grant", "event", "canary-env"].includes(key) || key in values) throw new Error(usage());
    values[key] = value;
  }
  if (!values.config) throw new Error("--config is required");
  if (["validate", "validate-active", "admit", "run", "control", "calibrate-notice"].includes(verb) && !values.grant) {
    throw new Error("--grant is required");
  }
  if (verb === "control" && !values.event) throw new Error("--event is required");
  if (verb === "calibrate-notice" && !values["canary-env"]) throw new Error("--canary-env is required");
  return { verb, ...values };
}

async function readJson(path, name) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    throw new Error(`${name} is missing or invalid JSON`);
  }
}

async function requirePrivateRegularFile(path, name) {
  const stat = await fs.stat(path);
  if (!stat.isFile()) throw new Error(`${name} must be a regular file`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${name} must be owned by the factory account`);
  }
  if ((stat.mode & 0o077) !== 0) throw new Error(`${name} must not be accessible by group or other users`);
}

async function requireInside(path, directory, name) {
  const [realPath, realDirectory] = await Promise.all([fs.realpath(path), fs.realpath(directory)]);
  const rel = relative(realDirectory, realPath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || resolve(realDirectory, rel) !== realPath) {
    throw new Error(`${name} must resolve to a file under ${realDirectory}`);
  }
  await requirePrivateRegularFile(realPath, name);
  return realPath;
}

async function requireExactFile(path, expected, name) {
  const [realPath, realExpected] = await Promise.all([fs.realpath(path), fs.realpath(expected)]);
  if (realPath !== realExpected) throw new Error(`${name} must be ${realExpected}`);
  await requirePrivateRegularFile(realPath, name);
  return realPath;
}

async function loadConfig(path, requireEnabled) {
  await requirePrivateRegularFile(path, "machine config");
  return validateMachineConfig(await readJson(path, "machine config"), { requireEnabled });
}

async function loadInboxGrant(config, grantPath) {
  const path = await requireInside(grantPath, config.inbox_dir, "grant receipt");
  const raw = await readJson(path, "grant receipt");
  return { raw, validated: validateGrantEnvelope(raw, config) };
}

async function loadActiveGrant(config, grantPath, { allowExpired = false } = {}) {
  const path = await requireExactFile(grantPath, config.active_grant_file, "active grant");
  const raw = await readJson(path, "active grant");
  return { raw, validated: validateGrantEnvelope(raw, config, { allowExpired }) };
}

export function controlReceiptPath(config, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("control grant fingerprint is invalid");
  return `${config.control_file}.${fingerprint}`;
}

function makeDelivery(config, secrets, notificationEnv) {
  return async (notice) => {
    assertNoSecret(notice, secrets);
    const args = config.notification_command.map((part) =>
      part.replaceAll("{chat_id}", config.buzz_channel).replaceAll("{thread_id}", notice.thread_id),
    );
    const result = await runProcess(args[0], args.slice(1), {
      cwd: config.repo_dir,
      env: notificationEnv,
      input: `${JSON.stringify(notice)}\n`,
      timeoutMs: 30_000,
      shouldStop: async () => null,
    });
    requireSuccess(result, args[0], args.slice(1), { definitive: true });
  };
}

export async function makeRuntime(
  config,
  validated,
  store,
  journal,
  childEnvs,
  { readFile = fs.readFile, now = () => new Date() } = {},
) {
  const secrets = secretValuesFromEnv(config.secret_env_names);
  const notices = new NoticeSink({
    validated,
    config,
    journal,
    store,
    deliver: makeDelivery(config, secrets, childEnvs.notification),
    secrets,
    log: (message) => process.stderr.write(`[hermes-factory] ${message}\n`),
  });
  let localStopReason = null;
  const requestStop = (reason) => {
    if (!localStopReason) localStopReason = String(reason).slice(0, 200);
  };
  const getStopReason = async () => {
    if (localStopReason) return localStopReason;
    // Use the same injectable clock as FactoryController so unit tests can freeze
    // time against fixture grant expires_at without depending on wall clock.
    if (now().getTime() > Date.parse(validated.grant.expires_at)) return "grant expired";
    let raw;
    try {
      raw = JSON.parse(await readFile(controlReceiptPath(config, validated.fingerprint), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      return "control receipt is unreadable or invalid";
    }
    try {
      const control = validateControlEnvelope(raw, config, validated);
      return `${control.control.kind}: ${control.control.reason}`;
    } catch {
      return "control receipt failed validation";
    }
  };
  return { secrets, notices, getStopReason, requestStop };
}

export function buildChildEnvironments(config, source = process.env) {
  const environments = {};
  for (const role of ["pipeline", "github", "git", "model_probe", "notification", "frg_runner", "install", "systemd"]) {
    environments[role] = envForRole(config, role, source);
  }
  for (const role of ["pipeline", "frg_runner", "install"]) {
    environments[role].AGENT_PIPELINE_PRODUCTION_PIN = config.production_pin_file;
    environments[role].PIPELINE_HARNESS_TELEMETRY = "on";
  }
  environments.model_probe.PIPELINE_HARNESS_TELEMETRY = "on";
  return environments;
}

export async function flushTerminalNotices(journal, notices) {
  if (!["completed", "stopped", "revoked", "rolled_back", "failed"].includes(journal.status)) return false;
  const result = await notices.flushPending();
  if (result.pending > 0) throw new Error("Buzz notices remain pending; the service must retry delivery");
  return true;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = await loadConfig(args.config, ["admit", "validate-active", "run", "control", "calibrate-notice"].includes(args.verb));
  const store = new JournalStore({ stateDir: config.state_dir });

  if (args.verb === "status") {
    const active = await store.getActive();
    process.stdout.write(`${JSON.stringify(active ? {
      schema_version: 1,
      status: active.status,
      grant_fingerprint: active.grant_fingerprint,
      current: active.current,
      completed_actions: Object.values(active.actions).filter((action) => action.state === "completed").length,
      updated_at: active.updated_at,
    } : { schema_version: 1, status: "idle" })}\n`);
    return;
  }

  if (args.verb === "validate" || args.verb === "admit") {
    const { validated } = await loadInboxGrant(config, args.grant);
    requireFullReleaseGrant(validated);
    if (args.verb === "validate") {
      process.stdout.write(`${JSON.stringify({
        schema_version: 1,
        status: "valid",
        grant_fingerprint: validated.fingerprint,
        repository: validated.grant.repository,
        base_branch: validated.grant.base_branch,
        release_version: validated.grant.release_version,
        ordered_issues: validated.grant.ordered_issues,
        actions: validated.grant.actions,
        expires_at: validated.grant.expires_at,
      })}\n`);
      return;
    }
    await store.admit(validated);
    await store.atomicWrite(config.active_grant_file, { auth: validated.auth, grant: validated.grant });
    process.stdout.write(`${JSON.stringify({ schema_version: 1, status: "admitted", grant_fingerprint: validated.fingerprint })}\n`);
    return;
  }

  if (args.verb === "validate-active") {
    const { validated } = await loadActiveGrant(config, args.grant);
    requireFullReleaseGrant(validated);
    process.stdout.write(`${JSON.stringify({
      schema_version: 1,
      status: "valid-active",
      grant_fingerprint: validated.fingerprint,
      repository: validated.grant.repository,
      release_version: validated.grant.release_version,
      expires_at: validated.grant.expires_at,
    })}\n`);
    return;
  }

  const { validated } = await loadActiveGrant(config, args.grant, {
    allowExpired: args.verb === "run" || args.verb === "validate-active",
  });
  requireFullReleaseGrant(validated);
  const journal = await store.admit(validated);

  if (args.verb === "control") {
    const eventPath = await requireInside(args.event, config.inbox_dir, "control receipt");
    const control = validateControlEnvelope(await readJson(eventPath, "control receipt"), config, validated);
    const receiptHash = createHash("sha256").update(canonicalJson(control), "utf8").digest("hex");
    const paths = journalPaths(config.state_dir, validated.fingerprint);
    await store.bind(paths.event(control.auth.message_id), {
      schema_version: 1,
      fingerprint: validated.fingerprint,
      event_id: control.auth.message_id,
      receipt_hash: receiptHash,
    }, "Buzz control event identity");
    await store.atomicWrite(controlReceiptPath(config, validated.fingerprint), control);
    process.stdout.write(`${JSON.stringify({ schema_version: 1, status: control.control.kind, grant_fingerprint: validated.fingerprint })}\n`);
    return;
  }

  const childEnvs = buildChildEnvironments(config);
  const runtime = await makeRuntime(config, validated, store, journal, childEnvs);
  if (args.verb === "calibrate-notice") {
    const name = args["canary-env"];
    if (!config.secret_env_names.includes(name)) throw new Error(`${name} is not in config.secret_env_names`);
    const canary = process.env[name];
    if (typeof canary !== "string" || canary.length < 4) throw new Error(`${name} must contain a canary of at least four characters`);
    const sent = await runtime.notices.send("calibration", { status: "redaction_test", canary });
    if (!sent.delivered) throw new Error("calibration notice delivery failed");
    assertNoSecret(sent.notice, [canary]);
    process.stdout.write(`${JSON.stringify({ schema_version: 1, status: "ok", notice: sent.notice })}\n`);
    return;
  }

  const controller = new FactoryController({
    config,
    configPath: resolve(args.config),
    validated,
    store,
    journal,
    exec: runProcess,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    mkdir: fs.mkdir,
    unlink: fs.unlink,
    getStopReason: runtime.getStopReason,
    notices: runtime.notices,
    envFor: (role) => ({ ...childEnvs[role] }),
    probeGrokModel: () =>
      probeEffectiveGrokModel(config, {
        env: childEnvs.model_probe,
      }),
    log: (message) => process.stderr.write(`[hermes-factory] ${message}\n`),
  });
  const releaseLease = await store.acquireRunLease(validated.fingerprint);
  try {
    if (["completed", "stopped", "revoked", "rolled_back", "failed"].includes(journal.status)) {
      await controller.settleTerminalDurableCleanup();
    }
    if (await flushTerminalNotices(journal, runtime.notices)) {
      process.stdout.write(`${JSON.stringify({ schema_version: 1, status: journal.status, grant_fingerprint: validated.fingerprint })}\n`);
      return;
    }
    const onTerminate = () => runtime.requestStop("service stop: SIGTERM");
    const onInterrupt = () => runtime.requestStop("service stop: SIGINT");
    process.on("SIGTERM", onTerminate);
    process.on("SIGINT", onInterrupt);
    try {
      await store.markStatus(journal, "running");
      const result = await controller.run();
      const noticeResult = await runtime.notices.flushPending();
      if (noticeResult.pending > 0) {
        throw new Error("Buzz notices remain pending; the service must retry delivery");
      }
      process.stdout.write(`${JSON.stringify({ schema_version: 1, ...result, grant_fingerprint: validated.fingerprint })}\n`);
    } finally {
      process.removeListener("SIGTERM", onTerminate);
      process.removeListener("SIGINT", onInterrupt);
    }
  } finally {
    await releaseLease();
  }
}

const isMain = import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`hermes-factory: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { main, requireInside, requireExactFile };
