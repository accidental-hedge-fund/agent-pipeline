## Context

`invoke()` in `core/scripts/harness.ts` is the single choke point through which every
prompt-bearing subprocess is spawned (stages, review rounds, plan-review, fix rounds, and the eval
executor all route through it). It resolves an adapter, calls `adapter.buildInvocation()`, and hands
`{cmd, args, cwd}` to `runCapped()`, which spawns with `stdio: ["ignore", "pipe", "pipe"]`. Every
adapter today appends `ctx.prompt` to `args`; an unregistered harness name (the custom
`review_harness`, #40) uses `args = [prompt]`.

Linux enforces two separate limits: `ARG_MAX` on the total size of argv + envp (~2 MB, not the
binding constraint here) and `MAX_ARG_STRLEN` = 32 × PAGE_SIZE = **131,072 bytes** on *each single*
argv element. The prompt is one element, so it hits the per-element cap first. `execve` returns
`E2BIG`; Node surfaces it as a spawn failure and `runCapped` resolves `exit_code: -1`,
`spawn_error: true` — the same shape as "CLI not on PATH", which is why the failure reads as
transient.

## Goals / Non-Goals

Goals:
- Arbitrarily large prompts reach the CLI.
- Zero observable change for prompts under the limit (same CLI, flags, cwd, telemetry mode, stdout
  parsing).
- No prompt-bearing spawn path is left silently exposed to the limit.

Non-Goals:
- Reducing prompt size (diff trimming, digest compaction) — a separate concern.
- Streaming/chunked prompt protocols, prompt caching, or retry policy.

## Decisions

### 1. Channel is declared by the adapter, not inferred at the call site

`AdapterInvocation` gains a prompt-delivery description rather than `invoke()` branching on harness
name. This matches the #431 contract, which deliberately removed `harness === "claude"` tests from
the call site (see `captureMode` / `transformForward`). The adapter returns either an argv that
already contains the prompt (`argv` channel), an argv plus a stdin payload (`stdin`), or an argv
referencing a file it asks the runner to materialize (`file`).

Alternative rejected: always pipe stdin for every adapter. Some CLIs treat piped stdin as additional
context appended to the positional prompt (codex documents exactly this: "If stdin is piped and a
prompt is also provided, stdin is appended as a `<stdin>` block"), so a blanket pipe would silently
change semantics for adapters that keep a positional.

### 2. Per-CLI channels are read from each CLI's own interface, never guessed

Golden rule 5. Verified at proposal time:

| adapter | channel | evidence |
| --- | --- | --- |
| `claude` | stdin (drop the positional) | `printf '…' \| claude --print --output-format text` returns the model's reply locally |
| `codex` | stdin with the documented `-` sentinel | `codex exec --help`: "Initial instructions … If not provided as an argument (or if `-` is used), instructions are read from stdin" |
| `grok` | file via `--prompt-file <PATH>` | `grok --help` lists `--prompt-file <PATH>` — "Single-turn prompt from a file" |
| `pi` | argv (no alternative documented) | `npx --yes @mariozechner/pi-coding-agent --help` (implementation time, CLI not installed locally): the `-p`/`--print` message positional has no stdin/file alternative; `@file` arguments attach file content alongside a message, they do not replace it |
| `opencode` | argv (no alternative documented) | `npx --yes opencode-ai@latest run --help` (implementation time, CLI not installed locally): the `message` positional has no stdin/file alternative; `-f/--file` attaches a file alongside the message, it does not replace it |

Any adapter whose CLI documents neither a stdin nor a file channel keeps `argv` and relies on
decision 4. Confirmed for `pi` and `opencode` at implementation time (#492): neither CLI's headless
interface documents a channel other than the positional message argument, so both adapters declare
`promptDelivery: "argv"` explicitly and are protected only by the pre-spawn oversize guard.

### 3. `runCapped` opens stdin only when there is a payload

`stdio[0]` becomes `"pipe"` **only** when the invocation carries a stdin payload; otherwise it stays
`"ignore"`, preserving current behavior byte-for-byte for anything that does not use the channel.
The payload is written and `end()`ed immediately after spawn. An `EPIPE`/write error on the child's
stdin is treated like the existing forward-error diagnostics: it is reported, not swallowed, and it
never masquerades as a treatment result. The existing synchronous-`spawn()`-throw guard (the NUL-byte
path, #393) stays as-is.

### 4. Oversize argv is a refusal, not a spawn attempt

Before spawning, any argv element whose UTF-8 byte length exceeds `MAX_ARG_STRLEN` causes the
invocation to be refused with a named failure carrying the limit, the measured size, and the remedy.
This is a belt-and-braces net for the `argv` channel (custom reviewer CLIs, and any adapter whose CLI
offers no other channel). It converts an unactionable, retry-forever `exit -1` into a diagnosis. The
constant is defined once and used by both the guard and its test.

### 5. The custom reviewer CLI gets an explicit, opt-in channel

`review_harness` names an arbitrary operator CLI whose interface the pipeline cannot know. Switching
its default to stdin would silently hang or blank the prompt for CLIs that read a positional. The
default therefore stays `argv` (byte-identical to today for small prompts), with an explicit setting
to select stdin. Combined with decision 4, an operator whose custom CLI hits the limit gets a message
that names the setting instead of an opaque failure.

### 6. File-channel temp files live under the managed worktree

For the `file` channel the prompt is written to a pipeline-owned temp path inside the stage worktree
(the same root the harness already writes to) and removed after the call. No write outside the
managed worktree root; removal is scoped to the exact file the pipeline created.

## Risks / Trade-offs

- **A CLI behaves differently with an open stdin pipe.** Mitigated by only piping when a payload
  exists, and by the golden-argv tests pinning every other aspect of the invocation.
- **Telemetry/streaming interaction.** `captureMode`/`transformForward` operate on stdout only and
  are untouched; the stdin write happens once, immediately after spawn, and cannot deadlock against
  stdout consumption because stdout/stderr readers are attached before the write.
- **`pi`/`opencode` channels unverified at proposal time.** Deliberate: the spec requires reading
  their documented interface rather than shipping a guess, and decision 4 keeps them safe meanwhile.

## Migration

None. No config migration is required; the new custom-reviewer delivery setting is optional and
defaults to today's behavior. The change is fully backward compatible for prompts under the limit.
