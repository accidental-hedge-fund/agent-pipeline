// Deterministic inventory of approved command-interface cases (#1564).
// Hermetic: reads committed test sources only. No network, git, or subprocess.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

export interface ApprovedCommandInterfaceCase {
  id: string;
  title: string;
  covers: Array<{ file: string; pattern: RegExp }>;
}

export const APPROVED_COMMAND_INTERFACE_CASES: readonly ApprovedCommandInterfaceCase[] = [
  {
    id: "milestone-integration-checks",
    title: "milestone integration checks",
    covers: [{ file: "release-complete.test.ts", pattern: /milestone must be exactly one nonempty match/ }],
  },
  {
    id: "isolated-metadata-first-merge",
    title: "isolated metadata-first merge",
    covers: [{ file: "release-complete.test.ts", pattern: /complete release orders metadata merge before C\/FRG\/tag\/publication/ }],
  },
  {
    id: "candidate-source-identity",
    title: "candidate source identity",
    covers: [{ file: "exact-candidate-frg.test.ts", pattern: /candidate C alone supplies worker and Tester policy identity/ }],
  },
  {
    id: "exact-two-partial-create-and-resume",
    title: "exactly two issues across partial create and resume",
    covers: [{ file: "exact-candidate-frg.test.ts", pattern: /lost create response is reconciled and resume never creates a third issue/ }],
  },
  {
    id: "same-host-duplicate-exclusion",
    title: "same-host duplicate exclusion",
    covers: [
      { file: "exact-candidate-frg.test.ts", pattern: /duplicates and a foreign third claim are gate defects with no create/ },
      { file: "exact-candidate-frg.test.ts", pattern: /same-host release\/FRG exclusion releases on failure and refuses contention/ },
    ],
  },
  {
    id: "fresh-genuine-ready-to-deploy",
    title: "fresh genuine pipeline:ready-to-deploy",
    covers: [{ file: "exact-candidate-frg.test.ts", pattern: /authoritative current green unmerged heads pass; claims and labels alone do not/ }],
  },
  {
    id: "forged-wrong-head-mismatched-rejection",
    title: "rejection of false, forged, wrong-head, and mismatched evidence",
    covers: [{ file: "exact-candidate-frg.test.ts", pattern: /wrong-head, stale, merged, non-independent, and worker-config evidence cannot pass/ }],
  },
  {
    id: "no-fixture-merging",
    title: "no fixture merging",
    covers: [{ file: "exact-candidate-frg.test.ts", pattern: /tagged retry discovers exactly one forge pair and never treats local pass as proof/ }],
  },
  {
    id: "external-wait-versus-regression",
    title: "correct external-wait versus regression handling",
    covers: [{ file: "exact-candidate-frg.test.ts", pattern: /four non-pass classes distinguish fixture revision, infrastructure, and demonstrated candidate regression/ }],
  },
  {
    id: "unchanged-and-changed-tester-candidates",
    title: "unchanged and changed Tester candidates",
    covers: [
      { file: "testgate-commit-verify.test.ts", pattern: /clean no-change retry preserves the PR candidate through Tester rebind/ },
      { file: "tester-evidence.test.ts", pattern: /post-fix regeneration: new HEAD overwrites prior evidence/ },
    ],
  },
  {
    id: "dirty-pre-commit-ci",
    title: "dirty pre-commit CI",
    covers: [{ file: "tester-evidence.test.ts", pattern: /runTestGate producer: failed \/ timeout \/ tooling \/ disabled \/ not_run \/ dirty/ }],
  },
  {
    id: "stale-main",
    title: "stale main",
    covers: [
      { file: "exact-candidate-frg.test.ts", pattern: /candidate movement marks old evidence stale without rebinding it/ },
      { file: "release-complete.test.ts", pattern: /tagged-stale-C stays incomplete without retag when main moved/ },
    ],
  },
  {
    id: "tag-and-publication-idempotency",
    title: "tag and publication idempotency",
    covers: [{ file: "release-complete.test.ts", pattern: /same-target published tag makes repeat invocation a no-op/ }],
  },
  {
    id: "cleanup-debt",
    title: "cleanup debt",
    covers: [{ file: "exact-candidate-frg.test.ts", pattern: /result is persisted before cleanup and cleanup debt cannot invalidate pass/ }],
  },
  {
    id: "equivalent-direct-release-and-ship-final-delegation-without-deployment",
    title: "equivalent direct-release and ship-final-delegation without deployment",
    covers: [
      { file: "ship-adapter.test.ts", pattern: /direct-release and ship-final-delegation complete the same SemVer contract without deployment/ },
      { file: "release-complete.test.ts", pattern: /complete release ignores historical HMAC latest.json and does not deploy/ },
    ],
  },
];

export function coveringRegressionsMissing(
  cases: readonly ApprovedCommandInterfaceCase[],
  read: (file: string) => string = (file) => readFileSync(join(here, file), "utf8"),
): string[] {
  const missing: string[] = [];
  for (const item of cases) {
    for (const cover of item.covers) {
      const body = read(cover.file);
      if (!cover.pattern.test(body)) missing.push(`${item.id} -> ${cover.file} / ${cover.pattern}`);
    }
  }
  return missing;
}

test("approved command-interface inventory names every required case", () => {
  const ids = APPROVED_COMMAND_INTERFACE_CASES.map((item) => item.id);
  assert.deepEqual(ids, [
    "milestone-integration-checks",
    "isolated-metadata-first-merge",
    "candidate-source-identity",
    "exact-two-partial-create-and-resume",
    "same-host-duplicate-exclusion",
    "fresh-genuine-ready-to-deploy",
    "forged-wrong-head-mismatched-rejection",
    "no-fixture-merging",
    "external-wait-versus-regression",
    "unchanged-and-changed-tester-candidates",
    "dirty-pre-commit-ci",
    "stale-main",
    "tag-and-publication-idempotency",
    "cleanup-debt",
    "equivalent-direct-release-and-ship-final-delegation-without-deployment",
  ]);
});

test("each approved command-interface case has a covering regression", () => {
  assert.deepEqual(coveringRegressionsMissing(APPROVED_COMMAND_INTERFACE_CASES), []);
});

test("inventory fails when a named case lacks a covering regression", () => {
  const missing = coveringRegressionsMissing(
    [{ id: "missing-case", title: "missing", covers: [{ file: "release-complete.test.ts", pattern: /this-title-does-not-exist/ }] }],
  );
  assert.deepEqual(missing, ["missing-case -> release-complete.test.ts / /this-title-does-not-exist/"]);
});

const repoRoot = join(here, "../..");

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

test("operator post-merge checklist exists and stays unchecked", () => {
  const checklist = readRepo("docs/runbooks/v1.40.1-post-merge-operator-checklist.md");
  assert.match(checklist, /Test exact main `C`/);
  assert.match(checklist, /two unmerged `pipeline:ready-to-deploy` results/);
  assert.match(checklist, /annotated `v1\.40\.1` at `C`/);
  assert.match(checklist, /matching versions and notes and a non-draft publication/);
  assert.match(checklist, /repeated release of that publication is idempotent/);
  assert.doesNotMatch(checklist, /^\s*- \[x\]/m);
  assert.match(checklist, /not treat injected-I\/O or fixture cleanup as proof that an operator\s+completed live cleanup/s);
});

test("protected-file alignment report exists and does not edit protected files", () => {
  const report = readRepo("docs/release-contract-protected-file-alignment.md");
  assert.match(report, /CLAUDE\.md/);
  assert.match(report, /AGENTS\.md/);
  assert.match(report, /This change does not edit those protected files/);
  assert.match(report, /Agrees|already agree/);
});

test("simulated cleanup is not treated as operator live cleanup", () => {
  const sources = [
    readRepo("core/scripts/exact-candidate-frg.ts"),
    readRepo("core/test/exact-candidate-frg.test.ts"),
    readRepo("docs/runbooks/v1.40.1-post-merge-operator-checklist.md"),
  ].join("\n");
  assert.match(sources, /not operator live cleanup|not proof that an operator/);
  assert.doesNotMatch(sources, /fixture cleanup (is|proves|completes) (live )?operator cleanup/i);
  assert.doesNotMatch(sources, /simulated cleanup completed the live operator cleanup/i);
});

test("optional observability, repository models, and review policy remain", () => {
  assert.match(readRepo("docs/observability.md"), /AGENT_OBSERVABILITY_ENABLED/);
  assert.match(readRepo("openspec/specs/release-simplification-contract/spec.md"), /optional observability #1482/);
  assert.match(readRepo("core/scripts/review-policy.ts"), /block_threshold|min_confidence/);
  const newDocs = [
    readRepo("docs/runbooks/v1.40.1-post-merge-operator-checklist.md"),
    readRepo("docs/release-contract-protected-file-alignment.md"),
  ].join("\n");
  assert.doesNotMatch(newDocs, /temporary Sol override|synthetic fixture implementation|second scheduler/i);
});
