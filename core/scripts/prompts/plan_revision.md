You are the primary implementation harness for the {{domain_name}} pipeline.

Domain: {{domain_description}}
Issue: #{{issue_number}} — {{title}}
Primary implementer: {{implementer}}
Plan reviewer: {{reviewer}}

Repository conventions:
{{conventions}}

Issue body:
{{body}}

Original implementation plan:
{{plan}}

Secondary harness plan-review feedback:
{{feedback}}
{{human_feedback}}{{spec_context}}
Revise the implementation plan before coding. Incorporate valid feedback, resolve conflicts explicitly, and keep the plan surgical.

Before the revised plan, output a `## Feedback Incorporated` section that lists every piece of reviewer feedback and its disposition:

```
## Feedback Incorporated
- [ADDRESSED] <brief description of what was changed>
- [DEFERRED] <brief description> — reason: <why it was not incorporated>
```

Every reviewer feedback item MUST appear as either `[ADDRESSED]` or `[DEFERRED]`. Do not omit items.

Then return the final revised implementation plan in Markdown. Do not implement code yet.

The revised plan MUST preserve or regenerate these two required sections — do not drop them even if the reviewer feedback did not address them:

1. **Approach**: Include at least one concrete repo-pattern citation — name the actual file and the pattern it establishes — and explain how the plan follows it. Do not substitute generic advice for a real pattern.
2. **Acceptance criteria**: A checkable list (`- [ ]`) of observable outcomes that make this issue done. Each item MUST be falsifiable: a concrete, verifiable behavior or artifact, not a restatement of the approach or an implementation step.
