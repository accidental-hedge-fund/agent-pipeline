# Design — CLI harness adapters

## Context

Two seams already exist and neither fits:

| Seam | What it generalizes | Why it doesn't fit |
| --- | --- | --- |
| `invoke()` branch chain (`harness.ts`) | claude / codex / custom-reviewer-CLI | Hard-coded; the custom branch is `<cmd> <prompt>` with no cwd, model, effort, preflight, or telemetry |
| `executors:` registry (#314, `executors.ts`) | Remote `agent-system` HTTP providers and `model-endpoint` chat completions | Definitions reference an API endpoint, explicitly "not a local CLI path"; preflight is an HTTP reachability probe |

This change generalizes the *first* seam and plugs it into the *second*'s assignment surface.

## Decision 1 — Extend `executors:` with `type: local-cli` instead of adding `stage_harnesses:`

**Chosen:** a third executor variant:

```yaml
executors:
  grok-impl:   { type: local-cli, adapter: grok,     model: grok-4, effort: high }
  oc-review:   { type: local-cli, adapter: opencode, model: claude-fable-5 }
stage_executors:
  implementing: grok-impl
  review-2:     oc-review
```

**Rejected:** a parallel `stage_harnesses: { implementing: grok }` key.

**Why.** A second per-stage assignment key would create a precedence question at every stage
(`stage_executors` vs `stage_harnesses` vs `review_harness` vs profile) with no principled answer,
and would duplicate the routing, evidence, and preflight plumbing `stage_executors` already owns.
The named-executor indirection also gives each assignment its own model/effort binding, which a
bare `stage: adapter` map cannot express. Cost: `executors:` now spans local and remote, so the
`model-endpoint` stage-eligibility rule must be stated per-type rather than as "endpoint vs
agent-system" — handled in the spec delta.

**Precedence (stated so it is never ambiguous):** for a given model-invoking stage,
`stage_executors[stage]` wins → else, for review stages, `review_harness` (#40) → else the
profile's `harnesses.implementer` / `harnesses.reviewer`.

## Decision 2 — Adapter contract shape

`core/scripts/harness-adapters/types.ts`:

```ts
export interface AdapterCapabilities {
  model: boolean;                        // supports selecting a model
  effort: boolean;                       // supports a reasoning-effort control
  sandbox: boolean;                      // supports a restricted-permission mode
  workingDir: "cwd" | "flag";            // cwd inheritance vs an explicit flag
  telemetry: "none" | "jsonl";           // machine-readable per-call usage
}

export interface AdapterInvocation { cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }

export interface HarnessAdapter {
  readonly name: string;                                  // registry key + recorded adapter identity
  readonly capabilities: AdapterCapabilities;
  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation;
  preflight(deps: AdapterPreflightDeps, req: AdapterRequest): Promise<AdapterPreflightResult>;
  parseTelemetry(capturedStdout: string): HarnessTelemetry;
  describeTreatment(req: AdapterRequest, inv: AdapterInvocation, probe: AdapterProbe): HarnessTreatment;
}
```

`invoke()` reduces to: `resolveAdapter(name)` → `buildInvocation` → `runCapped(…, { killProcessGroup: true })`
→ `adapter.parseTelemetry` → existing `HarnessResult` + accounting. `runCapped` is untouched;
capture mode and forward transform become adapter-declared rather than `harness === "claude"`
tests. Because types are stripped and not checked, a runtime test iterates the registry and
asserts each member is present and of the right kind.

## Decision 3 — Claude/Codex argv is frozen, not "equivalent"

Their adapters must emit the exact `cmd`/`args` the current chain emits, across the default,
`lean`, `sandbox`, `PIPELINE_CODEX_NO_SANDBOX=1`, and `PIPELINE_HARNESS_TELEMETRY=off` variants,
including the `--tools "" --strict-mcp-config` ordering comment (the variadic must not swallow the
prompt positional). A golden-argv table test pins all of them; it should fail if any flag order
changes. This is the regression contract for "existing behavior unchanged".

## Decision 4 — Verified vs. deliberately unspecified argv

Golden rule 5 forbids guessing external CLI shapes.

**Grok Build — verified** on this machine (`grok 0.2.93 (f00f9631)`), from `grok --help`:

- `-p, --single <PROMPT>` — single-turn headless prompt, prints response, exits
- `--cwd <CWD>` — working directory (so `workingDir: "flag"`, matching codex's `-C`)
- `--output-format plain|json|streaming-json` — headless output format
- `-m, --model <MODEL>`; `--reasoning-effort <EFFORT>` (alias `--effort`)
- `--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`
- `grok login` / `grok models` — auth and model-support probes for preflight
- `--verbatim` — send the prompt exactly as given (avoids prompt rewriting)

**Pi and OpenCode — not installed here.** Their adapters' argv MUST be read from the installed
CLI's own `--help`/docs and recorded in this file (task 4.1) before their adapter files are
written. The spec deltas therefore constrain *behavior* (headless, non-interactive, worktree
working directory, model/effort mapped or explicitly declared unsupported, machine-readable output
when the CLI offers one) and never name a flag for these two.

## Decision 5 — Adapter identity ≠ provider identity

`AdapterProbe` carries `{ cliVersion, providerAuthClass }`. `providerAuthClass` is a coarse,
non-secret label such as `oauth:anthropic`, `oauth:xai`, `api-key:anthropic`, or `unknown` — never
an account id, token, or auth-file path. Evidence records adapter and provider as **separate**
fields, so a `pi`/`opencode` run against an Anthropic model is `adapter=pi, provider=anthropic` and
is never collapsed into `harness=claude`. This is what keeps `pipeline scoreboard --by harness`
(#437) from silently merging two different products.

When the CLI exposes no reliable provider signal, `providerAuthClass` is `unknown`. Inferring it
from the model name is forbidden: a model alias can be served by more than one route.

## Decision 6 — Effort is recorded, never normalized

Requested and resolved effort are stored verbatim as two separate values. No cross-harness effort
mapping table exists in code or spec. `grok --reasoning-effort high` and `claude --effort high`
may cost wildly different compute; the pipeline records both as `high` and makes no equivalence
claim. Where an adapter cannot honor a requested effort, preflight fails loudly rather than
silently dropping the flag — a silently dropped effort would make a comparison meaningless.

## Decision 7 — Preflight is capability-based and pre-stage

`adapter.preflight()` answers four distinguishable failures: CLI absent from `PATH`; CLI present
but unauthenticated; headless/non-interactive mode unavailable; requested model or effort
unsupported. It runs through the existing `DoctorDeps`-style injected exec seam, so unit tests use
fake executables. On failure the item is blocked with a named stage+adapter error. There is **no**
fallback to another harness — falling back would silently change the treatment being measured.

## Decision 8 — Cancellation and credentials

All adapters go through `runCapped` with `killProcessGroup: true` and the existing hard secondary
deadline (#398); an adapter may not spawn detached or bypass `runCapped`. Adapters never read,
forward, or synthesize credentials: they rely on the CLI's own completed login state, and no
credential value ever reaches a result, event, log line, or error message.

## Risks

- **Registry-vs-custom-CLI collision.** A user whose `review_harness` command happens to be named
  `pi` would now resolve to the adapter. Mitigated by documenting the adapter names as reserved
  and by the precedence rule; the unregistered-name path is unchanged and tested.
- **Adapter drift.** Three third-party CLIs can change flags. Mitigated by preflight surfacing an
  unsupported capability rather than the stage failing opaquely mid-run, and by recording
  `cliVersion` in evidence so a behavior change is attributable after the fact.
- **`Harness` type widening.** `Harness = "claude" | "codex"` is used across stages; widening it to
  the adapter union is type-only (types are stripped), so any place that switches on it needs a
  real runtime test, not a type guarantee.
