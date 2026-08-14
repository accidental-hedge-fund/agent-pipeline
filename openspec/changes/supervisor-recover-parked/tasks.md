## 1. Inventory and seams

- [ ] 1.1 Map current park paths: review ceiling → needs-human/blocked, pre-merge residual delta block, leftover `blocked` after HEAD move, engine-scratch false parks.
- [ ] 1.2 Identify reusable entrypoints for deterministic recover (`unlink_engine_scratch` / engine-scratch path, stale-blocked re-review), audited `pipeline override` record path, implementer fix round, and `pipeline single` re-enter.
- [ ] 1.3 Confirm structured finding fields used for eligibility (`severity`, `category`, override-key / `findingKey`) and where residual sets are loaded at live HEAD.
- [ ] 1.4 Choose fingerprint marker storage (issue sentinel vs run-state) that supports one-pass budget and deps-injected unit tests.

## 2. Pure eligibility and fingerprint budget

- [ ] 2.1 Implement pure classification: structured-record non-overridable (HIGH/CRITICAL/security/human-decision-required) vs eligible (stale/DNR/below-high); prose must not unlock override.
- [ ] 2.2 Implement fingerprint `(issue, stage, sorted blocking override-keys)` spend/refuse helpers; same keys after new commit do not reset budget; deterministic-only clear does not spend senior budget.
- [ ] 2.3 Implement override payload builder: finding key + closed evidence reason (`stale` | `DNR` | `below-high`); refuse keyless/prose-only.

## 3. recover-parked command

- [ ] 3.1 Register `recover-parked` in the command registry with docs metadata, needs-issue, allowedFlags, non-merge classification.
- [ ] 3.2 Wire CLI handler: deterministic recover first → classify at live HEAD → audited overrides for eligible keys only → optional one fix round for non-overridable → re-evaluate → re-enter `single` or keep park + notify.
- [ ] 3.3 Ensure overrides call existing audited override path (governed validity / ledger); no label side door.
- [ ] 3.4 Refuse override of non-overridable keys even if an internal step requests them; fail closed on unreadable HEAD/PR.
- [ ] 3.5 Idempotent refuse when fingerprint already spent.

## 4. Train and outer-host hooks

- [ ] 4.1 Train: after deterministic enter-path resume, on `needs-human` / leftover `blocked`, invoke recover-parked once per fingerprint; if still parked apply today's hold/STOP + notify; continue independent peers under existing rules.
- [ ] 4.2 Ensure train does not call override directly, drop labels, or add a train-local senior recoverer.
- [ ] 4.3 Update ship-path / supervisor docs (and Tugboat guidance if present) so residual parks use recover-parked once or STOP — no host-invented override.
- [ ] 4.4 Host packaging: add `pipeline:recover-parked` to namespaced command surface / single-source operation list; forward only to CLI.

## 5. Unit tests (injected deps only)

- [ ] 5.1 Fixture: stale/DNR/below-high park → override + single re-enter; no backlog restart.
- [ ] 5.2 Fixture: structured CRITICAL (and HIGH/security) remains parked; no override for those keys.
- [ ] 5.3 Fixture: structured CRITICAL + prose "nit" still refuses override.
- [ ] 5.4 Fixture: same sorted keys after new commit refuse second supervisor pass.
- [ ] 5.5 Fixture: scratch-only / stale-SHA park clears via deterministic path without override and without spending senior fingerprint.
- [ ] 5.6 Fixture: extra fix may commit for HIGH/CRITICAL; override of those keys refused; residuals after fix keep park.
- [ ] 5.7 Fixture: second identical fingerprint is idempotent refuse.
- [ ] 5.8 Fixture: train hook invokes recover-parked once then STOP/hold if still parked; never invents override.
- [ ] 5.9 Registry allowlist / lookup tests for `recover-parked`; host surface includes entry if packaging changed.
- [ ] 5.10 All new tests use deps injection — no real network, git, or subprocess.

## 6. Mirror, validate, CI

- [ ] 6.1 After any `core/` or host packaging edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit when required.
- [ ] 6.2 Run `openspec validate supervisor-recover-parked` (and `openspec validate --all` as needed) until clean.
- [ ] 6.3 Run `npm run ci` from the repo root and fix failures until green.
