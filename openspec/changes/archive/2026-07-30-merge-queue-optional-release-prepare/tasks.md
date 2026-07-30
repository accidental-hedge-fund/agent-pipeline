## 1. Completeness evaluation

- [x] 1.1 Add a pure helper (e.g. `isQueueComplete` / `evaluateReleaseWhenComplete`) that takes remaining open R2D candidates, held items, and optional open non-candidate issues and returns `{ complete, skipReason?, nonCandidateWarning? }` per the queue-complete definition in the spec.
- [x] 1.2 Unit-test completeness: empty R2D + no holds → complete; remaining R2D → incomplete; holds → incomplete; open non-R2D only → complete with warning payload.

## 2. CLI / config opt-in surface

- [x] 2.1 Wire `--release-when-complete` and `--release-version <major|minor|patch|X.Y.Z>` onto the merge-queue command (match #673/#674 parent CLI once present). Default off.
- [x] 2.2 Optional config key defaulting to false (shape aligned with merge-queue config if it exists); CLI OR config enables. Reject enabled-without-version with usage error before release mutations.
- [x] 2.3 Document flags in help text: prepare-only, never tags/merges/publishes; requires complete queue.

## 3. Post-drive release hook

- [x] 3.1 After merge-queue apply finishes (merges/holds reported), if enabled: re-query remaining R2D candidates for the selector, evaluate completeness, skip with reason if incomplete.
- [x] 3.2 On complete: invoke shared `runRelease(version, { noEdit: true }, cfg, releaseDeps)` (or equivalent single-sourced API). Do not shell out to a second process.
- [x] 3.3 On prepare failure: print clear error, preserve merge outcomes, exit non-zero after reporting; never unmerge or re-drive.
- [x] 3.4 Emit warning when open non-R2D / non-candidate issues remain on the selector.

## 4. Dry-run disclosure

- [x] 4.1 In dry-run with flag: evaluate **current** completeness; print would-prepare (with version) or would-not + skip reason.
- [x] 4.2 Dry-run passes `dryRun: true` into release only if would-prepare (or simply report intent without calling release) — either way, assert zero PR creation and zero release-managed file writes.
- [x] 4.3 Dry-run without flag does not list prepare-release as a planned action.

## 5. Invariants and tests

- [x] 5.1 Injected-deps tests: default off → release never called; complete + flag → `runRelease` called with `noEdit: true` and version; incomplete → not called.
- [x] 5.2 Injected-deps test: prepare throws after mock merges → merges remain successful in result; no second merge call.
- [x] 5.3 Injected-deps test: dry-run complete + flag → no PR create / no writeFile on release-managed paths (or release not invoked if disclosure-only).
- [x] 5.4 Assert prepare path does not invoke tag, npm publish, or merge-release-PR operations (hook does not wire any such deps).

## 6. Mirror and CI gate

- [x] 6.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [x] 6.2 `npm run ci` green (core tests, mirror `--check`, install smoke, `openspec validate --all`).
