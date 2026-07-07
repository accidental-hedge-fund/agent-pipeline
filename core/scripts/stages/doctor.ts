// Doctor / preflight (#146): a deterministic, model-free capability check that
// runs before any autonomous work. It surfaces the most common setup defects —
// missing CLIs, expired GitHub auth, no repo access, a dirty protected branch,
// an unavailable harness, stale npm install state, a missing `openspec` binary,
// or a missing eval command — so they are reported up front with actionable
// remediation text instead of being discovered mid-run after tokens are spent.
//
// Every check is a `PreflightCheck` record over a `DoctorDeps` seam (the same
// injectable-deps pattern as the other stages), so the whole module is
// unit-testable with no real subprocess, filesystem, or network calls. Nothing
// here invokes a language model.

import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { PipelineConfig } from "../types.ts";
import { redactSecrets, sanitize, sanitizeDeep } from "../artifact-sanitize.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Deps seam + result shapes
// ---------------------------------------------------------------------------

export interface ExecResult {
  ok: boolean; // true iff the process exited 0
  stdout: string;
  stderr: string;
}

/** Thin I/O primitives every check runs through. Real impl in {@link realDoctorDeps};
 *  unit tests inject fakes so no real subprocess/fs/network call is made. */
export interface DoctorDeps {
  /** Run a command, capturing stdout/stderr and whether it exited 0. */
  exec(file: string, args: string[]): Promise<ExecResult>;
  /** Run a command, resolving only whether it exited 0 (binary-presence / status checks). */
  execCheck(file: string, args: string[]): Promise<boolean>;
  /** Whether a filesystem path exists. */
  fsExists(p: string): Promise<boolean>;
  /** mtime in ms since epoch, or null when the path does not exist. */
  fileMtime(p: string): Promise<number | null>;
  /** Read a file as UTF-8 text; returns null on any error (missing, permission, etc). */
  readTextFile(p: string): Promise<string | null>;
}

export type CheckStatus = "pass" | "fail" | "skip" | "warn";

export interface CheckResult {
  status: CheckStatus;
  /** One-line description of what was checked and what was found. */
  detail: string;
  /** Actionable remediation text — required when status is "fail" or "warn". */
  remediation?: string;
}

export interface CheckOutcome extends CheckResult {
  id: string;
  description: string;
}

/** A single declared preflight check. `run` closes over the resolved config. */
export interface PreflightCheck {
  id: string;
  description: string;
  run: (deps: DoctorDeps) => Promise<CheckResult>;
}

export interface PreflightResult {
  schema_version: number;
  /** True iff no check failed (skipped checks do not count as failures). */
  ok: boolean;
  checks: CheckOutcome[];
  /** ISO timestamp of when the preflight ran. */
  ranAt: string;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

const EXEC_TIMEOUT_MS = 30_000;

export function realDoctorDeps(): DoctorDeps {
  const exec: DoctorDeps["exec"] = async (file, args) => {
    try {
      const { stdout, stderr } = await execFileAsync(file, args, {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
    }
  };
  const execCheck: DoctorDeps["execCheck"] = async (file, args) => (await exec(file, args)).ok;
  const fsExists: DoctorDeps["fsExists"] = async (p) => {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  };
  const fileMtime: DoctorDeps["fileMtime"] = async (p) => {
    try {
      return (await fs.promises.stat(p)).mtimeMs;
    } catch {
      return null;
    }
  };
  const readTextFile: DoctorDeps["readTextFile"] = async (p) => {
    try {
      return await fs.promises.readFile(p, "utf8");
    } catch {
      return null;
    }
  };
  return { exec, execCheck, fsExists, fileMtime, readTextFile };
}

// ---------------------------------------------------------------------------
// Result constructors (keep individual checks terse)
// ---------------------------------------------------------------------------

const pass = (detail: string): CheckResult => ({ status: "pass", detail });
const skip = (detail: string): CheckResult => ({ status: "skip", detail });
const fail = (detail: string, remediation: string): CheckResult => ({
  status: "fail",
  detail,
  remediation,
});
/** Non-blocking: reported loudly but never sets `PreflightResult.ok` false and
 *  never aborts a run-start preflight — a stale/degraded-but-working install. */
const warn = (detail: string, remediation: string): CheckResult => ({
  status: "warn",
  detail,
  remediation,
});

// ---------------------------------------------------------------------------
// Check definitions
// ---------------------------------------------------------------------------

/** Protected branches the pipeline must not have dirty (it branches worktrees from them). */
function protectedBranches(config: PipelineConfig): Set<string> {
  return new Set([config.base_branch, "main", "master", "staging"]);
}

/** The engine's own source/release repo — fixed, and distinct from `config.repo`
 *  (the target repo the pipeline operates on). Mirrors the constant used by
 *  scripts/build.mjs, scripts/install.mjs, and scripts/postinstall.mjs. */
const UPSTREAM_REPO = "accidental-hedge-fund/agent-pipeline";

/** Strip a leading "v"/"V" so a release tag ("v1.14.0") and the running
 *  VERSION constant ("1.14.0") compare on the same footing. */
function normalizeVersionTag(v: string): string {
  return v.trim().replace(/^[vV]/, "");
}

/** Compare two dotted-numeric version strings segment by segment. Non-numeric
 *  or missing segments parse to 0, so a genuinely ambiguous tag never reads
 *  as "behind" — ambiguity biases toward pass, never a false-positive warn. */
function compareVersionSegments(a: string, b: string): number {
  const as = normalizeVersionTag(a).split(".");
  const bs = normalizeVersionTag(b).split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const an = Number.parseInt(as[i] ?? "0", 10) || 0;
    const bn = Number.parseInt(bs[i] ?? "0", 10) || 0;
    if (an !== bn) return an - bn;
  }
  return 0;
}

/** Build the ordered list of preflight checks for the given resolved config.
 *  `version` is the `VERSION` constant from `pipeline.ts` (loaded at startup) and is used
 *  by the install:version-coherence check. `installRoot` overrides the auto-derived install
 *  root path (for unit tests that need deterministic paths). */
export function buildPreflightChecks(
  config: PipelineConfig,
  version: string,
  installRoot?: string,
): PreflightCheck[] {
  // core/scripts/stages/doctor.ts → dirname×3 → core/
  const root = installRoot ?? path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const checks: PreflightCheck[] = [];

  // 1. Required CLIs — one check per binary so remediation can name it.
  checks.push({
    id: "cli:gh",
    description: "GitHub CLI (`gh`) is installed and on PATH",
    run: async (deps) =>
      (await deps.execCheck("gh", ["--version"]))
        ? pass("`gh` is available")
        : fail(
            "`gh` was not found on PATH",
            "Install the GitHub CLI (`gh`) and ensure it is on your PATH — https://cli.github.com.",
          ),
  });
  checks.push({
    id: "cli:node",
    description: "Node.js (`node`) is installed and on PATH",
    run: async (deps) =>
      (await deps.execCheck("node", ["--version"]))
        ? pass("`node` is available")
        : fail(
            "`node` was not found on PATH",
            "Install Node.js 24+ and ensure `node` is on your PATH — https://nodejs.org.",
          ),
  });

  // 2. GitHub auth.
  checks.push({
    id: "github-auth",
    description: "GitHub CLI is authenticated (`gh auth status`)",
    run: async (deps) =>
      (await deps.execCheck("gh", ["auth", "status"]))
        ? pass("GitHub CLI is authenticated")
        : fail(
            "`gh auth status` reported no valid authentication",
            "Run `gh auth login` to authenticate the GitHub CLI before starting a run.",
          ),
  });

  // 3. Repo access — token can actually see the configured repo.
  //    When config.repo is "" (gh was unavailable or the checkout could not be
  //    resolved to a GitHub repo during config resolution), fail with remediation
  //    rather than skipping: a missing repo name IS a repo-access failure and the
  //    spec requires it to appear in the failing check set.
  checks.push({
    id: "repo-access",
    description: config.repo
      ? `Authenticated token can access ${config.repo}`
      : "Authenticated token can access the configured repo",
    run: async (deps) => {
      if (!config.repo) {
        return fail(
          "could not determine the GitHub repo for this checkout — gh was unavailable or the checkout cannot be resolved to a GitHub repo",
          `Set \`repo: owner/name\` in \`.github/pipeline.yml\`, run \`gh auth login\` if authentication is expired, or ensure the checkout at ${config.repo_dir} is a GitHub-linked repo accessible to your token.`,
        );
      }
      return (await deps.execCheck("gh", ["repo", "view", config.repo]))
        ? pass(`can access ${config.repo}`)
        : fail(
            `\`gh repo view ${config.repo}\` failed — the token cannot access this repo`,
            `Verify your GitHub token has access to \`${config.repo}\` and the right scopes (run \`gh auth status\`, or \`gh auth refresh -s repo\` to add the repo scope).`,
          );
    },
  });

  // 4. Worktree cleanliness — the active checkout must not have uncommitted
  //    changes when it is sitting on a protected branch (the pipeline branches
  //    worktrees from that branch and runs git operations against it).
  checks.push({
    id: "worktree-clean",
    description: "Working tree is clean when on a protected branch",
    run: async (deps) => {
      const branchRes = await deps.exec("git", ["-C", config.repo_dir, "rev-parse", "--abbrev-ref", "HEAD"]);
      if (!branchRes.ok) {
        return fail(
          `could not determine the current git branch in ${config.repo_dir}`,
          `Ensure ${config.repo_dir} is a valid git checkout (run \`git status\` there).`,
        );
      }
      const branch = branchRes.stdout.trim();
      if (!protectedBranches(config).has(branch)) {
        return pass(`on feature branch \`${branch}\` — uncommitted changes are allowed`);
      }
      const statusRes = await deps.exec("git", ["-C", config.repo_dir, "status", "--porcelain"]);
      if (!statusRes.ok) {
        return fail(
          `\`git status\` failed in ${config.repo_dir}`,
          `Ensure ${config.repo_dir} is a valid git checkout (run \`git status\` there).`,
        );
      }
      if (statusRes.stdout.trim() !== "") {
        return fail(
          `uncommitted changes on protected branch \`${branch}\``,
          `Commit, stash, or discard the uncommitted changes on \`${branch}\` before running the pipeline (it branches worktrees from this branch).`,
        );
      }
      return pass(`clean working tree on protected branch \`${branch}\``);
    },
  });

  // 5. Harness availability — every distinct harness binary declared in config.
  //
  // Built-in harnesses (claude, codex) are probed with --version, which validates
  // both presence and basic invocability. Custom reviewer CLIs (review_harness, #40)
  // only guarantee `<bin> "<prompt>"` as their contract — they are NOT required to
  // support --version, and running them could invoke a model. For those we do a
  // PATH-only check via `which` to stay model-free and avoid unintended execution.
  const BUILT_IN_HARNESSES = new Set(["claude", "codex"]);
  const harnessBins = [...new Set([config.harnesses.implementer, config.harnesses.reviewer])];
  for (const bin of harnessBins) {
    const isBuiltIn = BUILT_IN_HARNESSES.has(bin);
    checks.push({
      id: `harness:${bin}`,
      description: `Configured harness \`${bin}\` is installed and on PATH`,
      run: async (deps) =>
        (isBuiltIn ? await deps.execCheck(bin, ["--version"]) : await deps.execCheck("which", [bin]))
          ? pass(`\`${bin}\` is available`)
          : fail(
              `configured harness \`${bin}\` was not found on PATH`,
              `Install the \`${bin}\` CLI and ensure it is on your PATH — it is a configured pipeline harness for this profile.`,
            ),
    });
  }

  // 6. Install version coherence — the VERSION constant loaded by pipeline.ts at startup
  //    must match the version field in core/package.json at the install root. A mismatch
  //    means the running binary is from a different (usually older) install than the code
  //    on disk, making version-tagged bug reports unreliable.
  checks.push({
    id: "install:version-coherence",
    description: "Installed core/package.json version matches the running pipeline version",
    run: async (deps) => {
      const pkgPath = path.join(root, "package.json");
      const text = await deps.readTextFile(pkgPath);
      if (text === null) {
        return fail(
          `core/package.json at ${root} could not be read`,
          `Reinstall the pipeline skill to ensure core/package.json is present and readable at ${root}.`,
        );
      }
      let pkg: { version?: string };
      try {
        pkg = JSON.parse(text) as { version?: string };
      } catch {
        return fail(
          `core/package.json at ${root} is not valid JSON`,
          `Reinstall the pipeline skill to restore a valid core/package.json at ${root}.`,
        );
      }
      if (pkg.version !== version) {
        return fail(
          `version mismatch: running v${version} but core/package.json at ${root} reports v${pkg.version ?? "(missing)"}`,
          `Reinstall the pipeline skill to bring the running code in sync with core/package.json at ${root}.`,
        );
      }
      return pass(`v${version} at ${root}`);
    },
  });

  // 6b. Install version freshness (#385) — the installed engine can be internally
  //     coherent (running code and its package.json agree) yet still be an old
  //     *release*. Compares the running VERSION against the latest published
  //     GitHub release tag of the engine's own upstream repo (never config.repo).
  //     Report-only: never mutates the install, never blocks (warn, not fail),
  //     and degrades to a silent skip when the release lookup is unavailable.
  checks.push({
    id: "install:version-freshness",
    description: "Installed engine version is up to date with the latest agent-pipeline release",
    run: async (deps) => {
      if (!version) {
        return skip("no running version available to compare — skipped (offline)");
      }
      const res = await deps.exec("gh", ["release", "view", "--repo", UPSTREAM_REPO, "--json", "tagName"]);
      if (!res.ok || !res.stdout.trim()) {
        return skip("could not reach the latest agent-pipeline release — skipped (offline)");
      }
      let parsed: { tagName?: string };
      try {
        parsed = JSON.parse(res.stdout) as { tagName?: string };
      } catch {
        return skip("release lookup returned unparseable output — skipped (offline)");
      }
      if (!parsed.tagName) {
        return skip("release lookup returned no tagName — skipped (offline)");
      }
      const latest = normalizeVersionTag(parsed.tagName);
      const installed = normalizeVersionTag(version);
      if (compareVersionSegments(installed, latest) < 0) {
        return warn(
          `installed engine v${installed} is behind the latest release v${latest}`,
          `Run \`npx github:${UPSTREAM_REPO} update\` to refresh the installed skill to v${latest}.`,
        );
      }
      return pass(`installed engine v${installed} is up to date with the latest release v${latest}`);
    },
  });

  // 7. Package install state — only meaningful for npm-ci repos (those with a
  //    package-lock.json at the repo root). Heuristic: node_modules must exist
  //    and not be older than the lock file. `npm ci` is the fix either way.
  checks.push({
    id: "package-install",
    description: "npm dependencies are installed and not stale",
    run: async (deps) => {
      const lockPath = path.join(config.repo_dir, "package-lock.json");
      const nmPath = path.join(config.repo_dir, "node_modules");
      if (!(await deps.fsExists(lockPath))) {
        return skip("no package-lock.json at the repo root — npm install state is not applicable");
      }
      if (!(await deps.fsExists(nmPath))) {
        return fail(
          "node_modules is missing",
          "Run `npm ci` in the repo to install dependencies before starting a run.",
        );
      }
      const lockMtime = await deps.fileMtime(lockPath);
      const nmMtime = await deps.fileMtime(nmPath);
      if (lockMtime !== null && nmMtime !== null && lockMtime > nmMtime) {
        return fail(
          "package-lock.json is newer than node_modules — dependencies may be stale",
          "Run `npm ci` to bring node_modules in sync with package-lock.json.",
        );
      }
      return pass("node_modules is present and not older than package-lock.json");
    },
  });

  // 7. OpenSpec CLI (conditional) — only when OpenSpec is active for this repo
  //    (`openspec.enabled: on`, or `auto` with an `openspec/` directory present).
  checks.push({
    id: "openspec-cli",
    description: "OpenSpec CLI is available when OpenSpec is active",
    run: async (deps) => {
      const mode = config.openspec.enabled;
      if (mode === "off") return skip("OpenSpec is disabled (`openspec.enabled: off`)");
      // For "auto", activation depends on an openspec/ directory; resolve it via
      // the deps seam so the decision stays testable without real fs access.
      const active =
        mode === "on" || (mode === "auto" && (await deps.fsExists(path.join(config.repo_dir, "openspec"))));
      if (!active) {
        return skip("OpenSpec not active for this repo (no `openspec/` directory)");
      }
      return (await deps.execCheck("openspec", ["--version"]))
        ? pass("`openspec` is available")
        : fail(
            "`openspec` was not found on PATH but OpenSpec is active for this repo",
            "Install the OpenSpec CLI (e.g. `npm i -g @openspec/cli`) — it is required because OpenSpec is enabled for this repo.",
          );
    },
  });

  // 8. Plugin mirror check (conditional) — for repos that have a generated
  //    `plugin/` mirror driven by `scripts/build.mjs` (the agent-pipeline golden
  //    rule). Running `node scripts/build.mjs --check` without actually building
  //    catches stale mirrors before CI does. The check is guarded by the presence
  //    of both artifacts so it is a no-op in repos without this pattern.
  checks.push({
    id: "plugin-mirror",
    description: "Generated plugin/ mirror is in sync with core/ (scripts/build.mjs --check)",
    run: async (deps) => {
      const buildScript = path.join(config.repo_dir, "scripts", "build.mjs");
      const pluginDir = path.join(config.repo_dir, "plugin");
      if (!(await deps.fsExists(buildScript)) || !(await deps.fsExists(pluginDir))) {
        return skip("no scripts/build.mjs or plugin/ directory — plugin mirror check is not applicable");
      }
      return (await deps.execCheck("node", [buildScript, "--check"]))
        ? pass("plugin/ mirror is in sync with core/")
        : fail(
            "plugin/ mirror is out of sync with core/",
            "Run `node scripts/build.mjs` from the repo root to regenerate the plugin/ mirror, then commit the result.",
          );
    },
  });

  // 9. Eval command (conditional) — when the eval gate is enabled with a
  //    configured command, verify its binary resolves on PATH (without running it).
  checks.push({
    id: "eval-command",
    description: "Configured eval command binary is available",
    run: async (deps) => {
      if (!config.eval_gate.enabled || !config.eval_gate.command) {
        return skip("eval gate is not enabled / no command configured");
      }
      const command = config.eval_gate.command;
      // Skip leading VAR=VALUE environment assignments (e.g. `NODE_ENV=test pnpm evals`)
      // and the `env` wrapper (e.g. `env NODE_ENV=test pnpm evals`) to find the real binary.
      const tokens = command.trim().split(/\s+/);
      let bin = "";
      for (const tok of tokens) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue; // skip VAR=value
        if (tok === "env") continue;                          // skip env wrapper
        bin = tok;
        break;
      }
      if (!bin) bin = tokens[0] ?? "";
      // `command -v "$1"` resolves $1 from the positional arg, so the configured
      // command text is never interpolated into the shell line (no injection).
      const ok = await deps.execCheck("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "doctor", bin]);
      return ok
        ? pass(`eval command binary \`${bin}\` is available`)
        : fail(
            `eval command binary \`${bin}\` was not found on PATH`,
            `Install \`${bin}\` or fix \`eval_gate.command\` (\`${command}\`) so its binary resolves on PATH.`,
          );
    },
  });

  return checks;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunPreflightOptions {
  /** Stop at the first failing check instead of collecting all failures. */
  failFast?: boolean;
}

/** Run every applicable preflight check and collect per-check results.
 *  Deterministic and model-free. With `failFast`, stops after the first failure
 *  (later checks are simply absent from the result). `version` is the `VERSION`
 *  constant from `pipeline.ts` and is threaded into `buildPreflightChecks` for
 *  the install:version-coherence check. */
export async function runPreflight(
  config: PipelineConfig,
  deps: DoctorDeps = realDoctorDeps(),
  opts: RunPreflightOptions = {},
  version = "",
): Promise<PreflightResult> {
  const checks = buildPreflightChecks(config, version);
  const outcomes: CheckOutcome[] = [];
  let ok = true;
  for (const check of checks) {
    const result = await check.run(deps);
    outcomes.push({ id: check.id, description: check.description, ...result });
    if (result.status === "fail") {
      ok = false;
      if (opts.failFast) break;
    }
  }
  return { schema_version: 1, ok, checks: outcomes, ranAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------------

const SYMBOL: Record<CheckStatus, string> = { pass: "✓", fail: "✗", warn: "!", skip: "–" };

/** Render a per-check pass/fail/warn/skip summary with remediation text on
 *  failures and warnings. */
export function formatDoctorSummary(result: PreflightResult): string {
  const passed = result.checks.filter((c) => c.status === "pass").length;
  const failed = result.checks.filter((c) => c.status === "fail").length;
  const warned = result.checks.filter((c) => c.status === "warn").length;
  const skipped = result.checks.filter((c) => c.status === "skip").length;

  const lines: string[] = [];
  lines.push(
    `Pipeline doctor — ${result.checks.length} checks (${passed} passed, ${failed} failed, ${warned} warned, ${skipped} skipped)`,
  );
  lines.push("");
  for (const c of result.checks) {
    lines.push(`  ${SYMBOL[c.status]} ${c.id} — ${c.detail}`);
    if ((c.status === "fail" || c.status === "warn") && c.remediation) {
      lines.push(`      → ${c.remediation}`);
    }
  }
  lines.push("");
  lines.push(`Result: ${result.ok ? "PASS" : "FAIL"}  (ran ${result.ranAt})`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON formatter (#154)
// ---------------------------------------------------------------------------

export interface DoctorJsonCheck {
  name: string;
  status: CheckStatus;
  ok: boolean;
  reason: string;
  fix: string;
}

export interface DoctorJsonEnvelope {
  schema_version: "1";
  status: "ok" | "warnings" | "error";
  checks: DoctorJsonCheck[];
}

/** Map a PreflightResult to the stable JSON envelope for `pipeline doctor --json`.
 *  Reuses the same runPreflight result as the prose path — no duplicate check logic.
 *  Top-level `status` is `"error"` when any check fails (a fail dominates a
 *  co-occurring warn), `"warnings"` when at least one check warns and none fail,
 *  else `"ok"`. */
export function formatDoctorJson(result: PreflightResult): DoctorJsonEnvelope {
  const hasFail = result.checks.some((c) => c.status === "fail");
  const hasWarn = result.checks.some((c) => c.status === "warn");
  return {
    schema_version: "1",
    status: hasFail ? "error" : hasWarn ? "warnings" : "ok",
    checks: result.checks.map((c) => ({
      name: c.id,
      status: c.status,
      ok: c.status !== "fail",
      reason: c.detail,
      fix: c.status === "fail" || c.status === "warn" ? (c.remediation ?? "") : "",
    })),
  };
}

// ---------------------------------------------------------------------------
// Result persistence — stored under /tmp (NOT in the repo), so the result file
// never shows up as an untracked change that the worktree-clean check would
// itself flag, and never risks being committed. Keyed by domain, mirroring the
// `/tmp/pipeline-{domain}*` convention used by the lock + kill switch.
// ---------------------------------------------------------------------------

export function doctorResultPath(domain: string): string {
  return `/tmp/pipeline-${domain}-doctor-result.json`;
}

/** Persist the latest preflight result for `--status` to surface. Best-effort:
 *  a write failure is logged but never aborts the run. String fields are
 *  redaction/injection-sanitized at the FIELD level (before serialization) so
 *  secrets/role-markers cannot survive JSON-escaping (`KEY=\"x\"`, escaped
 *  newlines), with a final whole-document pass as defense-in-depth (#161). */
export async function storePreflightResult(
  config: Pick<PipelineConfig, "domain">,
  result: PreflightResult,
): Promise<void> {
  try {
    const cleaned = sanitizeDeep(result);
    const serialized = sanitize(redactSecrets(`${JSON.stringify(cleaned, null, 2)}\n`));
    await fs.promises.writeFile(doctorResultPath(config.domain), serialized, "utf8");
  } catch (err) {
    console.warn(`[pipeline] doctor: could not persist preflight result: ${(err as Error).message}`);
  }
}

/** Load the latest stored preflight result, or null when none exists / is unreadable. */
export async function loadLatestPreflightResult(
  config: Pick<PipelineConfig, "domain">,
): Promise<PreflightResult | null> {
  try {
    const text = await fs.promises.readFile(doctorResultPath(config.domain), "utf8");
    const parsed = JSON.parse(text) as PreflightResult;
    if (parsed && Array.isArray(parsed.checks) && typeof parsed.ranAt === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
