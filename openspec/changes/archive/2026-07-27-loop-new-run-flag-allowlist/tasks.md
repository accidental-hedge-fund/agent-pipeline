## 1. Regression test first (prove it bites)

- [ ] 1.1 In `core/test/command-registry.test.ts`, add a test asserting
      `validateFlags(COMMAND_REGISTRY.loop, <fake cmd with `newRun` CLI-sourced>)` returns `[]`,
      using the existing `fakeCmdWithCliFlag` helper.
- [ ] 1.2 Add the bidirectional sync guard: enumerate `buildCmd().options`, filter to those whose
      `description` begins with `loop:`, and assert every such `attributeName()` is present in
      `COMMAND_REGISTRY.loop.allowedFlags`.
- [ ] 1.3 Run `node --test --experimental-strip-types test/command-registry.test.ts` from `core/`
      and confirm both new tests FAIL against the unfixed registry (naming `newRun`).

## 2. Fix

- [ ] 2.1 Add `"newRun"` to the `loop` entry's `allowedFlags` set in
      `core/scripts/command-registry.ts`. No other entry, no `UNIVERSAL_FLAGS` change.
- [ ] 2.2 Re-run the registry tests and confirm they now pass.

## 3. Mirror + full gate

- [ ] 3.1 Regenerate the plugin mirror: `node scripts/build.mjs` from the repo root; commit the
      regenerated `plugin/` in the same change.
- [ ] 3.2 Run `npm run ci` from the repo root and confirm it is green (core tests, mirror check,
      install smoke, `openspec validate --all`).

## 4. Verify the observable outcome

- [ ] 4.1 Confirm `pipeline loop --new-run <selector>` no longer exits 2 with
      `'loop' cannot be combined with --new-run`, and that `runLoopCommand` receives `newRun: true`.
- [ ] 4.2 Confirm no `--new-run` semantics changed: the supersession decision functions
      (`decideNewRun*`) and their tests are untouched.
