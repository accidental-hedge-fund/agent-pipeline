// Per-escalation-site safety dispositions (#760).
//
// Machine-readable inventory of production blocker / park emitters with a closed
// disposition that gates automatic retry wrappers. Orthogonal to
// pipeline/stage-diagnostic@1 reason codes (disposition = may this site retry;
// reason = what failed).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ESCALATION_INVENTORY_JSON } from "./escalation-dispositions.inventory.ts";
import type { BlockerKind } from "./types.ts";

export const ESCALATION_SITE_DISPOSITIONS = [
  "deliberately-fail-closed",
  "transient-retryable",
  "reconcile-owned",
] as const;

/** RecoverySupervisor migrated outcome for issue-stage escalation sites (#1328). */
export const MIGRATED_OUTCOMES = [
  "re-entry",
  "Cooling",
  "external-condition wait",
  "typed request",
  "compatibility park projection",
  "authenticated cancellation",
] as const;

export type MigratedOutcome = (typeof MIGRATED_OUTCOMES)[number];

export function isMigratedOutcome(value: unknown): value is MigratedOutcome {
  return typeof value === "string" && (MIGRATED_OUTCOMES as readonly string[]).includes(value);
}

export type EscalationSiteDisposition = (typeof ESCALATION_SITE_DISPOSITIONS)[number];

export function isEscalationSiteDisposition(value: unknown): value is EscalationSiteDisposition {
  return (
    typeof value === "string" &&
    (ESCALATION_SITE_DISPOSITIONS as readonly string[]).includes(value)
  );
}

export interface EscalationSiteEntry {
  site_id: string;
  module: string;
  line: number;
  occurrence: number;
  match: string;
  disposition: EscalationSiteDisposition;
  blocker_kind: BlockerKind | null;
  canonical_reason: string;
  notes: string;
  emitter: "setBlocked";
  /** Required on issue-advancement stage rows (#1328). */
  migrated_outcome?: MigratedOutcome;
}

export interface AuthorityEmitterEntry {
  site_id: string;
  module: string;
  match: string;
  reporting_only: boolean;
  requires_authority_predicate: boolean;
  notes: string;
}

/** Human-question handoff integrity / wait sites (#647). */
export interface HandoffEscalationSiteEntry {
  site_id: string;
  module: string;
  match: string;
  disposition: EscalationSiteDisposition;
  notes: string;
}

/** Governed override integrity / expiry sites (#693). */
export interface OverrideGovernanceEscalationSiteEntry {
  site_id: string;
  module: string;
  match: string;
  disposition: EscalationSiteDisposition;
  notes: string;
}

export interface EscalationInventory {
  schema: string;
  issue: number;
  sites: readonly EscalationSiteEntry[];
  authority_emitters: readonly AuthorityEmitterEntry[];
  /** Optional #647 handoff integrity inventory; absent on pre-#647 inventories. */
  handoff_sites?: readonly HandoffEscalationSiteEntry[];
  /** Optional #693 override-governance integrity inventory. */
  override_governance_sites?: readonly OverrideGovernanceEscalationSiteEntry[];
}

/** Closed inventory loaded from the seeded module (and re-checked by drift guards). */
export const ESCALATION_INVENTORY: EscalationInventory =
  ESCALATION_INVENTORY_JSON as unknown as EscalationInventory;

const DISPOSITION_BY_SITE_ID: ReadonlyMap<string, EscalationSiteEntry> = new Map(
  ESCALATION_INVENTORY.sites.map((s) => [s.site_id, s]),
);

/** Lookup by stable site id. Unknown sites default fail-closed for wrapper eligibility. */
export function getEscalationSite(siteId: string): EscalationSiteEntry | undefined {
  return DISPOSITION_BY_SITE_ID.get(siteId);
}

/**
 * Wrapper eligibility. Unknown / missing inventory rows are deliberately-fail-closed
 * so new emitters never inherit open retry by accident.
 */
export function dispositionForSiteId(siteId: string): EscalationSiteDisposition {
  return getEscalationSite(siteId)?.disposition ?? "deliberately-fail-closed";
}

export function isTransientRetryableSite(siteId: string): boolean {
  return dispositionForSiteId(siteId) === "transient-retryable";
}

export function isDeliberatelyFailClosedSite(siteId: string): boolean {
  return dispositionForSiteId(siteId) === "deliberately-fail-closed";
}

export function isReconcileOwnedSite(siteId: string): boolean {
  return dispositionForSiteId(siteId) === "reconcile-owned";
}

/** Inventory key used by discovery + drift guards (stable across line shifts). */
export function escalationSiteKey(module: string, kind: string, occurrence: number): string {
  const normalized = module.replace(/^scripts\//, "").replace(/\.ts$/, "").replace(/\//g, ".");
  return `${normalized}:${kind}#${occurrence}`;
}

const BLOCKER_KIND_PATTERN =
  /"(needs-human|merge-conflict|worktree-missing|worktree-creation-failed|worktree-capacity|pr-creation-failed|no-pull-request|plan-gen-failed|push-failed|head-drift|worktree-setup-failed|test-gate-exhausted|no-commits|openspec-invalid|openspec-stale-delta|eval-gate-misconfigured|eval-gate-failed|visual-gate-misconfigured|visual-gate-failed|shipcheck-failed|build-failed|design-gate-failed|pre-code-attestation-failed|ci-exhausted|review-findings|harness-failure|human-decision-required|review-independent-quorum-unmet|review-no-usable-reviewers|review-prompt-too-large)"/;

export interface DiscoveredEscalationSite {
  module: string;
  line: number;
  occurrence: number;
  kind: string;
  match: string;
  site_id: string;
  callSnippet: string;
}

function walkProductionTs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir)) {
      if (ent === "node_modules" || ent === "evals") continue;
      const p = join(dir, ent);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (ent.endsWith(".ts") && !ent.endsWith(".test.ts") && !ent.endsWith(".d.ts")) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out.sort();
}

function extractCall(src: string, openParenIdx: number): { end: number; text: string } {
  let depth = 0;
  let i = openParenIdx;
  let inStr = false;
  let strChar = "";
  let inTpl = false;
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      if (ch === strChar && src[i - 1] !== "\\") inStr = false;
    } else if (inTpl) {
      if (ch === "`" && src[i - 1] !== "\\") inTpl = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
    } else if (ch === "`") {
      inTpl = true;
    } else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  return { end: i + 1, text: src.slice(openParenIdx, i + 1) };
}

/**
 * Discover production `setBlocked` / `setBlockedFn` call sites under `core/scripts`.
 * Skips the function definition itself. Pure filesystem scan used by drift guards.
 */
export function discoverProductionSetBlockedSites(scriptsRoot?: string): DiscoveredEscalationSite[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = scriptsRoot ?? here;
  const coreRoot = join(root, "..");
  const files = walkProductionTs(root);
  const sites: DiscoveredEscalationSite[] = [];
  const occBy: Record<string, number> = {};

  for (const abs of files) {
    const src = readFileSync(abs, "utf8");
    const module = relative(coreRoot, abs).replace(/\\/g, "/");
    const re = /\bsetBlocked(?:Fn)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(Math.max(0, m.index - 60), m.index);
      if (
        /function\s+$/.test(before) ||
        /export\s+async\s+function\s+$/.test(before) ||
        /export\s+function\s+$/.test(before)
      ) {
        continue;
      }
      const openParen = m.index + m[0].length - 1;
      const { text: parenBody } = extractCall(src, openParen);
      const callText = src.slice(m.index, openParen) + parenBody;
      const line = src.slice(0, m.index).split("\n").length;
      const kindM = callText.match(BLOCKER_KIND_PATTERN);
      const kind = kindM?.[1] ?? "dynamic";
      const reasonM = callText.match(/`([^`]{8,100})/) || callText.match(/"([^"]{8,100})/);
      const match = (reasonM ? reasonM[1] : kind).slice(0, 80).replace(/\s+/g, " ");
      const occKey = `${module}::${kind}`;
      const occurrence = occBy[occKey] ?? 0;
      occBy[occKey] = occurrence + 1;
      sites.push({
        module,
        line,
        occurrence,
        kind,
        match,
        site_id: escalationSiteKey(module, kind, occurrence),
        callSnippet: callText.replace(/\s+/g, " ").slice(0, 200),
      });
    }
  }
  return sites;
}

/** Diff discovery against inventory: missing inventory rows and orphan inventory rows. */
export function diffEscalationInventory(discovered?: DiscoveredEscalationSite[]): {
  missing: DiscoveredEscalationSite[];
  orphans: EscalationSiteEntry[];
  ok: boolean;
} {
  const found = discovered ?? discoverProductionSetBlockedSites();
  const invById = new Map(ESCALATION_INVENTORY.sites.map((s) => [s.site_id, s]));
  const foundIds = new Set(found.map((s) => s.site_id));
  const missing = found.filter((s) => !invById.has(s.site_id));
  const orphans = ESCALATION_INVENTORY.sites.filter((s) => !foundIds.has(s.site_id));
  return { missing, orphans, ok: missing.length === 0 && orphans.length === 0 };
}

/** Closed disposition enum is total over inventory rows. */
export function assertInventoryDispositionsClosed(): void {
  for (const site of ESCALATION_INVENTORY.sites) {
    if (!isEscalationSiteDisposition(site.disposition)) {
      throw new Error(`inventory site ${site.site_id} has invalid disposition ${String(site.disposition)}`);
    }
  }
}

/** Named census classes the 2026-07-31 audit required in the starting inventory. */
export const AUDIT_CENSUS_REQUIRED_PATTERNS: readonly {
  id: string;
  test: (s: EscalationSiteEntry) => boolean;
}[] = [
  {
    id: "getGhActor-attestation",
    test: (s) =>
      s.disposition === "deliberately-fail-closed" &&
      (s.canonical_reason === "environment-auth" ||
        /actor|auth|provenance|trusted/i.test(s.match + s.notes)),
  },
  {
    id: "push-sites",
    test: (s) => s.blocker_kind === "push-failed",
  },
  {
    id: "worktree-missing",
    test: (s) => s.blocker_kind === "worktree-missing",
  },
  {
    id: "label-or-gh-infra",
    test: (s) =>
      s.disposition === "transient-retryable" &&
      (s.canonical_reason === "transient-infra" || /label/i.test(s.match + s.notes)),
  },
  {
    id: "format-or-pipeline-owned",
    test: (s) =>
      /format|commit message|prescribed/i.test(s.match + s.notes) ||
      s.site_id.includes("fix:needs-human"),
  },
  {
    id: "review-policy-surfaces",
    test: (s) =>
      s.module.includes("review-routing") ||
      s.blocker_kind === "review-findings" ||
      s.canonical_reason === "review-findings",
  },
];

const ISSUE_STAGE_MODULE_SKIP =
  /\/(merge|ship|train|queue|grill|papercut|doctor|intake|triage|decompose|release|engine-promote|sweep|auto_merge)/;

export function isIssueStageInventoryModule(module: string): boolean {
  if (module.startsWith("scripts/stages/")) {
    return !ISSUE_STAGE_MODULE_SKIP.test(module);
  }
  return (
    module === "scripts/pipeline-run.ts" ||
    module === "scripts/openspec-consistency.ts" ||
    module === "scripts/issue-context-snapshot.ts" ||
    module === "scripts/porcelain-dirt-sites.ts"
  );
}

const MECHANICAL_BLOCKER_KINDS = new Set([
  "worktree-missing",
  "worktree-creation-failed",
  "worktree-capacity",
  "worktree-setup-failed",
  "harness-failure",
  "push-failed",
]);

export function deriveMigratedOutcome(site: Pick<EscalationSiteEntry, "blocker_kind" | "canonical_reason">): MigratedOutcome {
  if (site.blocker_kind === "human-decision-required") return "typed request";
  if (site.blocker_kind === "worktree-capacity") return "external-condition wait";
  if (site.canonical_reason === "environment-auth") return "external-condition wait";
  if (site.canonical_reason === "harness-background-wait") return "external-condition wait";
  if (site.blocker_kind === "head-drift") return "re-entry";
  if (site.blocker_kind && MECHANICAL_BLOCKER_KINDS.has(site.blocker_kind)) return "Cooling";
  if (site.canonical_reason === "transient-infra") return "Cooling";
  return "compatibility park projection";
}

export function migratedOutcomeForSite(site: EscalationSiteEntry): MigratedOutcome | null {
  if (site.migrated_outcome) return site.migrated_outcome;
  if (!isIssueStageInventoryModule(site.module)) return null;
  return deriveMigratedOutcome(site);
}

/** Issue-stage rows must declare a migrated outcome. Mechanical sites must not be typed request. */
export function assertIssueStageMigratedOutcomes(
  inventory: EscalationInventory = ESCALATION_INVENTORY,
): void {
  const missing: string[] = [];
  const mechanicalAuthority: string[] = [];
  for (const site of inventory.sites) {
    if (!isIssueStageInventoryModule(site.module)) continue;
    const outcome = site.migrated_outcome;
    if (!isMigratedOutcome(outcome)) {
      missing.push(site.site_id);
      continue;
    }
    if (
      site.blocker_kind &&
      MECHANICAL_BLOCKER_KINDS.has(site.blocker_kind) &&
      outcome === "typed request"
    ) {
      mechanicalAuthority.push(site.site_id);
    }
  }
  if (missing.length > 0) {
    throw new Error(`issue-stage inventory missing migrated_outcome: ${missing.join("; ")}`);
  }
  if (mechanicalAuthority.length > 0) {
    throw new Error(
      `mechanical issue-stage sites must not migrate to Authority Request: ${mechanicalAuthority.join("; ")}`,
    );
  }
}
