## 1. Implement-path lockfile fold

- [x] 1.1 Wire `includeLockfileSideEffects` into the post-implementation path
      (`resumeFromImplementing` in `core/scripts/stages/planning.ts`) **before**
      `runFormatAndTestGates`, reusing `core/scripts/lockfile-side-effects.ts`
      without duplicating lock recognition.
- [x] 1.2 Extend `ResumeFromImplementingDeps` with an injectable lockfile-side-effects
      seam (mirror `AdvanceFixDeps.lockfileSideEffects`) so unit tests use fakes.
- [x] 1.3 Log when a fold occurs (parity with fix-path console diagnostic naming
      folded paths); no-op when no lock dirt is present.

## 2. Dirty-block operator messaging

- [x] 2.1 Tag testgate dirty-only results (pre-dirty and post-run dirty that never
      enter the fix loop) with a distinct flag or pass-through channel (e.g.
      `dirtyWorktree: true`), parallel to `toolingFailure` / `buildFailure`.
- [x] 2.2 Update `testGateBlockReason` so dirty-only results are **not** wrapped in
      “failed after N fix attempt(s)” / “command is still failing”; pass through
      (or thinly prefix) the gate’s dirty `blockReason` and retain path disclosure.
- [x] 2.3 Confirm exhausted real test failures still use exhaustion wording; tooling
      and build failure pass-through remains unchanged.

## 3. Regression tests

- [x] 3.1 Add an implement-path / `resumeFromImplementing` regression: HEAD advanced
      (or resume-shaped) + uncommitted recognized lock → fold seam invoked **before**
      the gates runner; injectable deps only.
- [x] 3.2 Prove the test bites without the fold (remove call or assert order fails /
      lock would remain pre-gate dirt).
- [x] 3.3 Add `testGateBlockReason` (or equivalent) unit tests: pre-dirty result does
      not match fix-exhaustion wording; exhausted test failure still does; path
      disclosure retained for dirty case.
- [x] 3.4 Cover yarn/pnpm lock basenames or nested path at least once if not already
      implied by reusing the existing helper tests (prefer not re-testing the helper’s
      full matrix — order/call-site is the new contract).

## 4. Mirror, validate, CI

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` and commit the
      regenerated `plugin/` in the same change (never hand-edit the mirror).
- [x] 4.2 Run `openspec validate implement-path-lockfile-fold` (and `openspec validate
      --all` if required by local habit) until green.
- [x] 4.3 Run `npm run ci` from repo root and fix any failures before declaring done.
