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
import { getIssueDetail } from "../gh.ts";
import {
  defaultLoopStoreDeps,
  getStatus,
  type LoopStoreDeps,
  type LoopStatus,
} from "../loop/store.ts";
import {
  productionPinPath,
  parseProductionEnginePin,
  type ProductionEnginePin,
} from "../production-engine-pin.ts";
import {
  FactoryError,
  type FactoryFingerprints,
  type FactoryGithubIdentitySnapshot,
} from "./types.ts";
import type { ChildRunStatus, FactoryMacroDeps } from "./controller.ts";
import type { FactoryStoreDeps } from "./store.ts";
import { getMilestones } from "../gh.ts";

const execFileAsync = promisify(execFile);

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
   * List milestone titles for the repository (live selector / milestone
   * identity observation).
   */
  listMilestones(repo: string): Promise<string[]>;
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
    async listMilestones(repo) {
      try {
        const ms = await getMilestones(repo);
        return ms.map((m) => m.title);
      } catch {
        return [];
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

/**
 * Fresh GitHub identity snapshot for the contracted selector, issue/PR ids,
 * milestones, and dependency edges. Returns a typed `observed` object so the
 * controller can compare each field against the accepted revision. Empty
 * issue/PR/milestone lists are successful no-ops for those slots.
 */
export async function observeFactoryGithubSnapshot(
  deps: Pick<FactoryLiveObserverDeps, "getIssue" | "getPull" | "listMilestones">,
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
  const missingIssues: string[] = [];
  const observedIssues: string[] = [];
  for (const raw of contracted.issue_ids) {
    const n = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) {
      missingIssues.push(String(raw));
      continue;
    }
    const issue = await deps.getIssue(input.repo, n);
    if (!issue) missingIssues.push(String(raw));
    else observedIssues.push(String(raw));
  }
  if (missingIssues.length > 0) {
    return {
      ok: false,
      detail: `selector issues not readable in ${input.repo}: ${missingIssues.join(", ")}`,
    };
  }

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

  const liveMilestoneTitles = await deps.listMilestones(input.repo);
  const liveMilestoneSet = new Set(liveMilestoneTitles.map(String));
  const observedMilestones = contracted.milestones.filter((m) =>
    liveMilestoneSet.has(String(m)),
  );
  if (observedMilestones.length !== contracted.milestones.length) {
    const missing = contracted.milestones.filter((m) => !liveMilestoneSet.has(String(m)));
    return {
      ok: false,
      detail: `contracted milestones not present in ${input.repo}: ${missing.join(", ")}`,
    };
  }

  // Selector backing identity: milestone/label/issues must still be live.
  const selector = {
    type: contracted.selector.type,
    value: contracted.selector.value,
  };
  if (selector.type === "milestone" && selector.value) {
    if (!liveMilestoneSet.has(selector.value)) {
      return {
        ok: false,
        detail: `selector milestone "${selector.value}" not present in ${input.repo}`,
      };
    }
  }
  if (selector.type === "issues" || selector.type === "explicit") {
    // Membership is the issue list already verified above.
  }

  // Dependency edges: both endpoints must remain among observed issues.
  const issueSet = new Set(observedIssues.map(String));
  const observedEdges = contracted.dependency_edges.filter(
    (e) => issueSet.has(String(e.from)) && issueSet.has(String(e.to)),
  );
  if (observedEdges.length !== contracted.dependency_edges.length) {
    return {
      ok: false,
      detail: `dependency edge endpoints missing from live issues in ${input.repo}`,
    };
  }

  const observed: FactoryGithubIdentitySnapshot = {
    selector,
    issue_ids: observedIssues,
    pr_ids: observedPrs,
    milestones: observedMilestones,
    dependency_edges: observedEdges.map((e) => ({ from: e.from, to: e.to })),
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
