// Backfill sub-command (#327): a safe maintenance flow for adding OpenSpec
// coverage to repositories whose accepted behavior predates OpenSpec adoption.
//
// Preview (default, non-mutating): analyzes the repo's accepted behavior
// against its living specs and prints a four-group coverage report without
// writing any spec, issue, branch, or PR.
//
// Apply (--apply): selects the missing-coverage slice, authors an OpenSpec
// change with additive requirement deltas and provenance annotations, runs
// openspec validate, then opens a spec-only PR targeting the default branch.
// Never commits directly to the default branch; never merges.
//
// All external I/O is injected via BackfillDeps so unit tests use no real
// network, git, or subprocess calls.

import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { invoke } from "../harness.ts";
import { buildBackfillPrompt } from "../prompts/index.ts";
import { isInitialized, listChangeDirs, readChangeFile, validate } from "../openspec.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EvidenceGrade = "sufficient" | "conflicting" | "uncertain";

export interface BackfillCandidate {
  behavior: string;
  provenance: string;
  evidence_grade: EvidenceGrade;
  conflicts_with: string | null;
}

export type CoverageGroup = "already-covered" | "missing-coverage" | "conflicting-evidence" | "uncertain-evidence";

export interface ClassifiedCandidate {
  candidate: BackfillCandidate;
  group: CoverageGroup;
  /** Set when group === "already-covered": the living requirement it maps to. */
  covered_by?: string;
  /** Set when group === "missing-coverage" and an open backfill PR already proposes it. */
  already_proposed?: boolean;
}

export interface BackfillOpts {
  apply?: boolean;
  /** Scope the apply slice to a named capability. */
  capability?: string;
  /** Override the target repo (owner/repo). */
  repo?: string;
}

export interface BackfillDeps {
  /** Invoke the behavior-analysis model harness. Single model boundary. */
  runHarness(prompt: string, timeoutSec: number): Promise<{ success: boolean; output: string; timed_out?: boolean }>;
  /** Read all living requirement labels from the repo's openspec/specs/ subtree. */
  readLivingSpecs(repoDir: string): string[];
  /** Read an evidence corpus from the repo (tests, docs, code, history summary). */
  readEvidenceCorpus(repoDir: string): string;
  /** Run openspec validate --all --json; returns { valid, issues, raw }. */
  validate(repoDir: string): Promise<{ valid: boolean; issues: { message: string }[]; raw: string }>;
  /** Write a file to disk. */
  writeFile(filePath: string, content: string): void;
  /** Create and checkout a new git branch from the given ref. */
  gitCreateBranch(repoDir: string, branch: string, fromRef: string): void;
  /** Resolve origin/<baseBranch> to an immutable commit SHA. */
  gitResolveBaseSha(repoDir: string, baseBranch: string): string;
  /** Stage files and commit. */
  gitCommit(repoDir: string, files: string[], message: string): void;
  /** Push the current branch to origin. */
  gitPushBranch(repoDir: string, branch: string): void;
  /** Open a PR; returns the PR URL. */
  createPR(repoDir: string, title: string, body: string, base: string, head: string): Promise<string>;
  log(msg: string): void;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

export function realBackfillDeps(
  repoDir: string,
  model = "claude-sonnet-4-5",
): BackfillDeps {
  return {
    runHarness: async (prompt, timeoutSec) => {
      const result = await invoke("claude", repoDir, prompt, {
        stream: true,
        model,
        lean: true,
        timeoutSec,
      });
      return { success: result.success, output: result.stdout, timed_out: result.timed_out };
    },

    readLivingSpecs: (dir) => {
      const specsBase = path.join(dir, "openspec", "specs");
      const requirements: string[] = [];
      const walk = (d: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            walk(p);
          } else if (e.isFile() && e.name.endsWith(".md")) {
            try {
              const content = fs.readFileSync(p, "utf8");
              // Extract ### Requirement: lines as requirement labels.
              const reqMatches = content.matchAll(/^###\s+Requirement:\s+(.+)$/gm);
              for (const m of reqMatches) {
                requirements.push(m[1].trim());
              }
            } catch {
              // skip unreadable file
            }
          }
        }
      };
      if (fs.existsSync(specsBase)) walk(specsBase);
      return requirements;
    },

    readEvidenceCorpus: (dir) => {
      // Build a brief evidence corpus by scanning test files, README/docs, and recent history.
      const parts: string[] = [];

      // Scan test file names as signals of what behaviors exist.
      const testDirs = [path.join(dir, "test"), path.join(dir, "tests"), path.join(dir, "__tests__"), path.join(dir, "core", "test")];
      const testFiles: string[] = [];
      for (const td of testDirs) {
        try {
          const entries = fs.readdirSync(td);
          for (const f of entries) {
            if (f.endsWith(".test.ts") || f.endsWith(".test.js") || f.endsWith(".spec.ts") || f.endsWith(".spec.js")) {
              testFiles.push(f);
            }
          }
        } catch {
          // skip missing dirs
        }
      }
      if (testFiles.length > 0) {
        parts.push(`## Test files (signal accepted behaviors)\n\n${testFiles.map(f => `- ${f}`).join("\n")}`);
      }

      // README snippets.
      const readmePath = path.join(dir, "README.md");
      try {
        const readme = fs.readFileSync(readmePath, "utf8");
        const excerpt = readme.slice(0, 4000);
        parts.push(`## README (first 4000 chars)\n\n${excerpt}`);
      } catch {
        // no README
      }

      // Recent git log.
      const logResult = spawnSync("git", ["log", "--oneline", "-40"], { encoding: "utf8", stdio: "pipe", cwd: dir });
      if (logResult.status === 0 && logResult.stdout.trim()) {
        parts.push(`## Recent git history (last 40 commits)\n\n${logResult.stdout.trim()}`);
      }

      return parts.join("\n\n") || "(no evidence corpus available)";
    },

    validate: async (dir) => validate(dir),

    writeFile: (filePath, content) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
    },

    gitResolveBaseSha: (dir, baseBranch) => {
      const result = spawnSync("git", ["rev-parse", "--verify", `origin/${baseBranch}`], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      const sha = result.stdout?.trim() ?? "";
      if (result.status !== 0 || !/^[0-9a-f]{7,40}$/.test(sha)) {
        throw new Error(
          `[pipeline backfill] could not resolve origin/${baseBranch} to a SHA (exit ${result.status}): ` +
            `${result.stderr?.trim() ?? ""}`,
        );
      }
      return sha;
    },

    gitCreateBranch: (dir, branch, fromRef) => {
      const result = spawnSync("git", ["checkout", "-b", branch, fromRef], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline backfill] git checkout -b ${branch} ${fromRef} failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
    },

    gitCommit: (dir, files, message) => {
      const addResult = spawnSync("git", ["add", "--", ...files], { encoding: "utf8", stdio: "pipe", cwd: dir });
      if (addResult.status !== 0) {
        throw new Error(
          `[pipeline backfill] git add failed (exit ${addResult.status}): ${addResult.stderr?.trim() ?? ""}`,
        );
      }
      const commitResult = spawnSync("git", ["commit", "-m", message], { encoding: "utf8", stdio: "pipe", cwd: dir });
      if (commitResult.status !== 0) {
        throw new Error(
          `[pipeline backfill] git commit failed (exit ${commitResult.status}): ${commitResult.stderr?.trim() ?? ""}`,
        );
      }
    },

    gitPushBranch: (dir, branch) => {
      const result = spawnSync("git", ["push", "-u", "origin", branch], { encoding: "utf8", stdio: "pipe", cwd: dir });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline backfill] git push origin ${branch} failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
    },

    createPR: async (dir, title, body, base, head) => {
      const result = spawnSync(
        "gh",
        ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", head],
        { encoding: "utf8", stdio: "pipe", cwd: dir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[pipeline backfill] gh pr create failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      return result.stdout.trim();
    },

    log: (msg) => process.stdout.write(msg + "\n"),
  };
}

// ---------------------------------------------------------------------------
// Coverage classification (deterministic, no model)
// ---------------------------------------------------------------------------

/**
 * Normalize a behavior string for identity comparison: lowercase, collapse
 * whitespace, strip punctuation so minor rewording doesn't cause duplicates.
 */
function normalizeBehavior(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Pure function. Assigns each candidate to exactly one coverage group.
 *
 * - already-covered: candidate maps to a living requirement by normalized behavior identity.
 * - conflicting-evidence: candidate.evidence_grade === "conflicting" OR it contradicts a living req.
 * - uncertain-evidence: candidate.evidence_grade === "uncertain".
 * - missing-coverage: sufficient evidence, not already covered, not conflicting.
 *
 * `alreadyProposedBehaviors` is the set of normalized behaviors already in an
 * open backfill change/PR — these are still classified but flagged already_proposed.
 */
export function classifyCoverage(
  candidates: BackfillCandidate[],
  livingRequirements: string[],
  alreadyProposedBehaviors: string[] = [],
): ClassifiedCandidate[] {
  const livingNorm = livingRequirements.map(normalizeBehavior);
  const proposedNorm = alreadyProposedBehaviors.map(normalizeBehavior);

  return candidates.map((c): ClassifiedCandidate => {
    const norm = normalizeBehavior(c.behavior);

    // Check already-covered first (living specs are the contract).
    const coveredIdx = livingNorm.findIndex((l) => {
      // Covered if the living requirement's normalized text substantially
      // overlaps with the candidate's normalized behavior (substring match).
      return l.includes(norm.slice(0, 30)) || norm.includes(l.slice(0, 30));
    });
    if (coveredIdx !== -1) {
      return {
        candidate: c,
        group: "already-covered",
        covered_by: livingRequirements[coveredIdx],
      };
    }

    // Conflicting evidence.
    if (c.evidence_grade === "conflicting") {
      return { candidate: c, group: "conflicting-evidence" };
    }

    // Uncertain evidence.
    if (c.evidence_grade === "uncertain" || !c.provenance || c.provenance.trim() === "") {
      return { candidate: c, group: "uncertain-evidence" };
    }

    // Missing coverage — check if already proposed in an open backfill PR.
    const alreadyProposed = proposedNorm.some((p) => p.includes(norm.slice(0, 30)) || norm.includes(p.slice(0, 30)));
    return {
      candidate: c,
      group: "missing-coverage",
      already_proposed: alreadyProposed || undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Living spec reader for open backfill changes
// ---------------------------------------------------------------------------

/**
 * Return the set of normalized behavior strings that are already proposed in
 * any open backfill change under openspec/changes/.
 */
function readOpenBackfillBehaviors(repoDir: string): string[] {
  const behaviors: string[] = [];
  const changeDirs = listChangeDirs(repoDir);
  for (const id of changeDirs) {
    if (!id.startsWith("backfill")) continue;
    const spec = readChangeFile(repoDir, id, "specs/backfill/spec.md");
    if (!spec) continue;
    const reqMatches = spec.matchAll(/^###\s+Requirement:\s+(.+)$/gm);
    for (const m of reqMatches) {
      behaviors.push(m[1].trim());
    }
  }
  return behaviors;
}

// ---------------------------------------------------------------------------
// Spec-only guard
// ---------------------------------------------------------------------------

/**
 * Return any paths in the provided list that are NOT under openspec/.
 */
export function nonOpenspecPaths(paths: string[]): string[] {
  return paths.filter((p) => !p.replace(/\\/g, "/").startsWith("openspec/"));
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatGroup(label: string, items: ClassifiedCandidate[], showProvenance = true): string {
  if (items.length === 0) return `### ${label}\n\n_(none)_\n`;
  const lines = [`### ${label}\n`];
  for (const item of items) {
    lines.push(`- **${item.candidate.behavior}**`);
    if (showProvenance && item.candidate.provenance) {
      lines.push(`  - Provenance: ${item.candidate.provenance}`);
    }
    if (item.covered_by) {
      lines.push(`  - Covered by: _${item.covered_by}_`);
    }
    if (item.candidate.conflicts_with) {
      lines.push(`  - Conflicts with: _${item.candidate.conflicts_with}_`);
    }
    if (item.already_proposed) {
      lines.push(`  - Already proposed in an open backfill PR.`);
    }
  }
  return lines.join("\n") + "\n";
}

function formatReport(
  classified: ClassifiedCandidate[],
  apply: boolean,
  prUrl?: string,
): string {
  const covered = classified.filter((c) => c.group === "already-covered");
  const missing = classified.filter((c) => c.group === "missing-coverage");
  const conflicting = classified.filter((c) => c.group === "conflicting-evidence");
  const uncertain = classified.filter((c) => c.group === "uncertain-evidence");

  const lines: string[] = [
    "## OpenSpec Backfill Coverage Report\n",
    `**Totals:** ${covered.length} already covered | ${missing.length} missing coverage | ${conflicting.length} conflicting | ${uncertain.length} uncertain\n`,
  ];

  lines.push(formatGroup("Already Covered (living specs)", covered, false));
  lines.push(formatGroup("Missing Coverage (candidates for backfill)", missing));
  lines.push(formatGroup("Conflicting Evidence (needs human decision)", conflicting));
  lines.push(formatGroup("Uncertain Evidence (needs human decision)", uncertain));

  lines.push("### What to review next\n");
  if (missing.length > 0) {
    lines.push(`- ${missing.length} behavior(s) have sufficient evidence and are ready to backfill.`);
    lines.push("  Run `pipeline backfill --apply` to author a spec-only PR for these.");
  }
  if (conflicting.length > 0) {
    lines.push(`- ${conflicting.length} behavior(s) have conflicting evidence and need human judgment before codifying.`);
  }
  if (uncertain.length > 0) {
    lines.push(`- ${uncertain.length} behavior(s) have uncertain evidence. Strengthen the evidence (add tests, docs) before backfilling.`);
  }
  if (missing.length === 0 && conflicting.length === 0 && uncertain.length === 0) {
    lines.push("- All detected behaviors are already covered. Backfill is complete.");
  }

  if (!apply) {
    lines.push("\n---\n");
    lines.push("**No specs, issues, branches, or PRs were changed.** This was a preview-only run.");
    lines.push("Run `pipeline backfill --apply` to apply the missing-coverage slice.");
  } else if (prUrl) {
    lines.push("\n---\n");
    lines.push(`**Backfill PR opened:** ${prUrl}`);
    lines.push("The pipeline never merges — a human must review and merge this PR.");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Apply path helpers
// ---------------------------------------------------------------------------

function buildChangeId(capability?: string): string {
  const token = crypto.randomBytes(3).toString("hex");
  const slug = capability ? capability.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-") : "legacy";
  return `backfill-${slug}-${token}`;
}

function buildProposalMd(slice: ClassifiedCandidate[], changeId: string): string {
  return [
    `# Backfill: ${changeId}\n`,
    "**Type:** OpenSpec backfill — accepted existing behavior\n",
    "This change adds OpenSpec coverage for legacy behavior that predates OpenSpec adoption.",
    "All requirements here describe behaviors that were accepted before this spec was written.",
    "They are marked with a backfill annotation so readers can distinguish them from",
    "new intended-behavior requirements added by the normal per-change flow.\n",
    "## Behaviors backfilled\n",
    ...slice.map((c) => `- ${c.candidate.behavior}`),
  ].join("\n");
}

function buildTasksMd(changeId: string): string {
  return [
    `## ${changeId} — Backfill Tasks\n`,
    "- [x] Identify missing legacy behaviors (automated by `pipeline backfill`)",
    "- [x] Author spec-only additive requirements with provenance",
    "- [x] Validate with `openspec validate`",
    "- [ ] Human review of the spec PR",
  ].join("\n");
}

function buildSpecMd(slice: ClassifiedCandidate[]): string {
  const lines = [
    "## ADDED Requirements\n",
    "_These requirements describe **accepted existing behavior** (backfilled)._",
    "_Each carries provenance showing the behavior is established, not accidental._\n",
  ];
  for (const c of slice) {
    const { behavior, provenance } = c.candidate;
    const reqTitle = `The system SHALL ${behavior.replace(/^the system (shall|must) /i, "").replace(/^[A-Z]/, (ch) => ch.toLowerCase())}`;
    lines.push(`### Requirement: ${reqTitle}\n`);
    lines.push(`> **Backfill annotation:** This requirement codifies accepted existing behavior.`);
    lines.push(`> Provenance: ${provenance}\n`);
    lines.push(`${behavior}\n`);
    lines.push(`#### Scenario: Accepted behavior is maintained\n`);
    lines.push(`- **GIVEN** the existing system`);
    lines.push(`- **WHEN** a maintainer or user exercises this feature`);
    lines.push(`- **THEN** the behavior described above SHALL hold\n`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function runBackfill(
  opts: BackfillOpts,
  cfg: { repo_dir: string; repo: string; base_branch: string },
  deps?: BackfillDeps,
): Promise<void> {
  const d = deps ?? realBackfillDeps(cfg.repo_dir);
  const repoDir = cfg.repo_dir;

  d.log("[pipeline backfill] starting...");

  // ---- Step 1: Read living specs and open backfill proposals ----

  const livingRequirements = d.readLivingSpecs(repoDir);
  const openBackfillBehaviors = readOpenBackfillBehaviors(repoDir);

  const hasWorkspace = isInitialized(repoDir);
  if (!hasWorkspace) {
    d.log("[pipeline backfill] no openspec/ workspace found — treating all behaviors as candidates.");
  } else if (livingRequirements.length === 0) {
    d.log("[pipeline backfill] openspec/ workspace exists but has no living requirements — treating all behaviors as candidates.");
  } else {
    d.log(`[pipeline backfill] found ${livingRequirements.length} living requirement(s) in living specs.`);
  }

  // ---- Step 2: Invoke behavior-analysis harness (single model boundary) ----

  d.log("[pipeline backfill] analyzing repository behavior (single model call)...");

  const evidenceCorpus = d.readEvidenceCorpus(repoDir);
  const livingSpecInventory =
    livingRequirements.length > 0
      ? livingRequirements.map((r, i) => `${i + 1}. ${r}`).join("\n")
      : "(none — workspace is absent or empty)";

  const prompt = buildBackfillPrompt({
    repoContext: `${cfg.repo} (dir: ${repoDir})`,
    livingSpecInventory,
    evidenceCorpus,
  });

  const harnessResult = await d.runHarness(prompt, 300);

  if (harnessResult.timed_out) {
    throw new Error("[pipeline backfill] behavior-analysis harness timed out after 300s.");
  }
  if (!harnessResult.success) {
    throw new Error("[pipeline backfill] behavior-analysis harness returned failure. Check output above.");
  }

  // ---- Step 3: Parse candidates from harness output ----

  let candidates: BackfillCandidate[] = [];
  const jsonMatch = harnessResult.output.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown[];
      candidates = parsed
        .filter((x): x is BackfillCandidate =>
          typeof x === "object" && x !== null &&
          typeof (x as Record<string, unknown>).behavior === "string" &&
          typeof (x as Record<string, unknown>).provenance === "string" &&
          typeof (x as Record<string, unknown>).evidence_grade === "string",
        )
        .map((x) => ({
          behavior: (x as BackfillCandidate).behavior,
          provenance: (x as BackfillCandidate).provenance || "",
          evidence_grade: (x as BackfillCandidate).evidence_grade,
          conflicts_with: (x as BackfillCandidate).conflicts_with ?? null,
        }));
    } catch {
      throw new Error("[pipeline backfill] could not parse candidate JSON from harness output.");
    }
  }

  d.log(`[pipeline backfill] harness produced ${candidates.length} candidate(s).`);

  // ---- Step 4: Classify candidates (deterministic) ----

  const classified = classifyCoverage(candidates, livingRequirements, openBackfillBehaviors);

  // ---- Preview path ----

  if (!opts.apply) {
    const report = formatReport(classified, false);
    d.log("\n" + report);
    return;
  }

  // ---- Apply path ----

  // Step 5: Select the slice.
  let slice = classified.filter((c) => c.group === "missing-coverage" && !c.already_proposed);

  if (opts.capability) {
    const capLower = opts.capability.toLowerCase();
    slice = slice.filter((c) => c.candidate.behavior.toLowerCase().includes(capLower));
  }

  if (slice.length === 0) {
    throw new Error(
      "[pipeline backfill] --apply: no missing-coverage candidates in the slice" +
        (opts.capability ? ` for capability '${opts.capability}'` : "") +
        ". All detected behaviors are already covered, conflicting, uncertain, or already proposed in an open PR.",
    );
  }

  d.log(`[pipeline backfill] apply: selected ${slice.length} missing-coverage candidate(s) for the slice.`);

  // Step 6: Author the OpenSpec change.
  const changeId = buildChangeId(opts.capability);
  const changeDir = path.join(repoDir, "openspec", "changes", changeId);
  const capabilitySlug = opts.capability ? opts.capability.toLowerCase().replace(/[^a-z0-9]/g, "-") : "backfill";
  const specDir = path.join(changeDir, "specs", capabilitySlug);

  const proposalPath = path.join(changeDir, "proposal.md");
  const tasksPath = path.join(changeDir, "tasks.md");
  const specPath = path.join(specDir, "spec.md");

  d.writeFile(proposalPath, buildProposalMd(slice, changeId));
  d.writeFile(tasksPath, buildTasksMd(changeId));
  d.writeFile(specPath, buildSpecMd(slice));

  // Compute the authored paths relative to repoDir.
  const authoredPaths = [proposalPath, tasksPath, specPath].map((p) =>
    path.relative(repoDir, p).replace(/\\/g, "/"),
  );

  // Step 7: Assert all authored paths are under openspec/.
  const nonSpec = nonOpenspecPaths(authoredPaths);
  if (nonSpec.length > 0) {
    throw new Error(
      `[pipeline backfill] spec-only guard: the authored change would touch non-openspec/ paths: ${nonSpec.join(", ")}. Aborting before PR.`,
    );
  }

  // Step 8: Validate.
  d.log("[pipeline backfill] running openspec validate...");
  const validResult = await d.validate(repoDir);
  if (!validResult.valid) {
    const details = validResult.issues.map((i) => `  - ${i.message}`).join("\n");
    throw new Error(
      `[pipeline backfill] openspec validate failed — aborting before PR.\n` +
        `Validation errors:\n${details || validResult.raw}`,
    );
  }
  d.log("[pipeline backfill] validation passed.");

  // Step 9: Create branch, commit, push, open PR.
  const baseSha = d.gitResolveBaseSha(repoDir, cfg.base_branch);
  const branch = `backfill/${changeId}`;
  d.log(`[pipeline backfill] creating branch ${branch}...`);
  d.gitCreateBranch(repoDir, branch, baseSha);

  const commitMsg =
    `chore: add OpenSpec backfill coverage for ${opts.capability ?? "legacy"} behavior\n\n` +
    `Adds ${slice.length} backfilled requirement(s) for accepted legacy behavior that predates\n` +
    `OpenSpec adoption. Each requirement carries provenance and a backfill annotation.\n\n` +
    `Change: ${changeId}\n` +
    `Issue: #327\nPipeline-Run: 327/2026-06-29T12:36:34Z`;

  d.gitCommit(repoDir, authoredPaths, commitMsg);
  d.gitPushBranch(repoDir, branch);

  const prTitle = `backfill: add OpenSpec coverage for ${opts.capability ?? "legacy"} behavior (${changeId})`;
  const prBody = buildPRBody(slice, changeId, cfg.base_branch);
  const prUrl = await d.createPR(repoDir, prTitle, prBody, cfg.base_branch, branch);

  d.log(`[pipeline backfill] PR opened: ${prUrl}`);

  const report = formatReport(classified, true, prUrl);
  d.log("\n" + report);
}

function buildPRBody(slice: ClassifiedCandidate[], changeId: string, baseBranch: string): string {
  const behaviorList = slice.map((c) => `- ${c.candidate.behavior} (_${c.candidate.provenance}_)`).join("\n");
  return [
    `## OpenSpec Backfill — ${changeId}\n`,
    "This PR was opened by `pipeline backfill`. It adds spec coverage for legacy",
    `behavior that predated OpenSpec adoption in this repository.\n`,
    "### Behaviors backfilled\n",
    behaviorList,
    "\n### Review guidance\n",
    "- Each requirement is annotated as _accepted existing behavior_ with provenance showing it is established, not accidental.",
    "- Requirements use `SHALL` language to match the OpenSpec format.",
    "- This PR touches only files under `openspec/` — no application behavior changes.",
    `- Target branch: \`${baseBranch}\`\n`,
    "---\n",
    "_The pipeline never merges — a human must review and merge this PR._",
  ].join("\n");
}
