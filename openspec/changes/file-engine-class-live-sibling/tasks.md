## 1. Inventory epic first cut vs #1021 acceptance

- [ ] 1.1 Confirm living filer module (`engine-class-live-sibling`) provides: provenance marker, labels `bug` + `pipeline:engine-class` + `pipeline:ready`, body `Depends on: #<N>`, pre-create evidence_key dedup, post-create title/key + rate-cap reconcile, no milestone invent when milestone omitted.
- [ ] 1.2 Confirm recover coupling: only successful engine-scratch recover (e.g. `unlink_engine_scratch`) best-effort invokes the filer; product dirt / `human-decision-required` paths do not call it.
- [ ] 1.3 Confirm train exposes current milestone into filer context (`pipeline train --milestone`) and clears it when the train invocation ends.
- [ ] 1.4 Record any gap against proposal acceptance (missing negative tests, shared rate-cap budget leakage, fatal sibling failure, missing Depends on, wrong labels, milestone guess).

## 2. Close filer contract gaps

- [ ] 2.1 Ensure labels never include `pipeline:backlog` on the live-sibling path; papercut / correction / durable-run-blocker paths remain backlog-only.
- [ ] 2.2 Ensure rate-cap membership is marker-scoped and does not consume papercut / correction / durable-run-blocker open-issue budgets.
- [ ] 2.3 Ensure no-milestone path creates without inventing a title from open milestones or improve-suggestion prose.
- [ ] 2.4 Ensure sibling create/list/reconcile failures are non-fatal relative to recover success (no reverse of clear-blocked solely for file failure).

## 3. Recover and train coupling

- [ ] 3.1 Wire or verify: successful engine-class recover → filer call with recovered issue number, stable `evidence_key`, and train milestone when in scope.
- [ ] 3.2 Ensure non-engine recover / human-authority / product-dirt outcomes never invoke the filer.
- [ ] 3.3 Ensure train does not STOP solely because recover cleared a mechanical `blocked` or because a sibling was filed/skipped (depends on #1020 clear + train blocked disposition; no new STOP on sibling alone).
- [ ] 3.4 Never auto-merge and never apply review override from this path.

## 4. Unit regressions

- [ ] 4.1 File one sibling for fresh `evidence_key` with train milestone: labels ready+engine-class+bug, milestone set, body has marker + `Depends on: #<recovered>`.
- [ ] 4.2 Second identical `evidence_key` in-window: no second create (dedup and/or post-create reconcile).
- [ ] 4.3 No milestone: create without milestone field; do not invent one.
- [ ] 4.4 Rate-cap overflow / cross-host overshoot: post-create keeps lowest-numbered open survivors.
- [ ] 4.5 Recover-path coupling test (injectable deps): successful `unlink_engine_scratch` (or equivalent) invokes filer once; filer throw does not flip recover to failed / re-block.
- [ ] 4.6 Negative: product dirt / `human-decision-required` path does not call filer and does not assign a milestone.
- [ ] 4.7 All unit tests stay injectable (no real network, git, or subprocess).

## 5. Mirror, validate, CI

- [ ] 5.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [ ] 5.2 Run `openspec validate file-engine-class-live-sibling` (and `openspec validate --all` as needed) until clean.
- [ ] 5.3 Run `npm run ci` from the repo root and fix failures until green.
