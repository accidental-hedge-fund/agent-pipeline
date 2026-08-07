// Default live-observation wiring for the factory macro-controller CLI (#890).
//
// Every enabled tick must reconcile against real git / repository identity /
// GitHub / effective-configuration fingerprints. This module is the shared
// production source for those observations (CLI and library adopters). Unit
// tests inject fakes — no real network, git, or subprocess in tests.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PipelineConfig } from "../types.ts";
import { getIssueDetail, getMilestones } from "../gh.ts";
import {
  defaultLoopStoreDeps,
  getStatus,
  type LoopStoreDeps,
  type LoopStatus,
} from "../loop/store.ts";
import {
  discoverDeclaredDependencies,
  realWorkListDependencyDiscoverDeps,
} from "../loop/work-list-deps.ts";
import {
  productionPinPath,
  parseProductionEnginePin,
  type ProductionEnginePin,
} from "../production-engine-pin.ts";
import {
  FactoryError,
  type FactoryDependencyEdge,
  type FactoryFingerprints,
  type FactoryGithubIdentitySnapshot,
  type FactorySelector,
} from "./types.ts";
import type { ChildRunStatus, FactoryMacroDeps } from "./controller.ts";
import type { FactoryStoreDeps } from "./store.ts";

const execFileAsync = promisify(execFile);

/** Open issue row used for independent selector membership resolution. */
export interface FactoryLiveOpenIssue {
  number: number;
  labels: string[];
  milestone: string | null;
}

// ---------------------------------------------------------------------------
// Injectable observation deps
// ---------------------------------------------------------------------------

export interface FactoryGitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface FactoryLiveObserverDeps {
  /** `git -C repoDir …` style invocation. */
  git(repoDir: string, args: string[]): Promise<FactoryGitResult>;
  /**
   * Resolve one issue in `owner/repo`. Return null when the issue is absent
   * or unreadable (caller maps that to snapshot mismatch).
   */
  getIssue(
    repo: string,
    issueNumber: number,
  ): Promise<{ number: number; state: string } | null>;
  /**
   * Resolve one pull request in `owner/repo`. Return null when absent or
   * unreadable (caller maps that to snapshot mismatch / identity drift).
   */
  getPull(
    repo: string,
    prNumber: number,
  ): Promise<{ number: number; state: string } | null>;
  /**
   * List open issues with labels + milestone for independent selector
   * membership. Return `null` when the query is unavailable (fail closed).
   * An empty array is a successful observation of zero open issues.
   */
  listOpenIssues(repo: string): Promise<FactoryLiveOpenIssue[] | null>;
  /**
   * Discover live declared dependency edges among `issueIds` from the
   * authoritative sources (body phrases, native blockedBy, optional roadmap).
   * Return `null` when discovery is unavailable (fail closed). Edge direction:
   * `from` = depender, `to` = prerequisite. Only in-membership edges.
   */
  listDependencyEdges(
    repo: string,
    issueIds: readonly string[],
  ): Promise<FactoryDependencyEdge[] | null>;
  /**
   * List milestone titles for the repository (aux live identity).
   * Return `null` when the query is unavailable (fail closed).
   */
  listMilestones(repo: string): Promise<string[] | null>;
  /** Optional production engine pin for the engine_pin fingerprint. */
  readEnginePin(repoDir: string): Promise<ProductionEnginePin | null>;
  /** Durable loop store for child observation (never invents run state). */
  loopStore: LoopStoreDeps;
  now(): Date;
}

/** Real git/gh/fs defaults for the CLI path. */
export function defaultFactoryLiveObserverDeps(
  env: NodeJS.ProcessEnv = process.env,
): FactoryLiveObserverDeps {
  return {
    async git(repoDir, args) {
      try {
        const { stdout, stderr } = await execFileAsync("git", args, {
          cwd: repoDir,
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
      } catch (err) {
        const e = err as {
          stdout?: string;
          stderr?: string;
          code?: number;
          message: string;
        };
        return {
          stdout: (e.stdout ?? "").toString(),
          stderr: (e.stderr ?? e.message).toString(),
          code: typeof e.code === "number" ? e.code : 1,
        };
      }
    },
    async getIssue(repo, issueNumber) {
      try {
        // Minimal PipelineConfig shape required by getIssueDetail (-R cfg.repo).
        const detail = await getIssueDetail({ repo } as PipelineConfig, issueNumber);
        return { number: detail.number, state: detail.state };
      } catch {
        return null;
      }
    },
    async getPull(repo, prNumber) {
      try {
        const { stdout } = await execFileAsync(
          "gh",
          [
            "pr",
            "view",
            String(prNumber),
            "--json",
            "number,state",
            "-R",
            repo,
          ],
          { timeout: 30_000, maxBuffer: 1024 * 1024 },
        );
        const data = JSON.parse(stdout) as { number: number; state: string };
        return { number: data.number, state: data.state };
      } catch {
        return null;
      }
    },
    async listOpenIssues(repo) {
      try {
        const { stdout } = await execFileAsync(
          "gh",
          [
            "issue",
            "list",
            "--state",
            "open",
            "--json",
            "number,labels,milestone",
            "--limit",
            "500",
            "-R",
            repo,
          ],
          { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
        );
        const items = JSON.parse(stdout.trim() || "[]") as Array<{
          number: number;
          labels?: Array<{ name: string } | string>;
          milestone?: { title: string } | null;
        }>;
        return items.map((item) => ({
          number: item.number,
          labels: (item.labels ?? []).map((l) =>
            typeof l === "string" ? l : l.name,
          ),
          milestone: item.milestone?.title ?? null,
        }));
      } catch {
        return null;
      }
    },
    async listDependencyEdges(repo, issueIds) {
      try {
        const cfg = { repo } as PipelineConfig;
        const discover = realWorkListDependencyDiscoverDeps(cfg);
        const items = await discoverDeclaredDependencies(issueIds, discover);
        const idSet = new Set(issueIds.map(String));
        const edges: FactoryDependencyEdge[] = [];
        for (const item of items) {
          for (const dep of item.depends_on) {
            const to = String(dep);
            if (!idSet.has(to)) continue;
            edges.push({ from: String(item.id), to });
          }
        }
        edges.sort((a, b) => {
          const af = String(a.from);
          const bf = String(b.from);
          if (af !== bf) return Number(af) - Number(bf) || (af < bf ? -1 : 1);
          const at = String(a.to);
          const bt = String(b.to);
          return Number(at) - Number(bt) || (at < bt ? -1 : 1);
        });
        return edges;
      } catch {
        return null;
      }
    },
    async listMilestones(repo) {
      try {
        const ms = await getMilestones(repo);
        return ms.map((m) => m.title);
      } catch {
        return null;
      }
    },
    async readEnginePin(repoDir) {
      try {
        const p = productionPinPath(repoDir, null, env);
        const { promises: fsp } = await import("node:fs");
        const text = await fsp.readFile(p, "utf8");
        return parseProductionEnginePin(text);
      } catch {
        return null;
      }
    },
    loopStore: defaultLoopStoreDeps(env),
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------
// Fingerprints (shared by adoption + tick reconciliation)
// ---------------------------------------------------------------------------

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Stable JSON with sorted object keys (same spirit as factory/hash.ts). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Effective configuration fingerprints for factory live reconciliation.
 * Same function MUST be used at adoption and on every tick so drift detection
 * is comparable.
 */
export function computeEffectiveConfigFingerprints(
  cfg: Pick<
    PipelineConfig,
    | "repo"
    | "base_branch"
    | "domain"
    | "review_policy"
    | "harnesses"
    | "factory"
    | "engine_track"
  >,
  pin: { version: string; tag: string; git_sha?: string | null } | null,
): FactoryFingerprints {
  const authority_policy = sha256Hex(
    stableStringify({
      review_policy: cfg.review_policy,
    }),
  );
  const engine_pin = sha256Hex(
    stableStringify(
      pin
        ? {
            version: pin.version,
            tag: pin.tag,
            git_sha: pin.git_sha ?? null,
          }
        : { version: null, tag: null, git_sha: null },
    ),
  );
  const configuration = sha256Hex(
    stableStringify({
      repo: cfg.repo,
      base_branch: cfg.base_branch,
      domain: cfg.domain,
      factory: cfg.factory,
      engine_track: cfg.engine_track ?? null,
    }),
  );
  const treatment = sha256Hex(
    stableStringify({
      implementer: cfg.harnesses?.implementer ?? null,
      reviewer: cfg.harnesses?.reviewer ?? null,
      reviewerModel: cfg.harnesses?.reviewerModel ?? null,
      implementerSource: cfg.harnesses?.implementerSource ?? null,
      reviewerSource: cfg.harnesses?.reviewerSource ?? null,
    }),
  );
  return { authority_policy, engine_pin, configuration, treatment };
}

// ---------------------------------------------------------------------------
// Individual observers
// ---------------------------------------------------------------------------

/**
 * Fresh base SHA for `baseBranch`. Prefers `origin/<branch>`, then local
 * branch tip. Throws FactoryError when no 40-char SHA can be resolved.
 */
export async function observeFactoryBaseSha(
  deps: Pick<FactoryLiveObserverDeps, "git">,
  repoDir: string,
  baseBranch: string,
): Promise<string> {
  const candidates = [`origin/${baseBranch}`, baseBranch, `refs/heads/${baseBranch}`];
  for (const ref of candidates) {
    const res = await deps.git(repoDir, ["rev-parse", "--verify", ref]);
    if (res.code !== 0) continue;
    const sha = res.stdout.trim().toLowerCase();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  throw new FactoryError(
    "validation",
    `unable to observe base SHA for branch "${baseBranch}" in ${repoDir}`,
  );
}

/**
 * Fresh repository identity from resolved pipeline config (same source as
 * adoption / resolveConfig discovery).
 */
export async function observeFactoryRepoIdentity(
  cfg: Pick<PipelineConfig, "repo" | "base_branch">,
  _input: { repoDir: string; baseBranch: string },
): Promise<{ name: string; base_branch: string }> {
  const name = typeof cfg.repo === "string" ? cfg.repo.trim() : "";
  const base_branch =
    typeof cfg.base_branch === "string" && cfg.base_branch.trim()
      ? cfg.base_branch.trim()
      : _input.baseBranch;
  if (!name || !name.includes("/")) {
    throw new FactoryError(
      "validation",
      `unable to observe repository identity (got repo="${name || ""}") — ensure gh is authenticated`,
    );
  }
  return { name, base_branch };
}

/** Parse explicit/issues selector values into sorted canonical issue id strings. */
export function parseFactorySelectorIssueIds(value: string): string[] {
  const ids = new Set<string>();
  for (const m of String(value).matchAll(/\b([1-9][0-9]*)\b/g)) {
    ids.add(m[1]!);
  }
  return [...ids].sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : 1));
}

/** Parse `N-M` / `N..M` range selector values. */
export function parseFactorySelectorRange(
  value: string,
): { lo: number; hi: number } | null {
  const m = /^([1-9][0-9]*)\s*(?:\.\.|-)\s*([1-9][0-9]*)$/.exec(String(value).trim());
  if (!m) return null;
  let lo = Number(m[1]);
  let hi = Number(m[2]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (lo > hi) [lo, hi] = [hi, lo];
  return { lo, hi };
}

/**
 * Resolve selector membership solely from live open-issue rows (and, for
 * explicit/issues selectors, per-issue existence reads). Does not use
 * contracted issue_ids as the membership source.
 */
export async function resolveLiveSelectorMembership(
  deps: Pick<FactoryLiveObserverDeps, "getIssue" | "listOpenIssues">,
  input: { repo: string; selector: FactorySelector },
): Promise<
  | {
      ok: true;
      issue_ids: string[];
      /** Live open rows that matched (empty for pure existence selectors). */
      matched_open: FactoryLiveOpenIssue[];
    }
  | { ok: false; detail: string }
> {
  const selector = input.selector;
  const type = selector.type;
  const value = String(selector.value ?? "");

  if (type === "issues" || type === "explicit") {
    const ids = parseFactorySelectorIssueIds(value);
    if (ids.length === 0) {
      return {
        ok: false,
        detail: `selector ${type} value "${value}" yields no issue ids`,
      };
    }
    const observed: string[] = [];
    for (const id of ids) {
      const n = Number(id);
      const issue = await deps.getIssue(input.repo, n);
      if (issue) observed.push(id);
    }
    return { ok: true, issue_ids: observed, matched_open: [] };
  }

  const openIssues = await deps.listOpenIssues(input.repo);
  if (openIssues == null) {
    return {
      ok: false,
      detail: `open-issue listing unavailable for ${input.repo} — cannot observe selector membership`,
    };
  }

  let matched: FactoryLiveOpenIssue[];
  if (type === "milestone") {
    if (!value) {
      return { ok: false, detail: "milestone selector value is empty" };
    }
    matched = openIssues.filter((i) => i.milestone === value);
  } else if (type === "label") {
    if (!value) {
      return { ok: false, detail: "label selector value is empty" };
    }
    matched = openIssues.filter((i) => i.labels.includes(value));
  } else if (type === "range") {
    const range = parseFactorySelectorRange(value);
    if (!range) {
      return {
        ok: false,
        detail: `range selector value "${value}" is not a valid N-M or N..M range`,
      };
    }
    matched = openIssues.filter(
      (i) => i.number >= range.lo && i.number <= range.hi,
    );
  } else {
    return {
      ok: false,
      detail: `unsupported factory selector type "${String(type)}"`,
    };
  }

  matched = [...matched].sort((a, b) => a.number - b.number);
  return {
    ok: true,
    issue_ids: matched.map((i) => String(i.number)),
    matched_open: matched,
  };
}

/**
 * Fresh GitHub identity snapshot built solely from independent live queries:
 * selector membership (label/range/milestone/issue assignment), PR existence
 * checks, milestone titles assigned to live members, and dependency edges from
 * the authoritative declared-dependency sources. Contracted issue/edge lists
 * are never copied into `observed` — the controller compares live vs revision.
 * Unavailable queries fail closed (ok:false) rather than echoing contract values.
 */
export async function observeFactoryGithubSnapshot(
  deps: Pick<
    FactoryLiveObserverDeps,
    | "getIssue"
    | "getPull"
    | "listOpenIssues"
    | "listDependencyEdges"
    | "listMilestones"
  >,
  input: { repo: string; contracted: FactoryGithubIdentitySnapshot },
): Promise<{
  ok: boolean;
  detail?: string;
  observed?: FactoryGithubIdentitySnapshot;
}> {
  if (!input.repo || !input.repo.includes("/")) {
    return { ok: false, detail: `invalid repo identity "${input.repo}"` };
  }
  const contracted = input.contracted;
  // Selector under observation is the contracted selector identity (type+value);
  // membership is resolved live — never by copying contracted.issue_ids.
  const selector: FactorySelector = {
    type: contracted.selector.type,
    value: contracted.selector.value,
  };

  const membership = await resolveLiveSelectorMembership(deps, {
    repo: input.repo,
    selector,
  });
  if (!membership.ok) {
    return { ok: false, detail: membership.detail };
  }
  const observedIssues = membership.issue_ids;

  // PR identity slots: re-verify each contracted PR still exists independently.
  // (PR membership is not selector-derived; absence → fail closed.)
  const missingPrs: string[] = [];
  const observedPrs: string[] = [];
  for (const raw of contracted.pr_ids) {
    const n = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) {
      missingPrs.push(String(raw));
      continue;
    }
    const pr = await deps.getPull(input.repo, n);
    if (!pr) missingPrs.push(String(raw));
    else observedPrs.push(String(raw));
  }
  if (missingPrs.length > 0) {
    return {
      ok: false,
      detail: `contracted PRs not readable in ${input.repo}: ${missingPrs.join(", ")}`,
    };
  }

  // Milestones: assigned on live matched open issues only (never copy
  // contracted.milestones). For milestone selectors, also require the selector
  // title still exists as a repo milestone title.
  const milestoneTitles = new Set<string>();
  for (const row of membership.matched_open) {
    if (row.milestone) milestoneTitles.add(String(row.milestone));
  }
  if (selector.type === "issues" || selector.type === "explicit") {
    // Existence selectors have no matched_open rows — project open-issue
    // milestone assignments for the live-readable membership set when listing
    // is available. Listing failure fails closed (do not invent titles).
    const openIssues = await deps.listOpenIssues(input.repo);
    if (openIssues == null) {
      return {
        ok: false,
        detail: `open-issue listing unavailable for ${input.repo} — cannot observe milestone assignments`,
      };
    }
    const idSet = new Set(observedIssues.map(String));
    for (const row of openIssues) {
      if (idSet.has(String(row.number)) && row.milestone) {
        milestoneTitles.add(String(row.milestone));
      }
    }
  }
  if (selector.type === "milestone" && selector.value) {
    const liveMilestoneTitles = await deps.listMilestones(input.repo);
    if (liveMilestoneTitles == null) {
      return {
        ok: false,
        detail: `milestone listing unavailable for ${input.repo}`,
      };
    }
    if (!liveMilestoneTitles.map(String).includes(selector.value)) {
      return {
        ok: false,
        detail: `selector milestone "${selector.value}" not present in ${input.repo}`,
      };
    }
    milestoneTitles.add(selector.value);
  }
  const observedMilestones = [...milestoneTitles].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  // Dependency edges: independent discovery — never filter contracted edges.
  const liveEdges = await deps.listDependencyEdges(input.repo, observedIssues);
  if (liveEdges == null) {
    return {
      ok: false,
      detail: `dependency-edge discovery unavailable for ${input.repo}`,
    };
  }
  const observedEdges = liveEdges.map((e) => ({
    from: String(e.from),
    to: String(e.to),
  }));

  const observed: FactoryGithubIdentitySnapshot = {
    selector: { type: selector.type, value: selector.value },
    issue_ids: observedIssues,
    pr_ids: observedPrs,
    milestones: observedMilestones,
    dependency_edges: observedEdges,
  };
  return { ok: true, observed };
}

/** Map durable loop status into the factory child observation shape. */
export function childStatusFromLoopStatus(status: LoopStatus): ChildRunStatus {
  const itemStates = Object.values(status.items).map((i) => i.state);
  const terminal = new Set(["merged", "released", "deployed", "cancelled", "failed", "ready"]);
  // Loop ledger terminal-ish product outcomes for "all items terminal".
  const productReady = new Set(["ready", "merged", "released", "deployed"]);
  const all_items_terminal =
    itemStates.length > 0 && itemStates.every((s) => terminal.has(s));
  const all_ready_to_deploy =
    itemStates.length > 0 && itemStates.every((s) => productReady.has(s));

  if (status.stop) {
    const reason = String((status.stop as { reason?: string }).reason ?? "stopped");
    if (all_items_terminal && all_ready_to_deploy) {
      return {
        state: "completed",
        run_id: status.run_id,
        all_items_terminal: true,
        all_ready_to_deploy: true,
      };
    }
    if (reason.includes("fail") || reason.includes("error")) {
      return { state: "failed", run_id: status.run_id, detail: reason };
    }
    if (all_items_terminal) {
      return {
        state: "completed",
        run_id: status.run_id,
        all_items_terminal: true,
        all_ready_to_deploy: false,
      };
    }
    return { state: "failed", run_id: status.run_id, detail: reason };
  }
  if (status.active_items.length > 0) {
    return { state: "running", run_id: status.run_id };
  }
  if (all_items_terminal) {
    return {
      state: "completed",
      run_id: status.run_id,
      all_items_terminal: true,
      all_ready_to_deploy,
    };
  }
  // Present ledger but no active work and not all terminal — still running/idle.
  if (itemStates.length > 0) {
    return { state: "running", run_id: status.run_id };
  }
  return { state: "running", run_id: status.run_id };
}

// ---------------------------------------------------------------------------
// CLI / production macro deps assembly
// ---------------------------------------------------------------------------

export interface BuildFactoryMacroDepsInput {
  store: FactoryStoreDeps;
  cfg: PipelineConfig;
  /** Repo root used for git / pin observation. */
  repoDir: string;
  observers?: Partial<FactoryLiveObserverDeps>;
}

/**
 * Build {@link FactoryMacroDeps} with authoritative live observers for the
 * enabled CLI tick path. Does not invent git/GitHub/config success — all four
 * external-truth seams call real (or injected) observers.
 */
export function buildFactoryMacroDeps(
  input: BuildFactoryMacroDepsInput,
): FactoryMacroDeps {
  const base = defaultFactoryLiveObserverDeps(process.env);
  const obs: FactoryLiveObserverDeps = {
    ...base,
    ...input.observers,
    // Explicitly keep loopStore if partially overridden without it.
    loopStore: input.observers?.loopStore ?? base.loopStore,
    git: input.observers?.git ?? base.git,
    getIssue: input.observers?.getIssue ?? base.getIssue,
    getPull: input.observers?.getPull ?? base.getPull,
    listOpenIssues: input.observers?.listOpenIssues ?? base.listOpenIssues,
    listDependencyEdges:
      input.observers?.listDependencyEdges ?? base.listDependencyEdges,
    listMilestones: input.observers?.listMilestones ?? base.listMilestones,
    readEnginePin: input.observers?.readEnginePin ?? base.readEnginePin,
    now: input.observers?.now ?? base.now,
  };
  const { cfg, store, repoDir } = input;

  return {
    store,
    now: () => obs.now(),
    observeBaseSha: (dir, baseBranch) => observeFactoryBaseSha(obs, dir, baseBranch),
    observeRepoIdentity: (args) => observeFactoryRepoIdentity(cfg, args),
    observeGithubSnapshot: (args) => observeFactoryGithubSnapshot(obs, args),
    readConfigFingerprints: async () => {
      const pin = await obs.readEnginePin(repoDir);
      return computeEffectiveConfigFingerprints(cfg, pin);
    },
    startOrResumeLoop: async ({ loop_run_id, factory_run_id }) => {
      // CLI does not mint new durable loop runs. Linked loop ids are observed
      // and resumed by identity only; creation is via pipeline loop / library.
      if (loop_run_id) return { loop_run_id };
      throw new FactoryError(
        "validation",
        `factory tick cannot create a new durable loop for "${factory_run_id}"; ` +
          `adopt/replan with linked_runs.loop_run_id or start the loop via pipeline loop`,
      );
    },
    observeLoop: async (loopRunId) => {
      try {
        const status = await getStatus(obs.loopStore, loopRunId);
        return childStatusFromLoopStatus(status);
      } catch {
        return { state: "not_found" };
      }
    },
  };
}
