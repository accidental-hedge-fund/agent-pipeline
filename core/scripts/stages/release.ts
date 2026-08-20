// Release sub-command (#170): prepares a release PR by:
// 1. Resolving the version (alias → semver)
// 2. Factory Reliability Gate for that version (#723) — default required;
//    skip via ReleaseOpts.skipFrg or config skip_frg (#1092)
// 2c. Failing closed on open candidate-linked engine-class soak defects (#755)
//    (skipped when FRG skip is active — soak attribution is FRG-linked)
// 3. Bumping both package.json files
// 4. Regenerating the plugin/ mirror (node scripts/build.mjs)
// 5. Running the CI gate (npm run ci)
// 6. Scaffolding ROADMAP.md at four mutation sites
// 7. Opening $EDITOR for human confirmation (skipped under --no-edit / --dry-run)
// 8. Committing on a new branch and opening a release PR (body includes FRG run_id
//    and, when used, open-soak-defect override evidence)
//
// Stops at the open PR — does not tag, merge, or publish. The post-merge
// release.yml workflow handles those after a separately authorized release-PR
// merge. FRG and open-soak preflights also never merge or tag.

import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  classifyFrgBlocker,
  formatFrgPrSection,
  requireFrgPassForRelease,
  type FrgEvidence,
  type FrgFsDeps,
} from "../factory-reliability-gate.ts";
import {
  formatOpenSoakDefectWaiverSection,
  projectIssueTypedAttribution,
  runOpenSoakDefectPreflight,
  type BlockingSoakDefect,
  type OpenSoakDefectWaiver,
  type SoakDefectCandidateIssue,
  type TypedSoakEvidence,
} from "../open-soak-defect-preflight.ts";
import {
  defaultLoopStoreDeps,
  readDurableRunBlockerOccurrences,
  readEvents,
} from "../loop/store.ts";
import {
  STAGE_DIAGNOSTIC_SCHEMA,
  projectStageDiagnostic,
  type StageDiagnostic,
} from "../stage-diagnostic.ts";
import { formatFrgSkipReason, resolveFrgSkip } from "../frg-skip.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReleaseOpts {
  dryRun?: boolean;
  noEdit?: boolean;
  /**
   * Optional theme for the release PR title and any best-effort ROADMAP plan-row
   * documentation. Precedence: CLI `--theme` → matching milestone title →
   * {@link PLAN_ROW_THEME_PLACEHOLDER}. ROADMAP plan-row Theme is not authority.
   */
  theme?: string;
  /**
   * Audited override reason to proceed despite open engine-class soak defects
   * (#755). Must be non-empty when a blocking set exists. Recorded on the
   * release PR body. There is no silent env/config skip.
   */
  allowOpenSoakDefects?: string;
  /**
   * Thin-ship opt-out: do not require `.agent-pipeline/frg/<ver>/latest.json`.
   * FRG remains available via `pipeline factory-gate` / durable prepare; it is
   * no longer a hard dependency of milestone ship. Default false (gate on).
   */
  skipFrg?: boolean;
}

/** Stable machine-readable identity of the release PR created by prepare. */
export interface ReleasePrepareResult {
  schema_version: 1;
  kind: "release_prepare";
  version: string;
  pr: number;
  base: string;
  head_oid: string;
}

export interface CreatedReleasePrIdentity {
  number: number;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
}

export interface ShippedPR {
  number: number;
  title: string;
}

/**
 * Milestone metadata for release plan membership (#985).
 * GitHub milestones are the sole authority for planned issue numbers.
 */
export interface ReleaseMilestoneInfo {
  title: string;
  /** Non-PR issue numbers assigned to the milestone (open + closed). */
  issueNumbers: number[];
  /** Open non-PR issues on the milestone (dry-run / status reporting). */
  openIssueCount: number;
  /** Total non-PR issues on the milestone (open + closed). */
  totalIssueCount: number;
}

/** Dry-run / prepare report for the matching version milestone. */
export type MilestoneStatusKind = "present" | "absent" | "unavailable";

export interface ReleaseContext {
  version: string;
  previousVersion: string;
  date: string;
  theme: string;
  shippedPRs: ShippedPR[];
  /** Issue numbers confirmed shipped (resolved from PR closing references). Empty in dry-run or when no PRs detected. */
  shippedIssueNumbers: number[];
  /**
   * Issue numbers for the plan-row Issues column when ensuring a missing row
   * (e.g. milestone membership). Merged with {@link shippedIssueNumbers}; never
   * invent numbers outside these sources.
   */
  planIssueNumbers?: number[];
}

/**
 * Documented placeholder when no theme is available from CLI or milestone.
 * Matches {@link extractTheme}'s missing-row return value (docs-only helper).
 */
export const PLAN_ROW_THEME_PLACEHOLDER = "<theme>";

/**
 * Documented Issues-column placeholder when milestone membership and shipped-PR
 * discovery yield no issue numbers. Never invent `#N` values.
 */
export const PLAN_ROW_ISSUES_PLACEHOLDER = "<issues>";

/**
 * Canonical unshipped release-plan row shape (single conceptual source with
 * {@link insertReleasePlanRow} / {@link patchReleasePlanRow}).
 * Columns: Release | Bump | Theme | Issues | Why this bump.
 */
export const RELEASE_PLAN_ROW_SHAPE =
  "| **vX.Y.Z** | major|minor|patch | <theme> | #N, #M | <why> |";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Outcome of classifying a candidate number parsed from a squash-merge `(#N)`
 * suffix: `pr` means GitHub confirms it is a pull request; `not-a-pr` means
 * GitHub reports it does not resolve to a pull request (the false-positive
 * parse of an issue reference on a non-PR commit); `error` means a genuine
 * API failure (network / auth / rate-limit) that could not be classified.
 */
export type PRClassification =
  | { kind: "pr" }
  | { kind: "not-a-pr" }
  | { kind: "error"; message: string };

/** Injectable I/O seam — unit tests inject fakes, production uses realReleaseDeps(). */
export interface ReleaseDeps {
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  runCommand(cmd: string, args: string[], opts?: { cwd?: string }): CommandResult;
  spawnEditor(editor: string, filePath: string): void;
  fetchPRTitle(num: number): Promise<string>;
  /**
   * Classify a candidate number parsed from a squash-merge `(#N)` suffix (#498).
   * Only called for suffix-parsed candidates — `Merge pull request #N` numbers
   * are unambiguously PRs and bypass classification.
   */
  classifyPR(num: number): Promise<PRClassification>;
  /** Fetch the issue numbers closed by a given PR via `gh pr view --json closingIssuesReferences`. */
  fetchPRClosingIssues(num: number): Promise<number[]>;
  /** Resolve the GitHub-authored identity of the PR for the known release branch. */
  inspectCreatedPR?(branch: string): Promise<CreatedReleasePrIdentity>;
  today(): string;
  stdout(msg: string): void;
  stderr(msg: string): void;
  /**
   * Factory Reliability Gate lookup for the resolved version (#723).
   * Defaults to reading `.agent-pipeline/frg/<version>/latest.json` via
   * {@link requireFrgPassForRelease}. Tests inject a fake that returns a pass
   * artifact (or throws) without touching the filesystem.
   */
  requireFrgPass?(repoDir: string, version: string): Promise<FrgEvidence>;
  /**
   * Look up a GitHub milestone matching the resolved version (#985).
   * Return null when listed milestones contain no match (absent).
   * Throw on network/auth/API failure so dry-run can report `unavailable`
   * and live prepare can fail closed. Planned membership is milestone-only.
   */
  fetchMilestoneForVersion?(version: string): Promise<ReleaseMilestoneInfo | null>;
  /**
   * Open soak-defect candidate issues for release preflight (#755).
   * Defaults to a paginated `gh api` issue list. Tests inject fakes — never
   * rely on real network. Missing injection in tests should return `[]`.
   */
  listOpenSoakDefectCandidates?(): Promise<SoakDefectCandidateIssue[]>;
  /**
   * Closed soak-defect issues for fingerprint reconciliation (#755).
   * Defaults to a paginated closed-issue list. Used so ledger evidence with
   * `issueNumber: null` does not re-block after the matching GitHub issue closed.
   */
  listClosedSoakDefectCandidates?(): Promise<SoakDefectCandidateIssue[]>;
  /**
   * Typed terminal/recovery soak evidence for the candidate FRG/loop run (#755).
   * Defaults to durable-loop blocker occurrences + stage diagnostics when
   * `loop_run_id` is present, and GitHub #760/#763 attribution matched by
   * FRG `run_id` and/or `loop_run_id` (FRG run alone is sufficient).
   */
  listTypedSoakEvidence?(args: {
    loopRunId: string | null;
    frgRunId: string;
  }): Promise<TypedSoakEvidence[]>;
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
    classifyPR: async (num) => {
      const result = spawnSync(
        "gh",
        ["pr", "view", String(num), "--json", "number"],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status === 0) return { kind: "pr" };
      const stderr = result.stderr ?? "";
      if (/could not resolve to a pullrequest/i.test(stderr)) {
        return { kind: "not-a-pr" };
      }
      return {
        kind: "error",
        message: stderr.trim() || `gh pr view #${num} exited ${result.status}`,
      };
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
    inspectCreatedPR: async (branch) => {
      const result = spawnSync(
        "gh",
        ["pr", "view", branch, "--json", "number,baseRefName,headRefName,headRefOid"],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `gh pr view ${branch} --json number,baseRefName,headRefName,headRefOid failed ` +
            `(exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const data = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
      return {
        number: Number(data.number),
        baseRefName: String(data.baseRefName ?? ""),
        headRefName: String(data.headRefName ?? ""),
        headRefOid: String(data.headRefOid ?? ""),
      };
    },
    today: () => new Date().toISOString().slice(0, 10),
    stdout: (msg) => process.stdout.write(msg + "\n"),
    stderr: (msg) => process.stderr.write(msg + "\n"),
    fetchMilestoneForVersion: async (version) => {
      // null = no matching milestone (absent). Throw on API/network failure so
      // callers can fail closed (live) or report unavailable (dry-run).
      const repoResult = spawnSync(
        "gh",
        ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (repoResult.status !== 0) {
        throw new Error(
          `gh repo view failed (exit ${repoResult.status}): ${repoResult.stderr?.trim() ?? ""}`,
        );
      }
      const repo = repoResult.stdout.trim();
      if (!repo) {
        throw new Error("gh repo view returned empty nameWithOwner");
      }

      const msResult = spawnSync(
        "gh",
        listReleaseMilestonesApiArgs(repo),
        { encoding: "utf8", stdio: "pipe", cwd: repoDir, maxBuffer: 10 * 1024 * 1024 },
      );
      if (msResult.status !== 0) {
        throw new Error(
          `gh api milestones failed (exit ${msResult.status}): ${msResult.stderr?.trim() ?? ""}`,
        );
      }
      // Paginate to completion (#985 review): a match beyond page 1 must not
      // be treated as absent (fail-closed live prepare would block valid releases).
      const milestones = parseReleaseMilestonesStdout(msResult.stdout || "[]");
      const match = findMilestoneMatchingVersion(milestones, version);
      if (!match) return null;

      const issuesResult = spawnSync(
        "gh",
        [
          "api",
          `repos/${repo}/issues?milestone=${match.number}&state=all&per_page=100`,
          "--paginate",
        ],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir, maxBuffer: 20 * 1024 * 1024 },
      );
      if (issuesResult.status !== 0) {
        throw new Error(
          `gh api milestone issues failed (exit ${issuesResult.status}): ${issuesResult.stderr?.trim() ?? ""}`,
        );
      }
      let items: Array<{
        number?: number;
        pull_request?: unknown;
        state?: string;
      }> = [];
      if (issuesResult.stdout.trim()) {
        // --paginate without --slurp concatenates JSON arrays; parse each page blob.
        const raw = issuesResult.stdout.trim();
        try {
          items = JSON.parse(raw) as typeof items;
        } catch {
          // Multi-page concat: split on "][" boundaries
          const joined = raw.replace(/\]\s*\[/g, ",");
          try {
            items = JSON.parse(joined) as typeof items;
          } catch {
            throw new Error("gh api milestone issues returned unparseable JSON");
          }
        }
      }
      // Milestones list both issues and PRs; plan membership is non-PR issues only.
      const nonPr = items.filter(
        (i) => i && typeof i.number === "number" && !i.pull_request,
      );
      const issueNumbers = nonPr.map((i) => i.number as number);
      const openIssueCount = nonPr.filter((i) => (i.state ?? "open") === "open").length;
      return {
        title: match.title,
        issueNumbers,
        openIssueCount,
        totalIssueCount: nonPr.length,
      };
    },
    listOpenSoakDefectCandidates: async () => listSoakDefectCandidatesReal("open", repoDir),
    listClosedSoakDefectCandidates: async () => listSoakDefectCandidatesReal("closed", repoDir),
    listTypedSoakEvidence: async ({ loopRunId, frgRunId }) =>
      listTypedSoakEvidenceReal(loopRunId, frgRunId, repoDir),
  };
}

type GhIssuePageRow = {
  number: number;
  title: string;
  state: string;
  created_at: string;
  body?: string | null;
  labels?: Array<{ name: string }>;
  pull_request?: unknown;
};

/**
 * Real gh-backed issue listing for open-soak-defect preflight (#755).
 * Projects #760 typed disposition and #763 candidate run ids from structured
 * issue body attribution when present (body free-text alone remains
 * non-authoritative in the pure preflight).
 */
function listSoakDefectCandidatesReal(
  state: "open" | "closed",
  repoDir?: string,
): SoakDefectCandidateIssue[] {
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/{owner}/{repo}/issues?state=${state}&per_page=100`,
      "--paginate",
      "--slurp",
    ],
    { encoding: "utf8", stdio: "pipe", cwd: repoDir, maxBuffer: 50 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `[pipeline release] open-soak-defect preflight: gh issue list (${state}) failed: ${result.stderr?.trim() || `exit ${result.status}`}`,
    );
  }
  let pages: GhIssuePageRow[][];
  try {
    pages = JSON.parse(result.stdout || "[]") as GhIssuePageRow[][];
  } catch (err) {
    throw new Error(
      `[pipeline release] open-soak-defect preflight: could not parse issue list: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return pages
    .flat()
    .filter((i) => i && typeof i.number === "number" && !i.pull_request)
    .map((i) => mapGhIssueToSoakCandidate(i));
}

/** Map a raw GitHub issue row into the soak-defect candidate shape. */
export function mapGhIssueToSoakCandidate(i: {
  number: number;
  title?: string;
  state?: string;
  created_at?: string;
  body?: string | null;
  labels?: Array<{ name: string }>;
}): SoakDefectCandidateIssue {
  const body = i.body ?? "";
  const attribution = projectIssueTypedAttribution(body);
  return {
    number: i.number,
    title: i.title ?? "",
    state: (i.state?.toLowerCase() === "closed" ? "CLOSED" : "OPEN") as "OPEN" | "CLOSED",
    createdAt: i.created_at ?? "",
    labels: (i.labels ?? []).map((l) => l.name),
    body,
    typedDisposition: attribution.typedDisposition,
    candidateRunIds: attribution.candidateRunIds.length > 0 ? attribution.candidateRunIds : undefined,
  };
}

/**
 * Project durable-loop blocker occurrences, canonical stage diagnostics, and
 * GitHub #760/#763 attribution for the candidate soak into typed preflight
 * evidence. Terminal + engine-class → blocking candidate; non-terminal recovered
 * intermediates are marked recovered so they do not block alone.
 *
 * Local ledger/diagnostic reads require `loop_run_id` to scope safely. GitHub
 * typed attribution (#760/#763) uses FRG `run_id` as a primary soak identity and
 * still runs when `loop_run_id` is absent (#755).
 */
async function listTypedSoakEvidenceReal(
  loopRunId: string | null,
  frgRunId: string,
  repoDir?: string,
): Promise<TypedSoakEvidence[]> {
  const out: TypedSoakEvidence[] = [];

  // Host-local durable ledger + stage diagnostics: only when loop_run_id is
  // known. Without it, do not invent cross-run attribution from the whole
  // host ledger — but still proceed to GitHub FRG-run attribution below.
  if (loopRunId) {
    const storeDeps = defaultLoopStoreDeps();
    const occurrences = await readDurableRunBlockerOccurrences(storeDeps);
    for (const occ of occurrences) {
      if (occ.runId !== loopRunId) continue;
      const engineClass = classifyFrgBlocker(occ.blockerClass) === "engine-class";
      out.push({
        issueNumber: null,
        loopRunId: occ.runId,
        frgRunId,
        terminal: occ.terminal,
        // Non-terminal occurrences in a completed run are treated as recovered
        // intermediates unless still terminal at stop.
        recovered: !occ.terminal,
        engineClass,
        blockerClass: occ.blockerClass,
        title: `durable-run blocker ${occ.blockerClass}:${occ.fingerprint}`,
        reasonKey: occ.blockerClass,
        fingerprint: occ.fingerprint,
      });
    }

    // Canonical pipeline/stage-diagnostic@1 from the durable loop events log.
    out.push(...(await listStageDiagnosticTypedEvidence(loopRunId, frgRunId, storeDeps)));
  }

  // Cross-host / no-local-ledger path: project structured GitHub attribution
  // (#760 disposition + #763 candidate runs + terminal stop) into typed evidence.
  // FRG run_id alone is sufficient soak identity when loop_run_id is missing.
  out.push(...listGithubAttributedTypedEvidence(loopRunId, frgRunId, repoDir));

  return out;
}

/**
 * Read candidate-scoped canonical stage diagnostics from the durable loop
 * events log and project engine-class terminal diagnostics into typed evidence.
 */
export async function listStageDiagnosticTypedEvidence(
  loopRunId: string,
  frgRunId: string,
  storeDeps = defaultLoopStoreDeps(),
): Promise<TypedSoakEvidence[]> {
  const out: TypedSoakEvidence[] = [];
  let events: Array<{ kind: string; data: unknown }>;
  try {
    events = (await readEvents(storeDeps, loopRunId)) as Array<{ kind: string; data: unknown }>;
  } catch {
    return out;
  }
  for (const ev of events) {
    const data = (ev.data && typeof ev.data === "object" ? ev.data : null) as Record<
      string,
      unknown
    > | null;
    if (!data) continue;
    const diagnostic = extractStageDiagnostic(data);
    if (!diagnostic) continue;
    const projection = projectStageDiagnostic(diagnostic);
    if (projection.disposition === "protocol_failure") continue;
    const engineClass = classifyFrgBlocker(projection.blockerClass) === "engine-class";
    // Recovery-exhaustion / terminal stop events are terminal; other diagnostic
    // embeddings without an exhaustion signal are treated as recovered intermediates.
    const terminal =
      ev.kind === "loop_run_stopped" ||
      ev.kind === "loop_recovery_exhausted" ||
      (typeof data.outcome === "string" && /exhaust|terminal|failed/i.test(data.outcome)) ||
      data.terminal === true;
    const recovered = !terminal;
    out.push({
      issueNumber: typeof data.issue_number === "number" ? data.issue_number : null,
      loopRunId,
      frgRunId,
      terminal,
      recovered,
      engineClass,
      blockerClass: projection.blockerClass,
      title: `stage-diagnostic ${diagnostic.reason_code}:${diagnostic.evidence_key}`,
      reasonKey: diagnostic.reason_code,
      fingerprint: diagnostic.evidence_key,
    });
  }
  return out;
}

function extractStageDiagnostic(data: Record<string, unknown>): StageDiagnostic | null {
  const direct = data.diagnostic;
  if (
    direct &&
    typeof direct === "object" &&
    !Array.isArray(direct) &&
    (direct as StageDiagnostic).schema === STAGE_DIAGNOSTIC_SCHEMA
  ) {
    return direct as StageDiagnostic;
  }
  // Some recovery evidence embeds the diagnostic at the top level.
  if (data.schema === STAGE_DIAGNOSTIC_SCHEMA) {
    return data as unknown as StageDiagnostic;
  }
  return null;
}

/**
 * Project open GitHub issues with structured engine-class attribution into typed
 * soak evidence so a release host without the local loop ledger still fails
 * closed on candidate-linked defects. Pure — injectable issues for unit tests.
 *
 * Authoritative terminal/recovery outcome is required: only an explicit
 * `**Terminal stop**: yes|no` marker projects typed evidence. When that marker
 * is absent, no typed row is emitted (including recovered/suppressing rows) so
 * the issue stays eligible for historical label fallback (#755).
 */
export function projectGithubAttributedTypedEvidence(
  issues: SoakDefectCandidateIssue[],
  loopRunId: string | null,
  frgRunId: string,
): TypedSoakEvidence[] {
  const soakIds = [loopRunId, frgRunId].filter((x): x is string => !!x && x.trim() !== "");
  if (soakIds.length === 0) return [];
  const out: TypedSoakEvidence[] = [];
  for (const issue of issues) {
    const attr = projectIssueTypedAttribution(issue.body);
    const disposition = issue.typedDisposition ?? attr.typedDisposition;
    if (!disposition) continue;
    const engineClass = classifyFrgBlocker(disposition) === "engine-class";
    if (!engineClass) continue;
    const runIds = issue.candidateRunIds ?? attr.candidateRunIds;
    const linked =
      runIds.some((id) => soakIds.includes(id)) ||
      soakIds.some((id) => `${issue.title}\n${issue.body}`.includes(id));
    if (!linked) continue;
    // Missing terminal outcome is not "recovered" — do not emit suppressing
    // typed evidence that would defeat label fallback on open engine-class bugs.
    if (attr.terminalStop == null) continue;
    const terminal = attr.terminalStop === true;
    out.push({
      issueNumber: issue.number,
      loopRunId,
      frgRunId,
      terminal,
      recovered: !terminal,
      engineClass,
      blockerClass: disposition,
      title: issue.title,
      reasonKey: disposition,
      fingerprint: attr.fingerprint ?? undefined,
    });
  }
  return out;
}

/**
 * Live GitHub-backed projection wrapper. Soft-fails on gh errors so local
 * ledger/diagnostic hits still participate when available.
 */
function listGithubAttributedTypedEvidence(
  loopRunId: string | null,
  frgRunId: string,
  repoDir?: string,
): TypedSoakEvidence[] {
  let issues: SoakDefectCandidateIssue[];
  try {
    issues = listSoakDefectCandidatesReal("open", repoDir);
  } catch {
    // Soft-fail: ledger + diagnostics still participate; missing gh must not
    // invent empty typed coverage that would clear a real ledger hit.
    return [];
  }
  return projectGithubAttributedTypedEvidence(issues, loopRunId, frgRunId);
}

/**
 * Resolve the previous release tag's creation timestamp for the post-tag
 * label-fallback window. Prefers annotated tagger date; falls back to
 * creatordate (lightweight tags / commit time) when taggerdate is empty.
 */
export function resolvePreviousTagCreatedAt(
  tag: string,
  runCommand: ReleaseDeps["runCommand"],
  cwd: string,
): string | null {
  // Prefer for-each-ref: taggerdate is the annotated tag object time; creatordate
  // is the target commit time (lightweight-tag fallback).
  const refResult = runCommand(
    "git",
    [
      "for-each-ref",
      "--format=%(taggerdate:iso-strict)%00%(creatordate:iso-strict)",
      `refs/tags/${tag}`,
    ],
    { cwd },
  );
  if (refResult.code === 0 && refResult.stdout.trim()) {
    const line = refResult.stdout.trim().split("\n")[0] ?? "";
    const [tagger, creator] = line.split("\0");
    if (tagger && tagger.trim()) return tagger.trim();
    if (creator && creator.trim()) return creator.trim();
  }
  // Legacy fallback for environments that only answer git-log committer time.
  const logResult = runCommand("git", ["log", "-1", "--format=%cI", tag], { cwd });
  if (logResult.code === 0 && logResult.stdout.trim()) {
    return logResult.stdout.trim();
  }
  return null;
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
  deps: Pick<ReleaseDeps, "runCommand" | "fetchPRTitle" | "classifyPR" | "stderr">,
  localOnly = false,
): Promise<ShippedPR[]> {
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const result = deps.runCommand("git", ["log", "--pretty=format:%s", range], { cwd: repoDir });

  if (result.code !== 0) {
    deps.stderr(`[pipeline release] warning: git log failed: ${result.stderr.trim()}`);
    return [];
  }

  // `mergePRNums` are parsed from an unambiguous `Merge pull request #N` subject —
  // definitionally PRs, trusted without classification. `candidateNums` are parsed
  // from a trailing `(#N)` suffix, which a non-PR commit (e.g. a docs commit ending
  // in an issue reference) can also produce — these require classification (#498).
  const mergePRNums = new Set<number>();
  const candidateNums = new Set<number>();
  for (const line of result.stdout.split("\n")) {
    for (const m of line.matchAll(MERGE_PR_RE)) mergePRNums.add(Number(m[1]));
    // Pipeline squash commits carry both issue and PR numbers: "...title (#issue) (#pr)".
    // Only the last (# N) on the line is the actual squash-merge PR number.
    const squashMatches = [...line.matchAll(SQUASH_PR_RE)];
    if (squashMatches.length > 0) candidateNums.add(Number(squashMatches[squashMatches.length - 1][1]));
  }

  const allNums = new Set([...mergePRNums, ...candidateNums]);
  if (allNums.size === 0) {
    deps.stderr("[pipeline release] warning: no merged PRs detected in git log since last tag");
    return [];
  }

  const sorted = [...allNums].sort((a, b) => a - b);
  if (localOnly) {
    // Dry-run path: return placeholder titles without calling any GitHub API.
    return sorted.map((num) => ({ number: num, title: `PR #${num}` }));
  }

  const prs: ShippedPR[] = [];
  for (const num of sorted) {
    if (!mergePRNums.has(num)) {
      // Suffix-parsed candidate — classify before trusting it as a PR.
      const classification = await deps.classifyPR(num);
      if (classification.kind === "not-a-pr") {
        deps.stderr(
          `[pipeline release] warning: #${num} is not a pull request — excluding from shipped set ` +
          `(likely an issue reference on a non-PR commit)`,
        );
        continue;
      }
      // On a genuine classification error, fall through and still attempt title
      // enrichment: the number may be a real PR whose failure surfaces (and
      // aborts the release) at closing-issue resolution, preserving the
      // existing safety net rather than silently dropping it here.
    }
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
    if (cols.length >= 4) return cols[3].trim() || PLAN_ROW_THEME_PLACEHOLDER;
  }
  return PLAN_ROW_THEME_PLACEHOLDER;
}

/** True when any plan-row line starts with `| **v{version}**` (shipped or not). */
export function hasReleasePlanRow(roadmapText: string, version: string): boolean {
  return roadmapText.split("\n").some((l) => l.startsWith(`| **v${version}**`));
}

/**
 * Strip a leading version prefix from a milestone title for use as Theme.
 * e.g. `v1.29.0 — Factory reliability` → `Factory reliability`.
 */
export function themeFromMilestoneTitle(title: string, version: string): string {
  const trimmed = title.trim();
  if (!trimmed) return PLAN_ROW_THEME_PLACEHOLDER;
  const re = new RegExp(`^v?${escapeRegex(version)}\\s*[—:\\-]\\s*`, "i");
  const stripped = trimmed.replace(re, "").trim();
  return stripped || trimmed;
}

/**
 * Resolve theme for release PR / docs: CLI `--theme` → milestone title →
 * documented placeholder. ROADMAP plan-row Theme is not authority (#985).
 */
export function resolveReleaseTheme(args: {
  cliTheme?: string;
  /** Unused for theme authority; retained for call-site compatibility. */
  roadmapText?: string;
  version: string;
  milestoneTitle?: string | null;
}): string {
  if (args.cliTheme?.trim()) return args.cliTheme.trim();
  if (args.milestoneTitle?.trim()) {
    return themeFromMilestoneTitle(args.milestoneTitle.trim(), args.version);
  }
  return PLAN_ROW_THEME_PLACEHOLDER;
}

/**
 * `gh api` args for every repo milestone (open+closed), paginated to completion.
 * `--paginate` follows Link headers past the first `per_page=100` page so a
 * matching release milestone on a later page is not treated as absent (#985).
 * `--slurp` yields a JSON array of pages for reliable multi-page parse.
 */
export function listReleaseMilestonesApiArgs(repo: string): string[] {
  return [
    "api",
    `repos/${repo}/milestones?state=all&per_page=100`,
    "--paginate",
    "--slurp",
  ];
}

export type ReleaseMilestoneApiRaw = {
  number: number;
  title: string;
};

/**
 * Flatten paginated milestone list stdout from `gh api ... --paginate --slurp`
 * (`[[page1...], [page2...]]`) or a single-page bare array.
 */
export function parseReleaseMilestonesStdout(stdout: string): ReleaseMilestoneApiRaw[] {
  const raw = JSON.parse(stdout.trim() || "[]") as unknown;
  if (!Array.isArray(raw)) return [];
  if (raw.length > 0 && Array.isArray(raw[0])) {
    return (raw as ReleaseMilestoneApiRaw[][]).flat();
  }
  // Non-slurp single page, or --paginate concat repaired by callers.
  return raw as ReleaseMilestoneApiRaw[];
}

/**
 * Version-aware milestone title match (title contains `vX.Y.Z` or a bare
 * `X.Y.Z` token bounded so it does not match a different patch/minor).
 *
 * Returns the sole matching milestone, or null when none match.
 * When two or more milestones match, throws {@link ambiguousMilestoneError}
 * so live prepare cannot silently pick an arbitrary REST-list order entry
 * and open a release PR with the wrong plan membership (#985 review 2).
 */
export function findMilestoneMatchingVersion(
  milestones: ReleaseMilestoneApiRaw[],
  version: string,
): ReleaseMilestoneApiRaw | null {
  const matches = milestones.filter((m) => {
    const t = m.title ?? "";
    return (
      t.includes(`v${version}`) ||
      new RegExp(`(?:^|[^0-9.])${escapeRegex(version)}(?:[^0-9.]|$)`).test(t)
    );
  });
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw ambiguousMilestoneError(version, matches);
  }
  return matches[0]!;
}

/**
 * Format dry-run / prepare milestone status line for the resolved version.
 * Does not invent membership when status is absent or unavailable.
 */
export function formatMilestoneStatusLine(
  version: string,
  status: MilestoneStatusKind,
  counts?: { open: number; total?: number },
  reason?: string,
): string {
  if (status === "present") {
    const open = counts?.open ?? 0;
    const totalPart =
      counts?.total != null ? `, total non-PR: ${counts.total}` : "";
    return (
      `[pipeline release] milestone: present for ${version}` +
      ` (open issues: ${open}${totalPart})`
    );
  }
  if (status === "absent") {
    return `[pipeline release] milestone: absent for ${version}`;
  }
  const detail = reason?.trim() ? ` (${reason.trim()})` : "";
  return `[pipeline release] milestone: unavailable for ${version}${detail}`;
}

/** Live-prepare error when the matching GitHub milestone is missing. */
export function missingMilestoneError(version: string): Error {
  return new Error(
    `[pipeline release] no GitHub milestone matching version ${version}. ` +
      `Release plan membership is milestone-authoritative. ` +
      `Create the milestone and assign planned issues, or run \`pipeline roadmap --apply\`, then retry.`,
  );
}

/**
 * Live-prepare error when more than one GitHub milestone matches the version.
 * GitHub permits duplicate titles; REST list order is not a disambiguation contract.
 */
export function ambiguousMilestoneError(
  version: string,
  matches: Array<{ number: number; title: string }>,
): Error {
  const listed = matches
    .map((m) => `#${m.number} "${m.title ?? ""}"`)
    .join("; ");
  return new Error(
    `[pipeline release] ambiguous GitHub milestones matching version ${version}: ${listed}. ` +
      `Release plan membership requires exactly one matching milestone. ` +
      `Rename or close the extras so only one title matches v${version} (or bare ${version}), then retry.`,
  );
}

/** True when `err` is an {@link ambiguousMilestoneError} (by message contract). */
export function isAmbiguousMilestoneError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /\[pipeline release\] ambiguous GitHub milestones matching version /.test(err.message)
  );
}

/** Live-prepare error when milestone lookup fails (network/auth/API). */
export function unavailableMilestoneError(version: string, reason: string): Error {
  return new Error(
    `[pipeline release] could not load GitHub milestone for version ${version}: ${reason}. ` +
      `Release plan membership is milestone-authoritative; retry when GitHub is available.`,
  );
}

/** Format Issues column from discovered numbers; placeholder when empty. */
export function formatPlanRowIssues(issueNumbers: number[]): string {
  const uniq = [...new Set(issueNumbers.filter((n) => Number.isFinite(n) && n > 0))].sort(
    (a, b) => a - b,
  );
  if (uniq.length === 0) return PLAN_ROW_ISSUES_PLACEHOLDER;
  return uniq.map((n) => `#${n}`).join(", ");
}

/** Why-column note for release-scaffolded plan rows (operator-editable). */
export function planRowScaffoldWhy(version: string): string {
  return `Scaffolded by pipeline release for v${version} cut.`;
}

/** Build one unshipped plan-row line in the insert/patch shape. */
export function formatReleasePlanRow(
  version: string,
  bump: string,
  theme: string,
  issues: string,
  why: string,
): string {
  return `| **v${version}** | ${bump} | ${theme} | ${issues} | ${why} |`;
}

/**
 * Derive major/minor/patch bump label from a resolved X.Y.Z version.
 * Exported for plan-row scaffold and tests (#730).
 */
export function versionBumpType(version: string): "major" | "minor" | "patch" {
  const parts = version.split(".").map(Number);
  const patch = parts[2] ?? 0;
  const minor = parts[1] ?? 0;
  if (patch > 0) return "patch";
  if (minor > 0) return "minor";
  return "major";
}

export interface EnsureReleasePlanRowOpts {
  version: string;
  theme?: string;
  issues?: string;
  why?: string;
}

/**
 * Ensure an unshipped release-plan row exists for `version` before ship mutations.
 *
 * - Unshipped `| **v{version}** |` present → unchanged (no duplicate).
 * - Only shipped `| **v{version}** ✅ shipped |` present → unchanged (never un-ship).
 * - Missing → insert via {@link insertReleasePlanRow} before `| *(none)* |`.
 * - Insert impossible → structured remediation error (file, copy-paste row, location).
 */
export function ensureReleasePlanRow(text: string, opts: EnsureReleasePlanRowOpts): string {
  const { version } = opts;
  const lines = text.split("\n");
  const hasUnshipped = lines.some(
    (l) => l.startsWith(`| **v${version}**`) && !l.includes("✅ shipped"),
  );
  if (hasUnshipped) return text;

  const hasShipped = lines.some(
    (l) => l.startsWith(`| **v${version}**`) && l.includes("✅ shipped"),
  );
  if (hasShipped) return text;

  const bump = versionBumpType(version);
  const theme = opts.theme?.trim() || PLAN_ROW_THEME_PLACEHOLDER;
  const issues = opts.issues?.trim() || PLAN_ROW_ISSUES_PLACEHOLDER;
  const why = opts.why?.trim() || planRowScaffoldWhy(version);
  const example = formatReleasePlanRow(version, bump, theme, issues, why);

  try {
    return insertReleasePlanRow(text, version, bump, theme, issues, why);
  } catch {
    throw new Error(
      `ROADMAP anchor not found: release-plan-none-row` +
        ` (cannot auto-scaffold missing release-plan-row for v${version}).\n` +
        `File: ROADMAP.md\n` +
        `Expected insert location: before the \`| *(none)* |\` sentinel in the release-plan table ` +
        `(restore that table/sentinel if missing).\n` +
        `Copy-paste this unshipped plan row:\n` +
        `  ${example}\n` +
        `Column shape: | Release | Bump | Theme | Issues | Why this bump | — unshipped Release cell is \`| **vX.Y.Z** |\`.\n` +
        `Canonical shape: ${RELEASE_PLAN_ROW_SHAPE}`,
    );
  }
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
      ` Shipped ${date} (tag \`v${version}\`). See CHANGELOG.md. `;
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
 * many of those would be stamped given `shippedIssueNumbers`. Advisory only (#985):
 * stamp mismatch no longer aborts release prepare; milestones own plan membership.
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
  issueNum: number | string,
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
 * Validate the GLOBAL ROADMAP anchors that every intake insertion depends on — the
 * release-plan `| *(none)* |` sentinel row and the per-issue sem-ver table header.
 * Their absence means ROADMAP.md is fundamentally malformed, distinct from a missing
 * TARGET-RELEASE `### vX.Y.Z` detail section (a legitimate, scaffoldable gap for a
 * milestone created without ROADMAP structure — see scaffoldDetailSectionHeading).
 * Intended to run as a precondition BEFORE the intake spec-generation harness call,
 * so a malformed ROADMAP aborts at zero token cost.
 */
export function validateGlobalRoadmapAnchors(text: string): void {
  // Line-anchored (not a bare substring search): the per-issue table's own
  // "*(none)*" → Release cells contain "| *(none)* |" as a mid-line substring, which
  // would false-positive a substring check even when the release-plan sentinel ROW
  // itself is missing.
  if (!text.split("\n").some((l) => l.startsWith("| *(none)* |"))) {
    throw new Error(
      `ROADMAP anchor not found: release-plan-none-row` +
        ` (expected "| *(none)* |" row in the release plan table)`,
    );
  }
  const tableHeader = "| # | Impact | Config | Theme | → Release | Depends on |";
  if (!text.includes(tableHeader)) {
    throw new Error(
      `ROADMAP anchor not found: per-issue-table` +
        ` (expected "${tableHeader}" header in the per-issue detail table)`,
    );
  }
}

/**
 * Scaffold a minimal `### vX.Y.Z` detail-section heading into the
 * "Remaining work — detail" section when it is absent — e.g. for a milestone created
 * via the GitHub API with no ROADMAP structure. Idempotent: a no-op when the heading
 * already exists. Throws when the container section itself is missing/unrecognizable
 * (the genuinely-unscaffoldable case, handled by the caller's degrade fallback).
 */
export function scaffoldDetailSectionHeading(text: string, version: string): string {
  const headingRe = new RegExp(`^### v${escapeRegex(version)}\\b`, "m");
  if (headingRe.test(text)) return text;

  const lines = text.split("\n");
  const containerIdx = lines.findIndex((l) => l.startsWith("## Remaining work — detail"));
  if (containerIdx === -1) {
    throw new Error(
      `ROADMAP anchor not found: detail-section-container` +
        ` (expected a "## Remaining work — detail" section to scaffold "### v${version}" into)`,
    );
  }
  let insertIdx = containerIdx + 1;
  if (insertIdx < lines.length && lines[insertIdx].trim() === "") {
    insertIdx++;
  }
  lines.splice(insertIdx, 0, `### v${version} — (intake)`, "");
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
 * Best-effort ROADMAP documentation updates for a release (#597 / #985):
 * ensure/insert plan row when anchors allow, compact ✅ ship-mark, per-issue stamps.
 *
 * ROADMAP is **not** plan authority — GitHub milestones own planned membership.
 * Missing `release-plan-row` / `release-plan-none-row` / per-issue anchors
 * warn and skip; they do not abort prepare.
 *
 * Does **not** accrete free-form "## Shipped" prose or intro-chain history —
 * those surfaces were retired in favor of generated CHANGELOG.md. The pure
 * helpers `patchIntroLine` / `prependShippedBlock` remain exported for
 * regression tests and one-off recovery, but are no longer called here.
 *
 * Tag-derived CHANGELOG for the version being released is **not** written at
 * prepare time: the annotated `vX.Y.Z` tag does not exist until after merge.
 * Post-tag refresh is owned by auto-tag-release.yml via
 * `scripts/release-docs-refresh.mjs` / `release-docs-refresh.ts` (#978).
 *
 * The optional `warn` callback receives skip/stamp notices.
 */
export function scaffoldRoadmap(
  roadmapText: string,
  ctx: ReleaseContext,
  warn?: (msg: string) => void,
): string {
  // Milestone membership is primary for Issues column; merge shipped discovery.
  const planIssues = formatPlanRowIssues([
    ...(ctx.planIssueNumbers ?? []),
    ...(ctx.shippedIssueNumbers ?? []),
  ]);
  let text = roadmapText;
  try {
    text = ensureReleasePlanRow(text, {
      version: ctx.version,
      theme: ctx.theme,
      issues: planIssues,
      why: planRowScaffoldWhy(ctx.version),
    });
  } catch (err) {
    warn?.(
      `[pipeline release] warning: skipping release-plan-row documentation update — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // #597 / #978: do not call patchIntroLine / prependShippedBlock — CHANGELOG.md
  // is generator-owned from git tags; the shipped ## [X.Y.Z] section is written
  // by post-tag docs refresh (auto-tag), not prepare. ROADMAP keeps only
  // derived docs + compact ✅ markers when anchors exist.
  try {
    text = patchReleasePlanRow(text, ctx);
  } catch (err) {
    warn?.(
      `[pipeline release] warning: skipping release-plan-row ship-mark — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    text = stampPerIssueTable(text, ctx, warn);
  } catch (err) {
    warn?.(
      `[pipeline release] warning: skipping per-issue ROADMAP stamps — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// PR body
// ---------------------------------------------------------------------------

export function buildPRBody(
  ctx: ReleaseContext,
  lastTag: string,
  frg?: FrgEvidence | null,
  openSoakWaiver?: {
    waived: OpenSoakDefectWaiver;
    blocking: BlockingSoakDefect[];
  } | null,
): string {
  const { version, theme, date, shippedPRs } = ctx;
  const since = lastTag ? `\`${lastTag}\`` : "the beginning";
  const prLines =
    shippedPRs.length > 0
      ? shippedPRs.map((pr) => `- #${pr.number} — ${pr.title}`).join("\n")
      : "_(no merged PRs detected — fill in manually)_";

  const frgSection = frg ? ["", formatFrgPrSection(frg), ""] : [];
  const waiverSection =
    openSoakWaiver && openSoakWaiver.waived
      ? ["", formatOpenSoakDefectWaiverSection(openSoakWaiver.waived, openSoakWaiver.blocking), ""]
      : [];

  return [
    `## Release: v${version} — ${theme}`,
    "",
    `**Shipped ${date}**`,
    "",
    `### Included since ${since}`,
    "",
    prLines,
    ...frgSection,
    ...waiverSection,
    "---",
    "",
    "**Merging this PR is the final step.** It auto-tags the merge commit " +
      `(annotated \`v${version}\`) and publishes the GitHub Release — no manual follow-up needed.`,
    "",
    "_Fallback only_ — if the automation doesn't run (e.g. a missing/misconfigured tag-push credential), tag manually with an **annotated** tag (`release.yml` rejects lightweight tags):",
    "```",
    `git tag -a v${version} -m "v${version} — ${theme}" && git push origin v${version}`,
    "```",
    "",
    "The automation requires the `RELEASE_TAG_TOKEN` repository secret (a fine-grained PAT with `contents: read` + `contents: write` on this repository, added as a repository Actions secret). If this is the first release on this repo, confirm it's provisioned — otherwise the auto-tag workflow falls back to the manual step above.",
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
 * call returned non-zero — the caller may warn and continue (ROADMAP stamps are
 * best-effort documentation under #985).
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
  cfg: { repo_dir: string; repo: string; base_branch?: string; release_model?: 'semver' | 'continuous'; skip_frg?: boolean },
  deps?: ReleaseDeps,
): Promise<ReleasePrepareResult | null> {
  const d = deps ?? realReleaseDeps(cfg.repo_dir);
  const repoDir = cfg.repo_dir;
  const rootPkgPath = path.join(repoDir, "package.json");
  const corePkgPath = path.join(repoDir, "core", "package.json");
  const roadmapPath = path.join(repoDir, "ROADMAP.md");

  // Refusal gate: `pipeline release` is a semver-only operation. When the
  // release_model is 'continuous', exit non-zero before any mutation. Named
  // key `roadmap.release_model` so the maintainer knows exactly what to change.
  if (cfg.release_model === 'continuous') {
    d.stderr(
      `[pipeline release] error: versioned release bundling is not available under the 'continuous' release model.\n` +
      `Set \`roadmap.release_model: semver\` (or remove the key) in .github/pipeline.yml to cut versioned releases.`,
    );
    throw new Error(
      `pipeline release is unavailable when roadmap.release_model is 'continuous'. ` +
      `Change roadmap.release_model to 'semver' or remove it to use versioned releases.`,
    );
  }

  // 1. Read current version for alias expansion.
  const corePkgText = d.readFile(corePkgPath);
  const previousVersion = (JSON.parse(corePkgText) as { version: string }).version;

  // 2. Resolve version — throws on invalid input.
  const resolvedVersion = resolveVersion(versionArg, previousVersion);
  d.stdout(`[pipeline release] resolved version: ${resolvedVersion}`);

  // 2b. Factory Reliability Gate (#723) — default fail-closed; skip via CLI
  // `--skip-frg` or config `skip_frg: true` (#1092). FRG stays available as
  // an explicit factory-gate / durable-prepare command.
  const frgSkip = resolveFrgSkip({
    cliSkip: !!opts.skipFrg,
    configSkip: cfg.skip_frg,
  });
  const skipFrg = frgSkip.skip;
  const skipReason = frgSkip.source ? formatFrgSkipReason(frgSkip.source) : null;
  let frgEvidence: FrgEvidence | null = null;
  if (skipFrg) {
    d.stdout(
      `[pipeline release] skipping Factory Reliability Gate for ${resolvedVersion} (${skipReason}); ` +
        `FRG is advisory for thin ship — run \`pipeline factory-gate --for ${resolvedVersion}\` separately if desired`,
    );
  } else {
    d.stdout(`[pipeline release] checking Factory Reliability Gate for ${resolvedVersion}...`);
    const frgRequire =
      d.requireFrgPass ??
      ((dir: string, ver: string) => {
        const fsDeps: FrgFsDeps = {
          readFile: async (p) => d.readFile(p),
          writeFile: async () => {},
          mkdir: async () => {},
          rename: async () => {},
        };
        return requireFrgPassForRelease(dir, ver, fsDeps);
      });
    frgEvidence = await frgRequire(repoDir, resolvedVersion);
    if (!frgEvidence.pass || !frgEvidence.run_id.trim()) {
      throw new Error(
        `[pipeline release] Factory Reliability Gate for ${resolvedVersion} lacks a usable pass run_id — refusing release preparation.`,
      );
    }
    d.stdout(
      `[pipeline release] FRG pass: run_id=${frgEvidence.run_id}` +
        (frgEvidence.loop_run_id ? ` loop_run_id=${frgEvidence.loop_run_id}` : ""),
    );
  }

  // 3. Find last git tag for git-log range (local git call, safe in all modes).
  const tagResult = d.runCommand("git", ["describe", "--tags", "--abbrev=0"], { cwd: repoDir });
  const lastTag = tagResult.code === 0 ? tagResult.stdout.trim() : "";
  if (lastTag) {
    d.stdout(`[pipeline release] git log range: ${lastTag}..HEAD`);
  } else {
    d.stdout("[pipeline release] no previous tag found; git log range: HEAD");
  }

  // 3b. Open soak-defect preflight (#755) — FRG-linked; skipped when skipFrg.
  const previousTagCreatedAt = lastTag
    ? resolvePreviousTagCreatedAt(lastTag, d.runCommand, repoDir)
    : null;

  let openSoakWaiver: {
    waived: OpenSoakDefectWaiver;
    blocking: BlockingSoakDefect[];
  } | null = null;
  if (skipFrg) {
    d.stdout(
      `[pipeline release] skipping open soak-defect preflight (${skipReason}; soak attribution is FRG-linked)`,
    );
  } else {
    d.stdout("[pipeline release] checking open engine-class soak defects for candidate...");
    const listOpen =
      d.listOpenSoakDefectCandidates ?? (async () => [] as SoakDefectCandidateIssue[]);
    const listClosed =
      d.listClosedSoakDefectCandidates ?? (async () => [] as SoakDefectCandidateIssue[]);
    const listTyped =
      d.listTypedSoakEvidence ??
      (async () => [] as TypedSoakEvidence[]);
    const frgRunId = frgEvidence!.run_id;
    const loopRunId = frgEvidence!.loop_run_id;
    const soakPreflight = await runOpenSoakDefectPreflight(
      {
        version: resolvedVersion,
        frgRunId,
        loopRunId,
        previousTag: lastTag || null,
        previousTagCreatedAt,
        overrideReason: opts.allowOpenSoakDefects,
      },
      {
        listOpenIssues: listOpen,
        listClosedIssues: listClosed,
        listTypedSoakEvidence: () =>
          listTyped({
            loopRunId,
            frgRunId,
          }),
      },
    );
    if (!soakPreflight.ok) {
      throw new Error(soakPreflight.message);
    }
    openSoakWaiver =
      soakPreflight.waived != null
        ? { waived: soakPreflight.waived, blocking: soakPreflight.blocking }
        : null;
    if (openSoakWaiver) {
      d.stdout(
        `[pipeline release] open-soak-defect override accepted for ${openSoakWaiver.waived.issueNumbers.map((n) => `#${n}`).join(", ") || "(defects)"} — reason recorded on PR body`,
      );
    } else {
      d.stdout("[pipeline release] open-soak-defect preflight: no blocking open engine-class defects");
    }
  }

  // 4. Resolve plan membership from the matching GitHub milestone (#985).
  //    Milestones are the sole authority for planned issues. ROADMAP is
  //    best-effort derived documentation only.
  //    Dry-run MAY perform a read-only milestone lookup; live prepare fails
  //    closed when the milestone is missing or lookup fails.
  const roadmapText = d.readFile(roadmapPath);
  const today = d.today();

  let milestoneTitle: string | null = null;
  let planIssueNumbers: number[] = [];
  let milestoneOpenCount = 0;
  let milestoneTotalCount = 0;
  let milestoneStatus: MilestoneStatusKind = "unavailable";
  let milestoneUnavailableReason: string | undefined;

  const fetchMs = d.fetchMilestoneForVersion;
  if (fetchMs) {
    try {
      const ms = await fetchMs(resolvedVersion);
      if (ms) {
        milestoneStatus = "present";
        milestoneTitle = ms.title;
        planIssueNumbers = ms.issueNumbers ?? [];
        milestoneOpenCount = ms.openIssueCount ?? 0;
        milestoneTotalCount = ms.totalIssueCount ?? planIssueNumbers.length;
      } else {
        milestoneStatus = "absent";
      }
    } catch (err) {
      // Ambiguous matches are fail-closed on live prepare: do not wrap as
      // "unavailable" (that would obscure remediation) and do not pick one.
      // Dry-run still soft-fails as unavailable with the ambiguous reason so
      // it does not invent membership or open a PR.
      if (!opts.dryRun && isAmbiguousMilestoneError(err)) {
        throw err;
      }
      milestoneStatus = "unavailable";
      milestoneUnavailableReason = err instanceof Error ? err.message : String(err);
    }
  } else if (opts.dryRun) {
    milestoneStatus = "unavailable";
    milestoneUnavailableReason = "no fetchMilestoneForVersion dependency";
  } else {
    // Live prepare without an injectable fetch seam cannot prove plan membership.
    throw unavailableMilestoneError(
      resolvedVersion,
      "fetchMilestoneForVersion dependency is not configured",
    );
  }

  if (!opts.dryRun) {
    if (milestoneStatus === "absent") {
      throw missingMilestoneError(resolvedVersion);
    }
    if (milestoneStatus === "unavailable") {
      throw unavailableMilestoneError(
        resolvedVersion,
        milestoneUnavailableReason ?? "milestone lookup failed",
      );
    }
  }

  const theme = resolveReleaseTheme({
    cliTheme: opts.theme,
    version: resolvedVersion,
    milestoneTitle,
  });

  // --- Dry-run path: no file writes. Read-only milestone lookup already ran.
  //    Shipped-PR title/closing-issue discovery stays local. ---
  if (opts.dryRun) {
    d.stdout(
      formatMilestoneStatusLine(
        resolvedVersion,
        milestoneStatus,
        milestoneStatus === "present"
          ? { open: milestoneOpenCount, total: milestoneTotalCount }
          : undefined,
        milestoneUnavailableReason,
      ),
    );

    // Discover PR numbers from git log only (localOnly=true skips fetchPRTitle → gh).
    const shippedPRs = await discoverShippedPRs(lastTag, repoDir, d, /* localOnly= */ true);

    // shippedIssueNumbers is empty in dry-run: resolving closing issues requires GitHub API.
    // planIssueNumbers may be populated from the read-only milestone lookup.
    const ctx: ReleaseContext = {
      version: resolvedVersion, previousVersion, date: today, theme,
      shippedPRs, shippedIssueNumbers: [], planIssueNumbers,
    };

    // Compute version-bump diffs in memory (no file writes).
    const rootPkgOld = d.readFile(rootPkgPath);
    const rootPkgNew = bumpVersionInMemory(rootPkgOld, resolvedVersion);
    const corePkgNew = bumpVersionInMemory(corePkgText, resolvedVersion);

    const rootDiff = computeUnifiedDiff(rootPkgOld, rootPkgNew, "a/package.json", "b/package.json");
    const coreDiff = computeUnifiedDiff(corePkgText, corePkgNew, "a/core/package.json", "b/core/package.json");

    // Best-effort ROADMAP scaffold in memory (missing anchors warn + skip).
    const dryWarnings: string[] = [];
    const patchedRoadmap = scaffoldRoadmap(roadmapText, ctx, (msg) => dryWarnings.push(msg));
    const roadmapDiff = computeUnifiedDiff(roadmapText, patchedRoadmap, "a/ROADMAP.md", "b/ROADMAP.md");

    const prBody = buildPRBody(ctx, lastTag, frgEvidence, openSoakWaiver);

    d.stdout(`\n=== Resolved version: ${resolvedVersion} ===\n`);
    d.stdout(`=== package.json diff ===`);
    d.stdout(rootDiff || "(no changes)");
    d.stdout(`\n=== core/package.json diff ===`);
    d.stdout(coreDiff || "(no changes)");
    d.stdout(`\n=== ROADMAP.md diff ===`);
    d.stdout(roadmapDiff || "(no changes)");
    for (const w of dryWarnings) d.stderr(w);
    d.stdout(`\nNOTE: per-issue ROADMAP table stamping is omitted in dry-run (requires GitHub API for closing-issue lookup).`);
    d.stdout(`\n=== PR body ===`);
    d.stdout(prBody);
    return null;
  }

  // --- Live path ---
  d.stdout(
    formatMilestoneStatusLine(resolvedVersion, "present", {
      open: milestoneOpenCount,
      total: milestoneTotalCount,
    }),
  );
  d.stdout(
    `[pipeline release] planned issues from milestone: ` +
      (planIssueNumbers.length > 0
        ? planIssueNumbers.map((n) => `#${n}`).join(", ")
        : "(none)"),
  );

  // ROADMAP documentation is best-effort; missing anchors no longer block prepare.
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
  // abort before a successful release commit (mirror-regen / CI / issue-discovery / editor
  // abort, or a failed `git add` / `git commit` after `checkout -b`). `git restore
  // --source=HEAD --staged --worktree` resets both the index and the worktree from HEAD.
  // `git checkout --` is not enough after a successful add: it copies the index into the
  // worktree and would write the staged version bumps back (#1148). `git clean -fd` then
  // removes any untracked mirror debris build.mjs may have generated (safe because the
  // clean-tree precondition above guaranteed plugin/ and .claude-plugin/ held no untracked
  // files when the run began). Never pass `.agent-pipeline/frg` to restore/clean: evidence
  // stays on disk (#1148). Both exit codes are checked so a failed rollback is surfaced
  // loudly, not silently claimed as restored. Otherwise a stranded bump poisons a retry
  // whose previousVersion reads the bumped core (#170). Point of no return is a successful
  // release commit (#1148).
  const branch = `release/v${resolvedVersion}`;
  const baseBranch = cfg.base_branch ?? "main";
  const restoreManagedFiles = (): boolean => {
    const r = d.runCommand(
      "git",
      [
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        "package.json",
        "core/package.json",
        "ROADMAP.md",
        "plugin",
        ".claude-plugin",
      ],
      { cwd: repoDir },
    );
    const clean = d.runCommand("git", ["clean", "-fd", "plugin", ".claude-plugin"], { cwd: repoDir });
    if (r.code !== 0 || clean.code !== 0) {
      d.stderr(
        `[pipeline release] ROLLBACK FAILED (git restore exited ${r.code}: ${r.stderr.trim()}; ` +
        `git clean exited ${clean.code}: ${clean.stderr.trim()}). ` +
        "The working tree may have a stranded version bump or partial mirror — run " +
        "`git restore --source=HEAD --staged --worktree -- package.json core/package.json ROADMAP.md plugin .claude-plugin && git clean -fd plugin .claude-plugin` manually before retrying.",
      );
      return false;
    }
    return true;
  };
  const restoreCheckout = (): void => {
    if (restoreManagedFiles()) {
      d.stderr("[pipeline release] aborted before branch creation — restored package.json, core/package.json, ROADMAP.md, and the plugin/ mirror from HEAD.");
    }
  };
  const restoreBaseAfterFailedStage = (): void => {
    restoreManagedFiles();
    const checkoutBase = d.runCommand("git", ["checkout", baseBranch], { cwd: repoDir });
    if (checkoutBase.code !== 0) {
      d.stderr(
        `[pipeline release] ROLLBACK FAILED (git checkout ${baseBranch} exited ${checkoutBase.code}: ${checkoutBase.stderr.trim()}). ` +
        `HEAD may still be on ${branch} with a stranded version bump — run ` +
        `\`git restore --source=HEAD --staged --worktree -- package.json core/package.json ROADMAP.md plugin .claude-plugin && git checkout ${baseBranch} && git branch -d ${branch}\` manually before retrying.`,
      );
      return;
    }
    const unique = d.runCommand(
      "git",
      ["rev-list", "--count", `${baseBranch}..${branch}`],
      { cwd: repoDir },
    );
    const raw = unique.stdout.trim();
    const uniqueCount = unique.code === 0 ? Number.parseInt(raw === "" ? "0" : raw, 10) : Number.NaN;
    if (uniqueCount === 0) {
      const del = d.runCommand("git", ["branch", "-d", branch], { cwd: repoDir });
      if (del.code !== 0) {
        d.stderr(
          `[pipeline release] warning: could not delete local ${branch} (git branch -d exited ${del.code}: ${del.stderr.trim()}). ` +
          `Delete it before retrying so \`git checkout -b ${branch}\` can succeed.`,
        );
      }
    }
    d.stderr(
      `[pipeline release] aborted after branch creation — restored release-managed files and checked out ${baseBranch}.`,
    );
  };

  let branchCreated = false;
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

    // 10. Resolve shipped issue numbers from PR closing references (best-effort ROADMAP stamps).
    const { issueNumbers: shippedIssueNumbers, hadFailures: issueDiscoveryFailed } =
      await collectShippedIssueNumbers(shippedPRs, d);
    if (issueDiscoveryFailed && shippedPRs.length > 0) {
      d.stderr(
        "[pipeline release] warning: issue discovery failed for one or more PRs — " +
          "ROADMAP per-issue stamps may be incomplete (best-effort documentation; " +
          "milestone plan membership remains authoritative).",
      );
    }
    // Advisory only (#985): ROADMAP stamp mismatch must not abort. Plan membership
    // comes from the matching GitHub milestone; ROADMAP docs are derived.
    const { planned, stampable } = countPerIssueRows(
      roadmapText,
      resolvedVersion,
      shippedIssueNumbers,
    );
    if (shippedPRs.length > 0 && planned > 0 && stampable === 0) {
      d.stderr(
        `[pipeline release] warning: found ${shippedPRs.length} shipped PR(s) and ${planned} ROADMAP row(s) planned for v${resolvedVersion}, ` +
          `but none could be stamped against shipped closing issues (resolved: [${shippedIssueNumbers.join(", ") || "none"}]). ` +
          `ROADMAP stamps are best-effort; milestone plan membership is authoritative.`,
      );
    }

    // 11. Best-effort ROADMAP documentation scaffold + PR body.
    const ctx: ReleaseContext = {
      version: resolvedVersion, previousVersion, date: today, theme,
      shippedPRs, shippedIssueNumbers, planIssueNumbers,
    };
    const patchedRoadmap = scaffoldRoadmap(roadmapText, ctx, (msg) => d.stderr(msg));
    prBody = buildPRBody(ctx, lastTag, frgEvidence, openSoakWaiver);

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

    // 14a. Create the release branch. Add and commit still roll back if they fail:
    // the branch has no unique commit until `git commit` succeeds. Point of no
    // return is a successful release commit (#1148). A checkout-b failure still
    // restores as a pre-branch abort.
    d.stdout(`[pipeline release] creating branch ${branch}...`);
    const checkoutResult = d.runCommand("git", ["checkout", "-b", branch], { cwd: repoDir });
    if (checkoutResult.code !== 0) {
      throw new Error(
        `[pipeline release] git checkout -b ${branch} failed: ${checkoutResult.stderr.trim()}`,
      );
    }
    branchCreated = true;

    // FRG evidence is gitignored (#1127 / #1148). Do not pass `.agent-pipeline/frg`
    // as an explicit pathspec — `git add` of an ignored path is a hard fail.
    // Do not `git add -f`. Do not stage CHANGELOG.md here.
    d.stdout("[pipeline release] staging release files...");
    const addPaths = ["package.json", "core/package.json", "ROADMAP.md", "plugin/"];
    const addResult = d.runCommand(
      "git",
      ["add", ...addPaths],
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
  } catch (err) {
    if (branchCreated) {
      restoreBaseAfterFailedStage();
    } else {
      restoreCheckout();
    }
    throw err;
  }

  // Successful commit is the point of no return. A later push failure stays on
  // the release branch so a retry can push the local commit (#1148).
  d.stdout("[pipeline release] pushing branch and opening release PR...");
  const pushResult = d.runCommand("git", ["push", "-u", "origin", branch], { cwd: repoDir });
  if (pushResult.code !== 0) {
    throw new Error(`[pipeline release] git push failed: ${pushResult.stderr.trim()}`);
  }

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

  // Do not make a supervisor scrape the human URL or infer the branch head.
  // Re-read the GitHub-authored PR identity and return one stable contract.
  if (!d.inspectCreatedPR) {
    throw new Error(
      "[pipeline release] release dependency cannot inspect the created PR identity",
    );
  }
  const created = await d.inspectCreatedPR(branch);
  if (!Number.isSafeInteger(created.number) || created.number <= 0) {
    throw new Error(
      `[pipeline release] created PR has an invalid number: ${JSON.stringify(created.number)}`,
    );
  }
  if (created.baseRefName !== baseBranch) {
    throw new Error(
      `[pipeline release] created PR #${created.number} targets ${JSON.stringify(created.baseRefName)}, ` +
        `expected ${JSON.stringify(baseBranch)} — refusing to return a mismatched release identity.`,
    );
  }
  if (created.headRefName !== branch) {
    throw new Error(
      `[pipeline release] created PR #${created.number} has head ${JSON.stringify(created.headRefName)}, ` +
        `expected ${JSON.stringify(branch)} — refusing to return a mismatched release identity.`,
    );
  }
  if (!/^[0-9a-f]{40,64}$/i.test(created.headRefOid)) {
    throw new Error(
      `[pipeline release] created PR #${created.number} has an invalid headRefOid: ` +
        `${JSON.stringify(created.headRefOid)}`,
    );
  }

  return {
    schema_version: 1,
    kind: "release_prepare",
    version: resolvedVersion,
    pr: created.number,
    base: created.baseRefName,
    head_oid: created.headRefOid,
  };
}
