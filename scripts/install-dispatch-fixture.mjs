import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

import { resolveEnginesNode } from "./ensure-engines-node.mjs";

/**
 * Build an offline repository plus deterministic `node`/`gh` shims for installed
 * launcher smoke tests. Both the root installer suite and CI smoke use this
 * fixture so they exercise the same doctor/status contract.
 */
export function makeInstalledDispatchFixture(root, { nodePath = process.execPath } = {}) {
  const repoDir = join(root, `dispatch-repo-${basename(root)}`);
  const domain = basename(repoDir);
  const fakeBin = join(root, "dispatch-bin");
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  mkdirSync(join(repoDir, ".github"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  const enginesNode = resolveEnginesNode();
  if (!enginesNode) {
    throw new Error("installed dispatch fixture requires a Node binary that satisfies the engines floor");
  }
  const fakeNode = join(fakeBin, "node");
  symlinkSync(enginesNode.path, fakeNode);

  writeFileSync(
    join(repoDir, ".github", "pipeline.yml"),
    "repo: example/repo\n" +
      "harnesses:\n" +
      "  implementer: claude\n" +
      "  reviewer: codex\n" +
      "openspec:\n" +
      "  enabled: off\n" +
      "doctor:\n" +
      "  runOnStart: false\n",
  );

  const git = (args) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`dispatch fixture git ${args.join(" ")} failed: ${result.stderr}`);
    }
  };
  git(["init", "-q", "-b", "feat/installed-dispatch", repoDir]);
  git(["-C", repoDir, "add", ".github/pipeline.yml"]);
  git([
    "-C",
    repoDir,
    "-c",
    "user.name=Pipeline Fixture",
    "-c",
    "user.email=pipeline-fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "fixture",
  ]);

  const fakeClaude = join(fakeBin, "claude");
  writeFileSync(
    fakeClaude,
    `#!${nodePath}
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "auth" && args[1] === "status" && args[2] === "--json") {
  process.stdout.write(JSON.stringify({ loggedIn: true }) + "\\n");
  process.exit(0);
}
process.exit(97);
`,
  );
  chmodSync(fakeClaude, 0o755);

  const fakeCodex = join(fakeBin, "codex");
  writeFileSync(
    fakeCodex,
    `#!${nodePath}
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "login" && args[1] === "status") process.exit(0);
process.exit(97);
`,
  );
  chmodSync(fakeCodex, 0o755);

  const fakeGh = join(fakeBin, "gh");
  writeFileSync(
    fakeGh,
    `#!${nodePath}
const args = process.argv.slice(2);
const ok = (value = "") => {
  if (value) process.stdout.write(value.endsWith("\\n") ? value : value + "\\n");
  process.exit(0);
};
if (args[0] === "--version") ok("gh version 2.99.0");
if (args[0] === "auth" && args[1] === "status") ok("authenticated");
if (args[0] === "repo" && args[1] === "view") ok("example/repo");
if (args[0] === "release" && args[1] === "view") ok(JSON.stringify({ tagName: "v1.39.15" }));
if (args[0] === "api" && args[1] === "/repos/example/repo/issues/1") ok("issue");
if (args[0] === "issue" && args[1] === "view" && args[2] === "1") {
  ok(JSON.stringify({
    number: 1,
    title: "Installed status fixture",
    body: "",
    state: "OPEN",
    url: "https://github.com/example/repo/issues/1",
    labels: [{ name: "pipeline:ready" }],
    comments: [],
  }));
}
if (args[0] === "api" && args[1] === "graphql" && args.includes("--jq")) ok();
if (args[0] === "api" && args[1] === "graphql") {
  ok(JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  }));
}
process.stderr.write("unsupported fake gh call: " + JSON.stringify(args) + "\\n");
process.exit(97);
`,
  );
  chmodSync(fakeGh, 0o755);

  return { repoDir, domain, fakeBin, fakeNode };
}
