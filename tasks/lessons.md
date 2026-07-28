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
