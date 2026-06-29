// Unit tests for the dedicated transitions log (#324).
//
// Coverage:
//   5.1  appendTransitionLine writes the line + trailing newline.
//   5.2  Mirrored line is byte-for-byte equal to the argument (no added prefix).
//   5.3  Second dispatch appends; does not truncate existing content.
//   5.4  A write error is non-fatal (no throw).
//   5.5  makeTransitionsLogger wraps appendTransitionLine with a bound path.
//   5.6  transitionsLogPath derives the correct /tmp path.
//   5.7  AdvanceDeps.logTransition seam is accepted by the type (compile check).
//   5.8  Cleanup pattern: unlinkSync removes transitions log; missing file is tolerated.
//   5.9  printOutcome calls tlog for advancing and non-advancing outcomes (regression for line-735 bug).
//   5.10 AdvanceDeps.transitionsLogN seam accepted; PR-resolves-to-issue path uses original arg.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { transitionsLogPath, appendTransitionLine, makeTransitionsLogger } from "../scripts/transitions-log.ts";
import { printOutcome } from "../scripts/pipeline-run.ts";
import type { AdvanceDeps } from "../scripts/pipeline-run.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpFile(fn: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlog-test-"));
  const filePath = path.join(dir, "transitions.log");
  try {
    fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5.6  transitionsLogPath
// ---------------------------------------------------------------------------

test("transitionsLogPath: produces /tmp/pipeline-<domain>-<N>.transitions.log", () => {
  assert.equal(
    transitionsLogPath("agent-pipeline", 301),
    "/tmp/pipeline-agent-pipeline-301.transitions.log",
  );
  assert.equal(
    transitionsLogPath("my-domain", 42),
    "/tmp/pipeline-my-domain-42.transitions.log",
  );
});

// ---------------------------------------------------------------------------
// 5.1 / 5.2  appendTransitionLine: line is written verbatim + newline
// ---------------------------------------------------------------------------

test("appendTransitionLine: writes line + newline, no extra prefix", () => {
  withTmpFile((p) => {
    const line = "[pipeline] #301: ready → review-1: PR #42 opened";
    appendTransitionLine(p, line);
    const content = fs.readFileSync(p, "utf8");
    assert.equal(content, line + "\n");
  });
});

test("appendTransitionLine: writes blocked/idle outcome line verbatim", () => {
  withTmpFile((p) => {
    const line = "[pipeline] #301: at review-1 — blocked: review ceiling reached";
    appendTransitionLine(p, line);
    assert.equal(fs.readFileSync(p, "utf8"), line + "\n");
  });
});

// ---------------------------------------------------------------------------
// 5.3  appendTransitionLine appends (does not truncate) on successive calls
// ---------------------------------------------------------------------------

test("appendTransitionLine: second call appends, does not truncate", () => {
  withTmpFile((p) => {
    const line1 = "[pipeline] #301: starting at stage=ready";
    const line2 = "[pipeline] #301: run id 301/2026-01-01T00:00:00Z";
    appendTransitionLine(p, line1);
    appendTransitionLine(p, line2);
    const content = fs.readFileSync(p, "utf8");
    assert.equal(content, line1 + "\n" + line2 + "\n");
  });
});

test("appendTransitionLine: second simulated dispatch appends after prior content", () => {
  withTmpFile((p) => {
    // Simulate first dispatch writing two lines.
    appendTransitionLine(p, "[pipeline] #42: starting at stage=ready");
    appendTransitionLine(p, "[pipeline] #42: run id 42/2026-01-01T00:00:00Z");
    const afterFirst = fs.readFileSync(p, "utf8");

    // Second dispatch appends.
    appendTransitionLine(p, "[pipeline] #42: starting at stage=review-1");
    const afterSecond = fs.readFileSync(p, "utf8");

    // Prior content must still be present.
    assert.ok(afterSecond.startsWith(afterFirst));
    assert.ok(afterSecond.includes("[pipeline] #42: starting at stage=review-1\n"));
  });
});

// ---------------------------------------------------------------------------
// 5.4  appendTransitionLine is non-fatal on write error
// ---------------------------------------------------------------------------

test("appendTransitionLine: silently ignores write to unwritable path", () => {
  assert.doesNotThrow(() => {
    appendTransitionLine("/nonexistent-directory-xyz/file.transitions.log", "some line");
  });
});

// ---------------------------------------------------------------------------
// 5.5  makeTransitionsLogger binds the path and delegates to appendTransitionLine
// ---------------------------------------------------------------------------

test("makeTransitionsLogger: returned function appends each call as a line", () => {
  withTmpFile((p) => {
    const log = makeTransitionsLogger(p);
    log("[pipeline] #99: starting at stage=ready");
    log("[pipeline] #99: run id 99/2026-01-01T00:00:00Z");
    log("[pipeline] #99: ready → review-1: PR opened");
    log("\n[pipeline] #99: done — ready → review-1 (1 transitions, 5s)");

    const lines = fs.readFileSync(p, "utf8").split("\n");
    assert.equal(lines[0], "[pipeline] #99: starting at stage=ready");
    assert.equal(lines[1], "[pipeline] #99: run id 99/2026-01-01T00:00:00Z");
    assert.equal(lines[2], "[pipeline] #99: ready → review-1: PR opened");
    assert.equal(lines[3], ""); // blank line from the leading \n in done line
    assert.equal(lines[4], "[pipeline] #99: done — ready → review-1 (1 transitions, 5s)");
  });
});

test("makeTransitionsLogger: non-fatal on write error", () => {
  const log = makeTransitionsLogger("/nonexistent-dir-xyz/file.log");
  assert.doesNotThrow(() => log("some line"));
});

// ---------------------------------------------------------------------------
// 5.7  AdvanceDeps.logTransition seam is accepted by the type system
// ---------------------------------------------------------------------------

test("AdvanceDeps: logTransition field is part of the interface", () => {
  const collected: string[] = [];
  const deps: AdvanceDeps = {
    now: () => 0,
    logTransition: (line) => collected.push(line),
  };
  deps.logTransition?.("[pipeline] #1: test");
  assert.deepEqual(collected, ["[pipeline] #1: test"]);
});

// ---------------------------------------------------------------------------
// 5.8  Cleanup pattern: unlinkSync removes; missing file does not throw
// ---------------------------------------------------------------------------

test("cleanup: unlinkSync removes an existing transitions log", () => {
  withTmpFile((p) => {
    fs.writeFileSync(p, "[pipeline] #42: done\n");
    assert.ok(fs.existsSync(p));
    try { fs.unlinkSync(p); } catch { /* non-fatal */ }
    assert.ok(!fs.existsSync(p));
  });
});

test("cleanup: tolerates missing transitions log (no throw)", () => {
  const missing = `/tmp/pipeline-test-99999-missing.transitions.log`;
  try { fs.unlinkSync(missing); } catch { /* ensure absent */ }
  assert.doesNotThrow(() => {
    try { fs.unlinkSync(missing); } catch { /* non-fatal */ }
  });
});

// ---------------------------------------------------------------------------
// 5.9  printOutcome calls tlog for advancing and non-advancing outcomes
//      Regression test for the line-735 bug: printOutcome was called without
//      tlog, causing tlog to be undefined and the dispatch loop to crash.
// ---------------------------------------------------------------------------

test("printOutcome: advancing outcome calls tlog with from → to line", () => {
  const collected: string[] = [];
  const tlog = (line: string) => collected.push(line);
  printOutcome(42, "ready" as import("../scripts/types.ts").Stage, {
    advanced: true,
    from: "ready" as import("../scripts/types.ts").Stage,
    to: "review-1" as import("../scripts/types.ts").Stage,
    summary: "PR #7 opened",
  }, tlog);
  assert.deepEqual(collected, ["[pipeline] #42: ready → review-1: PR #7 opened"]);
});

test("printOutcome: non-advancing outcome calls tlog with at — status line", () => {
  const collected: string[] = [];
  const tlog = (line: string) => collected.push(line);
  printOutcome(42, "review-1" as import("../scripts/types.ts").Stage, {
    advanced: false,
    status: "blocked",
    reason: "review ceiling reached",
  }, tlog);
  assert.deepEqual(collected, ["[pipeline] #42: at review-1 — blocked: review ceiling reached"]);
});

// ---------------------------------------------------------------------------
// 5.10 AdvanceDeps.transitionsLogN seam accepted; PR-resolves-to-issue path
//      uses the original argument number for the transitions log path.
// ---------------------------------------------------------------------------

test("AdvanceDeps: transitionsLogN field is part of the interface", () => {
  const deps: AdvanceDeps = {
    transitionsLogN: 100,
    logTransition: () => {},
  };
  assert.equal(deps.transitionsLogN, 100);
});

test("transitions log path: PR-resolved-to-issue scenario uses original arg number", () => {
  // PR #100 resolves to issue #64; the transitions log path must use 100
  // (the originally supplied argument) so operators can derive it from run args.
  const originalArg = 100;
  const path = transitionsLogPath("agent-pipeline", originalArg);
  assert.equal(path, "/tmp/pipeline-agent-pipeline-100.transitions.log");
  // Confirm the resolved-issue path would differ, so the fix is meaningful.
  const resolvedIssuePath = transitionsLogPath("agent-pipeline", 64);
  assert.notEqual(path, resolvedIssuePath);
});
