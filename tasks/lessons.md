# Lessons

## Harness selection must be repository-configurable

- Do not present the current profile-owned implementer harness as an acceptable
  deployment constraint when the user requires primary/secondary selection in
  repository configuration. The invocation profile is host/UI context only;
  `.github/pipeline.yml` must be able to choose both roles explicitly, with
  model and effort controls validated against the selected harnesses.

- When evaluating an agent pipeline, verify that the experiment treatment schema represents every decision variable requested by the user. A single-harness treatment axis can compare roles independently but cannot substantiate a claim about a primary→secondary harness pairing.
- When a user asks to continue an active evaluation, do not let related backlog/issue work become a stopping point. Resume the runnable experiment immediately and report the issue work as parallel context only.
- For a long-running evaluation, keep a user-readable execution log in `tasks/todo.md` and give incremental commentary at every meaningful state transition (plan, run start, completed-cell count, corpus invalidation, grade/report start, and result). A milestone-only summary leaves the user unable to assess progress or intervene.
- When the user requests monitoring, attach a live state monitor and keep the
  same agent turn open until the monitored workflow and all automatic
  follow-up phases are terminal. Poll durable result/failure records, surface
  updates at least every minute, and never send a final response while work is
  still running; ending the turn silently kills the only user-visible monitor.
- Monitor structured `runs.jsonl` and `failures.jsonl` classifications instead
  of grepping trajectory prose for provider errors. Fixture code and generated
  plans can legitimately mention rate limits, producing false alarms.
# Model-effort evaluation must cover declared levels

When the evaluation objective includes model effort selection, do not infer a curve from endpoint efforts. Run every valid effort level for the candidate model across the same frozen corpus, or explicitly get the operator's approval for a reduced screen before launch.

Keep the candidate set to the operator's stated decision boundary. Do not add adjacent model versions merely because they are available; that increases cost and delays the answer without improving the requested comparison.

When evaluating a named model family, enumerate the installed registry before defining treatments. Variant slugs and their supported effort levels are separate experimental factors; do not assume one variant represents the family.

Do not present a stage subset as a pipeline baseline. A harness-routing decision needs explicit, stage-level baselines for planning, implementation, review, and fix, plus an end-to-end treatment that passes the primary's actual plan and diff to the secondary reviewer.

Plan-review is a separate secondary/adversarial stage, not part of generic code review. Before designing or launching an evaluation, derive the complete stage graph and all role handoffs from pipeline configuration and stage-routing source, including plan revision and both review/fix convergence loops.

An evaluation may observe each runtime stage independently, but its treatments and final recommendations must be expressed as configurations the product can actually deploy. Derive the configurable slots and their shared-stage coupling from the schema and resolution code before proposing a matrix.

When production config supports a role-specific override (such as structured
`review_harness.effort`), the evaluator must represent and honor it. A
stage-only model/effort policy is not faithful when primary and reviewer
harnesses accept different effort vocabularies.

When an evaluation boundary relies on PATH shims, test interpreter-mediated execution of protected entrypoints as well as the named command. `node core/scripts/pipeline.ts …` is a distinct bypass path from `pipeline …`; stop and invalidate a run as soon as a protected action is attempted, then add a real-child-process regression before rerunning.

Evaluator-owned setup must be excluded from every model-visible artifact, not only final grading fields. In a multi-stage run, restore temporary instruction files before every reviewer-facing diff and reapply them only for the next isolated primary call; otherwise reviewers measure evaluator leakage rather than the treatment.
