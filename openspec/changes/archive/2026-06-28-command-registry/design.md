## Context

The current `pipeline.ts` dispatch block uses a cascade of `isXxxCommand` boolean variables (`isInit`, `isDoctorCommand`, `isReleaseCommand`, `isIntakeCommand`, `isSweepCommand`, `isTriageCommand`, `isMergeCommand`, `isRefineSpecCommand`) derived by string-matching the first positional argument. Each command then has its own ad-hoc flag-conflict section: `merge` uses an exhaustive allowlist via `MERGE_ALLOWED_OPTS`; most others use per-command denylist arrays (e.g., `intakeConflicts`, `rwConflicts`) that silently pass any newly-added global flag not explicitly enumerated. The `runAdvance` function is 550 lines of nested code handling locking, stage dispatch, event emission, evidence bundle writes, auto-loop budget, finalization, and terminal-log tee — all in one block inside `main()`, making it impossible to unit-test the lifecycle without also importing Commander and triggering CLI side-effects.

## Goals / Non-Goals

**Goals:**
- Make flag-allowlist enforcement structural and uniform across all commands (same guarantee `merge` has today, generalized to every command).
- Make the advance-loop lifecycle independently importable and testable without importing the CLI.
- Eliminate the need to edit multiple disconnected sections of `pipeline.ts` when adding a new sub-command.
- Produce golden CLI parsing tests enumerating every command × flag combination.

**Non-Goals:**
- Changing any externally observable behavior of existing commands (same flags, same dispatch routing, equivalent error messages — only the mechanism changes).
- Moving `buildCmd()` or Commander setup (stays in `pipeline.ts`).
- Introducing dynamic command registration (no plugin/extension surface; the registry is a static table in source).
- Altering the advance loop's stage-dispatch logic (only the packaging/extraction changes; all business logic stays).

## Decisions

**Decision: registry as a plain TypeScript map literal, not a class.**
A `Record<string, CommandEntry>` table is the simplest structure: each entry is plain data (no methods), the lookup is a single `COMMAND_REGISTRY[cmd]` access, and the table is grep-able. A class hierarchy or plugin registry would be over-engineered for a statically known set of ~18 commands.

**Decision: `allowedFlags` lists Commander attribute names, not flag strings.**
Commander converts `--dry-run` → `dryRun`, `--repo-path` → `repoPath`, etc. Using attribute names (as `merge` already does via `o.attributeName()`) is resilient to flag string renames and can be cross-validated at test time against `buildCmd().options.map(o => o.attributeName())`. Storing raw flag strings would require a secondary mapping step and would not be caught by Commander's own rename.

**Decision: `allowedFlags: "all"` sentinel for the advance (default) command.**
The advance command legitimately accepts all flags. Using a sentinel value rather than listing every flag prevents the advance entry from becoming a maintenance burden when new flags are added, and makes it explicit that "advance is the general case." All other commands use explicit `Set<string>` values.

**Decision: extract lifecycle into a plain exported function, not a class.**
`export async function runAdvance(cfg, issueNumber, opts, deps?)` matches the existing functional pattern (functions with deps parameters) rather than introducing OOP. The only requirement is that it is importable without importing the full CLI, so moving it to `pipeline-run.ts` is sufficient. A class API would add complexity without benefit given that the run is a single-call operation per issue.

**Decision: golden CLI parsing tests call `buildCmd().parse(synthetic_argv)` directly.**
These tests exercise the registry lookup and `validateFlags` independently of launching a child process. They call `buildCmd()` with synthetic argv and then call `validateFlags(entry, cmd)` to assert the expected rejection. This keeps them fast, avoids process spawning, and focuses on the structural invariant: "each command accepts exactly its declared flags and rejects everything else."

## Risks / Trade-offs

- *Flag attribute name drift* → If Commander changes how it computes attribute names, allowlist checks break silently at runtime. Mitigation: the cross-check test in `command-registry.test.ts` compares each registry entry's `allowedFlags` against `buildCmd().options.map(o => o.attributeName())` at test time, catching any drift.
- *Registry coverage drift* → A new sub-command added to `pipeline.ts` without a registry entry bypasses the allowlist check. Mitigation: a test that enumerates all recognized command keywords in the `numArg` dispatch and asserts each has a registry entry; any keyword missing from the registry fails the test.
- *`runAdvance` extraction merge conflicts* → `pipeline.ts` is a hot file; the extraction creates a large diff that conflicts with concurrent PRs. Mitigation: extract-only commit (no logic changes) as a separate step so downstream PRs can rebase cleanly.
- *Message format divergence* → Per-command error messages currently vary in phrasing; the unified `validateFlags` path may produce slightly different wording for some commands. Mitigation: preserve the existing error text for `merge` (highest-fidelity requirement); for others, accept minor phrasing consolidation as a non-breaking improvement.
