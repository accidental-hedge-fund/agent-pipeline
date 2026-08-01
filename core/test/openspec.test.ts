// OpenSpec wrapper tests — pure unit (no `openspec` binary required).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  archive,
  changeDirExists,
  changeIdFromArchiveFolderName,
  changeIdsFromPaths,
  isActive,
  isInitialized,
  listChangeDirs,
  openspecContext,
  openspecContextFromDiff,
  OPENSPEC_ARCHIVE_APPLY_CONFLICT_REASON_CODE,
  OPENSPEC_ARCHIVE_JSON_MIN_VERSION,
  parseArchiveResult,
  parseOpenspecCliVersion,
  parseValidateResult,
  readChangeFile,
  readSpecDeltas,
  sharedActiveChangeIdsFromPaths,
  shouldPlanWithOpenspec,
  unarchivedChangeIdsFromPrFiles,
} from "../scripts/openspec.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openspec-test-"));
}

test("isInitialized: true only when openspec/ dir exists", () => {
  const dir = tmpDir();
  assert.equal(isInitialized(dir), false);
  fs.mkdirSync(path.join(dir, "openspec"));
  assert.equal(isInitialized(dir), true);
});

test("isActive: off → false and on → true regardless of dir", () => {
  const dir = tmpDir(); // no openspec/
  assert.equal(isActive({ openspec: { enabled: "off" } }, dir), false);
  assert.equal(isActive({ openspec: { enabled: "on" } }, dir), true);
});

test("isActive: auto → follows openspec/ presence", () => {
  const dir = tmpDir();
  assert.equal(isActive({ openspec: { enabled: "auto" } }, dir), false);
  fs.mkdirSync(path.join(dir, "openspec"));
  assert.equal(isActive({ openspec: { enabled: "auto" } }, dir), true);
});

test("parseValidateResult: exit 0 is valid with no issues", () => {
  const r = parseValidateResult(0, "");
  assert.equal(r.valid, true);
  assert.equal(r.issues.length, 0);
  assert.equal(r.unavailable, false);
});

test("parseValidateResult: nonzero exit with JSON issues is invalid and extracts messages", () => {
  const out = JSON.stringify({
    results: [{ item: "add-auth", valid: false, errors: ["missing tasks.md", "spec delta empty"] }],
  });
  const r = parseValidateResult(1, out);
  assert.equal(r.valid, false);
  const msgs = r.issues.map((i) => i.message);
  assert.ok(msgs.includes("missing tasks.md"));
  assert.ok(msgs.includes("spec delta empty"));
});

test("parseValidateResult: nonzero exit with non-JSON falls back to raw text", () => {
  const r = parseValidateResult(2, "Error: openspec workspace is corrupt");
  assert.equal(r.valid, false);
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0].message, /workspace is corrupt/);
});

test("parseValidateResult: object with a message field is captured", () => {
  const r = parseValidateResult(1, JSON.stringify({ message: "validation failed: 2 errors" }));
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => /2 errors/.test(i.message)));
});

test("parseValidateResult: nested results.changes shape extracts issues", () => {
  const out = JSON.stringify({
    results: { changes: [{ name: "add-auth", valid: false, issues: ["delta missing scenario"] }] },
    summary: { total: 1, valid: 0, invalid: 1 },
  });
  const r = parseValidateResult(1, out);
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => /delta missing scenario/.test(i.message)));
});

test("parseArchiveResult: requires a matching archive object and removed active change", () => {
  const stdout = JSON.stringify({
    archive: {
      change: "add-auth",
      archivedAs: "2026-07-31-add-auth",
      path: "/repo/openspec/changes/archive/2026-07-31-add-auth",
      specsUpdated: true,
    },
  });

  assert.deepEqual(parseArchiveResult("add-auth", 0, stdout, "", "removed"), {
    success: true,
    unavailable: false,
    output: stdout,
  });
});

test("parseArchiveResult: exit 0 with a semantic apply failure is not success", () => {
  const stdout = JSON.stringify({
    archive: null,
    status: [{
      severity: "error",
      code: "archive_spec_update_failed",
      message: "ADDED requirement already exists",
      fix: "Fix the change delta specs and rerun. No files were changed.",
    }],
  });

  const result = parseArchiveResult("add-auth", 0, stdout, "", "present");

  assert.equal(result.success, false);
  assert.equal(result.diagnostic?.reasonCode, OPENSPEC_ARCHIVE_APPLY_CONFLICT_REASON_CODE);
  assert.equal(result.diagnostic?.diagnosticCode, "archive_spec_update_failed");
  assert.equal(
    result.diagnostic?.evidenceKey,
    "openspec-archive-apply-conflict:add-auth:archive_spec_update_failed",
  );
  assert.equal(result.diagnostic?.message, "ADDED requirement already exists");
});

test("parseArchiveResult: archive object with a residual active dir fails its postcondition", () => {
  const stdout = JSON.stringify({
    archive: { change: "add-auth", archivedAs: "2026-07-31-add-auth" },
  });

  const result = parseArchiveResult("add-auth", 0, stdout, "", "present");

  assert.equal(result.success, false);
  assert.equal(result.diagnostic?.diagnosticCode, "archive_active_change_remains");
  assert.equal(
    result.diagnostic?.evidenceKey,
    "openspec-archive-apply-conflict:add-auth:archive_active_change_remains",
  );
});

test("parseArchiveResult: rejects a success object for a different change", () => {
  const stdout = JSON.stringify({
    archive: { change: "other-change", archivedAs: "2026-07-31-other-change" },
  });

  const result = parseArchiveResult("add-auth", 0, stdout, "", "removed");

  assert.equal(result.success, false);
  assert.equal(result.diagnostic?.diagnosticCode, "archive_result_mismatch");
});

test("parseArchiveResult: unverifiable active-change removal is not semantic success", () => {
  const stdout = JSON.stringify({
    archive: { change: "add-auth", archivedAs: "2026-07-31-add-auth" },
  });

  const result = parseArchiveResult("add-auth", 0, stdout, "", "unverified");

  assert.equal(result.success, false);
  assert.equal(result.diagnostic?.diagnosticCode, "archive_active_change_unverified");
});

test("archive: requests JSON and verifies removal independently of exit code", async () => {
  const calls: string[][] = [];
  const result = await archive("/repo", "add-auth", 1234, {
    run: async (_dir, args) => {
      calls.push(args);
      if (args[0] === "--version") {
        return { code: 0, stdout: `${OPENSPEC_ARCHIVE_JSON_MIN_VERSION}\n`, stderr: "", unavailable: false };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          archive: { change: "add-auth", archivedAs: "2026-07-31-add-auth" },
        }),
        stderr: "",
        unavailable: false,
      };
    },
    changeState: () => "present",
  });

  assert.deepEqual(calls, [["--version"], ["archive", "add-auth", "--yes", "--json"]]);
  assert.equal(result.success, false);
  assert.equal(result.diagnostic?.diagnosticCode, "archive_active_change_remains");
});

// ---------------------------------------------------------------------------
// archive CLI capability preflight — an old CLI (no `archive --json`) must fail
// with an actionable upgrade diagnostic, never a garbage JSON-parse failure
// that feeds implementer repair rounds.
// ---------------------------------------------------------------------------

test("archive: an older CLI fails the version preflight with an upgrade diagnostic and never reaches the JSON archive call", async () => {
  const calls: string[][] = [];
  const result = await archive("/repo", "add-auth", 1234, {
    run: async (_dir, args) => {
      calls.push(args);
      if (args[0] === "--version") {
        return { code: 0, stdout: "1.4.2\n", stderr: "", unavailable: false };
      }
      // What an old CLI would emit for the unsupported flag — must never be parsed.
      return { code: 1, stdout: "", stderr: "error: unknown option '--json'", unavailable: false };
    },
    changeState: () => "present",
  });

  assert.deepEqual(calls, [["--version"]], "the archive --json call must not run on an unsupported CLI");
  assert.equal(result.success, false);
  assert.equal(result.unavailable, false);
  assert.equal(result.diagnostic?.diagnosticCode, "archive_cli_unsupported");
  assert.equal(result.diagnostic?.reasonCode, OPENSPEC_ARCHIVE_APPLY_CONFLICT_REASON_CODE);
  // Doctor-grade: names the found version, the required version, and the remedy.
  assert.match(result.output, /1\.4\.2/);
  assert.ok(result.output.includes(OPENSPEC_ARCHIVE_JSON_MIN_VERSION));
  assert.match(result.output, /Upgrade the openspec CLI/);
  assert.ok(result.diagnostic?.message?.includes(OPENSPEC_ARCHIVE_JSON_MIN_VERSION));
  assert.match(result.diagnostic?.fix ?? "", /Upgrade the openspec CLI/);
});

test("archive: an inconclusive version probe falls through to the archive call whose own result governs", async () => {
  const calls: string[][] = [];
  const result = await archive("/repo", "add-auth", 1234, {
    run: async (_dir, args) => {
      calls.push(args);
      if (args[0] === "--version") {
        // No parseable semver — the probe must not block a healthy CLI.
        return { code: 0, stdout: "openspec dev build\n", stderr: "", unavailable: false };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ archive: { change: "add-auth", archivedAs: "2026-07-31-add-auth" } }),
        stderr: "",
        unavailable: false,
      };
    },
    changeState: () => "removed",
  });

  assert.deepEqual(calls, [["--version"], ["archive", "add-auth", "--yes", "--json"]]);
  assert.equal(result.success, true);
});

test("archive: an unavailable version probe reports the CLI unavailable without an apply-conflict diagnostic", async () => {
  const result = await archive("/repo", "add-auth", 1234, {
    run: async () => ({ code: -1, stdout: "", stderr: "openspec not found", unavailable: true }),
    changeState: () => "present",
  });

  assert.equal(result.success, false);
  assert.equal(result.unavailable, true);
  assert.equal(result.diagnostic, undefined);
});

test("parseOpenspecCliVersion: parses the real bare-version output and rejects versionless text", () => {
  assert.deepEqual(parseOpenspecCliVersion("1.5.0\n"), [1, 5, 0]);
  assert.deepEqual(parseOpenspecCliVersion("openspec/2.10.3 linux"), [2, 10, 3]);
  assert.equal(parseOpenspecCliVersion("openspec dev build"), null);
});

test("listChangeDirs: lists change folders excluding archive", () => {
  const dir = tmpDir();
  const changes = path.join(dir, "openspec", "changes");
  fs.mkdirSync(path.join(changes, "add-auth"), { recursive: true });
  fs.mkdirSync(path.join(changes, "fix-bug"), { recursive: true });
  fs.mkdirSync(path.join(changes, "archive"), { recursive: true });
  assert.deepEqual(listChangeDirs(dir).sort(), ["add-auth", "fix-bug"]);
});

test("listChangeDirs: empty when no openspec workspace", () => {
  assert.deepEqual(listChangeDirs(tmpDir()), []);
});

test("changeDirExists + readChangeFile", () => {
  const dir = tmpDir();
  const c = path.join(dir, "openspec", "changes", "add-auth");
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(c, "proposal.md"), "# Proposal\nbody");
  assert.equal(changeDirExists(dir, "add-auth"), true);
  assert.equal(changeDirExists(dir, "nope"), false);
  assert.match(readChangeFile(dir, "add-auth", "proposal.md") ?? "", /Proposal/);
  assert.equal(readChangeFile(dir, "add-auth", "missing.md"), null);
});

test("readSpecDeltas: concatenates spec delta markdown under a change", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "add-auth", "specs", "auth");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "## ADDED Requirement: login\nuser can log in");
  const out = readSpecDeltas(dir, "add-auth");
  assert.match(out, /Requirement: login/);
  assert.match(out, /user can log in/);
});

test("readSpecDeltas: empty string when the change has no specs", () => {
  assert.equal(readSpecDeltas(tmpDir(), "nope"), "");
});

test("parseValidateResult: real validate --json {items} failure yields clean messages", () => {
  // Shape confirmed against openspec 1.4.1: { items: [...], summary: { totals }, byType }.
  const out = JSON.stringify({
    items: [
      { id: "add-auth", type: "change", valid: false, issues: ["missing tasks.md", "empty spec delta"] },
    ],
    summary: { totals: { items: 1, passed: 0, failed: 1 } },
    version: "1.0",
  });
  const r = parseValidateResult(1, out);
  assert.equal(r.valid, false);
  const msgs = r.issues.map((i) => i.message);
  assert.ok(msgs.includes("missing tasks.md"));
  assert.ok(msgs.includes("empty spec delta"));
});

test("changeIdsFromPaths: distinct active change ids, excludes archive + non-change paths", () => {
  const paths = [
    "openspec/changes/add-auth/proposal.md",
    "openspec/changes/add-auth/tasks.md",
    "openspec/changes/archive/2026-01-01-old/specs/x/spec.md",
    "src/index.ts",
    "openspec/specs/auth/spec.md",
  ];
  assert.deepEqual(changeIdsFromPaths(paths).sort(), ["add-auth"]);
});

test("unarchivedChangeIdsFromPrFiles: active-only id is unarchived", () => {
  const paths = ["openspec/changes/foo/proposal.md", "openspec/changes/foo/tasks.md"];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), ["foo"]);
});

test("unarchivedChangeIdsFromPrFiles: archived-only id is not unarchived", () => {
  const paths = ["openspec/changes/archive/foo/proposal.md"];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), []);
});

test("unarchivedChangeIdsFromPrFiles: id present both active and archived nets to none remaining", () => {
  const paths = [
    "openspec/changes/foo/proposal.md",
    "openspec/changes/archive/foo/proposal.md",
  ];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), []);
});

test("unarchivedChangeIdsFromPrFiles: no openspec/changes paths → empty", () => {
  const paths = ["src/index.ts", "openspec/specs/auth/spec.md"];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), []);
});

test("unarchivedChangeIdsFromPrFiles: nested paths and multiple ids", () => {
  const paths = [
    "openspec/changes/foo/specs/x/spec.md",
    "openspec/changes/bar/proposal.md",
    "openspec/changes/archive/bar/proposal.md",
  ];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), ["foo"]);
});

test("unarchivedChangeIdsFromPrFiles: archive id itself excluded from active set", () => {
  const paths = ["openspec/changes/archive/proposal.md"];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), []);
});

test("unarchivedChangeIdsFromPrFiles: date-prefixed archive folder clears bare active id (#714)", () => {
  const paths = [
    "openspec/changes/foo/proposal.md",
    "openspec/changes/archive/2026-07-30-foo/proposal.md",
  ];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), []);
});

test("unarchivedChangeIdsFromPrFiles: multi active + foreign/stacked id only as active path (#714)", () => {
  const paths = [
    "openspec/changes/own-change/tasks.md",
    "openspec/changes/foreign-stacked/proposal.md",
    "src/index.ts",
  ];
  assert.deepEqual(unarchivedChangeIdsFromPrFiles(paths), ["foreign-stacked", "own-change"]);
});

test("unarchivedChangeIdsFromPrFiles: empty set when no change paths", () => {
  assert.deepEqual(unarchivedChangeIdsFromPrFiles([]), []);
});

test("changeIdFromArchiveFolderName: strips YYYY-MM-DD prefix", () => {
  assert.equal(changeIdFromArchiveFolderName("2026-07-30-foo"), "foo");
  assert.equal(changeIdFromArchiveFolderName("foo"), "foo");
  assert.equal(changeIdFromArchiveFolderName("2026-07-30-multi-dash-id"), "multi-dash-id");
});

test("sharedActiveChangeIdsFromPaths is the same function as unarchivedChangeIdsFromPrFiles (#714)", () => {
  assert.equal(sharedActiveChangeIdsFromPaths, unarchivedChangeIdsFromPrFiles);
});

test("shouldPlanWithOpenspec: off → false, on → true", () => {
  const d = tmpDir();
  assert.equal(shouldPlanWithOpenspec({ openspec: { enabled: "off", bootstrap: true } }, d), false);
  assert.equal(shouldPlanWithOpenspec({ openspec: { enabled: "on", bootstrap: false } }, d), true);
});

test("shouldPlanWithOpenspec: auto follows init, or bootstrap when uninitialized", () => {
  const d = tmpDir();
  assert.equal(shouldPlanWithOpenspec({ openspec: { enabled: "auto", bootstrap: false } }, d), false);
  assert.equal(shouldPlanWithOpenspec({ openspec: { enabled: "auto", bootstrap: true } }, d), true);
  fs.mkdirSync(path.join(d, "openspec"));
  assert.equal(shouldPlanWithOpenspec({ openspec: { enabled: "auto", bootstrap: false } }, d), true);
});

test("openspecContext: returns spec deltas when OpenSpec is active with a change", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "my-change", "specs", "feature");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "## ADDED Requirement: must support batch mode");
  const result = openspecContext({ openspec: { enabled: "on" } }, dir);
  assert.match(result, /must support batch mode/);
});

test("openspecContext: returns empty string when OpenSpec is inactive (mode off)", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "my-change", "specs");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "## ADDED Requirement");
  assert.equal(openspecContext({ openspec: { enabled: "off" } }, dir), "");
});

test("openspecContext: returns empty string when no change dirs exist", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "openspec", "changes"), { recursive: true });
  assert.equal(openspecContext({ openspec: { enabled: "on" } }, dir), "");
});

test("openspecContext: returns empty string when active change has no spec deltas", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "openspec", "changes", "empty-change"), { recursive: true });
  assert.equal(openspecContext({ openspec: { enabled: "on" } }, dir), "");
});

test("openspecContext: uses the first change dir when multiple exist", () => {
  const dir = tmpDir();
  const changes = path.join(dir, "openspec", "changes");
  const s1 = path.join(changes, "aaa-change", "specs");
  const s2 = path.join(changes, "zzz-change", "specs");
  fs.mkdirSync(s1, { recursive: true });
  fs.mkdirSync(s2, { recursive: true });
  fs.writeFileSync(path.join(s1, "spec.md"), "REQ-AAA");
  fs.writeFileSync(path.join(s2, "spec.md"), "REQ-ZZZ");
  const result = openspecContext({ openspec: { enabled: "on" } }, dir);
  // Should return spec deltas from whichever change listChangeDirs() picks first.
  assert.ok(result === "REQ-AAA" || result.includes("REQ-AAA") || result === "REQ-ZZZ" || result.includes("REQ-ZZZ"));
  // Should NOT include both (only the first change is used).
  assert.ok(!(result.includes("REQ-AAA") && result.includes("REQ-ZZZ")));
});

// ---------------------------------------------------------------------------
// openspecContextFromDiff — regression for multi-change worktrees in fix rounds
// ---------------------------------------------------------------------------

test("openspecContextFromDiff: returns inactive string when OpenSpec is off", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "my-change", "specs");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "REQ-X");
  const result = openspecContextFromDiff({ openspec: { enabled: "off" } }, dir, [
    "openspec/changes/my-change/proposal.md",
  ]);
  assert.equal(result, "");
});

test("openspecContextFromDiff: returns the matching change's spec deltas", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "new-change", "specs");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "REQ-NEW");
  const result = openspecContextFromDiff({ openspec: { enabled: "on" } }, dir, [
    "src/index.ts",
    "openspec/changes/new-change/proposal.md",
    "openspec/changes/new-change/tasks.md",
  ]);
  assert.match(result, /REQ-NEW/);
});

test("openspecContextFromDiff: returns empty string when diff has no OpenSpec change paths", () => {
  const dir = tmpDir();
  const specs = path.join(dir, "openspec", "changes", "my-change", "specs");
  fs.mkdirSync(specs, { recursive: true });
  fs.writeFileSync(path.join(specs, "spec.md"), "REQ-X");
  const result = openspecContextFromDiff({ openspec: { enabled: "on" } }, dir, [
    "src/index.ts",
    "README.md",
  ]);
  assert.equal(result, "");
});

test("openspecContextFromDiff: multi-change worktree — selects only the branch-introduced change", () => {
  // Regression: worktree has a pre-existing 'old-change' AND this branch's 'new-change'.
  // openspecContext() would pick changes[0] (alphabetically 'new-change' here, but
  // ordering is filesystem-dependent). openspecContextFromDiff must pick only 'new-change'
  // regardless of ordering, because only 'new-change' appears in the branch diff paths.
  const dir = tmpDir();
  const oldSpecs = path.join(dir, "openspec", "changes", "old-change", "specs");
  const newSpecs = path.join(dir, "openspec", "changes", "new-change", "specs");
  fs.mkdirSync(oldSpecs, { recursive: true });
  fs.mkdirSync(newSpecs, { recursive: true });
  fs.writeFileSync(path.join(oldSpecs, "spec.md"), "REQ-OLD-UNRELATED");
  fs.writeFileSync(path.join(newSpecs, "spec.md"), "REQ-NEW-CORRECT");

  // Branch diff only references new-change (old-change was already on base branch).
  const diffPaths = [
    "src/feature.ts",
    "openspec/changes/new-change/proposal.md",
    "openspec/changes/new-change/specs/spec.md",
  ];
  const result = openspecContextFromDiff({ openspec: { enabled: "on" } }, dir, diffPaths);
  assert.match(result, /REQ-NEW-CORRECT/);
  assert.ok(!result.includes("REQ-OLD-UNRELATED"), "must not include the pre-existing change's spec deltas");
});

test("openspecContextFromDiff: returns empty string when diff references a change not on disk", () => {
  // e.g. the diff references openspec/changes/gone-change/ but it was archived/deleted.
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "openspec", "changes"), { recursive: true });
  const result = openspecContextFromDiff({ openspec: { enabled: "on" } }, dir, [
    "openspec/changes/gone-change/proposal.md",
  ]);
  assert.equal(result, "");
});
