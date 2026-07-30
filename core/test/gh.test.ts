// Unit tests for gh-transient-retry (#270).
// No real gh subprocess calls — all I/O is faked via GhRunOptions seams.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeChangeIdsFromContentsEntries,
  isGithubAuthOrPermissionError,
  isHttp404Signal,
  isTransientGhError,
  shouldTreatContents404AsEmpty,
} from "../scripts/gh.ts";

// ---------------------------------------------------------------------------
// activeChangeIdsFromContentsEntries — pure tip-tree listing parser (#714)
// ---------------------------------------------------------------------------

test("activeChangeIdsFromContentsEntries: dirs only, excludes archive", () => {
  assert.deepEqual(
    activeChangeIdsFromContentsEntries([
      { name: ".gitkeep", type: "file" },
      { name: "archive", type: "dir" },
      { name: "foo", type: "dir" },
      { name: "bar", type: "dir" },
    ]),
    ["bar", "foo"],
  );
});

test("activeChangeIdsFromContentsEntries: empty / non-array → []", () => {
  assert.deepEqual(activeChangeIdsFromContentsEntries([]), []);
  assert.deepEqual(activeChangeIdsFromContentsEntries({ type: "file" }), []);
  assert.deepEqual(activeChangeIdsFromContentsEntries(null), []);
});

// ---------------------------------------------------------------------------
// listPrHeadChangeDirs 404 fail-open guard (#714 delta 4706fcc2)
// ---------------------------------------------------------------------------

test("isHttp404Signal: only explicit HTTP/status 404 syntax", () => {
  assert.equal(isHttp404Signal("HTTP 404: Not Found"), true);
  assert.equal(isHttp404Signal("non-200 OK status code: 404"), true);
  assert.equal(isHttp404Signal("gh api failed: {\"message\":\"Not Found\"}"), false); // no status
  // SHA / command fragment containing "404" must NOT classify as HTTP 404 (#714 aaa27d9c)
  assert.equal(
    isHttp404Signal("gh api failed: HTTP 500 Internal Server Error ref=a404bcafe"),
    false,
  );
  assert.equal(isHttp404Signal("timeout listing contents a404b"), false);
});

test("shouldTreatContents404AsEmpty: HTTP 500 with SHA fragment 404 fails closed", () => {
  assert.equal(
    shouldTreatContents404AsEmpty(
      "gh api repos/x/y/contents/openspec/changes?ref=a404bcafe failed: HTTP 500",
      true,
    ),
    false,
  );
});

test("isHttp404Signal: bare 404 token / SHA fragment is not a status signal (#714 aaa27d9c)", () => {
  // Standalone numeric token without HTTP/status-code wording
  assert.equal(isHttp404Signal("404"), false);
  assert.equal(isHttp404Signal("error: 404 Not Found"), false);
  // HTTP 500 whose message embeds a SHA (or command/ref) containing "404"
  assert.equal(
    isHttp404Signal(
      "HTTP 500: Internal Server Error for repos/acme/r/contents/openspec/changes?ref=a404b1c2d3e4f5",
    ),
    false,
  );
  assert.equal(
    isHttp404Signal("gh api repos/acme/r/git/trees/a404beef -- failed: connection reset"),
    false,
  );
  // Fail-closed path: tip root ok + non-404 that happens to contain "404" must not invent empty set
  assert.equal(
    shouldTreatContents404AsEmpty(
      "HTTP 500: Internal Server Error (ref a404b1c2d3e4f5)",
      true,
    ),
    false,
  );
});

test("isGithubAuthOrPermissionError: 401/403/auth wording", () => {
  assert.equal(isGithubAuthOrPermissionError("HTTP 401: Bad credentials"), true);
  assert.equal(isGithubAuthOrPermissionError("HTTP 403: Resource not accessible by integration"), true);
  assert.equal(isGithubAuthOrPermissionError("authentication required"), true);
  assert.equal(isGithubAuthOrPermissionError("HTTP 404: Not Found"), false);
});

test("shouldTreatContents404AsEmpty: only when tip root ok and 404 not auth-shaped", () => {
  // True path missing on readable tip
  assert.equal(
    shouldTreatContents404AsEmpty("gh api failed: HTTP 404: Not Found", true),
    true,
  );
  // Tip root not listable → never invent empty set
  assert.equal(
    shouldTreatContents404AsEmpty("gh api failed: HTTP 404: Not Found", false),
    false,
  );
  // Auth-shaped must not map to empty even if tipRootListSucceeded (belt + suspenders)
  assert.equal(
    shouldTreatContents404AsEmpty("HTTP 403: Resource not accessible by integration", true),
    false,
  );
  // Non-404 must not map to empty
  assert.equal(
    shouldTreatContents404AsEmpty("HTTP 500: Internal Server Error", true),
    false,
  );
  // Bare "not found" without 404 status must not map to empty (too broad / auth-obscured)
  assert.equal(
    shouldTreatContents404AsEmpty("gh: Not Found", true),
    false,
  );
});

// ---------------------------------------------------------------------------
// isTransientGhError — pure classification
// ---------------------------------------------------------------------------

test("isTransientGhError: HTTP 401 Bad credentials is transient", () => {
  assert.equal(
    isTransientGhError("HTTP 401: Bad credentials (https://api.github.com/graphql)"),
    true,
  );
});

test("isTransientGhError: HTTP 403 rate limit exceeded is transient", () => {
  assert.equal(isTransientGhError("HTTP 403: rate limit exceeded"), true);
});

test("isTransientGhError: HTTP 403 secondary rate limit is transient", () => {
  assert.equal(isTransientGhError("HTTP 403: secondary rate limit triggered"), true);
});

test("isTransientGhError: HTTP 502 Bad Gateway is transient", () => {
  assert.equal(isTransientGhError("HTTP 502: Bad Gateway"), true);
});

test("isTransientGhError: HTTP 500 Internal Server Error is transient", () => {
  assert.equal(isTransientGhError("HTTP 500: Internal Server Error"), true);
});

test("isTransientGhError: HTTP 503 is transient", () => {
  assert.equal(isTransientGhError("HTTP 503: Service Unavailable"), true);
});

test("isTransientGhError: ETIMEDOUT is transient", () => {
  assert.equal(isTransientGhError("ETIMEDOUT"), true);
});

test("isTransientGhError: ECONNRESET is transient", () => {
  assert.equal(isTransientGhError("ECONNRESET"), true);
});

test("isTransientGhError: ENOTFOUND is transient", () => {
  assert.equal(isTransientGhError("ENOTFOUND api.github.com"), true);
});

test("isTransientGhError: socket hang up is transient", () => {
  assert.equal(isTransientGhError("socket hang up"), true);
});

test("isTransientGhError: case-insensitive matching for 401 bad credentials", () => {
  assert.equal(isTransientGhError("http 401: BAD CREDENTIALS"), true);
});

test("isTransientGhError: HTTP 404 Not Found is deterministic", () => {
  assert.equal(isTransientGhError("HTTP 404: Not Found"), false);
});

test("isTransientGhError: HTTP 422 Validation Failed is deterministic", () => {
  assert.equal(isTransientGhError("HTTP 422: Validation Failed"), false);
});

test("isTransientGhError: unrecognized error string is deterministic", () => {
  assert.equal(isTransientGhError("gh: some unrecognized error"), false);
});

test("isTransientGhError: empty string is deterministic", () => {
  assert.equal(isTransientGhError(""), false);
});

test("isTransientGhError: HTTP 403 without rate-limit body is deterministic", () => {
  // A 403 that is not a rate-limit (e.g. repo access denied) should not be retried.
  assert.equal(isTransientGhError("HTTP 403: Forbidden"), false);
});

// ---------------------------------------------------------------------------
// ghRun retry loop — tested via runner/sleep/isTransient seams
//
// ghRun is internal, but the test imports the module and calls it indirectly
// through an exported wrapper that accepts GhRunOptions. We use getIssueLabelEvents
// (which accepts a GhApiRunner seam) for integration-style tests, and we test
// ghRun's retry loop directly by building a minimal exported shim.
//
// Rather than re-exporting ghRun, we test via the already-exported
// getIssueLabelEvents function which delegates to ghRun internally — but that
// only works for the no-retry paths. For the retry-loop tests (4.2–4.5) we use
// a purpose-built exported test helper that exposes GhRunOptions seams.
// ---------------------------------------------------------------------------

// Import the test-only export once it's available. For now we test the retry
// logic by exercising it through a real exported function that passes opts through.
// The cleanest approach: export a thin `ghRunWithOpts` for tests only — but the
// spec doesn't require that. Instead, we rely on the fact that `createIssue` and
// `addIssueComment` accept a `run: GhApiRunner` seam, but that seam bypasses
// the retry logic (the runner is called directly).
//
// To truly test ghRun's retry loop we need to call it. We do this by importing
// via a dynamic workaround: since the module doesn't export ghRun, we test the
// retry semantics at the isTransientGhError + GhRunOptions contract level only,
// and cover the retry loop path indirectly via a purpose-built exported helper.
//
// Per the implementation plan, GhRunOptions is exported and ghRun is the only
// consumer of these seams. We verify the seams work end-to-end by using a
// lightweight exported test wrapper: `ghRunForTest`.

// ---------------------------------------------------------------------------
// ghRunForTest — exported seam-exercising helper for retry-loop tests
// ---------------------------------------------------------------------------

// We cannot directly test ghRun (it's private) and the existing exported wrappers
// like `createIssue`/`getIssueLabelEvents` have their own run seams that bypass
// the retry logic. Export a thin test-only re-export from gh.ts to exercise the
// retry loop:
//
//   export async function ghRunForTest(args: string[], opts: GhRunOptions): Promise<string> {
//     return ghRun(args, opts);
//   }
//
// This is added in gh.ts for this test module. If it's not present, the tests
// below will fail at import time (proving the bite).

import { ghRunForTest, postComment } from "../scripts/gh.ts";
import type { GhRunOptions } from "../scripts/gh.ts";
import type { PipelineConfig } from "../scripts/types.ts";

test("ghRun retry loop: transient 401 fails once then succeeds → returns successfully, 2 invocations", async () => {
  let calls = 0;
  const sleepCalls: number[] = [];

  const runner = async (_args: string[]) => {
    calls++;
    if (calls === 1) {
      const err = new Error("gh failed") as Error & { stderr: string };
      err.stderr = "HTTP 401: Bad credentials (https://api.github.com/graphql)";
      throw err;
    }
    return { stdout: "success" };
  };

  const sleep = async (ms: number) => {
    sleepCalls.push(ms);
  };

  const result = await ghRunForTest(["issue", "view", "1"], { runner, sleep, retries: 3 });
  assert.equal(result, "success");
  assert.equal(calls, 2, "exactly 2 subprocess invocations");
});

test("ghRun retry loop: deterministic 404 is not retried → throws after 1 invocation, sleep never called", async () => {
  let calls = 0;
  let sleepCalled = false;

  const runner = async (_args: string[]) => {
    calls++;
    const err = new Error("gh failed") as Error & { stderr: string };
    err.stderr = "HTTP 404: Not Found";
    throw err;
  };

  const sleep = async (_ms: number) => {
    sleepCalled = true;
  };

  await assert.rejects(
    () => ghRunForTest(["issue", "view", "999"], { runner, sleep, retries: 3 }),
    /404/,
  );
  assert.equal(calls, 1, "exactly 1 invocation — no retries on 404");
  assert.equal(sleepCalled, false, "sleep must never be called for deterministic errors");
});

test("ghRun retry loop: persistent 5xx with retries:2 → throws after 2 invocations, sleep called once", async () => {
  let calls = 0;
  const sleepCalls: number[] = [];

  const runner = async (_args: string[]) => {
    calls++;
    const err = new Error("gh failed") as Error & { stderr: string };
    err.stderr = "HTTP 502: Bad Gateway";
    throw err;
  };

  const sleep = async (ms: number) => {
    sleepCalls.push(ms);
  };

  await assert.rejects(
    () => ghRunForTest(["pr", "view", "1"], { runner, sleep, retries: 2 }),
    /502/,
  );
  assert.equal(calls, 2, "exactly 2 invocations (exhausted retry budget)");
  assert.equal(sleepCalls.length, 1, "sleep called once — between attempt 1 and 2");
});

test("ghRun retry loop: isTransient override returning false prevents retry even on 401 stderr", async () => {
  let calls = 0;
  let sleepCalled = false;

  const runner = async (_args: string[]) => {
    calls++;
    const err = new Error("gh failed") as Error & { stderr: string };
    err.stderr = "HTTP 401: Bad credentials";
    throw err;
  };

  const sleep = async (_ms: number) => {
    sleepCalled = true;
  };

  // Custom override that always says "not transient"
  const isTransient = (_stderr: string) => false;

  await assert.rejects(
    () => ghRunForTest(["api", "graphql"], { runner, sleep, isTransient, retries: 3 }),
    /401/,
  );
  assert.equal(calls, 1, "exactly 1 invocation — override suppressed retry");
  assert.equal(sleepCalled, false, "sleep must not be called when isTransient returns false");
});

test("postComment: retries on transient 401 and succeeds — wrapper-level regression for #270", async () => {
  // Regression: postComment previously passed { retries: 1 } to ghRun, meaning
  // a single transient 401 would abort the run and strand the issue. Verify the
  // fix: postComment must retry and succeed when the first attempt sees a transient error.
  let calls = 0;
  const sleepCalls: number[] = [];

  const runner = async (_args: string[]) => {
    calls++;
    if (calls === 1) {
      const err = new Error("gh failed") as Error & { stderr: string };
      err.stderr = "HTTP 401: Bad credentials (https://api.github.com/graphql)";
      throw err;
    }
    return { stdout: "" };
  };

  const sleep = async (ms: number) => { sleepCalls.push(ms); };
  const cfg = { repo: "owner/repo" } as unknown as PipelineConfig;

  await postComment(cfg, 42, "test body", { runner, sleep });

  assert.equal(calls, 2, "postComment must retry on transient 401 — not abort");
  assert.equal(sleepCalls.length, 1, "exactly one backoff sleep between attempts");
});

test("ghRun retry loop: network-level error (ETIMEDOUT in message, empty stderr) is classified transient", async () => {
  let calls = 0;

  const runner = async (_args: string[]) => {
    calls++;
    if (calls < 3) {
      // Simulate a network error where the error message (not stderr) carries the info
      const err = new Error("ETIMEDOUT");
      throw err;
    }
    return { stdout: "ok" };
  };

  const sleep = async (_ms: number) => {};

  const result = await ghRunForTest(["api", "user"], { runner, sleep, retries: 3 });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});
