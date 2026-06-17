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
      // Run through shell so "code --wait", "subl -n -w", etc. work correctly.
      const result = spawnSync("sh", ["-c", `${editor} "$1"`, "--", filePath], {
        stdio: "inherit",
      });
      if ((result.status ?? 1) !== 0) {
        throw new Error(
          `[pipeline release] editor exited ${result.status ?? 1} (EDITOR="${editor}"). Aborting.`,
        );
      }
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
// Unified diff helper (used for dry-run output — no file writes or gh calls)
// ---------------------------------------------------------------------------

function diffLines(
  a: string[],
  b: string[],
): Array<{ kind: "eq" | "del" | "ins"; val: string }> {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);

  const ops: Array<{ kind: "eq" | "del" | "ins"; val: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ kind: "eq", val: a[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ kind: "ins", val: b[j - 1] }); j--;
    } else {
      ops.push({ kind: "del", val: a[i - 1] }); i--;
    }
  }
  ops.reverse();
  return ops;
}

/** Generate a unified diff string comparing two text blocks. Returns "" when identical. */
export function computeUnifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
  contextLines = 3,
): string {
  if (oldText === newText) return "";
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const edits = diffLines(a, b);

  // Annotate edits with 1-based a/b side line numbers.
  type Tagged = { kind: "eq" | "del" | "ins"; val: string; aLine?: number; bLine?: number };
  const tagged: Tagged[] = [];
  let aLine = 0, bLine = 0;
  for (const e of edits) {
    if (e.kind === "eq")       { aLine++; bLine++; tagged.push({ kind: "eq",  val: e.val, aLine, bLine }); }
    else if (e.kind === "del") { aLine++;           tagged.push({ kind: "del", val: e.val, aLine }); }
    else                       { bLine++;           tagged.push({ kind: "ins", val: e.val, bLine }); }
  }

  // Collect indices of changed edits and group into hunk ranges with context.
  const changeIdxs = tagged.flatMap((t, idx) => (t.kind !== "eq" ? [idx] : []));
  if (changeIdxs.length === 0) return "";

  type HunkRange = { start: number; end: number };
  const ranges: HunkRange[] = [];
  let cur: HunkRange | null = null;
  for (const ci of changeIdxs) {
    const s = Math.max(0, ci - contextLines);
    const e = Math.min(tagged.length - 1, ci + contextLines);
    if (!cur) { cur = { start: s, end: e }; }
    else if (s <= cur.end + 1) { cur.end = Math.max(cur.end, e); }
    else { ranges.push(cur); cur = { start: s, end: e }; }
  }
  if (cur) ranges.push(cur);

  // Format hunks.
  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const r of ranges) {
    const slice = tagged.slice(r.start, r.end + 1);
    const aSlice = slice.filter((t) => t.aLine !== undefined);
    const bSlice = slice.filter((t) => t.bLine !== undefined);
    const oldStart = aSlice[0]?.aLine ?? 1;
    const newStart = bSlice[0]?.bLine ?? 1;
    out.push(`@@ -${oldStart},${aSlice.length} +${newStart},${bSlice.length} @@`);
    for (const t of slice) {
      if (t.kind === "eq")       out.push(` ${t.val}`);
      else if (t.kind === "del") out.push(`-${t.val}`);
      else                       out.push(`+${t.val}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Version bump
// ---------------------------------------------------------------------------

/** Apply version bump in memory (no file write). Used by dry-run diff. */
function bumpVersionInMemory(text: string, resolvedVersion: string): string {
  const pkg = JSON.parse(text) as { version: string };
  const indentMatch = text.match(/^(\s+)"/m);
  const indent = indentMatch ? indentMatch[1] : "  ";
  pkg.version = resolvedVersion;
  return JSON.stringify(pkg, null, indent) + "\n";
}

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
  localOnly = false,
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

  const sorted = [...prNums].sort((a, b) => a - b);
  if (localOnly) {
    // Dry-run path: return placeholder titles without calling any GitHub API.
    return sorted.map((num) => ({ number: num, title: `PR #${num}` }));
  }

  const prs: ShippedPR[] = [];
  for (const num of sorted) {
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
  cfg: { repo_dir: string; repo: string; base_branch?: string },
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

  // 3. Find last git tag for git-log range (local git call, safe in all modes).
  const tagResult = deps.runCommand("git", ["describe", "--tags", "--abbrev=0"], { cwd: repoDir });
  const lastTag = tagResult.code === 0 ? tagResult.stdout.trim() : "";
  if (lastTag) {
    deps.stdout(`[pipeline release] git log range: ${lastTag}..HEAD`);
  } else {
    deps.stdout("[pipeline release] no previous tag found; git log range: HEAD");
  }

  // 4. Read ROADMAP and extract theme (local, safe in all modes).
  const roadmapText = deps.readFile(roadmapPath);
  const theme = extractTheme(roadmapText, resolvedVersion);
  const today = deps.today();

  // --- Dry-run path: local-only, no file writes, no GitHub API calls ---
  if (opts.dryRun) {
    // Discover PR numbers from git log only (localOnly=true skips fetchPRTitle → gh).
    const shippedPRs = await discoverShippedPRs(lastTag, repoDir, deps, /* localOnly= */ true);

    const ctx: ReleaseContext = { version: resolvedVersion, previousVersion, date: today, theme, shippedPRs };

    // Compute version-bump diffs in memory (no file writes).
    const rootPkgOld = deps.readFile(rootPkgPath);
    const rootPkgNew = bumpVersionInMemory(rootPkgOld, resolvedVersion);
    const corePkgNew = bumpVersionInMemory(corePkgText, resolvedVersion);

    const rootDiff = computeUnifiedDiff(rootPkgOld, rootPkgNew, "a/package.json", "b/package.json");
    const coreDiff = computeUnifiedDiff(corePkgText, corePkgNew, "a/core/package.json", "b/core/package.json");

    // Scaffold ROADMAP in memory and diff it.
    const patchedRoadmap = scaffoldRoadmap(roadmapText, ctx);
    const roadmapDiff = computeUnifiedDiff(roadmapText, patchedRoadmap, "a/ROADMAP.md", "b/ROADMAP.md");

    const prBody = buildPRBody(ctx, lastTag);

    deps.stdout(`\n=== Resolved version: ${resolvedVersion} ===\n`);
    deps.stdout(`=== package.json diff ===`);
    deps.stdout(rootDiff || "(no changes)");
    deps.stdout(`\n=== core/package.json diff ===`);
    deps.stdout(coreDiff || "(no changes)");
    deps.stdout(`\n=== ROADMAP.md diff ===`);
    deps.stdout(roadmapDiff || "(no changes)");
    deps.stdout(`\n=== PR body ===`);
    deps.stdout(prBody);
    return;
  }

  // --- Live path ---

  // 5. Bump version in both package.json files.
  deps.stdout("[pipeline release] bumping version in package.json files...");
  bumpVersion(resolvedVersion, rootPkgPath, corePkgPath, deps);

  // 6. Regenerate plugin/ mirror.
  deps.stdout("[pipeline release] regenerating plugin/ mirror (node scripts/build.mjs)...");
  const buildResult = deps.runCommand("node", ["scripts/build.mjs"], { cwd: repoDir });
  if (buildResult.code !== 0) {
    deps.stderr(buildResult.stdout);
    deps.stderr(buildResult.stderr);
    throw new Error(
      `[pipeline release] mirror regen failed: node scripts/build.mjs exited ${buildResult.code}`,
    );
  }

  // 7. CI gate — abort here if CI fails; no GitHub API has been called yet.
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

  // 8. Discover shipped PRs with title enrichment (first GitHub API call; only reached after CI).
  const shippedPRs = await discoverShippedPRs(lastTag, repoDir, deps);

  // 9. Scaffold ROADMAP in memory and build PR body.
  const ctx: ReleaseContext = { version: resolvedVersion, previousVersion, date: today, theme, shippedPRs };
  const patchedRoadmap = scaffoldRoadmap(roadmapText, ctx);
  const prBody = buildPRBody(ctx, lastTag);

  // 10. Write scaffolded ROADMAP to disk.
  deps.stdout("[pipeline release] writing scaffolded ROADMAP.md...");
  deps.writeFile(roadmapPath, patchedRoadmap);

  // 11. Open $EDITOR for human confirmation.
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

  // 12. Create release branch, commit, and open PR.
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

  // Use configured base_branch (from .github/pipeline.yml or --base CLI flag), default "main".
  const baseBranch = cfg.base_branch ?? "main";
  const prTitle = `release: ${resolvedVersion} — ${theme}`;
  const prResult = deps.runCommand(
    "gh",
    ["pr", "create", "--title", prTitle, "--body", prBody, "--base", baseBranch],
    { cwd: repoDir },
  );
  if (prResult.code !== 0) {
    throw new Error(`[pipeline release] gh pr create failed: ${prResult.stderr.trim()}`);
  }

  const prUrl = prResult.stdout.trim();
  deps.stdout(`[pipeline release] release PR opened: ${prUrl}`);
}
