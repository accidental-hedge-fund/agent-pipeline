## ADDED Requirements

### Requirement: Deterministic preconditions SHALL run before the spec-generation model call

The `intake` handler SHALL evaluate every deterministic precondition that does not depend on the generated spec BEFORE it invokes the spec-generation model harness. These preconditions SHALL include at minimum: the validity of the `--release` argument when supplied, resolution of `origin/<base_branch>` to an immutable commit SHA, readability of `ROADMAP.md` at that SHA, resolution of the target release slot (explicit `--release` or inferred), and the presence of the **global** ROADMAP table anchors that every intake insertion depends on — the release-plan `| *(none)* |` sentinel row and the per-issue sem-ver table header. When any such precondition fails, the command SHALL exit non-zero WITHOUT making any model harness call, so a doomed intake terminates at zero token cost. The spec-generation harness SHALL be invoked at most once, and only after every deterministic precondition has passed.

A **global** table anchor (the release-plan sentinel row or the per-issue table header) is distinct from a **target-release** structure (the `### vX.Y.Z` detail section): the absence of a global anchor means `ROADMAP.md` is malformed and SHALL fail this precondition, whereas the absence of a target-release detail section SHALL NOT fail here (it is handled by the scaffold-or-degrade requirement).

#### Scenario: A missing global ROADMAP table anchor fails before the harness runs

- **WHEN** the release-plan `| *(none)* |` sentinel row (or the per-issue table header) is absent from `ROADMAP.md` at the pinned base SHA
- **THEN** the command SHALL exit non-zero with a named-anchor error
- **AND** the spec-generation model harness SHALL NOT be invoked (zero harness calls)
- **AND** no GitHub issue is created and no PR is opened

#### Scenario: An unresolvable base branch fails before the harness runs

- **WHEN** `origin/<base_branch>` cannot be resolved to a commit SHA (e.g. it is not fetched)
- **THEN** the command SHALL exit non-zero with a resolve/read error
- **AND** the spec-generation model harness SHALL NOT be invoked

#### Scenario: The harness runs exactly once after all preconditions pass

- **WHEN** every deterministic precondition (release validity, base SHA, ROADMAP readability, slot resolution, global anchors) succeeds
- **THEN** the spec-generation harness SHALL be invoked, and SHALL be the only model-invoking step
- **AND** it SHALL be invoked at most once per successful intake (retry-once on capture-shaped output notwithstanding)

### Requirement: A missing target-release detail section SHALL NOT discard the generated spec

When the target release's `### vX.Y.Z` detail section is absent from `ROADMAP.md` — for example a milestone that exists on GitHub but was created without ROADMAP structure — the handler SHALL NOT abort after spec generation and discard the generated spec. It SHALL instead **scaffold** the minimal missing detail-section heading onto the intake branch so that the detail-section bullet, the release-plan table row, and the per-issue sem-ver row all land in the same human-reviewed PR. The scaffolding SHALL be idempotent: when the `### vX.Y.Z` heading already exists, no duplicate heading SHALL be inserted.

If the missing structure genuinely cannot be scaffolded, the handler SHALL **degrade**: it SHALL complete GitHub issue creation and SHALL print an explicit roadmap-gap report naming the missing structure and the reconciliation command (`pipeline roadmap --apply` / `pipeline sweep --apply`). Under no circumstance SHALL a generated spec be silently discarded because of a missing target-release ROADMAP structure. The release-plan row and per-issue row are inserted against the global anchors and SHALL require no pre-existing per-version structure.

#### Scenario: Milestone exists on GitHub but ROADMAP has no detail section — scaffold

- **WHEN** intake targets `vX.Y.Z` and `ROADMAP.md` has no `### vX.Y.Z` detail section, but the global release-plan and per-issue table anchors are present
- **THEN** the handler SHALL scaffold a minimal `### vX.Y.Z` detail-section heading on the intake branch
- **AND** the resulting ROADMAP PR SHALL contain that new heading, a release-plan table row, a per-issue sem-ver row, and a detail-section bullet — all referencing the same issue number and version
- **AND** the GitHub issue SHALL still be created (the spec is not discarded)

#### Scenario: Scaffolding is idempotent when the section already exists

- **WHEN** the `### vX.Y.Z` detail section already exists
- **THEN** the handler SHALL insert the detail bullet without adding a duplicate heading

#### Scenario: Degrade fallback still creates the issue and reports the gap

- **WHEN** the target-release detail section cannot be scaffolded (the detail-section container is itself absent or unrecognizable)
- **THEN** the handler SHALL complete GitHub issue creation
- **AND** SHALL print a roadmap-gap report naming the missing structure and the reconciliation command
- **AND** SHALL NOT silently discard the generated spec

#### Scenario: Dry-run reflects the scaffolded structure and writes nothing

- **WHEN** the user runs `pipeline intake --description "..." --release vX.Y.Z --dry-run` and `ROADMAP.md` has no `### vX.Y.Z` detail section
- **THEN** the printed ROADMAP diff SHALL include the scaffolded `### vX.Y.Z` heading and the three insertions
- **AND** no GitHub issue is created, no file is written, no branch is created, and no PR is opened

## MODIFIED Requirements

### Requirement: The `intake` sub-command SHALL create a GitHub issue from the generated spec

The handler SHALL call the GitHub API to create an issue in the target repo as the FIRST irreversible action — only after every reversible prerequisite has succeeded: the deterministic preconditions that do not depend on the generated spec (evaluated BEFORE spec generation — see the preconditions requirement), spec generation, spec validation, ROADMAP mutation preparation (scaffolding the target-release detail section when it is absent rather than aborting — see the scaffold-or-degrade requirement), the clean-working-tree check, and preparation AND atomic reservation of the release branch. Branch preparation SHALL (1) derive a collision-resistant branch name that two concurrent runs with the same generated title and base SHA cannot share (e.g. by including a random token), and (2) RESERVE the remote ref create-only BEFORE the issue is created. The reservation SHALL satisfy three properties: (a) it SHALL fail when the ref already exists at ANY SHA — including the same base SHA (a plain push no-ops "up-to-date") and an ancestor SHA (a plain push would fast-forward and MOVE the existing ref) — and it SHALL NOT modify an existing ref; (b) it SHALL exercise the SAME push transport and credentials used to publish the roadmap commit afterwards, so a missing or read-only push credential fails during reservation (before the issue) rather than after it; and (c) on collision or failure it SHALL abort before issue creation. The reference implementation uses `git push` with an empty `--force-with-lease` (expect the ref absent) and treats only a newly-created ref status (`*`) as success. A failure in any preparatory step SHALL abort before issue creation so a labeled issue is never stranded without its roadmap PR. The post-issue push of the roadmap commit is then a fast-forward onto the already-reserved ref over the just-proven credential. The issue body SHALL be the full generated spec text. The issue SHALL receive at minimum two labels: one `pipeline:ready` triage label and one `release:vX.Y.Z` label whose value is either the `--release` argument or the proposed release slot.

The handler SHALL ensure both required labels exist before issue creation in a CREATE-ONLY manner: it SHALL create a label that is absent but SHALL NOT modify (clobber) the color or description of a label that already exists. An "already exists" result from the create call SHALL be treated as success.

#### Scenario: Issue created with correct labels

- **WHEN** intake runs successfully with `--release v1.7.0`
- **THEN** a GitHub issue is created with the generated spec as its body
- **AND** the issue carries both the `pipeline:ready` label and the `release:v1.7.0` label

#### Scenario: Proposed release slot when `--release` is omitted

- **WHEN** the user runs `pipeline intake --description "..."` without `--release`
- **THEN** the handler proposes a release slot derived from the roadmap context (e.g., the next open minor version lane)
- **AND** the issue is created with a `release:vX.Y.Z` label matching the proposed slot

#### Scenario: Branch-preparation failure never strands a labeled issue

- **WHEN** the release branch cannot be prepared (e.g., the base SHA is unresolvable, the branch name collides locally, or the working tree is dirty)
- **THEN** the command SHALL abort with a non-zero exit and SHALL NOT create any GitHub issue or open any PR

#### Scenario: A pre-existing remote branch aborts before issue creation

- **WHEN** a branch with the chosen head name already exists on `origin` (e.g., a prior intake run reserved it), even at the same base SHA
- **THEN** the atomic create-only reservation SHALL fail and the command SHALL abort with a non-zero exit BEFORE creating the issue
- **AND** no GitHub issue is created and no PR is opened

#### Scenario: Reservation failure aborts before issue creation

- **WHEN** the pre-issue atomic reservation of `origin/<branch>` fails (a colliding ref, or missing push/API capability)
- **THEN** the command SHALL abort with a non-zero exit BEFORE creating the issue
- **AND** no GitHub issue is created and no PR is opened

#### Scenario: Reservation is create-only, not a no-op push

- **WHEN** `origin/<branch>` already exists and points at the same base SHA the reservation would use
- **THEN** the reservation SHALL still be treated as a collision and abort before issue creation (it SHALL NOT succeed as a no-op "up-to-date" push that would let two runs both create issues)

#### Scenario: Reservation never moves an existing branch

- **WHEN** `origin/<branch>` already exists at an ANCESTOR of the reservation SHA
- **THEN** the reservation SHALL fail and abort before issue creation WITHOUT fast-forwarding (moving) the existing ref, so a prior intake or human branch is never advanced or corrupted

#### Scenario: A read-only or missing push credential aborts before issue creation

- **WHEN** the checkout's `origin` push credential is missing or read-only
- **THEN** the reservation (which uses the same push transport as the roadmap publish) SHALL fail and the command SHALL abort BEFORE creating the issue
- **AND** no GitHub issue is created and no PR is opened

#### Scenario: Concurrent identical specs cannot share a branch

- **WHEN** two intake runs generate the same title against the same base SHA at the same time
- **THEN** the collision-resistant branch names SHALL differ, so neither run's reservation push collides with the other and neither strands an issue

#### Scenario: Existing label metadata is not clobbered

- **WHEN** intake ensures `pipeline:ready` or `release:vX.Y.Z` and that label already exists with a curated color/description
- **THEN** the handler SHALL treat the label as present and SHALL NOT change its color or description (no `--force`)
