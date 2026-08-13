// Porcelain dirt-site shared-classifier drift guard (#1020).
//
// Machine-readable inventory of production modules that decide whether worktree
// porcelain warrants a block/park (setBlocked or an equivalent dirt-trust refusal
// that feeds setBlocked). Every such site MUST use classifyWorktreeDirt /
// productDirtyPaths / ENGINE_NON_PRODUCT_SCRATCH_GLOBS (or an explicit exception
// disposition). The unit drift-guard fails when a new site appears without a row.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Closed dispositions for porcelain dirt sites. */
export const PORCELAIN_DIRT_DISPOSITIONS = [
  /** Site classifies via classifyWorktreeDirt / productDirtyPaths / ENGINE set. */
  "uses-shared-classifier",
  /** Module touches porcelain but is not a dirt→block gate (fold, salvage, recovery). */
  "not-porcelain-dirt-gate",
  /** Documented exception: must not invent a parallel scratch list without review. */
  "explicit-exception",
] as const;

export type PorcelainDirtDisposition = (typeof PORCELAIN_DIRT_DISPOSITIONS)[number];

export function isPorcelainDirtDisposition(
  value: unknown,
): value is PorcelainDirtDisposition {
  return (
    typeof value === "string" &&
    (PORCELAIN_DIRT_DISPOSITIONS as readonly string[]).includes(value)
  );
}

export interface PorcelainDirtSiteEntry {
  /** Stable id: module basename key (e.g. stages.pre-merge-openspec-archive). */
  site_id: string;
  /** Repo-relative module path under core/ (e.g. scripts/stages/foo.ts). */
  module: string;
  disposition: PorcelainDirtDisposition;
  /** How scratch is classified when disposition is uses-shared-classifier. */
  classifier?: "classifyWorktreeDirt" | "productDirtyPaths" | "classifyPreArchiveDirt" | "classifyPorcelainForScratchRecover";
  notes: string;
}

/**
 * Seeded inventory of production porcelain dirt / related modules (#1020).
 * Discovery compares production modules that match porcelain+dirt patterns
 * against this list; missing rows fail CI.
 */
export const PORCELAIN_DIRT_SITES: readonly PorcelainDirtSiteEntry[] = [
  {
    site_id: "stages.pre-merge-openspec-archive",
    module: "scripts/stages/pre-merge-openspec-archive.ts",
    disposition: "uses-shared-classifier",
    classifier: "classifyPreArchiveDirt",
    notes:
      "Pre-archive cleanliness + post-archive staged-scratch unstage; classifyPreArchiveDirt → classifyWorktreeDirt; residual engine scratch blocks as harness-failure (#1017 / #1020)",
  },
  {
    site_id: "testgate",
    module: "scripts/testgate.ts",
    disposition: "uses-shared-classifier",
    classifier: "productDirtyPaths",
    notes:
      "Dirty-trust pre/post test run; productDirtyPaths; scratch-only does not mint dirtyWorktree block (#873 / #1013)",
  },
  {
    site_id: "stages.format-gate",
    module: "scripts/stages/format-gate.ts",
    disposition: "uses-shared-classifier",
    classifier: "classifyWorktreeDirt",
    notes:
      "Format auto-fix dirty trust + product-only commit; classifyWorktreeDirt / productDirtyPaths (#873)",
  },
  {
    site_id: "salvage-harness-work",
    module: "scripts/salvage-harness-work.ts",
    disposition: "not-porcelain-dirt-gate",
    notes:
      "Salvage path selection + marker strip; does not setBlocked on porcelain; product-only salvage uses onlyPaths from classifier at call sites (#522 / #873)",
  },
  {
    site_id: "pipeline.unlink_engine_scratch",
    module: "scripts/pipeline.ts",
    disposition: "uses-shared-classifier",
    classifier: "classifyPorcelainForScratchRecover",
    notes:
      "Recovery action unlink_engine_scratch; XY-aware untracked scratch only; never setBlocked (#1020 / #1028)",
  },
  {
    site_id: "worktree-dirt",
    module: "scripts/worktree-dirt.ts",
    disposition: "uses-shared-classifier",
    classifier: "classifyWorktreeDirt",
    notes: "Single source of ENGINE_NON_PRODUCT_SCRATCH_GLOBS / classifyWorktreeDirt",
  },
  {
    site_id: "stages.pre-merge-autofix",
    module: "scripts/stages/pre-merge-autofix.ts",
    disposition: "explicit-exception",
    notes:
      "Pre-fix cleanliness refuses any porcelain before git reset --hard (destructive rollback safety #235). Does not setBlocked; returns error. Not a scratch-classification gate — any residual dirt is unsafe for hard reset.",
  },
  {
    site_id: "lockfile-side-effects",
    module: "scripts/lockfile-side-effects.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Folds lockfiles from porcelain; never parks on scratch",
  },
  {
    site_id: "build-side-effects",
    module: "scripts/build-side-effects.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Folds build artifacts; local porcelain parse for fold, not setBlocked dirt gate",
  },
  {
    site_id: "docs-freshness",
    module: "scripts/docs-freshness.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Docs regenerate dirt detection; not engine-scratch setBlocked path",
  },
  {
    site_id: "verify-harness-commits",
    module: "scripts/verify-harness-commits.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Commit-range verification; not porcelain→needs-human dirt gate",
  },
  {
    site_id: "loop.repair-pipeline-item",
    module: "scripts/loop/repair-pipeline-item.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Repair inspects porcelain for dirty refuse; not a scratch-classification dirt gate",
  },
  {
    site_id: "openspec-consistency",
    module: "scripts/openspec-consistency.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Spec repair pre/post porcelain; product openspec paths, not engine-scratch setBlocked",
  },
  {
    site_id: "release-docs-refresh",
    module: "scripts/release-docs-refresh.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Release docs path dirt detection; not engine-scratch gate",
  },
  {
    site_id: "stages.backfill",
    module: "scripts/stages/backfill.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Scoped openspec/ preflight; not shared engine-scratch dirt gate",
  },
  {
    site_id: "stages.doctor",
    module: "scripts/stages/doctor.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Doctor preflight cleanliness on protected branch; advisory, not item setBlocked dirt gate",
  },
  {
    site_id: "stages.eval",
    module: "scripts/stages/eval.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Eval-gate salvage cleanliness; product salvage, not engine-scratch classifier site",
  },
  {
    site_id: "stages.harness-smoke",
    module: "scripts/stages/harness-smoke.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Harness smoke mutation detection; not production item dirt→setBlocked gate",
  },
  {
    site_id: "stages.intake",
    module: "scripts/stages/intake.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "ROADMAP.md scoped preflight; not engine-scratch gate",
  },
  {
    site_id: "stages.merge-queue",
    module: "scripts/stages/merge-queue.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Managed-root dirty refuse before deterministic rebase; not scratch classifier site",
  },
  {
    site_id: "stages.planning",
    module: "scripts/stages/planning.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Scoped openspec config / salvage; dirt gates for implement use testgate/format-gate classifiers",
  },
  {
    site_id: "stages.release",
    module: "scripts/stages/release.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Release-managed path cleanliness; not engine-scratch gate",
  },
  {
    site_id: "stages.sweep",
    module: "scripts/stages/sweep.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "ROADMAP.md scoped preflight; not engine-scratch gate",
  },
  {
    site_id: "stages.visual",
    module: "scripts/stages/visual.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Visual-gate salvage cleanliness; product salvage, not engine-scratch classifier site",
  },
  {
    site_id: "worktree",
    module: "scripts/worktree.ts",
    disposition: "not-porcelain-dirt-gate",
    notes: "Worktree list porcelain + dirty remove refuse; not item engine-scratch dirt gate",
  },
];

const SITE_BY_MODULE: ReadonlyMap<string, PorcelainDirtSiteEntry> = new Map(
  PORCELAIN_DIRT_SITES.map((s) => [s.module, s]),
);

export function porcelainDirtSiteForModule(
  module: string,
): PorcelainDirtSiteEntry | undefined {
  return SITE_BY_MODULE.get(module);
}

/** Patterns that mark a production file as a porcelain dirt-related site. */
const PORCELAIN_SIGNAL =
  /status",\s*"--porcelain|status',\s*'--porcelain|gitStatusPorcelain|parsePorcelainPaths|classifyWorktreeDirt|productDirtyPaths|classifyPreArchiveDirt|classifyPorcelainForScratchRecover|ENGINE_NON_PRODUCT_SCRATCH/;

/** Modules that are pure helpers / inventory and always inventoried via worktree-dirt or this file. */
const SELF_MODULES = new Set([
  "scripts/porcelain-dirt-sites.ts",
  "scripts/worktree-dirt.ts",
]);

function walkProductionTs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir)) {
      if (ent === "node_modules" || ent === "evals" || ent === "prompts" || ent === "frg-packs") {
        continue;
      }
      const p = join(dir, ent);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (ent.endsWith(".ts") && !ent.endsWith(".test.ts") && !ent.endsWith(".d.ts") && !ent.endsWith(".inventory.ts")) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out.sort();
}

export interface DiscoveredPorcelainDirtModule {
  module: string;
  site_id: string;
  absPath: string;
}

function moduleToSiteId(module: string): string {
  return module
    .replace(/^scripts\//, "")
    .replace(/\.ts$/, "")
    .replace(/\//g, ".");
}

/**
 * Discover production modules under core/scripts that reference porcelain dirt
 * classification or `git status --porcelain` (excluding pure inventory self).
 */
export function discoverPorcelainDirtModules(
  scriptsRoot?: string,
): DiscoveredPorcelainDirtModule[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = scriptsRoot ?? here;
  const coreRoot = join(root, "..");
  const files = walkProductionTs(root);
  const found: DiscoveredPorcelainDirtModule[] = [];

  for (const abs of files) {
    const module = relative(coreRoot, abs).replace(/\\/g, "/");
    if (module === "scripts/porcelain-dirt-sites.ts") continue;
    const src = readFileSync(abs, "utf8");
    if (!PORCELAIN_SIGNAL.test(src)) continue;
    found.push({
      module,
      site_id: moduleToSiteId(module),
      absPath: abs,
    });
  }
  return found;
}

export interface PorcelainDirtInventoryDiff {
  missing: DiscoveredPorcelainDirtModule[];
  /** Inventoried modules no longer matching porcelain signal (orphan rows). */
  orphans: PorcelainDirtSiteEntry[];
  /** uses-shared-classifier sites that do not reference the shared helper symbols. */
  undeclaredBypass: PorcelainDirtSiteEntry[];
  ok: boolean;
}

const SHARED_CLASSIFIER_SYMBOL =
  /classifyWorktreeDirt|productDirtyPaths|classifyPreArchiveDirt|classifyPorcelainForScratchRecover|ENGINE_NON_PRODUCT_SCRATCH|isNonProductScratchPath/;

/**
 * Diff discovery against inventory. Missing production modules fail.
 * uses-shared-classifier rows must still reference a shared classifier symbol.
 */
export function diffPorcelainDirtInventory(
  discovered?: DiscoveredPorcelainDirtModule[],
  scriptsRoot?: string,
): PorcelainDirtInventoryDiff {
  const found = discovered ?? discoverPorcelainDirtModules(scriptsRoot);
  const invByModule = new Map(PORCELAIN_DIRT_SITES.map((s) => [s.module, s]));
  const foundModules = new Set(found.map((f) => f.module));

  const missing = found.filter((f) => !invByModule.has(f.module));
  const orphans = PORCELAIN_DIRT_SITES.filter(
    (s) => !SELF_MODULES.has(s.module) && !foundModules.has(s.module),
  );

  const undeclaredBypass: PorcelainDirtSiteEntry[] = [];
  const here = dirname(fileURLToPath(import.meta.url));
  const root = scriptsRoot ?? here;
  const coreRoot = join(root, "..");

  for (const site of PORCELAIN_DIRT_SITES) {
    if (site.disposition !== "uses-shared-classifier") continue;
    if (site.module === "scripts/worktree-dirt.ts") continue; // is the source
    const abs = join(coreRoot, site.module);
    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      undeclaredBypass.push(site);
      continue;
    }
    if (!SHARED_CLASSIFIER_SYMBOL.test(src)) {
      undeclaredBypass.push(site);
    }
  }

  return {
    missing,
    orphans,
    undeclaredBypass,
    ok: missing.length === 0 && orphans.length === 0 && undeclaredBypass.length === 0,
  };
}

/** Every inventory disposition is closed. */
export function assertPorcelainDirtDispositionsClosed(): void {
  for (const site of PORCELAIN_DIRT_SITES) {
    if (!isPorcelainDirtDisposition(site.disposition)) {
      throw new Error(
        `porcelain dirt site ${site.site_id} has invalid disposition ${String(site.disposition)}`,
      );
    }
  }
}
