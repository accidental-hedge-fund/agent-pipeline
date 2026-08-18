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
import {
  computeFrgEvidence,
  FRG_PACK_MANIFEST,
  FRG_UNIT_TEST_ATTESTATION_KEY,
  frgRequiredCompositionOverrides,
  frgRequiredObservationOverrides,
  validateFrgEvidenceFileForTag,
  writeFrgEvidence,
  type FrgFsDeps,
} from "../scripts/factory-reliability-gate.ts";

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
  // Slice is large enough for branch-attach + refresh (detached-HEAD fix #978 review 1).
  const docsSlice = workflowSrc.slice(docsStep, docsStep + 4000);
  assert.match(docsSlice, /release-docs-refresh\.mjs/);
  assert.match(docsSlice, /RELEASE_TAG_TOKEN/);
});

// Regression (#978 review 1): actions/checkout leaves detached HEAD. Bare
// `git push` from the refresh helper fails unless the step attaches a local
// branch tracking origin/${{ github.ref_name }} first.
test("post-tag docs-refresh attaches local default branch before bare git push (detached checkout)", () => {
  const script = extractStepScript("Regenerate tag-derived CHANGELOG");
  const refreshIdx = script.indexOf("release-docs-refresh.mjs");
  assert.notEqual(refreshIdx, -1, "expected release-docs-refresh invoker");

  assert.match(
    script,
    /git checkout -B /,
    "expected git checkout -B to attach a local branch for the docs push",
  );
  const checkoutIdx = script.indexOf("git checkout -B ");
  assert.ok(
    checkoutIdx < refreshIdx,
    "local branch attach must happen before release-docs-refresh --push",
  );

  // Branch target must come from the workflow default-branch ref.
  assert.match(
    script,
    /github\.ref_name/,
    "expected docs-refresh to target github.ref_name (default branch)",
  );
  assert.match(
    script,
    /origin\/\$\{branch\}|origin\/"\$\{branch\}"|origin\/\$\{\{\s*github\.ref_name\s*\}\}/,
    "expected checkout to track origin/<default-branch>",
  );

  // Fail closed on attach — must not swallow with || true (old pull line did).
  const checkoutLine = script.split("\n").find((l) => l.includes("git checkout -B"));
  assert.ok(checkoutLine, "expected checkout -B line");
  assert.equal(
    checkoutLine.includes("|| true"),
    false,
    `branch attach must fail closed (no || true): ${checkoutLine}`,
  );
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
// Auto-tag fail-closes on missing / failed FRG (#1040 restore of #757)
// ---------------------------------------------------------------------------

function workflowMemFs(): FrgFsDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(p) {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    async writeFile(p, data) {
      files.set(p, data);
    },
    async mkdir() {},
    async rename(from, to) {
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT rename ${from}`);
      files.set(to, v);
      files.delete(from);
    },
  };
}

test("auto-tag-release workflow has FRG verification step ordered before tag create/push", () => {
  const workflowSrc = readFileSync(WORKFLOW_PATH, "utf-8");
  const existsStep = workflowSrc.indexOf("- name: Check whether the tag already exists");
  const frgStep = workflowSrc.indexOf("- name: Verify Factory Reliability Gate evidence");
  const notesStep = workflowSrc.indexOf("- name: Resolve release notes");
  const tagStep = workflowSrc.indexOf("- name: Create and push annotated tag");
  assert.notEqual(existsStep, -1, "expected existing-tag check");
  assert.notEqual(frgStep, -1, "FRG verification step must exist before tag create/push");
  assert.notEqual(notesStep, -1, "expected notes resolution step");
  assert.notEqual(tagStep, -1, "expected tag create/push step");
  assert.ok(frgStep > existsStep, "FRG verify must run after the existing-tag check");
  assert.ok(frgStep < notesStep, "FRG verify must run before notes resolution");
  assert.ok(frgStep < tagStep, "FRG verify must run before tag create/push");

  const frgSlice = workflowSrc.slice(frgStep, notesStep);
  assert.match(frgSlice, /--validate-tag/, "FRG step must invoke the shared --validate-tag CLI");
  assert.match(
    frgSlice,
    /PIPELINE_FRG_ATTESTATION_KEY/,
    "FRG step must require PIPELINE_FRG_ATTESTATION_KEY for HMAC verification",
  );
  assert.match(
    frgSlice,
    /steps\.exists\.outputs\.exists == 'false'/,
    "FRG step must run only when the version tag does not already exist",
  );
  assert.equal(
    /optional|advisory/i.test(frgSlice),
    false,
    "FRG step must not call FRG optional or advisory",
  );

  const tagSlice = workflowSrc.slice(tagStep, tagStep + 1500);
  assert.equal(
    /if:\s*always\(\)/.test(tagSlice),
    false,
    "tag create/push must not run after an FRG failure",
  );
  assert.equal(
    workflowSrc.includes("FRG is optional/advisory"),
    false,
    "#962 inverted optional/advisory comment must not remain",
  );
});

test("auto-tag FRG verify step script calls shared --validate-tag and does not tag", () => {
  const script = extractStepScript("Verify Factory Reliability Gate evidence");
  assert.match(script, /--validate-tag "\$\{version\}"/);
  assert.match(script, /factory-reliability-gate\.ts/);
  assert.match(script, /PIPELINE_FRG_ATTESTATION_KEY/);
  assert.equal(/git tag/.test(script), false);
  assert.equal(/git push/.test(script), false);
  assert.equal(/optional|advisory/i.test(script), false);
});

test("missing latest.json fails closed and names path plus pack remediation", async () => {
  const fs = workflowMemFs();
  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.39.0", fs, {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /\.agent-pipeline\/frg\/1\.39\.0\/latest\.json/);
      assert.match(message, /factory-release prepare/);
      assert.match(message, /Tugboat FRG pack/);
      assert.match(message, /missing/);
      assert.equal(/optional|advisory/i.test(message), false);
      return true;
    },
  );
});

test("pass:false latest.json fails closed and does not allow tag proceed", async () => {
  const fs = workflowMemFs();
  const failEv = computeFrgEvidence({
    version: "1.30.0",
    run_id: "frg-auto-tag-fail",
    loop_run_id: "loop",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(failEv.pass, false);
  await writeFrgEvidence("/repo", failEv, fs);
  await assert.rejects(
    () =>
      validateFrgEvidenceFileForTag("/repo", "1.30.0", fs, {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /\.agent-pipeline\/frg\/1\.30\.0\/latest\.json/);
      assert.match(message, /factory-release prepare/);
      assert.match(message, /Tugboat FRG pack/);
      assert.match(message, /pass=false/i);
      return true;
    },
  );
});

test("release-eligible pass:true latest.json allows tag proceed", async () => {
  const fs = workflowMemFs();
  const good = computeFrgEvidence({
    version: "1.30.0",
    run_id: "frg-auto-tag-pass",
    loop_run_id: "loop-full-pass",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(good.pass, true);
  await writeFrgEvidence("/repo", good, fs);
  const ok = await validateFrgEvidenceFileForTag("/repo", "1.30.0", fs, {
    attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(ok.pass, true);
  assert.equal(ok.version, "1.30.0");
});
