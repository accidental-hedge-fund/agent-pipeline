import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256, verifyFrgPackManifest, verifyWrapperArtifact } from "./artifact-proof.mjs";
import { canonicalJson, GRANT_ACTIONS, requireFullReleaseGrant, requireGrantAction } from "./grant.mjs";
import {
  listOpenPullRequests,
  observeIssue,
  observePullRequest,
  observePublishedRelease,
  requireGreenChecks,
  resolveLinkedPullRequest,
  resolveReleasePullRequest,
  validateReleasePullRequest,
  validateIndependentReviewProof,
} from "./github.mjs";
import { CommandError, parseLastJsonObject, requireSuccess } from "./runtime.mjs";
import { safeErrorMessage } from "./redaction.mjs";
import { parseIssueAdvanceLinkage, validateIssueAdvanceEvidence } from "./issue-run-proof.mjs";
import {
  buildNativeReleaseRequest,
  validateNativeFrgAttestationHandoff,
  validateNativeReleaseCheckpoint,
  validateNativeReleaseResult,
} from "./native-release.mjs";
import { actionId as journalActionId } from "./journal.mjs";
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
} from "./durable-command.mjs";

export class FactoryStop extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FactoryStop";
    this.code = code;
  }
}

export const HYBRID_PILOT_VERSION = "1.33.0";

function versionParts(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value ?? "");
  if (!match) throw new FactoryStop("release-version", `invalid semantic version ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function deriveStartingFrontier({ releaseVersion, config, productionPin, fetchedBaseTip }) {
  const pin = normalizedPin(productionPin, "current production pin");
  if (!validOid(fetchedBaseTip)) throw new FactoryStop("merge-frontier", "the fetched base tip is invalid");
  if (releaseVersion === HYBRID_PILOT_VERSION) {
    if (fetchedBaseTip !== config.bootstrap_base_git_sha) {
      throw new FactoryStop("merge-frontier", "the pilot base is not the exact reviewed bootstrap tip");
    }
    return {
      git_sha: fetchedBaseTip,
      candidate_version: config.candidate_version,
      production_pin: pin,
      pilot: true,
    };
  }
  if (compareVersions(releaseVersion, HYBRID_PILOT_VERSION) <= 0) {
    throw new FactoryStop("release-version", `the stable wrapper cannot use the expired hybrid for v${releaseVersion}`);
  }
  if (compareVersions(releaseVersion, pin.version) <= 0 || fetchedBaseTip !== pin.git_sha) {
    throw new FactoryStop("merge-frontier", "a later release must start from the exact current production pin and fetched base");
  }
  return {
    git_sha: pin.git_sha,
    candidate_version: pin.version,
    production_pin: pin,
    pilot: false,
  };
}

export function repositoryFromRemoteUrl(value) {
  const text = String(value ?? "").trim();
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(text);
  if (!match) throw new FactoryStop("repository-drift", "origin is not a supported GitHub repository URL");
  return match[1];
}

function parseJson(text, name) {
  try {
    return JSON.parse(String(text).trim());
  } catch {
    try {
      return parseLastJsonObject(text);
    } catch {
      throw new FactoryStop("invalid-json", `${name} did not return valid JSON`);
    }
  }
}

function validOid(value) {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
}

function normalizedPin(value, name) {
  if (
    !value ||
    typeof value !== "object" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version ?? "") ||
    value.tag !== `v${value.version}` ||
    !validOid(value.git_sha)
  ) {
    throw new FactoryStop("rollback-binding", `${name} is not an exact version, tag, and git_sha pin`);
  }
  return { version: value.version, tag: value.tag, git_sha: value.git_sha };
}

export function validateProductionPinRecord(value, resolvedGitSha) {
  if (
    !value ||
    typeof value !== "object" ||
    value.schema_version !== 1 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version ?? "") ||
    value.tag !== `v${value.version}` ||
    !/^[a-f0-9]{7,64}$/i.test(value.git_sha ?? "") ||
    !validOid(resolvedGitSha) ||
    !resolvedGitSha.toLowerCase().startsWith(value.git_sha.toLowerCase())
  ) {
    throw new FactoryStop("pin-invalid", "the current production pin is missing or invalid");
  }
  return { version: value.version, tag: value.tag, git_sha: resolvedGitSha };
}

function samePin(left, right) {
  return left.version === right.version && left.tag === right.tag && left.git_sha === right.git_sha;
}

function pipelineStage(labels) {
  const stages = labels.filter((label) => label.startsWith("pipeline:"));
  if (stages.length !== 1) {
    throw new FactoryStop("ambiguous-stage", `expected one Pipeline stage label, found ${stages.length}`);
  }
  return stages[0];
}

function loopRunIdFromOutput(text) {
  const objects = [];
  for (const line of String(text).split(/\r?\n/)) {
    const value = line.trim();
    if (!value.startsWith("{") || !value.endsWith("}")) continue;
    try {
      objects.push(JSON.parse(value));
    } catch {}
  }
  const terminal = [...objects].reverse().find((entry) => typeof entry?.run_id === "string");
  const handoff = objects.find((entry) => entry?.kind === "loop_run_handoff");
  const runId = terminal?.run_id ?? handoff?.run_id;
  if (typeof runId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(runId) || runId.includes("..")) {
    throw new FactoryStop("missing-run-id", "Pipeline loop output did not contain a safe run_id");
  }
  return runId;
}

export function validateFrgEvidence(evidence, { version, loopRunId, packRunId, frgRunId = null, manifestSha256, notBefore }) {
  if (!evidence || typeof evidence !== "object") throw new FactoryStop("frg-invalid", "FRG evidence is not an object");
  if (evidence.version !== version || evidence.pass !== true) {
    throw new FactoryStop("frg-failed", "FRG evidence does not contain a pass for the granted version");
  }
  if (evidence.loop_run_id !== loopRunId || evidence.pack_id !== "factory-gate-v1") {
    throw new FactoryStop("frg-identity", "FRG evidence does not bind the fresh fixed-pack loop");
  }
  const provenance = evidence.pack_provenance;
  if (
    provenance?.schema_version !== 1 ||
    provenance.pack_id !== "factory-gate-v1" ||
    provenance.release_version !== version ||
    provenance.loop_run_id !== loopRunId ||
    provenance.pack_run_id !== packRunId ||
    provenance.manifest_sha256 !== manifestSha256 ||
    !Array.isArray(provenance.issues) ||
    provenance.issues.length < 2
  ) {
    throw new FactoryStop("frg-provenance", "FRG evidence does not preserve the fresh manifest pack provenance");
  }
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(evidence.run_id ?? "") || String(evidence.run_id).includes("..")) {
    throw new FactoryStop("frg-identity", "FRG evidence has an invalid run_id");
  }
  if (frgRunId && evidence.run_id !== frgRunId) {
    throw new FactoryStop("frg-identity", "FRG evidence does not match the isolated scorer receipt");
  }
  if (!Array.isArray(evidence.composition?.missing) || evidence.composition.missing.length !== 0) {
    throw new FactoryStop("frg-composition", "FRG evidence is missing representative composition");
  }
  if (evidence.integrity?.producer !== "pipeline-factory-gate") {
    throw new FactoryStop("frg-attestation", "FRG evidence has an unexpected producer");
  }
  if (
    evidence.integrity?.attestation?.alg !== "hmac-sha256-v1" ||
    !/^[a-f0-9]{64}$/i.test(evidence.integrity?.attestation?.mac ?? "")
  ) {
    throw new FactoryStop("frg-attestation", "FRG evidence has no valid producer attestation shape");
  }
  const created = Date.parse(evidence.created_at ?? "");
  if (!Number.isFinite(created) || created < notBefore) {
    throw new FactoryStop("frg-stale", "FRG evidence is older than the last granted issue merge");
  }
  return {
    version,
    loop_run_id: loopRunId,
    frg_run_id: evidence.run_id,
    pack_run_id: packRunId,
    manifest_sha256: manifestSha256,
    created_at: evidence.created_at,
  };
}

function confinedArtifactPath(path, root, name) {
  if (!isAbsolute(path)) throw new FactoryStop("frg-runner-receipt", `${name} must be an absolute path`);
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new FactoryStop("frg-runner-receipt", `${name} must be inside the FRG run directory`);
  }
  return resolve(path);
}

export function validateFrgRunnerReceipt(receipt, { version, manifestSha256, candidateGitSha, runRoot, repoDir }) {
  if (
    receipt?.schema_version !== 1 ||
    receipt?.kind !== "frg_pack_run" ||
    receipt?.status !== "complete" ||
    receipt?.pack_id !== "factory-gate-v1" ||
    receipt?.version !== version ||
    receipt?.manifest_sha256 !== manifestSha256 ||
    receipt?.candidate_git_sha !== candidateGitSha ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(receipt?.pack_run_id ?? "") ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(receipt?.loop_run_id ?? "") ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(receipt?.frg_run_id ?? "") ||
    !Array.isArray(receipt?.synthetic_issues) ||
    receipt.synthetic_issues.length < 2
  ) {
    throw new FactoryStop("frg-runner-receipt", "the FRG runner did not return a complete, bound receipt");
  }
  if (
    receipt.synthetic_issues.some((issue) =>
      !Number.isSafeInteger(issue?.number) || issue.number <= 0 || issue.closed !== true ||
      !Number.isSafeInteger(issue?.pr_number) || issue.pr_number <= 0 || issue.pr_closed !== true,
    )
  ) {
    throw new FactoryStop("frg-runner-cleanup", "the FRG runner did not close every synthetic issue and pull request");
  }
  if (
    !/^[a-f0-9]{64}$/.test(receipt?.observations_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(receipt?.evidence_bundle_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(receipt?.frg_evidence_sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(receipt?.frg_latest_sha256 ?? "")
  ) {
    throw new FactoryStop("frg-runner-receipt", "the FRG runner omitted content hashes");
  }
  const expectedEvidence = join(repoDir, ".agent-pipeline", "frg", version, receipt.frg_run_id, "evidence.json");
  const expectedLatest = join(repoDir, ".agent-pipeline", "frg", version, "latest.json");
  if (resolve(receipt.frg_evidence_path ?? "") !== expectedEvidence || resolve(receipt.frg_latest_path ?? "") !== expectedLatest) {
    throw new FactoryStop("frg-runner-receipt", "the scorer evidence paths do not match the bound repository and run");
  }
  return {
    ...receipt,
    observations_path: confinedArtifactPath(receipt.observations_path, runRoot, "observations_path"),
    evidence_bundle_path: confinedArtifactPath(receipt.evidence_bundle_path, runRoot, "evidence_bundle_path"),
    frg_evidence_path: expectedEvidence,
    frg_latest_path: expectedLatest,
  };
}

export function validateDoctorEnvelope(envelope, version = null) {
  if (envelope?.schema_version !== "1" || envelope?.status !== "ok" || !Array.isArray(envelope.checks)) {
    throw new FactoryStop("doctor-failed", "Pipeline doctor did not return an ok envelope");
  }
  const failed = envelope.checks.filter((check) => check?.ok === false || check?.status === "fail");
  if (failed.length) throw new FactoryStop("doctor-failed", "Pipeline doctor reported a failed check");

  const smokeNames = envelope.checks.map((check) => String(check?.name ?? "")).filter((name) => name.startsWith("harness-smoke:"));
  const implementer = smokeNames.filter((name) => name.includes(":implementer"));
  const reviewer = smokeNames.filter((name) => name.includes(":reviewer"));
  if (
    !implementer.length ||
    implementer.some((name) => {
      const parts = name.split(":");
      return parts[1] !== "grok" || parts[2] !== "implementer" || parts[3] !== "grok-4.5";
    })
  ) {
    throw new FactoryStop("implementer-drift", "doctor did not bind every implementer treatment to grok-4.5");
  }
  if (!reviewer.length || reviewer.some((name) => !name.startsWith("harness-smoke:codex:reviewer"))) {
    throw new FactoryStop("reviewer-drift", "doctor did not prove Codex for every reviewer treatment");
  }
  if (version && envelope.version && envelope.version !== version) {
    throw new FactoryStop("install-version", "doctor version does not match the installed release");
  }
  return envelope;
}

export function validatePublication({ tagType, peeledOid, release, tag, mergeOid }) {
  if (tagType !== "tag") throw new FactoryStop("tag-type", `${tag} is not an annotated tag`);
  if (peeledOid !== mergeOid) throw new FactoryStop("tag-target", `${tag} does not peel to the release merge commit`);
  if (!release || release.tag !== tag || release.draft || release.prerelease || !release.published_at) {
    throw new FactoryStop("release-publication", "the GitHub Release is missing, draft, prerelease, or bound to another tag");
  }
  return { tag, merge_oid: mergeOid, release_url: release.url, published_at: release.published_at };
}

export class FactoryController {
  constructor({
    config,
    configPath = null,
    validated,
    store,
    journal,
    exec,
    readFile,
    writeFile,
    mkdir,
    unlink,
    now = () => new Date(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    getStopReason = async () => null,
    notices,
    probeGrokModel,
    envFor = () => ({}),
    log = () => {},
  }) {
    this.config = config;
    this.configPath = configPath;
    this.validated = validated;
    this.store = store;
    this.journal = journal;
    this.exec = exec;
    this.readFile = readFile;
    this.writeFile = writeFile;
    this.mkdir = mkdir;
    this.unlink = unlink;
    this.now = now;
    this.sleep = sleep;
    this.getStopReason = getStopReason;
    this.notices = notices;
    this.probeGrokModel = probeGrokModel;
    this.envFor = envFor;
    this.log = log;
    this.githubActor = null;
    this.frgDirtValidated = false;
    this.monitorPromises = new Map();
  }

  async ensureLiveGrant() {
    if (this.now().getTime() > Date.parse(this.validated.grant.expires_at)) {
      throw new FactoryStop("expired", "the grant expired before the next mutation");
    }
    const stop = await this.getStopReason();
    if (stop) throw new FactoryStop("stopped", stop);
  }

  async guard(action) {
    requireGrantAction(this.validated, action);
    await this.ensureLiveGrant();
  }

  async command(command, args, { action = null, input = null, timeoutSeconds = null, envRole = "pipeline", onStdoutLine = async () => {} } = {}) {
    if (action) await this.guard(action);
    return this.exec(command, args, {
      cwd: this.config.repo_dir,
      env: this.envFor(envRole),
      input,
      timeoutMs: (timeoutSeconds ?? this.config.command_timeout_seconds) * 1000,
      heartbeatMs: this.config.heartbeat_seconds * 1000,
      shouldStop: this.getStopReason,
      onHeartbeat: () => this.notices.heartbeat({ status: "command_running" }),
      onStdoutLine,
    });
  }

  async compensationProcess(previousPin, command, args, { cwd = this.config.repo_dir, envRole = "pipeline" } = {}) {
    this.requireCompensationPin(previousPin);
    return this.exec(command, args, {
      cwd,
      env: this.envFor(envRole),
      timeoutMs: this.config.command_timeout_seconds * 1000,
      heartbeatMs: this.config.heartbeat_seconds * 1000,
      shouldStop: async () => null,
      onHeartbeat: () => this.notices.heartbeat({ status: "rollback_running" }),
    });
  }

  async readOptionalText(path) {
    try {
      const body = String(await this.readFile(path));
      return body.length > 2 * 1024 * 1024 ? body.slice(-2 * 1024 * 1024) : body;
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }

  async removePrivateEnvironment(path) {
    try {
      await this.unlink(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new FactoryStop("environment-cleanup", `could not remove the private child environment at ${path}`);
    }
  }

  async monitorDurableCommand(actionId) {
    const active = this.monitorPromises.get(actionId);
    if (active) return active;
    const pending = this.monitorDurableCommandOnce(actionId).finally(() => {
      if (this.monitorPromises.get(actionId) === pending) this.monitorPromises.delete(actionId);
    });
    this.monitorPromises.set(actionId, pending);
    return pending;
  }

  async monitorDurableCommandOnce(actionId) {
    const record = this.journal.actions[actionId];
    if (!record?.observed?.output_path) return;
    try {
      const output = await this.readOptionalText(record.observed.output_path);
      let linkage = record.observed.pipeline_run_id
        ? { pipeline_run_id: record.observed.pipeline_run_id, events_path: record.observed.events_path }
        : null;
      if (!linkage) {
        linkage = parsePipelineHandoff(output, this.config.pipeline_loop_state_dir);
        if (linkage) {
          await this.store.observeAction(this.journal, actionId, {
            ...linkage,
            last_event_cursor: 0,
          });
        }
      }
      if (!linkage?.events_path) return;
      const eventBody = await this.readOptionalText(linkage.events_path);
      const currentCursor = this.journal.actions[actionId]?.observed?.last_event_cursor ?? 0;
      const materialFilter = join(dirname(this.config.pipeline_command[1]), "material-filter.mjs");
      const filtered = await this.exec(
        this.config.node_command,
        [materialFilter, "--jsonl", linkage.events_path],
        {
          cwd: this.config.repo_dir,
          env: this.envFor("systemd"),
          timeoutMs: 30_000,
          shouldStop: async () => null,
        },
      );
      if (filtered.code !== 0) throw new Error("the installed shared material filter failed");
      for (const event of projectSharedMaterialEvents(filtered.stdout, currentCursor)) {
        const item = event.fields.item_id;
        const fields = {
          ...event.fields,
          ...(item === undefined ? {} : { issue: Number.parseInt(item, 10) || item }),
          source_event_id: event.source_id,
        };
        const sent = await this.notices.send(
          event.kind === "loop_item_stage_progress" ? "stage_change" : "pipeline_event",
          fields,
          { dedupeId: event.source_id },
        );
        if (!sent.delivered && !sent.skipped) return;
        await this.store.observeAction(this.journal, actionId, { last_event_cursor: event.sequence });
      }
      const sourceCursor = maxEventSequence(eventBody);
      if (sourceCursor > (this.journal.actions[actionId]?.observed?.last_event_cursor ?? 0)) {
        await this.store.observeAction(this.journal, actionId, { last_event_cursor: sourceCursor });
      }
    } catch (error) {
      this.log(`Pipeline event monitoring skipped: ${safeErrorMessage(error)}`);
    }
  }

  async unitState(unit) {
    const result = await this.exec(
      this.config.systemctl_command,
      [
        "--user",
        "show",
        unit,
        "--property=LoadState",
        "--property=ActiveState",
        "--property=SubState",
        "--property=Result",
        "--property=ExecMainStatus",
      ],
      {
        cwd: this.config.repo_dir,
        env: this.envFor("systemd"),
        timeoutMs: 30_000,
        shouldStop: async () => null,
      },
    );
    if (result.code !== 0) {
      throw new FactoryStop("unit-observation", `could not prove transient unit state for ${unit}`);
    }
    return parseUnitProperties(result.stdout);
  }

  async stopUnit(unit) {
    const stopped = await this.exec(this.config.systemctl_command, ["--user", "stop", unit], {
      cwd: this.config.repo_dir,
      env: this.envFor("systemd"),
      timeoutMs: 30_000,
      shouldStop: async () => null,
    });
    if (stopped.code !== 0) {
      const raced = await this.unitState(unit);
      if (raced.state === "missing" || ["inactive", "failed"].includes(raced.active_state)) return;
      throw new FactoryStop("unit-stop-unproved", `systemd did not confirm stop for ${unit}`);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await this.unitState(unit);
      if (state.state === "missing" || ["inactive", "failed"].includes(state.active_state)) return;
      await this.sleep(100);
    }
    throw new FactoryStop("unit-stop-unproved", `transient unit ${unit} remained active after stop`);
  }

  async waitForDurableCommand(actionId) {
    const record = this.journal.actions[actionId];
    const compensationPin = this.compensationPinForAction(record);
    const identity = assertRecordedCommand(record, {
      stateDir: this.config.state_dir,
      fingerprint: this.validated.fingerprint,
      actionId,
      kind: record.kind,
    });
    if (["complete", "failed"].includes(record.observed?.unit_result)) {
      if (record.observed?.unit_cleanup !== true) {
        await this.stopUnit(identity.unit);
        await this.removePrivateEnvironment(identity.paths.env);
        await this.store.observeAction(this.journal, actionId, { unit_cleanup: true });
      }
      return {
        code: record.observed.unit_exit_code,
        stdout: await this.readOptionalText(identity.paths.output),
        stderr: await this.readOptionalText(identity.paths.diagnostic),
        signal: null,
        stopped: null,
      };
    }
    const attempts = Math.ceil(this.config.command_timeout_seconds / 2);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await this.monitorDurableCommand(actionId);
      const stop = compensationPin ? null : await this.getStopReason();
      if (stop) {
        await this.stopUnit(identity.unit);
        await this.removePrivateEnvironment(identity.paths.env);
        throw new CommandError(`command stopped: ${stop}`, { command: identity.unit, code: 1, stopped: stop });
      }
      const state = await this.unitState(identity.unit);
      if (state.state === "complete" || state.state === "failed") {
        await this.monitorDurableCommand(actionId);
        await this.store.observeAction(this.journal, actionId, {
          unit_result: state.state,
          unit_exit_code: state.code,
        });
        await this.stopUnit(identity.unit);
        await this.removePrivateEnvironment(identity.paths.env);
        await this.store.observeAction(this.journal, actionId, { unit_cleanup: true });
        return {
          code: state.code,
          stdout: await this.readOptionalText(identity.paths.output),
          stderr: await this.readOptionalText(identity.paths.diagnostic),
          signal: null,
          stopped: null,
        };
      }
      if (state.state === "missing") {
        return {
          code: null,
          stdout: await this.readOptionalText(identity.paths.output),
          stderr: await this.readOptionalText(identity.paths.diagnostic),
          signal: null,
          stopped: null,
          missing: true,
          launch_ack: record.observed?.launch_ack === true,
        };
      }
      await this.notices.heartbeat({ status: "command_running", service_unit: identity.unit });
      await this.sleep(2_000);
    }
    await this.stopUnit(identity.unit);
    await this.removePrivateEnvironment(identity.paths.env);
    throw new FactoryStop("command-timeout", `transient unit ${identity.unit} exceeded its time limit`);
  }

  async durableCommand(actionId, kind, command, args, { envRole = "pipeline" } = {}) {
    const commandDigest = sha256(JSON.stringify({ command, args, env_role: envRole }));
    const existingRecord = this.journal.actions[actionId];
    const existing = existingRecord?.observed?.service_unit;
    if (existing) {
      if (existingRecord.observed?.launch_digest !== commandDigest) {
        throw new FactoryStop("durable-command-drift", "the resumed transient command does not match its launch intent");
      }
      return this.waitForDurableCommand(actionId);
    }
    const recordKind = this.journal.actions[actionId]?.kind;
    if (typeof recordKind !== "string" || !recordKind) {
      throw new FactoryStop("durable-command", "the transient command has no journal action identity");
    }
    const compensationPin = this.compensationPinForAction(this.journal.actions[actionId]);
    if (compensationPin) this.requireCompensationPin(compensationPin);
    else await this.ensureLiveGrant();
    const unit = durableUnitName(this.validated.fingerprint, recordKind, actionId);
    const paths = durableCommandPaths(this.config.state_dir, this.validated.fingerprint, actionId);
    await this.mkdir(paths.root, { recursive: true, mode: 0o700 });
    await this.removePrivateEnvironment(paths.env);
    await this.writeFile(paths.env, serializeEnvironment(this.envFor(envRole)), { mode: 0o600, flag: "wx" });
    await this.store.observeAction(this.journal, actionId, {
      service_unit: unit,
      output_path: paths.output,
      diagnostic_path: paths.diagnostic,
      last_event_cursor: 0,
      launch_digest: commandDigest,
      launch_ack: false,
    });
    let launch;
    try {
      launch = await this.exec(
        this.config.systemd_run_command,
        systemdRunArgs({
          unit,
          cwd: this.config.repo_dir,
          outputPath: paths.output,
          diagnosticPath: paths.diagnostic,
          envFile: paths.env,
          cleanExecNode: this.config.node_command,
          cleanExecScript: join(this.config.wrapper_dir, "lib", "clean-exec.mjs"),
          command,
          args,
        }),
        {
          cwd: this.config.repo_dir,
          env: this.envFor("systemd"),
          timeoutMs: this.config.command_timeout_seconds * 1000,
          heartbeatMs: Math.min(this.config.heartbeat_seconds * 1000, 5_000),
          shouldStop: compensationPin ? async () => null : this.getStopReason,
          onHeartbeat: () => this.monitorDurableCommand(actionId),
        },
      );
    } catch (error) {
      launch = { code: null, stopped: null, error: safeErrorMessage(error) };
    }
    if (launch.stopped) {
      await this.stopUnit(unit);
      await this.removePrivateEnvironment(paths.env);
      throw new CommandError(`command stopped: ${launch.stopped}`, { command: unit, code: launch.code, stopped: launch.stopped });
    }
    if (launch.code !== 0) {
      const state = await this.unitState(unit);
      if (state.state === "missing") {
        return {
          code: null,
          stdout: await this.readOptionalText(paths.output),
          stderr: await this.readOptionalText(paths.diagnostic),
          signal: null,
          stopped: null,
          missing: true,
          launch_ack: false,
        };
      }
      await this.store.observeAction(this.journal, actionId, { launch_ack: true });
      return this.waitForDurableCommand(actionId);
    }
    await this.store.observeAction(this.journal, actionId, { launch_ack: true });
    return this.waitForDurableCommand(actionId);
  }

  pipelineArgs(args) {
    return [...this.config.pipeline_command.slice(1), ...args];
  }

  async pipeline(args, options = {}) {
    return this.command(this.config.pipeline_command[0], this.pipelineArgs(args), { envRole: "pipeline", ...options });
  }

  candidatePipelineArgs(args) {
    return [...this.config.candidate_pipeline_command.slice(1), ...args];
  }

  async candidatePipeline(args, options = {}) {
    return this.command(
      this.config.candidate_pipeline_command[0],
      this.candidatePipelineArgs(args),
      { envRole: "pipeline", ...options },
    );
  }

  async gh(args, options = {}) {
    return this.command(this.config.gh_command, args, { envRole: "github", ...options });
  }

  async git(args, { cwd = this.config.repo_dir, ...options } = {}) {
    if (options.action) await this.guard(options.action);
    return this.exec(this.config.git_command, args, {
      cwd,
      env: this.envFor("git"),
      timeoutMs: (options.timeoutSeconds ?? this.config.command_timeout_seconds) * 1000,
      heartbeatMs: this.config.heartbeat_seconds * 1000,
      shouldStop: this.getStopReason,
      onHeartbeat: () => this.notices.heartbeat({ status: "command_running" }),
    });
  }

  async readJson(path, name) {
    try {
      return JSON.parse(await this.readFile(path, "utf8"));
    } catch {
      throw new FactoryStop("invalid-file", `${name} is missing or invalid JSON`);
    }
  }

  async runAction(kind, target, { invoke, reconcile, safeRetry = false }) {
    const started = await this.store.beginAction(this.journal, kind, target);
    if (started.state === "completed") return started.record.result;

    if (started.state === "reconcile") {
      let durable = null;
      if (started.record.observed?.service_unit) {
        durable = await this.waitForDurableCommand(started.id);
      }
      const observed = await reconcile(started.record);
      if (observed.state === "complete") {
        if (durable?.missing) {
          const paths = durableCommandPaths(this.config.state_dir, this.validated.fingerprint, started.id);
          await this.removePrivateEnvironment(paths.env);
        }
        await this.store.completeAction(this.journal, started.id, observed.result);
        return observed.result;
      }
      if (durable && !durable.missing && durable.code !== 0) {
        await this.store.markAction(this.journal, started.id, "failed", `transient unit exited with ${durable.code}`);
        throw new CommandError(`transient unit exited with ${durable.code}`, {
          command: started.record.observed.service_unit,
          code: durable.code,
          definitive: true,
        });
      }
      const missingBeforeLaunch = !started.record.observed?.service_unit && observed.state === "not_done";
      const safeMissingRetry = durable?.missing && safeRetry && observed.state === "not_done";
      if (safeMissingRetry) {
        await this.store.observeAction(this.journal, started.id, {
          service_unit: null,
          output_path: null,
          diagnostic_path: null,
          launch_digest: null,
          launch_ack: null,
          unit_result: null,
          unit_exit_code: null,
        });
      } else if (!missingBeforeLaunch && (started.record.observed?.service_unit || observed.state !== "not_done" || !safeRetry)) {
        await this.store.markAction(this.journal, started.id, "ambiguous", observed.detail ?? "could not reconcile action");
        throw new FactoryStop("ambiguous-action", `${kind} did not have one safe restart result`);
      }
      await this.store.retryAction(this.journal, started.id);
    }

    try {
      await invoke(started.id);
      const observed = await reconcile(this.journal.actions[started.id]);
      if (observed.state !== "complete") {
        throw new FactoryStop("unverified-action", observed.detail ?? `${kind} did not produce a verified result`);
      }
      await this.store.completeAction(this.journal, started.id, observed.result);
      return observed.result;
    } catch (error) {
      let observed = null;
      try {
        observed = await reconcile(this.journal.actions[started.id]);
      } catch {}
      if (observed?.state === "complete") {
        await this.store.completeAction(this.journal, started.id, observed.result);
        return observed.result;
      }
      const definitive = error instanceof CommandError && error.definitive;
      const state = definitive || (observed?.state === "not_done" && safeRetry) ? "failed" : "ambiguous";
      await this.store.markAction(
        this.journal,
        started.id,
        state,
        safeErrorMessage(error),
      );
      throw error;
    }
  }

  async pipelineProof(kind, target, args, validate, { compensationPin = null } = {}) {
    if (compensationPin) {
      const bound = this.requireCompensationPin(compensationPin);
      if (kind !== "installed_doctor" || target.version !== bound.version) {
        throw new FactoryStop("rollback-binding", "the compensation doctor target does not match the journaled previous_pin");
      }
    }
    const command = compensationPin ? this.config.node_command : this.config.pipeline_command[0];
    const commandArgs = compensationPin
      ? [this.compensationPipelineEntrypoint(compensationPin), ...args]
      : this.pipelineArgs(args);
    return this.runAction(kind, target, {
      safeRetry: false,
      invoke: async (actionId) => {
        const result = await this.durableCommand(
          actionId,
          kind,
          command,
          commandArgs,
        );
        requireSuccess(result, `pipeline ${kind}`, [], { definitive: true });
        const proof = validate(result.stdout);
        await this.store.observeAction(this.journal, actionId, { proof });
      },
      reconcile: async (record) => {
        let proof = record.observed?.proof;
        if (!proof && record.observed?.unit_result === "complete") {
          const body = await this.readOptionalText(record.observed.output_path);
          proof = validate(body);
          await this.store.observeAction(this.journal, record.action_id, { proof });
        }
        return proof ? { state: "complete", result: proof } : { state: "not_done" };
      },
    });
  }

  frgEvidenceMayExist() {
    return this.frgDirtValidated;
  }

  frgAction() {
    return Object.values(this.journal.actions).find(
      (action) => action.kind === "frg" && action.state !== "failed",
    ) ?? null;
  }

  hasPromotionStarted() {
    return Object.values(this.journal.actions).some(
      (action) =>
        ["pin_promote", "install", "install_host", "rollback_pin", "rollback"].includes(action.kind) &&
        (action.state !== "failed" || (action.kind === "pin_promote" && action.observed?.previous_pin)),
    );
  }

  startingFrontierAction() {
    return Object.values(this.journal.actions).find(
      (action) => action.kind === "starting_frontier" && action.state === "completed",
    ) ?? null;
  }

  async bindStartingFrontier(fetchedBaseTip, { skipPinCheck = false } = {}) {
    const existing = this.startingFrontierAction();
    if (existing) {
      const result = existing.result;
      if (
        result?.release_version !== this.validated.grant.release_version ||
        !validOid(result?.git_sha) ||
        typeof result?.candidate_version !== "string" ||
        typeof result?.pilot !== "boolean"
      ) {
        throw new FactoryStop("merge-frontier", "the stored starting frontier is incomplete or belongs to another release");
      }
      if (!skipPinCheck) {
        const livePin = await this.readProductionPin();
        if (!samePin(normalizedPin(result.production_pin, "stored production pin"), livePin)) {
          throw new FactoryStop("production-pin-drift", "the production pin changed after the starting frontier was bound");
        }
      }
      this.startingFrontier = result;
      return result;
    }
    const hasIssueMutation = Object.values(this.journal.actions).some(
      (action) => action.kind === "issue_advance" || action.kind === "issue_pr_merge",
    );
    if (hasIssueMutation) {
      throw new FactoryStop("merge-frontier", "issue work exists without a bound starting frontier");
    }
    const productionPin = await this.readProductionPin();
    const frontier = deriveStartingFrontier({
      releaseVersion: this.validated.grant.release_version,
      config: this.config,
      productionPin,
      fetchedBaseTip,
    });
    const target = { release_version: this.validated.grant.release_version };
    const started = await this.store.beginAction(this.journal, "starting_frontier", target);
    if (started.state !== "started") {
      throw new FactoryStop("merge-frontier", "the starting frontier could not be bound once");
    }
    const result = { ...frontier, release_version: this.validated.grant.release_version };
    await this.store.completeAction(this.journal, started.id, result);
    this.startingFrontier = result;
    return result;
  }

  journalCompensationPin({ required = false } = {}) {
    const promotions = Object.values(this.journal.actions).filter(
      (action) =>
        action.kind === "pin_promote" &&
        action.target?.version === this.validated.grant.release_version &&
        ["running", "ambiguous", "completed", "failed"].includes(action.state) &&
        action.observed?.previous_pin,
    );
    if (promotions.length === 0) {
      if (required) throw new FactoryStop("rollback-binding", "the journal has no authorized promotion rollback pin");
      return null;
    }
    if (promotions.length !== 1 || !validOid(promotions[0].target?.merge_oid)) {
      throw new FactoryStop("rollback-binding", "the journal does not bind one exact authorized promotion");
    }
    requireGrantAction(this.validated, "rollback");
    return normalizedPin(promotions[0].observed.previous_pin, "the journaled previous_pin");
  }

  requireCompensationPin(value) {
    const requested = normalizedPin(value, "the requested compensation pin");
    const journaled = this.journalCompensationPin({ required: true });
    if (!samePin(requested, journaled)) {
      throw new FactoryStop("rollback-binding", "the requested compensation pin does not match the journaled previous_pin");
    }
    return journaled;
  }

  compensationPipelineEntrypoint(previousPin) {
    this.requireCompensationPin(previousPin);
    return join(
      this.config.artifact_checkout,
      "plugin",
      "pipeline",
      "skills",
      "pipeline",
      "scripts",
      "pipeline.mjs",
    );
  }

  async compensationPipeline(previousPin, args) {
    return this.compensationProcess(
      previousPin,
      this.config.node_command,
      [this.compensationPipelineEntrypoint(previousPin), ...args],
    );
  }

  compensationPinForAction(record) {
    const pin = this.journalCompensationPin();
    if (!pin || !record?.target) return null;
    if (record.kind === "rollback_pin") {
      try {
        return samePin(normalizedPin(record.target, "rollback_pin target"), pin) ? pin : null;
      } catch {
        return null;
      }
    }
    if (
      record.kind === "install_host" &&
      record.target.action === "rollback" &&
      record.target.tag === pin.tag &&
      record.target.expected_oid === pin.git_sha
    ) {
      return pin;
    }
    if (record.kind === "installed_doctor" && record.target.version === pin.version) return pin;
    return null;
  }

  rollbackEvidence() {
    return Object.values(this.journal.actions).filter(
      (action) =>
        action.kind === "rollback" ||
        action.kind === "rollback_pin" ||
        (action.kind === "install_host" && action.target?.action === "rollback"),
    );
  }

  rollbackRecoveryPin() {
    const evidence = this.rollbackEvidence();
    if (evidence.length === 0) return null;
    const pin = this.journalCompensationPin({ required: true });
    for (const action of evidence) {
      if (action.kind === "rollback" || action.kind === "rollback_pin") {
        let target;
        try {
          target = normalizedPin(action.target, `${action.kind} target`);
        } catch {
          throw new FactoryStop("rollback-binding", `${action.kind} evidence is not bound to the journaled previous_pin`);
        }
        if (!samePin(target, pin)) {
          throw new FactoryStop("rollback-binding", `${action.kind} evidence does not match the journaled previous_pin`);
        }
        continue;
      }
      if (
        action.target?.tag !== pin.tag ||
        action.target?.expected_oid !== pin.git_sha ||
        !this.config.install_hosts.includes(action.target?.host)
      ) {
        throw new FactoryStop("rollback-binding", "rollback install evidence does not match the journaled previous_pin");
      }
    }
    return pin;
  }

  async settleActiveDurableUnit() {
    const active = Object.values(this.journal.actions).filter(
      (action) =>
        ["running", "ambiguous"].includes(action.state) &&
        action.observed?.service_unit &&
        !action.observed?.unit_result,
    );
    if (active.length > 1) throw new FactoryStop("durable-unit-conflict", "the journal contains more than one active transient unit");
    if (active.length === 1) await this.waitForDurableCommand(active[0].action_id);
  }

  async settleTerminalDurableCleanup() {
    const pending = Object.values(this.journal.actions).filter(
      (action) => action.observed?.service_unit && action.observed?.unit_cleanup !== true,
    );
    for (const action of pending) {
      const identity = assertRecordedCommand(action, {
        stateDir: this.config.state_dir,
        fingerprint: this.validated.fingerprint,
        actionId: action.action_id,
        kind: action.kind,
      });
      await this.stopUnit(identity.unit);
      await this.removePrivateEnvironment(identity.paths.env);
      await this.store.observeAction(this.journal, action.action_id, { unit_cleanup: true });
    }
  }

  async preflight({ skipProductionRuntime = false } = {}) {
    requireFullReleaseGrant(this.validated);
    if (this.validated.grant.model !== "grok-4.5") throw new FactoryStop("model-drift", "the grant model is not grok-4.5");
    const repo = parseJson(
      requireSuccess(
        await this.gh(["repo", "view", "--json", "nameWithOwner"]),
        this.config.gh_command,
        [],
      ).stdout,
      "gh repo view",
    );
    if (String(repo.nameWithOwner).toLowerCase() !== this.config.repository.toLowerCase()) {
      throw new FactoryStop("repository-drift", "repo_dir resolves to another GitHub repository");
    }
    const actor = requireSuccess(
      await this.gh(["api", "user", "--jq", ".login"]),
      "gh authenticated actor",
      [],
      { definitive: true },
    ).stdout.trim();
    if (!/^[A-Za-z0-9-]+$/.test(actor)) throw new FactoryStop("github-actor", "GitHub did not report one authenticated actor");
    this.githubActor = actor;
    const origin = requireSuccess(
      await this.git(["remote", "get-url", "origin"]),
      "git remote get-url origin",
      [],
      { definitive: true },
    ).stdout.trim();
    if (repositoryFromRemoteUrl(origin).toLowerCase() !== this.config.repository.toLowerCase()) {
      throw new FactoryStop("repository-drift", "repo_dir origin does not match config.repository");
    }

    await verifyWrapperArtifact(this.config, this.readFile);
    await verifyFrgPackManifest(this.config, this.readFile);
    if (this.frgAction()) await this.validateBoundFrgArtifacts();
    await this.refreshBase({ requireClean: true, allowFrgEvidence: this.frgEvidenceMayExist() });

    const candidateHead = requireSuccess(
      await this.git(["rev-parse", "HEAD"]),
      "git candidate head",
      [],
      { definitive: true },
    ).stdout.trim();
    const hasIssueMutation = Object.values(this.journal.actions).some((action) =>
      action.kind === "issue_advance" || action.kind === "issue_pr_merge",
    );
    const frontier = await this.bindStartingFrontier(candidateHead, { skipPinCheck: skipProductionRuntime });
    if (!hasIssueMutation && candidateHead !== frontier.git_sha) {
      throw new FactoryStop("candidate-drift", "the control checkout HEAD does not match the bound starting frontier");
    }
    if (!skipProductionRuntime) await this.validateProductionRuntime();
  }

  async validateProductionRuntime(scope = "preflight") {
    const productionPin = await this.readProductionPin();
    const productionVersion = requireSuccess(
      await this.pipeline(["--version"]),
      "installed pipeline --version",
      [],
      { definitive: true },
    ).stdout.trim();
    if (productionVersion !== productionPin.version) {
      throw new FactoryStop("production-pin-drift", "the installed Pipeline launcher does not match the external production pin");
    }

    const configResult = await this.pipeline([
      "config",
      "validate",
      "--json",
      "--repo-path",
      this.config.repo_dir,
      "--profile",
      this.config.profile,
    ]);
    const configEnvelope = parseJson(requireSuccess(configResult, "pipeline", [], { definitive: true }).stdout, "pipeline config validate");
    if (configEnvelope.valid !== true) throw new FactoryStop("pipeline-config", "Pipeline config validation failed");

    await this.pipelineProof(
      "doctor_proof",
      { scope, version: productionVersion, base: this.config.base_branch },
      [
        "doctor",
        "--json",
        "--harness-smoke",
        "--engine-track",
        "pinned",
        "--repo-path",
        this.config.repo_dir,
        "--base",
        this.config.base_branch,
        "--profile",
        this.config.profile,
      ],
      (stdout) => {
        validateDoctorEnvelope(parseJson(stdout, "pipeline doctor"), productionVersion);
        return { status: "ok", version: productionVersion, implementer_model: "grok-4.5", reviewer: "codex" };
      },
    );
    const modelProof = await this.probeGrokModel();
    if (modelProof?.effective_model !== "grok-4.5") {
      throw new FactoryStop("model-drift", "Grok did not report effective model grok-4.5");
    }
    return { version: productionVersion, effective_model: modelProof.effective_model };
  }

  async refreshBase({ requireClean = true, allowFrgEvidence = false } = {}) {
    const branch = requireSuccess(await this.git(["branch", "--show-current"]), "git", [], { definitive: true }).stdout.trim();
    if (branch !== this.config.base_branch) {
      requireSuccess(
        await this.git(["checkout", this.config.base_branch]),
        "git checkout base",
        [],
        { definitive: true },
      );
    }
    if (requireClean) {
      const status = requireSuccess(
        await this.git(["status", "--porcelain", "--untracked-files=all"]),
        "git status",
        [],
        { definitive: true },
      );
      const dirty = status.stdout.split(/\r?\n/).filter(Boolean);
      const allowedPrefix = `.agent-pipeline/frg/${this.validated.grant.release_version}/`;
      const expectedOnly = allowFrgEvidence && dirty.every((line) => {
        const path = line.slice(3);
        return path.startsWith(allowedPrefix) || path === ".agent-pipeline/frg/trend-ledger.jsonl";
      });
      if (dirty.length && !expectedOnly) throw new FactoryStop("dirty-checkout", "the factory control checkout is not clean");
    }
    requireSuccess(
      await this.git([
        "fetch",
        "origin",
        `refs/heads/${this.config.base_branch}:refs/remotes/origin/${this.config.base_branch}`,
      ]),
      "git fetch base",
      [],
    );
    requireSuccess(
      await this.git(["merge", "--ff-only", `refs/remotes/origin/${this.config.base_branch}`]),
      "git fast-forward base",
      [],
    );
    const [localHead, remoteHead] = await Promise.all([
      this.git(["rev-parse", "HEAD"]),
      this.git(["rev-parse", `refs/remotes/origin/${this.config.base_branch}`]),
    ]);
    const localOid = requireSuccess(localHead, "git local base identity", [], { definitive: true }).stdout.trim();
    const remoteOid = requireSuccess(remoteHead, "git remote base identity", [], { definitive: true }).stdout.trim();
    if (!validOid(localOid) || localOid !== remoteOid) {
      throw new FactoryStop("base-identity", "the local base is not exactly the freshly fetched origin base");
    }
  }

  async containsInBase(oid) {
    if (!validOid(oid)) return false;
    requireSuccess(
      await this.git([
        "fetch",
        "origin",
        `refs/heads/${this.config.base_branch}:refs/remotes/origin/${this.config.base_branch}`,
      ]),
      "git fetch base",
      [],
    );
    const result = await this.git([
      "merge-base",
      "--is-ancestor",
      oid,
      `refs/remotes/origin/${this.config.base_branch}`,
    ]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new FactoryStop("containment-check", "git could not check base containment");
  }

  async fetchedBaseTip() {
    requireSuccess(
      await this.git([
        "fetch",
        "origin",
        `refs/heads/${this.config.base_branch}:refs/remotes/origin/${this.config.base_branch}`,
      ]),
      "git fetch base",
      [],
    );
    const tip = requireSuccess(
      await this.git(["rev-parse", `refs/remotes/origin/${this.config.base_branch}`]),
      "git fetched base tip",
      [],
      { definitive: true },
    ).stdout.trim();
    if (!validOid(tip)) throw new FactoryStop("base-identity", "the fetched base tip is not a valid commit identity");
    return tip;
  }

  async proveIssueRun(issue, headOid, record = null) {
    const advanceRecord = record ?? Object.values(this.journal.actions).find(
      (action) => action.kind === "issue_advance" && action.target?.issue === issue,
    );
    if (!advanceRecord?.observed?.events_path) {
      throw new FactoryStop("issue-run-proof", `issue #${issue} has no durable Pipeline loop event linkage`);
    }
    const outer = await this.readOptionalText(advanceRecord.observed.events_path);
    const linkage = parseIssueAdvanceLinkage(outer, {
      repoDir: this.config.repo_dir,
      expectedIssue: issue,
    });
    const advance = await this.readOptionalText(linkage.events_path);
    const proof = validateIssueAdvanceEvidence(advance, {
      expectedIssue: issue,
      expectedRunId: linkage.pipeline_run_id,
      expectedPrHead: headOid,
    });
    return {
      ...proof,
      outer_events_sha256: sha256(outer),
      advance_events_sha256: sha256(advance),
    };
  }

  async observeReadyIssue(issue, advanceRecord = null) {
    const observed = await observeIssue(
      (command, args) => this.command(command, args, { envRole: "github" }),
      this.config.gh_command,
      this.config.repository,
      issue,
    );
    const stage = pipelineStage(observed.labels);
    if (observed.state !== "OPEN") {
      return { state: "unsafe", detail: `issue #${issue} is not open` };
    }
    if (observed.milestone !== this.validated.grant.milestone) {
      return { state: "unsafe", detail: `issue #${issue} is not in granted milestone ${this.validated.grant.milestone}` };
    }
    if (stage === "pipeline:needs-human") {
      return { state: "unsafe", detail: `issue #${issue} needs human action` };
    }
    if (stage !== "pipeline:ready-to-deploy") return { state: "not_done", stage };
    const prs = await listOpenPullRequests(
      (command, args) => this.command(command, args, { envRole: "github" }),
      this.config.gh_command,
      this.config.repository,
    );
    const pr = resolveLinkedPullRequest(prs, issue, this.config.repository, this.config.base_branch);
    if (pr.is_draft) return { state: "unsafe", detail: `issue #${issue} is linked to a draft pull request` };
    if (!this.githubActor) return { state: "unsafe", detail: "the authenticated GitHub actor is not bound" };
    try {
      validateIndependentReviewProof(observed.comments, { actor: this.githubActor, headOid: pr.head_oid });
    } catch (error) {
      return { state: "unsafe", detail: safeErrorMessage(error) };
    }
    let runtimeProof;
    try {
      runtimeProof = await this.proveIssueRun(issue, pr.head_oid, advanceRecord);
    } catch (error) {
      return { state: "unsafe", detail: safeErrorMessage(error) };
    }
    return {
      state: "complete",
      result: { issue, pr: pr.number, head_oid: pr.head_oid, head_ref: pr.head_ref, runtime_proof: runtimeProof },
    };
  }

  async driveIssue(issue) {
    await this.guard("issue_advance");
    const scopedIssue = await observeIssue(
      (command, args) => this.command(command, args, { envRole: "github" }),
      this.config.gh_command,
      this.config.repository,
      issue,
    );
    if (scopedIssue.state !== "OPEN" || scopedIssue.milestone !== this.validated.grant.milestone) {
      throw new FactoryStop("issue-scope", `issue #${issue} is not open in granted milestone ${this.validated.grant.milestone}`);
    }
    return this.runAction(
      "issue_advance",
      { issue, base: this.config.base_branch },
      {
        safeRetry: true,
        invoke: async (actionId) => {
          await this.notices.send("issue_start", { issue, status: "advancing" });
          const result = await this.durableCommand(
            actionId,
            "issue-advance",
            this.config.pipeline_command[0],
            this.pipelineArgs([
              "single",
              String(issue),
              "--repo-path",
              this.config.repo_dir,
              "--base",
              this.config.base_branch,
              "--profile",
              this.config.profile,
              "--engine-track",
              "pinned",
            ]),
          );
          requireSuccess(result, "pipeline single", [], { definitive: true });
        },
        reconcile: (record) => this.observeReadyIssue(issue, record),
      },
    );
  }

  async reconcileIssueMerge(target) {
    const pr = await observePullRequest(
      (command, args) => this.command(command, args, { envRole: "github" }),
      this.config.gh_command,
      this.config.repository,
      target.pr,
    );
    if (pr.head_oid !== target.head_oid) {
      return { state: "unsafe", detail: "the issue PR head changed after inspection" };
    }
    if (pr.state === "OPEN") return { state: "not_done" };
    if (pr.state !== "MERGED" || !validOid(pr.merge_oid)) {
      return { state: "unsafe", detail: "the issue PR has an unexpected terminal state" };
    }
    const tip = await this.fetchedBaseTip();
    if (tip !== pr.merge_oid) {
      return { state: "unsafe", detail: "the freshly fetched base tip is not exactly the granted issue merge result" };
    }
    const parent = requireSuccess(
      await this.git(["rev-parse", `${pr.merge_oid}^`]),
      "git issue merge parent",
      [],
      { definitive: true },
    ).stdout.trim();
    if (parent !== target.base_oid) {
      return { state: "unsafe", detail: "the issue merge was not based on the exact frozen granted frontier" };
    }
    return {
      state: "complete",
      result: {
        issue: target.issue,
        pr: target.pr,
        head_oid: target.head_oid,
        merge_oid: pr.merge_oid,
        base_oid: target.base_oid,
        base: this.config.base_branch,
      },
    };
  }

  async mergeIssue(candidate) {
    await this.guard("issue_pr_merge");
    const target = {
      issue: candidate.issue,
      pr: candidate.pr,
      head_oid: candidate.head_oid,
      base_oid: candidate.base_oid,
      pipeline_run_id: candidate.runtime_proof?.run_id,
      advance_events_sha256: candidate.runtime_proof?.advance_events_sha256,
      reviewed_head: candidate.runtime_proof?.reviewed_head,
      base: this.config.base_branch,
    };
    if (
      !validOid(target.base_oid) ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(target.pipeline_run_id ?? "") ||
      !/^[a-f0-9]{64}$/.test(target.advance_events_sha256 ?? "") ||
      target.reviewed_head !== target.head_oid
    ) {
      throw new FactoryStop("issue-run-proof", "the issue candidate has no exact runtime and base proof");
    }
    return this.runAction("issue_pr_merge", target, {
      safeRetry: true,
      invoke: async (actionId) => {
        const fresh = await this.observeReadyIssue(candidate.issue);
        if (
          fresh.state !== "complete" ||
          fresh.result.pr !== candidate.pr ||
          fresh.result.head_oid !== candidate.head_oid ||
          fresh.result.runtime_proof?.run_id !== target.pipeline_run_id ||
          fresh.result.runtime_proof?.advance_events_sha256 !== target.advance_events_sha256 ||
          fresh.result.runtime_proof?.reviewed_head !== target.reviewed_head
        ) {
          throw new FactoryStop("head-drift", "the linked issue PR changed before merge");
        }
        const freshBase = await this.fetchedBaseTip();
        if (freshBase !== target.base_oid) {
          throw new FactoryStop("merge-frontier", "the base changed after issue work and before the granted merge");
        }
        const result = await this.durableCommand(
          actionId,
          "issue-merge",
          this.config.pipeline_command[0],
          this.pipelineArgs([
            "merge",
            String(candidate.pr),
            "--repo-path",
            this.config.repo_dir,
            "--base",
            this.config.base_branch,
            "--profile",
            this.config.profile,
          ]),
        );
        requireSuccess(result, "pipeline merge", [], { definitive: true });
      },
      reconcile: () => this.reconcileIssueMerge(target),
    });
  }

  async verifyPriorIssueMerges(index, { requireExactTip = true } = {}) {
    let expectedTip = this.startingFrontierAction()?.result?.git_sha ?? this.config.bootstrap_base_git_sha;
    for (const issue of this.validated.grant.ordered_issues.slice(0, index)) {
      const record = Object.values(this.journal.actions).find(
        (action) => action.kind === "issue_pr_merge" && action.target?.issue === issue && action.state === "completed",
      );
      if (!record?.result?.merge_oid || !(await this.containsInBase(record.result.merge_oid))) {
        throw new FactoryStop("merge-frontier", `prior issue #${issue} is not proved in the current base`);
      }
      expectedTip = record.result.merge_oid;
    }
    const actualTip = await this.fetchedBaseTip();
    if (requireExactTip && actualTip !== expectedTip) {
      throw new FactoryStop(
        "merge-frontier",
        `base changed outside the granted merge train before issue #${this.validated.grant.ordered_issues[index] ?? "release"}`,
      );
    }
    return expectedTip;
  }

  async driveIssues() {
    const issues = this.validated.grant.ordered_issues;
    const completed = issues.map((issue) => Object.values(this.journal.actions).some(
      (action) => action.kind === "issue_pr_merge" && action.target?.issue === issue && action.state === "completed",
    ));
    const firstIncomplete = completed.indexOf(false);
    const startIndex = firstIncomplete < 0 ? issues.length : firstIncomplete;
    if (completed.slice(startIndex).some(Boolean)) {
      throw new FactoryStop("merge-frontier", "the journal contains a non-contiguous granted merge train");
    }
    if (startIndex === issues.length) {
      await this.refreshBase({ requireClean: true, allowFrgEvidence: this.frgEvidenceMayExist() });
      await this.verifyPriorIssueMerges(startIndex);
      return;
    }
    for (let index = startIndex; index < issues.length; index += 1) {
      await this.refreshBase({ requireClean: true, allowFrgEvidence: this.frgEvidenceMayExist() });
      const activeMerge = Object.values(this.journal.actions).find(
        (action) =>
          action.kind === "issue_pr_merge" &&
          action.target?.issue === issues[index] &&
          ["running", "ambiguous"].includes(action.state) &&
          action.observed?.service_unit,
      );
      const baseOid = await this.verifyPriorIssueMerges(index, { requireExactTip: !activeMerge });
      await this.validateProductionRuntime(`issue-${issues[index]}-frontier-${index}`);
      const candidate = { ...(await this.driveIssue(issues[index])), base_oid: baseOid };
      await this.notices.send("pr_ready", { issue: candidate.issue, pr: candidate.pr, head_oid: candidate.head_oid });
      const merged = await this.mergeIssue(candidate);
      await this.notices.send("merge_result", merged);
      await this.refreshBase({ requireClean: true, allowFrgEvidence: this.frgEvidenceMayExist() });
    }
  }

  async bindIntegratedCandidate() {
    await this.refreshBase({ requireClean: true, allowFrgEvidence: this.frgEvidenceMayExist() });
    const head = requireSuccess(await this.git(["rev-parse", "HEAD"]), "git integrated base", [], { definitive: true }).stdout.trim();
    const remote = requireSuccess(
      await this.git(["rev-parse", `refs/remotes/origin/${this.config.base_branch}`]),
      "git fetched base",
      [],
      { definitive: true },
    ).stdout.trim();
    const lastIssue = this.validated.grant.ordered_issues.at(-1);
    const lastMerge = Object.values(this.journal.actions).find(
      (action) => action.kind === "issue_pr_merge" && action.target?.issue === lastIssue && action.state === "completed",
    );
    if (
      !validOid(head) ||
      head !== remote ||
      !lastMerge?.result?.merge_oid ||
      head !== lastMerge.result.merge_oid
    ) {
      throw new FactoryStop("candidate-drift", "the final integrated base is not exactly the last granted merge result");
    }
    const sourceVersion = this.startingFrontierAction()?.result?.candidate_version ?? this.config.candidate_version;
    const target = {
      base: this.config.base_branch,
      ordered_issues: this.validated.grant.ordered_issues,
      starting_git_sha: this.startingFrontierAction()?.result?.git_sha ?? this.config.bootstrap_base_git_sha,
      source_version: sourceVersion,
    };
    const started = await this.store.beginAction(this.journal, "integrated_candidate", target);
    if (started.state === "completed") {
      if (started.record.result?.git_sha !== head) {
        throw new FactoryStop("candidate-drift", "the fetched base changed after the integrated candidate was bound");
      }
    } else if (started.state === "reconcile") {
      if (started.record.observed?.git_sha !== head) {
        await this.store.markAction(this.journal, started.id, "ambiguous", "integrated base identity changed");
        throw new FactoryStop("candidate-drift", "the integrated candidate cannot be reconciled to one base commit");
      }
      await this.store.completeAction(this.journal, started.id, { git_sha: head, version: sourceVersion });
    } else {
      await this.store.observeAction(this.journal, started.id, { git_sha: head });
      await this.store.completeAction(this.journal, started.id, { git_sha: head, version: sourceVersion });
    }
    requireSuccess(await this.git(["checkout", "--detach", head]), "git detach integrated candidate", [], { definitive: true });
    const status = requireSuccess(
      await this.git(["status", "--porcelain", "--untracked-files=all"]),
      "git candidate status",
      [],
      { definitive: true },
    );
    const dirty = status.stdout.split(/\r?\n/).filter(Boolean);
    const allowedPrefix = `.agent-pipeline/frg/${this.validated.grant.release_version}/`;
    const expectedFrgOnly = this.frgEvidenceMayExist() && dirty.every((line) => {
      const path = line.slice(3);
      return path.startsWith(allowedPrefix) || path === ".agent-pipeline/frg/trend-ledger.jsonl";
    });
    if (dirty.length && !expectedFrgOnly) {
      throw new FactoryStop("candidate-dirty", "the integrated candidate checkout has changes outside verified FRG evidence paths");
    }
    const detached = requireSuccess(await this.git(["rev-parse", "HEAD"]), "git detached candidate", [], { definitive: true }).stdout.trim();
    if (detached !== head) throw new FactoryStop("candidate-drift", "the detached candidate does not match the integrated base");
    const candidateVersion = requireSuccess(
      await this.candidatePipeline(["--version"]),
      "candidate pipeline --version",
      [],
      { definitive: true },
    ).stdout.trim();
    if (candidateVersion !== sourceVersion) {
      throw new FactoryStop("candidate-drift", "the integrated candidate version does not match machine config");
    }
    return { git_sha: head, version: candidateVersion };
  }

  lastIssueMergeTime() {
    const times = Object.values(this.journal.actions)
      .filter((action) => action.kind === "issue_pr_merge" && action.state === "completed")
      .map((action) => Date.parse(action.completed_at ?? ""))
      .filter(Number.isFinite);
    if (!times.length) throw new FactoryStop("missing-merge-evidence", "the journal has no completed issue merge evidence");
    return Math.max(...times);
  }

  async existingFrgResult(version, expected = null) {
    const evidencePath = join(this.config.repo_dir, ".agent-pipeline", "frg", version, "latest.json");
    try {
      const evidence = await this.readJson(evidencePath, "FRG latest evidence");
      const loopRunId = expected?.loop_run_id ?? evidence.loop_run_id;
      const packRunId = expected?.pack_run_id ?? evidence.pack_provenance?.pack_run_id;
      return {
        state: "complete",
        result: validateFrgEvidence(evidence, {
          version,
          loopRunId,
          packRunId,
          manifestSha256: this.config.frg_pack_manifest_sha256,
          notBefore: this.lastIssueMergeTime(),
          frgRunId: expected?.frg_run_id ?? null,
        }),
      };
    } catch (error) {
      if (expected) return { state: "unsafe", detail: safeErrorMessage(error) };
      return { state: "not_done" };
    }
  }

  async validateBoundFrgArtifacts({ requireExactDirtySet = false } = {}) {
    const record = this.frgAction();
    if (!record) {
      this.frgDirtValidated = false;
      return null;
    }
    const version = record.target?.version;
    const candidateGitSha = record.target?.candidate_git_sha;
    if (version !== this.validated.grant.release_version || !validOid(candidateGitSha)) {
      throw new FactoryStop("frg-identity", "the journaled FRG action has invalid release or candidate identity");
    }
    if (!record.observed?.frg_run_id && record.observed?.unit_result === "complete") {
      const runRoot = join(this.config.state_dir, "frg", this.validated.fingerprint, version);
      await this.consumeFrgRunnerReceipt(record.action_id, { git_sha: candidateGitSha }, runRoot, version);
    }
    const observed = this.journal.actions[record.action_id]?.observed ?? record.observed;
    if (
      !/^[A-Za-z0-9._:-]{1,256}$/.test(observed?.loop_run_id ?? "") ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(observed?.pack_run_id ?? "") ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(observed?.frg_run_id ?? "") ||
      !/^[a-f0-9]{64}$/.test(observed?.frg_evidence_sha256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(observed?.frg_latest_sha256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(observed?.trend_ledger_sha256 ?? "")
    ) {
      throw new FactoryStop("frg-unverified", "the FRG action has no complete receipt-bound artifact hashes");
    }
    const evidenceRelative = `.agent-pipeline/frg/${version}/${observed.frg_run_id}/evidence.json`;
    const latestRelative = `.agent-pipeline/frg/${version}/latest.json`;
    const trendRelative = ".agent-pipeline/frg/trend-ledger.jsonl";
    const [evidenceBody, latestBody, trendBody] = await Promise.all([
      this.readFile(join(this.config.repo_dir, evidenceRelative)),
      this.readFile(join(this.config.repo_dir, latestRelative)),
      this.readFile(join(this.config.repo_dir, trendRelative)),
    ]);
    if (
      sha256(evidenceBody) !== observed.frg_evidence_sha256 ||
      sha256(latestBody) !== observed.frg_latest_sha256 ||
      sha256(trendBody) !== observed.trend_ledger_sha256
    ) {
      throw new FactoryStop("frg-artifact-drift", "FRG evidence changed after the isolated scorer receipt was bound");
    }
    const expected = {
      loop_run_id: observed.loop_run_id,
      pack_run_id: observed.pack_run_id,
      frg_run_id: observed.frg_run_id,
    };
    for (const [name, body] of [["immutable", evidenceBody], ["latest", latestBody]]) {
      validateFrgEvidence(parseJson(body, `FRG ${name} evidence`), {
        version,
        loopRunId: expected.loop_run_id,
        packRunId: expected.pack_run_id,
        manifestSha256: this.config.frg_pack_manifest_sha256,
        notBefore: this.lastIssueMergeTime(),
        frgRunId: expected.frg_run_id,
      });
    }
    const status = requireSuccess(
      await this.git(["status", "--porcelain", "--untracked-files=all"]),
      "git FRG artifact status",
      [],
      { definitive: true },
    ).stdout.split(/\r?\n/).filter(Boolean);
    const allowed = new Set([evidenceRelative, latestRelative, trendRelative]);
    const dirtyPaths = status.map((line) => line.slice(3));
    if (dirtyPaths.some((path) => !allowed.has(path))) {
      throw new FactoryStop("frg-artifact-drift", "the checkout has changes outside the exact receipt-bound FRG file set");
    }
    if (
      requireExactDirtySet &&
      dirtyPaths.length > 0 &&
      (dirtyPaths.length !== allowed.size || [...allowed].some((path) => !dirtyPaths.includes(path)))
    ) {
      throw new FactoryStop("frg-artifact-drift", "the FRG dirty file set is not exact");
    }
    this.frgDirtValidated = true;
    return { version, candidate_git_sha: candidateGitSha, ...expected };
  }

  async consumeFrgRunnerReceipt(actionId, integratedCandidate, runRoot, version) {
    const record = this.journal.actions[actionId];
    const output = await this.readOptionalText(record?.observed?.output_path);
    const receipt = validateFrgRunnerReceipt(parseJson(output, "FRG pack runner"), {
      version,
      manifestSha256: this.config.frg_pack_manifest_sha256,
      candidateGitSha: integratedCandidate.git_sha,
      runRoot,
      repoDir: this.config.repo_dir,
    });
    const trendPath = join(this.config.repo_dir, ".agent-pipeline", "frg", "trend-ledger.jsonl");
    const [observationsBody, bundleBody, frgEvidenceBody, frgLatestBody, trendBody] = await Promise.all([
      this.readFile(receipt.observations_path),
      this.readFile(receipt.evidence_bundle_path),
      this.readFile(receipt.frg_evidence_path),
      this.readFile(receipt.frg_latest_path),
      this.readFile(trendPath),
    ]);
    if (
      sha256(observationsBody) !== receipt.observations_sha256 ||
      sha256(bundleBody) !== receipt.evidence_bundle_sha256 ||
      sha256(frgEvidenceBody) !== receipt.frg_evidence_sha256 ||
      sha256(frgLatestBody) !== receipt.frg_latest_sha256
    ) {
      throw new FactoryStop("frg-runner-receipt", "the FRG runner artifact hashes do not match its receipt");
    }
    const observations = parseJson(observationsBody, "FRG observations");
    const provenance = observations.pack_provenance;
    if (
      provenance?.pack_id !== "factory-gate-v1" ||
      provenance?.release_version !== version ||
      provenance?.manifest_sha256 !== this.config.frg_pack_manifest_sha256 ||
      provenance?.pack_run_id !== receipt.pack_run_id ||
      provenance?.loop_run_id !== receipt.loop_run_id ||
      !Array.isArray(provenance?.issues) ||
      provenance.issues.length !== receipt.synthetic_issues.length
    ) {
      throw new FactoryStop("frg-provenance", "the observations do not bind the fresh runner receipt");
    }
    await this.store.observeAction(this.journal, actionId, {
      loop_run_id: receipt.loop_run_id,
      pack_run_id: receipt.pack_run_id,
      observations_sha256: receipt.observations_sha256,
      evidence_bundle_sha256: receipt.evidence_bundle_sha256,
      frg_run_id: receipt.frg_run_id,
      frg_evidence_sha256: receipt.frg_evidence_sha256,
      frg_latest_sha256: receipt.frg_latest_sha256,
      trend_ledger_sha256: sha256(trendBody),
    });
    this.frgDirtValidated = true;
    return receipt;
  }

  async runFrg(integratedCandidate) {
    const version = this.validated.grant.release_version;
    if (version !== HYBRID_PILOT_VERSION) {
      throw new FactoryStop("frg-hybrid-expired", "the bootstrap hybrid is valid only for v1.33.0; later releases require factory-release prepare");
    }
    const runRoot = join(this.config.state_dir, "frg", this.validated.fingerprint, version);
    await this.guard("frg");
    return this.runAction("frg", {
      version,
      pack_id: "factory-gate-v1",
      manifest_sha256: this.config.frg_pack_manifest_sha256,
      candidate_git_sha: integratedCandidate.git_sha,
    }, {
      safeRetry: false,
      invoke: async (actionId) => {
        const runner = await this.durableCommand(
          actionId,
          "frg-runner",
          this.config.frg_runner_command[0],
          [
            ...this.config.frg_runner_command.slice(1),
            "run",
            "--manifest", this.config.frg_pack_manifest,
            "--manifest-sha256", this.config.frg_pack_manifest_sha256,
            "--version", version,
            "--repository", this.config.repository,
            "--base", this.config.base_branch,
            "--profile", this.config.profile,
            "--candidate-git-sha", integratedCandidate.git_sha,
            "--action-id", actionId,
            "--state-dir", runRoot,
            "--scorer-unit-template", this.config.frg_scorer_unit_template,
            "--scorer-request-dir", this.config.frg_scorer_request_dir,
          ],
          { envRole: "frg_runner" },
        );
        requireSuccess(runner, "FRG pack runner", [], { definitive: true });
        const receipt = await this.consumeFrgRunnerReceipt(actionId, integratedCandidate, runRoot, version);

        const scored = await this.existingFrgResult(version, {
          loop_run_id: receipt.loop_run_id,
          pack_run_id: receipt.pack_run_id,
          frg_run_id: receipt.frg_run_id,
        });
        if (scored.state !== "complete") {
          throw new FactoryStop("frg-unverified", "the isolated FRG scorer did not produce current verified evidence");
        }
      },
      reconcile: async (record) => {
        if (!record.observed?.frg_run_id && record.observed?.unit_result === "complete") {
          try {
            await this.consumeFrgRunnerReceipt(record.action_id, integratedCandidate, runRoot, version);
          } catch (error) {
            return { state: "unsafe", detail: safeErrorMessage(error) };
          }
        }
        const current = this.journal.actions[record.action_id] ?? record;
        const loopRunId = current.observed?.loop_run_id;
        const packRunId = current.observed?.pack_run_id;
        const frgRunId = current.observed?.frg_run_id;
        if (!loopRunId || !packRunId || !frgRunId) return { state: "unsafe", detail: "the interrupted FRG action has no bound fresh pack identity" };
        return this.existingFrgResult(version, { loop_run_id: loopRunId, pack_run_id: packRunId, frg_run_id: frgRunId });
      },
    });
  }

  async attachFrgEvidence(frg) {
    const bound = await this.validateBoundFrgArtifacts({ requireExactDirtySet: true });
    if (!bound || bound.frg_run_id !== frg.frg_run_id || bound.version !== frg.version) {
      throw new FactoryStop("frg-artifact-drift", "release preparation did not receive the exact receipt-bound FRG result");
    }
    const version = frg.version;
    const paths = [
      `.agent-pipeline/frg/${version}/latest.json`,
      `.agent-pipeline/frg/${version}/${frg.frg_run_id}/evidence.json`,
      ".agent-pipeline/frg/trend-ledger.jsonl",
    ];
    requireSuccess(await this.git(["add", "--", ...paths], { action: "release_prepare" }), "git add FRG evidence", [], { definitive: true });
    const diff = await this.git(["diff", "--cached", "--quiet", "--", ...paths]);
    if (diff.code === 1) {
      requireSuccess(
        await this.git(["commit", "-m", `chore: attach FRG evidence for v${version}`], { action: "release_prepare" }),
        "git commit FRG evidence",
        [],
        { definitive: true },
      );
      requireSuccess(
        await this.git(["push", "origin", `HEAD:release/v${version}`], { action: "release_prepare" }),
        "git push release evidence",
        [],
      );
    } else if (diff.code !== 0) {
      throw new FactoryStop("frg-stage", "git could not inspect staged FRG evidence");
    }
  }

  async validateReleaseVersionAtHead(version, headOid) {
    if (!validOid(headOid)) throw new FactoryStop("release-version", "release head identity is invalid");
    for (const path of ["package.json", "core/package.json"]) {
      const result = requireSuccess(
        await this.git(["show", `${headOid}:${path}`]),
        `git show release ${path}`,
        [],
        { definitive: true },
      );
      const pkg = parseJson(result.stdout, `release ${path}`);
      if (pkg.version !== version) throw new FactoryStop("release-version", `${path} does not contain version ${version}`);
    }
  }

  async recoverFrgAttachment(frg, pr) {
    const branch = `release/v${frg.version}`;
    requireSuccess(
      await this.git(["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]),
      "git fetch release branch",
      [],
    );
    const remoteHead = requireSuccess(
      await this.git(["rev-parse", `refs/remotes/origin/${branch}`]),
      "git release branch head",
      [],
      { definitive: true },
    ).stdout.trim();
    if (remoteHead !== pr.head_oid) throw new FactoryStop("release-head-drift", "release branch changed before FRG evidence recovery");
    const status = requireSuccess(
      await this.git(["status", "--porcelain", "--untracked-files=all"]),
      "git release recovery status",
      [],
      { definitive: true },
    ).stdout.split(/\r?\n/).filter(Boolean);
    const prefix = `.agent-pipeline/frg/${frg.version}/`;
    if (status.some((line) => {
      const path = line.slice(3);
      return !path.startsWith(prefix) && path !== ".agent-pipeline/frg/trend-ledger.jsonl";
    })) {
      throw new FactoryStop("dirty-checkout", "release recovery found changes outside the verified FRG evidence paths");
    }
    requireSuccess(
      await this.git(["checkout", "-B", branch, `refs/remotes/origin/${branch}`]),
      "git checkout release recovery",
      [],
      { definitive: true },
    );
    await this.attachFrgEvidence(frg);
  }

  async reconcileReleasePrepare(frg, integratedCandidate, record) {
    try {
      const pr = await resolveReleasePullRequest(
        (command, args) => this.command(command, args, { envRole: "github" }),
        this.config.gh_command,
        this.config.repository,
        this.config.base_branch,
        frg.version,
      );
      if (record?.observed?.launch_ack !== true || record?.observed?.unit_result !== "complete") {
        return {
          state: "unsafe",
          detail: "a release PR exists without one recorded successful candidate release unit",
        };
      }
      const ancestry = await this.gh([
        "api",
        `repos/${this.config.repository}/compare/${integratedCandidate.git_sha}...${pr.head_oid}`,
        "--jq",
        ".status",
      ]);
      if (ancestry.code !== 0 || ancestry.stdout.trim() !== "ahead") {
        return { state: "unsafe", detail: "the release PR head is not derived from the exact integrated candidate" };
      }
      try {
        validateReleasePullRequest(pr, {
          version: frg.version,
          baseBranch: this.config.base_branch,
          frgRunId: frg.frg_run_id,
        });
      } catch (error) {
        if (!String(error?.message ?? "").includes("missing .agent-pipeline/frg/")) throw error;
        await this.recoverFrgAttachment(frg, pr);
        const recovered = await resolveReleasePullRequest(
          (command, args) => this.command(command, args, { envRole: "github" }),
          this.config.gh_command,
          this.config.repository,
          this.config.base_branch,
          frg.version,
        );
        validateReleasePullRequest(recovered, {
          version: frg.version,
          baseBranch: this.config.base_branch,
          frgRunId: frg.frg_run_id,
        });
        await this.validateReleaseVersionAtHead(frg.version, recovered.head_oid);
        return {
          state: "complete",
          result: {
            version: frg.version,
            pr: recovered.number,
            head_oid: recovered.head_oid,
            frg_run_id: frg.frg_run_id,
            base_oid: integratedCandidate.git_sha,
          },
        };
      }
      await this.validateReleaseVersionAtHead(frg.version, pr.head_oid);
      return {
        state: "complete",
        result: {
          version: frg.version,
          pr: pr.number,
          head_oid: pr.head_oid,
          frg_run_id: frg.frg_run_id,
          base_oid: integratedCandidate.git_sha,
        },
      };
    } catch (error) {
      if (error instanceof FactoryStop && error.code === "release-version") throw error;
      return { state: "not_done", detail: safeErrorMessage(error) };
    }
  }

  async prepareRelease(frg, integratedCandidate) {
    await this.guard("release_prepare");
    return this.runAction("release_prepare", {
      version: frg.version,
      frg_run_id: frg.frg_run_id,
      candidate_git_sha: integratedCandidate.git_sha,
    }, {
      safeRetry: false,
      invoke: async (actionId) => {
        const head = requireSuccess(await this.git(["rev-parse", "HEAD"]), "git candidate head", [], { definitive: true }).stdout.trim();
        const branch = requireSuccess(await this.git(["branch", "--show-current"]), "git candidate branch", [], { definitive: true }).stdout.trim();
        if (head !== integratedCandidate.git_sha || branch !== "") {
          throw new FactoryStop("candidate-drift", "release preparation did not start from the exact detached integrated candidate");
        }
        const result = await this.durableCommand(
          actionId,
          "release-prepare",
          this.config.candidate_pipeline_command[0],
          this.candidatePipelineArgs([
            "release",
            frg.version,
            "--no-edit",
            "--repo-path",
            this.config.repo_dir,
            "--base",
            this.config.base_branch,
          ]),
        );
        requireSuccess(result, "pipeline release", [], { definitive: true });
        await this.attachFrgEvidence(frg);
      },
      reconcile: (record) => this.reconcileReleasePrepare(frg, integratedCandidate, record),
    });
  }

  orderedMergeResults() {
    return this.validated.grant.ordered_issues.map((issue) => {
      const record = Object.values(this.journal.actions).find(
        (action) => action.kind === "issue_pr_merge" && action.target?.issue === issue && action.state === "completed",
      );
      if (!record?.result) throw new FactoryStop("merge-frontier", `issue #${issue} has no completed merge result`);
      return record.result;
    });
  }

  async publishNativeReleaseArtifact(path, value, name) {
    try {
      await this.store.publishExclusive(path, value);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await this.store.readJson(path);
      if (!existing || canonicalJson(existing) !== canonicalJson(value)) {
        throw new FactoryStop("native-release-artifact", `the ${name} path is bound to different content`);
      }
    }
  }

  async publishNativeReleaseRequest(path, request) {
    return this.publishNativeReleaseArtifact(path, request, "native release request");
  }

  async loadBoundNativeReleaseRequest(path, expectedSha256) {
    const request = await this.readJson(path, "native release request");
    if (sha256(canonicalJson(request)) !== expectedSha256) {
      throw new FactoryStop("native-release-request", "the native release request changed after publication");
    }
    return request;
  }

  async reconcileNativeReleaseCheckpoint(request, checkpointPath, record) {
    let checkpoint = record.observed?.native_checkpoint ?? null;
    if (!checkpoint && record.observed?.unit_result === "complete") {
      checkpoint = validateNativeReleaseCheckpoint(
        parseJson(await this.readOptionalText(record.observed.output_path), "native factory-release FRG checkpoint"),
        request,
      );
      await this.store.observeAction(this.journal, record.action_id, { native_checkpoint: checkpoint });
    }
    if (!checkpoint) return { state: "not_done" };
    try {
      validateNativeReleaseCheckpoint(checkpoint, request);
      await this.publishNativeReleaseArtifact(checkpointPath, checkpoint, "native release FRG checkpoint");
      const checkpointSha256 = sha256(canonicalJson(checkpoint));
      await this.store.observeAction(this.journal, record.action_id, {
        checkpoint_path: checkpointPath,
        checkpoint_sha256: checkpointSha256,
      });
      return { state: "complete", result: checkpoint };
    } catch (error) {
      return { state: "unsafe", detail: safeErrorMessage(error) };
    }
  }

  async reconcileNativeFrgAttestation(request, checkpoint, record) {
    let handoff = record.observed?.native_attestation_handoff ?? null;
    if (!handoff && record.observed?.unit_result === "complete") {
      handoff = validateNativeFrgAttestationHandoff(
        parseJson(await this.readOptionalText(record.observed.output_path), "native FRG attestation handoff"),
        checkpoint,
        request,
      );
      await this.store.observeAction(this.journal, record.action_id, { native_attestation_handoff: handoff });
    }
    if (!handoff) return { state: "not_done" };
    try {
      validateNativeFrgAttestationHandoff(handoff, checkpoint, request);
      const [evidence, latest] = await Promise.all([
        this.readFile(handoff.frg_evidence_path, "utf8"),
        this.readFile(handoff.frg_latest_path, "utf8"),
      ]);
      if (
        evidence !== latest ||
        sha256(evidence) !== handoff.frg_evidence_sha256 ||
        sha256(latest) !== handoff.frg_latest_sha256
      ) {
        return { state: "unsafe", detail: "the native FRG attestation files do not match the trusted handoff" };
      }
      return { state: "complete", result: handoff };
    } catch (error) {
      return { state: "unsafe", detail: safeErrorMessage(error) };
    }
  }

  async reconcileNativeReleasePrepare(request, record) {
    let result = record.observed?.native_result ?? null;
    if (!result && record.observed?.unit_result === "complete") {
      result = validateNativeReleaseResult(
        parseJson(await this.readOptionalText(record.observed.output_path), "native factory-release result"),
        request,
      );
      await this.store.observeAction(this.journal, record.action_id, { native_result: result });
    }
    if (!result) return { state: "not_done" };
    try {
      validateNativeReleaseResult(result, request);
      const pr = await observePullRequest(
        (command, args) => this.command(command, args, { envRole: "github" }),
        this.config.gh_command,
        this.config.repository,
        result.release_pr.number,
      );
      if (pr.head_oid !== result.release_pr.head_oid) {
        return { state: "unsafe", detail: "the native release PR head changed after candidate handoff" };
      }
      validateReleasePullRequest(pr, {
        version: request.target_version,
        baseBranch: request.base_branch,
        frgRunId: result.frg.run_id,
      });
      const ancestry = await this.gh([
        "api",
        `repos/${this.config.repository}/compare/${request.integrated_candidate.git_sha}...${pr.head_oid}`,
        "--jq",
        ".status",
      ]);
      if (ancestry.code !== 0 || ancestry.stdout.trim() !== "ahead") {
        return { state: "unsafe", detail: "the native release PR is not derived from the integrated candidate" };
      }
      await this.validateReleaseVersionAtHead(request.target_version, pr.head_oid);
      return {
        state: "complete",
        result: {
          version: request.target_version,
          pr: pr.number,
          head_oid: pr.head_oid,
          frg_run_id: result.frg.run_id,
          base_oid: request.integrated_candidate.git_sha,
          native_checkpoint: result.checkpoint,
          frg_evidence_sha256: result.frg.evidence_sha256,
        },
      };
    } catch (error) {
      return { state: "unsafe", detail: safeErrorMessage(error) };
    }
  }

  async prepareNativeRelease(integratedCandidate) {
    if (this.validated.grant.release_version === HYBRID_PILOT_VERSION) {
      throw new FactoryStop("native-release", "the pilot must use the reviewed v1.33.0 hybrid path");
    }
    await this.guard("frg");
    await this.guard("release_prepare");
    const frontier = this.startingFrontierAction()?.result;
    if (!frontier || frontier.pilot || !samePin(frontier.production_pin, normalizedPin(frontier.production_pin, "starting pin"))) {
      throw new FactoryStop("native-release", "a later release has no verified production-pin starting frontier");
    }
    const merges = this.orderedMergeResults();
    const target = {
      version: this.validated.grant.release_version,
      candidate_git_sha: integratedCandidate.git_sha,
      merge_results_sha256: sha256(canonicalJson(merges)),
    };
    if (!isAbsolute(this.configPath ?? "")) {
      throw new FactoryStop("native-release", "the stable wrapper has no absolute machine-config path for trusted attestation");
    }
    const workflowActionId = journalActionId(this.validated.fingerprint, "native_release_checkpoint", target);
    const request = buildNativeReleaseRequest({
      validated: this.validated,
      config: this.config,
      actionId: workflowActionId,
      integratedCandidate,
      productionPin: frontier.production_pin,
      mergeResults: merges,
    });
    const requestRoot = join(
      this.config.state_dir,
      "native-release",
      this.validated.fingerprint,
      this.validated.grant.release_version,
    );
    const requestPath = join(requestRoot, `${workflowActionId}.request.json`);
    const checkpointPath = join(requestRoot, `${workflowActionId}.checkpoint.json`);
    const requestSha256 = sha256(canonicalJson(request));

    const checkpoint = await this.runAction("native_release_checkpoint", target, {
      safeRetry: false,
      invoke: async (actionId) => {
        if (actionId !== workflowActionId) {
          throw new FactoryStop("native-release", "the native release workflow action identity changed");
        }
        await this.mkdir(requestRoot, { recursive: true, mode: 0o700 });
        await this.publishNativeReleaseRequest(requestPath, request);
        await this.store.observeAction(this.journal, actionId, {
          request_path: requestPath,
          request_sha256: requestSha256,
        });
        const command = await this.durableCommand(
          actionId,
          "native-release-checkpoint",
          this.config.candidate_pipeline_command[0],
          this.candidatePipelineArgs([
            "factory-release",
            "prepare",
            "--request",
            requestPath,
            "--json",
          ]),
        );
        requireSuccess(command, "candidate pipeline factory-release checkpoint", [], { definitive: true });
        const result = validateNativeReleaseCheckpoint(
          parseJson(command.stdout, "native factory-release FRG checkpoint"),
          request,
        );
        await this.publishNativeReleaseArtifact(checkpointPath, result, "native release FRG checkpoint");
        await this.store.observeAction(this.journal, actionId, {
          native_checkpoint: result,
          checkpoint_path: checkpointPath,
          checkpoint_sha256: sha256(canonicalJson(result)),
        });
      },
      reconcile: async (record) => {
        if (!record.observed?.request_path) return { state: "not_done" };
        const bound = await this.loadBoundNativeReleaseRequest(record.observed.request_path, record.observed.request_sha256);
        if (canonicalJson(bound) !== canonicalJson(request)) {
          return { state: "unsafe", detail: "the native release request changed after publication" };
        }
        return this.reconcileNativeReleaseCheckpoint(request, checkpointPath, record);
      },
    });

    validateNativeReleaseCheckpoint(checkpoint, request);
    const checkpointSha256 = sha256(canonicalJson(checkpoint));
    const [boundRequest, boundCheckpoint] = await Promise.all([
      this.loadBoundNativeReleaseRequest(requestPath, requestSha256),
      this.readJson(checkpointPath, "native release FRG checkpoint"),
    ]);
    if (
      canonicalJson(boundRequest) !== canonicalJson(request) ||
      canonicalJson(boundCheckpoint) !== canonicalJson(checkpoint) ||
      sha256(canonicalJson(boundCheckpoint)) !== checkpointSha256
    ) {
      throw new FactoryStop("native-release-checkpoint", "the native release checkpoint changed after publication");
    }
    const attestationTarget = {
      workflow_action_id: workflowActionId,
      checkpoint: checkpoint.checkpoint,
      checkpoint_sha256: checkpointSha256,
      candidate_git_sha: integratedCandidate.git_sha,
    };
    const handoff = await this.runAction("native_release_attest", attestationTarget, {
      safeRetry: true,
      invoke: async (actionId) => {
        const command = await this.durableCommand(
          actionId,
          "native-release-attest",
          this.config.frg_runner_command[0],
          [
            ...this.config.frg_runner_command.slice(1),
            "attest",
            "--checkpoint", checkpointPath,
            "--config", this.configPath,
          ],
          { envRole: "frg_runner" },
        );
        requireSuccess(command, "trusted production FRG attestation", [], { definitive: true });
        const result = validateNativeFrgAttestationHandoff(
          parseJson(command.stdout, "native FRG attestation handoff"),
          checkpoint,
          request,
        );
        await this.store.observeAction(this.journal, actionId, { native_attestation_handoff: result });
      },
      reconcile: (record) => this.reconcileNativeFrgAttestation(request, checkpoint, record),
    });

    validateNativeFrgAttestationHandoff(handoff, checkpoint, request);
    const attestationRecord = Object.values(this.journal.actions).find(
      (entry) => entry.kind === "native_release_attest" && entry.target?.workflow_action_id === workflowActionId,
    );
    if (!attestationRecord || (await this.reconcileNativeFrgAttestation(request, checkpoint, attestationRecord)).state !== "complete") {
      throw new FactoryStop("native-release-attestation", "the trusted FRG attestation is not current and intact");
    }
    const finalTarget = {
      ...target,
      workflow_action_id: workflowActionId,
      checkpoint: checkpoint.checkpoint,
      attestation_payload_sha256: handoff.attestation_payload_sha256,
      frg_evidence_sha256: handoff.frg_evidence_sha256,
    };
    return this.runAction("native_release_prepare", finalTarget, {
      safeRetry: false,
      invoke: async (actionId) => {
        if (!attestationRecord || (await this.reconcileNativeFrgAttestation(request, checkpoint, attestationRecord)).state !== "complete") {
          throw new FactoryStop("native-release-attestation", "the trusted FRG attestation changed before release preparation");
        }
        const command = await this.durableCommand(
          actionId,
          "native-release-prepare",
          this.config.candidate_pipeline_command[0],
          this.candidatePipelineArgs([
            "factory-release",
            "prepare",
            "--request",
            requestPath,
            "--json",
          ]),
        );
        requireSuccess(command, "candidate pipeline factory-release prepare", [], { definitive: true });
        const result = validateNativeReleaseResult(parseJson(command.stdout, "native factory-release result"), request);
        await this.store.observeAction(this.journal, actionId, { native_result: result });
      },
      reconcile: async (record) => {
        const bound = await this.loadBoundNativeReleaseRequest(requestPath, requestSha256);
        if (canonicalJson(bound) !== canonicalJson(request)) {
          return { state: "unsafe", detail: "the native release request changed before completion" };
        }
        const attestationRecord = Object.values(this.journal.actions).find(
          (entry) => entry.kind === "native_release_attest" && entry.target?.workflow_action_id === workflowActionId,
        );
        if (!attestationRecord || (await this.reconcileNativeFrgAttestation(request, checkpoint, attestationRecord)).state !== "complete") {
          return { state: "unsafe", detail: "the native FRG attestation is no longer valid" };
        }
        return this.reconcileNativeReleasePrepare(request, record);
      },
    });
  }

  async reconcileReleaseMerge(target) {
    const pr = await observePullRequest(
      (command, args) => this.command(command, args, { envRole: "github" }),
      this.config.gh_command,
      this.config.repository,
      target.pr,
    );
    if (pr.head_oid !== target.head_oid) return { state: "unsafe", detail: "the release PR head changed after inspection" };
    if (pr.state === "OPEN") return { state: "not_done" };
    if (pr.state !== "MERGED" || !validOid(pr.merge_oid)) return { state: "unsafe", detail: "the release PR has an unexpected state" };
    const tip = await this.fetchedBaseTip();
    if (tip !== pr.merge_oid) return { state: "unsafe", detail: "the release merge is not the freshly fetched base tip" };
    const parent = requireSuccess(
      await this.git(["rev-parse", `${pr.merge_oid}^`]),
      "git release merge parent",
      [],
      { definitive: true },
    ).stdout.trim();
    if (parent !== target.base_oid) {
      return { state: "unsafe", detail: "the release merge was not based on the exact integrated candidate" };
    }
    return {
      state: "complete",
      result: { version: target.version, pr: target.pr, head_oid: target.head_oid, merge_oid: pr.merge_oid, base_oid: target.base_oid },
    };
  }

  async finalizeRelease(prepared) {
    await this.guard("release_pr_merge");
    const target = { version: prepared.version, pr: prepared.pr, head_oid: prepared.head_oid, base_oid: prepared.base_oid };
    if (!validOid(target.base_oid)) {
      throw new FactoryStop("release-frontier", "the release candidate has no exact integrated base identity");
    }
    return this.runAction("release_pr_merge", target, {
      safeRetry: true,
      invoke: async () => {
        const pr = await observePullRequest(
          (command, args) => this.command(command, args, { envRole: "github" }),
          this.config.gh_command,
          this.config.repository,
          prepared.pr,
        );
        if (pr.head_oid !== prepared.head_oid) throw new FactoryStop("head-drift", "the release PR head changed before finalization");
        validateReleasePullRequest(pr, {
          version: prepared.version,
          baseBranch: this.config.base_branch,
          frgRunId: prepared.frg_run_id,
        });
        if (pr.mergeable !== "MERGEABLE" || pr.merge_state !== "CLEAN") {
          throw new FactoryStop("release-mergeability", "the release PR is not clean and mergeable");
        }
        await requireGreenChecks(
          (command, args) => this.command(command, args, { envRole: "github" }),
          this.config.gh_command,
          this.config.repository,
          prepared.pr,
          {
            timeoutMs: this.config.ci_timeout_seconds * 1000,
            retryDelayMs: 5_000,
            sleep: this.sleep,
            onWait: () => this.notices.heartbeat({ status: "waiting_for_release_checks", pr: prepared.pr }),
          },
        );
        const freshBase = await this.fetchedBaseTip();
        if (freshBase !== prepared.base_oid) {
          throw new FactoryStop("release-frontier", "the base changed before exact-head release finalization");
        }
        const result = await this.gh(
          [
            "pr",
            "merge",
            String(prepared.pr),
            "--squash",
            "--delete-branch",
            "--match-head-commit",
            prepared.head_oid,
            "--repo",
            this.config.repository,
          ],
          { action: "release_pr_merge" },
        );
        requireSuccess(result, "gh exact-head release merge", [], { definitive: true });
      },
      reconcile: () => this.reconcileReleaseMerge(target),
    });
  }

  async observePublication(merged) {
    const tag = `v${merged.version}`;
    const fetch = await this.git(["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    if (fetch.code !== 0) return null;
    const type = await this.git(["cat-file", "-t", `refs/tags/${tag}`]);
    if (type.code !== 0) return null;
    const peel = await this.git(["rev-parse", `refs/tags/${tag}^{}`]);
    if (peel.code !== 0) return null;
    const release = await observePublishedRelease(
      (command, args) => this.command(command, args, { envRole: "github" }),
      this.config.gh_command,
      this.config.repository,
      tag,
    );
    if (!release) return null;
    return validatePublication({
      tagType: type.stdout.trim(),
      peeledOid: peel.stdout.trim(),
      release,
      tag,
      mergeOid: merged.merge_oid,
    });
  }

  async verifyPublication(merged) {
    await this.guard("release_verify");
    return this.runAction("release_verify", { version: merged.version, merge_oid: merged.merge_oid }, {
      safeRetry: true,
      invoke: async () => {
        const deadline = this.now().getTime() + this.config.publication_timeout_seconds * 1000;
        while (this.now().getTime() <= deadline) {
          const proof = await this.observePublication(merged);
          if (proof) return;
          await this.notices.heartbeat({ status: "waiting_for_release_publication" });
          await this.sleep(15_000);
        }
        throw new FactoryStop("publication-timeout", "the tag and GitHub Release did not become verifiable before timeout");
      },
      reconcile: async () => {
        const proof = await this.observePublication(merged);
        return proof ? { state: "complete", result: proof } : { state: "not_done" };
      },
    });
  }

  async readProductionPin({ compensationPin = null } = {}) {
    const record = await this.readJson(this.config.production_pin_file, "production engine pin");
    const tagArgs = ["rev-parse", `refs/tags/${record.tag}^{}`];
    const tagResult = compensationPin
      ? await this.compensationProcess(
        compensationPin,
        this.config.git_command,
        tagArgs,
        { cwd: this.config.repo_dir, envRole: "git" },
      )
      : await this.git(tagArgs);
    const resolvedGitSha = requireSuccess(
      tagResult,
      "production pin tag resolution",
      [],
      { definitive: true },
    ).stdout.trim();
    return validateProductionPinRecord(record, resolvedGitSha);
  }

  factoryPinPromoteArgs(version, gitSha) {
    return [
      "factory-pin",
      "promote",
      "--for",
      version,
      "--git-sha",
      gitSha,
      "--repo-path",
      this.config.repo_dir,
      "--profile",
      this.config.profile,
    ];
  }

  factoryPinRollbackArgs(version) {
    return [
      "factory-pin",
      "rollback",
      "--to",
      version,
      "--repo-path",
      this.config.repo_dir,
      "--profile",
      this.config.profile,
    ];
  }

  async promotePin(publication, previousPin) {
    const version = this.validated.grant.release_version;
    await this.guard("pin_promote");
    return this.runAction("pin_promote", { version, merge_oid: publication.merge_oid }, {
      safeRetry: true,
      invoke: async (actionId) => {
        const prior = {
          version: previousPin.version,
          tag: previousPin.tag,
          git_sha: previousPin.git_sha,
        };
        const existingObserved = this.journal.actions[actionId]?.observed;
        if (existingObserved?.previous_pin) {
          if (JSON.stringify(existingObserved.previous_pin) !== JSON.stringify(prior)) {
            throw new FactoryStop("pin-baseline-drift", "the stored rollback pin does not match the pre-promotion pin");
          }
        } else {
          await this.store.observeAction(this.journal, actionId, { previous_pin: prior });
        }
        const livePrior = await this.readProductionPin();
        if (
          livePrior.version !== prior.version ||
          livePrior.tag !== prior.tag ||
          livePrior.git_sha !== prior.git_sha
        ) {
          throw new FactoryStop("pin-baseline-drift", "the live production pin changed before promotion");
        }
        const result = await this.durableCommand(
          actionId,
          "pin-promote",
          this.config.pipeline_command[0],
          this.pipelineArgs(this.factoryPinPromoteArgs(version, publication.merge_oid)),
        );
        requireSuccess(result, "pipeline factory-pin promote", [], { definitive: true });
      },
      reconcile: async (record) => {
        const pin = await this.readProductionPin();
        if (pin.version === version && pin.tag === `v${version}` && pin.git_sha === publication.merge_oid) {
          if (!record.observed?.previous_pin) return { state: "unsafe", detail: "the pre-promotion rollback pin was not persisted" };
          return { state: "complete", result: { version, tag: pin.tag, git_sha: pin.git_sha, previous_pin: record.observed.previous_pin } };
        }
        return { state: "not_done" };
      },
    });
  }

  async checkoutArtifact(tag, expectedOid, { compensationPin = null } = {}) {
    const cwd = this.config.artifact_checkout;
    const git = (args) => compensationPin
      ? this.compensationProcess(compensationPin, this.config.git_command, args, { cwd, envRole: "git" })
      : this.git(args, { cwd });
    const status = requireSuccess(await git(["status", "--porcelain", "--untracked-files=all"]), "artifact git status", [], { definitive: true });
    if (status.stdout.trim()) throw new FactoryStop("artifact-dirty", "the install artifact checkout is not clean");
    requireSuccess(
      await git(["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`]),
      "artifact tag fetch",
      [],
    );
    const type = requireSuccess(await git(["cat-file", "-t", `refs/tags/${tag}`]), "artifact tag type", [], { definitive: true }).stdout.trim();
    const peel = requireSuccess(await git(["rev-parse", `refs/tags/${tag}^{}`]), "artifact tag peel", [], { definitive: true }).stdout.trim();
    if (type !== "tag" || (expectedOid && peel !== expectedOid)) {
      throw new FactoryStop("artifact-identity", `install artifact ${tag} is not the verified annotated release tag`);
    }
    requireSuccess(await git(["checkout", "--detach", peel]), "artifact checkout", [], { definitive: true });
    return peel;
  }

  async installTag(tag, expectedOid, action, { compensationPin = null } = {}) {
    if (compensationPin) {
      const bound = this.requireCompensationPin(compensationPin);
      if (action !== "rollback" || tag !== bound.tag || expectedOid !== bound.git_sha) {
        throw new FactoryStop("rollback-binding", "the compensation install target does not match the journaled previous_pin");
      }
    } else {
      await this.guard(action);
    }
    await this.checkoutArtifact(tag, expectedOid, { compensationPin });
    for (const host of this.config.install_hosts) {
      await this.runAction("install_host", { action, tag, host, expected_oid: expectedOid }, {
        safeRetry: false,
        invoke: async (actionId) => {
          if (compensationPin) this.requireCompensationPin(compensationPin);
          else await this.guard(action);
          const result = await this.durableCommand(
            actionId,
            `install-${host}`,
            this.config.node_command,
            [join(this.config.artifact_checkout, "scripts", "install.mjs"), "install", "--host", host],
            { envRole: "install" },
          );
          requireSuccess(result, `install ${tag} for ${host}`, [], { definitive: true });
        },
        reconcile: async (record) => record.observed?.unit_result === "complete"
          ? { state: "complete", result: { host, tag, exit_code: 0 } }
          : { state: "not_done" },
      });
    }
  }

  async observeInstalled(version, { compensationPin = null } = {}) {
    const versionResult = compensationPin
      ? await this.compensationPipeline(compensationPin, ["--version"])
      : await this.pipeline(["--version"]);
    if (versionResult.code !== 0 || versionResult.stdout.trim() !== version) return null;
    try {
      await this.pipelineProof(
        "installed_doctor",
        { version, base: this.config.base_branch },
        [
          "doctor",
          "--json",
          "--harness-smoke",
          "--engine-track",
          "pinned",
          "--repo-path",
          this.config.repo_dir,
          "--base",
          this.config.base_branch,
          "--profile",
          this.config.profile,
        ],
        (stdout) => {
          validateDoctorEnvelope(parseJson(stdout, "pipeline doctor"), version);
          return { status: "ok", version, implementer_model: "grok-4.5", reviewer: "codex" };
        },
        { compensationPin },
      );
    } catch (error) {
      if (error instanceof CommandError && error.stopped) throw error;
      if (error instanceof FactoryStop && error.code === "stopped") throw error;
      return null;
    }
    const modelProof = await this.probeGrokModel();
    if (modelProof?.effective_model !== "grok-4.5") return null;
    return { version, launcher: this.config.pipeline_command.join(" "), doctor: "ok", effective_model: "grok-4.5" };
  }

  async restoreProductionPin(previousPin) {
    const target = this.requireCompensationPin(previousPin);
    return this.runAction("rollback_pin", target, {
      safeRetry: true,
      invoke: async (actionId) => {
        await this.checkoutArtifact(target.tag, target.git_sha, { compensationPin: target });
        const pinResult = await this.durableCommand(
          actionId,
          "pin-rollback",
          this.config.node_command,
          [
            this.compensationPipelineEntrypoint(target),
            ...this.factoryPinRollbackArgs(previousPin.version),
          ],
        );
        requireSuccess(pinResult, "pipeline factory-pin rollback", [], { definitive: true });
      },
      reconcile: async () => {
        await this.checkoutArtifact(target.tag, target.git_sha, { compensationPin: target });
        const pin = await this.readProductionPin({ compensationPin: target });
        if (pin.version === previousPin.version && pin.tag === previousPin.tag && pin.git_sha === previousPin.git_sha) {
          return { state: "complete", result: target };
        }
        return { state: "not_done" };
      },
    });
  }

  async rollback(previousPin, cause) {
    const target = this.requireCompensationPin(previousPin);
    return this.runAction("rollback", target, {
      safeRetry: true,
      invoke: async () => {
        await this.restoreProductionPin(target);
        await this.installTag(target.tag, target.git_sha, "rollback", { compensationPin: target });
      },
      reconcile: async () => {
        await this.checkoutArtifact(target.tag, target.git_sha, { compensationPin: target });
        const installed = await this.observeInstalled(target.version, { compensationPin: target });
        const pin = await this.readProductionPin({ compensationPin: target });
        if (
          installed &&
          pin.version === target.version &&
          pin.tag === target.tag &&
          pin.git_sha === target.git_sha
        ) {
          return {
            state: "complete",
            result: { ...installed, restored_tag: target.tag, restored_git_sha: target.git_sha, cause: safeErrorMessage(cause) },
          };
        }
        return { state: "not_done" };
      },
    });
  }

  async promoteAndInstall(publication) {
    const existingPromotion = Object.values(this.journal.actions).find(
      (action) => action.kind === "pin_promote" && action.target?.version === this.validated.grant.release_version,
    );
    const previousPin = existingPromotion?.observed?.previous_pin ?? await this.readProductionPin();
    const promoted = await this.promotePin(publication, previousPin);
    const version = promoted.version;
    try {
      return await this.runAction("install", { version, tag: promoted.tag, merge_oid: publication.merge_oid }, {
        safeRetry: true,
        invoke: () => this.installTag(promoted.tag, publication.merge_oid, "install"),
        reconcile: async () => {
          const installed = await this.observeInstalled(version);
          const pin = await this.readProductionPin();
          return installed && pin.version === version && pin.tag === promoted.tag && pin.git_sha === publication.merge_oid
            ? { state: "complete", result: { ...installed, tag: pin.tag, git_sha: pin.git_sha } }
            : { state: "not_done" };
        },
      });
    } catch (error) {
      const rollback = await this.rollback(promoted.previous_pin, error);
      await this.notices.send("rollback", rollback, {
        dedupeId: `${this.validated.fingerprint}:rollback`,
      });
      await this.store.markStatus(this.journal, "rolled_back");
      throw new FactoryStop("install-rolled-back", "the new install failed and the previous verified pin was restored");
    }
  }

  async run() {
    await this.notices.flushPending();
    await this.notices.send("run_start", {
      status: "accepted",
      issues: this.validated.grant.ordered_issues,
      model: this.validated.grant.model,
    });
    let compensationOnly = this.rollbackEvidence().length > 0;
    try {
      const recoveryPin = this.rollbackRecoveryPin();
      if (recoveryPin) {
        compensationOnly = true;
        const rollback = await this.rollback(
          recoveryPin,
          new FactoryStop("rollback-resume", "journaled rollback evidence requires compensation-only recovery"),
        );
        await this.store.markStatus(this.journal, "rolled_back");
        await this.notices.send("rollback", rollback, {
          dedupeId: `${this.validated.fingerprint}:rollback`,
        });
        throw new FactoryStop("rollback-resumed", "the journaled rollback completed; forward work remains stopped");
      }
      await this.settleActiveDurableUnit();
      await this.ensureLiveGrant();
      await this.preflight({ skipProductionRuntime: this.hasPromotionStarted() });
      const completedResult = (kind) => Object.values(this.journal.actions).find(
        (action) => action.kind === kind && action.state === "completed",
      )?.result ?? null;
      const pilot = this.validated.grant.release_version === HYBRID_PILOT_VERSION;
      let prepared = completedResult(pilot ? "release_prepare" : "native_release_prepare");
      let merged = completedResult("release_pr_merge");
      if (!merged) {
        if (!prepared) {
          await this.driveIssues();
          const integratedCandidate = await this.bindIntegratedCandidate();
          if (pilot) {
            const frg = await this.runFrg(integratedCandidate);
            await this.notices.send("frg_result", { ...frg, status: "pass" });
            prepared = await this.prepareRelease(frg, integratedCandidate);
          } else {
            prepared = await this.prepareNativeRelease(integratedCandidate);
            await this.notices.send("frg_result", {
              status: "pass",
              frg_run_id: prepared.frg_run_id,
              evidence_sha256: prepared.frg_evidence_sha256,
              native_checkpoint: prepared.native_checkpoint,
            });
          }
          await this.notices.send("release_pr", { ...prepared, status: "ready" });
        }
        merged = await this.finalizeRelease(prepared);
      }
      const publication = await this.verifyPublication(merged);
      await this.notices.send("release_published", publication);
      await this.refreshBase({ requireClean: false });
      const installed = await this.promoteAndInstall(publication);
      await this.notices.send("install_result", { ...installed, status: "pass" });
      await this.store.markStatus(this.journal, "completed");
      return { status: "completed", publication, installed };
    } catch (error) {
      let failure = error;
      if (!compensationOnly && this.journal.status !== "rolled_back") {
        try {
          const previousPin = this.journalCompensationPin();
          if (previousPin) {
            const rollback = await this.rollback(previousPin, error);
            await this.store.markStatus(this.journal, "rolled_back");
            await this.notices.send("rollback", rollback, {
              dedupeId: `${this.validated.fingerprint}:rollback`,
            });
          }
        } catch (compensationError) {
          failure = new FactoryStop(
            "rollback-failed",
            `the journal-bound post-promotion rollback failed: ${safeErrorMessage(compensationError)}`,
          );
        }
      }
      const childStop = failure instanceof CommandError ? failure.stopped : null;
      const isStop = (failure instanceof FactoryStop && failure.code === "stopped") || Boolean(childStop);
      const isRevoke = String(childStop ?? failure?.message ?? "").startsWith("revoke:");
      const stopStatus = this.journal.status === "rolled_back"
        ? "rolled_back"
        : isRevoke
          ? "revoked"
          : isStop
            ? "stopped"
            : "failed";
      await this.store.markStatus(this.journal, stopStatus);
      await this.notices.send(["stopped", "revoked"].includes(stopStatus) ? "stop" : "failure", {
        status: stopStatus,
        code: failure?.code ?? "factory-error",
        message: safeErrorMessage(failure),
      });
      throw failure;
    }
  }
}

export function assertGrantHasOnlyKnownActions(validated) {
  return validated.grant.actions.every((action) => GRANT_ACTIONS.includes(action));
}
