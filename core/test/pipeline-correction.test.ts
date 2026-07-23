// CLI tests for `pipeline correction record` (#499) — a narrow, non-mutating
// command that records exactly one correction_event against an existing run.
// Exercised as a real subprocess (spawnSync) against a real tmp git-less repo
// dir, mirroring the pattern used for --remove-worktree/refine-spec CLI tests
// in worktree-remove.test.ts — no real network, gh, or GitHub state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_REGISTRY, lookupCommand } from "../scripts/command-registry.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_SCRIPT = path.join(__dirname, "..", "scripts", "pipeline.ts");

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, ...args],
    { encoding: "utf8", cwd, env: { ...process.env, PATH: process.env.PATH ?? "" } },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeRunJson(repoDir: string, runId: string, issue: number, repo = "acme/repo"): string {
  const dir = path.join(repoDir, ".agent-pipeline", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ schema_version: 1, run_id: runId, issue, repo }));
  return dir;
}

function requiredArgs(overrides: Record<string, string> = {}): string[] {
  const base: Record<string, string> = {
    "--issue": "499",
    "--source-kind": "manual",
    "--failure-class": "other",
    "--stage": "review-2",
    "--evidence-ref": "finding:abc12345",
    "--correction-text": "operator manually confirmed the fix",
    "--reusable": "unknown",
  };
  const merged = { ...base, ...overrides };
  return Object.entries(merged).flatMap(([k, v]) => [k, v]);
}

// ---------------------------------------------------------------------------
// command-registry (#499): correction entry shape
// ---------------------------------------------------------------------------

test("command-registry: correction entry is non-mutating and needs no gh auth", () => {
  const entry = COMMAND_REGISTRY.correction;
  assert.ok(entry !== undefined);
  assert.equal(entry.mutatesGitHub, false);
  assert.equal(entry.needsGhAuth, false);
  assert.equal(entry.needsIssueNumber, false);
  for (const flag of ["issue", "runId", "sourceKind", "failureClass", "stage", "evidenceRef", "correctionText", "reusable", "proposedControl", "reviewedSha", "headSha"]) {
    assert.ok((entry.allowedFlags as Set<string>).has(flag), `correction.allowedFlags should include "${flag}"`);
  }
});

test("command-registry: lookupCommand('correction') returns the correction entry", () => {
  assert.equal(lookupCommand("correction"), COMMAND_REGISTRY.correction);
});

// ---------------------------------------------------------------------------
// CLI: success path
// ---------------------------------------------------------------------------

test("pipeline correction record: complete invocation appends exactly one correction_event and exits 0", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-"));
  try {
    const runDir = writeRunJson(tmp, "499-2026-07-23T00-00-00-000Z", 499);
    const result = runCli(["correction", "record", "--repo-path", tmp, ...requiredArgs()], tmp);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "correction_event");
    assert.equal(events[0].source_kind, "manual");
    assert.equal(events[0].actor_kind, "human");
    assert.deepEqual(events[0].evidence_ref, { kind: "finding", id: "abc12345" });
    assert.equal(events[0].correction, "operator manually confirmed the fix");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pipeline correction record: rejects retry/repair — those source kinds are reserved for the pipeline-owned recovery/repair paths — regression for #499 review-2 finding 34d10c78", () => {
  for (const sourceKind of ["retry", "repair"]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-actor-"));
    try {
      const runDir = writeRunJson(tmp, "499-2026-07-23T00-00-00-000Z", 499);
      const result = runCli(["correction", "record", "--repo-path", tmp, ...requiredArgs({ "--source-kind": sourceKind })], tmp);
      assert.notEqual(result.status, 0, `--source-kind ${sourceKind} should be rejected`);
      assert.match(result.stderr, /--source-kind/);
      assert.equal(fs.existsSync(path.join(runDir, "events.jsonl")), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test("pipeline correction record: --run-id pins an explicit run over the latest-matching one", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-runid-"));
  try {
    writeRunJson(tmp, "499-2026-07-23T00-01-00-000Z", 499); // newer
    const olderRunDir = writeRunJson(tmp, "499-2026-07-23T00-00-00-000Z", 499); // older, explicitly pinned
    const result = runCli(
      ["correction", "record", "--repo-path", tmp, "--run-id", "499-2026-07-23T00-00-00-000Z", ...requiredArgs()],
      tmp,
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(fs.existsSync(path.join(olderRunDir, "events.jsonl")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: failure paths — append nothing, exit non-zero
// ---------------------------------------------------------------------------

test("pipeline correction record: missing required field exits non-zero and appends nothing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-missing-"));
  try {
    const runDir = writeRunJson(tmp, "499-2026-07-23T00-00-00-000Z", 499);
    const args = requiredArgs();
    const idx = args.indexOf("--reusable");
    args.splice(idx, 2); // drop --reusable and its value
    const result = runCli(["correction", "record", "--repo-path", tmp, ...args], tmp);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--reusable/);
    assert.equal(fs.existsSync(path.join(runDir, "events.jsonl")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pipeline correction record: unlocatable run exits non-zero and appends nothing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-no-run-"));
  try {
    const result = runCli(["correction", "record", "--repo-path", tmp, ...requiredArgs()], tmp);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(tmp, ".agent-pipeline", "runs")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pipeline correction record: --run-id pointing at a nonexistent run directory exits non-zero and appends nothing — regression for #499 finding 9f3a5ede", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-ghost-run-"));
  try {
    const result = runCli(
      ["correction", "record", "--repo-path", tmp, "--run-id", "499-2026-07-23T00-00-00-000Z", ...requiredArgs()],
      tmp,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not be read/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pipeline correction record: run belonging to a different issue exits non-zero and appends nothing — regression for #499 finding 9f3a5ede", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-wrong-issue-"));
  try {
    const runDir = writeRunJson(tmp, "777-2026-07-23T00-00-00-000Z", 777);
    const result = runCli(
      ["correction", "record", "--repo-path", tmp, "--run-id", "777-2026-07-23T00-00-00-000Z", ...requiredArgs()],
      tmp,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /belongs to issue #777, not #499/);
    assert.equal(fs.existsSync(path.join(runDir, "events.jsonl")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pipeline correction record: malformed run.json exits non-zero and appends nothing — regression for #499 finding 9f3a5ede", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-malformed-run-"));
  try {
    const runDir = path.join(tmp, ".agent-pipeline", "runs", "499-2026-07-23T00-00-00-000Z");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "run.json"), "{ not valid json");
    const result = runCli(
      ["correction", "record", "--repo-path", tmp, "--run-id", "499-2026-07-23T00-00-00-000Z", ...requiredArgs()],
      tmp,
    );
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(runDir, "events.jsonl")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pipeline correction record: invalid --source-kind exits non-zero and appends nothing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-bad-kind-"));
  try {
    const runDir = writeRunJson(tmp, "499-2026-07-23T00-00-00-000Z", 499);
    const result = runCli(["correction", "record", "--repo-path", tmp, ...requiredArgs({ "--source-kind": "not-a-real-kind" })], tmp);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(runDir, "events.jsonl")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pipeline correction record: malformed --evidence-ref (no colon) exits non-zero and appends nothing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-bad-evref-"));
  try {
    const runDir = writeRunJson(tmp, "499-2026-07-23T00-00-00-000Z", 499);
    const result = runCli(["correction", "record", "--repo-path", tmp, ...requiredArgs({ "--evidence-ref": "no-colon-here" })], tmp);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(runDir, "events.jsonl")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: authority boundary — undeclared flag rejected before any side effect
// ---------------------------------------------------------------------------

test("pipeline correction record: an undeclared flag is rejected with exit 2 before any append", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-undeclared-flag-"));
  try {
    const runDir = writeRunJson(tmp, "499-2026-07-23T00-00-00-000Z", 499);
    const result = runCli(["correction", "record", "--repo-path", tmp, "--dry-run", ...requiredArgs()], tmp);
    assert.equal(result.status, 2, `stderr: ${result.stderr}`);
    assert.equal(fs.existsSync(path.join(runDir, "events.jsonl")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pipeline correction record: mutates no GitHub or code state — only side effect is the appended event", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cli-no-mutation-"));
  try {
    const runDir = writeRunJson(tmp, "499-2026-07-23T00-00-00-000Z", 499);
    const before = fs.readdirSync(tmp).sort();
    const result = runCli(["correction", "record", "--repo-path", tmp, ...requiredArgs()], tmp);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const after = fs.readdirSync(tmp).sort();
    assert.deepEqual(before, after, "no new top-level files/dirs beyond the existing run directory");
    assert.ok(fs.existsSync(path.join(runDir, "events.jsonl")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
