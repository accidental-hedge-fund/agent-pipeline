// Integration test for `pipeline logs <run-id> --follow` hang fix (#155).
// Uses a real temp run dir + a real `tail` child (no network/git).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runLogs } from "../scripts/pipeline.ts";

test("runLogs --follow returns (does not hang) when terminal.log is missing (#155)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runlogs-"));
  const runId = "42-2026-06-16T00-00-00Z";
  // Run dir exists (so the directory stat passes) but terminal.log does NOT —
  // the window the old code hung on. `tail -f <missing>` exits non-zero, and the
  // fixed runLogs resolves on that exit instead of awaiting forever.
  const runDir = path.join(tmp, ".agent-pipeline", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), "{}");

  const savedExit = process.exitCode;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("runLogs --follow hung (did not resolve)")), 5000);
    });
    await Promise.race([runLogs(tmp, runId, true), timeout]);
    // tail failed to open the missing file → non-zero exit propagated.
    assert.ok(
      process.exitCode !== undefined && process.exitCode !== 0,
      `expected a non-zero exitCode after a failed follow; got ${String(process.exitCode)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    process.exitCode = savedExit;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
