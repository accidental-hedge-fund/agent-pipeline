// #857: Covered call-site inventory contract — each site imports the shared wrapper.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COVERED_MUTATION_SITES,
  OUT_OF_SCOPE_MUTATION_SITES,
} from "../scripts/candidate-integrity.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Covered mutation sites import runCoveredCandidateMutation or candidate-integrity", () => {
  for (const site of COVERED_MUTATION_SITES) {
    const [relFile, symbol] = site.split(":");
    assert.ok(relFile && symbol, `site must be file:symbol — got ${site}`);
    const abs = path.join(ROOT, "scripts", relFile!);
    assert.ok(fs.existsSync(abs), `Covered site file missing: ${abs}`);
    const src = fs.readFileSync(abs, "utf8");
    assert.ok(
      src.includes("candidate-integrity") ||
        src.includes("runCoveredCandidateMutation") ||
        src.includes("runCandidateMovingMutation"),
      `${site} must import candidate-integrity protocol`,
    );
    // Symbol should still be defined/exported in that file
    assert.ok(
      src.includes(symbol!) || src.includes(`function ${symbol}`),
      `${site}: symbol ${symbol} not found in ${relFile}`,
    );
  }
});

test("Out-of-scope inventory is non-empty documentation", () => {
  assert.ok(OUT_OF_SCOPE_MUTATION_SITES.length >= 4);
});
