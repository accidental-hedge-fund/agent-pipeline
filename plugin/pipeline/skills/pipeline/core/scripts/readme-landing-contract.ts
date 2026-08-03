// Pure README landing-page contract (#855 / docs-landing-split).
//
// Enforces the lean root README accepted by #597 / PR #790:
//   - fewer than 400 lines
//   - relative links to docs/cli.md, docs/config.md, docs/concepts.md
//   - no full hand-maintained CLI/config inventory body
//
// Pure text checks only — no filesystem, network, or git. Callers (docs
// generator --check, merge-queue re-gate, unit fixtures) supply the README
// content. Failures use stable diagnostic codes for operators and tests.

/** Maximum allowed README line count (exclusive upper bound: must be < 400). */
export const README_LANDING_MAX_LINES = 400;

/** Required relative companion link targets (path forms accepted in markdown links). */
export const README_REQUIRED_COMPANIONS = [
  "docs/cli.md",
  "docs/config.md",
  "docs/concepts.md",
] as const;

export type ReadmeLandingDiagnosticCode =
  | "line-budget"
  | "missing-companion-link"
  | "full-inventory-shape";

export interface ReadmeLandingDiagnostic {
  code: ReadmeLandingDiagnosticCode;
  message: string;
  /** Measured line count when code is line-budget. */
  lineCount?: number;
  /** Missing companion path when code is missing-companion-link. */
  companion?: string;
}

export interface ReadmeLandingContractResult {
  ok: boolean;
  lineCount: number;
  diagnostics: ReadmeLandingDiagnostic[];
}

/**
 * Count lines the same way Unix `wc -l` does: number of newline characters,
 * plus one when the final line has content without a trailing newline.
 * Empty string → 0. Committed markdown normally ends with `\n`.
 */
export function countReadmeLines(content: string): number {
  if (content.length === 0) return 0;
  const newlines = (content.match(/\n/g) ?? []).length;
  if (content.endsWith("\n")) return newlines;
  return newlines + 1;
}

/**
 * True when markdown text contains a relative link to the companion path
 * (e.g. `[text](docs/cli.md)` or `[text](./docs/cli.md)` or with anchors).
 */
export function hasRelativeCompanionLink(
  content: string,
  companion: string,
): boolean {
  const escaped = companion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Markdown link destination: optional ./, path, optional #fragment or query.
  const re = new RegExp(
    `\\]\\(\\s*\\.?/?${escaped}(?:#[^)\\s]*)?\\s*\\)`,
    "i",
  );
  return re.test(content);
}

/**
 * Heuristic for a full hand-maintained CLI/config inventory body restored into
 * the README (the #793 monolith shape). Lean landing pages may mention a few
 * commands; they must not re-host the deep operator reference inventory.
 *
 * Low-noise markers drawn from the pre-#597 monolithic README section set.
 * Trigger when several of these large reference sections co-exist.
 */
const FULL_INVENTORY_SECTION_PATTERNS: readonly RegExp[] = [
  /^##\s+Usage\s*$/m,
  /^##\s+Intake sub-command\s*$/m,
  /^##\s+Sweep sub-command\s*$/m,
  /^##\s+Backfill sub-command\s*$/m,
  /^##\s+Merge sub-command\s*$/m,
  /^##\s+Merge-queue sub-command\s*$/m,
  /^##\s+Queue sub-command/m,
  /^##\s+Improve sub-command\s*$/m,
  /^##\s+Scoreboard sub-command\s*$/m,
  /^##\s+Durable autonomous runs/m,
  /^##\s+Per-repo config/m,
  /^##\s+Worktree dependency install/m,
  /^##\s+Test\/build gate/m,
  /^##\s+Advanced topics\s*$/m,
  /^##\s+Desktop Integration\s*$/m,
  /^##\s+Troubleshooting\s*$/m,
];

/** Minimum distinct inventory-section hits to flag full-inventory shape. */
export const FULL_INVENTORY_SECTION_THRESHOLD = 4;

export function detectFullInventoryShape(content: string): boolean {
  let hits = 0;
  for (const re of FULL_INVENTORY_SECTION_PATTERNS) {
    if (re.test(content)) hits += 1;
  }
  return hits >= FULL_INVENTORY_SECTION_THRESHOLD;
}

/**
 * Check root README content against the docs-landing-split landing-page contract.
 * Pure — does not read the filesystem.
 */
export function checkReadmeLandingContract(
  content: string,
): ReadmeLandingContractResult {
  const diagnostics: ReadmeLandingDiagnostic[] = [];
  const lineCount = countReadmeLines(content);

  if (lineCount >= README_LANDING_MAX_LINES) {
    diagnostics.push({
      code: "line-budget",
      message:
        `README.md landing-page line budget exceeded: ${lineCount} lines ` +
        `(must be fewer than ${README_LANDING_MAX_LINES})`,
      lineCount,
    });
  }

  for (const companion of README_REQUIRED_COMPANIONS) {
    if (!hasRelativeCompanionLink(content, companion)) {
      diagnostics.push({
        code: "missing-companion-link",
        message:
          `README.md is missing a working relative link to ${companion}`,
        companion,
      });
    }
  }

  if (detectFullInventoryShape(content)) {
    diagnostics.push({
      code: "full-inventory-shape",
      message:
        "README.md matches a full hand-maintained CLI/config inventory shape " +
        "(monolithic operator reference sections). Keep those in docs/cli.md, " +
        "docs/config.md, and docs/concepts.md — not the landing page.",
    });
  }

  return {
    ok: diagnostics.length === 0,
    lineCount,
    diagnostics,
  };
}

/**
 * Operator-facing multi-line diagnostics block for check failures.
 * Stable header so stages and tests can match the breach class.
 */
export function formatReadmeLandingDiagnostics(
  result: ReadmeLandingContractResult,
): string {
  if (result.ok) return "";
  const lines = [
    "README landing-page contract breach:",
    `  measured_lines: ${result.lineCount}`,
  ];
  for (const d of result.diagnostics) {
    lines.push(`  - [${d.code}] ${d.message}`);
  }
  return lines.join("\n");
}

/**
 * Build a synthetic #793-shaped fixture: lean prefix + large monolithic append.
 * Used by regression tests only (exported for fixtures).
 */
export function build793ShapedMonolithicReadme(opts?: {
  leanPrefix?: string;
  appendLines?: number;
}): string {
  const lean =
    opts?.leanPrefix ??
    [
      "# agent-pipeline",
      "",
      "Lean landing page for tests.",
      "",
      "## Where to go next",
      "",
      "| Doc | What |",
      "| --- | --- |",
      "| **[docs/cli.md](docs/cli.md)** | CLI |",
      "| **[docs/config.md](docs/config.md)** | Config |",
      "| **[docs/concepts.md](docs/concepts.md)** | Concepts |",
      "",
      "### Uninstall",
      "",
      "Uninstall removes the host skill tree.",
      "",
    ].join("\n");

  const n = opts?.appendLines ?? 1800;
  const monolithSections = [
    "## Usage",
    "## Intake sub-command",
    "## Sweep sub-command",
    "## Backfill sub-command",
    "## Merge sub-command",
    "## Merge-queue sub-command",
    "## Queue sub-command (batch factory)",
    "## Improve sub-command",
    "## Scoreboard sub-command",
    "## Durable autonomous runs (`pipeline single` and `pipeline:loop`)",
    "## Per-repo config (optional)",
    "## Worktree dependency install (`setup_command`)",
    "## Test/build gate (optional, default on)",
    "## Advanced topics",
    "## Desktop Integration",
    "## Troubleshooting",
  ];
  const filler: string[] = ["", "<!-- #793-shaped monolithic append fixture -->", ""];
  for (const h of monolithSections) {
    filler.push(h, "", "Operator reference body restored incorrectly.", "");
  }
  while (filler.length < n) {
    filler.push(
      `Filler line ${filler.length} from the pre-split monolith (should not land in README).`,
    );
  }
  return `${lean}${filler.join("\n")}\n`;
}
