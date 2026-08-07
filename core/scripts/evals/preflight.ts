// Fixture integrity preflight (#637 — eval-fixture-preflight).
//
// Two tiers:
//   static — model-free, used by `pipeline doctor` and before experiment run:
//            base_commit object reachability, smoke_only consistency (via
//            loader), path-token sanity against the repo test-layout policy.
//   deep   — cell-like worktree at the pin before treatments: public baseline
//            health, biting hidden probes, generator-owned allowed paths.
//
// Failures are infrastructure (doctor gate / experiment abort /
// fixture_preflight:<check>:<fixture_id>) and never enter quality pools.
// All I/O is injectable — unit tests never touch real git/network/subprocess.

import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineConfig } from "../types.ts";
import {
  evalIsolationEnv,
  installBoundaryShim as installBoundaryShimReal,
  removeBoundaryShim as removeBoundaryShimReal,
} from "./boundary-shim.ts";
import type { Fixture, SandboxMode } from "./types.ts";

/** Stable reason prefix for infrastructure classification (#637). */
export const FIXTURE_PREFLIGHT_REASON_PREFIX = "fixture_preflight";

export type FixturePreflightCheckId =
  | "base_commit_reachable"
  | "path_token"
  | "public_baseline"
  | "biting_probe"
  | "plugin_allowance"
  | "unresolvable_path"
  | "bootstrap";

export interface FixturePreflightFailure {
  fixture_id: string;
  check: FixturePreflightCheckId;
  /** Stable machine-readable reason: fixture_preflight:<check>:<fixture_id> */
  reason: string;
  /** Human-readable detail naming the fixture and corrective action. */
  detail: string;
  remediation: string;
}

export interface FixturePreflightResult {
  ok: boolean;
  failures: FixturePreflightFailure[];
}

export function preflightReason(check: FixturePreflightCheckId, fixtureId: string): string {
  return `${FIXTURE_PREFLIGHT_REASON_PREFIX}:${check}:${fixtureId}`;
}

function fail(
  fixtureId: string,
  check: FixturePreflightCheckId,
  detail: string,
  remediation: string,
): FixturePreflightFailure {
  return {
    fixture_id: fixtureId,
    check,
    reason: preflightReason(check, fixtureId),
    detail,
    remediation,
  };
}

// ---------------------------------------------------------------------------
// Static preflight deps + checks
// ---------------------------------------------------------------------------

export interface StaticPreflightDeps {
  /** Probe git object type for a SHA (`git cat-file -t <sha>` → "commit" | null). */
  catFile?: (sha: string) => Promise<string | null>;
  /** Run a declared bootstrap command; only called when fixture declares one. */
  runBootstrap?: (command: string) => Promise<{ ok: boolean; error?: string }>;
  /** Repo root used for path-token policy (defaults unused when not probing fs). */
  repoDir?: string;
}

/** Default: `git cat-file -t <sha>` in the current process cwd / repo. */
export async function defaultCatFile(sha: string, repoDir?: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const args = repoDir ? ["-C", repoDir, "cat-file", "-t", sha] : ["cat-file", "-t", sha];
    const { stdout } = await execFileAsync("git", args, { timeout: 15_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Repository test-layout policy for this monorepo: unit tests live under
 * `core/test/`, not a repository-root `test/` directory. A check command that
 * references a bare `test/...` path (not `core/test/...`) is almost certainly
 * unresolvable in a cell worktree and wasted the 2026-07-28 campaign.
 */
export function findDisallowedTestRootTokens(command: string): string[] {
  // Match path-like tokens that start with test/ or ./test/ or are standalone
  // `test/foo` after a space, but not core/test/.
  const tokens: string[] = [];
  const re = /(?:^|[\s"'`=])(\.?\/?test\/[^\s"'`;|&]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const tok = m[1];
    // Allow only if the full command also has core/ before this — still flag
    // a bare test/ root token even if core/test appears elsewhere.
    if (!tok.includes("core/test/")) {
      tokens.push(tok);
    }
  }
  return tokens;
}

/** True when public checks imply the generator-owned plugin mirror must be
 *  regenerable (this repo's `npm run ci` includes `build.mjs --check`). */
export function publicChecksRequirePluginMirror(publicChecks: string[]): boolean {
  return publicChecks.some((c) => {
    const s = c.toLowerCase();
    return (
      s.includes("npm run ci") ||
      s.includes("build.mjs") ||
      s.includes("docs:check") ||
      s.includes("generate-docs")
    );
  });
}

/** True when allowed_change_paths admits at least one generator-owned plugin path. */
export function allowsPluginMirrorPaths(allowed: string[] | undefined): boolean {
  if (!allowed) return true; // no boundary declared — not our gate
  return allowed.some((p) => p === "plugin" || p === "plugin/" || p.startsWith("plugin/"));
}

/** Static integrity checks for one fixture (no worktree, no model). */
export async function runStaticFixturePreflight(
  fixture: Fixture,
  deps: StaticPreflightDeps = {},
): Promise<FixturePreflightResult> {
  const failures: FixturePreflightFailure[] = [];
  const catFileFn = deps.catFile ?? ((sha: string) => defaultCatFile(sha, deps.repoDir));

  // 1. base_commit object reachability (or successful bootstrap).
  let objectType = await catFileFn(fixture.base_commit);
  if (objectType !== "commit" && fixture.base_commit_bootstrap) {
    const runBootstrap =
      deps.runBootstrap ??
      (async (command: string) => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        try {
          await execFileAsync("sh", ["-c", command], {
            cwd: deps.repoDir,
            timeout: 120_000,
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      });
    const boot = await runBootstrap(fixture.base_commit_bootstrap);
    if (!boot.ok) {
      failures.push(
        fail(
          fixture.fixture_id,
          "bootstrap",
          `base_commit bootstrap failed for ${fixture.base_commit}: ${boot.error ?? "unknown error"}`,
          `Fix the fixture's base_commit_bootstrap or ensure ${fixture.base_commit} is fetchable, then re-run doctor.`,
        ),
      );
    } else {
      objectType = await catFileFn(fixture.base_commit);
    }
  }
  if (objectType !== "commit") {
    failures.push(
      fail(
        fixture.fixture_id,
        "base_commit_reachable",
        `base_commit ${fixture.base_commit} is not a reachable commit object in this clone`,
        `Fetch the commit (full clone / git fetch) or declare base_commit_bootstrap on fixture "${fixture.fixture_id}". ` +
          `CI uses fetch-depth: 0 so corpus pins must exist in full history.`,
      ),
    );
  }

  // 2. Static path-token sanity on public + hidden check commands.
  const allChecks = [...fixture.public_checks, ...(fixture.hidden_checks ?? [])];
  for (const cmd of allChecks) {
    const bad = findDisallowedTestRootTokens(cmd);
    for (const tok of bad) {
      failures.push(
        fail(
          fixture.fixture_id,
          "path_token",
          `check command references repository-root test path ${JSON.stringify(tok)}; tests live under core/test/`,
          `Rewrite the check on fixture "${fixture.fixture_id}" to use core/test/... (not root test/...).`,
        ),
      );
    }
  }

  // 3. Generator-owned allowed_change_paths completeness (static approximation).
  if (
    publicChecksRequirePluginMirror(fixture.public_checks) &&
    fixture.allowed_change_paths !== undefined &&
    !allowsPluginMirrorPaths(fixture.allowed_change_paths)
  ) {
    failures.push(
      fail(
        fixture.fixture_id,
        "plugin_allowance",
        `public checks require plugin/ mirror regen but allowed_change_paths omits generator-owned plugin/ paths`,
        `Add plugin/ (or specific plugin/... paths) to allowed_change_paths on fixture "${fixture.fixture_id}", ` +
          `or document an explicit corpus exception.`,
      ),
    );
  }

  return { ok: failures.length === 0, failures };
}

/** Run static preflight over every fixture in a map (corpus or experiment set). */
export async function runStaticCorpusPreflight(
  fixtures: Iterable<Fixture>,
  deps: StaticPreflightDeps = {},
): Promise<FixturePreflightResult> {
  const failures: FixturePreflightFailure[] = [];
  for (const fixture of fixtures) {
    const result = await runStaticFixturePreflight(fixture, deps);
    failures.push(...result.failures);
  }
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Deep (cell-like) preflight
// ---------------------------------------------------------------------------

export interface DeepPreflightDeps {
  createWorktree?: (opts: {
    path: string;
    branch: string;
    baseCommit: string;
  }) => Promise<void>;
  removeWorktree?: (opts: { path: string; branch: string }) => Promise<void>;
  /** Run a check command under the cell-like env; return true if exit 0. */
  runCheck?: (args: {
    worktreeDir: string;
    check: string;
    deadlineMs: number;
    /** Cell isolation env (PATH deny shim + credential strip). */
    env: NodeJS.ProcessEnv;
  }) => Promise<boolean>;
  /** Whether a path exists under the worktree (repo-relative). */
  pathExists?: (worktreeDir: string, relPath: string) => Promise<boolean>;
  /** Optional bootstrap for deep tier (reuse static). */
  staticDeps?: StaticPreflightDeps;
  /**
   * Manifest sandbox mode for the experiment (#607 / #637). Deep preflight
   * accepts the same policy a real cell would; process-boundary isolation is
   * always applied for check commands (matching runCell), independent of the
   * harness CLI sandbox switch.
   */
  sandboxMode?: SandboxMode;
  /** Materialize the PATH deny shim for the preflight worktree. */
  installBoundaryShim?: (worktreeDir: string) => string;
  /** Tear down the cell-scoped boundary control directory. */
  removeBoundaryShim?: (worktreeDir: string) => void;
  /**
   * Dependency/bootstrap surface public checks assume (e.g. `npm ci` via
   * `detectAndInstall`). Runs after worktree creation, before checks.
   */
  bootstrapWorktree?: (worktreeDir: string) => Promise<void>;
  /** Build cell isolation env overrides (defaults to {@link evalIsolationEnv}). */
  isolationEnv?: (worktreeDir: string) => NodeJS.ProcessEnv;
}

function extractPathTokensFromCheck(command: string): string[] {
  // Heuristic: file-like tokens ending in common source/test extensions or
  // starting with core/ / plugin/ / scripts/ / test/.
  const tokens: string[] = [];
  const re = /(?:^|[\s"'`])((?:\.\/)?(?:core|plugin|scripts|test|hosts|openspec)\/[^\s"'`;|&]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1].replace(/^\.\//, ""));
  }
  return tokens;
}

/** Deep cell-like preflight for one fixture. No model invocation.
 *  Uses the same worktree layout, dependency bootstrap, PATH deny shim, and
 *  credential-strip env a real cell applies to checks (#637 review). */
export async function runDeepFixturePreflight(
  cfg: PipelineConfig,
  fixture: Fixture,
  deps: DeepPreflightDeps = {},
): Promise<FixturePreflightResult> {
  // Always run static first.
  const staticResult = await runStaticFixturePreflight(fixture, {
    ...(deps.staticDeps ?? {}),
    repoDir: deps.staticDeps?.repoDir ?? cfg.repo_dir,
  });
  if (!staticResult.ok) return staticResult;

  const failures: FixturePreflightFailure[] = [];
  const slug = `preflight-${fixture.fixture_id}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  const worktreePath = path.join(cfg.repo_dir, ".worktrees", "evals", slug);
  const branch = `pipeline-eval-preflight/${slug}`;
  // sandboxMode is accepted for cell-policy parity with runCell / the
  // experiment manifest; check isolation always applies the process boundary
  // (same as runCell, which installs the shim regardless of sandbox_mode).
  void deps.sandboxMode;

  const createWorktreeFn =
    deps.createWorktree ??
    (async (opts) => {
      const { createWorktreeAt } = await import("../worktree.ts");
      await createWorktreeAt(cfg, {
        path: opts.path,
        branch: opts.branch,
        baseCommit: opts.baseCommit,
      });
    });
  const removeWorktreeFn =
    deps.removeWorktree ??
    (async (opts) => {
      const { removeWorktreeAt } = await import("../worktree.ts");
      await removeWorktreeAt(cfg, { path: opts.path, branch: opts.branch });
    });
  const bootstrapWorktreeFn =
    deps.bootstrapWorktree ??
    (async (dir: string) => {
      const { detectAndInstall } = await import("../worktree-setup.ts");
      await detectAndInstall(dir, cfg);
    });
  const installBoundaryShimFn = deps.installBoundaryShim ?? installBoundaryShimReal;
  const removeBoundaryShimFn = deps.removeBoundaryShim ?? removeBoundaryShimReal;
  const isolationEnvFn = deps.isolationEnv ?? evalIsolationEnv;
  const runCheckFn =
    deps.runCheck ??
    (async (args) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      try {
        await execFileAsync("sh", ["-c", args.check], {
          cwd: args.worktreeDir,
          timeout: Math.max(1, args.deadlineMs),
          env: args.env,
        });
        return true;
      } catch {
        return false;
      }
    });
  const pathExistsFn =
    deps.pathExists ??
    (async (worktreeDir: string, relPath: string) => {
      try {
        await fs.promises.access(path.join(worktreeDir, relPath));
        return true;
      } catch {
        return false;
      }
    });

  let created = false;
  let boundaryInstalled = false;
  try {
    await createWorktreeFn({
      path: worktreePath,
      branch,
      baseCommit: fixture.base_commit,
    });
    created = true;

    // Same dependency/bootstrap surface public checks assume (npm ci / setup).
    try {
      await bootstrapWorktreeFn(worktreePath);
    } catch (err) {
      failures.push(
        fail(
          fixture.fixture_id,
          "bootstrap",
          `cell dependency bootstrap failed at base_commit ${fixture.base_commit}: ${(err as Error).message}`,
          `Fix worktree install/setup for fixture "${fixture.fixture_id}" (lockfile, setup_command, or pin) so public checks can run under the cell surface.`,
        ),
      );
      return { ok: false, failures };
    }

    // PATH deny shim + isolation env — same surface as runCell checks.
    installBoundaryShimFn(worktreePath);
    boundaryInstalled = true;
    const cellEnv = { ...process.env, ...isolationEnvFn(worktreePath) };

    // Path resolution for check commands + seeded defect paths.
    for (const cmd of [...fixture.public_checks, ...(fixture.hidden_checks ?? [])]) {
      for (const tok of extractPathTokensFromCheck(cmd)) {
        // Skip globs / flags that look like paths but aren't files.
        if (tok.includes("*") || tok.startsWith("-")) continue;
        // npm scripts are not paths.
        if (tok === "core/test" || tok.endsWith("/")) continue;
        const exists = await pathExistsFn(worktreePath, tok);
        if (!exists) {
          failures.push(
            fail(
              fixture.fixture_id,
              "unresolvable_path",
              `check references path ${JSON.stringify(tok)} which does not exist at base_commit ${fixture.base_commit}`,
              `Fix the path on fixture "${fixture.fixture_id}" (use core/test/... when tests live there) or retarget base_commit.`,
            ),
          );
        }
      }
    }
    for (const defect of fixture.seeded_defects ?? []) {
      const exists = await pathExistsFn(worktreePath, defect.path);
      if (!exists) {
        failures.push(
          fail(
            fixture.fixture_id,
            "unresolvable_path",
            `seeded defect ${JSON.stringify(defect.defect_id)} path ${JSON.stringify(defect.path)} missing at pin`,
            `Repair or replace seeded defect ${defect.defect_id} on fixture "${fixture.fixture_id}".`,
          ),
        );
      }
    }

    // Public baseline must be healthy at the pin (no treatment).
    const deadlineMs = 600_000;
    for (const check of fixture.public_checks) {
      const ok = await runCheckFn({ worktreeDir: worktreePath, check, deadlineMs, env: cellEnv });
      if (!ok) {
        failures.push(
          fail(
            fixture.fixture_id,
            "public_baseline",
            `public check ${JSON.stringify(check)} fails at base_commit ${fixture.base_commit} with no treatment`,
            `Repair fixture "${fixture.fixture_id}" so the public baseline is green at the pin, or retarget base_commit.`,
          ),
        );
      }
    }

    // Hidden checks declared as biting probes must FAIL at the pin.
    for (const check of fixture.hidden_checks ?? []) {
      const ok = await runCheckFn({ worktreeDir: worktreePath, check, deadlineMs, env: cellEnv });
      if (ok) {
        failures.push(
          fail(
            fixture.fixture_id,
            "biting_probe",
            `hidden check ${JSON.stringify(check)} already passes at the pin (non-biting / already fixed)`,
            `Replace or retarget the seeded probe on fixture "${fixture.fixture_id}" so it fails at base_commit.`,
          ),
        );
      }
    }
  } catch (err) {
    failures.push(
      fail(
        fixture.fixture_id,
        "base_commit_reachable",
        `deep preflight worktree failed: ${(err as Error).message}`,
        `Ensure base_commit ${fixture.base_commit} is fetchable for fixture "${fixture.fixture_id}".`,
      ),
    );
  } finally {
    if (boundaryInstalled) {
      try {
        removeBoundaryShimFn(worktreePath);
      } catch {
        // Best-effort; control dir is outside the worktree.
      }
    }
    if (created) {
      try {
        await removeWorktreeFn({ path: worktreePath, branch });
      } catch {
        // Best-effort cleanup; preflight failures already recorded.
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

/** Deep-preflight every fixture id referenced by an experiment (before treatments). */
export async function runDeepExperimentPreflight(
  cfg: PipelineConfig,
  fixtures: Map<string, Fixture>,
  fixtureIds: string[],
  deps: DeepPreflightDeps = {},
): Promise<FixturePreflightResult> {
  const failures: FixturePreflightFailure[] = [];
  // Share one deep run per unique base_commit within the batch when possible
  // is a future optimization; correctness first — per-fixture.
  for (const id of fixtureIds) {
    const fixture = fixtures.get(id);
    if (!fixture) {
      failures.push(
        fail(
          id,
          "base_commit_reachable",
          `fixture id ${JSON.stringify(id)} is not loaded`,
          `Add the fixture file or remove it from the experiment manifest.`,
        ),
      );
      continue;
    }
    // Smoke-only fixtures are excluded from graded quality aggregates, but
    // still require full deep cell-like integrity preflight (baseline, path
    // resolution, isolation/bootstrap surface) before harness/isolation smoke
    // may run (#637 review 1 finding 235a716c).
    const result = await runDeepFixturePreflight(cfg, fixture, deps);
    failures.push(...result.failures);
  }
  return { ok: failures.length === 0, failures };
}

/** Format failures for doctor remediation text. */
export function formatPreflightFailures(failures: FixturePreflightFailure[]): string {
  return failures
    .map((f) => `${f.reason}: ${f.detail} — ${f.remediation}`)
    .join("\n");
}
