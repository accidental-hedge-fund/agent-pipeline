// Fixture integrity preflight (#637 — eval-fixture-preflight).
//
// Two tiers:
//   static — model-free, used by `pipeline doctor` and before experiment run:
//            base_commit object reachability, smoke_only consistency (via
//            loader), path-token sanity against the repo test-layout policy.
//   deep   — cell-like worktree at the pin before treatments: public baseline
//            health, biting hidden + per-seeded-defect probes, generator-owned
//            allowed paths.
//
// Failures are infrastructure (doctor gate / experiment abort /
// fixture_preflight:<check>:<fixture_id>) and never enter quality pools.
// All I/O is injectable — unit tests never touch real git/network/subprocess.

import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineConfig } from "../types.ts";
import { SKILL_HOST_IDS } from "../host-skill.ts";
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
  /** Read one repository file at the fixture pin (`git show <sha>:<path>`). */
  readFileAtCommit?: (sha: string, relPath: string) => Promise<string | null>;
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

export async function defaultReadFileAtCommit(
  sha: string,
  relPath: string,
  repoDir?: string,
): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const object = `${sha}:${relPath}`;
    const args = repoDir ? ["-C", repoDir, "show", object] : ["show", object];
    const { stdout } = await execFileAsync("git", args, { timeout: 15_000 });
    return stdout;
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

/** Exact generated host SKILL outputs accepted by fixture boundaries (#1049). */
export const GENERATED_HOST_SKILL_PATHS = SKILL_HOST_IDS.map((id) => `hosts/${id}/SKILL.md`);

/** Exact generated packaging outputs accepted by fixture boundaries (#1050). */
export const GENERATED_PACKAGING_OUTPUT_PATHS = [
  ...GENERATED_HOST_SKILL_PATHS,
] as const;

const HOST_SKILL_SOURCE_PATHS = [
  "core/scripts/host-skill.ts",
  "core/scripts/operation-surface.ts",
  "core/scripts/outer-hosts/load-manifest.ts",
  "scripts/build.mjs",
  "hosts/claude/outer-host.manifest.json",
  "hosts/codex/outer-host.manifest.json",
  "hosts/grok/outer-host.manifest.json",
  "hosts/opencode/outer-host.manifest.json",
] as const;

/** True when public checks exercise generated packaging freshness. */
export function publicChecksRequireGeneratedPackagingOutputs(publicChecks: string[]): boolean {
  return publicChecks.some((c) => {
    const s = c.toLowerCase();
    return s.includes("npm run ci") || s.includes("build.mjs");
  });
}

/** True when allowed_change_paths names an exact generated packaging output. */
export function allowsGeneratedPackagingOutput(allowed: string[] | undefined): boolean {
  if (!allowed) return true; // no boundary declared — not our gate
  return allowed.some((candidate) =>
    GENERATED_PACKAGING_OUTPUT_PATHS.some((generated) => candidate === generated),
  );
}

/**
 * Resolve only outputs that the fixture's permitted source edits can actually
 * make stale at its pinned build implementation. Pre-#1048 pins mirrored a
 * subset of core/; current pins generate only the four host SKILLs.
 */
export function requiredGeneratedPackagingOutputs(
  allowed: string[] | undefined,
  pinnedBuildSource: string | null,
): string[] {
  if (!allowed) return [];
  const required = new Set<string>();
  const mirrorsCore =
    pinnedBuildSource?.includes("const CORE_ENTRIES") === true &&
    pinnedBuildSource.includes("const coreDst");
  if (mirrorsCore) {
    for (const source of allowed) {
      const mirrored =
        source.startsWith("core/scripts/") ||
        source.startsWith("core/profiles/") ||
        source === "core/package.json" ||
        source === "core/package-lock.json";
      if (mirrored) {
        required.add(`plugin/pipeline/skills/pipeline/core/${source.slice("core/".length)}`);
      }
    }
    return [...required];
  }

  if (
    allowed.some((source) =>
      (HOST_SKILL_SOURCE_PATHS as readonly string[]).includes(source),
    )
  ) {
    for (const output of GENERATED_HOST_SKILL_PATHS) required.add(output);
  }
  if (allowed.includes("scripts/build.mjs")) {
    for (const output of GENERATED_PACKAGING_OUTPUT_PATHS) required.add(output);
  }
  return [...required];
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
  // Multi-change held-out verifiers (#577) are also deterministic check commands.
  if (fixture.kind === "multi_change" && fixture.checkpoints) {
    for (const cp of fixture.checkpoints) {
      for (const v of cp.held_out_verifiers) {
        allChecks.push(v.check);
      }
    }
  }
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

  // 2b. Multi-change structural integrity (#577): non-empty checkpoints already
  // validated at load; re-assert verifier_id uniqueness and non-empty checks
  // without model spend.
  if (fixture.kind === "multi_change") {
    if (!fixture.checkpoints || fixture.checkpoints.length === 0) {
      failures.push(
        fail(
          fixture.fixture_id,
          "multi_change_checkpoints",
          `multi_change fixture declares no checkpoints`,
          `Add a non-empty checkpoints array to fixture "${fixture.fixture_id}".`,
        ),
      );
    } else {
      const ids = new Set<string>();
      for (const cp of fixture.checkpoints) {
        if (cp.held_out_verifiers.length === 0) {
          failures.push(
            fail(
              fixture.fixture_id,
              "multi_change_verifiers",
              `checkpoint ${JSON.stringify(cp.checkpoint_id)} has no held_out_verifiers`,
              `Add at least one held-out verifier to checkpoint "${cp.checkpoint_id}".`,
            ),
          );
        }
        for (const v of cp.held_out_verifiers) {
          if (ids.has(v.verifier_id)) {
            failures.push(
              fail(
                fixture.fixture_id,
                "multi_change_verifiers",
                `duplicate verifier_id ${JSON.stringify(v.verifier_id)}`,
                `Make verifier_id unique across the multi-change fixture.`,
              ),
            );
          }
          ids.add(v.verifier_id);
        }
      }
    }
  }

  // 3. Exact, pin-aware generator-owned output allowance. A CI command alone
  // does not imply every core edit changes today's host SKILL outputs.
  if (publicChecksRequireGeneratedPackagingOutputs(fixture.public_checks)) {
    const allowed = fixture.allowed_change_paths;
    const broadPluginAllowance =
      allowed?.some((candidate) =>
        ["plugin", "plugin/", "plugin/**", "plugin/**/*"].includes(candidate),
      ) ?? false;
    const readPinnedFile =
      deps.readFileAtCommit ??
      ((sha: string, relPath: string) => defaultReadFileAtCommit(sha, relPath, deps.repoDir));
    const pinnedBuildSource = await readPinnedFile(fixture.base_commit, "scripts/build.mjs");
    const required = requiredGeneratedPackagingOutputs(allowed, pinnedBuildSource);
    const missing = required.filter((output) => !allowed?.includes(output));
    if (!broadPluginAllowance && missing.length === 0) return { ok: failures.length === 0, failures };
    failures.push(
      fail(
        fixture.fixture_id,
        "plugin_allowance",
        broadPluginAllowance
          ? `allowed_change_paths grants a broad plugin/** boundary instead of exact pinned generator outputs`
          : `allowed_change_paths omits required pinned generator output(s): ${missing.join(", ")}`,
        `List only the exact generator output path(s) required at base_commit ${fixture.base_commit} on fixture "${fixture.fixture_id}"; ` +
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
  /**
   * Materialize a fixture's frozen review.diff into the preflight worktree so
   * seeded-defect biting_probes can inspect review ground truth. Returns the
   * absolute path written (exposed as EVAL_PREFLIGHT_REVIEW_DIFF).
   */
  materializeReviewDiff?: (worktreeDir: string, diff: string) => Promise<string>;
}

/** Extract stage_entry_artifacts.review.diff when present. */
export function extractReviewDiff(fixture: Fixture): string | undefined {
  const review = fixture.stage_entry_artifacts?.review;
  if (typeof review !== "object" || review === null || Array.isArray(review)) return undefined;
  const diff = (review as Record<string, unknown>).diff;
  return typeof diff === "string" ? diff : undefined;
}

async function defaultMaterializeReviewDiff(worktreeDir: string, diff: string): Promise<string> {
  const dir = path.join(worktreeDir, ".eval-preflight");
  await fs.promises.mkdir(dir, { recursive: true });
  const out = path.join(dir, "review.diff");
  await fs.promises.writeFile(out, diff, "utf8");
  return out;
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

    // Materialize frozen review.diff for seeded-defect probes that inspect
    // review ground truth (EVAL_PREFLIGHT_REVIEW_DIFF).
    const reviewDiff = extractReviewDiff(fixture);
    if (reviewDiff !== undefined && (fixture.seeded_defects?.length ?? 0) > 0) {
      const materializeFn = deps.materializeReviewDiff ?? defaultMaterializeReviewDiff;
      try {
        const reviewDiffPath = await materializeFn(worktreePath, reviewDiff);
        cellEnv.EVAL_PREFLIGHT_REVIEW_DIFF = reviewDiffPath;
      } catch (err) {
        failures.push(
          fail(
            fixture.fixture_id,
            "biting_probe",
            `failed to materialize review.diff for seeded-defect biting probes: ${(err as Error).message}`,
            `Ensure deep preflight can write .eval-preflight/ under the cell worktree for fixture "${fixture.fixture_id}".`,
          ),
        );
      }
    }

    // Path resolution for check commands, seeded-defect biting probes, and paths.
    const probeCommands = [
      ...fixture.public_checks,
      ...(fixture.hidden_checks ?? []),
      ...(fixture.seeded_defects ?? []).map((d) => d.biting_probe),
    ];
    for (const cmd of probeCommands) {
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

    // Per-seeded-defect biting probes must FAIL at the pin (path existence alone
    // is not proof the declared defect still bites — #637 ae1fad38).
    for (const defect of fixture.seeded_defects ?? []) {
      const ok = await runCheckFn({
        worktreeDir: worktreePath,
        check: defect.biting_probe,
        deadlineMs,
        env: cellEnv,
      });
      if (ok) {
        failures.push(
          fail(
            fixture.fixture_id,
            "biting_probe",
            `seeded defect ${JSON.stringify(defect.defect_id)} biting_probe already passes at the pin (non-biting / already fixed)`,
            `Replace or retarget biting_probe for defect ${defect.defect_id} on fixture "${fixture.fixture_id}" so it fails at base_commit while the defect remains ground truth.`,
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
