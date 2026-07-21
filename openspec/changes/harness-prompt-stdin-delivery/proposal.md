## Why

Every model-invoking stage hands its prompt to the harness CLI as a **single argv element**
(`harness.ts` `invoke()` → each adapter's `buildInvocation()` pushes `ctx.prompt` as a trailing
positional; the unregistered custom reviewer CLI path uses `args = [prompt]`). Linux caps a single
argv element at `MAX_ARG_STRLEN` = 128 KiB (131,072 bytes). A prompt larger than that makes
`execve` fail with `E2BIG`; the pipeline observes `exit -1` a few seconds after spawn, with no
verdict and no usable diagnostic.

This was observed on 2026-07-21 against #436 / PR #491 (46 files, +4867): the review-1 prompt was
168,804 characters and review-1 exited `-1` in ~7–10 s, twice, with an identical fingerprint after
an unblock + retry. A manual repro (`codex exec "<168 KB string>"`) reproduces `argument list too
long`, while the same prompt in a small form succeeds.

The consequence is the worst possible failure shape for a review-rigor product: **the larger the
change, the more certainly it cannot be reviewed at all**. The factory hard-blocks precisely on the
PRs that most need review, and because the failure surfaces as a generic spawn error it looks
transient and burns unblock/retry cycles that can never succeed.

## What Changes

- The harness-adapter contract gains an explicit **prompt-delivery channel**. An adapter declares
  how its CLI receives the prompt — `stdin`, a prompt **file** the CLI itself reads, or `argv` —
  and `buildInvocation()` returns the prompt payload on that channel instead of always appending it
  to `args`.
- `runCapped()` gains a stdin-payload seam: when an invocation carries a stdin prompt, the child is
  spawned with a writable stdin pipe and the payload is written and the stream closed. When there is
  no stdin payload, stdin stays `"ignore"` exactly as today.
- Built-in adapters move to a channel **verified against that CLI's own documented interface**, not
  guessed:
  - `claude` — prompt via stdin, positional dropped (`claude --print --output-format text` with the
    prompt piped in is confirmed working locally).
  - `codex` — prompt via stdin using the documented `-` sentinel (`codex exec --help`: "If not
    provided as an argument (or if `-` is used), instructions are read from stdin").
  - `grok` — prompt via `--prompt-file <PATH>` (documented in `grok --help`).
  - `pi` and `opencode` — the channel is set from each CLI's own help/docs at implementation time;
    if neither CLI documents a stdin or file channel, that adapter keeps `argv` and is protected by
    the oversize guard below, and the limitation is recorded.
- A **hard oversize guard** covers every remaining `argv` delivery, including the user-configured
  custom reviewer CLI (`review_harness`, #40): a prompt whose UTF-8 byte length would exceed
  `MAX_ARG_STRLEN` is **never spawned**. The pipeline fails fast with a specific, named, actionable
  failure that identifies the argv limit, the measured prompt size, and the remedy — never a bare
  `exit -1` that reads as transient.
- The custom reviewer CLI gains an explicit, opt-in prompt-delivery setting so an operator whose CLI
  reads stdin can select that channel. The default preserves today's `<cmd> <prompt>` shape
  byte-for-byte for prompts under the limit.
- The existing golden-argv regression tests are updated to pin the *new* argv shapes plus the
  channel each adapter declares; a new regression test drives a >131,072-character prompt through
  the deps seam and asserts (a) the prompt is delivered intact and (b) no single argv element
  exceeds the limit.

Non-goals: shrinking or truncating prompts, changing prompt content or the diff/digest assembly,
changing verdict parsing, changing which stages run, or adding retry/backoff behavior. This change
alters only *how the prompt bytes reach the CLI*.

## Impact

- Affected specs: `cli-harness-adapters`, `configurable-review-harness`.
- Affected code: `core/scripts/harness.ts` (`invoke`, `runCapped`),
  `core/scripts/harness-adapters/*` (`types.ts`, `claude.ts`, `codex.ts`, `grok.ts`, `pi.ts`,
  `opencode.ts`), plus the regenerated `plugin/` mirror.
- Risk: prompt content is unchanged and every prompt-bearing spawn goes through the single
  `invoke()` choke point, so the blast radius is one function plus five adapters. The main behavioral
  risk is a CLI that behaves differently with an open stdin pipe than with closed stdin; the guard
  is that stdin is only piped when a stdin payload exists, and the golden-argv tests pin the rest.

## Acceptance criteria

- [ ] A review prompt of 168,804 characters (the observed #436 / PR #491 review-1 prompt size)
      reaches the reviewer CLI intact and produces a parsed verdict, instead of `exit -1`.
- [ ] For every prompt-bearing invocation the pipeline constructs, no single argv element exceeds
      131,072 bytes, at any prompt size.
- [ ] `claude`, `codex`, `grok`, `pi`, and `opencode` invocations each declare a prompt-delivery
      channel derived from that CLI's own documented interface, recorded in `design.md`.
- [ ] For prompts under the limit, the CLI executed, its flags, its working directory, its telemetry
      mode, and the parsing of its stdout verdict are unchanged — pinned by the golden-argv tests
      (only the prompt's position/channel moves).
- [ ] A regression test drives a >131,072-character prompt through the deps/spawn seam and asserts
      the delivered payload equals the prompt and every argv element is under the limit; the test
      fails against the pre-change adapters.
- [ ] An `argv`-delivery target given an oversize prompt is never spawned; the pipeline reports a
      named failure naming the argv limit, the measured prompt byte size, and the delivery-mode
      remedy, and that failure is distinguishable from a transient spawn error.
- [ ] The custom reviewer CLI (`review_harness`) supports an explicit stdin delivery selection, and
      its default invocation shape for a small prompt is byte-for-byte what it is today.
- [ ] `npm run ci` is green from the repo root, including the `plugin/` mirror check.
- [ ] #436 is resumed after the fix and its review-1 round completes a real review (verdict
      recorded), demonstrating the fix on the originally failing input.
