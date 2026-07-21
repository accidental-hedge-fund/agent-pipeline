## 1. Verify the external interfaces (no guessing)

- [x] 1.1 Confirm `claude --print` reads the prompt from stdin when no positional is given (already
      verified locally; re-confirm on the target CLI version).
- [x] 1.2 Confirm `codex exec -` reads instructions from stdin (`codex exec --help`).
- [x] 1.3 Read `grok --help` for `--prompt-file <PATH>` semantics (path handling, encoding).
- [x] 1.4 Read `pi --help` and `opencode run --help` for a stdin or prompt-file channel; record the
      finding (including "none documented") in `design.md`.

## 2. Contract

- [x] 2.1 Add the prompt-delivery channel to `AdapterInvocation` in
      `core/scripts/harness-adapters/types.ts` (`argv` | `stdin` | `file`, with the payload).
- [x] 2.2 Define the `MAX_ARG_STRLEN` constant (131,072 bytes) in one place and export it for the
      guard and its tests.

## 3. Runner

- [x] 3.1 Extend `runCapped()` in `core/scripts/harness.ts` to accept an optional stdin payload;
      spawn with `stdio[0] = "pipe"` only when a payload exists, write it, and end the stream.
      Attach stdout/stderr readers before writing.
- [x] 3.2 Report a stdin write/`EPIPE` failure as a diagnostic in the result's stderr; never let it
      masquerade as a gate or verdict outcome.
- [x] 3.3 Add the pre-spawn oversize guard: refuse (do not spawn) when any argv element exceeds the
      limit, resolving a named, non-transient failure carrying the limit, the measured size, and the
      remedy.
- [x] 3.4 Materialize and clean up the `file`-channel prompt file under the managed worktree root,
      removing exactly the file the pipeline created.

## 4. Adapters

- [x] 4.1 `claude.ts` — drop the prompt positional, declare the stdin channel.
- [x] 4.2 `codex.ts` — replace the prompt positional with the `-` sentinel, declare the stdin channel.
- [x] 4.3 `grok.ts` — replace the `--single <PROMPT>` positional with `--prompt-file`, declare the
      file channel.
- [x] 4.4 `pi.ts` and `opencode.ts` — apply the channel found in 1.4, or declare `argv` explicitly
      when the CLI documents no alternative.
- [x] 4.5 `invoke()` — pass the adapter-declared channel through to `runCapped`; keep the call site
      free of harness-name branching.

## 5. Custom reviewer CLI

- [x] 5.1 Add the optional prompt-delivery selection for `review_harness` in `config.ts` (default:
      positional) and thread it into the unregistered-harness path of `invoke()`.
- [x] 5.2 Ensure the oversize refusal message names this setting as the remedy.
- [x] 5.3 Document the setting alongside the existing `review_harness` documentation.

## 6. Tests

- [x] 6.1 Update the golden-argv regression test to pin the new argv shapes **and** the declared
      channel for every adapter and option variant.
- [x] 6.2 Add a regression test driving a >131,072-character prompt through the spawn seam:
      the delivered payload equals the prompt, and every argv element is under the limit. Prove it
      fails against the pre-change adapters.
- [x] 6.3 Add a test that a small-prompt invocation is byte-for-byte unchanged apart from prompt
      delivery, including the custom reviewer default shape.
- [x] 6.4 Add a test for the oversize-argv refusal: no spawn, named failure, distinguishable from a
      missing-CLI spawn error.
- [x] 6.5 Add a test that stdin stays `"ignore"` when there is no stdin payload.

## 7. Ship

- [x] 7.1 `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [x] 7.2 `npm run ci` green from the repo root.
- [ ] 7.3 Resume #436 and confirm its review-1 round completes a real review with a recorded verdict.
