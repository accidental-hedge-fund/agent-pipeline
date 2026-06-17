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
  /** Issue numbers confirmed shipped (resolved from PR closing references). Empty in dry-run or when no PRs detected. */
  shippedIssueNumbers: number[];
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
  /** Fetch the issue numbers closed by a given PR via `gh pr view --json closingIssuesReferences`. */
  fetchPRClosingIssues(num: number): Promise<number[]>;
  today(): string;
  stdout(msg: string): void;
  stderr(msg: string): void;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

/** Create real deps. Pass repoDir so gh commands run in the target repo's cwd. */
export function realReleaseDeps(repoDir?: string): ReleaseDeps {
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
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) return `PR #${num}`;
      return result.stdout.trim() || `PR #${num}`;
    },
    fetchPRClosingIssues: async (num) => {
      const result = spawnSync(
        "gh",
        [
          "pr", "view", String(num),
          "--json", "closingIssuesReferences",
          "--jq", ".closingIssuesReferences[].number",
        ],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `gh pr view #${num} --json closingIssuesReferences failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      if (!result.stdout.trim()) return [];
      return result.stdout
        .trim()
        .split("\n")
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
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
 * where `→ Release` = `v{version}` AND the issue number is in `ctx.shippedIssueNumbers`,
 * then marks them with `✅`. Rows whose version matches but whose issue number is not
 * in the shipped set are left unchanged (they were deferred or planned but not merged).
 * When `shippedIssueNumbers` is empty (dry-run or no PRs detected) no rows are stamped.
 *
 * An optional `warn` callback receives a message for each version-matched row that was
 * not stamped, so the caller can surface it to the maintainer.
 */
export function stampPerIssueTable(
  text: string,
  ctx: ReleaseContext,
  warn?: (msg: string) => void,
): string {
  const { version, shippedIssueNumbers } = ctx;
  const shippedSet = new Set(shippedIssueNumbers);
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
      if (releaseCol !== `v${version}`) continue;

      // Extract the issue number from the # column (e.g., " #170 " → 170).
      const issueMatch = cols[1].trim().match(/^#(\d+)$/);
      const issueNum = issueMatch ? Number(issueMatch[1]) : NaN;

      if (shippedSet.size > 0 && !Number.isNaN(issueNum) && shippedSet.has(issueNum)) {
        cols[5] = ` ✅ v${version} `;
        lines[i] = cols.join("|");
      } else if (shippedSet.size > 0 && !Number.isNaN(issueNum) && !shippedSet.has(issueNum)) {
        warn?.(
          `[pipeline release] note: per-issue row #${issueNum} is planned for v${version} but was not in the shipped PR set — leaving unchanged (verify manually)`,
        );
      }
      // shippedSet.size === 0: no confirmed shipped issues (dry-run / no PRs detected), leave unchanged
    }
  }
  return lines.join("\n");
}

/**
 * Count per-issue ROADMAP rows planned for `version` (`→ Release == vX.Y.Z`) and how
 * many of those would be stamped given `shippedIssueNumbers`. Used to block a live
 * release that would otherwise write an inconsistent ROADMAP — shipped PRs exist and
 * the table has rows for this version, but none can be stamped because the shipped
 * PRs resolved no matching closing issues (e.g. empty `closingIssuesReferences`) (#170).
 */
export function countPerIssueRows(
  text: string,
  version: string,
  shippedIssueNumbers: number[],
): { planned: number; stampable: number } {
  const tableHeader = "| # | Impact | Config | Theme | → Release | Depends on |";
  if (!text.includes(tableHeader)) return { planned: 0, stampable: 0 };
  const shippedSet = new Set(shippedIssueNumbers);
  const lines = text.split("\n");
  let inTable = false;
  let planned = 0;
  let stampable = 0;
  for (const line of lines) {
    if (line.includes(tableHeader)) { inTable = true; continue; }
    if (!inTable) continue;
    if (line.startsWith("#") || (line.trim() !== "" && !line.startsWith("|"))) { inTable = false; continue; }
    if (!line.startsWith("| #")) continue;
    const cols = line.split("|");
    if (cols.length < 7) continue;
    if (cols[5].trim() !== `v${version}`) continue;
    planned++;
    const m = cols[1].trim().match(/^#(\d+)$/);
    if (m && shippedSet.has(Number(m[1]))) stampable++;
  }
  return { planned, stampable };
}

// ---------------------------------------------------------------------------
// Intake ROADMAP helpers (used by the `intake` sub-command, #158)
// ---------------------------------------------------------------------------

/**
 * Insert a new row in the release-plan table before the `| *(none)* |`
 * research-tracker sentinel row.
 */
export function insertReleasePlanRow(
  text: string,
  version: string,
  bump: string,
  theme: string,
  issueRef: string,
  why: string,
): string {
  const anchor = "| *(none)* |";
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.startsWith(anchor));
  if (idx === -1) {
    throw new Error(
      `ROADMAP anchor not found: release-plan-none-row` +
        ` (expected "| *(none)* |" row in the release plan table)`,
    );
  }
  const newRow = `| **v${version}** | ${bump} | ${theme} | ${issueRef} | ${why} |`;
  lines.splice(idx, 0, newRow);
  return lines.join("\n");
}

/**
 * Insert a new row in the per-issue sem-ver table before the first row whose
 * `→ Release` column is `*(none)*` (the research-tracker rows).
 */
export function insertPerIssueRow(
  text: string,
  issueNum: number,
  impact: string,
  config: string,
  theme: string,
  version: string,
  dependsOn: string,
): string {
  const tableHeader = "| # | Impact | Config | Theme | → Release | Depends on |";
  if (!text.includes(tableHeader)) {
    throw new Error(
      `ROADMAP anchor not found: per-issue-table` +
        ` (expected "${tableHeader}" header in the per-issue detail table)`,
    );
  }
  const lines = text.split("\n");
  let inTable = false;
  let insertIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(tableHeader)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (lines[i].startsWith("#") || (lines[i].trim() !== "" && !lines[i].startsWith("|"))) {
      inTable = false;
      break;
    }
    const cols = lines[i].split("|");
    if (cols.length >= 7 && cols[5].trim() === "*(none)*") {
      insertIdx = i;
      break;
    }
  }
  if (insertIdx === -1) {
    throw new Error(
      `ROADMAP anchor not found: per-issue-none-row` +
        ` (expected a row with "*(none)*" in → Release column in the per-issue detail table)`,
    );
  }
  const newRow = `| #${issueNum} | ${impact} | ${config} | ${theme} | v${version} | ${dependsOn} |`;
  lines.splice(insertIdx, 0, newRow);
  return lines.join("\n");
}

/**
 * Insert a bullet at the top of the `### vX.Y.Z` detail section, after the
 * heading line and before any existing bullets.
 */
export function insertDetailSectionBullet(
  text: string,
  version: string,
  bullet: string,
): string {
  const lines = text.split("\n");
  const headingRe = new RegExp(`^### v${escapeRegex(version)}`);
  const headingIdx = lines.findIndex((l) => headingRe.test(l));
  if (headingIdx === -1) {
    throw new Error(
      `ROADMAP anchor not found: detail-section-v${version}` +
        ` (expected "### v${version}" heading in the detail section)`,
    );
  }
  // Insert after the heading and any immediately-following blank line.
  let insertIdx = headingIdx + 1;
  if (insertIdx < lines.length && lines[insertIdx].trim() === "") {
    insertIdx++;
  }
  lines.splice(insertIdx, 0, `- ${bullet}`);
  return lines.join("\n");
}

/**
 * Apply all four ROADMAP mutations atomically in memory.
 * Throws with a named-anchor error on the first missing site.
 * The optional `warn` callback is forwarded to stampPerIssueTable for
 * per-row "planned but not shipped" notifications.
 */
export function scaffoldRoadmap(
  roadmapText: string,
  ctx: ReleaseContext,
  warn?: (msg: string) => void,
): string {
  let text = roadmapText;
  text = patchIntroLine(text, ctx);
  text = patchReleasePlanRow(text, ctx);
  text = prependShippedBlock(text, ctx);
  text = stampPerIssueTable(text, ctx, warn);
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
// Shipped issue number resolution
// ---------------------------------------------------------------------------

/**
 * For each shipped PR, fetch the GitHub issue numbers it closes and return the
 * deduplicated union plus a `hadFailures` flag. A failure means the GitHub API
 * call returned non-zero — the caller should abort in live mode rather than
 * silently producing an incomplete per-issue ROADMAP stamp.
 */
export async function collectShippedIssueNumbers(
  prs: ShippedPR[],
  deps: Pick<ReleaseDeps, "fetchPRClosingIssues" | "stderr">,
): Promise<{ issueNumbers: number[]; hadFailures: boolean }> {
  const issueNums = new Set<number>();
  let hadFailures = false;
  for (const pr of prs) {
    try {
      const closing = await deps.fetchPRClosingIssues(pr.number);
      for (const n of closing) issueNums.add(n);
    } catch (err) {
      hadFailures = true;
      deps.stderr(
        `[pipeline release] warning: could not fetch closing issues for PR #${pr.number} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { issueNumbers: [...issueNums].sort((a, b) => a - b), hadFailures };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runRelease(
  versionArg: string,
  opts: ReleaseOpts,
  cfg: { repo_dir: string; repo: string; base_branch?: string },
  deps?: ReleaseDeps,
): Promise<void> {
  const d = deps ?? realReleaseDeps(cfg.repo_dir);
  const repoDir = cfg.repo_dir;
  const rootPkgPath = path.join(repoDir, "package.json");
  const corePkgPath = path.join(repoDir, "core", "package.json");
  const roadmapPath = path.join(repoDir, "ROADMAP.md");

  // 1. Read current version for alias expansion.
  const corePkgText = d.readFile(corePkgPath);
  const previousVersion = (JSON.parse(corePkgText) as { version: string }).version;

  // 2. Resolve version — throws on invalid input.
  const resolvedVersion = resolveVersion(versionArg, previousVersion);
  d.stdout(`[pipeline release] resolved version: ${resolvedVersion}`);

  // 3. Find last git tag for git-log range (local git call, safe in all modes).
  const tagResult = d.runCommand("git", ["describe", "--tags", "--abbrev=0"], { cwd: repoDir });
  const lastTag = tagResult.code === 0 ? tagResult.stdout.trim() : "";
  if (lastTag) {
    d.stdout(`[pipeline release] git log range: ${lastTag}..HEAD`);
  } else {
    d.stdout("[pipeline release] no previous tag found; git log range: HEAD");
  }

  // 4. Read ROADMAP and extract theme (local, safe in all modes).
  const roadmapText = d.readFile(roadmapPath);
  const theme = extractTheme(roadmapText, resolvedVersion);
  const today = d.today();

  // --- Dry-run path: local-only, no file writes, no GitHub API calls ---
  if (opts.dryRun) {
    // Discover PR numbers from git log only (localOnly=true skips fetchPRTitle → gh).
    const shippedPRs = await discoverShippedPRs(lastTag, repoDir, d, /* localOnly= */ true);

    // shippedIssueNumbers is empty in dry-run: resolving closing issues requires GitHub API.
    const ctx: ReleaseContext = {
      version: resolvedVersion, previousVersion, date: today, theme,
      shippedPRs, shippedIssueNumbers: [],
    };

    // Compute version-bump diffs in memory (no file writes).
    const rootPkgOld = d.readFile(rootPkgPath);
    const rootPkgNew = bumpVersionInMemory(rootPkgOld, resolvedVersion);
    const corePkgNew = bumpVersionInMemory(corePkgText, resolvedVersion);

    const rootDiff = computeUnifiedDiff(rootPkgOld, rootPkgNew, "a/package.json", "b/package.json");
    const coreDiff = computeUnifiedDiff(corePkgText, corePkgNew, "a/core/package.json", "b/core/package.json");

    // Scaffold ROADMAP in memory and diff it (per-issue table is not stamped in dry-run).
    const patchedRoadmap = scaffoldRoadmap(roadmapText, ctx);
    const roadmapDiff = computeUnifiedDiff(roadmapText, patchedRoadmap, "a/ROADMAP.md", "b/ROADMAP.md");

    const prBody = buildPRBody(ctx, lastTag);

    d.stdout(`\n=== Resolved version: ${resolvedVersion} ===\n`);
    d.stdout(`=== package.json diff ===`);
    d.stdout(rootDiff || "(no changes)");
    d.stdout(`\n=== core/package.json diff ===`);
    d.stdout(coreDiff || "(no changes)");
    d.stdout(`\n=== ROADMAP.md diff ===`);
    d.stdout(roadmapDiff || "(no changes)");
    d.stdout(`\nNOTE: per-issue ROADMAP table stamping is omitted in dry-run (requires GitHub API for closing-issue lookup).`);
    d.stdout(`\n=== PR body ===`);
    d.stdout(prBody);
    return;
  }

  // --- Live path ---

  // 5. Pre-validate all ROADMAP anchors in memory BEFORE writing any files.
  //    scaffoldRoadmap throws with a named-anchor error if any of the four sites is missing.
  //    This guarantees a missing anchor aborts cleanly before version files are written.
  d.stdout("[pipeline release] validating ROADMAP.md anchors...");
  const validationCtx: ReleaseContext = {
    version: resolvedVersion, previousVersion, date: today, theme,
    shippedPRs: [], shippedIssueNumbers: [],
  };
  scaffoldRoadmap(roadmapText, validationCtx);  // throws on missing anchor; result discarded

  // Refuse to start if any release-managed path already has uncommitted changes (tracked
  // modifications OR untracked files). The pre-branch rollback below restores these paths
  // from HEAD via `git checkout` + `git clean`, which would silently DISCARD a maintainer's
  // pre-existing local edits and delete pre-existing untracked files. Requiring a clean slate
  // up front makes the rollback provably lossless — the paths matched HEAD when we began, so
  // restoring from HEAD restores exactly the pre-release state — and keeps the automated
  // release commit free of unrelated edits (#170 review-2).
  //
  // `--untracked-files=all` is REQUIRED: plain `git status` honors `status.showUntrackedFiles`,
  // so a maintainer with that set to `no` would slip an untracked file under `plugin/` past
  // this guard — and `scripts/build.mjs` rm -rf's `plugin/` wholesale before regenerating, so
  // that file would be destroyed. Forcing `=all` makes detection independent of user git config.
  // Ignored files under the regenerated mirror dirs (`plugin/`, `.claude-plugin/`) are EXPLICITLY
  // excluded from the lossless guarantee: those dirs are generated build output that build.mjs
  // rewrites wholesale, so anything git-ignored there is disposable by repo convention.
  const releaseManagedPaths = ["package.json", "core/package.json", "ROADMAP.md", "plugin", ".claude-plugin"];
  d.stdout("[pipeline release] checking working tree is clean in release-managed paths...");
  const statusResult = d.runCommand("git", ["status", "--porcelain", "--untracked-files=all", "--", ...releaseManagedPaths], { cwd: repoDir });
  if (statusResult.code !== 0) {
    throw new Error(
      `[pipeline release] could not verify working-tree cleanliness (git status exited ${statusResult.code}: ${statusResult.stderr.trim()})`,
    );
  }
  if (statusResult.stdout.trim()) {
    throw new Error(
      `[pipeline release] working tree has uncommitted changes in release-managed paths:\n${statusResult.stdout.trimEnd()}\n` +
      "Commit, stash, or discard them before cutting a release — the release command rewrites " +
      "package.json, core/package.json, ROADMAP.md, and the plugin/ mirror, and its abort rollback " +
      "restores those paths from HEAD (which would discard your local edits).",
    );
  }

  // Restore every file the version bump + mirror regen + ROADMAP write touch FROM HEAD on
  // ANY abort before the release branch is created (mirror-regen / CI / issue-discovery
  // failure, or an editor abort). `git checkout --` recovers package.json, core/package.json,
  // ROADMAP.md, AND the whole plugin/ mirror in one step — even if build.mjs deleted files
  // mid-regen — so it does not depend on re-running the same (failing) build; `git clean -fd`
  // then removes any untracked mirror debris build.mjs may have generated (safe because the
  // clean-tree precondition above guaranteed plugin/ and .claude-plugin/ held no untracked
  // files when the run began). Both exit codes are checked so a failed rollback is surfaced
  // loudly, not silently claimed as restored. Otherwise a stranded bump poisons a retry whose
  // previousVersion reads the bumped core (#170).
  const branch = `release/v${resolvedVersion}`;
  const restoreCheckout = (): void => {
    const r = d.runCommand(
      "git",
      ["checkout", "--", "package.json", "core/package.json", "ROADMAP.md", "plugin", ".claude-plugin"],
      { cwd: repoDir },
    );
    const clean = d.runCommand("git", ["clean", "-fd", "plugin", ".claude-plugin"], { cwd: repoDir });
    if (r.code !== 0 || clean.code !== 0) {
      d.stderr(
        `[pipeline release] ROLLBACK FAILED (git checkout exited ${r.code}: ${r.stderr.trim()}; ` +
        `git clean exited ${clean.code}: ${clean.stderr.trim()}). ` +
        "The working tree may have a stranded version bump or partial mirror — run " +
        "`git checkout -- package.json core/package.json ROADMAP.md plugin .claude-plugin && git clean -fd plugin .claude-plugin` manually before retrying.",
      );
    } else {
      d.stderr("[pipeline release] aborted before branch creation — restored package.json, core/package.json, ROADMAP.md, and the plugin/ mirror from HEAD.");
    }
  };

  let prBody: string;
  try {
    // 6. Bump version in both package.json files.
    d.stdout("[pipeline release] bumping version in package.json files...");
    bumpVersion(resolvedVersion, rootPkgPath, corePkgPath, d);

    // 7. Regenerate plugin/ mirror.
    d.stdout("[pipeline release] regenerating plugin/ mirror (node scripts/build.mjs)...");
    const buildResult = d.runCommand("node", ["scripts/build.mjs"], { cwd: repoDir });
    if (buildResult.code !== 0) {
      d.stderr(buildResult.stdout);
      d.stderr(buildResult.stderr);
      throw new Error(
        `[pipeline release] mirror regen failed: node scripts/build.mjs exited ${buildResult.code}`,
      );
    }

    // 8. CI gate — abort here if CI fails; no GitHub API has been called yet.
    d.stdout("[pipeline release] running CI gate (npm run ci)...");
    const ciResult = d.runCommand("npm", ["run", "ci"], { cwd: repoDir });
    if (ciResult.code !== 0) {
      d.stderr(ciResult.stdout);
      d.stderr(ciResult.stderr);
      throw new Error(
        `[pipeline release] CI gate failed: npm run ci exited ${ciResult.code}`,
      );
    }
    d.stdout("[pipeline release] CI passed.");

    // 9. Discover shipped PRs with title enrichment (first GitHub API call; only reached after CI).
    const shippedPRs = await discoverShippedPRs(lastTag, repoDir, d);

    // 10. Resolve shipped issue numbers from PR closing references (required for per-issue stamping).
    const { issueNumbers: shippedIssueNumbers, hadFailures: issueDiscoveryFailed } =
      await collectShippedIssueNumbers(shippedPRs, d);
    if (issueDiscoveryFailed && shippedPRs.length > 0) {
      throw new Error(
        "[pipeline release] issue discovery failed for one or more PRs — cannot reliably stamp per-issue ROADMAP rows. " +
        "Resolve the GitHub API errors above and retry, or use --dry-run to preview without per-issue stamping.",
      );
    }
    // Finding 1 (#170): shipped PRs exist and the ROADMAP has rows planned for this
    // version, but none can be stamped (the shipped PRs resolved no matching closing
    // issues, e.g. empty closingIssuesReferences) → writing would produce an
    // inconsistent release ROADMAP. Block for manual resolution. No abort when the
    // ROADMAP simply has no rows planned for this version (planned === 0).
    const { planned, stampable } = countPerIssueRows(roadmapText, resolvedVersion, shippedIssueNumbers);
    if (shippedPRs.length > 0 && planned > 0 && stampable === 0) {
      throw new Error(
        `[pipeline release] found ${shippedPRs.length} shipped PR(s) and ${planned} ROADMAP row(s) planned for v${resolvedVersion}, ` +
        `but none could be stamped — the shipped PRs resolved no matching closing issues (resolved: [${shippedIssueNumbers.join(", ") || "none"}]). ` +
        `Verify the PR→issue links (gh pr view <n> --json closingIssuesReferences) and retry, or stamp the rows manually.`,
      );
    }

    // 11. Scaffold ROADMAP in memory and build PR body.
    const ctx: ReleaseContext = {
      version: resolvedVersion, previousVersion, date: today, theme,
      shippedPRs, shippedIssueNumbers,
    };
    const patchedRoadmap = scaffoldRoadmap(roadmapText, ctx, (msg) => d.stderr(msg));
    prBody = buildPRBody(ctx, lastTag);

    // 12. Write scaffolded ROADMAP to disk.
    d.stdout("[pipeline release] writing scaffolded ROADMAP.md...");
    d.writeFile(roadmapPath, patchedRoadmap);

    // 13. Open $EDITOR for human confirmation — INSIDE the rollback guard: an editor
    // abort (non-zero exit) before the branch exists must restore the checkout (#170).
    if (!opts.noEdit) {
      const editor = process.env.EDITOR;
      if (!editor) {
        d.stderr(
          "[pipeline release] warning: $EDITOR is not set — proceeding as --no-edit (committing scaffolded ROADMAP as-is)",
        );
      } else {
        d.stdout(`[pipeline release] opening ${roadmapPath} in $EDITOR (${editor}) for review...`);
        d.spawnEditor(editor, roadmapPath);
      }
    }

    // 14a. Create the release branch. This is the rollback point of no return: once the
    // branch exists the bumped/scaffolded files live on it (not stranded on the base
    // branch), so the rollback guard ends here. A checkout failure still restores.
    d.stdout(`[pipeline release] creating branch ${branch}...`);
    const checkoutResult = d.runCommand("git", ["checkout", "-b", branch], { cwd: repoDir });
    if (checkoutResult.code !== 0) {
      throw new Error(
        `[pipeline release] git checkout -b ${branch} failed: ${checkoutResult.stderr.trim()}`,
      );
    }
  } catch (err) {
    restoreCheckout();
    throw err;
  }

  d.stdout("[pipeline release] staging release files...");
  const addResult = d.runCommand(
    "git",
    ["add", "package.json", "core/package.json", "ROADMAP.md", "plugin/"],
    { cwd: repoDir },
  );
  if (addResult.code !== 0) {
    throw new Error(`[pipeline release] git add failed: ${addResult.stderr.trim()}`);
  }

  const commitMsg = `release: ${resolvedVersion} — ${theme}\n\nIssue: #170\nPipeline-Run: 170/${today}T00:00:00Z`;
  const commitResult = d.runCommand("git", ["commit", "-m", commitMsg], { cwd: repoDir });
  if (commitResult.code !== 0) {
    throw new Error(`[pipeline release] git commit failed: ${commitResult.stderr.trim()}`);
  }
  d.stdout("[pipeline release] committed release files.");

  d.stdout("[pipeline release] pushing branch and opening release PR...");
  const pushResult = d.runCommand("git", ["push", "-u", "origin", branch], { cwd: repoDir });
  if (pushResult.code !== 0) {
    throw new Error(`[pipeline release] git push failed: ${pushResult.stderr.trim()}`);
  }

  // Use configured base_branch (from .github/pipeline.yml or --base CLI flag), default "main".
  const baseBranch = cfg.base_branch ?? "main";
  const prTitle = `release: ${resolvedVersion} — ${theme}`;
  const prResult = d.runCommand(
    "gh",
    ["pr", "create", "--title", prTitle, "--body", prBody, "--base", baseBranch],
    { cwd: repoDir },
  );
  if (prResult.code !== 0) {
    throw new Error(`[pipeline release] gh pr create failed: ${prResult.stderr.trim()}`);
  }

  const prUrl = prResult.stdout.trim();
  d.stdout(`[pipeline release] release PR opened: ${prUrl}`);
}
