# surgical-fix-rounds Specification

## Purpose
TBD - created by archiving change surgical-fix-rounds. Update Purpose after archive.

## Requirements

### Requirement: The fix prompt SHALL instruct a minimal, finding-scoped diff

`buildFixPrompt` output SHALL instruct the fix harness to make the minimal diff that
resolves the specific review finding(s) it was given, and SHALL explicitly forbid
refactors, scope-broadening, unrelated changes, and opportunistic cleanup — even when
the tempting change is adjacent to the finding. This minimal-diff instruction SHALL be a
prominent, leading part of the fix prompt's instructions, not a buried trailing line. The
instruction SHALL apply to every fix round regardless of whether the run uses OpenSpec
(the one carve-out remains the OpenSpec `{{spec_revision_instruction}}` block, which
permits bringing a stale spec delta back into agreement with the fix).

#### Scenario: fix prompt forbids over-reach

- **WHEN** `buildFixPrompt` is called for any fix round
- **THEN** the returned prompt string SHALL instruct the harness to make the minimal diff that resolves the finding
- **AND** it SHALL explicitly forbid refactors, scope-broadening, unrelated changes, and opportunistic cleanup

#### Scenario: minimal-diff discipline is unconditional

- **WHEN** `buildFixPrompt` is called with no OpenSpec spec context (the freeform path)
- **THEN** the minimal-diff instruction SHALL still be present in the returned prompt string

### Requirement: The fix prompt SHALL guard destructive and irreversible operations

`buildFixPrompt` output SHALL require an explicit safety scope or written justification
when a fix would touch a destructive or irreversible operation. The prompt SHALL name the
guarded operations concretely — at minimum force worktree removal (`git worktree remove
--force`), force push (`git push --force` / `--force-with-lease`), branch or worktree
deletion, and the merge surface. The guard SHALL split the scope requirement by operation type: worktree deletion and
removal operations SHALL be constrained to the **managed worktree root** only (the
`reviewed head` alternative does NOT apply — a git commit reference is not a filesystem
boundary); force push and merge-surface operations MAY be scoped to the **managed
worktree root** or the **reviewed head**. A fix cannot widen the blast radius of a
destructive operation while resolving an unrelated finding. If a finding's correct fix
genuinely requires touching a guarded operation, the harness SHALL state an explicit
justification in its output.

#### Scenario: destructive-operation guard is present and scoped

- **WHEN** `buildFixPrompt` is called for any fix round
- **THEN** the returned prompt string SHALL name at least one destructive operation (e.g. force worktree removal or force push)
- **AND** for worktree deletion/removal it SHALL require managed worktree root scoping only; for force push/merge it SHALL require managed worktree root or reviewed head scoping; or accompanied by an explicit justification

#### Scenario: guard targets the #223 data-loss pattern

- **WHEN** the guard text is rendered in the fix prompt
- **THEN** it SHALL constrain destructive worktree operations to the managed root (the constraint a prior fix violated by force-removing worktrees outside the managed root)

### Requirement: The fix prompt SHALL instruct a pre-commit self-check for severity escalation

`buildFixPrompt` output SHALL instruct the harness, before committing or pushing, to
compare its own diff against the findings it was given and to call out any change that
appears to introduce a problem of *higher severity* than the finding it resolves. The
self-check SHALL be conservative-open: when such an escalation is suspected, the harness
SHALL surface the concern in its output and withhold the push rather than silently
proceeding. The self-check is a prompt-level instruction the harness performs on its own
diff; it SHALL NOT add a new pipeline stage or a second independent re-review (the
pre-merge review-SHA gate already re-reviews the pushed fix commit).

#### Scenario: self-check instruction is present

- **WHEN** `buildFixPrompt` is called for any fix round
- **THEN** the returned prompt string SHALL instruct the harness to compare its diff against the findings before committing
- **AND** to flag, and withhold the push for, any change that appears to introduce a higher-severity issue than the finding it fixes

### Requirement: The surgical-fix discipline SHALL be drift-guarded by tests

The test suite SHALL include golden-prompt/drift assertions over `buildFixPrompt` output
that cover the minimal-diff discipline, the destructive-operation guard, and the
pre-commit self-check. Each assertion SHALL fail (bite) when the corresponding instruction
is removed from the fix prompt, so the discipline cannot silently regress.

#### Scenario: drift test bites on removal

- **WHEN** any one of the three instructions (minimal-diff, destructive-operation guard, self-check) is removed from the fix prompt
- **THEN** at least one `buildFixPrompt` drift assertion SHALL fail with a message indicating the missing instruction

#### Scenario: drift test passes with the discipline present

- **WHEN** the fix prompt contains all three instructions
- **THEN** the `buildFixPrompt` drift assertions SHALL pass
- **AND** the rendered prompt SHALL contain no unfilled `{{placeholder}}`

### Requirement: The surgical-fix discipline SHALL be documented in the conventions reference

The conventions reference SHALL document the surgical-fix discipline — minimal
finding-scoped diffs, the destructive-operation guard, and the pre-commit self-check — in
`CLAUDE.md`'s Review layer & convergence section, so the rationale and the prompt behavior
are discoverable alongside the other convergence conventions.

#### Scenario: discipline is discoverable in the conventions reference

- **WHEN** a reader consults the Review layer & convergence section of `CLAUDE.md`
- **THEN** it SHALL describe the surgical-fix discipline and reference the fix prompt as its implementation

### Requirement: Pre-merge or surgical repair SHALL fail closed on large unrelated landing-page documentation deltas

A pre-merge repair, fix-round repair, restack, or conflict-resolution path that applies surgical-fix discipline SHALL treat a large unrelated root `README.md` landing-page contract breach (including a #793-class monolithic append unrelated to the findings or conflict under repair) as out of surgical scope for silent success. When such a delta is present on the head that would advance, the control path SHALL fail closed or return the item to scoped repair/review with diagnostics naming the documentation contract breach. The path SHALL NOT advertise gate-passed implement/fix success or ready-to-deploy eligibility while the landing-page contract enforced by the docs check surface is red. This requirement does not change review severity thresholds, finding disposition policy, or merge authority; it is a deterministic documentation-contract control.

#### Scenario: Fix/pre-merge head with monolithic README does not silently advance

- **WHEN** a surgical fix or pre-merge repair commits a head whose `README.md` violates the landing-page line budget or companion-link contract
- **AND** that documentation delta is unrelated to the findings or conflict being repaired
- **THEN** the pipeline control path SHALL NOT treat the item as successfully advanced past the docs/test gate
- **AND** SHALL surface a failure or scoped-review return that names the README / landing-page contract breach class

#### Scenario: Finding-scoped code fix with compliant README still advances subject to other gates

- **WHEN** a surgical fix changes only finding-scoped code paths
- **AND** root `README.md` remains within the landing-page contract
- **THEN** this requirement SHALL NOT by itself block advance
- **AND** other existing gates (tests, review-SHA, CI) continue to apply unchanged

#### Scenario: Regression coverage for the #793 repair escape class

- **WHEN** a unit or fixture test injects a post-repair head with a #793-shaped monolithic README append on a path that claims surgical or conflict repair success
- **THEN** the test SHALL assert fail-closed or non-success (no silent ready-to-deploy / gate-pass outcome)
- **AND** the test SHALL fail if that assertion path is removed

### Requirement: Ship-path autonomy preamble SHALL coexist with surgical-fix discipline

When fix-round prompts include the ship-path autonomy doctrine preamble (versioned marker and factory-class guidance), the surgical-fix requirements already defined by this capability SHALL remain fully in force for ordinary product review findings. The autonomy preamble SHALL NOT remove, bury, or weaken: (1) minimal finding-scoped diff instructions, (2) destructive-operation safety scope, or (3) pre-commit severity self-check. Class-over-site guidance in the preamble applies when the work is engine recovery, pipeline self-host, or ship-path dogfood autonomy; it is an additional judgment layer, not a license to refactor or broaden ordinary product fixes.

#### Scenario: Autonomy-injected fix prompt still forbids over-reach on ordinary findings

- **WHEN** `buildFixPrompt` is called and the built prompt includes the ship-path autonomy version marker
- **THEN** the returned prompt string SHALL still instruct the harness to make the minimal diff that resolves the finding
- **AND** it SHALL still explicitly forbid refactors, scope-broadening, unrelated changes, and opportunistic cleanup for ordinary product review findings

#### Scenario: Autonomy-injected fix prompt still guards destructive operations

- **WHEN** `buildFixPrompt` is called and the built prompt includes the ship-path autonomy version marker
- **THEN** the returned prompt string SHALL still name at least one guarded destructive operation and require managed-root / reviewed-head scoping or explicit justification as already required by this capability

#### Scenario: Drift tests still bite if surgical instructions disappear under autonomy injection

- **WHEN** any of the three surgical instructions is removed from the fix prompt while the autonomy preamble remains
- **THEN** at least one `buildFixPrompt` drift assertion SHALL fail
