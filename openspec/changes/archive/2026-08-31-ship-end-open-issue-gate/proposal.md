## Why

After merge-mode train completes, in-engine `pipeline ship --milestone` starts Factory Reliability Gate (FRG) pack, release, and promote from freeze-eligible integration. Freeze-eligible membership is not proof that the GitHub milestone has no remaining open issues. A `pipeline:backlog` label (or any other pipeline label) does not close that gap.

Site of discovery: `pipeline ship --milestone v1.40.1` after #1340. Train freeze listed `#1340` only. Train completed at `c23981173cd2`. Ship started FRG pack (`factory-release prepare`, pack loop `loop-718dff2965daf126`, fixtures #1352 / #1353) while #1344, #1348, #1349, #1350, #1305, and #977 remained open on that milestone (all `pipeline:backlog`).

This is a class fix, not a path-local mole. The class is: post-train ship proceeds from freeze-eligible integration rather than GitHub remaining-open work. The next leftover-open-issue on any later ship milestone hits this same gate. A new mole issue is not required.

**Conflict (do not average):** living `openspec/specs/integrated-train-mode/spec.md` currently requires proceeding to FRG when every freeze-eligible item is integrated. Grill-settled CONTEXT terms `freeze-eligible` and `ship-end-open-issue-gate` define freeze-eligible as train membership only and require a GitHub remaining-open check at every post-train FRG, release, and promotion boundary. Current `CONTEXT.md` does not yet contain those two terms. This change writes them as settled and aligns ship behavior and the living specs with that law.

## What Changes

- Add a shared **ship-end-open-issue-gate** on the ship coordinator. After train is complete or resumed complete, every post-train boundary that can start or resume `factory-release prepare`, FRG pack, FRG convergence, release, or `engine-promote` re-observes GitHub immediately before the operation.
- Count every GitHub issue with `state: open` on the ship milestone. Do not count pull requests. Do not count closed issues. Do not count unmilestoned issues (including unmilestoned engine-filed factory-gate pack issues). Pipeline labels do not exempt an open milestoned issue. A pack fixture that is on the ship milestone and still open counts until the operator unmilestones or closes it. This change does not close #1352 or #1353.
- Fail closed when at least one remaining open issue exists. The message names the milestone and every remaining open issue number, with no cap that drops numbers.
- Fail closed when GitHub auth, the query, parse, or pagination cannot prove that zero open issues remain. Use the existing `gh` credential path. Do not add a secret. Do not classify a skipped gate as an engine defect that recovery should bypass.
- Do not persist a gate pass. Restart and resume re-observe GitHub. A prior train freeze snapshot is not the remaining-open set.
- Keep train freeze-eligible membership unchanged: open non-backlog pipeline issues plus closed `pipeline:ready-to-deploy`. This issue does not change which issues train advances.
- Keep merge authorization unchanged. Advance and loop still never merge. Ship merge-mode train keeps current operator-authorized merge behavior.
- Keep `--skip-frg` out of this cut. There is no skip flag, label waiver, or human attestation that starts FRG, release, or promote while the milestone still has open issues.
- Align living specs and ship-path docs so freeze-eligible integration is not sufficient to start FRG, release, or promote. Write CONTEXT terms `freeze-eligible` and `ship-end-open-issue-gate` as settled.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `ship-coordinator`: After train completes, in-engine `pipeline ship --milestone` SHALL run the remaining-open check immediately before every post-train FRG, release, and promote boundary. Fail closed on leftover open issues or inability to prove zero. Restart and resume re-observe. A persisted pass SHALL NOT authorize a later boundary.
- `integrated-train-mode`: Freeze-eligible integration SHALL remain train membership and SHALL NOT authorize FRG, release, or promote. The all-closed ready-to-deploy / already-integrated freeze path from #1252 SHALL still reach train merge-mode. Ship SHALL proceed to FRG only when the remaining-open check also proves zero open issues on that milestone.
- `factory-reliability-gate`: Runbook and supervisor ship text SHALL stop treating all-integrated freeze as authorization to start FRG. They SHALL document the remaining-open check as a fail-closed ship-end gate.
- `tugboat-thin-ship`: Tugboat SHALL invoke the same remaining-open check immediately before it starts or resumes `factory-release prepare`, FRG pack, FRG convergence, release, or `engine-promote`. It SHALL NOT keep a second, skippable policy.

## Acceptance criteria

- [ ] After merge-mode train completes, in-engine `pipeline ship --milestone` re-observes open GitHub issues on that milestone. The query lists issues, not pull requests.
- [ ] WHEN at least one of those issues has `state: open`, ship fails closed before `factory-release prepare` / FRG pack. Ship does not start release. Ship does not start `engine-promote`.
- [ ] The fail-closed message names the milestone and every remaining open issue number. A pipeline label (`pipeline:backlog`, `pipeline:ready`, `blocked`, or any other) does not exempt an open issue.
- [ ] WHEN the milestone has no remaining open issues, ship still proceeds to FRG after freeze-eligible items are integrated. The all-closed ready-to-deploy / already-integrated path from #1252 stays.
- [ ] Train freeze-eligible membership stays as it is: open non-backlog pipeline issues plus closed `pipeline:ready-to-deploy`. This issue is a ship-end gate. It is not a change to which issues train advances.
- [ ] Engine-filed factory-gate pack issues with no milestone do not count as remaining milestone work. They are products of the pack.
- [ ] An engine-filed factory-gate pack issue that is on the ship milestone and still open does count. The operator unmilestones or closes it. This issue does not close #1352 or #1353.
- [ ] Ship runs the same remaining-open check immediately before every post-train boundary that can start or resume `factory-release prepare`, FRG pack, FRG convergence, release, or `engine-promote`. Restart and resume re-observe GitHub. A previously persisted pass does not authorize a later boundary.
- [ ] The milestone issue query paginates to exhaustion. It fails closed on query, parse, or pagination failure. It excludes pull requests. It excludes unmilestoned engine-filed factory-gate fixtures.
- [ ] The next leftover-open-issue on any later ship milestone hits this same gate. A path-local skip in one coordinator branch is not enough.
- [ ] Unit tests inject a leftover open backlog issue after a completed train and fail if FRG pack or FRG convergence runs. Separate boundary tests fail if blocked release or `engine-promote` invokes its operation. Additional tests prove restart/resume re-observation, pull-request exclusion, pagination and query-failure behavior, unmilestoned fixture exclusion, and the no-open-issues path proceeding to FRG. Tests inject I/O. Tests make no real network, git, or subprocess calls.
- [ ] `npm run ci` passes.

## Impact

- `core/scripts/stages/ship.ts` — shared remaining-open check on the coordinator `run()` wrapper before post-train phases (same place as the live authorization re-check).
- `core/scripts/stages/ship-adapter.ts` — real GitHub listing for the injected seam.
- `core/scripts/stages/merge_queue.ts` — reuse existing `listMilestoneOpenIssuesApiArgs` / `parseMilestoneIssuesPages` (paginate to exhaustion, drop PRs). Do not invent a second listing path or restore `gh issue list --limit`.
- `core/test/ship.test.ts` (and adapter tests as needed) — hermetic remaining-open matrix.
- `CONTEXT.md` — write `freeze-eligible` and `ship-end-open-issue-gate`.
- `openspec/specs/integrated-train-mode/spec.md`, `ship-coordinator`, `factory-reliability-gate`, `tugboat-thin-ship` — living-spec alignment.
- `docs/factory-reliability-gate-runbook.md`, `docs/supervisor.md`, `docs/runbooks/ship-milestone.md` — stop treating freeze-eligible integration as FRG authorization.
- Train freeze listing (`MILESTONE_ISSUE_DISCOVERY_LIMIT` / `selectFreezeEligibleIssues`) stays as it is.
- No new CLI verb, skip flag, persisted gate-pass field, grant file, or merge-authorization change.
- After any `core/` edit, `node scripts/build.mjs` so host SKILL freshness stays current.
