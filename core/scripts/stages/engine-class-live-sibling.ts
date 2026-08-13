// Engine-class live sibling filing (#1021 / #1028).
//
// After first recovered engine-class / engine-scratch fingerprint, file at most
// one live pipeline:ready sibling on the current train milestone with Depends on
// the recovered item. Narrow exception to #538 backlog-only auto-file policy.
// Reuses cross-host-safe create + reconcile patterns; never patches the victim PR.

import { spawnSync } from "node:child_process";
import { withLock } from "../lock.ts";
import {
  BACKLOG_LABEL,
  ENGINE_CLASS_MARKER_LABEL,
} from "../open-soak-defect-preflight.ts";

/** Provenance marker — independent of papercut/correction/durable-run-blocker caps. */
export const ENGINE_CLASS_LIVE_SIBLING_MARKER =
  "<!-- pipeline-auto-file: engine-class-live-sibling -->";

export const ENGINE_CLASS_LIVE_SIBLING_LABELS = [
  "bug",
  ENGINE_CLASS_MARKER_LABEL,
  "pipeline:ready",
] as const;

export interface EngineClassLiveSiblingOpts {
  /** Recovered (victim) issue number. */
  recoveredIssue: number;
  /** Stable evidence identity — one open sibling per key in-window. */
  evidenceKey: string;
  /** Current train milestone title when in scope; omit rather than guess. */
  milestone?: string | null;
  domain: string;
  windowHours: number;
  maxPerWindow: number;
}

export interface OpenSiblingIssue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  createdAt: string;
  milestone: string | null;
}

export interface EngineClassLiveSiblingDeps {
  listOpenImproveIssues: () => Promise<OpenSiblingIssue[]>;
  createIssue: (
    title: string,
    body: string,
    labels: string[],
    options?: { milestone?: string },
  ) => Promise<string>;
  closeIssue: (number: number, comment: string) => Promise<void>;
  ghAuthCheck: () => Promise<boolean>;
  now: () => number;
  withLock: <T>(domain: string, fn: () => Promise<T>) => Promise<T>;
  log: (msg: string) => void;
}

export function realEngineClassLiveSiblingDeps(repoDir: string): EngineClassLiveSiblingDeps {
  return {
    async listOpenImproveIssues() {
      const r = spawnSync(
        "gh",
        [
          "issue",
          "list",
          "--state",
          "all",
          "--limit",
          "200",
          "--search",
          "engine-class-live-sibling in:body",
          "--json",
          "number,title,body,state,labels,createdAt,milestone",
        ],
        { encoding: "utf8", cwd: repoDir },
      );
      if (r.status !== 0) return [];
      const rows = JSON.parse(r.stdout.trim() || "[]") as Array<{
        number: number;
        title: string;
        body: string;
        state: string;
        labels: Array<{ name: string }>;
        createdAt: string;
        milestone: { title: string } | null;
      }>;
      return rows.map((row) => ({
        number: row.number,
        title: row.title ?? "",
        body: row.body ?? "",
        state: row.state === "CLOSED" || row.state === "closed" ? "CLOSED" : "OPEN",
        labels: (row.labels ?? []).map((l) => l.name),
        createdAt: row.createdAt ?? "",
        milestone: row.milestone?.title ?? null,
      }));
    },
    async createIssue(title, body, labels, options) {
      const args = ["issue", "create", "--title", title, "--body", body];
      for (const label of labels) args.push("--label", label);
      if (options?.milestone) {
        args.push("--milestone", options.milestone);
      }
      const r = spawnSync("gh", args, { encoding: "utf8", cwd: repoDir });
      if (r.status !== 0) {
        throw new Error(`gh issue create failed: ${r.stderr?.trim() ?? "unknown error"}`);
      }
      return (r.stdout ?? "").trim();
    },
    async closeIssue(number, comment) {
      const r = spawnSync(
        "gh",
        ["issue", "close", String(number), "--comment", comment],
        { encoding: "utf8", cwd: repoDir },
      );
      if (r.status !== 0) {
        throw new Error(`gh issue close failed: ${r.stderr?.trim() ?? "unknown error"}`);
      }
    },
    async ghAuthCheck() {
      const r = spawnSync("gh", ["auth", "status"], { encoding: "utf8", cwd: repoDir });
      return r.status === 0;
    },
    now: () => Date.now(),
    withLock: (domain, fn) => withLock(domain, fn),
    log: (msg) => console.warn(msg),
  };
}

export function engineClassLiveSiblingTitle(evidenceKey: string): string {
  const short = evidenceKey.length > 80 ? evidenceKey.slice(0, 77) + "…" : evidenceKey;
  return `[pipeline-engine] engine-class live sibling: ${short}`;
}

export function engineClassLiveSiblingBody(input: {
  recoveredIssue: number;
  evidenceKey: string;
  milestone?: string | null;
}): string {
  const lines = [
    ENGINE_CLASS_LIVE_SIBLING_MARKER,
    "",
    `## Engine-class live sibling`,
    "",
    `Filed after first recovered engine-class / engine-scratch fingerprint.`,
    "",
    `**Evidence key**: \`${input.evidenceKey}\``,
    `**Recovered item**: #${input.recoveredIssue}`,
    `Depends on: #${input.recoveredIssue}`,
    "",
    `The recovered (victim) item continues toward ready-to-deploy without engine-source`,
    `patches in its PR. Land the durable engine fix on this sibling.`,
    "",
    input.milestone
      ? `**Train milestone**: ${input.milestone}`
      : `**Train milestone**: (none in scope — not guessed)`,
    "",
    `Labels: bug + ${ENGINE_CLASS_MARKER_LABEL} + pipeline:ready (not backlog; #1021 exception to #538).`,
  ];
  return lines.join("\n");
}

function hasMarker(body: string): boolean {
  return body.includes(ENGINE_CLASS_LIVE_SIBLING_MARKER);
}

function evidenceKeyInBody(body: string, key: string): boolean {
  return body.includes(key) || body.includes(`\`${key}\``);
}

/**
 * File at most one live sibling for the evidence key. Never triggers for
 * human-decision or product dirt (caller responsibility). Non-fatal total.
 */
export async function autoFileEngineClassLiveSibling(
  opts: EngineClassLiveSiblingOpts,
  deps: EngineClassLiveSiblingDeps,
): Promise<{ filed: boolean; issueNumber?: number; skippedReason?: string }> {
  try {
    if (!(await deps.ghAuthCheck())) {
      return { filed: false, skippedReason: "gh auth unavailable" };
    }
    // Never file with backlog-only policy labels on this path.
    const labels = [...ENGINE_CLASS_LIVE_SIBLING_LABELS];
    if (labels.includes(BACKLOG_LABEL as typeof labels[number])) {
      return { filed: false, skippedReason: "internal: backlog label leaked" };
    }

    const title = engineClassLiveSiblingTitle(opts.evidenceKey);
    const body = engineClassLiveSiblingBody({
      recoveredIssue: opts.recoveredIssue,
      evidenceKey: opts.evidenceKey,
      milestone: opts.milestone,
    });

    return await deps.withLock(opts.domain, async () => {
      const all = await deps.listOpenImproveIssues();
      const now = deps.now();
      const windowMs = opts.windowHours * 3600_000;
      const openMarked = all.filter(
        (i) => i.state === "OPEN" && hasMarker(i.body),
      );
      // Dedup by evidence key or exact title.
      const existing = openMarked.find(
        (i) =>
          i.title === title ||
          evidenceKeyInBody(i.body, opts.evidenceKey),
      );
      if (existing) {
        return { filed: false, issueNumber: existing.number, skippedReason: "duplicate evidence_key" };
      }
      // Rate cap: open marked siblings in window.
      const inWindow = openMarked.filter((i) => {
        const t = Date.parse(i.createdAt);
        return Number.isFinite(t) && now - t <= windowMs;
      });
      if (inWindow.length >= opts.maxPerWindow) {
        return { filed: false, skippedReason: "rate-cap" };
      }

      const milestone =
        opts.milestone && opts.milestone.trim() !== ""
          ? opts.milestone.trim()
          : undefined;
      const url = await deps.createIssue(title, body, labels, {
        milestone,
      });
      const m = url.match(/\/issues\/(\d+)/);
      const issueNumber = m ? Number(m[1]) : undefined;

      // Post-create reconcile: close title duplicates down to lowest number.
      try {
        const after = await deps.listOpenImproveIssues();
        const dups = after
          .filter((i) => i.state === "OPEN" && (i.title === title || evidenceKeyInBody(i.body, opts.evidenceKey)))
          .sort((a, b) => a.number - b.number);
        for (const d of dups.slice(1)) {
          await deps.closeIssue(
            d.number,
            `Cross-host reconcile: keeping lowest-numbered engine-class live sibling #${dups[0]!.number}.`,
          );
        }
      } catch (err) {
        deps.log(
          `[engine-class-live-sibling] post-create reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      deps.log(
        `[engine-class-live-sibling] filed sibling for #${opts.recoveredIssue} evidence=${opts.evidenceKey}` +
          (issueNumber != null ? ` → #${issueNumber}` : ` → ${url}`),
      );
      return { filed: true, issueNumber };
    });
  } catch (err) {
    deps.log(
      `[engine-class-live-sibling] non-fatal failure: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { filed: false, skippedReason: err instanceof Error ? err.message : String(err) };
  }
}

/** Module-level train milestone context for recovery sibling filing (#1021). */
let trainMilestoneContext: string | null = null;

export function setTrainMilestoneContext(milestone: string | null | undefined): void {
  trainMilestoneContext =
    milestone && String(milestone).trim() !== "" ? String(milestone).trim() : null;
}

export function getTrainMilestoneContext(): string | null {
  return trainMilestoneContext;
}
