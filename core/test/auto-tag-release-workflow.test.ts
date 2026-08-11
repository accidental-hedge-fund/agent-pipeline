// Drift guard for the auto-tag-release workflow's release-merge detection pattern
// (#411). The pattern lives in .github/workflows/auto-tag-release.yml (single
// source); this test extracts it verbatim and asserts it stays in lock-step with
// the title release.ts actually builds (`release: X.Y.Z — <theme>`, em dash
// separator), including the squash-merge form (`… (#N)`), and rejects a plausible
// non-release subject.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(__dirname, "../../.github/workflows/auto-tag-release.yml");

function extractDetectionPattern(): RegExp {
  const workflowSrc = readFileSync(WORKFLOW_PATH, "utf-8");
  const match = workflowSrc.match(/pattern='(.+)'/);
  if (!match) {
    throw new Error(
      `Could not find a line matching pattern='...' in ${WORKFLOW_PATH} — the detection pattern moved or was renamed.`,
    );
  }
  return new RegExp(match[1]);
}

// Extracts the `run: |` block of a named step verbatim from the workflow YAML
// (single source) so the "Resolve release notes" fallback logic is exercised
// as real bash, not reimplemented in the test.
function extractStepScript(stepName: string): string {
  const workflowSrc = readFileSync(WORKFLOW_PATH, "utf-8");
  const lines = workflowSrc.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (startIdx === -1) {
    throw new Error(`Could not find step "${stepName}" in ${WORKFLOW_PATH}`);
  }
  let runIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\s*- name: /.test(lines[i])) break;
    if (/^\s*run: \|\s*$/.test(lines[i])) {
      runIdx = i;
      break;
    }
  }
  if (runIdx === -1) {
    throw new Error(`Could not find "run: |" block for step "${stepName}"`);
  }
  const runIndent = lines[runIdx].match(/^\s*/)?.[0].length ?? 0;
  const bodyIndent = runIndent + 2;
  const scriptLines: string[] = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      scriptLines.push("");
      continue;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent < bodyIndent) break;
    scriptLines.push(line.slice(bodyIndent));
  }
  return scriptLines.join("\n");
}

// Runs the extracted "Resolve release notes" script against a real temp git
// repo with a fake `gh` on PATH, substituting the GitHub Actions expressions
// the workflow runner would normally interpolate.
function runNotesScript(opts: {
  repoDir: string;
  ghScript: string;
  notesPath: string;
}): { status: number | null; stdout: string; stderr: string } {
  const script = extractStepScript("Resolve release notes")
    .replaceAll("${{ github.repository }}", "test-owner/test-repo")
    .replaceAll("${{ github.sha }}", "deadbeef")
    .replaceAll("${{ steps.detect.outputs.version }}", "1.16.0")
    .replaceAll("/tmp/release-notes.md", opts.notesPath);

  const binDir = mkdtempSync(join(tmpdir(), "auto-tag-gh-bin-"));
  const ghPath = join(binDir, "gh");
  writeFileSync(ghPath, opts.ghScript);
  chmodSync(ghPath, 0o755);

  const scriptPath = join(mkdtempSync(join(tmpdir(), "auto-tag-notes-script-")), "notes.sh");
  writeFileSync(scriptPath, script);

  const result = spawnSync("bash", [scriptPath], {
    cwd: opts.repoDir,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    encoding: "utf-8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function initRepoWithCommit(subject: string, body: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), "auto-tag-repo-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: repoDir, encoding: "utf-8" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t.com"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(repoDir, "f.txt"), "x");
  run(["add", "f.txt"]);
  const commitArgs = ["commit", "-q", "-m", subject];
  if (body) commitArgs.push("-m", body);
  run(commitArgs);
  return repoDir;
}

// Mirrors how release.ts builds the release PR title (`prTitle` in release.ts):
// `release: ${version} — ${theme}`. Squash-merging the release PR appends ` (#N)`.
function buildReleaseTitle(version: string, theme: string): string {
  return `release: ${version} — ${theme}`;
}

test("auto-tag-release detection pattern matches release.ts's raw title format", () => {
  const pattern = extractDetectionPattern();
  const subject = buildReleaseTitle("1.16.0", "Factory reliability");
  const match = subject.match(pattern);
  assert.ok(match, `expected pattern to match subject: ${subject}`);
  assert.equal(match?.[1], "1.16.0");
});

test("auto-tag-release detection pattern matches the squash-merged form", () => {
  const pattern = extractDetectionPattern();
  const subject = `${buildReleaseTitle("1.16.0", "Factory reliability")} (#412)`;
  const match = subject.match(pattern);
  assert.ok(match, `expected pattern to match subject: ${subject}`);
  assert.equal(match?.[1], "1.16.0");
});

test("auto-tag-release detection pattern rejects a plausible non-release subject", () => {
  const pattern = extractDetectionPattern();
  const subject = "feat: release notes tooling (#412)";
  assert.equal(pattern.test(subject), false, `expected pattern NOT to match subject: ${subject}`);
});

test("auto-tag-release detection pattern rejects a hyphen in place of the em dash", () => {
  const pattern = extractDetectionPattern();
  // release.ts uses an em dash (—, U+2014) separator, never a hyphen.
  const subject = "release: 1.16.0 - Factory reliability";
  assert.equal(pattern.test(subject), false, `expected pattern NOT to match subject: ${subject}`);
});

// Regression coverage (#411 review round 2): the notes fallback previously only
// resolved a PR when the subject ended with "(#N)". A raw release subject (no
// squash suffix) with an empty merge-commit body exited non-zero instead of
// falling back to the release PR body.

const GH_FAKE_API_LOOKUP = `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ]; then
  case "$2" in
    repos/test-owner/test-repo/commits/deadbeef/pulls) echo "42" ;;
    *) echo "unexpected gh api call: $*" >&2; exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ "$3" = "42" ]; then
    echo "release notes from PR body via commit lookup"
    exit 0
  fi
  echo "unexpected pr number: $3" >&2
  exit 1
fi
echo "unhandled gh invocation: $*" >&2
exit 1
`;

test("resolve release notes: raw subject (no PR suffix) with empty body falls back via commit→PR lookup", () => {
  const repoDir = initRepoWithCommit("release: 1.16.0 — Factory reliability", "");
  const notesPath = join(mkdtempSync(join(tmpdir(), "auto-tag-notes-out-")), "release-notes.md");

  const result = runNotesScript({ repoDir, ghScript: GH_FAKE_API_LOOKUP, notesPath });

  assert.equal(result.status, 0, `expected success, got stderr: ${result.stderr}`);
  const notes = readFileSync(notesPath, "utf-8").trim();
  assert.equal(notes, "release notes from PR body via commit lookup");
});

const GH_FAKE_REJECTS_API = `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ]; then
  echo "gh api should not be called when the subject already has a (#N) suffix" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ "$3" = "412" ]; then
    echo "release notes from PR body via subject suffix"
    exit 0
  fi
  echo "unexpected pr number: $3" >&2
  exit 1
fi
echo "unhandled gh invocation: $*" >&2
exit 1
`;

test("resolve release notes: squash-merged subject (#N) with empty body still resolves via subject suffix, no API call", () => {
  const repoDir = initRepoWithCommit("release: 1.16.0 — Factory reliability (#412)", "");
  const notesPath = join(mkdtempSync(join(tmpdir(), "auto-tag-notes-out-")), "release-notes.md");

  const result = runNotesScript({ repoDir, ghScript: GH_FAKE_REJECTS_API, notesPath });

  assert.equal(result.status, 0, `expected success, got stderr: ${result.stderr}`);
  const notes = readFileSync(notesPath, "utf-8").trim();
  assert.equal(notes, "release notes from PR body via subject suffix");
});

const GH_FAKE_UNUSED = `#!/usr/bin/env bash
echo "gh should not be invoked when the merge-commit body is non-empty" >&2
exit 1
`;

test("resolve release notes: non-empty merge-commit body is used directly, no gh call", () => {
  const repoDir = initRepoWithCommit("release: 1.16.0 — Factory reliability", "notes straight from the merge commit");
  const notesPath = join(mkdtempSync(join(tmpdir(), "auto-tag-notes-out-")), "release-notes.md");

  const result = runNotesScript({ repoDir, ghScript: GH_FAKE_UNUSED, notesPath });

  assert.equal(result.status, 0, `expected success, got stderr: ${result.stderr}`);
  const notes = readFileSync(notesPath, "utf-8").trim();
  assert.equal(notes, "notes straight from the merge commit");
});

// ---------------------------------------------------------------------------
// RELEASE_TAG_TOKEN single point of use (#413)
// ---------------------------------------------------------------------------
//
// The workflow's first live run failed at checkout on every push to main because
// RELEASE_TAG_TOKEN was passed as actions/checkout's `token:` input — an empty
// secret makes checkout hard-fail before the release-detection guard can no-op a
// non-release commit. These tests pin the secret to its single legitimate use
// (the tag-push step) and bite if it's reintroduced at checkout.

test("RELEASE_TAG_TOKEN is never referenced by actions/checkout", () => {
  const workflowSrc = readFileSync(WORKFLOW_PATH, "utf-8");
  const checkoutIdx = workflowSrc.indexOf("uses: actions/checkout@");
  assert.notEqual(checkoutIdx, -1, "expected an actions/checkout step in the workflow");

  // actions/checkout's step block runs from its "uses:" line up to (but not
  // including) the next "- uses:" or "- name:" step marker.
  const rest = workflowSrc.slice(checkoutIdx);
  const nextStepMatch = rest.slice(1).match(/\n\s*- (uses|name): /);
  const checkoutBlock = nextStepMatch
    ? rest.slice(0, nextStepMatch.index! + 1)
    : rest;

  assert.equal(
    checkoutBlock.includes("RELEASE_TAG_TOKEN"),
    false,
    `expected actions/checkout's step block to never reference RELEASE_TAG_TOKEN, got:\n${checkoutBlock}`,
  );
});

/** Inclusive step body range for a named `- name:` step (until next step). */
function stepLineRange(lines: string[], stepName: string): { start: number; end: number } {
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (start === -1) {
    throw new Error(`expected a '${stepName}' step`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*- (uses|name): /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function lineInRanges(i: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((r) => i >= r.start && i < r.end);
}

test("RELEASE_TAG_TOKEN is referenced only within tag-push and post-tag docs-refresh steps (excluding comments)", () => {
  const workflowSrc = readFileSync(WORKFLOW_PATH, "utf-8");
  const lines = workflowSrc.split("\n");
  const allowed = [
    stepLineRange(lines, "Create and push annotated tag"),
    stepLineRange(lines, "Regenerate tag-derived CHANGELOG"),
  ];

  // Header comments documenting the secret (its purpose, provisioning) are fine —
  // this test pins where the secret is actually *consumed* by the YAML, not every
  // prose mention of its name. #978 also consumes the secret for the docs commit push.
  lines.forEach((line, i) => {
    if (line.trim().startsWith("#")) return;
    if (!line.includes("RELEASE_TAG_TOKEN")) return;
    assert.ok(
      lineInRanges(i, allowed),
      `expected RELEASE_TAG_TOKEN reference at line ${i + 1} to be within the tag-push or ` +
        `docs-refresh step, got: ${line}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Post-tag CHANGELOG refresh (#978) — drift guards
// ---------------------------------------------------------------------------

test("auto-tag-release runs post-tag docs refresh after the tag-push step", () => {
  const workflowSrc = readFileSync(WORKFLOW_PATH, "utf-8");
  const tagStep = workflowSrc.indexOf("- name: Create and push annotated tag");
  const docsStep = workflowSrc.indexOf("- name: Regenerate tag-derived CHANGELOG");
  assert.notEqual(tagStep, -1, "expected tag create/push step");
  assert.notEqual(docsStep, -1, "expected post-tag CHANGELOG regenerate step (#978)");
  assert.ok(
    docsStep > tagStep,
    "docs refresh must run after annotated tag create/push so the generator can see the tag",
  );
  assert.match(
    workflowSrc,
    /node scripts\/release-docs-refresh\.mjs --version .* --push/,
    "expected release-docs-refresh.mjs invoker with --push",
  );
  // Guard against removing the step while leaving a comment that mentions CHANGELOG.
  const docsSlice = workflowSrc.slice(docsStep, docsStep + 2500);
  assert.match(docsSlice, /release-docs-refresh\.mjs/);
  assert.match(docsSlice, /RELEASE_TAG_TOKEN/);
});

test("auto-tag detection pattern rejects post-tag docs regenerate commit subject (no tag loop)", () => {
  const pattern = extractDetectionPattern();
  const subject = "docs: regenerate CHANGELOG for v1.34.0";
  assert.equal(
    pattern.test(subject),
    false,
    `expected docs-refresh subject NOT to match release detection (would re-tag): ${subject}`,
  );
  assert.equal(pattern.test("docs: regenerate generated docs (#716)"), false);
});

// ---------------------------------------------------------------------------
// Checkout-persisted credential can't shadow the tag-push PAT (#413 review 1)
// ---------------------------------------------------------------------------
//
// actions/checkout persists the default GITHUB_TOKEN as an
// `http.https://github.com/.extraheader` git config entry (persist-credentials
// defaults to true). That config matches any https://github.com/ URL,
// including the PAT-embedded push URL below, so without clearing it the tag
// push could silently authenticate with GITHUB_TOKEN instead of
// RELEASE_TAG_TOKEN — pushing the tag without triggering release.yml.

test("tag-push step unsets the checkout-persisted extraheader before pushing with the PAT", () => {
  const script = extractStepScript("Create and push annotated tag");
  const unsetIdx = script.indexOf("http.https://github.com/.extraheader");
  const pushIdx = script.indexOf("git push ");
  assert.notEqual(unsetIdx, -1, "expected the tag-push step to unset the checkout-persisted extraheader");
  assert.notEqual(pushIdx, -1, "expected the tag-push step to contain a git push command");
  assert.ok(
    unsetIdx < pushIdx,
    "expected the extraheader unset to happen before git push, so the persisted GITHUB_TOKEN can't shadow RELEASE_TAG_TOKEN",
  );
});

test("resolve release notes: raw subject with empty body and no PR found via API fails loudly", () => {
  const repoDir = initRepoWithCommit("release: 1.16.0 — Factory reliability", "");
  const notesPath = join(mkdtempSync(join(tmpdir(), "auto-tag-notes-out-")), "release-notes.md");
  const ghNoPr = `#!/usr/bin/env bash
if [ "$1" = "api" ]; then
  echo ""
  exit 0
fi
echo "unhandled gh invocation: $*" >&2
exit 1
`;

  const result = runNotesScript({ repoDir, ghScript: ghNoPr, notesPath });

  assert.notEqual(result.status, 0, "expected the script to fail when no notes can be resolved");
  assert.match(result.stderr + result.stdout, /No non-empty release notes could be resolved/);
});

// ---------------------------------------------------------------------------
// Thin ship: auto-tag must NOT hard-require FRG (#962 follow-up)
// ---------------------------------------------------------------------------

test("auto-tag-release workflow does not hard-gate tag create on FRG evidence", () => {
  const workflowSrc = readFileSync(WORKFLOW_PATH, "utf-8");
  const frgStep = workflowSrc.indexOf("- name: Verify Factory Reliability Gate evidence");
  const tagStep = workflowSrc.indexOf("- name: Create and push annotated tag");
  assert.equal(frgStep, -1, "FRG verification step must be removed from auto-tag (thin ship)");
  assert.notEqual(tagStep, -1, "expected tag create/push step");
  // Tag step must not depend on a frg_ok output
  assert.equal(/steps\.frg\.outputs/.test(workflowSrc), false);
  // Optional FRG tooling may still be mentioned in comments, but no validate-tag gate
  const tagSlice = workflowSrc.slice(tagStep, tagStep + 1500);
  assert.equal(/--validate-tag/.test(tagSlice), false);
  assert.equal(/PIPELINE_FRG_ATTESTATION_KEY/.test(tagSlice), false);
});
