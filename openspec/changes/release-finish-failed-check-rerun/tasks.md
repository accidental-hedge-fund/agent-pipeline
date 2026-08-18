## 1. Shared wait helper

- [ ] 1.1 Extend `examples/supervisor/shell/release-checks-green.py` (or add one sibling helper) so a `gh pr checks` capture classifies as `green` / `pending` / `rerun` / `fail` with pending-first over the whole set
- [ ] 1.2 Implement the flake-eligible allowlist (default `test`) and treat mixed or non-test product fails as `fail`
- [ ] 1.3 On `rerun` or `fail`, write a structured sidecar with PR (when supplied), check name, bucket/state, and `link`
- [ ] 1.4 Keep existing `1` / `0` / `-1` meanings stable if numeric tokens remain; add a distinct rerun token
- [ ] 1.5 If a new sibling helper is added, add it to `OPTION1_CRITICAL_PACK_IDS` and the documented install loop

## 2. Composer adoption

- [ ] 2.1 Update Tugboat’s release-finish wait to request `name,state,bucket,link`, call the shared helper, and on `rerun` invoke `gh run rerun --failed <id>` then resume the loop
- [ ] 2.2 Persist rerun budget (default 1, max 2) in the ship run dir keyed by PR + head SHA; do not rerun without recording the attempt
- [ ] 2.3 Apply the same wait, field set, rerun, and budget behavior in `pipeline-ship-playbook.sh` C0
- [ ] 2.4 Update Tugboat and playbook `failure_detail` so release-finish prefers the checks sidecar and does not lead with `tester-evidence` or `trusted-surface blocked`
- [ ] 2.5 Confirm `find_open_release_pr` still reuses an existing open release PR after a prior waiter STOP

## 3. Regression tests

- [ ] 3.1 Add helper fixtures: sole `test` fail → `rerun`; non-test fail → `fail`; mixed fail → `fail`; pending+fail → `pending`; all pass → `green`
- [ ] 3.2 Add a first-fail-then-pass fixture (one rerun, then green → proceed). Prove it fails if the waiter still STOPs on the first `test` fail
- [ ] 3.3 Add a budget-exhausted fixture: second `test` fail after one rerun → STOP; detail includes check name and run URL; detail does not lead with `tester-evidence` / `trusted-surface`
- [ ] 3.4 Add a `failure_detail` fixture whose log contains a leftover tester-evidence warn and whose sidecar names `test` + run URL; assert the sidecar wins
- [ ] 3.5 Update Tugboat and playbook field-schema tests so `--json` includes `bucket` and `link` and still rejects `conclusion`
- [ ] 3.6 Static-assert both composers call the shared helper and do not treat raw helper `-1` as immediate `exit 1` when the recipe still says `rerun`

## 4. Validate and ship the change

- [ ] 4.1 Run `openspec validate release-finish-failed-check-rerun` and fix structural errors
- [ ] 4.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [ ] 4.3 Run targeted tests (`release-checks-green`, `tugboat`, playbook field schema) then `npm run ci` from repo root
- [ ] 4.4 Note agent-box post-merge refresh of Tugboat + `release-checks-green.py` (and any new sibling) in the PR body
