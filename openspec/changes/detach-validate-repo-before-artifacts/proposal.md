## Why

`pipeline <N> --detach` (and its `pipeline run <N> --detach` alias) creates its
artifacts **before** anything validates that the launch cwd is inside a git checkout.
In `handleRunSubcommand` (`core/scripts/pipeline.ts`) the detach branch computes

```ts
const runStoreStart = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
const repoDir = findGitRoot(runStoreStart) ?? runStoreStart;   // <- silent fallback to raw cwd
const runStoreDir = runDirPath(repoDir, runStoreRunId);
```

then calls `spawnDetached`, which creates `~/.pipeline/runs/<N>/<ts>/`, opens
`pipeline.log`, spawns the wrapper, and finally writes a `run-store.json` pointer.
Only afterwards does the inner process call `resolveConfig`, fail with
`pipeline: no git repo found at or above <cwd>`, and exit 2.

Reproduced on this branch (2026-07-22, from an empty `/tmp` dir):

```
$ cd /tmp/p485 && pipeline 999999 --detach
/home/mcomardo/.pipeline/runs/999999/2026-07-22_16-16-23-540-p1102190
[pipeline] #999999: detached run started (PID 1102197)
[pipeline] #999999: structured run artifacts at /tmp/p485/.agent-pipeline/runs/999999-...Z/
EXIT=0
$ cat ~/.pipeline/runs/999999/*/sentinel.json
{"exitCode":2,"durationMs":455,"completedAt":"2026-07-22T16:16:24Z"}
```

Three failure modes in one command:

1. The launcher exits **0** and prints "detached run started" for a run that cannot start.
2. A wrapper directory plus `pipeline.log`, `sentinel.json`, and `run-store.json` are
   created for a refused run.
3. The advertised run-store path is derived from the **raw cwd** (`/tmp/p485/.agent-pipeline/…`)
   because of the `?? runStoreStart` fallback — a stray-store location outside any repo,
   and the pointer a desktop consumer is told to trust.

Observed three times in one supervised run (2026-07-21, v1.15.1 / v1.16.0, fuseiq-core
#89/#93/#96) when an orchestrator's shell cwd drifted to a scratch directory.

## What Changes

- Resolve the repo **first** in the detached launch path: `--repo-path` (resolved) or a
  git-root walk up from cwd, using the same `findGitRoot` semantics `resolveConfig` uses
  for the inner run.
- On failure, refuse **before any write**: no wrapper directory, no log file, no lock file,
  no spawned wrapper, no `run-store.json` — print the existing
  `no git repo found at or above <startDir>. Run from inside a checkout, or pass --repo-path.`
  message and exit 2.
- Delete the `?? runStoreStart` fallback. The pinned run-store directory is derived from the
  **resolved repo root** only; there is no code path that points the run store at a raw,
  unvalidated cwd. The wrapper directory stays under `$HOME/.pipeline/runs/` as today.
- Add regression coverage over the existing `RunSubcommandDeps` seam (plus whatever seam is
  needed for git-root resolution) proving the refusal is write-free and that `spawnDetached`
  is never invoked.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `detached-launcher`: gains an explicit precondition requirement — repo resolution/validation
  precedes any artifact creation, and a failed resolution is a write-free exit 2.
- `run-directory-layout`: the "A detached launch exposes the same run-store run directory"
  requirement is tightened so the pinned run-store path is derived from the resolved repo
  root, never from an unvalidated cwd.

## Scope

In scope: the `--detach` launch path in `core/scripts/pipeline.ts`
(`handleRunSubcommand`) and its tests.

Out of scope:

- Managed-worktree cwd resolution (#472) — a launch from inside `.worktrees/pipeline-*`
  currently nests the run store in a worktree that finalize deletes. That resolves to a
  valid git root, so it is unaffected by this change.
- Non-detached `pipeline <N>` behavior, which already validates via `resolveConfig` before
  writing.
- Any change to the wrapper directory layout, sentinel schema, or lock protocol.

## Acceptance criteria

- [x] `pipeline <N> --detach` invoked from a directory with no git repo at or above it exits
      **2** and prints `no git repo found at or above <dir>. Run from inside a checkout, or
      pass --repo-path.` — it does not print "detached run started".
- [x] That refusal creates **nothing**: the launch directory is byte-for-byte unchanged (no
      `.agent-pipeline/`), no `~/.pipeline/runs/<N>/<ts>/` wrapper directory, no
      `pipeline.log`, no `sentinel.json`, no `run-store.json`, and no per-issue lock file.
- [x] `spawnDetached` is never called when repo resolution fails (asserted through the
      `RunSubcommandDeps` seam, so no process is ever spawned in the test).
- [x] `pipeline run <N> --detach` (the alias) exhibits identical refusal behavior.
- [x] `--repo-path <dir>` pointing at a non-repo directory refuses the same way, naming the
      resolved `--repo-path` value in the error, not the cwd.
- [x] When the repo resolves, the pinned run-store directory is
      `<git-root>/.agent-pipeline/runs/<run-id>`; a launch from a subdirectory of a repo pins
      the run store at the repo root, and no code path derives it from an unvalidated cwd.
- [x] Existing detached-launch behavior is otherwise unchanged: successful launches still
      print the wrapper dir on stdout, still write `run-store.json`, still forward
      `--run-id`/`--json-events`/lifecycle flags, and still exit 0.
- [x] `core/test/` contains a regression test that fails on the pre-fix code (launcher exits
      0 and creates a wrapper dir) and passes after.
- [x] `npm run ci` passes from the repo root with the `plugin/` mirror in sync.
