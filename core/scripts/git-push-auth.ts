// Configurable git-push authentication (#980).
//
// Operators select a single push-auth mechanism via `git.push_auth` in
// `.github/pipeline.yml`. Default is SSH (worktree origin / pushurl). Opt-in
// HTTPS-token mode authenticates with a token from a named env var — never a
// literal secret stored in config. Every authoritative pipeline-owned push
// routes through {@link runConfiguredGitPush} so ambient `gh auth git-credential`
// cannot silently win and false-block workflow-file deliveries.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import type { GitPushAuth } from "./types.ts";

const execFileAsync = promisify(execFileCb);

export type { GitPushAuth };

/** Pure transport selection result (no I/O). */
export type PushTransport =
  | { transport: "ssh" }
  | { transport: "https-token"; tokenEnv: string };

/** Env-var name grammar for `https-token:<ENV>` (matches config schema). */
export const GIT_PUSH_TOKEN_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Private child-env key for the token value — never written to durable config. */
export const PIPELINE_GIT_PUSH_TOKEN_VALUE_ENV = "PIPELINE_GIT_PUSH_TOKEN_VALUE";

/** Marker env so harnesses / diagnostics can see the configured mechanism. */
export const PIPELINE_GIT_PUSH_AUTH_ENV = "PIPELINE_GIT_PUSH_AUTH";

const HTTPS_TOKEN_PREFIX = "https-token:";

/** Known GitHub workflow-scope refusal text fragments (case-insensitive match). */
const WORKFLOW_SCOPE_MARKERS = [
  "without `workflow` scope",
  "without 'workflow' scope",
  "without workflow scope",
  "refusing to allow a personal access token to create or update workflow",
  "refusing to allow a personal access token to create or update workflow file",
];

export class GitPushAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitPushAuthConfigError";
  }
}

/**
 * Parse a raw `git.push_auth` string into structured form.
 * Rejects `app`, empty/malformed env names, and unrecognized forms.
 * Never accepts or stores a raw token value.
 */
export function parseGitPushAuth(raw: string): GitPushAuth {
  const value = raw.trim();
  if (value === "ssh") return { mechanism: "ssh" };
  if (value === "app") {
    throw new GitPushAuthConfigError(
      'git.push_auth: "app" is reserved for a future GitHub App installation-token path and is not implemented — use "ssh" (default) or "https-token:<ENV_NAME>"',
    );
  }
  if (value.startsWith(HTTPS_TOKEN_PREFIX)) {
    const tokenEnv = value.slice(HTTPS_TOKEN_PREFIX.length);
    if (!tokenEnv) {
      throw new GitPushAuthConfigError(
        'git.push_auth: "https-token:" requires a non-empty environment-variable name (e.g. https-token:GITHUB_PUSH_TOKEN)',
      );
    }
    if (!GIT_PUSH_TOKEN_ENV_NAME_RE.test(tokenEnv)) {
      throw new GitPushAuthConfigError(
        `git.push_auth: invalid env-var name after https-token: — expected ^[A-Za-z_][A-Za-z0-9_]*$, got ${JSON.stringify(tokenEnv)}`,
      );
    }
    // Reject values that look like a raw token stuffed into the env-name slot.
    if (/^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)/i.test(tokenEnv)) {
      throw new GitPushAuthConfigError(
        "git.push_auth: env-var name must not look like a raw token value — configure https-token:<ENV_NAME> and put the secret in the environment",
      );
    }
    return { mechanism: "https-token", tokenEnv };
  }
  // Anything else (including raw-token-looking full values) is invalid.
  throw new GitPushAuthConfigError(
    `git.push_auth: unrecognized value ${JSON.stringify(value)} — admitted forms are "ssh" and "https-token:<ENV_NAME>" (env-var name only; never a literal secret)`,
  );
}

/** Pure: map structured auth to a transport selection. */
export function selectPushTransport(auth: GitPushAuth): PushTransport {
  if (auth.mechanism === "ssh") return { transport: "ssh" };
  return { transport: "https-token", tokenEnv: auth.tokenEnv };
}

/** True when stderr indicates GitHub refused a PAT for missing workflow scope. */
export function isWorkflowScopePushRejection(stderr: string): boolean {
  const s = stderr.toLowerCase();
  if (!s.includes("workflow")) return false;
  return WORKFLOW_SCOPE_MARKERS.some((m) => s.includes(m.toLowerCase()))
    || (s.includes("personal access token") && s.includes("workflow") && s.includes("refusing"));
}

/**
 * Build an operator-visible push failure message. Never includes secret values —
 * only mechanism identity and, for https-token, the env-var **name**.
 */
export function formatPushAuthFailure(
  auth: GitPushAuth,
  stderr: string,
  opts?: { phase?: "pre-git" | "git" },
): string {
  const mechanism = auth.mechanism;
  const envName = auth.mechanism === "https-token" ? auth.tokenEnv : undefined;
  const trimmed = stderr.trim();

  if (opts?.phase === "pre-git" || /unset or empty/i.test(trimmed)) {
    if (envName) {
      return (
        `Git push failed (mechanism=https-token, env=${envName}): ` +
        `environment variable ${envName} is unset or empty — set it to a token with the required scopes before pushing`
      );
    }
    return `Git push failed (mechanism=${mechanism}): ${trimmed || "configuration error before git ran"}`;
  }

  if (isWorkflowScopePushRejection(trimmed)) {
    if (envName) {
      return (
        `Git push failed (mechanism=https-token, env=${envName}): ` +
        `GitHub refused the token because it lacks the \`workflow\` scope required to create or update files under .github/workflows/. ` +
        `Grant \`workflow\` on the token in ${envName}, or switch to git.push_auth: ssh (deploy key / SSH agent; no workflow scope required).`
      );
    }
    return (
      `Git push failed (mechanism=ssh): received a GitHub HTTPS workflow-scope refusal while push-auth is ssh — ` +
      `the push likely used an HTTPS/PAT path instead of the worktree SSH origin/pushurl. ` +
      `Check remote.origin.url / remote.origin.pushurl and do not reconfigure origin to ambient gh HTTPS credentials. ` +
      `Original: ${sanitizePushErrorText(trimmed)}`
    );
  }

  const envPart = envName ? `, env=${envName}` : "";
  return `Git push failed (mechanism=${mechanism}${envPart}): ${sanitizePushErrorText(trimmed) || "push failed"}`;
}

/** Strip credential-like substrings from stderr before surfacing. */
export function sanitizePushErrorText(text: string): string {
  return text
    .replace(/https:\/\/[^/\s:]+:[^@\s]+@/gi, "https://[REDACTED]@")
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[REDACTED]");
}

// ---------------------------------------------------------------------------
// URL / endpoint helpers
// ---------------------------------------------------------------------------

/** Convert an SSH or HTTPS git remote URL to a plain HTTPS URL (no credentials). */
export function toHttpsRemoteUrl(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  // https://[user[:pass]@]host/path
  const https = u.match(/^https?:\/\/(?:[^@/\s]+@)?([^/\s]+)(\/.*)?$/i);
  if (https) {
    const host = https[1];
    let p = https[2] ?? "";
    if (p.endsWith("/")) p = p.slice(0, -1);
    if (!p.endsWith(".git") && p.length > 1) {
      // keep as-is; many remotes omit .git
    }
    return `https://${host}${p || ""}`;
  }
  // git@host:path
  const scp = u.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    let p = scp[2];
    if (!p.startsWith("/")) p = `/${p}`;
    return `https://${scp[1]}${p}`;
  }
  // ssh://git@host/path
  const ssh = u.match(/^ssh:\/\/(?:git@)?([^/]+)(\/.*)$/i);
  if (ssh) {
    return `https://${ssh[1]}${ssh[2]}`;
  }
  return null;
}

/** Whether a remote URL is an SSH form (scp-like or ssh://). */
export function isSshRemoteUrl(url: string): boolean {
  const u = url.trim();
  return /^git@[^:]+:/.test(u) || /^ssh:\/\//i.test(u);
}

// ---------------------------------------------------------------------------
// Invocation building + execution
// ---------------------------------------------------------------------------

export interface GitPushAuthExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitPushAuthDeps {
  /** Process env (defaults to process.env). Used for token lookup only by name. */
  env?: NodeJS.ProcessEnv;
  /**
   * Run git with the given args and env. Defaults to a real git subprocess.
   * Tests inject fakes — no network.
   */
  gitExec?: (opts: {
    cwd: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  }) => Promise<GitPushAuthExecResult>;
  /** Sync git exec for sync call sites. */
  gitExecSync?: (opts: {
    cwd: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  }) => GitPushAuthExecResult;
  /** Read a single git config key (null when unset). */
  gitConfigGet?: (cwd: string, key: string) => Promise<string | null>;
  gitConfigGetSync?: (cwd: string, key: string) => string | null;
  /** Write an askpass helper script; returns absolute path. */
  writeAskpassScript?: (scriptBody: string) => string;
  /** Cleanup askpass script after push. */
  cleanupAskpassScript?: (scriptPath: string) => void;
}

export interface RunConfiguredGitPushOpts {
  cwd: string;
  /**
   * Full `git` argv starting with `"push"` (e.g. `["push", "-u", "origin", branch]`).
   * The remote name `"origin"` is rewritten to the resolved endpoint when needed.
   */
  args: string[];
  auth: GitPushAuth;
  deps?: GitPushAuthDeps;
}

export interface RunConfiguredGitPushResult extends GitPushAuthExecResult {
  /** Operator-facing failure message when code !== 0 (or pre-git failure). */
  errorMessage?: string;
  /** Resolved push endpoint used (URL or "origin"). Never includes a token. */
  endpoint?: string;
  /** Args actually passed to git (token never present). */
  recordedArgs?: string[];
}

function defaultGitConfigGetSync(cwd: string, key: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "config", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const v = out.trim();
    return v || null;
  } catch {
    return null;
  }
}

async function defaultGitConfigGet(cwd: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "config", "--get", key], {
      encoding: "utf8",
    });
    const v = (stdout ?? "").trim();
    return v || null;
  } catch {
    return null;
  }
}

function defaultWriteAskpass(scriptBody: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-git-askpass-"));
  const scriptPath = path.join(dir, "askpass.sh");
  fs.writeFileSync(scriptPath, scriptBody, { mode: 0o700 });
  return scriptPath;
}

function defaultCleanupAskpass(scriptPath: string): void {
  try {
    fs.unlinkSync(scriptPath);
    fs.rmdirSync(path.dirname(scriptPath));
  } catch {
    // best-effort
  }
}

async function defaultGitExec(opts: {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): Promise<GitPushAuthExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120_000,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: (e.stdout ?? "").toString(),
      stderr: (e.stderr ?? e.message ?? "").toString(),
    };
  }
}

function defaultGitExecSync(opts: {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): GitPushAuthExecResult {
  const r = spawnSync("git", opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? r.error?.message ?? "",
  };
}

/**
 * Resolve the worktree push endpoint for SSH: pushurl first, else origin URL.
 * Returns null when neither is set (caller falls back to remote name "origin").
 */
export async function resolveSshPushEndpoint(
  cwd: string,
  deps: GitPushAuthDeps = {},
): Promise<string | null> {
  const get = deps.gitConfigGet ?? defaultGitConfigGet;
  const pushurl = await get(cwd, "remote.origin.pushurl");
  if (pushurl) return pushurl;
  return get(cwd, "remote.origin.url");
}

export function resolveSshPushEndpointSync(
  cwd: string,
  deps: GitPushAuthDeps = {},
): string | null {
  const get = deps.gitConfigGetSync ?? defaultGitConfigGetSync;
  const pushurl = get(cwd, "remote.origin.pushurl");
  if (pushurl) return pushurl;
  return get(cwd, "remote.origin.url");
}

/** Rewrite exact `"origin"` tokens in push args to a concrete endpoint URL. */
export function rewriteOriginRemote(args: string[], endpoint: string): string[] {
  return args.map((a) => (a === "origin" ? endpoint : a));
}

function askpassScriptBody(): string {
  // Username prompt → x-access-token; password/token prompt → private env value.
  // Never print anything except the credential response.
  return `#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s\\n' "x-access-token" ;;
  *) printf '%s\\n' "\${${PIPELINE_GIT_PUSH_TOKEN_VALUE_ENV}}" ;;
esac
`;
}

/**
 * Build child env for an HTTPS-token push so ambient `gh auth git-credential`
 * does not win. Token value is only in {@link PIPELINE_GIT_PUSH_TOKEN_VALUE_ENV}.
 */
export function buildHttpsTokenPushEnv(
  baseEnv: NodeJS.ProcessEnv,
  token: string,
  askpassPath: string,
): NodeJS.ProcessEnv {
  // Disable ambient credential helpers for this child via GIT_CONFIG_* overrides.
  // GIT_CONFIG_COUNT keys override system/global/local for the process.
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpassPath,
    // Empty helper so gh/osxkeychain/etc. do not supply a different PAT.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    // Private; consumed only by askpass. Not a durable config key.
    [PIPELINE_GIT_PUSH_TOKEN_VALUE_ENV]: token,
    // Discourage GUI credential prompts.
    GCM_INTERACTIVE: "Never",
  };
}

/** Env fragment for harness children so they inherit the same push-auth intent. */
export function prepareWorktreePushAuthEnv(
  auth: GitPushAuth,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const transport = selectPushTransport(auth);
  if (transport.transport === "ssh") {
    return {
      ...baseEnv,
      [PIPELINE_GIT_PUSH_AUTH_ENV]: "ssh",
      // Prefer not prompting; SSH uses agent/keys already on the worktree.
      GIT_TERMINAL_PROMPT: baseEnv.GIT_TERMINAL_PROMPT ?? "0",
    };
  }
  const token = (baseEnv[transport.tokenEnv] ?? "").trim();
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    [PIPELINE_GIT_PUSH_AUTH_ENV]: `https-token:${transport.tokenEnv}`,
    GIT_TERMINAL_PROMPT: "0",
  };
  // Only inject askpass material when the token is present — missing token
  // fails at the authoritative engine push with a clear pre-git message.
  if (token) {
    const askpassPath = defaultWriteAskpass(askpassScriptBody());
    Object.assign(env, buildHttpsTokenPushEnv(env, token, askpassPath));
  }
  return env;
}

/**
 * Authoritative configured push. SSH uses origin pushurl/url without PAT.
 * HTTPS-token fails before git when env is empty; otherwise askpass + disabled
 * ambient helpers. Never embeds the token in argv or durable remote URL.
 */
export async function runConfiguredGitPush(
  opts: RunConfiguredGitPushOpts,
): Promise<RunConfiguredGitPushResult> {
  const deps = opts.deps ?? {};
  const env = deps.env ?? process.env;
  const transport = selectPushTransport(opts.auth);

  if (!opts.args.length || opts.args[0] !== "push") {
    return {
      code: 1,
      stdout: "",
      stderr: "runConfiguredGitPush requires args starting with \"push\"",
      errorMessage: 'runConfiguredGitPush requires args starting with "push"',
    };
  }

  if (transport.transport === "ssh") {
    const endpoint = (await resolveSshPushEndpoint(opts.cwd, deps)) ?? "origin";
    // Prefer pushurl/url as the push endpoint; fall back to remote name "origin".
    const finalArgs = endpoint === "origin" ? opts.args : rewriteOriginRemote(opts.args, endpoint);
    const gitExec = deps.gitExec ?? defaultGitExec;
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      [PIPELINE_GIT_PUSH_AUTH_ENV]: "ssh",
    };
    const result = await gitExec({ cwd: opts.cwd, args: finalArgs, env: childEnv });
    if (result.code === 0) {
      return { ...result, endpoint, recordedArgs: finalArgs };
    }
    return {
      ...result,
      endpoint,
      recordedArgs: finalArgs,
      errorMessage: formatPushAuthFailure(opts.auth, result.stderr || result.stdout),
    };
  }

  // https-token
  const tokenEnv = transport.tokenEnv;
  const token = (env[tokenEnv] ?? "").trim();
  if (!token) {
    const msg = formatPushAuthFailure(opts.auth, `${tokenEnv} is unset or empty`, {
      phase: "pre-git",
    });
    return { code: 1, stdout: "", stderr: msg, errorMessage: msg };
  }

  const originUrl =
    (await resolveSshPushEndpoint(opts.cwd, deps)) ??
    (await (deps.gitConfigGet ?? defaultGitConfigGet)(opts.cwd, "remote.origin.url"));
  const httpsUrl = originUrl ? toHttpsRemoteUrl(originUrl) : null;
  if (!httpsUrl) {
    const msg =
      `Git push failed (mechanism=https-token, env=${tokenEnv}): ` +
      `could not derive an HTTPS remote URL from origin (got ${JSON.stringify(originUrl ?? "")})`;
    return { code: 1, stdout: "", stderr: msg, errorMessage: msg };
  }

  const writeAsk = deps.writeAskpassScript ?? defaultWriteAskpass;
  const cleanup = deps.cleanupAskpassScript ?? defaultCleanupAskpass;
  const askpassPath = writeAsk(askpassScriptBody());
  try {
    const childEnv = buildHttpsTokenPushEnv(env, token, askpassPath);
    childEnv[PIPELINE_GIT_PUSH_AUTH_ENV] = `https-token:${tokenEnv}`;
    const finalArgs = rewriteOriginRemote(opts.args, httpsUrl);
    // Also clear credential.helper via -c so system config cannot re-enable gh.
    const argsWithCred = [
      "-c",
      "credential.helper=",
      ...finalArgs,
    ];
    const gitExec = deps.gitExec ?? defaultGitExec;
    const result = await gitExec({ cwd: opts.cwd, args: argsWithCred, env: childEnv });
    // Assert token never appears in recorded args (execution-seam guarantee).
    const joined = argsWithCred.join(" ");
    if (joined.includes(token)) {
      return {
        code: 1,
        stdout: "",
        stderr: "internal error: token leaked into git argv",
        errorMessage: "internal error: token leaked into git argv",
      };
    }
    if (result.code === 0) {
      return { ...result, endpoint: httpsUrl, recordedArgs: argsWithCred };
    }
    return {
      ...result,
      endpoint: httpsUrl,
      recordedArgs: argsWithCred,
      errorMessage: formatPushAuthFailure(opts.auth, result.stderr || result.stdout),
    };
  } finally {
    cleanup(askpassPath);
  }
}

/** Sync variant for intake/sweep/backfill-style call sites. */
export function runConfiguredGitPushSync(opts: RunConfiguredGitPushOpts): RunConfiguredGitPushResult {
  const deps = opts.deps ?? {};
  const env = deps.env ?? process.env;
  const transport = selectPushTransport(opts.auth);

  if (!opts.args.length || opts.args[0] !== "push") {
    return {
      code: 1,
      stdout: "",
      stderr: "runConfiguredGitPush requires args starting with \"push\"",
      errorMessage: 'runConfiguredGitPush requires args starting with "push"',
    };
  }

  if (transport.transport === "ssh") {
    const endpoint = resolveSshPushEndpointSync(opts.cwd, deps) ?? "origin";
    const finalArgs = endpoint === "origin" ? opts.args : rewriteOriginRemote(opts.args, endpoint);
    const gitExec = deps.gitExecSync ?? defaultGitExecSync;
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      [PIPELINE_GIT_PUSH_AUTH_ENV]: "ssh",
    };
    const result = gitExec({ cwd: opts.cwd, args: finalArgs, env: childEnv });
    if (result.code === 0) {
      return { ...result, endpoint, recordedArgs: finalArgs };
    }
    return {
      ...result,
      endpoint,
      recordedArgs: finalArgs,
      errorMessage: formatPushAuthFailure(opts.auth, result.stderr || result.stdout),
    };
  }

  const tokenEnv = transport.tokenEnv;
  const token = (env[tokenEnv] ?? "").trim();
  if (!token) {
    const msg = formatPushAuthFailure(opts.auth, `${tokenEnv} is unset or empty`, {
      phase: "pre-git",
    });
    return { code: 1, stdout: "", stderr: msg, errorMessage: msg };
  }

  const originUrl =
    resolveSshPushEndpointSync(opts.cwd, deps) ??
    (deps.gitConfigGetSync ?? defaultGitConfigGetSync)(opts.cwd, "remote.origin.url");
  const httpsUrl = originUrl ? toHttpsRemoteUrl(originUrl) : null;
  if (!httpsUrl) {
    const msg =
      `Git push failed (mechanism=https-token, env=${tokenEnv}): ` +
      `could not derive an HTTPS remote URL from origin (got ${JSON.stringify(originUrl ?? "")})`;
    return { code: 1, stdout: "", stderr: msg, errorMessage: msg };
  }

  const writeAsk = deps.writeAskpassScript ?? defaultWriteAskpass;
  const cleanup = deps.cleanupAskpassScript ?? defaultCleanupAskpass;
  const askpassPath = writeAsk(askpassScriptBody());
  try {
    const childEnv = buildHttpsTokenPushEnv(env, token, askpassPath);
    childEnv[PIPELINE_GIT_PUSH_AUTH_ENV] = `https-token:${tokenEnv}`;
    const finalArgs = rewriteOriginRemote(opts.args, httpsUrl);
    const argsWithCred = ["-c", "credential.helper=", ...finalArgs];
    const gitExec = deps.gitExecSync ?? defaultGitExecSync;
    const result = gitExec({ cwd: opts.cwd, args: argsWithCred, env: childEnv });
    if (argsWithCred.join(" ").includes(token)) {
      return {
        code: 1,
        stdout: "",
        stderr: "internal error: token leaked into git argv",
        errorMessage: "internal error: token leaked into git argv",
      };
    }
    if (result.code === 0) {
      return { ...result, endpoint: httpsUrl, recordedArgs: argsWithCred };
    }
    return {
      ...result,
      endpoint: httpsUrl,
      recordedArgs: argsWithCred,
      errorMessage: formatPushAuthFailure(opts.auth, result.stderr || result.stdout),
    };
  } finally {
    cleanup(askpassPath);
  }
}

/**
 * Classification guard: a non-authoritative harness log that only shows a
 * workflow-scope HTTPS rejection must not alone justify `push-failed` when
 * the authoritative engine push already succeeded (or is about to own push).
 */
export function isNonAuthoritativeWorkflowScopeNoise(
  text: string,
  opts: { auth: GitPushAuth; authoritativePushSucceeded: boolean },
): boolean {
  if (!opts.authoritativePushSucceeded) return false;
  if (opts.auth.mechanism !== "ssh") return false;
  return isWorkflowScopePushRejection(text);
}

/** Default structured auth when config omits `git`. */
export const DEFAULT_GIT_PUSH_AUTH: GitPushAuth = { mechanism: "ssh" };
