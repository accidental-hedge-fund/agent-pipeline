## Context

See `proposal.md` for motivation.

Commander is configured with `allowExcessArguments(true)`. The shared extra-positionals guard in `main` is the admission gate. It calls `maxPositionalsFor(cmd.args[0])` and exits 2 when `cmd.args.length` is above that budget.

`maxPositionalsFor` already special-cases commands with extra positionals (`run`, `lineage`, `factory-pin`, `loop`, `refine-spec`, and others). The default remains **1**. `handoff` still uses that default, so the keyword spends the whole budget and the documented verb is rejected as `unexpected argument(s)` before the existing `numArg === "handoff"` dispatch block.

That dispatch block already implements the five verbs, missing-verb usage, missing-ID usage, required flags, authentication, and materialization. Handler unit tests already cover those seams with injected I/O.

First holding rung after reading that code: extend the existing `maxPositionalsFor` helper and keep the existing dispatch block. Do not add a new parser, arity registry, or CLI deps seam.

## Goals / Non-Goals

**Goals:**

- Make documented `pipeline handoff <verb>` argv reach the existing dispatch block.
- Keep extra tokens, a missing required ID, a missing verb, and an unknown verb as exit 2 before a handler read or mutation.
- Prove admission through the real argument parser (`buildCmd().parse`) plus the shared arity predicate.
- Publish executable per-verb usage in command-docs / `docs/cli.md`.

**Non-Goals:**

- A declarative command-arity registry for every CLI verb.
- A rewrite of Commander parsing or of the handoff dispatch block.
- New handler, lock, auth, materialization, or audit behavior.
- A new CLI deps injection so `main` can stub `listHandoffs`.
- An audit of unrelated commands unless they already fail this same omitted-budget rejection for documented sub-verbs.
- A live GitHub mutation or a live Decisions-node attestation in CI.

## Decisions

### D1: Extend `maxPositionalsFor`; do not invent a parser

**Decision:** Reuse `maxPositionalsFor` as the shared budget function. Add an optional second argument (`args?: readonly string[]`). The extra-positionals call site in `main` SHALL pass `cmd.args` so `handoff` can be verb-aware. Existing one-argument call sites stay valid.

**Why:** This is the same first-rung fix as #554 (`loop` positional list). The helper already exists and is unit-tested. A new arity registry or parser layer would be a custom layer the implementer then has to build.

**Rejected:** Skip the shared guard for `handoff` (unbounded argv). That would let extra tokens reach handlers.

**Rejected:** Put the extra-token check only inside `listHandoffs` / mutating handlers. The defect is the admission gate, not the handlers.

**Rejected:** Raise a single integer cap of 3 for every `handoff` argv. That would admit `handoff list extra` into the list handler.

### D2: Verb-aware budget for `handoff` only

**Decision:** When `command === "handoff"` and `args` is present:

| argv shape | budget (including `handoff`) |
| --- | --- |
| `list` | 2 (verb only) |
| `show`, `answer`, `reject`, `supersede` | 3 (verb + exactly one ID) |
| missing or unknown verb | 2 (command + one token) |

Without `args`, return 3 (the documented ceiling) so one-argument tests still describe the maximum legal shape.

The gate rejects surplus tokens before the `if (numArg === "handoff")` block. Missing verb, unknown verb, and missing ID stay with the existing dispatch usage path (exit 2, no handler read or mutation). Do not refactor the dispatch verb allowlist in this issue.

**Why:** The class is “positional budget matches documented grammar, extra tokens still fail before dispatch.” Implement that class for `handoff`. Other documented sub-verb commands (`lineage`, `factory-pin`, `evals`, `refine-spec`) already have a non-default cap. This issue does not scan or rewrite them.

**Rejected:** Teach the guard the full per-verb flag grammar. Flags are already Commander options. Required-flag checks stay in dispatch.

### D3: Parser tests, not a new dispatch seam

**Decision:** Prove admission the same way #554 does:

1. `buildCmd().parse(documented argv)` so flags stay options and positionals match the grammar.
2. `cmd.args.length <= maxPositionalsFor(cmd.args[0], cmd.args)` so the tests fail if the guard still rejects the verb.
3. The inverse predicate for extra tokens after `list` and after `show|answer|reject|supersede <id>`.
4. Optional `spawnSync` of `pipeline.ts` for extra-token cases that must prove `process.exit(2)` before any handler, matching `detach.test.ts`. Those spawns MUST be argv that the guard rejects, so they need no git, network, or GitHub.

Keep existing `human-question-handoff` and grill-authority materialization tests with injected I/O. Do not add a `HandoffCliDeps` seam and do not call live GitHub in CI.

**Why:** The issue requires CLI-parser coverage, not handler-only tests. Dispatch is already correct once argv arrives. A new injection layer is YAGNI.

### D4: Command-docs spaced-pipe grammar

**Decision:** Replace the collapsed `handoff list|show|answer|reject|supersede …` usage string with spaced-pipe alternatives that `formatHostUsage` already prefixes as complete `pipeline …` invocations. Match the executable dispatch usage, including `--filter-status` (not `--status`) for list. Regenerate `docs/cli.md`. Do not document module invocation.

**Why:** Generated docs are the operator contract. The current synopsis both hides per-verb arity and names a non-executable `--status` filter.

## Risks / Trade-offs

- **[Risk] One-argument `maxPositionalsFor("handoff")` returns 3, which would admit `list extra` if `main` forgets to pass `cmd.args`.** → Mitigation: the production call site must pass `cmd.args`; tests cover `maxPositionalsFor("handoff", ["handoff", "list", "extra"])` as over budget.
- **[Risk] Unknown-verb usage still enters the `handoff` block after the gate admits `handoff <token>`.** → Mitigation: that path is the existing usage printer (exit 2). It does not call list/show/answer/reject/supersede. Extra tokens after an unknown verb remain over budget (2).
- **[Risk] `spawnSync` of a valid `handoff list` would perform a real read.** → Mitigation: valid-verb tests stay on `buildCmd` + `maxPositionalsFor`. Spawn only guard-rejected extras.

## Migration Plan

No migration. Existing documented argv starts working. Invalid extra tokens keep exiting 2. Rollback is revert of the `maxPositionalsFor` / docs change.

## Open Questions

None. Settled Decisions nodes bound admission-only scope, the `handoff` grammar, exit 2 timing, parser tests, and docs parity.
