// Unit tests for the run-directory-first summary read (#261).
// All I/O goes through RunSummaryDeps fakes — no real filesystem, network, git,
// or subprocess. Tests cover both `pipeline N --summary` (runSummary) and
// `pipeline summary <run-id>` (runSummaryByRunId).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  runSummary,
  runSummaryByRunId,
  type RunSummaryDeps,
} from "../scripts/pipeline.ts";
import type { EvidenceBundle } from "../scripts/types.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_DIR = "/repo";
const STATE_DIR = "/tmp/pipeline-test";
const ISSUE = 147;

/** Minimal valid EvidenceBundle for test assertions. */
function makeBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    schema_version: 1,
    schemaVersion: 1,
    runId: `${ISSUE}/2026-06-20T10:00:00Z`,
    issue: ISSUE,
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
    ...overrides,
  };
}

/** Minimal cfg stub — only the fields runSummary reads. */
const cfg = {
  domain: "test",
  repo_dir: REPO_DIR,
} as unknown as PipelineConfig;

// ---------------------------------------------------------------------------
// Capture console.error / process.exitCode without affecting other tests
// ---------------------------------------------------------------------------

function withCapture(fn: () => Promise<void>): Promise<{ errors: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const errors: string[] = [];
    const origError = console.error.bind(console);
    const origExitCode = process.exitCode;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await fn();
    } finally {
      const exitCode = process.exitCode as number | undefined;
      console.error = origError;
      process.exitCode = origExitCode;
      resolve({ errors, exitCode });
    }
  });
}

// ---------------------------------------------------------------------------
// runSummary — run-directory priority
// ---------------------------------------------------------------------------

test("runSummary: reads from run-directory summary.json when available (#261)", async () => {
  const runDirBundle = makeBundle({ runId: "run-dir-bundle" });
  const legacyBundle = makeBundle({ runId: "legacy-bundle" });

  const deps: RunSummaryDeps = {
    latestSummaryForIssue: async (_repoDir, _issue) => runDirBundle,
    readBundle: async (_stateDir, _issue) => legacyBundle,
    readFile: async (_p) => { throw new Error("should not be called"); },
  };

  const printed: string[] = [];
  const origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
  try {
    await runSummary(cfg, ISSUE, REPO_DIR, deps);
  } finally {
    console.log = origLog;
  }

  assert.ok(printed.some((l) => l.includes("run-dir-bundle")), `expected run-dir-bundle in output; got:\n${printed.join("\n")}`);
  assert.ok(!printed.some((l) => l.includes("legacy-bundle")), `legacy-bundle should not appear; got:\n${printed.join("\n")}`);
});

test("runSummary: falls back to legacy path when no run-directory summary.json exists (#261)", async () => {
  const legacyBundle = makeBundle({ runId: "legacy-fallback" });

  const deps: RunSummaryDeps = {
    latestSummaryForIssue: async () => null,
    readBundle: async () => legacyBundle,
    readFile: async (_p) => { throw new Error("should not be called"); },
  };

  const printed: string[] = [];
  const origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
  try {
    await runSummary(cfg, ISSUE, REPO_DIR, deps);
  } finally {
    console.log = origLog;
  }

  assert.ok(printed.some((l) => l.includes("legacy-fallback")), `expected legacy-fallback in output; got:\n${printed.join("\n")}`);
});

test("runSummary: treats corrupt run-directory summary.json as absent and falls back to legacy (#261)", async () => {
  // latestSummaryForIssue returns null for corrupt JSON (internal try/catch in run-store)
  const legacyBundle = makeBundle({ runId: "legacy-after-corrupt" });

  const deps: RunSummaryDeps = {
    latestSummaryForIssue: async () => null, // simulates corrupt / parse error
    readBundle: async () => legacyBundle,
    readFile: async (_p) => { throw new Error("should not be called"); },
  };

  const printed: string[] = [];
  const origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
  try {
    await runSummary(cfg, ISSUE, REPO_DIR, deps);
  } finally {
    console.log = origLog;
  }

  assert.ok(printed.some((l) => l.includes("legacy-after-corrupt")), `expected legacy bundle in output; got:\n${printed.join("\n")}`);
});

test("runSummary: exits non-zero when no bundle found at either location (#261)", async () => {
  const deps: RunSummaryDeps = {
    latestSummaryForIssue: async () => null,
    readBundle: async () => null,
    readFile: async (_p) => { throw new Error("should not be called"); },
  };

  const { errors, exitCode } = await withCapture(() => runSummary(cfg, ISSUE, REPO_DIR, deps));

  assert.equal(exitCode, 1, `expected exitCode 1; got ${String(exitCode)}`);
  const combined = errors.join("\n");
  assert.ok(combined.includes(`.agent-pipeline/runs`), `error should name run-directory path; got:\n${combined}`);
  assert.ok(combined.includes(`evidence.json`), `error should name legacy path; got:\n${combined}`);
});

test("runSummary: error message names both the run-directory and the legacy path (#261)", async () => {
  const deps: RunSummaryDeps = {
    latestSummaryForIssue: async () => null,
    readBundle: async () => null,
    readFile: async (_p) => { throw new Error("should not be called"); },
  };

  const { errors } = await withCapture(() => runSummary(cfg, ISSUE, REPO_DIR, deps));
  const combined = errors.join("\n");

  // Both paths must appear so the user knows where to look
  assert.ok(combined.includes(`${ISSUE}-*`), `error should name issue-prefix run dir pattern; got:\n${combined}`);
  assert.ok(combined.includes(`${ISSUE}`), `error should name issue number; got:\n${combined}`);
});

test("runSummary: falls back gracefully when legacy readBundle throws (corrupt) (#261)", async () => {
  const deps: RunSummaryDeps = {
    latestSummaryForIssue: async () => null,
    readBundle: async () => { throw new Error("corrupt JSON"); },
    readFile: async (_p) => { throw new Error("should not be called"); },
  };

  const { errors, exitCode } = await withCapture(() => runSummary(cfg, ISSUE, REPO_DIR, deps));

  assert.equal(exitCode, 1, `expected exitCode 1; got ${String(exitCode)}`);
  assert.ok(errors.some((e) => e.includes("no evidence bundle")), `expected not-found error; got:\n${errors.join("\n")}`);
});

// ---------------------------------------------------------------------------
// runSummaryByRunId — exact run selection
// ---------------------------------------------------------------------------

const RUN_ID = `${ISSUE}-2026-06-20T10-00-00-000Z`;

test("runSummaryByRunId: prints summary from exact run directory (#261)", async () => {
  const bundle = makeBundle({ runId: RUN_ID });

  const deps: RunSummaryDeps = {
    latestSummaryForIssue: async () => { throw new Error("should not be called"); },
    readBundle: async () => { throw new Error("should not be called"); },
    readFile: async (_p) => JSON.stringify(bundle),
  };

  const printed: string[] = [];
  const origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
  const origExitCode = process.exitCode;
  try {
    await runSummaryByRunId(REPO_DIR, RUN_ID, deps);
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode;
  }

  assert.ok(printed.some((l) => l.includes(String(ISSUE))), `expected issue number in output; got:\n${printed.join("\n")}`);
  assert.equal(process.exitCode, origExitCode, "should not set exitCode on success");
});

test("runSummaryByRunId: readFile receives the correct summary.json path (#261)", async () => {
  const bundle = makeBundle();
  let receivedPath = "";

  const deps: RunSummaryDeps = {
    latestSummaryForIssue: async () => { throw new Error("should not be called"); },
    readBundle: async () => { throw new Error("should not be called"); },
    readFile: async (p) => { receivedPath = p; return JSON.stringify(bundle); },
  };

  const origLog = console.log.bind(console);
  console.log = () => {};
  const origExitCode = process.exitCode;
  try {
    await runSummaryByRunId(REPO_DIR, RUN_ID, deps);
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode;
  }

  const expectedPath = path.join(REPO_DIR, ".agent-pipeline", "runs", RUN_ID, "summary.json");
  assert.equal(receivedPath, expectedPath, `expected readFile to be called with ${expectedPath}; got ${receivedPath}`);
});

test("runSummaryByRunId: exits non-zero with clear error for unknown run-id (#261)", async () => {
  const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;

  const deps: RunSummaryDeps = {
    latestSummaryForIssue: async () => { throw new Error("should not be called"); },
    readBundle: async () => { throw new Error("should not be called"); },
    readFile: async (_p) => { throw enoent; },
  };

  const { errors, exitCode } = await withCapture(() => runSummaryByRunId(REPO_DIR, "999-nonexistent", deps));

  assert.equal(exitCode, 1, `expected exitCode 1; got ${String(exitCode)}`);
  const combined = errors.join("\n");
  assert.ok(combined.includes("999-nonexistent"), `error should name the run-id; got:\n${combined}`);
  assert.ok(combined.includes("summary.json"), `error should mention summary.json; got:\n${combined}`);
});

test("runSummaryByRunId: does not consult domain config — path derived from repoDir alone (#261)", async () => {
  // Verify the path passed to readFile starts with REPO_DIR, not a /tmp domain path.
  const bundle = makeBundle();
  let receivedPath = "";

  const deps: RunSummaryDeps = {
    latestSummaryForIssue: async () => { throw new Error("should not be called"); },
    readBundle: async () => { throw new Error("should not be called"); },
    readFile: async (p) => { receivedPath = p; return JSON.stringify(bundle); },
  };

  const origLog = console.log.bind(console);
  console.log = () => {};
  const origExitCode = process.exitCode;
  try {
    await runSummaryByRunId(REPO_DIR, RUN_ID, deps);
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode;
  }

  assert.ok(receivedPath.startsWith(REPO_DIR), `path should start with REPO_DIR (${REPO_DIR}); got ${receivedPath}`);
  assert.ok(!receivedPath.includes("/tmp"), `path should not go through /tmp; got ${receivedPath}`);
});

test("runSummaryByRunId: exits non-zero with clear error for summary.json with missing required fields (#261)", async () => {
  // {} is valid JSON but missing harnesses/stages/reviews/overrides/recoveries.
  // Regression: before the fix, printSummary would throw instead of giving a clear error.
  const deps: RunSummaryDeps = {
    latestSummaryForIssue: async () => { throw new Error("should not be called"); },
    readBundle: async () => { throw new Error("should not be called"); },
    readFile: async (_p) => "{}",
  };

  const { errors, exitCode } = await withCapture(() => runSummaryByRunId(REPO_DIR, RUN_ID, deps));

  assert.equal(exitCode, 1, `expected exitCode 1; got ${String(exitCode)}`);
  const combined = errors.join("\n");
  assert.ok(combined.includes("missing required fields"), `error should mention missing fields; got:\n${combined}`);
  assert.ok(combined.includes(RUN_ID), `error should name the run-id; got:\n${combined}`);
});
