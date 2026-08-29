## Purpose

Lets a repository declare named planning-fact providers so the engine observes mutable repository state immediately before planning, plan-revision, and plan-review, injects a bound fact bundle, and treats only digest-matched claims as engine-verified. Alembic is a conformance fixture, not built-in engine behavior.

## ADDED Requirements

### Requirement: Absent or empty planning_facts SHALL leave planning behavior unchanged

When `.github/pipeline.yml` omits `planning_facts` or declares an empty providers list, the engine SHALL NOT spawn a provider, SHALL NOT inject a planning-facts section, and SHALL NOT introduce a planning-facts blocking failure. Planning, plan-revision, and plan-review SHALL proceed as they do today.

#### Scenario: Omitted block is a no-op

- **WHEN** a repository has no `planning_facts` key
- **AND** the planning stage builds a planning prompt
- **THEN** the engine SHALL spawn zero planning-fact providers
- **AND** the rendered prompt SHALL contain no planning-facts section

#### Scenario: Empty providers list is a no-op

- **WHEN** `.github/pipeline.yml` sets `planning_facts.providers` to `[]`
- **THEN** planning SHALL match the omitted-block behavior

### Requirement: Agent Pipeline SHALL remain repository-neutral

The engine SHALL NOT encode Alembic, migration-head, or any other repository-specific schema as built-in fact logic. A fact exists only when trusted repository configuration names a provider and that provider returns a declared key. Tests MAY ship an Alembic-style fixture that is driven only by fixture config plus a fixture script.

#### Scenario: Alembic is a fixture, not an engine feature

- **WHEN** a repository does not declare an Alembic provider
- **AND** its worktree contains `alembic/versions/`
- **THEN** the engine SHALL NOT read that directory
- **AND** SHALL NOT inject a migration-head fact

#### Scenario: Alembic fixture is config-driven

- **WHEN** a test fixture declares a provider whose script reports the Alembic head from `alembic/versions/`
- **THEN** the observed fact SHALL come from that script's JSON
- **AND** the engine SHALL NOT contain a hard-coded Alembic parser used in production

### Requirement: The engine SHALL resolve provider configuration and executable content from the trusted integration-base revision

Immediately before observation, the engine SHALL resolve the trusted integration-base SHA for the run. Provider configuration and provider executable bytes SHALL be read from that SHA. Bytes or YAML present only in the planning worktree SHALL NOT replace trusted configuration or the trusted executable during the run.

#### Scenario: Worktree rewrite of pipeline.yml is ignored

- **WHEN** the planning worktree replaces `.github/pipeline.yml` with a different `planning_facts` block
- **AND** observation runs
- **THEN** the engine SHALL execute the providers declared at the trusted integration-base SHA
- **AND** SHALL NOT execute a provider that exists only in the worktree copy of the file

#### Scenario: Worktree rewrite of the provider script is ignored

- **WHEN** the planning worktree replaces the provider executable with different content
- **AND** observation runs
- **THEN** the spawned program SHALL be the trusted-base bytes
- **AND** SHALL NOT be the worktree bytes

#### Scenario: Missing trusted executable fails closed

- **WHEN** trusted configuration names an executable path that is absent at the trusted integration-base SHA
- **THEN** that provider SHALL fail as typed `planning-facts-provider-contract`
- **AND** the engine SHALL NOT search `PATH` for a substitute

### Requirement: The engine SHALL spawn each provider as an argv-only process

The engine SHALL spawn the trusted executable by absolute path with an argument vector. The spawn SHALL NOT use a shell. The spawn SHALL NOT resolve the provider executable through `PATH`. Optional configured arguments SHALL be passed as additional argv entries only.

#### Scenario: Shell metacharacters are not interpreted

- **WHEN** a provider's configured arguments contain shell metacharacters such as `;` or `$HOME`
- **THEN** those characters SHALL be literal argv bytes
- **AND** the engine SHALL NOT invoke `/bin/sh` or equivalent to launch the provider

#### Scenario: Executable is not looked up on PATH

- **WHEN** trusted configuration sets the executable to a repo-relative path
- **THEN** the spawned file SHALL be the trusted copy of that path
- **AND** a same-named program earlier on `PATH` SHALL NOT be executed

### Requirement: Providers SHALL run in the managed planning worktree with a sanitized environment

The provider process cwd SHALL be the managed planning worktree for the issue. The child environment SHALL be constructed by the engine and SHALL NOT inherit Pipeline, GitHub, signing, or harness credentials from the parent. A parent environment that contains those credentials SHALL still produce a child environment without them.

#### Scenario: Cwd is the planning worktree

- **WHEN** a provider runs
- **THEN** its cwd SHALL be the issue's managed planning worktree
- **AND** SHALL NOT be the pipeline host checkout or a sibling worktree

#### Scenario: Credential variables are stripped

- **WHEN** the parent process environment contains `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, and Pipeline or harness credential variables
- **AND** a provider is spawned
- **THEN** the child environment SHALL omit those variables
- **AND** a unit test that plants them in the parent env SHALL observe them absent from the spawn env

### Requirement: The engine SHALL require a clean worktree and SHALL detect provider mutation

The engine SHALL run a provider only when the planning worktree is clean. It SHALL record `HEAD` and porcelain before execution and compare them after. A dirty pre-run worktree or a post-run `HEAD` or porcelain change SHALL fail as typed `planning-facts-provider-contract`. The engine SHALL preserve the post-run evidence and SHALL NOT silently reset, clean, or discard it.

#### Scenario: Dirty worktree is not a run surface

- **WHEN** porcelain is non-empty before a provider would run
- **THEN** the engine SHALL NOT spawn that provider
- **AND** the outcome SHALL be typed `planning-facts-provider-contract`

#### Scenario: Mutating provider fails and dirt is preserved

- **WHEN** a provider writes or deletes a tracked or untracked file, or changes `HEAD`
- **THEN** the outcome SHALL be typed `planning-facts-provider-contract`
- **AND** the worktree SHALL still contain that mutation when the failure is recorded
- **AND** the engine SHALL NOT run `git reset`, `git checkout --`, or `git clean` to hide it

#### Scenario: Timeout snapshot runs after the provider has exited

- **WHEN** a provider exceeds the effective runtime ceiling
- **THEN** the engine SHALL wait until the provider process has exited
- **AND** SHALL take the post-run worktree snapshot only after that exit
- **AND** SHALL treat a mutation discovered in that snapshot as typed `planning-facts-provider-contract`

#### Scenario: Non-mutating provider succeeds

- **WHEN** a provider exits 0, writes valid JSON, and leaves `HEAD` and porcelain unchanged
- **THEN** observation SHALL accept its declared facts

### Requirement: The engine SHALL recompute facts immediately before every planning, plan-revision, and plan-review invocation

The engine SHALL produce a fresh observation immediately before each of those three model invocations. It SHALL NOT reuse a prior bundle as current. When the trusted integration-base SHA has advanced since the previous observation for the same issue run, the engine SHALL update the planning worktree to include that base before running providers. A failed update SHALL fail closed with typed evidence and SHALL NOT inject the previous bundle.

#### Scenario: Each invocation observes again

- **WHEN** planning, then plan-review, then plan-revision run in one issue
- **THEN** the engine SHALL perform a distinct observation immediately before each model invoke
- **AND** SHALL NOT pass the planning-time bundle to plan-review as if it were current

#### Scenario: Concurrent base advancement is observed

- **WHEN** a required fact was observed as value A at planning
- **AND** the trusted integration-base SHA then advances and the planning worktree's observed value becomes B
- **AND** plan-review is about to run
- **THEN** the engine SHALL observe B
- **AND** SHALL NOT report A as current

#### Scenario: Failed worktree update does not reuse stale facts

- **WHEN** the trusted integration-base SHA has advanced
- **AND** the planning worktree cannot be updated to include that base
- **THEN** the engine SHALL record typed evidence
- **AND** SHALL NOT inject the previous bundle into the next prompt

### Requirement: Each fact bundle SHALL carry provenance binding

Each bundle SHALL record repository identity, the trusted integration-base SHA, the planning-worktree state identity, the provider content digest, and the observation time. Consumers SHALL treat that binding as the identity of the observation. Observation time SHALL be provenance metadata and SHALL NOT by itself make a required fact count as changed.

#### Scenario: Bundle names its observation

- **WHEN** observation succeeds
- **THEN** the bundle SHALL include repository identity, integration-base SHA, worktree state identity, provider content digest, and observation time

#### Scenario: Time passing does not invalidate required facts

- **WHEN** the only difference between two bundles is observation time
- **AND** required fact ids and value digests are unchanged
- **THEN** the engine SHALL NOT treat the required facts as changed

### Requirement: Provider output SHALL be bounded versioned JSON of declared primitive or array facts

A successful provider SHALL write versioned JSON to stdout. Trusted configuration SHALL declare the allowed fact keys and each key's type, limited to primitives and arrays of primitives. The engine SHALL reject undeclared keys, nested objects, wrong types, extra top-level fields beyond the versioned envelope, and output that exceeds pipeline ceilings. Stderr SHALL be captured for evidence and SHALL NOT be parsed as facts.

#### Scenario: Declared string fact is accepted

- **WHEN** trusted configuration allows `alembic_head: string`
- **AND** the provider prints versioned JSON containing that key with a string value inside the ceiling
- **THEN** the bundle SHALL include that fact with a value digest

#### Scenario: Undeclared key is rejected

- **WHEN** a provider prints a key that trusted configuration does not allow
- **THEN** the provider SHALL fail as typed `planning-facts-provider-contract`
- **AND** that key SHALL NOT be injected

#### Scenario: Nested object is rejected

- **WHEN** a provider prints a nested object as a fact value
- **THEN** the provider SHALL fail as typed `planning-facts-provider-contract`

#### Scenario: Oversized or too-many-facts output is rejected

- **WHEN** stdout, stderr, fact count, key size, value size, or total prompt contribution exceeds the effective ceiling
- **THEN** the provider SHALL fail as typed `planning-facts-provider-contract`
- **AND** the truncated evidence SHALL be retained

#### Scenario: Byte caps are enforced during capture

- **WHEN** a provider writes more than `max_stdout_bytes` or `max_stderr_bytes` before it exits
- **THEN** the engine SHALL retain only truncated diagnostic bytes
- **AND** SHALL terminate the provider once the cap is exceeded
- **AND** SHALL wait for that process to exit before returning the typed ceiling failure

#### Scenario: Timeout is rejected

- **WHEN** a provider exceeds the effective runtime ceiling
- **THEN** the provider SHALL fail as typed `planning-facts-provider-contract`
- **AND** the engine SHALL NOT wait for a later completion as success
- **AND** the engine SHALL wait for the provider process to exit before taking the post-run worktree snapshot

### Requirement: Pipeline-owned ceilings SHALL apply and repository configuration SHALL only tighten them

The pipeline SHALL own hard ceilings for runtime, stdout bytes, stderr bytes, fact count, key size, value size, and total prompt contribution. Repository configuration MAY set lower ceilings. A repository value above a pipeline ceiling SHALL fail config validation. The engine SHALL enforce the effective (tightest) ceilings at observation time.

#### Scenario: Default ceilings apply when the repo omits them

- **WHEN** `planning_facts` names providers and omits ceiling keys
- **THEN** observation SHALL enforce the pipeline-owned ceilings

#### Scenario: Repo may lower a ceiling

- **WHEN** the repository sets a timeout below the pipeline ceiling
- **THEN** a provider that exceeds the repository timeout SHALL fail
- **AND** a provider that finishes between the repository timeout and the pipeline ceiling SHALL fail

#### Scenario: Repo may not raise a ceiling

- **WHEN** the repository sets a timeout above the pipeline-owned ceiling
- **THEN** config validation SHALL reject the file

### Requirement: Required provider failure SHALL block before the model is invoked

A provider declared required SHALL block the planning, plan-revision, or plan-review invocation when it fails (timeout, non-zero exit, malformed JSON, mutation, dirty worktree, ceiling breach, missing executable, type error, or undeclared field). The engine SHALL record typed `planning-facts-provider-contract` evidence. The engine SHALL NOT invoke the model for that step. The failure SHALL be engine-owned and SHALL NOT be classified as human authority solely because a provider failed.

#### Scenario: Required failure skips the model

- **WHEN** a required provider times out or exits non-zero immediately before planning
- **THEN** the planning harness SHALL NOT be invoked
- **AND** the recorded diagnostic tag SHALL be `planning-facts-provider-contract`

#### Scenario: Required failure is not a human-authority park by itself

- **WHEN** a required provider fails the contract
- **THEN** the outcome SHALL be an engine-owned block
- **AND** SHALL NOT be solely `needs-human` for that contract failure

### Requirement: Optional provider failure SHALL emit an unavailable record and SHALL NOT reuse a prior value

A provider declared optional that fails SHALL contribute an explicit unavailable record for its declared fact keys. Planning MAY continue. The engine SHALL NOT inject a previous successful value for those keys. The prompt SHALL present the unavailable record so the model and reviewer can see that the fact was not observed.

#### Scenario: Optional failure continues with unavailable

- **WHEN** an optional provider fails immediately before planning
- **THEN** the planning harness MAY still be invoked
- **AND** the injected bundle SHALL mark that provider's facts unavailable
- **AND** SHALL NOT include an older successful value

#### Scenario: Optional success after prior failure is a new observation

- **WHEN** an optional provider failed on the previous invocation
- **AND** it succeeds on the next invocation
- **THEN** the new bundle SHALL include the newly observed values
- **AND** SHALL NOT keep the unavailable record as current

### Requirement: Engine-verified claims SHALL reference a supplied fact ID and value digest

Planner output SHALL include a typed fact-claims artifact when the planner asserts engine-verified facts. Each engine-verified claim SHALL name a fact ID that exists in the current bundle and SHALL carry the current value digest. Prose, including explicit verification sentences, SHALL NOT become engine-verified. A claim whose ID is missing, unavailable, or whose digest does not match SHALL NOT be engine-verified. A malformed claims artifact SHALL fail closed as typed `planning-facts-provider-contract` rather than silently promoting prose.

#### Scenario: Matching claim is engine-verified

- **WHEN** the current bundle has `alembic_head` with digest D
- **AND** the planner claims `alembic_head` with digest D
- **THEN** that claim SHALL be engine-verified

#### Scenario: False verification prose is not engine-verified

- **WHEN** the current bundle has `alembic_head` equal to `0074`
- **AND** the plan says the Alembic head was verified at `0068`
- **AND** the claims artifact does not name `alembic_head` with the current digest
- **THEN** the `0068` statement SHALL NOT be engine-verified
- **AND** plan-review SHALL receive the current bundle showing `0074`
- **AND** the plan-review prompt SHALL instruct the reviewer to treat unmatched prose verification as untrusted

#### Scenario: Stale-digest claim is not engine-verified

- **WHEN** the planner claims `alembic_head` with a digest that does not match the current bundle
- **THEN** that claim SHALL NOT be engine-verified

#### Scenario: Malformed claims artifact fails closed

- **WHEN** facts were supplied
- **AND** the planner emits a claims artifact that is not valid versioned claims JSON
- **THEN** the engine SHALL fail as typed `planning-facts-provider-contract`
- **AND** SHALL NOT treat surrounding prose as verified

### Requirement: A required-fact change before plan review SHALL invalidate the stale plan

Immediately before plan-review, after a fresh observation, the engine SHALL compare required fact identities (fact ID plus value digest) to the identities bound on the plan. If any required fact was added, removed, or changed digest, the engine SHALL NOT invoke plan-review on the stale plan. It SHALL return the plan for revision and SHALL supply the previous and current fact identities to the reviser.

#### Scenario: Changed required fact returns the plan for revision

- **WHEN** the plan is bound to required `alembic_head` digest D1
- **AND** the pre-review observation has `alembic_head` digest D2
- **AND** D1 is not equal to D2
- **THEN** the engine SHALL NOT invoke the plan-review harness
- **AND** SHALL enter plan revision
- **AND** the revision prompt SHALL include the previous and current fact identities

#### Scenario: Unchanged required facts proceed to plan-review

- **WHEN** required fact IDs and digests match the plan's bound bundle
- **THEN** plan-review SHALL run
- **AND** SHALL receive the current bundle and provenance

#### Scenario: Optional fact change does not by itself invalidate

- **WHEN** only an optional fact digest changed
- **AND** every required fact identity is unchanged
- **THEN** the engine SHALL NOT invalidate the plan solely for that optional change

### Requirement: Planner, reviser, and reviewer SHALL receive the same current fact bundle

For a given invocation, the engine SHALL inject the same current bundle and provenance into the planning, plan-revision, or plan-review prompt that it just observed for that invocation. Stale triage text in the issue body MAY still appear in the issue-body slot. The facts section SHALL state that engine-observed values supersede issue-body, carry-forward, and remembered values for those keys.

#### Scenario: Stale triage value is not the injected fact

- **WHEN** the issue body names revision `0069` / `0068` from triage time
- **AND** the current worktree's fixture provider reports head `0074`
- **THEN** the planning prompt body slot MAY still contain `0068`
- **AND** the planning-facts section SHALL present `0074` as the current observed value
- **AND** SHALL instruct the planner not to replace observed facts with triage-time values

#### Scenario: Plan-review sees the same current bundle as the just-completed observation

- **WHEN** plan-review runs after an observation that did not invalidate the plan
- **THEN** the plan-review prompt SHALL contain that observation's bundle and provenance
- **AND** SHALL NOT contain a prior observation in its place

### Requirement: Planning facts SHALL NOT replace implementation-time revalidation

The implementing prompt SHALL instruct the implementer to re-derive mutable repository state immediately before writing. The engine SHALL NOT present planning-time fact values as the write-time source of truth. Implementation-time tests SHALL keep a regression that would catch an implementer writing a planned revision without reading current worktree state.

#### Scenario: Implementing prompt requires re-derivation

- **WHEN** the implementing prompt is built
- **THEN** it SHALL instruct the implementer to re-derive mutable repository facts immediately before writing
- **AND** SHALL NOT tell the implementer to reuse planning-time fact values as current

#### Scenario: Planned revision is not write-time authority

- **WHEN** a plan claims the next Alembic revision is `0069`
- **AND** the worktree at implementation time already contains `0069`
- **THEN** the implementing instructions SHALL still require a fresh read of current versions before a new revision is written
