// Drift guard for the auto-tag-release workflow's release-merge detection pattern
// (#411). The pattern lives in .github/workflows/auto-tag-release.yml (single
// source); this test extracts it verbatim and asserts it stays in lock-step with
// the title release.ts actually builds (`release: X.Y.Z — <theme>`, em dash
// separator), including the squash-merge form (`… (#N)`), and rejects a plausible
// non-release subject.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
