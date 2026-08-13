import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  runOutcomesIngest,
  runOutcomesList,
  type OutcomesCliDeps,
} from "../scripts/outcomes/cli.ts";
import type { OutcomeStoreDeps } from "../scripts/outcomes/store.ts";
import type { RawOutcomeSignal } from "../scripts/outcomes/adapters.ts";

const REPO = "/repo";
const SHA = "1".repeat(40);

function memCli(): OutcomesCliDeps & { files: Map<string, string>; logs: string[] } {
  const files = new Map<string, string>();
  const logs: string[] = [];
  const store: OutcomeStoreDeps = {
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p, c) => {
      files.set(p, c);
    },
    readdir: async (p) => {
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      const names = new Set<string>();
      let any = false;
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) {
          any = true;
          names.add(k.slice(prefix.length).split(path.sep)[0]!);
        }
      }
      if (!any) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return [...names].filter(Boolean).map((name) => ({
        name,
        isDirectory: () => !name.includes("."),
      }));
    },
    mkdir: async () => {},
  };
  return {
    files,
    logs,
    store,
    readFile: store.readFile,
    readdir: store.readdir,
    log: (m) => logs.push(m),
    gh: async () => {
      throw new Error("gh must not be called without fixture");
    },
  };
}

const mergeSignal: RawOutcomeSignal = {
  signal_id: "merge:pr:9",
  kind: "merge",
  payload: {
    pr_number: 9,
    merged_at: "2026-08-13T16:00:00Z",
    merge_commit_sha: SHA,
    title: "t",
    body: "Issue: #9\nPipeline-Run: 9/2026-08-13T15:00:00Z\n",
    url: "https://example.test/9",
  },
};

test("ingest summary reports written and skipped counts", async () => {
  const deps = memCli();
  // Put fixture content in files map and point fixturePath at it
  const fixturePath = "/tmp/fixture-signals.json";
  deps.files.set(
    fixturePath,
    JSON.stringify([
      mergeSignal,
      { signal_id: "bad", kind: "other", payload: {} },
      {
        ...mergeSignal,
        signal_id: "merge:pr:10",
        payload: { ...mergeSignal.payload, pr_number: 10, merge_commit_sha: "2".repeat(40) },
      },
    ]),
  );

  const summary = await runOutcomesIngest(
    {
      repoDir: REPO,
      verb: "ingest",
      fixturePath,
      now: new Date("2026-08-13T18:00:00Z"),
    },
    deps,
  );
  assert.equal(summary.written, 2);
  assert.ok(summary.skipped >= 1);
  assert.ok(summary.diagnostics.length >= 1);
  assert.equal(summary.adapter_id, "github");
});

test("empty store list reads cleanly", async () => {
  const deps = memCli();
  const listed = await runOutcomesList({ repoDir: REPO, verb: "list" }, deps);
  assert.equal(listed.count, 0);
  assert.ok(listed.diagnostics.length >= 1);
});

test("ingest path does not call gh when fixture provided", async () => {
  const deps = memCli();
  let ghCalls = 0;
  deps.gh = async () => {
    ghCalls++;
    return "[]";
  };
  const fixturePath = "/tmp/fix.json";
  deps.files.set(fixturePath, JSON.stringify([mergeSignal]));
  await runOutcomesIngest(
    { repoDir: REPO, verb: "ingest", fixturePath, dryRun: true },
    deps,
  );
  assert.equal(ghCalls, 0);
});
