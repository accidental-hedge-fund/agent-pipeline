## ADDED Requirements

### Requirement: Scoped operator overrides by category or file path

`parseOverrideArg` SHALL accept a scope specifier in the same argument position as a bare finding key: `category:<name>` or `file:<path>`, in the form `--override "<scope>: <reason>"`. A scoped specifier SHALL produce a scoped disposition (scope type, normalized scope value, normalized disposition token, and human reason) rather than a key disposition. A bare 8-hex key SHALL continue to parse exactly as before this change. The scope value SHALL be normalized consistently with the finding-key inputs (lowercased; category names trimmed). An argument whose scope value is empty (`category:` or `file:` with nothing after the prefix) or whose reason is empty SHALL be rejected with a usage error, and SHALL post nothing.

#### Scenario: Category scope parses

- **WHEN** an operator runs `--override "category:rollback-safety: deferred #90"`
- **THEN** `parseOverrideArg` SHALL return a scoped disposition with type `category`, value `rollback-safety`, disposition `deferred-#90`, and the full reason text

#### Scenario: File scope parses

- **WHEN** an operator runs `--override "file:src-tauri/src/repo.rs: deferred #90"`
- **THEN** `parseOverrideArg` SHALL return a scoped disposition with type `file`, value `src-tauri/src/repo.rs`, and disposition `deferred-#90`

#### Scenario: Bare key still parses as a key disposition

- **WHEN** an operator runs `--override "a1b2c3d4: rejected — handled already"`
- **THEN** `parseOverrideArg` SHALL return a key disposition for key `a1b2c3d4`, unchanged from prior behavior

#### Scenario: Empty scope value or empty reason rejected

- **WHEN** an operator runs `--override "category: reason"` (empty name), or `--override "file:src/x.rs:   "` (empty reason)
- **THEN** the invocation SHALL fail with a usage error and SHALL post nothing

---

### Requirement: Scoped overrides disposition all matching findings regardless of finding key

`partitionFindings` SHALL move every finding matching an active scope into the overridden set, independent of each finding's `findingKey`, on every (re-)review. A `category:<name>` scope SHALL match a finding whose `category`, lowercased and trimmed, equals the scope value; a finding without a `category` SHALL NOT match a category scope. A `file:<path>` scope SHALL match a finding whose normalized `file` equals the scope value or begins with the scope value followed by `/` (directory-boundary-aware prefix); a finding without a `file` SHALL NOT match a file scope. Because the match is recomputed against the live verdict each round, a scoped disposition SHALL survive finding-key drift: a re-worded, re-located, or newly-minted finding that still falls within the scope SHALL remain overridden.

#### Scenario: Category scope overrides all matching findings

- **WHEN** a `category:rollback-safety` scope is active
- **AND** the verdict contains two findings whose `category` is `rollback-safety` with different keys
- **THEN** both findings SHALL be in the overridden set and neither SHALL block

#### Scenario: File scope matches exact path and directory prefix

- **WHEN** a `file:src-tauri/src` scope is active
- **AND** the verdict contains findings for `src-tauri/src/repo.rs` and `src-tauri/src/lib.rs`
- **THEN** both findings SHALL be overridden

#### Scenario: File scope respects directory boundaries

- **WHEN** a `file:src/repo` scope is active
- **AND** the verdict contains a finding for `src/report.rs`
- **THEN** that finding SHALL NOT be matched by the scope and SHALL be classified normally

#### Scenario: Scoped disposition survives key drift across re-review

- **WHEN** a `category:rollback-safety` scope is recorded against a finding in round N
- **AND** round N+1 re-emits the same concern with a different `findingKey` but the same `category`
- **THEN** the round N+1 finding SHALL still be overridden without the operator recording a new disposition

#### Scenario: Finding without the scoped attribute is unaffected

- **WHEN** a `file:src/repo.rs` scope is active
- **AND** the verdict contains a finding with no `file` value
- **THEN** that finding SHALL NOT be overridden by the file scope

---

### Requirement: Scoped overrides bypass the per-key ambiguity guard

A scoped override SHALL NOT be subject to the single-distinct-candidate ambiguity guard that governs key overrides. Whereas a key override is withheld when two or more materially distinct findings resolve to that one key, a scope is explicitly intended to match more than one finding, so all findings matching an active scope SHALL be overridden.

#### Scenario: Two distinct findings under one scope are both overridden

- **WHEN** a `category:rollback-safety` scope is active
- **AND** the verdict contains two materially distinct findings both categorized `rollback-safety`
- **THEN** both SHALL be overridden, and the ambiguity guard SHALL NOT withhold the scope

---

### Requirement: Scoped dispositions are audited and re-read like key overrides

A scoped override SHALL post an audited comment carrying a scope sentinel distinct from the key sentinel, of the form `<!-- pipeline-override-scope: <type>:<value> <disposition> -->`, recording the scope, disposition, reason, stage, and timestamp. Subsequent reviews SHALL read active scopes back from these sentinels and pass them to `partitionFindings`, and a later scope sentinel for the same `<type>:<value>` SHALL win. After posting the sentinel and clearing `blocked`, a scoped override SHALL re-enter the advance loop automatically, identically to a key override (`override-auto-resume`); the operator SHALL NOT need to re-run the pipeline. The all-advisory advance comment SHALL itemize each scope-overridden finding under the scope that swept it, so the audit trail shows exactly what the scope dispositioned rather than only that a scope was active.

#### Scenario: Scope sentinel round-trips

- **WHEN** a scoped override for `category:rollback-safety` is recorded
- **THEN** the posted comment SHALL contain `<!-- pipeline-override-scope: category:rollback-safety <disposition> -->`
- **AND** a subsequent review's extraction SHALL recover that scope and disposition and apply it in `partitionFindings`

#### Scenario: Scoped override auto-resumes without a manual re-run

- **WHEN** an operator records a scoped override that disposition the last unresolved blocker
- **THEN** the pipeline SHALL post the scope sentinel, clear `blocked`, and immediately enter the advance loop
- **AND** the item SHALL advance to the next stage without a second pipeline invocation

#### Scenario: Advance comment itemizes the swept findings

- **WHEN** a review advances because an active scope overrode the remaining blockers
- **THEN** the audited advance comment SHALL list each scope-overridden finding under its scope and the operator-supplied reason
