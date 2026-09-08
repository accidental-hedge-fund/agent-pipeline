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

test("candidate test inventory comes from exact commit, not dirty operator files (#1558)", () => {
  const observed: Array<{ root: string; sha: string }> = [];
  const names = candidateTestNamesAtCommit(
    "/operator/scripts/pipeline-launcher.mjs",
    CANDIDATE,
    {
      lsTree(root, sha) {
        observed.push({ root, sha });
        return "core/test/a.test.ts\ncore/test/b.test.ts\n";
      },
    },
  );
  // An imagined live-only core/test/uncommitted.test.ts is not an input to
  // this seam; only the candidate commit's ls-tree result is authoritative.
  assert.deepEqual(names, ["a.test.ts", "b.test.ts"]);
  assert.deepEqual(observed, [{ root: "/operator", sha: CANDIDATE }]);
  assert.equal(candidateTestNamesAtCommit("relative", CANDIDATE, { lsTree: () => "x" }), null);
  assert.equal(candidateTestNamesAtCommit("/operator/scripts/pipeline-launcher.mjs", CANDIDATE, { lsTree: () => "" }), null);
});
