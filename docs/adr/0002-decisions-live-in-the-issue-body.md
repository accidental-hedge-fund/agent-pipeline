# Decisions live in the issue body; comments are not the spec

Agents, train, and `triage --stage ready` read the **issue body**. A grill pass writes a `## Decisions` section there. A comment, including a lock comment, does not settle an authority node. Bare `pipeline triage N` is one implementer shot that rewrites the body and leaves `pipeline:backlog` when authority remains unset. `--stage ready` is a deterministic gate (exit 2, no label flip) with no harness.

**Considered options:** store the frontier in issue comments (rejected: comments are invisible to train/body readers); interview during planning (rejected: factory must not grill mid-run); put a harness inside every `--stage ready` (rejected: complete bodies stay one deterministic call).
