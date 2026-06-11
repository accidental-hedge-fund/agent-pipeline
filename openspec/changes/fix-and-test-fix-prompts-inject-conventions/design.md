## Context

Every pipeline step that invokes a harness to edit code should be convention-aware. The `implementing` prompt already achieves this via `readConventions(cfg)` → `{{conventions}}`. The `fix` and `test_fix` prompts omit this injection, so conventions reach those steps only through host-specific auto-load (Claude's headless CLAUDE.md pick-up; Codex's `-C <worktreeDir>` flag). The Codex channel is reliable; the Claude-headless channel is not guaranteed. Additionally, `implementing.md` hardcodes "Read CLAUDE.md" on line 15, which is wrong under the Codex profile whose `conventionsDefault` is `AGENTS.md`.

## Goals / Non-Goals

**Goals:**
- `buildFixPrompt` and `buildTestFixPrompt` inject `conventions: readConventions(cfg)` the same way `buildImplementingPrompt` does.
- `fix.md` and `test_fix.md` expose a `{{conventions}}` placeholder at the position where the implementing prompt places it.
- `implementing.md` names both `CLAUDE.md` and `AGENTS.md` (or the generic "conventions file") rather than hardcoding one.
- `hosts/codex/SKILL.md` per-repo-config example references `AGENTS.md` (not `CLAUDE.md`).
- Two regression tests bite without the fix and pass with it.

**Non-Goals:**
- No change to `readConventions` logic, cap (8000 chars), or stub-when-missing behavior.
- No new config key — `conventions_md_path` already exists.
- No change to which harness runs fix rounds (Claude stays the implementer harness under the default profile).
- No change to `buildPlanningPrompt`, `buildReviewPrompt`, or any other builder.

## Decisions

### 1. Mirror implementing.md's injection pattern exactly

The `{{conventions}}` placeholder in `fix.md` and `test_fix.md` goes in the same structural position as in `implementing.md` (near the top, before the task description), so the editing harness always sees conventions before reading the task context.

Alternatives considered:
- Append at the bottom — rejected; conventions guidance reached last is less reliably applied.
- Add a new `readConventionsIfMissing` helper — rejected; `readConventions` already stubs gracefully when the file is absent; no new helper needed.

### 2. Update implementing.md to name both CLAUDE.md and AGENTS.md

Line 15 of `implementing.md` instructs the harness to "Read CLAUDE.md". Under the Codex profile, the conventions file is `AGENTS.md`. The simplest fix is to phrase the instruction as "Read the conventions file (CLAUDE.md or AGENTS.md depending on your host)" — accurate under both profiles without introducing a new placeholder.

### 3. No structural change to the `buildPromptArgs` call shape

The builder functions already accept a `cfg` argument from which `readConventions(cfg)` is called. Adding `conventions` to the map is a one-line change per builder — no signature changes, no new dependencies.

## Risks / Trade-offs

- [Risk] Conventions content adds ~200–8000 chars to every fix and test-fix prompt. → Mitigation: the cap is already enforced by `readConventions`; the 8000-char ceiling is appropriate for providing context without token bloat.
- [Risk] A repo with no conventions file (stub path) injects an empty string. → Mitigation: `readConventions` already returns `""` in that case; the placeholder renders to empty, which is harmless.
