You are updating documentation for a merge-ready PR in {{domain_name}}, {{domain_description}}.

## Issue #{{issue_number}}: {{title}}

## Your Task

Review the diff below and update any documentation that is now stale or incomplete. ONLY touch docs — do not modify any code.

### Files to check and update if needed:
1. **README.md** — update if user-visible setup, workflows, features, or operations changed
2. **CLAUDE.md** — update if the change affects conventions that agents need to know
3. **Issue/ops docs or runbooks** — update any repo-local operational docs touched by the change
4. **Docstrings/comments in changed docs-adjacent files** — only if they are now inaccurate
5. **Environment/config examples** — update if new required env vars, flags, or setup steps were introduced

### Rules:
- If no docs need updating, do nothing and create no docs commit.
- Do NOT modify application code, tests, or configs unless the file is itself documentation/config-example text.
- Do NOT add unnecessary boilerplate docs.
- Keep updates minimal and accurate.
- Do not commit — the pipeline commits documentation changes with the required traceability trailers.

## Diff to Review

```diff
{{diff}}
```
