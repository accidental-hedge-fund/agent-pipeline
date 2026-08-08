# Lessons

- When several stage failures all become `blocked`, inspect the outer supervisor before adding
  stage-local retries. A configured recovery policy with untouched budgets is evidence that the
  orchestration contract is dead or bypassed.
- A human hold requires an explicit authority boundary or product decision. Mechanical validation,
  merge, worktree, harness, CI, and state-reconciliation failures must remain engine-owned through
  bounded recovery and typed exhaustion.
- Use incident failures as fixtures for a generic recovery taxonomy and controller. Do not encode
  provider names or individual issue numbers into production recovery behavior.
- A validated retry/backoff configuration is not an implemented recovery policy until production
  actually executes it through an injected, testable wait seam.
- Persisted recovery claims must be bound to freshly observed candidate identity both before and
  after the side effect; a completed local action is not success until the remote head proves it.
- Recovery backoff is scheduler state, not an item-executor sleep. Persist the eligibility deadline,
  run independent siblings first, and let only an otherwise-idle driver wait while maintaining its heartbeat.
- Candidate-bound human authority expires when fresh reconciliation observes another HEAD; a label
  cannot preserve authority granted for stale reviewed evidence.
- A green broad suite does not replace adversarial lifecycle review. Explicitly test crashes after
  each external side effect and fresh external truth that overtakes a durable local claim.
- An autonomous recovery policy is still misleading when its first action is a model call while a
  deterministic redispatch can re-evaluate the invariant, or when a named recipe is guaranteed to
  fail. Every configured recipe must have a real production side effect or verification path.
- Recovery semantics must be shared by single-item and multi-item entry points. A durable loop that
  heals mechanical blocks does not make the product autonomous when the primary one-item command
  bypasses that controller and parks the same outcome.
- Fail-closed authority means missing current authority proof stays engine-owned. Do not create a
  "conservative" human-resume-only hold from a label, outcome name, or old blocker-kind marker.
- Do not defer a regression in newly shipped behavior into a later architectural milestone merely
  because future issues own broader consolidation. Patch the broken release invariant now and add
  only the remaining structural acceptance criteria to the future owners.
- Review recurrence is evidence only when it is bound to the current run/candidate and follows an
  actual repair attempt. Issue-wide comment history cannot prove same-candidate non-convergence.
- Lifecycle regressions must use the production transition graph and run-identity boundaries in
  their fixtures. A fabricated transition can make an unreachable recovery path look complete.
- A recovery policy is internally inconsistent when its first action cannot change the failed
  invariant or its retry/repeat budgets make a later recipe unreachable. Test recipe order through
  the real supervisor, not only policy compilation.
- A body hash proves integrity, not authorship of individual fields inside reviewer-controlled
  prose. Security- or policy-relevant lineage must live in a typed, validated artifact field and
  consumers must ignore lookalike prose markers.

# Installer command discovery

- `scripts/install.mjs` does not implement `--help`; invoking it with that flag falls through to the default all-host install. Read its usage header/docs or use an explicit supported dry run when inspecting installer behavior, and never run command-discovery probes from an unmerged worktree.

# Autonomous factory intent

- Do not turn an autonomous delivery-factory request into a supervised PR generator. Preserve the full outcome: integrate prerequisite work, release it, promote the verified pin, install that exact release, and continue with the new engine.
- For current Grok routing, use only `grok-4.5`. Do not infer a model from stale provider documentation and do not configure an automatic Grok fallback.
- A self-building Pipeline release is incomplete until the factory host updates both its base checkout and its pinned installed Pipeline engine, passes role-aware doctor smoke, and records the new engine on the next run.
- A bootstrap supervisor is not self-building if its release version, candidate identity, or FRG path is fixed to the first release. Prove two consecutive releases: the first installed engine must supply the candidate-native release seam for the second without manual wrapper or config replacement.
- When the operator asks to rebase all milestones, assign every open issue to one explicit SemVer release milestone. Do not replace later milestones with theme-only backlog labels unless the operator asks for a rolling horizon.
- After the operator approves a small startup path, freeze that boundary. Do not turn later review findings into new architecture unless they block the approved path, and report the remaining gate count before adding work.
