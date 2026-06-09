## Context

The pipeline instructs harnesses (Claude Code, Codex) at ten steps. Each step builds its prompt from a template, spawns the harness, and currently verifies only coarse signals: exit code, and whether any commits appeared on the branch. Fine-grained invariants that the prompt explicitly prescribes — specific commit message format, issue reference presence, docs-only file scope, acknowledgement sections — are trusted to the harness rather than verified. This design captures how to add mechanical verification consistently, using the pattern already established by PR #66 (commit trailers on test-fix) and PR #67 (acknowledgement section on plan-revision) as the authoritative model.

## Goals / Non-Goals

**Goals:**
- Define a consistent "capture-then-verify" helper that each harness-instruction step calls after the harness returns.
- Enumerate per-step invariants (see spec) and specify block-on-violation semantics for each.
- Ensure the two existing pointwise verifications are expressed through or consistent with the helper — no duplication, no regression.
- Cover the audit output in the PR so there are no silent gaps.

**Non-Goals:**
- Retrying the harness on mechanical invariant violations — one chance per step is sufficient; retry loops are reserved for the test-fix gate which already has bounded retry semantics.
- Verifying judgmental properties (code quality, design soundness) — those belong to review rounds.
- Changing what the prompts ask for — this design only verifies compliance with existing asks.

## Decisions

### Decision 1: Shared `verifyHarnessCommits` helper, not per-step inline logic

Each step that produces commits will call a shared helper with a typed config describing what to check (expected message pattern, required trailers, etc.). The helper inspects `git log headBefore..HEAD` and throws a structured `HarnessViolation` on mismatch.

**Why over duplicating per-step**: three steps need commit-message format verification; a shared helper prevents three slightly-different implementations of the same regex/git-log logic, and gives one place to add future invariants.

### Decision 2: Block, don't retry, on mechanical invariant violations

When a mechanical invariant fails (wrong commit message, non-doc files in docs-update, no acknowledgement section), the step blocks with a descriptive reason and does not re-invoke the harness.

**Why**: these are format/structure checks the harness had explicit instructions to satisfy. A re-invoke risks producing the same violation a second time and burning pipeline credits without improving signal. The test-fix loop already has a bounded retry design for a different reason (test commands are environment-sensitive); mechanical format checks are not.

### Decision 3: Docs-only constraint uses git diff --name-only against a deny-list of non-doc patterns

The docs-update step verifies the set of modified files contains no paths matching application code patterns (`src/`, `core/`, `plugin/`, `*.ts`, `*.js`, `*.json` outside of examples/config-docs). A small allowlist of doc-adjacent patterns (`*.md`, `*.txt`, docs config examples) defines the permitted set.

**Why a deny-list over an allowlist**: the docs-update prompt already enumerates a specific allowlist of things to check (README, CLAUDE.md, runbooks, docstrings). A deny-list of obviously non-doc patterns is more robust to new doc file types being added, and avoids false-block on legitimate new documentation formats.

**Alternative considered**: shallow file-extension allowlist (`*.md` only). Rejected — the prompt explicitly covers CLAUDE.md, docstrings in docs-adjacent files, and config examples, all of which may have non-md extensions.

### Decision 4: Plan-revision acknowledgement uses a structured marker in the harness output, not LLM-judged prose

The plan-revision prompt is updated (as part of this change) to require the harness to emit a machine-readable acknowledgement block of the form:

```
## Feedback Incorporated
- [ADDRESSED] <brief description>
- [DEFERRED] <brief description> — reason: <reason>
```

The verification regex checks for the presence of `## Feedback Incorporated` followed by at least one `[ADDRESSED]` or `[DEFERRED]` line. Any output lacking this section is blocked.

**Why structured over prose-judged**: LLM-judged prose acknowledgement would require a second harness call just to evaluate compliance — defeating the purpose. A structured marker is machine-parseable with a single regex, consistent with how review SHA sentinels and verdict JSON work.

### Decision 5: Audit table is committed as a comment in `tasks/lessons.md` (or a dedicated `docs/harness-audit.md`)

The issue requires the audit's covered-vs-deferred list to be stated in the PR. This design places it in `docs/harness-audit.md` in the repo so it is reviewable and update-able as new steps are added.

## Risks / Trade-offs

- **False block if harness uses different casing/punctuation in commit message** → Mitigation: use a loose regex (case-insensitive, anchor on key tokens) rather than exact string match. Document the allowed variance in the spec.
- **Docs-only deny-list may need updates as repo structure evolves** → Mitigation: the deny-list is configurable via pipeline config (`cfg.docs_deny_patterns`), with a safe default. Document in CLAUDE.md.
- **Plan-revision marker requirement changes prompts.md** → Mitigation: this is explicitly in-scope (the prompt is updated to ask for the marker; the verification checks for it). Not a scope creep: the issue says "fixing the gap" includes making the prompt ask for something checkable.

## Open Questions

- Should `headBefore` capture be refactored into a shared pre-harness hook, or remain a local `const headBefore = await gitHead(wt.path)` in each step? (Implementation detail; either is acceptable — consistency matters more than centralization here.)
- Does the docs-only deny-list need to cover generated files (`.lock`, `.snap`) or is that covered by the existing "no application code" check? To be resolved during implementation.
