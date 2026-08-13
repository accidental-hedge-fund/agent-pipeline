## Purpose

Bind readiness-relevant verification to a resolved trusted surface so a candidate cannot silently weaken the rules, prompts, policy, schemas, gate commands, rubrics, or ownership mappings used to judge itself. Emit an explicit passthrough, rebound, or blocked decision for every run.

## ADDED Requirements

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
