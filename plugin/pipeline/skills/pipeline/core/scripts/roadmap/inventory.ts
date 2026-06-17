// Phase 2: Issue inventory — fetches open issues and identifies touched files.
// All external I/O is injectable via InventoryDeps for unit testing.

import type { Issue, InventoryItem, RoadmapConfig } from "./types.ts";

export interface InventoryDeps {
  getOpenIssues(repo: string, opts?: { labels?: string[] }): Promise<Issue[]>;
  readFile(path: string): Promise<string | null>;
  runHarness(prompt: string): Promise<{ success: boolean; output: string }>;
  log(msg: string): void;
}

/**
 * Compute a backlog fingerprint (SHA-ish) from open issue numbers + updatedAt timestamps.
 * Used for staleness detection in plan.json.
 */
export function computeBacklogSha(issues: Issue[]): string {
  const sorted = [...issues].sort((a, b) => a.number - b.number);
  const payload = sorted.map((i) => `${i.number}:${i.updatedAt ?? ""}`).join(",");
  // Simple hash-like fingerprint without crypto (no external dep needed)
  let h = 5381;
  for (let i = 0; i < payload.length; i++) {
    h = ((h << 5) + h) ^ payload.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Filter issues by include_labels / exclude_labels from config.
 * include_labels: issue must have at least one of these labels (when specified).
 * exclude_labels: issue must not have any of these labels.
 */
export function filterIssues(issues: Issue[], config: RoadmapConfig): Issue[] {
  return issues.filter((issue) => {
    const labels = issue.labels;
    if (config.include_labels && config.include_labels.length > 0) {
      if (!config.include_labels.some((l) => labels.includes(l))) return false;
    }
    if (config.exclude_labels && config.exclude_labels.length > 0) {
      if (config.exclude_labels.some((l) => labels.includes(l))) return false;
    }
    return true;
  });
}

/**
 * Extract file references from issue text (basic heuristic).
 * Looks for patterns like `path/to/file.ts`, backtick-wrapped paths, etc.
 */
export function extractCandidateFiles(issue: Issue): string[] {
  const text = `${issue.title}\n${issue.body}`;
  const fileRe = /`([^`]+\.[a-zA-Z]{1,6})`|(\b[\w/-]+\.(?:ts|js|md|json|yml|yaml|sh|py|go)\b)/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(text)) !== null) {
    const f = (m[1] ?? m[2] ?? "").trim();
    if (f && !f.startsWith("http") && f.length > 3) found.add(f);
  }
  return [...found].slice(0, 20);
}

/**
 * Build a comprehension prompt to identify files an issue touches.
 */
function buildTouchedFilesPrompt(issue: Issue): string {
  return (
    `You are analyzing a GitHub issue to identify which files it will touch.\n\n` +
    `## Issue #${issue.number}: ${issue.title}\n\n` +
    `${issue.body}\n\n` +
    `Based on the issue description, list the file paths (relative to repo root) that this issue will likely create, modify, or delete. ` +
    `Return only a JSON array of strings: ["path/to/file.ts", ...]. ` +
    `Return at most 15 files. If the issue is too vague to identify specific files, return [].`
  );
}

/**
 * Parse touched files from harness output: expects a JSON array of strings.
 */
export function parseTouchedFiles(output: string): string[] {
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => typeof x === "string" && x.trim().length > 0)
      .map((x: string) => x.trim())
      .slice(0, 15);
  } catch {
    return [];
  }
}

/**
 * Build the inventory: fetch all open issues, filter by config, identify touched files.
 */
export async function buildInventory(
  repo: string,
  config: RoadmapConfig,
  deps: InventoryDeps,
): Promise<InventoryItem[]> {
  deps.log("[roadmap] phase 2: inventory — fetching open issues...");

  const allIssues = await deps.getOpenIssues(repo);
  if (allIssues.length === 0) {
    deps.log("[roadmap] inventory: no open issues found");
    return [];
  }

  const filtered = filterIssues(allIssues, config);
  deps.log(`[roadmap] inventory: ${filtered.length}/${allIssues.length} issues after filtering`);

  const items: InventoryItem[] = [];
  for (const issue of filtered) {
    deps.log(`[roadmap] inventory: analyzing issue #${issue.number}: ${issue.title}`);
    // Use harness to identify touched files
    const prompt = buildTouchedFilesPrompt(issue);
    const result = await deps.runHarness(prompt);
    const touched_files = result.success
      ? parseTouchedFiles(result.output)
      : extractCandidateFiles(issue);

    items.push({ issue, touched_files });
  }

  deps.log(`[roadmap] inventory: built ${items.length} inventory items`);
  return items;
}
