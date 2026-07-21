## ADDED Requirements

### Requirement: The `ci:openspec` gate SHALL fail when unexpected OpenSpec changes are active on the default branch
The `ci:openspec` step SHALL, after running `openspec validate --all`, check the entries under `openspec/changes/`. Every subdirectory other than `archive/` is an active change. When the gate is evaluating the repository's default branch, any active change whose id is not present in the allowlist SHALL be an error: the step SHALL exit non-zero, SHALL print every offending change id, and SHALL print the expected cleanup path (the change is archived automatically at pre-merge, or manually via `openspec archive <id>`). The check SHALL run after validation so that a structurally invalid change is reported as invalid rather than merely unexpected, and both failures SHALL be reported when both apply.

#### Scenario: Unallowlisted active change on the default branch
- **WHEN** the gate runs in default-branch mode against a repo whose `openspec/changes/` contains `legacy-thing/` and no allowlist entry for it
- **THEN** the step SHALL exit non-zero
- **AND** its output SHALL contain the id `legacy-thing`
- **AND** its output SHALL name the expected cleanup path (`openspec archive`)

#### Scenario: Several unallowlisted active changes are all reported
- **WHEN** the gate runs in default-branch mode with three unallowlisted active changes
- **THEN** the step SHALL exit non-zero
- **AND** its output SHALL list all three change ids, not only the first

#### Scenario: Clean default branch passes
- **WHEN** the gate runs in default-branch mode and `openspec/changes/` contains only `archive/`
- **THEN** the step SHALL exit zero

#### Scenario: Validation failure still reported ahead of the hygiene check
- **WHEN** the gate runs against a repo containing a structurally invalid change
- **THEN** `openspec validate --all` SHALL still run and its failure SHALL be surfaced
- **AND** the step SHALL exit non-zero

#### Scenario: Repository without an OpenSpec workspace
- **WHEN** the gate runs in a repo with no `openspec/` directory
- **THEN** the step SHALL exit zero without running validation or the hygiene check

---

### Requirement: The hygiene check SHALL be inert outside the default branch
A pull-request branch legitimately carries its own in-flight OpenSpec change, so the check SHALL NOT fail there. The gate SHALL resolve its mode in this order: the `OPENSPEC_HYGIENE_MODE` environment variable (`default-branch`, `pr`, or `off`) when set; otherwise GitHub Actions environment (`GITHUB_EVENT_NAME` of `push` with `GITHUB_REF` equal to the default branch ref ⇒ default-branch mode; `pull_request` ⇒ inert); otherwise the locally checked-out branch compared against the resolved default branch name. When the mode cannot be determined the check SHALL be inert (fail-open), because a false positive would block every pull request while a false negative is re-detected on the next push to the default branch.

#### Scenario: Pull-request mode with an active change
- **WHEN** the gate runs in pull-request mode and `openspec/changes/` contains one active change
- **THEN** the step SHALL exit zero and SHALL NOT report the change as an error

#### Scenario: Explicit environment override wins
- **WHEN** `OPENSPEC_HYGIENE_MODE` is set to `default-branch`
- **THEN** the check SHALL run in default-branch mode regardless of the GitHub Actions or local git environment

#### Scenario: Mode cannot be determined
- **WHEN** no `OPENSPEC_HYGIENE_MODE` is set, no recognised GitHub Actions event is present, and the checked-out branch is not the default branch (or cannot be resolved)
- **THEN** the check SHALL be inert and the step SHALL exit zero

---

### Requirement: A reviewed allowlist SHALL be the only exemption from the hygiene check
The repository SHALL keep a checked-in allowlist at `openspec/active-allowlist.txt` containing one change id per line, ignoring blank lines and lines beginning with `#`. A missing or empty file SHALL mean zero exemptions. An allowlisted active change SHALL NOT fail the check. An allowlist entry naming a change id that is not currently active SHALL be an error, so that a stale exemption cannot silently keep the hole it was granted for open.

#### Scenario: Allowlisted active change passes
- **WHEN** `openspec/active-allowlist.txt` lists `long-lived-change` and that change is active on the default branch
- **THEN** the step SHALL exit zero

#### Scenario: Comments and blank lines are ignored
- **WHEN** the allowlist contains blank lines and `#`-prefixed comment lines alongside one change id
- **THEN** only the change id SHALL be treated as an exemption

#### Scenario: Stale allowlist entry is an error
- **WHEN** the allowlist names a change id that does not exist under `openspec/changes/`
- **THEN** the step SHALL exit non-zero and SHALL name the stale entry

#### Scenario: Missing allowlist file means strict
- **WHEN** `openspec/active-allowlist.txt` does not exist and an active change is present in default-branch mode
- **THEN** the step SHALL exit non-zero

---

### Requirement: Archiving a completed change SHALL preserve its audit material and its shipped requirements
When a completed OpenSpec change is retired from `openspec/changes/`, its artifacts SHALL remain discoverable under `openspec/changes/archive/<id>/` rather than being deleted. Requirements from the change that describe shipped behavior SHALL be present in the living specs under `openspec/specs/` after archiving — either because they are already there (archive with spec merge skipped) or because archiving merged them. A change that was never implemented SHALL be archived with a written note naming the reason it was retired and any follow-up issue that carries the surviving intent.

#### Scenario: Legacy change with requirements already in living specs
- **WHEN** a legacy change's delta requirements are already present in `openspec/specs/<capability>/spec.md`
- **THEN** it SHALL be archived without re-merging its deltas
- **AND** its `proposal.md` and remaining artifacts SHALL be readable under `openspec/changes/archive/<id>/`

#### Scenario: Legacy change describing shipped behavior missing from living specs
- **WHEN** a legacy change corresponds to merged work but its requirements are absent from `openspec/specs/`
- **THEN** archiving SHALL merge its deltas into the living specs
- **AND** `openspec validate --all` SHALL pass afterwards

#### Scenario: Legacy change that was never implemented
- **WHEN** a legacy change has no merged implementation and is superseded or abandoned
- **THEN** it SHALL be archived with a note naming the reason and any follow-up issue
- **AND** its artifacts SHALL NOT be deleted

#### Scenario: Per-PR archiving is unchanged
- **WHEN** a pipeline pull request reaches pre-merge with its own active change
- **THEN** the existing pre-merge archive behavior SHALL apply unchanged and SHALL NOT be weakened by this hygiene check
