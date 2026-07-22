## Context

`verifyPlanRevisionOutput` is a text-shape gate over untrusted model output. Its current
extraction is: first header match → slice to the next `^##` line → scan for `^[\s>*_-]*\[(ADDRESSED|DEFERRED)\]`.
Every assumption in that chain is violated by the fenced-example echo shape described in #443.

## Goals / Non-Goals

- **Goal**: no false block on a plan revision that genuinely acknowledges the feedback, whatever
  Markdown wrapper the model chose.
- **Goal**: preserve the true negatives — an omitted section, or a section with no tagged items,
  must still stop the pipeline. This gate exists because plan revisions used to silently skip
  reviewer feedback; loosening it into "any `[ADDRESSED]` anywhere in stdout" would forfeit that.
- **Non-goal**: full Markdown parsing. The pipeline has no Markdown AST dependency and should not
  gain one for a shape check.
- **Non-goal**: changing what the acknowledgement means, its coverage semantics, or the advisory
  (non-blocking) nature of the coverage shortfall warning (that was a deliberate earlier decision).

## Decisions

### Decision: Neutralise fence delimiters rather than skip fenced content

Fenced regions are *stripped of their delimiter lines* (` ``` ` / `~~~` fences) before section
extraction, keeping their content in place.

- **Why not "ignore everything inside fences"?** That is the intuitive reading of "fences are not
  content", but it is exactly backwards here: in the observed failure the *real* acknowledgement
  lives inside the fence. Ignoring fenced content would turn a false block into a different false
  block.
- **Why not parse Markdown properly?** The only thing at stake is whether a line starts with a
  tag, and dropping delimiter lines is enough to recover that. No new dependency.
- Cost: a genuinely illustrative fenced example inside the section would now count as real items.
  Accepted — the prompt no longer offers such an example to copy, and the alternative failure
  (block a correct revision) is far more expensive than the alternative (accept a revision whose
  acknowledgement was an example).

### Decision: Consider every header occurrence, not just the first

The header regex is scanned globally; each occurrence yields a candidate section (to the next
`^##` after it, over the fence-neutralised text). The gate passes if **any** candidate section
contains at least one tagged item.

- Handles the duplicated-header shape directly, and is robust to a revised plan that legitimately
  re-states the header later.
- Anchoring stays per-section, so a stray `[ADDRESSED]` in prose elsewhere in the plan still does
  not satisfy the gate.

### Decision: Coverage count is the max over sections, not the sum

The advisory coverage warning uses the **greatest** tagged-item count found in any single
candidate section.

- With a duplicated header the same bullets are reachable from two headers; summing would report
  double the real count and make the shortfall warning meaningless (or wrongly suppress it).
- Max is the right aggregate for the question the warning asks — "did the revision acknowledge
  enough items?" — since the sections are duplicates, not partitions.

### Decision: Fix the prompt too, even though the validator now tolerates the shape

Defence in depth, and they fail differently: the prompt change makes the good shape the default
(cheaper, cleaner issue comments), the validator change makes the bad shape harmless. Shipping
only the prompt half would leave the block one model-compliance slip away — which is precisely
what the host-local hot-patch demonstrated when auto-update reverted it.

The prompt keeps an illustrative example, but as plain indented Markdown lines rather than a
fenced block, plus two explicit constraints: not fenced, header exactly once.

## Risks / Trade-offs

- **Risk**: a revision that only *quotes* the prompt's example (no real content) now passes the
  shape gate. Mitigated by the plan review that follows — the gate has always been a shape check,
  never a semantic one — and by removing the fenced example the model would be quoting.
- **Risk**: unbalanced fences (an opening ` ``` ` with no closer) after delimiter stripping. Since
  delimiters are removed line-wise rather than paired into regions, an unbalanced fence degrades
  to plain text, which is the tolerant direction.

## Migration Plan

Pure behavioural widening of an existing gate plus prompt wording; no config keys, no state, no
stored artifacts change shape. Runs in flight at upgrade time are unaffected — the next
plan-revision verification simply becomes more tolerant.

## Open Questions

_None._
