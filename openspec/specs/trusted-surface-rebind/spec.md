# trusted-surface-rebind Specification

## Purpose
Bind readiness-relevant verification to a resolved trusted surface so a candidate cannot silently weaken the rules, prompts, policy, schemas, gate commands, rubrics, or ownership mappings used to judge itself. Emit an explicit passthrough, rebound, or blocked decision for every run.

## Requirements

### Requirement: Versioned path classes SHALL enumerate verifier-sensitive surfaces

The pipeline SHALL define a versioned verifier-sensitive path-class registry with integer `path_class_schema_version` starting at `1`. Schema version `1` SHALL include at least these built-in classes:

- `engine_core` — installed engine code and shipped judging modules that define verification behavior
- `engine_prompts` — engine prompt templates used for review, fix, plan, or other judging/writing stages that affect verification outcomes
- `repo_policy` — repository pipeline configuration that governs acceptance (including `.github/pipeline.yml` and documented includes)
- `gate_commands` — configured test, build, and related gate command identity and scripts referenced as gate authority
- `evidence_schemas` — schemas and producer contracts that define authoritative evidence shapes for readiness
- `eval_rubrics` — eval, visual, and shipcheck rubric material used to score or pass readiness-adjacent gates
- `ownership_authority` — ownership and authority mapping material the engine consults for override or stage ownership (excluding repository-config merge grants, which remain structurally rejected elsewhere)

Each class SHALL have a documented matching rule (globs or roots) and a documented trusted-source kind (`installed_engine`, `base_ref`, or `engine_default`). Built-in classes and their default matching rules SHALL be defined by the engine, not by candidate content. Readers and config consumers SHALL ignore unknown future class ids only when explicitly version-gated; v1 consumers MUST understand all v1 built-in class ids.

#### Scenario: v1 registry exposes required class ids

- **WHEN** the path-class registry is loaded at `path_class_schema_version` 1
- **THEN** it SHALL include `engine_core`, `engine_prompts`, `repo_policy`, `gate_commands`, `evidence_schemas`, `eval_rubrics`, and `ownership_authority`
- **AND** each class SHALL declare a trusted-source kind

#### Scenario: candidate content cannot redefine built-in classes

- **WHEN** a candidate adds or edits files that claim to redefine built-in path-class membership
- **THEN** the engine SHALL continue to use the engine-defined v1 registry for classification
- **AND** SHALL NOT treat candidate-authored class definitions as authority for that run’s decision

---

### Requirement: Trusted revision resolution SHALL be deterministic and source-bound

For each path class, the pipeline SHALL resolve a trusted revision from the class’s trusted-source kind:

- `installed_engine` — content and identity of the running installed engine pin (version, root, template snapshot / engine fingerprint), not the candidate worktree when that worktree is under evaluation
- `base_ref` — content of matching paths at the authoritative integration base SHA for the run
- `engine_default` — engine-shipped defaults when no repository file exists at base

Resolution inputs SHALL be injectable (base tree reader, engine identity, candidate changed-path set, candidate SHA, base SHA, registry). Resolution SHALL be pure with respect to those inputs. The pipeline SHALL NOT accept harness prose, reviewer free text, or model-authored JSON as trusted revision material. When a required class cannot be resolved (unreadable base, missing engine pin, incomplete digests), resolution for that class SHALL fail closed rather than invent a revision from candidate-only content.

#### Scenario: base_ref class uses base SHA blobs

- **WHEN** class `repo_policy` is resolved for a run with base SHA B and candidate SHA C
- **AND** `.github/pipeline.yml` exists at B
- **THEN** the trusted content hash for `repo_policy` SHALL be derived from the blob(s) at B
- **AND** SHALL NOT be derived solely from the candidate copy at C

#### Scenario: engine class uses installed pin

- **WHEN** class `engine_prompts` is resolved
- **THEN** trusted content SHALL come from the installed engine template snapshot / engine identity pin
- **AND** SHALL NOT treat the candidate worktree’s prompt files as the trusted surface for judging that candidate

#### Scenario: unreadable required trusted source fails closed

- **WHEN** a class required for the run’s judging path cannot resolve its trusted revision
- **THEN** that class resolution SHALL fail
- **AND** the aggregate decision SHALL NOT invent a trusted hash from candidate-only bytes

---

### Requirement: Every verification-relevant run SHALL emit a structured trusted-surface decision

For every pipeline run that performs readiness-relevant verification, the engine SHALL compute and durable-persist exactly one structured trusted-surface decision with integer `schema_version` starting at `1`. The decision SHALL include at least:

- `schema_version`
- `path_class_schema_version`
- `outcome` — exactly one of `passthrough`, `rebound`, `blocked`
- `candidate_sha` — full 40-character hex SHA of the product candidate under evaluation
- `base_sha` — full 40-character hex SHA of the integration base used for base_ref classes (or documented null only when no base applies and no base_ref class is required)
- `triggering_paths` — list of candidate paths that matched a sensitive class (empty when none)
- `classes` — per-class records with `class_id`, `trusted_source`, `trusted_content_hash` when resolved, optional `candidate_content_hash` when the candidate touches the class, and per-class status
- `effective_verifier_hash` — stable digest of the trusted content map used for judging when outcome is not a failure that precludes a pin
- `reason` — machine-oriented reason code and human-readable summary

Aggregate outcome rules SHALL be: `blocked` if any required class fails resolution or policy forbids rebound; else `rebound` if any sensitive path is touched and trusted resolution succeeds; else `passthrough`.

#### Scenario: no sensitive paths yields passthrough

- **WHEN** the candidate changed-path set intersects no verifier-sensitive class
- **THEN** `outcome` SHALL be `passthrough`
- **AND** `triggering_paths` SHALL be empty
- **AND** judging SHALL use the resolved trusted surface without candidate rebind

#### Scenario: sensitive path with successful trust resolution yields rebound

- **WHEN** the candidate modifies `.github/pipeline.yml`
- **AND** the trusted `repo_policy` revision resolves from base SHA B
- **THEN** `outcome` SHALL be `rebound`
- **AND** `triggering_paths` SHALL include the policy path
- **AND** the decision SHALL record trusted source and content hash for `repo_policy`
- **AND** readiness-relevant policy acceptance for that candidate SHALL use the trusted (base) policy surface, not silent candidate-only weakening

#### Scenario: failed trust resolution yields blocked

- **WHEN** the candidate touches a sensitive class
- **AND** trusted revision for that class cannot be resolved
- **THEN** `outcome` SHALL be `blocked`
- **AND** the run SHALL NOT treat candidate-only content as the authoritative judging surface for that class

#### Scenario: decision is deterministic for identical inputs

- **WHEN** the same candidate paths, candidate SHA, base SHA, engine pin, and registry version are supplied twice
- **THEN** both decisions SHALL produce the same `outcome`, `effective_verifier_hash`, and per-class trusted hashes

---

### Requirement: Candidate SHALL NOT silently self-judge under a weakened surface

When a candidate changes verifier-sensitive material, the pipeline SHALL NOT apply that candidate’s weakened copy as the sole authoritative judging surface for the same candidate without an explicit `rebound` or `blocked` decision. A `rebound` decision SHALL bind judging of the affected classes to the resolved trusted revision and SHALL record that binding. A `blocked` decision SHALL refuse readiness advancement that depends on the unresolved or forbidden surface. Ordinary candidates that touch no sensitive paths SHALL retain pre-existing judging behavior via `passthrough`.

#### Scenario: dogfood engine change rebounds to installed pin

- **WHEN** an Agent Pipeline dogfood PR modifies engine prompt templates or review judging modules
- **AND** an installed engine pin is available
- **THEN** the decision SHALL be `rebound` or `blocked` (not silent `passthrough`)
- **AND** on `rebound`, judging rules for those classes SHALL come from the installed pin
- **AND** the candidate tree SHALL NOT be the sole source of those judging rules for that PR

#### Scenario: target repo gate script change is not silent passthrough

- **WHEN** a target repository PR modifies a configured gate command script matched by `gate_commands`
- **THEN** the decision SHALL be `rebound` or `blocked`
- **AND** SHALL NOT be `passthrough`

#### Scenario: product-only path change stays passthrough

- **WHEN** a product repository PR changes only application source files outside all sensitive classes
- **THEN** the decision SHALL be `passthrough`
- **AND** existing gate and review behavior SHALL not require rebound solely because a PR exists

---

### Requirement: Mid-run effective verifier change SHALL invalidate affected evidence

After a trusted-surface decision is pinned for a candidate SHA, the pipeline SHALL detect mid-run changes to the effective verifier identity (including installed engine identity / template fingerprint drift that changes `effective_verifier_hash` or the engine-class trusted content). When the effective verifier identity changes, the pipeline SHALL emit a structured diagnostic and SHALL treat readiness evidence bound to the prior effective verifier identity as non-current until regenerated under the new identity (or until the run is blocked per fail-closed policy). The pipeline SHALL NOT silently continue to claim readiness pass under a stale effective verifier hash.

#### Scenario: engine fingerprint drift invalidates prior verifier-bound evidence

- **WHEN** a run pinned effective verifier hash H1
- **AND** a later stage boundary observes engine-class material that yields effective hash H2 where H1 ≠ H2
- **THEN** the pipeline SHALL record the transition
- **AND** readiness evidence produced under H1 SHALL be non-current for judging under H2
- **AND** regeneration or fail-closed disposition SHALL be required before readiness pass under H2

#### Scenario: candidate SHA advance recomputes decision

- **WHEN** the product candidate advances from SHA A to SHA B
- **THEN** the pipeline SHALL compute a new trusted-surface decision for B
- **AND** SHALL NOT reuse A’s decision as authority for B without recomputation

---

### Requirement: Downstream artifacts SHALL carry the decision and effective verifier identity

The trusted-surface decision and `effective_verifier_hash` SHALL be available to readiness producers and durable run evidence. Project Warrant and other external consumers MAY read the recorded decision and MUST NOT invent or repair a missing decision. When outcome is `blocked`, readiness composition SHALL NOT mark `pipeline:ready-to-deploy` on the basis of judging that required the unresolved surface.

#### Scenario: blocked decision refuses ready-to-deploy

- **WHEN** the trusted-surface decision outcome is `blocked` for a required class
- **THEN** the pipeline SHALL NOT advance the item to `pipeline:ready-to-deploy` while that block remains
- **AND** diagnostics SHALL name the outcome and reason

#### Scenario: external consumer does not invent the decision

- **WHEN** run evidence lacks a trusted-surface decision record
- **THEN** an external dossier consumer SHALL NOT synthesize a `passthrough` decision
- **AND** Agent Pipeline producers remain the only authority that create the decision

---

### Requirement: Dogfood and target-repository regressions SHALL prove the invariant

The engine test suite SHALL include regression coverage (injectable deps only) that:

1. An Agent Pipeline-shaped candidate that weakens engine judging material cannot achieve readiness while judged only by that weakened candidate surface (must `rebound` to pin or `blocked`).
2. Target-repository candidates that edit `.github/pipeline.yml`, gate scripts, rubrics, schemas, or ownership mappings produce `rebound` or `blocked` with recorded triggering paths.
3. A candidate that touches no sensitive paths produces `passthrough` and does not alter baseline judging selection.

#### Scenario: weaken-review-policy dogfood fixture

- **WHEN** a fixture candidate deletes or relaxes engine-shipped review blocking policy used for judging
- **THEN** classification SHALL not be silent `passthrough`
- **AND** readiness under the weakened candidate-only policy SHALL fail closed or rebound to the trusted pin

#### Scenario: pipeline.yml weaken fixture on target repo

- **WHEN** a fixture candidate sets repository config that would disable or weaken a structural verification expectation matched by `repo_policy` or `gate_commands`
- **THEN** the decision SHALL be `rebound` or `blocked`
- **AND** the trusted surface used for acceptance SHALL not be solely the weakened candidate config without an explicit recorded rebound

### Requirement: Trusted-surface candidate SHA SHALL resolve without a managed worktree when an authoritative later-stage pin exists

When a verification-relevant run computes a trusted-surface decision and no managed worktree is on disk for the issue, the engine SHALL still resolve `candidate_sha` from an authoritative source instead of failing closed solely because the worktree is absent. Resolution order SHALL be:

1. Worktree HEAD when a managed worktree is present (existing path).
2. Else an explicit candidate-SHA override from the advance `--sha` command input (or an equivalent production caller field), when it is a full 40-character hexadecimal SHA.
3. Else the head SHA of the linked open pull request, when that head is a full 40-character hexadecimal SHA and it matches the last-advanced candidate pin when that pin is present.

The last-advanced candidate pin is the SHA last recorded as the product candidate this issue successfully advanced under (review SHA-gate pin, last successful pre-merge candidate, or last non-sentinel trusted-surface `candidate_sha` for the issue). Recency SHALL be the persisted trusted-surface decision timestamp or successful pre-merge event `at`, not the originating run's `run_start` or run-id time. When that pin is absent and a linked open PR head is a full 40-hex SHA, the engine SHALL use that PR head. When the pin is present and the PR head differs, the engine SHALL NOT use the PR head.

This fallback SHALL apply at least when the issue stage is at or after `pre-merge`. It SHALL NOT invent a candidate SHA from harness prose, reviewer free text, or an all-zero sentinel.

When a candidate SHA is resolved this way, the engine SHALL still compute (or reuse a SHA-matched durable) trusted-surface decision for that SHA. It SHALL NOT treat missing path information as silent `passthrough`. If the decision cannot be computed or reused for the resolved SHA, the outcome SHALL be `blocked` with a named reason other than inventing a trusted hash.

#### Scenario: matching PR head after park supplies candidate SHA

- **WHEN** issue N is at or after `pre-merge` and has no managed worktree on disk
- **AND** a linked open PR exists whose head SHA H is a full 40-character hex SHA
- **AND** H equals the last-advanced candidate pin, or that pin is absent
- **THEN** the trusted-surface decision `candidate_sha` SHALL be H
- **AND** the decision SHALL NOT use reason code `worktree_unavailable` solely because the worktree is absent

#### Scenario: explicit override supplies candidate SHA

- **WHEN** issue N has no managed worktree on disk
- **AND** an explicit candidate-SHA override S is a full 40-character hex SHA
- **AND** if a linked open PR exists, S equals that PR head
- **THEN** the trusted-surface decision `candidate_sha` SHALL be S
- **AND** the decision SHALL NOT use reason code `worktree_unavailable` solely because the worktree is absent

#### Scenario: production advance --sha override supplies candidate SHA

- **WHEN** issue N has no managed worktree on disk
- **AND** the operator supplied `--sha S` on the advance command, where S is a full 40-character hexadecimal SHA
- **AND** if a linked open PR exists, S equals that PR head
- **THEN** the trusted-surface decision `candidate_sha` SHALL be S
- **AND** the decision SHALL NOT use reason code `worktree_unavailable` solely because the worktree is absent

#### Scenario: absent worktree and absent PR fails closed with a named outcome

- **WHEN** issue N is at or after `pre-merge` and has no managed worktree on disk
- **AND** no explicit candidate-SHA override is present
- **AND** no linked open PR with a resolvable head SHA exists
- **THEN** the trusted-surface decision outcome SHALL be `blocked`
- **AND** the reason SHALL be a named code (not an invented SHA)
- **AND** readiness composition SHALL NOT treat that run as a trusted-surface pass

#### Scenario: mismatched PR head is not accepted as the candidate

- **WHEN** issue N has no managed worktree on disk
- **AND** a last-advanced candidate pin P is present
- **AND** the linked open PR head H is a full 40-character hex SHA
- **AND** H is not equal to P
- **THEN** the trusted-surface decision outcome SHALL be `blocked`
- **AND** `candidate_sha` SHALL NOT be set to H
- **AND** readiness composition SHALL NOT use H as the readiness subject

#### Scenario: newest durable pin wins when an older run matches the PR head

- **WHEN** issue N has no managed worktree on disk
- **AND** more than one prior durable last-advanced record exists
- **AND** an older record's SHA equals the linked open PR head H
- **AND** a newer record's SHA P differs from H
- **THEN** the last-advanced candidate pin SHALL be P
- **AND** the trusted-surface decision outcome SHALL be `blocked`
- **AND** `candidate_sha` SHALL NOT be set to H

#### Scenario: mismatched override is not accepted

- **WHEN** issue N has no managed worktree on disk
- **AND** an explicit candidate-SHA override S is present
- **AND** a linked open PR exists whose head H is not equal to S
- **THEN** the trusted-surface decision outcome SHALL be `blocked`
- **AND** `candidate_sha` SHALL NOT be set to S or H as a guessed subject

#### Scenario: worktree HEAD still wins when present

- **WHEN** a managed worktree is on disk for the issue
- **AND** its HEAD is a full 40-character hex SHA
- **THEN** trusted-surface `candidate_sha` SHALL be that HEAD
- **AND** the engine SHALL NOT skip the worktree in favor of the PR head

### Requirement: Trusted-surface pin recency SHALL use persisted decision time

The engine SHALL order durable last-advanced trusted-surface pins by the timestamp persisted with each decision write, not by the originating run's `run_start` or run-id time. A durable resume that overwrites a trusted-surface decision under an older run ID SHALL assign that rewrite the new persist timestamp. When a stored trusted-surface decision has no persist timestamp, the engine MAY fall back to that run's `run_start` or run-id time.

#### Scenario: resumed older run ID updated after a later-started run

- **WHEN** issue N has no managed worktree on disk
- **AND** a later-started run recorded trusted-surface SHA H
- **AND** an older run ID is resumed and persists a different trusted-surface SHA P at a later decision time
- **AND** the linked open PR head equals H
- **THEN** the last-advanced candidate pin SHALL be P
- **AND** the trusted-surface decision outcome SHALL be `blocked`
- **AND** `candidate_sha` SHALL NOT be set to H

### Requirement: Absent-worktree candidate SHA regressions SHALL fail the unit suite

Automated tests covered by `npm run ci` SHALL inject I/O (no live network, git, or subprocess) and SHALL fail if: (1) a re-run at `pre-merge` with no on-disk managed worktree and a linked open PR whose head matches the last-advanced candidate still records trusted-surface `worktree_unavailable` or leaves the PR untagged at ready-to-deploy; (2) a PR head that is not the last-advanced candidate is accepted as the trusted-surface or readiness `candidate_sha`; (3) an older durable pin that matches the live PR head is accepted when a newer authoritative pin differs, including when that newer pin was written by resuming an older run ID after a later-started run.

#### Scenario: matching PR head still reporting worktree_unavailable fails the suite

- **WHEN** a unit test drives a `pre-merge` re-entry with no on-disk managed worktree
- **AND** a linked open PR head matches the last-advanced candidate
- **AND** other readiness gates pass
- **THEN** the test SHALL fail unless the trusted-surface decision uses that PR head as `candidate_sha` and does not report `worktree_unavailable`

#### Scenario: mismatched PR head accepted as candidate fails the suite

- **WHEN** a unit test drives the same re-entry with no on-disk managed worktree
- **AND** the linked open PR head differs from the last-advanced candidate pin
- **THEN** the test SHALL fail unless the decision is `blocked` with a named mismatch or unresolved outcome
- **AND** SHALL fail if that PR head is stored as trusted-surface or readiness `candidate_sha`

#### Scenario: older matching SHA accepted while a newer pin differs fails the suite

- **WHEN** a unit test drives a `pre-merge` re-entry with no on-disk managed worktree
- **AND** more than one prior durable last-advanced record exists
- **AND** an older record's SHA equals the linked open PR head
- **AND** a newer record's SHA differs
- **THEN** the test SHALL fail unless the decision is `blocked` with a named mismatch or unresolved outcome
- **AND** SHALL fail if that older PR head is stored as trusted-surface or readiness `candidate_sha`

#### Scenario: resumed older run ID whose decision time is newer fails the suite if the later-started SHA is accepted

- **WHEN** a unit test drives a `pre-merge` re-entry with no on-disk managed worktree
- **AND** a later-started run recorded trusted-surface SHA H that equals the linked open PR head
- **AND** an older run ID has a trusted-surface SHA P persisted at a later decision time
- **THEN** the test SHALL fail unless the decision is `blocked` with a named mismatch or unresolved outcome
- **AND** SHALL fail if H is stored as trusted-surface or readiness `candidate_sha`
