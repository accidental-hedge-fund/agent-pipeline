## Context

Pipeline Desk runs `agent-pipeline` as a supervised child process in a desktop app shell. Two problems block this today:

1. **Lifetime**: when the launching process exits (user closes a terminal, harness times out, the app is backgrounded), any in-flight `pipeline run` inherits the process group and receives the parent's `SIGTERM` — killing the run mid-issue.
2. **Discovery**: Pipeline Desk must know which host CLIs are installed (`claude`, `codex`, neither, both) to set a sane default and surface missing-install errors before launching. There is no machine-readable probe today; `pipeline --version` answers "is it installed?" but not "which hosts are available?"

The existing `cli-version-flag` and `cross-host-profiles` specs cover `--version` and profile selection; this design introduces two adjacent capabilities without modifying their contracts.

## Goals / Non-Goals

**Goals:**
- `pipeline run <issue> --detach`: launch a run that survives the launcher's exit via process-group escape.
- Advisory flock serializes concurrent launches for the same issue number.
- `--timeout <seconds>` watchdog kills a hung detached run and writes a non-zero-exit sentinel.
- Completion sentinel written atomically to the run dir on every exit path (success, failure, watchdog, signal) so a poller can classify running/done/crashed without parsing prose output.
- `pipeline path [--json]`: probe known install locations, enumerate host coverage in four states (missing / Claude-only / Codex-only / both), and print core path + version.

**Non-Goals:**
- No daemon process. No persistent server. Filesystem + subprocess only.
- No moving prompt or state-machine logic into the desktop app.
- No Windows support in this change (macOS/Linux `setsid` only; a follow-up can add a Windows shim).
- No IPC channel between the desktop and the detached process beyond the run directory on disk.

## Decisions

### 1. Process-group escape via `setsid` (not `nohup`)

`nohup` only redirects `SIGHUP`; `disown` is a shell builtin unavailable in subprocess contexts. `setsid` creates a new session and detaches from the controlling terminal — the child process group is orphaned from the parent, so `SIGTERM` on the parent does not propagate. On macOS, `setsid` is available via `/usr/bin/setsid` (macOS 12+) and via the Node.js `child_process.spawn` `detached: true` + `unref()` combination. We use the Node.js API (`detached: true`, `stdio: ['ignore', fd, fd]`, `proc.unref()`) so the implementation stays in-process without shelling out to `/usr/bin/setsid`.

**Alternative considered**: double-fork (fork → fork → exit middle). Works but requires a native addon or a helper script; the Node.js `detached` flag achieves the same isolation without native code.

### 2. Advisory flock via a per-issue lock file

The run directory (`~/.pipeline/runs/<issue>/`) gets a `.lock` file held by the detached process for its lifetime. A second `--detach` call for the same issue attempts the flock with a short deadline (`--flock-timeout`, default 5 s). If the flock is not acquired, the command exits non-zero with a clear message: `issue <N> is already running`. This is advisory — a caller that ignores the exit code races, but that is acceptable (same semantics as `flock(1)`).

**Alternative considered**: a PID file with kill-signal probe. More complex to make race-free; flock avoids TOCTOU.

### 3. Completion sentinel written atomically via tmp + rename

On every exit path (normal return, uncaught exception, `SIGTERM` from watchdog), the detached process writes `<run-dir>/sentinel.json` by:
1. Writing to `<run-dir>/sentinel.tmp`.
2. `fs.renameSync` to `sentinel.json`.

This makes the sentinel appear atomically; a poller that sees `sentinel.json` can read it safely. The sentinel contains `{ exitCode, durationMs, completedAt }`.

**Alternative considered**: appending to a log file with a magic trailer. Polling requires parsing; rename is O(1) and parser-free.

### 4. Watchdog via `setTimeout` + `SIGKILL`

A `--timeout <seconds>` option (no default = no watchdog; Pipeline Desk should pass one) starts a `setTimeout` inside the detached process. On expiry, it sends `SIGKILL` to the entire process group, then writes a sentinel with `exitCode: -1` and `timedOut: true`. `SIGKILL` is used (not `SIGTERM`) because a hung harness subprocess may be ignoring `SIGTERM`.

### 5. Host discovery via probing known install paths

`pipeline path` probes, in order: npm global bin (`npm root -g`), `~/.claude/skills/pipeline/` (Claude skill install), `~/.codex/skills/pipeline/` (Codex skill install), and `./node_modules/.bin/pipeline` (local dev). For each probe location, it checks whether the associated host CLI (`claude`, `codex`) is reachable via `which`. This determines the four coverage states:
- **missing**: no `pipeline` binary found at any probe location.
- **claude-only**: core found, `claude` CLI reachable, `codex` not.
- **codex-only**: core found, `codex` CLI reachable, `claude` not.
- **both**: core found, both CLIs reachable.

**Alternative considered**: reading `~/.claude/package.json` / `~/.codex/package.json` for install metadata. Fragile across installs; `which` is the actual runtime availability check.

### 6. JSON output contract for `pipeline path --json`

```jsonc
{
  "corePath": "/Users/alice/.claude/skills/pipeline/core",
  "version": "1.4.0",
  "hostCoverage": "both",          // "missing" | "claude-only" | "codex-only" | "both"
  "hosts": {
    "claude": { "available": true, "cliBin": "/usr/local/bin/claude" },
    "codex":  { "available": true, "cliBin": "/usr/local/bin/codex" }
  }
}
```

Exit code 0 on any resolved state (including `missing`). The caller inspects `hostCoverage` to decide whether to surface an install prompt. Exit code non-zero only on a probe error (e.g., `npm root -g` fails).

## Risks / Trade-offs

- **`detached: true` + `unref()` may not fully isolate on some CI environments** where the process manager forcibly kills all descendants. Mitigation: document the behavior; for CI use the non-detach path.
- **Advisory flock allows races if the caller ignores the exit code.** Mitigation: the non-zero exit and stderr message are the primary guard; the per-issue state machine lock (planned for a follow-up issue) is the deeper serializer.
- **Discovery probe paths are heuristic and may miss unusual installs.** Mitigation: `pipeline path --json` includes `corePath` so integrators can validate; `hostCoverage: "missing"` is the safe fallback (surfaces an install prompt rather than silently failing).
- **Sentinel rename is not atomic across filesystems (NFS, some Docker volumes).** Mitigation: pipeline runs are always local; cross-filesystem home directories are out of scope.

## Open Questions

- Should `--flock-timeout` be configurable per-run or only via CLI flag? (Current: CLI flag, default 5 s.)
- Does Pipeline Desk need a `pipeline path --watch` mode to detect newly-installed hosts, or is a one-shot probe sufficient? (Current: one-shot; watch is deferred.)
