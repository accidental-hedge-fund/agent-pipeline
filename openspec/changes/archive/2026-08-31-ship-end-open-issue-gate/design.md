## Context

See `proposal.md` for why.

Current law and code:

- In-engine `pipeline ship` is `runShipCoordinator` in `core/scripts/stages/ship.ts`. After train evidence exists, it starts `frg_pack` with no GitHub remaining-open check. `requireActiveAuthorization()` already re-runs immediately before every phase inside the existing `run()` wrapper.
- Train freeze (`selectFreezeEligibleIssues`, ship `planTrain`) lists freeze-eligible work: open non-backlog plus closed `pipeline:ready-to-deploy`. Living `integrated-train-mode` currently says freeze-eligible integration proceeds to FRG. That is the spec conflict this change resolves.
- Train and ship freeze listing still use `gh issue list --limit 200`. This change does not alter that freeze listing.
- Merge-queue already paginates every open issue in a milestone: `listMilestoneOpenIssuesApiArgs` + `parseMilestoneIssuesPages` (`gh api repos/…/issues?state=open&milestone=N&per_page=100 --paginate --slurp`, drop `pull_request`). That listing already excludes unmilestoned issues.
- Tugboat still composes post-train leaf verbs (`factory-release prepare`, `pipeline release`, `engine-promote`) without going through `runShipCoordinator`. `factory-release-prepare` already defaults `milestone` to `v${target_version}`.

**Conflict (do not average):** freeze-eligible integration authorizes train membership and already-integrated recording. It does not authorize FRG. CONTEXT currently lacks the grill-settled terms `freeze-eligible` and `ship-end-open-issue-gate`; this change writes them.

**Class vs site (engine-dogfood bar):**

| Question | Answer |
| --- | --- |
| Class | Post-train ship proceeds from freeze-eligible integration rather than GitHub remaining-open work. |
| Site | `pipeline ship --milestone v1.40.1` after #1340 started FRG pack while #1344, #1348, #1349, #1350, #1305, #977 stayed open (`pipeline:backlog`). |
| Shared law | One remaining-open check. Every post-train FRG / release / promote boundary on the ship coordinator, and the same check on Tugboat's post-train leaf path. |
| Next identical fault | A later `pipeline ship --milestone` with leftover open GitHub issues fails closed before FRG. A new mole issue is not required. |

## Goals / Non-Goals

**Goals:**

- One remaining-open helper. Fail closed before every listed post-train operation unless live GitHub proves zero open issues on the ship milestone.
- Reuse the merge-queue exhaustive open-issue listing. Reuse the ship coordinator `run()` wrapper. Do not invent a second listing path, a persisted gate pass, a skip flag, or a new `pipeline` verb.
- Cover Tugboat without a Tugboat-local policy by invoking that same helper from the existing leaf verbs that already know `v${version}`.
- Align living specs, CONTEXT terms, and ship-path docs with that law.

**Non-Goals:**

- Changing train freeze-eligible membership or the 200-issue freeze discovery limit.
- Expanding train freeze so ship implements `pipeline:backlog` items.
- `--skip-frg` or any flag that starts FRG, release, or promote while open issues remain.
- Changing merge authorization.
- Closing leftover pack fixtures #1352 / #1353.
- Counting pull requests or unmilestoned pack issues as remaining milestone work.
- A persisted gate-pass field on ship status.

## Decisions

### D1: First holding rung — reuse merge-queue listing and the ship `run()` wrapper

**Decision:** Implement remaining-open observation with the existing merge-queue helpers (`listMilestonesApiArgs`, `findMilestoneNumberByTitle`, `listMilestoneOpenIssuesApiArgs`, `parseMilestoneIssuesPages`). Call a shared fail-closed helper from the existing ship coordinator `run()` wrapper immediately before post-train operations (`frg_pack`, `frg_score`, `release_prepare`, `release_finish`, `engine_promote`), next to `requireActiveAuthorization()`. Inject listing through `ShipCoordinatorDeps` so unit tests supply leftover issues, empty sets, and query failures with no real `gh`.

Do not use train/ship freeze `gh issue list --limit 200` for this gate. That listing is freeze membership and stays unchanged. Do not add a factory-gate label filter: the milestone query already excludes unmilestoned pack issues. Do not persist a pass on `ShipStatus`.

**Why:** The merge-queue listing already paginates to exhaustion and drops pull requests. The coordinator `run()` wrapper is already the single place that starts every post-train mutation after restart. A new module, CLI verb, or status field is a custom layer.

**Alternatives considered:**

- Guard only the `if (!status.frg_pack)` branch → rejected; class-over-site forbids a one-branch mole. Later resume of release/promote would skip the check.
- New `pipeline` verb for Tugboat → rejected; YAGNI. Existing leaf verbs already know the version/milestone.
- Reuse freeze listing (`--limit 200`) → rejected; a truncated remaining-open set is a silent skip. Freeze listing stays train membership.

### D2: Missing milestone and query errors fail closed, not empty

**Decision:** If the milestone title does not resolve, or `gh`/JSON/`--paginate` fails, the helper throws. It SHALL NOT treat that as zero remaining issues. Merge-queue currently returns `[]` when the title is absent; the ship-end helper MUST NOT copy that empty-list fallback.

**Why:** Inability to prove zero is the security decision. An unresolved milestone after train is not authorization to start FRG.

**Alternatives considered:** Treat missing milestone as empty (copy merge-queue) → rejected; that is a skip.

### D3: Cover Tugboat by calling the same helper from existing leaf verbs

**Decision:** Export one remaining-open helper. In-engine ship coordinator is the required controller. Also invoke that helper at the start of `factory-release prepare`, `pipeline release`, and `engine-promote` when the ship milestone is known (`request.milestone` or `v${version}`). That is how Tugboat, which MUST NOT exec `pipeline ship` as its product path, hits the same gate without a new verb or a bash-local query.

Do not add `--skip-frg` behavior for leftover open issues. Do not teach recovery to bypass a skipped gate.

**Why:** Tugboat still starts `factory-release prepare` after train. A coordinator-only mole leaves that path open. Leaf verbs already exist and already bind `v${version}`.

**Alternatives considered:**

- Coordinator only → rejected; Tugboat remains a mole.
- Duplicate `gh api` in `tugboat.sh` → rejected; second policy.
- New Tugboat node script → rejected; custom layer after a holding rung (leaf verbs) already exists.

### D4: Write CONTEXT terms; do not change train selection

**Decision:** Add `freeze-eligible` and `ship-end-open-issue-gate` under CONTEXT ship-path language using the grill-settled definitions. Keep train `selectFreezeEligibleIssues` as it is.

**Why:** The issue and living-spec-alignment require CONTEXT terms as written. They are currently missing. Averaging CONTEXT-absent with the living spec would leave freeze as FRG authorization.

## Risks / Trade-offs

- [Standalone `pipeline release` / `factory-release prepare` also fail closed on leftover open milestoned issues] → Accept. That is the class: leftover open milestone work must not start those operations. Milestone is already `v${version}` on prepare.
- [A pack fixture that the operator accidentally milestones blocks ship] → Accept. Spec says the operator unmilestones or closes it. This issue does not close #1352 / #1353.
- [Long remaining-open lists] → Paginate to exhaustion and name every number. No truncation cap.
- [Merge-queue empty-list fallback copied by mistake] → Unit test: unresolved milestone or query throw must not call FRG.

## Migration Plan

No persisted schema migration. Existing ship status records stay valid. A resume of `v1.40.1` with leftover open issues fails closed at the next post-train boundary until the operator closes, unmilestones, or moves those issues. No rollback flag.

## Open Questions

None. Grill nodes for class, remaining-open set, fail-closed integrity, live proof, merge auth, attestation, gate contract, tests, living-spec alignment, and operational defaults are resolved.
