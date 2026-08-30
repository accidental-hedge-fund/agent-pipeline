# Lessons

- During long Pipeline model calls, report concrete stage transitions and blocker evidence at least once per minute. If output is silent, inspect the live process and written artifacts; do not leave the operator guessing whether the run is active.
- A plan-review request cannot broaden an issue past an explicit non-goal. When a required generated host artifact appears to conflict with an existing install lifecycle, inspect the living lifecycle contract and prefer content parity at the existing seam before changing install mode.
- Before dispatching any durable backlog item while a milestone train is live, compare exact issue identities and subtract every overlap from this run. The train owns overlapping issues; do not infer safety from separate processes or worktrees.
- A train-owned issue is not necessarily under active recovery. Check the train event stream for `train_item_completed` and later waves. If it terminalized the issue and moved on, report that scheduler gap instead of saying the train is still handling it; later repair commits still need a fresh Pipeline/CI/review pass.
- When the operator requires per-issue integration, `pipeline:ready-to-deploy` is not a batching point. Merge that issue through the Pipeline merge gate, prove `main` contains the merge, reconcile the ledger, and only then dispatch a dependent successor.

- A newly filed issue that belongs to the active milestone cannot be left unmilestoned. Assign its release milestone when creating it; do not wait for the operator to correct the omission.
- When the operator identifies repository `pipeline.yml` as the source of execution policy, do not ask a host-level profile question before establishing whether the configuration explicitly declares the relevant harness roles. Separate a missing-config enforcement change from a host-install change.

- When the operator says finish ship **including FRG**, a `--skip-frg` tag/promote
  is not done. Optional-FRG / `no-frg-*` is not “rip FRG out.” Keep fixing the
  score path until `latest.json` is `pass: true` and promote has no `--skip-frg`,
  or delete FRG from the product. Do not pick a third path.
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
- For current Grok routing, use only `grok-4.6`. Do not infer a model from stale provider documentation and do not configure an automatic Grok fallback.
- A self-building Pipeline release is incomplete until the factory host updates both its base checkout and its pinned installed Pipeline engine, passes role-aware doctor smoke, and records the new engine on the next run.
- A bootstrap supervisor is not self-building if its release version, candidate identity, or FRG path is fixed to the first release. Prove two consecutive releases: the first installed engine must supply the candidate-native release seam for the second without manual wrapper or config replacement.
- When the operator asks to rebase all milestones, assign every open issue to one explicit SemVer release milestone. Do not replace later milestones with theme-only backlog labels unless the operator asks for a rolling horizon.
- After the operator approves a small startup path, freeze that boundary. Do not turn later review findings into new architecture unless they block the approved path, and report the remaining gate count before adding work.
- Live factory calibration must use the exact pinned Pipeline command and the exact Buzz channel-and-thread target. A nearby smoke test does not prove the deployed command shape.
- A chat command that starts a long systemd unit must use a nonblocking start. The factory controller owns progress messages; the Hermes tool turn must return after admission instead of emitting terminal wait timers.
- A factory model pin must cover every treatment that `doctor --harness-smoke` enumerates, including optional intake and sweep slots. An omitted slot can inherit an incompatible model even when the main issue stages are pinned correctly.
- A pinned bootstrap engine can be healthy while doctor reports a version-freshness warning. Validate each check result; do not turn a warning-only envelope into a factory failure.
- Model admission must distinguish the configured model name from a provider-reported canonical runtime name. Accept only a live-verified one-to-one alias; do not broaden the model allowlist.
- A nested self-update must exempt only the invoking launcher's validated reservation lock. Do not use a broad force option that permits file replacement under unrelated live runs.
- A deterministic digest proves a document is internally unchanged, not that an authorized
  gateway created it. Mutation authority needs an independently trusted signature key, and
  long-running coordinators must revalidate expiry at every side-effect boundary.
- Temporal proximity cannot bind reliability evidence to a release candidate. If the
  producer does not record the exact repository, base, and candidate OID, the release must
  stop instead of rebinding the evidence in a downstream adapter.
- A globally installed validation CLI can be newer and more permissive than CI's pinned
  fallback. When CI pins a tool version, reproduce failures with that exact version before
  treating a newer local validator as authoritative.
- When asked to update relevant PRs, do not silently replace or close an explicitly named
  PR. Preserve its distinct deliverable, stack it on prerequisite implementation when
  appropriate, and let the user decide whether it should be superseded.
