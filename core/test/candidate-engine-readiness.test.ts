// Candidate-engine resolve-and-prepare (#1344). Injected fs/digest/install/lock
// only — no real network, git, or npm.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateReadyRecordPath,
  candidateSetupLockPath,
  CANDIDATE_CORE_LOCKFILE_REL,
  READY_RECORD_SCHEMA,
  SETUP_LOCK_SCHEMA,
  resolveCandidateReadinessStateDir,
  type InstallerHandle,
  type PrepareCandidateEngineDeps,
} from "../scripts/candidate-engine-readiness.ts";
import {
  CANDIDATE_PROCESS_GUARD_REL,
  CANDIDATE_ENGINE_CONSUMERS,
  assertCandidateEngineConsumerInventoryComplete,
  candidateEngineConsumerInventoryGaps,
  candidateEngineRuntimeBindingGaps,
  runCandidateEngineProcess,
  revalidateCandidateEngineBeforeSpawn,
  resolveAndPrepareCandidateEngine as sharedResolveAndPrepareCandidateEngine,
  resolveCandidateEngine,
  type ResolveAndPrepareCandidateEngineDeps,
  type ResolveCandidateEngineDeps,
} from "../scripts/ship-end-candidate.ts";
import { BLOCKER_KINDS } from "../scripts/types.ts";
import { verifyCandidateProcessGuard } from "../../scripts/candidate-process-guard.mjs";

const SHA = "b".repeat(40);
const OTHER = "d".repeat(40);
const LOCKFILE_V1 = Buffer.from('{"lockfileVersion":1,"v":"one"}');
const LOCKFILE_V2 = Buffer.from('{"lockfileVersion":1,"v":"two"}');
const DIGEST_V1 = "d1-lock";
const DIGEST_V2 = "d2-lock";

function fakeProcessLease() {
  return {
    proof: {
      engineRoot: "/candidate",
      commitSha: SHA,
      readyRecordPath: "/state/ready.json",
      lockfileDigest: DIGEST_V1,
      processLockPath: "/state/process.lock",
      processLockDigest: "f".repeat(64),
    },
    release() {},
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function resolveAndPrepareCandidateEngine(
  opts: Omit<Parameters<typeof sharedResolveAndPrepareCandidateEngine>[0], "consumer">,
  deps: ResolveAndPrepareCandidateEngineDeps,
) {
  return sharedResolveAndPrepareCandidateEngine(
    { ...opts, consumer: "ship.stage-adapter" },
    deps,
  );
}

function readTypeScriptSources(root: string, relative = ""): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      Object.assign(sources, readTypeScriptSources(root, child));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      sources[child] = fs.readFileSync(path.join(root, child), "utf8");
    }
  }
  return sources;
}

test("candidate-engine consumer inventory is exact and hard-gated (#1454)", () => {
  assert.doesNotThrow(() => assertCandidateEngineConsumerInventoryComplete());
  assert.deepEqual(candidateEngineConsumerInventoryGaps(), []);
  assert.throws(
    () => assertCandidateEngineConsumerInventoryComplete(
      CANDIDATE_ENGINE_CONSUMERS.filter((row) => row.consumer !== "factory-release.pack-loop.start"),
    ),
    /missing consumer factory-release\.pack-loop\.start/,
  );
  const bypass = CANDIDATE_ENGINE_CONSUMERS.map((row) =>
    row.consumer === "ship.stage-adapter" ? { ...row, child_side_guard: false } : row,
  ) as never;
  assert.throws(
    () => assertCandidateEngineConsumerInventoryComplete(bypass),
    /ship\.stage-adapter missing child_side_guard/,
  );
});

test("candidate-engine hard gate discovers and exercises every production process start (#1454)", async () => {
  const sources = readTypeScriptSources(path.join(repoRoot, "core", "scripts"));
  assert.deepEqual(candidateEngineRuntimeBindingGaps(sources), []);

  const bypass = {
    ...sources,
    "new-consumer.ts": `async function bypass(engine) {
      await resolveAndPrepareCandidateEngine(engine);
      await revalidateCandidateEngineBeforeSpawn(engine);
      spawn(engine.launcherPath);
    }`,
  };
  assert.deepEqual(
    candidateEngineRuntimeBindingGaps(bypass).filter((gap) => gap.includes("new-consumer.ts")),
    [
      "raw parent-only candidate revalidation in new-consumer.ts",
      "raw candidate process start in new-consumer.ts",
    ],
  );

  const hiddenAlongsideAValidConsumer = {
    ...sources,
    "stages/ship-adapter.ts": `${sources["stages/ship-adapter.ts"]}\nspawn(candidate.engine.launcherPath);`,
  };
  assert.ok(
    candidateEngineRuntimeBindingGaps(hiddenAlongsideAValidConsumer)
      .includes("raw candidate process start in stages/ship-adapter.ts"),
    "a raw new spawn in a file that already has a valid consumer must still fail the hard gate",
  );

  const aliasedSpawn = {
    ...sources,
    "aliased-consumer.ts": `const start = spawn;\nstart(engine.launcherPath, args);`,
  };
  assert.ok(
    candidateEngineRuntimeBindingGaps(aliasedSpawn)
      .includes("raw candidate process start in aliased-consumer.ts"),
    "an aliased spawn of the candidate launcher must fail the hard gate",
  );

  const renamedImport = {
    ...sources,
    "aliased-import.ts": `import { spawn as start } from "node:child_process";\nstart(engine.launcherPath);`,
  };
  assert.ok(
    candidateEngineRuntimeBindingGaps(renamedImport)
      .includes("raw candidate process start in aliased-import.ts"),
    "a renamed spawn import of the candidate launcher must fail the hard gate",
  );

  for (const row of CANDIDATE_ENGINE_CONSUMERS) {
    let starts = 0;
    const engine = {
      engineRoot: "/candidate",
      launcherPath: "/candidate/scripts/pipeline-launcher.mjs",
      commitSha: SHA,
      consumer: row.consumer,
      acquireProcessLock: fakeProcessLease,
      revalidateBeforeSpawn: () => ({ ok: true as const, engine: {
        engineRoot: "/candidate",
        launcherPath: "/candidate/scripts/pipeline-launcher.mjs",
        commitSha: SHA,
        consumer: row.consumer,
        acquireProcessLock: fakeProcessLease,
        revalidateBeforeSpawn: () => { throw new Error("single boundary validation only"); },
      } }),
    };
    const result = await row.execute({
      engine,
      start: async () => ++starts,
    });
    assert.equal(result.ok, true, row.consumer);
    assert.equal(starts, 1, row.consumer);
  }
});

test("resolve-and-prepare rejects an uninventoried consumer before resolution I/O (#1454)", async () => {
  let touched = false;
  const deps = {
    isDirectory() { touched = true; return true; },
    fileExists() { touched = true; return true; },
    revParseHead() { touched = true; return SHA; },
    porcelain() { touched = true; return ""; },
  } as ResolveAndPrepareCandidateEngineDeps;
  await assert.rejects(
    sharedResolveAndPrepareCandidateEngine(
      {
        repoDir: "/repo",
        candidateSha: SHA,
        consumer: "new.uninventoried.consumer" as never,
      },
      deps,
    ),
    /not bound exactly once/,
  );
  assert.equal(touched, false);
});

type RootState = {
  head: string | null;
  porcelain: string | null;
  files?: string[];
};

type EventLog = string[];

function defaultFiles(root: string): string[] {
  return [
    path.join(root, "core/scripts/pipeline.ts"),
    path.join(root, "scripts/pipeline-launcher.mjs"),
    path.join(root, CANDIDATE_PROCESS_GUARD_REL),
    path.join(root, CANDIDATE_CORE_LOCKFILE_REL),
  ];
}

function identityDeps(opts: {
  roots: Record<string, RootState>;
  fetchOk?: boolean;
  addOk?: boolean;
  created?: string[];
}): ResolveCandidateEngineDeps {
  const created = opts.created ?? [];
  return {
    isDirectory: (p) => opts.roots[p] != null,
    fileExists: (p) => {
      for (const [root, st] of Object.entries(opts.roots)) {
        const files = st.files ?? defaultFiles(root);
        if (files.includes(p)) return true;
      }
      return false;
    },
    revParseHead: (cwd) => opts.roots[cwd]?.head ?? null,
    porcelain: (cwd) => opts.roots[cwd]?.porcelain ?? null,
    fetchSha: (repo, sha) => {
      void repo;
      return opts.fetchOk === true && sha === SHA;
    },
    worktreeAdd: (repo, dest, sha) => {
      if (opts.addOk !== true) return false;
      opts.roots[dest] = { head: sha, porcelain: "" };
      created.push(`${repo}:${dest}:${sha}`);
      return true;
    },
  };
}

function prepareHarness(opts: {
  roots: Record<string, RootState>;
  lockfiles?: Record<string, Buffer>;
  digests?: Record<string, string>;
  installCode?: number;
  holdInstall?: boolean;
  parentAlive?: boolean;
  childGroupAlive?: boolean;
  existingLock?: string | null;
  existingReady?: string | null;
  vanishLockAfterRead?: boolean;
  porcelainAfterInstall?: string | null;
  headAfterInstall?: string | null;
  setupCommand?: string;
  fetchOk?: boolean;
  addOk?: boolean;
  realpath?: (p: string) => string | null;
  onStartInstall?: () => void;
  porcelainAfterIdentity?: string | null;
  headAfterIdentity?: string | null;
  untrustedPaths?: string[];
  ensureStateDir?: boolean;
}): {
  deps: ResolveAndPrepareCandidateEngineDeps;
  events: EventLog;
  installs: Array<{ cwd: string; lockfilePath: string }>;
  heartbeatsSeen: number[];
  readyWrites: string[];
  lockUnlinks: string[];
  spawned: string[][];
  releaseInstall: () => void;
  setChildGroupAlive: (v: boolean) => void;
  setOwnerParentAlive: (v: boolean) => void;
  files: Map<string, string>;
} {
  const events: EventLog = [];
  const installs: Array<{ cwd: string; lockfilePath: string }> = [];
  const heartbeatsSeen: number[] = [];
  const readyWrites: string[] = [];
  const lockUnlinks: string[] = [];
  const spawned: string[][] = [];
  const files = new Map<string, string>();
  const created: string[] = [];
  const identity = identityDeps({
    roots: opts.roots,
    fetchOk: opts.fetchOk,
    addOk: opts.addOk,
    created,
  });
  let identityHeadCalls = 0;
  let identityPorcelainCalls = 0;
  const origHead = identity.revParseHead;
  const origPorcelain = identity.porcelain;
  identity.revParseHead = (cwd) => {
    identityHeadCalls += 1;
    if (opts.headAfterIdentity !== undefined && identityHeadCalls > 1) {
      return opts.headAfterIdentity;
    }
    return origHead(cwd);
  };
  identity.porcelain = (cwd) => {
    identityPorcelainCalls += 1;
    if (opts.porcelainAfterIdentity !== undefined && identityPorcelainCalls > 1) {
      return opts.porcelainAfterIdentity;
    }
    return origPorcelain(cwd);
  };
  let holdResolve: ((r: { code: number; stdout: string; stderr: string }) => void) | null = null;
  let childGroupAlive = opts.childGroupAlive ?? false;
  let ownerParentAlive = true;
  let now = 1_000;
  const lockfiles = opts.lockfiles ?? {};
  const digests = opts.digests ?? {};
  let lockReads = 0;

  if (opts.existingLock) {
    const [root] = Object.keys(opts.roots);
    files.set(candidateSetupLockPath(root!, SHA, "/tmp-state"), opts.existingLock);
  }
  if (opts.existingReady) {
    const [root] = Object.keys(opts.roots);
    files.set(candidateReadyRecordPath(root!, SHA, "/tmp-state"), opts.existingReady);
  }

  const startInstall = (installOpts: { cwd: string; lockfilePath: string }): InstallerHandle => {
    installs.push({ ...installOpts });
    events.push("install");
    opts.onStartInstall?.();
    if (opts.porcelainAfterInstall !== undefined) {
      const root = path.dirname(installOpts.cwd);
      if (opts.roots[root]) opts.roots[root].porcelain = opts.porcelainAfterInstall;
    }
    if (opts.headAfterInstall !== undefined) {
      const root = path.dirname(installOpts.cwd);
      if (opts.roots[root]) opts.roots[root].head = opts.headAfterInstall;
    }
    const done = opts.holdInstall
      ? new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
          holdResolve = resolve;
        })
      : Promise.resolve({
          code: opts.installCode ?? 0,
          stdout: "",
          stderr: opts.installCode ? "npm ERR! exploded" : "",
        });
    return { pgid: 4242, starttime: "child-st", done };
  };

  const prepare: PrepareCandidateEngineDeps = {
    readFile: (p) => {
      if (lockfiles[p]) return lockfiles[p];
      throw new Error(`unexpected readFile ${p}`);
    },
    readText: (p) => {
      const body = files.get(p) ?? null;
      if (p.includes("pipeline-candidate-setup-") && body) {
        try {
          const parsed = JSON.parse(body) as { heartbeatAt?: number };
          if (typeof parsed.heartbeatAt === "number") heartbeatsSeen.push(parsed.heartbeatAt);
        } catch {
          /* ignore */
        }
        lockReads += 1;
        if (opts.vanishLockAfterRead && lockReads >= 2) {
          files.delete(p);
          return body;
        }
      }
      return body;
    },
    writeText: (p, body, flag) => {
      if (flag === "wx" && files.has(p)) return false;
      files.set(p, body);
      if (p.includes("pipeline-candidate-ready-")) readyWrites.push(body);
      if (p.includes("pipeline-candidate-setup-")) {
        try {
          const parsed = JSON.parse(body) as { heartbeatAt?: number };
          if (typeof parsed.heartbeatAt === "number") events.push(`heartbeat:${parsed.heartbeatAt}`);
        } catch {
          /* ignore */
        }
      }
      assert.equal(p.startsWith("/tmp-state/"), true, "state files must live outside the candidate tree");
      return true;
    },
    remove: (p) => {
      files.delete(p);
      if (p.includes("pipeline-candidate-setup-")) lockUnlinks.push(p);
    },
    digest: (buf) => {
      if (buf.equals(LOCKFILE_V1)) return DIGEST_V1;
      if (buf.equals(LOCKFILE_V2)) return DIGEST_V2;
      return digests[buf.toString()] ?? "digest-other";
    },
    nowMs: () => {
      now += 50;
      return now;
    },
    sleep: async () => {
      now += 200;
    },
    tmpDir: () => "/tmp-state",
    ensureStateDir: () => opts.ensureStateDir !== false,
    statePathTrusted: (p) => !(opts.untrustedPaths ?? []).includes(p),
    parentIdentity: () => ({ pid: 111, starttime: "parent-st" }),
    processAlive: (pid) => {
      if (pid === 111) return ownerParentAlive;
      if (opts.parentAlive === false && pid === 999) return false;
      if (opts.parentAlive === false && pid !== 111) return false;
      if (pid === 999) return false;
      return false;
    },
    processGroupAlive: (pgid) => pgid === 4242 && childGroupAlive,
    realpath: opts.realpath ?? ((p) => path.resolve(p)),
    startInstall,
    heartbeatIntervalMs: 10,
    heartbeatStaleMs: 1_000,
    waiterPollMs: 5,
    waiterMaxMs: 5_000,
  };

  void opts.setupCommand;

  const deps: ResolveAndPrepareCandidateEngineDeps = { ...identity, ...prepare };
  return {
    deps,
    events,
    installs,
    heartbeatsSeen,
    readyWrites,
    lockUnlinks,
    spawned,
    releaseInstall: () => {
      holdResolve?.({ code: 0, stdout: "", stderr: "" });
    },
    setChildGroupAlive: (v) => {
      childGroupAlive = v;
    },
    setOwnerParentAlive: (v) => {
      ownerParentAlive = v;
    },
    files,
  };
}

function recordSpawn(events: EventLog, spawned: string[][], argv: string[]): void {
  if (!events.includes("ready")) {
    throw new Error(`candidate command spawned before readiness success: ${argv.join(" ")}`);
  }
  events.push("spawn");
  spawned.push(argv);
}

async function resolveThenSpawn(
  h: ReturnType<typeof prepareHarness>,
  opts: {
    repoDir: string;
    candidateSha?: string;
    candidateEngineRootEnv?: string | null;
  },
) {
  const result = await resolveAndPrepareCandidateEngine(
    {
      repoDir: opts.repoDir,
      candidateSha: opts.candidateSha ?? SHA,
      candidateEngineRootEnv: opts.candidateEngineRootEnv,
    },
    h.deps,
  );
  if (result.ok) {
    h.events.push("ready");
    const checked = await revalidateCandidateEngineBeforeSpawn(result.engine);
    if (!checked.ok) return checked;
    recordSpawn(h.events, h.spawned, [
      "node",
      checked.engine.launcherPath,
      "factory-release",
      "prepare",
    ]);
  }
  return result;
}

test("candidate movement after an earlier parent check is refused inside the process-start boundary (#1454)", async () => {
  const repo = "/repo";
  const root = { head: SHA, porcelain: "" };
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: root },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
  });
  const prepared = await resolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: SHA },
    h.deps,
  );
  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    const priorParentCheck = revalidateCandidateEngineBeforeSpawn(prepared.engine);
    assert.equal(priorParentCheck.ok, true);
    root.head = OTHER;
    const started = await runCandidateEngineProcess({
      consumer: "ship.stage-adapter",
      engine: prepared.engine,
      start: async () => {
        recordSpawn(h.events, h.spawned, ["node", prepared.engine.launcherPath]);
      },
    });
    assert.equal(started.ok, false);
  }
  assert.equal(h.spawned.length, 0);
});

test("candidate movement after final parent validation is refused by the child-side guard (#1454)", async () => {
  const engineRoot = "/candidate";
  const lockfile = Buffer.from("candidate lockfile");
  const lockfileDigest = createHash("sha256").update(lockfile).digest("hex");
  const processLock = Buffer.from("held candidate process lease");
  const proof = {
    engineRoot,
    commitSha: SHA,
    readyRecordPath: "/state/ready.json",
    lockfileDigest,
    processLockPath: "/state/process.lock",
    processLockDigest: createHash("sha256").update(processLock).digest("hex"),
  };
  let head = SHA;
  let candidateStarts = 0;
  const engine = {
    engineRoot,
    launcherPath: path.join(engineRoot, "scripts", "pipeline-launcher.mjs"),
    commitSha: SHA,
    consumer: "ship.stage-adapter" as const,
    acquireProcessLock: () => ({ proof, release() {} }),
    revalidateBeforeSpawn: () => ({ ok: true as const, engine }),
  };

  const started = await runCandidateEngineProcess({
    consumer: "ship.stage-adapter",
    engine,
    start: async (_checked, childEnv) => {
      head = OTHER; // The reviewed race: movement after the parent's final check.
      const guarded = verifyCandidateProcessGuard(childEnv, {
        realpath: (p: string) => p === engineRoot
          ? engineRoot
          : p.endsWith("candidate-process-guard.mjs")
            ? path.join(engineRoot, CANDIDATE_PROCESS_GUARD_REL)
            : p,
        readFile: (p: string) => {
          if (p === proof.processLockPath) return processLock;
          if (p === proof.readyRecordPath) return Buffer.from(JSON.stringify({
            schema: READY_RECORD_SCHEMA,
            engineRoot,
            commitSha: SHA,
            lockfileDigest,
          }));
          if (p === path.join(engineRoot, CANDIDATE_CORE_LOCKFILE_REL)) return lockfile;
          throw new Error(`unexpected guard read ${p}`);
        },
        git: (_root: string, args: string[]) => args[0] === "status" ? "" : `${head}\n`,
      });
      if (guarded.ok) candidateStarts += 1;
      return guarded.ok ? 0 : 78;
    },
  });

  assert.equal(started.ok, true);
  if (started.ok) assert.equal(started.value, 78);
  assert.equal(candidateStarts, 0);
});

function candidateRootLockPath(engineRoot: string): string {
  return path.join(
    "/tmp-state",
    `pipeline-candidate-process-${createHash("sha256").update(engineRoot).digest("hex").slice(0, 32)}.lock`,
  );
}

test("detached pack loop retains the candidate-root lease until the child exits (#1454)", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
  });
  let childAlive = true;
  let parentAlive = true;
  h.deps.processAlive = (pid) => {
    if (pid === 111) return parentAlive;
    if (pid === 4242) return childAlive;
    return false;
  };
  const prepared = await sharedResolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: SHA, consumer: "factory-release.pack-loop.start" },
    h.deps,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const first = await runCandidateEngineProcess({
    consumer: "factory-release.pack-loop.start",
    engine: prepared.engine,
    start: async () => ({ dispatch_state: "dispatched" as const, pid: 4242 }),
    detachedSupervisor: (value) =>
      value.dispatch_state === "dispatched" ? { pid: value.pid, starttime: null } : null,
  });
  assert.equal(first.ok, true);
  const lockPath = candidateRootLockPath(repo);
  assert.equal(h.files.has(lockPath), true, "lease must remain after detached handoff");
  assert.equal(JSON.parse(h.files.get(lockPath)!).pid, 4242);

  const resumePrepared = await sharedResolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: SHA, consumer: "factory-release.pack-loop.resume" },
    h.deps,
  );
  assert.equal(resumePrepared.ok, true);
  if (!resumePrepared.ok) return;

  const concurrent = await runCandidateEngineProcess({
    consumer: "factory-release.pack-loop.resume",
    engine: resumePrepared.engine,
    start: async () => {
      throw new Error("must not spawn while detached child holds the root");
    },
  });
  assert.equal(concurrent.ok, false);
  if (!concurrent.ok) assert.equal(concurrent.kind, "lock");

  parentAlive = false;
  const afterParentCrash = await runCandidateEngineProcess({
    consumer: "factory-release.pack-loop.resume",
    engine: resumePrepared.engine,
    start: async () => {
      throw new Error("must not spawn after parent crash while child is live");
    },
  });
  assert.equal(afterParentCrash.ok, false);
  if (!afterParentCrash.ok) assert.equal(afterParentCrash.kind, "lock");

  childAlive = false;
  let reclaimed = 0;
  const afterChildExit = await runCandidateEngineProcess({
    consumer: "factory-release.pack-loop.resume",
    engine: resumePrepared.engine,
    start: async () => ++reclaimed,
  });
  assert.equal(afterChildExit.ok, true);
  assert.equal(reclaimed, 1);
});

test("candidate process lock serializes distinct SHAs on one canonical root (#1454)", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const root = { head: SHA, porcelain: "" };
  const h = prepareHarness({
    roots: { [repo]: root },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
  });
  let childAlive = true;
  h.deps.processAlive = (pid) => {
    if (pid === 111) return true;
    if (pid === 4242) return childAlive;
    return false;
  };
  const first = await sharedResolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: SHA, consumer: "factory-release.pack-loop.start" },
    h.deps,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const started = await runCandidateEngineProcess({
    consumer: "factory-release.pack-loop.start",
    engine: first.engine,
    start: async () => ({ dispatch_state: "dispatched" as const, pid: 4242 }),
    detachedSupervisor: (value) => ({ pid: value.pid, starttime: null }),
  });
  assert.equal(started.ok, true);

  root.head = OTHER;
  const second = await sharedResolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: OTHER, consumer: "ship.stage-adapter" },
    h.deps,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const contended = await runCandidateEngineProcess({
    consumer: "ship.stage-adapter",
    engine: second.engine,
    start: async () => {
      throw new Error("must not spawn C2 while C1 child holds the canonical root");
    },
  });
  assert.equal(contended.ok, false);
  if (!contended.ok) assert.equal(contended.kind, "lock");
});

test("candidate process lock trusts its private parent before exclusively creating the lock (#1454)", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
  });
  const originalTrusted = h.deps.statePathTrusted;
  h.deps.statePathTrusted = (p) => p === "/tmp-state" || h.files.has(p) && originalTrusted(p);
  const prepared = await resolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: SHA, consumer: "ship.stage-adapter" },
    h.deps,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  let starts = 0;
  const result = await runCandidateEngineProcess({
    consumer: "ship.stage-adapter",
    engine: prepared.engine,
    start: async () => ++starts,
  });
  assert.equal(result.ok, true);
  assert.equal(starts, 1);
});

test("spawn ordering fails if a candidate command precedes readiness success", () => {
  const events: EventLog = [];
  const spawned: string[][] = [];
  assert.throws(
    () => recordSpawn(events, spawned, ["node", "/cand/scripts/pipeline-launcher.mjs", "factory-release"]),
    /spawned before readiness success/,
  );
});

test("identity-only resolveCandidateEngine is not a spawn gate", () => {
  const repo = "/repo";
  const r = resolveCandidateEngine(
    { repoDir: repo, candidateSha: SHA },
    identityDeps({ roots: { [repo]: { head: SHA, porcelain: "" } } }),
  );
  assert.equal(r.ok, true);
});

test("fresh REPO_DIR at candidate SHA is prepared before spawn", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, true);
  assert.equal(h.installs.length, 1);
  assert.equal(h.installs[0]?.cwd, path.join(repo, "core"));
  assert.equal(h.installs[0]?.lockfilePath, lockfile);
  assert.deepEqual(
    h.events.filter((e) => e === "install" || e === "ready" || e === "spawn"),
    ["install", "ready", "spawn"],
  );
  assert.equal(h.spawned.length, 1);
  assert.equal(h.readyWrites.length, 1);
  assert.match(h.readyWrites[0] ?? "", new RegExp(DIGEST_V1));
});

test("existing ship-candidate worktree is prepared before spawn", async () => {
  const repo = "/repo";
  const worktree = path.join(repo, ".worktrees", `ship-candidate-${SHA}`);
  const lockfile = path.join(worktree, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: {
      [repo]: { head: OTHER, porcelain: "" },
      [worktree]: { head: SHA, porcelain: "" },
    },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.engine.engineRoot, worktree);
  assert.equal(h.installs[0]?.cwd, path.join(worktree, "core"));
  assert.ok(h.events.indexOf("install") < h.events.indexOf("spawn"));
});

test("PIPELINE_CANDIDATE_ENGINE_ROOT is prepared before spawn", async () => {
  const repo = "/repo";
  const cand = "/opt/candidate";
  const lockfile = path.join(cand, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: {
      [repo]: { head: OTHER, porcelain: "" },
      [cand]: { head: SHA, porcelain: "" },
    },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
  });
  const r = await resolveThenSpawn(h, { repoDir: repo, candidateEngineRootEnv: cand });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.engine.engineRoot, cand);
  assert.equal(h.installs[0]?.cwd, path.join(cand, "core"));
});

test("newly created ship-candidate worktree is prepared before spawn", async () => {
  const repo = "/repo";
  const worktree = path.join(repo, ".worktrees", `ship-candidate-${SHA}`);
  const h = prepareHarness({
    roots: { [repo]: { head: OTHER, porcelain: "" } },
    fetchOk: true,
    addOk: true,
    lockfiles: { [path.join(worktree, CANDIDATE_CORE_LOCKFILE_REL)]: LOCKFILE_V1 },
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.engine.engineRoot, worktree);
  assert.equal(h.installs.length, 1);
  assert.equal(h.installs[0]?.cwd, path.join(worktree, "core"));
  assert.ok(!h.events.includes("spawn") || h.events.indexOf("install") < h.events.indexOf("spawn"));
});

test("unmarked core/node_modules is not ready and installs once", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const files = [...defaultFiles(repo), path.join(repo, "core/node_modules/.bin/x")];
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "", files } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, true);
  assert.equal(h.installs.length, 1);
  assert.equal(h.readyWrites.length, 1);
});

test("stale lockfile digest retriggers one nested-core install", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const stale = JSON.stringify({
    schema: READY_RECORD_SCHEMA,
    engineRoot: repo,
    commitSha: SHA,
    lockfileDigest: DIGEST_V1,
  });
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V2 },
    existingReady: `${stale}\n`,
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, true);
  assert.equal(h.installs.length, 1);
  assert.match(h.readyWrites.at(-1) ?? "", new RegExp(DIGEST_V2));
});

test("matching SHA-plus-digest record skips install and still revalidates", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const ready = JSON.stringify({
    schema: READY_RECORD_SCHEMA,
    engineRoot: repo,
    commitSha: SHA,
    lockfileDigest: DIGEST_V1,
  });
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    existingReady: `${ready}\n`,
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, true);
  assert.equal(h.installs.length, 0);
  assert.equal(h.spawned.length, 1);
});

test("setup_command empty string does not skip candidate bootstrap", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    setupCommand: "",
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, true);
  assert.equal(h.installs.length, 1, "setup_command: \"\" must not skip nested-core install");
});

test("install failure writes no success record and does not spawn", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    installCode: 1,
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "readiness");
    assert.match(r.error, /\/repo/);
    assert.match(r.error, /\/repo\/core/);
    assert.match(r.error, /Do not run a global package reinstall/);
    assert.doesNotMatch(r.error, /npm install -g agent-pipeline/);
    assert.doesNotMatch(r.error, /Reinstall the pipeline skill/);
  }
  assert.equal(h.readyWrites.length, 0);
  assert.equal(h.spawned.length, 0);
});

test("missing nested lockfile fails closed with no spawn", async () => {
  const repo = "/repo";
  const h = prepareHarness({
    roots: {
      [repo]: {
        head: SHA,
        porcelain: "",
        files: [
          path.join(repo, "core/scripts/pipeline.ts"),
          path.join(repo, "scripts/pipeline-launcher.mjs"),
          path.join(repo, CANDIDATE_PROCESS_GUARD_REL),
        ],
      },
    },
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /package-lock\.json/);
  assert.equal(h.installs.length, 0);
  assert.equal(h.readyWrites.length, 0);
  assert.equal(h.spawned.length, 0);
});

test("nested-core install CWD is candidate core from that lockfile", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
  });
  await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(h.installs[0]?.cwd, "/repo/core");
  assert.equal(h.installs[0]?.lockfilePath, "/repo/core/package-lock.json");
  assert.notEqual(h.installs[0]?.cwd, "/repo");
});

test("post-bootstrap dirty tree fails closed with no ready record", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    porcelainAfterInstall: " M core/scripts/release.ts",
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, false);
  assert.equal(h.readyWrites.length, 0);
  assert.equal(h.spawned.length, 0);
});

test("post-bootstrap SHA mismatch fails closed with no ready record", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    headAfterInstall: OTHER,
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, false);
  assert.equal(h.readyWrites.length, 0);
  assert.equal(h.spawned.length, 0);
});

test("abbreviated SHA, dirty tree, and relative env still fail closed", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: " M x" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
  });
  const abbreviated = await resolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: SHA.slice(0, 12) },
    h.deps,
  );
  assert.equal(abbreviated.ok, false);
  const dirty = await resolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: SHA },
    h.deps,
  );
  assert.equal(dirty.ok, false);
  const relative = await resolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: SHA, candidateEngineRootEnv: "not/absolute" },
    h.deps,
  );
  assert.equal(relative.ok, false);
  assert.equal(h.installs.length, 0);
});

test("concurrent waiters share one install and observe heartbeats", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    holdInstall: true,
  });
  const first = resolveAndPrepareCandidateEngine({ repoDir: repo, candidateSha: SHA }, h.deps);
  await Promise.resolve();
  await Promise.resolve();
  const second = resolveAndPrepareCandidateEngine({ repoDir: repo, candidateSha: SHA }, h.deps);
  await Promise.resolve();
  await Promise.resolve();
  h.releaseInstall();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(h.installs.length, 1);
  assert.ok(h.heartbeatsSeen.length > 0, "waiter must observe installer heartbeats");
});

test("two lexical aliases of one checkout share exactly one install", async () => {
  const canonical = "/canonical/candidate";
  const aliasEnv = "/aliases/env-root";
  const aliasOther = "/aliases/other-root";
  const h = prepareHarness({
    roots: {
      "/repo": { head: OTHER, porcelain: "" },
      [aliasEnv]: { head: SHA, porcelain: "" },
      [aliasOther]: { head: SHA, porcelain: "" },
      [canonical]: { head: SHA, porcelain: "" },
    },
    lockfiles: {
      [path.join(aliasEnv, CANDIDATE_CORE_LOCKFILE_REL)]: LOCKFILE_V1,
      [path.join(aliasOther, CANDIDATE_CORE_LOCKFILE_REL)]: LOCKFILE_V1,
      [path.join(canonical, CANDIDATE_CORE_LOCKFILE_REL)]: LOCKFILE_V1,
    },
    realpath: (p) => {
      if (p === aliasEnv || p === aliasOther) return canonical;
      return path.resolve(p);
    },
  });
  const first = await resolveAndPrepareCandidateEngine(
    { repoDir: "/repo", candidateSha: SHA, candidateEngineRootEnv: aliasEnv },
    h.deps,
  );
  const second = await resolveAndPrepareCandidateEngine(
    { repoDir: "/repo", candidateSha: SHA, candidateEngineRootEnv: aliasOther },
    h.deps,
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(h.installs.length, 1, "aliases of one checkout must serialize on the canonical root");
  assert.equal(h.installs[0]?.cwd, path.join(canonical, "core"));
  if (first.ok) {
    assert.equal(first.engine.engineRoot, canonical);
    assert.equal(first.engine.launcherPath, path.join(canonical, "scripts/pipeline-launcher.mjs"));
  }
  if (second.ok) {
    assert.equal(second.engine.engineRoot, canonical);
    assert.equal(second.engine.launcherPath, path.join(canonical, "scripts/pipeline-launcher.mjs"));
  }
});

test("spawned launcher stays under the prepared canonical root after symlink retarget", async () => {
  const canonical = "/canonical/candidate";
  const lexical = "/aliases/env-root";
  const h = prepareHarness({
    roots: {
      "/repo": { head: OTHER, porcelain: "" },
      [lexical]: { head: SHA, porcelain: "" },
      [canonical]: { head: SHA, porcelain: "" },
    },
    lockfiles: {
      [path.join(lexical, CANDIDATE_CORE_LOCKFILE_REL)]: LOCKFILE_V1,
      [path.join(canonical, CANDIDATE_CORE_LOCKFILE_REL)]: LOCKFILE_V1,
    },
    realpath: (p) => (p === lexical ? canonical : path.resolve(p)),
  });
  const r = await resolveThenSpawn(h, { repoDir: "/repo", candidateEngineRootEnv: lexical });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.engine.engineRoot, canonical);
    assert.equal(r.engine.launcherPath, path.join(canonical, "scripts/pipeline-launcher.mjs"));
    assert.notEqual(r.engine.launcherPath, path.join(lexical, "scripts/pipeline-launcher.mjs"));
  }
  assert.equal(h.spawned[0]?.[1], path.join(canonical, "scripts/pipeline-launcher.mjs"));
});

test("porcelain mutation between resolve and bootstrap fails closed before install", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    porcelainAfterIdentity: " M core/scripts/pipeline.ts",
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "readiness");
    assert.match(r.error, /pre-bootstrap tracked porcelain is not empty/);
  }
  assert.equal(h.installs.length, 0);
  assert.equal(h.readyWrites.length, 0);
  assert.equal(h.spawned.length, 0);
});

test("SHA mutation between resolve and bootstrap fails closed before install", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    headAfterIdentity: OTHER,
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "readiness");
    assert.match(r.error, /pre-bootstrap HEAD/);
    assert.match(r.error, new RegExp(OTHER));
  }
  assert.equal(h.installs.length, 0);
  assert.equal(h.readyWrites.length, 0);
  assert.equal(h.spawned.length, 0);
});

test("pre-existing untrusted ready record does not skip install", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const readyPath = candidateReadyRecordPath(repo, SHA, "/tmp-state");
  const ready = JSON.stringify({
    schema: READY_RECORD_SCHEMA,
    engineRoot: repo,
    commitSha: SHA,
    lockfileDigest: DIGEST_V1,
  });
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    existingReady: `${ready}\n`,
    untrustedPaths: [readyPath],
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, false);
  assert.equal(h.installs.length, 1, "untrusted record must not skip nested-core install");
  assert.equal(h.spawned.length, 0, "untrusted final readiness proof must refuse spawn");
});

test("pre-existing untrusted setup lock is not treated as ownership", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const lockPath = candidateSetupLockPath(repo, SHA, "/tmp-state");
  const lockBody = JSON.stringify({
    schema: SETUP_LOCK_SCHEMA,
    engineRoot: repo,
    commitSha: SHA,
    parentPid: 111,
    parentStarttime: "parent-st",
    childPgid: 4242,
    childStarttime: "child-st",
    heartbeatAt: 9_999_999,
  });
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    existingLock: `${lockBody}\n`,
    untrustedPaths: [lockPath],
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "lock");
    assert.match(r.error, /untrusted/);
  }
  assert.equal(h.installs.length, 0);
  assert.equal(h.spawned.length, 0);
  assert.equal(h.readyWrites.length, 0);
  assert.equal(h.lockUnlinks.includes(lockPath), false, "must not unlink an untrusted lock path");
});

test("default readiness state dir is per-user private, not shared /tmp", () => {
  assert.equal(
    resolveCandidateReadinessStateDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/u"),
    "/run/user/1000/pipeline-candidate-readiness",
  );
  assert.equal(
    resolveCandidateReadinessStateDir({ AGENT_PIPELINE_STATE_HOME: "/state/home" }, "/home/u"),
    "/state/home/candidate-readiness",
  );
  assert.equal(
    resolveCandidateReadinessStateDir({ XDG_STATE_HOME: "/xdg/state" }, "/home/u"),
    "/xdg/state/agent-pipeline/candidate-readiness",
  );
  assert.equal(
    resolveCandidateReadinessStateDir({}, "/home/u"),
    "/home/u/.local/state/agent-pipeline/candidate-readiness",
  );
  assert.notEqual(resolveCandidateReadinessStateDir({}, "/home/u"), "/tmp");
});

test("abandoned ownership fails closed with path and process data", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const lockBody = JSON.stringify({
    schema: SETUP_LOCK_SCHEMA,
    engineRoot: repo,
    commitSha: SHA,
    parentPid: 111,
    parentStarttime: "parent-st",
    childPgid: 4242,
    childStarttime: "child-st",
    heartbeatAt: 1,
  });
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    existingLock: `${lockBody}\n`,
    vanishLockAfterRead: true,
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "lock");
    assert.match(r.error, /\/repo/);
    assert.match(r.error, /pid=111/);
    assert.match(r.error, /pgid=4242/);
    assert.match(r.error, /Retry only after/);
    assert.doesNotMatch(r.error, /needs-human|DecisionRequest|AuthorityRequest/);
  }
  assert.equal(h.spawned.length, 0);
  assert.equal(h.readyWrites.length, 0);
});

test("parent ESRCH with a possibly live child does not unlink the lock", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const lockPath = candidateSetupLockPath(repo, SHA, "/tmp-state");
  const lockBody = JSON.stringify({
    schema: SETUP_LOCK_SCHEMA,
    engineRoot: repo,
    commitSha: SHA,
    parentPid: 999,
    parentStarttime: "dead-parent",
    childPgid: 4242,
    childStarttime: "child-st",
    heartbeatAt: 1,
  });
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    existingLock: `${lockBody}\n`,
    parentAlive: false,
    childGroupAlive: true,
  });
  const r = await resolveThenSpawn(h, { repoDir: repo });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "lock");
    assert.match(r.error, /does not reclaim|possibly live installer child/);
    assert.match(r.error, /pid=999/);
  }
  assert.equal(h.lockUnlinks.includes(lockPath), false);
  assert.ok(h.files.has(lockPath));
  assert.equal(h.installs.length, 0);
  assert.equal(h.spawned.length, 0);
});

test("retry is refused while the prior process group remains and allowed once it is gone", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const lockBody = JSON.stringify({
    schema: SETUP_LOCK_SCHEMA,
    engineRoot: repo,
    commitSha: SHA,
    parentPid: 999,
    parentStarttime: "dead-parent",
    childPgid: 4242,
    childStarttime: "child-st",
    heartbeatAt: 1,
  });
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    existingLock: `${lockBody}\n`,
    parentAlive: false,
    childGroupAlive: true,
  });
  const refused = await resolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: SHA },
    h.deps,
  );
  assert.equal(refused.ok, false);
  assert.equal(h.installs.length, 0);
  h.setChildGroupAlive(false);
  const allowed = await resolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: SHA },
    h.deps,
  );
  assert.equal(allowed.ok, true);
  assert.equal(h.installs.length, 1);
});

test("owner death between startInstall and child-PGID publication does not reclaim", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const lockPath = candidateSetupLockPath(repo, SHA, "/tmp-state");
  let retryP: ReturnType<typeof resolveAndPrepareCandidateEngine> | undefined;
  let retryStarted = false;
  let h: ReturnType<typeof prepareHarness>;
  h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    onStartInstall: () => {
      if (retryStarted) return;
      retryStarted = true;
      const raw = h.files.get(lockPath);
      assert.ok(raw, "lock must exist before startInstall returns");
      const parsed = JSON.parse(raw!) as { childPgid: number | null };
      assert.equal(parsed.childPgid, null, "child identity is unpublished during startInstall");
      h.setOwnerParentAlive(false);
      retryP = resolveAndPrepareCandidateEngine({ repoDir: repo, candidateSha: SHA }, h.deps);
    },
  });
  const first = await resolveAndPrepareCandidateEngine({ repoDir: repo, candidateSha: SHA }, h.deps);
  assert.ok(retryP, "startInstall must observe the unpublished-child window");
  const retry = await retryP!;
  assert.equal(retry.ok, false);
  if (!retry.ok) {
    assert.equal(retry.kind, "lock");
    assert.match(retry.error, /missing installer child identity|unresolved ownership does not reclaim/);
    assert.match(retry.error, /pid=111/);
    assert.match(retry.error, /Retry only after/);
  }
  assert.equal(h.installs.length, 1, "retry must not start a second install while child identity is unpublished");
  assert.equal(first.ok, true);
});

test("locks and ready records are not stored inside the tracked candidate worktree", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
  });
  await resolveThenSpawn(h, { repoDir: repo });
  const lockPath = candidateSetupLockPath(repo, SHA, "/tmp-state");
  const readyPath = candidateReadyRecordPath(repo, SHA, "/tmp-state");
  assert.equal(lockPath.startsWith(repo), false);
  assert.equal(readyPath.startsWith(repo), false);
  assert.ok(h.files.has(readyPath));
});

test("readiness failures are not needs-human, DecisionRequest, or AuthorityRequest", async () => {
  const repo = "/repo";
  const lockfile = path.join(repo, CANDIDATE_CORE_LOCKFILE_REL);
  const h = prepareHarness({
    roots: { [repo]: { head: SHA, porcelain: "" } },
    lockfiles: { [lockfile]: LOCKFILE_V1 },
    installCode: 1,
  });
  const r = await resolveAndPrepareCandidateEngine(
    { repoDir: repo, candidateSha: SHA },
    h.deps,
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.doesNotMatch(r.error, /needs-human|generic blocked|DecisionRequest|AuthorityRequest|terminal mechanical/i);
    assert.match(r.error, /\/repo\/core/);
  }
  assert.equal(
    BLOCKER_KINDS.includes("candidate-setup-failed" as (typeof BLOCKER_KINDS)[number]),
    false,
    "must not add a new recover recipe kind",
  );
});

test("seam source does not call detectAndInstall or honor setup_command", () => {
  const readiness = fs.readFileSync(
    path.join(repoRoot, "core/scripts/candidate-engine-readiness.ts"),
    "utf8",
  );
  const seam = fs.readFileSync(path.join(repoRoot, "core/scripts/ship-end-candidate.ts"), "utf8");
  const factoryRelease = fs.readFileSync(
    path.join(repoRoot, "core/scripts/factory-release-prepare.ts"),
    "utf8",
  );
  assert.doesNotMatch(readiness, /detectAndInstall/);
  assert.doesNotMatch(readiness, /setup_command/);
  assert.doesNotMatch(seam, /detectAndInstall/);
  assert.match(seam, /resolveAndPrepareCandidateEngine/);
  assert.match(seam, /resolveCandidateEngine\(/);
  assert.match(factoryRelease, /resolveAndPrepareCandidateEngine/);
  assert.doesNotMatch(factoryRelease, /defaultResolveCandidateEngineDeps/);
});

test("default state writes refuse shared /tmp and follow no attacker entries", () => {
  const readiness = fs.readFileSync(
    path.join(repoRoot, "core/scripts/candidate-engine-readiness.ts"),
    "utf8",
  );
  assert.doesNotMatch(readiness, /tmpDir:\s*\(\)\s*=>\s*"\/tmp"/);
  assert.match(readiness, /O_NOFOLLOW/);
  assert.match(readiness, /0o600/);
  assert.match(readiness, /0o700/);
  assert.match(readiness, /resolveCandidateReadinessStateDir/);
});

test("launcher does not self-heal missing candidate node_modules", () => {
  const launcher = fs.readFileSync(path.join(repoRoot, "scripts/pipeline-launcher.mjs"), "utf8");
  assert.match(launcher, /runtime dependencies not found/);
  assert.doesNotMatch(launcher, /npm ci/);
  assert.doesNotMatch(launcher, /spawnSync\(\s*["']npm["']/);
  assert.match(launcher, /command-time provisioning is never attempted/);
});

test("no new pipeline CLI verb for candidate setup", () => {
  const registry = fs.readFileSync(path.join(repoRoot, "core/scripts/command-registry.ts"), "utf8");
  const pipeline = fs.readFileSync(path.join(repoRoot, "core/scripts/pipeline.ts"), "utf8");
  assert.doesNotMatch(registry, /resolve-and-prepare|candidate-setup|candidate-prepare/);
  assert.doesNotMatch(pipeline, /"resolve-and-prepare"|case "candidate-setup"/);
});

test("CONTEXT.md keeps candidate-engine-root, candidate-readiness, and resolve-and-prepare", () => {
  const context = fs.readFileSync(path.join(repoRoot, "CONTEXT.md"), "utf8");
  assert.match(context, /\*\*Candidate-engine root\*\*:/);
  assert.match(context, /\*\*Candidate readiness\*\*:/);
  assert.match(context, /\*\*Resolve-and-prepare\*\*:/);
});

test("operator-facing ship docs state spawn-after-ready (#1344)", () => {
  const ship = fs.readFileSync(path.join(repoRoot, "docs/runbooks/ship-milestone.md"), "utf8");
  const supervisor = fs.readFileSync(path.join(repoRoot, "docs/supervisor.md"), "utf8");
  for (const [name, text] of [
    ["ship-milestone", ship],
    ["supervisor", supervisor],
  ] as const) {
    assert.match(text, /made runnable[\s\S]{0,20}before spawn/, `${name} must state spawn-after-ready`);
    assert.match(text, /SHA plus nested/, `${name} must state SHA plus nested lockfile digest`);
    assert.match(text, /candidate-local/, `${name} must state candidate-local recovery`);
  }
});
