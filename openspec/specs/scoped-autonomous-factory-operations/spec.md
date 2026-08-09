# scoped-autonomous-factory-operations Specification

## Purpose
TBD - created by archiving change add-scoped-autonomous-factory-operations. Update Purpose after archive.
## Requirements
### Requirement: The scoped factory profile SHALL be opt-in and disabled by default

The repository SHALL provide a deployment profile for a Hermes-supervised factory on `agent-box`. The profile SHALL be disabled by default and SHALL NOT change ordinary Pipeline command behavior. Enabling the profile SHALL require machine-local configuration and an authenticated release grant. The profile SHALL compose existing Pipeline and GitHub surfaces and SHALL NOT add a public Pipeline API, MCP server, state machine, scheduler, or `auto_merge` configuration key.

#### Scenario: Normal repository use is unchanged

- **WHEN** the scoped factory profile is not installed or is disabled
- **THEN** `pipeline advance`, `pipeline single`, and `pipeline loop` SHALL stop at `pipeline:ready-to-deploy`
- **AND** no pull request, release, tag, pin, or installed engine SHALL be changed by the factory

#### Scenario: Repository config cannot enable the factory

- **WHEN** a repository sets `auto_merge` or a factory-authority key in `.github/pipeline.yml`
- **THEN** strict configuration validation SHALL reject the unknown key
- **AND** no deployment grant SHALL be created from repository configuration

### Requirement: Every factory mutation SHALL be covered by one authenticated immutable grant

Before it performs a mutation, the factory SHALL validate one active grant received through the native Buzz gateway's configured operator and private-stream filters. The grant SHALL bind a schema version, nonce, repository, base branch, exact release version, ordered issue list, allowed actions, required Grok model, issue and time limits, issue time, expiry, sender identity, channel identity, message identity, and thread identity. The factory SHALL derive and persist a stable grant fingerprint. The pilot wrapper SHALL validate the relay-observed context supplied by Hermes, but SHALL NOT claim that it independently verifies the Nostr event signature. A display name, unrelated prompt, repository file, or unscoped tool argument SHALL NOT add or widen the grant fields that the wrapper accepts.

#### Scenario: Valid grant admits only its exact scope

- **WHEN** an unexpired grant with matching relay-observed operator, channel, message, and thread context names repository R, base B, release V, ordered issues I, and actions A
- **THEN** the factory MAY perform only actions A for R, B, V, and I
- **AND** every action record SHALL name the grant fingerprint and the relay-observed Buzz message identity

#### Scenario: Scope mismatch stops before mutation

- **WHEN** the sender, channel, repository, base, version, issue, order, action, model, or expiry does not match the active grant
- **THEN** the factory SHALL stop before the next mutation
- **AND** it SHALL report the mismatched field without disclosing a secret

#### Scenario: Grant replay resumes instead of widening authority

- **WHEN** the same authenticated grant event is delivered again
- **THEN** the factory SHALL reconcile and resume the same grant identity
- **AND** it SHALL NOT create a second grant or repeat a completed action

### Requirement: Grok work SHALL use only grok-4.5 and Codex SHALL review

The factory deployment and target Pipeline profile SHALL configure Grok planning, implementation, and fix roles to use exactly `grok-4.5`. They SHALL configure no Grok model fallback. Codex SHALL remain the independent review harness. A provider response that cannot run `grok-4.5`, silently substitutes another Grok model, or omits the effective model identity SHALL stop the factory.

#### Scenario: Required Grok model is available

- **WHEN** the factory starts an issue
- **THEN** its preflight and run evidence SHALL identify `grok-4.5` for every Grok role
- **AND** review SHALL identify Codex as the configured reviewer

#### Scenario: Grok model drifts

- **WHEN** the provider cannot run `grok-4.5` or reports a different effective Grok model
- **THEN** the factory SHALL stop before accepting implementation output
- **AND** it SHALL NOT use a fallback Grok model

### Requirement: Dependency-bearing work SHALL run as one-item integration waves

For the startup profile, the factory SHALL process the grant's issue list in its fixed order, one issue at a time. It SHALL invoke the installed Pipeline CLI for one issue and wait for a terminal result. It SHALL merge only the exact linked pull request after `pipeline:ready-to-deploy`. Before it starts the next issue, it SHALL bind the inspected pull-request head to the merged pull request, record the merge-result commit, freshly fetch the configured base, and prove that the merge-result commit is contained in that base. For the first frozen train, the fetched base tip SHALL equal that observed merge-result commit. An unrelated base advance SHALL stop the train instead of silently adding work outside the grant.

For squash merges, the inspected candidate head SHALL be the identity proof and the same pull request's `mergeCommit.oid` SHALL be the containment proof. The candidate head itself SHALL NOT be required to be an ancestor of the base.

#### Scenario: Ready-to-deploy alone does not release the next issue

- **WHEN** issue A reaches `pipeline:ready-to-deploy` but its exact merge result is not proved in the configured base
- **THEN** issue B SHALL NOT start
- **AND** the factory SHALL remain at the A integration step or stop on an error

#### Scenario: Squash merge releases the next issue after proof

- **WHEN** the merged pull request's merge-time head equals the head inspected before merge
- **AND** a fresh fetch proves that the same pull request's `mergeCommit.oid` is an ancestor of `origin/<base>`
- **THEN** the factory MAY fast-forward its control checkout and start the next issue

#### Scenario: Changed head fails closed

- **WHEN** the pull-request head changes after the factory records its merge candidate
- **THEN** the factory SHALL NOT merge or release the next issue under the old evidence
- **AND** fresh Pipeline and grant checks SHALL be required

#### Scenario: Unrelated base advance stops the frozen train

- **WHEN** a fresh fetch after the granted merge finds a base tip other than the same pull request's observed merge-result commit
- **THEN** the factory SHALL stop with base drift
- **AND** it SHALL NOT include the unrelated commit in the release candidate under the old grant

### Requirement: Issue pull requests SHALL merge only through pipeline merge

The factory SHALL use `pipeline merge <pr>` for an issue pull request. It SHALL NOT replace that command with raw `gh pr merge`, force merge, merge queue apply, a direct API call, or a merge inside the advance path. The deployment grant validator SHALL check scope before invocation, and the existing command SHALL still enforce linked ready-to-deploy state, mergeability, required checks, and exact head.

#### Scenario: Granted issue merge uses the existing primitive

- **WHEN** an in-scope issue has an exact linked pull request at `pipeline:ready-to-deploy`
- **THEN** the factory SHALL invoke `pipeline merge <pr>`
- **AND** the ordinary merge gates SHALL remain in effect

#### Scenario: Unsupported mutation is refused

- **WHEN** a requested factory action would use `merge-queue --apply`, force push, force merge, or raw issue-PR merge
- **THEN** the deployment grant validator SHALL refuse the action
- **AND** no GitHub mutation SHALL occur

### Requirement: Release finalization SHALL require current FRG and exact release identity

After every granted issue merge is contained in the base, the factory SHALL run the representative Factory Reliability Gate for the exact release version. For v1.33.0, the narrow hybrid rule in the `factory-reliability-gate` delta applies: safe outcomes require live pack proof and unsafe fault classes require exact candidate-bound Layer A proof. It SHALL require current release-eligible passing evidence with a valid producer attestation and SHALL NOT use a soak-defect override, caller-authored pass field, or invented observation. For v1.33.0, it SHALL then run the existing prepare-only release command from a clean checkout of the fetched base. Later releases SHALL use the #908 candidate-native prepare interface defined below.

The separate factory finalizer MAY merge the release pull request only when the active grant names that version and action, the repository and base match, version files and title match, the changed files are release-managed, the FRG identity matches, the head is unchanged, required checks pass, and the pull request is clean. The merge SHALL use an exact-head guard. On an ambiguous response, the factory SHALL inspect current GitHub state before any retry.

#### Scenario: FRG failure stops release preparation

- **WHEN** required FRG evidence is missing, invalid, stale, unattested, waived, outside the v1.33.0 hybrid boundary, or reports `pass: false`
- **THEN** the factory SHALL NOT prepare or merge the release pull request
- **AND** it SHALL stop with the FRG evidence reason

#### Scenario: Exact release pull request may be finalized

- **WHEN** all release identity, FRG, changed-file, mergeability, exact-head, and required-check gates pass under the active grant
- **THEN** the factory finalizer MAY merge that exact release pull request
- **AND** the prepare command itself SHALL remain prepare-only

### Requirement: Publication SHALL be verified before production promotion and install

After release-PR merge, the factory SHALL wait for the existing tag and GitHub Release workflows. It SHALL prove that `vX.Y.Z` is an annotated tag whose peeled commit equals the observed release merge commit. It SHALL also prove that a published, non-draft GitHub Release exists for the same tag. Only then MAY it promote the production pin, install the exact tag on `agent-box`, and run `pipeline doctor --json --harness-smoke` in the exact service environment.

The installed command path, version, production pin, tag, and release commit SHALL agree before the factory admits another release. On install or doctor failure, the factory SHALL reinstall the previous verified production pin, run doctor, and remain stopped.

#### Scenario: Verified release updates the self-hosted factory

- **WHEN** the annotated tag, peeled release commit, and published GitHub Release agree
- **THEN** the factory MAY promote the pin and install that exact tag
- **AND** the next run SHALL invoke the newly installed Pipeline version

#### Scenario: Publication mismatch blocks promotion

- **WHEN** the tag is lightweight, peels to another commit, the GitHub Release is missing or draft, or identities disagree
- **THEN** the factory SHALL NOT promote or install the new version
- **AND** it SHALL NOT rewrite the remote tag or release

### Requirement: A verified install SHALL preserve self-build continuity

Issue #898 SHALL ship the stable bootstrap wrapper in v1.33.0. Its temporary hybrid FRG and release preparation path SHALL apply only to v1.33.0. For every later release, the wrapper SHALL prove the installed launcher against the current production pin, fetch current `main`, and derive the starting frontier and final integrated candidate from those observed identities. It SHALL NOT use a static `bootstrap_base_git_sha` or static `candidate_version` as authority for a later release.

Issue #908 SHALL ship in v1.34.0 after #890 and #891 and SHALL expose `pipeline factory-release prepare --request <absolute-request.json> --json`. The wrapper SHALL invoke that exact interface from the integrated candidate as an idempotent two-call protocol. The first call SHALL return `awaiting_frg_attestation` with unsigned artifact identities and digests. The wrapper SHALL attest them through the fixed trusted production-owned attestor. The second call with the unchanged request SHALL return the complete release pull request. Issue #909 SHALL also ship in v1.34.0 after #890 and #891. After publication proof, pin promotion, exact-tag install, and doctor pass, the same wrapper and config SHALL be able to start the next release without manual replacement.

#### Scenario: Two consecutive releases use the promoted engine

- **WHEN** the factory starts with a verified v1.33.0 production pin and fresh `main` contains the v1.34.0 candidate with #908
- **AND** its first candidate call returns `awaiting_frg_attestation`, the verified v1.33.0 production signer attests the exact unsigned artifacts, and its second unchanged call returns the complete v1.34.0 release pull request
- **AND** it verifies publication, promotes the pin, installs v1.34.0, and passes doctor
- **THEN** the next grant SHALL use v1.34.0 as its verified production engine and starting base
- **AND** it SHALL require no manual wrapper replacement or release-identity config edit

#### Scenario: Static bootstrap identity cannot authorize a later release

- **WHEN** a target release is later than v1.33.0
- **THEN** the wrapper SHALL derive the release start from the verified installed production pin and freshly fetched `main`
- **AND** stale bootstrap-base or candidate-version config SHALL NOT select or authorize the candidate
- **AND** a missing or failed candidate-native prepare interface SHALL stop instead of using the v1.33.0 hybrid

### Requirement: Candidate release code SHALL not cross the FRG signing boundary

The factory SHALL NOT place the FRG attestation credential or its path in the candidate environment, inherited file descriptors, or the candidate-action cgroup's credential mount. The existing scorer unit SHALL run a fixed wrapper-local trusted attestor that does not start a child process, use the network, import or execute candidate code, or import request-selected code. For v1.33.0, that attestor SHALL use the pinned #898 policy snapshot. For later releases, it SHALL use the verified current production signer and SHALL stop on an unsupported schema or policy.

The pilot explicitly accepts that `mcomardo` and passwordless sudo have broad local authority. A malicious same-user process can read or control local resources. The process split prevents automatic credential propagation and candidate-selected attestor behavior; it does not provide privilege separation. Issues #618, #899, or later hardening own that boundary.

The wrapper-to-attestor request SHALL contain only versioned identity fields, closed data paths under fixed allowed roots, and expected digests. It SHALL contain no executable path, module, command, network target, pass claim, or candidate-selected signer. The attestor SHALL return only the bounded attestation result and SHALL never return key material.

#### Scenario: Candidate action receives no automatic FRG credential

- **WHEN** the wrapper starts candidate release code and processes its attestation handoff
- **THEN** the candidate environment SHALL contain no FRG credential or credential path
- **AND** the candidate SHALL inherit no FRG key file descriptor
- **AND** the candidate-action cgroup SHALL have no FRG credential mount
- **AND** the request, result, error, log, and notice SHALL contain no credential and SHALL redact its path

#### Scenario: Candidate cannot select trusted attestor behavior

- **WHEN** candidate output sends a credential path, executable path, import, traversal, symlink escape, command, or network target through the attestation handoff
- **THEN** the trusted attestor SHALL reject the request without importing or executing candidate code, starting a child process, using the network, or disclosing secret data

#### Scenario: Same-user authority remains explicit

- **WHEN** a malicious process runs as `mcomardo` or uses the pilot's passwordless sudo outside the wrapper handoff
- **THEN** #898 SHALL make no claim that it prevents that process from reading or controlling local resources
- **AND** #618, #899, or later hardening SHALL own any required privilege separation

#### Scenario: Unsupported future policy fails closed

- **WHEN** candidate artifacts require a request schema, evidence schema, or FRG policy that the verified current production signer does not support
- **THEN** the wrapper SHALL stop before attestation or release preparation
- **AND** it SHALL NOT load a signer from the candidate or accept a candidate-authored pass claim

### Requirement: Buzz monitoring SHALL use existing evidence and SHALL not gate Pipeline

Hermes SHALL use its native Buzz gateway with a dedicated Nostr identity, an exact private channel allowlist, an exact operator-key allowlist, and a mention requirement. The factory SHALL send deterministic, redacted notices for material run, issue, stage, pull-request, merge, FRG, release, install, rollback, stop, and failure changes. It MAY send one bounded heartbeat after a documented interval without a material event.

Notices SHALL be derived from existing Pipeline event streams, the shared material filter, GitHub observations, and service state. They SHALL NOT contain raw prompts, model output, environment values, credentials, or unredacted tool output. Buzz delivery failure SHALL NOT authorize, block, advance, or fail a Pipeline stage.

#### Scenario: Material progress reaches the private stream

- **WHEN** a material factory or Pipeline transition occurs
- **THEN** the factory SHALL send a concise redacted notice to the run's Buzz thread
- **AND** it SHALL retain the local Pipeline and service evidence even if delivery fails

#### Scenario: Buzz outage does not change Pipeline truth

- **WHEN** Buzz is unavailable during an active Pipeline command
- **THEN** the Pipeline command SHALL continue according to its own state and gates
- **AND** direct service logs and local status SHALL remain available

### Requirement: Factory restart, stop, and rollback SHALL fail closed

The factory SHALL persist only the minimum restart journal: grant fingerprint, authenticated message identity, current exact target, Pipeline run identity, service unit, last material-event cursor, command action identity, and observed external result. The journal SHALL NOT become an issue-stage ledger. After restart, the factory SHALL reconcile every recorded step against Pipeline, git, GitHub, release, pin, and installed-version truth before continuing.

A valid stop or revocation SHALL prevent each new forward mutation. If pin promotion or installation already changed production state, the factory MAY use only the grant's rollback action to restore the stored prior pin and exact installed tag and to run doctor. This bounded compensation SHALL NOT merge, publish, promote another version, or continue the release. Expiry, scope drift, target drift, failed checks, `pipeline:needs-human`, blocked Pipeline state, failed FRG, ambiguous mutation, publication mismatch, or unproved rollback SHALL stop the factory and produce a redacted report.

#### Scenario: Restart after an ambiguous mutation

- **WHEN** the factory restarts after a merge or release command returned no definitive result
- **THEN** it SHALL inspect the exact pull request, head, merge result, base, tag, and release state before any retry
- **AND** it SHALL stop if one safe result cannot be proved

#### Scenario: Revocation wins before the next mutation

- **WHEN** the operator sends a valid stop or revoke event
- **THEN** the factory SHALL perform no later forward mutation under that grant
- **AND** it SHALL report the last completed and first suppressed steps

#### Scenario: Stop after promotion permits only compensation

- **WHEN** a stop, revocation, or expiry occurs after production pin promotion or installation has changed state
- **THEN** the factory MAY restore only the stored prior pin and exact installed tag and run doctor
- **AND** it SHALL stop after it proves that rollback or reports that rollback could not be proved

### Requirement: The pilot trust boundary SHALL be explicit and testable

The deployment SHALL document that the pilot's shared `mcomardo` account and GitHub credential are broader than the grant. It SHALL also document that Hermes supplies the Buzz context to the same-user wrapper and that the wrapper does not independently verify the Nostr signature. It SHALL keep the factory disabled until a grant is accepted, keep secrets out of the repository and prompts, use service-owned secret files or systemd credentials, and pin Hermes and Buzz artifacts. Calibration SHALL prove DNS, TLS, Buzz authentication, channel membership, authorized send and receive, model identity, Pipeline doctor, stop, restart, notification redaction, exact command paths, and rollback.

#### Scenario: Pilot is not presented as least privilege

- **WHEN** an operator reads the deployment runbook or status
- **THEN** it SHALL state that the same-user pilot is an accepted risk and not a strong credential boundary
- **AND** it SHALL state that the model-to-wrapper Buzz context handoff is not independent cryptographic verification
- **AND** it SHALL name later privilege isolation as separate work

#### Scenario: Secret canary stays private

- **WHEN** calibration places a canary in each secret input
- **THEN** no Buzz message, journal entry, service log, prompt, or committed file SHALL contain that canary

