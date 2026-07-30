// Work-list declared-dependency population (#615, capability
// `work-list-declared-dependency-population`).
//
// Production work-list compilation used to hardcode `depends_on: []` for every
// resolved issue after milestone/label/roadmap-slice/explicit-list selection,
// so the durable dependency machinery never saw body/native/roadmap edges.
// This module discovers **declared** prerequisite ids (lexical conventions,
// GitHub native blockedBy, optional roadmap edges), unions them per depender,
// and returns `RawContractItem[]` for `compileContractItems`.
//
// Pure parsing is network-free. Live reads go only through
// {@link WorkListDependencyDiscoverDeps} — unit tests inject fakes and perform
// zero real network, git, or subprocess calls.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getIssueDetail, type GhApiRunner } from "../gh.ts";
import type { PipelineConfig } from "../types.ts";
import { type RawContractItem } from "./dependencies.ts";

const execFileAsync = promisify(execFile);

/** Default production GraphQL/API runner — real `gh` subprocess, not for unit tests. */
const defaultGhApiRunner: GhApiRunner = async (args) => {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: 30_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  return typeof stdout === "string" ? stdout : stdout.toString("utf8");
};

// Canonical GitHub issue id: plain decimal digits, no leading zero (same gate
// spirit as external-dependency verification in dependencies.ts).
const CANONICAL_ISSUE_ID_RE = /^[1-9][0-9]*$/;

/** Phrase forms already used by roadmap depgraph (`findTextualDepCandidates`). */
const PHRASE_DEP_RE = /(?:depends on|requires|blocked by|needs)\s+#(\d+)/gi;

/** ATX heading for a dedicated dependency section (any heading level). */
const DEP_SECTION_HEADING_RE = /^#{1,6}\s+dependenc(?:y|ies)\b[^\n]*$/gim;

const ISSUE_REF_RE = /#(\d+)/g;

/**
 * Extracts prerequisite issue ids from free text (title and/or body).
 *
 * Matches:
 * - Case-insensitive phrases: `depends on|requires|blocked by|needs` + `#N`
 * - `#N` references under a `## Dependency` / `## Dependencies` (any ATX level)
 *   section body (until the next ATX heading)
 *
 * Ignores self-references when `selfId` is provided, non-canonical ids, and
 * bare `#N` mentions outside phrase or dependency-section context. Returns
 * stable deduped string ids in first-seen order.
 */
export function parseDeclaredDependencyIds(text: string, selfId?: string): string[] {
  if (!text) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  const add = (raw: string): void => {
    if (!CANONICAL_ISSUE_ID_RE.test(raw)) return;
    if (selfId !== undefined && raw === selfId) return;
    if (seen.has(raw)) return;
    seen.add(raw);
    out.push(raw);
  };

  PHRASE_DEP_RE.lastIndex = 0;
  let phraseMatch: RegExpExecArray | null;
  while ((phraseMatch = PHRASE_DEP_RE.exec(text)) !== null) {
    add(phraseMatch[1]!);
  }

  DEP_SECTION_HEADING_RE.lastIndex = 0;
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = DEP_SECTION_HEADING_RE.exec(text)) !== null) {
    const sectionStart = headingMatch.index + headingMatch[0].length;
    const rest = text.slice(sectionStart);
    const nextHeading = rest.search(/\n#{1,6}\s+\S/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    ISSUE_REF_RE.lastIndex = 0;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = ISSUE_REF_RE.exec(section)) !== null) {
      add(refMatch[1]!);
    }
  }

  return out;
}

/** One declared edge from a roadmap / slice graph when available at compile time. */
export interface RoadmapDeclaredEdge {
  /** Issue that depends on the prerequisite. */
  depender: string;
  /** Prerequisite issue id. */
  prerequisite: string;
}

/**
 * Extracts issue-level declared dependency edges from ROADMAP.md (or equivalent
 * roadmap/slice markdown) when present. Pure and network-free.
 *
 * Per line, the first `#N` is treated as the depender; prerequisite ids are
 * taken from the same lexical dependency conventions as issue bodies
 * (`depends on` / `requires` / `blocked by` / `needs` + `#M`, including the
 * roadmap writeback annotation `_(blocked by #M)_`). Self-references and
 * non-canonical ids are ignored. List order alone never invents an edge.
 */
export function extractRoadmapDeclaredEdges(roadmapText: string): RoadmapDeclaredEdge[] {
  if (!roadmapText) return [];

  const out: RoadmapDeclaredEdge[] = [];
  const seen = new Set<string>();

  for (const rawLine of roadmapText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const firstRef = /#(\d+)/.exec(line);
    if (!firstRef || firstRef[1] === undefined) continue;
    const depender = firstRef[1];
    if (!CANONICAL_ISSUE_ID_RE.test(depender)) continue;

    // Phrases after the depender id (writeback annotations + freeform table cells).
    const rest = line.slice(firstRef.index! + firstRef[0].length);
    for (const prerequisite of parseDeclaredDependencyIds(rest, depender)) {
      const key = `${depender}:${prerequisite}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ depender, prerequisite });
    }
  }

  return out;
}

/**
 * Injectable discovery seam for work-list dependency population.
 * Unit tests inject fakes — production uses {@link realWorkListDependencyDiscoverDeps}.
 */
export interface WorkListDependencyDiscoverDeps {
  /** Title + body for lexical declaration parsing. Null on unobservable issue. */
  getIssueTitleBody(issueNumber: number): Promise<{ title: string; body: string } | null>;
  /**
   * Same-repo GitHub native `blockedBy` issue numbers for the depender.
   * Null when the relationship cannot be observed (fail closed: no edges from this source).
   */
  getBlockedByIssueNumbers(issueNumber: number): Promise<readonly number[] | null>;
  /**
   * Optional issue-level edges already present in a roadmap/slice graph.
   * Omitted or null contributes no roadmap edges.
   */
  getRoadmapDeclaredEdges?(): Promise<readonly RoadmapDeclaredEdge[] | null>;
}

/**
 * Resolves declared raw dependencies for each work-list issue id by unioning
 * lexical body/title conventions, native blockedBy, and optional roadmap edges.
 * Always returns one {@link RawContractItem} per input id (empty `depends_on`
 * when nothing is declared). Per-source IO failure contributes no edges from
 * that source (fail closed toward independent) without aborting the whole list.
 */
export async function discoverDeclaredDependencies(
  issueIds: readonly string[],
  deps: WorkListDependencyDiscoverDeps,
): Promise<RawContractItem[]> {
  const roadmapEdges = await loadRoadmapEdges(deps);
  const roadmapByDepender = new Map<string, string[]>();
  for (const edge of roadmapEdges) {
    if (!CANONICAL_ISSUE_ID_RE.test(edge.depender) || !CANONICAL_ISSUE_ID_RE.test(edge.prerequisite)) {
      continue;
    }
    if (edge.depender === edge.prerequisite) continue;
    const list = roadmapByDepender.get(edge.depender) ?? [];
    if (!list.includes(edge.prerequisite)) list.push(edge.prerequisite);
    roadmapByDepender.set(edge.depender, list);
  }

  const items: RawContractItem[] = [];
  for (const id of issueIds) {
    const dependsOn = new Set<string>();

    if (CANONICAL_ISSUE_ID_RE.test(id)) {
      const issueNumber = Number(id);

      try {
        const text = await deps.getIssueTitleBody(issueNumber);
        if (text) {
          const combined = `${text.title ?? ""}\n${text.body ?? ""}`;
          for (const dep of parseDeclaredDependencyIds(combined, id)) {
            dependsOn.add(dep);
          }
        }
      } catch {
        // Fail closed for this source.
      }

      try {
        const blockedBy = await deps.getBlockedByIssueNumbers(issueNumber);
        if (blockedBy) {
          for (const n of blockedBy) {
            const depId = String(n);
            if (!CANONICAL_ISSUE_ID_RE.test(depId) || depId === id) continue;
            dependsOn.add(depId);
          }
        }
      } catch {
        // Fail closed for this source.
      }
    }

    for (const dep of roadmapByDepender.get(id) ?? []) {
      if (dep !== id) dependsOn.add(dep);
    }

    items.push({ id, depends_on: [...dependsOn] });
  }
  return items;
}

async function loadRoadmapEdges(
  deps: WorkListDependencyDiscoverDeps,
): Promise<readonly RoadmapDeclaredEdge[]> {
  if (!deps.getRoadmapDeclaredEdges) return [];
  try {
    const edges = await deps.getRoadmapDeclaredEdges();
    return edges ?? [];
  } catch {
    return [];
  }
}

/** Page size for GraphQL `Issue.blockedBy` (GitHub connection default max is 100). */
const BLOCKED_BY_PAGE_SIZE = 100;
/**
 * Safety bound only — 50 pages × 100 = 5000 native blockers per issue, far above
 * realistic dependency fan-in. Hitting the bound without exhausting pages fails
 * visibly rather than treating a truncated list as authoritative (#615).
 */
const BLOCKED_BY_MAX_PAGES = 50;

const ISSUE_DEP_SOURCES_QUERY =
  "query($owner:String!,$repo:String!,$n:Int!,$after:String){" +
  "repository(owner:$owner,name:$repo){issue(number:$n){" +
  "title body " +
  `blockedBy(first:${BLOCKED_BY_PAGE_SIZE},after:$after){` +
  "pageInfo{hasNextPage endCursor}nodes{... on Issue{number}}" +
  "}}}}";

interface BlockedByPage {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: Array<{ number?: number } | null> | null;
}

interface IssueDepSourcesPayload {
  data?: {
    repository?: {
      issue?: {
        title?: string | null;
        body?: string | null;
        blockedBy?: BlockedByPage | null;
      } | null;
    } | null;
  };
  errors?: unknown[];
}

/** Collect valid positive issue numbers from a blockedBy page, first-seen order. */
export function collectBlockedByIssueNumbers(
  nodes: BlockedByPage["nodes"],
  seen: Set<number>,
  out: number[],
): void {
  for (const node of nodes ?? []) {
    const n = node?.number;
    if (typeof n !== "number" || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
}

/**
 * Production discovery seam: loads title/body + native blockedBy via GraphQL
 * (paginated `blockedBy` until exhausted, cached). Falls back to REST
 * `getIssueDetail` for text when GraphQL is unavailable. Roadmap edges default
 * to none unless the caller injects `getRoadmapDeclaredEdges`.
 */
export function realWorkListDependencyDiscoverDeps(
  cfg: PipelineConfig,
  options: {
    runGhApi?: GhApiRunner;
    getIssueTitleBody?: WorkListDependencyDiscoverDeps["getIssueTitleBody"];
    getBlockedByIssueNumbers?: WorkListDependencyDiscoverDeps["getBlockedByIssueNumbers"];
    getRoadmapDeclaredEdges?: WorkListDependencyDiscoverDeps["getRoadmapDeclaredEdges"];
  } = {},
): WorkListDependencyDiscoverDeps {
  type Cached = { title: string; body: string; blockedBy: number[] };
  const cache = new Map<number, Cached | null>();

  const runGhApi: GhApiRunner = options.runGhApi ?? defaultGhApiRunner;

  async function load(issueNumber: number): Promise<Cached | null> {
    if (cache.has(issueNumber)) return cache.get(issueNumber)!;

    const [owner, repoName] = cfg.repo.split("/");
    if (!owner || !repoName) {
      cache.set(issueNumber, null);
      return null;
    }

    try {
      const cached = await loadViaGraphql(owner, repoName, issueNumber);
      cache.set(issueNumber, cached);
      return cached;
    } catch (err) {
      // Truncation / incomplete discovery must not become "empty blockedBy".
      if (err instanceof Error && err.message.includes("blockedBy pagination")) {
        throw err;
      }
      const fallback = await loadViaRest(issueNumber);
      cache.set(issueNumber, fallback);
      return fallback;
    }
  }

  async function loadViaGraphql(
    owner: string,
    repoName: string,
    issueNumber: number,
  ): Promise<Cached | null> {
    const blockedBy: number[] = [];
    const seen = new Set<number>();
    let after: string | null = null;
    let title = "";
    let body = "";

    for (let page = 0; page < BLOCKED_BY_MAX_PAGES; page++) {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${ISSUE_DEP_SOURCES_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repoName}`,
        "-F",
        `n=${issueNumber}`,
      ];
      if (after) args.push("-F", `after=${after}`);

      const stdout = await runGhApi(args);
      const payload = JSON.parse(stdout) as IssueDepSourcesPayload;
      if (payload.errors && Array.isArray(payload.errors) && payload.errors.length > 0) {
        // GraphQL unavailable for this issue — fall back to REST for text only.
        // Throw so the outer catch can REST-fallback without caching a partial page.
        throw new Error(
          `GraphQL errors loading issue #${issueNumber} dependency sources`,
        );
      }
      const issue = payload.data?.repository?.issue;
      if (!issue) {
        return null;
      }
      if (page === 0) {
        title = issue.title ?? "";
        body = issue.body ?? "";
      }
      const connection = issue.blockedBy;
      collectBlockedByIssueNumbers(connection?.nodes, seen, blockedBy);
      if (!connection?.pageInfo?.hasNextPage) {
        return { title, body, blockedBy };
      }
      after = connection.pageInfo.endCursor ?? null;
      if (!after) {
        // hasNextPage without a cursor is not an authoritative full set.
        throw new Error(
          `blockedBy pagination for issue #${issueNumber}: hasNextPage without endCursor`,
        );
      }
    }

    throw new Error(
      `blockedBy pagination for issue #${issueNumber} exceeded safety bound ` +
        `(${BLOCKED_BY_MAX_PAGES} pages × ${BLOCKED_BY_PAGE_SIZE}); refusing truncated result`,
    );
  }

  async function loadViaRest(issueNumber: number): Promise<Cached | null> {
    try {
      const detail = await getIssueDetail(cfg, issueNumber);
      return { title: detail.title, body: detail.body ?? "", blockedBy: [] };
    } catch {
      return null;
    }
  }

  return {
    getIssueTitleBody:
      options.getIssueTitleBody ??
      (async (issueNumber) => {
        const row = await load(issueNumber);
        return row ? { title: row.title, body: row.body } : null;
      }),
    getBlockedByIssueNumbers:
      options.getBlockedByIssueNumbers ??
      (async (issueNumber) => {
        const row = await load(issueNumber);
        return row ? row.blockedBy : null;
      }),
    getRoadmapDeclaredEdges: options.getRoadmapDeclaredEdges,
  };
}
