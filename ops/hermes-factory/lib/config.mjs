import { isAbsolute, join, normalize } from "node:path";

export const CONFIG_SCHEMA_VERSION = 1;

const CONFIG_KEYS = Object.freeze([
  "schema_version", "enabled", "operator_pubkey", "buzz_channel", "repository", "base_branch",
  "repo_dir", "state_dir", "inbox_dir", "active_grant_file", "control_file", "artifact_checkout",
  "production_pin_file", "wrapper_dir", "wrapper_manifest_file", "wrapper_git_sha",
  "bootstrap_base_git_sha", "candidate_version", "frg_pack_manifest", "frg_pack_manifest_sha256",
  "pipeline_loop_state_dir", "frg_scorer_unit_template", "frg_scorer_request_dir",
  "pipeline_command", "candidate_pipeline_command", "frg_runner_command", "gh_command", "git_command",
  "node_command", "grok_command", "systemd_run_command", "systemctl_command", "install_hosts", "profile", "max_issues", "max_grant_seconds",
  "event_clock_skew_seconds", "heartbeat_seconds", "command_timeout_seconds",
  "publication_timeout_seconds", "ci_timeout_seconds", "notification_command", "secret_env_names", "env_allowlists",
]);

const ENV_ROLES = Object.freeze([
  "common",
  "pipeline",
  "github",
  "git",
  "model_probe",
  "notification",
  "frg_runner",
  "install",
  "systemd",
]);

const BUZZ_SECRET_ENV = new Set(["BUZZ_PRIVATE_KEY", "BUZZ_AUTH_TAG"]);

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function assertExactKeys(value, keys, name) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${name} contains unknown field(s): ${unknown.sort().join(", ")}`);
}

function assertString(value, name, pattern) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (pattern && !pattern.test(value)) {
    throw new Error(`${name} has an invalid value`);
  }
  return value;
}

function assertAbsolute(value, name) {
  assertString(value, name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return normalize(value);
}

function assertInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function assertCommand(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty command array`);
  }
  const command = value.map((part, index) => assertString(part, `${name}[${index}]`));
  assertAbsolute(command[0], `${name}[0]`);
  return command;
}

function validateEnvAllowlists(raw) {
  const input = assertObject(raw, "config.env_allowlists");
  assertExactKeys(input, ENV_ROLES, "config.env_allowlists");
  const out = {};
  for (const role of ENV_ROLES) {
    const names = input[role];
    if (!Array.isArray(names)) throw new Error(`config.env_allowlists.${role} must be an array`);
    const unique = new Set();
    for (const name of names) {
      assertString(name, `config.env_allowlists.${role}[]`, /^[A-Z][A-Z0-9_]*$/);
      if (unique.has(name)) throw new Error(`config.env_allowlists.${role} repeats ${name}`);
      unique.add(name);
    }
    out[role] = Object.freeze([...unique]);
  }
  for (const [role, names] of Object.entries(out)) {
    if (names.some((name) => BUZZ_SECRET_ENV.has(name))) {
      throw new Error("Buzz credentials must not enter the factory service environment");
    }
    if (names.includes("PIPELINE_FRG_ATTESTATION_KEY") || names.includes("PIPELINE_FRG_ATTESTATION_KEY_FILE")) {
      throw new Error("the live factory service must not receive the FRG credential or its file path");
    }
  }
  if (!out.common.includes("PATH") || !out.common.includes("HOME")) {
    throw new Error("config.env_allowlists.common must include PATH and HOME");
  }
  return Object.freeze(out);
}

export function envForRole(config, role, source = process.env) {
  if (!ENV_ROLES.includes(role)) throw new Error(`unsupported child environment role ${role}`);
  const names = new Set([...config.env_allowlists.common, ...config.env_allowlists[role]]);
  const env = {};
  for (const name of names) {
    if (typeof source[name] === "string") env[name] = source[name];
  }
  return env;
}

export function validateMachineConfig(raw, { requireEnabled = false } = {}) {
  const input = assertObject(raw, "config");
  assertExactKeys(input, CONFIG_KEYS, "config");
  if (input.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`config.schema_version must be ${CONFIG_SCHEMA_VERSION}`);
  }
  if (typeof input.enabled !== "boolean") throw new Error("config.enabled must be a boolean");
  if (requireEnabled && !input.enabled) throw new Error("the scoped factory is disabled in machine config");
  if (requireEnabled && input.notification_command == null) {
    throw new Error("config.notification_command is required when the scoped factory is enabled");
  }

  const repoDir = assertAbsolute(input.repo_dir, "config.repo_dir");
  const nodeCommand = assertAbsolute(input.node_command, "config.node_command");
  const pipelineCommand = assertCommand(input.pipeline_command, "config.pipeline_command");
  if (pipelineCommand.includes("/usr/local/bin/pipeline")) {
    throw new Error("config.pipeline_command must not use /usr/local/bin/pipeline");
  }
  if (
    pipelineCommand.length !== 2 ||
    pipelineCommand[0] !== nodeCommand ||
    !isAbsolute(pipelineCommand[1]) ||
    !pipelineCommand[1].endsWith("/.codex/skills/pipeline/scripts/pipeline.mjs")
  ) {
    throw new Error(
      "config.pipeline_command must be the exact installed Codex Pipeline launcher",
    );
  }

  const candidatePipelineCommand = assertCommand(
    input.candidate_pipeline_command,
    "config.candidate_pipeline_command",
  );
  const candidateEntrypoint = join(repoDir, "core", "scripts", "pipeline.ts");
  if (
    candidatePipelineCommand.length !== 3 ||
    candidatePipelineCommand[0] !== nodeCommand ||
    candidatePipelineCommand[1] !== "--experimental-strip-types" ||
    normalize(candidatePipelineCommand[2]) !== candidateEntrypoint
  ) {
    throw new Error(
      "config.candidate_pipeline_command must run the control checkout core/scripts/pipeline.ts with Node type stripping",
    );
  }

  const wrapperDirForRunner = assertAbsolute(input.wrapper_dir, "config.wrapper_dir");
  const frgRunnerCommand = assertCommand(input.frg_runner_command, "config.frg_runner_command");
  const frgRunnerEntrypoint = join(wrapperDirForRunner, "lib", "frg-runner.mjs");
  if (
    frgRunnerCommand.length !== 2 ||
    frgRunnerCommand[0] !== nodeCommand ||
    normalize(frgRunnerCommand[1]) !== frgRunnerEntrypoint
  ) {
    throw new Error(
      "config.frg_runner_command must run wrapper_dir/lib/frg-runner.mjs",
    );
  }

  const installHosts = input.install_hosts;
  if (!Array.isArray(installHosts) || installHosts.length === 0) {
    throw new Error("config.install_hosts must be a non-empty array");
  }
  const allowedHosts = new Set(["claude", "codex", "grok", "opencode"]);
  const uniqueHosts = new Set();
  for (const host of installHosts) {
    assertString(host, "config.install_hosts[]", /^[a-z]+$/);
    if (!allowedHosts.has(host)) throw new Error(`config.install_hosts contains unsupported host ${host}`);
    if (uniqueHosts.has(host)) throw new Error(`config.install_hosts repeats ${host}`);
    uniqueHosts.add(host);
  }
  if (!uniqueHosts.has("codex")) throw new Error("config.install_hosts must include codex for the fixed production launcher");
  const claudeIndex = installHosts.indexOf("claude");
  const grokIndex = installHosts.indexOf("grok");
  if (grokIndex >= 0 && (claudeIndex < 0 || claudeIndex > grokIndex)) {
    throw new Error("config.install_hosts must place claude before grok");
  }

  const secretEnvNames = input.secret_env_names ?? [];
  if (!Array.isArray(secretEnvNames)) throw new Error("config.secret_env_names must be an array");
  const secretSet = new Set();
  for (const name of secretEnvNames) {
    assertString(name, "config.secret_env_names[]", /^[A-Z][A-Z0-9_]*$/);
    if (secretSet.has(name)) throw new Error(`config.secret_env_names repeats ${name}`);
    secretSet.add(name);
  }
  const envAllowlists = validateEnvAllowlists(input.env_allowlists);

  const wrapperDir = wrapperDirForRunner;
  const wrapperManifestFile = assertAbsolute(input.wrapper_manifest_file, "config.wrapper_manifest_file");
  if (wrapperManifestFile !== join(wrapperDir, "pinned-artifacts.json")) {
    throw new Error("config.wrapper_manifest_file must be wrapper_dir/pinned-artifacts.json");
  }
  const stateDir = assertAbsolute(input.state_dir, "config.state_dir");
  const frgScorerRequestDir = assertAbsolute(input.frg_scorer_request_dir, "config.frg_scorer_request_dir");
  if (frgScorerRequestDir !== join(stateDir, "frg-scorer-requests")) {
    throw new Error("config.frg_scorer_request_dir must be state_dir/frg-scorer-requests");
  }
  if (input.frg_scorer_unit_template !== "hermes-factory-frg@.service") {
    throw new Error("config.frg_scorer_unit_template must be hermes-factory-frg@.service");
  }
  let notificationCommand = null;
  if (input.notification_command != null) {
    notificationCommand = assertCommand(input.notification_command, "config.notification_command");
    const expectedTail = [
      "-m", "hermes_cli.main", "-p", "pipeline-factory", "send", "--to",
      "buzz:{chat_id}:{thread_id}", "--file", "-", "--quiet",
    ];
    if (
      !notificationCommand[0].endsWith("/hermes-agent-v2026.8.3/venv/bin/python") ||
      notificationCommand.length !== expectedTail.length + 1 ||
      expectedTail.some((part, index) => notificationCommand[index + 1] !== part)
    ) {
      throw new Error("config.notification_command must be the pinned Hermes v2026.8.3 Buzz sender command");
    }
  }

  return Object.freeze({
    schema_version: CONFIG_SCHEMA_VERSION,
    enabled: input.enabled,
    operator_pubkey: assertString(input.operator_pubkey, "config.operator_pubkey", /^[a-f0-9]{64}$/),
    buzz_channel: assertString(
      input.buzz_channel,
      "config.buzz_channel",
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    ),
    repository: assertString(input.repository, "config.repository", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    base_branch: assertString(input.base_branch, "config.base_branch", /^[A-Za-z0-9._\/-]+$/),
    repo_dir: repoDir,
    state_dir: stateDir,
    inbox_dir: assertAbsolute(input.inbox_dir, "config.inbox_dir"),
    active_grant_file: assertAbsolute(input.active_grant_file, "config.active_grant_file"),
    control_file: assertAbsolute(input.control_file, "config.control_file"),
    artifact_checkout: assertAbsolute(input.artifact_checkout, "config.artifact_checkout"),
    production_pin_file: assertAbsolute(input.production_pin_file, "config.production_pin_file"),
    wrapper_dir: wrapperDir,
    wrapper_manifest_file: wrapperManifestFile,
    wrapper_git_sha: assertString(input.wrapper_git_sha, "config.wrapper_git_sha", /^[a-f0-9]{40}$/),
    bootstrap_base_git_sha: assertString(input.bootstrap_base_git_sha, "config.bootstrap_base_git_sha", /^[a-f0-9]{40}$/),
    candidate_version: assertString(
      input.candidate_version,
      "config.candidate_version",
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    ),
    frg_pack_manifest: assertAbsolute(input.frg_pack_manifest, "config.frg_pack_manifest"),
    frg_pack_manifest_sha256: assertString(
      input.frg_pack_manifest_sha256,
      "config.frg_pack_manifest_sha256",
      /^[a-f0-9]{64}$/,
    ),
    pipeline_loop_state_dir: assertAbsolute(input.pipeline_loop_state_dir, "config.pipeline_loop_state_dir"),
    frg_scorer_unit_template: input.frg_scorer_unit_template,
    frg_scorer_request_dir: frgScorerRequestDir,
    pipeline_command: Object.freeze(pipelineCommand),
    candidate_pipeline_command: Object.freeze(candidatePipelineCommand),
    frg_runner_command: Object.freeze(frgRunnerCommand),
    gh_command: assertAbsolute(input.gh_command, "config.gh_command"),
    git_command: assertAbsolute(input.git_command, "config.git_command"),
    node_command: nodeCommand,
    grok_command: assertAbsolute(input.grok_command, "config.grok_command"),
    systemd_run_command: assertAbsolute(input.systemd_run_command, "config.systemd_run_command"),
    systemctl_command: assertAbsolute(input.systemctl_command, "config.systemctl_command"),
    install_hosts: Object.freeze([...installHosts]),
    profile: assertString(input.profile, "config.profile", /^(codex|claude)$/),
    max_issues: assertInteger(input.max_issues, "config.max_issues", 1, 50),
    max_grant_seconds: assertInteger(input.max_grant_seconds, "config.max_grant_seconds", 60, 604800),
    event_clock_skew_seconds: assertInteger(
      input.event_clock_skew_seconds ?? 300,
      "config.event_clock_skew_seconds",
      0,
      3600,
    ),
    heartbeat_seconds: assertInteger(input.heartbeat_seconds ?? 900, "config.heartbeat_seconds", 60, 3600),
    command_timeout_seconds: assertInteger(
      input.command_timeout_seconds ?? 21600,
      "config.command_timeout_seconds",
      60,
      86400,
    ),
    publication_timeout_seconds: assertInteger(
      input.publication_timeout_seconds ?? 1800,
      "config.publication_timeout_seconds",
      60,
      7200,
    ),
    ci_timeout_seconds: assertInteger(input.ci_timeout_seconds ?? 900, "config.ci_timeout_seconds", 60, 3600),
    notification_command:
      notificationCommand == null ? null : Object.freeze(notificationCommand),
    secret_env_names: Object.freeze([...secretSet]),
    env_allowlists: envAllowlists,
  });
}
