## Context

The planning harness invokes `claude --print --permission-mode bypassPermissions`, which grants full local filesystem read access. The gap is not capability — it is instruction. Nothing in `planning.md` tells the harness to use that access to read the actual codebase before drafting. A prompt-only fix is the minimal, lowest-risk change.

## Goals / Non-Goals

**Goals**
- The planning harness reads relevant files before drafting (grounded in actual repo patterns, not just the conventions excerpt).
- Every plan includes an explicit `### Acceptance criteria` section with checkable items that state the observable outcomes needed for the issue to be done.
- No extra harness calls, no new configuration keys, no fan-out.

**Non-Goals**
- Prior-plan / accumulated-findings mining (#19-dependent). Deferred until #19 lands.
- Parallel research-agent fan-out (rejected by maintainer in the simplification audit 2026-06-10).
- Acceptance-criteria enforcement at later stages (that is the eval-gate's role, #12).

## Decisions

**Decision: prompt-only change, no code.**
The harness already has `bypassPermissions` access. Adding a research instruction to the prompt is sufficient and is the minimum viable change. Any harness-level scaffolding (explicit file injection, structured research calls) is over-engineering for the problem.

**Decision: single mandatory pre-draft block, not a separate phase.**
The maintainer decision (2026-06-10) explicitly rejects a parallel research-agent fan-out or an extra pre-planning call. The instruction is a single "before you draft, read …" paragraph prepended to the task section. The harness decides which files to read; the prompt provides the mandate, not the file list.

**Decision: `### Acceptance criteria` is a required section in the output format.**
Adding it to the prompt template's output schema (alongside the existing sections) is the lowest-friction way to make the absence visible at plan-review time. The reviewer sees a plan with no acceptance criteria and flags it; no new code is needed to enforce the shape.

**Decision: same pattern for OpenSpec mode (`planning_openspec.md`).**
OpenSpec planning emits acceptance criteria inside `proposal.md` anyway. Mirroring the section name makes the two paths consistent; the OpenSpec harness interprets "acceptance criteria" as the proposal's rough criteria block.

**Decision: mirror regeneration required.**
`plugin/` mirrors `core/scripts/prompts/`. Changing `.md` files under `core/scripts/prompts/` requires `node scripts/build.mjs` and a commit of the regenerated mirror. This is standard for any prompt edit (documented in CLAUDE.md rule 1).

## Risks / Trade-offs

- *Harness ignores the research instruction* — the plan-review step (plan-reviewer harness) will flag a plan with no cited patterns or no acceptance criteria as insufficient, causing a revision. This is the natural catch.
- *Over-reading causes latency* — the harness may read more files than necessary. Acceptable: planning latency is dominated by the model call, not file I/O.
- *Acceptance criteria section is vague* — the prompt must give enough structural guidance (checkable items, observable outcomes) to produce actionable criteria, not narrative prose. The instruction text must be specific.
