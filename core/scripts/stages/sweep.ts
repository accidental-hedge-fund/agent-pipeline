// Sweep sub-command (#168): a batch maintenance pass over the open backlog and
// ROADMAP.md in one shot. For each open issue whose body lacks sufficient detail,
// it generates an implementable spec via the model harness following the same
// WHAT-not-HOW contract as the /pm agent. Then it reconciles ROADMAP.md against
// the current open backlog (issues absent from the per-issue table are added).
//
// Without --apply: prints a preview of what would change; no GitHub writes.
// With --apply: updates thin issue bodies in place and opens a ROADMAP PR for
// human review (never commits directly to the default branch).
//
// All external I/O is injected via SweepDeps so unit tests use no real network,
// git, or subprocess calls.

import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { invoke } from "../harness.ts";
import { buildSweepPrompt } from "../prompts/index.ts";
import {
  insertReleasePlanRow,
  insertPerIssueRow,
  insertDetailSectionBullet,
  computeUnifiedDiff,
} from "./release.ts";
import { inferReleaseSlot, extractOneLiner, reservePushArgs } from "./intake.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SweepConfig {
  min_body_length?: number;
  required_sections?: string[];
}

export interface SweepOpts {
  apply?: boolean;
  /** Override the target GitHub repository (owner/repo). Default: current repo from gh config. */
  repo?: string;
}

export interface SweepIssue {
  number: number;
  title: string;
  body: string;
}

export type IssueAction = "specced" | "left-as-is" | "blocked";

export interface ClassifiedIssue {
  issue: SweepIssue;
  action: IssueAction;
  reason: string;
  /** Generated spec body — set when action === "specced". */
  newBody?: string;
}

export interface SweepDeps {
  /** List all open issues in the repo. */
  listIssues(repo: string): Promise<SweepIssue[]>;
  /** Update an issue's body on GitHub. */
  updateIssueBody(repo: string, issueNumber: number, body: string): Promise<void>;
  /** Invoke the spec-generation model harness. */
  runHarness(prompt: string): Promise<{ success: boolean; output: string }>;
  /** Read a local file. */
  readFile(p: string): string;
  /** Write a local file. */
  writeFile(p: string, content: string): void;
  /** Resolve origin/<baseBranch> to an immutable commit SHA. */
  gitResolveBaseSha(repoDir: string, baseBranch: string): string;
  /** Read a file at a specific git ref without touching the working tree. */
  readFileAtBase(repoDir: string, ref: string, relPath: string): string;
  /** Throw if ROADMAP.md has uncommitted local changes. */
  gitEnsureClean(repoDir: string): void;
  /** Create and checkout a new branch starting from the given ref. */
  gitCreateBranch(repoDir: string, branch: string, fromRef: string): void;
  /**
   * Reserve a remote branch ref create-only (fails if the ref already exists).
   * Follows the intake pattern: proves push credentials work before any irreversible
   * issue writes, and prevents branch collisions on same-day reruns.
   */
  reserveRemoteBranch(repoDir: string, branch: string, sha: string): void;
  /** Push the current branch to origin. */
  gitPushBranch(repoDir: string, branch: string): void;
  /** Return a short random token for collision-resistant branch naming. */
  randomToken(): string;
  /** Stage files and commit. */
  gitCommit(repoDir: string, files: string[], message: string): void;
  /** Open a PR; returns the PR URL. */
  createPR(repoDir: string, title: string, body: string, base: string, head: string): Promise<string>;
  /** Return today's date as YYYY-MM-DD. */
  today(): string;
  log(msg: string): void;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

export function realSweepDeps(repoDir: string): SweepDeps {
  return {
    listIssues: async (repo) => {
      // Paginate via gh api to fetch all open issues regardless of count.
      const PAGE_SIZE = 100;
      const all: Array<{ number: number; title: string; body: string }> = [];
      let page = 1;
      while (true) {
        const result = spawnSync(
          "gh",
          [
            "api",
            `repos/${repo}/issues`,
            "--method", "GET",
            "-F", "state=open",
            "-F", `per_page=${PAGE_SIZE}`,
            "-F", `page=${page}`,
          ],
          { encoding: "utf8", stdio: "pipe", cwd: repoDir },
        );
        if (result.status !== 0) {
          throw new Error(
            `[pipeline sweep] gh api issues failed (page ${page}, exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
          );
        }
        const batch = JSON.parse(result.stdout.trim() || "[]") as Array<{ number: number; title: string; body: string | null; pull_request?: unknown }>;
        all.push(...filterOutPullRequests(batch));
        if (batch.length < PAGE_SIZE) break;
        page++;
      }
      return all;
    },
    updateIssueBody: async (repo, issueNumber, body) => {
      const result = spawnSync(
        "gh",
        ["issue", "edit", String(issueNumber), "--repo", repo, "--body", body],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[pipeline sweep] gh issue edit #${issueNumber} failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
    },
    runHarness: async (prompt) => {
      const result = await invoke("claude", repoDir, prompt, { stream: true });
      return { success: result.success, output: result.stdout };
    },
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf8"),
    gitResolveBaseSha: (dir, baseBranch) => {
      const result = spawnSync("git", ["rev-parse", "--verify", `origin/${baseBranch}`], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      const sha = result.stdout?.trim() ?? "";
      if (result.status !== 0 || !/^[0-9a-f]{7,40}$/.test(sha)) {
        throw new Error(
          `[pipeline sweep] could not resolve origin/${baseBranch} to a SHA (exit ${result.status}): ` +
            `${result.stderr?.trim() ?? ""}.`,
        );
      }
      return sha;
    },
    readFileAtBase: (dir, ref, relPath) => {
      const result = spawnSync("git", ["show", `${ref}:${relPath}`], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline sweep] could not read ${relPath} at ${ref} (exit ${result.status}): ` +
            `${result.stderr?.trim() ?? ""}.`,
        );
      }
      return result.stdout;
    },
    gitEnsureClean: (dir) => {
      const result = spawnSync("git", ["status", "--porcelain", "--", "ROADMAP.md"], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline sweep] git status failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const dirty = result.stdout.trim();
      if (dirty) {
        throw new Error(
          `[pipeline sweep] ROADMAP.md has uncommitted local changes — stash or commit them before running sweep.\n` +
            `  Dirty: ${dirty}`,
        );
      }
    },
    gitCreateBranch: (dir, branch, fromRef) => {
      const result = spawnSync("git", ["checkout", "-b", branch, fromRef], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline sweep] git checkout -b ${branch} ${fromRef} failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
    },
    reserveRemoteBranch: (dir, branch, sha) => {
      const result = spawnSync("git", reservePushArgs(branch, sha), {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      const statusLine = out.split("\n").find((l) => l.includes(`:refs/heads/${branch}`)) ?? "";
      const flag = statusLine.charAt(0);
      if (result.status === 0 && flag === "*") return; // newly created — reserved
      if (flag === "!" || flag === "=" || /stale info/i.test(out)) {
        throw new Error(
          `[pipeline sweep] branch ${branch} already exists on origin — aborting before any issue writes.\n` +
            `  A concurrent or prior sweep run reserved it; re-run to get a fresh branch name.`,
        );
      }
      throw new Error(
        `[pipeline sweep] could not reserve origin/${branch} via git push (exit ${result.status}): ${(result.stderr || result.stdout || "").trim()}\n` +
          `  The branch may already exist, or push credentials are missing or read-only.`,
      );
    },
    gitPushBranch: (dir, branch) => {
      const result = spawnSync("git", ["push", "-u", "origin", branch], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline sweep] git push origin ${branch} failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
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
          `[pipeline sweep] git add failed (exit ${addResult.status}): ${addResult.stderr?.trim() ?? ""}`,
        );
      }
      const commitResult = spawnSync("git", ["commit", "-m", message], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (commitResult.status !== 0) {
        throw new Error(
          `[pipeline sweep] git commit failed (exit ${commitResult.status}): ${commitResult.stderr?.trim() ?? ""}`,
        );
      }
    },
    createPR: async (dir, title, body, base, head) => {
      const prResult = spawnSync(
        "gh",
        ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", head],
        { encoding: "utf8", stdio: "pipe", cwd: dir },
      );
      if (prResult.status !== 0) {
        throw new Error(
          `[pipeline sweep] gh pr create failed (exit ${prResult.status}): ${prResult.stderr?.trim() ?? ""}`,
        );
      }
      return prResult.stdout.trim();
    },
    today: () => new Date().toISOString().slice(0, 10),
    randomToken: () => crypto.randomBytes(3).toString("hex"),
    log: (msg) => process.stdout.write(msg + "\n"),
  };
}

// ---------------------------------------------------------------------------
// PR filter (Finding 1)
// ---------------------------------------------------------------------------

/**
 * Filter out pull requests from the GitHub REST /issues API response.
 * The /repos/{owner}/{repo}/issues endpoint includes PRs; items with a
 * `pull_request` field MUST be excluded to prevent sweep from rewriting active
 * PR descriptions and adding PR numbers to ROADMAP.md as if they were issues.
 */
export function filterOutPullRequests(
  items: Array<{ number: number; title: string; body: string | null; pull_request?: unknown }>,
): Array<{ number: number; title: string; body: string }> {
  return items
    .filter((i) => !i.pull_request)
    .map((i) => ({ number: i.number, title: i.title, body: i.body ?? "" }));
}

// ---------------------------------------------------------------------------
// Sufficiency heuristic
// ---------------------------------------------------------------------------

const DEFAULT_MIN_BODY_LENGTH = 150;
const DEFAULT_REQUIRED_SECTIONS = ["Summary", "User story", "Acceptance criteria", "Out of scope"];

/**
 * Classify an issue body as sufficient (true) or thin (false).
 *
 * An issue is sufficient when ALL three conditions hold:
 *   (a) body character count >= min_body_length (default 150)
 *   (b) at least 2 required section headings are present (e.g. "## Summary")
 *   (c) the body is not a single sentence (contains at least one newline with content)
 */
export function isSufficient(body: string, config: SweepConfig = {}): boolean {
  const minLen = config.min_body_length ?? DEFAULT_MIN_BODY_LENGTH;
  const requiredSections = config.required_sections ?? DEFAULT_REQUIRED_SECTIONS;

  if (!body || body.trim().length < minLen) return false;

  const sectionCount = requiredSections.filter((s) =>
    body.includes(`## ${s}`),
  ).length;
  if (sectionCount < 2) return false;

  // Single-sentence check: body has content on at least 2 non-empty lines.
  const nonEmptyLines = body.split("\n").filter((l) => l.trim().length > 0);
  if (nonEmptyLines.length < 2) return false;

  return true;
}

// ---------------------------------------------------------------------------
// ROADMAP presence checks
// ---------------------------------------------------------------------------

/**
 * Check if an issue number is already present in the per-issue sem-ver table.
 * This is the definitive presence indicator: a `| #N |` row in the table.
 */
export function isIssueInPerIssueTable(roadmapText: string, issueNum: number): boolean {
  // Match "| #N |" at the start of a table row (with possible leading space).
  return roadmapText.includes(`| #${issueNum} |`);
}

/**
 * Check if an issue number is referenced in the release-plan table.
 * Matches both versioned rows (`| **v...`) and the no-release row (`| *(none)*`),
 * which `| **v...`-only filtering missed (Finding 3).
 *
 * Uses a word-boundary regex so #15 does not false-positive when only #158 is
 * present (the substring "#15" appears inside "#158").
 */
export function isIssueInReleasePlanTable(roadmapText: string, issueNum: number): boolean {
  const pattern = new RegExp(`#${issueNum}(?!\\d)`);
  const lines = roadmapText.split("\n");
  for (const line of lines) {
    if (!line.startsWith("| **v") && !line.startsWith("| *(none)*")) continue;
    if (pattern.test(line)) return true;
  }
  return false;
}

/**
 * Check if an issue number appears in any detail-section bullet (lines starting
 * with "- " inside a `### v` section).
 *
 * Uses a word-boundary regex so #15 does not false-positive when only #158 is
 * present (the substring "#15" appears inside "#158").
 */
export function isIssueInDetailSections(roadmapText: string, issueNum: number): boolean {
  const pattern = new RegExp(`#${issueNum}(?!\\d)`);
  const lines = roadmapText.split("\n");
  let inDetailSection = false;
  for (const line of lines) {
    if (line.startsWith("### v")) { inDetailSection = true; continue; }
    if (inDetailSection && line.startsWith("## ")) { inDetailSection = false; continue; }
    if (inDetailSection && line.startsWith("- ") && pattern.test(line)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Spec validation (reused from intake contract)
// ---------------------------------------------------------------------------

const REQUIRED_SPEC_SECTIONS = [
  "## Summary",
  "## User story",
  "## Acceptance criteria",
  "## Out of scope",
];

export function validateSweepSpecBody(body: string): void {
  const missing = REQUIRED_SPEC_SECTIONS.filter((s) => !body.includes(s));
  if (missing.length > 0) {
    throw new Error(
      `[pipeline sweep] generated spec is missing required sections: ${missing.join(", ")}.\n` +
        `  Required: Summary, User story, Acceptance criteria, Out of scope.\n` +
        `  Raw output (first 500 chars):\n${body.slice(0, 500)}`,
    );
  }
  if (!body.includes("- [ ]")) {
    throw new Error(
      `[pipeline sweep] generated spec has no checkable acceptance criteria (expected "- [ ]" items).\n` +
        `  Raw output (first 500 chars):\n${body.slice(0, 500)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runSweep(
  opts: SweepOpts,
  cfg: { repo_dir: string; repo: string; base_branch: string },
  sweepConfig: SweepConfig,
  deps?: SweepDeps,
): Promise<void> {
  const d = deps ?? realSweepDeps(cfg.repo_dir);
  const repoDir = cfg.repo_dir;
  const targetRepo = opts.repo ?? cfg.repo;
  const roadmapPath = path.join(repoDir, "ROADMAP.md");

  // Finding 2: --repo must match the local checkout's repo. Sweep reads and commits
  // ROADMAP.md from the local checkout; allowing a different --repo would rewrite
  // issue bodies in one repo while opening the ROADMAP PR from another.
  if (opts.repo && opts.repo !== cfg.repo) {
    throw new Error(
      `[pipeline sweep] --repo "${opts.repo}" differs from the configured repo "${cfg.repo}". ` +
        `Sweep reads and commits ROADMAP.md from the local checkout, which belongs to "${cfg.repo}". ` +
        `Omit --repo or run from a checkout of "${opts.repo}".`,
    );
  }

  if (!opts.apply) {
    d.log("[pipeline sweep] preview mode (dry-run) — no GitHub writes will occur.");
    d.log("  Pass --apply to update issue bodies and open the ROADMAP reconciliation PR.\n");
  }

  // --apply preflight — validate roadmap git state AND reserve the remote branch
  // BEFORE any issue writes (Finding 2). The branch reservation serves two purposes:
  //   (a) It proves the push credential works, so a missing/read-only origin push
  //       fails here — before any issue body is updated — instead of after.
  //   (b) A collision-resistant name (date + random token) prevents same-day reruns
  //       from hitting an existing remote ref and stranding updated issues with no PR.
  let preflightedBaseSha: string | undefined;
  let preflightedRoadmapAtBase: string | null = null;
  let roadmapSkippedInPreflight = false;
  let preflightedBranch: string | undefined;

  if (opts.apply) {
    preflightedBaseSha = d.gitResolveBaseSha(repoDir, cfg.base_branch);
    try {
      preflightedRoadmapAtBase = d.readFileAtBase(repoDir, preflightedBaseSha, "ROADMAP.md");
    } catch (_err) {
      roadmapSkippedInPreflight = true;
    }
    d.gitEnsureClean(repoDir);

    // Compute branch name and reserve it on origin BEFORE any issue writes.
    const preflightToday = d.today();
    preflightedBranch = `sweep/${preflightToday}-roadmap-reconcile-${d.randomToken()}`;
    d.log(`[pipeline sweep] creating local branch ${preflightedBranch} and reserving remote ref...`);
    d.gitCreateBranch(repoDir, preflightedBranch, preflightedBaseSha);
    d.reserveRemoteBranch(repoDir, preflightedBranch, preflightedBaseSha);
    d.log(`[pipeline sweep] remote branch reserved — push credentials verified.\n`);
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Classify and re-spec issues
  // ---------------------------------------------------------------------------

  d.log(`[pipeline sweep] fetching open issues from ${targetRepo}...`);
  const issues = await d.listIssues(targetRepo);
  d.log(`[pipeline sweep] ${issues.length} open issue(s) found.\n`);

  const classified: ClassifiedIssue[] = [];

  for (const issue of issues) {
    const sufficient = isSufficient(issue.body, sweepConfig);
    if (sufficient) {
      classified.push({
        issue,
        action: "left-as-is",
        reason: "already meets the sufficiency threshold",
      });
      continue;
    }

    // Thin issue: invoke the spec-generation harness.
    d.log(`[pipeline sweep] generating spec for #${issue.number}: ${issue.title}...`);
    const prompt = buildSweepPrompt({
      issueTitle: issue.title,
      existingBody: issue.body || "(no description)",
      repoContext: targetRepo,
    });

    let harnessResult: { success: boolean; output: string };
    try {
      harnessResult = await d.runHarness(prompt);
    } catch (err) {
      classified.push({
        issue,
        action: "blocked",
        reason: `harness error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (!harnessResult.success) {
      classified.push({
        issue,
        action: "blocked",
        reason: "harness returned failure (check output above for details)",
      });
      continue;
    }

    try {
      validateSweepSpecBody(harnessResult.output);
    } catch (err) {
      classified.push({
        issue,
        action: "blocked",
        reason: `generated spec failed validation: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    classified.push({
      issue,
      action: "specced",
      reason: isSufficientReason(issue.body, sweepConfig),
      newBody: harnessResult.output.trim(),
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 1b: Print proposed re-specs (dry-run) or apply them (--apply)
  // ---------------------------------------------------------------------------

  const toSpec = classified.filter((c) => c.action === "specced");

  if (!opts.apply) {
    for (const c of toSpec) {
      d.log(`\n=== Proposed spec for #${c.issue.number}: ${c.issue.title} ===\n`);
      d.log(c.newBody ?? "");
    }
  } else {
    for (const c of toSpec) {
      d.log(`[pipeline sweep] updating #${c.issue.number}: ${c.issue.title}...`);
      try {
        await d.updateIssueBody(targetRepo, c.issue.number, c.newBody!);
        d.log(`[pipeline sweep] #${c.issue.number} updated.`);
      } catch (err) {
        // Demote to blocked if the update fails; continue with remaining.
        c.action = "blocked";
        c.reason = `issue update failed: ${err instanceof Error ? err.message : String(err)}`;
        d.log(`[pipeline sweep] #${c.issue.number} update failed: ${c.reason}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Roadmap reconciliation
  // ---------------------------------------------------------------------------

  // Resolve the base SHA and ROADMAP content. In --apply mode, reuse the
  // preflighted values (already validated before issue writes). In dry-run mode,
  // resolve now (no git state changes occur).
  let baseSha: string;
  let roadmapAtBase: string;

  if (opts.apply) {
    if (roadmapSkippedInPreflight) {
      d.log("[pipeline sweep] ROADMAP.md not found at base — skipping roadmap reconciliation.");
      printSummaryReport(d, classified, null, true);
      return;
    }
    baseSha = preflightedBaseSha!;
    roadmapAtBase = preflightedRoadmapAtBase!;
  } else {
    const dryRunBaseSha = d.gitResolveBaseSha(repoDir, cfg.base_branch);
    try {
      roadmapAtBase = d.readFileAtBase(repoDir, dryRunBaseSha, "ROADMAP.md");
    } catch (_err) {
      d.log("[pipeline sweep] ROADMAP.md not found at base — skipping roadmap reconciliation.");
      printSummaryReport(d, classified, null, false);
      return;
    }
    baseSha = dryRunBaseSha;
  }

  const version = inferReleaseSlot(roadmapAtBase);
  if (!version) {
    d.log("[pipeline sweep] no open release slot found in ROADMAP.md — skipping roadmap reconciliation.");
    printSummaryReport(d, classified, null, opts.apply ?? false);
    return;
  }

  // Determine which open issues are absent from each ROADMAP structure.
  type RoadmapDelta = { issue: SweepIssue; oneLiner: string; missingInPerIssue: boolean; missingInReleasePlan: boolean; missingInDetail: boolean };
  const deltas: RoadmapDelta[] = [];

  for (const c of classified) {
    const { issue } = c;
    const missingInPerIssue = !isIssueInPerIssueTable(roadmapAtBase, issue.number);
    const missingInReleasePlan = !isIssueInReleasePlanTable(roadmapAtBase, issue.number);
    const missingInDetail = !isIssueInDetailSections(roadmapAtBase, issue.number);

    if (!missingInPerIssue && !missingInReleasePlan && !missingInDetail) continue;

    // One-liner: prefer from generated spec, fall back to existing body, then title.
    const bodyForOneLiner = c.action === "specced" ? (c.newBody ?? issue.body) : issue.body;
    const oneLiner = extractOneLiner(bodyForOneLiner) || `${issue.title}.`;

    deltas.push({ issue, oneLiner, missingInPerIssue, missingInReleasePlan, missingInDetail });
  }

  // Finding 6: Apply ROADMAP mutations atomically per issue. Each issue's three
  // mutations are applied to a temporary copy; only if ALL succeed is the copy
  // promoted to the live roadmap. A partial success (e.g., release-plan row added
  // but per-issue row missing) is rolled back so the roadmap stays consistent.
  let mutatedRoadmap = roadmapAtBase;
  const roadmapAdded: number[] = [];
  const roadmapErrors: Array<{ issueNum: number; error: string }> = [];

  for (const delta of deltas) {
    let tempRoadmap = mutatedRoadmap;
    try {
      const issueRef = `#${delta.issue.number}`;
      const slugTitle = delta.issue.title.length > 40 ? delta.issue.title.slice(0, 40) + "…" : delta.issue.title;

      if (delta.missingInReleasePlan) {
        tempRoadmap = insertReleasePlanRow(
          tempRoadmap,
          version,
          "minor",
          slugTitle,
          issueRef,
          `${delta.oneLiner} Additive; existing flows unchanged.`,
        );
      }
      if (delta.missingInPerIssue) {
        tempRoadmap = insertPerIssueRow(
          tempRoadmap,
          delta.issue.number,
          "minor",
          "—",
          slugTitle,
          version,
          "—",
        );
      }
      if (delta.missingInDetail) {
        tempRoadmap = insertDetailSectionBullet(
          tempRoadmap,
          version,
          `**${issueRef}** — ${delta.oneLiner}`,
        );
      }
      // All mutations succeeded: promote the temporary copy.
      mutatedRoadmap = tempRoadmap;
      roadmapAdded.push(delta.issue.number);
    } catch (err) {
      roadmapErrors.push({
        issueNum: delta.issue.number,
        error: err instanceof Error ? err.message : String(err),
      });
      // mutatedRoadmap is unchanged (tempRoadmap was the only modified copy).
    }
  }

  // Tracks whether the roadmap delivery (commit + push + PR) failed after issue
  // bodies were already written. Used to adjust the summary report message.
  let roadmapDeliveryBlocked = false;

  if (!opts.apply) {
    const diff = computeUnifiedDiff(roadmapAtBase, mutatedRoadmap, "a/ROADMAP.md", "b/ROADMAP.md");
    d.log("\n=== Proposed ROADMAP.md diff ===\n");
    d.log(diff || "(no changes — all open issues already present in ROADMAP.md)");
    if (roadmapErrors.length > 0) {
      for (const e of roadmapErrors) {
        d.log(`[pipeline sweep] ROADMAP: could not add #${e.issueNum}: ${e.error}`);
      }
    }
  } else if (mutatedRoadmap !== roadmapAtBase) {
    // --apply path: commit the mutated ROADMAP on the already-reserved branch and open a PR.
    // The branch was created + reserved in the preflight (before issue writes), so the push
    // is a fast-forward onto the already-reserved ref over the already-proven credential.
    //
    // Wrap in try/catch: if any delivery step fails after issue bodies have been rewritten,
    // we must still print the summary and recovery instructions rather than aborting with
    // only an uncaught exception. This is the partial-write recovery block.
    const branch = preflightedBranch!;
    const today = d.today();

    try {
      d.writeFile(roadmapPath, mutatedRoadmap);
      const commitMsg =
        `docs: ROADMAP — sweep reconciliation (${today})\n\n` +
        `Added ${roadmapAdded.length} issue(s) to ROADMAP.md: ${roadmapAdded.map((n) => `#${n}`).join(", ")}.\n\n` +
        `Issue: #168\nPipeline-Run: 168/2026-06-17T06:08:26Z`;
      d.gitCommit(repoDir, ["ROADMAP.md"], commitMsg);
      d.gitPushBranch(repoDir, branch);

      const prTitle = `sweep: ROADMAP reconciliation (${today})`;
      const prBody = buildRoadmapPRBody(roadmapAdded, roadmapErrors, today);
      const prUrl = await d.createPR(repoDir, prTitle, prBody, cfg.base_branch, branch);
      d.log(`[pipeline sweep] roadmap reconciliation PR opened: ${prUrl}`);
    } catch (err) {
      roadmapDeliveryBlocked = true;
      d.log(
        `\n[pipeline sweep] ERROR: roadmap delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      d.log(`  Issue bodies above have already been rewritten on GitHub.`);
      d.log(`  Branch "${branch}" has been reserved on origin.`);
      d.log(`  To recover, manually push and open the PR:`);
      d.log(`    git push -u origin ${branch}`);
      d.log(
        `    gh pr create --base ${cfg.base_branch} --head ${branch}` +
          ` --title "sweep: ROADMAP reconciliation (${today})" --body "Manually recovered sweep run."`,
      );
    }

    if (roadmapErrors.length > 0) {
      for (const e of roadmapErrors) {
        d.log(`[pipeline sweep] ROADMAP: could not add #${e.issueNum}: ${e.error}`);
      }
    }
  } else {
    d.log("[pipeline sweep] ROADMAP.md is already in sync — no changes needed.");
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Summary report
  // ---------------------------------------------------------------------------

  const roadmapDelta = {
    added: roadmapAdded.length,
    unchanged: deltas.length === 0 ? classified.length : classified.length - deltas.length,
    errors: roadmapErrors.length,
  };

  printSummaryReport(d, classified, roadmapDelta, opts.apply ?? false, roadmapDeliveryBlocked);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSufficientReason(body: string, config: SweepConfig): string {
  const minLen = config.min_body_length ?? DEFAULT_MIN_BODY_LENGTH;
  const requiredSections = config.required_sections ?? DEFAULT_REQUIRED_SECTIONS;
  const trimmed = (body ?? "").trim();

  if (trimmed.length < minLen) {
    return `body length ${trimmed.length} chars (threshold: ${minLen}), missing sections`;
  }
  const sectionCount = requiredSections.filter((s) => body.includes(`## ${s}`)).length;
  if (sectionCount < 2) {
    const present = requiredSections.filter((s) => body.includes(`## ${s}`));
    const missing = requiredSections.filter((s) => !body.includes(`## ${s}`));
    return `only ${sectionCount} of 2 required sections present (has: ${present.join(", ")}; missing: ${missing.join(", ")})`;
  }
  const nonEmptyLines = (body ?? "").split("\n").filter((l) => l.trim().length > 0);
  if (nonEmptyLines.length < 2) {
    return "single-sentence body";
  }
  return "did not meet sufficiency threshold";
}

function printSummaryReport(
  d: SweepDeps,
  classified: ClassifiedIssue[],
  roadmapDelta: { added: number; unchanged: number; errors: number } | null,
  applied: boolean,
  roadmapDeliveryBlocked = false,
): void {
  d.log("\n=== Sweep Summary ===\n");

  for (const c of classified) {
    const actionStr =
      c.action === "specced"
        ? "specced"
        : c.action === "left-as-is"
          ? "left-as-is"
          : "BLOCKED";
    d.log(`#${c.issue.number} ${c.issue.title} — ${actionStr} (${c.reason})`);
  }

  const total = classified.length;
  const numSpecced = classified.filter((c) => c.action === "specced").length;
  const numLeftAsIs = classified.filter((c) => c.action === "left-as-is").length;
  const numBlocked = classified.filter((c) => c.action === "blocked").length;

  d.log(`\n${total} inspected, ${numSpecced} re-specced, ${numLeftAsIs} left-as-is, ${numBlocked} blocked`);

  if (roadmapDelta !== null) {
    d.log(`\nROADMAP delta: ${roadmapDelta.added} issue(s) added, ${roadmapDelta.unchanged} already present, ${roadmapDelta.errors} error(s)`);
  }

  if (applied && roadmapDeliveryBlocked) {
    d.log("\nIssue bodies updated in place. ROADMAP delivery BLOCKED — see recovery instructions above.");
  } else if (applied) {
    d.log("\nWrites applied: issue bodies updated in place; roadmap change delivered as a branch + PR.");
  } else {
    d.log("\nPreview only — no writes performed. Run with --apply to commit changes.");
  }
}

function buildRoadmapPRBody(added: number[], errors: Array<{ issueNum: number; error: string }>, today: string): string {
  const addedList = added.length > 0
    ? added.map((n) => `- #${n}`).join("\n")
    : "_(no issues added)_";

  const errorSection = errors.length > 0
    ? `\n\n### Issues that could not be added (manual intervention needed)\n\n` +
      errors.map((e) => `- #${e.issueNum}: ${e.error}`).join("\n")
    : "";

  return [
    `## ROADMAP reconciliation — sweep (${today})`,
    "",
    "This PR was opened by `pipeline sweep`. It synchronizes `ROADMAP.md` with the current open backlog.",
    "",
    "### Issues added to ROADMAP.md",
    "",
    addedList,
    errorSection,
    "",
    "---",
    "",
    "Review the placement, adjust release slots as needed, then merge when satisfied.",
    "",
    "_The pipeline never merges — a human owns this button._",
  ].join("\n");
}
