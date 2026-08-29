// Candidate-engine resolution and ship-end spawn argv (#1151).
//
// Closed contract: SHA is data (exact 40-hex). Allowed roots are a clean
// REPO_DIR HEAD, $REPO_DIR/.worktrees/ship-candidate-<sha>, or
// PIPELINE_CANDIDATE_ENGINE_ROOT. Entrypoint is
// node "$ENGINE_ROOT/scripts/pipeline-launcher.mjs". No eval of train JSON.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseExactGitSha } from "./ship-end-identity.ts";

export const CANDIDATE_WORKTREE_PREFIX = "ship-candidate-";
export const PIPELINE_TS_REL = path.join("core", "scripts", "pipeline.ts");
export const LAUNCHER_REL = path.join("scripts", "pipeline-launcher.mjs");

export interface CandidateEngine {
  engineRoot: string;
  launcherPath: string;
  commitSha: string;
}

export type CandidateEngineResult =
  | { ok: true; engine: CandidateEngine }
  | { ok: false; error: string };

export interface ResolveCandidateEngineDeps {
  isDirectory(p: string): boolean;
  fileExists(p: string): boolean;
  /** `git -C cwd rev-parse --verify HEAD` → 40-hex or null. */
  revParseHead(cwd: string): string | null;
  /** `git -C cwd status --porcelain` → "" if clean, non-empty if dirty, null on error. */
  porcelain(cwd: string): string | null;
  /** Optional: `git -C repoDir fetch origin sha`. */
  fetchSha?(repoDir: string, sha: string): boolean;
  /** Optional: `git -C repoDir worktree add --detach dest sha`. */
  worktreeAdd?(repoDir: string, dest: string, sha: string): boolean;
}

function isSafeAbsoluteDir(p: string): boolean {
  if (typeof p !== "string" || !p.trim()) return false;
  if (!path.isAbsolute(p)) return false;
  if (/[\u0000-\u001f]/.test(p)) return false;
  return true;
}

function engineRootOk(
  root: string,
  wantSha: string,
  deps: ResolveCandidateEngineDeps,
): CandidateEngine | null {
  if (!isSafeAbsoluteDir(root)) return null;
  if (!deps.isDirectory(root)) return null;
  if (!deps.fileExists(path.join(root, PIPELINE_TS_REL))) return null;
  const launcherPath = path.join(root, LAUNCHER_REL);
  if (!deps.fileExists(launcherPath)) return null;
  const head = parseExactGitSha(deps.revParseHead(root));
  if (head !== wantSha) return null;
  const porcelain = deps.porcelain(root);
  if (porcelain !== "") return null;
  return { engineRoot: root, launcherPath, commitSha: wantSha };
}

/**
 * Resolve the candidate engine for ship-end verbs. First match wins:
 * 1. clean REPO_DIR HEAD == sha
 * 2. existing .worktrees/ship-candidate-<sha>
 * 3. PIPELINE_CANDIDATE_ENGINE_ROOT (absolute, same checks)
 * 4. create the worktree (fetch + worktree add) when deps allow
 *
 * Never resets operator REPO_DIR HEAD. Never falls back to PATH `pipeline`.
 */
export function resolveCandidateEngine(
  opts: {
    repoDir: string;
    candidateSha: string;
    candidateEngineRootEnv?: string | null;
  },
  deps: ResolveCandidateEngineDeps,
): CandidateEngineResult {
  const sha = parseExactGitSha(opts.candidateSha);
  if (!sha) {
    return { ok: false, error: "candidate SHA is not an exact 40-hex git OID" };
  }
  if (!isSafeAbsoluteDir(opts.repoDir)) {
    return { ok: false, error: "REPO_DIR must be an absolute directory" };
  }
  const repoDir = path.resolve(opts.repoDir);
  const worktree = path.join(repoDir, ".worktrees", `${CANDIDATE_WORKTREE_PREFIX}${sha}`);
  const explicit = opts.candidateEngineRootEnv?.trim() || "";

  const roots: string[] = [repoDir, worktree];
  if (explicit) {
    if (!isSafeAbsoluteDir(explicit)) {
      return {
        ok: false,
        error: "PIPELINE_CANDIDATE_ENGINE_ROOT must be an absolute directory",
      };
    }
    roots.push(path.resolve(explicit));
  }

  for (const root of roots) {
    const hit = engineRootOk(root, sha, deps);
    if (hit) return { ok: true, engine: hit };
  }

  if (deps.fetchSha && deps.worktreeAdd) {
    if (deps.fetchSha(repoDir, sha) && deps.worktreeAdd(repoDir, worktree, sha)) {
      const hit = engineRootOk(worktree, sha, deps);
      if (hit) return { ok: true, engine: hit };
    }
  }

  return {
    ok: false,
    error:
      `cannot resolve candidate engine at ${sha}: need a clean checkout at that SHA ` +
      `(REPO_DIR, ${worktree}, or PIPELINE_CANDIDATE_ENGINE_ROOT)`,
  };
}

/** Production git/fs deps for {@link resolveCandidateEngine}. Tests inject fakes. */
export function defaultResolveCandidateEngineDeps(): ResolveCandidateEngineDeps {
  return {
    isDirectory: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    fileExists: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    revParseHead: (cwd) => {
      try {
        const out = execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        });
        return parseExactGitSha(String(out).trim());
      } catch {
        return null;
      }
    },
    porcelain: (cwd) => {
      try {
        const out = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        });
        return String(out);
      } catch {
        return null;
      }
    },
    fetchSha: (dir, sha) => {
      try {
        execFileSync("git", ["-C", dir, "fetch", "--quiet", "origin", sha], {
          stdio: "ignore",
          timeout: 120_000,
        });
        return true;
      } catch {
        return false;
      }
    },
    worktreeAdd: (dir, dest, sha) => {
      try {
        execFileSync("git", ["-C", dir, "worktree", "add", "--detach", dest, sha], {
          stdio: "ignore",
          timeout: 120_000,
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function shipEndCliPrefix(
  engine: CandidateEngine,
  nodeBin = "node",
): string[] {
  return [nodeBin, engine.launcherPath];
}

export type ShipEndLeafVerb =
  | "factory-release-prepare"
  | "factory-gate"
  | "release"
  | "release-finish"
  | "ensure-tag";

const BARE_VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Leaf argv after the launcher. Never `ship` / `train`. */
export function shipEndLeafArgv(
  verb: ShipEndLeafVerb,
  args: {
    requestPath?: string;
    version?: string;
    loopRunId?: string;
    pr?: number;
    mergeCommitOid?: string;
    packedCandidate?: string;
  } = {},
): string[] {
  switch (verb) {
    case "factory-release-prepare":
      if (!args.requestPath || !path.isAbsolute(args.requestPath)) {
        throw new Error("factory-release prepare requires an absolute --request path");
      }
      return ["factory-release", "prepare", "--request", args.requestPath, "--json"];
    case "factory-gate":
      if (!args.version || !args.loopRunId) {
        throw new Error("factory-gate requires --for <version> --from-run <id>");
      }
      return ["factory-gate", "--for", args.version, "--from-run", args.loopRunId];
    case "release":
      if (!args.version) throw new Error("release requires a bare X.Y.Z version");
      return ["release", args.version, "--no-edit"];
    case "release-finish":
      if (!args.pr || args.pr <= 0) throw new Error("release finish requires a PR number");
      return ["release", "finish", String(args.pr), "--json"];
    case "ensure-tag": {
      if (!args.version || !BARE_VERSION_RE.test(args.version)) {
        throw new Error("ensure-tag requires a bare X.Y.Z version");
      }
      const oid = parseExactGitSha(args.mergeCommitOid);
      if (!oid) throw new Error("ensure-tag requires a 40-hex merge commit OID");
      const packed = parseExactGitSha(args.packedCandidate);
      if (!packed) throw new Error("ensure-tag requires a 40-hex --packed-candidate");
      return ["release", "ensure-tag", args.version, oid, "--packed-candidate", packed];
    }
    default: {
      const _exhaustive: never = verb;
      throw new Error(`unknown ship-end verb: ${_exhaustive}`);
    }
  }
}

export function assertShipEndLeafArgv(argv: readonly string[]): void {
  if (argv.includes("ship")) {
    throw new Error("ship-end spawn argv must not re-enter pipeline ship --milestone");
  }
  const first = argv.find(
    (a) =>
      a === "train" ||
      a === "factory-release" ||
      a === "factory-gate" ||
      a === "release",
  );
  if (first === "train") {
    throw new Error("ship-end spawn argv must not rerun train");
  }
}

export const FRG_ATTESTATION_KEY_ENV_NAME = "PIPELINE_FRG_ATTESTATION_KEY";
export const FRG_ATTESTATION_KEY_FILE_ENV_NAME = "PIPELINE_FRG_ATTESTATION_KEY_FILE";

export type PresentFrgAttestorCredentialReason =
  | "missing_attestor_credential"
  | "unreadable_attestor_key_file";

export type PresentFrgAttestorCredentialResult =
  | { ok: true; env: NodeJS.ProcessEnv }
  | { ok: false; reason: PresentFrgAttestorCredentialReason };

export interface PresentFrgAttestorCredentialDeps {
  /** Read KEY_FILE bytes. Throw to signal unreadable. Tests inject. */
  readFile?(path: string): Buffer;
}

function readAttestorKeyFile(
  filePath: string,
  deps?: PresentFrgAttestorCredentialDeps,
): Buffer {
  if (typeof deps?.readFile === "function") return deps.readFile(filePath);
  return fs.readFileSync(filePath);
}

/**
 * Present KEY_FILE as KEY for HMAC-verify children (Tugboat five-branch recipe).
 * Copies `env`; does not mutate the parent.
 */
export function presentFrgAttestorCredential(
  env: NodeJS.ProcessEnv,
  deps?: PresentFrgAttestorCredentialDeps,
): PresentFrgAttestorCredentialResult {
  const next = { ...env };
  const key = next[FRG_ATTESTATION_KEY_ENV_NAME];
  if (typeof key === "string" && key !== "") {
    delete next[FRG_ATTESTATION_KEY_FILE_ENV_NAME];
    return { ok: true, env: next };
  }
  const keyFile = next[FRG_ATTESTATION_KEY_FILE_ENV_NAME];
  if (typeof keyFile !== "string" || keyFile === "") {
    return { ok: false, reason: "missing_attestor_credential" };
  }
  let body: Buffer;
  try {
    body = readAttestorKeyFile(keyFile, deps);
  } catch {
    return { ok: false, reason: "unreadable_attestor_key_file" };
  }
  if (body.length === 0) {
    return { ok: false, reason: "missing_attestor_credential" };
  }
  // Tugboat KEY="$(cat -- "$KEY_FILE")" drops trailing LF via command substitution.
  next[FRG_ATTESTATION_KEY_ENV_NAME] = body.toString("utf8").replace(/\n+$/, "");
  delete next[FRG_ATTESTATION_KEY_FILE_ENV_NAME];
  return { ok: true, env: next };
}

/** Fail closed with the Tugboat named reason. Returns presented KEY. */
export function requirePresentedFrgAttestationKey(
  env: NodeJS.ProcessEnv = process.env,
  deps?: PresentFrgAttestorCredentialDeps,
): string {
  const presented = presentFrgAttestorCredential(env, deps);
  if (!presented.ok) {
    throw new Error(presented.reason);
  }
  const key = presented.env[FRG_ATTESTATION_KEY_ENV_NAME];
  if (typeof key !== "string" || key === "") {
    throw new Error("missing_attestor_credential");
  }
  return key;
}

/** Prepare child: KEY and KEY_FILE unset. Parent env is not mutated. */
export function uncredentialedPrepareEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next[FRG_ATTESTATION_KEY_ENV_NAME];
  delete next[FRG_ATTESTATION_KEY_FILE_ENV_NAME];
  return next;
}

/**
 * HMAC-verify child (attestor and ensure-tag): KEY_FILE presented as KEY.
 * Fails closed with a named reason and does not return a spawn env.
 */
export function hmacVerifyChildEnv(
  env: NodeJS.ProcessEnv,
  deps?: PresentFrgAttestorCredentialDeps,
): NodeJS.ProcessEnv {
  const presented = presentFrgAttestorCredential(env, deps);
  if (!presented.ok) {
    throw new Error(presented.reason);
  }
  return presented.env;
}

/** Same recipe as {@link hmacVerifyChildEnv} (attestor spawn). */
export function attestorChildEnv(
  env: NodeJS.ProcessEnv,
  deps?: PresentFrgAttestorCredentialDeps,
): NodeJS.ProcessEnv {
  return hmacVerifyChildEnv(env, deps);
}

export function pinShaDiffersFromCandidate(
  pinCommitSha: string | null,
  candidateSha: string,
): boolean {
  const pin = parseExactGitSha(pinCommitSha);
  const cand = parseExactGitSha(candidateSha);
  if (!cand) return true;
  return pin !== cand;
}
