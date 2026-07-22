# Run-engine snapshot isolation: an update can no longer change a live run (#450)

## Why

The installed skill tree (`~/.claude/skills/pipeline/`, `~/.codex/skills/pipeline/`) is
replaced in place by `scripts/install.mjs` (`install` / `update` verbs copy `CORE_ENTRIES =
["scripts", "profiles", "package.json", "package-lock.json"]` over the existing install).
Nothing coordinates that overwrite with the long-lived `node …/pipeline.ts advance` processes
already running against those exact files.

The engine reads its own files at two different times:

- **Code** is loaded once, at process start, by the ES module loader — a running process keeps
  the module graph it started with.
- **Prompt templates** are read at *stage* time, lazily, on every build:
  `core/scripts/prompts/index.ts` resolves `here = dirname(fileURLToPath(import.meta.url))` and
  `loadTemplate(name)` does a fresh `fs.readFileSync(here/<name>.md)` inside each
  `build*Prompt()` call.

So an update that lands mid-run produces a process running **old code against new templates**.
`substitute()` validates placeholders against the template, so a template that gained a
placeholder the old builder does not supply throws immediately:

```
Error: Unfilled prompt placeholder(s) {{reviewed_sha}} (template substitution missed a key).
```

Two observed incidents on lyric-utils:

1. **2026-07-08 (1.14.x → 1.15.0/1.15.1)** — the update landed ~1 minute after a run started;
   old `buildFixPrompt` + new `fix.md` → the `{{reviewed_sha}}` crash above killed `fix-1` on
   lyric-utils#651 (run `651-2026-07-08T16-55-10-737Z`).
2. **2026-07-21 (→ 1.15.2)** — an update landed mid-run on lyric-utils#420, silently reverting a
   host-local prompt mitigation for #443 and activating the #448 config semantic change against an
   in-flight goal-loop. Nothing in the run artifacts recorded that the engine underneath the run
   had changed, so the resulting behavior change was un-attributable after the fact.

Both classes are the same defect: **a run does not execute against a consistent skill snapshot.**
Incident 1 is a hard crash; incident 2 is a silent behavior swap that is worse, because the run
completes and lies about what produced it.

## What Changes

Three layers, defence in depth — the first makes the crash impossible, the second makes any
residual drift visible and attributable, the third stops the race at its source.

- **Templates are pinned at process start.** Prompt templates are read **once**, eagerly, into an
  in-memory snapshot when the prompts module is first loaded, and every `build*Prompt()` reads from
  that snapshot instead of the filesystem. Old code is then structurally guaranteed to see the
  templates that shipped with it. Template *content* is unchanged; only the read timing moves.
- **Engine identity is recorded in `run.json`.** `initRunDir` additionally writes an `engine` object
  — the engine `version` (already single-sourced from `core/package.json`), the resolved engine
  root path, and a cheap content fingerprint of the pinned template set — captured at run start.
  This is written once, with the rest of the immutable identity metadata, and never rewritten.
- **Mid-run engine drift is detected and surfaced.** At each stage boundary the orchestrator
  re-reads the on-disk engine version/fingerprint and compares it to the pinned values. A mismatch
  appends an `engine_drift` event to `events.jsonl`, prints a visible warning naming the pinned and
  on-disk identities, and records the drift in the evidence bundle. Detection is advisory and
  best-effort: the run continues against its pinned snapshot, and a failed probe never changes a
  stage outcome. (The run cannot "reload" — its code is already loaded — so honesty, not recovery,
  is the correct behavior here.)
- **`install.mjs update` defers to live runs.** Before overwriting an installed core, the installer
  scans `/tmp/pipeline-*.lock` for locks held by a **live** PID (the same liveness probe
  `PipelineLock` already uses: `process.kill(pid, 0)`, `ESRCH` ⇒ stale). If any live run is found,
  the update refuses with a non-zero exit, lists the holding PIDs and lock paths, and tells the
  operator to retry when the runs finish or to pass `--force`. `--force` proceeds with the same
  information printed as a warning. `install` on a host with no existing core install is unaffected;
  `uninstall` is out of scope.

## Non-goals

- **No copy-the-skill-tree-per-run.** The issue offers that as an alternative. It multiplies disk
  and `node_modules` provisioning per run and changes the resolution of every relative path in the
  engine; pinning templates in memory achieves the same isolation for the only file class actually
  read late.
- **No blocking, killing, or auto-retrying a drifted run.** Drift is reported, not remediated.
- **No change to prompt template content**, to the review layer, or to any gate.

## Deferred (out of scope, follow-up)

The human comment on #450 reports a distinct salvage defect on 1.15.2 (lyric-utils#638, run
`638-2026-07-21T04-47-26-851Z`): `trySalvageUncommittedWork` staged and committed
`.pipeline-rebase-attempted` — the pipeline-internal marker written by
`core/scripts/stages/pre_merge.ts` (`REBASE_MARKER_FILE`) — as a round's only content. That is a
salvage staging-exclusion bug, unrelated to update races, and is tracked as a separate follow-up
issue rather than expanded into this change.

## Acceptance criteria

- [ ] Replacing every `*.md` file under the engine's `prompts/` directory *after* the prompts module
      has loaded does not change any prompt subsequently built by that process; a test that rewrites
      `fix.md` to contain a novel `{{reviewed_sha}}`-shaped placeholder between two
      `buildFixPrompt()` calls sees identical output from both and raises no
      `Unfilled prompt placeholder(s)` error.
- [ ] No `build*Prompt()` code path performs a filesystem read of a template at call time; a test
      asserts the template read seam is invoked zero times after module initialization.
- [ ] `run.json` written by `initRunDir` contains an `engine` object with `version`, the engine root
      path, and a template-set fingerprint, alongside the existing `schema_version`, `run_id`,
      `issue`, `repo`, `profile`, `started_at` fields; re-entering the dispatch loop for the same
      run-id leaves `run.json` byte-identical.
- [ ] A run whose on-disk engine version or template fingerprint differs from its pinned `engine`
      values at a stage boundary appends exactly one `engine_drift` event per detected transition to
      `events.jsonl`, carrying the pinned and observed identities and the stage at which it was
      detected, and records the drift in the evidence bundle.
- [ ] A drift probe that throws (engine files unreadable, `package.json` missing) leaves the stage
      outcome and the run's exit status identical to a no-drift run.
- [ ] `node scripts/install.mjs update` exits non-zero without copying any file when a
      `/tmp/pipeline-*.lock` is held by a live PID, and its output names each blocking lock path and
      PID.
- [ ] The same invocation with `--force` performs the update and prints the blocking runs as a
      warning.
- [ ] Locks whose recorded PID is dead (or whose contents are unparseable) do not block an update;
      the update proceeds normally.
- [ ] Regression tests bite: with template pinning reverted, the mid-run template-swap test fails
      with the `{{reviewed_sha}}` unfilled-placeholder error; with the live-run guard reverted, the
      installer test observes a copy where it expected a refusal.
- [ ] `npm run ci` is green, including the regenerated `plugin/` mirror.

## Capabilities

### New Capabilities
- `run-engine-snapshot-isolation`: prompt templates pinned at process start, engine identity pinned
  in `run.json`, and mid-run engine-drift detection and disclosure.
- `update-live-run-deferral`: the installer's `update` verb refuses to overwrite an installed core
  while a live pipeline run holds a lock, unless forced.

### Modified Capabilities
- `run-directory-layout`: `run.json`'s immutable identity metadata gains the `engine` object.

## Impact

- `core/scripts/prompts/index.ts` — eager template snapshot; `loadTemplate` reads from the snapshot.
- `core/scripts/run-store.ts` — `RunMeta`/`InitRunDirOpts` gain `engine`; new `EngineDriftEvent`
  variant on `RunEvent`.
- `core/scripts/pipeline-run.ts` — capture engine identity at run start; stage-boundary drift probe.
- `core/scripts/evidence-bundle.ts` — record detected drift.
- `scripts/install.mjs` — live-run lock scan and `--force` flag on the `update`/`install` path.
- `core/test/` — new tests for template pinning, drift events, and the installer guard.
- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` — document the update-deferral behavior.
- `plugin/` — regenerate via `node scripts/build.mjs`.
- No new `.github/pipeline.yml` config keys.
