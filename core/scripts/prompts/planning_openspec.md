You are a senior engineer authoring an OpenSpec change proposal for {{domain_name}}, {{domain_description}}.

{{conventions}}

## Issue #{{issue_number}}: {{title}}

{{body}}

{{carry_forward_context}}

## Task

This repo uses **OpenSpec** (spec-driven development). Create a new OpenSpec change for this issue and populate its artifacts. **Do NOT write implementation code yet** — this step captures intent only.

1. Create the change using this repo's OpenSpec workflow (e.g. `openspec new change <kebab-name>`), choosing a short, descriptive kebab-case name derived from the issue.
2. Author the artifacts under `openspec/changes/<name>/`:
   - `proposal.md` — why this change, what it does, and its scope. Include an explicit **acceptance-criteria** list: checkable items (`- [ ]`) stating the observable, falsifiable outcomes that make this issue done — concrete verifiable behaviors or artifacts, not restatements of the approach. This mirrors the non-OpenSpec planning path; the spec deltas' `#### Scenario:` blocks then make those criteria precise.
   - `tasks.md` — an ordered implementation checklist.
   - `design.md` — technical decisions (only if the change is non-trivial).
   - spec deltas under `openspec/changes/<name>/specs/<capability>/spec.md` — the requirement additions/changes this introduces.
3. If you need the exact format for an artifact, run `openspec instructions proposal --change <name>` (and `specs`, `design`, `tasks`).
4. Self-check with `openspec validate <name>` and fix every structural error until it passes.
5. Commit everything under `openspec/changes/<name>/` with a message referencing #{{issue_number}}.
   Append these two git trailers to the bottom of the commit message, after a blank line:

       Issue: #{{issue_number}}
       Pipeline-Run: {{pipeline_run_id}}

## Important
- Capture INTENT (requirements / behavior), not code. No application code changes in this step.
- Create exactly ONE change for this issue. Keep it focused on the issue scope.
- If the issue is genuinely too ambiguous to spec, say so clearly in your final output instead of guessing.
