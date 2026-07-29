## 1. Shared pre-remove safety policy

- [x] 1.1 In `core/scripts/worktree.ts`, extract a single-sourced safety helper that encodes the operator remove tier table: dirty blocks without force; local-only `true` / `"unverifiable"` (without force) / `null` block; clean + local-only false proceeds.
- [x] 1.2 Refactor `removeWorktreeForIssue` to call that helper so operator outcomes stay byte-compatible with existing `worktree-remove` tests (no intentional behavior change to `--remove-worktree`).
- [x] 1.3 Export only what tests need; keep the helper free of network/git side effects (it consumes already-computed dirty / localOnly / force inputs).

## 2. Gate create-time reclaim

- [x] 2.1 In `createWorktree`, before each reclaim mutation over same-issue managed records (`mine`), run dirty + local-only checks (injectable via `CreateWorktreeDeps`) and apply the shared helper with `force: false`.
- [x] 2.2 Apply the same gates to the target-path collision cleanup when `existsFn(wtPath)` would otherwise call `removeWorktree`.
- [x] 2.3 On any blocking result, throw a clear error naming issue, path/branch, and condition (dirty vs local-only vs verification failure); do not call the remove dep.
- [x] 2.4 On pass, call the existing `removeWorktree` dep as today so clean self-reclaim / slug-change / capacity paths continue.
- [x] 2.5 Preserve `underManagedRoot === false` skip (never reclaim developer checkouts outside managed roots).
- [x] 2.6 Preflight **all** reclaim candidates (same-issue managed + collision) before any mutation; abort with zero removals if any candidate fails (#622 review-2 37cc1885).
- [x] 2.7 Race-safe mutation: non-force `git worktree remove` + OID-gated `update-ref -d` (no `--force`, no unconditional `branch -D`); revalidate before delete (#622 review-2 c0028d2d).

## 3. Regression tests

- [x] 3.1 Add unit tests (deps-injected, no real git/network) for dirty reclaim: remove dep not called; error names dirty; create aborts.
- [x] 3.2 Add unit tests for definitive local-only reclaim: remove dep not called; error names local-only.
- [x] 3.3 Add unit tests for `"unverifiable"` and hard-failure (`null`) local-only results: refuse without mutation.
- [x] 3.4 Add unit test for clean reclaim: remove dep called; create proceeds (existing happy path still green).
- [x] 3.5 Prove bite: temporarily drop the reclaim gate and confirm dirty / local-only tests fail (document or run once while implementing).
- [x] 3.6 Re-run existing `worktree-remove.test.ts` (and any create-worktree tests) to confirm operator remove tiers unchanged.
- [x] 3.7 Preflight multi-candidate: later dirty/local-only/collision failure leaves earlier clean candidates unmutated.
- [x] 3.8 Race-safe path: non-force remove + update-ref OID args; late remove refusal skips branch delete; tip change aborts before mutation.

## 4. Ship

- [x] 4.1 Run `node scripts/build.mjs` and include regenerated `plugin/` if `core/` changed.
- [x] 4.2 Run `npm run ci` from repo root until green.
