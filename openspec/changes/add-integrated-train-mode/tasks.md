## 1. Spec and policy alignment

- [ ] 1.1 Confirm OpenSpec validates: `openspec validate add-integrated-train-mode --strict` (or project equivalent).
- [ ] 1.2 Draft golden-rule / README wording that lists `pipeline train --merge` as loop-isolated (do not land policy edits until implementation PR if docs gate requires paired code).
- [ ] 1.3 Cross-link `docs/factory-simplification-plan.md` from README or factory docs so pilot plan is marked superseded for startup.

## 2. CLI surface

- [ ] 2.1 Add `train` to the command registry with explicit allowed flags (`--issues`, `--milestone`, `--merge`, `--json`, `--repo-path`, `--base`, `--profile`, status flags as needed).
- [ ] 2.2 Wire `pipeline train` handler in the CLI entrypoint with allowlist rejection before mutation.
- [ ] 2.3 Add usage/help text and host skill mention (non-advance surface).

## 3. Work-list resolution

- [ ] 3.1 Resolve explicit `--issues` lists with canonical issue ids.
- [ ] 3.2 Resolve `--milestone` via existing discovery + declared-dependency ordering (#905).
- [ ] 3.3 Refuse cycles and empty work lists with fail-visible errors.
- [ ] 3.4 Unit tests for ordering, cycles, and selector validation (deps injected; no network).

## 4. Advance composition (no merge)

- [ ] 4.1 Drive each item through existing single/advance path to ready-to-deploy or park.
- [ ] 4.2 Stop train on needs-human / typed blocker with status payload.
- [ ] 4.3 Unit tests for non-merge train sequencing and park stop.

## 5. Merge integration wave

- [ ] 5.1 After ready-to-deploy, resolve exactly one linked PR; fail closed on zero or many ambiguous candidates.
- [ ] 5.2 Invoke shared merge implementation used by `pipeline merge` (same gates).
- [ ] 5.3 Observe merge-result commit; fetch base; prove squash-aware containment.
- [ ] 5.4 Enforce capacity 1 between integrate steps.
- [ ] 5.5 Idempotent path for already-merged + contained PR.
- [ ] 5.6 Unit tests: containment, non-ancestor PR head, gate failure stop, double-merge avoidance, dependent not started early.

## 6. Status, events, restart

- [ ] 6.1 Persist thin train run identity pointing at issue/PR/merge evidence (no second stage ledger).
- [ ] 6.2 Implement `train status --json` (or equivalent) with current item, next action, blocker.
- [ ] 6.3 Emit observational train events compatible with existing event/notify patterns.
- [ ] 6.4 Restart reconcile from GitHub + Pipeline truth; ownership split fails closed.
- [ ] 6.5 Unit tests for resume-after-merge and ambiguous ownership.

## 7. Isolation and CI

- [ ] 7.1 Extend advance-loop isolation tests so train may call merge but advance/stages may not.
- [ ] 7.2 Registry allowlist cross-check includes `train`.
- [ ] 7.3 Run `npm run ci` from repo root; regenerate plugin/docs if required by generators.
- [ ] 7.4 Open PR targeting `main` with OpenSpec change included.

## 8. Follow-on (out of this change, track only)

- [ ] 8.1 Engine resume / ownership GC prerequisites (plan-review process death) — separate issue or PR if not already fixed.
- [ ] 8.2 Phase 2 thin Hermes skill calling `pipeline train` / `pipeline single`.
- [ ] 8.3 Phase 3 release finish surface.
- [ ] 8.4 Retriage #901/#765 to this change; park #890-family comments on GitHub when ready.
