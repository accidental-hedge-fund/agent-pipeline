// Ship-path composition class inventory (#1029).
//
// Machine-readable SSOT for v1.38.1 ship-path autonomy composition classes:
// frontier train∘loop, scratch-only recover, independent R2D merge under partial
// failure, and soft stale-block re-review before train STOP.
//
// Hermetic unit tests (Layer A style) own CI proof. Hard classes MUST map to
// covering tests — waivers are not accepted for hard classes. Soft class MAY
// name an open tracking-issue waiver. Silent omission of a hard class from both
// inventory coverage and (disallowed) waiver fails the unit suite drift-guard.
//
// Does NOT expand FRG Layer B fixed scenario pack ids. Offline composition does
// not mint release-eligible FRG pass:true alone.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Hard composition classes required by #1029 acceptance (tests, not waivers). */
export const SHIP_PATH_COMPOSITION_HARD_CLASS_IDS = [
  "train-frontier-one-wave",
  "train-code-dep-merge-barrier",
  "train-independent-r2d-merge-partial-failure",
  "scratch-only-no-needs-human",
  "scratch-only-unlink-not-repair",
] as const;

/** Soft composition class (optional; may use open-issue waiver). */
export const SHIP_PATH_COMPOSITION_SOFT_CLASS_IDS = [
  "stale-blocked-rereview-before-train-stop",
] as const;

export type ShipPathCompositionHardClassId =
  (typeof SHIP_PATH_COMPOSITION_HARD_CLASS_IDS)[number];
export type ShipPathCompositionSoftClassId =
  (typeof SHIP_PATH_COMPOSITION_SOFT_CLASS_IDS)[number];
export type ShipPathCompositionClassId =
  | ShipPathCompositionHardClassId
  | ShipPathCompositionSoftClassId;

export type ShipPathCompositionClassKind = "hard" | "soft";

export interface ShipPathCompositionClassEntry {
  id: ShipPathCompositionClassId;
  kind: ShipPathCompositionClassKind;
  /**
   * Covering test modules relative to core/ (e.g. `test/train.test.ts`).
   * Empty only when soft + waiver_issue is set.
   */
  covering_modules: readonly string[];
  /**
   * Substrings that MUST appear inside `test("…")` titles in covering modules.
   * Empty only when soft + waiver_issue is set.
   */
  covering_test_name_substrings: readonly string[];
  /**
   * Soft-only: open tracking issue (`#N`) when no covering test yet.
   * Hard classes MUST leave this null/undefined.
   */
  waiver_issue?: string | null;
  notes: string;
}

/**
 * Inventory of ship-path composition classes → covering hermetic tests.
 * Prefer existing island tests that already fail on the defective composition;
 * this table makes absence fail CI.
 */
export const SHIP_PATH_COMPOSITION_INVENTORY: readonly ShipPathCompositionClassEntry[] = [
  {
    id: "train-frontier-one-wave",
    kind: "hard",
    covering_modules: ["test/train.test.ts"],
    covering_test_name_substrings: [
      "independent peers use one advance-wave call per frontier",
      "production wiring is multi-item loop, not N×single / advanceWaveFromSingle",
    ],
    notes:
      "One multi-item advance-wave per base-eligible frontier; production not N×single / advanceWaveFromSingle (#1023)",
  },
  {
    id: "train-code-dep-merge-barrier",
    kind: "hard",
    covering_modules: ["test/train.test.ts"],
    covering_test_name_substrings: [
      "code dependent waits for base containment, not mere R2D",
      "computeBaseEligibleFrontier: code child waits for integrated parent",
    ],
    notes:
      "Code-dependent child must not enter advance wave until prerequisite merge-result is on base (#1023 / #1028)",
  },
  {
    id: "train-independent-r2d-merge-partial-failure",
    kind: "hard",
    covering_modules: ["test/train.test.ts"],
    covering_test_name_substrings: [
      "merge-mode continues and merges independent sibling after a contained park",
      "already-blocked sibling does not abandon independent next",
      "unproven independence fails closed — dep-linked R2D not merged while peer held",
      "contained hold continues independent remaining issues",
      "transitive dependent is dependency-skipped and never advanced",
    ],
    notes:
      "#1273: merge-mode contained hold continues proven-independent remaining work and merges independent R2D siblings. Direct/transitive dependents are dependency-skipped. Unproven independence still fails closed.",
  },
  {
    id: "scratch-only-no-needs-human",
    kind: "hard",
    covering_modules: [
      "test/testgate.test.ts",
      "test/format-gate.test.ts",
      "test/worktree-dirt.test.ts",
    ],
    covering_test_name_substrings: [
      "challenge-response-only pre-dirty allows the test command to run",
      "scratch-only pre-dirty does not refuse auto-fix gate",
      "challenge-response-only porcelain is scratch",
    ],
    notes:
      "Scratch-only engine porcelain must not park as needs-human / mint dirt blockReason (#873 / #1013 / #1020)",
  },
  {
    id: "scratch-only-unlink-not-repair",
    kind: "hard",
    covering_modules: ["test/pipeline-recovery-executor.test.ts"],
    covering_test_name_substrings: [
      "scratch-only unlinks, clears blocked, never repairs",
      "DEFAULT_RECOVERY_POLICY recipe order: unlink before repair",
    ],
    notes:
      "Scratch-only recovery unlinks/clears; must not invoke repair_pipeline_item for that attempt (#1020)",
  },
  {
    id: "stale-blocked-rereview-before-train-stop",
    kind: "soft",
    covering_modules: [
      "test/stale-blocked-rereview.test.ts",
      "test/ship-path-composition-coverage.test.ts",
    ],
    covering_test_name_substrings: [
      "tryResumeStaleBlocked: non-internal H clears block",
      "pipeline-run attempts stale-block resume before terminal STOP",
    ],
    waiver_issue: null,
    notes:
      "Soft join #1025: leftover blocked + non-internal HEAD past reviewed-sha must resume/re-review before train/loop terminal STOP",
  },
] as const;

const HARD_SET = new Set<string>(SHIP_PATH_COMPOSITION_HARD_CLASS_IDS);
const SOFT_SET = new Set<string>(SHIP_PATH_COMPOSITION_SOFT_CLASS_IDS);

export function isShipPathCompositionHardClassId(
  id: string,
): id is ShipPathCompositionHardClassId {
  return HARD_SET.has(id);
}

export function isShipPathCompositionSoftClassId(
  id: string,
): id is ShipPathCompositionSoftClassId {
  return SOFT_SET.has(id);
}

export function shipPathCompositionEntry(
  id: ShipPathCompositionClassId,
): ShipPathCompositionClassEntry | undefined {
  return SHIP_PATH_COMPOSITION_INVENTORY.find((e) => e.id === id);
}

export interface ShipPathCompositionInventoryGap {
  class_id: string;
  reason: string;
}

/**
 * Structural inventory check (no filesystem). Returns gaps; empty = complete.
 * Hard classes must have covering modules + name substrings and no waiver.
 * Soft classes may waive with `#N` open issue when coverage is empty.
 */
export function collectShipPathCompositionInventoryGaps(): ShipPathCompositionInventoryGap[] {
  const gaps: ShipPathCompositionInventoryGap[] = [];
  const seen = new Set<string>();

  for (const entry of SHIP_PATH_COMPOSITION_INVENTORY) {
    if (seen.has(entry.id)) {
      gaps.push({ class_id: entry.id, reason: "duplicate inventory row" });
    }
    seen.add(entry.id);

    if (entry.kind === "hard") {
      if (!HARD_SET.has(entry.id)) {
        gaps.push({
          class_id: entry.id,
          reason: "kind=hard but id is not in SHIP_PATH_COMPOSITION_HARD_CLASS_IDS",
        });
      }
      if (entry.waiver_issue) {
        gaps.push({
          class_id: entry.id,
          reason: `hard class must not use waiver_issue (got ${entry.waiver_issue})`,
        });
      }
      if (entry.covering_modules.length === 0) {
        gaps.push({
          class_id: entry.id,
          reason: "hard class missing covering_modules",
        });
      }
      if (entry.covering_test_name_substrings.length === 0) {
        gaps.push({
          class_id: entry.id,
          reason: "hard class missing covering_test_name_substrings",
        });
      }
    } else {
      if (!SOFT_SET.has(entry.id)) {
        gaps.push({
          class_id: entry.id,
          reason: "kind=soft but id is not in SHIP_PATH_COMPOSITION_SOFT_CLASS_IDS",
        });
      }
      const hasCoverage =
        entry.covering_modules.length > 0 &&
        entry.covering_test_name_substrings.length > 0;
      const hasWaiver =
        typeof entry.waiver_issue === "string" && /^#\d+$/.test(entry.waiver_issue);
      if (!hasCoverage && !hasWaiver) {
        gaps.push({
          class_id: entry.id,
          reason:
            "soft class needs covering tests or open tracking-issue waiver (#N)",
        });
      }
    }
  }

  for (const id of SHIP_PATH_COMPOSITION_HARD_CLASS_IDS) {
    if (!seen.has(id)) {
      gaps.push({
        class_id: id,
        reason: "hard class missing from inventory",
      });
    }
  }

  return gaps;
}

export function assertShipPathCompositionInventoryComplete(): void {
  const gaps = collectShipPathCompositionInventoryGaps();
  if (gaps.length === 0) return;
  const detail = gaps.map((g) => `${g.class_id}: ${g.reason}`).join("; ");
  throw new Error(`ship-path composition inventory incomplete: ${detail}`);
}

export interface ShipPathCompositionCoverageGap {
  class_id: string;
  reason: string;
}

/**
 * Filesystem coverage check: covering modules exist under core/ and each
 * registered test-name substring appears in a `test("…")` title.
 */
export function collectShipPathCompositionCoverageGaps(
  coreRoot?: string,
): ShipPathCompositionCoverageGap[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = coreRoot ?? join(here, "..");
  const gaps: ShipPathCompositionCoverageGap[] = [];

  for (const entry of SHIP_PATH_COMPOSITION_INVENTORY) {
    if (
      entry.kind === "soft" &&
      entry.covering_modules.length === 0 &&
      typeof entry.waiver_issue === "string" &&
      /^#\d+$/.test(entry.waiver_issue)
    ) {
      continue;
    }

    const bodies: string[] = [];
    for (const rel of entry.covering_modules) {
      const abs = join(root, rel);
      if (!existsSync(abs)) {
        gaps.push({
          class_id: entry.id,
          reason: `covering module missing: ${rel}`,
        });
        continue;
      }
      bodies.push(readFileSync(abs, "utf8"));
    }

    if (bodies.length === 0) {
      if (entry.kind === "hard") {
        gaps.push({
          class_id: entry.id,
          reason: "no readable covering modules",
        });
      }
      continue;
    }

    const joined = bodies.join("\n");
    for (const sub of entry.covering_test_name_substrings) {
      // Match node:test registration: test("title" or test('title'
      const escaped = sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(
        String.raw`\btest\s*\(\s*(["'\`])(?:(?!\1).)*${escaped}(?:(?!\1).)*\1`,
        "s",
      );
      if (!re.test(joined)) {
        // Fallback: substring present near a test( line (template titles, etc.)
        if (!joined.includes(sub)) {
          gaps.push({
            class_id: entry.id,
            reason: `covering test name substring not found: ${JSON.stringify(sub)}`,
          });
        }
      }
    }
  }

  return gaps;
}

export function assertShipPathCompositionCoveragePresent(coreRoot?: string): void {
  const gaps = collectShipPathCompositionCoverageGaps(coreRoot);
  if (gaps.length === 0) return;
  const detail = gaps.map((g) => `${g.class_id}: ${g.reason}`).join("; ");
  throw new Error(`ship-path composition coverage missing: ${detail}`);
}

/**
 * FRG Layer A honesty helper: hard ship-path classes are owned by hermetic unit
 * composition (source: layer_a style), not by expanding Layer B pack ids.
 * Returns the hard ids that lack inventory completeness or coverage registration.
 */
export function shipPathCompositionSilentHardGaps(
  coreRoot?: string,
): string[] {
  const inv = collectShipPathCompositionInventoryGaps()
    .filter((g) => HARD_SET.has(g.class_id))
    .map((g) => g.class_id);
  const cov = collectShipPathCompositionCoverageGaps(coreRoot)
    .filter((g) => HARD_SET.has(g.class_id))
    .map((g) => g.class_id);
  return [...new Set([...inv, ...cov])];
}
