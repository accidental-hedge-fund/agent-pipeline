## Context

`verifyPlanRevisionOutput` (`core/scripts/verify-harness-commits.ts`) is a pure
text-shape gate over untrusted plan-revision stdout. After fence-delimiter
neutralisation it still locates headers with:

```ts
/^##\s+Feedback\s+Incorporated\b/gim
```

That requires the `##` to sit at **line start**. Observed Grok implementer output
(issue #622 run, engine with `implementer: grok`) glues the header onto the end of
preamble prose:

```text
…matches the real code and the reviewer's required changes.## Feedback Incorporated

- [ADDRESSED] Preflight all reclaim candidates before any removal …
```

The section body is fully tagged and semantically correct, but header detection
returns zero matches → `"Plan revision output is missing required ## Feedback
Incorporated section"`. `planning.ts` then:

```ts
setBlocked(cfg, issueNumber, ackCheck.reason, "plan-review", "needs-human")
```

so the advance parks for human intervention with **no** in-stage format retry.
Harness process failure (non-zero exit / timeout) already uses
`blockerKind: "harness-failure"`; only the shape gate takes the `needs-human` path.

Prior art: #68 (ack contract), plan-revision-fenced-section-tolerance (#443) —
defence in depth of **prompt wording + tolerant verifier**. This change continues
that pattern for mid-line headers and adds a **bounded format-repair retry** so
remaining pure shape failures do not immediately escalate to human.

## Goals / Non-Goals

- **Goal**: no false block when the model produced a real acknowledgement whose
  only defect is header placement (mid-line / preamble-glued).
- **Goal**: pure output-contract failures get at least one automatic format-repair
  attempt before a terminal block.
- **Goal**: preserve true negatives — no section, or section with no tagged items.
- **Non-goal**: full Markdown AST parsing.
- **Non-goal**: changing plan-review verdict schema, coverage-warning semantics,
  or inventing a new `harness-format-failure` blocker kind.
- **Non-goal**: multi-harness eval matrix beyond the ack contract.
- **Non-goal**: fixing unrelated human-feedback ack (`HUMAN_FEEDBACK_ACK_HEADER`)
  disposition — only the machine-checkable `## Feedback Incorporated` path.

## Decisions

### Decision: Normalize mid-line headers in the verifier (primary fix)

Before header matching, rewrite occurrences of `## Feedback Incorporated` that
are not already at line start so they become line-start headers. Concretely:
insert a newline before a mid-line `## Feedback Incorporated` token (case-
insensitive word-boundary match consistent with today's header regex), then run
the existing multi-header / fence-tolerant extraction unchanged.

- **Why normalize rather than only loosen the regex?** A non-anchored search would
  still need section-boundary logic and risks matching inside unrelated prose in
  subtler ways. Promoting the header to a real line-start keeps the rest of the
  gate (section slice to next `^##`, line-anchored tags, max coverage count)
  intact and reuses all prior fenced-header work.
- **Why not require models to be perfect?** The product goal is autonomy across
  configured implementers; Claude happens to line-start the header more often.
  Cross-harness parity is pipeline-owned.
- Cost: a mid-sentence mention of the exact phrase `## Feedback Incorporated`
  could be promoted to a section. Accepted — that phrase is the contract marker,
  not natural prose, and tagged items still must appear under a candidate section.

### Decision: Bounded in-stage format-repair retry (secondary fix)

When `verifyPlanRevisionOutput` still returns `ok: false` after the (possibly
already-revised) stdout is checked, the planning phase runner SHALL **not**
immediately `setBlocked(..., "needs-human")`. It SHALL perform **at least one**
additional harness invocation with a short format-repair addendum that states:

- emit `## Feedback Incorporated` exactly once as a **line-start** level-2 heading;
- list each feedback item as a line-start `- [ADDRESSED]` or `- [DEFERRED]` bullet;
- do not glue the header to preamble text or wrap it only inside a fence.

Retry budget for this path is **one** automatic re-prompt by default (total of two
verification attempts: original + one repair). Cap is intentionally small: the
primary fix should clear the common Grok shape without burning a full revision
round; the retry is a safety net for residual messiness.

On retry **success**, proceed as today (post revised plan, continue). On
exhaustion, block without posting the revised plan.

### Decision: Exhausted format retries stay `needs-human` (not a new class)

After the format-retry budget is spent, keep `blockerKind: "needs-human"` (and the
same human-facing reason strings where applicable).

- **Why not `harness-failure`?** Auto-loop treats `harness-failure` as recoverable
  and could re-dispatch the whole planning stage into the same format trap without
  a focused repair prompt, burning loop budget. `needs-human` after in-stage
  retries already exhausted is the correct terminal for an advance attempt.
- **Why not a new `harness-format-failure` class?** Extra taxonomy without loop-
  policy benefit for this single gate. Revisit only if multiple stages need a
  shared format-retry class later.
- **Paired freeform / OpenSpec paths**: both routes share `runPlanningPhases`;
  disposition must remain equivalent across hooks (existing
  `unified-planning-phase-runner` paired-blocker requirement).

### Decision: Strengthen the prompt contract for line-start headers

Update `plan_revision.md` (and its drift guard) so the template states that the
`## Feedback Incorporated` header MUST appear at the **start of a line** (in
addition to “exactly once” and “not inside a code fence”). Defence in depth: good
default for all implementers; verifier still accepts mid-line so a slip is not a
hard block.

### Decision: Pure function stays pure; retry lives in the stage

`verifyPlanRevisionOutput` remains a pure function of stdout (+ optional feedback).
Retry orchestration lives in the planning stage / phase runner so unit tests can
fake `invoke` / `invokeRevision` without network. Do not fold retry into the
verifier.

## Risks / Trade-offs

- **Risk**: over-accepting a revision that only quotes the section title mid-prose
  without real disposition. Mitigated by still requiring line-start tagged items
  under a candidate section, and by the subsequent plan quality path (posted
  revised plan is human- and later-stage visible). Shape gate has never been
  semantic.
- **Risk**: format-repair retry doubles harness cost on rare residual failures.
  Accepted — cheaper than operator unblock latency; budget is one retry.
- **Risk**: repair invocation might rewrite more of the plan than the header.
  Acceptable: plan-revision is already allowed to revise the plan; the addendum
  should ask for format correction of the acknowledgement section without
  discarding addressed content. Surgical wording in the addendum, not a second
  full redesign prompt.
- **Risk**: mid-line normalization changes section boundaries for pathological
  multi-header outputs. Existing “any section with tagged items wins” rule
  remains the safety net.

## Migration Plan

Behavioural widening of the gate + optional one-shot retry on failure. No config
keys, no stored artifact shape changes, no label renames. In-flight runs pick up
the new behaviour on the next plan-revision verification after upgrade.

## Open Questions

_Resolved in this design:_

1. **Normalize only vs also auto-retry?** Both: normalize first (fixes the repro
   without a second harness call); one format-repair retry for residual pure
   contract failures.
2. **Exhausted format retries: `needs-human` or new class?** Stay `needs-human`
   after in-stage budget exhaustion; do not add `harness-format-failure` here.
