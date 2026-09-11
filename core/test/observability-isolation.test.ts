import { observationFiles, observationHome, observationWarnings } from "./helpers/isolated-observability.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  beginInvocationObservation, enqueueAccountingObservation, observabilityPaths,
  type ObservabilityDeps,
} from "../scripts/observability.ts";
import { DEFAULT_CONFIG } from "../scripts/types.ts";
import { buildStageAccountingRecord } from "../scripts/accounting.ts";
import { defaultRunStoreDeps, emitStageAccounting } from "../scripts/run-store.ts";

test("unit-test defaults keep enabled accounting and invocation markers off the host filesystem", async (t) => {
  observationFiles.clear();
  const ambient = ["readFile", "readdir", "mkdir", "writeFile", "rename", "unlink"].map((name) =>
    t.mock.method(fs, name as "readFile", async () => { throw new Error(`ambient ${name} is forbidden`); }),
  );
  const localAccounting: string[] = [];
  const runDir = "/test-run/43-2026-01-01T00-00-00-000Z";
  observationFiles.set(`${runDir}/run.json`, JSON.stringify({ repo: "acme/widgets" }));
  const enabledConfig = { ...DEFAULT_CONFIG.observability, enabled: true };
  const deps: ObservabilityDeps = {
    home: observationHome,
    read: async (file) => {
      const value = observationFiles.get(file);
      if (value === undefined) throw Object.assign(new Error("missing test file"), { code: "ENOENT" });
      return value;
    },
    list: async (dir) => [...observationFiles.keys()].filter((file) => file.startsWith(`${dir}/`)),
    write: async (file, data) => { observationFiles.set(file, JSON.stringify(data)); },
    remove: async (file) => { observationFiles.delete(file); },
    warn: (message) => { observationWarnings.push(message); },
    uuid: () => "fixture-invocation",
  };
  const paths = observabilityPaths(enabledConfig, deps);
  assert.ok(paths.inbox.startsWith(`${observationHome}/`) || paths.inbox.includes("agent-pipeline/observability"));
  assert.ok(paths.context.startsWith(`${observationHome}/`) || paths.context.includes("agent-pipeline/observability"));

  const observation = await beginInvocationObservation({
    runDir, issue: 43, stage: "review-1", harness: "codex", cwd: "/test-repo",
    startedAt: "2026-01-01T00:00:00Z",
  }, enabledConfig, deps);
  assert.ok(observation, "isolation must exercise enabled observation, not silently disable it");
  observation.feed('{"type":"thread.started","thread_id":"fixture-thread"}\n');
  await observation.finish("", "2026-01-01T00:01:00Z");
  assert.ok(observationFiles.has(`${paths.context}/codex--fixture-thread.json`));

  await emitStageAccounting(runDir, buildStageAccountingRecord({
    runId: "43-2026-01-01T00-00-00-000Z", invocationId: observation.id,
    issue: 43, stage: "review-1", harness: "openrouter-review",
    startedAt: "2026-01-01T00:00:00Z", outcome: "success",
    resolvedModel: "openai/gpt-5", usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 },
  }), {
    ...defaultRunStoreDeps,
    appendFile: async (_file, data) => { localAccounting.push(data); },
    accountingSink: (dir, record, config) => enqueueAccountingObservation(dir, record, config, deps),
  }, enabledConfig);
  assert.equal(localAccounting.length, 1, "local run accounting is still emitted");
  const queued = [...observationFiles].filter(([file]) => file.startsWith(`${paths.inbox}/`));
  assert.equal(queued.length >= 1, true, "the in-memory accounting sink is captured");
  const event = JSON.parse(queued[queued.length - 1][1]);
  assert.equal(event.metadata.repo, "acme/widgets");
  for (const call of ambient) assert.equal(call.mock.callCount(), 0);
});

test("unit-test runner and known default-writer fixtures retain their observability boundary", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.test, /--import \.\/test\/helpers\/isolated-observability\.ts/);
  for (const file of ["executors", "harness", "production-preflight", "testgate"]) {
    const source = readFileSync(new URL(`./${file}.test.ts`, import.meta.url), "utf8");
    assert.match(source, /import "\.\/helpers\/isolated-observability\.ts"/,
      `${file}: direct single-file runs must not inherit ambient telemetry`);
  }
});
