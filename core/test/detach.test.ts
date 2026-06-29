// Tests for core/scripts/detach.ts (#153).
//
// Covers:
//   1. spawnDetached: spawn called with detached:true + correct stdio wiring
//   2. writeSentinel: atomic tmp→rename write
//   3. Path helpers: issueRunsDir, lockFilePath, makeRunDir
//   4. Regression: pipeline run without --detach does not call spawnDetached
//   5. Regression: pipeline --version is unaffected by detach module import

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  spawnDetached,
  writeSentinel,
  issueRunsDir,
  lockFilePath,
  makeRunDir,
  parseProcTable,
  descendantProcessGroups,
  killProcessTree,
  type SpawnDetachedDeps,
  type SentinelData,
} from "../scripts/detach.ts";
import { buildCmd, handleRunSubcommand, type RunSubcommandDeps } from "../scripts/pipeline.ts";
import type { CliOpts } from "../scripts/pipeline.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "detach-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Minimal fake ChildProcess returned by the mocked spawn. */
function fakeChild(pid = 12345) {
  const ev = new EventEmitter();
  return Object.assign(ev, {
    pid,
    unref() {},
  });
}

const FIXED_PID = 42;       // deterministic PID for test run-dir names
const FIXED_NOW = 1_700_000_000_000; // deterministic timestamp

/** Build a SpawnDetachedDeps that captures spawn args and uses a tmp home dir. */
function makeTestDeps(homeDir: string) {
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  let nextPid = 9999;

  const deps: SpawnDetachedDeps & { calls: typeof calls } = {
    homedir: () => homeDir,
    now: () => FIXED_NOW,
    pid: () => FIXED_PID,
    spawn(cmd, args, opts) {
      calls.push({ cmd, args, opts: opts as Record<string, unknown> });
      const child = fakeChild(nextPid++);
      // Simulate immediate fd close so openSync logFd is closed
      return child as unknown as ReturnType<(typeof deps)["spawn"]>;
    },
    // Default: the wrapper acquired the lock — no real wrapper runs in unit tests.
    awaitLockHandshake: async () => ({ acquired: true }),
    calls,
  };
  return deps;
}

// ---------------------------------------------------------------------------
// 1. Path helpers
// ---------------------------------------------------------------------------

test("issueRunsDir: returns ~/.pipeline/runs/<issue>", () => {
  assert.equal(issueRunsDir("/home/alice", 42), "/home/alice/.pipeline/runs/42");
});

test("lockFilePath: is inside issueRunsDir", () => {
  const lp = lockFilePath("/home/alice", 42);
  assert.equal(lp, "/home/alice/.pipeline/runs/42/.lock");
  assert.ok(lp.startsWith(issueRunsDir("/home/alice", 42)));
});

test("makeRunDir: is inside issueRunsDir with timestamp", () => {
  const rd = makeRunDir("/home/alice", 42, "2024-01-01_00-00-00");
  assert.equal(rd, "/home/alice/.pipeline/runs/42/2024-01-01_00-00-00");
  assert.ok(rd.startsWith(issueRunsDir("/home/alice", 42)));
});

// ---------------------------------------------------------------------------
// 2. writeSentinel — atomic tmp→rename
// ---------------------------------------------------------------------------

test("writeSentinel: creates sentinel.json atomically (tmp not present after write)", () => {
  const dir = makeTmpDir();
  try {
    const data: SentinelData = {
      exitCode: 0,
      durationMs: 123,
      completedAt: "2024-01-01T00:00:00Z",
    };
    writeSentinel(dir, data);

    const sentinel = JSON.parse(fs.readFileSync(path.join(dir, "sentinel.json"), "utf8")) as SentinelData;
    assert.equal(sentinel.exitCode, 0);
    assert.equal(sentinel.durationMs, 123);
    assert.equal(sentinel.completedAt, "2024-01-01T00:00:00Z");
    assert.equal(sentinel.timedOut, undefined);

    // tmp file must be gone (rename is atomic)
    assert.ok(!fs.existsSync(path.join(dir, "sentinel.tmp")));
  } finally {
    cleanup(dir);
  }
});

test("writeSentinel: timedOut field present when set", () => {
  const dir = makeTmpDir();
  try {
    writeSentinel(dir, {
      exitCode: -1,
      durationMs: 300000,
      completedAt: "2024-01-01T00:05:00Z",
      timedOut: true,
    });
    const sentinel = JSON.parse(
      fs.readFileSync(path.join(dir, "sentinel.json"), "utf8"),
    ) as SentinelData;
    assert.equal(sentinel.exitCode, -1);
    assert.equal(sentinel.timedOut, true);
  } finally {
    cleanup(dir);
  }
});

test("writeSentinel: non-zero exit code for failure path", () => {
  const dir = makeTmpDir();
  try {
    writeSentinel(dir, { exitCode: 1, durationMs: 50, completedAt: "2024-01-01T00:00:00Z" });
    const sentinel = JSON.parse(
      fs.readFileSync(path.join(dir, "sentinel.json"), "utf8"),
    ) as SentinelData;
    assert.equal(sentinel.exitCode, 1);
    assert.equal(sentinel.timedOut, undefined);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 3. spawnDetached — detached:true, stdio wiring, run-dir creation
// ---------------------------------------------------------------------------

test("spawnDetached: calls spawn with detached:true", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    await spawnDetached(7, [], {}, deps);
    assert.equal(deps.calls.length, 1);
    assert.equal(deps.calls[0].opts["detached"], true);
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: stdio[0] is 'ignore'", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    await spawnDetached(7, [], {}, deps);
    const stdio = deps.calls[0].opts["stdio"] as unknown[];
    assert.equal(stdio[0], "ignore");
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: stdio[1] and stdio[2] are file descriptors (numbers)", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    await spawnDetached(7, [], {}, deps);
    const stdio = deps.calls[0].opts["stdio"] as unknown[];
    assert.equal(typeof stdio[1], "number");
    assert.equal(typeof stdio[2], "number");
    assert.equal(stdio[1], stdio[2]); // same log fd
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: creates the run directory", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    const result = await spawnDetached(7, [], {}, deps);
    assert.ok(fs.existsSync(result.runDir), `run dir missing: ${result.runDir}`);
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: run dir is inside issueRunsDir", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    const result = await spawnDetached(7, [], {}, deps);
    assert.ok(result.runDir.startsWith(issueRunsDir(home, 7)));
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: returns the child PID", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    const result = await spawnDetached(7, [], {}, deps);
    assert.equal(typeof result.pid, "number");
    assert.ok(result.pid > 0);
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: wrapper argv includes --issue, --run-dir, _wrapper", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    await spawnDetached(42, [], {}, deps);
    const args = deps.calls[0].args;
    assert.ok(args.includes("_wrapper"), "missing _wrapper token");
    assert.ok(args.includes("--issue"), "missing --issue flag");
    assert.ok(args.includes("42"), "missing issue number");
    assert.ok(args.includes("--run-dir"), "missing --run-dir flag");
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: --timeout forwarded when provided", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    await spawnDetached(42, [], { timeout: 300 }, deps);
    const args = deps.calls[0].args;
    assert.ok(args.includes("--timeout"), "missing --timeout");
    assert.ok(args.includes("300"), "missing timeout value");
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: no --timeout in wrapper args when not provided", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    await spawnDetached(42, [], {}, deps);
    const args = deps.calls[0].args;
    assert.ok(!args.includes("--timeout"), "unexpected --timeout");
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: flock-timeout forwarded with custom value", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    await spawnDetached(42, [], { flockTimeoutMs: 8000 }, deps);
    const args = deps.calls[0].args;
    assert.ok(args.includes("--flock-timeout"), "missing --flock-timeout");
    assert.ok(args.includes("8000"), "missing flock-timeout value");
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: creates pipeline.log file in run dir", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    const result = await spawnDetached(7, [], {}, deps);
    const logPath = path.join(result.runDir, "pipeline.log");
    assert.ok(fs.existsSync(logPath), `log file missing: ${logPath}`);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 4. Regression: pipeline run without --detach does NOT call spawnDetached
// ---------------------------------------------------------------------------

test("handleRunSubcommand: --detach=false does not call spawnDetached", async () => {
  let spawnCalled = false;
  const deps: RunSubcommandDeps = {
    spawnDetached: async () => {
      spawnCalled = true;
      return { runDir: "/tmp/x", pid: 1 };
    },
  };

  const origExitCode = process.exitCode;
  try {
    const opts: CliOpts = { profile: "codex" };
    // Pass an invalid issue number so the non-detach path errors out early
    // (no real gh calls in unit tests).
    await handleRunSubcommand("not-a-number", opts, deps);
    assert.equal(spawnCalled, false, "spawnDetached must not be called without --detach");
  } finally {
    process.exitCode = origExitCode;
  }
});

test("handleRunSubcommand: detach=true calls spawnDetached with the issue number", async () => {
  const called: number[] = [];
  const deps: RunSubcommandDeps = {
    spawnDetached: async (issue) => {
      called.push(issue);
      return { runDir: "/tmp/fake-run", pid: 42 };
    },
  };
  const opts: CliOpts = { detach: true, profile: "codex" };
  await handleRunSubcommand("99", opts, deps);
  assert.deepEqual(called, [99]);
});

test("handleRunSubcommand: detach=true prints runDir to stdout", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (msg: string) => logged.push(msg));

  const deps: RunSubcommandDeps = {
    spawnDetached: async () => ({ runDir: "/tmp/my-run-dir", pid: 1 }),
  };
  const opts: CliOpts = { detach: true, profile: "codex" };
  await handleRunSubcommand("10", opts, deps);

  assert.ok(logged.some((l) => l.includes("/tmp/my-run-dir")), `runDir not printed; got: ${JSON.stringify(logged)}`);
});

test("handleRunSubcommand: missing number exits with code 2 without calling spawnDetached", async () => {
  let spawnCalled = false;
  const deps: RunSubcommandDeps = {
    spawnDetached: async () => { spawnCalled = true; return { runDir: "", pid: 0 }; },
  };
  const savedExitCode = process.exitCode;
  process.exitCode = undefined; // clear before the call so we can detect the change
  try {
    await handleRunSubcommand("", { detach: true }, deps);
    assert.equal(process.exitCode, 2);
    assert.equal(spawnCalled, false);
  } finally {
    process.exitCode = savedExitCode; // always restore, even when original was undefined
  }
});

// ---------------------------------------------------------------------------
// 5. Lock acquired in foreground (Finding: concurrent detach must fail fast)
// ---------------------------------------------------------------------------


// #153 lock-handoff race fix: the launcher must NOT pre-acquire and transfer the
// lock (a launcher death between spawn and transfer strands it on a dead PID).
// The wrapper acquires the lock itself, so the flag is gone.
test("spawnDetached: wrapper argv does NOT include --lock-pre-acquired (wrapper acquires the lock)", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    await spawnDetached(42, [], {}, deps);
    const args = deps.calls[0].args;
    assert.ok(!args.includes("--lock-pre-acquired"), "launcher must not pre-acquire/transfer the lock");
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: does not create the lock file itself (wrapper owns the lock)", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    await spawnDetached(42, [], {}, deps);
    // The launcher no longer writes the per-issue lock; the wrapper does.
    assert.ok(!fs.existsSync(lockFilePath(home, 42)), "launcher must not write the lock file");
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: rejects when the wrapper reports the lock is already held (handshake fail)", async () => {
  const home = makeTmpDir();
  try {
    const deps = { ...makeTestDeps(home), awaitLockHandshake: async () => ({ acquired: false, holder: "4321" }) };
    await assert.rejects(
      () => spawnDetached(42, [], {}, deps),
      /already running \(held by PID 4321\)/,
    );
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: waits for the handshake in the child's run dir", async () => {
  const home = makeTmpDir();
  try {
    let seenRunDir = "";
    const base = makeTestDeps(home);
    const deps = {
      ...base,
      awaitLockHandshake: async (runDir: string) => {
        seenRunDir = runDir;
        return { acquired: true };
      },
    };
    const result = await spawnDetached(42, [], {}, deps);
    assert.equal(seenRunDir, result.runDir, "launcher must wait on the spawned run dir's handshake");
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 6. Option forwarding (Finding: --profile/--domain/--model must reach inner process)
// ---------------------------------------------------------------------------

test("handleRunSubcommand: detach forwards --profile, --domain, --model to spawnDetached", async () => {
  let capturedArgs: string[] = [];
  const deps: RunSubcommandDeps = {
    spawnDetached: async (_issue, pipelineArgs) => {
      capturedArgs = pipelineArgs;
      return { runDir: "/tmp/fake-run", pid: 42 };
    },
  };
  const opts: CliOpts = { detach: true, profile: "claude", domain: "mydom", model: "claude-opus-4-8" };
  await handleRunSubcommand("99", opts, deps);
  assert.ok(capturedArgs.includes("--profile"), "missing --profile");
  assert.ok(capturedArgs.includes("claude"), "missing profile value");
  assert.ok(capturedArgs.includes("--domain"), "missing --domain");
  assert.ok(capturedArgs.includes("mydom"), "missing domain value");
  assert.ok(capturedArgs.includes("--model"), "missing --model");
  assert.ok(capturedArgs.includes("claude-opus-4-8"), "missing model value");
});

// #155: a detached launch must pin the #155 run-store run id (so the caller can
// find the same .agent-pipeline/runs/<run-id>/events.jsonl) and forward --json-events.
test("handleRunSubcommand: detach forwards --run-id (always) so the inner run shares the caller's run dir", async () => {
  let capturedArgs: string[] = [];
  const deps: RunSubcommandDeps = {
    spawnDetached: async (_issue, pipelineArgs) => {
      capturedArgs = pipelineArgs;
      return { runDir: "/tmp/fake-run", pid: 42 };
    },
  };
  await handleRunSubcommand("99", { detach: true }, deps);
  const idx = capturedArgs.indexOf("--run-id");
  assert.ok(idx >= 0, `--run-id must be forwarded; got ${JSON.stringify(capturedArgs)}`);
  const runId = capturedArgs[idx + 1];
  assert.match(runId ?? "", /^99-/, "the pinned run id must be for issue 99");
});

test("handleRunSubcommand: detach forwards --json-events only when requested", async () => {
  const capture = async (opts: CliOpts) => {
    let captured: string[] = [];
    await handleRunSubcommand("99", opts, {
      spawnDetached: async (_issue, pipelineArgs) => {
        captured = pipelineArgs;
        return { runDir: "/tmp/fake-run", pid: 42 };
      },
    });
    return captured;
  };
  assert.ok((await capture({ detach: true, jsonEvents: true })).includes("--json-events"), "must forward --json-events when set");
  assert.ok(!(await capture({ detach: true })).includes("--json-events"), "must not inject --json-events when unset");
});

test("handleRunSubcommand: detach writes a machine-readable run-store.json pointer in the wrapper dir (#155)", async () => {
  const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-"));
  try {
    await handleRunSubcommand("99", { detach: true }, {
      spawnDetached: async () => ({ runDir: wrapperDir, pid: 42 }),
    });
    // A caller captures the wrapper dir from stdout, then reads the pointer — no
    // prose parsing — to find the #155 run store and its events.jsonl/terminal.log.
    const pointerPath = path.join(wrapperDir, "run-store.json");
    assert.ok(fs.existsSync(pointerPath), "wrapper dir must contain run-store.json");
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    assert.match(pointer.run_store_run_id, /^99-/, "pointer must carry the #155 run id for issue 99");
    assert.ok(String(pointer.run_store_dir).includes(".agent-pipeline"), "run_store_dir must be the .agent-pipeline run store");
    assert.ok(String(pointer.events).endsWith("events.jsonl"), "pointer must link to events.jsonl");
    assert.ok(String(pointer.terminal_log).endsWith("terminal.log"), "pointer must link to terminal.log");
  } finally {
    fs.rmSync(wrapperDir, { recursive: true, force: true });
  }
});

test("handleRunSubcommand: detach pointer resolves a nested --repo-path to the repo ROOT (#155)", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  const nested = path.join(repoRoot, "pkgs", "sub");
  fs.mkdirSync(nested, { recursive: true });
  const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-"));
  try {
    // Pass a checkout SUBDIRECTORY as --repo-path. The inner run resolves it to the
    // git root via findGitRoot, so the pointer must too — else it points at
    // <subdir>/.agent-pipeline while the run writes <root>/.agent-pipeline.
    await handleRunSubcommand("99", { detach: true, repoPath: nested }, {
      spawnDetached: async () => ({ runDir: wrapperDir, pid: 42 }),
    });
    const pointer = JSON.parse(fs.readFileSync(path.join(wrapperDir, "run-store.json"), "utf8"));
    assert.ok(
      String(pointer.run_store_dir).startsWith(path.join(repoRoot, ".agent-pipeline")),
      `pointer must resolve to <repoRoot>/.agent-pipeline; got ${pointer.run_store_dir}`,
    );
    assert.ok(
      !String(pointer.run_store_dir).includes(path.join("pkgs", "sub")),
      `pointer must not use the nested subdir; got ${pointer.run_store_dir}`,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(wrapperDir, { recursive: true, force: true });
  }
});

test("handleRunSubcommand: detach forwards --repo-path and --base to spawnDetached", async () => {
  let capturedArgs: string[] = [];
  const deps: RunSubcommandDeps = {
    spawnDetached: async (_issue, pipelineArgs) => {
      capturedArgs = pipelineArgs;
      return { runDir: "/tmp/fake-run", pid: 42 };
    },
  };
  const opts: CliOpts = { detach: true, repoPath: "/path/to/repo", base: "main" };
  await handleRunSubcommand("99", opts, deps);
  assert.ok(capturedArgs.includes("--repo-path"), "missing --repo-path");
  assert.ok(capturedArgs.includes("/path/to/repo"), "missing repoPath value");
  assert.ok(capturedArgs.includes("--base"), "missing --base");
  assert.ok(capturedArgs.includes("main"), "missing base value");
});

// Review-2 finding (#153): detached launch must not drop no-write / lifecycle
// flags. `pipeline run <N> --detach --dry-run` previously started a REAL advance
// (mutating GitHub/worktree) because --dry-run/--once/--doctor/--fail-fast were
// omitted from the forwarded args.
test("handleRunSubcommand: detach forwards --dry-run so a detached dry-run stays read-only", async () => {
  let capturedArgs: string[] = [];
  const deps: RunSubcommandDeps = {
    spawnDetached: async (_issue, pipelineArgs) => {
      capturedArgs = pipelineArgs;
      return { runDir: "/tmp/fake-run", pid: 42 };
    },
  };
  await handleRunSubcommand("99", { detach: true, dryRun: true }, deps);
  assert.ok(capturedArgs.includes("--dry-run"), `--dry-run must reach the inner process; got ${JSON.stringify(capturedArgs)}`);
});

test("handleRunSubcommand: detach forwards --once / --doctor / --fail-fast lifecycle flags", async () => {
  let capturedArgs: string[] = [];
  const deps: RunSubcommandDeps = {
    spawnDetached: async (_issue, pipelineArgs) => {
      capturedArgs = pipelineArgs;
      return { runDir: "/tmp/fake-run", pid: 42 };
    },
  };
  await handleRunSubcommand("99", { detach: true, once: true, doctor: true, failFast: true }, deps);
  assert.ok(capturedArgs.includes("--once"), "missing --once");
  assert.ok(capturedArgs.includes("--doctor"), "missing --doctor");
  assert.ok(capturedArgs.includes("--fail-fast"), "missing --fail-fast");
});

test("handleRunSubcommand: detach omits no-write flags when the caller did not set them", async () => {
  let capturedArgs: string[] = [];
  const deps: RunSubcommandDeps = {
    spawnDetached: async (_issue, pipelineArgs) => {
      capturedArgs = pipelineArgs;
      return { runDir: "/tmp/fake-run", pid: 42 };
    },
  };
  await handleRunSubcommand("99", { detach: true, profile: "codex" }, deps);
  assert.ok(!capturedArgs.includes("--dry-run"), "must not inject --dry-run when not requested");
  assert.ok(!capturedArgs.includes("--once"), "must not inject --once when not requested");
});

// ---------------------------------------------------------------------------
// 7. CLI parser: 'pipeline run 153 --detach' is accepted (Finding: too-many-args)
// ---------------------------------------------------------------------------

test("CLI parser: 'pipeline run 153 --detach' is accepted without excess-args rejection", () => {
  const cmd = buildCmd();
  // Should not throw — allowExcessArguments(true) permits 'run' + '153' as two positionals.
  assert.doesNotThrow(() => {
    cmd.parse(["node", "pipeline.ts", "run", "153", "--detach"]);
  });
  assert.equal(cmd.args[0], "run");
  assert.equal(cmd.args[1], "153");
  assert.equal(cmd.opts<CliOpts>().detach, true);
});

test("CLI parser: 'pipeline path --json' is accepted without excess-args rejection", () => {
  const cmd = buildCmd();
  assert.doesNotThrow(() => {
    cmd.parse(["node", "pipeline.ts", "path", "--json"]);
  });
  assert.equal(cmd.args[0], "path");
  assert.equal(cmd.opts<CliOpts>().json, true);
});

// ---------------------------------------------------------------------------
// 8. Collision-proof run directories (Finding 3: run dirs must not collide)
// ---------------------------------------------------------------------------

test("spawnDetached: run dir name includes milliseconds and PID suffix", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    const result = await spawnDetached(7, [], {}, deps);
    const dirName = path.basename(result.runDir);
    // Millisecond precision: format is YYYY-MM-DD_HH-mm-ss-mmm-p<pid>
    assert.match(dirName, /-p\d+$/, "run dir must end with -p<pid>");
    // Fixed now=1_700_000_000_000 has ms part 000; fixed pid=42
    assert.ok(dirName.includes("-p42"), `expected pid suffix -p42 in ${dirName}`);
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: throws when run dir already has sentinel.json (collision guard)", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    // First call succeeds and creates the run dir.
    const result = await spawnDetached(7, [], {}, deps);
    // Place a sentinel.json into that run dir to simulate a prior run.
    fs.writeFileSync(path.join(result.runDir, "sentinel.json"), JSON.stringify({ exitCode: 0 }));
    // Second call with the same deps (same timestamp + same pid) must throw.
    await assert.rejects(
      () => spawnDetached(7, [], {}, deps),
      /collision|sentinel/i,
    );
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 9. Timeout watchdog kills the full process TREE, not just the wrapper group
//    (Review-2 finding #153): pipeline steps spawn detached child groups
//    (worktree-setup.ts, harness.ts), which a bare kill(-wrapperPid) leaves
//    running after the timeout sentinel. The watchdog must cover those groups.
// ---------------------------------------------------------------------------

test("parseProcTable: parses `ps` pid/ppid/pgid rows, ignoring junk", () => {
  const out = "  100   1   100\n 200 100 200\nheader junk\n 201 200 200\n";
  const rows = parseProcTable(out);
  assert.deepEqual(rows, [
    { pid: 100, ppid: 1, pgid: 100 },
    { pid: 200, ppid: 100, pgid: 200 },
    { pid: 201, ppid: 200, pgid: 200 },
  ]);
});

test("descendantProcessGroups: includes detached child groups, not just the root group", () => {
  // wrapper(pid100,pgid100) → inner(pid200,pgid100) → detached harness(pid300,pgid300)
  //                                                  → detached setup (pid400,pgid400)
  // An unrelated process (pid500,pgid500) must NOT be included.
  const table = [
    { pid: 100, ppid: 1, pgid: 100 },
    { pid: 200, ppid: 100, pgid: 100 },
    { pid: 300, ppid: 200, pgid: 300 },
    { pid: 400, ppid: 200, pgid: 400 },
    { pid: 500, ppid: 1, pgid: 500 },
  ];
  const groups = descendantProcessGroups(table, 100).sort((a, b) => a - b);
  assert.deepEqual(groups, [100, 300, 400], "must cover wrapper + both detached child groups, exclude unrelated");
});

test("killProcessTree: signals every descendant group, ending with the wrapper's own group", () => {
  const table =
    " 100 1 100\n 200 100 100\n 300 200 300\n 400 200 400\n";
  const killed: number[] = [];
  const order = killProcessTree(100, "SIGKILL", {
    snapshot: () => table,
    killGroup: (pgid) => killed.push(pgid),
  });
  assert.deepEqual([...killed].sort((a, b) => a - b), [100, 300, 400]);
  // The wrapper's own group (100) must be signalled LAST (killing it ends self).
  assert.equal(order[order.length - 1], 100, "wrapper group must be killed last");
});

test("killProcessTree: falls back to the root group when the ps snapshot is empty", () => {
  const killed: number[] = [];
  killProcessTree(777, "SIGKILL", { snapshot: () => "", killGroup: (pgid) => killed.push(pgid) });
  assert.deepEqual(killed, [777], "empty snapshot must still terminate the wrapper group");
});

// #156 review-2: a malformed detached run must be rejected before it starts.
// The post-dispatch excess-args guard never runs on the --detach path (it returns
// first), so `pipeline run <N> extra --detach` must be rejected inside the run
// branch. CLI spawn test (no gh / repo needed — the guard exits before resolveConfig).
const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));

test("CLI: `pipeline run 123 extra --detach` rejects extra positionals (exit 2, no detached run)", () => {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "run", "123", "extra", "--detach"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 2, `expected exit 2; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /unexpected argument/i);
});

test("CLI: `pipeline run 123 extra` (non-detach) also rejects extra positionals (exit 2)", () => {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "run", "123", "extra"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 2, `expected exit 2; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /unexpected argument/i);
});

// ---------------------------------------------------------------------------
// Finding 3 (#273 review-1): `pipeline N --detach` must not run before extra-args
// guard or before legacy mode-selector flag checks.
// ---------------------------------------------------------------------------

test("CLI: `pipeline 42 config validate --detach` rejects extra positionals (exit 2)", () => {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "42", "config", "validate", "--detach"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 2, `expected exit 2; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /unexpected argument/i);
});

test("CLI: `pipeline 42 --status --detach` rejects incompatible mode flag (exit 2)", () => {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "42", "--status", "--detach"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 2, `expected exit 2; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /--detach cannot be combined/i);
});
