You are fixing code review findings for issue #{{issue_number}}: {{title}}

This is fix round {{fix_round}} — addressing findings from the {{review_type}} review.

## Review Findings

{{review_findings}}
{{prior_review_history}}{{spec_context}}{{spec_revision_instruction}}
## Instructions

1. Address EACH finding listed above. For each:
   - Read the finding carefully
   - Make the necessary code change
   - If you disagree with a finding, explain why in a comment

2. After all fixes:
   - Run the repo's standard formatter and tests for the touched files (e.g., `pnpm test`, `pytest test/`, `black .` — whatever applies).
   - Commit all fixes with message: `fix: address review {{fix_round}} findings (#{{issue_number}})`
   - Append these two git trailers to the bottom of every commit message, after a
     blank line (standard git trailer format):

         Issue: #{{issue_number}}
         Pipeline-Run: {{pipeline_run_id}}

3. Do NOT change anything unrelated to the review findings.

4. If a finding cannot be resolved (requires a product decision, or you genuinely disagree), describe the blocker in your output. Do NOT silently skip it.
