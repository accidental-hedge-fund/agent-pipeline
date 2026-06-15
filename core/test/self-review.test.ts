// Unit tests for the same-harness self-review fallback seam (#39).
//
// invokeReviewer is the single point through which every review round (plan-review,
// review-1, review-2) reaches the reviewer harness, so these tests pin the whole
// fallback contract in one place:
//   - reviewer CLI not spawnable  → fall back to the implementer (self-review)
//   - reviewer ran but failed     → NOT a fallback (genuine failure still blocks)
//   - reviewer === implementer    → no pointless fallback to the same missing CLI
//   - both unspawnable            → fallback attempted, surfaces failure to block
//
// `inv` is injected, so no harness is ever spawned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeReviewer, selfReviewBanner } from "../scripts/self-review.ts";
import type { HarnessResult } from "../scripts/harness.ts";
import type { Harness } from "../scripts/types.ts";

const ok = (stdout = '{"verdict":"approve"}'): HarnessResult => ({
  success: true,
  stdout,
  stderr: "",
  exit_code: 0,
  duration: 0.1,
  timed_out: false,
});
// The CLI could not be spawned at all (e.g. not installed) — the #39 trigger.
const spawnErr = (): HarnessResult => ({
  success: false,
  stdout: "",
  stderr: "spawn error: ENOENT",
  exit_code: -1,
  duration: 0,
  timed_out: false,
  spawn_error: true,
});
// The CLI ran but timed out — a genuine failure, NOT a missing CLI.
const timeout = (): HarnessResult => ({
  success: false,
  stdout: "",
  stderr: "",
  exit_code: -1,
  duration: 9,
  timed_out: true,
});
// The CLI ran and exited nonzero — also a genuine failure, not a missing CLI.
const nonzero = (): HarnessResult => ({
  success: false,
  stdout: "partial",
  stderr: "boom",
  exit_code: 1,
  duration: 1,
  timed_out: false,
});

/** Fake `invoke`: returns a per-harness result and records which harnesses ran. */
function fakeInvoke(byHarness: Partial<Record<Harness, HarnessResult>>) {
  const calls: Harness[] = [];
  const inv = async (harness: Harness): Promise<HarnessResult> => {
    calls.push(harness);
    const r = byHarness[harness];
    if (!r) throw new Error(`test fake has no result for harness ${harness}`);
    return r;
  };
  return { inv: inv as unknown as typeof import("../scripts/harness.ts").invoke, calls };
}

test("invokeReviewer: reviewer present → cross-harness review, no fallback", async () => {
  const { inv, calls } = fakeInvoke({ codex: ok() });
  const out = await invokeReviewer("codex", "claude", "/wt", "prompt", {}, inv);
  assert.equal(out.selfReview, false);
  assert.equal(out.effectiveReviewer, "codex");
  assert.equal(out.result.success, true);
  assert.deepEqual(calls, ["codex"], "only the configured reviewer is invoked");
});

test("invokeReviewer: reviewer CLI unspawnable → same-harness self-review by the implementer (#39)", async () => {
  const { inv, calls } = fakeInvoke({ codex: spawnErr(), claude: ok() });
  const out = await invokeReviewer("codex", "claude", "/wt", "prompt", {}, inv);
  assert.equal(out.selfReview, true);
  assert.equal(out.effectiveReviewer, "claude");
  assert.equal(out.result.success, true, "the returned result is the implementer's successful self-review");
  assert.deepEqual(calls, ["codex", "claude"], "reviewer attempted first, then the implementer fallback");
});

test("invokeReviewer: reviewer timed out → NOT a fallback (genuine failure still blocks)", async () => {
  const { inv, calls } = fakeInvoke({ codex: timeout(), claude: ok() });
  const out = await invokeReviewer("codex", "claude", "/wt", "prompt", {}, inv);
  assert.equal(out.selfReview, false, "a timeout is a real failure, not a missing CLI — must not self-review");
  assert.equal(out.effectiveReviewer, "codex");
  assert.equal(out.result.timed_out, true);
  assert.deepEqual(calls, ["codex"], "the implementer must NOT be invoked on a timeout");
});

test("invokeReviewer: reviewer exited nonzero → NOT a fallback", async () => {
  const { inv, calls } = fakeInvoke({ codex: nonzero(), claude: ok() });
  const out = await invokeReviewer("codex", "claude", "/wt", "prompt", {}, inv);
  assert.equal(out.selfReview, false);
  assert.equal(out.effectiveReviewer, "codex");
  assert.deepEqual(calls, ["codex"], "the implementer must NOT be invoked on a nonzero exit");
});

test("invokeReviewer: reviewer === implementer + unspawnable → no pointless fallback, surfaces failure", async () => {
  const { inv, calls } = fakeInvoke({ claude: spawnErr() });
  const out = await invokeReviewer("claude", "claude", "/wt", "prompt", {}, inv);
  assert.equal(out.selfReview, false, "a self-review by the same missing CLI is impossible");
  assert.equal(out.result.spawn_error, true, "the spawn_error surfaces so the caller blocks");
  assert.deepEqual(calls, ["claude"], "exactly one attempt — no fallback to the same harness");
});

test("invokeReviewer: both harnesses unspawnable → fallback attempted, then blocks (spawn_error surfaced)", async () => {
  const { inv, calls } = fakeInvoke({ codex: spawnErr(), claude: spawnErr() });
  const out = await invokeReviewer("codex", "claude", "/wt", "prompt", {}, inv);
  assert.equal(out.selfReview, true, "the fallback was taken (the reviewer was missing)");
  assert.equal(out.effectiveReviewer, "claude");
  assert.equal(out.result.success, false);
  assert.equal(out.result.spawn_error, true, "no harness left to review with → caller's !success branch blocks");
  assert.deepEqual(calls, ["codex", "claude"]);
});

// ---- custom reviewer CLI (#40) ----
//
// `review_harness` lets the reviewer be an arbitrary CLI string, not just a
// built-in harness. invokeReviewer must route that string through the generalized
// invoke() seam, and the #39 fallback still applies when the custom CLI is missing.

/** Fake `invoke` keyed by an arbitrary CLI name (custom reviewers aren't `Harness`). */
function fakeInvokeByName(byName: Record<string, HarnessResult>) {
  const calls: string[] = [];
  const inv = async (harness: string): Promise<HarnessResult> => {
    calls.push(harness);
    const r = byName[harness];
    if (!r) throw new Error(`test fake has no result for harness ${harness}`);
    return r;
  };
  return { inv: inv as unknown as typeof import("../scripts/harness.ts").invoke, calls };
}

test("invokeReviewer: a custom reviewer CLI that succeeds → no fallback, effectiveReviewer is the custom CLI (#40)", async () => {
  const { inv, calls } = fakeInvokeByName({ "my-reviewer": ok() });
  const out = await invokeReviewer("my-reviewer", "claude", "/wt", "prompt", {}, inv);
  assert.equal(out.selfReview, false);
  assert.equal(out.effectiveReviewer, "my-reviewer");
  assert.equal(out.result.success, true);
  assert.deepEqual(calls, ["my-reviewer"], "only the custom reviewer is invoked when it succeeds");
});

test("invokeReviewer: a custom reviewer CLI that is unspawnable → same-harness fallback to the implementer (#40)", async () => {
  const { inv, calls } = fakeInvokeByName({ "my-reviewer": spawnErr(), claude: ok() });
  const out = await invokeReviewer("my-reviewer", "claude", "/wt", "prompt", {}, inv);
  assert.equal(out.selfReview, true, "a missing custom reviewer CLI triggers the #39 fallback");
  assert.equal(out.effectiveReviewer, "claude");
  assert.equal(out.result.success, true, "the returned result is the implementer's successful self-review");
  assert.deepEqual(calls, ["my-reviewer", "claude"], "custom reviewer attempted first, then the implementer fallback");
});

test("invokeReviewer: custom reviewer + fallback both fail → result.stderr contains both errors (#40 finding 1)", async () => {
  // Simulate the real harness.ts behaviour: custom reviewer's spawn error gets the
  // actionable CLI message prepended; the implementer fallback gets its own message.
  const configuredErr = {
    ...spawnErr(),
    stderr: "reviewer CLI 'my-reviewer' not found or not executable — ensure it is installed and on PATH\nspawn error: ENOENT",
  };
  const fallbackErr = {
    ...spawnErr(),
    stderr: "[harness claude] spawn error: ENOENT",
  };
  const { inv, calls } = fakeInvokeByName({ "my-reviewer": configuredErr, claude: fallbackErr });
  const out = await invokeReviewer("my-reviewer", "claude", "/wt", "prompt", {}, inv);
  assert.equal(out.selfReview, true, "fallback was attempted");
  assert.equal(out.effectiveReviewer, "claude");
  assert.equal(out.result.spawn_error, true, "double-failure: no harness left to review with");
  // Both error messages must appear so callers can surface them in the blocked message.
  assert.match(out.result.stderr, /my-reviewer/, "configured reviewer error present in merged stderr");
  assert.match(out.result.stderr, /claude/, "fallback error present in merged stderr");
  assert.deepEqual(calls, ["my-reviewer", "claude"]);
});

test("selfReviewBanner: names the missing reviewer and the effective reviewer, marks it weaker", () => {
  const banner = selfReviewBanner("codex", "claude");
  assert.match(banner, /self-review/i);
  assert.match(banner, /codex/, "names the missing cross-harness reviewer");
  assert.match(banner, /claude/, "names the implementing harness that reviewed");
  assert.match(banner, /weaker/i, "states a self-review is weaker than an independent review");
});
