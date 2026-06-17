// Intake sub-command (#158): takes a short description, generates a structured
// issue spec via a model harness, creates a GitHub issue, and proposes a
// ROADMAP.md update (release-plan row, per-issue row, detail bullet) as a
// branch + PR for human review.
//
// All external I/O is injected via IntakeDeps so unit tests use no real
// network, git, or subprocess calls.

import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { invoke } from "../harness.ts";
import { buildIntakePrompt } from "../prompts/index.ts";
import {
  insertReleasePlanRow,
  insertPerIssueRow,
  insertDetailSectionBullet,
  computeUnifiedDiff,
} from "./release.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IntakeOpts {
  description: string;
  /** Pinned release slot (e.g. "v1.6.0"). When absent, infer from ROADMAP. */
  release?: string;
  dryRun?: boolean;
}

export interface IntakeDeps {
  /** Invoke the spec-generation model harness with the given prompt. Returns the raw output. */
  runHarness(prompt: string): Promise<{ success: boolean; output: string }>;
  /** Create a GitHub issue and return its number. */
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  /**
   * Read a file at a specific git ref (e.g. origin/<baseBranch>) without
   * modifying the working tree. relPath is repo-relative (e.g. "ROADMAP.md").
   * This ensures mutations are computed from the integration branch's content,
   * not a potentially-stale caller checkout.
   */
  readFileAtBase(repoDir: string, baseBranch: string, relPath: string): string;
  /** Generic local file read (for writes only — ROADMAP reads use readFileAtBase). */
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  /**
   * Ensure a GitHub label exists (creates it with the given color when absent,
   * idempotent via --force). Must be called before createIssue so that issue
   * creation with that label never fails due to a missing label.
   */
  ensureLabel(repoDir: string, name: string, color: string): Promise<void>;
  /**
   * Throw if ROADMAP.md has uncommitted local changes in the working tree.
   * Prevents overwriting in-progress edits with the intake write.
   */
  gitEnsureClean(repoDir: string): void;
  /**
   * Create and checkout a new branch starting from origin/<fromRef> so the
   * roadmap PR is always based on the integration branch, not the caller's HEAD.
   */
  gitCreateBranch(repoDir: string, branch: string, fromRef: string): void;
  /** Stage the given files and commit. */
  gitCommit(repoDir: string, files: string[], message: string): void;
  /** Push branch and open a PR. Returns the PR URL. */
  createPR(repoDir: string, title: string, body: string, base: string, head: string): Promise<string>;
  log(msg: string): void;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

export function realIntakeDeps(repoDir: string): IntakeDeps {
  return {
    runHarness: async (prompt) => {
      const result = await invoke("claude", repoDir, prompt, { stream: true });
      return { success: result.success, output: result.stdout };
    },
    createIssue: async (title, body, labels) => {
      const args = ["issue", "create", "--title", title, "--body", body];
      for (const label of labels) {
        args.push("--label", label);
      }
      const result = spawnSync("gh", args, {
        encoding: "utf8",
        stdio: "pipe",
        cwd: repoDir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline intake] gh issue create failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const url = result.stdout.trim();
      // gh issue create prints the URL; extract the issue number from it.
      const m = url.match(/\/(\d+)$/);
      if (!m) {
        throw new Error(`[pipeline intake] could not parse issue number from gh output: ${url}`);
      }
      return Number(m[1]);
    },
    readFileAtBase: (dir, baseBranch, relPath) => {
      // Read the file at origin/<baseBranch> without touching the working tree.
      // This ensures mutations are computed from the integration branch's content
      // even when intake is run from a feature worktree or a stale checkout.
      // A failure here also serves as a preflight: if origin/<baseBranch> is not
      // accessible, we bail before creating any irreversible GitHub issue.
      const result = spawnSync("git", ["show", `origin/${baseBranch}:${relPath}`], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline intake] could not read ${relPath} from origin/${baseBranch} (exit ${result.status}): ` +
            `${result.stderr?.trim() ?? ""}.\n` +
            `  Ensure origin/${baseBranch} is fetched: git fetch origin ${baseBranch}`,
        );
      }
      return result.stdout;
    },
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf8"),
    ensureLabel: async (dir, name, color) => {
      // gh label create --force is idempotent: creates if absent, updates if present.
      const result = spawnSync("gh", ["label", "create", name, "--color", color, "--force"], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline intake] could not ensure label "${name}" (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
    },
    gitEnsureClean: (dir) => {
      const result = spawnSync("git", ["status", "--porcelain", "--", "ROADMAP.md"], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline intake] git status failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const dirty = result.stdout.trim();
      if (dirty) {
        throw new Error(
          `[pipeline intake] ROADMAP.md has uncommitted local changes — stash or commit them before running intake.\n` +
            `  Dirty: ${dirty}`,
        );
      }
    },
    gitCreateBranch: (dir, branch, fromRef) => {
      const result = spawnSync("git", ["checkout", "-b", branch, `origin/${fromRef}`], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline intake] git checkout -b ${branch} origin/${fromRef} failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
    },
    gitCommit: (dir, files, message) => {
      const addResult = spawnSync("git", ["add", "--", ...files], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (addResult.status !== 0) {
        throw new Error(
          `[pipeline intake] git add failed (exit ${addResult.status}): ${addResult.stderr?.trim() ?? ""}`,
        );
      }
      const commitResult = spawnSync("git", ["commit", "-m", message], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (commitResult.status !== 0) {
        throw new Error(
          `[pipeline intake] git commit failed (exit ${commitResult.status}): ${commitResult.stderr?.trim() ?? ""}`,
        );
      }
    },
    createPR: async (dir, title, body, base, head) => {
      const pushResult = spawnSync("git", ["push", "-u", "origin", head], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (pushResult.status !== 0) {
        throw new Error(
          `[pipeline intake] git push failed (exit ${pushResult.status}): ${pushResult.stderr?.trim() ?? ""}`,
        );
      }
      const prResult = spawnSync(
        "gh",
        ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", head],
        { encoding: "utf8", stdio: "pipe", cwd: dir },
      );
      if (prResult.status !== 0) {
        throw new Error(
          `[pipeline intake] gh pr create failed (exit ${prResult.status}): ${prResult.stderr?.trim() ?? ""}`,
        );
      }
      return prResult.stdout.trim();
    },
    log: (msg) => process.stdout.write(msg + "\n"),
  };
}

// ---------------------------------------------------------------------------
// Release-slot inference
// ---------------------------------------------------------------------------

/**
 * Infer the first open (not yet shipped) release slot from the release-plan
 * table. A row is "open" when it does NOT contain "✅ shipped". Returns the
 * version string (e.g. "1.6.0") or undefined when none is found.
 */
export function inferReleaseSlot(roadmapText: string): string | undefined {
  const lines = roadmapText.split("\n");
  for (const line of lines) {
    if (!line.startsWith("| **v")) continue;
    if (line.includes("✅ shipped")) continue;
    if (line.startsWith("| *(none)*")) continue;
    // Extract version: "| **v1.6.0** |" → "1.6.0"
    const m = line.match(/^\| \*\*v(\d+\.\d+\.\d+)\*\*/);
    if (m) return m[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

/**
 * Extract the title and body from the raw harness output.
 * The harness output is expected to start with `# <title>` followed by the
 * spec sections. Returns the raw text as the body, and the first H1 heading
 * as the title. Falls back gracefully when the heading is absent.
 */
export function parseSpec(raw: string): { title: string; body: string } {
  const lines = raw.trim().split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? titleLine.replace(/^# /, "").trim() : "New feature (intake)";
  return { title, body: raw.trim() };
}

/**
 * Derive a one-line description from the spec body for use in the ROADMAP
 * detail section bullet. Uses the Summary section's first sentence.
 */
export function extractOneLiner(body: string): string {
  const summaryMatch = body.match(/^## Summary\s*\n+([\s\S]*?)(?=^##|\Z)/m);
  if (!summaryMatch) return "New issue from intake.";
  const summary = summaryMatch[1].trim();
  const firstSentence = summary.split(/\.\s+/)[0];
  return firstSentence.endsWith(".") ? firstSentence : firstSentence + ".";
}

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

const REQUIRED_SPEC_SECTIONS = [
  "## Summary",
  "## User story",
  "## Acceptance criteria",
  "## Out of scope",
];

/**
 * Validate that the harness-generated spec body contains the required sections
 * and at least one checkable acceptance criterion. Throws a descriptive error
 * so the caller can bail out before creating any GitHub issue.
 */
export function validateSpecBody(body: string): void {
  const missing = REQUIRED_SPEC_SECTIONS.filter((s) => !body.includes(s));
  if (missing.length > 0) {
    throw new Error(
      `[pipeline intake] generated spec is missing required sections: ${missing.join(", ")}.\n` +
        `  Required: Summary, User story, Acceptance criteria, Out of scope.\n` +
        `  Raw output (first 500 chars):\n${body.slice(0, 500)}`,
    );
  }
  if (!body.includes("- [ ]")) {
    throw new Error(
      `[pipeline intake] generated spec has no checkable acceptance criteria (expected "- [ ]" items).\n` +
        `  Raw output (first 500 chars):\n${body.slice(0, 500)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runIntake(
  opts: IntakeOpts,
  cfg: { repo_dir: string; repo: string; base_branch: string },
  deps?: IntakeDeps,
): Promise<void> {
  const d = deps ?? realIntakeDeps(cfg.repo_dir);
  const repoDir = cfg.repo_dir;
  const roadmapPath = path.join(repoDir, "ROADMAP.md");

  // 1. Validate inputs.
  if (!opts.description || !opts.description.trim()) {
    throw new Error(
      `[pipeline intake] a description is required.\n` +
        `  Usage: pipeline intake --description "<text>"  OR  pipeline intake "<text>"`,
    );
  }
  if (/^\d+$/.test(opts.description.trim())) {
    throw new Error(
      `[pipeline intake] "${opts.description.trim()}" looks like an issue number, not a description.\n` +
        `  The intake sub-command requires a description string, not an issue number.\n` +
        `  Usage: pipeline intake --description "<text>"`,
    );
  }
  if (opts.release !== undefined && !/^\d+\.\d+\.\d+$/.test(opts.release)) {
    const withV = opts.release.startsWith("v") ? opts.release.slice(1) : null;
    if (!withV || !/^\d+\.\d+\.\d+$/.test(withV)) {
      throw new Error(
        `[pipeline intake] invalid --release value: "${opts.release}".\n` +
          `  Expected a semver string like "v1.6.0" or "1.6.0".`,
      );
    }
  }

  // 2. Read ROADMAP from origin/<base_branch> — not the caller's working tree.
  //    This ensures release-slot inference, context, and mutations are all based
  //    on the integration branch's content, regardless of the caller's local
  //    checkout state.  A failure here also acts as a preflight: if
  //    origin/<base_branch> is inaccessible, we bail before any GitHub writes.
  const roadmapAtBase = d.readFileAtBase(repoDir, cfg.base_branch, "ROADMAP.md");

  // Normalize release slot — strip leading "v" for internal use.
  let version: string;
  if (opts.release) {
    version = opts.release.startsWith("v") ? opts.release.slice(1) : opts.release;
  } else {
    // 3. Infer from the base-branch ROADMAP.
    const inferred = inferReleaseSlot(roadmapAtBase);
    if (!inferred) {
      throw new Error(
        `[pipeline intake] could not infer a release slot from ROADMAP.md — ` +
          `pass --release vX.Y.Z to pin the target version.`,
      );
    }
    version = inferred;
    d.log(`[pipeline intake] proposed release slot: v${version}`);
  }

  // 4. Extract ROADMAP context for the harness prompt.
  const releaseContext = extractReleaseContext(roadmapAtBase, version);

  // 5. Build and invoke the spec-generation prompt.
  d.log(`[pipeline intake] generating spec via model harness...`);
  const prompt = buildIntakePrompt({
    description: opts.description.trim(),
    repoContext: cfg.repo || path.basename(repoDir),
    roadmapContext: releaseContext,
  });

  const harnessResult = await d.runHarness(prompt);
  if (!harnessResult.success) {
    throw new Error(
      `[pipeline intake] spec-generation harness failed — check the output above for details.`,
    );
  }

  const { title, body: specBody } = parseSpec(harnessResult.output);
  const oneLiner = extractOneLiner(specBody);

  d.log(`[pipeline intake] spec generated: "${title}"`);

  // 6. Validate the generated spec body — fail early before any irreversible action.
  validateSpecBody(specBody);

  // 7. Precompute roadmap mutations with a placeholder issue number to validate all
  //    ROADMAP anchors exist.  Uses base-branch content so anchor validation reflects
  //    the integration branch, not a potentially-stale caller worktree.
  //    This must succeed before creating any GitHub issue so anchor drift never leaves
  //    behind an orphaned issue with no roadmap PR.
  const prevalidatedRoadmap = applyRoadmapMutations(roadmapAtBase, version, 0, title, oneLiner);

  // Dry-run path: print proposed body + diff and exit without any writes.
  if (opts.dryRun) {
    const diff = computeUnifiedDiff(roadmapAtBase, prevalidatedRoadmap, "a/ROADMAP.md", "b/ROADMAP.md");
    d.log("\n=== Proposed issue body ===\n");
    d.log(specBody);
    d.log("\n=== Proposed ROADMAP.md diff ===\n");
    d.log(diff || "(no changes)");
    return;
  }

  // 8. Git preflight: ensure ROADMAP.md has no uncommitted local changes so we do
  //    not silently lose in-progress edits when gitCreateBranch checks out the
  //    base branch (git checkout rejects conflicting local changes).
  d.gitEnsureClean(repoDir);

  // 9. Ensure both required labels exist before issue creation.  Intake bypasses
  //    the normal `pipeline init` label-bootstrap path, so release:vX.Y.Z labels
  //    (dynamically named) and pipeline:ready may be absent in a fresh repo.
  await d.ensureLabel(repoDir, "pipeline:ready", "1D76DB");
  await d.ensureLabel(repoDir, `release:v${version}`, "e4e669");

  // 10. Create the GitHub issue — only after all deterministic prerequisites pass.
  d.log(`[pipeline intake] creating GitHub issue...`);
  const labels = [`pipeline:ready`, `release:v${version}`];
  const issueNumber = await d.createIssue(title, specBody, labels);
  d.log(`[pipeline intake] created issue #${issueNumber}: ${title}`);

  // 11. Apply the three ROADMAP mutations with the real issue number.
  const mutatedRoadmap = applyRoadmapMutations(roadmapAtBase, version, issueNumber, title, oneLiner);

  // 12. Create a branch FROM the base branch, write ROADMAP, commit, and open PR.
  //     Wrap in try-catch: if any post-issue step fails, the issue is already live
  //     so log a recovery command so the user can complete the roadmap PR manually.
  const slug = slugifyTitle(title);
  const branch = `intake/issue-${issueNumber}-${slug}`;
  const prTitle = `intake: ROADMAP slot for #${issueNumber} — ${title}`;
  try {
    d.log(`[pipeline intake] creating branch ${branch} from origin/${cfg.base_branch}...`);
    d.gitCreateBranch(repoDir, branch, cfg.base_branch);

    d.writeFile(roadmapPath, mutatedRoadmap);
    d.log(`[pipeline intake] wrote ROADMAP.md`);

    const commitMsg =
      `docs: ROADMAP — intake #${issueNumber} (${title})\n\n` +
      `Issue: #158\nPipeline-Run: 158/2026-06-17T02:48:33Z`;
    d.gitCommit(repoDir, ["ROADMAP.md"], commitMsg);

    const prBody = buildPRBody(issueNumber, title, specBody, version);
    const prUrl = await d.createPR(repoDir, prTitle, prBody, cfg.base_branch, branch);

    d.log(`[pipeline intake] roadmap PR opened: ${prUrl}`);
    d.log(`[pipeline intake] done — issue #${issueNumber} created; roadmap PR: ${prUrl}`);
  } catch (err) {
    d.log(
      `\n[pipeline intake] ERROR: issue #${issueNumber} was created but the roadmap PR step failed.\n` +
        `  Recovery — complete the roadmap PR manually:\n` +
        `    git checkout -b ${branch} origin/${cfg.base_branch}\n` +
        `    # Add ROADMAP.md: release-plan row, per-issue row, detail bullet for #${issueNumber} at v${version}\n` +
        `    git add ROADMAP.md && git commit -m "docs: ROADMAP — intake #${issueNumber} (${title})"\n` +
        `    git push -u origin ${branch}\n` +
        `    gh pr create --title "${prTitle}" --base ${cfg.base_branch} --head ${branch}`,
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyRoadmapMutations(
  text: string,
  version: string,
  issueNumber: number,
  title: string,
  oneLiner: string,
): string {
  const issueRef = issueNumber > 0 ? `#${issueNumber}` : "#TBD";
  let mutated = text;
  mutated = insertReleasePlanRow(
    mutated,
    version,
    "minor",
    title,
    issueRef,
    `${oneLiner} Additive; existing flows unchanged.`,
  );
  mutated = insertPerIssueRow(
    mutated,
    issueNumber > 0 ? issueNumber : "TBD",
    "minor",
    "new sub-command",
    "intake",
    version,
    "—",
  );
  mutated = insertDetailSectionBullet(
    mutated,
    version,
    `**${issueRef}** — ${oneLiner}`,
  );
  return mutated;
}

function extractReleaseContext(roadmapText: string, version: string): string {
  // Look for the detail section heading for this version.
  const lines = roadmapText.split("\n");
  const headingRe = new RegExp(`^### v${escapeRegex(version)}`);
  const headingIdx = lines.findIndex((l) => headingRe.test(l));
  if (headingIdx !== -1) {
    // Return the heading line + a few following lines as context.
    const slice = lines.slice(headingIdx, headingIdx + 5).join("\n");
    return slice;
  }
  // Fall back to the release-plan table row for this version.
  const tableRow = lines.find((l) => l.startsWith(`| **v${version}**`));
  if (tableRow) return tableRow;
  return `v${version}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function buildPRBody(
  issueNumber: number,
  title: string,
  specBody: string,
  version: string,
): string {
  const summaryMatch = specBody.match(/^## Summary\s*\n+([\s\S]*?)(?=^##)/m);
  const summary = summaryMatch ? summaryMatch[1].trim() : "(see issue body)";
  return [
    `## ROADMAP slot: #${issueNumber} — ${title}`,
    "",
    `**Release:** v${version}`,
    "",
    "### Summary",
    "",
    summary,
    "",
    "---",
    "",
    `This PR was opened by \`pipeline intake\`. Review the roadmap placement and merge when satisfied.`,
    "",
    "_The pipeline never merges — a human owns this button._",
  ].join("\n");
}
