// Epic decompose sub-command (#766): turn one epic issue into a bounded set of
// small, dependency-linked child issues and a human-reviewable ROADMAP PR.
//
// Default is dry-run (preview only). `--apply` creates children + opens a
// ROADMAP PR and never merges. All external I/O is injected via DecomposeDeps.

import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { invoke } from "../harness.ts";
import { DEFAULT_CONFIG, type GitPushAuth, type PipelineConfig } from "../types.ts";
import { buildDecomposePrompt } from "../prompts/index.ts";
import {
  DEFAULT_GIT_PUSH_AUTH,
  runConfiguredGitPushSync,
} from "../git-push-auth.ts";
import {
  insertPerIssueRow,
  insertDetailSectionBullet,
  scaffoldDetailSectionHeading,
  validateGlobalRoadmapAnchors,
  computeUnifiedDiff,
} from "./release.ts";
import {
  inferReleaseSlot,
  labelCreateArgs,
  isLabelAlreadyExists,
  reservePushArgs,
} from "./intake.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EPIC_LABEL = "pipeline:epic";
export const DEFAULT_MAX_CHILDREN = 12;
export type EffortBand = "S" | "M" | "L" | "XL";
export const DEFAULT_MAX_EFFORT: EffortBand = "M";
export const EFFORT_RANK: Record<EffortBand, number> = { S: 1, M: 2, L: 3, XL: 4 };
export const EFFORT_BANDS = new Set<string>(["S", "M", "L", "XL"]);

const PROVENANCE_RE =
  /<!--\s*pipeline-decompose:\s*parent=#(\d+)\s+key=([a-z0-9][a-z0-9-]*)\s*-->/i;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DecomposeChildPlan {
  key: string;
  title: string;
  summary: string;
  user_story: string;
  acceptance_criteria: string[];
  out_of_scope: string[];
  open_questions?: string[];
  effort: EffortBand;
  depends_on_keys: string[];
}

export interface DecomposePlan {
  children: DecomposeChildPlan[];
}

export interface DecomposeOpts {
  epic: number;
  description?: string;
  apply?: boolean;
  /** Pinned release slot (e.g. "v1.6.0"). When absent, infer from ROADMAP. */
  release?: string;
  maxChildren?: number;
  maxEffort?: EffortBand;
  /** Permit children with effort above maxEffort / XL when configured. */
  allowXl?: boolean;
}

export interface DecomposeConfig {
  max_children?: number;
  max_effort?: EffortBand;
}

export interface DecomposeIssue {
  number: number;
  title: string;
  body: string;
  labels?: string[];
  state?: string;
}

export interface DecomposeDeps {
  getIssue(issueNumber: number): Promise<DecomposeIssue>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  ensureLabel(repoDir: string, name: string, color: string): Promise<void>;
  /** Open issues with bodies for provenance matching. */
  listOpenIssues(): Promise<DecomposeIssue[]>;
  runHarness(
    prompt: string,
    timeoutSec: number,
  ): Promise<{ success: boolean; output: string; timed_out?: boolean }>;
  gitResolveBaseSha(repoDir: string, baseBranch: string): string;
  readFileAtBase(repoDir: string, ref: string, relPath: string): string;
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  gitEnsureClean(repoDir: string): void;
  gitCreateBranch(repoDir: string, branch: string, fromRef: string): void;
  reserveRemoteBranch(repoDir: string, branch: string, sha: string): void;
  gitPushBranch(repoDir: string, branch: string): void;
  gitCommit(repoDir: string, files: string[], message: string): void;
  createPR(
    repoDir: string,
    title: string,
    body: string,
    base: string,
    head: string,
  ): Promise<string>;
  randomToken(): string;
  log(msg: string): void;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

export function realDecomposeDeps(
  repoDir: string,
  model: string = DEFAULT_CONFIG.models.intake,
  reasoningEffort?: string,
  implementerHarness: string = "claude",
  pushAuth: GitPushAuth = DEFAULT_GIT_PUSH_AUTH,
): DecomposeDeps {
  const auth = pushAuth;
  return {
    getIssue: async (issueNumber) => {
      const result = spawnSync(
        "gh",
        [
          "issue",
          "view",
          String(issueNumber),
          "--json",
          "number,title,body,labels,state",
        ],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[pipeline decompose] could not load epic #${issueNumber} (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const data = JSON.parse(result.stdout.trim() || "{}") as {
        number: number;
        title: string;
        body?: string;
        state?: string;
        labels?: Array<{ name: string }>;
      };
      if (!data.number) {
        throw new Error(
          `[pipeline decompose] epic #${issueNumber} not found or inaccessible`,
        );
      }
      return {
        number: data.number,
        title: data.title ?? "",
        body: data.body ?? "",
        state: data.state,
        labels: (data.labels ?? []).map((l) => l.name),
      };
    },
    createIssue: async (title, body, labels) => {
      const args = ["issue", "create", "--title", title, "--body", body];
      for (const label of labels) args.push("--label", label);
      const result = spawnSync("gh", args, {
        encoding: "utf8",
        stdio: "pipe",
        cwd: repoDir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline decompose] gh issue create failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const url = result.stdout.trim();
      const m = url.match(/\/(\d+)$/);
      if (!m) {
        throw new Error(
          `[pipeline decompose] could not parse issue number from gh output: ${url}`,
        );
      }
      return Number(m[1]);
    },
    addLabels: async (issueNumber, labels) => {
      if (labels.length === 0) return;
      const args = ["issue", "edit", String(issueNumber)];
      for (const label of labels) {
        args.push("--add-label", label);
      }
      const result = spawnSync("gh", args, {
        encoding: "utf8",
        stdio: "pipe",
        cwd: repoDir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline decompose] gh issue edit --add-label failed for #${issueNumber} (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
    },
    ensureLabel: async (dir, name, color) => {
      const result = spawnSync("gh", labelCreateArgs(name, color), {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status === 0) return;
      if (isLabelAlreadyExists(result.status ?? 1, result.stderr ?? "")) return;
      throw new Error(
        `[pipeline decompose] could not ensure label "${name}" (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
      );
    },
    listOpenIssues: async () => {
      const PAGE_SIZE = 100;
      const all: DecomposeIssue[] = [];
      let page = 1;
      while (true) {
        const result = spawnSync(
          "gh",
          [
            "api",
            "repos/{owner}/{repo}/issues",
            "--method",
            "GET",
            "-F",
            "state=open",
            "-F",
            `per_page=${PAGE_SIZE}`,
            "-F",
            `page=${page}`,
          ],
          { encoding: "utf8", stdio: "pipe", cwd: repoDir },
        );
        if (result.status !== 0) {
          throw new Error(
            `[pipeline decompose] gh api issues failed (page ${page}, exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
          );
        }
        const batch = JSON.parse(result.stdout.trim() || "[]") as Array<{
          number: number;
          title: string;
          body?: string | null;
          labels?: Array<{ name: string }>;
          pull_request?: unknown;
        }>;
        for (const item of batch) {
          if (item.pull_request) continue;
          all.push({
            number: item.number,
            title: item.title ?? "",
            body: item.body ?? "",
            labels: (item.labels ?? []).map((l) => l.name),
          });
        }
        if (batch.length < PAGE_SIZE) break;
        page += 1;
      }
      return all;
    },
    runHarness: async (prompt, timeoutSec) => {
      const result = await invoke(implementerHarness, repoDir, prompt, {
        stream: true,
        model,
        lean: true,
        timeoutSec,
        reasoningEffort,
      });
      return {
        success: result.success,
        output: result.stdout,
        timed_out: result.timed_out,
      };
    },
    gitResolveBaseSha: (dir, baseBranch) => {
      const result = spawnSync(
        "git",
        ["rev-parse", "--verify", `origin/${baseBranch}`],
        { encoding: "utf8", stdio: "pipe", cwd: dir },
      );
      const sha = result.stdout?.trim() ?? "";
      if (result.status !== 0 || !/^[0-9a-f]{7,40}$/.test(sha)) {
        throw new Error(
          `[pipeline decompose] could not resolve origin/${baseBranch} to a commit SHA (exit ${result.status}): ` +
            `${result.stderr?.trim() ?? ""}.\n` +
            `  Ensure origin/${baseBranch} is fetched: git fetch origin ${baseBranch}`,
        );
      }
      return sha;
    },
    readFileAtBase: (dir, ref, relPath) => {
      const result = spawnSync("git", ["show", `${ref}:${relPath}`], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline decompose] could not read ${relPath} at ${ref} (exit ${result.status}): ` +
            `${result.stderr?.trim() ?? ""}.`,
        );
      }
      return result.stdout;
    },
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf8"),
    gitEnsureClean: (dir) => {
      const result = spawnSync(
        "git",
        ["status", "--porcelain", "--", "ROADMAP.md"],
        { encoding: "utf8", stdio: "pipe", cwd: dir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[pipeline decompose] git status failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const dirty = result.stdout.trim();
      if (dirty) {
        throw new Error(
          `[pipeline decompose] ROADMAP.md has uncommitted local changes — stash or commit them before --apply.\n` +
            `  Dirty: ${dirty}`,
        );
      }
    },
    reserveRemoteBranch: (dir, branch, sha) => {
      const result = runConfiguredGitPushSync({
        cwd: dir,
        auth,
        args: reservePushArgs(branch, sha),
      });
      const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      const statusLine =
        out.split("\n").find((l) => l.includes(`:refs/heads/${branch}`)) ?? "";
      const flag = statusLine.charAt(0);
      if (result.code === 0 && flag === "*") return;
      if (flag === "!" || flag === "=" || /stale info/i.test(out)) {
        throw new Error(
          `[pipeline decompose] branch ${branch} already exists on origin — aborting before creating any issue.\n` +
            `  A concurrent or prior decompose run reserved it; re-run to get a fresh branch name.`,
        );
      }
      throw new Error(
        `[pipeline decompose] could not reserve origin/${branch} via git push (exit ${result.code}): ${(result.errorMessage || result.stderr || result.stdout || "").trim()}\n` +
          `  The branch may already exist, or this checkout's origin push credentials are missing or read-only.`,
      );
    },
    gitCreateBranch: (dir, branch, fromRef) => {
      const result = spawnSync("git", ["checkout", "-b", branch, fromRef], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (result.status !== 0) {
        throw new Error(
          `[pipeline decompose] git checkout -b ${branch} ${fromRef} failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
    },
    gitCommit: (dir, files, message) => {
      const addResult = spawnSync("git", ["add", "--", ...files], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (addResult.status !== 0) {
        throw new Error(
          `[pipeline decompose] git add failed (exit ${addResult.status}): ${addResult.stderr?.trim() ?? ""}`,
        );
      }
      const commitResult = spawnSync("git", ["commit", "-m", message], {
        encoding: "utf8",
        stdio: "pipe",
        cwd: dir,
      });
      if (commitResult.status !== 0) {
        throw new Error(
          `[pipeline decompose] git commit failed (exit ${commitResult.status}): ${commitResult.stderr?.trim() ?? ""}`,
        );
      }
    },
    gitPushBranch: (dir, branch) => {
      const result = runConfiguredGitPushSync({
        cwd: dir,
        auth,
        args: ["push", "origin", branch],
      });
      if (result.code !== 0) {
        throw new Error(
          `[pipeline decompose] git push origin ${branch} failed (exit ${result.code}): ${(result.errorMessage ?? result.stderr)?.trim() ?? ""}`,
        );
      }
    },
    createPR: async (dir, title, body, base, head) => {
      const prResult = spawnSync(
        "gh",
        [
          "pr",
          "create",
          "--title",
          title,
          "--body",
          body,
          "--base",
          base,
          "--head",
          head,
        ],
        { encoding: "utf8", stdio: "pipe", cwd: dir },
      );
      if (prResult.status !== 0) {
        throw new Error(
          `[pipeline decompose] gh pr create failed (exit ${prResult.status}): ${prResult.stderr?.trim() ?? ""}`,
        );
      }
      return prResult.stdout.trim();
    },
    randomToken: () => crypto.randomBytes(3).toString("hex"),
    log: (msg) => process.stdout.write(msg + "\n"),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — provenance, plan parse, cycle, bounds
// ---------------------------------------------------------------------------

/** Render the machine-readable provenance marker embedded in child bodies. */
export function renderProvenanceMarker(parent: number, key: string): string {
  return `<!-- pipeline-decompose: parent=#${parent} key=${key} -->`;
}

/** Parse a provenance marker from an issue body; null when absent/malformed. */
export function parseProvenanceMarker(
  body: string,
): { parent: number; key: string } | null {
  const m = PROVENANCE_RE.exec(body ?? "");
  if (!m) return null;
  return { parent: Number(m[1]), key: m[2] };
}

/** Pure cycle detection over plan keys. Returns a cycle path or null. */
export function detectDependencyCycle(
  children: ReadonlyArray<{ key: string; depends_on_keys: string[] }>,
): string[] | null {
  const adj = new Map<string, string[]>();
  for (const c of children) {
    adj.set(c.key, [...(c.depends_on_keys ?? [])]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    if (visiting.has(node)) {
      const idx = stack.indexOf(node);
      return [...stack.slice(idx), node];
    }
    if (visited.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (!adj.has(next)) continue; // external / unknown edges ignored for cycle among plan keys
      const cycle = dfs(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const key of adj.keys()) {
    const cycle = dfs(key);
    if (cycle) return cycle;
  }
  return null;
}

export type BoundCheckResult =
  | { ok: true }
  | { ok: false; message: string };

/** Enforce max-children and max-effort (XL requires allowXl or maxEffort XL). */
export function checkPlanBounds(
  plan: DecomposePlan,
  maxChildren: number,
  maxEffort: EffortBand,
  allowXl: boolean,
): BoundCheckResult {
  if (plan.children.length === 0) {
    return { ok: false, message: "decomposition plan has zero children" };
  }
  if (plan.children.length > maxChildren) {
    return {
      ok: false,
      message:
        `decomposition plan has ${plan.children.length} children which exceeds max-children bound ${maxChildren}`,
    };
  }
  const maxRank = EFFORT_RANK[maxEffort];
  for (const child of plan.children) {
    if (child.effort === "XL" && !allowXl && maxEffort !== "XL") {
      return {
        ok: false,
        message:
          `child "${child.key}" has effort XL; refuse without --allow-xl (or max-effort XL)`,
      };
    }
    if (EFFORT_RANK[child.effort] > maxRank && !(child.effort === "XL" && allowXl)) {
      return {
        ok: false,
        message:
          `child "${child.key}" has effort ${child.effort} which exceeds max-effort ${maxEffort}` +
          (allowXl ? "" : " (pass --allow-xl to permit XL)"),
      };
    }
  }
  return { ok: true };
}

/**
 * Parse and validate a harness plan. Throws with a descriptive message on
 * malformed JSON or schema violations.
 */
export function parseDecomposePlan(raw: string): DecomposePlan {
  const jsonText = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `[pipeline decompose] harness output is not valid JSON: ${(err as Error).message}\n` +
        `  Raw output (first 500 chars):\n${raw.slice(0, 500)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[pipeline decompose] plan root must be a JSON object");
  }
  const childrenRaw = (parsed as { children?: unknown }).children;
  if (!Array.isArray(childrenRaw)) {
    throw new Error("[pipeline decompose] plan.children must be an array");
  }
  const children: DecomposeChildPlan[] = [];
  const seenKeys = new Set<string>();
  for (let i = 0; i < childrenRaw.length; i++) {
    const c = childrenRaw[i];
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      throw new Error(`[pipeline decompose] children[${i}] must be an object`);
    }
    const row = c as Record<string, unknown>;
    const key = String(row.key ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
      throw new Error(
        `[pipeline decompose] children[${i}].key must be a non-empty lowercase slug (got "${key}")`,
      );
    }
    if (seenKeys.has(key)) {
      throw new Error(`[pipeline decompose] duplicate child key "${key}"`);
    }
    seenKeys.add(key);
    const title = String(row.title ?? "").trim();
    if (!title) {
      throw new Error(`[pipeline decompose] children[${i}] ("${key}") missing title`);
    }
    const summary = String(row.summary ?? "").trim();
    if (!summary) {
      throw new Error(`[pipeline decompose] children[${i}] ("${key}") missing summary`);
    }
    const user_story = String(row.user_story ?? "").trim();
    if (!user_story) {
      throw new Error(
        `[pipeline decompose] children[${i}] ("${key}") missing user_story`,
      );
    }
    const acceptance_criteria = asStringArray(
      row.acceptance_criteria,
      `children[${i}].acceptance_criteria`,
    );
    if (acceptance_criteria.length === 0) {
      throw new Error(
        `[pipeline decompose] children[${i}] ("${key}") needs at least one acceptance criterion`,
      );
    }
    const out_of_scope = asStringArray(
      row.out_of_scope,
      `children[${i}].out_of_scope`,
    );
    const open_questions =
      row.open_questions === undefined
        ? undefined
        : asStringArray(row.open_questions, `children[${i}].open_questions`);
    const effortRaw = String(row.effort ?? "").trim().toUpperCase();
    if (!EFFORT_BANDS.has(effortRaw)) {
      throw new Error(
        `[pipeline decompose] children[${i}] ("${key}") effort must be S|M|L|XL (got "${row.effort}")`,
      );
    }
    const depends_on_keys = asStringArray(
      row.depends_on_keys ?? [],
      `children[${i}].depends_on_keys`,
    );
    children.push({
      key,
      title,
      summary,
      user_story,
      acceptance_criteria,
      out_of_scope,
      open_questions,
      effort: effortRaw as EffortBand,
      depends_on_keys,
    });
  }
  // Validate depends_on_keys reference known keys.
  for (const child of children) {
    for (const dep of child.depends_on_keys) {
      if (!seenKeys.has(dep)) {
        throw new Error(
          `[pipeline decompose] child "${child.key}" depends_on_keys references unknown key "${dep}"`,
        );
      }
      if (dep === child.key) {
        throw new Error(
          `[pipeline decompose] child "${child.key}" cannot depend on itself`,
        );
      }
    }
  }
  return { children };
}

function asStringArray(value: unknown, pathLabel: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`[pipeline decompose] ${pathLabel} must be an array of strings`);
  }
  return value.map((v, i) => {
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(
        `[pipeline decompose] ${pathLabel}[${i}] must be a non-empty string`,
      );
    }
    return v.trim();
  });
}

/** Extract the first top-level JSON object from harness output. */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  // Strip optional fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  if (start < 0) {
    throw new Error(
      `[pipeline decompose] harness output contains no JSON object\n` +
        `  Raw output (first 500 chars):\n${raw.slice(0, 500)}`,
    );
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  throw new Error(
    `[pipeline decompose] harness output JSON object is incomplete\n` +
      `  Raw output (first 500 chars):\n${raw.slice(0, 500)}`,
  );
}

/** Build a WHAT-not-HOW issue body with grammar-legal Depends on lines. */
export function buildChildBody(
  child: DecomposeChildPlan,
  parentNumber: number,
  depIssueNumbers: number[],
): string {
  const marker = renderProvenanceMarker(parentNumber, child.key);
  const ac = child.acceptance_criteria.map((c) => `- [ ] ${c}`).join("\n");
  const oos =
    child.out_of_scope.length > 0
      ? child.out_of_scope.map((c) => `- ${c}`).join("\n")
      : "- (none)";
  const openQs =
    child.open_questions && child.open_questions.length > 0
      ? [
          "",
          "## Open questions",
          "",
          ...child.open_questions.map((q) => `- ${q}`),
        ].join("\n")
      : "";
  const depLine =
    depIssueNumbers.length > 0
      ? `Depends on: ${depIssueNumbers.map((n) => `#${n}`).join(", ")}`
      : "Depends on: (none)";
  const depSection =
    depIssueNumbers.length > 0
      ? [
          "",
          "## Dependencies",
          "",
          ...depIssueNumbers.map((n) => `- #${n}`),
        ].join("\n")
      : "";

  return [
    marker,
    "",
    `Parent epic: #${parentNumber}`,
    "",
    "## Summary",
    "",
    child.summary,
    "",
    "## User story",
    "",
    child.user_story,
    "",
    "## Acceptance criteria",
    "",
    ac,
    "",
    "## Out of scope",
    "",
    oos,
    openQs,
    "",
    depLine,
    depSection,
    "",
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n")
    .trim() + "\n";
}

/** Decision-complete children get pipeline:ready; open questions → backlog. */
export function triageLabelForChild(child: DecomposeChildPlan): string {
  const open = child.open_questions?.filter((q) => q.trim()) ?? [];
  return open.length === 0 ? "pipeline:ready" : "pipeline:backlog";
}

/** Pure filter used by loop selectors to drop epic umbrellas. */
export function isEpicLabeled(labels: readonly string[]): boolean {
  return labels.includes(EPIC_LABEL);
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runDecompose(
  opts: DecomposeOpts,
  cfg: {
    repo_dir: string;
    repo: string;
    base_branch: string;
    intake_timeout?: number;
    models?: PipelineConfig["models"];
    effort?: PipelineConfig["effort"];
    harnesses?: PipelineConfig["harnesses"];
    git?: PipelineConfig["git"];
    decompose?: DecomposeConfig;
  },
  deps?: DecomposeDeps,
): Promise<void> {
  const d =
    deps ??
    realDecomposeDeps(
      cfg.repo_dir,
      cfg.models?.intake ?? DEFAULT_CONFIG.models.intake,
      cfg.effort?.intake,
      cfg.harnesses?.implementer ?? "claude",
      cfg.git?.push_auth ?? DEFAULT_GIT_PUSH_AUTH,
    );
  const repoDir = cfg.repo_dir;
  const apply = !!opts.apply;

  // 1. Validate epic seed.
  if (!Number.isInteger(opts.epic) || opts.epic < 1) {
    throw new Error(
      `[pipeline decompose] --epic is required and must be a positive issue number.\n` +
        `  Usage: pipeline decompose --epic <N> [--description "…"] [--apply]`,
    );
  }
  if (opts.release !== undefined && !/^\d+\.\d+\.\d+$/.test(opts.release)) {
    const withV = opts.release.startsWith("v") ? opts.release.slice(1) : null;
    if (!withV || !/^\d+\.\d+\.\d+$/.test(withV)) {
      throw new Error(
        `[pipeline decompose] invalid --release value: "${opts.release}".\n` +
          `  Expected a semver string like "v1.6.0" or "1.6.0".`,
      );
    }
  }

  const maxChildren =
    opts.maxChildren ??
    cfg.decompose?.max_children ??
    DEFAULT_MAX_CHILDREN;
  const maxEffort: EffortBand =
    opts.maxEffort ??
    cfg.decompose?.max_effort ??
    DEFAULT_MAX_EFFORT;
  if (!EFFORT_BANDS.has(maxEffort)) {
    throw new Error(
      `[pipeline decompose] invalid max-effort "${maxEffort}" (expected S|M|L|XL)`,
    );
  }
  if (!Number.isInteger(maxChildren) || maxChildren < 1) {
    throw new Error(
      `[pipeline decompose] max-children must be a positive integer (got ${maxChildren})`,
    );
  }
  const allowXl = !!opts.allowXl;

  // 2. Load epic (fail before harness when missing).
  d.log(`[pipeline decompose] loading epic #${opts.epic}...`);
  let epic: DecomposeIssue;
  try {
    epic = await d.getIssue(opts.epic);
  } catch (err) {
    throw new Error(
      `[pipeline decompose] epic #${opts.epic} not found or inaccessible.\n` +
        `  ${(err as Error).message}`,
    );
  }

  // 3. Harness — single model call for the graph.
  d.log(`[pipeline decompose] generating child plan via model harness...`);
  const prompt = buildDecomposePrompt({
    epicTitle: epic.title,
    epicBody: epic.body || "(no description)",
    descriptionSeed: opts.description?.trim() || "",
    maxChildren,
    maxEffort,
    repoContext: cfg.repo || path.basename(repoDir),
  });
  const timeout = cfg.intake_timeout ?? DEFAULT_CONFIG.intake_timeout;
  const harnessResult = await d.runHarness(prompt, timeout);
  if (!harnessResult.success) {
    const timeoutMsg = harnessResult.timed_out
      ? ` (timed out after ${timeout}s)`
      : "";
    throw new Error(
      `[pipeline decompose] decomposition harness failed${timeoutMsg}`,
    );
  }

  // 4. Validate plan schema, bounds, cycles — before any write.
  const plan = parseDecomposePlan(harnessResult.output);
  const bounds = checkPlanBounds(plan, maxChildren, maxEffort, allowXl);
  if (!bounds.ok) {
    throw new Error(`[pipeline decompose] ${bounds.message}`);
  }
  const cycle = detectDependencyCycle(plan.children);
  if (cycle) {
    throw new Error(
      `[pipeline decompose] dependency cycle detected: ${cycle.join(" → ")}`,
    );
  }

  // Topological order for create (deps first).
  const ordered = topoSort(plan.children);

  // Dry-run path.
  if (!apply) {
    d.log(
      `[pipeline decompose] dry-run (no writes) — pass --apply to create children and open a ROADMAP PR`,
    );
    d.log("");
    d.log(`Epic: #${epic.number} — ${epic.title}`);
    d.log(`Proposed children: ${ordered.length} (max ${maxChildren}, max-effort ${maxEffort})`);
    d.log("");
    for (const child of ordered) {
      d.log(`### ${child.key} — ${child.title}`);
      d.log(`  effort: ${child.effort}`);
      d.log(
        `  deps: ${
          child.depends_on_keys.length
            ? child.depends_on_keys.join(", ")
            : "(none)"
        }`,
      );
      d.log(`  summary: ${child.summary}`);
      d.log(`  AC:`);
      for (const ac of child.acceptance_criteria) {
        d.log(`    - [ ] ${ac}`);
      }
      if (child.open_questions?.length) {
        d.log(`  open questions: ${child.open_questions.join("; ")}`);
      }
      d.log("");
    }
    d.log(
      `No GitHub issues, labels, branches, or PRs were created. Re-run with --apply to materialize.`,
    );
    return;
  }

  // ---- Apply path ----

  // Pin base SHA for ROADMAP PR isolation (same as intake).
  const baseSha = d.gitResolveBaseSha(repoDir, cfg.base_branch);
  let roadmapAtBase: string;
  try {
    roadmapAtBase = d.readFileAtBase(repoDir, baseSha, "ROADMAP.md");
    validateGlobalRoadmapAnchors(roadmapAtBase);
  } catch (err) {
    throw new Error(
      `[pipeline decompose] ROADMAP precondition failed before child creates: ${(err as Error).message}`,
    );
  }

  let version: string;
  if (opts.release) {
    version = opts.release.startsWith("v")
      ? opts.release.slice(1)
      : opts.release;
  } else {
    const inferred = inferReleaseSlot(roadmapAtBase);
    if (!inferred) {
      d.log(
        `[pipeline decompose] could not infer a release slot from ROADMAP.md — children will be created without release:* label; pass --release vX.Y.Z to pin.`,
      );
      version = "";
    } else {
      version = inferred;
      d.log(`[pipeline decompose] proposed release slot: v${version}`);
    }
  }

  d.gitEnsureClean(repoDir);

  // Reserve branch before irreversible creates (intake pattern).
  const branch = `decompose/${opts.epic}-${baseSha.slice(0, 7)}-${d.randomToken()}`;
  d.log(
    `[pipeline decompose] creating branch ${branch} from base ${baseSha.slice(0, 12)}...`,
  );
  d.gitCreateBranch(repoDir, branch, baseSha);
  d.log(
    `[pipeline decompose] reserving origin/${branch} (proves push capability) before issue creation...`,
  );
  d.reserveRemoteBranch(repoDir, branch, baseSha);

  // Ensure labels create-only.
  const labelsToEnsure = [
    { name: EPIC_LABEL, color: "5319E7" },
    { name: "pipeline:ready", color: "1D76DB" },
    { name: "pipeline:backlog", color: "FBCA04" },
  ];
  if (version) {
    labelsToEnsure.push({ name: `release:v${version}`, color: "e4e669" });
  }
  await Promise.all(
    labelsToEnsure.map((l) => d.ensureLabel(repoDir, l.name, l.color)),
  );

  // Label parent epic (create-only ensure already done).
  await d.addLabels(opts.epic, [EPIC_LABEL]);
  d.log(`[pipeline decompose] labeled parent #${opts.epic} with ${EPIC_LABEL}`);

  // Idempotency: match existing children by provenance marker.
  const openIssues = await d.listOpenIssues();
  const existingByKey = new Map<string, number>();
  for (const issue of openIssues) {
    const marker = parseProvenanceMarker(issue.body ?? "");
    if (marker && marker.parent === opts.epic) {
      existingByKey.set(marker.key, issue.number);
    }
  }

  const keyToNumber = new Map<string, number>(existingByKey);
  let createdCount = 0;
  let reusedCount = 0;

  for (const child of ordered) {
    const existing = keyToNumber.get(child.key);
    if (existing !== undefined) {
      reusedCount += 1;
      d.log(
        `[pipeline decompose] reusing existing child #${existing} for key "${child.key}" (idempotent)`,
      );
      continue;
    }
    // Resolve deps among already-matched/created siblings.
    const depNumbers: number[] = [];
    for (const depKey of child.depends_on_keys) {
      const n = keyToNumber.get(depKey);
      if (n === undefined) {
        throw new Error(
          `[pipeline decompose] internal error: dep key "${depKey}" has no issue number yet for child "${child.key}"`,
        );
      }
      depNumbers.push(n);
    }
    const body = buildChildBody(child, opts.epic, depNumbers);
    const triage = triageLabelForChild(child);
    const labels = [triage];
    if (version) labels.push(`release:v${version}`);
    const num = await d.createIssue(child.title, body, labels);
    keyToNumber.set(child.key, num);
    createdCount += 1;
    d.log(
      `[pipeline decompose] created #${num}: ${child.title} [${triage}] (key=${child.key})`,
    );
  }

  // ROADMAP mutations for all children (created + reused).
  const childNumbers = ordered.map((c) => ({
    child: c,
    number: keyToNumber.get(c.key)!,
  }));
  let mutated = roadmapAtBase;
  for (const { child, number } of childNumbers) {
    mutated = insertPerIssueRow(
      mutated,
      number,
      "minor",
      "new sub-command",
      "decompose",
      version || "—",
      child.depends_on_keys
        .map((k) => {
          const n = keyToNumber.get(k);
          return n ? `#${n}` : k;
        })
        .join(", ") || "—",
    );
    try {
      if (version) {
        mutated = scaffoldDetailSectionHeading(mutated, version);
        mutated = insertDetailSectionBullet(
          mutated,
          version,
          `**#${number}** — ${child.summary.split(/(?<=\.)\s+/)[0] ?? child.title}`,
        );
      }
    } catch {
      // Detail section optional; per-issue row already applied.
    }
  }

  const roadmapPath = path.join(repoDir, "ROADMAP.md");
  const prTitle = `decompose: ROADMAP for epic #${opts.epic} — ${childNumbers.length} children`;
  const childList = childNumbers
    .map(({ child, number }) => `- #${number} (\`${child.key}\`) — ${child.title}`)
    .join("\n");
  try {
    d.writeFile(roadmapPath, mutated);
    d.log(`[pipeline decompose] wrote ROADMAP.md`);
    const commitMsg =
      `docs: ROADMAP — decompose epic #${opts.epic}\n\n` +
      `Issue: #766\nPipeline-Run: 766/2026-08-11T22:06:15Z`;
    d.gitCommit(repoDir, ["ROADMAP.md"], commitMsg);
    d.gitPushBranch(repoDir, branch);
    const prBody = [
      `## ROADMAP update: epic #${opts.epic}`,
      "",
      `**Parent epic:** #${opts.epic} — ${epic.title}`,
      version ? `**Release:** v${version}` : "**Release:** (unpinned)",
      "",
      "### Children",
      "",
      childList,
      "",
      "---",
      "",
      "This PR was opened by `pipeline decompose`. Review the roadmap placement and merge when satisfied.",
      "",
      "_The advance path never merges. Integration requires an operator-authorized merge surface._",
    ].join("\n");
    const prUrl = await d.createPR(
      repoDir,
      prTitle,
      prBody,
      cfg.base_branch,
      branch,
    );
    d.log(`[pipeline decompose] roadmap PR opened: ${prUrl}`);
    d.log(
      `[pipeline decompose] done — created ${createdCount}, reused ${reusedCount}; parent #${opts.epic} labeled ${EPIC_LABEL}; roadmap PR: ${prUrl}`,
    );
    d.log(
      `[pipeline decompose] next: pipeline loop --milestone <lane>  (epic parents labeled ${EPIC_LABEL} are excluded from default milestone/label selectors)`,
    );
  } catch (err) {
    d.log(
      `\n[pipeline decompose] ERROR: children may have been created and branch ${branch} reserved, but the roadmap PR step failed.\n` +
        `  Recovery — finish the roadmap PR manually from the reserved branch:\n` +
        `    git add ROADMAP.md && git commit -m "docs: ROADMAP — decompose epic #${opts.epic}"\n` +
        `    git push origin ${branch}\n` +
        `    gh pr create --title "${prTitle}" --base ${cfg.base_branch} --head ${branch}`,
    );
    throw err;
  }
}

/** Deterministic topological order; assumes acyclic (caller validated). */
export function topoSort(children: DecomposeChildPlan[]): DecomposeChildPlan[] {
  const byKey = new Map(children.map((c) => [c.key, c]));
  const indeg = new Map<string, number>();
  for (const c of children) indeg.set(c.key, 0);
  for (const c of children) {
    for (const d of c.depends_on_keys) {
      if (indeg.has(d)) {
        // edge d → c (d before c): increment indegree of c
      }
    }
  }
  for (const c of children) {
    for (const d of c.depends_on_keys) {
      if (indeg.has(c.key) && byKey.has(d)) {
        indeg.set(c.key, (indeg.get(c.key) ?? 0) + 1);
      }
    }
  }
  const queue = children
    .filter((c) => (indeg.get(c.key) ?? 0) === 0)
    .map((c) => c.key)
    .sort();
  const out: DecomposeChildPlan[] = [];
  while (queue.length) {
    const key = queue.shift()!;
    const node = byKey.get(key)!;
    out.push(node);
    for (const c of children) {
      if (!c.depends_on_keys.includes(key)) continue;
      const next = (indeg.get(c.key) ?? 0) - 1;
      indeg.set(c.key, next);
      if (next === 0) {
        queue.push(c.key);
        queue.sort();
      }
    }
  }
  if (out.length !== children.length) {
    // Should not happen after cycle check; fall back to input order.
    return [...children];
  }
  return out;
}

/** Exported for tests that want a dry-run-friendly bound message without throw. */
export function formatCycleError(cycle: string[]): string {
  return `dependency cycle detected: ${cycle.join(" → ")}`;
}
