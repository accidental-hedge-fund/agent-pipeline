// SHA-pinned Tester evidence (#646) — pure helpers, producer matrix, acquisition,
// redaction, persistence, and scoreboard extractors. No real network/git/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  appendTargetedCheck,
  appendTesterEvidenceSection,
  boundExcerpt,
  buildTesterEvidence,
  buildToolchainFingerprint,
  candidateShaMatches,
  computeConfigDigest,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_TESTER_EVIDENCE_CONFIG,
  deriveOverallStatus,
  enforceArtifactBudget,
  extractTesterMetricsFromEvent,
  extractTesterMetricsFromEvidence,
  formatTesterEvidenceSummary,
  loadTesterEvidenceForReview,
  loadTesterEvidenceForReviewSync,
  normalizeCandidateSha,
  renderTesterEvidenceSection,
  runAllowlistedExtractors,
  stableStringify,
  TESTER_EVIDENCE_KIND,
  TESTER_EVIDENCE_SCHEMA_VERSION,
  testerEvidencePath,
  validateTesterEvidence,
  worktreeIdFromPath,
  writeTesterEvidence,
  type TesterEvidence,
  type TesterEvidenceIoDeps,
  type TesterExtractor,
} from "../scripts/tester-evidence.ts";
import { runTestGate, type RunTestsResult, type TestGateDeps } from "../scripts/testgate.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import { DEFAULT_CONFIG } from "../scripts/types.ts";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function memoryIo(files: Map<string, string> = new Map()): TesterEvidenceIoDeps & {
  files: Map<string, string>;
} {
  return {
    files,
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    rename: async (from, to) => {
      const data = files.get(from);
      if (data === undefined) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.set(to, data);
      files.delete(from);
    },
    mkdir: async () => {},
    appendFile: async (p, data) => {
      files.set(p, (files.get(p) ?? "") + data);
    },
  };
}

function baseEvidence(over: Partial<TesterEvidence> = {}): TesterEvidence {
  return {
    schema_version: TESTER_EVIDENCE_SCHEMA_VERSION,
    kind: TESTER_EVIDENCE_KIND,
    candidate_sha: SHA_A,
    run_id: "646/test-run",
    issue: 646,
    pr: null,
    worktree_id: "pipeline-646-wt",
    config_digest: computeConfigDigest({
      command_identity: "npm test",
      enabled: true,
      timeout: 300,
      max_output_chars: 4000,
    }),
    toolchain_fingerprint: { node: "v24.0.0", platform: "linux", arch: "x64" },
    started_at: "2026-08-05T16:00:00Z",
    ended_at: "2026-08-05T16:00:05Z",
    duration_ms: 5000,
    overall_status: "passed",
    commands: [
      {
        identity: "npm test",
        exit_code: 0,
        duration_ms: 4800,
        status: "passed",
        output_excerpt: "ok",
      },
    ],
    output_excerpt: "ok",
    producer: { component: "test-build-gate" },
    ...over,
  };
}

function cfgWith(
  over: Partial<PipelineConfig> & {
    test_gate?: Partial<PipelineConfig["test_gate"]>;
    tester_evidence?: Partial<PipelineConfig["tester_evidence"]>;
  } = {},
): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    profile_name: "codex",
    invocation: "$pipeline",
    review_mode: "prompt-harness",
    marker_footer: "—",
    implementation_ready_message: "ready",
    conventions_default: "CLAUDE.md",
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/tmp/does-not-exist",
    harnesses: { implementer: "codex", reviewer: "claude" },
    ...over,
    test_gate: {
      ...DEFAULT_CONFIG.test_gate,
      enabled: true,
      max_attempts: 1,
      timeout: 30,
      ...over.test_gate,
    },
    tester_evidence: {
      ...DEFAULT_CONFIG.tester_evidence,
      ...over.tester_evidence,
    },
  } as PipelineConfig;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("normalizeCandidateSha / candidateShaMatches: full hex equality case-insensitive", () => {
  assert.equal(normalizeCandidateSha(SHA_A.toUpperCase()), SHA_A);
  assert.equal(candidateShaMatches(SHA_A.toUpperCase(), SHA_A), true);
  assert.equal(candidateShaMatches(SHA_A, SHA_B), false);
  assert.equal(normalizeCandidateSha("deadbeef"), null);
  assert.equal(normalizeCandidateSha(""), null);
});

test("computeConfigDigest: stable under key insertion order", () => {
  const a = computeConfigDigest({
    command_identity: "npm test",
    enabled: true,
    timeout: 300,
    max_output_chars: 4000,
  });
  const b = computeConfigDigest({
    max_output_chars: 4000,
    timeout: 300,
    enabled: true,
    command_identity: "npm test",
  });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  const c = computeConfigDigest({
    command_identity: "pnpm test",
    enabled: true,
    timeout: 300,
    max_output_chars: 4000,
  });
  assert.notEqual(a, c);
});

test("stableStringify sorts nested keys", () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: 3 } }),
    stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
  );
});

test("worktreeIdFromPath uses basename only", () => {
  assert.equal(worktreeIdFromPath("/home/me/dev/repo/.worktrees/pipeline-646-feat"), "pipeline-646-feat");
  assert.equal(worktreeIdFromPath("/tmp/wt/"), "wt");
});

test("toolchain fingerprint allowlist only", () => {
  const fp = buildToolchainFingerprint({
    node: "v24.1.0",
    platform: "linux",
    arch: "x64",
  });
  assert.deepEqual(fp, { node: "v24.1.0", platform: "linux", arch: "x64" });
  assert.equal("PATH" in fp, false);
});

test("deriveOverallStatus precedence", () => {
  assert.equal(deriveOverallStatus({ enabled: false, commandResolved: true }), "disabled");
  assert.equal(
    deriveOverallStatus({ enabled: true, commandResolved: false }),
    "not_run",
  );
  assert.equal(
    deriveOverallStatus({
      enabled: true,
      commandResolved: true,
      dirtyUnavailable: true,
    }),
    "unavailable",
  );
  assert.equal(
    deriveOverallStatus({
      enabled: true,
      commandResolved: true,
      toolingFailure: true,
      timedOut: true,
      exitFailed: true,
    }),
    "tooling_failure",
  );
  assert.equal(
    deriveOverallStatus({
      enabled: true,
      commandResolved: true,
      timedOut: true,
      exitFailed: true,
    }),
    "timeout",
  );
  assert.equal(
    deriveOverallStatus({
      enabled: true,
      commandResolved: true,
      exitFailed: true,
    }),
    "failed",
  );
  assert.equal(
    deriveOverallStatus({ enabled: true, commandResolved: true }),
    "passed",
  );
  assert.equal(
    deriveOverallStatus({
      enabled: true,
      commandResolved: true,
      partial: true,
    }),
    "partial",
  );
});

test("boundExcerpt truncates with marker and redacts secrets", () => {
  const long = "x".repeat(100);
  const truncated = boundExcerpt(long, 40);
  assert.ok(truncated.length <= 40 + 20); // marker overhead
  assert.match(truncated, /truncated/);
  const secret = boundExcerpt("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  assert.match(secret, /\[REDACTED\]/);
  assert.equal(secret.includes("ghp_ABCDEF"), false);
});

test("enforceArtifactBudget shrinks oversized artifacts", () => {
  const huge = baseEvidence({
    output_excerpt: "Y".repeat(20_000),
    commands: [
      {
        identity: "npm test",
        exit_code: 1,
        duration_ms: 1,
        status: "failed",
        output_excerpt: "Z".repeat(20_000),
      },
    ],
  });
  const shrunk = enforceArtifactBudget(huge, 2_000);
  assert.ok(JSON.stringify(shrunk).length <= 2_000 + 200);
});

test("validateTesterEvidence accepts pass record and rejects malformed", () => {
  const ok = validateTesterEvidence(baseEvidence());
  assert.equal(ok.ok, true);
  const bad = validateTesterEvidence({ ...baseEvidence(), candidate_sha: "short" });
  assert.equal(bad.ok, false);
  const wrongKind = validateTesterEvidence({ ...baseEvidence(), kind: "other" });
  assert.equal(wrongKind.ok, false);
});

test("runAllowlistedExtractors: empty / unknown / malformed preserve no invented rows", () => {
  assert.deepEqual(runAllowlistedExtractors("ok", []).tests, []);
  const unknown = runAllowlistedExtractors("ok", ["nope"]);
  assert.deepEqual(unknown.tests, []);
  assert.match(unknown.diagnostic ?? "", /unknown extractor/);

  const registry: Record<string, TesterExtractor> = {
    boom: () => {
      throw new Error("parse fail");
    },
    bad: () => ({ ok: false, reason: "malformed payload" }),
    good: () => ({
      ok: true,
      tests: [{ identity: "a.test.ts", status: "passed" }],
    }),
  };
  const mixed = runAllowlistedExtractors("out", ["boom", "bad", "good"], registry);
  assert.equal(mixed.tests.length, 1);
  assert.equal(mixed.tests[0].identity, "a.test.ts");
  assert.match(mixed.diagnostic ?? "", /malformed|threw|boom/i);
});

// ---------------------------------------------------------------------------
// Prompt + acquisition
// ---------------------------------------------------------------------------

test("renderTesterEvidenceSection labels authoritative suite evidence", () => {
  const acq = loadTesterEvidenceForReviewSync(
    { status: "ok", evidence: baseEvidence() },
    SHA_A,
    "fail_closed",
  );
  assert.equal(acq.classification, "current");
  assert.equal(acq.withholdInvoke, false);
  assert.match(acq.section, /authoritative/i);
  assert.match(acq.section, /passed/);
  assert.ok(acq.section.includes(SHA_A));
});

test("stale SHA never presents as suite pass for current candidate", () => {
  const acq = loadTesterEvidenceForReviewSync(
    { status: "ok", evidence: baseEvidence({ candidate_sha: SHA_A, overall_status: "passed" }) },
    SHA_B,
    "fail_closed",
  );
  assert.equal(acq.classification, "stale");
  assert.equal(acq.withholdInvoke, true);
  assert.match(acq.section, /stale/i);
  assert.match(acq.section, /not allowed/i);
  assert.doesNotMatch(acq.section, /\*\*Overall status:\*\* `passed`/);
});

test("fail_closed missing withholds; fail_open does not imply pass", () => {
  const closed = loadTesterEvidenceForReviewSync({ status: "missing" }, SHA_A, "fail_closed");
  assert.equal(closed.withholdInvoke, true);
  assert.match(closed.section, /missing|not current/i);
  assert.doesNotMatch(closed.section, /Overall status:\*\* `passed`/);

  const open = loadTesterEvidenceForReviewSync({ status: "missing" }, SHA_A, "fail_open");
  assert.equal(open.withholdInvoke, false);
  assert.match(open.section, /missing|not current/i);
});

test("malformed is not treated as passed", () => {
  const acq = loadTesterEvidenceForReviewSync(
    { status: "malformed", reason: "bad json" },
    SHA_A,
    "fail_closed",
  );
  assert.equal(acq.classification, "malformed");
  assert.equal(acq.withholdInvoke, true);
  assert.doesNotMatch(acq.section, /Overall status:\*\* `passed`/);
});

test("appendTesterEvidenceSection is shared bytes for ensemble (pure append)", () => {
  const acq = loadTesterEvidenceForReviewSync(
    { status: "ok", evidence: baseEvidence() },
    SHA_A,
  );
  const core = "REVIEW CORE PROMPT";
  const a = appendTesterEvidenceSection(core, acq);
  const b = appendTesterEvidenceSection(core, acq);
  assert.equal(a, b);
  assert.ok(a.includes(core));
  assert.ok(a.includes("Tester suite evidence"));
});

test("formatTesterEvidenceSummary is compact", () => {
  const s = formatTesterEvidenceSummary(baseEvidence());
  assert.match(s, /passed/);
  assert.match(s, /aaaaaaa/);
  assert.doesNotMatch(s, /Y{100}/);
});

test("loadTesterEvidenceForReview without runDir does not withhold", async () => {
  const acq = await loadTesterEvidenceForReview(undefined, SHA_A, {
    tester_evidence: DEFAULT_TESTER_EVIDENCE_CONFIG,
  });
  assert.equal(acq.classification, "missing");
  assert.equal(acq.withholdInvoke, false);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test("writeTesterEvidence atomic write + successful event shape fields", async () => {
  const io = memoryIo();
  const runDir = "/runs/r1";
  const evidence = baseEvidence();
  const events: unknown[] = [];
  const result = await writeTesterEvidence(runDir, evidence, {
    io,
    appendEvent: false,
  });
  assert.equal(result.ok, true);
  const raw = await io.readFile(testerEvidencePath(runDir));
  const parsed = JSON.parse(raw);
  const v = validateTesterEvidence(parsed);
  assert.equal(v.ok, true);
  // still verify event extractor shape
  events.push({
    type: "tester_evidence",
    overall_status: evidence.overall_status,
    duration_ms: evidence.duration_ms,
    command_count: evidence.commands.length,
  });
  const m = extractTesterMetricsFromEvent(events[0] as Record<string, unknown>);
  assert.deepEqual(m, {
    duration_ms: 5000,
    command_count: 1,
    overall_status: "passed",
  });
});

test("targeted check cannot overwrite authoritative file", async () => {
  const io = memoryIo();
  const runDir = "/runs/r2";
  await writeTesterEvidence(runDir, baseEvidence({ overall_status: "failed" }), {
    io,
    appendEvent: false,
  });
  await appendTargetedCheck(
    runDir,
    {
      schema_version: 1,
      kind: "tester_targeted_check",
      candidate_sha: SHA_A,
      run_id: "r2",
      issue: 646,
      identity: "npm test -- one",
      exit_code: 0,
      duration_ms: 10,
      status: "passed",
      output_excerpt: "ok",
      recorded_at: "2026-08-05T16:01:00Z",
      source: "deterministic_runner",
      producer: { component: "reviewer-targeted" },
    },
    { io },
  );
  const auth = JSON.parse(await io.readFile(testerEvidencePath(runDir)));
  assert.equal(auth.overall_status, "failed");
  assert.ok(io.files.has(path.join(runDir, "targeted-checks.jsonl")));
});

test("buildTesterEvidence maps statuses and bounds output", () => {
  const e = buildTesterEvidence({
    candidateSha: SHA_A,
    runId: "r",
    issue: 1,
    wtPath: "/repo/.worktrees/wt-1",
    enabled: true,
    commandIdentity: "npm test",
    timeoutSec: 30,
    maxOutputChars: 50,
    startedAt: "2026-08-05T00:00:00Z",
    endedAt: "2026-08-05T00:00:01Z",
    durationMs: 1000,
    overallStatus: "timeout",
    overallReason: "timed out",
    lastCommand: {
      identity: "npm test",
      exitCode: null,
      durationMs: 1000,
      status: "timeout",
      output: "x".repeat(500) + " ghp_ABCDEFGHIJKLMNOPQRSTUV",
    },
  });
  assert.equal(e.overall_status, "timeout");
  assert.equal(e.commands[0].status, "timeout");
  assert.ok(e.commands[0].output_excerpt.length <= 50 + 30);
  assert.match(e.commands[0].output_excerpt, /REDACTED|truncated/);
  assert.equal(e.worktree_id, "wt-1");
  assert.equal(e.producer.component, "test-build-gate");
});

test("extractTesterMetricsFromEvidence structured fields", () => {
  const m = extractTesterMetricsFromEvidence(baseEvidence(), { count: 2, duration_ms: 30 });
  assert.equal(m.duration_ms, 5000);
  assert.equal(m.command_count, 1);
  assert.equal(m.overall_status, "passed");
  assert.equal(m.targeted_check_count, 2);
});

// ---------------------------------------------------------------------------
// Producer via runTestGate (injected seams)
// ---------------------------------------------------------------------------

test("runTestGate producer: passed writes SHA-pinned evidence", async () => {
  const ioFiles = new Map<string, string>();
  // Hijack write by using a real runDir under memory via intercepting writeTesterEvidence
  // is hard; instead use filesystem-less path: inject gitHead full SHA and spy via deps
  // that use a temp-like in-memory by patching — producer uses writeTesterEvidence with
  // default fs. Use a node:fs real temp dir for this one producer path only.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-te-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-te-wt-"));
  try {
    const pass: RunTestsResult = {
      passed: true,
      output: "all good",
      durationSec: 1.2,
      toolingError: false,
    };
    const deps: TestGateDeps = {
      runTests: async () => pass,
      detectTestCommand: () => ({ cmd: "npm", args: ["test"] }),
      gitHead: async () => SHA_A,
      gitDirty: async () => false,
      gitStatusPorcelain: async () => "",
    };
    const res = await runTestGate(
      cfgWith({ test_gate: { command: "npm test", max_attempts: 1 } }),
      646,
      wt,
      deps,
      "646/run",
      "test-gate",
      undefined,
      runDir,
    );
    assert.equal(res.passed, true);
    const raw = fs.readFileSync(path.join(runDir, "tester-evidence.json"), "utf8");
    const evidence = JSON.parse(raw) as TesterEvidence;
    assert.equal(evidence.candidate_sha, SHA_A);
    assert.equal(evidence.overall_status, "passed");
    assert.equal(evidence.commands.length, 1);
    assert.equal(evidence.producer.component, "test-build-gate");
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test("runTestGate producer: failed / timeout / tooling / disabled / not_run / dirty", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");

  async function runCase(
    name: string,
    setup: {
      cfg?: ReturnType<typeof cfgWith>;
      deps: TestGateDeps;
      expectStatus: string;
    },
  ): Promise<void> {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `pipeline-te-${name}-`));
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), `pipeline-te-wt-${name}-`));
    try {
      await runTestGate(
        setup.cfg ?? cfgWith({ test_gate: { command: "npm test", max_attempts: 0 } }),
        646,
        wt,
        {
          gitHead: async () => SHA_A,
          gitDirty: async () => false,
          gitStatusPorcelain: async () => "",
          ...setup.deps,
        },
        "646/run",
        "test-gate",
        undefined,
        runDir,
      );
      const raw = fs.readFileSync(path.join(runDir, "tester-evidence.json"), "utf8");
      const evidence = JSON.parse(raw) as TesterEvidence;
      assert.equal(
        evidence.overall_status,
        setup.expectStatus,
        `${name}: expected ${setup.expectStatus}`,
      );
      assert.equal(evidence.candidate_sha, SHA_A);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
    }
  }

  await runCase("failed", {
    deps: {
      runTests: async () => ({
        passed: false,
        output: "FAIL",
        durationSec: 1,
        toolingError: false,
      }),
    },
    expectStatus: "failed",
  });

  await runCase("timeout", {
    deps: {
      runTests: async () => ({
        passed: false,
        output: "timeout",
        durationSec: 30,
        toolingError: false,
        timed_out: true,
      }),
    },
    expectStatus: "timeout",
  });

  await runCase("tooling", {
    deps: {
      runTests: async () => ({
        passed: false,
        output: "spawn failed",
        durationSec: 0.1,
        toolingError: true,
      }),
    },
    expectStatus: "tooling_failure",
  });

  await runCase("disabled", {
    cfg: cfgWith({ test_gate: { enabled: false } }),
    deps: {
      runTests: async () => {
        throw new Error("should not run");
      },
    },
    expectStatus: "disabled",
  });

  await runCase("not_run", {
    cfg: cfgWith({ test_gate: { enabled: true, command: undefined } }),
    deps: {
      detectTestCommand: () => null,
      runTests: async () => {
        throw new Error("should not run");
      },
    },
    expectStatus: "not_run",
  });

  await runCase("dirty", {
    deps: {
      gitDirty: async () => true,
      gitStatusPorcelain: async () => " M core/scripts/foo.ts",
      runTests: async () => {
        throw new Error("should not run");
      },
    },
    expectStatus: "unavailable",
  });
});

test("post-fix regeneration: new HEAD overwrites prior evidence (stale until rewrite)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-te-regen-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-te-wt-regen-"));
  try {
    let head = SHA_A;
    const deps: TestGateDeps = {
      runTests: async () => ({
        passed: true,
        output: "ok",
        durationSec: 1,
        toolingError: false,
      }),
      gitHead: async () => head,
      gitDirty: async () => false,
      gitStatusPorcelain: async () => "",
    };
    await runTestGate(
      cfgWith({ test_gate: { command: "npm test", max_attempts: 0 } }),
      646,
      wt,
      deps,
      "646/run",
      "test-gate",
      undefined,
      runDir,
    );
    let acq = await loadTesterEvidenceForReview(runDir, SHA_A, cfgWith());
    assert.equal(acq.classification, "current");

    head = SHA_B;
    acq = await loadTesterEvidenceForReview(runDir, SHA_B, cfgWith());
    assert.equal(acq.classification, "stale");

    await runTestGate(
      cfgWith({ test_gate: { command: "npm test", max_attempts: 0 } }),
      646,
      wt,
      deps,
      "646/run",
      "test-gate",
      undefined,
      runDir,
    );
    acq = await loadTesterEvidenceForReview(runDir, SHA_B, cfgWith());
    assert.equal(acq.classification, "current");
    assert.equal(acq.artifact?.candidate_sha, SHA_B);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test("default max_output_chars constant", () => {
  assert.equal(DEFAULT_MAX_OUTPUT_CHARS, 4000);
});
