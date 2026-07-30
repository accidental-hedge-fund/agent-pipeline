// Docs-generator freshness gate (#716).
//
// When a worktree ships the repository docs generator (`scripts/generate-docs.mjs`
// and/or a `docs:check` script that invokes it), the post-implementation path
// runs the same freshness check CI runs, optionally auto-heals once, and fails
// closed before push / PR create-or-reuse when the check stays red.
//
// Generator-absent worktrees are fully inert — no generate/check, no heal
// commits, no extra pre-PR blocks.
//
// Auto-heal mirrors build-side-effects clean-tree attribution: require a clean
// tree before generate, commit only post-generate dirt, at most one attempt.

import * as fs from "node:fs";
import * as path from "node:path";
import { gitInWorktree } from "./worktree.ts";
import { runCapped } from "./harness.ts";
import { truncate } from "./stages/eval.ts";

/** Relative path of the canonical docs generator entry point. */
export const DOCS_GENERATOR_REL = path.join("scripts", "generate-docs.mjs");

/** Conventional subject for a docs-regenerate heal commit. */
export function docsRegenerateCommitMessage(issueNumber: number): string {
  return `docs: regenerate generated docs (#${issueNumber})`;
}

const DOCS_TIMEOUT_SEC = 5 * 60;
const MAX_DOCS_OUTPUT = 8000;

export interface DocsFreshnessDeps {
  /** True when `rel` (or absolute) path exists. Defaults to fs.existsSync. */
  fileExists?: (absPath: string) => boolean;
  /** Read + parse root package.json; return null if missing/invalid. */
  readPackageJson?: (wtPath: string) => { scripts?: Record<string, string> } | null;
  /** Run a shell command in the worktree (check or generate). */
  runDocsCommand?: (wtPath: string, command: string) => Promise<{ code: number; output: string }>;
  /** Raw `git status --porcelain` for the worktree. */
  gitStatusPorcelain?: (wtPath: string) => Promise<string>;
  /** Stage every worktree change via `git add -A`. */
  gitAddAll?: (wtPath: string) => Promise<void>;
  /** Create a new commit with the given message (not amend). */
  gitCommit?: (wtPath: string, message: string) => Promise<void>;
}

export type DocsGeneratorSurface = {
  present: true;
  checkCommand: string;
  generateCommand: string;
} | {
  present: false;
};

/**
 * True when a package.json script value invokes the docs generator contract
 * (`generate-docs.mjs` or `generate-docs` path form with optional --check).
 */
export function scriptInvokesDocsGenerator(scriptValue: string | undefined): boolean {
  if (!scriptValue) return false;
  // Match generate-docs.mjs or `node scripts/generate-docs` forms; avoid
  // activating on arbitrary scripts merely named docs:check.
  return /generate-docs(?:\.mjs)?\b/.test(scriptValue);
}

/**
 * Walk an npm scripts map starting from `ci` (and transitively via `npm run X`
 * references) and return true when the graph reaches a docs freshness step.
 * Pure — used by the structural drift-guard and unit tests.
 */
export function ciScriptReachesDocsFreshness(scripts: Record<string, string>): boolean {
  const visited = new Set<string>();
  const queue: string[] = ["ci"];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const body = scripts[name];
    if (typeof body !== "string") continue;
    if (scriptInvokesDocsGenerator(body) && /--check\b/.test(body)) return true;
    if (/\bdocs:check\b/.test(body)) {
      // Direct reference in the chain — if docs:check script itself is the
      // generator contract, that counts; otherwise keep walking.
      const docsCheckBody = scripts["docs:check"];
      if (scriptInvokesDocsGenerator(docsCheckBody)) return true;
      if (docsCheckBody) queue.push("docs:check");
    }
    // Collect `npm run <name>` / `npm run <name> --` targets.
    for (const m of body.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)) {
      queue.push(m[1]!);
    }
  }
  return false;
}

/**
 * Detect whether a worktree is docs-generator-present and which commands to use.
 *
 * Present when:
 * 1. `scripts/generate-docs.mjs` exists, **or**
 * 2. `package.json` defines `docs:check` whose value invokes the generator.
 *
 * An arbitrary `docs:check` that does not invoke the generator does **not** activate.
 */
export function detectDocsGenerator(wtPath: string, deps: DocsFreshnessDeps = {}): DocsGeneratorSurface {
  const exists = deps.fileExists ?? ((p: string) => fs.existsSync(p));
  const readPkg = deps.readPackageJson ?? defaultReadPackageJson;

  const generatorAbs = path.join(wtPath, DOCS_GENERATOR_REL);
  const hasGeneratorFile = exists(generatorAbs);
  const pkg = readPkg(wtPath);
  const scripts = pkg?.scripts ?? {};
  const docsCheckScript = scripts["docs:check"];
  const docsGenerateScript = scripts["docs:generate"];
  const checkInvokes = scriptInvokesDocsGenerator(docsCheckScript);

  if (!hasGeneratorFile && !checkInvokes) {
    return { present: false };
  }

  // Prefer npm script wrappers when they invoke the generator contract.
  const checkCommand =
    checkInvokes && docsCheckScript
      ? "npm run docs:check"
      : hasGeneratorFile
        ? "node scripts/generate-docs.mjs --check"
        : "npm run docs:check"; // script claims generator but file missing — still run npm path

  const generateInvokes = scriptInvokesDocsGenerator(docsGenerateScript);
  const generateCommand =
    generateInvokes && docsGenerateScript
      ? "npm run docs:generate"
      : hasGeneratorFile
        ? "node scripts/generate-docs.mjs"
        : "npm run docs:generate";

  return { present: true, checkCommand, generateCommand };
}

/**
 * Parse stale paths from known generator check output shapes:
 *   generate-docs --check: stale generated docs:
 *     - CHANGELOG.md
 *     - docs/cli.md
 * Returns only path-like tokens from those bullet lines — never invents names.
 */
export function extractStalePaths(output: string): string[] {
  if (!output) return [];
  const lines = output.split(/\r?\n/);
  const paths: string[] = [];
  let inStaleBlock = false;
  for (const line of lines) {
    if (/stale generated docs\s*:/i.test(line)) {
      inStaleBlock = true;
      continue;
    }
    if (inStaleBlock) {
      const bullet = line.match(/^\s*[-*]\s+(\S+)\s*$/);
      if (bullet) {
        paths.push(bullet[1]!);
        continue;
      }
      // Leave the block on a non-bullet, non-blank line (e.g. "Run: …").
      if (line.trim() === "") continue;
      inStaleBlock = false;
    }
  }
  return paths;
}

export type DocsFreshnessResult =
  | { ok: true; ran: false }
  | { ok: true; ran: true; healed: false }
  | { ok: true; ran: true; healed: true; paths: string[] }
  | { ok: false; ran: true; reason: string; stalePaths: string[] };

/**
 * Enforce docs freshness on a worktree HEAD that is about to be pushed / PR'd.
 *
 * Order: detect → check → (optional one-shot auto-heal) → re-check.
 * Does **not** re-run format/test gates — the caller does that when
 * `healed: true` so gate deps stay on the stage surface.
 */
export async function enforceDocsFreshness(
  wtPath: string,
  issueNumber: number,
  deps: DocsFreshnessDeps = {},
): Promise<DocsFreshnessResult> {
  const surface = detectDocsGenerator(wtPath, deps);
  if (!surface.present) {
    return { ok: true, ran: false };
  }

  const runFn = deps.runDocsCommand ?? defaultRunDocsCommand;
  const statusFn = deps.gitStatusPorcelain ?? defaultGitStatusPorcelain;
  const addAllFn = deps.gitAddAll ?? defaultGitAddAll;
  const commitFn = deps.gitCommit ?? defaultGitCommit;

  const checkRes = await runFn(wtPath, surface.checkCommand);
  if (checkRes.code === 0) {
    return { ok: true, ran: true, healed: false };
  }

  // ---- Auto-heal (at most one attempt) ----
  const preStatus = await statusFn(wtPath);
  if (preStatus.trim()) {
    return failClosed(
      "docs freshness check failed and the worktree has uncommitted changes — " +
        "cannot auto-heal without risking an unrelated commit. " +
        "PR open/update withheld for docs freshness.",
      checkRes.output,
    );
  }

  const genRes = await runFn(wtPath, surface.generateCommand);
  if (genRes.code !== 0) {
    return failClosed(
      `docs generator failed while attempting to heal stale generated docs ` +
        `(command: ${surface.generateCommand}). PR open/update withheld for docs freshness.`,
      genRes.output,
      /* inventStaleFromCheck */ false,
    );
  }

  const postStatus = await statusFn(wtPath);
  const paths = parsePorcelainPaths(postStatus);
  if (paths.length === 0) {
    // Generate no-op: tree still clean — fail closed using original check output.
    return failClosed(
      "docs freshness check failed and the generator produced no file changes — " +
        "cannot auto-heal. PR open/update withheld for docs freshness.",
      checkRes.output,
    );
  }

  await addAllFn(wtPath);
  await commitFn(wtPath, docsRegenerateCommitMessage(issueNumber));

  const recheck = await runFn(wtPath, surface.checkCommand);
  if (recheck.code !== 0) {
    return failClosed(
      "docs freshness check still failing after regenerate commit. " +
        "PR open/update withheld for docs freshness.",
      recheck.output,
    );
  }

  return { ok: true, ran: true, healed: true, paths };
}

/**
 * Block-reason builder used by stage wiring so callers share wording.
 */
export function docsFreshnessBlockReason(result: Extract<DocsFreshnessResult, { ok: false }>): string {
  return result.reason;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function failClosed(
  headline: string,
  output: string,
  useStaleFromOutput = true,
): Extract<DocsFreshnessResult, { ok: false }> {
  const stalePaths = useStaleFromOutput ? extractStalePaths(output) : [];
  const staleNote =
    stalePaths.length > 0
      ? `\nStale generated file(s): ${stalePaths.join(", ")}`
      : "";
  const body = truncate(output.trim() || "(no output captured)", MAX_DOCS_OUTPUT);
  const reason =
    `${headline}${staleNote}\n\n\`\`\`\n${body}\n\`\`\``;
  return { ok: false, ran: true, reason, stalePaths };
}

function combineOutput(res: { stdout: string; stderr: string }): string {
  const parts = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean);
  return parts.join("\n").trim() || "(no output captured)";
}

async function defaultRunDocsCommand(
  wtPath: string,
  command: string,
): Promise<{ code: number; output: string }> {
  const res = await runCapped(
    "bash",
    ["-c", `set -o pipefail\n${command}`],
    wtPath,
    DOCS_TIMEOUT_SEC,
    false,
    "docs-freshness",
    { killProcessGroup: true },
  );
  let output = combineOutput(res);
  if (res.timed_out) {
    output = `${output}\n\n[docs command timed out after ${DOCS_TIMEOUT_SEC}s]`;
  }
  return { code: res.success ? 0 : (res.exit_code || 1), output };
}

function defaultReadPackageJson(wtPath: string): { scripts?: Record<string, string> } | null {
  const p = path.join(wtPath, "package.json");
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function defaultGitStatusPorcelain(wtPath: string): Promise<string> {
  const res = await gitInWorktree(wtPath, ["status", "--porcelain"], { ignoreFailure: true });
  return res.stdout;
}

async function defaultGitAddAll(wtPath: string): Promise<void> {
  await gitInWorktree(wtPath, ["add", "-A"]);
}

async function defaultGitCommit(wtPath: string, message: string): Promise<void> {
  await gitInWorktree(wtPath, ["commit", "-m", message]);
}

/** Extracts worktree-relative path(s) from `git status --porcelain` output. */
function parsePorcelainPaths(raw: string): string[] {
  const paths: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3);
    if (pathPart.includes(" -> ")) {
      const dst = pathPart.slice(pathPart.indexOf(" -> ") + 4).trim();
      if (dst) paths.push(dst);
    } else {
      const trimmed = pathPart.trim();
      if (trimmed) paths.push(trimmed);
    }
  }
  return paths;
}
