## Why

The implement-stage test/build gate treats **any** uncommitted path as untrustworthy,
including non-product agent scratch such as `tasks/todo.md` and `.pipeline-prompt-*`.
Dogfood on #762 showed implementer product work already committed and pushed, yet the
gate hard-blocked solely on `M tasks/todo.md`, classified the hold as
`test-gate-exhausted` / `implementation-ci`, and burned durable recovery budget on
recipes that cannot clear scratch dirt. Lockfile fold (#722 / #358) already exempts
recognized locks; scratch paths still fail closed and mis-route recovery.

## What Changes

- Before the implement (and shared format/test) dirty-tree trust check, treat
  **engine-known non-product scratch paths** as non-blocking for “clean enough to
  trust the gate,” while **product-relevant dirt** continues to fail closed until
  committed.
- Prefer a fixed engine-known set (with optional config extension) over folding
  scratch into product commits or silently discarding without a documented policy.
- Keep lockfile fold (#722) unchanged and orthogonal: locks are still folded into
  HEAD; scratch is ignored for trust (or restored only when that is the chosen
  implementation), never staged as product.
- Operator-facing / recovery-facing reasons MUST distinguish **product dirty**
  (still a hard block) from **scratch-only dirty that was ignored or restored**
  (gate proceeds; must not claim test/build failure or fix exhaustion for that
  alone).
- Regression coverage: product tree committed + only configured/engine scratch
  dirty → gate proceeds (or restores scratch then proceeds); product path dirty
  → still blocks with path disclosure.

## Capabilities

### New Capabilities

- `test-gate-non-product-dirty`: Engine-known (and optionally config-extended)
  non-product scratch path patterns applied at the pre-gate dirty trust check so
  scratch-only dirt does not hard-block implement format/test gates or burn
  recovery budget; product dirt remains fail-closed.

### Modified Capabilities

- `test-build-gate`: Refine “worktree must be clean around a trusted run” so
  “clean enough” excludes engine-known non-product scratch paths; path disclosure
  and dirty-vs-exhaustion wording remain for **product** dirt only. Post-run
  dirt that is scratch-only follows the same classification (does not fail a
  passing command solely on scratch).

## Acceptance criteria

- [ ] With product HEAD clean and only engine-known scratch dirty (at least
      `tasks/todo.md` and `.pipeline-prompt-*`), the implement-path format/test
      pre-dirty checks do **not** hard-block; the test command is allowed to run
      (or scratch is restored first and then the gate proceeds).
- [ ] With any uncommitted **product** path dirty (e.g. under `core/`, `plugin/`,
      `openspec/`, or other non-scratch tracked/untracked product files), the gate
      still blocks with attempts 0 and discloses those paths.
- [ ] Lockfile fold (#722 / implement-commit-lockfile-inclusion) is unchanged:
      recognized locks still fold before gates; this change does not re-classify
      lockfiles as “scratch ignore.”
- [ ] Scratch-only dirt does **not** produce an operator reason claiming the
      test/build command failed or fix attempts were exhausted; if a block still
      occurs for other reasons, residual scratch is not labeled as the CI/test
      failure.
- [ ] A unit/regression test drives porcelain that is scratch-only after a
      committed product tree and asserts the gate proceeds (or restore-then-proceed);
      the test bites without the scratch exemption.
- [ ] A unit/regression test drives mixed dirt (scratch + product) and asserts
      the gate still blocks on the product path(s).
- [ ] Seams stay injectable (no real git/network/subprocess in unit tests);
      `core/` changes are mirrored with `node scripts/build.mjs`;
      `openspec validate` and `npm run ci` pass.

## Impact

- `core/scripts/testgate.ts` — pre-run and post-run dirty trust checks classify
  paths before treating the tree as dirty.
- Likely shared helper used by format-gate pre-flight dirty check
  (`core/scripts/stages/format-gate.ts`) so implement-path certification is
  consistent before either gate.
- Optional thin config surface under `test_gate` (or a dedicated ignore list) if
  operators need extra globs beyond the engine-known set.
- Recovery / blocker classification only indirectly: correct gate behavior avoids
  mis-routing scratch dirt into `test-gate-exhausted` durable recovery.
- Living specs: new `test-gate-non-product-dirty`; delta on `test-build-gate`.
- Regenerated `plugin/` when `core/` changes.
- Does **not** allow arbitrary uncommitted product code through the gate; does
  **not** change human-input / design-gate classification (#872).
