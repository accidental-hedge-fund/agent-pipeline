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

For **worktree deletion and removal** (`git worktree remove --force`, any worktree deletion):
1. The operation MUST be scoped to the **managed worktree root** only. The `reviewed head` alternative does NOT apply — a git commit reference is not a filesystem boundary and cannot constrain which directories are deleted.
2. Confirm the managed-root path explicitly in your output before committing.
3. If the fix cannot remain scoped to the managed worktree root, stop and surface a blocker — do not proceed.

For **force push and merge-surface operations** (`git push --force`, `git push --force-with-lease`, merge operations):
1. Confirm the operation is scoped to the **managed worktree root** or the **reviewed head** — not the broader repo or remote.
2. If the correct fix genuinely requires widening the blast radius beyond these constraints, state an explicit written justification before committing.

A fix may NOT widen the blast radius of a destructive path while resolving an unrelated finding.

## Pre-Commit Self-Check (required)

Before committing or pushing:
1. Review your own diff against the findings you were given.
2. If any change in your diff appears to introduce a problem of **higher severity** than the finding it resolves — surface the concern in your output and **do NOT push**.
3. Conservative-open: when in doubt whether a new issue is higher severity, call it out and withhold the push rather than silently proceeding.

This self-check is a targeted scan of your own changes against the findings you were given — it is not a full re-review (the SHA-gate re-review handles that on push).

## Injectable-Dep Rule (required)

Any code path you add or modify that calls an external CLI or API (`gh`, `git`, network, auth) MUST go through an injectable dep — never call the module-level function directly when a seam already exists on the `Deps` type. If no seam exists, add one. Tests that only pass because local auth is active are NOT passing tests — they will fail in CI. Every new or modified test must cover the unauthenticated/no-network path and prove it fails without the injected fake.

## Does-Not-Reproduce Outcome (if applicable)

If an assigned blocking finding does NOT reproduce at the reviewed SHA `{{reviewed_sha}}` — for example it is a tooling artifact, a false positive, or the condition it describes does not exist in the code — do NOT silently skip it, and do NOT commit a no-op change to work around it. Instead, declare it using the finding's `override-key` AND its `finding-fingerprint` (both shown above each finding — the fingerprint is the hidden `<!-- finding-fingerprint: ... -->` marker) by emitting exactly one line per non-reproducing finding, formatted precisely as:

    <!-- pipeline-does-not-reproduce: <override-key> <finding-fingerprint> {{reviewed_sha}} | <one-line justification> -->

Rules for this declaration:
- The `finding-fingerprint` MUST be copied verbatim from the marker shown directly above the finding you are declaring non-reproducing — never guessed or reused from a different finding. The same `override-key` can be shared by more than one finding in this review; the fingerprint is what identifies which one you mean.
- The reviewed SHA in the declaration MUST be exactly `{{reviewed_sha}}` — a declaration against any other SHA is ignored.
- The justification MUST be a single line (no line breaks) explaining why the finding does not reproduce.
- Emit one declaration per non-reproducing finding. You may still commit fixes for the other assigned findings in the same round.
- This is a distinct, sanctioned outcome from silently making no change — the pipeline recognizes a valid declaration and does NOT treat it as a failed fix round.

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
