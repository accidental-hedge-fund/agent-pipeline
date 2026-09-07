// Hermetic schema guards for installed-CLI qualification (#1525).
// Real launcher/process coverage lives in scripts/installed-cli-qualification.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
