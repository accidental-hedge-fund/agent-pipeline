// review-routing.ts: round-aware reviewer model/effort resolution (#366).
//
// invokePromptHarnessReview resolves the reviewer model/effort as
// `cfg.harnesses.reviewerModel ?? cfg.models.review` and
// `cfg.harnesses.reviewerEffort ?? cfg.effort.review`, expanding "auto"
// round-aware (review-1 Iterative, review-2 Definitive). These tests spawn a
// local fake "claude" executable (same technique as harness.test.ts) so the
// actual CLI args reveal what invoke() received — a custom reviewer CLI would
// not surface --model/--effort in its argv at all, since only the two
// built-in harness shapes emit those flags.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { invokePromptHarnessReview } from "../scripts/stages/review-routing.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import { withPreflightReadiness } from "./_preflight-readiness-shim.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-review-routing-test-"));

function makeFakeClaude(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const cliPath = path.join(dir, "claude");
  fs.writeFileSync(cliPath, withPreflightReadiness(`printf '%s\\n' "$@"`));
  fs.chmodSync(cliPath, 0o755);
  return dir;
}

function makeFakeCodex(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const cliPath = path.join(dir, "codex");
  fs.writeFileSync(cliPath, withPreflightReadiness(`printf '%s\\n' "$@"`));
  fs.chmodSync(cliPath, 0o755);
  return dir;
}

function baseCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    repo_dir: tmpRoot,
    repo: "acme/widget",
    domain: "widget",
    review_timeout: 60,
    openspec: { enabled: "off", bootstrap: false },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet", intake: "sonnet", sweep: "sonnet" },
    effort: {},
    harnesses: { implementer: "codex", reviewer: "claude" },
    // These unit tests exercise model/effort CLI argv, not Tester evidence.
    // Without a runDir + SHA-matched artifact, default fail_closed withholds
    // the reviewer invoke (#646). Opt into fail_open so the harness runs.
    tester_evidence: { on_missing: "fail_open", max_output_chars: 4000, max_artifact_chars: 48_000, extractors: [] },
    ...overrides,
  } as unknown as PipelineConfig;
}

async function run(cfg: PipelineConfig, round: 1 | 2) {
  return invokePromptHarnessReview(
    cfg,
    42,
    "Test issue",
    "test body",
    "plan text",
    undefined,
    undefined,
    "diff text",
    round,
    tmpRoot,
    {},
  );
}

test("invokePromptHarnessReview: cfg.models.review reaches the claude invocation as --model", async () => {
  const binDir = makeFakeClaude();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg({ models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet", intake: "sonnet", sweep: "sonnet" } as any });
    const { result } = await run(cfg, 1);
    const lines = result.stdout.split("\n");
    const idx = lines.indexOf("--model");
    assert.ok(idx !== -1, "--model flag must be present");
    assert.equal(lines[idx + 1], "opus");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: cfg.harnesses.reviewerModel overrides cfg.models.review", async () => {
  const binDir = makeFakeClaude();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg({ harnesses: { implementer: "codex", reviewer: "claude", reviewerModel: "claude-fable-5" } as any });
    const { result } = await run(cfg, 1);
    const lines = result.stdout.split("\n");
    const idx = lines.indexOf("--model");
    assert.equal(lines[idx + 1], "claude-fable-5", "reviewerModel override must win over cfg.models.review");
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// codex reviewer model passthrough / auto-sentinel per-CLI resolution (#441)
// ---------------------------------------------------------------------------

test("invokePromptHarnessReview: codex reviewer + models.review: auto → no -m flag", async () => {
  const binDir = makeFakeCodex();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg({
      harnesses: { implementer: "claude", reviewer: "codex" } as any,
      models: {
        planning: "sonnet", implementing: "sonnet",
        review: "claude-fable-5", reviewWasAuto: true,
        fix: "sonnet", intake: "sonnet", sweep: "sonnet",
      } as any,
    });
    const { result } = await run(cfg, 2);
    const lines = result.stdout.split("\n");
    assert.equal(lines.indexOf("-m"), -1, "no -m flag when the resolved reviewer model is a claude-only alias");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: codex reviewer + structured review_harness.model: auto → no -m flag", async () => {
  const binDir = makeFakeCodex();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg({
      harnesses: { implementer: "claude", reviewer: "codex", reviewerModel: "claude-fable-5", reviewerModelWasAuto: true } as any,
    });
    const { result } = await run(cfg, 2);
    const lines = result.stdout.split("\n");
    assert.equal(lines.indexOf("-m"), -1, "no -m flag when the resolved reviewerModel override is a claude-only alias");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: codex reviewer + EXPLICIT review_harness.model (claude-only alias) is forwarded verbatim (#441)", async () => {
  const binDir = makeFakeCodex();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg({
      harnesses: { implementer: "claude", reviewer: "codex", reviewerModel: "sonnet" } as any,
    });
    const { result } = await run(cfg, 2);
    const lines = result.stdout.split("\n");
    const idx = lines.indexOf("-m");
    assert.notEqual(idx, -1, "an explicit (non-auto) reviewer model must reach codex verbatim");
    assert.equal(lines[idx + 1], "sonnet");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: codex reviewer + explicit codex-valid model → -m <model>", async () => {
  const binDir = makeFakeCodex();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg({
      harnesses: { implementer: "claude", reviewer: "codex" } as any,
      models: { planning: "sonnet", implementing: "sonnet", review: "gpt-5.6-terra", fix: "sonnet", intake: "sonnet", sweep: "sonnet" } as any,
    });
    const { result } = await run(cfg, 2);
    const lines = result.stdout.split("\n");
    const idx = lines.indexOf("-m");
    assert.ok(idx !== -1, "-m flag must be present for an explicit codex-valid model");
    assert.equal(lines[idx + 1], "gpt-5.6-terra");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: claude reviewer + auto still resolves -m claude-fable-5 (round-aware, unchanged)", async () => {
  const binDir = makeFakeClaude();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg({
      harnesses: { implementer: "codex", reviewer: "claude" } as any,
      models: { planning: "sonnet", implementing: "sonnet", review: "claude-fable-5", fix: "sonnet", intake: "sonnet", sweep: "sonnet" } as any,
    });
    const { result } = await run(cfg, 2);
    const lines = result.stdout.split("\n");
    const idx = lines.indexOf("--model");
    assert.ok(idx !== -1, "--model flag must be present for a claude reviewer");
    assert.equal(lines[idx + 1], "claude-fable-5");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: effort.review 'auto' resolves round-1 as Iterative (high)", async () => {
  const binDir = makeFakeClaude();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg({ effort: { review: "auto" } as any });
    const { result } = await run(cfg, 1);
    const lines = result.stdout.split("\n");
    const idx = lines.indexOf("--effort");
    assert.ok(idx !== -1, "--effort flag must be present");
    assert.equal(lines[idx + 1], "high", "review-1 is Adversarial/Iterative");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: effort.review 'auto' resolves round-2 as Definitive (max) — same key, different round", async () => {
  const binDir = makeFakeClaude();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg({ effort: { review: "auto" } as any });
    const { result } = await run(cfg, 2);
    const lines = result.stdout.split("\n");
    const idx = lines.indexOf("--effort");
    assert.equal(lines[idx + 1], "max", "review-2 is Adversarial/Definitive");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: cfg.harnesses.reviewerEffort overrides cfg.effort.review, round-aware", async () => {
  const binDir = makeFakeClaude();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg({
      effort: { review: "low" } as any,
      harnesses: { implementer: "codex", reviewer: "claude", reviewerEffort: "auto" } as any,
    });
    const { result: r1 } = await run(cfg, 1);
    const { result: r2 } = await run(cfg, 2);
    const effortOf = (stdout: string) => {
      const lines = stdout.split("\n");
      return lines[lines.indexOf("--effort") + 1];
    };
    assert.equal(effortOf(r1.stdout), "high", "round-1: reviewerEffort auto overrides cfg.effort.review, Iterative");
    assert.equal(effortOf(r2.stdout), "max", "round-2: reviewerEffort auto overrides cfg.effort.review, Definitive");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: explicit (non-auto) effort.review passes through unchanged for both rounds", async () => {
  const binDir = makeFakeClaude();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg({ effort: { review: "critical" } as any });
    const { result: r1 } = await run(cfg, 1);
    const { result: r2 } = await run(cfg, 2);
    for (const result of [r1, r2]) {
      const lines = result.stdout.split("\n");
      assert.equal(lines[lines.indexOf("--effort") + 1], "critical");
    }
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: effort.review absent — no --effort flag forwarded", async () => {
  const binDir = makeFakeClaude();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = baseCfg();
    const { result } = await run(cfg, 1);
    assert.doesNotMatch(result.stdout, /--effort/, "no --effort flag when effort.review is unset");
  } finally {
    process.env.PATH = oldPath;
  }
});

// #882: fail_closed + empty runDir used to withhold forever (workflow-state park).
// Review must call the deterministic producer once before withhold; when the
// producer writes SHA-matched evidence, the model invoke proceeds.
// Non-git cwd → acquisition uses 40 zero-hex placeholder; producer writes that pin.
test("invokePromptHarnessReview: fail_closed missing evidence regenerates then invokes reviewer", async () => {
  const binDir = makeFakeClaude();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const wt = fs.mkdtempSync(path.join(tmpRoot, "wt-"));
  const runDir = fs.mkdtempSync(path.join(tmpRoot, "run-"));
  const zeroSha = "0".repeat(40);
  let gateCalls = 0;
  try {
    const cfg = baseCfg({
      tester_evidence: {
        on_missing: "fail_closed",
        max_output_chars: 4000,
        max_artifact_chars: 48_000,
        extractors: [],
      },
    });
    const { result, effectiveReviewer } = await invokePromptHarnessReview(
      cfg,
      882,
      "Test issue",
      "test body",
      "plan text",
      undefined,
      undefined,
      "diff text",
      1,
      wt,
      {
        runDir,
        pipelineRunId: "882-test",
        runTestGate: async () => {
          gateCalls += 1;
          const { writeTesterEvidence, buildTesterEvidence } = await import(
            "../scripts/tester-evidence.ts"
          );
          const evidence = buildTesterEvidence({
            candidateSha: zeroSha,
            runId: path.basename(runDir),
            issue: 882,
            wtPath: wt,
            enabled: true,
            commandIdentity: "npm test",
            timeoutSec: 60,
            maxOutputChars: 4000,
            startedAt: "2026-08-06T00:00:00Z",
            endedAt: "2026-08-06T00:00:01Z",
            durationMs: 1000,
            overallStatus: "passed",
            lastCommand: {
              identity: "npm test",
              exitCode: 0,
              durationMs: 1000,
              status: "passed",
              output: "ok",
            },
          });
          await writeTesterEvidence(runDir, evidence, { appendEvent: false });
          return { skipped: false, passed: true, attempts: 0 };
        },
      },
    );
    assert.equal(gateCalls, 1, "must regenerate suite evidence once when missing");
    assert.notEqual(effectiveReviewer, "tester-evidence-gate");
    assert.equal(result.success, true);
    assert.ok(result.stdout.length > 0);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("invokePromptHarnessReview: fail_closed still withholds when regenerate writes nothing", async () => {
  const binDir = makeFakeClaude();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const wt = fs.mkdtempSync(path.join(tmpRoot, "wt-"));
  const runDir = fs.mkdtempSync(path.join(tmpRoot, "run-"));
  let gateCalls = 0;
  try {
    const cfg = baseCfg({
      tester_evidence: {
        on_missing: "fail_closed",
        max_output_chars: 4000,
        max_artifact_chars: 48_000,
        extractors: [],
      },
    });
    const { result, effectiveReviewer } = await invokePromptHarnessReview(
      cfg,
      882,
      "Test issue",
      "test body",
      "plan text",
      undefined,
      undefined,
      "diff text",
      1,
      wt,
      {
        runDir,
        pipelineRunId: "882-test",
        runTestGate: async () => {
          gateCalls += 1;
          return { skipped: false, passed: true, attempts: 0 };
        },
      },
    );
    assert.equal(gateCalls, 1);
    assert.equal(effectiveReviewer, "tester-evidence-gate");
    assert.equal(result.success, false);
    assert.match(result.stderr, /fail_closed|missing tester-evidence/i);
  } finally {
    process.env.PATH = oldPath;
  }
});
