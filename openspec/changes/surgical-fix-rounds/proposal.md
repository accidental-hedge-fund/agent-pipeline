## Why

Part of adversarial-review churn is genuinely *the fixer's fault*, not the reviewer's: a fix round introduces a worse defect than the one it resolves, and the next adversarial round correctly blocks on it. The severity *escalates* across rounds (MED → HIGH) specifically because the fix over-reached.

- **#223**: the fix that broadened detached-worktree *discovery* also made the reclaim path `git worktree remove --force` worktrees **outside the managed root** — a HIGH-severity, verified data-loss defect (`29db8fd3`).
- **#214**: a fix-1 lock change introduced a **first-run ENOENT crash** (`ec30abb8`, HIGH) because the lock was acquired before the output directory existed.

The current `fix.md` has a single weak guardrail — "Do NOT change anything unrelated to the review findings" — buried as step 3, with no discipline around *minimal* diffs and no special handling for destructive/irreversible operations. A surgical, finding-scoped fix discipline plus a destructive-operation guard would prevent the new surface area at fix time, which is strictly cheaper than catching it on the next review round.

## What Changes

- **`core/scripts/prompts/fix.md`** — promote and strengthen the discipline so the fix harness makes the **minimal diff that resolves the specific finding**: no refactors, no broadening of scope, no unrelated changes, no opportunistic cleanup. This becomes a prominent, leading instruction rather than a buried step-3 line.
- **`core/scripts/prompts/fix.md`** — add a **destructive-operation guard**: when a fix diff touches known destructive/irreversible operations (`git worktree remove --force`, `git push --force`/`--force-with-lease`, branch/worktree deletion, the merge surface), the prompt requires an explicit safety guard or justification scoped to the **managed worktree root** or the **reviewed head** — the fixer may not widen the blast radius of a destructive path while fixing an unrelated finding.
- **`core/scripts/prompts/fix.md`** — add a cheap, prompt-level **pre-commit self-check**: before committing/pushing, the harness compares its own diff against the findings it was given and calls out (in its output, and by not pushing) any change that appears to introduce a *higher-severity* problem than the finding it resolves.
- **`core/scripts/prompts/index.ts`** — if the destructive-operation list is best single-sourced (mirroring `SEVERITY_RUBRIC`), add a constant injected via a new `{{placeholder}}`; otherwise the discipline lives inline in `fix.md`.
- **`core/test/prompt-loader.test.ts`** — golden-prompt/drift assertions over `buildFixPrompt` output so the surgical-fix instruction, the destructive-operation guard, and the self-check cannot silently regress.
- **`CLAUDE.md`** (Review layer & convergence section) — document the surgical-fix discipline so it is discoverable in the conventions/prompt reference.

This is **prevention at fix time**. It does not add a new stage, does not re-review fix diffs (the #16 SHA-gate already re-reviews on push), and does not change the state-machine edges or the review schema.

## Acceptance criteria

- [ ] `buildFixPrompt` output instructs the harness to make the **minimal diff that resolves the specific finding** — explicitly forbidding refactors, scope-broadening, unrelated changes, and opportunistic cleanup.
- [ ] When a fix would touch a destructive/irreversible operation (e.g. `worktree remove --force`, `git push --force`, branch/worktree deletion, the merge surface), the prompt requires an explicit guard or justification scoped to the managed worktree root or the reviewed head.
- [ ] The fix prompt instructs a pre-commit self-check that compares the diff against the findings and flags (without pushing) any change that appears to introduce a higher-severity issue than the finding it fixes.
- [ ] Golden-prompt/drift tests over `buildFixPrompt` assert the surgical-fix discipline, the destructive-operation guard, and the self-check are present; each assertion bites (fails) if the corresponding instruction is removed.
- [ ] The surgical-fix discipline is documented in `CLAUDE.md` (Review layer & convergence section) as the conventions/prompt reference.
- [ ] `node scripts/build.mjs` regenerates the `plugin/` mirror in the same change and `npm run ci` is green.

## Capabilities

### New Capabilities
- `surgical-fix-rounds`: The review fix prompt enforces minimal finding-scoped diffs, guards destructive/irreversible operations behind explicit scope/justification, and self-checks the diff for fix-introduced severity escalation before pushing — all covered by drift tests.

## Impact

- `core/scripts/prompts/fix.md` — strengthened discipline, destructive-operation guard, pre-commit self-check.
- `core/scripts/prompts/index.ts` — optional single-sourced constant + placeholder for the destructive-operation list.
- `core/test/prompt-loader.test.ts` — new drift/golden assertions over `buildFixPrompt`.
- `CLAUDE.md` — documents the discipline.
- `plugin/` — regenerated mirror.
- No changes to the state-machine edges, the review schema, the SHA gate, or any other stage. The freeform (non-OpenSpec) path is unaffected — the discipline applies to every fix round regardless of OpenSpec.
