## 1. Reproduce & pin the failure

- [ ] 1.1 Add a failing test that composes the wrapper's arg list
      (`[...passthrough, "--profile", PROFILE]`, mirroring
      `hosts/_shared/entry.template.mjs`) for `refine-spec`, `scoreboard`, and
      `release`, drives the CLI flag-validation path, and asserts none is
      rejected on `profile`. Confirm it fails against current `main` (it bites).

## 2. Implement universal `--profile` tolerance

- [ ] 2.1 In `core/scripts/command-registry.ts`, introduce a `UNIVERSAL_FLAGS`
      set (containing at least `profile`) and exempt its members inside
      `validateFlags` so `profile` is never reported as an offending flag for
      any command whose `allowedFlags` is not `"all"`.
- [ ] 2.2 Confirm the strict allowlist is otherwise unchanged — only `profile`
      is universally tolerated; every other undeclared flag still returns as
      offending.
- [ ] 2.3 Do NOT edit the wrapper (`entry.template.mjs`) and do NOT add
      `profile` to individual `allowedFlags` sets — the fix is the single
      universal carve-out.

## 3. Tests

- [ ] 3.1 Make the reproduction test from 1.1 pass.
- [ ] 3.2 Add a `UNIVERSAL_FLAGS` membership test asserting `profile` is a
      member (guards the type-only invariant, since types are stripped not
      checked).
- [ ] 3.3 Add a negative test: a non-universal undeclared flag on a profile-free
      command (e.g. `scoreboard --bogus`) is still rejected with exit code 2.
- [ ] 3.4 Confirm existing `merge` allowlist tests (which assert `--profile` is
      accepted) still pass.

## 4. Regenerate mirror & full gate

- [ ] 4.1 Run `node scripts/build.mjs` to regenerate `plugin/` and the installed
      wrapper template; commit the regenerated mirror in the same change.
- [ ] 4.2 Run `node scripts/build.mjs --check` (mirror in sync).
- [ ] 4.3 Run `npm run ci` from the repo root; treat red as not-done.

## 5. OpenSpec

- [ ] 5.1 `openspec validate tolerate-host-injected-profile --strict` passes.
