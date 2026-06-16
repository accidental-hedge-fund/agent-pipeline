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
import {
  spawnDetached,
  writeSentinel,
  issueRunsDir,
  lockFilePath,
  makeRunDir,
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

/** Build a SpawnDetachedDeps that captures spawn args and uses a tmp home dir. */
function makeTestDeps(homeDir: string) {
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  let nextPid = 9999;

  const deps: SpawnDetachedDeps & { calls: typeof calls } = {
    homedir: () => homeDir,
    now: () => 1_700_000_000_000,
    spawn(cmd, args, opts) {
      calls.push({ cmd, args, opts: opts as Record<string, unknown> });
      const child = fakeChild(nextPid++);
      // Simulate immediate fd close so openSync logFd is closed
      return child as unknown as ReturnType<(typeof deps)["spawn"]>;
    },
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

test("spawnDetached: throws when advisory lock is already held by a live process", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    // Pre-create the lock file with the current process PID (guaranteed alive).
    const lp = lockFilePath(home, 42);
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, String(process.pid));

    await assert.rejects(
      () => spawnDetached(42, [], { flockTimeoutMs: 100 }, deps),
      /already running/,
    );
  } finally {
    cleanup(home);
  }
});

test("spawnDetached: wrapper argv includes --lock-pre-acquired", async () => {
  const home = makeTmpDir();
  try {
    const deps = makeTestDeps(home);
    await spawnDetached(42, [], {}, deps);
    const args = deps.calls[0].args;
    assert.ok(args.includes("--lock-pre-acquired"), "missing --lock-pre-acquired flag");
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
