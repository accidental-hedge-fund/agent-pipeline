## 1. Remaining-open helper (reuse merge-queue listing)

- [x] 1.1 Add a pure remaining-open fail-closed helper that takes a milestone title and an injected open-issue list (numbers only). Verify it throws naming the milestone and every issue number with no truncation, and that an empty list does not throw
- [x] 1.2 Reuse `listMilestonesApiArgs`, `findMilestoneNumberByTitle`, `listMilestoneOpenIssuesApiArgs`, and `parseMilestoneIssuesPages` for live listing. Verify unresolved milestone title, parse failure, and listing throw fail closed rather than returning an empty remaining-open set
- [x] 1.3 Verify pull-request rows (`pull_request` present) are dropped and unmilestoned issues never appear (milestone query only). Verify pagination fixtures retain issues past the first page. Inject I/O; no real `gh`

## 2. Ship coordinator gate at every post-train boundary

- [x] 2.1 Inject remaining-open observation on `ShipCoordinatorDeps`. Call it from the existing coordinator `run()` wrapper immediately before `frg_pack`, `frg_score`, `release_prepare`, `release_finish`, and `engine_promote`. Verify train is not gated
- [x] 2.2 Add a hermetic test that seeds a completed train plus a leftover open `pipeline:backlog` issue and fails if `convergeFrgPack` or `convergeFrgScore` runs
- [x] 2.3 Add separate boundary tests that fail if blocked `convergeReleasePrepare` / `convergeReleaseFinish` or `convergeEnginePromote` runs while leftover open issues remain
- [x] 2.4 Add a resume test: prior remaining-open pass and completed FRG pack, then leftover open issues on re-invoke. Verify the next post-train operation does not run. Verify each post-train phase re-observes (no persisted pass)
- [x] 2.5 Add the no-open-issues path: completed train, empty remaining-open list, FRG pack is invoked. Verify freeze-eligible membership / `planTrain` is unchanged
- [x] 2.6 Wire the real listing in `ship-adapter.ts` to the helper from 1.2. Verify adapter tests inject deps and still make no real network, git, or subprocess calls

## 3. Leaf verbs so Tugboat cannot skip the class

- [x] 3.1 Invoke the same remaining-open helper at the start of `factory-release prepare` when the request milestone is known (`request.milestone` or `v${target_version}`). Verify an injected leftover open issue fails closed before pack-loop start
- [x] 3.2 Invoke the same helper at the start of `pipeline release` and `engine-promote` when the ship milestone is known as `v${version}`. Verify blocked fixtures do not invoke release mutation or promote install
- [x] 3.3 Verify Tugboat's post-train path has no skippable local remaining-open policy (no Tugboat-only empty-list fallback, no `--skip-frg` for leftover open issues). Source or helper-call test is enough if leaf verbs own the check

## 4. Docs and CONTEXT alignment

- [x] 4.1 Write CONTEXT terms `freeze-eligible` and `ship-end-open-issue-gate` under Ship path using the grill-settled definitions. Verify freeze-eligible is train membership only and the remaining-open check blocks every post-train FRG, release, and promotion boundary
- [x] 4.2 Update `docs/factory-reliability-gate-runbook.md`, `docs/supervisor.md`, and `docs/runbooks/ship-milestone.md` so freeze-eligible integration is not authorization to start FRG. Verify leftover open issues (including `pipeline:backlog`) are documented as fail-closed before FRG / release / promote
- [x] 4.3 Keep train freeze listing (`selectFreezeEligibleIssues`, `MILESTONE_ISSUE_DISCOVERY_LIMIT`) unchanged. Verify existing all-integrated freeze tests still pass

## 5. Gate and CI

- [x] 5.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated host SKILL output in the same change
- [x] 5.2 Run `openspec validate ship-end-open-issue-gate` and `npm run ci` from the repo root. Fix failures until green
