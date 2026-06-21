## Context

`pipeline.ts` has grown to 2,458 lines over many increments. The `main()` function spans roughly 700 lines of sequential guards — each new subcommand appended its own `for ([flag, active] of conflicts)` block, its own early-dispatch arm, and its own config-resolution call. Two structural problems compound:

1. **Flag-validation scatter.** Every command validates its own incompatible flags separately. The merge-command allowlist (#217) generalised the pattern once (using `cmd.getOptionValueSource`), but the pattern never propagated. The unrecognised-subcommand guard (line 730) maintains a hard-coded `recognized` array that must be kept in sync by hand.
2. **Lifecycle inlining.** `runAdvance` (line 1786) embeds locking, GhMetrics setup, evidence bundle creation, run-directory init, terminal tee, stage loop, audit-sentinel repair, auto-loop budget, and finalization inline. Nothing in this lifecycle can be tested without going through the CLI layer or extracting the function wholesale.

## Goals / Non-Goals

**Goals:**
- Every subcommand's allowed flags, config requirements, issue requirements, and JSON-output eligibility are declared once in `command-registry.ts`, not scattered in `main()`.
- `main()` reduces to: `buildCmd()` → `cmd.parse()` → registry lookup → generic flag guard → dispatch.
- The advance-loop lifecycle lives in `pipeline-run.ts`; its caller in `main()` passes resolved values, not Commander state.
- All existing behaviors — kill-switch, preflight gate, per-command rejections, auto-loop, audit-sentinel repair — are preserved exactly.
- Golden CLI parsing tests cover every command × disallowed-flag combination currently guarded in `main()`.
- `PipelineRun` tests call the lifecycle directly with injectable `AdvanceDeps` without touching Commander.

**Non-Goals:**
- Redesigning state machine edges, stage handlers, or any GitHub-visible behavior.
- Changing config schema, `gh.ts` API, `types.ts`, or evidence bundle format.
- Converting `pipeline.ts` to a public-API module beyond what tests already use.

## Decisions

**Decision: registry is a plain typed map, not a class hierarchy.**
`COMMAND_REGISTRY: Record<string, CommandMeta>` where `CommandMeta` carries:
```
allowedFlags: Set<keyof CliOpts>
mutatesGitHub: boolean
needsConfig: boolean
needsIssue: boolean
supportsJson: boolean
requiresArgs: string[]        // positional arg names, in order
```
The CLI entry resolves `COMMAND_REGISTRY[subcommand]?.allowedFlags` and runs the generic `cmd.getOptionValueSource(key) === "cli"` guard — the same pattern the merge-command uses today. No runtime polymorphism; a plain lookup.

**Decision: the merge-command guard is the template.**
The existing merge allowlist (lines 363-378) is the proven pattern. The generic guard iterates every key of `cmd.options`, checks `!allowedFlags.has(key) && cmd.getOptionValueSource(key) === "cli"`, and emits a single combined error. Every command with an existing hand-written guard migrates to the registry; commands with no current guard (e.g. `init`, `cleanup`) get an entry reflecting what `main()` currently accepts without error.

**Decision: `PipelineRun` is a plain async function, not a class.**
`runAdvance(cfg, issueNumber, opts, deps?)` — same signature as today's. The extract is a file move; `main()` continues to call it identically. The closure over `deps` (already an optional parameter) provides the testability seam without introducing class state. The function signature does NOT expose Commander types.

**Decision: `pipeline-run.ts` does NOT import Commander.**
It receives `cfg: PipelineConfig`, `issueNumber: number`, and `opts: CliOpts` as plain values. This is the enforced contract: the CLI parses, the run service executes. An import of Commander from `pipeline-run.ts` is a test-failing import-cycle guard (asserted in a unit test via a regex over the file's import block).

**Decision: golden CLI tests use `buildCmd().parse(argv)` on synthetic slices, not subprocess snapshots.**
`buildCmd()` is already exported for this purpose. Each test case is `{ argv: string[], shouldExit2: boolean }`. Table-driven; one case per known guard: every command × every flag currently rejected. This makes flag-guard regressions a test failure rather than a CI surprise.

**Decision: registry coverage test asserts completeness.**
A test iterates every key of the `CliOpts` interface at runtime (via a representative object) and asserts it appears in at least one entry's `allowedFlags`. A new flag added to `buildCmd()` but omitted from the registry is a test failure rather than a silent acceptance gap.

## Risks / Trade-offs

- *Registry drift*: a new flag added to `buildCmd()` but omitted from the registry silently accepts it for commands that shouldn't allow it. Mitigation: the registry-coverage test makes this a CI failure.
- *Behavior regression from `runAdvance` extraction*: the function is ~600 lines with nested try/finally; a copy-paste error could change teardown order. Mitigation: existing end-to-end and stage-loop tests must pass unchanged; the function moves verbatim with no logic edits in the extraction step.
- *Import cycles*: `pipeline-run.ts` will import from several existing modules (`gh.ts`, `evidence-bundle.ts`, `run-store.ts`, etc.). These are already imported by `pipeline.ts`, so no new cycles are introduced — but the direction must be verified. `pipeline-run.ts` must NOT import `pipeline.ts`. A unit test asserts the absence of that import.
