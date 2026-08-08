import assert from "node:assert/strict";
import test from "node:test";
import {
  observePullRequest,
  requireGreenChecks,
  resolveLinkedPullRequest,
  validateIndependentReviewProof,
  validateReleasePullRequest,
} from "../lib/github.mjs";
import { validatePublication } from "../lib/controller.mjs";
import { fail, ok } from "./helpers.mjs";

const head = "a".repeat(40);
const actor = "factory-operator";

function reviewComments(reviewBody = "") {
  return [
    { author: actor, body: "## Plan Review\n**Reviewer**: codex" },
    { author: actor, body: `## Review 2\n**Reviewer**: codex\n<!-- reviewed-sha: ${head} -->\n${reviewBody}` },
  ];
}

test("independent Codex review must bind the exact candidate head", () => {
  assert.equal(validateIndependentReviewProof(reviewComments(), { actor, headOid: head }).reviewed_head, head);
  assert.throws(() => validateIndependentReviewProof(reviewComments(), { actor, headOid: "b".repeat(40) }), /candidate head/);
  assert.throws(
    () => validateIndependentReviewProof(reviewComments("Same-harness self-review"), { actor, headOid: head }),
    /candidate head/,
  );
});

test("linked PR resolution requires one same-repository Pipeline PR", () => {
  const pr = {
    number: 44,
    state: "OPEN",
    isDraft: false,
    headRefName: "pipeline/905-change",
    headRefOid: head,
    baseRefName: "main",
    isCrossRepository: false,
    closingIssuesReferences: { nodes: [{ number: 905, repository: { name: "repo", owner: { login: "owner" } } }] },
  };
  assert.equal(resolveLinkedPullRequest([pr], 905, "owner/repo", "main").number, 44);
  const unrelated = {
    ...pr,
    number: 911,
    headRefName: "docs/unrelated",
    closingIssuesReferences: { nodes: [{ number: 891, repository: { name: "repo", owner: { login: "owner" } } }] },
  };
  assert.equal(resolveLinkedPullRequest([pr, unrelated], 905, "owner/repo", "main").number, 44);
  assert.throws(() => resolveLinkedPullRequest([pr, { ...pr, number: 45 }], 905, "owner/repo", "main"), /exactly one/);
});

test("release identity and publication bind exact heads and annotated tag", () => {
  const pr = {
    state: "OPEN",
    is_draft: false,
    base_ref: "main",
    head_ref: "release/v1.33.0",
    head_oid: head,
    title: "release: 1.33.0 — scoped factory",
    body: "## Release: v1.33.0 — scoped factory\nFRG run_id:** `frg-1`",
    files: ["package.json", "core/package.json", ".agent-pipeline/frg/1.33.0/evidence.json"],
  };
  assert.doesNotThrow(() => validateReleasePullRequest(pr, { version: "1.33.0", baseBranch: "main", frgRunId: "frg-1" }));
  assert.throws(() => validateReleasePullRequest({ ...pr, head_ref: "release/v1.34.0" }, { version: "1.33.0", baseBranch: "main", frgRunId: "frg-1" }), /base or head/);
  const proof = validatePublication({
    tagType: "tag",
    peeledOid: head,
    mergeOid: head,
    tag: "v1.33.0",
    release: { tag: "v1.33.0", draft: false, prerelease: false, published_at: "2026-08-08T12:00:00Z", url: "https://example/release" },
  });
  assert.equal(proof.merge_oid, head);
  assert.throws(() => validatePublication({ tagType: "commit", peeledOid: head, mergeOid: head, tag: "v1.33.0", release: {} }), /annotated/);
});

test("release validation sees an unmanaged file after the first 100 PR files", async () => {
  const managedFiles = [
    "package.json",
    "core/package.json",
    ".agent-pipeline/frg/1.33.0/evidence.json",
    ...Array.from({ length: 97 }, (_, index) => `plugin/generated-${index}.mjs`),
  ];
  const calls = [];
  const exec = async (_command, args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return ok(JSON.stringify({
        number: 42,
        state: "OPEN",
        isDraft: false,
        headRefName: "release/v1.33.0",
        headRefOid: head,
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        mergeCommit: null,
        title: "release: 1.33.0 — scoped factory",
        body: "## Release: v1.33.0 — scoped factory\nFRG run_id:** `frg-1`",
        changedFiles: 101,
      }));
    }
    return ok(JSON.stringify([
      managedFiles.map((filename) => ({ filename })),
      [{ filename: "src/unmanaged-on-page-two.mjs" }],
    ]));
  };

  const pr = await observePullRequest(exec, "/usr/bin/gh", "owner/repo", 42);
  assert.equal(pr.files.length, 101);
  assert.equal(pr.files[100], "src/unmanaged-on-page-two.mjs");
  assert.ok(calls[1].includes("--paginate"));
  assert.ok(calls[1].includes("--slurp"));
  assert.throws(
    () => validateReleasePullRequest(pr, { version: "1.33.0", baseBranch: "main", frgRunId: "frg-1" }),
    /unmanaged-on-page-two/,
  );
});

test("PR observation rejects a paginated file result shorter than changedFiles", async () => {
  const exec = async (_command, args) => {
    if (args[0] === "pr") {
      return ok(JSON.stringify({ changedFiles: 101 }));
    }
    return ok(JSON.stringify([
      Array.from({ length: 100 }, (_, index) => ({ filename: `plugin/generated-${index}.mjs` })),
    ]));
  };
  await assert.rejects(
    observePullRequest(exec, "/usr/bin/gh", "owner/repo", 42),
    /returned 100 of 101 changed files/,
  );
});

test("required checks reject a no-required and empty fallback result after a bounded retry", async () => {
  let calls = 0;
  const sleeps = [];
  const exec = async (_command, args) => {
    calls += 1;
    if (args.includes("--required")) return fail("no required checks reported");
    return ok("[]");
  };
  await assert.rejects(
    requireGreenChecks(exec, "/usr/bin/gh", "owner/repo", 42, {
      attempts: 3,
      retryDelayMs: 25,
      sleep: async (ms) => sleeps.push(ms),
    }),
    /did not become green after 3 bounded observations/,
  );
  assert.equal(calls, 6);
  assert.deepEqual(sleeps, [25, 25]);
});

test("required checks accept checks that appear during the bounded observation window", async () => {
  let observation = 0;
  const exec = async (_command, args) => {
    if (args.includes("--required")) return fail("no required checks reported");
    observation += 1;
    return ok(observation === 1 ? "[]" : JSON.stringify([{ name: "ci", bucket: "pass" }]));
  };
  await requireGreenChecks(exec, "/usr/bin/gh", "owner/repo", 42, {
    attempts: 3,
    retryDelayMs: 0,
    sleep: async () => {},
  });
  assert.equal(observation, 2);
});

test("required checks poll pending CI and stop immediately on a terminal failure", async () => {
  let observation = 0;
  const waits = [];
  const exec = async () => {
    observation += 1;
    return ok(JSON.stringify(observation < 3
      ? [{ name: "ci", bucket: "pending" }]
      : [{ name: "ci", bucket: "pass" }]));
  };
  await requireGreenChecks(exec, "/usr/bin/gh", "owner/repo", 42, {
    attempts: 3,
    retryDelayMs: 0,
    sleep: async () => {},
    onWait: async (state) => waits.push(state.state),
  });
  assert.deepEqual(waits, ["pending", "pending"]);

  await assert.rejects(
    requireGreenChecks(async () => ok(JSON.stringify([{ name: "ci", bucket: "fail" }])), "/usr/bin/gh", "owner/repo", 42, {
      attempts: 3,
      retryDelayMs: 0,
      sleep: async () => {},
    }),
    /required checks failed/,
  );
});
