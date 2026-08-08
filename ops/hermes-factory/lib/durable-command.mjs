import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,256}$/;
const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export function durableUnitName(fingerprint, kind, actionId) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || !/^[a-f0-9]{64}$/.test(actionId)) {
    throw new Error("durable unit identity is invalid");
  }
  const safeKind = String(kind).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  if (!safeKind) throw new Error("durable unit kind is invalid");
  return `hermes-factory-${fingerprint.slice(0, 10)}-${safeKind}-${actionId.slice(0, 10)}`;
}

export function durableCommandPaths(stateDir, fingerprint, actionId) {
  const root = join(stateDir, "commands", fingerprint, actionId);
  return {
    root,
    output: join(root, "output.log"),
    diagnostic: join(root, "diagnostic.log"),
    env: join(root, "child.env"),
  };
}

function quoteEnvironmentValue(value) {
  const text = String(value);
  if (text.includes("\0") || /[\r\n]/.test(text)) throw new Error("child environment values must be single-line text");
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function serializeEnvironment(env) {
  const lines = [];
  for (const name of Object.keys(env).sort()) {
    if (!SAFE_ENV_NAME.test(name)) throw new Error(`invalid child environment name ${name}`);
    if (typeof env[name] !== "string") throw new Error(`child environment ${name} must be text`);
    lines.push(`${name}=${quoteEnvironmentValue(env[name])}`);
  }
  return `${lines.join("\n")}\n`;
}

export function systemdRunArgs({
  unit,
  cwd,
  outputPath,
  diagnosticPath,
  envFile,
  cleanExecNode,
  cleanExecScript,
  command,
  args,
}) {
  if (!/^[a-z0-9][a-z0-9-]{1,100}$/.test(unit)) throw new Error("transient unit name is invalid");
  for (const [name, value] of Object.entries({ cwd, outputPath, diagnosticPath, envFile, cleanExecNode, cleanExecScript, command })) {
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  return [
    "--user",
    `--unit=${unit}`,
    "--property=Type=exec",
    "--property=RemainAfterExit=yes",
    "--property=UMask=0077",
    `--property=WorkingDirectory=${cwd}`,
    `--property=StandardOutput=append:${outputPath}`,
    `--property=StandardError=append:${diagnosticPath}`,
    "--",
    cleanExecNode,
    cleanExecScript,
    "--env-file",
    envFile,
    "--",
    command,
    ...args,
  ];
}

export function parseUnitProperties(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
  }
  if (!values.LoadState || !values.ActiveState) throw new Error("systemd unit status is incomplete");
  if (values.LoadState === "not-found") return { state: "missing", active_state: values.ActiveState };
  const status = Number.parseInt(values.ExecMainStatus ?? "", 10);
  if (
    values.ActiveState === "active" &&
    values.SubState === "exited" &&
    values.Result === "success" &&
    status === 0
  ) {
    return { state: "complete", code: 0, active_state: values.ActiveState };
  }
  if (["active", "activating", "reloading", "deactivating"].includes(values.ActiveState)) {
    return { state: "running", active_state: values.ActiveState };
  }
  if (values.ActiveState === "inactive" && values.Result === "success" && status === 0) {
    return { state: "complete", code: 0, active_state: values.ActiveState };
  }
  return {
    state: "failed",
    code: Number.isSafeInteger(status) ? status : 1,
    result: String(values.Result ?? "unknown").slice(0, 100),
    active_state: values.ActiveState,
  };
}

function confined(path, root) {
  if (!isAbsolute(path)) return false;
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

export function parsePipelineHandoff(text, loopStateDir) {
  let handoff = null;
  for (const line of String(text).split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (value?.kind === "loop_run_handoff") handoff = value;
    } catch {}
  }
  if (!handoff) return null;
  if (!SAFE_RUN_ID.test(handoff.run_id ?? "") || String(handoff.run_id).includes("..")) {
    throw new Error("Pipeline handoff has an invalid run id");
  }
  const expectedDir = join(resolve(loopStateDir), handoff.run_id);
  const expectedEvents = join(expectedDir, "events.jsonl");
  if (
    !confined(handoff.events, loopStateDir) ||
    resolve(handoff.run_dir ?? "") !== expectedDir ||
    resolve(handoff.events) !== expectedEvents
  ) {
    throw new Error("Pipeline handoff is outside the configured loop state directory");
  }
  return { pipeline_run_id: handoff.run_id, events_path: expectedEvents };
}

function boundedText(value, maximum = 200) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}

export function maxEventSequence(text) {
  let cursor = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (Number.isSafeInteger(event?.seq) && event.seq > cursor) cursor = event.seq;
    } catch {}
  }
  return cursor;
}

/**
 * Project JSONL that the installed shared material-filter selected with
 * `--jsonl`. This function does not decide materiality. It only bounds the
 * already selected lifecycle fields before they enter a notice.
 */
export function projectSharedMaterialEvents(text, afterSequence = 0) {
  const events = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(event?.seq) || event.seq <= afterSequence) continue;
    if (typeof event.kind !== "string" || !event.kind.startsWith("loop_")) continue;
    const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? event.data
      : {};
    const fields = {
      event_kind: event.kind.slice(0, 100),
      ...(boundedText(data.item_id, 100) ? { item_id: boundedText(data.item_id, 100) } : {}),
      ...(boundedText(data.stage, 100) ? { stage: boundedText(data.stage, 100) } : {}),
      ...(boundedText(data.from, 100) ? { from: boundedText(data.from, 100) } : {}),
      ...(boundedText(data.to, 100) ? { to: boundedText(data.to, 100) } : {}),
      ...(boundedText(data.domain, 100) ? { domain: boundedText(data.domain, 100) } : {}),
      ...(boundedText(data.step, 100) ? { step: boundedText(data.step, 100) } : {}),
      ...(boundedText(data.status, 100) ? { status: boundedText(data.status, 100) } : {}),
      ...(boundedText(data.outcome, 100) ? { outcome: boundedText(data.outcome, 100) } : {}),
      ...(boundedText(data.result, 100) ? { result: boundedText(data.result, 100) } : {}),
      ...(boundedText(data.reason, 200) ? { reason: boundedText(data.reason, 200) } : {}),
      ...(boundedText(data.class, 100) ? { class: boundedText(data.class, 100) } : {}),
      ...(boundedText(data.advance_run_id ?? data.pipeline_run_id, 256)
        ? { pipeline_run_id: boundedText(data.advance_run_id ?? data.pipeline_run_id, 256) }
        : {}),
      ...(Number.isSafeInteger(data.round) ? { round: data.round } : {}),
    };
    events.push({
      sequence: event.seq,
      source_id: createHash("sha256").update(`${event.seq}\0${line}`, "utf8").digest("hex"),
      occurred_at: typeof data.at === "string" ? data.at : event.time,
      kind: event.kind,
      fields,
    });
  }
  return events.sort((left, right) => left.sequence - right.sequence);
}

export function assertRecordedCommand(record, { stateDir, fingerprint, actionId, kind }) {
  const expectedUnit = durableUnitName(fingerprint, kind, actionId);
  const paths = durableCommandPaths(stateDir, fingerprint, actionId);
  const observed = record?.observed;
  if (
    observed?.service_unit !== expectedUnit ||
    observed?.output_path !== paths.output ||
    observed?.diagnostic_path !== paths.diagnostic ||
    !confined(observed.output_path, paths.root) ||
    !confined(observed.diagnostic_path, paths.root)
  ) {
    throw new Error("journaled transient unit identity is invalid");
  }
  return { unit: expectedUnit, paths };
}

export function parentDirectory(path) {
  return dirname(path);
}
