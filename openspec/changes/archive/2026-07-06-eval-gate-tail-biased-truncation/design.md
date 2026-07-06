## Context

`truncate(s, cap)` in `core/scripts/stages/eval.ts` is head-biased:

```ts
function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + "\n\n[…output truncated]";
}
```

Five call sites use it against `MAX_COMMENT_OUTPUT = 2000`: the shared excerpt (line 242,
reused on the pass path and the gate-fail block message), the timeout block message
(line 275), the spawn-error block message (line 288), and the gate-fail message (line 310).
The advisory path reuses the shared `excerpt`. So there is really one helper to change.

## Goals

- Surface the end-of-run summary (tail) that eval harnesses print last.
- Keep the command/setup context (head) so the reader knows what ran.
- Make the excerpt visibly non-contiguous when middle content is dropped.
- Keep the 2000-char budget and all comment/branch structure unchanged.

## Decision: head + tail elision, not tail-only

The issue offers two options — tail-only, or head + tail with a middle-elision marker. We
choose **head + tail**. Tail-only would drop the command-invocation context that operators
use to reproduce the run; the timeout/spawn-error paths in particular benefit from seeing
the early lines (what command, what setup failed) as well as the final error. Head + tail
satisfies the tail requirement (summary preserved) while also keeping reproduction context,
and it strictly dominates tail-only for the same character budget.

### Budget split

Reserve the `cap` for source characters, split between head and tail. A tail-weighted split
(summaries are the priority) — e.g. ~1/3 head, ~2/3 tail — keeps meaningful setup context
while giving the summary the larger share. The exact ratio is an implementation detail and
is not fixed by the spec; the spec only requires that both a head portion and the final tail
portion are present. The elision marker (`[… N characters truncated …]`) is additional to the
source-character budget so the budget is spent on real output, not marker text.

### Boundary behavior

- `s.length <= cap`: return `s` unchanged, no marker (preserves today's within-limit path).
- `s.length > cap`: return `head_slice + "\n\n[… N characters truncated …]\n\n" + tail_slice`
  where `N = s.length - (head_len + tail_len)` and `head_len + tail_len === cap`.
- Guard the degenerate case where head + tail would overlap (only possible if `cap >=
  s.length`, already handled by the first branch), so no character is shown twice.

## Alternatives considered

- **Tail-only (`s.slice(-cap)`)**: simplest, satisfies the primary acceptance criterion, but
  loses reproduction context. Rejected in favor of head + tail, which costs a few lines and
  keeps both ends.
- **Parsing the output to find the summary block**: explicitly out of scope (issue #373) and
  fragile across heterogeneous eval harnesses. Rejected.
- **Raising the 2000 cap / linking full output externally**: out of scope per the issue.

## Test strategy

Unit-test the helper directly (it is pure, no I/O seam needed):

- Long input with a unique sentinel only in the final characters → sentinel present in output.
- Long input → output contains both a head fragment and the tail fragment and the elision
  marker between them; total source characters shown ≤ cap.
- Input length ≤ cap → returned verbatim, no marker.
- Prove the test bites: it fails against the current `slice(0, cap)` implementation.
