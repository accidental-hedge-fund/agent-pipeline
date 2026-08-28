## Why

In merge mode, `pipeline train` treats one contained per-item hold as a whole-train STOP and never starts remaining independent issues. On v1.39.13, `train --merge --issues "279,269,268,267,266,264,263"` merged the first two, held #268, and never started #267, #266, #264, or #263, even though none depended on #268. The same abandonment fired again when #268 ended `waiting` (CI still running). A multi-hour unattended ship therefore delivered 2 of 7 selected issues, and the JSON result (`complete: false` plus a `blocker` string) did not list the skipped issues.

## What Changes

- Merge-mode train SHALL hold a contained blocked, parked, waiting, or otherwise non-ready item and SHALL continue independent remaining work. It SHALL NOT abort the selected set with `will not implement another sibling` solely because one item is held.
- Independent means no direct or transitive `Depends on` path from the remaining item to a held item. Direct and transitive dependents SHALL be held as `dependency-skipped` and SHALL NOT advance or merge.
- Train SHALL resolve the selected issue set once at start. It SHALL NOT admit newly filed issues (including engine-class live siblings) into that run.
- After a contained hold, train SHALL still merge every eligible independent ready-to-deploy item, then exit non-zero while any item remains held.
- The structured `train_status` result SHALL enumerate every selected issue and SHALL separately report completed, held, and dependency-skipped items. A caller SHALL NOT need to parse blocker prose to learn which issues never started.
- Merge-first, serial merge, base containment, and "advance never merges" stay in force. An uncontained failure (partial merge, containment failure, unproven independence) still STOP the train.
- **BREAKING:** none for successful all-integrated trains. Partial merge-mode trains that used to STOP after the first hold will now advance and merge remaining independents and will list every selected issue in `items`. Supervisors that treat any non-zero exit as "nothing else ran" MUST read the item buckets.

## Acceptance criteria

- [ ] `pipeline train --merge --issues "A,B,C"` holds A after a contained block, park, wait, or non-ready terminal, then advances independent B and C. It does not print `will not implement another sibling` and does not return before B and C start.
- [ ] When A is held and C declares `Depends on: #A` (or a transitive path through B), C is recorded `dependency-skipped` and is not advanced or merged. Independent B still runs.
- [ ] The selected issue set is the start-of-run snapshot. A sibling filed mid-run, including an engine-class live sibling assigned the same milestone, does not enter this train's work list.
- [ ] After the remaining independents finish, eligible independent ready-to-deploy items are merged under existing merge-wave law. The process exit code is non-zero because A remains held. `complete` is false.
- [ ] `--json` stdout is still exactly one `train_status` object (`schema_version` remains `1`). `items` includes every selected issue. Completed, held, and dependency-skipped items are distinguishable without parsing `blocker` prose.
- [ ] An uncontained failure (merge-result not in the fetched base, or independence unproven) still STOP the train and does not start remaining work.
- [ ] Merge-first still holds: train does not implement a newer sibling while an earlier ready-to-deploy open mergeable PR remains unmerged.
- [ ] Non-merge train already continues independents after a park. That path stays the same.
- [ ] Injected unit tests fail if merge mode abandons independent remaining issues after a contained hold, and they fail if a dependent of the held item is advanced. Tests inject I/O (no live network, git, or subprocess).
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `openspec validate train-contained-hold-continues-independents` and `npm run ci` pass.

## Capabilities

### New Capabilities

- None. This is shared train controller law, not a new command.

### Modified Capabilities

- `integrated-train-mode`: Merge-mode contained holds are per-item. Independent remaining work continues. Dependents are dependency-skipped. The work list is frozen at start. The structured result names completed, held, and dependency-skipped items. Exit is non-zero when any item remains held.
- `train-event-stream`: Merge-mode contained holds emit `train_sibling_halted` (or equivalent) for the held item and still record later work on independent siblings. `train_item_completed` includes the `dependency-skipped` terminal.

## Impact

- Train orchestrator: `core/scripts/stages/train.ts` merge-mode STOP on first hold (`will not implement another sibling` and `will not implement #X while #Y is blocked/parked`). Independence check becomes transitive dependents, not only direct edges.
- JSON contract: additive `dependency-skipped` item terminal (and/or additive summary buckets) on existing `train_status`. `schema_version` stays `1`.
- Events: merge-mode uses the existing `train_sibling_halted` catalog entry instead of whole-train STOP.
- Tests: invert #1063-class fixtures that currently require sibling abandonment. Add a #1273 seven-issue-shape fixture (contained hold, independents continue, dependents skip).
- Docs: train command summary already says independent R2D siblings may merge while a peer is parked. Align the anti-PR-farm comment with merge-first, not with abandoning independents.
- Does not: reclassify `waiting` as not `run_fatal` / `workflow-engine-defect` (companion theming, #1265); change `ci_timeout` to exclude runner queue time; add `--continue-on-block` / `--stop-on-block`; merge from advance/loop; admit new issues mid-run.
