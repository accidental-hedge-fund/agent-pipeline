import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PIPELINE_CLI = resolve(import.meta.dirname, "../core/scripts/pipeline.ts");

function summaryBundle(issue, runId) {
  return {
    schema_version: 1,
    schemaVersion: 1,
    runId,
    issue,
    pr: null,
    branch: "feat/test",
    harnesses: ["codex"],
    stages: [],
    reviews: [],
    overrides: [],
    recoveries: [],
    finalState: "ready-to-deploy",
    finalizedAt: "2026-06-20T10:01:00Z",
    notifiedAt: null,
  };
}

function runCli(repoDir, args) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_CLI, ...args, "--repo-path", repoDir],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PATH: "" },
    },
  );
}

test("pipeline summary <issue> reads a run summary offline and rejects unsupported flags", () => {
  const issue = 147;
  const runId = `${issue}-2026-06-20T10-00-00-000Z`;
  const repoDir = mkdtempSync(join(tmpdir(), "pipeline-summary-offline-"));
  const runDir = join(repoDir, ".agent-pipeline", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summaryBundle(issue, runId)));

  try {
    const result = runCli(repoDir, ["summary", String(issue), "--domain", "offline-test"]);
    assert.equal(result.error, undefined, `summary spawn failed: ${String(result.error)}`);
    assert.equal(result.signal, null, `summary was killed by ${String(result.signal)}`);
    assert.equal(result.status, 0, `offline summary failed: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, new RegExp(runId));
    assert.doesNotMatch(result.stderr, /gh repo view|pipeline\.yml|unexpected argument/i);

    const invalid = runCli(repoDir, ["summary", String(issue), "--dry-run"]);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /pipeline summary.*--dry-run/i);

    const extra = runCli(repoDir, ["summary", String(issue), "junk"]);
    assert.equal(extra.status, 2);
    assert.match(extra.stderr, /unexpected argument\(s\): junk/i);
    assert.equal(extra.stdout, "", "invalid summary argv must not read or print a bundle");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
