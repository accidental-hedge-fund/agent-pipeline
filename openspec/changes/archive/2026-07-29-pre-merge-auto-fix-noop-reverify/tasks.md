## 1. Outcome shape and durable attempt marker

- [x] 1.1 Add a discriminated pre-merge auto-fix outcome for confirmed clean no-commit (e.g. `noop-clean`) distinct from `error` and `fix-committed`, carrying the #553 worktree diagnostic.
- [x] 1.2 Thread the outcome through `performPreMergeAutoFix` / `attemptPreMergeAutoFix` seams so unit tests can inject it without parsing free-text diagnostics.
- [x] 1.3 Define and implement a trusted durable prior-attempt marker for noop-clean at a head SHA (comment sentinel or equivalent surviving restart/host switch) and include it in the one-attempt bound scan alongside `PRE_MERGE_AUTOFIX_PREFIX` commits.

## 2. Clean-noop re-verify path

- [x] 2.1 On `noop-clean`, re-enter delta verification (or equivalent deterministic HEAD check) once against the unchanged head; do not invoke the implementer harness again.
- [x] 2.2 On re-verify approve / no blocking findings: return from the SHA gate without `setBlocked`; record evidence of no-op already-fixed / false-positive.
- [x] 2.3 On re-verify still blocking: `setBlocked`/`needs-human` once with the still-broken recipe (auto-fix made no diff; finding still present at path).
- [x] 2.4 On re-verify unavailable/unparseable/currency unknown: fail closed (conservative re-review or needs-human) — never approve solely because the auto-fix was a no-op.
- [x] 2.5 Preserve dirty/timeout/salvage paths unchanged (#547); preserve pre-dirty fail-closed; preserve post-commit re-review path (#371).

## 3. Delta HEAD-truth for classification claims

- [x] 3.1 Ensure re-verify (and/or a cheap injectable HEAD assertion for pure classification/control-flow findings) does not leave a finding blocking when cited HEAD code already implements the recommended behavior and no contradictory executable evidence exists (#683-class).
- [x] 3.2 Keep findings that cite current-file evidence of still-wrong behavior subject to normal severity/confidence policy.

## 4. Block comment / disclosure quality

- [x] 4.1 Keep #553 worktree-path disclosure on clean no-commit.
- [x] 4.2 Ensure still-broken no-op block text includes no-diff + still-present recipe; ensure re-verify-clean does not leave blocking authority for the no-op alone.

## 5. Tests (injected seams, no live I/O)

- [x] 5.1 Unit test: noop-clean → re-verify approve → no `setBlocked`, pre-merge proceeds; bites if re-verify is skipped.
- [x] 5.2 Unit test: noop-clean → re-verify still blocking → one needs-human with recipe; no second auto-fix.
- [x] 5.3 Unit test: durable noop-clean marker / prior attempt exhausts auto-fix without a second harness invoke.
- [x] 5.4 Regression fixture: #683-class stale classification already correct on HEAD does not hard-block when re-verify/HEAD check is clean.
- [x] 5.5 Update any tests that currently expect immediate `error` → block on clean no-commit to match the new disposition, while still asserting disclosure and dirty-path salvage.

## 6. Optional loop schedule hygiene

- [x] 6.1 When live labels include `pipeline:blocked` without an unblock path, reconciliation `next_actions` MUST NOT be actionable `advance` (hold/waiting/unblock-oriented instead).
- [x] 6.2 Unit test for blocked-item next_action; skip or follow-up only if deferred deliberately with proposal optional AC noted.

## 7. Mirror, validate, gate

- [x] 7.1 After any `core/` edit, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change.
- [x] 7.2 Run `openspec validate pre-merge-auto-fix-noop-reverify` (and `openspec validate --all` when touching living specs at archive time).
- [x] 7.3 Run `npm run ci` from repo root; fix failures before done.
