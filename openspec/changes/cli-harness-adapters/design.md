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

**OpenCode — verified** via `npx --yes opencode-ai@latest --help` / `run --help` / `providers --help`
(npm package `opencode-ai`, bin `opencode`, maintainer thdxr/SST):

- `opencode run [message..]` — non-interactive single-turn mode; `message` is the prompt positional
  (default `--interactive` is `false` for `run`, so no TUI is spawned)
- `--dir <dir>` — "directory to run in" → `workingDir: "flag"`
- `-m, --model <provider/model>` — model flag, format `provider/model` (so requested model must
  already be in that shape or the adapter must prefix a provider; if the configured model has no
  `/`, preflight fails rather than guessing a provider)
- `--variant <level>` — "model variant (provider-specific reasoning effort, e.g., high, max,
  minimal)" → effort flag; values are provider-specific and are recorded verbatim (decision 6), no
  mapping
- `--format default|json` — `json` = "raw JSON events" → `telemetry: "jsonl"`
- `--auto` — "auto-approve permissions that are not explicitly denied (dangerous!)" — the closest
  thing to a sandbox/permission-mode flag; treated as the adapter's `sandbox` capability. Default
  (no `--auto`) is unattended-unsafe for a fully headless pipeline run (it can block on a permission
  prompt with no TTY to answer it), so the adapter always passes `--auto` for pipeline invocations
  and records that fact in `describeTreatment`.
- `-c, --continue` / `-s, --session` — session resume; unused (pipeline stages are single-turn)
- `opencode providers list` (alias `opencode providers ls` / `opencode auth`) — lists configured
  provider credentials; used by preflight as the login-state probe. No documented flag reports
  auth state as clean machine-readable JSON, so preflight parses the human-readable list output for
  a non-empty provider entry; if that ever changes shape, preflight degrades to "authenticated
  state unknown" rather than crashing (never inferred from the model name — decision 5).
- No documented `--cwd`-vs-repo-root distinction beyond `--dir`; no separate "headless capability
  probe" flag exists, so preflight's "headless mode available" check is satisfied by the CLI being
  on `PATH` and `run --help` succeeding (i.e. the `run` subcommand exists in this version).

**Pi (Pi Coding Agent) — verified** via `README.md` at `github.com/badlogic/pi-mono` (package
`@mariozechner/pi-coding-agent`, project site `pi.dev`, by Armin Ronacher / earendil-works):

- `-p, --print` — "Print response and exit" → single-turn headless mode; prompt passed as a
  trailing positional argument (`pi -p "<prompt>"`)
- `--mode json` — "Output all events as JSON lines" → `telemetry: "jsonl"`
- `--provider <name>` + `--model <pattern>` — model selection (`provider/id` or bare id with
  optional `:<thinking>` suffix)
- `--thinking <level>` — reasoning effort, one of `off|minimal|low|medium|high|xhigh|max` → effort
  flag, recorded verbatim, no mapping
- `-a, --approve` / `-na, --no-approve` — trust/permission mode for project-local files; the
  adapter always passes `-a` for pipeline invocations (unattended headless run, no TTY to answer a
  trust prompt) and records that in `describeTreatment` → `sandbox: true` capability, always-on for
  pipeline use
- **No documented `--cwd`/`-C` flag.** Pi has no working-directory override; it operates on the
  process's current working directory. → `workingDir: "cwd"` (adapter spawns with `cwd` set to the
  stage worktree, like claude's mechanism, not like codex/grok's explicit flag).
- **No documented non-interactive login-status probe.** The only auth commands found are the
  interactive `/login`/`/logout` REPL commands and an `--api-key <key>` override flag; there is no
  `pi auth status`-equivalent. Preflight therefore can verify "CLI on `PATH`" and "`-p`/`--mode
  json` flags exist in `pi --help`" but **cannot** distinguish "authenticated" from
  "unauthenticated" before spawning a real request. Per decision 7 ("preflight fails loudly rather
  than silently drop"), the pi adapter's preflight reports this sub-check as
  `authState: "unknown"` (not `pass`/`fail`) with an explicit message that pi has no documented
  auth-status probe and the first real invocation is the actual auth test — this is a documented
  adapter limitation, not a guess, and doctor surfaces it as a distinct informational result rather
  than blocking the run on it.

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
