## 1. Spec and policy alignment

- [x] 1.1 Confirm OpenSpec validates: `openspec validate add-integrated-train-mode --strict`.
- [x] 1.2 Loop-isolated wording: train is operator-authorized; advance never merges (command-docs, host skills, factory simplification plan).
- [x] 1.3 `docs/factory-simplification-plan.md` on `main` (via #921); pilot marked historical.

## 2. CLI surface

- [x] 2.1 Add `train` to the command registry with allowed flags (`--issues`, `--milestone`, `--merge`, `--json`, `--repo-path`, `--base`, `--profile`, `--dry-run` rejected).
- [x] 2.2 Wire `pipeline train` handler in the CLI entrypoint with allowlist rejection before mutation.
- [x] 2.3 Usage/help text and host skill mention (generated CLI table).

## 3. Work-list resolution

- [x] 3.1 Resolve explicit `--issues` lists with canonical issue ids (`parseIssueList`).
- [x] 3.2 Resolve `--milestone` via `gh issue list --milestone` + declared-dependency ordering (#905 grammar + `compileContractItems`).
- [x] 3.3 Refuse cycles and empty work lists with fail-visible errors.
- [x] 3.4 Unit tests for ordering, cycles, and selector validation (deps injected; no network).

## 4. Advance composition (no merge)

- [x] 4.1 Drive each item through existing `pipeline single` path to ready-to-deploy or park.
- [x] 4.2 Stop train on needs-human / blocked with status payload.
- [x] 4.3 Unit tests for non-merge train sequencing and park stop.

## 5. Merge integration wave

- [x] 5.1 After ready-to-deploy, resolve linked PR via existing `getPrForIssue`; fail closed when missing.
- [x] 5.2 Invoke shared `mergePr` (same gates as `pipeline merge`).
- [x] 5.3 Observe merge-result commit; fetch base; prove squash-aware containment (`merge-base --is-ancestor`).
- [x] 5.4 Enforce serial capacity (one item at a time).
- [x] 5.5 Idempotent path for already-merged + contained PR.
- [x] 5.6 Unit tests: containment stop, double-merge avoidance, dependent not started early.

## 6. Status, events, restart

- [x] 6.1 Thin in-process train status (no second stage ledger); GitHub is source of truth for labels/PR merge.
- [x] 6.2 Emit `train_status` JSON via `--json` (current items, next action, blocker, complete).
- [ ] 6.3 Optional: stream observational train events into existing event-sink patterns (follow-up).
- [x] 6.4 Restart: re-read issue/PR/base on each run; already-integrated items skip merge; ownership fail-closed for advance is delegated to `pipeline single`.
- [x] 6.5 Unit tests for resume-after-merge (already-integrated) and containment failure.

## 7. Isolation and CI

- [x] 7.1 Isolation tests: train may call merge; advance stage handlers and `dispatch()` must not.
- [x] 7.2 Registry allowlist cross-check includes `train`.
- [x] 7.3 `npm run ci` green; plugin/docs regenerated.
- [x] 7.4 PR #922 targets `main` with OpenSpec change included (this commit).

## 8. Follow-on (out of this change, track only)

- [ ] 8.1 Engine resume / ownership GC prerequisites (plan-review process death) — separate issue or PR.
- [ ] 8.2 Phase 2 thin Hermes skill calling `pipeline train` / `pipeline single`.
- [ ] 8.3 Phase 3 release finish surface.
- [ ] 8.4 Retriage #901/#765 to this change; park #890-family on GitHub when ready.
