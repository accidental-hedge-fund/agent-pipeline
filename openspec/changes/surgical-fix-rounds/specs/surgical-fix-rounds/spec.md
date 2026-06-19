## ADDED Requirements

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
deletion, and the merge surface. The guard SHALL require any such destructive path to be
scoped to the **managed worktree root** or the **reviewed head**, so a fix cannot widen
the blast radius of a destructive operation while resolving an unrelated finding. If a
finding's correct fix genuinely requires touching a guarded operation, the harness SHALL
state an explicit justification in its output.

#### Scenario: destructive-operation guard is present and scoped

- **WHEN** `buildFixPrompt` is called for any fix round
- **THEN** the returned prompt string SHALL name at least one destructive operation (e.g. force worktree removal or force push)
- **AND** it SHALL require that operation to be scoped to the managed worktree root or the reviewed head, or accompanied by an explicit justification

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
