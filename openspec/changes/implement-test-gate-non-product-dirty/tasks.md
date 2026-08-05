## 1. Pure product-vs-scratch classifier

- [x] 1.1 Add a pure helper (new module or colocated export) that classifies
      porcelain paths into product dirt vs non-product scratch using the
      engine-known set (`tasks/todo.md` and/or `tasks/**` aligned with authoring
      `allowDirtyPattern`, plus `.pipeline-prompt-*` at worktree root).
- [x] 1.2 Support optional config-extended globs as a **union** with the engine
      set (no replace mode); document the default set in code comments or config
      schema if a config key is added.
- [x] 1.3 Unit-test the classifier for scratch-only, product-only, mixed, empty,
      and lockfile basenames (locks are **not** scratch).

## 2. Wire test gate dirty trust checks

- [x] 2.1 In `core/scripts/testgate.ts`, change pre-run dirty check so it
      hard-blocks only when **product** dirt is non-empty (use classifier +
      porcelain path list; keep injectable seams).
- [x] 2.2 Apply the same product-dirt rule to the post-run dirty check after a
      passing command.
- [x] 2.3 Ensure product dirty `blockReason` still discloses product paths and is
      not wrapped as test/build fix exhaustion; scratch-only does not mint a
      dirty hard block.

## 3. Wire format gate pre-flight (implement certification path)

- [x] 3.1 Update format-gate pre-existing dirty refusal to use the same
      product-dirt classification so implement-path certification is not still
      blocked by scratch before the test gate.
- [x] 3.2 Confirm lockfile fold (#722) still runs before format/test gates and is
      not reclassified as scratch ignore.

## 4. Regression tests

- [x] 4.1 Add a testgate regression: porcelain scratch-only (`tasks/todo.md`
      and/or `.pipeline-prompt-*`) → gate proceeds (command invoked or
      restore-then-proceed); test **bites** without the exemption.
- [x] 4.2 Add a fail-closed test: mixed scratch + product path → still blocks;
      product path appears in `blockReason`.
- [x] 4.3 Add or extend format-gate coverage for scratch-only pre-dirty so it
      does not refuse solely for engine-known scratch.
- [x] 4.4 Confirm existing lockfile-fold and dirty-vs-exhaustion tests remain green.

## 5. Mirror, validate, CI

- [x] 5.1 After any `core/` edits, run `node scripts/build.mjs` and include
      regenerated `plugin/` in the same change.
- [x] 5.2 Run `openspec validate implement-test-gate-non-product-dirty` (and
      `openspec validate --all` as needed).
- [x] 5.3 Run `npm run ci` from repo root and fix failures until green.
