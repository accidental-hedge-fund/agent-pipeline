## 1. Policy lifecycle core

- [x] 1.1 Add pure lifecycle module under `core/scripts/` with closed states, legal transition table, and promotion/retirement predicates (injectable observation aggregates + authority)
- [x] 1.2 Implement append-only lineage records (`policy_id`, from/to state, hashes, authority, evidence_refs, timestamp)
- [x] 1.3 Implement deterministic `policy_hash` inputs for the effective acceptance slice (document included keys in comments/tests)
- [x] 1.4 Unit tests: legal transitions; illegal jump to `enforcing`; rejected promotion without authority/observation; authorized retirement; lineage append-only; enforcing unreachable without lineage event

## 2. Desired-state schema and config

- [x] 2.1 Define versioned `repository_control_desired_state` types (`schema_version: 1`) and closed `risk_class` set
- [x] 2.2 Wire config parse/validate for opt-in staged policies + desired-state block (or referenced file); reject unknown states/risk classes
- [x] 2.3 Unit tests: valid snapshot; unknown risk_class rejected; absent config is no-op (backward compatible)

## 3. Live readers and compare

- [x] 3.1 Add injectable live-state readers via existing `gh` surfaces (required checks, branch protection / rulesets where readable); no forge writes; no new ForgeAdapter type
- [x] 3.2 Implement pure compare → closed outcomes `in_sync` | `drifted` | `unknown` | `unsupported` | `unavailable` with field-level diffs and freshness (`stale` never `in_sync`)
- [x] 3.3 Unit tests: matching fresh → `in_sync`; required-check drift; branch/ruleset drift; permission error → `unavailable`; stale snapshot; unsupported family; equality edge cases

## 4. Fail-open / fail-closed readiness disposition

- [x] 4.1 Implement disposition helper combining lifecycle state + risk class + compare outcome (observe never blocks; enforcing+fail_closed blocks on non-`in_sync`)
- [x] 4.2 Wire disposition into the readiness/pre-merge or finalize path only when desired state is configured (default off)
- [x] 4.3 Unit tests: observe drift records only; enforcing fail_open advisory; enforcing fail_closed blocks; unavailable fail_closed not pass

## 5. Evidence bundle and evidence_subject integration

- [x] 5.1 Record in-scope policies (`policy_id`, state, `policy_hash`) and drift results in `summary.json` / legacy `evidence.json` at finalize
- [x] 5.2 Bind run-scoped drift results to `evidence_subject`; recompute `policy_hash` after promotion/retirement that changes acceptance slice
- [x] 5.3 Unit tests: evidence fields present; policy_hash change invalidates prior subject; standalone check disposition does not claim readiness pass

## 6. Read-only check surface and registry

- [x] 6.1 Add CLI/doctor read-only check that loads desired state, compares live state, supports human + `--json` output
- [x] 6.2 Register command in `COMMAND_REGISTRY` with `mutatesGitHub: false` and allowlisted flags
- [x] 6.3 Unit tests: JSON shape; exit policy for fail-closed; no mutation calls through deps; absent config no-op message

## 7. Escalation inventory

- [x] 7.1 Add escalation-site inventory entry for fail-closed repository-control drift parks (`deliberately-fail-closed`) with typed reason codes
- [x] 7.2 Ensure observation-only drift is not inventoried as a park site and does not auto-remediate
- [x] 7.3 Unit/drift-guard tests for inventory presence and disposition

## 8. CI and mirror

- [x] 8.1 Run targeted `core` unit tests for new/changed modules
- [x] 8.2 Run `openspec validate stage-policy-rollout-and-repo-control-drift` (and strict if used in CI)
- [x] 8.3 Run `npm run ci` from repo root and fix failures
- [x] 8.4 If any `core/` file changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change
