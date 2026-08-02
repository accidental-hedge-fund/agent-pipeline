// #628: Pre-merge domain-module boundary.
//
// Structural guards only (no tsc graph gate): domain modules exist, the facade
// re-exports canary public symbols, domain modules must not import the
// pre_merge facade, and isPipelineInternalCommit ownership stays neutral.
// Pure + filesystem only — no network/git/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import * as preMergeFacade from "../scripts/stages/pre_merge.ts";
import { enforceReviewShaGate } from "../scripts/stages/pre-merge-sha-gate.ts";
import { maybeArchiveOpenspec } from "../scripts/stages/pre-merge-openspec-archive.ts";
import { hydrateCiRecoveryMarkers } from "../scripts/stages/pre-merge-ci-gate.ts";
import { tryRebaseAndPush, REBASE_MARKER_FILE } from "../scripts/stages/pre-merge-conflict-rebase.ts";
import { advance, advancePolling } from "../scripts/stages/pre-merge-routing.ts";
import { isPipelineInternalCommit as neutralClassifier } from "../scripts/pipeline-commits.ts";

const stagesDir = path.dirname(
  fileURLToPath(new URL("../scripts/stages/pre_merge.ts", import.meta.url)),
);

const DOMAIN_MODULES = [
  "pre-merge-sha-gate.ts",
  "pre-merge-openspec-archive.ts",
  "pre-merge-ci-gate.ts",
  "pre-merge-conflict-rebase.ts",
  "pre-merge-routing.ts",
  "pre-merge-autofix.ts",
  "pre-merge-shared.ts",
] as const;

/** Canary public surface previously imported from pre_merge.ts by production/tests. */
const FACADE_CANARY_EXPORTS = [
  "advance",
  "advancePolling",
  "enforceReviewShaGate",
  "maybeArchiveOpenspec",
  "performPreMergeAutoFix",
  "resolveReviewedShaCurrency",
  "buildCiExhaustedBlockReason",
  "hydrateCiRecoveryMarkers",
  "resolveRebasePushResult",
  "REBASE_MARKER_FILE",
  "isPipelineInternalCommit",
  "OPENSPEC_ARCHIVE_PREFIX",
  "staleReviewNotice",
  "archiveAlreadyDone",
  "partitionBlockingForAutofix",
  // #759 reconcile-shaped domain surfaces
  "reconcileCiRecoveryState",
  "reconcileConflictRebaseState",
  "reconcileReviewShaGateState",
] as const;

test("pre-merge domain modules exist under stages/", () => {
  for (const name of DOMAIN_MODULES) {
    assert.ok(
      existsSync(path.join(stagesDir, name)),
      `missing domain module: ${name}`,
    );
  }
});

test("pre_merge.ts facade re-exports canary public symbols", () => {
  for (const name of FACADE_CANARY_EXPORTS) {
    assert.ok(
      name in preMergeFacade,
      `facade missing re-export: ${name}`,
    );
  }
  assert.equal(typeof preMergeFacade.advance, "function");
  assert.equal(typeof preMergeFacade.enforceReviewShaGate, "function");
  assert.equal(typeof preMergeFacade.maybeArchiveOpenspec, "function");
  assert.equal(typeof preMergeFacade.performPreMergeAutoFix, "function");
});

test("facade re-exports resolve to the same bindings as domain modules", () => {
  assert.equal(preMergeFacade.enforceReviewShaGate, enforceReviewShaGate);
  assert.equal(preMergeFacade.maybeArchiveOpenspec, maybeArchiveOpenspec);
  assert.equal(preMergeFacade.hydrateCiRecoveryMarkers, hydrateCiRecoveryMarkers);
  assert.equal(preMergeFacade.tryRebaseAndPush, tryRebaseAndPush);
  assert.equal(preMergeFacade.REBASE_MARKER_FILE, REBASE_MARKER_FILE);
  assert.equal(preMergeFacade.advance, advance);
  assert.equal(preMergeFacade.advancePolling, advancePolling);
  assert.equal(typeof preMergeFacade.reconcileCiRecoveryState, "function");
  assert.equal(typeof preMergeFacade.reconcileConflictRebaseState, "function");
  assert.equal(typeof preMergeFacade.reconcileReviewShaGateState, "function");
});

test("pre_merge.ts is a thin re-export facade (not the sole implementation home)", () => {
  const src = readFileSync(path.join(stagesDir, "pre_merge.ts"), "utf8");
  assert.match(src, /export \* from ["']\.\/pre-merge-sha-gate\.ts["']/);
  assert.match(src, /export \* from ["']\.\/pre-merge-openspec-archive\.ts["']/);
  assert.match(src, /export \* from ["']\.\/pre-merge-ci-gate\.ts["']/);
  assert.match(src, /export \* from ["']\.\/pre-merge-conflict-rebase\.ts["']/);
  assert.match(src, /export \* from ["']\.\/pre-merge-routing\.ts["']/);
  // Facade must not re-house the SHA-gate body.
  assert.doesNotMatch(src, /export async function enforceReviewShaGate\b/);
  assert.doesNotMatch(src, /export async function maybeArchiveOpenspec\b/);
  // Keep the facade small relative to the pre-split monolith (~5400 LOC).
  const nonCommentLines = src
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("//")).length;
  assert.ok(
    nonCommentLines < 40,
    `facade should stay thin; non-comment lines=${nonCommentLines}`,
  );
});

test("domain modules do not import the pre_merge facade", () => {
  for (const name of DOMAIN_MODULES) {
    const src = readFileSync(path.join(stagesDir, name), "utf8");
    for (const line of src.split("\n")) {
      if (!/^\s*import\s/.test(line)) continue;
      assert.doesNotMatch(
        line,
        /from\s+["']\.\/pre_merge\.ts["']/,
        `${name} must not import the pre_merge facade: ${line}`,
      );
      assert.doesNotMatch(
        line,
        /from\s+["']\.\/pre_merge["']/,
        `${name} must not import the pre_merge facade: ${line}`,
      );
    }
  }
});

test("isPipelineInternalCommit remains owned by neutral pipeline-commits", () => {
  assert.equal(preMergeFacade.isPipelineInternalCommit, neutralClassifier);
  const facadeSrc = readFileSync(path.join(stagesDir, "pre_merge.ts"), "utf8");
  assert.match(
    facadeSrc,
    /export\s*\{[^}]*isPipelineInternalCommit[^}]*\}\s*from\s*["']\.\.\/pipeline-commits\.ts["']/,
  );
  // Classifier body must not live in sha-gate or the facade as sole owner.
  const shaSrc = readFileSync(path.join(stagesDir, "pre-merge-sha-gate.ts"), "utf8");
  assert.doesNotMatch(shaSrc, /export function isPipelineInternalCommit\b/);
});
