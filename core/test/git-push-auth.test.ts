// Unit tests for configurable git-push auth (#980).
// No real network, git remotes, or secrets required — injectable deps only.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildHttpsTokenPushEnv,
  DEFAULT_GIT_PUSH_AUTH,
  formatPushAuthFailure,
  isNonAuthoritativeWorkflowScopeNoise,
  isWorkflowScopePushRejection,
  parseGitPushAuth,
  PIPELINE_GIT_PUSH_TOKEN_VALUE_ENV,
  prepareWorktreePushAuthEnv,
  rewriteOriginRemote,
  runConfiguredGitPush,
  runConfiguredGitPushSync,
  selectPushTransport,
  toHttpsRemoteUrl,
  type GitPushAuthDeps,
} from "../scripts/git-push-auth.ts";
import { buildPreflightChecks, type DoctorDeps } from "../scripts/stages/doctor.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

const SECRET = "ghp_TEST_SECRET_VALUE_NEVER_LOG_ME_980";

// ---------------------------------------------------------------------------
// Pure parse + transport selection
// ---------------------------------------------------------------------------

test("parseGitPushAuth: ssh", () => {
  assert.deepEqual(parseGitPushAuth("ssh"), { mechanism: "ssh" });
});

test("parseGitPushAuth: https-token with env name", () => {
  assert.deepEqual(parseGitPushAuth("https-token:GITHUB_PUSH_TOKEN"), {
    mechanism: "https-token",
    tokenEnv: "GITHUB_PUSH_TOKEN",
  });
});

test("parseGitPushAuth: rejects app", () => {
  assert.throws(() => parseGitPushAuth("app"), /git\.push_auth.*app|not implemented/i);
});

test("parseGitPushAuth: rejects empty https-token suffix", () => {
  assert.throws(() => parseGitPushAuth("https-token:"), /git\.push_auth/);
});

test("parseGitPushAuth: rejects malformed env name", () => {
  assert.throws(() => parseGitPushAuth("https-token:123-bad"), /git\.push_auth/);
  assert.throws(() => parseGitPushAuth("https-token:has-dash"), /git\.push_auth/);
});

test("parseGitPushAuth: rejects raw-token-looking full values", () => {
  assert.throws(() => parseGitPushAuth("ghp_abcdef"), /git\.push_auth/);
  assert.throws(() => parseGitPushAuth("https-token:ghp_abcdef"), /git\.push_auth|raw token/i);
});

test("selectPushTransport: maps mechanisms", () => {
  assert.deepEqual(selectPushTransport({ mechanism: "ssh" }), { transport: "ssh" });
  assert.deepEqual(
    selectPushTransport({ mechanism: "https-token", tokenEnv: "MY_PUSH_TOKEN" }),
    { transport: "https-token", tokenEnv: "MY_PUSH_TOKEN" },
  );
});

test("toHttpsRemoteUrl: scp and https forms", () => {
  assert.equal(
    toHttpsRemoteUrl("git@github.com:owner/repo.git"),
    "https://github.com/owner/repo.git",
  );
  assert.equal(
    toHttpsRemoteUrl("https://github.com/owner/repo.git"),
    "https://github.com/owner/repo.git",
  );
  assert.equal(
    toHttpsRemoteUrl("https://x-access-token:SECRET@github.com/owner/repo.git"),
    "https://github.com/owner/repo.git",
  );
});

test("rewriteOriginRemote: only exact origin tokens", () => {
  assert.deepEqual(
    rewriteOriginRemote(["push", "-u", "origin", "branch"], "git@gh:o/r.git"),
    ["push", "-u", "git@gh:o/r.git", "branch"],
  );
});

// ---------------------------------------------------------------------------
// Failure formatting (never secret)
// ---------------------------------------------------------------------------

const WORKFLOW_STDERR =
  "remote: refusing to allow a Personal Access Token to create or update workflow " +
  "`.github/workflows/ci.yml` without `workflow` scope";

test("isWorkflowScopePushRejection: detects GitHub refusal", () => {
  assert.equal(isWorkflowScopePushRejection(WORKFLOW_STDERR), true);
  assert.equal(isWorkflowScopePushRejection("network unreachable"), false);
});

test("formatPushAuthFailure: https-token workflow scope names env, not secret", () => {
  const msg = formatPushAuthFailure(
    { mechanism: "https-token", tokenEnv: "GITHUB_PUSH_TOKEN" },
    WORKFLOW_STDERR,
  );
  assert.match(msg, /https-token/);
  assert.match(msg, /GITHUB_PUSH_TOKEN/);
  assert.match(msg, /workflow/i);
  assert.doesNotMatch(msg, new RegExp(SECRET));
  assert.doesNotMatch(msg, /ghp_/);
});

test("formatPushAuthFailure: missing env pre-git", () => {
  const msg = formatPushAuthFailure(
    { mechanism: "https-token", tokenEnv: "GITHUB_PUSH_TOKEN" },
    "GITHUB_PUSH_TOKEN is unset or empty",
    { phase: "pre-git" },
  );
  assert.match(msg, /GITHUB_PUSH_TOKEN/);
  assert.match(msg, /unset or empty/i);
});

test("isNonAuthoritativeWorkflowScopeNoise: only when ssh + authoritative ok", () => {
  assert.equal(
    isNonAuthoritativeWorkflowScopeNoise(WORKFLOW_STDERR, {
      auth: { mechanism: "ssh" },
      authoritativePushSucceeded: true,
    }),
    true,
  );
  assert.equal(
    isNonAuthoritativeWorkflowScopeNoise(WORKFLOW_STDERR, {
      auth: { mechanism: "ssh" },
      authoritativePushSucceeded: false,
    }),
    false,
  );
  assert.equal(
    isNonAuthoritativeWorkflowScopeNoise(WORKFLOW_STDERR, {
      auth: { mechanism: "https-token", tokenEnv: "T" },
      authoritativePushSucceeded: true,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Execution seam (injectable git/env)
// ---------------------------------------------------------------------------

test("runConfiguredGitPush: ssh uses pushurl endpoint, no PAT in argv", async () => {
  const recorded: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const deps: GitPushAuthDeps = {
    env: { PATH: "/usr/bin" },
    gitConfigGet: async (_cwd, key) => {
      if (key === "remote.origin.pushurl") return "git@github.com:owner/repo.git";
      if (key === "remote.origin.url") return "https://github.com/owner/repo.git";
      return null;
    },
    gitExec: async ({ args, env }) => {
      recorded.push({ args, env });
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  const res = await runConfiguredGitPush({
    cwd: "/tmp/wt",
    auth: { mechanism: "ssh" },
    args: ["push", "-u", "origin", "pipeline/1-x"],
    deps,
  });
  assert.equal(res.code, 0);
  assert.deepEqual(recorded[0].args, ["push", "-u", "git@github.com:owner/repo.git", "pipeline/1-x"]);
  assert.equal(recorded[0].env[PIPELINE_GIT_PUSH_TOKEN_VALUE_ENV], undefined);
});

test("runConfiguredGitPush: ssh rejects HTTPS origin/pushurl pre-git (no silent HTTPS)", async () => {
  let gitCalled = false;
  const res = await runConfiguredGitPush({
    cwd: "/tmp/wt",
    auth: { mechanism: "ssh" },
    args: ["push", "-u", "origin", "pipeline/1-x"],
    deps: {
      env: { PATH: "/usr/bin" },
      gitConfigGet: async (_cwd, key) => {
        if (key === "remote.origin.pushurl") return null;
        if (key === "remote.origin.url") return "https://github.com/owner/repo.git";
        return null;
      },
      gitExec: async () => {
        gitCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(res.code, 1);
  assert.equal(gitCalled, false, "must not invoke git when remote is HTTPS under ssh");
  assert.match(res.errorMessage ?? "", /mechanism=ssh/);
  assert.match(res.errorMessage ?? "", /SSH endpoint|ssh:\/\//i);
  assert.match(res.errorMessage ?? "", /https:\/\/github\.com\/owner\/repo\.git/);
  assert.match(res.errorMessage ?? "", /https-token/);
});

test("runConfiguredGitPush: ssh with unset origin falls back to remote name origin", async () => {
  const recorded: string[][] = [];
  const res = await runConfiguredGitPush({
    cwd: "/tmp/wt",
    auth: { mechanism: "ssh" },
    args: ["push", "origin", "b"],
    deps: {
      env: { PATH: "/usr/bin" },
      gitConfigGet: async () => null,
      gitExec: async ({ args }) => {
        recorded.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(res.code, 0);
  assert.deepEqual(recorded[0], ["push", "origin", "b"]);
  assert.equal(res.endpoint, "origin");
});

test("runConfiguredGitPushSync: ssh rejects HTTPS origin pre-git", () => {
  let gitCalled = false;
  const res = runConfiguredGitPushSync({
    cwd: "/tmp/wt",
    auth: { mechanism: "ssh" },
    args: ["push", "origin", "b"],
    deps: {
      gitConfigGetSync: () => "https://github.com/o/r.git",
      gitExecSync: () => {
        gitCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(res.code, 1);
  assert.equal(gitCalled, false);
  assert.match(res.errorMessage ?? "", /mechanism=ssh/);
  assert.match(res.errorMessage ?? "", /https:\/\/github\.com\/o\/r\.git/);
});

test("runConfiguredGitPush: https-token missing env fails pre-git", async () => {
  let gitCalled = false;
  const res = await runConfiguredGitPush({
    cwd: "/tmp/wt",
    auth: { mechanism: "https-token", tokenEnv: "GITHUB_PUSH_TOKEN" },
    args: ["push", "origin", "b"],
    deps: {
      env: { PATH: "/usr/bin" }, // token absent
      gitExec: async () => {
        gitCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(res.code, 1);
  assert.equal(gitCalled, false, "must not invoke git when env is missing");
  assert.match(res.errorMessage ?? "", /GITHUB_PUSH_TOKEN/);
  assert.doesNotMatch(res.errorMessage ?? "", new RegExp(SECRET));
});

test("runConfiguredGitPush: https-token sets askpass env and disables helper; secret not in argv", async () => {
  const recorded: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  let askpassPath = "";
  const res = await runConfiguredGitPush({
    cwd: "/tmp/wt",
    auth: { mechanism: "https-token", tokenEnv: "GITHUB_PUSH_TOKEN" },
    args: ["push", "origin", "b"],
    deps: {
      env: { PATH: "/usr/bin", GITHUB_PUSH_TOKEN: SECRET },
      gitConfigGet: async () => "git@github.com:owner/repo.git",
      writeAskpassScript: (body) => {
        assert.match(body, new RegExp(PIPELINE_GIT_PUSH_TOKEN_VALUE_ENV));
        askpassPath = "/tmp/fake-askpass-980.sh";
        return askpassPath;
      },
      cleanupAskpassScript: () => {},
      gitExec: async ({ args, env }) => {
        recorded.push({ args, env });
        return {
          code: 1,
          stdout: "",
          stderr: WORKFLOW_STDERR,
        };
      },
    },
  });
  assert.equal(res.code, 1);
  assert.equal(recorded.length, 1);
  const { args, env } = recorded[0];
  assert.ok(args.includes("-c") && args.includes("credential.helper="));
  assert.ok(args.some((a) => a.startsWith("https://github.com/")));
  assert.ok(!args.some((a) => a.includes(SECRET)), "token must not appear in argv");
  assert.equal(env.GIT_ASKPASS, askpassPath);
  assert.equal(env[PIPELINE_GIT_PUSH_TOKEN_VALUE_ENV], SECRET);
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
  assert.match(res.errorMessage ?? "", /GITHUB_PUSH_TOKEN/);
  assert.match(res.errorMessage ?? "", /workflow/i);
  assert.doesNotMatch(res.errorMessage ?? "", new RegExp(SECRET));
});

test("runConfiguredGitPushSync: ssh path", () => {
  const res = runConfiguredGitPushSync({
    cwd: "/tmp/wt",
    auth: DEFAULT_GIT_PUSH_AUTH,
    args: ["push", "origin", "b"],
    deps: {
      gitConfigGetSync: (_cwd, key) =>
        key === "remote.origin.url" ? "git@github.com:o/r.git" : null,
      gitExecSync: ({ args }) => {
        assert.deepEqual(args, ["push", "git@github.com:o/r.git", "b"]);
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });
  assert.equal(res.code, 0);
});

test("buildHttpsTokenPushEnv: disables ambient helper", () => {
  const env = buildHttpsTokenPushEnv({ PATH: "/bin" }, SECRET, "/tmp/askpass");
  assert.equal(env.GIT_ASKPASS, "/tmp/askpass");
  assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
  assert.equal(env[PIPELINE_GIT_PUSH_TOKEN_VALUE_ENV], SECRET);
});

test("prepareWorktreePushAuthEnv: ssh marks mechanism", () => {
  const env = prepareWorktreePushAuthEnv({ mechanism: "ssh" }, { PATH: "/bin" });
  assert.equal(env.PIPELINE_GIT_PUSH_AUTH, "ssh");
});

// ---------------------------------------------------------------------------
// Config round-trip via resolveConfig
// ---------------------------------------------------------------------------

function makeFakeRepo(content: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-git-auth-cfg-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (content !== null) {
    fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "pipeline.yml"), content);
  }
  return dir;
}

function makeFakeGh(repoSlug: string): string {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-git-auth-bin-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env bash\necho "${repoSlug}"\n`);
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

test("resolveConfig: absent git defaults to structured ssh", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/widget");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const { resolveConfig } = await import(`../scripts/config.ts?git-auth-absent=${Date.now()}`);
    const cfg = resolveConfig({ repoPath: repo });
    assert.deepEqual(cfg.git.push_auth, { mechanism: "ssh" });
    assert.deepEqual(selectPushTransport(cfg.git.push_auth), { transport: "ssh" });
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: explicit ssh and https-token round-trip", async () => {
  const oldPath = process.env.PATH;
  try {
    {
      const repo = makeFakeRepo("git:\n  push_auth: ssh\n");
      const binDir = makeFakeGh("acme/ssh");
      process.env.PATH = `${binDir}:${oldPath}`;
      const mod = await import(`../scripts/config.ts?git-auth-ssh=${Date.now()}`);
      const cfg = mod.resolveConfig({ repoPath: repo });
      assert.deepEqual(cfg.git.push_auth, { mechanism: "ssh" });
    }
    {
      const repo = makeFakeRepo("git:\n  push_auth: https-token:GITHUB_PUSH_TOKEN\n");
      const binDir = makeFakeGh("acme/https");
      process.env.PATH = `${binDir}:${oldPath}`;
      const mod = await import(`../scripts/config.ts?git-auth-https=${Date.now()}`);
      const cfg = mod.resolveConfig({ repoPath: repo });
      assert.deepEqual(cfg.git.push_auth, {
        mechanism: "https-token",
        tokenEnv: "GITHUB_PUSH_TOKEN",
      });
      // Resolved config must not hold the secret even if env is set.
      assert.equal(
        JSON.stringify(cfg.git).includes(SECRET),
        false,
      );
      assert.deepEqual(selectPushTransport(cfg.git.push_auth), {
        transport: "https-token",
        tokenEnv: "GITHUB_PUSH_TOKEN",
      });
    }
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: rejects app, unknown git keys, invalid push_auth", async () => {
  const oldPath = process.env.PATH;
  try {
    for (const [label, yml, re] of [
      ["app", "git:\n  push_auth: app\n", /git\.push_auth|app/i],
      ["empty https", 'git:\n  push_auth: "https-token:"\n', /git\.push_auth/i],
      ["unknown key", "git:\n  force_https: true\n", /unrecognized|force_https|git/i],
      ["literal token", "git:\n  push_auth: ghp_not_a_real_token\n", /git\.push_auth/i],
    ] as const) {
      const repo = makeFakeRepo(yml);
      const binDir = makeFakeGh(`acme/${label}`);
      process.env.PATH = `${binDir}:${oldPath}`;
      const mod = await import(`../scripts/config.ts?git-auth-rej-${label}=${Date.now()}`);
      assert.throws(() => mod.resolveConfig({ repoPath: repo }), re, label);
    }
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// Doctor preflight (injectable deps; no network push)
// ---------------------------------------------------------------------------

function minimalDoctorConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    ...(DEFAULT_CONFIG as PipelineConfig),
    profile_name: "claude",
    invocation: "pipeline",
    review_mode: "prompt-harness",
    marker_footer: "",
    implementation_ready_message: "",
    conventions_default: "",
    domain: "test",
    repo: "acme/widget",
    repo_dir: "/tmp/repo",
    harnesses: {
      implementer: "codex",
      reviewer: "claude",
      implementerSource: "profile",
      reviewerSource: "profile",
    },
    git: { push_auth: { mechanism: "ssh" } },
    ...overrides,
  };
}

function emptyDoctorDeps(): DoctorDeps {
  return {
    exec: async () => ({ ok: true, stdout: "", stderr: "" }),
    execCheck: async () => true,
    fsExists: async () => true,
    fileMtime: async () => null,
    readTextFile: async () => null,
    listDirNames: async () => [],
    isWritable: async () => true,
    listPipelineLocks: async () => [],
    isPidLive: async () => false,
    claimStaleLockFile: async () => null,
    restoreClaimedLockFile: async () => {},
    discardClaimedLockFile: async () => {},
  };
}

test("doctor: git-push-auth passes for ssh", async () => {
  const checks = buildPreflightChecks(minimalDoctorConfig(), "1.0.0");
  const check = checks.find((c) => c.id === "git-push-auth");
  assert.ok(check, "git-push-auth check must be registered");
  const result = await check!.run(emptyDoctorDeps());
  assert.equal(result.status, "pass");
  assert.match(result.detail, /ssh/i);
});

test("doctor: https-token missing env fails naming env only", async () => {
  const prev = process.env.GITHUB_PUSH_TOKEN;
  delete process.env.GITHUB_PUSH_TOKEN;
  try {
    const checks = buildPreflightChecks(
      minimalDoctorConfig({
        git: { push_auth: { mechanism: "https-token", tokenEnv: "GITHUB_PUSH_TOKEN" } },
      }),
      "1.0.0",
    );
    const check = checks.find((c) => c.id === "git-push-auth")!;
    const result = await check.run(emptyDoctorDeps());
    assert.equal(result.status, "fail");
    assert.match(result.detail, /GITHUB_PUSH_TOKEN/);
    assert.doesNotMatch(result.detail, new RegExp(SECRET));
    assert.doesNotMatch(result.remediation ?? "", new RegExp(SECRET));
  } finally {
    if (prev !== undefined) process.env.GITHUB_PUSH_TOKEN = prev;
  }
});

test("doctor: https-token present env passes without printing secret", async () => {
  const prev = process.env.GITHUB_PUSH_TOKEN;
  process.env.GITHUB_PUSH_TOKEN = SECRET;
  try {
    const checks = buildPreflightChecks(
      minimalDoctorConfig({
        git: { push_auth: { mechanism: "https-token", tokenEnv: "GITHUB_PUSH_TOKEN" } },
      }),
      "1.0.0",
    );
    const check = checks.find((c) => c.id === "git-push-auth")!;
    const result = await check.run(emptyDoctorDeps());
    assert.equal(result.status, "pass");
    assert.match(result.detail, /GITHUB_PUSH_TOKEN/);
    assert.doesNotMatch(result.detail, new RegExp(SECRET));
  } finally {
    if (prev === undefined) delete process.env.GITHUB_PUSH_TOKEN;
    else process.env.GITHUB_PUSH_TOKEN = prev;
  }
});

// ---------------------------------------------------------------------------
// Harness false-block regression (classification guard)
// ---------------------------------------------------------------------------

test("regression: ssh + authoritative success is not push-failed from harness workflow noise", () => {
  // Simulate: engine SSH push succeeded; harness log still contains HTTPS workflow refusal.
  const harnessNoise = `To https://github.com/acme/widget.git\n ! [remote rejected] ${WORKFLOW_STDERR}`;
  const authoritativeOk = true;
  const auth = { mechanism: "ssh" as const };
  const shouldBlock = !isNonAuthoritativeWorkflowScopeNoise(harnessNoise, {
    auth,
    authoritativePushSucceeded: authoritativeOk,
  });
  // Guard returns true for noise → we must NOT treat as sole push-failed cause.
  assert.equal(
    isNonAuthoritativeWorkflowScopeNoise(harnessNoise, {
      auth,
      authoritativePushSucceeded: authoritativeOk,
    }),
    true,
  );
  assert.equal(shouldBlock, false);
});
