// Intake sub-command (#158): takes a short description, generates a structured
// issue spec via a model harness, creates a GitHub issue, and proposes a
// ROADMAP.md update (release-plan row, per-issue row, detail bullet) as a
// branch + PR for human review.
//
// All external I/O is injected via IntakeDeps so unit tests use no real
// network, git, or subprocess calls.

import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { invoke } from "../harness.ts";
import { DEFAULT_CONFIG } from "../types.ts";
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
   * Resolve origin/<baseBranch> to an immutable commit SHA. Also a preflight:
   * throws if origin/<baseBranch> is not fetched. The SHA is pinned ONCE and
   * reused for both the ROADMAP read and the branch fork point, so the two can
   * never straddle a concurrent push to the moving origin/<base> ref.
   */
  gitResolveBaseSha(repoDir: string, baseBranch: string): string;
  /**
   * Read a file at a specific immutable git ref/SHA without modifying the working
   * tree. relPath is repo-relative (e.g. "ROADMAP.md"). Pass the pinned base SHA so
   * the mutation is computed from exactly the commit the intake branch will fork
   * from — not a moving ref or a potentially-stale caller checkout.
   */
  readFileAtBase(repoDir: string, ref: string, relPath: string): string;
  /** Generic local file read (for writes only — ROADMAP reads use readFileAtBase). */
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  /**
   * Ensure a GitHub label exists, CREATE-ONLY: creates it with the given color
   * when absent and leaves an existing label's color/description UNTOUCHED (never
   * `--force`). Must be called before createIssue so issue creation never fails on
   * a missing label, without clobbering label metadata the repo already curates.
   */
  ensureLabel(repoDir: string, name: string, color: string): Promise<void>;
  /**
   * Throw if ROADMAP.md has uncommitted local changes in the working tree.
   * Prevents overwriting in-progress edits with the intake write.
   */
  gitEnsureClean(repoDir: string): void;
  /**
   * Create and checkout a new branch starting from the given immutable ref/SHA
   * (the pinned base SHA), so the roadmap PR forks from exactly the commit the
   * ROADMAP mutation was computed against — not a moving ref or the caller's HEAD.
   */
  gitCreateBranch(repoDir: string, branch: string, fromRef: string): void;
  /**
   * Reserve `origin/<branch>` at the given SHA, create-only, BEFORE issue creation. Three
   * guarantees: (1) it SHALL fail when the ref already exists at ANY SHA — including the
   * same SHA (a plain push no-ops "up-to-date") AND an ancestor SHA (a plain push would
   * fast-forward and MOVE the existing ref); it SHALL NOT modify an existing ref. (2) It
   * SHALL exercise the SAME push transport/credentials that gitPushBranch uses to publish
   * the roadmap commit, so a missing/read-only push credential fails HERE rather than after
   * the irreversible issue creation. (3) On collision or failure it SHALL abort before
   * createIssue. The reference implementation uses `git push` with an empty
   * `--force-with-lease` (expect-absent) and treats only a newly-created ref ('*') as success.
   */
  reserveRemoteBranch(repoDir: string, branch: string, sha: string): void;
  /**
   * Push the current branch to `origin/<branch>` — used AFTER the roadmap commit as a
   * fast-forward onto the already-reserved ref. (Reservation is reserveRemoteBranch, which
   * shares this transport so capability is proven before issue creation.)
   */
  gitPushBranch(repoDir: string, branch: string): void;
  /** Stage the given files and commit. */
  gitCommit(repoDir: string, files: string[], message: string): void;
  /** Open a PR (the branch is already pushed by gitPushBranch). Returns the PR URL. */
  createPR(repoDir: string, title: string, body: string, base: string, head: string): Promise<string>;
  /** A short random token used to make intake branch names collision-resistant so two
   *  concurrent runs with the same generated title + base SHA can never share a branch. */
  randomToken(): string;
  log(msg: string): void;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

export function realIntakeDeps(
  repoDir: string,
  model: string = DEFAULT_CONFIG.models.intake,
): IntakeDeps {
  return {
    runHarness: async (prompt) => {
      // Intake is a self-contained description->spec transform: the prompt injects
      // all needed context, so pin a fast model and run lean (no built-in tools, no
      // MCP) to stop the call from cold-starting MCP servers or burning agentic
      // turns exploring the repo. See harness.ts InvokeOptions.lean.
      const result = await invoke("claude", repoDir, prompt, { stream: true, model, lean: true });
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
    gitResolveBaseSha: (dir, baseBranch) => {
      // Pin origin/<baseBranch> to an immutable SHA. Also a preflight: if the ref is
      // not fetched, bail here before any irreversible GitHub write.
      const result = spawnSync("git", ["rev-parse", "--verify", `origin/${baseBranch}`], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      const sha = result.stdout?.trim() ?? "";
      if (result.status !== 0 || !/^[0-9a-f]{7,40}$/.test(sha)) {
        throw new Error(
          `[pipeline intake] could not resolve origin/${baseBranch} to a commit SHA (exit ${result.status}): ` +
            `${result.stderr?.trim() ?? ""}.\n` +
            `  Ensure origin/${baseBranch} is fetched: git fetch origin ${baseBranch}`,
        );
      }
      return sha;
    },
    readFileAtBase: (dir, ref, relPath) => {
      // Read the file at the pinned base SHA without touching the working tree, so the
      // mutation is computed from exactly the commit the intake branch forks from —
      // even when intake is run from a feature worktree or a stale checkout.
      const result = spawnSync("git", ["show", `${ref}:${relPath}`], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline intake] could not read ${relPath} at ${ref} (exit ${result.status}): ` +
            `${result.stderr?.trim() ?? ""}.`,
        );
      }
      return result.stdout;
    },
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf8"),
    ensureLabel: async (dir, name, color) => {
      // Create-only: NEVER `--force`, which would update (clobber) an existing label's
      // color/description. Create when absent; tolerate the already-exists error and
      // leave the existing label's metadata exactly as the repo curates it.
      const result = spawnSync("gh", labelCreateArgs(name, color), {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status === 0) return;
      if (isLabelAlreadyExists(result.status ?? 1, result.stderr ?? "")) return;
      throw new Error(
        `[pipeline intake] could not ensure label "${name}" (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
      );
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
    reserveRemoteBranch: (dir, branch, sha) => {
      // Reserve via the SAME `git push` transport used later to publish the roadmap commit, so
      // a missing/read-only origin push credential fails HERE — before the issue — instead of
      // after it (which would strand a labeled issue). TRULY create-only via an empty
      // --force-with-lease (expect the ref absent): git then refuses to update an existing ref
      // AT ALL — including a fast-forward to a descendant SHA, which a plain push would silently
      // perform and MOVE someone else's branch. Verified against the live remote: new ref → '*'
      // exit 0; existing ref at any SHA (incl. an ancestor) → '!' "(stale info)" exit 1, ref
      // unchanged.
      const result = spawnSync("git", reservePushArgs(branch, sha), {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      const statusLine = out.split("\n").find((l) => l.includes(`:refs/heads/${branch}`)) ?? "";
      const flag = statusLine.charAt(0);
      if (result.status === 0 && flag === "*") return; // newly created → reserved (never moves an existing ref)
      if (flag === "!" || flag === "=" || /stale info/i.test(out)) {
        throw new Error(
          `[pipeline intake] branch ${branch} already exists on origin — aborting before creating any issue.\n` +
            `  A concurrent or prior intake run reserved it; re-run to get a fresh branch name.`,
        );
      }
      throw new Error(
        `[pipeline intake] could not reserve origin/${branch} via git push (exit ${result.status}): ${(result.stderr || result.stdout || "").trim()}\n` +
          `  The branch may already exist, or this checkout's origin push credentials are missing or read-only.`,
      );
    },
    gitCreateBranch: (dir, branch, fromRef) => {
      // fromRef is the pinned base SHA — fork from exactly the commit the ROADMAP
      // mutation was computed against, not a moving ref.
      const result = spawnSync("git", ["checkout", "-b", branch, fromRef], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline intake] git checkout -b ${branch} ${fromRef} failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
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
    gitPushBranch: (dir, branch) => {
      const result = spawnSync("git", ["push", "origin", branch], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline intake] git push origin ${branch} failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
    },
    createPR: async (dir, title, body, base, head) => {
      // The branch is already pushed (reserved + roadmap commit) via gitPushBranch.
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
    randomToken: () => crypto.randomBytes(3).toString("hex"),
    log: (msg) => process.stdout.write(msg + "\n"),
  };
}

// ---------------------------------------------------------------------------
// Label helpers (create-only — never clobber existing label metadata)
// ---------------------------------------------------------------------------

/**
 * Build the `gh label create` args for create-only label creation. Deliberately
 * omits `--force`: `--force` UPDATES an existing label's color/description, which
 * would mutate label metadata the repo already curates. Drift-guard: a unit test
 * asserts `--force` is absent.
 */
export function labelCreateArgs(name: string, color: string): string[] {
  return ["label", "create", name, "--color", color];
}

/**
 * Classify a `gh label create` result: true when the non-zero exit is the benign
 * "label already exists" case (treat as present, leave its metadata untouched),
 * false for success (status 0) or any other failure (which the caller rethrows).
 * The error string is verified real: gh prints
 * `label with name "X" already exists; use --force to update its color and description`.
 */
export function isLabelAlreadyExists(status: number, stderr: string): boolean {
  return status !== 0 && /already exists/i.test(stderr);
}

/**
 * Build the `git push` args for a CREATE-ONLY branch reservation. The empty
 * `--force-with-lease=refs/heads/<branch>:` (no expected OID = expect the ref absent)
 * makes git refuse to update an existing ref — including a fast-forward to a descendant
 * SHA, which a plain push would silently perform and MOVE someone else's branch
 * (data-corruption). Verified against the live remote: new ref → '*' exit 0; existing ref
 * at any SHA → '!' "(stale info)" exit 1 with the ref unchanged. Drift-guard: a unit test
 * asserts the empty-lease flag is present.
 */
export function reservePushArgs(branch: string, sha: string): string[] {
  return [
    "push",
    "--porcelain",
    `--force-with-lease=refs/heads/${branch}:`,
    "origin",
    `${sha}:refs/heads/${branch}`,
  ];
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

  // 2. Pin origin/<base_branch> to an immutable SHA, then read ROADMAP at THAT SHA —
  //    not the caller's working tree, and not the moving ref. Pinning once and reusing
  //    the SHA for both the read and the branch fork point is what makes the roadmap PR
  //    safe: origin/<base> is a moving ref, so reading at the ref and later branching
  //    from the ref can straddle a concurrent push, yielding a PR that rolls back roadmap
  //    entries that landed in between. A failed resolve/read also preflights
  //    origin/<base_branch> accessibility before any GitHub write (#158 review-2).
  const baseSha = d.gitResolveBaseSha(repoDir, cfg.base_branch);
  const roadmapAtBase = d.readFileAtBase(repoDir, baseSha, "ROADMAP.md");

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
  //    not silently lose in-progress edits when gitCreateBranch switches branches
  //    (git checkout rejects conflicting local changes).
  d.gitEnsureClean(repoDir);

  // 9. Prepare AND RESERVE the release branch BEFORE creating the issue — the irreversible
  //    action must come last, after every step that can fail. Two layers keep an orphaned
  //    issue impossible:
  //      (a) The branch name carries the short base SHA AND a random token, so two concurrent
  //          intake runs with the same generated title + base are very unlikely to derive the
  //          same branch.
  //      (b) We RESERVE the remote ref create-only BEFORE createIssue, over the SAME git push
  //          transport that later publishes the roadmap commit. This catches a branch collision
  //          even at the same SHA (where a plain push would no-op "up-to-date") AND proves the
  //          push credential works — so a read-only/missing push credential fails HERE, not on
  //          the post-issue push where it would strand the issue. The post-issue push is then a
  //          fast-forward onto the reserved ref over the just-proven credential.
  //    Forking from the pinned SHA also means the ROADMAP we read and the branch we write onto
  //    share one commit, so the PR diff is exactly our three inserted rows — never a rollback
  //    of roadmap entries that landed on the base after our read (#158 review-2).
  const slug = slugifyTitle(title);
  const branch = `intake/${slug}-${baseSha.slice(0, 7)}-${d.randomToken()}`;
  d.log(`[pipeline intake] creating branch ${branch} from base ${baseSha.slice(0, 12)}...`);
  d.gitCreateBranch(repoDir, branch, baseSha);
  d.log(`[pipeline intake] reserving origin/${branch} (proves push capability) before issue creation...`);
  d.reserveRemoteBranch(repoDir, branch, baseSha);

  // 10. Ensure both required labels exist (create-only) before issue creation. Intake
  //     bypasses the normal `pipeline init` label-bootstrap path, so release:vX.Y.Z
  //     labels (dynamically named) and pipeline:ready may be absent in a fresh repo.
  //     The two creates are independent and both must precede createIssue, so run
  //     them concurrently.
  await Promise.all([
    d.ensureLabel(repoDir, "pipeline:ready", "1D76DB"),
    d.ensureLabel(repoDir, `release:v${version}`, "e4e669"),
  ]);

  // 11. Create the GitHub issue — only after the branch is reserved on origin and labels
  //     exist. This is the first irreversible action; everything that could fail has run.
  d.log(`[pipeline intake] creating GitHub issue...`);
  const labels = [`pipeline:ready`, `release:v${version}`];
  const issueNumber = await d.createIssue(title, specBody, labels);
  d.log(`[pipeline intake] created issue #${issueNumber}: ${title}`);

  // 12. Apply the three ROADMAP mutations with the real issue number, write onto the
  //     prepared branch, commit, push (fast-forward onto the reserved ref), and open the PR.
  //     Past issue creation a failure here leaves the issue + reserved branch live, so log a
  //     recovery command.
  const mutatedRoadmap = applyRoadmapMutations(roadmapAtBase, version, issueNumber, title, oneLiner);
  const prTitle = `intake: ROADMAP slot for #${issueNumber} — ${title}`;
  try {
    d.writeFile(roadmapPath, mutatedRoadmap);
    d.log(`[pipeline intake] wrote ROADMAP.md`);

    const commitMsg =
      `docs: ROADMAP — intake #${issueNumber} (${title})\n\n` +
      `Issue: #158\nPipeline-Run: 158/2026-06-17T02:48:33Z`;
    d.gitCommit(repoDir, ["ROADMAP.md"], commitMsg);
    d.gitPushBranch(repoDir, branch);

    const prBody = buildPRBody(issueNumber, title, specBody, version);
    const prUrl = await d.createPR(repoDir, prTitle, prBody, cfg.base_branch, branch);

    d.log(`[pipeline intake] roadmap PR opened: ${prUrl}`);
    d.log(`[pipeline intake] done — issue #${issueNumber} created; roadmap PR: ${prUrl}`);
  } catch (err) {
    d.log(
      `\n[pipeline intake] ERROR: issue #${issueNumber} was created and branch ${branch} reserved on origin, but the roadmap PR step failed.\n` +
        `  Recovery — finish the roadmap PR manually from the reserved branch:\n` +
        `    git add ROADMAP.md && git commit -m "docs: ROADMAP — intake #${issueNumber} (${title})"\n` +
        `    git push origin ${branch}\n` +
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
