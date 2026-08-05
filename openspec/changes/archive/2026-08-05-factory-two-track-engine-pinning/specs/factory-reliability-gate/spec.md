## ADDED Requirements

### Requirement: FRG Layer B SHALL be the designated candidate-track soak for promote eligibility

A live FRG Layer B run that exercises a release candidate engine build SHALL execute and record
evidence on the **candidate** engine track. The FRG driver SHALL ensure the resulting evidence
artifact continues to name the candidate `version` under test. An FRG `pass: true` for that
version is the eligibility signal for promoting the factory production pin to that version; the
FRG driver MAY offer an explicit opt-in promote step or command after pass, but SHALL NOT promote
silently without operator-visible action when a pin write would modify the repository. FRG
SHALL NOT merge pull requests, create git tags, or enable auto-merge as part of promote.

#### Scenario: Layer B soak is labeled candidate

- **WHEN** the FRG Layer B driver runs against a candidate engine for version `1.30.0`
- **THEN** the associated run evidence SHALL record engine track `candidate`
- **AND** the FRG evidence artifact SHALL name version `1.30.0`

#### Scenario: Pass is promote-eligible but not an autonomous merge

- **WHEN** FRG evidence for version `1.30.0` is recorded with `pass: true`
- **THEN** that artifact SHALL be sufficient eligibility for a subsequent production-pin promote
  of `1.30.0`
- **AND** the FRG driver SHALL NOT merge any PR or create any git tag as a side effect of
  recording the pass

#### Scenario: Failed FRG is not promote-eligible

- **WHEN** FRG evidence for version `1.30.0` exists with `pass: false`
- **THEN** the production pin SHALL NOT be promoted to `1.30.0` on the basis of that artifact

---

### Requirement: FRG documentation SHALL describe candidate soak vs pinned production dogfood

The FRG runbook (or a clearly linked two-track section) SHALL state that: (1) factory production
and dogfood loops run the **pinned** last-promoted FRG-passed release; (2) FRG Layer B soaks the
**candidate** until pass; (3) promote updates the production pin and requires reinstall from the
new tag; (4) rollback repoints the pin to a previous FRG-passed release and reinstalls. The
runbook SHALL NOT describe FRG pass as authorizing auto-merge.

#### Scenario: Runbook distinguishes pinned dogfood from candidate FRG

- **WHEN** an operator reads the FRG runbook two-track section
- **THEN** it SHALL state that production dogfood uses the pinned install
- **AND** SHALL state that Layer B exercises the candidate until FRG pass promotes the pin
