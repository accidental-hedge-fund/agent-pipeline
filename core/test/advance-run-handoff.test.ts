// Early advance_run_handoff for plain numeric `pipeline <N>` (#1049).
// Injected I/O only: no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ADVANCE_RUN_HANDOFF_KIND,
  PIPELINE_NESTED_ADVANCE_ENV,
  formatAdvanceRunHandoff,
  nestedAdvanceChildEnv,
  shouldEmitAdvanceRunHandoff,
} from "../scripts/advance-handoff.ts";
import {
  runAdvance,
  type AdvanceDeps,
} from "../scripts/pipeline-run.ts";
import { listRunIds, runDirPath, runIdFor } from "../scripts/run-store.ts";
import { makePipelineRunId } from "../scripts/traceability.ts";
import { runLogs } from "../scripts/pipeline.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import {
  FACTORY_CONTROL_DIR_ENV,
  PRODUCTION_PIN_ENV,
} from "../scripts/production-engine-pin.ts";

const ISSUE = 1049;
const STARTED_AT = new Date("2026-08-30T00:17:30.123Z");

function withoutHostPinAuthorityEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const savedPin = process.env[PRODUCTION_PIN_ENV];
  const savedControl = process.env[FACTORY_CONTROL_DIR_ENV];
  delete process.env[PRODUCTION_PIN_ENV];
  delete process.env[FACTORY_CONTROL_DIR_ENV];
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      if (savedPin === undefined) delete process.env[PRODUCTION_PIN_ENV];
      else process.env[PRODUCTION_PIN_ENV] = savedPin;
      if (savedControl === undefined) delete process.env[FACTORY_CONTROL_DIR_ENV];
      else process.env[FACTORY_CONTROL_DIR_ENV] = savedControl;
    });
}

test("formatAdvanceRunHandoff emits kind advance_run_handoff with run-store fields", () => {
  const line = formatAdvanceRunHandoff({
    runId: "1049-2026-08-30T00-17-30-123Z",
    runDir: "/repo/.agent-pipeline/runs/1049-2026-08-30T00-17-30-123Z",
    events: "/repo/.agent-pipeline/runs/1049-2026-08-30T00-17-30-123Z/events.jsonl",
  });
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal(parsed.schema_version, "1");
  assert.equal(parsed.kind, ADVANCE_RUN_HANDOFF_KIND);
  assert.equal(parsed.run_id, "1049-2026-08-30T00-17-30-123Z");
  assert.equal(
    parsed.events,
    "/repo/.agent-pipeline/runs/1049-2026-08-30T00-17-30-123Z/events.jsonl",
  );
  assert.ok(!line.includes("\n"));
});

test("plain numeric runAdvance emits advance_run_handoff before first dispatch and logs resolves it", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-handoff-"));
  const domain = `advance-handoff-${process.pid}-${Date.now()}`;
  const stateDir = `/tmp/pipeline-${domain}`;
  const expectedStoreId = runIdFor(ISSUE, STARTED_AT);
  const trailerId = makePipelineRunId(ISSUE, STARTED_AT);
  const order: string[] = [];
  const lines: string[] = [];
  const cfg = {
    repo: "owner/repo",
    domain,
    repo_dir: repoDir,
    base_branch: "main",
    invocation: "pipeline",
    marker_footer: "*Automated by Claude Code Pipeline Skill*",
    harnesses: {
      implementer: "claude",
      implementerSource: "default",
      reviewer: "codex",
      reviewerSource: "default",
    },
    steps: { standard_review: true, adversarial_review: true },
    auto_loop: { enabled: false, max_rounds: 3, max_wallclock_minutes: 60, stages: [] },
    papercuts: { enabled: false, auto_file: false },
    corrections: { auto_file: false },
  } as unknown as PipelineConfig;
  const detail = {
    number: ISSUE,
    type: "issue" as const,
    title: "T",
    body: "B",
    state: "open",
    url: `https://example.test/${ISSUE}`,
    labels: ["pipeline:ready"],
    comments: [],
  };
  const deps: AdvanceDeps = {
    now: () => STARTED_AT.getTime(),
    resolvePinnedEngineIdentity: () => null,
    probeEngineIdentity: () => null,
    enforceEngineTrack: async () => ({
      ok: true as const,
      track: "candidate" as const,
    }),
    releaseParkedWorktree: async () => ({
      action: "absent",
      reason: "no managed worktree",
      branch: null,
      worktree: null,
    }),
    ensurePipelineLabels: async () => {},
    getIssueDetail: (async () => detail) as AdvanceDeps["getIssueDetail"],
    getGhActor: async () => "pipeline-bot",
    getPrForIssue: async () => null,
    getOnDiskForIssue: async () => null,
    postComment: async () => {},
    postPrComment: async () => {},
    setBlocked: async () => {},
    lastAdvancedCandidateSha: "a".repeat(40),
    trustedSurfaceObjectSource: {
      listChangedPaths: async () => ({ paths: [] }),
      resolveBaseSha: async () => "a".repeat(40),
    },
    gitInWorktree: async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    writeHandoffLine: (line) => {
      lines.push(line.replace(/\n$/, ""));
      order.push("handoff");
    },
    dispatch: async () => {
      order.push("dispatch");
      return {
        advanced: false,
        status: "blocked",
        reason: "stop after first dispatch",
        blockerKind: "needs-human",
      };
    },
    env: {},
  };

  const prevExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await withoutHostPinAuthorityEnv(() => runAdvance(cfg, ISSUE, {}, deps));
    assert.deepEqual(order, ["handoff", "dispatch"]);
    assert.equal(lines.length, 1);
    const handoff = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(handoff.kind, ADVANCE_RUN_HANDOFF_KIND);
    assert.equal(handoff.run_id, expectedStoreId);
    assert.notEqual(handoff.run_id, trailerId);
    assert.equal(typeof handoff.run_id, "string");
    assert.equal(String(handoff.run_id).includes("/"), false);
    assert.equal(handoff.events, path.join(runDirPath(repoDir, expectedStoreId), "events.jsonl"));
    assert.ok(path.isAbsolute(String(handoff.run_dir)));
    assert.ok(path.isAbsolute(String(handoff.events)));
    assert.ok(fs.existsSync(String(handoff.events)));

    const ids = await listRunIds(repoDir);
    assert.ok(ids.includes(expectedStoreId), "run-store listing must include the handoff run_id");
    assert.equal(ids.includes(trailerId), false);

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: typeof process.stdout.write }).write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runLogs(repoDir, String(handoff.run_id), false, true);
    } finally {
      (process.stdout as { write: typeof process.stdout.write }).write = origWrite;
    }
    assert.notEqual(process.exitCode, 1, "pipeline logs must resolve the handoff run_id");
    assert.match(chunks.join(""), /run_start|schema_version/);

    process.exitCode = undefined;
    await runLogs(repoDir, trailerId, false, true);
    assert.equal(process.exitCode, 1, "pipeline logs must refuse the commit-trailer id");
  } finally {
    process.exitCode = prevExit;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function stubHandoffAdvance(
  repoDir: string,
  extra: Partial<AdvanceDeps> = {},
): { deps: AdvanceDeps; lines: string[]; order: string[] } {
  const lines: string[] = [];
  const order: string[] = [];
  const detail = {
    number: ISSUE,
    type: "issue" as const,
    title: "T",
    body: "B",
    state: "open",
    url: `https://example.test/${ISSUE}`,
    labels: ["pipeline:ready"],
    comments: [],
  };
  const deps: AdvanceDeps = {
    now: () => STARTED_AT.getTime(),
    resolvePinnedEngineIdentity: () => null,
    probeEngineIdentity: () => null,
    enforceEngineTrack: async () => ({
      ok: true as const,
      track: "candidate" as const,
    }),
    releaseParkedWorktree: async () => ({
      action: "absent",
      reason: "no managed worktree",
      branch: null,
      worktree: null,
    }),
    ensurePipelineLabels: async () => {},
    getIssueDetail: (async () => detail) as AdvanceDeps["getIssueDetail"],
    getGhActor: async () => "pipeline-bot",
    getPrForIssue: async () => null,
    getOnDiskForIssue: async () => null,
    postComment: async () => {},
    postPrComment: async () => {},
    setBlocked: async () => {},
    lastAdvancedCandidateSha: "a".repeat(40),
    trustedSurfaceObjectSource: {
      listChangedPaths: async () => ({ paths: [] }),
      resolveBaseSha: async () => "a".repeat(40),
    },
    gitInWorktree: async (_cwd, args) => {
      if (args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    writeHandoffLine: (line) => {
      lines.push(line.replace(/\n$/, ""));
      order.push("handoff");
    },
    dispatch: async () => {
      order.push("dispatch");
      return {
        advanced: false,
        status: "blocked",
        reason: "stop after first dispatch",
        blockerKind: "needs-human",
      };
    },
    env: {},
    ...extra,
  };
  return { deps, lines, order };
}

function handoffCfg(repoDir: string, domain: string): PipelineConfig {
  return {
    repo: "owner/repo",
    domain,
    repo_dir: repoDir,
    base_branch: "main",
    invocation: "pipeline",
    marker_footer: "*Automated by Claude Code Pipeline Skill*",
    harnesses: {
      implementer: "claude",
      implementerSource: "default",
      reviewer: "codex",
      reviewerSource: "default",
    },
    steps: { standard_review: true, adversarial_review: true },
    auto_loop: { enabled: false, max_rounds: 3, max_wallclock_minutes: 60, stages: [] },
    papercuts: { enabled: false, auto_file: false },
    corrections: { auto_file: false },
  } as unknown as PipelineConfig;
}

test("shouldEmitAdvanceRunHandoff is false for nested env and explicit suppress", () => {
  assert.equal(shouldEmitAdvanceRunHandoff({ env: {} }), true);
  assert.equal(shouldEmitAdvanceRunHandoff({ emitAdvanceHandoff: false }), false);
  assert.equal(
    shouldEmitAdvanceRunHandoff({ env: nestedAdvanceChildEnv({}) }),
    false,
  );
  assert.equal(
    shouldEmitAdvanceRunHandoff({ env: { [PIPELINE_NESTED_ADVANCE_ENV]: "1" } }),
    false,
  );
});

test("runAdvance does not emit advance_run_handoff when mkdir fails", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-handoff-mkdir-"));
  const domain = `advance-handoff-mkdir-${process.pid}-${Date.now()}`;
  const { deps, lines } = stubHandoffAdvance(repoDir, {
    runStore: {
      mkdir: async () => {
        throw new Error("EACCES: mkdir failed");
      },
    },
  });
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await withoutHostPinAuthorityEnv(() =>
      runAdvance(handoffCfg(repoDir, domain), ISSUE, {}, deps),
    );
    assert.deepEqual(lines, []);
  } finally {
    process.exitCode = prevExit;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(`/tmp/pipeline-${domain}`, { recursive: true, force: true });
  }
});

test("runAdvance does not emit advance_run_handoff when writeFile fails", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-handoff-write-"));
  const domain = `advance-handoff-write-${process.pid}-${Date.now()}`;
  const { deps, lines } = stubHandoffAdvance(repoDir, {
    runStore: {
      writeFile: async () => {
        throw new Error("ENOSPC: write failed");
      },
    },
  });
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await withoutHostPinAuthorityEnv(() =>
      runAdvance(handoffCfg(repoDir, domain), ISSUE, {}, deps),
    );
    assert.deepEqual(lines, []);
  } finally {
    process.exitCode = prevExit;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(`/tmp/pipeline-${domain}`, { recursive: true, force: true });
  }
});

test("runAdvance does not emit advance_run_handoff for an incomplete idempotent store", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-handoff-idemp-"));
  const domain = `advance-handoff-idemp-${process.pid}-${Date.now()}`;
  const expectedStoreId = runIdFor(ISSUE, STARTED_AT);
  const runDir = runDirPath(repoDir, expectedStoreId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify({ run_id: expectedStoreId })}\n`);
  assert.equal(fs.existsSync(path.join(runDir, "events.jsonl")), false);
  const { deps, lines } = stubHandoffAdvance(repoDir);
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await withoutHostPinAuthorityEnv(() =>
      runAdvance(handoffCfg(repoDir, domain), ISSUE, {}, deps),
    );
    assert.deepEqual(lines, []);
  } finally {
    process.exitCode = prevExit;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(`/tmp/pipeline-${domain}`, { recursive: true, force: true });
  }
});

test("runAdvance does not emit advance_run_handoff in exclusive-sink mode", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-handoff-excl-"));
  const domain = `advance-handoff-excl-${process.pid}-${Date.now()}`;
  const expectedStoreId = runIdFor(ISSUE, STARTED_AT);
  const runDir = runDirPath(repoDir, expectedStoreId);
  const { deps, lines } = stubHandoffAdvance(repoDir, {
    runStore: {
      eventSink: async () => {},
      eventSinkMode: "exclusive",
      summaryEvents: [],
    },
  });
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await withoutHostPinAuthorityEnv(() =>
      runAdvance(handoffCfg(repoDir, domain), ISSUE, {}, deps),
    );
    assert.equal(fs.existsSync(path.join(runDir, "events.jsonl")), false);
    assert.deepEqual(lines, []);
  } finally {
    process.exitCode = prevExit;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(`/tmp/pipeline-${domain}`, { recursive: true, force: true });
  }
});

test("nested numeric runAdvance does not emit advance_run_handoff", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-handoff-nested-"));
  const domain = `advance-handoff-nested-${process.pid}-${Date.now()}`;
  const { deps, lines, order } = stubHandoffAdvance(repoDir, {
    env: nestedAdvanceChildEnv({}),
  });
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await withoutHostPinAuthorityEnv(() =>
      runAdvance(handoffCfg(repoDir, domain), ISSUE, {}, deps),
    );
    assert.deepEqual(lines, []);
    assert.deepEqual(order, ["dispatch"]);
  } finally {
    process.exitCode = prevExit;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(`/tmp/pipeline-${domain}`, { recursive: true, force: true });
  }
});

test("in-process nested re-entry suppresses advance_run_handoff via emitAdvanceHandoff", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-handoff-reenter-"));
  const domain = `advance-handoff-reenter-${process.pid}-${Date.now()}`;
  const { deps, lines, order } = stubHandoffAdvance(repoDir);
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await withoutHostPinAuthorityEnv(() =>
      runAdvance(handoffCfg(repoDir, domain), ISSUE, { emitAdvanceHandoff: false }, deps),
    );
    assert.deepEqual(lines, []);
    assert.deepEqual(order, ["dispatch"]);
  } finally {
    process.exitCode = prevExit;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(`/tmp/pipeline-${domain}`, { recursive: true, force: true });
  }
});
