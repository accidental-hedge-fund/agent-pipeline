// Tests for #502 review 1 finding db3559ff ("No engine path ever records a
// product_fault event"): the dispatch-stage crash boundary in pipeline-run.ts
// must classify and emit a `product_fault` event for a genuine engine crash,
// and must NOT do so for a target-repo/gh/harness-shaped failure (a plain
// `Error`) — that distinction is `isEngineOwnedCrash`.
//
// No real filesystem, network, or subprocess calls — RunStoreDeps is faked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isEngineOwnedCrash, classifyAndEmitDispatchCrash } from "../scripts/pipeline-run.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";

interface FakeFs {
  files: Record<string, string>;
}

function makeRunStoreDeps(fs: FakeFs): RunStoreDeps {
  return {
    readFile: async (p) => {
      if (!(p in fs.files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return fs.files[p];
    },
    writeFile: async (p, data) => {
      fs.files[p] = data;
    },
    appendFile: async (p, data) => {
      fs.files[p] = (fs.files[p] ?? "") + data;
    },
    rename: async (from, to) => {
      fs.files[to] = fs.files[from];
      delete fs.files[from];
    },
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date(0) }),
  };
}

test("isEngineOwnedCrash: true for TypeError/RangeError/ReferenceError", () => {
  assert.equal(isEngineOwnedCrash(new TypeError("boom")), true);
  assert.equal(isEngineOwnedCrash(new RangeError("boom")), true);
  assert.equal(isEngineOwnedCrash(new ReferenceError("boom")), true);
});

test("isEngineOwnedCrash: false for a plain Error (gh/git/harness/target-repo failures)", () => {
  assert.equal(isEngineOwnedCrash(new Error("gh: command failed with exit code 1")), false);
  assert.equal(isEngineOwnedCrash("a thrown string"), false);
});

test("classifyAndEmitDispatchCrash: an engine-owned crash (TypeError) records a product_fault event", async () => {
  const fs: FakeFs = { files: {} };
  const deps = makeRunStoreDeps(fs);
  await classifyAndEmitDispatchCrash(new TypeError("Cannot read properties of undefined"), {
    runDir: "/repo/.agent-pipeline/runs/1-x",
    stage: "planning",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    runStoreDeps: deps,
  });
  const lines = (fs.files["/repo/.agent-pipeline/runs/1-x/events.jsonl"] ?? "").trim().split("\n");
  assert.equal(lines.length, 1, "exactly one product_fault event must be recorded");
  const event = JSON.parse(lines[0]);
  assert.equal(event.type, "product_fault");
  assert.equal(event.error_class, "TypeError");
  assert.equal(event.confidence, "high");
});

test("classifyAndEmitDispatchCrash: a target-repo/gh/harness failure (plain Error) records nothing", async () => {
  const fs: FakeFs = { files: {} };
  const deps = makeRunStoreDeps(fs);
  await classifyAndEmitDispatchCrash(new Error("gh api call failed: 401 Unauthorized"), {
    runDir: "/repo/.agent-pipeline/runs/1-x",
    stage: "test_gate",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    runStoreDeps: deps,
  });
  assert.equal(fs.files["/repo/.agent-pipeline/runs/1-x/events.jsonl"], undefined);
});
