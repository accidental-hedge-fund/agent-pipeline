## 1. Spec and spine alignment

- [ ] 1.1 Confirm OpenSpec validates: `openspec validate train-loop-ship-path-autonomy --strict` (or project default validate).
- [ ] 1.2 Track child land order on the epic: #1020 + #1025 (parallel) → #1023 → #1021 → dogfood ship; do not implement #1024 / #1030 / #1029 inside this change unless a later scope decision adds them.

## 2. Engine scratch recover (#1020)

- [ ] 2.1 Share or extend the engine-known non-product scratch classifier so challenge-response-class porcelain is scratch-only for recover and block decisions (no broad `artifacts/**` waiver).
- [ ] 2.2 Implement deterministic `unlink_engine_scratch` (or equivalent) that removes/restores only engine-known scratch paths and clears scratch-only `pipeline:blocked`.
- [ ] 2.3 Wire recipe order: unlink-engine-scratch **before** `repair_pipeline_item` on the engine-scratch / workflow-engine path under the autonomous recovery controller.
- [ ] 2.4 Ensure scratch-only porcelain does not set `blocked` / `needs-human` on the paths that currently escalate (#1013-class pre-merge / cleanliness).
- [ ] 2.5 Unit tests: scratch-only → unlink + clearBlocked + no `repair_pipeline_item`; product dirt still blocks; recipe order assertion bites if reversed.

## 3. Stale blocked re-review (#1025)

- [ ] 3.1 On enter pre-merge (single / loop / train advance of already-blocked items), compare blocking `reviewed-sha` S to PR HEAD H.
- [ ] 3.2 When H supersedes S with at least one non-pipeline-internal commit: `clearBlocked` + re-run delta review (or existing full re-review path); no security `--override`.
- [ ] 3.3 Keep verdict when S..H is pipeline-internal-only (#98); keep block when HEAD is still S with residuals.
- [ ] 3.4 Ensure train/loop do not STOP on leftover `blocked` until this resume attempt runs once for the current advance.
- [ ] 3.5 Unit tests with injected deps for: non-internal H clears+re-reviews; HEAD==S stays blocked; internal-only reuses verdict.

## 4. Train∘loop base-eligible frontiers (#1023)

- [ ] 4.1 Add frontier computation: code prereqs integrated (merge-result contained on fetched base); unknown dep kind fails closed as code dep; ownership/conflict serialize unknown overlap.
- [ ] 4.2 Replace production N×`single` advance in train with one injected multi-item loop/advance-wave call per frontier.
- [ ] 4.3 Keep merge wave serial, loop-isolated, squash-aware containment; advance never merges.
- [ ] 4.4 Independent R2D sibling may merge when peer parked and independence proven; fail closed when unproven; blocked item never merges.
- [ ] 4.5 Preserve already-integrated / closed R2D-with-merged-PR idempotency paths.
- [ ] 4.6 Unit tests: one advance-wave call shape; A→B containment before B advance; independent merge while peer parked; concurrency 1 stays serial; no real network/git/subprocess.

## 5. Engine-class live sibling (#1021)

- [ ] 5.1 After first recovered engine-class / engine-scratch fingerprint, file at most one sibling via cross-host-safe auto-file (dedup + rate-cap + reconcile).
- [ ] 5.2 Labels: `bug` + `pipeline:engine-class` + `pipeline:ready` (not backlog); body `Depends on: #<recovered>`; milestone = current train milestone when in scope, else no milestone guess.
- [ ] 5.3 Never trigger on `human-decision-required` or product dirt; never patch victim PR with engine source via this path.
- [ ] 5.4 Prefer train/loop run context from #1023 for milestone; allow explicit milestone argument if context seam lands later.
- [ ] 5.5 Unit tests: one sibling per evidence_key; no duplicate in-window; human/product non-trigger; victim continues to R2D.

## 6. Packaging, CI, and dogfood gate

- [ ] 6.1 After any `core/` edit, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change.
- [ ] 6.2 Run `npm run ci` from repo root; treat red as not-done.
- [ ] 6.3 Dogfood (or scripted replay): `pipeline train --merge --milestone <m>` survives #1013-class scratch and #691-class stale-block without manual unblock/label surgery.
- [ ] 6.4 Confirm code-dep merge barrier and independent sibling merge behaviors against the acceptance criteria in `proposal.md`.
- [ ] 6.5 Archive OpenSpec change at pre-merge when implementation ships (`openspec validate --all` remains green).
