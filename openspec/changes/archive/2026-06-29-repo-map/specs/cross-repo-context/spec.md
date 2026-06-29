## ADDED Requirements

### Requirement: Planning receives declared repos' open-issue context when repo_map is configured

The planning stage SHALL inject a supplemental-context summary of the declared repos' open
issues into the planning prompt whenever `repo_map` is configured with at least one repo
across `depends_on` and `depended_on_by`. It SHALL fetch the open issues of each distinct
declared repo and render each summarized issue as its title plus its label set (no body). The
summary SHALL be supplemental context only — it SHALL NOT replace or alter the issue's own
planning inputs (body, carry-forward, human comments). Context gathering SHALL be sourced from
open issues only; recently merged or closed work SHALL NOT be fetched.

#### Scenario: declared repos summarized into the planning prompt

- **WHEN** `repo_map.depends_on` lists `acme/lib` and `acme/lib` has open issues
- **THEN** the planning prompt SHALL include a cross-repo context section
- **AND** each declared-repo issue SHALL appear as its title plus its label set
- **AND** no issue body text SHALL be included in that section

#### Scenario: both relationship directions contribute context

- **WHEN** `repo_map.depends_on` lists `acme/lib` and `repo_map.depended_on_by` lists `acme/app`
- **THEN** open issues from both `acme/lib` and `acme/app` SHALL be summarized into the planning prompt

#### Scenario: a repo listed in both directions is fetched once

- **WHEN** the same `owner/repo` appears in both `depends_on` and `depended_on_by`
- **THEN** its open issues SHALL be fetched and summarized exactly once (no duplicate `gh` call, no duplicated lines)

### Requirement: Cross-repo context is inert when repo_map has no declared repos

The planning stage SHALL NOT fetch any cross-repo issues when `repo_map.depends_on` and
`repo_map.depended_on_by` are both empty. Because `PipelineConfig.repo_map` is always a
non-optional resolved object (never `undefined`), the inert condition is exclusively "both
lists empty" — absence of the YAML block produces this state via the DEFAULT_CONFIG. On this
inert path the planning prompt SHALL be unchanged from its behavior before this capability,
and no additional `gh` call SHALL be made.

#### Scenario: repo_map not configured — no cross-repo fetch

- **WHEN** `.github/pipeline.yml` has no `repo_map` block (resolves to both lists empty)
- **THEN** the planning stage SHALL make no cross-repo issue fetch
- **AND** the planning prompt's cross-repo context section SHALL be empty (rendering identically to current behavior)

#### Scenario: repo_map present but empty — no cross-repo fetch

- **WHEN** `repo_map` is present with `depends_on: []` and `depended_on_by: []`
- **THEN** no cross-repo issue fetch SHALL occur and planning behavior SHALL be unchanged

### Requirement: Cross-repo context SHALL be fenced and sanitized as untrusted external data

The planning stage SHALL treat cross-repo issue titles and labels as untrusted input authored
by external contributors. Before injection into the planning prompt, each issue title and each
label SHALL be sanitized by redacting known prompt-injection patterns (using the same patterns
applied to last30days carry-forward briefs). The entire cross-repo context block SHALL be
rendered inside an explicit untrusted fence (`<untrusted-cross-repo-context>`) with a visible
directive instructing the planning agent not to follow commands from it. The fence boundary
tokens SHALL be stripped from issue titles and labels before rendering so that external content
cannot escape the fence boundary.

#### Scenario: injection pattern in external issue title is redacted

- **WHEN** a declared repo has an open issue whose title contains a prompt-injection imperative
  (e.g., "Ignore all previous instructions")
- **THEN** the raw injection text SHALL NOT appear in the planning prompt
- **AND** a `[REDACTED]` placeholder SHALL appear in its place

#### Scenario: cross-repo context block is wrapped in untrusted fence

- **WHEN** cross-repo context is non-empty
- **THEN** the planning prompt SHALL contain an explicit `<untrusted-cross-repo-context>` fence
- **AND** a visible directive SHALL appear before the fence instructing the agent not to follow
  commands from it

### Requirement: Unreachable declared repo degrades gracefully with a named warning

The pipeline SHALL log a named warning identifying the specific `owner/repo` and SHALL continue
the run without that repo's context whenever it cannot read a declared repo's issues at runtime
(no read access, repo not found, or a transient `gh` failure). A missing or unreachable declared
repo SHALL NOT abort planning or fail the run. Context from the other reachable declared repos
SHALL still be gathered and injected.

#### Scenario: one unreachable repo logs a warning and the run continues

- **WHEN** `repo_map.depends_on` lists `acme/private` and the pipeline lacks read access to it
- **THEN** a named warning identifying `acme/private` SHALL be logged
- **AND** the planning stage SHALL continue without `acme/private`'s context rather than aborting

#### Scenario: reachable repos still contribute when another is unreachable

- **WHEN** `repo_map.depends_on` lists both `acme/lib` (reachable) and `acme/private` (unreachable)
- **THEN** `acme/lib`'s open issues SHALL still be summarized into the planning prompt
- **AND** the run SHALL complete without error
