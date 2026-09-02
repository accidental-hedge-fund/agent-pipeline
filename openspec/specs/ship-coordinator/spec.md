# ship-coordinator Specification

## Purpose

Provide one small, restart-safe Pipeline command that composes existing train,
recovery, FRG, release, publication, and engine-promotion capabilities. Channel
adapters stay thin, and systemd remains the host process supervisor.

## Requirements

### Requirement: The CLI SHALL provide one explicit ship coordinator

The CLI SHALL expose `pipeline ship --milestone vX.Y.Z` as the operator product command. When the milestone title is a semantic version (`vX.Y.Z` or `X.Y.Z`), the coordinator SHALL derive the release version from that title and SHALL NOT require a separate `--for` flag. It SHALL compose the existing integrated train in merge mode, bounded Pipeline recovery, candidate-bound FRG validation, release prepare and finish, publication verification, and `engine-promote`. It SHALL NOT reimplement stage dispatch, merge gates, FRG scoring, release mutation, retry taxonomy, or install behavior.

The command SHALL remain loop-isolated: `advance`, `single`, and `loop` SHALL never invoke it. Operator invocation of `pipeline ship --milestone` SHALL be sufficient authority to compose those existing loop-isolated surfaces. The command SHALL NOT require `--authorization` or a signed grant document.

The coordinator SHALL execute this phase order for a semver milestone: `train --merge` → (semver) `release` → wait until the release PR checks are green → `release finish` → wait until GitHub Release `vX.Y.Z` is published → `engine-promote`. It SHALL NOT invent a second merge policy.

#### Scenario: One command composes existing lifecycle utilities

- **WHEN** an operator runs `pipeline ship --milestone v1.39.3`
- **THEN** the coordinator SHALL call the existing Pipeline implementations for each lifecycle phase
- **AND** it SHALL NOT create a second issue scheduler, merge implementation, FRG scorer, release builder, or model router

#### Scenario: Milestone-only argv does not require a grant document

- **WHEN** an operator runs `pipeline ship --milestone v1.39.3` with no `--authorization` and no `--for`
- **THEN** the command SHALL admit and compose the ship phases
- **AND** it SHALL NOT exit for a missing grant file or a missing `--for`

#### Scenario: Advance surfaces do not acquire ship authority

- **WHEN** `pipeline advance`, `pipeline single`, or `pipeline loop` reaches
  `pipeline:ready-to-deploy`
- **THEN** it SHALL still stop without invoking the ship coordinator

---

### Requirement: Ship state SHALL be typed, atomic, and restart-safe

The coordinator SHALL persist one atomic typed state record keyed by repository,
base branch, and milestone (and version when distinct from the milestone title).
The record SHALL include at least `schema_version`, `kind`, repository, base,
milestone, version, phase, current item, last durable stage, exact child run
identities, current candidate identity, release PR identity when known, a
human-authority flag when the current stop is human authority, and terminal
result when known. It SHALL treat GitHub and Pipeline artifacts as authoritative
and use the record only as a restart checkpoint.

Before each external mutation, including after process restart, it SHALL
re-observe the relevant issue, PR, base, FRG, publication, pin, and installed
engine state. A completed observation SHALL advance the checkpoint without
repeating the mutation. Ambiguous or mismatched identity SHALL fail closed.
The coordinator SHALL resolve and atomically store the ordered milestone issue
plan before the first train mutation. A restart SHALL reuse that exact plan;
later milestone assignments SHALL NOT widen the accepted shipment.

A second invoke of the same repository, base, and milestone SHALL continue this
record. It SHALL NOT start a sibling plan or implement while an earlier
`pipeline:ready-to-deploy` item on that plan still has an open mergeable PR.

#### Scenario: Restart after an external side effect reconciles

- **WHEN** the process stops after a train merge, release PR creation, release
  merge, publication, pin update, or install but before the next checkpoint
- **THEN** a restart SHALL observe the completed side effect and continue
- **AND** it SHALL NOT perform the same mutation twice

#### Scenario: Candidate drift fails closed

- **WHEN** the observed release PR head, base, or release version differs from
  the typed prepare identity stored by the ship
- **THEN** the coordinator SHALL stop with a typed identity error before merge

#### Scenario: Later milestone assignment does not widen the ship

- **WHEN** the coordinator has stored its ordered issue plan
- **AND** another issue is later assigned to the same GitHub milestone
- **THEN** a restart SHALL continue only the stored issue plan
- **AND** it SHALL NOT merge the later issue under the accepted shipment

#### Scenario: Second invoke does not farm a sibling while an R2D PR is open

- **WHEN** the ship ledger records item A at `pipeline:ready-to-deploy` with an open mergeable PR
- **AND** an operator re-invokes `pipeline ship --milestone` for the same milestone
- **THEN** the coordinator SHALL continue the same ledger and SHALL merge A (via `train --merge`) before any plan or implement of a newer sibling
- **AND** it SHALL NOT implement a newer sibling while that PR remains open

---

### Requirement: Ship status SHALL expose the exact run without mutation

`pipeline ship status --milestone <title> --for <X.Y.Z> --json` SHALL read the
matching ship record without requiring chat memory or scanning host-global
latest-run directories. JSON output SHALL be one unfenced object and SHALL
include the ship phase, terminal result, blocker when present, exact child run
identities, current issue or candidate when present, release PR identity when
present, and next deterministic action.

#### Scenario: Status selects by stable coordinates

- **WHEN** another unrelated Pipeline run is active on the same host
- **AND** an adapter requests ship status with the original milestone and
  version
- **THEN** the response SHALL describe only that ship and its recorded child
  runs

#### Scenario: Status is observational

- **WHEN** an adapter polls ship status
- **THEN** the request SHALL perform no train, merge, release, promotion, or
  install mutation

---

### Requirement: Host adapters SHALL use systemd only for process supervision

Host adapters SHALL map operator phrase `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z`.
Hermes, OpenClaw, Claude, Codex, Grok, omp, OpenCode, and other hosts use that same mapping.
If the CLI is blocking, the adapter MAY detach one process (systemd user unit or
the host’s existing detach helper) without waiting for terminal completion.
The adapter SHALL render typed `pipeline ship status` plus material-filtered
exact-run events. Pipeline SHALL hold one host-local writer lock for each
repository/base across foreground and detached calls. systemd or the detach
helper MAY own process restart, PID tracking, cancellation, logs, and service
lifetime.

The adapter SHALL NOT implement its own durable scheduler, PID registry,
lifecycle state machine, merge policy, release discovery, retry policy,
classification, run-directory janitor, or event attribution. On notify of a
non-human failure it SHALL re-invoke the same `pipeline ship --milestone …`
argv. If ship status reports human authority, it SHALL stop and report that
state. It SHALL NOT invent `single` or `loop`.

#### Scenario: Accepted command returns after admission

- **WHEN** an operator issues `Ship milestone v1.39.3` on a configured host
- **THEN** the adapter SHALL exec `pipeline ship --milestone v1.39.3` (detached when the CLI is blocking) and return an accepted response without waiting for the ship to finish
- **AND** subsequent progress SHALL come from typed ship status and exact-run material events

#### Scenario: systemd restart resumes one ship

- **WHEN** the ship process exits unexpectedly and systemd or the host detach helper restarts its unit
- **THEN** the same milestone coordinates SHALL resume the same Pipeline ship record
- **AND** the adapter SHALL NOT create a parallel wrapper-local run

#### Scenario: Hermes re-invokes the same ship on non-human failure

- **WHEN** ship status or notify reports a non-human failure for milestone `v1.39.3`
- **THEN** Hermes SHALL re-invoke `pipeline ship --milestone v1.39.3`
- **AND** it SHALL NOT classify the failure, delete a run directory, wait a cooldown, or invoke `pipeline single` / `pipeline loop`

#### Scenario: Human-authority ledger stops the host

- **WHEN** ship status reports a human-authority stop for the milestone
- **THEN** the host SHALL stop and report that human-authority state
- **AND** it SHALL NOT re-invoke ship as if the stop were a dead-holder interrupt

### Requirement: Ship FRG generation for post-pilot releases SHALL use the durable engine path

For target release versions after v1.33.0, the ship coordinator and any ship FRG adapter it composes (including host `pipeline-ship-frg` when used) SHALL generate release-eligible FRG evidence through the durable engine path: `pipeline factory-release prepare --request <absolute-request.json> --json` (or an in-process equivalent that implements the same protocol and shared `runRelease` handoff). They SHALL NOT use a synthetic trivial docs/fixture-only pack as release-eligible FRG generation for those versions. When FRG evidence is missing at release-prepare time, ship SHALL invoke that durable path automatically; a genuine FRG failure SHALL stop ship before release finalization. Omitted HMAC on a structurally eligible terminal pack SHALL NOT be a genuine FRG failure. That tick SHALL be attestation wait: the coordinator SHALL run `pipeline factory-gate --for <X.Y.Z> --from-run <bound-loop>` in a separate credentialed child and SHALL re-invoke the same prepare request. It SHALL NOT stop the ship as `frg_not_eligible` for omitted HMAC only.

#### Scenario: Missing FRG auto-generates via durable prepare for 1.34+

- **WHEN** an authorized ship for version `1.34.0` reaches release preparation and no release-eligible FRG pass artifact exists for `1.34.0`
- **THEN** ship SHALL invoke the durable `factory-release prepare` path (or equivalent) from the exact integrated candidate
- **AND** it SHALL NOT mint release-eligible evidence from a trivial docs-only synthetic pack

#### Scenario: Genuine FRG failure stops ship before release finalization

- **WHEN** durable FRG generation for the ship version returns failure or non-complete status because required evidence is missing or structurally ineligible (`pass: false` that is not omitted-HMAC-only)
- **THEN** ship SHALL stop before release-PR finalization mutations that require a pass
- **AND** status SHALL name the FRG defect

#### Scenario: Omitted HMAC is attestation wait not genuine failure

- **WHEN** candidate `factory-release prepare` scores a terminal structurally eligible pack without HMAC
- **THEN** ship SHALL treat the tick as attestation wait
- **AND** it SHALL NOT stop the ship as `frg_not_eligible`
- **AND** it SHALL invoke `pipeline factory-gate --for <X.Y.Z> --from-run <bound-loop>` in a child other than prepare
- **AND** that child SHALL have the producer credential

#### Scenario: Complete durable prepare supplies typed release identity

- **WHEN** `factory-release prepare` returns `status: "complete"` with typed version, PR, base, head, and FRG run id
- **THEN** ship SHALL store that identity as the release prepare result
- **AND** later finalization SHALL revalidate against the observed GitHub and FRG state before merge or promotion

### Requirement: Ship durable FRG handoff SHALL remain restart-safe and non-duplicating

When ship drives the durable FRG and prepare protocol, every entry after crash, timeout, or restart SHALL re-observe pack, FRG run, attestation, branch, release PR, and head state before any create mutation. Duplicate ticks with the same ship coordinates and request binding SHALL NOT create a second pack, second attestation, second release branch, or second release PR.

#### Scenario: Restart after awaiting attestation continues without new pack

- **WHEN** ship stopped after unsigned FRG artifacts exist and status was `awaiting_frg_attestation`
- **AND** a restart runs the same ship coordinates and request binding
- **THEN** ship SHALL re-observe the existing pack and artifacts
- **AND** it SHALL NOT create a second pack for the same binding

#### Scenario: Restart after complete prepare does not open a second PR

- **WHEN** ship stopped after a complete prepare with a known release PR identity
- **AND** a restart re-enters release preparation
- **THEN** ship SHALL reconcile the existing PR identity
- **AND** it SHALL NOT open a second release pull request for the same version binding

### Requirement: Ship coordinator promote phase SHALL install to all hosts by default

When the in-engine ship coordinator (`pipeline ship`) reaches the engine-promote phase and the operator has not scoped the install host, the coordinator SHALL promote and install using effective host selector `all` so every installer-managed outer-host skill tree receives the released engine. The coordinator SHALL NOT leave Claude, Grok, or OpenCode on a prior release solely because the promote call omitted a host option and inherited a codex-only default.

#### Scenario: Authorized ship promote uses multi-host install default

- **WHEN** an authorized `pipeline ship` completes publication and runs engine promote for version `X.Y.Z`
- **AND** the operator has not scoped promote to a single host
- **THEN** the composed engine-promote install SHALL use host selector `all`
- **AND** the install command or promote result recorded for that phase SHALL include `--host all` (or an equivalent explicit multi-host selector)

#### Scenario: Ship promote does not silent-default to codex only

- **WHEN** the ship coordinator promote path invokes engine-promote without an operator host override
- **THEN** the effective install host SHALL NOT be `codex` alone as an implicit omitted-host default

### Requirement: Ship interrupt with a dead holder SHALL resume the same item

The coordinator SHALL treat a dead harness, SIGTERM, host reboot, or network drop mid-stage as a resume-eligible interrupt when the prior holder is dead. It SHALL continue the same ledger item from its last durable stage using the worktree, live labels, and ship ledger. It SHALL NOT classify that interrupt as `workflow-engine-defect`. It SHALL NOT burn a `restart_workflow_engine` class budget. It SHALL NOT STOP the ship with `supervisor_no_progress` solely because the prior holder is dead.

#### Scenario: Kill mid-implement resumes the same issue

- **WHEN** ship is implementing issue N for milestone `vX.Y.Z`
- **AND** the implementer process is killed and the prior holder is dead
- **AND** an operator re-invokes `pipeline ship --milestone vX.Y.Z`
- **THEN** ship SHALL resume issue N from its last durable stage
- **AND** it SHALL NOT STOP with `supervisor_no_progress`
- **AND** it SHALL NOT record a leftover `workflow-engine-defect` whose first recipe was `restart_workflow_engine`

### Requirement: Ship SHALL fail when merge-first is violated

When the composed `train --merge` would plan or implement any milestone item while a work-list item already at `pipeline:ready-to-deploy` still has an open mergeable PR, the ship SHALL fail closed. The first mutation of a ship or merge-mode train that observes ready-to-deploy #A with an open MERGEABLE PR and ready #B SHALL be the merge of #A.

#### Scenario: Open R2D PR blocks sibling implement

- **WHEN** item A is `pipeline:ready-to-deploy` with an open MERGEABLE PR
- **AND** item B is `pipeline:ready` on the same milestone
- **THEN** ship SHALL merge A and prove base containment before any plan or implement of B
- **AND** a fixture that implements B first SHALL fail

### Requirement: Ship coordinator post-train phases SHALL execute the candidate engine

After `train --merge` is complete or resumed complete, in-engine `pipeline ship` SHALL run Factory Reliability Gate (FRG) pack (`factory-release prepare` and `factory-gate`), `pipeline release`, `release finish`, and any coordinator-invoked tag on the candidate engine bound to the SHA being released. The candidate engine SHALL be the control checkout at that SHA, or an explicit candidate install of that SHA. The coordinator SHALL obtain that root from the shared asynchronous resolve-and-prepare seam. Identity-only resolution SHALL NOT authorize leaf spawn.

When the operator started `pipeline ship` from the previous production-pin CLI, the coordinator SHALL keep that pin process as the durable coordinator and SHALL spawn the candidate engine for leaf post-train verbs (`factory-release prepare`, `factory-gate`, `release`, `release finish`, and `release ensure-tag`). After a successful candidate `factory-gate`, the coordinator SHALL re-invoke the same candidate `factory-release prepare --request <absolute-request.json> --json` once. When that prepare returns `status: "complete"`, the FRG pack phase SHALL return. When that prepare still returns `status: "awaiting_frg_attestation"` because observation is absent or rejected, the FRG pack phase SHALL fail closed and SHALL name unsigned `frg_run_id` `A`, observed `latest.json` `run_id` `B` when present, and the observe miss reason. It SHALL NOT spawn factory-gate again for that unchanged checkpoint. It SHALL NOT return from the FRG pack phase at the first attestation checkpoint. It SHALL NOT treat the later standalone `pipeline release` leaf as a substitute for that complete checkpoint. `release ensure-tag` SHALL run the candidate's `ensureAnnotatedReleaseTag`; it SHALL NOT import that helper from the production-pin process. It SHALL NOT re-exec `pipeline ship`. It SHALL NOT rerun train. It SHALL NOT keep executing those leaf verbs inside the production-pin process when that process source SHA differs from the candidate. Train and `engine-promote` SHALL remain on the production pin.

The coordinator SHALL fail closed before those ship-end verbs if it cannot resolve-and-prepare a matching runnable candidate engine. A failed resolution or failed candidate readiness SHALL persist the train checkpoint and SHALL NOT start FRG pack or release mutation. Setup failure, abandoned ownership, and lock uncertainty SHALL remain supervised lifecycle states (bounded treatment, Cooling, or External-condition wait) and SHALL NOT become generic blocked, needs-human, or terminal mechanical failure. They SHALL NOT create a DecisionRequest or AuthorityRequest. This requirement does not authorize `--skip-frg` as the default. It does not authorize promote before GitHub Release publication. It does not add a new recover recipe, `auto_merge`, a merge stage, or a special ship of the readiness gate.

#### Scenario: Production-pin ship switches to candidate after train

- **WHEN** an operator runs production-pin `pipeline ship --milestone v1.39.5`
- **AND** train completes with FRG-bound candidate SHA `C` whose version is `1.39.5`
- **THEN** the coordinator SHALL spawn `factory-release prepare` and `pipeline release` on the candidate engine at `C`
- **AND** it SHALL NOT open the release PR using the `1.39.4` production-pin `release.ts`

#### Scenario: Unresolvable candidate stops ship before release

- **WHEN** train is complete
- **AND** the coordinator cannot resolve a candidate engine matching the FRG-bound SHA
- **THEN** ship SHALL stop before `pipeline factory-release prepare` and before `pipeline release`
- **AND** status SHALL name the candidate-engine identity defect
- **AND** persisted train evidence SHALL remain so a retry does not retrain

#### Scenario: Handoff does not re-enter ship or train

- **WHEN** the pin coordinator spawns the candidate for a post-train verb
- **THEN** the spawned argv SHALL be a leaf CLI verb
- **AND** it SHALL NOT be `pipeline ship --milestone`
- **AND** it SHALL NOT be `pipeline train`

#### Scenario: Candidate FRG pack converges prepare after attestation

- **WHEN** candidate `factory-release prepare --request <absolute-request.json> --json` returns `status: "awaiting_frg_attestation"`
- **AND** candidate `factory-gate --for <X.Y.Z> --from-run <loop_run_id>` succeeds
- **THEN** the coordinator SHALL re-invoke the same candidate `factory-release prepare` with that unchanged request once
- **AND** when that prepare returns `status: "complete"`, the FRG pack phase SHALL return
- **AND** when that prepare still returns `status: "awaiting_frg_attestation"`, the FRG pack phase SHALL fail closed
- **AND** it SHALL NOT spawn factory-gate again for that unchanged checkpoint
- **AND** it SHALL NOT treat the later standalone `pipeline release` leaf as a substitute for that complete checkpoint

#### Scenario: Coordinator-invoked tag runs candidate ensure-tag

- **WHEN** the pin coordinator waits for publication after a merged release
- **AND** the pin process SHA differs from the FRG-bound candidate SHA
- **THEN** the coordinator SHALL spawn `release ensure-tag <X.Y.Z> <merge-commit-oid>` on the candidate launcher
- **AND** it SHALL NOT call the production-pin process's imported `ensureAnnotatedReleaseTag`

#### Scenario: Unready candidate stops ship before leaf spawn

- **WHEN** train is complete
- **AND** a candidate-engine root matches the FRG-bound SHA
- **AND** resolve-and-prepare fails to prove candidate readiness
- **THEN** ship SHALL stop before `pipeline factory-release prepare` and before `pipeline release`
- **AND** persisted train evidence SHALL remain so a retry does not retrain
- **AND** no candidate leaf command SHALL have spawned

#### Scenario: Setup failure is not needs-human

- **WHEN** in-engine `pipeline ship` fails closed on candidate setup or abandoned ownership
- **THEN** the outcome SHALL be a supervised lifecycle state (bounded treatment, Cooling, or External-condition wait)
- **AND** it SHALL NOT be generic blocked, needs-human, or terminal mechanical failure
- **AND** it SHALL NOT create a DecisionRequest or AuthorityRequest solely for that failure

### Requirement: Candidate ensure-tag SHALL prove the supplied OID is the merged release

`pipeline release ensure-tag` SHALL re-observe the version's release PR before creating a missing annotated tag. It SHALL require that pull request to be merged with a merge commit exactly equal to the supplied OID. It SHALL fail closed and SHALL NOT create or push `v<X.Y.Z>` when that proof is absent. Before creating a missing tag it SHALL also validate on-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` as release-eligible (`pass: true` and valid HMAC) and SHALL require HMAC `candidate_git_sha` (`factory_release_binding.candidate_git_sha` if present and HMAC-attested, else `pack_provenance.candidate_git_sha`) to equal the caller-supplied `--packed-candidate` 40-hex SHA. `factory_release_binding` SHALL be part of the FRG HMAC canonical payload when present. An unauthenticated `factory_release_binding` overlay SHALL fail closed and SHALL NOT retarget the packed candidate. A present but invalid binding SHALL NOT fall back to another carrier. That packed SHA SHALL be this ship's independent Factory Reliability Gate (FRG)-bound identity: factory-release request `integrated_candidate.git_sha` or `ShipTrainEvidence.integrated_head_oid`. The HMAC artifact SHALL NOT be the authority for "this ship." The command SHALL fail closed when `--packed-candidate` is missing or is not 40-hex. It SHALL NOT require that packed candidate SHA to equal the merge commit. It SHALL NOT rewrite `latest.json`. It SHALL NOT require the file to exist in the git tree. HMAC `candidate_git_sha` SHALL be taken from the same HMAC-validated `latest.json` snapshot (one file read). The helper SHALL NOT reopen `latest.json` after validation to bind `--packed-candidate`.

An existing `v<X.Y.Z>` SHALL succeed only when origin has an annotated tag whose peeled commit equals the merge commit. A local-only annotated tag SHALL NOT be treated as published: the helper SHALL observe origin in a temporary ref and, if origin lacks the tag, SHALL push the verified local tag. A lightweight tag or a tag on a different commit (local or remote) SHALL fail closed. The command SHALL NOT force-update or delete the tag. If a concurrent push creates the remote tag, the command SHALL re-observe origin and succeed only if that tag is the correct annotated tag on the merge commit.

#### Scenario: Unrelated OID is rejected

- **WHEN** `pipeline release ensure-tag 1.39.5 <oid> --packed-candidate <C>` runs
- **AND** `<oid>` is a valid 40-hex commit
- **AND** the v1.39.5 release PR merge commit is a different OID
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: Missing on-disk HMAC latest.json is rejected

- **WHEN** `pipeline release ensure-tag 1.39.5 <merge-oid> --packed-candidate <C>` runs
- **AND** the merge OID is the v1.39.5 release PR merge commit
- **AND** on-disk `.agent-pipeline/frg/1.39.5/latest.json` is absent
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: Unbound HMAC candidate_git_sha is rejected

- **WHEN** on-disk `latest.json` is otherwise release-eligible
- **AND** `--packed-candidate` is this ship's `integrated_candidate.git_sha` `C`
- **AND** HMAC `candidate_git_sha` is a 40-hex SHA that is not `C`
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: Packed candidate may differ from the merge commit

- **WHEN** `--packed-candidate` is `C`
- **AND** HMAC `candidate_git_sha` equals `C`
- **AND** the merged release PR merge commit is `M`
- **AND** `C` and `M` differ
- **THEN** the command SHALL create and push annotated tag `v1.39.5` on peeled `M`
- **AND** it SHALL NOT tag `C` instead of `M`

#### Scenario: Wrong existing tag fails closed

- **WHEN** `refs/tags/v1.39.5` already exists as a lightweight tag or peels to a commit other than the merge
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT force-update or delete the tag

#### Scenario: HMAC candidate SHA comes from the validated snapshot

- **WHEN** `pipeline release ensure-tag` validates on-disk `latest.json`
- **AND** a concurrent writer replaces that file after the HMAC-valid read
- **THEN** `--packed-candidate` SHALL be compared to `candidate_git_sha` from the validated snapshot
- **AND** the helper SHALL NOT reopen `latest.json` for that comparison

#### Scenario: Unauthenticated factory_release_binding overlay is rejected

- **WHEN** on-disk `latest.json` is HMAC-valid for packed candidate `A`
- **AND** a writer adds or changes `factory_release_binding.candidate_git_sha` to `B` after signing
- **THEN** `pipeline release ensure-tag` SHALL fail closed
- **AND** it SHALL NOT create or push `v1.39.5`

#### Scenario: Local annotated tag with no remote tag is pushed

- **WHEN** local `refs/tags/v1.39.5` is an annotated tag on the merge commit
- **AND** origin has no `refs/tags/v1.39.5`
- **THEN** the command SHALL push the verified local tag
- **AND** SHALL NOT return success as if the tag were already published

#### Scenario: Wrong remote tag still fails closed after a local tag exists

- **WHEN** local `refs/tags/v1.39.5` is the correct annotated tag
- **AND** origin has a lightweight tag or a tag on a different commit
- **THEN** the command SHALL fail closed
- **AND** it SHALL NOT force-update or delete the tag

### Requirement: In-engine ship FRG pack wait SHALL outlive the bound pack loop

In-engine `pipeline ship` SHALL keep re-invoking the same candidate `factory-release prepare` request while prepare status is `in_progress` and the bound pack loop is live. Live SHALL mean the authoritative pack-loop liveness status object (prepare JSON `liveness`, or the same TypeScript probe): a valid `loop_run_handoff` for that exact loop, plus the exact PID, process-start identity, boot identity, and a fresh heartbeat. A non-terminal ledger SHALL NOT prove live. Wait-budget expiry while that loop is live SHALL NOT fail the ship. A short FRG tick cap (including 120 × 10s) plus a "retry the same ship command to resume" error SHALL NOT be pack-fail in that case. The coordinator SHALL keep the ship ledger FRG phase running and SHALL heartbeat on each wait tick. The coordinator SHALL NOT kill the pack loop. Wait-budget expiry MAY fail the FRG pack phase when the bound loop is not live. Unreadable identity evidence SHALL consume the bounded observation window and then fail closed with a typed observer or identity error. It SHALL NOT keep wait-budget from applying as not-live after that window. False live SHALL NOT disable the wait cap. This requirement does not return from the FRG pack phase at the attestation checkpoint. It does not authorize `--skip-frg` as the default.

#### Scenario: In-engine live-loop wait expiry is not ship fail

- **WHEN** candidate `factory-release prepare` returns `status: "in_progress"` for bound loop `L`
- **AND** `L` is live under acknowledged-process liveness
- **AND** the numeric FRG tick cap is exhausted
- **THEN** `pipeline ship` SHALL NOT fail the FRG pack phase for wait-budget exhaustion
- **AND** it SHALL keep re-invoking the same request
- **AND** it SHALL NOT require a human to re-invoke the ship command solely to continue that live wait

#### Scenario: In-engine dead-loop wait expiry remains fail-closed

- **WHEN** candidate `factory-release prepare` returns `status: "in_progress"` for bound loop `L`
- **AND** `L` is not live
- **AND** the not-live wait budget is exhausted
- **THEN** `pipeline ship` SHALL fail the FRG pack phase
- **AND** it SHALL NOT open or finish a release PR for that version on that evidence

#### Scenario: In-engine dead pid plus open ledger is not live

- **WHEN** candidate `factory-release prepare` returns `status: "in_progress"` for bound loop `L`
- **AND** lock pid for `L` is dead or missing
- **AND** the ledger for `L` is present without `stop`
- **AND** events for `L` are not terminal
- **THEN** `pipeline ship` SHALL NOT classify `L` as live
- **AND** wait-budget expiry MAY fail the FRG pack phase
- **AND** `last_error` SHALL include the child exit status and a safe stderr excerpt when that child exited before handoff

#### Scenario: In-engine unreadable liveness at cap is not ship fail

- **WHEN** candidate `factory-release prepare` returns `status: "in_progress"` for bound loop `L`
- **AND** identity evidence for `L` is unreadable or malformed
- **AND** the bounded observation window has not expired
- **THEN** `pipeline ship` SHALL NOT fail the FRG pack phase for wait-budget exhaustion
- **AND** it SHALL keep observing `L`

#### Scenario: In-engine unreadable identity after the observation window is ship fail

- **WHEN** candidate `factory-release prepare` returns `status: "in_progress"` for bound loop `L`
- **AND** identity evidence for `L` is unreadable or malformed
- **AND** the bounded observation window has expired
- **THEN** `pipeline ship` SHALL fail the FRG pack phase with a typed observer or identity error
- **AND** it SHALL NOT keep re-invoking as if `L` were live

#### Scenario: Regression fails if in-engine wait treats live in_progress as terminal

- **WHEN** an automated check evaluates `in_progress` plus a live bound loop after N short FRG ticks at cap N
- **THEN** the decision SHALL be continue, not terminal fail
- **AND** the check SHALL fail if the adapter still throws a resume-to-retry error for that case

### Requirement: In-engine publication wait SHALL tag from on-disk HMAC before polling GitHub Release

In-engine `pipeline ship` publication wait SHALL invoke candidate `ensureAnnotatedReleaseTag` / `release ensure-tag` against on-disk HMAC `latest.json` before polling GitHub Release. A missing tree-file `latest.json` SHALL NOT skip that invoke. Publication wait SHALL still require a published non-draft GitHub Release after the tag exists.

#### Scenario: Disk evidence with no tree file still tags

- **WHEN** in-engine ship has merged the `1.39.5` release pull request
- **AND** on-disk HMAC `latest.json` is release-eligible
- **AND** the git tree has no `.agent-pipeline/frg/1.39.5/latest.json`
- **THEN** publication wait SHALL invoke ensure-tag on the candidate engine
- **AND** it SHALL NOT skip tagging because auto-tag cannot see the tree file

### Requirement: In-engine ship SHALL apply ship-release-check-wait before release finish

In-engine `pipeline ship` SHALL apply living `ship-release-check-wait` before it invokes `pipeline release finish` for an unfinished release PR. The coordinator SHALL classify a `gh pr checks --json` capture into exactly one of `green`, `pending`, `rerun`, or `fail`. The requested field set SHALL include `name`, `state`, `bucket`, and `link`. The waiter SHALL NOT request a non-existent `conclusion` field. Classification SHALL be deterministic from check metadata. Classification SHALL NOT require a non-deterministic LLM.

`green` SHALL invoke finish. `pending` SHALL keep waiting inside the coordinator. Durable resume on the same `pipeline ship --milestone` argv SHALL be allowed. A one-shot throw on a pending snapshot SHALL NOT persist ship failure and SHALL NOT count as the wait. Session poll-cap expiry while still `pending` SHALL preserve `next_action: "release_finish"` without persisting ship failure so the same argv can resume. `rerun` SHALL request one bounded `gh run rerun --failed` per release-PR head SHA (budget SHALL NOT exceed two) and SHALL resume wait. `fail` SHALL persist ship failure and SHALL NOT invoke finish.

The coordinator SHALL re-observe the release PR identity after each wait capture and immediately before finish. When the live PR or head SHA differs from the prepared identity, the coordinator SHALL NOT rerun workflows and SHALL NOT invoke finish under the stale checkpoint. It SHALL stop resumably so the same argv can recover. Persisted rerun-budget state SHALL be written atomically. When an existing budget file cannot be parsed, the waiter SHALL treat the budget as exhausted and SHALL NOT issue an additional rerun.

The finish-converge path (`convergeReleaseFinish` or the seam it calls) SHALL NOT invoke finish while the waiter would classify `pending` or `rerun`. When an already-merged finish identity is observed for the same PR and head, the coordinator SHALL reuse that evidence and SHALL NOT wait or finish again. This requirement does not turn bare `pipeline release finish` into a poller.

#### Scenario: Pending checks do not invoke finish

- **WHEN** in-engine `pipeline ship` reaches release finish for an open release PR
- **AND** the waiter classifies the current checks capture as `pending`
- **THEN** the coordinator SHALL keep waiting
- **AND** it SHALL NOT invoke `pipeline release finish` for that PR on that poll
- **AND** it SHALL NOT persist ship failure solely because that snapshot was pending

#### Scenario: Pending wait-cap expiry stays resumable

- **WHEN** in-engine `pipeline ship` is waiting on an open release PR
- **AND** the session poll cap expires while the waiter still classifies `pending`
- **THEN** the coordinator SHALL preserve `next_action: "release_finish"`
- **AND** it SHALL NOT persist ship failure
- **AND** a same-argv retry SHALL resume the wait

#### Scenario: Green after wait invokes finish

- **WHEN** a later poll classifies the same open release PR as `green`
- **THEN** the coordinator SHALL invoke `pipeline release finish` for that PR
- **AND** it SHALL NOT open a second release PR for that version

#### Scenario: Flake-eligible test fail reruns then waits

- **WHEN** the only settled failed check is named `test`
- **AND** no other check is pending
- **AND** rerun budget remains for that head SHA
- **THEN** the coordinator SHALL request `gh run rerun --failed` for that run id
- **AND** it SHALL resume waiting
- **AND** it SHALL NOT invoke finish on that poll

#### Scenario: Terminal fail does not invoke finish

- **WHEN** the waiter classifies the capture as `fail`
- **THEN** the coordinator SHALL persist ship failure
- **AND** it SHALL NOT invoke `pipeline release finish`

#### Scenario: Already-finished observation skips the wait

- **WHEN** the coordinator re-observes a merged finish identity for the prepared release PR and head
- **THEN** it SHALL reuse that finish evidence
- **AND** it SHALL NOT wait on checks
- **AND** it SHALL NOT merge again

#### Scenario: Regression fails if finish is invoked on pending

- **WHEN** an automated check drives the finish-converge seam with a checks capture the waiter would classify as `pending`
- **THEN** the decision SHALL be wait, not finish
- **AND** the check SHALL fail if finish is invoked on that capture

#### Scenario: Head change during wait does not finish or rerun

- **WHEN** in-engine `pipeline ship` is waiting on an open release PR
- **AND** a later poll observes a different release-PR head than the prepared identity
- **THEN** the coordinator SHALL NOT request `gh run rerun --failed` under the stale head
- **AND** it SHALL NOT invoke `pipeline release finish` for the stale identity
- **AND** it SHALL stop resumably without persisting ship failure

#### Scenario: Unreadable rerun-budget state does not reset the cap

- **WHEN** persisted rerun-budget state for a release-PR head cannot be parsed
- **AND** a later capture is rerun-eligible
- **THEN** the coordinator SHALL treat the budget as exhausted
- **AND** it SHALL NOT request an additional `gh run rerun --failed`

### Requirement: Ship train observation SHALL prove integration from merged pipeline mentions

Ship train observation SHALL treat the planned issues as integrated when each issue has a same-repo pull request that any-state resolution links (ConnectedEvent, closing `willCloseTarget`, head `pipeline/<N>-*`, or title parenthetical `(#N)`), that pull request is `MERGED`, and the merge commit OID is an ancestor of the candidate head (`origin/<base>` or the recorded candidate). It SHALL return complete train evidence including `integrated_head_oid` set to that candidate. It SHALL NOT require an open pull request. It SHALL NOT require `Fixes #N` or `Closes #N` in the squash title.

When that observation succeeds, the coordinator SHALL NOT invoke train mutation (`runTrain` / `train --merge`) for those planned issues. Coordinator `next_action` SHALL be the first missing post-train phase (`frg_pack` when FRG pack evidence is absent). It SHALL NOT leave `next_action` at `train_merge` with `train: null` solely because GitHub recorded `willCloseTarget: false` for a `(#N)` squash mention.

#### Scenario: Merged (#N) pipeline PRs complete observeTrain

- **WHEN** a ship milestone plan is issues 1258, 1259, and 1252
- **AND** each issue's timeline has a `CrossReferencedEvent` with `willCloseTarget: false` to a merged same-repo pipeline pull request
- **AND** each merge commit OID is an ancestor of `origin/main`
- **THEN** train observation SHALL return complete train evidence
- **AND** that evidence SHALL include `integrated_head_oid` equal to the candidate head
- **AND** it SHALL NOT return null

#### Scenario: Successful observation does not re-enter train

- **WHEN** train observation returns complete evidence for the planned issues
- **THEN** ship SHALL NOT invoke `runTrain`
- **AND** it SHALL NOT STOP with `ready-to-deploy but has no linked open PR`

#### Scenario: Closing-keyword and ConnectedEvent paths still prove integration

- **WHEN** a planned issue's timeline has a `ConnectedEvent` or a `CrossReferencedEvent` with `willCloseTarget: true` to a merged same-repo pull request whose merge OID is an ancestor of the candidate
- **THEN** train observation SHALL return complete train evidence for that issue
- **AND** ship SHALL continue as for the `(#N)` path

#### Scenario: Fork PRs are not integration proof

- **WHEN** the only timeline link for a planned issue is a fork pull request (`isCrossRepository: true`)
- **THEN** train observation SHALL NOT treat that issue as integrated
- **AND** it SHALL NOT return complete train evidence for the plan

#### Scenario: After observation, next_action is FRG not train_merge

- **WHEN** train observation returns complete evidence and no later ship phase has run
- **THEN** coordinator `next_action` SHALL be `frg_pack` (or a later post-train phase if FRG evidence already exists)
- **AND** it SHALL NOT remain `train_merge` with `train: null` and `complete: false`

### Requirement: Ship FRG observation SHALL return null when latest.json is not yet release-eligible

Ship FRG observation SHALL return null when `.agent-pipeline/frg/<X.Y.Z>/latest.json` is absent, unreadable, or not release-eligible for the ship version. After train observation has proven the integrated candidate and no later ship phase has run, coordinator `next_action` SHALL be `frg_pack`. Observation SHALL NOT throw the tag-path fail-closed message that names `Cannot create or push tag`. Observation returning null SHALL NOT skip a later ensure-tag or publication phase. Candidate-identity defects during observation (base advanced after the recorded train, recorded train not contained in base, HMAC candidate SHA mismatch after a valid eligible read, or base advanced after the initial observe read while latest.json is missing, unreadable, or not release-eligible) SHALL still fail closed.

#### Scenario: Missing latest.json is not observed, not a tag-path throw

- **WHEN** train observation has returned complete evidence for the planned issues
- **AND** `.agent-pipeline/frg/1.39.14/latest.json` is absent
- **AND** the FRG attestation key is presented
- **THEN** ship FRG observation SHALL return null
- **AND** coordinator `next_action` SHALL be `frg_pack`
- **AND** ship SHALL NOT throw a message that says `Cannot create or push tag v1.39.14`
- **AND** ship SHALL NOT leave `next_action` at `train_merge` solely because that file is absent

#### Scenario: Unreadable or not-eligible latest.json is not observed

- **WHEN** train observation has returned complete evidence
- **AND** `.agent-pipeline/frg/1.39.14/latest.json` is unreadable, unparsable, `pass: false`, or otherwise not release-eligible
- **THEN** ship FRG observation SHALL return null
- **AND** coordinator `next_action` SHALL be `frg_pack`
- **AND** ship SHALL NOT skip FRG pack solely because that file is present but ineligible

#### Scenario: Observe-null does not skip later tagging

- **WHEN** ship FRG observation has returned null because `latest.json` was absent or ineligible
- **AND** a later tick observes a release-eligible `latest.json` for that version
- **THEN** observation SHALL return that evidence
- **AND** publication / `release ensure-tag` SHALL still fail closed unless that artifact is release-eligible
- **AND** ship SHALL NOT omit ensure-tag because an earlier observe returned null

#### Scenario: Candidate identity defects still fail closed during observe

- **WHEN** ship FRG observation runs against a recorded train candidate
- **AND** base has advanced past that candidate, the candidate is no longer contained in base, or a valid eligible `latest.json` has HMAC `candidate_git_sha` that is not that candidate
- **THEN** observation SHALL fail closed
- **AND** it SHALL NOT return null
- **AND** it SHALL NOT start FRG pack on that drifted identity

#### Scenario: Observe-null still fail-closes when base advances during the evidence read

- **WHEN** ship FRG observation has proven the recorded train on the first base read
- **AND** `.agent-pipeline/frg/<X.Y.Z>/latest.json` is absent, unreadable, or not release-eligible
- **AND** a later base read after that evidence observation shows the base has advanced
- **THEN** observation SHALL fail closed
- **AND** it SHALL NOT return null
- **AND** it SHALL NOT start FRG pack on that drifted identity

### Requirement: In-engine runFrgPack SHALL fail closed after one attest observation

In-engine `pipeline ship` FRG pack (`runFrgPack` / `bindCandidateShipEndOperations`) SHALL spawn credentialed candidate `factory-gate --for <X.Y.Z> --from-run <loop_run_id>` at most once for an unchanged complete unsigned checkpoint binding. After that child exits 0, it SHALL re-invoke the same candidate `factory-release prepare --request <absolute-request.json> --json` once. If that prepare still returns `status: "awaiting_frg_attestation"` because observation is absent or rejected, `runFrgPack` SHALL throw. The error SHALL name unsigned `frg_run_id` `A`, observed `latest.json` `run_id` `B` when present, and the observe miss reason. It SHALL NOT `continue` forever on `"attest"`. It SHALL NOT spawn another factory-gate for that binding.

A changed complete checkpoint binding SHALL reset the allowance. Live `"retry"` wait while the bound pack loop is live SHALL keep the existing #1150 law. `"attest"` SHALL NOT inherit that live-loop uncap.

The existing re-invoke test SHALL drive a real-shaped `--from-run` payload (HMAC-pass `run_id=B`, `pack_provenance`, top-level `factory_release_binding` matching unsigned `A`) through the observe contract. It SHALL NOT mock factory-gate as a no-op that magically makes the next prepare return `complete`. A unit test SHALL fail if unsigned `A` plus `--from-run` `B` + `pack_provenance` and no `factory_release_binding` is treated as observe success, or if `runFrgPack` never terminates.

This requirement does not authorize `--skip-frg`. It does not treat standalone `pipeline release` as a substitute for prepare `complete`.

#### Scenario: HMAC from-run latest.json is observable or ship fails closed

- **WHEN** unsigned checkpoint `frg_run_id` is `A`
- **AND** HMAC `latest.json` `run_id` is `B` for the same loop and candidate
- **AND** in-engine `runFrgPack` has spawned factory-gate once and re-invoked prepare once
- **THEN** prepare SHALL return `status: "complete"` when `factory_release_binding` matches `A`
- **OR** `runFrgPack` SHALL throw naming `A`, `B`, and the miss reason when observation is absent or rejected
- **AND** it SHALL NOT loop

#### Scenario: Attest ticks are bounded

- **WHEN** prepare keeps returning `status: "awaiting_frg_attestation"` for unchanged unsigned `A`
- **AND** ship has already spawned factory-gate once for that checkpoint
- **THEN** `runFrgPack` SHALL throw
- **AND** it SHALL NOT spawn another factory-gate

#### Scenario: Magical complete after no-op gate is not the proof

- **WHEN** the candidate FRG pack re-invoke test runs
- **THEN** factory-gate SHALL persist a real-shaped `--from-run` payload
- **AND** the next prepare `complete` SHALL be a consequence of accepted observation of that payload
- **AND** the test SHALL fail if factory-gate is a no-op and prepare returns `complete` anyway

### Requirement: Ship FRG observation SHALL accept candidate-bound hybrid-v2 after v1.33.0

Ship Factory Reliability Gate (FRG) observation SHALL reuse the shared FRG release-eligibility validator for `.agent-pipeline/frg/<X.Y.Z>/latest.json`. After that validator accepts the artifact, observation SHALL bind it to the ship intent, the integrated train candidate, and the closed factory-release checkpoint. Observation SHALL NOT duplicate the validator's policy, manifest, fingerprint, proof-matrix, or HMAC checks.

For a target version after `1.33.0`, observation SHALL accept the artifact only when all of the following hold:

- `pack_provenance.policy_id` is `factory-gate-v1-hybrid-v2`
- HMAC-covered top-level `factory_release_binding` is present
- that binding fully matches the closed unsigned checkpoint
- `pack_provenance` repository, base branch, and candidate SHA match the ship intent and the integrated train candidate
- `factory_release_binding.candidate_git_sha` equals that same train candidate

Presence of valid `pack_provenance` SHALL NOT cause rejection. Historical `1.33.0` observation SHALL keep its current acceptance: hybrid-v1 remains valid only for exactly `1.33.0`; a matching `pack_provenance` on `1.33.0` SHALL still bind the train candidate, repository, and base branch.

Observation SHALL compare the binding to the closed checkpoint with the existing unsigned-digest binding comparison. It SHALL NOT invent a second binding schema. When the closed checkpoint is missing, malformed, or in conflict after a post-pilot eligible read, observation SHALL fail closed. It SHALL NOT accept the artifact by reading only a version-index candidate SHA.

#### Scenario: v1.40.0 hybrid-v2 with matching checkpoint is observed

- **WHEN** train observation has proven integrated candidate `C`
- **AND** `.agent-pipeline/frg/1.40.0/latest.json` is HMAC-pass, `pass: true`, `pack_provenance.policy_id` is `factory-gate-v1-hybrid-v2`, `pack_provenance.candidate_git_sha` is `C`, and HMAC-covered `factory_release_binding` matches the closed checkpoint for `C`
- **THEN** ship FRG observation SHALL return that evidence
- **AND** ship SHALL proceed to the next phase after `frg_pack`
- **AND** it SHALL NOT throw `hybrid pack_provenance is valid only for v1.33.0`

#### Scenario: Observed v1.39.16 and v1.40.0 rejection shapes no longer reject hybrid-v2

- **WHEN** a unit test feeds the v1.39.16 or v1.40.0 ship-observe rejection shape (HMAC-pass hybrid-v2 `pack_provenance` present, version not `1.33.0`, matching candidate and checkpoint)
- **THEN** the test SHALL fail if observation throws `hybrid pack_provenance is valid only for v1.33.0; got 1.39.16` or `got 1.40.0`
- **AND** after the fix the same input SHALL be accepted

#### Scenario: Historical v1.33.0 matching provenance remains accepted

- **WHEN** ship FRG observation runs for version `1.33.0`
- **AND** release-eligible `latest.json` has `pack_provenance` whose candidate SHA, repository, and base branch match the train and intent
- **THEN** observation SHALL return that evidence
- **AND** it SHALL NOT require a post-pilot `factory_release_binding` solely because `pack_provenance` is present

### Requirement: Ship FRG observation SHALL fail closed on post-pilot hybrid-v1, unknown policy, or unbound hybrid-v2

Ship FRG observation SHALL fail closed for a target version after `1.33.0` when release-eligible `latest.json` carries historical hybrid-v1 (`factory-gate-v1-hybrid-v1`), an unknown `pack_provenance.policy_id`, missing `factory_release_binding`, notes-only binding, or a binding that does not fully match the closed checkpoint. The fail-closed message SHALL name the mismatched `policy_id` or the mismatched `factory_release_binding` field. Observation SHALL NOT fall back to `pack_provenance` as the join to the checkpoint. Observation SHALL NOT accept provenance-free post-pilot evidence. Repository, base, candidate, release, manifest, and HMAC defects SHALL continue to fail closed. Unauthenticated `factory_release_binding` overlay SHALL fail HMAC in the shared validator and SHALL NOT become observed ship evidence.

#### Scenario: Hybrid-v1 after v1.33.0 fails closed

- **WHEN** the ship version is `1.40.0` or any other version after `1.33.0`
- **AND** `pack_provenance.policy_id` is `factory-gate-v1-hybrid-v1`
- **THEN** observation SHALL fail closed
- **AND** the message SHALL name that policy id
- **AND** it SHALL NOT return the evidence

#### Scenario: Missing or notes-only binding fails closed

- **WHEN** HMAC-pass hybrid-v2 `latest.json` for a post-pilot ship has no top-level `factory_release_binding`
- **OR** the only binding carrier is a notes string
- **THEN** observation SHALL fail closed
- **AND** the message SHALL name `factory_release_binding`
- **AND** it SHALL NOT treat `pack_provenance` as the checkpoint join

#### Scenario: Checkpoint-mismatched binding fails closed

- **WHEN** HMAC-pass hybrid-v2 `latest.json` for a post-pilot ship has top-level `factory_release_binding`
- **AND** that binding differs from the closed unsigned checkpoint in request fingerprint, target version, candidate SHA, pack identity, pack run id, loop run id, unsigned `frg_run_id`, or an unsigned artifact digest
- **THEN** observation SHALL fail closed
- **AND** the message SHALL name the mismatched binding field
- **AND** it SHALL NOT return the evidence

#### Scenario: Unknown policy, identity mismatch, and invalid HMAC stay fail-closed

- **WHEN** `pack_provenance.policy_id` is unknown, or repository / base / candidate / release / manifest identity does not match the ship intent and train, or HMAC verification fails
- **THEN** observation SHALL NOT accept the artifact
- **AND** HMAC or other release-eligibility failure SHALL remain not-observed (`null`) per the existing observe-null mapping
- **AND** identity defects after a valid eligible read SHALL still throw

#### Scenario: Provenance-free post-pilot evidence is not rebound from the version index

- **WHEN** the ship version is after `1.33.0`
- **AND** release-eligible observation would otherwise proceed without hybrid `pack_provenance`
- **THEN** observation SHALL fail closed
- **AND** it SHALL NOT accept a candidate SHA read only from `.agent-pipeline/factory-release/by-version/<X.Y.Z>.json`

### Requirement: Ship coordinator post-train phases SHALL fail closed while any issue on the ship milestone remains open

After merge-mode train is complete or resumed complete, in-engine `pipeline ship --milestone <m>` SHALL re-observe GitHub immediately before every post-train boundary that can start or resume `factory-release prepare`, Factory Reliability Gate (FRG) pack, FRG convergence, release, or `engine-promote`. The observation SHALL list GitHub issues on that ship milestone with `state: open`. It SHALL exclude pull requests. It SHALL exclude closed issues. It SHALL exclude issues with no milestone, including unmilestoned engine-filed factory-gate pack issues. Pipeline labels (`pipeline:backlog`, `pipeline:ready`, `blocked`, or any other) SHALL NOT exempt an open milestoned issue. An engine-filed factory-gate pack issue that is on the ship milestone and still open SHALL count as remaining work. The operator who wants to ship SHALL close, unmilestone, or move those issues. A handoff answer SHALL NOT be required to fire the gate and SHALL NOT waive it.

The query SHALL paginate to exhaustion. It SHALL fail closed on environment-auth, API, parse, or pagination failure, and when the milestone title cannot be resolved. Inability to prove zero remaining open issues SHALL NOT skip the gate. It SHALL NOT be classified as an engine defect that recovery bypasses. The existing `gh` credential path SHALL be used. A new secret or token SHALL NOT be added.

WHEN at least one remaining open issue exists, ship SHALL fail closed before those operations. The fail-closed message SHALL name the milestone and every remaining open issue number, with no cap that drops numbers. Ship SHALL NOT start `factory-release prepare`, FRG pack, FRG convergence, release, or `engine-promote`. A `--skip-frg` flag, label waiver, or persisted gate pass SHALL NOT authorize those operations this cut.

WHEN the observation proves zero remaining open issues, and freeze-eligible items are integrated, ship SHALL still proceed to FRG on the existing all-closed ready-to-deploy / already-integrated path. Train freeze-eligible membership SHALL stay open non-backlog pipeline issues plus closed `pipeline:ready-to-deploy`. This gate SHALL NOT change which issues train advances. Merge authorization SHALL NOT change: `advance`, `single`, and `loop` SHALL still never merge; ship merge-mode train SHALL keep current operator-authorized merge behavior.

Restart and resume SHALL re-observe GitHub at each later post-train boundary. A previously persisted pass, a prior train freeze snapshot, or a completed earlier post-train phase SHALL NOT authorize a later boundary. A path-local skip in one coordinator branch SHALL NOT be sufficient. The next leftover-open-issue on any later ship milestone SHALL hit this same gate.

#### Scenario: Leftover open backlog after completed train blocks FRG

- **WHEN** merge-mode train for `pipeline ship --milestone v1.40.1` has completed
- **AND** GitHub still has open issue #1344 on that milestone labeled `pipeline:backlog`
- **THEN** ship SHALL fail closed before `factory-release prepare` and FRG pack
- **AND** it SHALL NOT start FRG convergence, release, or `engine-promote`
- **AND** the fail-closed message SHALL name milestone `v1.40.1` and `#1344`

#### Scenario: Pipeline labels do not exempt remaining open issues

- **WHEN** the remaining-open observation finds open issues labeled `pipeline:backlog`, `pipeline:ready`, or `blocked` on the ship milestone
- **THEN** those issues SHALL count as remaining work
- **AND** ship SHALL fail closed before FRG pack, release, and `engine-promote`

#### Scenario: Unmilestoned factory-gate pack issues do not count

- **WHEN** an engine-filed factory-gate pack issue is open and has no milestone
- **AND** every issue that does have the ship milestone is closed
- **THEN** the remaining-open check SHALL treat the milestone as having zero remaining open issues
- **AND** ship SHALL be allowed to proceed to FRG after freeze-eligible items are integrated

#### Scenario: Milestoned factory-gate pack issue does count

- **WHEN** an engine-filed factory-gate pack issue is open and assigned the ship milestone
- **THEN** the remaining-open check SHALL count that issue
- **AND** ship SHALL fail closed until the operator unmilestones or closes it

#### Scenario: Pull requests are not remaining milestone work

- **WHEN** the GitHub issues listing for the ship milestone includes an open pull request and no open issues
- **THEN** the remaining-open check SHALL exclude that pull request
- **AND** ship SHALL be allowed to proceed to FRG after freeze-eligible items are integrated

#### Scenario: Query failure fails closed

- **WHEN** GitHub auth, the milestone issue query, parse, or pagination cannot prove that zero open issues remain
- **THEN** ship SHALL fail closed before `factory-release prepare`, FRG pack, release, and `engine-promote`
- **AND** recovery SHALL NOT classify that failure as an engine defect that bypasses the gate

#### Scenario: Restart and resume re-observe GitHub

- **WHEN** a prior remaining-open observation proved zero open issues and FRG pack completed
- **AND** an operator re-invokes `pipeline ship --milestone` for the same milestone
- **AND** GitHub now shows at least one open issue on that milestone
- **THEN** ship SHALL fail closed before the next post-train boundary (FRG convergence, release, or `engine-promote`)
- **AND** it SHALL NOT treat the earlier observation or the completed pack as authorization

#### Scenario: Zero remaining open issues still reaches FRG

- **WHEN** freeze-eligible items are integrated
- **AND** the remaining-open observation proves zero open GitHub issues on the ship milestone
- **THEN** ship SHALL proceed to FRG pack
- **AND** the all-closed ready-to-deploy / already-integrated path SHALL remain available

### Requirement: Remaining-open ship-end regressions SHALL be guarded by automated tests

The test suite SHALL fail if in-engine `pipeline ship --milestone` starts FRG pack or FRG convergence after a completed train when a leftover open `pipeline:backlog` issue remains on that milestone. Separate tests SHALL fail if blocked release or `engine-promote` invokes its operation. Additional tests SHALL prove restart/resume re-observation, pull-request exclusion, pagination to exhaustion, query/parse/pagination failure, unmilestoned factory-gate fixture exclusion, and the no-open-issues path proceeding to FRG. These tests SHALL inject I/O and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: Leftover open backlog after train fails CI if FRG runs

- **WHEN** a hermetic fixture models a completed train and a leftover open `pipeline:backlog` issue on the ship milestone
- **AND** the system under test invokes FRG pack or FRG convergence
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Blocked release and promote fail CI if the operation runs

- **WHEN** a hermetic fixture models leftover open milestone issues at a release or `engine-promote` boundary
- **AND** the system under test invokes that operation
- **THEN** the test SHALL fail

#### Scenario: Pagination and query-failure fixtures fail CI if the gate is skipped

- **WHEN** a hermetic fixture models a truncated listing, a parse failure, or a query failure
- **AND** the system under test proceeds as if zero open issues remained
- **THEN** the test SHALL fail
