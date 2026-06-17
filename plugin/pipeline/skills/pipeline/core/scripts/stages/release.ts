// Release sub-command (#170): prepares a release PR by:
// 1. Resolving the version (alias → semver)
// 2. Bumping both package.json files
// 3. Regenerating the plugin/ mirror (node scripts/build.mjs)
// 4. Running the CI gate (npm run ci)
// 5. Scaffolding ROADMAP.md at four mutation sites
// 6. Opening $EDITOR for human confirmation (skipped under --no-edit / --dry-run)
// 7. Committing on a new branch and opening a release PR
//
// Stops at the open PR — does not tag, merge, or publish (the post-merge
// release.yml workflow handles those after a human merges).

import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReleaseOpts {
  dryRun?: boolean;
  noEdit?: boolean;
}

export interface ShippedPR {
  number: number;
  title: string;
}

export interface ReleaseContext {
  version: string;
  previousVersion: string;
  date: string;
  theme: string;
  shippedPRs: ShippedPR[];
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable I/O seam — unit tests inject fakes, production uses realReleaseDeps(). */
export interface ReleaseDeps {
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  runCommand(cmd: string, args: string[], opts?: { cwd?: string }): CommandResult;
  spawnEditor(editor: string, filePath: string): void;
  fetchPRTitle(num: number): Promise<string>;
  today(): string;
  stdout(msg: string): void;
  stderr(msg: string): void;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

export function realReleaseDeps(): ReleaseDeps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf8"),
    runCommand: (cmd, args, opts) => {
      const result = spawnSync(cmd, args, {
        encoding: "utf8",
        cwd: opts?.cwd,
        stdio: "pipe",
        maxBuffer: 50 * 1024 * 1024,
      });
      return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
    spawnEditor: (editor, filePath) => {
      spawnSync(editor, [filePath], { stdio: "inherit" });
    },
    fetchPRTitle: async (num) => {
      const result = spawnSync(
        "gh",
        ["pr", "view", String(num), "--json", "title", "--jq", ".title"],
        { encoding: "utf8", stdio: "pipe" },
      );
      if (result.status !== 0) return `PR #${num}`;
      return result.stdout.trim() || `PR #${num}`;
    },
    today: () => new Date().toISOString().slice(0, 10),
    stdout: (msg) => process.stdout.write(msg + "\n"),
    stderr: (msg) => process.stderr.write(msg + "\n"),
  };
}

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

/** Expand `major`/`minor`/`patch` aliases or pass through a valid X.Y.Z semver. */
export function resolveVersion(alias: string, currentVersion: string): string {
  if (alias === "major" || alias === "minor" || alias === "patch") {
    const parts = currentVersion.split(".").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error(
        `Cannot expand alias "${alias}": current version "${currentVersion}" is not a valid X.Y.Z semver`,
      );
    }
    const [major, minor, patch] = parts;
    if (alias === "major") return `${major + 1}.0.0`;
    if (alias === "minor") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
  }

  if (/^\d+\.\d+\.\d+$/.test(alias)) return alias;

  throw new Error(
    `Invalid version: "${alias}". Expected a semver string (X.Y.Z) or alias (major, minor, patch).`,
  );
}

// ---------------------------------------------------------------------------
// Version bump
// ---------------------------------------------------------------------------

export function bumpVersion(
  resolvedVersion: string,
  rootPkgPath: string,
  corePkgPath: string,
  deps: Pick<ReleaseDeps, "readFile" | "writeFile">,
): void {
  for (const pkgPath of [rootPkgPath, corePkgPath]) {
    const text = deps.readFile(pkgPath);
    const pkg = JSON.parse(text) as { version: string };
    // Detect indent by inspecting the first indented property line.
    const indentMatch = text.match(/^(\s+)"/m);
    const indent = indentMatch ? indentMatch[1] : "  ";
    pkg.version = resolvedVersion;
    deps.writeFile(pkgPath, JSON.stringify(pkg, null, indent) + "\n");
  }
}

// ---------------------------------------------------------------------------
// Shipped PR discovery
// ---------------------------------------------------------------------------

const MERGE_PR_RE = /Merge pull request #(\d+)/g;
const SQUASH_PR_RE = /\(#(\d+)\)/g;

export async function discoverShippedPRs(
  lastTag: string,
  repoDir: string,
  deps: Pick<ReleaseDeps, "runCommand" | "fetchPRTitle" | "stderr">,
): Promise<ShippedPR[]> {
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const result = deps.runCommand("git", ["log", "--pretty=format:%s", range], { cwd: repoDir });

  if (result.code !== 0) {
    deps.stderr(`[pipeline release] warning: git log failed: ${result.stderr.trim()}`);
    return [];
  }

  const prNums = new Set<number>();
  for (const line of result.stdout.split("\n")) {
    for (const m of line.matchAll(MERGE_PR_RE)) prNums.add(Number(m[1]));
    for (const m of line.matchAll(SQUASH_PR_RE)) prNums.add(Number(m[1]));
  }

  if (prNums.size === 0) {
    deps.stderr("[pipeline release] warning: no merged PRs detected in git log since last tag");
    return [];
  }

  const prs: ShippedPR[] = [];
  for (const num of [...prNums].sort((a, b) => a - b)) {
    const title = await deps.fetchPRTitle(num);
    prs.push({ number: num, title });
  }
  return prs;
}

// ---------------------------------------------------------------------------
// ROADMAP helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse the theme from the first `| **vX.Y.Z** |` row in the release plan table. */
export function extractTheme(roadmapText: string, version: string): string {
  // Table column layout: | Release | Bump | Theme | Issues | Why |
  // After split on "|": indices 1=release, 2=bump, 3=theme, 4=issues, 5=why
  const lines = roadmapText.split("\n");
  for (const line of lines) {
    if (!line.startsWith(`| **v${version}**`)) continue;
    const cols = line.split("|");
    if (cols.length >= 4) return cols[3].trim() || "<theme>";
  }
  return "<theme>";
}

function minorOrdinal(minor: number): string {
  const words = [
    "first", "second", "third", "fourth", "fifth",
    "sixth", "seventh", "eighth", "ninth", "tenth",
    "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth",
    "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth",
  ];
  return words[minor - 1] ?? `${minor}th`;
}

function versionBumpType(version: string): "major" | "minor" | "patch" {
  const parts = version.split(".").map(Number);
  const patch = parts[2] ?? 0;
  const minor = parts[1] ?? 0;
  if (patch > 0) return "patch";
  if (minor > 0) return "minor";
  return "major";
}

// ---------------------------------------------------------------------------
// Four ROADMAP mutation functions
// ---------------------------------------------------------------------------

/**
 * 1. Update the intro paragraph's "shipped chain" sentence.
 *
 * Finds the "Everything below v{previousVersion} is the post-{previousVersion} line."
 * anchor and inserts the new version entry before it, then updates the anchor text.
 */
export function patchIntroLine(text: string, ctx: ReleaseContext): string {
  const { version, previousVersion, date, theme } = ctx;
  const anchor = `Everything below v${previousVersion}`;
  if (!text.includes(anchor)) {
    throw new Error(
      `ROADMAP anchor not found: intro-chain-ending` +
        ` (expected "Everything below v${previousVersion}" in the intro paragraph)`,
    );
  }
  const newEntry = `**v${version} shipped ${date}** (tag \`v${version}\`) — ${theme}; see Shipped. `;
  return text
    .replace(anchor, `${newEntry}Everything below v${version}`)
    .replace(`post-${previousVersion} line`, `post-${version} line`);
}

/**
 * 2. Mark the release plan table row as shipped.
 *
 * Finds the first `| **vX.Y.Z** |` row and appends `✅ shipped` to the
 * release column, replacing the why column with a shipped note.
 */
export function patchReleasePlanRow(text: string, ctx: ReleaseContext): string {
  const { version, date } = ctx;
  const lines = text.split("\n");
  // Find the first unshipped row for this version
  const rowIdx = lines.findIndex(
    (l) => l.startsWith(`| **v${version}**`) && !l.includes("✅ shipped"),
  );
  if (rowIdx === -1) {
    // Check if ANY row exists (even if already shipped) to give better error messages
    const anyRow = lines.some((l) => l.startsWith(`| **v${version}**`));
    if (!anyRow) {
      throw new Error(
        `ROADMAP anchor not found: release-plan-row` +
          ` (expected "| **v${version}**" row in the release plan table)`,
      );
    }
    // Already shipped — return unchanged (idempotent)
    return text;
  }

  const cols = lines[rowIdx].split("|");
  // cols: ["", " **vX.Y.Z** ", " bump ", " theme ", " issues ", " why ", ""]
  if (cols.length >= 2) {
    cols[1] = cols[1].replace(`**v${version}**`, `**v${version}** ✅ shipped`);
  }
  // Replace the last content column (why) with shipped note
  const lastContentIdx = cols.length - 2;
  if (lastContentIdx >= 1) {
    cols[lastContentIdx] =
      ` Shipped ${date} (tag \`v${version}\`). See **Shipped** above for the per-PR detail. `;
  }
  lines[rowIdx] = cols.join("|");
  return lines.join("\n");
}

/**
 * 3. Prepend a new shipped block before the previous version's block in ## Shipped.
 *
 * Inserts a scaffolded `**vX.Y.Z — theme (shipped DATE, tag vX.Y.Z):** ...` block
 * immediately before the `**v{previousVersion} —` line.
 */
export function prependShippedBlock(text: string, ctx: ReleaseContext): string {
  const { version, previousVersion, date, theme, shippedPRs } = ctx;
  const anchor = `\n**v${previousVersion} —`;
  const anchorIdx = text.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(
      `ROADMAP anchor not found: shipped-section` +
        ` (expected "**v${previousVersion} —" block in the ## Shipped section)`,
    );
  }

  const type = versionBumpType(version);
  const [, minorNum] = version.split(".").map(Number);
  const typeSuffix =
    type === "minor"
      ? ` — ${minorOrdinal(minorNum)} minor`
      : type === "major"
        ? " — major"
        : "";

  const header = `**v${version} — ${theme} (shipped ${date}, tag \`v${version}\`)${typeSuffix}:**`;

  const tableRows =
    shippedPRs.length > 0
      ? shippedPRs.map((pr) => `| | ${pr.title} | #${pr.number} |`).join("\n")
      : "| (no merged PRs detected — fill manually) | | |";

  const block = `\n${header}\n\n| # | What | PR |\n|---|------|-----|\n${tableRows}\n`;

  return text.slice(0, anchorIdx) + block + text.slice(anchorIdx);
}

/**
 * 4. Stamp the per-issue semver table.
 *
 * Finds rows in the `| # | Impact | Config | Theme | → Release | Depends on |` table
 * where `→ Release` = `v{version}` and prefixes them with `✅`.
 */
export function stampPerIssueTable(text: string, ctx: ReleaseContext): string {
  const { version } = ctx;
  const tableHeader = "| # | Impact | Config | Theme | → Release | Depends on |";
  if (!text.includes(tableHeader)) {
    throw new Error(
      `ROADMAP anchor not found: per-issue-table` +
        ` (expected "${tableHeader}" header in the per-issue detail table)`,
    );
  }

  const lines = text.split("\n");
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(tableHeader)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      // Stop at the next section or non-table line
      if (lines[i].startsWith("#") || (lines[i].trim() !== "" && !lines[i].startsWith("|"))) {
        inTable = false;
        continue;
      }
      if (!lines[i].startsWith("| #")) continue;
      const cols = lines[i].split("|");
      // col[5] is "→ Release" (0-indexed: 0=empty, 1=#N, 2=impact, 3=config, 4=theme, 5=→Release, 6=depends)
      if (cols.length < 7) continue;
      const releaseCol = cols[5].trim();
      if (releaseCol === `v${version}`) {
        cols[5] = ` ✅ v${version} `;
        lines[i] = cols.join("|");
      }
    }
  }
  return lines.join("\n");
}

/**
 * Apply all four ROADMAP mutations atomically in memory.
 * Throws with a named-anchor error on the first missing site.
 */
export function scaffoldRoadmap(roadmapText: string, ctx: ReleaseContext): string {
  let text = roadmapText;
  text = patchIntroLine(text, ctx);
  text = patchReleasePlanRow(text, ctx);
  text = prependShippedBlock(text, ctx);
  text = stampPerIssueTable(text, ctx);
  return text;
}

// ---------------------------------------------------------------------------
// PR body
// ---------------------------------------------------------------------------

export function buildPRBody(ctx: ReleaseContext, lastTag: string): string {
  const { version, theme, date, shippedPRs } = ctx;
  const since = lastTag ? `\`${lastTag}\`` : "the beginning";
  const prLines =
    shippedPRs.length > 0
      ? shippedPRs.map((pr) => `- #${pr.number} — ${pr.title}`).join("\n")
      : "_(no merged PRs detected — fill in manually)_";

  return [
    `## Release: v${version} — ${theme}`,
    "",
    `**Shipped ${date}**`,
    "",
    `### Included since ${since}`,
    "",
    prLines,
    "",
    "---",
    "",
    "After this PR is merged, push the tag to trigger the automated GitHub Release:",
    "```",
    `git tag v${version} && git push origin v${version}`,
    "```",
    "",
    "_Prepared by `pipeline release`_",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runRelease(
  versionArg: string,
  opts: ReleaseOpts,
  cfg: { repo_dir: string; repo: string },
  deps: ReleaseDeps = realReleaseDeps(),
): Promise<void> {
  const repoDir = cfg.repo_dir;
  const rootPkgPath = path.join(repoDir, "package.json");
  const corePkgPath = path.join(repoDir, "core", "package.json");
  const roadmapPath = path.join(repoDir, "ROADMAP.md");

  // 1. Read current version for alias expansion.
  const corePkgText = deps.readFile(corePkgPath);
  const previousVersion = (JSON.parse(corePkgText) as { version: string }).version;

  // 2. Resolve version — throws on invalid input.
  const resolvedVersion = resolveVersion(versionArg, previousVersion);
  deps.stdout(`[pipeline release] resolved version: ${resolvedVersion}`);

  // 3. Find last git tag for git-log range.
  const tagResult = deps.runCommand("git", ["describe", "--tags", "--abbrev=0"], { cwd: repoDir });
  const lastTag = tagResult.code === 0 ? tagResult.stdout.trim() : "";
  if (lastTag) {
    deps.stdout(`[pipeline release] git log range: ${lastTag}..HEAD`);
  } else {
    deps.stdout("[pipeline release] no previous tag found; git log range: HEAD");
  }

  // 4. Discover shipped PRs.
  const shippedPRs = await discoverShippedPRs(lastTag, repoDir, deps);

  // 5. Read ROADMAP and extract theme from the release plan row.
  const roadmapText = deps.readFile(roadmapPath);
  const theme = extractTheme(roadmapText, resolvedVersion);
  const today = deps.today();

  const ctx: ReleaseContext = {
    version: resolvedVersion,
    previousVersion,
    date: today,
    theme,
    shippedPRs,
  };

  // 6. Scaffold ROADMAP in memory (always — needed for dry-run diff too).
  const patchedRoadmap = scaffoldRoadmap(roadmapText, ctx);

  // 7. Build PR body.
  const prBody = buildPRBody(ctx, lastTag);

  // --- Dry-run path: print and exit ---
  if (opts.dryRun) {
    deps.stdout(`\n=== Resolved version: ${resolvedVersion} ===\n`);
    deps.stdout(`=== package.json changes ===`);
    deps.stdout(`  "version": "${previousVersion}" → "${resolvedVersion}" (root + core/package.json)`);
    deps.stdout(`  + node scripts/build.mjs (mirror regen)\n`);
    deps.stdout(`=== ROADMAP.md (scaffolded) ===`);
    deps.stdout(patchedRoadmap);
    deps.stdout(`\n=== PR body ===`);
    deps.stdout(prBody);
    return;
  }

  // --- Live path ---

  // 8. Bump version in both package.json files.
  deps.stdout("[pipeline release] bumping version in package.json files...");
  bumpVersion(resolvedVersion, rootPkgPath, corePkgPath, deps);

  // 9. Regenerate plugin/ mirror.
  deps.stdout("[pipeline release] regenerating plugin/ mirror (node scripts/build.mjs)...");
  const buildResult = deps.runCommand("node", ["scripts/build.mjs"], { cwd: repoDir });
  if (buildResult.code !== 0) {
    deps.stderr(buildResult.stdout);
    deps.stderr(buildResult.stderr);
    throw new Error(
      `[pipeline release] mirror regen failed: node scripts/build.mjs exited ${buildResult.code}`,
    );
  }

  // 10. CI gate.
  deps.stdout("[pipeline release] running CI gate (npm run ci)...");
  const ciResult = deps.runCommand("npm", ["run", "ci"], { cwd: repoDir });
  if (ciResult.code !== 0) {
    deps.stderr(ciResult.stdout);
    deps.stderr(ciResult.stderr);
    throw new Error(
      `[pipeline release] CI gate failed: npm run ci exited ${ciResult.code}`,
    );
  }
  deps.stdout("[pipeline release] CI passed.");

  // 11. Write scaffolded ROADMAP to disk.
  deps.stdout("[pipeline release] writing scaffolded ROADMAP.md...");
  deps.writeFile(roadmapPath, patchedRoadmap);

  // 12. Open $EDITOR for human confirmation.
  if (!opts.noEdit) {
    const editor = process.env.EDITOR;
    if (!editor) {
      deps.stderr(
        "[pipeline release] warning: $EDITOR is not set — proceeding as --no-edit (committing scaffolded ROADMAP as-is)",
      );
    } else {
      deps.stdout(`[pipeline release] opening ${roadmapPath} in $EDITOR (${editor}) for review...`);
      deps.spawnEditor(editor, roadmapPath);
    }
  }

  // 13. Create release branch, commit, and open PR.
  const branch = `release/v${resolvedVersion}`;
  deps.stdout(`[pipeline release] creating branch ${branch}...`);

  const checkoutResult = deps.runCommand("git", ["checkout", "-b", branch], { cwd: repoDir });
  if (checkoutResult.code !== 0) {
    throw new Error(
      `[pipeline release] git checkout -b ${branch} failed: ${checkoutResult.stderr.trim()}`,
    );
  }

  deps.stdout("[pipeline release] staging release files...");
  const addResult = deps.runCommand(
    "git",
    ["add", "package.json", "core/package.json", "ROADMAP.md", "plugin/"],
    { cwd: repoDir },
  );
  if (addResult.code !== 0) {
    throw new Error(`[pipeline release] git add failed: ${addResult.stderr.trim()}`);
  }

  const commitMsg = `release: ${resolvedVersion} — ${theme}\n\nIssue: #170\nPipeline-Run: 170/${today}T00:00:00Z`;
  const commitResult = deps.runCommand("git", ["commit", "-m", commitMsg], { cwd: repoDir });
  if (commitResult.code !== 0) {
    throw new Error(`[pipeline release] git commit failed: ${commitResult.stderr.trim()}`);
  }
  deps.stdout("[pipeline release] committed release files.");

  deps.stdout("[pipeline release] pushing branch and opening release PR...");
  const pushResult = deps.runCommand("git", ["push", "-u", "origin", branch], { cwd: repoDir });
  if (pushResult.code !== 0) {
    throw new Error(`[pipeline release] git push failed: ${pushResult.stderr.trim()}`);
  }

  const prTitle = `release: ${resolvedVersion} — ${theme}`;
  const prResult = deps.runCommand(
    "gh",
    ["pr", "create", "--title", prTitle, "--body", prBody, "--base", "main"],
    { cwd: repoDir },
  );
  if (prResult.code !== 0) {
    throw new Error(`[pipeline release] gh pr create failed: ${prResult.stderr.trim()}`);
  }

  const prUrl = prResult.stdout.trim();
  deps.stdout(`[pipeline release] release PR opened: ${prUrl}`);
}
