## 1. Lock the recovery contract

- [x] 1.1 Update the implement-deliverable observer test so exact candidates containing only test, fixture, example, mock, script, or tool code must classify as implementation, and verify the old classifier fails the test.
- [x] 1.2 Preserve assertions that OpenSpec, documentation, workflow-only, and unknown non-code configuration candidates do not classify as implementation.

## 2. Correct artifact classification

- [x] 2.1 Remove directory-name demotion from the executable/package artifact classifier while retaining the planning-only exclusion and existing type allowlist; verify the focused observer suite passes.
- [x] 2.2 Verify candidate SHA/epoch invalidation and planning-only recovery regression tests still pass.

## 3. Gates

- [x] 3.1 Run `openspec validate implementation-proof-test-tooling --strict` and verify it passes.
- [x] 3.2 Run `node scripts/build.mjs` and `node scripts/build.mjs --check` after the `core/` edits.
- [x] 3.3 Run `npm run ci` from the repository root and verify the complete gate passes.
