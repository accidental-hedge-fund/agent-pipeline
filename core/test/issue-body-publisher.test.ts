import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  IssueBodyPublicationError,
  publishIssueBody,
  publishIssueBodyOrThrow,
  type IssueBodyPublisherDeps,
} from "../scripts/issue-body-publisher.ts";

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("large generated issue body is delivered through stdin and never argv (#1454)", () => {
  const body = `# Decisions\n\n${"evidence\n".repeat(200_000)}`;
  let argv: readonly string[] = [];
  let stdin = "";
  const deps: IssueBodyPublisherDeps = {
    spawn: (_command, args, options) => {
      argv = args;
      stdin = options.input;
      return { status: 0 };
    },
  };
  const result = publishIssueBody(
    { repo: "owner/repo", repoDir: "/repo", issueNumber: 1454, body },
    deps,
  );
  assert.deepEqual(result, { acknowledged: true });
  assert.deepEqual(argv, ["issue", "edit", "1454", "-R", "owner/repo", "--body-file", "-"]);
  assert.equal(argv.includes(body), false);
  assert.equal(stdin, body);
});

test("null-status OS failure is typed as spawn failure with bounded diagnostics (#1454)", () => {
  const error = Object.assign(new Error(`spawn ENOENT ${"x".repeat(2000)}`), { code: "ENOENT" });
  const deps: IssueBodyPublisherDeps = {
    spawn: () => ({ status: null, error }),
  };
  const result = publishIssueBody(
    { repo: "owner/repo", repoDir: "/repo", issueNumber: 1454, body: "body" },
    deps,
  );
  assert.equal(result.acknowledged, false);
  if (!result.acknowledged) {
    assert.equal(result.kind, "spawn_failure");
    assert.equal(result.exitCode, null);
    assert.match(result.diagnostic, /spawn ENOENT/);
    assert.ok(result.diagnostic.length <= 1000);
    assert.doesNotMatch(result.diagnostic, /exit null/);
  }
  assert.throws(
    () => publishIssueBodyOrThrow(
      { repo: "owner/repo", repoDir: "/repo", issueNumber: 1454, body: "body" },
      deps,
    ),
    (thrown) => thrown instanceof IssueBodyPublicationError && thrown.kind === "spawn_failure",
  );
});

test("null-status broken stdin is typed separately from GitHub rejection", () => {
  const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const result = publishIssueBody(
    { repo: "owner/repo", repoDir: "/repo", issueNumber: 1454, body: "body" },
    { spawn: () => ({ status: null, error }) },
  );
  assert.equal(result.acknowledged, false);
  if (!result.acknowledged) assert.equal(result.kind, "stdin_failure");
});

test("all production grill body writers use the shared non-argv publisher (#1454)", () => {
  const routes = [
    ["scripts/stages/grill.ts", "updateIssueBody: async"],
    ["scripts/grill-issue.ts", "updateIssueBody: async"],
    ["scripts/pipeline.ts", "const out = await materializeGrillAnswer"],
  ] as const;
  for (const [relative, anchor] of routes) {
    const source = readFileSync(join(CORE_ROOT, relative), "utf8");
    const start = source.indexOf(anchor);
    assert.notEqual(start, -1, `${relative} must retain the ${anchor} route`);
    const route = source.slice(start, start + 1_500);
    assert.match(route, /publishIssueBodyOrThrow\(/, relative);
    assert.doesNotMatch(route, /\[\s*["']--body["']\s*,\s*body\s*\]/, relative);
  }
});
