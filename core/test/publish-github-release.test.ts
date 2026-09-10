// Publisher-boundary helper used by release.yml (#1563).
// Injected command/file seams only — no real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCanonicalReleaseTag,
  publishGithubRelease,
  runPublishGithubReleaseCli,
  type CommandResult,
  type PublishGithubReleaseDeps,
} from "../scripts/publish-github-release.ts";
import { releaseTagNotes } from "../scripts/stages/release-complete.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(__dirname, "../../.github/workflows/release.yml");
const HELPER = "core/scripts/publish-github-release.ts";
const TAG = "v1.40.1";
const C = "c".repeat(40);
const REPO = "acme/agent-pipeline";
const NOTES_PATH = "/tmp/notes.md";
const NOTES = `${TAG}\n\nVerified exact-candidate release at ${C}.`;

type Recorded = { file: string; args: string[] };

function result(status: number, stdout = "", stderr = ""): CommandResult {
  return { status, stdout, stderr };
}

function makeDeps(opts: {
  notes?: string;
  lookup?: CommandResult;
  mutate?: CommandResult;
}): { deps: PublishGithubReleaseDeps; commands: Recorded[] } {
  const commands: Recorded[] = [];
  return {
    commands,
    deps: {
      readFile(path) {
        if (opts.notes === undefined) throw new Error(`ENOENT: ${path}`);
        return opts.notes;
      },
      runCommand(file, args) {
        commands.push({ file, args });
        if (file === "gh" && args[0] === "api") {
          return opts.lookup ?? result(1, "", "HTTP 404: Not Found");
        }
        if (file === "gh" && args[0] === "release") {
          return opts.mutate ?? result(0);
        }
        return result(1, "", `unexpected ${file}`);
      },
    },
  };
}

function publish(over: {
  tag?: string;
  candidate?: string;
  repository?: string;
  notesPath?: string;
  notes?: string;
  lookup?: CommandResult;
  mutate?: CommandResult;
} = {}) {
  const harness = makeDeps(over);
  const outcome = publishGithubRelease(
    {
      tag: over.tag ?? TAG,
      candidate: over.candidate ?? C,
      repository: over.repository ?? REPO,
      notesPath: over.notesPath ?? NOTES_PATH,
    },
    harness.deps,
  );
  return { outcome, commands: harness.commands };
}

function mutations(commands: Recorded[]): Recorded[] {
  return commands.filter((row) => row.file === "gh" && row.args[0] === "release");
}

test("isCanonicalReleaseTag: accept vMAJOR.MINOR.PATCH with ASCII decimals and no leading zeros", () => {
  assert.equal(isCanonicalReleaseTag("v0.0.0"), true);
  assert.equal(isCanonicalReleaseTag("v1.40.1"), true);
});

test("isCanonicalReleaseTag: reject garbage, leading zeros, prerelease, suffix, and a fourth component", () => {
  assert.equal(isCanonicalReleaseTag("v1foo.2bar.3baz"), false);
  assert.equal(isCanonicalReleaseTag("v01.02.03"), false);
  assert.equal(isCanonicalReleaseTag("v1.2.3-beta"), false);
  assert.equal(isCanonicalReleaseTag("v1.2.3garbage"), false);
  assert.equal(isCanonicalReleaseTag("v1.2.3.4"), false);
});

test("publishGithubRelease: invalid tag fails closed with no lookup or mutation", () => {
  const { outcome, commands } = publish({ tag: "v1.2.3-beta", notes: NOTES });
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("expected failure");
  assert.equal(outcome.action, "none");
  assert.match(outcome.error, /vMAJOR\.MINOR\.PATCH/);
  assert.equal(commands.length, 0);
});

test("publishGithubRelease: notes must match TAG and C before any GitHub mutation", () => {
  const { outcome, commands } = publish({ notes: "wrong notes" });
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("expected failure");
  assert.equal(outcome.action, "none");
  assert.match(outcome.error, /annotation does not match required notes/);
  assert.equal(commands.length, 0);
  assert.equal(releaseTagNotes("1.40.1", C), NOTES);
});

test("publishGithubRelease: exit-zero malformed JSON does not create or edit", () => {
  const { outcome, commands } = publish({
    notes: NOTES,
    lookup: result(0, "{", ""),
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("expected failure");
  assert.equal(outcome.action, "none");
  assert.match(outcome.error, /unknown/);
  assert.equal(mutations(commands).length, 0);
});

test("publishGithubRelease: exit-zero array, null, wrong tag, and missing identity do not create or edit", () => {
  const payloads = [
    "[]",
    "null",
    JSON.stringify({ tag_name: "v9.9.9" }),
    JSON.stringify({ name: TAG }),
    JSON.stringify({ tag_name: TAG }),
    JSON.stringify({ id: "278451234", tag_name: TAG, draft: false, prerelease: false }),
  ];
  for (const stdout of payloads) {
    const { outcome, commands } = publish({
      notes: NOTES,
      lookup: result(0, stdout, ""),
    });
    assert.equal(outcome.ok, false, stdout);
    if (outcome.ok) throw new Error("expected failure");
    assert.equal(outcome.action, "none", stdout);
    assert.match(outcome.error, /unknown/, stdout);
    assert.equal(mutations(commands).length, 0, stdout);
  }
});

const VALID_EXISTING_RELEASE = {
  id: 278451234,
  tag_name: TAG,
  draft: false,
  prerelease: false,
  name: TAG,
  html_url: `https://github.com/${REPO}/releases/tag/${TAG}`,
};

test("publishGithubRelease: valid existing Release with exact tag_name is edited as latest non-prerelease", () => {
  const { outcome, commands } = publish({
    notes: NOTES,
    lookup: result(0, JSON.stringify(VALID_EXISTING_RELEASE), ""),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("expected success");
  assert.equal(outcome.action, "edit");
  const mut = mutations(commands);
  assert.equal(mut.length, 1);
  assert.deepEqual(mut[0]!.args, [
    "release",
    "edit",
    TAG,
    "--notes-file",
    NOTES_PATH,
    "--title",
    TAG,
    "--draft=false",
    "--latest",
    "--prerelease=false",
  ]);
  assert.equal(mut[0]!.args.includes("--prerelease"), false);
});

test("publishGithubRelease: authoritative non-auth HTTP 404 creates a latest non-prerelease Release", () => {
  const { outcome, commands } = publish({
    notes: NOTES,
    lookup: result(1, "", "gh: Not Found (HTTP 404)"),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("expected success");
  assert.equal(outcome.action, "create");
  const mut = mutations(commands);
  assert.equal(mut.length, 1);
  assert.deepEqual(mut[0]!.args, [
    "release",
    "create",
    TAG,
    "--verify-tag",
    "--notes-file",
    NOTES_PATH,
    "--title",
    TAG,
    "--latest",
    "--prerelease=false",
  ]);
});

test("publishGithubRelease: 401/403/auth/permission observation fails closed", () => {
  const errors = [
    "HTTP 401: Bad credentials",
    "HTTP 403: Resource not accessible by integration",
    "authentication required",
    "permission denied",
  ];
  for (const stderr of errors) {
    const { outcome, commands } = publish({
      notes: NOTES,
      lookup: result(1, "", stderr),
    });
    assert.equal(outcome.ok, false, stderr);
    if (outcome.ok) throw new Error("expected failure");
    assert.equal(outcome.action, "none", stderr);
    assert.match(outcome.error, /unknown/, stderr);
    assert.equal(mutations(commands).length, 0, stderr);
  }
});

test("publishGithubRelease: 429, 5xx, network, and unknown observation fail closed", () => {
  const errors = [
    { status: 1, stderr: "HTTP 429: API rate limit exceeded" },
    { status: 1, stderr: "HTTP 500 Internal Server Error" },
    { status: 1, stderr: "HTTP 502: Bad Gateway" },
    { status: 1, stderr: "dial tcp: i/o timeout" },
    { status: 1, stdout: '{"message":"Not Found"}', stderr: "" },
  ];
  for (const row of errors) {
    const { outcome, commands } = publish({
      notes: NOTES,
      lookup: result(row.status, row.stdout ?? "", row.stderr),
    });
    assert.equal(outcome.ok, false, row.stderr || row.stdout);
    if (outcome.ok) throw new Error("expected failure");
    assert.equal(outcome.action, "none");
    assert.match(outcome.error, /unknown/);
    assert.equal(mutations(commands).length, 0);
  }
});

test("publishGithubRelease: mixed 500/404, prior 404, and HTTP 4040 are unknown with no mutation", () => {
  const errors = [
    "HTTP 500 Internal Server Error from upstream HTTP 404",
    "status code 500; prior status code: 404",
    "HTTP 4040",
  ];
  for (const stderr of errors) {
    const { outcome, commands } = publish({
      notes: NOTES,
      lookup: result(1, "", stderr),
    });
    assert.equal(outcome.ok, false, stderr);
    if (outcome.ok) throw new Error("expected failure");
    assert.equal(outcome.action, "none", stderr);
    assert.match(outcome.error, /unknown/, stderr);
    assert.equal(mutations(commands).length, 0, stderr);
  }
});

test("publishGithubRelease: notes compare after terminal newlines only", () => {
  const { outcome: okNl } = publish({ notes: `${NOTES}\n` });
  assert.equal(okNl.ok, true);
  if (!okNl.ok) throw new Error("expected success");
  assert.equal(okNl.action, "create");

  for (const notes of [` ${NOTES}`, `${NOTES} `, `\n${NOTES}`]) {
    const { outcome, commands } = publish({ notes });
    assert.equal(outcome.ok, false, notes);
    if (outcome.ok) throw new Error("expected failure");
    assert.equal(outcome.action, "none");
    assert.match(outcome.error, /annotation does not match required notes/);
    assert.equal(commands.length, 0);
  }
});

test("publishGithubRelease: candidate must be exact 40-hex before lookup", () => {
  for (const candidate of ["c".repeat(39), "g".repeat(40), `${C} `, ` ${C}`]) {
    const { outcome, commands } = publish({ notes: NOTES, candidate });
    assert.equal(outcome.ok, false, candidate);
    if (outcome.ok) throw new Error("expected failure");
    assert.equal(outcome.action, "none");
    assert.equal(commands.length, 0);
  }
  const { outcome, commands } = publish({ notes: NOTES, candidate: C.toUpperCase() });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("expected success");
  assert.equal(outcome.action, "create");
  assert.equal(mutations(commands).length, 1);
});

test("publishGithubRelease: thrown create or edit is a visible failure with no second mutation", () => {
  const harness = makeDeps({
    notes: NOTES,
    lookup: result(0, JSON.stringify(VALID_EXISTING_RELEASE), ""),
  });
  const throwing: PublishGithubReleaseDeps = {
    readFile: harness.deps.readFile,
    runCommand(file, args) {
      if (file === "gh" && args[0] === "release") throw new Error("spawn EIO");
      return harness.deps.runCommand(file, args);
    },
  };
  const outcome = publishGithubRelease(
    { tag: TAG, candidate: C, repository: REPO, notesPath: NOTES_PATH },
    throwing,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("expected failure");
  assert.equal(outcome.action, "none");
  assert.match(outcome.error, /edit failed/);
  assert.equal(mutations(harness.commands).length, 0);
});

test("runPublishGithubReleaseCli: thrown mutation exits 1 with no second mutation", () => {
  const commands: Recorded[] = [];
  const code = runPublishGithubReleaseCli(
    { TAG, C, GITHUB_REPOSITORY: REPO, RELEASE_NOTES_PATH: NOTES_PATH },
    {
      readFile: () => NOTES,
      runCommand(file, args) {
        commands.push({ file, args });
        if (file === "gh" && args[0] === "api") return result(1, "", "HTTP 404: Not Found");
        if (file === "gh" && args[0] === "release") throw new Error("spawn EIO");
        return result(1, "", `unexpected ${file}`);
      },
    },
  );
  assert.equal(code, 1);
  assert.equal(mutations(commands).length, 1);
  assert.equal(mutations(commands)[0]!.args[1], "create");
});

test("release.yml invokes the publisher helper after notes dump and keeps one publication job", () => {
  const src = readFileSync(WORKFLOW, "utf8");
  const publish = src.slice(src.indexOf("Publish GitHub Release from the annotated tag"));
  const notesDump = publish.indexOf("git tag -l \"${TAG}\" --format='%(contents)' > /tmp/notes.md");
  const helper = publish.indexOf(HELPER);
  assert.ok(notesDump >= 0, "publish step must dump annotated notes");
  assert.ok(helper >= 0, "publish step must invoke publish-github-release.ts");
  assert.ok(notesDump < helper, "exact notes file must exist before the helper runs");
  assert.match(src, /node --experimental-strip-types core\/scripts\/publish-github-release\.ts/);
  assert.doesNotMatch(src, /^\s*gh release create/m);
  assert.doesNotMatch(src, /^\s*gh release edit/m);
  assert.equal((src.match(/^jobs:\n  release:/m) ?? []).length, 1);
});
