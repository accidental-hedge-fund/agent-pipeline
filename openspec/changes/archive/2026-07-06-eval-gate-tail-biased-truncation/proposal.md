## Why

When the eval gate blocks (or records an advisory failure), it posts the eval command's
combined stdout/stderr to the issue, truncated to `MAX_COMMENT_OUTPUT` (2000) characters.
The truncation keeps the **head** of the output (`eval.ts:414-416` → `s.slice(0, cap)`).

Eval harnesses almost universally print setup and per-case noise first and the pass/fail
**summary** — total tests, which suites regressed, overall score — at the **end**. Keeping
the head therefore shows boilerplate and drops the one part that tells the operator what
actually regressed. The operator has to re-run the eval harness by hand just to see the
diagnostic the pipeline already captured. This defeats the purpose of posting the output.

All four failure paths (gate failure, advisory failure, timeout, spawn/runner error) call
the same `truncate()` and share the defect.

## What Changes

- Change the excerpting strategy in `eval.ts` so that when output exceeds the cap, the
  comment preserves the **tail** of the output (where summaries live) instead of the head.
- Preserve enough of the **head** to keep the command-invocation context (what was run,
  early setup lines) by emitting a head excerpt **and** a tail excerpt separated by an
  explicit middle-elision marker that states how many characters were dropped.
- Apply the identical strategy to all four failure paths and to the pass-path excerpt, so
  truncation direction is uniform regardless of mode or failure kind.
- Leave the 2000-character budget, the comment structure, and within-limit output unchanged.

## Impact

- `core/scripts/stages/eval.ts` — replace the head-biased `truncate()` with a head+tail
  elision helper; call sites at the four failure paths and the pass excerpt are unchanged
  except that they call the new helper.
- `core/test/` — new regression test proving the summary tail survives truncation and that
  within-limit output is emitted verbatim.
- `plugin/` mirror regenerated via `node scripts/build.mjs`.
- Affected capability: `eval-gate` (the "eval outcome is recorded … as a comment"
  requirement's excerpt wording is refined; no state-machine, config, or schema change).

## Acceptance Criteria

- [ ] When eval output exceeds `MAX_COMMENT_OUTPUT`, the posted excerpt contains the final
      characters (tail) of the output, so an end-of-run summary line is present in the comment.
- [ ] The excerpt also contains a leading head portion (command/setup context) followed by an
      explicit middle-elision marker indicating the beginning-to-middle was truncated.
- [ ] The elision marker states, or makes unambiguous, that content was dropped (e.g. a
      character count), so the reader knows the excerpt is not contiguous.
- [ ] The excerpt never exceeds `MAX_COMMENT_OUTPUT` characters of source output (marker text
      excluded from the budget count of source characters).
- [ ] The tail-biased behavior is identical across all four failure paths: gate-mode failure,
      advisory-mode failure, timeout, and spawn/runner error.
- [ ] When output length is ≤ `MAX_COMMENT_OUTPUT`, the excerpt equals the output verbatim with
      no marker added (behavior unchanged from today).
- [ ] A regression test fails against the current head-only `slice(0, cap)` and passes with the
      new helper.
