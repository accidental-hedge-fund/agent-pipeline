// Exhaustive GitHub milestone open-issue listing.
// Shared by operator plan and the ship-end remaining-open gate.
// Paginate to exhaustion; drop pull requests; never use `gh issue list --limit`.

/** REST shape of one milestone from `gh api .../milestones` (paginated --slurp). */
export interface MilestoneApiRaw {
  number: number;
  title: string;
}

/**
 * REST shape of one issue from `gh api .../issues` (paginated --slurp).
 * `pull_request` is present on PRs listed under the issues endpoint.
 */
export interface MilestoneIssueApiRaw {
  number: number;
  labels?: Array<{ name: string }>;
  pull_request?: unknown;
}

export interface MilestoneOpenIssue {
  number: number;
  labels: string[];
}

/** `gh api` args: every milestone (open+closed) so a closed-milestone title still resolves. */
export function listMilestonesApiArgs(repo: string): string[] {
  return ["api", `repos/${repo}/milestones?state=all&per_page=100`, "--paginate", "--slurp"];
}

/** Resolve milestone title → number. Exact title match; null when absent. */
export function findMilestoneNumberByTitle(
  milestones: MilestoneApiRaw[],
  title: string,
): number | null {
  const hit = milestones.find((m) => m.title === title);
  return hit ? hit.number : null;
}

/**
 * Flatten `--slurp` milestone pages (`[[page1...], [page2...]]`).
 * Exported so multi-page milestone lists are regression-testable.
 */
export function parseMilestonesPages(pages: MilestoneApiRaw[][]): MilestoneApiRaw[] {
  return pages.flat();
}

/** `gh api` args: every open issue (and PR) in a milestone, paginated to completion. */
export function listMilestoneOpenIssuesApiArgs(repo: string, milestoneNumber: number): string[] {
  return [
    "api",
    `repos/${repo}/issues?state=open&milestone=${milestoneNumber}&per_page=100`,
    "--paginate",
    "--slurp",
  ];
}

/**
 * Flatten `--slurp` issue pages, drop PRs, map to {@link MilestoneOpenIssue}.
 * Must not cap at 500 — a fixed `--limit 500` on `gh issue list` silently
 * omitted selector-matched R2D issues (#673 review-2).
 */
export function parseMilestoneIssuesPages(pages: MilestoneIssueApiRaw[][]): MilestoneOpenIssue[] {
  return pages
    .flat()
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      labels: (item.labels ?? []).map((l) => l.name),
    }));
}
