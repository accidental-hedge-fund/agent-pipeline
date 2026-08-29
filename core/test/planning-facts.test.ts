// Planning-facts observation, claims, prompts, and runner seams (#1300).
// Injected I/O only — no real network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type Outcome, type PipelineConfig } from "../scripts/types.ts";
import type { HarnessResult } from "../scripts/harness.ts";
import {
  constructProviderEnv,
  createCgroupContainment,
  defaultSpawnProvider,
  NOOP_PROVIDER_CONTAINMENT,
  digestValue,
  emptyPlanningFactBundle,
  extractPlanningFactClaims,
  canonicalizeIgnoredListing,
  defaultMaterializeTrustedProviderBundle,
  defaultOverlayTrustedProviderFiles,
  observePlanningFacts,
  planningFactsContainmentArgv,
  planningFactsSubreaperArgv,
  planningFactsReasonPrefix,
  planningFactsSection,
  requiredFactIdentities,
  requiredFactsChanged,
  worktreeSnapshotsDiffer,
  PLANNING_FACT_CLAIMS_SCHEMA_BLOCK,
  PLANNING_FACT_CLAIMS_SCHEMA_FIELDS,
  PLANNING_FACTS_CONTRACT_TAG,
  type PlanningFactBundle,
  type PlanningFactsDeps,
  type ProviderContainment,
  type SpawnProviderRequest,
  type SpawnProviderResult,
  type TrustedProviderFile,
  type WorktreeSnapshot,
} from "../scripts/planning-facts.ts";
import {
  buildImplementingPrompt,
  buildPlanningPrompt,
  buildPlanReviewPrompt,
  buildPlanRevisionPrompt,
} from "../scripts/prompts/index.ts";
import { runPlanningPhases, type PlanningPhaseHooks } from "../scripts/stages/planning.ts";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/planning-facts-alembic", import.meta.url));
const PRODUCTION_PLANNING_FACTS = fileURLToPath(new URL("../scripts/planning-facts.ts", import.meta.url));
const PRODUCTION_CONFIG = fileURLToPath(new URL("../scripts/config.ts", import.meta.url));

const TRUSTED_YAML = `planning_facts:
  providers:
    - id: alembic-head
      executable: scripts/pipeline/planning-facts/alembic-head
      required: true
      facts:
        alembic_head: string
`;

const TRUSTED_SCRIPT = Buffer.from("#!/bin/sh\necho trusted\n");
const WORKTREE_SCRIPT = Buffer.from("#!/bin/sh\necho worktree-rewrite\n");

function cfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/repo",
    harnesses: {
      implementer: "claude",
      reviewer: "codex",
      implementerSource: "repo-config",
      reviewerSource: "repo-config",
    },
    planning_facts: {
      ...DEFAULT_CONFIG.planning_facts,
      providers: [
        {
          id: "alembic-head",
          executable: "scripts/pipeline/planning-facts/alembic-head",
          args: [],
          required: true,
          facts: { alembic_head: "string" },
        },
      ],
    },
    ...overrides,
  } as PipelineConfig;
}

function alembicHeadFromDir(cwd: string): string {
  const dir = path.join(cwd, "alembic", "versions");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".py")).sort();
  let head = "";
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const m = text.match(/^revision\s*=\s*"([^"]+)"/m);
    if (m) head = m[1];
  }
  return head;
}

function fixtureWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-wt-"));
  fs.cpSync(path.join(FIXTURE_DIR, "alembic"), path.join(dir, "alembic"), { recursive: true });
  return dir;
}

function successSpawn(facts: Record<string, unknown>): SpawnProviderResult {
  return {
    exit_code: 0,
    stdout: Buffer.from(JSON.stringify({ schema_version: 1, facts })),
    stderr: Buffer.alloc(0),
    timed_out: false,
    duration_ms: 5,
  };
}

function snapshot(over: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return { head: "aaa", tree: "bbb", porcelain: "", ignored: "", ...over };
}

function baseDeps(over: Partial<PlanningFactsDeps> & {
  blobs?: Record<string, Buffer | null>;
  spawnImpl?: (req: SpawnProviderRequest) => Promise<SpawnProviderResult> | SpawnProviderResult;
  snapshots?: WorktreeSnapshot[];
} = {}): PlanningFactsDeps {
  const blobs = over.blobs ?? {
    ".github/pipeline.yml": Buffer.from(TRUSTED_YAML),
    "scripts/pipeline/planning-facts/alembic-head": TRUSTED_SCRIPT,
  };
  let snapIdx = 0;
  const snaps = over.snapshots ?? [snapshot(), snapshot(), snapshot(), snapshot(), snapshot()];
  const recorded: SpawnProviderRequest[] = [];
  const deps: PlanningFactsDeps = {
    readTrustedBlob: async (_sha, p) => (p in blobs ? blobs[p] : null),
    resolveIntegrationBaseSha: async () => "base-sha-1",
    worktreeSnapshot: async () => snaps[Math.min(snapIdx++, snaps.length - 1)],
    spawnProvider: async (req) => {
      recorded.push(req);
      const impl = over.spawnImpl;
      if (!impl) return successSpawn({ alembic_head: "0074" });
      return await impl(req);
    },
    now: () => new Date("2026-08-29T15:46:05Z"),
    updateWorktreeOntoBase: async () => ({ ok: true }),
    listTrustedPrefix: async (_sha, prefix) =>
      Object.keys(blobs).filter((p) => p === prefix || p.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)),
    materializeTrustedProviderBundle: (files, entry) => {
      const dest = path.join(
        os.tmpdir(),
        `pf-exec-${digestValue(files.find((f) => f.repoRelPath === entry)?.bytes.toString("utf8") ?? "x").slice(0, 12)}`,
      );
      fs.writeFileSync(dest, files.find((f) => f.repoRelPath === entry)?.bytes ?? Buffer.alloc(0));
      return dest;
    },
    overlayTrustedProviderFiles: () => ({ restore() {} }),
    ...over,
  };
  (deps as PlanningFactsDeps & { recorded: SpawnProviderRequest[] }).recorded = recorded;
  return deps;
}

test("production observation module does not hard-code Alembic", () => {
  const src = fs.readFileSync(PRODUCTION_PLANNING_FACTS, "utf8");
  assert.doesNotMatch(src, /alembic/i);
  const cfgSrc = fs.readFileSync(PRODUCTION_CONFIG, "utf8");
  // config may document an example provider id; it must not parse versions/
  assert.doesNotMatch(cfgSrc, /alembic\/versions/);
});

test("omitted providers: observe spawns nothing and returns empty facts", async () => {
  let spawned = 0;
  const observation = await observePlanningFacts({
    cfg: cfg({ planning_facts: DEFAULT_CONFIG.planning_facts }),
    worktreeDir: "/wt",
    deps: baseDeps({
      blobs: { ".github/pipeline.yml": Buffer.from("harnesses: {}\n") },
      spawnImpl: () => {
        spawned += 1;
        return successSpawn({ alembic_head: "0074" });
      },
    }),
  });
  assert.equal(observation.ok, true);
  if (observation.ok) {
    assert.deepEqual(observation.bundle.facts, []);
  }
  assert.equal(spawned, 0);
});

test("trusted-base YAML rewrite in the worktree is ignored", async () => {
  const worktreeYaml = Buffer.from(`planning_facts:
  providers:
    - id: evil
      executable: scripts/evil
      required: true
      facts:
        pwned: string
`);
  const spawnedIds: string[] = [];
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      spawnImpl: (req) => {
        spawnedIds.push(req.command);
        return successSpawn({ alembic_head: "0074" });
      },
    }),
  });
  assert.equal(observation.ok, true);
  if (observation.ok) {
    assert.equal(observation.bundle.facts[0]?.id, "alembic_head");
    assert.doesNotMatch(observation.bundle.facts.map((f) => f.id).join(), /pwned/);
  }
  assert.equal(worktreeYaml.includes("evil"), true);
});

test("trusted executable bytes are spawned, not worktree rewrite bytes", async () => {
  let spawnedBytes = "";
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      materializeTrustedProviderBundle: (files, entry) => {
        spawnedBytes = (files.find((f) => f.repoRelPath === entry)?.bytes ?? Buffer.alloc(0)).toString("utf8");
        return "/tmp/trusted-exec";
      },
      spawnImpl: (req) => {
        assert.equal(req.command, "/tmp/trusted-exec");
        assert.equal(req.shell, false);
        return successSpawn({ alembic_head: "0074" });
      },
    }),
  });
  assert.equal(observation.ok, true);
  assert.equal(spawnedBytes, TRUSTED_SCRIPT.toString("utf8"));
  assert.notEqual(spawnedBytes, WORKTREE_SCRIPT.toString("utf8"));
});

test("spawn is argv-only with constructed env and worktree cwd", async () => {
  const planted = {
    GH_TOKEN: "secret-gh",
    GITHUB_TOKEN: "secret-github",
    GH_ENTERPRISE_TOKEN: "secret-ent",
    SSH_AUTH_SOCK: "/tmp/ssh.sock",
    PIPELINE_SECRET: "pipeline",
    ANTHROPIC_API_KEY: "claude-key",
    OPENAI_API_KEY: "openai-key",
  };
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(planted)) {
    old[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    let req: SpawnProviderRequest | undefined;
    const observation = await observePlanningFacts({
      cfg: cfg({
        planning_facts: {
          ...DEFAULT_CONFIG.planning_facts,
          providers: [
            {
              id: "alembic-head",
              executable: "scripts/pipeline/planning-facts/alembic-head",
              args: [";", "$HOME"],
              required: true,
              facts: { alembic_head: "string" },
            },
          ],
        },
      }),
      worktreeDir: "/managed/planning-wt",
      deps: baseDeps({
        blobs: {
          ".github/pipeline.yml": Buffer.from(`planning_facts:
  providers:
    - id: alembic-head
      executable: scripts/pipeline/planning-facts/alembic-head
      args: [";", "$HOME"]
      required: true
      facts:
        alembic_head: string
`),
          "scripts/pipeline/planning-facts/alembic-head": TRUSTED_SCRIPT,
        },
        spawnImpl: (r) => {
          req = r;
          return successSpawn({ alembic_head: "0074" });
        },
      }),
    });
    assert.equal(observation.ok, true);
    assert.ok(req);
    assert.equal(req!.shell, false);
    assert.equal(req!.cwd, "/managed/planning-wt");
    assert.deepEqual(req!.args, [";", "$HOME"]);
    assert.equal(req!.env.PATH, "/usr/bin:/bin");
    assert.equal(req!.env.LANG, "C.UTF-8");
    assert.equal(req!.env.TZ, "UTC");
    for (const key of Object.keys(planted)) {
      assert.equal(req!.env[key], undefined, `${key} must be absent from child env`);
    }
    assert.equal(req!.env.PIPELINE_SECRET, undefined);
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("constructProviderEnv never copies parent credential keys", () => {
  const env = constructProviderEnv("/home/pf", "/tmp/pf");
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.HOME, "/home/pf");
  assert.equal(env.TMPDIR, "/tmp/pf");
});

test("dirty worktree does not spawn", async () => {
  let spawned = 0;
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      snapshots: [snapshot({ porcelain: "?? dirt.txt\n" })],
      spawnImpl: () => {
        spawned += 1;
        return successSpawn({ alembic_head: "0074" });
      },
    }),
  });
  assert.equal(observation.ok, false);
  if (!observation.ok) {
    assert.equal(observation.tag, PLANNING_FACTS_CONTRACT_TAG);
    assert.match(observation.reason, /dirty-worktree/);
    assert.equal(observation.evidence?.porcelain, "?? dirt.txt\n");
  }
  assert.equal(spawned, 0);
});

test("mutating provider fails and dirt is preserved (no reset/clean)", async () => {
  const gitOps: string[] = [];
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      snapshots: [
        snapshot(),
        snapshot(),
        snapshot({ porcelain: "?? mutated.txt\n" }),
      ],
      spawnImpl: () => successSpawn({ alembic_head: "0074" }),
      updateWorktreeOntoBase: async () => {
        gitOps.push("merge");
        return { ok: true };
      },
    }),
  });
  assert.equal(observation.ok, false);
  if (!observation.ok) {
    assert.match(observation.reason, /mutation/);
    assert.equal(observation.evidence?.porcelain, "?? mutated.txt\n");
  }
  assert.deepEqual(gitOps, []);
});

test("pre-existing ignored files do not count as a dirty worktree", async () => {
  let spawned = 0;
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      snapshots: [
        snapshot({ ignored: ".env\nabc" }),
        snapshot({ ignored: ".env\nabc" }),
        snapshot({ ignored: ".env\nabc" }),
        snapshot({ ignored: ".env\nabc" }),
      ],
      spawnImpl: () => {
        spawned += 1;
        return successSpawn({ alembic_head: "0074" });
      },
    }),
  });
  assert.equal(observation.ok, true);
  assert.equal(spawned, 1);
});

test("ignored-file write is mutation even when porcelain stays empty", async () => {
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      snapshots: [
        snapshot({ ignored: ".env\nabc" }),
        snapshot({ ignored: ".env\nabc" }),
        snapshot({ ignored: ".env\ndef" }),
      ],
      spawnImpl: () => successSpawn({ alembic_head: "0074" }),
    }),
  });
  assert.equal(observation.ok, false);
  if (!observation.ok) {
    assert.equal(observation.failureClass, "mutation");
    assert.equal(observation.evidence?.ignored, ".env\ndef");
    assert.equal(observation.evidence?.porcelain, "");
  }
});

test("ignored-file delete is mutation even when porcelain stays empty", async () => {
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      snapshots: [
        snapshot({ ignored: ".env\nsecret/a.txt\nabc" }),
        snapshot({ ignored: ".env\nsecret/a.txt\nabc" }),
        snapshot({ ignored: ".env\nabc" }),
      ],
      spawnImpl: () => successSpawn({ alembic_head: "0074" }),
    }),
  });
  assert.equal(observation.ok, false);
  if (!observation.ok) {
    assert.equal(observation.failureClass, "mutation");
    assert.equal(observation.evidence?.ignored, ".env\nabc");
  }
});

test("canonicalizeIgnoredListing enumerates files and content, not collapsed directories", () => {
  const files: Record<string, Buffer> = {
    ".env": Buffer.from("secret"),
    "secret/a.txt": Buffer.from("a"),
    "secret/nested/b.txt": Buffer.from("b"),
  };
  const listing = [".env", "secret/a.txt", "secret/nested/b.txt"].join("\0") + "\0";
  const snap = canonicalizeIgnoredListing(listing, (p) => files[p] ?? null);
  assert.match(snap, /\.env/);
  assert.match(snap, /secret\/a\.txt/);
  assert.match(snap, /secret\/nested\/b\.txt/);
  const afterWrite = canonicalizeIgnoredListing(listing, (p) =>
    p === ".env" ? Buffer.from("changed") : files[p] ?? null,
  );
  assert.notEqual(snap, afterWrite);
  const afterDelete = canonicalizeIgnoredListing([".env", "secret/a.txt"].join("\0") + "\0", (p) => files[p] ?? null);
  assert.notEqual(snap, afterDelete);
  assert.equal(worktreeSnapshotsDiffer(snapshot({ ignored: snap }), snapshot({ ignored: afterWrite })), true);
});

test("trusted bundle helpers overlay worktree-rewritten helpers before spawn", async () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "pf-helper-wt-"));
  const helperDir = path.join(wt, "scripts", "pipeline", "planning-facts");
  fs.mkdirSync(helperDir, { recursive: true });
  fs.writeFileSync(path.join(helperDir, "helper.mjs"), "worktree-rewrite\n");
  const trustedHelper = Buffer.from("trusted-helper\n");
  const trustedEntry = Buffer.from("#!/bin/sh\nexec node scripts/pipeline/planning-facts/helper.mjs\n");
  const overlaid: TrustedProviderFile[] = [];
  const materialized: TrustedProviderFile[] = [];
  let helperAtSpawn = "";
  const yaml = `planning_facts:
  providers:
    - id: alembic-head
      executable: scripts/pipeline/planning-facts/alembic-head
      required: true
      facts:
        alembic_head: string
`;
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: wt,
    deps: baseDeps({
      blobs: {
        ".github/pipeline.yml": Buffer.from(yaml),
        "scripts/pipeline/planning-facts/alembic-head": trustedEntry,
        "scripts/pipeline/planning-facts/helper.mjs": trustedHelper,
      },
      materializeTrustedProviderBundle: (files, entry) => {
        materialized.push(...files);
        const dest = path.join(os.tmpdir(), "pf-bundle-entry");
        fs.writeFileSync(dest, files.find((f) => f.repoRelPath === entry)?.bytes ?? Buffer.alloc(0));
        return dest;
      },
      overlayTrustedProviderFiles: (worktreeDir, files) => {
        overlaid.push(...files);
        return defaultOverlayTrustedProviderFiles(worktreeDir, files);
      },
      spawnImpl: (req) => {
        helperAtSpawn = fs.readFileSync(path.join(req.cwd, "scripts/pipeline/planning-facts/helper.mjs"), "utf8");
        return successSpawn({ alembic_head: "0074" });
      },
    }),
  });
  assert.equal(observation.ok, true);
  assert.ok(materialized.some((f) => f.repoRelPath.endsWith("helper.mjs") && f.bytes.equals(trustedHelper)));
  assert.ok(overlaid.some((f) => f.repoRelPath.endsWith("helper.mjs") && f.bytes.equals(trustedHelper)));
  assert.equal(helperAtSpawn, "trusted-helper\n");
  assert.equal(fs.readFileSync(path.join(helperDir, "helper.mjs"), "utf8"), "worktree-rewrite\n");
});

test("defaultMaterializeTrustedProviderBundle writes helpers next to the entry", () => {
  const entry = defaultMaterializeTrustedProviderBundle(
    [
      { repoRelPath: "scripts/pipeline/planning-facts/wrap", bytes: Buffer.from("entry") },
      { repoRelPath: "scripts/pipeline/planning-facts/helper.mjs", bytes: Buffer.from("help") },
    ],
    "scripts/pipeline/planning-facts/wrap",
  );
  assert.equal(fs.readFileSync(entry, "utf8"), "entry");
  assert.equal(fs.readFileSync(path.join(path.dirname(entry), "helper.mjs"), "utf8"), "help");
});

test("undeclared key, nested object, extra top-level, timeout, exit, missing executable, ceiling", async () => {
  const cases: Array<{
    name: string;
    spawn?: SpawnProviderResult;
    blobs?: Record<string, Buffer | null>;
    class: string;
  }> = [
    {
      name: "undeclared",
      spawn: {
        exit_code: 0,
        stdout: Buffer.from(JSON.stringify({ schema_version: 1, facts: { alembic_head: "0074", extra: "x" } })),
        stderr: Buffer.alloc(0),
        timed_out: false,
        duration_ms: 1,
      },
      class: "undeclared-key",
    },
    {
      name: "nested",
      spawn: {
        exit_code: 0,
        stdout: Buffer.from(JSON.stringify({ schema_version: 1, facts: { alembic_head: { n: 1 } } })),
        stderr: Buffer.alloc(0),
        timed_out: false,
        duration_ms: 1,
      },
      class: "type",
    },
    {
      name: "extra-top",
      spawn: {
        exit_code: 0,
        stdout: Buffer.from(JSON.stringify({ schema_version: 1, facts: { alembic_head: "0074" }, hint: true })),
        stderr: Buffer.alloc(0),
        timed_out: false,
        duration_ms: 1,
      },
      class: "malformed-json",
    },
    {
      name: "timeout",
      spawn: { exit_code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timed_out: true, duration_ms: 10000 },
      class: "timeout",
    },
    {
      name: "exit",
      spawn: { exit_code: 2, stdout: Buffer.alloc(0), stderr: Buffer.from("boom"), timed_out: false, duration_ms: 1 },
      class: "exit",
    },
    {
      name: "missing",
      blobs: { ".github/pipeline.yml": Buffer.from(TRUSTED_YAML), "scripts/pipeline/planning-facts/alembic-head": null },
      class: "missing-executable",
    },
    {
      name: "stdout-ceiling",
      spawn: {
        exit_code: 0,
        stdout: Buffer.alloc(40_000, 0x61),
        stderr: Buffer.alloc(0),
        timed_out: false,
        duration_ms: 1,
      },
      class: "ceiling",
    },
  ];
  for (const c of cases) {
    const observation = await observePlanningFacts({
      cfg: cfg(),
      worktreeDir: "/wt",
      deps: baseDeps({
        blobs: c.blobs,
        spawnImpl: () => c.spawn ?? successSpawn({ alembic_head: "0074" }),
      }),
    });
    assert.equal(observation.ok, false, c.name);
    if (!observation.ok) {
      assert.equal(observation.tag, PLANNING_FACTS_CONTRACT_TAG, c.name);
      assert.match(observation.reason, new RegExp(c.class), c.name);
      assert.match(observation.reason, /^planning-facts-provider-contract:/, c.name);
    }
  }
});

function fakeProviderChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  exitCode: number | null;
  signals: string[];
  kill: (signal?: NodeJS.Signals) => boolean;
} {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 999999,
    exitCode: null as number | null,
    signals: [] as string[],
    kill(signal?: NodeJS.Signals) {
      this.signals.push(signal ?? "SIGTERM");
      return true;
    },
  });
  return child;
}

const boundedSpawnReq: SpawnProviderRequest = {
  command: "/tmp/provider",
  args: [],
  cwd: "/wt",
  env: {},
  shell: false,
  timeoutMs: 5_000,
  maxStdoutBytes: 16,
  maxStderrBytes: 8,
};

test("defaultSpawnProvider bounds stdout in the data handler, kills, and waits for close", async () => {
  const child = fakeProviderChild();
  let spawnOpts: { detached?: boolean; shell?: boolean } | undefined;
  const spawnImpl = ((...args: unknown[]) => {
    spawnOpts = args[2] as { detached?: boolean; shell?: boolean };
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const pending = defaultSpawnProvider(boundedSpawnReq, spawnImpl);
  let resolved: SpawnProviderResult | undefined;
  void pending.then((r) => {
    resolved = r;
  });
  child.stdout.emit("data", Buffer.alloc(1_000, 0x61));
  child.stdout.emit("data", Buffer.alloc(1_000, 0x62));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, undefined, "must not resolve before the provider process closes");
  assert.equal(spawnOpts?.shell, false);
  assert.equal(spawnOpts?.detached, true);
  assert.ok(child.signals.includes("SIGTERM"), `expected SIGTERM, got ${JSON.stringify(child.signals)}`);
  child.emit("close", 1);
  const result = await pending;
  assert.equal(result.stdout.length, 16);
  assert.equal(result.stdout.equals(Buffer.alloc(16, 0x61)), true);
  assert.equal(result.stdout_exceeded, true);
  assert.equal(result.timed_out, false);
  assert.equal(result.exit_code, 1);
});

test("defaultSpawnProvider bounds stderr in the data handler", async () => {
  const child = fakeProviderChild();
  const spawnImpl = ((..._args: unknown[]) => child) as unknown as typeof import("node:child_process").spawn;
  const pending = defaultSpawnProvider(boundedSpawnReq, spawnImpl);
  child.stderr.emit("data", Buffer.alloc(500, 0x62));
  await new Promise((r) => setImmediate(r));
  child.emit("close", 1);
  const result = await pending;
  assert.equal(result.stderr.length, 8);
  assert.equal(result.stderr_exceeded, true);
});

test("defaultSpawnProvider timeout waits for close and does not treat later exit 0 as success", async () => {
  const child = fakeProviderChild();
  const spawnImpl = ((..._args: unknown[]) => child) as unknown as typeof import("node:child_process").spawn;
  const pending = defaultSpawnProvider({ ...boundedSpawnReq, timeoutMs: 20 }, spawnImpl);
  let resolved: SpawnProviderResult | undefined;
  void pending.then((r) => {
    resolved = r;
  });
  const waitStart = Date.now();
  while (!child.signals.includes("SIGTERM") && Date.now() - waitStart < 500) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(resolved, undefined, "timeout must not resolve before process close");
  assert.ok(child.signals.includes("SIGTERM"), `expected SIGTERM on timeout, got ${JSON.stringify(child.signals)}`);
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.timed_out, true);
  assert.equal(result.exit_code, 0);
});

test("defaultSpawnProvider does not succeed while containment still has descendants", async () => {
  const child = fakeProviderChild();
  let remaining = [4242];
  let killed = false;
  const containment: ProviderContainment = {
    dir: "/sys/fs/cgroup/fake",
    addPid() {},
    remainingPids: () => remaining,
    killRemaining() {
      killed = true;
      remaining = [];
    },
    close() {},
  };
  const spawnImpl = ((..._args: unknown[]) => child) as unknown as typeof import("node:child_process").spawn;
  const pending = defaultSpawnProvider(boundedSpawnReq, spawnImpl, containment);
  child.emit("close", 0);
  const result = await pending;
  assert.equal(killed, true);
  assert.equal(result.descendants_remaining, true);
  assert.equal(result.exit_code, 0);
});

test("defaultSpawnProvider still kills containment when cgroup.procs looks empty", async () => {
  const child = fakeProviderChild();
  let killed = 0;
  const containment: ProviderContainment = {
    dir: "/sys/fs/cgroup/fake",
    addPid() {},
    remainingPids: () => [],
    killRemaining() {
      killed += 1;
    },
    close() {},
  };
  const spawnImpl = ((..._args: unknown[]) => child) as unknown as typeof import("node:child_process").spawn;
  const pending = defaultSpawnProvider(boundedSpawnReq, spawnImpl, containment);
  child.emit("close", 0);
  const result = await pending;
  assert.ok(killed >= 1, "empty cgroup.procs must not skip cgroup.kill");
  assert.equal(result.descendants_remaining, false);
});

test("escaped descendants after a successful-looking spawn fail containment", async () => {
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      spawnImpl: () => ({
        exit_code: 0,
        stdout: Buffer.from(JSON.stringify({ schema_version: 1, facts: { alembic_head: "0074" } })),
        stderr: Buffer.alloc(0),
        timed_out: false,
        duration_ms: 1,
        descendants_remaining: true,
      }),
    }),
  });
  assert.equal(observation.ok, false);
  if (!observation.ok) {
    assert.equal(observation.failureClass, "containment");
    assert.match(observation.reason, /escaped descendants/);
  }
});

test("planningFactsContainmentArgv execs the trusted command without a shell", () => {
  const wrapped = planningFactsContainmentArgv(
    {
      command: "/tmp/trusted-exec",
      args: [";", "$HOME"],
      cwd: "/wt",
      env: {},
      shell: false,
      timeoutMs: 1,
      maxStdoutBytes: 1,
      maxStderrBytes: 1,
    },
    "/sys/fs/cgroup/fake",
  );
  assert.equal(wrapped.command, process.execPath);
  assert.equal(wrapped.args.includes("/bin/sh"), false);
  const dash = wrapped.args.indexOf("--");
  assert.ok(dash > 0);
  assert.equal(wrapped.args[dash + 1], "/tmp/trusted-exec");
  assert.deepEqual(wrapped.args.slice(dash + 2), [";", "$HOME"]);
  assert.ok(wrapped.args.includes("--containment-child"));
});

test("planningFactsSubreaperArgv is argv-only and fail-closed when the interpreter is missing", () => {
  const inner = planningFactsContainmentArgv(
    {
      command: "/tmp/trusted-exec",
      args: [";", "$HOME"],
      cwd: "/wt",
      env: {},
      shell: false,
      timeoutMs: 1,
      maxStdoutBytes: 1,
      maxStderrBytes: 1,
    },
    "/sys/fs/cgroup/fake",
  );
  const wrapped = planningFactsSubreaperArgv(inner.command, inner.args);
  assert.equal("unavailable" in wrapped, false);
  if ("unavailable" in wrapped) return;
  assert.equal(wrapped.command, "/usr/bin/python3");
  assert.equal(wrapped.args[0], "-I");
  assert.equal(wrapped.args.includes("/bin/sh"), false);
  const dash = wrapped.args.lastIndexOf("--");
  assert.ok(dash > 0);
  assert.equal(wrapped.args[dash + 1], "/tmp/trusted-exec");
  assert.deepEqual(wrapped.args.slice(dash + 2), [";", "$HOME"]);
  const missing = planningFactsSubreaperArgv(inner.command, inner.args, "/no/such/python3");
  assert.equal("unavailable" in missing, true);
  if ("unavailable" in missing) {
    assert.match(missing.unavailable, /subreaper interpreter missing/);
  }
});

test("defaultSpawnProvider fails closed without running the provider when the subreaper is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-nosubreaper-"));
  const script = path.join(dir, "provider.sh");
  fs.writeFileSync(
    script,
    `#!/bin/sh
echo ran > ran.txt
printf '%s\\n' '{"schema_version":1,"facts":{"alembic_head":"0074"}}'
`,
    { mode: 0o755 },
  );
  const result = await defaultSpawnProvider(
    {
      command: script,
      args: [],
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: dir, TMPDIR: dir },
      shell: false,
      timeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    },
    spawn,
    undefined,
    { pythonPath: "/no/such/python3" },
  );
  assert.equal(result.spawn_error, true);
  assert.match(result.stderr.toString("utf8"), /subreaper interpreter missing/);
  assert.equal(fs.existsSync(path.join(dir, "ran.txt")), false, "provider must not run without a subreaper");
});

function spawnSetsIdDaemon(dir: string, containment?: ProviderContainment) {
  const script = path.join(dir, "provider.sh");
  fs.writeFileSync(
    script,
    `#!/bin/sh
( setsid sh -c 'sleep 0.4; echo pwned > pwned.txt' < /dev/null > /dev/null 2>&1 & )
printf '%s\\n' '{"schema_version":1,"facts":{"alembic_head":"0074"}}'
`,
    { mode: 0o755 },
  );
  return defaultSpawnProvider(
    {
      command: script,
      args: [],
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: dir, TMPDIR: dir },
      shell: false,
      timeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    },
    spawn,
    containment,
  );
}

test("defaultSpawnProvider cgroup containment kills a setsid daemon before a delayed write lands", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-daemon-"));
  // GitHub Actions does not delegate nested cgroup.kill. Nested cgroup mkdir
  // may also return EACCES. The subreaper must still terminate the setsid
  // descendant; do not skip this assertion there.
  let containment: ProviderContainment = {
    addPid() {},
    remainingPids: () => [],
    killRemaining() {},
    close() {},
  };
  try {
    const inner = createCgroupContainment();
    containment = {
      dir: inner.dir,
      addPid: (pid) => inner.addPid(pid),
      remainingPids: () => inner.remainingPids(),
      killRemaining() {},
      close: () => inner.close(),
    };
  } catch {
    /* nested cgroup is optional; subreaper must contain without it */
  }
  const result = await spawnSetsIdDaemon(dir, containment);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fs.existsSync(path.join(dir, "pwned.txt")), false, "daemonized descendant must not write after observation");
  assert.equal(result.timed_out, false);
  assert.equal(result.spawn_error ?? false, false);
  assert.match(result.stdout.toString("utf8"), /alembic_head/);
});

test("defaultSpawnProvider kills a setsid daemon without a nested cgroup dir", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-daemon-nocgroup-"));
  const result = await spawnSetsIdDaemon(dir, NOOP_PROVIDER_CONTAINMENT);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fs.existsSync(path.join(dir, "pwned.txt")), false, "subreaper must contain setsid descendants without cgroup.kill");
  assert.equal(result.timed_out, false);
  assert.equal(result.spawn_error ?? false, false);
  assert.match(result.stdout.toString("utf8"), /alembic_head/);
});

test("spawn request carries effective stdout/stderr byte caps", async () => {
  let req: SpawnProviderRequest | undefined;
  await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      spawnImpl: (r) => {
        req = r;
        return successSpawn({ alembic_head: "0074" });
      },
    }),
  });
  assert.ok(req);
  assert.equal(req!.maxStdoutBytes, DEFAULT_CONFIG.planning_facts.max_stdout_bytes);
  assert.equal(req!.maxStderrBytes, DEFAULT_CONFIG.planning_facts.max_stderr_bytes);
});

test("stdout_exceeded with non-zero exit is ceiling, not exit", async () => {
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      spawnImpl: () => ({
        exit_code: 143,
        stdout: Buffer.alloc(16, 0x61),
        stderr: Buffer.alloc(0),
        timed_out: false,
        duration_ms: 1,
        stdout_exceeded: true,
      }),
    }),
  });
  assert.equal(observation.ok, false);
  if (!observation.ok) {
    assert.equal(observation.failureClass, "ceiling");
    assert.match(observation.reason, /stdout exceeded/);
    assert.equal(observation.evidence?.stdout?.length, 16);
  }
});

test("repo-lowered timeout fails between repo value and pipeline max", async () => {
  const yaml = `planning_facts:
  timeout_ms: 50
  providers:
    - id: alembic-head
      executable: scripts/pipeline/planning-facts/alembic-head
      required: true
      facts:
        alembic_head: string
`;
  let timeoutMs = 0;
  await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      blobs: {
        ".github/pipeline.yml": Buffer.from(yaml),
        "scripts/pipeline/planning-facts/alembic-head": TRUSTED_SCRIPT,
      },
      spawnImpl: (req) => {
        timeoutMs = req.timeoutMs;
        return { exit_code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timed_out: true, duration_ms: 80 };
      },
    }),
  }).then((observation) => {
    assert.equal(timeoutMs, 50);
    assert.equal(observation.ok, false);
    if (!observation.ok) assert.match(observation.reason, /timeout/);
  });
});

test("bundle provenance binds repo, base, worktree, providers digest, observed_at", async () => {
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps(),
  });
  assert.equal(observation.ok, true);
  if (!observation.ok) return;
  assert.equal(observation.bundle.repo_id, "acme/widget");
  assert.equal(observation.bundle.integration_base_sha, "base-sha-1");
  assert.equal(observation.bundle.worktree_head_sha, "aaa");
  assert.equal(observation.bundle.worktree_tree_sha, "bbb");
  assert.ok(observation.bundle.providers_digest.length === 64);
  assert.equal(observation.bundle.observed_at, "2026-08-29T15:46:05.000Z");
});

test("two bundles that differ only in observed_at do not count as a required-fact change", () => {
  const a: PlanningFactBundle = {
    repo_id: "acme/widget",
    integration_base_sha: "s",
    worktree_head_sha: "h",
    worktree_tree_sha: "t",
    providers_digest: "p",
    observed_at: "2026-08-29T00:00:00Z",
    facts: [{ id: "alembic_head", provider_id: "alembic-head", required: true, value: "0074", digest: digestValue("0074") }],
  };
  const b = { ...a, observed_at: "2026-08-29T01:00:00Z" };
  assert.equal(requiredFactsChanged(a, b), false);
});

test("optional provider failure records unavailable and does not reuse a prior value", async () => {
  const yaml = `planning_facts:
  providers:
    - id: optional-head
      executable: scripts/opt
      required: false
      facts:
        maybe: string
`;
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      blobs: {
        ".github/pipeline.yml": Buffer.from(yaml),
        "scripts/opt": TRUSTED_SCRIPT,
      },
      spawnImpl: () => ({
        exit_code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("fail"),
        timed_out: false,
        duration_ms: 1,
      }),
    }),
  });
  assert.equal(observation.ok, true);
  if (!observation.ok) return;
  assert.equal(observation.bundle.facts[0]?.unavailable?.reason.includes("exit"), true);
  assert.equal(observation.bundle.facts[0]?.value, undefined);
});

test("required provider failure is a block-before-model outcome", async () => {
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      spawnImpl: () => ({
        exit_code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("fail"),
        timed_out: false,
        duration_ms: 1,
      }),
    }),
  });
  assert.equal(observation.ok, false);
  if (!observation.ok) {
    assert.equal(observation.tag, PLANNING_FACTS_CONTRACT_TAG);
    assert.match(observation.reason, /alembic-head: exit/);
  }
});

test("Alembic fixture provider reports head 0074 from versions directory", async () => {
  const wt = fixtureWorktree();
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: wt,
    deps: baseDeps({
      spawnImpl: (req) => {
        assert.equal(req.cwd, wt);
        const head = alembicHeadFromDir(req.cwd);
        return successSpawn({ alembic_head: head });
      },
    }),
  });
  assert.equal(observation.ok, true);
  if (!observation.ok) return;
  assert.equal(observation.bundle.facts[0]?.value, "0074");
});

test("stale triage 0069/0068 in the issue body; injected fact is 0074", () => {
  const bundle: PlanningFactBundle = {
    repo_id: "acme/widget",
    integration_base_sha: "s",
    worktree_head_sha: "h",
    worktree_tree_sha: "t",
    providers_digest: "p",
    observed_at: "2026-08-29T15:46:05Z",
    facts: [{ id: "alembic_head", provider_id: "alembic-head", required: true, value: "0074", digest: digestValue("0074") }],
  };
  const body = "Use revision = \"0069\", down_revision = \"0068\".";
  const prompt = buildPlanningPrompt({
    cfg: cfg(),
    issueNumber: 268,
    title: "add migration",
    body,
    planningFacts: bundle,
  });
  assert.match(prompt, /0068/);
  assert.match(prompt, /0074/);
  assert.match(prompt, /supersede issue-body/);
  assert.doesNotMatch(planningFactsSection(undefined) + "x", /Planning Facts/);
});

test("omitted planning facts leave planning prompts section-free", () => {
  const out = buildPlanningPrompt({ cfg: cfg(), issueNumber: 1, title: "t", body: "b" });
  assert.doesNotMatch(out, /Planning Facts \(engine-observed\)/);
  assert.doesNotMatch(out, /\{\{planning_facts\}\}/);
  const review = buildPlanReviewPrompt({
    cfg: cfg(),
    issueNumber: 1,
    title: "t",
    body: "b",
    plan: "p",
    reviewer: "codex",
    implementer: "claude",
  });
  assert.doesNotMatch(review, /Planning Facts \(engine-observed\)/);
});

test("claims schema is single-sourced into the planning-facts section", () => {
  const bundle: PlanningFactBundle = {
    repo_id: "acme/widget",
    integration_base_sha: "s",
    worktree_head_sha: "h",
    worktree_tree_sha: "t",
    providers_digest: "p",
    observed_at: "t",
    facts: [{ id: "alembic_head", provider_id: "alembic-head", required: true, value: "0074", digest: "d" }],
  };
  const section = planningFactsSection(bundle, { role: "planner" });
  assert.ok(section.includes(PLANNING_FACT_CLAIMS_SCHEMA_BLOCK));
  assert.deepEqual(PLANNING_FACT_CLAIMS_SCHEMA_FIELDS.envelope, ["schema_version", "claims"]);
  assert.deepEqual(PLANNING_FACT_CLAIMS_SCHEMA_FIELDS.claim, ["fact_id", "value_digest"]);
});

test("false verification prose is not engine-verified", () => {
  const digest = digestValue("0074");
  const bundle: PlanningFactBundle = {
    repo_id: "acme/widget",
    integration_base_sha: "s",
    worktree_head_sha: "h",
    worktree_tree_sha: "t",
    providers_digest: "p",
    observed_at: "t",
    facts: [{ id: "alembic_head", provider_id: "alembic-head", required: true, value: "0074", digest }],
  };
  const plan = `Alembic head verified — ls alembic/versions | tail terminates at 0068; 0069 confirmed, not assumed.`;
  const extracted = extractPlanningFactClaims(plan, bundle);
  assert.equal(extracted.ok, true);
  if (extracted.ok) {
    assert.equal(extracted.missing, true);
    assert.equal(extracted.claims.length, 0);
  }
  const review = buildPlanReviewPrompt({
    cfg: cfg(),
    issueNumber: 1,
    title: "t",
    body: "b",
    plan,
    reviewer: "codex",
    implementer: "claude",
    planningFacts: bundle,
  });
  assert.match(review, /0074/);
  assert.match(review, /untrusted/);
});

test("matching claim is engine-verified; stale digest is not; malformed fails closed", () => {
  const digest = digestValue("0074");
  const bundle: PlanningFactBundle = {
    repo_id: "acme/widget",
    integration_base_sha: "s",
    worktree_head_sha: "h",
    worktree_tree_sha: "t",
    providers_digest: "p",
    observed_at: "t",
    facts: [{ id: "alembic_head", provider_id: "alembic-head", required: true, value: "0074", digest }],
  };
  const match = extractPlanningFactClaims(
    "plan\n```planning-fact-claims\n" + JSON.stringify({ schema_version: 1, claims: [{ fact_id: "alembic_head", value_digest: digest }] }) + "\n```\n",
    bundle,
  );
  assert.equal(match.ok, true);
  if (match.ok) assert.equal(match.claims[0]?.engine_verified, true);

  const stale = extractPlanningFactClaims(
    "plan\n```planning-fact-claims\n" + JSON.stringify({ schema_version: 1, claims: [{ fact_id: "alembic_head", value_digest: "deadbeef" }] }) + "\n```\n",
    bundle,
  );
  assert.equal(stale.ok, true);
  if (stale.ok) assert.equal(stale.claims[0]?.engine_verified, false);

  const malformed = extractPlanningFactClaims("plan\n```planning-fact-claims\nnot-json\n```\n", bundle);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.tag, PLANNING_FACTS_CONTRACT_TAG);
    assert.match(malformed.reason, /claims/);
  }
});

test("implementing prompt requires re-derivation and does not treat planning-time facts as current", () => {
  const out = buildImplementingPrompt({
    cfg: cfg(),
    issueNumber: 1,
    title: "t",
    body: "b",
    plan: "next revision is 0069",
    pipelineRunId: "1/x",
  });
  assert.match(out, /re-read that state in this worktree/);
  assert.match(out, /Do not treat planning-time fact values as the write-time source of truth/);
  assert.doesNotMatch(out, /Planning Facts \(engine-observed\)/);
});

function nextRevisionAfter(head: string): string {
  return String(Number(head) + 1).padStart(4, "0");
}

function fakeImplementerWriteRevision(opts: { plannedNext: string; worktreeDir: string; reread: boolean }): string {
  if (!opts.reread) return opts.plannedNext;
  const head = alembicHeadFromDir(opts.worktreeDir);
  return nextRevisionAfter(head);
}

test("implementation-time revalidation: writing the planned revision without a fresh read is the regression", () => {
  const wt = fixtureWorktree();
  const versionsDir = path.join(wt, "alembic", "versions");
  const withoutRead = fakeImplementerWriteRevision({ plannedNext: "0069", worktreeDir: wt, reread: false });
  assert.equal(withoutRead, "0069");
  assert.ok(fs.existsSync(path.join(versionsDir, "0069_use_case_business_case.py")));
  const withRead = fakeImplementerWriteRevision({ plannedNext: "0069", worktreeDir: wt, reread: true });
  assert.equal(withRead, "0075");
});

const revisionOkResult: HarnessResult = {
  success: true,
  stdout: "## Revised Plan\n\nDo the thing.\n\n## Feedback Incorporated\n\n- [ADDRESSED] reviewer concern\n\n## Human Feedback Acknowledgement\n\nAcknowledged.",
  stderr: "",
  exit_code: 0,
  duration: 1,
  timed_out: false,
};
const planReviewOk: HarnessResult = {
  success: true,
  stdout: "## Plan Review Verdict\n\nApproved.",
  stderr: "",
  exit_code: 0,
  duration: 1,
  timed_out: false,
};

function eqCfg(): PipelineConfig {
  return cfg({
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
    last30days: { enabled: false, timeout: 600 },
    openspec: { enabled: "auto", bootstrap: false },
    worktree_root: ".worktrees",
    marker_footer: "---pipeline---",
    implementation_ready_message: "Implementation ready.",
    implementation_timeout: 300,
    review_timeout: 300,
    plan_review_timeout: 300,
  });
}

function freeformHooks(): PlanningPhaseHooks {
  return {
    async authorArtifact() {
      return { ok: true, planText: "## Plan\n\nDo the thing.", specContext: "", readyToPlanningMsg: "Implementation plan generated." };
    },
    async validateArtifact() { return { ok: true }; },
    async revalidateArtifact(_wt, revisionStdout) {
      return { ok: true, updatedPlanText: revisionStdout, updatedSpecContext: "" };
    },
    buildPrBody(_c, issueNumber) { return `Closes #${issueNumber}`; },
    buildTransitionMessage(prNumber) { return `PR #${prNumber}`; },
    planToReviewMsg() { return "Reviewing."; },
    preImplTransitionMsg() { return "Implementing."; },
    revisedPlanHeaderLines(p, r) { return [`**Updated by**: ${p}`, `**Based on review by**: ${r}`]; },
    buildImplPlan(_wt, plan) { return plan; },
  };
}

function openspecHooks(): PlanningPhaseHooks {
  const h = freeformHooks();
  return {
    ...h,
    async authorArtifact() {
      return {
        ok: true,
        planText: "_OpenSpec change `x`_\n\n## Proposal\n\nDo the thing.",
        promptPlanText: "## Proposal\n\nDo the thing.",
        specContext: "",
        readyToPlanningMsg: "OpenSpec drafted.",
      };
    },
  };
}

function baseRunnerDeps(over: Record<string, unknown> = {}) {
  return {
    createWorktree: async () => ({ path: "/fake/wt", branch: "pipeline/42" }),
    detectAndInstall: async () => ({ skipped: true }),
    removeWorktree: async () => {},
    invoke: async () => revisionOkResult,
    setBlocked: async () => {},
    transition: async () => {},
    postComment: async () => {},
    addLabel: async () => {},
    getIssueDetail: async () => ({ title: "Test", body: "test body", comments: [], number: 42, labels: [], state: "open" }),
    invokeReviewer: async () => ({ result: planReviewOk, effectiveReviewer: "codex", selfReview: false }),
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    hasCommitsAhead: async () => true,
    runTestGate: async () => ({ skipped: true }),
    runFormatGate: async () => ({ status: "ok" as const, committed: false }),
    getPrForBranch: async () => null,
    createPr: async () => 99,
    disposeSupersededIssuePrs: async () => ({ closed: [], commented: [], errors: [], isCanonical: true }),
    ...over,
  };
}

function digestFor(head: string): string {
  return digestValue(head);
}

function bundleWithHead(head: string, observedAt = "t1"): PlanningFactBundle {
  return {
    repo_id: "acme/widget",
    integration_base_sha: "base-a",
    worktree_head_sha: "h",
    worktree_tree_sha: "t",
    providers_digest: "p",
    observed_at: observedAt,
    facts: [{ id: "alembic_head", provider_id: "alembic-head", required: true, value: head, digest: digestFor(head) }],
  };
}

test("runPlanningPhases observes three times across author, review, and revision", async () => {
  const heads = ["0074", "0074", "0074"];
  let i = 0;
  const deps = baseRunnerDeps({
    observePlanningFacts: async () => {
      const b = bundleWithHead(heads[Math.min(i, heads.length - 1)], `t${i}`);
      i += 1;
      return { ok: true as const, block: false as const, bundle: b };
    },
  });
  await runPlanningPhases(eqCfg(), 42, "Test", "body", "run-42", {}, freeformHooks(), deps as never);
  assert.equal(i, 3);
});

test("required provider failure skips the harness on freeform and OpenSpec with the same tag and prefix", async () => {
  const prefix = planningFactsReasonPrefix("alembic-head", "timeout");
  for (const hooks of [freeformHooks(), openspecHooks()]) {
    let reviewCalls = 0;
    let invokeCalls = 0;
    let blocked: { tag: string; reason: string } | undefined;
    const deps = baseRunnerDeps({
      invoke: async () => {
        invokeCalls += 1;
        return revisionOkResult;
      },
      invokeReviewer: async () => {
        reviewCalls += 1;
        return { result: planReviewOk, effectiveReviewer: "codex", selfReview: false };
      },
      setBlocked: async (_c: unknown, _n: unknown, reason: string, _s: string, tag: string) => {
        blocked = { tag, reason };
      },
      observePlanningFacts: async () => ({
        ok: false as const,
        tag: PLANNING_FACTS_CONTRACT_TAG,
        failureClass: "timeout" as const,
        reason: `${prefix}: exceeded 10000ms`,
        providerId: "alembic-head",
      }),
    });
    const outcome: Outcome = await runPlanningPhases(eqCfg(), 42, "Test", "body", "run-42", {}, hooks, deps as never);
    assert.equal(blocked?.tag, PLANNING_FACTS_CONTRACT_TAG);
    assert.equal(blocked?.reason.startsWith(prefix), true);
    assert.equal(reviewCalls, 0);
    assert.equal(invokeCalls, 0);
    assert.equal(outcome.advanced, false);
  }
});

test("required fact change 0068 → 0074 skips plan-review and enters revision with identities", async () => {
  const sequence = [bundleWithHead("0068", "t0"), bundleWithHead("0074", "t1"), bundleWithHead("0074", "t2")];
  let i = 0;
  let reviewCalls = 0;
  const revisionPrompts: string[] = [];
  const deps = baseRunnerDeps({
    observePlanningFacts: async () => {
      const bundle = sequence[Math.min(i, sequence.length - 1)];
      i += 1;
      return { ok: true as const, block: false as const, bundle };
    },
    invokeReviewer: async () => {
      reviewCalls += 1;
      return { result: planReviewOk, effectiveReviewer: "codex", selfReview: false };
    },
    invoke: async (_h: unknown, _p: unknown, prompt: string) => {
      revisionPrompts.push(prompt);
      return revisionOkResult;
    },
  });
  await runPlanningPhases(eqCfg(), 42, "Test", "body", "run-42", {}, freeformHooks(), deps as never);
  assert.equal(reviewCalls, 0);
  assert.ok(revisionPrompts.length >= 1);
  const revision = revisionPrompts[0];
  assert.match(revision, new RegExp(digestFor("0068")));
  assert.match(revision, /0074/);
  assert.match(revision, new RegExp(digestFor("0074")));
  assert.match(revision, /Previous:/);
  assert.match(revision, /Current:/);
});

test("optional-only fact change does not skip plan-review", async () => {
  const requiredDigest = digestFor("0074");
  const bundles: PlanningFactBundle[] = [0, 1, 2].map((n) => ({
    repo_id: "acme/widget",
    integration_base_sha: "base-a",
    worktree_head_sha: "h",
    worktree_tree_sha: "t",
    providers_digest: "p",
    observed_at: `t${n}`,
    facts: [
      { id: "alembic_head", provider_id: "alembic-head", required: true, value: "0074", digest: requiredDigest },
      { id: "note", provider_id: "opt", required: false, value: `v${n}`, digest: digestValue(`v${n}`) },
    ],
  }));
  let i = 0;
  let reviewCalls = 0;
  const deps = baseRunnerDeps({
    observePlanningFacts: async () => {
      const bundle = bundles[Math.min(i, bundles.length - 1)];
      i += 1;
      return { ok: true as const, block: false as const, bundle };
    },
    invokeReviewer: async () => {
      reviewCalls += 1;
      return { result: planReviewOk, effectiveReviewer: "codex", selfReview: false };
    },
  });
  await runPlanningPhases(eqCfg(), 42, "Test", "body", "run-42", {}, freeformHooks(), deps as never);
  assert.equal(reviewCalls, 1);
});

test("concurrent base advancement observes the new head; update failure does not reuse stale facts", async () => {
  let updateCalls = 0;
  const observation = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      previousIntegrationBaseSha: "old-sha",
      resolveIntegrationBaseSha: async () => "new-sha",
      updateWorktreeOntoBase: async (sha) => {
        updateCalls += 1;
        assert.equal(sha, "new-sha");
        return { ok: true };
      },
      spawnImpl: () => successSpawn({ alembic_head: "0074" }),
    }),
  });
  assert.equal(updateCalls, 1);
  assert.equal(observation.ok, true);
  if (observation.ok) assert.equal(observation.bundle.facts[0]?.value, "0074");

  const failed = await observePlanningFacts({
    cfg: cfg(),
    worktreeDir: "/wt",
    deps: baseDeps({
      previousIntegrationBaseSha: "old-sha",
      resolveIntegrationBaseSha: async () => "new-sha",
      updateWorktreeOntoBase: async () => ({ ok: false, reason: "conflict" }),
    }),
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.reason, /base-update/);
});
