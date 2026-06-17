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
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  /** Create and checkout a new branch. */
  gitCreateBranch(repoDir: string, branch: string): void;
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
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf8"),
    gitCreateBranch: (dir, branch) => {
      const result = spawnSync("git", ["checkout", "-b", branch], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline intake] git checkout -b ${branch} failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
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

  // Normalize release slot — strip leading "v" for internal use.
  let version: string;
  if (opts.release) {
    version = opts.release.startsWith("v") ? opts.release.slice(1) : opts.release;
  } else {
    // 2. Infer from ROADMAP.
    const roadmapText = d.readFile(roadmapPath);
    const inferred = inferReleaseSlot(roadmapText);
    if (!inferred) {
      throw new Error(
        `[pipeline intake] could not infer a release slot from ROADMAP.md — ` +
          `pass --release vX.Y.Z to pin the target version.`,
      );
    }
    version = inferred;
    d.log(`[pipeline intake] proposed release slot: v${version}`);
  }

  // 3. Read ROADMAP context for the target lane.
  const roadmapTextForContext = d.readFile(roadmapPath);
  const releaseContext = extractReleaseContext(roadmapTextForContext, version);

  // 4. Build and invoke the spec-generation prompt.
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

  // 5. Build roadmap mutations in memory.
  const originalRoadmap = d.readFile(roadmapPath);
  let mutatedRoadmap = originalRoadmap;
  // We insert placeholder mutations that will be updated with the real issue
  // number after issue creation (dry-run uses a placeholder #TBD).
  const ISSUE_PLACEHOLDER = 0; // will be replaced after creation

  // Dry-run path: print proposed body + diff and exit.
  if (opts.dryRun) {
    const dryRoadmap = applyRoadmapMutations(
      originalRoadmap, version, ISSUE_PLACEHOLDER, title, oneLiner,
    );
    const diff = computeUnifiedDiff(originalRoadmap, dryRoadmap, "a/ROADMAP.md", "b/ROADMAP.md");
    d.log("\n=== Proposed issue body ===\n");
    d.log(specBody);
    d.log("\n=== Proposed ROADMAP.md diff ===\n");
    d.log(diff || "(no changes)");
    return;
  }

  // 6. Create the GitHub issue.
  d.log(`[pipeline intake] creating GitHub issue...`);
  const labels = [`pipeline:ready`, `release:v${version}`];
  const issueNumber = await d.createIssue(title, specBody, labels);
  d.log(`[pipeline intake] created issue #${issueNumber}: ${title}`);

  // 7. Apply the three ROADMAP mutations with the real issue number.
  mutatedRoadmap = applyRoadmapMutations(
    originalRoadmap, version, issueNumber, title, oneLiner,
  );

  // 8. Create a branch, write ROADMAP, commit, and open PR.
  const slug = slugifyTitle(title);
  const branch = `intake/issue-${issueNumber}-${slug}`;
  d.log(`[pipeline intake] creating branch ${branch}...`);
  d.gitCreateBranch(repoDir, branch);

  d.writeFile(roadmapPath, mutatedRoadmap);
  d.log(`[pipeline intake] wrote ROADMAP.md`);

  const commitMsg =
    `docs: ROADMAP — intake #${issueNumber} (${title})\n\n` +
    `Issue: #158\nPipeline-Run: 158/2026-06-17T02:48:33Z`;
  d.gitCommit(repoDir, ["ROADMAP.md"], commitMsg);

  const prTitle = `intake: ROADMAP slot for #${issueNumber} — ${title}`;
  const prBody = buildPRBody(issueNumber, title, specBody, version);
  const prUrl = await d.createPR(repoDir, prTitle, prBody, cfg.base_branch, branch);

  d.log(`[pipeline intake] roadmap PR opened: ${prUrl}`);
  d.log(`[pipeline intake] done — issue #${issueNumber} created; roadmap PR: ${prUrl}`);
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
    issueNumber > 0 ? issueNumber : 0,
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
