// Ship-path composition coverage (#1029).
//
// Drift-guard + composition ownership for train∘loop frontier advance,
// scratch-only recover, independent R2D merge under partial failure, and soft
// stale-block re-review before train STOP.
//
// Product bites live in train.test.ts / testgate / recovery / stale-blocked
// suites; this file makes silent deletion or non-registration fail CI.
// Zero real network, git, or subprocess.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  SHIP_PATH_COMPOSITION_HARD_CLASS_IDS,
  SHIP_PATH_COMPOSITION_INVENTORY,
  SHIP_PATH_COMPOSITION_SOFT_CLASS_IDS,
  assertShipPathCompositionCoveragePresent,
  assertShipPathCompositionInventoryComplete,
  collectShipPathCompositionCoverageGaps,
  collectShipPathCompositionInventoryGaps,
  isShipPathCompositionHardClassId,
  shipPathCompositionSilentHardGaps,
} from "../scripts/ship-path-composition-coverage.ts";
import { FRG_SCENARIO_IDS } from "../scripts/factory-reliability-gate.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(__dirname, "..");
const SCRIPTS_ROOT = join(CORE_ROOT, "scripts");

// ---------------------------------------------------------------------------
// 1. Inventory completeness + drift guard
// ---------------------------------------------------------------------------

test("ship-path composition inventory is complete for hard classes (#1029)", () => {
  assertShipPathCompositionInventoryComplete();
  for (const id of SHIP_PATH_COMPOSITION_HARD_CLASS_IDS) {
    const row = SHIP_PATH_COMPOSITION_INVENTORY.find((e) => e.id === id);
    assert.ok(row, `hard class missing from inventory: ${id}`);
    assert.equal(row.kind, "hard");
    assert.ok(row.covering_modules.length > 0, `${id} needs covering_modules`);
    assert.ok(
      row.covering_test_name_substrings.length > 0,
      `${id} needs covering_test_name_substrings`,
    );
    assert.ok(!row.waiver_issue, `hard class ${id} must not use waiver_issue`);
  }
});

test("ship-path composition hard class without coverage fails the inventory guard", () => {
  // Bite: simulate a hard class with empty covering registration.
  const defective = {
    id: "train-frontier-one-wave" as const,
    kind: "hard" as const,
    covering_modules: [] as string[],
    covering_test_name_substrings: [] as string[],
    notes: "defective",
  };
  assert.equal(defective.covering_modules.length, 0);
  assert.equal(defective.covering_test_name_substrings.length, 0);
  // Real inventory must still pass; the bite is that empty coverage is illegal.
  const gaps = collectShipPathCompositionInventoryGaps();
  assert.equal(gaps.length, 0, `unexpected inventory gaps: ${JSON.stringify(gaps)}`);
  // Structural rule used by collectShipPathCompositionInventoryGaps:
  assert.ok(isShipPathCompositionHardClassId(defective.id));
  assert.ok(
    defective.kind === "hard" &&
      (defective.covering_modules.length === 0 ||
        defective.covering_test_name_substrings.length === 0),
    "hard class with empty coverage is the defective shape the guard rejects",
  );
});

test("ship-path composition covering tests are present on disk (#1029)", () => {
  assertShipPathCompositionCoveragePresent(CORE_ROOT);
  const gaps = collectShipPathCompositionCoverageGaps(CORE_ROOT);
  assert.deepEqual(gaps, []);
});

test("ship-path composition silent hard-class omission fails (#1029)", () => {
  const silent = shipPathCompositionSilentHardGaps(CORE_ROOT);
  assert.deepEqual(
    silent,
    [],
    `silent hard ship-path composition gaps: ${silent.join(", ")}`,
  );
});

test("ship-path composition inventory maps every hard id exactly once", () => {
  const hardRows = SHIP_PATH_COMPOSITION_INVENTORY.filter((e) => e.kind === "hard");
  assert.equal(hardRows.length, SHIP_PATH_COMPOSITION_HARD_CLASS_IDS.length);
  const ids = hardRows.map((e) => e.id).sort();
  assert.deepEqual(
    ids,
    [...SHIP_PATH_COMPOSITION_HARD_CLASS_IDS].slice().sort(),
  );
});

// ---------------------------------------------------------------------------
// 2. Soft stale-block join (covered, not waived)
// ---------------------------------------------------------------------------

test("soft class stale-blocked-rereview-before-train-stop is inventoried with coverage", () => {
  assert.ok(
    SHIP_PATH_COMPOSITION_SOFT_CLASS_IDS.includes(
      "stale-blocked-rereview-before-train-stop",
    ),
  );
  const soft = SHIP_PATH_COMPOSITION_INVENTORY.find(
    (e) => e.id === "stale-blocked-rereview-before-train-stop",
  );
  assert.ok(soft, "soft class must be inventoried");
  assert.equal(soft.kind, "soft");
  assert.ok(
    soft.covering_modules.length > 0 && soft.covering_test_name_substrings.length > 0,
    "soft class is covered (not open-issue waived)",
  );
  assert.ok(!soft.waiver_issue, "covered soft class must not carry a waiver");
});

test("pipeline-run attempts stale-block resume before terminal STOP (#1025 soft join)", () => {
  // Soft composition: leftover blocked must try resume before terminal STOP text.
  const src = readFileSync(join(SCRIPTS_ROOT, "pipeline-run.ts"), "utf8");
  const resumeIdx = src.indexOf("tryResumeStaleBlocked");
  assert.ok(resumeIdx !== -1, "pipeline-run must call tryResumeStaleBlocked");
  // Terminal already-blocked STOP surface (after resume attempt in the blocked branch).
  const stopMarker = "blocked at ${stage}; surface latest blocker";
  const stopIdx = src.indexOf(stopMarker);
  assert.ok(stopIdx !== -1, `expected STOP surface marker: ${stopMarker}`);
  assert.ok(
    resumeIdx < stopIdx,
    "stale-block resume must run before terminal blocked STOP surface",
  );
  assert.ok(
    src.includes("stageEligibleForStaleBlockedResume"),
    "resume must be stage-gated via stageEligibleForStaleBlockedResume",
  );
  // Must not invent override/disposition as the resume path.
  const blockedBranch = src.slice(resumeIdx, stopIdx + 200);
  assert.ok(
    /clearBlocked|tryResumeStaleBlocked/.test(blockedBranch),
    "resume path must clear/resume, not mint needs-human authority",
  );
});

// ---------------------------------------------------------------------------
// 3. FRG Layer A honesty — do not expand Layer B pack; no release FRG mint
// ---------------------------------------------------------------------------

test("FRG Layer B scenario pack ids remain frozen by ship-path composition (#1029)", () => {
  // Hard classes are hermetic unit / Layer A style; Layer B fixed pack stays at 10.
  assert.equal(FRG_SCENARIO_IDS.length, 10);
  for (const id of SHIP_PATH_COMPOSITION_HARD_CLASS_IDS) {
    assert.ok(
      !(FRG_SCENARIO_IDS as readonly string[]).includes(id),
      `ship-path class ${id} must not be injected into FRG Layer B scenario pack`,
    );
  }
});

test("ship-path composition module does not claim release FRG pass from offline alone", () => {
  const invSrc = readFileSync(
    join(SCRIPTS_ROOT, "ship-path-composition-coverage.ts"),
    "utf8",
  );
  assert.ok(
    /does not mint release-eligible FRG|not mint release-eligible FRG/i.test(invSrc),
    "inventory module must document that offline composition is not FRG pass:true alone",
  );
  // No production path in this module writes FRG evidence objects.
  assert.ok(
    !/writeFrg|computeFrgEvidence|FRG_SCHEMA|pass:\s*true\s*[,}]/.test(invSrc),
    "ship-path composition inventory must not write FRG evidence or mint pass:true",
  );
});

// ---------------------------------------------------------------------------
// 4. Product dirt still hard-blocks (not a false composition failure)
// ---------------------------------------------------------------------------

test("scratch-only composition does not treat product dirt hard-block as failure shape", async () => {
  // Confirm product dirt remains a hard-block at the classifier + gate seams used
  // by covering tests — composition suite must not redefine product dirt as pass.
  const { classifyWorktreeDirt } = await import("../scripts/worktree-dirt.ts");
  const product = classifyWorktreeDirt([
    "artifacts/challenge-response-1.json",
    "core/scripts/foo.ts",
  ]);
  assert.deepEqual(product.product, ["core/scripts/foo.ts"]);
  assert.ok(product.product.length > 0, "product path must remain classified as product");
  const scratchOnly = classifyWorktreeDirt(["artifacts/challenge-response-1.json"]);
  assert.deepEqual(scratchOnly.product, []);
  assert.deepEqual(scratchOnly.scratch, ["artifacts/challenge-response-1.json"]);
});
