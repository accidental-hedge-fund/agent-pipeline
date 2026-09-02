// Static guards for #1333 legacy lifecycle paths. Synthetic fixtures must fail.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  LEGACY_LIFECYCLE_SITE_INVENTORY,
  collectCommandLocalLifecycleExits,
  collectDirectStageLifecycleWrites,
  collectProviderIncidentDispatch,
  collectRetiredControllerImports,
  scanProductionRecoveryGuards,
} from "../scripts/fault-recovery-static-guards.ts";
import { FAULT_RECOVERY_MATRIX } from "../scripts/fault-recovery-matrix.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(__dirname, "..");

test("each inventoried legacy site maps to a replacement matrix row", () => {
  for (const site of LEGACY_LIFECYCLE_SITE_INVENTORY) {
    assert.equal(site.status, "replaced_with_cooling");
    const src = readFileSync(join(CORE_ROOT, site.module), "utf8");
    assert.match(src, /cooling/);
    assert.ok(
      FAULT_RECOVERY_MATRIX.some(
        (row) =>
          row.covering_test_name_substring === site.replacement_row ||
          row.fault_state === "strategy_exhaustion",
      ),
    );
  }
});

test("retired controller import fails the static guard", () => {
  const synthetic = `import { recover } from "./legacy-recovery-controller.ts";\n`;
  const hits = collectRetiredControllerImports(synthetic, "fixture.ts");
  assert.ok(hits.some((h) => /retired recovery-controller import/.test(h.reason)));
});

test("command-local lifecycle exit fails the static guard", () => {
  const synthetic = `if (mechanical) { process.exit(1); }\n`;
  const hits = collectCommandLocalLifecycleExits(synthetic, "fixture.ts");
  assert.ok(hits.some((h) => /process.exit/.test(h.reason)));
});

test("direct stage-label write fails the static guard", () => {
  const synthetic = `await addLabel("pipeline:needs-human");\n`;
  const hits = collectDirectStageLifecycleWrites(synthetic, "fixture.ts");
  assert.ok(hits.some((h) => /lifecycle label write|needs-human write/.test(h.reason)));
});

test("direct addLabels of a lifecycle label fails without command-local prose", () => {
  const synthetic = `await addLabels(n, ["pipeline:ready-to-deploy"]);\n`;
  const hits = collectDirectStageLifecycleWrites(synthetic, "fixture.ts");
  assert.ok(hits.some((h) => /lifecycle label write/.test(h.reason)));
});

test("direct setBlocked of a lifecycle label fails the static guard", () => {
  const synthetic = `await setBlocked(cfg, n, reason, "fix", "pipeline:needs-human");\n`;
  const hits = collectDirectStageLifecycleWrites(synthetic, "fixture.ts");
  assert.ok(hits.some((h) => /needs-human write/.test(h.reason)));
});

test("provider string dispatch fails the static guard", () => {
  const synthetic = `switch (err) { case "GitHub Actions failed": return "park"; }\n`;
  const hits = collectProviderIncidentDispatch(synthetic, "fixture.ts");
  assert.ok(hits.some((h) => /incident string dispatch/.test(h.reason)));
});

test("production recovery routing has no retired imports or incident keys", () => {
  const hits = scanProductionRecoveryGuards(CORE_ROOT);
  assert.deepEqual(hits, [], JSON.stringify(hits));
});
