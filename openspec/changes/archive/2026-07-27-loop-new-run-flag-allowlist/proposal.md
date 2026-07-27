## Why

`pipeline loop --new-run` — the documented supersession surface for a terminally-stopped
canonical run (#568, capability `loop-run-supersession`) — is unreachable from the CLI. The
option is registered (`core/scripts/pipeline.ts:406`), read by `runLoopCommand`, and backed by
fully-implemented decision logic (`decideNewRun*`), but the `loop` entry's `allowedFlags` set in
`core/scripts/command-registry.ts` omits `"newRun"`. Unified flag validation therefore rejects the
flag with exit code 2 before any run logic executes:

```
$ pipeline loop --new-run --label <selector>
pipeline: 'loop' cannot be combined with --new-run. These are separate commands.
```

The message is also wrong on its face: `--new-run` is not a separate command, it is a documented
mode of `loop`. The only way an operator can currently unwedge a terminally-stopped selector is by
hand-editing durable run state — exactly what `loop-run-supersession` promises they SHALL NOT have
to do.

The registry's existing cross-check test only asserts one direction (every allowlisted attribute
name exists as a registered option). It cannot catch the inverse drift — a registered `loop:`
option missing from the loop allowlist — which is precisely the defect here.

## What Changes

- Add `"newRun"` to the `loop` entry's `allowedFlags` set in `core/scripts/command-registry.ts`, so
  `pipeline loop --new-run <selector>` passes flag validation and reaches `runLoopCommand`.
- Add a bidirectional sync guard to the command-registry test suite: every registered CLI option
  whose help description is `loop:`-namespaced SHALL appear in the `loop` entry's `allowedFlags`.
  This closes the drift class, not just the single instance.
- No change to `--new-run`'s semantics, the supersession decision logic, the refusal conditions, or
  any other command's allowlist. Surgical scope per the issue and the maintainer's v1.28.1 note.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `command-registry`: the `loop` entry's flag allowlist SHALL cover every `loop:`-namespaced
  registered option, including `newRun`; the allowlist/CLI cross-check SHALL be bidirectional.
- `loop-run-supersession`: the `--new-run` surface SHALL be invocable end-to-end from the CLI —
  flag validation SHALL NOT reject it before the supersession decision runs.

## Acceptance criteria

- [ ] `validateFlags(COMMAND_REGISTRY.loop, <cmd with --new-run provided on the CLI>)` returns `[]`
      (no offending flags), where today it returns `["newRun"]`.
- [ ] `COMMAND_REGISTRY.loop.allowedFlags` contains `"newRun"`.
- [ ] A registry test asserts that every option registered in `buildCmd()` whose description begins
      with `loop:` is present in `COMMAND_REGISTRY.loop.allowedFlags`; the test fails on the
      pre-fix registry and passes after the one-line addition.
- [ ] `pipeline loop --new-run <selector>` no longer exits 2 with
      `'loop' cannot be combined with --new-run`; control reaches `runLoopCommand` with
      `newRun: true`.
- [ ] No other command entry's `allowedFlags` set changes, and no `--new-run` semantics change:
      supersession is still refused for a run that is not terminally stopped, and the minted run id
      is still the deterministic supersession-chain id.
- [ ] `npm run ci` is green from the repo root, including the regenerated `plugin/` mirror.

## Impact

- `core/scripts/command-registry.ts` — one entry in the `loop` `allowedFlags` set.
- `core/test/command-registry.test.ts` — regression test + bidirectional `loop:` sync guard.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`).
- No change to `pipeline.ts` option registration, `runLoopCommand`, the durable loop store, or the
  supersession decision functions.
