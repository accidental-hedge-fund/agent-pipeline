// Hermetic schema guards for installed-CLI qualification (#1525).
// Real launcher/process coverage lives in scripts/installed-cli-qualification.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
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
  const repo = mkdtempSync(path.join(tmpdir(), "pipeline-candidate-inventory-"));
  try {
    mkdirSync(path.join(repo, "core", "test"), { recursive: true });
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    writeFileSync(path.join(repo, "core", "test", "trusted.test.ts"), "export {};\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "pipeline@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Pipeline Test"], { cwd: repo });
    execFileSync("git", ["add", "core/test/trusted.test.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "trusted inventory"], { cwd: repo });
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(path.join(repo, "core", "test", "operator-only.test.ts"), "export {};\n");
    assert.deepEqual(candidateTestNamesAtCommit(path.join(repo, "scripts", "pipeline-launcher.mjs"), candidate),
      ["trusted.test.ts"], "dirty operator-only tests are not part of the trusted candidate inventory");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  assert.equal(candidateTestNamesAtCommit("relative", CANDIDATE, { lsTree: () => "x" }), null);
  assert.equal(candidateTestNamesAtCommit("/operator/scripts/pipeline-launcher.mjs", CANDIDATE, { lsTree: () => "" }), null);
});
