// Unit tests for gh-transient-retry (#270).
// No real gh subprocess calls — all I/O is faked via GhRunOptions seams.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeChangeIdsFromContentsEntries,
  ghChildEnv,
  isGithubAuthOrPermissionError,
  isHttp404Signal,
  isPrDiffTooLargeError,
  isTransientGhError,
  deleteIssueComment,
  listIssueCommentsWithIds,
  shouldTreatContents404AsEmpty,
  updateIssueComment,
} from "../scripts/gh.ts";
import type { PipelineConfig } from "../scripts/types.ts";

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
// ghChildEnv — uncolored child env for machine-readable gh --json (#762 recovery)
// ---------------------------------------------------------------------------

test("ghChildEnv: forces NO_COLOR and clears FORCE_COLOR/CLICOLOR from host env", () => {
  const env = ghChildEnv({
    PATH: "/usr/bin",
    FORCE_COLOR: "1",
    CLICOLOR: "1",
    CLICOLOR_FORCE: "1",
    NO_COLOR: "",
    GH_TOKEN: "secret",
  });
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.FORCE_COLOR, "0");
  assert.equal(env.CLICOLOR, "0");
  assert.equal(env.CLICOLOR_FORCE, "0");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GH_TOKEN, "secret", "parent credentials and PATH must be preserved");
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

import { getPrChecks, getPrDiff, ghRunForTest, postComment } from "../scripts/gh.ts";
import type { GhRunOptions } from "../scripts/gh.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import { diffFilePaths } from "../scripts/stages/review-parsing.ts";

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

// ---------------------------------------------------------------------------
// getPrChecks — "no checks reported" normalizes to [] (#882)
// ---------------------------------------------------------------------------

test("getPrChecks: gh 'no checks reported' non-zero exit → empty array (#882)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  let calls = 0;
  const runner = async (_args: string[]) => {
    calls++;
    const err = new Error("Command failed: gh pr checks") as Error & { stderr: string };
    err.stderr = "no checks reported on the 'feature/x' branch";
    throw err;
  };
  const result = await getPrChecks(cfg, 883, { runner, retries: 1 });
  assert.deepEqual(result, []);
  assert.equal(calls, 1, "no retries for deterministic empty-check result");
});

test("getPrChecks: unrelated gh failure still throws (#882)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const runner = async (_args: string[]) => {
    const err = new Error("Command failed: gh pr checks") as Error & { stderr: string };
    err.stderr = "HTTP 401: authentication required";
    throw err;
  };
  await assert.rejects(
    () => getPrChecks(cfg, 883, { runner, retries: 1 }),
    /401|authentication/i,
  );
});

test("getPrChecks: successful JSON stdout parses check runs (#882)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const runner = async (_args: string[]) => ({
    stdout: JSON.stringify([
      { name: "test", state: "COMPLETED", bucket: "pass", description: "", link: "" },
    ]),
  });
  const result = await getPrChecks(cfg, 42, { runner, retries: 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "test");
  assert.equal(result[0].bucket, "pass");
});

// ---------------------------------------------------------------------------
// getPrDiff — 406 / too-large files-API fallback (#1223)
// ---------------------------------------------------------------------------

const LIVE_PR_DIFF_TOO_LARGE_STDERR =
  "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead. (https://api.github.com/repos/accidental-hedge-fund/agent-pipeline/pulls/1222)\nPullRequest.diff too_large";

const SMALL_PR_DIFF = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

function throwGh(stderr: string): never {
  const err = new Error("gh failed") as Error & { stderr: string };
  err.stderr = stderr;
  throw err;
}

function blobStdout(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const wrapped = b64.match(/.{1,60}/g)?.join("\n") ?? b64;
  return JSON.stringify({ content: wrapped, encoding: "base64", size: text.length });
}

function isPrDiffArgs(args: string[]): boolean {
  return args[0] === "pr" && args[1] === "diff";
}

function isFilesListArgs(args: string[]): boolean {
  return args[0] === "api" && typeof args[1] === "string" && args[1].includes("/files");
}

function isPrRevisionArgs(args: string[]): boolean {
  return args[0] === "api" && typeof args[1] === "string" && /\/pulls\/\d+$/.test(args[1]);
}

function stablePrRevision(headSha = "headsha", baseSha = "basesha"): { stdout: string } {
  return { stdout: JSON.stringify({ base: { sha: baseSha }, head: { sha: headSha } }) };
}

test("isPrDiffTooLargeError: live PR #1222 stderr, status syntax, and wording (#1223)", () => {
  assert.equal(isPrDiffTooLargeError(LIVE_PR_DIFF_TOO_LARGE_STDERR), true);
  assert.equal(isPrDiffTooLargeError("non-200 OK status code: 406"), true);
  assert.equal(isPrDiffTooLargeError("status code 406"), true);
  assert.equal(
    isPrDiffTooLargeError("gh: the diff is too large; use the files API"),
    true,
  );
  assert.equal(isPrDiffTooLargeError("PullRequest.diff too_large"), true);
  assert.equal(isTransientGhError(LIVE_PR_DIFF_TOO_LARGE_STDERR), false);
});

test("isPrDiffTooLargeError: bare 406 / SHA fragment / 404 are not too-large (#1223)", () => {
  assert.equal(isPrDiffTooLargeError("406"), false);
  assert.equal(isPrDiffTooLargeError("error: 406 Not Found"), false);
  assert.equal(isPrDiffTooLargeError("a406bcafe"), false);
  assert.equal(isPrDiffTooLargeError("HTTP 404: Not Found"), false);
  assert.equal(
    isPrDiffTooLargeError("HTTP 500: Internal Server Error ref=a406bcafe"),
    false,
  );
});

test("getPrDiff: HTTP 406 falls back to files-list composed diff (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const calls: string[][] = [];
  const patch = "@@ -1,1 +1,1 @@\n-old\n+new\n";
  const runner = async (args: string[]) => {
    calls.push(args);
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isPrRevisionArgs(args)) return stablePrRevision();
    if (isFilesListArgs(args)) {
      return {
        stdout: JSON.stringify([
          [
            { filename: "src/a.ts", status: "modified", sha: "aaa", additions: 1, deletions: 1, changes: 2, patch },
            { filename: "bin/empty.dat", status: "modified", sha: "bbb", additions: 0, deletions: 0, changes: 0 },
          ],
        ]),
      };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };

  const result = await getPrDiff(cfg, 1222, { runner, retries: 1 });
  assert.match(result, /^diff --git a\/src\/a\.ts b\/src\/a\.ts/m);
  assert.match(result, /^diff --git a\/bin\/empty\.dat b\/bin\/empty\.dat/m);
  assert.ok(result.includes(patch.trim()), "supplied patch text must appear under its header");
  assert.equal(calls.filter(isPrDiffArgs).length, 1, "pr diff must run once (406 is not retried)");
  const filesCall = calls.find(isFilesListArgs);
  assert.ok(filesCall, "files API must be called after 406");
  assert.equal(filesCall![1], "repos/acme/widget/pulls/1222/files?per_page=100");
  assert.ok(filesCall!.includes("--paginate"));
  assert.ok(filesCall!.includes("--slurp"));
  assert.ok(calls.every((args) => args[0] !== "git"), "fallback must not invoke local git");
  assert.deepEqual(diffFilePaths(result).sort(), ["bin/empty.dat", "src/a.ts"]);
});

test("getPrDiff: small unified diff uses the fast path only (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    if (isPrDiffArgs(args)) return { stdout: SMALL_PR_DIFF };
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  const result = await getPrDiff(cfg, 42, { runner, retries: 1 });
  assert.equal(result, SMALL_PR_DIFF);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["pr", "diff", "42", "-R", "acme/widget"]);
  assert.equal(calls.filter(isFilesListArgs).length, 0);
});

test("getPrDiff: HTTP 404 still throws and does not call the files list (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    if (isPrDiffArgs(args)) throwGh("HTTP 404: Not Found");
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  await assert.rejects(() => getPrDiff(cfg, 99, { runner, retries: 1 }), /404/);
  assert.equal(calls.filter(isPrDiffArgs).length, 1);
  assert.equal(calls.filter(isFilesListArgs).length, 0);
});

test("getPrDiff: SHA fragment 406 is not too-large and does not hit files API (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    if (isPrDiffArgs(args)) throwGh("HTTP 500: Internal Server Error ref=a406bcafe");
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  assert.equal(isPrDiffTooLargeError("HTTP 500: Internal Server Error ref=a406bcafe"), false);
  await assert.rejects(() => getPrDiff(cfg, 7, { runner, retries: 1 }), /a406bcafe/);
  assert.equal(calls.filter(isFilesListArgs).length, 0);
});

test("getPrDiff: patch-less binary/zero-change file still emits a path header (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const runner = async (args: string[]) => {
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isPrRevisionArgs(args)) return stablePrRevision();
    if (isFilesListArgs(args)) {
      return {
        stdout: JSON.stringify([[
          { filename: "bin/app.bin", status: "modified", sha: "ccc", additions: 0, deletions: 0, changes: 0 },
        ]]),
      };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  const result = await getPrDiff(cfg, 8, { runner, retries: 1 });
  assert.match(result, /^diff --git a\/bin\/app\.bin b\/bin\/app\.bin/m);
  assert.deepEqual(diffFilePaths(result), ["bin/app.bin"]);
});

test("getPrDiff: omitted removed text is materialized from the git blob (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const calls: string[][] = [];
  const sourceLine = "export const DEFAULT_TIMEOUT_MS = 30_000;";
  const runner = async (args: string[]) => {
    calls.push(args);
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isPrRevisionArgs(args)) return stablePrRevision();
    if (isFilesListArgs(args)) {
      return {
        stdout: JSON.stringify([[
          {
            filename: "src/big.ts",
            status: "removed",
            sha: "deletedblob",
            additions: 0,
            deletions: 12,
            changes: 12,
          },
        ]]),
      };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/git/blobs/deletedblob") {
      return { stdout: blobStdout(`${sourceLine}\n`) };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  const result = await getPrDiff(cfg, 1222, { runner, retries: 1 });
  assert.match(result, /^diff --git a\/src\/big\.ts b\/src\/big\.ts/m);
  assert.ok(result.includes(`-${sourceLine}`), "deleted source must appear as a unified-diff minus line");
  assert.ok(calls.every((args) => args[0] !== "git"), "materialization must not invoke local git");
  assert.equal(calls.filter(isPrDiffArgs).length, 1);
});

test("getPrDiff: omitted text blob failure throws naming the path (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const runner = async (args: string[]) => {
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isPrRevisionArgs(args)) return stablePrRevision();
    if (isFilesListArgs(args)) {
      return {
        stdout: JSON.stringify([[
          { filename: "src/big.ts", status: "removed", sha: "deletedblob", additions: 0, deletions: 8, changes: 8 },
        ]]),
      };
    }
    if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("/git/blobs/")) {
      throwGh("HTTP 404: Not Found");
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  await assert.rejects(
    () => getPrDiff(cfg, 1222, { runner, retries: 1 }),
    /src\/big\.ts/,
  );
});

test("getPrDiff: flattened list of 3000 files throws the files-list cap (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const runner = async (args: string[]) => {
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isPrRevisionArgs(args)) return stablePrRevision();
    if (isFilesListArgs(args)) {
      const files = Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}.ts` }));
      return { stdout: JSON.stringify([files]) };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  await assert.rejects(
    () => getPrDiff(cfg, 9, { runner, retries: 1 }),
    /3000/,
  );
});

test("getPrDiff: multi-page slurp flatten includes every file header (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const runner = async (args: string[]) => {
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isPrRevisionArgs(args)) return stablePrRevision();
    if (isFilesListArgs(args)) {
      return {
        stdout: JSON.stringify([
          [{ filename: "src/a.ts", status: "modified", sha: "a", additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+a\n" }],
          [{ filename: "src/b.ts", status: "modified", sha: "b", additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+b\n" }],
        ]),
      };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  const result = await getPrDiff(cfg, 10, { runner, retries: 1 });
  assert.ok(result.includes("diff --git a/src/a.ts b/src/a.ts"));
  assert.ok(result.includes("diff --git a/src/b.ts b/src/b.ts"));
  assert.deepEqual(diffFilePaths(result).sort(), ["src/a.ts", "src/b.ts"]);
});

test("getPrDiff: rename uses previous_filename on the a/ side (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const runner = async (args: string[]) => {
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isPrRevisionArgs(args)) return stablePrRevision();
    if (isFilesListArgs(args)) {
      return {
        stdout: JSON.stringify([[
          {
            filename: "new.ts",
            previous_filename: "old.ts",
            status: "renamed",
            sha: "r1",
            additions: 0,
            deletions: 0,
            changes: 0,
          },
        ]]),
      };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  const result = await getPrDiff(cfg, 11, { runner, retries: 1 });
  assert.ok(result.includes("diff --git a/old.ts b/new.ts"));
  assert.deepEqual(diffFilePaths(result), ["new.ts"]);
});

test("getPrDiff: space-containing path stays parseable by diffFilePaths (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const runner = async (args: string[]) => {
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isPrRevisionArgs(args)) return stablePrRevision();
    if (isFilesListArgs(args)) {
      return {
        stdout: JSON.stringify([[
          {
            filename: "foo bar.ts",
            status: "modified",
            sha: "s1",
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: "@@ -1 +1 @@\n-a\n+b\n",
          },
        ]]),
      };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  const result = await getPrDiff(cfg, 12, { runner, retries: 1 });
  assert.ok(result.includes("diff --git a/foo bar.ts b/foo bar.ts"));
  assert.deepEqual(diffFilePaths(result), ["foo bar.ts"]);
});

test("getPrDiff: invalid files-list JSON after 406 throws (not empty string) (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const runner = async (args: string[]) => {
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isPrRevisionArgs(args)) return stablePrRevision();
    if (isFilesListArgs(args)) return { stdout: "not-json" };
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  await assert.rejects(
    () => getPrDiff(cfg, 15, { runner, retries: 1 }),
    /invalid JSON from files API/,
  );
});

test("getPrDiff: empty files list after 406 throws (not empty string) (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const runner = async (args: string[]) => {
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isPrRevisionArgs(args)) return stablePrRevision();
    if (isFilesListArgs(args)) return { stdout: JSON.stringify([[]]) };
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  await assert.rejects(
    () => getPrDiff(cfg, 16, { runner, retries: 1 }),
    /empty files list/,
  );
});

test("getPrDiff: files-list failure after 406 throws (not empty string) (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const runner = async (args: string[]) => {
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isPrRevisionArgs(args)) return stablePrRevision();
    if (isFilesListArgs(args)) throwGh("HTTP 403: Resource not accessible by integration");
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  await assert.rejects(
    () => getPrDiff(cfg, 13, { runner, retries: 1 }),
    /Resource not accessible|403/,
  );
});

test("getPrDiff: omitted modified text materializes a replacement hunk (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isFilesListArgs(args)) {
      return {
        stdout: JSON.stringify([[
          {
            filename: "src/changed.ts",
            status: "modified",
            sha: "newblob",
            additions: 1,
            deletions: 1,
            changes: 2,
          },
        ]]),
      };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/pulls/14") {
      return { stdout: JSON.stringify({ base: { sha: "basesha" }, head: { sha: "headsha" } }) };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/compare/basesha...headsha") {
      return { stdout: JSON.stringify({ merge_base_commit: { sha: "basesha" } }) };
    }
    if (args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("repos/acme/widget/contents/src/changed.ts")) {
      return { stdout: JSON.stringify({ sha: "oldblob" }) };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/git/blobs/newblob") {
      return { stdout: blobStdout("new line\n") };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/git/blobs/oldblob") {
      return { stdout: blobStdout("old line\n") };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  const result = await getPrDiff(cfg, 14, { runner, retries: 1 });
  assert.ok(result.includes("diff --git a/src/changed.ts b/src/changed.ts"));
  assert.ok(result.includes("-old line"));
  assert.ok(result.includes("+new line"));
  assert.ok(calls.every((args) => args[0] !== "git"));
});

test("getPrDiff: omitted modified hunk uses merge-base, not base tip (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isFilesListArgs(args)) {
      return {
        stdout: JSON.stringify([[
          {
            filename: "src/changed.ts",
            status: "modified",
            sha: "newblob",
            additions: 1,
            deletions: 1,
            changes: 2,
          },
        ]]),
      };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/pulls/17") {
      return {
        stdout: JSON.stringify({
          base: { sha: "basetip" },
          head: { sha: "prhead" },
        }),
      };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/compare/basetip...prhead") {
      return { stdout: JSON.stringify({ merge_base_commit: { sha: "mergebase" } }) };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/contents/src/changed.ts?ref=mergebase") {
      return { stdout: JSON.stringify({ sha: "mergeblob" }) };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/contents/src/changed.ts?ref=basetip") {
      return { stdout: JSON.stringify({ sha: "tipblob" }) };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/git/blobs/newblob") {
      return { stdout: blobStdout("from-pr-head\n") };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/git/blobs/mergeblob") {
      return { stdout: blobStdout("from-merge-base\n") };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/git/blobs/tipblob") {
      return { stdout: blobStdout("from-base-tip\n") };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  const result = await getPrDiff(cfg, 17, { runner, retries: 1 });
  assert.ok(result.includes("-from-merge-base"), "old side must be the merge-base blob");
  assert.ok(result.includes("+from-pr-head"), "new side must be the files-list blob");
  assert.equal(result.includes("from-base-tip"), false, "base-tip blob must not appear in the hunk");
  const contentsCalls = calls.filter(
    (args) => args[0] === "api" && typeof args[1] === "string" && args[1].includes("/contents/"),
  );
  assert.equal(contentsCalls.length, 1);
  assert.equal(contentsCalls[0][1], "repos/acme/widget/contents/src/changed.ts?ref=mergebase");
  assert.ok(
    calls.some((args) => args[0] === "api" && args[1] === "repos/acme/widget/compare/basetip...prhead"),
    "merge-base must come from compare of captured base/head SHAs",
  );
  assert.ok(calls.every((args) => args[0] !== "git"));
});

test("getPrDiff: H1→H2 files/head race retries and composes the stable H2 pair (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const calls: string[][] = [];
  const events: string[] = [];
  let filesListCount = 0;
  const runner = async (args: string[]) => {
    calls.push(args);
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isFilesListArgs(args)) {
      events.push("files");
      filesListCount += 1;
      const sha = filesListCount === 1 ? "h1blob" : "h2blob";
      return {
        stdout: JSON.stringify([[
          {
            filename: "src/changed.ts",
            status: "modified",
            sha,
            additions: 1,
            deletions: 1,
            changes: 2,
          },
        ]]),
      };
    }
    if (isPrRevisionArgs(args)) {
      events.push("pr");
      const head = events.includes("files") ? "h2" : "h1";
      return { stdout: JSON.stringify({ base: { sha: "base" }, head: { sha: head } }) };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/compare/base...h1") {
      return { stdout: JSON.stringify({ merge_base_commit: { sha: "mb1" } }) };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/compare/base...h2") {
      return { stdout: JSON.stringify({ merge_base_commit: { sha: "mb2" } }) };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/contents/src/changed.ts?ref=mb1") {
      return { stdout: JSON.stringify({ sha: "old1" }) };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/contents/src/changed.ts?ref=mb2") {
      return { stdout: JSON.stringify({ sha: "old2" }) };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/git/blobs/h1blob") {
      return { stdout: blobStdout("from-h1\n") };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/git/blobs/h2blob") {
      return { stdout: blobStdout("from-h2\n") };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/git/blobs/old1") {
      return { stdout: blobStdout("old-h1\n") };
    }
    if (args[0] === "api" && args[1] === "repos/acme/widget/git/blobs/old2") {
      return { stdout: blobStdout("old-h2\n") };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };

  const result = await getPrDiff(cfg, 18, { runner, retries: 1 });
  assert.ok(result.includes("-old-h2"), "old side must be the stable H2 merge-base");
  assert.ok(result.includes("+from-h2"), "new side must be the stable H2 files-list blob");
  assert.equal(result.includes("from-h1"), false, "must not compose H1 blob SHAs with an H2 merge-base");
  assert.equal(result.includes("old-h1"), false, "must not use the H1 merge-base after the head moved");
  assert.ok(filesListCount >= 2, "must retry files-list collection after H1→H2");
  assert.equal(
    calls.some((a) => a[0] === "api" && a[1] === "repos/acme/widget/compare/base...h1"),
    false,
    "must not derive merge-base from the pre-push H1 pair",
  );
  assert.ok(
    calls.some((a) => a[0] === "api" && a[1] === "repos/acme/widget/compare/base...h2"),
    "merge-base must come from the pinned H2 pair",
  );
  assert.ok(calls.every((args) => args[0] !== "git"));
});

test("getPrDiff: files-list fallback fails closed if the PR keeps moving (#1223)", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  let filesListCount = 0;
  const runner = async (args: string[]) => {
    if (isPrDiffArgs(args)) throwGh(LIVE_PR_DIFF_TOO_LARGE_STDERR);
    if (isFilesListArgs(args)) {
      filesListCount += 1;
      return {
        stdout: JSON.stringify([[
          {
            filename: "src/changed.ts",
            status: "modified",
            sha: `blob${filesListCount}`,
            additions: 1,
            deletions: 1,
            changes: 2,
          },
        ]]),
      };
    }
    if (isPrRevisionArgs(args)) {
      const head = `h${filesListCount + 1}`;
      return { stdout: JSON.stringify({ base: { sha: "base" }, head: { sha: head } }) };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  await assert.rejects(
    () => getPrDiff(cfg, 19, { runner, retries: 1 }),
    /moved during files-list fallback/,
  );
  assert.equal(filesListCount, 3, "must exhaust the bounded pin attempts then fail closed");
});

test("listIssueCommentsWithIds: parses REST numeric ids via injected runner", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const seen: string[][] = [];
  const comments = await listIssueCommentsWithIds(cfg, 1238, async (args) => {
    seen.push(args);
    return JSON.stringify([
      { id: 5433321980, body: "hello", user: { login: "alice" }, created_at: "2026-08-27T01:48:10Z" },
    ]);
  });
  assert.equal(seen[0][0], "api");
  assert.ok(String(seen[0][1]).includes("issues/1238/comments"));
  assert.ok(seen[0].includes("--paginate"));
  assert.ok(seen[0].includes("--slurp"));
  assert.equal(comments[0].id, 5433321980);
  assert.equal(comments[0].author, "alice");
});

test("listIssueCommentsWithIds: flattens --paginate --slurp multi-page arrays", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const comments = await listIssueCommentsWithIds(cfg, 1238, async () =>
    JSON.stringify([
      [{ id: 1, body: "page-1", user: { login: "alice" }, created_at: "2026-08-27T01:00:00Z" }],
      [{ id: 2, body: "page-2", user: { login: "bob" }, created_at: "2026-08-27T01:01:00Z" }],
    ]),
  );
  assert.equal(comments.length, 2);
  assert.equal(comments[0].id, 1);
  assert.equal(comments[0].author, "alice");
  assert.equal(comments[1].id, 2);
  assert.equal(comments[1].author, "bob");
});

test("updateIssueComment: PATCHes REST numeric id via injected runner", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const seen: string[][] = [];
  await updateIssueComment(cfg, 5433321980, "new body", async (args) => {
    seen.push(args);
    return "{}";
  });
  assert.equal(seen[0].includes("PATCH"), true);
  assert.ok(String(seen[0].join(" ")).includes("issues/comments/5433321980"));
  assert.ok(seen[0].some((a) => a.startsWith("body=")));
});

test("deleteIssueComment: DELETEs REST numeric id via injected runner", async () => {
  const cfg = { repo: "acme/widget" } as PipelineConfig;
  const seen: string[][] = [];
  await deleteIssueComment(cfg, 5433321980, async (args) => {
    seen.push(args);
    return "";
  });
  assert.equal(seen[0].includes("DELETE"), true);
  assert.ok(String(seen[0].join(" ")).includes("issues/comments/5433321980"));
});
