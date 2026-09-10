// Hermetic schema guards for installed-CLI qualification (#1525).
// Real launcher/process coverage lives in scripts/installed-cli-qualification.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidateTestNamesAtCommit,
  INSTALLED_CLI_QUALIFICATION_SCHEMA,
  parseInstalledCliQualificationArtifact,
} from "../scripts/installed-cli-qualification.ts";

const CANDIDATE = "a".repeat(40);

test("malformed and stale qualification artifacts receive no coverage", () => {
  assert.equal(parseInstalledCliQualificationArtifact(null, CANDIDATE), null);
  assert.equal(
    parseInstalledCliQualificationArtifact(
      {
        schema: INSTALLED_CLI_QUALIFICATION_SCHEMA,
        candidate_sha: "b".repeat(40),
        launcher: "/staged/pipeline",
        matrix_version: 1,
        generated_at: "2026-09-07T00:00:00.000Z",
        rows: [],
        proofs: [],
        digest_sha256: `sha256:${"0".repeat(64)}`,
      },
      CANDIDATE,
    ),
    null,
  );
});

test("installed CLI coverage module points to the external process qualification", async () => {
  const { collectFaultRecoveryCoverageGaps } = await import("../scripts/fault-recovery-matrix.ts");
  assert.deepEqual(
    collectFaultRecoveryCoverageGaps().filter((gap) => gap.class_id.startsWith("installed_cli:")),
    [],
  );
});

test("candidate test inventory parses injected exact-commit ls-tree output (#1558)", () => {
  let observedRoot = "";
  let observedCandidate = "";
  const inventory = candidateTestNamesAtCommit("/operator/scripts/pipeline-launcher.mjs", CANDIDATE, {
    lsTree: (repoRoot, candidateSha) => {
      observedRoot = repoRoot;
      observedCandidate = candidateSha;
      return [
        "core/test/z-last.test.ts",
        "core/test/helpers/not-a-suite.test.ts",
        "core/test/readme.md",
        "core/test/a-first.test.ts",
      ].join("\n");
    },
  });
  assert.equal(observedRoot, "/operator");
  assert.equal(observedCandidate, CANDIDATE);
  assert.deepEqual(inventory, ["a-first.test.ts", "z-last.test.ts"]);
  assert.equal(candidateTestNamesAtCommit("relative", CANDIDATE, { lsTree: () => "x" }), null);
  assert.equal(candidateTestNamesAtCommit("/operator/scripts/pipeline-launcher.mjs", CANDIDATE, { lsTree: () => "" }), null);
});
