import { GRANT_ACTIONS, validateGrantEnvelope } from "../lib/grant.mjs";
import { JournalStore } from "../lib/journal.mjs";

export const NOW = new Date("2026-08-08T12:00:00.000Z");
export const EVENT_SECONDS = 1786190400;
export const OPERATOR = "a".repeat(64);
export const MESSAGE = "b".repeat(64);
export const CHANNEL = "11111111-2222-3333-4444-555555555555";

export function config(overrides = {}) {
  return {
    schema_version: 1,
    enabled: true,
    operator_pubkey: OPERATOR,
    buzz_channel: CHANNEL,
    repository: "owner/repo",
    base_branch: "main",
    repo_dir: "/repo",
    state_dir: "/state",
    inbox_dir: "/state/inbox",
    active_grant_file: "/state/active-grant.json",
    control_file: "/state/control.json",
    artifact_checkout: "/artifact",
    production_pin_file: "/state/production-engine.json",
    wrapper_dir: "/factory",
    wrapper_manifest_file: "/factory/pinned-artifacts.json",
    wrapper_git_sha: "c".repeat(40),
    bootstrap_base_git_sha: "d".repeat(40),
    candidate_version: "1.32.0",
    frg_pack_manifest: "/repo/core/scripts/frg-packs/factory-gate-v1/manifest.json",
    frg_pack_manifest_sha256: "e".repeat(64),
    pipeline_loop_state_dir: "/state/agent-pipeline/loop/runs",
    frg_scorer_unit_template: "hermes-factory-frg@.service",
    frg_scorer_request_dir: "/state/frg-scorer-requests",
    pipeline_command: ["/usr/bin/node", "/home/user/.codex/skills/pipeline/scripts/pipeline.mjs"],
    candidate_pipeline_command: ["/usr/bin/node", "--experimental-strip-types", "/repo/core/scripts/pipeline.ts"],
    frg_runner_command: ["/usr/bin/node", "/factory/lib/frg-runner.mjs"],
    gh_command: "/usr/bin/gh",
    git_command: "/usr/bin/git",
    node_command: "/usr/bin/node",
    grok_command: "/home/user/.local/bin/grok",
    systemd_run_command: "/usr/bin/systemd-run",
    systemctl_command: "/usr/bin/systemctl",
    install_hosts: ["codex"],
    profile: "codex",
    max_issues: 10,
    max_grant_seconds: 86400,
    event_clock_skew_seconds: 300,
    heartbeat_seconds: 900,
    command_timeout_seconds: 21600,
    publication_timeout_seconds: 1800,
    ci_timeout_seconds: 900,
    notification_command: [
      "/home/user/.local/opt/hermes-agent-v2026.8.3/venv/bin/python",
      "-m", "hermes_cli.main", "-p", "pipeline-factory", "send", "--to",
      "buzz:{chat_id}:{thread_id}", "--file", "-", "--quiet",
    ],
    secret_env_names: [
      "PIPELINE_FACTORY_SECRET_CANARY",
    ],
    env_allowlists: {
      common: ["PATH", "HOME", "LANG"],
      pipeline: ["GH_TOKEN"],
      github: ["GH_TOKEN"],
      git: ["GIT_SSH_COMMAND"],
      model_probe: [],
      notification: [],
      frg_runner: ["GH_TOKEN"],
      install: [],
      systemd: [],
    },
    ...overrides,
  };
}

export function envelope(overrides = {}) {
  const auth = {
    adapter: "hermes-native-buzz",
    chat_id: CHANNEL,
    user_id: OPERATOR,
    message_id: MESSAGE,
    thread_id: MESSAGE,
    created_at: EVENT_SECONDS,
    ...(overrides.auth ?? {}),
  };
  const grant = {
    schema_version: 1,
    kind: "release_grant",
    nonce: "release-1.32.1-run-001",
    repository: "owner/repo",
    base_branch: "main",
    release_version: "1.32.1",
    milestone: "v1.32.1",
    ordered_issues: [905, 874, 870],
    actions: [...GRANT_ACTIONS],
    model: "grok-4.5",
    issue_limit: 3,
    issued_at: NOW.toISOString(),
    expires_at: "2026-08-09T12:00:00.000Z",
    ...(overrides.grant ?? {}),
  };
  return { auth, grant };
}

export function validated(configOverrides = {}, envelopeOverrides = {}) {
  return validateGrantEnvelope(envelope(envelopeOverrides), config(configOverrides), { now: () => NOW });
}

export function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    deps: {
      async readFile(path) {
        if (!files.has(path)) {
          const error = new Error(`missing ${path}`);
          error.code = "ENOENT";
          throw error;
        }
        return files.get(path);
      },
      async writeFile(path, body, options = {}) {
        if (options?.flag === "wx" && files.has(path)) {
          const error = new Error(`exists ${path}`);
          error.code = "EEXIST";
          throw error;
        }
        files.set(path, String(body));
      },
      async rename(from, to) {
        if (!files.has(from)) throw new Error(`missing temp ${from}`);
        files.set(to, files.get(from));
        files.delete(from);
      },
      async mkdir() {},
      async open(path, flags) {
        if (flags === "wx" && files.has(path)) {
          const error = new Error(`exists ${path}`);
          error.code = "EEXIST";
          throw error;
        }
        files.set(path, "");
        let closed = false;
        return {
          async writeFile(body) {
            if (closed) throw new Error("file is closed");
            files.set(path, String(body));
          },
          async sync() {},
          async close() { closed = true; },
        };
      },
      async link(from, to) {
        if (!files.has(from)) {
          const error = new Error(`missing ${from}`);
          error.code = "ENOENT";
          throw error;
        }
        if (files.has(to)) {
          const error = new Error(`exists ${to}`);
          error.code = "EEXIST";
          throw error;
        }
        files.set(to, files.get(from));
      },
      async syncDirectory() {},
      async unlink(path) {
        if (!files.delete(path)) {
          const error = new Error(`missing ${path}`);
          error.code = "ENOENT";
          throw error;
        }
      },
    },
  };
}

export function testLockDeps(token = "test-owner") {
  const owner = {
    schema_version: 1,
    host: "test-host",
    boot_id: "test-boot",
    pid: 1,
    process_start: "test-start",
    token,
  };
  return {
    owner: async () => owner,
    status: async (value) => value?.host === owner.host && value?.boot_id === owner.boot_id &&
      value?.pid === owner.pid && value?.process_start === owner.process_start ? "alive" : "dead",
  };
}

export async function admittedJournal(configOverrides = {}, envelopeOverrides = {}) {
  const fs = memoryFs();
  const store = new JournalStore({
    stateDir: "/state",
    fsDeps: fs.deps,
    now: () => NOW,
    random: () => "fixed",
    lockDeps: testLockDeps(),
  });
  const grant = validated(configOverrides, envelopeOverrides);
  const journal = await store.admit(grant);
  return { fs, store, grant, journal };
}

export const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", signal: null, stopped: null });
export const fail = (stderr = "failed") => ({ code: 1, stdout: "", stderr, signal: null, stopped: null });
