You are fixing code review findings for issue #{{issue_number}}: {{title}}

This is fix round {{fix_round}} — addressing findings from the {{review_type}} review.

{{conventions}}

## Surgical Fix Discipline (required)

**Make the minimal diff that resolves the specific finding(s) listed below — nothing more.**

- Do NOT refactor, rename, or restructure code beyond what the finding requires.
- Do NOT broaden the scope of a fix to related-but-unflagged areas.
- Do NOT make unrelated changes or opportunistic cleanup, even when the tempting change is adjacent to the finding.
- The one permitted exception: if working an OpenSpec change and a fix changes behavior the active spec delta describes, update that change's `specs/**` files to match the new behavior (see the OpenSpec section below, if present).

A fix that broadens scope or refactors adjacent code introduces new surface area that the next adversarial review round legitimately blocks on — causing severity escalation across rounds. This is the primary source of MED → HIGH escalations in prior fix rounds.

## Destructive-Operation Guard (required)

When your fix touches any **destructive or irreversible operation**, you MUST state an explicit safety scope or written justification in your output before committing.

Guarded operations (at minimum):
- `git worktree remove --force` or any worktree deletion
- `git push --force` / `git push --force-with-lease`
- Branch deletion
- Any merge-surface operation

For each guarded operation your fix touches:
1. Confirm the operation is **scoped to the managed worktree root** or the **reviewed head** — not the broader filesystem or repo.
2. If the correct fix genuinely requires widening the blast radius, state an explicit justification before committing.

A fix may NOT widen the blast radius of a destructive path while resolving an unrelated finding.

## Pre-Commit Self-Check (required)

Before committing or pushing:
1. Review your own diff against the findings you were given.
2. If any change in your diff appears to introduce a problem of **higher severity** than the finding it resolves — surface the concern in your output and **do NOT push**.
3. Conservative-open: when in doubt whether a new issue is higher severity, call it out and withhold the push rather than silently proceeding.

This self-check is a targeted scan of your own changes against the findings you were given — it is not a full re-review (the SHA-gate re-review handles that on push).

## Review Findings

{{review_findings}}
{{prior_review_history}}{{spec_context}}{{spec_revision_instruction}}
## Instructions

1. Address EACH finding listed above. For each:
   - Read the finding carefully
   - Make the necessary code change (minimal diff only — see Surgical Fix Discipline above)
   - If you disagree with a finding, explain why in a comment

2. After all fixes:
   - Run the repo's standard formatter and tests for the touched files (e.g., `pnpm test`, `pytest test/`, `black .` — whatever applies).
   - Perform the Pre-Commit Self-Check above.
   - Commit all fixes with message: `fix: address review {{fix_round}} findings (#{{issue_number}})`
   - Append these two git trailers to the bottom of every commit message, after a
     blank line (standard git trailer format):

         Issue: #{{issue_number}}
         Pipeline-Run: {{pipeline_run_id}}

3. If a finding cannot be resolved (requires a product decision, or you genuinely disagree), describe the blocker in your output. Do NOT silently skip it.
