import { observationFiles, observationHome } from "./helpers/isolated-observability.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  beginInvocationObservation, defaultObservabilityDeps, observabilityPaths,
} from "../scripts/observability.ts";
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
  const paths = observabilityPaths(defaultObservabilityDeps);
  assert.equal(defaultObservabilityDeps.home, observationHome);
  assert.ok(paths.inbox.startsWith(`${observationHome}/`));
  assert.ok(paths.context.startsWith(`${observationHome}/`));
  assert.deepEqual(defaultObservabilityDeps.env, { AGENT_OBSERVABILITY_ENABLED: "1" });

  const observation = await beginInvocationObservation({
    runDir, issue: 43, stage: "review-1", harness: "codex", cwd: "/test-repo",
    startedAt: "2026-01-01T00:00:00Z",
  });
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
  });
  assert.equal(localAccounting.length, 1, "local run accounting is still emitted");
  const queued = [...observationFiles].filter(([file]) => file.startsWith(`${paths.inbox}/`));
  assert.equal(queued.length, 1, "the default accounting sink is captured in memory");
  const event = JSON.parse(queued[0][1]);
  assert.equal(event.model, "openai/gpt-5");
  assert.equal(event.cost_usd, 0.01);
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
