## Purpose

Gives operators a single configurable git-push authentication mechanism (SSH by default, opt-in HTTPS token from an env-var name) so engine and harness worktree pushes stay consistent and workflow-file updates do not produce false push-failed blocks from ambient HTTPS PATs that lack the GitHub `workflow` scope.

## ADDED Requirements

### Requirement: Resolved config SHALL expose a structured git push-auth mechanism defaulting to SSH

The pipeline SHALL resolve an operator-selected git push authentication mechanism from repository configuration. When the mechanism is unset, the resolved mechanism SHALL be `ssh`. The resolved representation SHALL be structured (not an opaque unparsed blob) so transport selection is deterministic. Configuration SHALL never store a literal secret value for push authentication — only mechanism identity and, for HTTPS-token mode, an environment-variable **name** (or equivalent secret reference name).

#### Scenario: default mechanism is SSH when git config is absent

- **WHEN** `.github/pipeline.yml` does not set a git push-auth field
- **THEN** the resolved config SHALL expose push-auth mechanism `ssh`

#### Scenario: explicit SSH is accepted

- **WHEN** `.github/pipeline.yml` sets `git.push_auth` to `ssh`
- **THEN** the resolved config SHALL expose push-auth mechanism `ssh`

#### Scenario: HTTPS-token mechanism stores only the env-var name

- **WHEN** `.github/pipeline.yml` sets `git.push_auth` to `https-token:GITHUB_PUSH_TOKEN`
- **THEN** the resolved config SHALL expose mechanism `https-token` with token environment name `GITHUB_PUSH_TOKEN`
- **AND** the resolved config SHALL NOT contain the token’s secret value

#### Scenario: invalid push-auth form is rejected

- **WHEN** `.github/pipeline.yml` sets `git.push_auth` to an unrecognized form (including a literal secret-looking token, an empty `https-token:` suffix, or the reserved unimplemented `app` value)
- **THEN** config resolution SHALL fail with a parse or validation error that identifies the push-auth field

---

### Requirement: Transport selection SHALL map each mechanism to a concrete push transport

Given a resolved push-auth mechanism, the pipeline SHALL select a push transport as follows: `ssh` selects the SSH transport using the worktree’s configured `origin` / `pushurl` without injecting a GitHub personal access token as the pipeline-chosen credential; `https-token` selects the HTTPS transport authenticated with the value of the named environment variable at invocation time. Selection SHALL be pure with respect to the resolved mechanism structure so unit tests can assert transport choice without performing a network push.

#### Scenario: SSH mechanism selects SSH transport

- **WHEN** the resolved mechanism is `ssh`
- **THEN** transport selection SHALL return the SSH transport
- **AND** SHALL NOT require a token environment variable to be set for selection to succeed

#### Scenario: HTTPS-token mechanism selects HTTPS transport bound to the env name

- **WHEN** the resolved mechanism is `https-token` with token environment name `MY_PUSH_TOKEN`
- **THEN** transport selection SHALL return the HTTPS-token transport bound to env name `MY_PUSH_TOKEN`

#### Scenario: config round-trip preserves mechanism and env name

- **WHEN** a valid `git.push_auth` value of `ssh` or `https-token:<ENV>` is loaded through config resolution
- **THEN** re-reading the resolved structured mechanism SHALL equal the parsed mechanism and env name
- **AND** transport selection for that resolved value SHALL match the corresponding transport

---

### Requirement: Managed worktree pushes SHALL use the configured mechanism consistently

Every git push the pipeline performs as the authoritative delivery of a managed worktree branch (including the post-implement push and fix-round pushes that share the same delivery contract) SHALL apply the resolved push-auth mechanism. When the mechanism is `ssh`, the pipeline SHALL push via the worktree remote without treating ambient `gh auth git-credential` HTTPS authentication as the selected transport. When the mechanism is `https-token`, the pipeline SHALL authenticate the push with the named environment variable’s value for that invocation and SHALL NOT persist the secret value into durable git config as a long-lived remote URL containing the token.

#### Scenario: default SSH push does not require workflow scope on the token

- **WHEN** push-auth is `ssh` and a managed worktree change includes files under `.github/workflows/`
- **THEN** the authoritative pipeline push SHALL use the SSH transport
- **AND** success SHALL NOT depend on a GitHub PAT having the `workflow` scope

#### Scenario: SSH mechanism rejects a non-SSH origin or pushurl before push

- **WHEN** push-auth is `ssh` and the worktree `remote.origin.pushurl` / `remote.origin.url` resolves to a non-SSH URL (for example `https://github.com/owner/repo.git`)
- **THEN** the authoritative pipeline push SHALL fail before invoking `git push` against that HTTPS endpoint
- **AND** the failure message SHALL identify mechanism `ssh` and that an SSH remote is required
- **AND** the pipeline SHALL NOT silently perform an HTTPS push under the `ssh` mechanism

#### Scenario: HTTPS-token push uses the named env var

- **WHEN** push-auth is `https-token:GITHUB_PUSH_TOKEN` and `GITHUB_PUSH_TOKEN` is set in the environment
- **THEN** the authoritative pipeline push from a managed worktree SHALL authenticate over HTTPS using that environment variable
- **AND** SHALL NOT use ambient `gh auth git-credential` as the selected push credential source for that mechanism

#### Scenario: HTTPS-token missing env var fails before a silent wrong-transport push

- **WHEN** push-auth is `https-token:GITHUB_PUSH_TOKEN` and `GITHUB_PUSH_TOKEN` is unset or empty at push time
- **THEN** the pipeline SHALL fail the push path with an error that names the missing environment variable
- **AND** SHALL NOT embed or log a secret value

---

### Requirement: Workflow-scope HTTPS rejection SHALL fail fast with a clear operator message

When a managed worktree push fails because GitHub refuses an HTTPS personal access token that lacks the `workflow` scope for creating or updating a workflow file, the pipeline SHALL surface a fail-fast error as a real push failure. The operator-visible reason SHALL name the configured mechanism, mention the missing `workflow` scope (or the GitHub rejection text that identifies it), and — for `https-token` — name the configured env-var name without printing its value. The failure SHALL remain classified as a push failure (not a silent success or an unexplained false idle state) so operators can fix credentials or switch to `ssh`.

#### Scenario: HTTPS-token without workflow scope on a workflow-file change

- **WHEN** push-auth is `https-token:<ENV>`, the token value lacks `workflow` scope, and the pushed tip creates or updates a path under `.github/workflows/`
- **THEN** the pipeline SHALL report a push failure with a clear message that identifies the missing `workflow` scope (or equivalent GitHub refusal)
- **AND** the message SHALL name the env-var name used for the token without printing the secret

#### Scenario: SSH path is not blocked solely by ambient HTTPS workflow-scope rejection as the chosen transport

- **WHEN** push-auth is `ssh` and the authoritative SSH push of a workflow-file change succeeds
- **THEN** the implementing (or equivalent delivery) stage SHALL NOT set `pipeline:blocked` with `push-failed` solely because a non-authoritative HTTPS/`gh` credential path lacked `workflow` scope

---

### Requirement: Harness stages SHALL be guided to honor the configured push-auth mechanism

For stages whose harness may invoke `git push` inside a managed worktree, the pipeline SHALL prepare the worktree environment and/or stage guidance so that a harness-initiated push prefers the configured mechanism rather than ad-hoc remotes or ambient HTTPS credential helpers that contradict operator intent. The authoritative engine push path remains the delivery contract; harness guidance reduces dual-path divergence.

#### Scenario: SSH configuration discourages HTTPS credential fallback for push

- **WHEN** push-auth is `ssh` and an implement or fix harness runs in a managed worktree
- **THEN** the pipeline-prepared environment or prompt guidance for that stage SHALL prefer the SSH remote for `git push`
- **AND** SHALL NOT instruct the harness to reconfigure origin to HTTPS via ambient `gh` credentials as the pipeline’s selected mechanism

#### Scenario: HTTPS-token configuration points harness pushes at the same env-bound transport

- **WHEN** push-auth is `https-token:<ENV>` and an implement or fix harness runs in a managed worktree
- **THEN** the pipeline-prepared environment or prompt guidance SHALL align harness `git push` with the same HTTPS-token mechanism the engine uses

---

### Requirement: Operators SHALL have documentation for each push-auth mechanism

Operator-facing documentation SHALL describe the `ssh` and `https-token:<env>` mechanisms, when to use each, and that HTTPS tokens used for changes under `.github/workflows/**` require the GitHub `workflow` scope (or the operator should use SSH). Documentation SHALL state that config holds env-var names only, never literal secrets, and that the `app` mechanism is not implemented in this change.

#### Scenario: docs cover mechanism choice and workflow scope

- **WHEN** an operator reads the push-auth documentation delivered with this change
- **THEN** the docs SHALL describe `ssh` and `https-token:<env>`
- **AND** SHALL state the `workflow` scope requirement for HTTPS pushes that modify workflow files
- **AND** SHALL state that secret values are never stored in pipeline config
