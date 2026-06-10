## Context

`plugin/` is a generated mirror of `core/` (plus `hosts/claude` additions) produced by `node scripts/build.mjs`. When an agent harness edits `core/` without regenerating this mirror, the `build.mjs --check` step in `npm run ci` fails, consuming one of the bounded fix-loop retries on a purely mechanical correction.

The maintainer's decision (2026-06-10) is **zero-machinery**: no new pipeline code, no new config keys, no generator-detection logic. The fix is a plain English instruction in the repo-local context files that LLM harnesses read before acting.

## Goals / Non-Goals

**Goals:**
- Agent harnesses (Claude Code, Codex) read and follow a directive to run `node scripts/build.mjs` and commit `plugin/` immediately after editing any file under `core/`.
- The instruction appears in every context file a harness is likely to read: repo CLAUDE.md, `hosts/claude/SKILL.md`, `hosts/codex/AGENTS.md` (or equivalent).
- The `build.mjs --check` test-gate backstop remains unchanged as the deterministic safety net.

**Non-Goals:**
- Automated generator detection or invocation from pipeline runtime code.
- New `pipeline.json` / `.pipeline.yaml` config keys.
- Any change to `core/scripts/`, `plugin/`, or the test-gate logic.
- Guaranteeing harnesses that ignore context files (not a supported case).

## Decisions

**Decision: Instruction-only (no code machinery)**
The maintainer audited alternative approaches (#61, #75 original spec) and chose documentation over code. The rationale: harnesses already read CLAUDE.md/AGENTS.md before every task; adding a one-sentence instruction is the lowest-risk, most maintainable path. The test gate already provides the deterministic backstop.

**Decision: All three context file locations get the instruction**
Repo CLAUDE.md is the primary contract. `hosts/claude/SKILL.md` is read by the Claude Code harness when the pipeline skill is invoked. `hosts/codex/AGENTS.md` is read by the Codex harness. All three need the directive so no host variant silently loses the hint.

**Decision: Instruction wording includes both run AND commit**
"Run `node scripts/build.mjs` and commit the regenerated `plugin/`" — specifying the commit step prevents a harness from regenerating the mirror but staging it separately from the core change, which would still fail the SHA-gate's clean-tree check.

## Risks / Trade-offs

- [Risk: Harness ignores instruction] The test-gate backstop catches it; the bounded fix loop still self-heals, just at the cost of one attempt as before. → Mitigation: instruction is prominent and specific; backstop unchanged.
- [Risk: Instruction text drifts across files] CLAUDE.md, SKILL.md, AGENTS.md could diverge over time. → Mitigation: spec requirement explicitly requires all three locations; future maintainers see a test failure if the gate fires repeatedly (hint of missing instruction).
