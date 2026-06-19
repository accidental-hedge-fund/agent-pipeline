## 1. Surgical, finding-scoped fix discipline

- [ ] 1.1 `fix.md`: promote the "minimal diff" rule to a leading instruction — the fix harness SHALL make the minimal diff that resolves the specific finding: no refactors, no scope-broadening, no unrelated changes, no opportunistic cleanup (even adjacent to the finding). Strengthen/replace the existing weak step-3 "Do NOT change anything unrelated" line.

## 2. Destructive-operation guard

- [ ] 2.1 `fix.md`: add a guard requiring an explicit safety scope or written justification when a fix touches a destructive/irreversible operation — name the operations (`git worktree remove --force`, `git push --force`/`--force-with-lease`, branch/worktree deletion, the merge surface).
- [ ] 2.2 The guard requires the destructive path to be scoped to the **managed worktree root** or the **reviewed head** (the constraint #223 violated by removing worktrees outside the managed root).
- [ ] 2.3 (If reused) single-source the destructive-operation list as a `DESTRUCTIVE_OPERATIONS` constant in `index.ts` injected via a new `{{placeholder}}`, mirroring `SEVERITY_RUBRIC`; otherwise keep it inline in `fix.md`.

## 3. Pre-commit self-check

- [ ] 3.1 `fix.md`: instruct the harness, before committing/pushing, to compare its diff against the findings and call out (in output, and by withholding the push) any change that appears to introduce a higher-severity issue than the finding it resolves. Conservative-open: document the concern rather than silently proceeding.

## 4. Drift / golden-prompt tests

- [ ] 4.1 `prompt-loader.test.ts`: assert `buildFixPrompt` output contains the minimal-diff discipline; the assertion bites if the instruction is removed.
- [ ] 4.2 Assert `buildFixPrompt` output contains the destructive-operation guard (names a destructive op + the managed-root/reviewed-head scope); the assertion bites if removed.
- [ ] 4.3 Assert `buildFixPrompt` output contains the pre-commit self-check; the assertion bites if removed.
- [ ] 4.4 Confirm no unfilled `{{placeholder}}` remains in the rendered fix prompt (consistent with existing `doesNotMatch(/\{\{[a-zA-Z_]+\}\}/)` assertions).

## 5. Documentation

- [ ] 5.1 `CLAUDE.md` (Review layer & convergence section): document the surgical-fix discipline (minimal diff, destructive-operation guard, self-check) so it is discoverable as the conventions/prompt reference.

## 6. Mirror + CI

- [ ] 6.1 `node scripts/build.mjs` regenerates `plugin/`; commit the regenerated mirror in the same change.
- [ ] 6.2 `npm run ci` green from repo root.
