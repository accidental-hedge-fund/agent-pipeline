// Work-list declared-dependency population (#615 / #905, capabilities
// `work-list-declared-dependency-population`, `dependency-discovery-source-status`).
//
// Discovers **declared** prerequisite ids (lexical conventions via the shared
// grammar, GitHub native blockedBy, optional roadmap edges), unions them per
// depender, and returns compile-ready raw items plus observation/provenance
// records. Fresh multi-item admission refuses when any enabled source is
// unavailable or incomplete (#905).
//
// Pure lexical parsing lives in `declared-dependency-grammar.ts`. Live reads go
// only through {@link WorkListDependencyDiscoverDeps} — unit tests inject fakes
// and perform zero real network, git, or subprocess calls.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  isCanonicalIssueId,
  parseDeclaredDependencyIds,
} from "../declared-dependency-grammar.ts";
import {
  getIssueDetail,
  getPrDetail,
  getPrForIssueAnyState,
  type GhApiRunner,
} from "../gh.ts";
import type { PipelineConfig } from "../types.ts";
import { type RawContractItem } from "./dependencies.ts";
import { LoopError } from "./types.ts";

// Re-export the shared grammar so existing import sites keep working.
export { parseDeclaredDependencyIds, isCanonicalIssueId } from "../declared-dependency-grammar.ts";

const execFileAsync = promisify(execFile);

/** Default production GraphQL/API runner — real `gh` subprocess, not for unit tests. */
const defaultGhApiRunner: GhApiRunner = async (args) => {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: 30_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  return typeof stdout === "string" ? stdout : stdout.toString("utf8");
};

// ---------------------------------------------------------------------------
// Source status + provenance (#905)
// ---------------------------------------------------------------------------

/** Closed observation vocabulary for an authoritative discovery source. */
export type DiscoverySourceStatus =
  | "observed-empty"
  | "observed-with-edges"
  | "unavailable"
  | "incomplete";

/** Authoritative declaration sources for work-list population (v1). */
export type DependencyEdgeSource = "lexical" | "native-blocked-by" | "roadmap-declared";

/**
 * One fully-classified observation of an enabled discovery source for a scope
 * (per-issue for lexical/native; list-level `*` for roadmap edges).
 */
export interface SourceObservation {
  source: DependencyEdgeSource;
  /** Issue id for per-item sources, or `"*"` for list-level roadmap observation. */
  scope: string;
  status: DiscoverySourceStatus;
  /** Stable identity for this observation decision (source + scope + status). */
  observation_id: string;
  /** Optional machine-readable reason when status is unavailable/incomplete. */
  reason?: string;
}

/** Contributing source(s) for one directed declared edge. */
export interface DeclaredEdgeProvenance {
  depender: string;
  prerequisite: string;
  sources: DependencyEdgeSource[];
}

/**
 * Stable reason codes when a raw declared prerequisite is not admitted as a
 * hard wait (#1073, capability `work-list-declared-dependency-population`).
 */
export type IgnoredDepReason = "not_on_selector" | "closed" | "not_open";

/** Structured audit record for a non-admitted declared dependency. */
export interface IgnoredDep {
  depender: string;
  target: string;
  reason: IgnoredDepReason;
}

/**
 * Observed open/closed class for hard-wait admission. `closed` covers
 * issue-closed and linked-PR-merged satisfaction (closed/merged-class).
 * `not_open` covers unobservable, missing, or any non-open class that is not
 * a clean closed/merged class.
 */
export type PrerequisiteOpenClass = "open" | "closed" | "not_open";

/**
 * Live observation for hard-wait admission (#1073). `"merged"` means a linked
 * PR is merged (issue may still be open) — maps to closed/merged-class ignore.
 */
export type PrerequisiteObservation = "open" | "closed" | "merged" | null;

/** One raw directed edge before hard-wait admission. */
export interface RawDeclaredEdge {
  depender: string;
  prerequisite: string;
}

/**
 * Pure hard-wait admission (#1073): a declared prerequisite becomes a hard wait
 * only when the target is **open** (not closed, not satisfied via merged linked
 * PR) and a member of the current work-list / train selector snapshot.
 * Non-admitted candidates are returned as `ignored_dep` records with stable
 * reason codes. Does not invent edges.
 */
export function admitHardWaits(
  edges: readonly RawDeclaredEdge[],
  selectorIds: ReadonlySet<string>,
  openState: ReadonlyMap<string, PrerequisiteOpenClass>,
): { admitted: RawDeclaredEdge[]; ignored: IgnoredDep[] } {
  const admitted: RawDeclaredEdge[] = [];
  const ignored: IgnoredDep[] = [];
  const seenIgnored = new Set<string>();
  const seenAdmitted = new Set<string>();

  for (const edge of edges) {
    const { depender, prerequisite: target } = edge;
    if (!isCanonicalIssueId(depender) || !isCanonicalIssueId(target)) continue;
    if (depender === target) continue;

    const state = openState.get(target) ?? "not_open";
    let reason: IgnoredDepReason | null = null;
    // Closed/merged-class wins for audit when observed, even off-selector.
    // Off-selector (open or unobserved) is not_on_selector so ship-path
    // forensics name the train membership rule. On-selector not-open stays
    // not_open.
    if (state === "closed") {
      reason = "closed";
    } else if (!selectorIds.has(target)) {
      reason = "not_on_selector";
    } else if (state !== "open") {
      reason = "not_open";
    }

    if (reason) {
      const key = `${depender}:${target}:${reason}`;
      if (!seenIgnored.has(key)) {
        seenIgnored.add(key);
        ignored.push({ depender, target, reason });
      }
      continue;
    }

    const admitKey = `${depender}:${target}`;
    if (seenAdmitted.has(admitKey)) continue;
    seenAdmitted.add(admitKey);
    admitted.push({ depender, prerequisite: target });
  }

  ignored.sort((a, b) => {
    if (a.depender !== b.depender) return a.depender.localeCompare(b.depender, "en");
    if (a.target !== b.target) return a.target.localeCompare(b.target, "en");
    return a.reason.localeCompare(b.reason, "en");
  });

  return { admitted, ignored };
}

/** Result of declared-dependency discovery for a work-list snapshot. */
export interface DeclaredDependencyDiscoveryResult {
  items: RawContractItem[];
  observations: SourceObservation[];
  edge_provenance: DeclaredEdgeProvenance[];
  /**
   * Declared prerequisites dropped by hard-wait admission (off-selector, closed,
   * or not open). Empty when every raw edge was admitted (#1073).
   */
  ignored_deps: IgnoredDep[];
  /** True when any enabled observation is unavailable or incomplete. */
  has_incomplete: boolean;
}

/** Build a stable observation identity string. */
export function observationIdentity(
  source: DependencyEdgeSource,
  scope: string,
  status: DiscoverySourceStatus,
): string {
  return `${source}:${scope}:${status}`;
}

function observation(
  source: DependencyEdgeSource,
  scope: string,
  status: DiscoverySourceStatus,
  reason?: string,
): SourceObservation {
  return {
    source,
    scope,
    status,
    observation_id: observationIdentity(source, scope, status),
    ...(reason ? { reason } : {}),
  };
}

function isIncompleteStatus(status: DiscoverySourceStatus): boolean {
  return status === "unavailable" || status === "incomplete";
}

/**
 * Typed refusal when fresh multi-item (or forced) admission cannot fully observe
 * an enabled authoritative discovery source. No contract/ledger is initialized.
 */
export class IncompleteDependencyDiscoveryError extends LoopError {
  readonly observations: readonly SourceObservation[];
  readonly incomplete: readonly SourceObservation[];

  constructor(message: string, observations: readonly SourceObservation[]) {
    super("validation", message);
    this.name = "IncompleteDependencyDiscoveryError";
    this.observations = observations;
    this.incomplete = observations.filter((o) => isIncompleteStatus(o.status));
  }
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
 * taken from the shared lexical dependency grammar on the remainder of the
 * line (`depends on` / `requires` / `blocked by` / `needs` + multi-ref lists,
 * including the roadmap writeback annotation `_(blocked by #M)_`).
 * Self-references and non-canonical ids are ignored. List order alone never
 * invents an edge.
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
    if (!isCanonicalIssueId(depender)) continue;

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
   * Null when the relationship cannot be fully observed.
   */
  getBlockedByIssueNumbers(issueNumber: number): Promise<readonly number[] | null>;
  /**
   * Optional issue-level edges already present in a roadmap/slice graph.
   * Omitted means the roadmap source is not enabled for this compile.
   * Null means the source was enabled but could not be fully observed.
   */
  getRoadmapDeclaredEdges?(): Promise<readonly RoadmapDeclaredEdge[] | null>;
  /**
   * Open/closed/merged observation for hard-wait admission (#1073). Returns
   * `"open"`, `"closed"` (issue closed), `"merged"` (linked PR merged — issue
   * may still be open), or `null` when the issue cannot be observed
   * (`not_open`). When omitted, discovery treats every candidate as open so
   * selector membership alone decides admission (closed/merged-class reasons
   * require a seam).
   */
  getIssueOpenState?(issueNumber: number): Promise<PrerequisiteObservation>;
}

/**
 * Resolves declared raw dependencies for each work-list issue id by unioning
 * successfully observed edges from lexical body/title conventions, native
 * blockedBy, and optional roadmap edges; then applies **hard-wait admission**
 * so only open prerequisites on the current selector remain on `depends_on`
 * (#1073). Off-selector / closed / not-open candidates become `ignored_deps`
 * and never land on `external_depends_on` after compile. Does not invent edges
 * from list order.
 *
 * Callers that admit a fresh multi-item run must refuse when
 * `result.has_incomplete` is true (see {@link assertDiscoveryCompleteForAdmission}).
 */
export async function discoverDeclaredDependencies(
  issueIds: readonly string[],
  deps: WorkListDependencyDiscoverDeps,
): Promise<DeclaredDependencyDiscoveryResult> {
  const observations: SourceObservation[] = [];
  // depender → prerequisite → contributing sources (raw union, pre-admission)
  const provenance = new Map<string, Map<string, Set<DependencyEdgeSource>>>();

  const addEdge = (depender: string, prerequisite: string, source: DependencyEdgeSource): void => {
    if (depender === prerequisite) return;
    if (!isCanonicalIssueId(prerequisite)) return;
    let byPrereq = provenance.get(depender);
    if (!byPrereq) {
      byPrereq = new Map();
      provenance.set(depender, byPrereq);
    }
    let sources = byPrereq.get(prerequisite);
    if (!sources) {
      sources = new Set();
      byPrereq.set(prerequisite, sources);
    }
    sources.add(source);
  };

  // --- Roadmap (list-level) ---
  const roadmapEnabled = typeof deps.getRoadmapDeclaredEdges === "function";
  if (roadmapEnabled) {
    try {
      const edges = await deps.getRoadmapDeclaredEdges!();
      if (edges === null) {
        observations.push(
          observation("roadmap-declared", "*", "unavailable", "roadmap edges returned null"),
        );
      } else {
        let edgeCount = 0;
        for (const edge of edges) {
          if (!isCanonicalIssueId(edge.depender) || !isCanonicalIssueId(edge.prerequisite)) {
            continue;
          }
          if (edge.depender === edge.prerequisite) continue;
          addEdge(edge.depender, edge.prerequisite, "roadmap-declared");
          edgeCount += 1;
        }
        observations.push(
          observation(
            "roadmap-declared",
            "*",
            edgeCount > 0 ? "observed-with-edges" : "observed-empty",
          ),
        );
      }
    } catch (err) {
      observations.push(
        observation(
          "roadmap-declared",
          "*",
          "unavailable",
          err instanceof Error ? err.message : "roadmap edges threw",
        ),
      );
    }
  }

  // --- Per-issue lexical + native ---
  for (const id of issueIds) {
    if (!isCanonicalIssueId(id)) {
      // Non-canonical snapshot ids still produce an empty raw item; no source
      // observation can be issued for them.
      continue;
    }
    const issueNumber = Number(id);

    // Lexical
    try {
      const text = await deps.getIssueTitleBody(issueNumber);
      if (text === null) {
        observations.push(
          observation("lexical", id, "unavailable", "issue title/body unobservable (null)"),
        );
      } else {
        const combined = `${text.title ?? ""}\n${text.body ?? ""}`;
        const depsIds = parseDeclaredDependencyIds(combined, id);
        for (const dep of depsIds) {
          addEdge(id, dep, "lexical");
        }
        observations.push(
          observation(
            "lexical",
            id,
            depsIds.length > 0 ? "observed-with-edges" : "observed-empty",
          ),
        );
      }
    } catch (err) {
      observations.push(
        observation(
          "lexical",
          id,
          "unavailable",
          err instanceof Error ? err.message : "lexical discovery threw",
        ),
      );
    }

    // Native blockedBy
    try {
      const blockedBy = await deps.getBlockedByIssueNumbers(issueNumber);
      if (blockedBy === null) {
        observations.push(
          observation("native-blocked-by", id, "unavailable", "blockedBy unobservable (null)"),
        );
      } else {
        const contributed: string[] = [];
        for (const n of blockedBy) {
          const depId = String(n);
          if (!isCanonicalIssueId(depId) || depId === id) continue;
          addEdge(id, depId, "native-blocked-by");
          contributed.push(depId);
        }
        observations.push(
          observation(
            "native-blocked-by",
            id,
            contributed.length > 0 ? "observed-with-edges" : "observed-empty",
          ),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "native blockedBy threw";
      const status: DiscoverySourceStatus =
        /truncat|pagination|safety bound|incomplete/i.test(msg) ? "incomplete" : "unavailable";
      observations.push(observation("native-blocked-by", id, status, msg));
    }
  }

  // --- Hard-wait admission (#1073): open + on selector only ---
  const selectorIds = new Set(issueIds.filter((id) => isCanonicalIssueId(id)));
  const rawEdges: RawDeclaredEdge[] = [];
  for (const [depender, byPrereq] of provenance) {
    for (const prerequisite of byPrereq.keys()) {
      rawEdges.push({ depender, prerequisite });
    }
  }

  const openState = new Map<string, PrerequisiteOpenClass>();
  const candidateTargets = new Set(rawEdges.map((e) => e.prerequisite));
  const observeOpen = typeof deps.getIssueOpenState === "function";
  for (const target of candidateTargets) {
    if (!observeOpen) {
      // No seam: assume open so selector membership is the sole filter.
      openState.set(target, "open");
      continue;
    }
    try {
      const observed = await deps.getIssueOpenState!(Number(target));
      // Issue closed OR linked-PR-merged → closed/merged-class (not a hard wait).
      if (observed === "open") openState.set(target, "open");
      else if (observed === "closed" || observed === "merged") openState.set(target, "closed");
      else openState.set(target, "not_open");
    } catch {
      openState.set(target, "not_open");
    }
  }

  const { admitted, ignored } = admitHardWaits(rawEdges, selectorIds, openState);
  const admittedSet = new Set(admitted.map((e) => `${e.depender}:${e.prerequisite}`));

  // items / provenance only for admitted hard waits
  const admittedByDepender = new Map<string, string[]>();
  for (const edge of admitted) {
    const list = admittedByDepender.get(edge.depender) ?? [];
    list.push(edge.prerequisite);
    admittedByDepender.set(edge.depender, list);
  }

  const items: RawContractItem[] = issueIds.map((id) => {
    const depends_on = admittedByDepender.get(id) ?? [];
    return { id, depends_on };
  });

  const edge_provenance: DeclaredEdgeProvenance[] = [];
  for (const [depender, byPrereq] of provenance) {
    for (const [prerequisite, sources] of byPrereq) {
      if (!admittedSet.has(`${depender}:${prerequisite}`)) continue;
      edge_provenance.push({
        depender,
        prerequisite,
        sources: [...sources],
      });
    }
  }
  // Stable order for audit diffs
  edge_provenance.sort((a, b) => {
    if (a.depender !== b.depender) return a.depender.localeCompare(b.depender, "en");
    return a.prerequisite.localeCompare(b.prerequisite, "en");
  });

  const has_incomplete = observations.some((o) => isIncompleteStatus(o.status));

  return {
    items,
    observations,
    edge_provenance,
    ignored_deps: ignored,
    has_incomplete,
  };
}

/**
 * Refuses fresh multi-item or forced (factory-owned) admission when any
 * enabled source is incomplete. Single-item non-factory packs report
 * observations but do not hard-refuse (exploratory advance). Callers for
 * multi-item packs (`issueIds.length >= 2`) or factory-owned packs must pass
 * `forceRefuse: true` (or rely on multi-item size) so incomplete sources
 * refuse contract/ledger init.
 *
 * When refused, throws {@link IncompleteDependencyDiscoveryError} — callers
 * must not write a run contract or ledger.
 */
export function assertDiscoveryCompleteForAdmission(
  issueIds: readonly string[],
  result: DeclaredDependencyDiscoveryResult,
  opts: { forceRefuse?: boolean } = {},
): void {
  if (!result.has_incomplete) return;
  const multiItem = issueIds.length >= 2;
  if (!multiItem && !opts.forceRefuse) return;

  const incomplete = result.observations.filter((o) => isIncompleteStatus(o.status));
  const detail = incomplete
    .map((o) => `${o.source} scope=${o.scope} status=${o.status}${o.reason ? ` (${o.reason})` : ""}`)
    .join("; ");
  throw new IncompleteDependencyDiscoveryError(
    `declared-dependency discovery incomplete for fresh multi-item or factory-owned admission — ` +
      `refusing contract/ledger init. Incomplete sources: ${detail}`,
    result.observations,
  );
}

/** Page size for GraphQL `Issue.blockedBy` (GitHub connection default max is 100). */
const BLOCKED_BY_PAGE_SIZE = 100;
/**
 * Safety bound only — 50 pages × 100 = 5000 native blockers per issue, far above
 * realistic dependency fan-in. Hitting the bound without exhausting pages fails
 * visibly rather than treating a truncated list as authoritative (#615 / #905).
 */
const BLOCKED_BY_MAX_PAGES = 50;

const ISSUE_DEP_SOURCES_QUERY =
  "query($owner:String!,$repo:String!,$n:Int!,$after:String){" +
  "repository(owner:$owner,name:$repo){issue(number:$n){" +
  "title body state " +
  `blockedBy(first:${BLOCKED_BY_PAGE_SIZE},after:$after){` +
  "pageInfo{hasNextPage endCursor}nodes{... on Issue{number}}" +
  "}}}}";

/** Lightweight state-only query for hard-wait admission of off-list targets. */
const ISSUE_OPEN_STATE_QUERY =
  "query($owner:String!,$repo:String!,$n:Int!){" +
  "repository(owner:$owner,name:$repo){issue(number:$n){state}}" +
  "}";

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
        state?: string | null;
        blockedBy?: BlockedByPage | null;
      } | null;
    } | null;
  };
  errors?: unknown[];
}

interface IssueOpenStatePayload {
  data?: {
    repository?: {
      issue?: {
        state?: string | null;
      } | null;
    } | null;
  };
  errors?: unknown[];
}

function openClassFromGraphqlState(state: string | null | undefined): "open" | "closed" | null {
  if (!state) return null;
  const upper = state.toUpperCase();
  if (upper === "OPEN") return "open";
  if (upper === "CLOSED") return "closed";
  return null;
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
 *
 * Hard-wait open-state observation also treats a merged linked PR as
 * closed/merged-class satisfaction (even when the issue is still open).
 *
 * Incomplete pagination throws (does not cache a truncated set). Null cache
 * entries mean the issue was unobservable — callers classify as unavailable.
 */
export function realWorkListDependencyDiscoverDeps(
  cfg: PipelineConfig,
  options: {
    runGhApi?: GhApiRunner;
    getIssueTitleBody?: WorkListDependencyDiscoverDeps["getIssueTitleBody"];
    getBlockedByIssueNumbers?: WorkListDependencyDiscoverDeps["getBlockedByIssueNumbers"];
    getRoadmapDeclaredEdges?: WorkListDependencyDiscoverDeps["getRoadmapDeclaredEdges"];
    getIssueOpenState?: WorkListDependencyDiscoverDeps["getIssueOpenState"];
    /** Injectable linked-PR lookup for merged-PR satisfaction (#1073 r1). */
    findPrForIssue?: (issueNumber: number) => Promise<number | null>;
    /** Injectable PR state for merged-PR satisfaction (#1073 r1). */
    getPrState?: (prNumber: number) => Promise<"open" | "closed" | "merged" | null>;
  } = {},
): WorkListDependencyDiscoverDeps {
  type Cached = {
    title: string;
    body: string;
    /** Null when open/closed was not observed with this cache row. */
    openState: "open" | "closed" | null;
    /** Null when native blockedBy was not fully observed (e.g. REST-only fallback). */
    blockedBy: number[] | null;
  };
  const cache = new Map<number, Cached | null>();
  /** Open-state cache for targets that never loaded full dep sources. */
  const openStateOnly = new Map<number, "open" | "closed" | null>();
  /** Admission observation cache (includes merged-linked-PR class). */
  const admissionStateCache = new Map<number, PrerequisiteObservation>();

  const runGhApi: GhApiRunner = options.runGhApi ?? defaultGhApiRunner;
  const findPrForIssue =
    options.findPrForIssue ??
    ((issueNumber: number) => getPrForIssueAnyState(cfg, issueNumber, runGhApi));
  const getPrState =
    options.getPrState ??
    (async (prNumber: number): Promise<"open" | "closed" | "merged" | null> => {
      try {
        const detail = await getPrDetail(cfg, prNumber);
        return detail.state;
      } catch {
        return null;
      }
    });

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
    let openState: "open" | "closed" | null = null;

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
        openState = openClassFromGraphqlState(issue.state);
      }
      const connection = issue.blockedBy;
      collectBlockedByIssueNumbers(connection?.nodes, seen, blockedBy);
      if (!connection?.pageInfo?.hasNextPage) {
        return { title, body, openState, blockedBy };
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
      // REST has no blockedBy connection — mark native as unobserved (null),
      // never as an authoritative empty list (#905).
      const openState =
        detail.state === "closed" ? "closed" : detail.state === "open" ? "open" : null;
      return { title: detail.title, body: detail.body ?? "", openState, blockedBy: null };
    } catch {
      return null;
    }
  }

  async function loadOpenStateOnly(issueNumber: number): Promise<"open" | "closed" | null> {
    if (openStateOnly.has(issueNumber)) return openStateOnly.get(issueNumber)!;
    const [owner, repoName] = cfg.repo.split("/");
    if (!owner || !repoName) {
      openStateOnly.set(issueNumber, null);
      return null;
    }
    try {
      const stdout = await runGhApi([
        "api",
        "graphql",
        "-f",
        `query=${ISSUE_OPEN_STATE_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repoName}`,
        "-F",
        `n=${issueNumber}`,
      ]);
      const payload = JSON.parse(stdout) as IssueOpenStatePayload;
      if (payload.errors && Array.isArray(payload.errors) && payload.errors.length > 0) {
        throw new Error("GraphQL errors");
      }
      const state = openClassFromGraphqlState(payload.data?.repository?.issue?.state);
      openStateOnly.set(issueNumber, state);
      return state;
    } catch {
      try {
        const detail = await getIssueDetail(cfg, issueNumber);
        const state =
          detail.state === "closed" ? "closed" : detail.state === "open" ? "open" : null;
        openStateOnly.set(issueNumber, state);
        return state;
      } catch {
        openStateOnly.set(issueNumber, null);
        return null;
      }
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
        if (!row) return null;
        return row.blockedBy;
      }),
    getIssueOpenState:
      options.getIssueOpenState ??
      (async (issueNumber): Promise<PrerequisiteObservation> => {
        if (admissionStateCache.has(issueNumber)) {
          return admissionStateCache.get(issueNumber)!;
        }

        // Prefer issue open/closed from full-cache row when discovery already loaded it.
        let issueState: "open" | "closed" | null;
        if (cache.has(issueNumber)) {
          const row = cache.get(issueNumber);
          if (!row) {
            admissionStateCache.set(issueNumber, null);
            return null;
          }
          issueState = row.openState;
        } else {
          issueState = await loadOpenStateOnly(issueNumber);
        }

        if (issueState === "closed") {
          admissionStateCache.set(issueNumber, "closed");
          return "closed";
        }
        if (issueState !== "open") {
          admissionStateCache.set(issueNumber, null);
          return null;
        }

        // Issue still open: linked merged PR satisfies the prerequisite
        // (closed/merged-class) so it is not admitted as a hard wait (#1073).
        try {
          const prNumber = await findPrForIssue(issueNumber);
          if (prNumber !== null) {
            const prState = await getPrState(prNumber);
            if (prState === "merged") {
              admissionStateCache.set(issueNumber, "merged");
              return "merged";
            }
          }
        } catch {
          // PR observation failure does not invent satisfaction — fall through
          // to open (fail closed toward hard wait, never toward "satisfied").
        }

        admissionStateCache.set(issueNumber, "open");
        return "open";
      }),
    getRoadmapDeclaredEdges: options.getRoadmapDeclaredEdges,
  };
}
