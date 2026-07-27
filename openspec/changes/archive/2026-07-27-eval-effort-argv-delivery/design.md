## Context

Two vocabularies meet at one seam. The **eval domain** calls the coordinate `effort`: it is a
manifest treatment axis, a `Treatment` field, part of `cell_id`/`treatment_id`, and a `CellRecord`
field. The **harness domain** calls the caller-facing option `reasoningEffort`
(`InvokeOptions.reasoningEffort`, #366) and only re-narrows it to `effort` one level lower, inside
`AdapterInvocationContext`, where each adapter turns it into its native flag.

`realInvokeHarness` in `core/scripts/evals/executor.ts` builds the `invoke()` options object with
the eval-domain name:

```ts
const result = await harnessInvoke(args.harness, args.worktreeDir, args.prompt, {
  timeoutSec: args.timeoutSec,
  model: args.model,
  effort: args.effort,        // ← not an InvokeOptions key; dropped
  stream: false,
  env: args.env,
  sandboxMode: args.sandboxMode,
});
```

Excess-property checking would flag this in a real `tsc` build, but this repo runs Node's native
type-stripping with **no type-check step**, so the field is simply absent at runtime. Every other
`invoke()` call site in the engine (`planning.ts`, `fix.ts`, `review-routing.ts`, `intake.ts`,
`sweep.ts`, `design_gate.ts`) uses `reasoningEffort` correctly — the eval path is the sole
offender, which is exactly why it went unnoticed: nothing else in the pipeline exercises it.

## Goals / Non-Goals

**Goals**
- The effort a cell claims is the effort its harness process actually received.
- The regression test observes the CLI argv, the only surface that can distinguish "requested" from
  "delivered".
- A treatment whose effort cannot be delivered fails loudly instead of being scored.

**Non-Goals**
- Renaming the eval domain's `effort` axis (it is manifest-facing and part of `treatment_id`;
  renaming it would invalidate existing artifacts for no benefit).
- Renaming `InvokeOptions.reasoningEffort` (it is the engine-wide convention across six call sites).
- Introducing a `tsc` step. That is a real recurrence guard for this bug class, but it is a
  repo-wide change well outside this issue; the runtime test below is the in-scope guard.
- Touching `executors.ts` effort encoding for the API path.

## Decisions

### 1. Map at the seam; keep both domain names

`realInvokeHarness` explicitly translates: `reasoningEffort: args.effort`. Rejected alternatives:

- *Accept both keys in `InvokeOptions`* (`effort?: string` as an alias). Creates two ways to say
  one thing at the engine's most-used seam, and a future caller setting both has undefined
  precedence. A silently-tolerant option bag is what let this bug hide.
- *Rename `HarnessInvokeArgs.effort` → `reasoningEffort`*. Makes the mapping implicit rather than
  explicit and pushes harness vocabulary into the eval domain, where `Treatment.effort`,
  `deriveModelEndpointOverride`, and `preflightFn(harness, { model, effort })` all speak `effort`.
  The seam is the honest place for the translation.

The mapping site keeps a comment naming the two vocabularies and pointing at the argv test, so a
future edit cannot re-diverge without stepping over it.

### 2. The regression test asserts argv, via a fake CLI on `PATH`

`core/test/harness.test.ts` already establishes the pattern: write a temp executable named
`claude`/`codex` that does `printf '%s\n' "$@"`, prepend its directory to `PATH`, call `invoke()`,
and assert on `result.stdout`. This is the only assertion that bites — the pre-fix call site did
pass an option, so any test that inspects the options object handed to a faked `invoke()` would
pass on broken code.

The test drives the **eval path**, not `invoke()` directly, otherwise it re-tests #366 rather than
this bug. That requires `realInvokeHarness` (or an equivalently thin exported entry taking
`HarnessInvokeArgs`) to be exported from `core/scripts/evals/executor.ts`. Exporting the real
implementation is preferred over reaching through `runCell`: `runCell` needs a worktree, fixture,
and gh surface, none of which this assertion is about.

Placement is `core/test/harness.test.ts` (or a sibling that already spawns), **not**
`core/test/evals-executor.test.ts`. The eval executor tests are bound by the repo rule that they
make no real subprocess call; the spawn-based argv tests live where spawning is already the
established, credential-free practice (a local `printf` script, no model, no network).

Proving the test bites is part of the task list: run it against the unmapped call site and show the
effort flag absent.

### 3. Undeliverable effort fails as `infra_error`, before invocation

`AdapterCapabilities.effort` already exists (`harness-adapters/types.ts`), and every registered
adapter declares `true`. The exposed hole is the unregistered custom-CLI path (#40), where
`invoke()` builds `<cmd> <prompt>` and no effort flag exists to emit. Today such a cell would run
and be recorded at its declared effort.

`runCell`'s local-harness branch therefore checks, before the first invocation: if
`treatment.effort` is set and the resolved harness has no effort capability, finish the cell as
`infra_error` naming the harness and the requested effort. This mirrors the established rule that
a configuration/expressibility failure is never a treatment outcome — the same rule
`realInvokeExecutor` applies for an effort the API dialect cannot encode. A cell declaring no
effort against a custom CLI is unaffected.

### 4. No retro-correction of recorded experiments

Existing cell records claiming an effort coordinate they never delivered stay as written; this
change makes them impossible going forward. Invalidating or annotating prior experiment artifacts
is a separate operational decision (and would be a write to append-only run artifacts, which the
eval filesystem contract forbids).

## Risks / Trade-offs

- **Effort now actually takes effect**, so eval cells that previously all ran at CLI default will
  diverge in latency and cost. That is the point, but operators comparing a post-fix run against a
  pre-fix run of the "same" experiment will see a genuine behavior change — the pre-fix numbers are
  the invalid ones. Called out in the task list as a note for the campaign issues (#600–#604).
- **The capability check can reject a previously-running manifest** (custom harness + declared
  effort). That configuration was silently producing invalid data; failing it loudly is the
  intended trade.
- **Spawn-based tests are slower and OS-dependent.** Accepted: the pattern is already in
  `harness.test.ts` and passes in CI today, and argv is the only honest assertion surface.
