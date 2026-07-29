## 1. Shared pre-remove safety policy

- [ ] 1.1 In `core/scripts/worktree.ts`, extract a single-sourced safety helper that encodes the operator remove tier table: dirty blocks without force; local-only `true` / `"unverifiable"` (without force) / `null` block; clean + local-only false proceeds.
- [ ] 1.2 Refactor `removeWorktreeForIssue` to call that helper so operator outcomes stay byte-compatible with existing `worktree-remove` tests (no intentional behavior change to `--remove-worktree`).
- [ ] 1.3 Export only what tests need; keep the helper free of network/git side effects (it consumes already-computed dirty / localOnly / force inputs).

## 2. Gate create-time reclaim

- [ ] 2.1 In `createWorktree`, before each reclaim mutation over same-issue managed records (`mine`), run dirty + local-only checks (injectable via `CreateWorktreeDeps`) and apply the shared helper with `force: false`.
- [ ] 2.2 Apply the same gates to the target-path collision cleanup when `existsFn(wtPath)` would otherwise call `removeWorktree`.
- [ ] 2.3 On any blocking result, throw a clear error naming issue, path/branch, and condition (dirty vs local-only vs verification failure); do not call the remove dep.
- [ ] 2.4 On pass, call the existing `removeWorktree` dep as today so clean self-reclaim / slug-change / capacity paths continue.
- [ ] 2.5 Preserve `underManagedRoot === false` skip (never reclaim developer checkouts outside managed roots).

## 3. Regression tests

- [ ] 3.1 Add unit tests (deps-injected, no real git/network) for dirty reclaim: remove dep not called; error names dirty; create aborts.
- [ ] 3.2 Add unit tests for definitive local-only reclaim: remove dep not called; error names local-only.
- [ ] 3.3 Add unit tests for `"unverifiable"` and hard-failure (`null`) local-only results: refuse without mutation.
- [ ] 3.4 Add unit test for clean reclaim: remove dep called; create proceeds (existing happy path still green).
- [ ] 3.5 Prove bite: temporarily drop the reclaim gate and confirm dirty / local-only tests fail (document or run once while implementing).
- [ ] 3.6 Re-run existing `worktree-remove.test.ts` (and any create-worktree tests) to confirm operator remove tiers unchanged.

## 4. Ship

- [ ] 4.1 Run `node scripts/build.mjs` and include regenerated `plugin/` if `core/` changed.
- [ ] 4.2 Run `npm run ci` from repo root until green.
