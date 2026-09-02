# Agent Pipeline

The CLI that advances GitHub issues through a label-driven pipeline. Hosts wrap that CLI. They are not a second engine.

## Language

### Packaging

**CLI**:
The `pipeline` binary. The product. Every verb (`single`, `train`, `merge`, `status`) lands here.
_Avoid_: plugin engine, skill engine, core copy

**Host**:
A thin argv or JSON wrapper that invokes the CLI (Claude, Codex, Grok, OpenCode, OMP, Tugboat).
_Avoid_: second pipeline, per-host stage machine

**Outer-host ID**:
The install and lifecycle identity for a session surface (for example, `omp`). It is independent of a stage-adapter ID; `omp` does not replace or alias the `pi` adapter.
_Avoid_: provider identity, implementer identity

**Native host command**:
A host-owned command that invokes the installed launcher as a process, forwarding the session working directory and exact argv. It does not turn command output into an LLM prompt. OMP's `/pipeline` uses this form.
_Avoid_: prompt template, a second CLI, OpenCode command reuse

**Shim**:
A short host SKILL (or none) that tells the agent to exec `pipeline` on PATH.
_Avoid_: `/pipeline:*` command pack, marketplace command files

**Slash command**:
A generated `/pipeline:status`-style wrapper that only execs the CLI. Not required.
_Avoid_: product surface

**Plugin directory**:
A retired packaging tree. The repo has no `plugin/` overlay and no marketplace catalog. Claude install writes a short SKILL next to the CLI via `install --host claude`. If `CLAUDE_PLUGIN_ROOT` still points at a leftover core copy, run `install --host claude` or pin.
_Avoid_: marketplace listing, source of truth

**Launcher bootstrap**:
The dependency-free phase before loading TypeScript. It may answer version-only requests on its invoking Node; otherwise it resolves and re-execs an engines-compliant Node with the resolved binary's directory first on `PATH`.
_Avoid_: treating PATH `node` as the engine, a per-host Node walker

**Introspection compatibility**:
Version-only launcher behavior available below the engine floor. It does not make that Node version a supported TypeScript runtime.
_Avoid_: lowering `engines.node`, Node 22 engine support

**Repository execution policy**:
A runnable target has `.github/pipeline.yml` with both `harnesses.implementer` and `harnesses.reviewer`. That file selects stage workers; an outer host does not. Missing or partial policy fails before work begins.
_Avoid_: host-selected workers, profile fallback for a runnable repository

**Profile bootstrap**:
Compatibility metadata supplied before repository configuration is read. An OMP profile keeps the current launcher/config interface intact; it must not determine live stage workers once repository execution policy is required.
_Avoid_: treating a host profile as repository policy

**Captured launcher executable**:
The absolute `process.execPath` used to install a native host command. The command launches the installed shim with that executable and no shell/PATH `node` lookup; launcher bootstrap may still re-exec a compliant Node.
_Avoid_: a hard-coded `node` command, a second resolver

**OPERATION_SURFACE**:
The single list of CLI verbs in `scripts/build.mjs`. Catalog for docs and the SKILL verb table. Does not justify emitting one markdown file per verb.

**MCP server**:
A possible third surface that would wrap the same CLI verbs as tools. Not required. Parked (#907).
_Avoid_: control plane, startup requirement

**Implementer**:
The configured harness that plans, codes, and fixes (`harnesses.implementer`). A role, not a brand.
_Avoid_: Claude, Grok (as the name of the role)

**Reviewer**:
The configured independent harness that judges plans and diffs (`harnesses.reviewer`). A role, not a brand.
_Avoid_: Codex (as the name of the role), self-review as the default product

### Intake

**Grill**:
Native `pipeline grill` admission: select issues, walk each design tree, auto-settle in-scope recommendations, record the Decisions artifact and required domain docs, and request `pipeline:ready`. Not planning, not a comment, not a chat loop, not `triage --stage`, not a host skill.
_Avoid_: plan-review, mid-run interview, comment-as-spec, bare `pipeline triage N` as a body rewrite, refine-spec as the grill

**Decisions**:
The versioned issue-body artifact and its derived `## Decisions` section. That body is the spec for `--stage ready`. Comments and handoffs prove provenance; they do not replace the body. #1238 comments are pickup verdict evidence, not the spec.
_Avoid_: review comment, blocker comment, lock comment, comment-as-spec

**Authority node**:
An unsettled question whose class is `scope`, `security`, `irreversible-operations`, `merge-release`, or `human-attestation`. It blocks `--stage ready` until auto-accept under existing authority, or an authenticated hash-bound `pipeline handoff answer`. Unknown or disputed classes stay unresolved authority.
_Avoid_: open question, TODO, parking everything

**auto-accept**:
Provenance of an in-scope default that is reversible, policy-consistent, and covered by existing authority. Not operator authority. It never grants merge, release, destructive, security, or other protected authority.
_Avoid_: operator sign-off, merge grant, comment-as-accept

**typed request**:
An irreducible `DecisionRequest`, input-requiring `CapabilityRequest`, or protected `AuthorityRequest` that pauses only that issue. Answered through `pipeline handoff answer`. Low model confidence is not a typed request.
_Avoid_: low confidence as a handoff, second answer ledger

**reviewer-accept**:
Historical provenance of an automatic default on a taxonomy-validated non-authority node (`interface-contract`, `test-evidence`, `docs-surface`, `operational-default`) after a reviewer `accept`. Not operator authority. Remaining reviewer-accept nodes stay valid until re-grilled.
_Avoid_: operator sign-off, handoff answer, comment-as-accept

### Diagnostics

**Supervised operation**:
A lifecycle-affecting mutation that remains owned until it proves success, remains durably scheduled for recovery, waits on an external condition or typed request, or is explicitly cancelled by an authenticated operator or its authorized caller. Mechanical failure and retry exhaustion do not end ownership.
_Avoid_: one-shot command, terminal-on-error operation

**Decision request**:
A choice among permitted product alternatives for which Pipeline supplies a recommendation. Policy may accept a reversible authorized default.
_Avoid_: failure, capability request, authority request

**Capability request**:
A typed statement that progress requires an unavailable external capability, condition, or information. It requests restoration or input, not approval.
_Avoid_: authority request, generic blocker, harness failure

**Authority request**:
A typed request for authority Pipeline does not possess, such as approval for security-sensitive, irreversible, merge/release, or human-attested action. It cannot be settled by a model-authored default.
_Avoid_: capability request, decision request, generic needs-human

**RecoverySupervisor**:
The sole lifecycle owner for supervised operations. Command, stage, integration, ship, and host surfaces report observations to it rather than defining their own terminal or recovery policy.
_Avoid_: loop supervisor as a separate policy, command-local recovery controller

**Operation adapter**:
A boundary that performs one bounded operation attempt and reports a typed observation with evidence. It does not choose lifecycle treatment or declare terminal state.
_Avoid_: recovery controller, scheduler

**Operation observation**:
Versioned evidence about an operation invariant, candidate, and side-effect certainty. A process exit, exception, timeout, or model response is ingress evidence, not success by itself.
_Avoid_: exit code as lifecycle state, prose blocker

**Operation invariant**:
The declared precondition, postcondition, authoritative observer, candidate binding, and replay rule for a supervised operation.
_Avoid_: best-effort success heuristic

**Authoritative observer**:
The system whose fresh state proves an operation-specific fact. Local intent history cannot overrule the forge, git remote, CI, release provider, or deployment provider for facts those systems own.
_Avoid_: local ledger as universal truth

**Candidate epoch**:
The period during which all candidate-bearing authoritative facts retain one identity. Candidate movement starts a new epoch and invalidates candidate-bound review, test, decision, and authority evidence.
_Avoid_: process lifetime, retry number

**Side-effect certainty**:
An observation classifying a side effect as known complete, known absent, or uncertain. Uncertainty requires reconciliation before replay.
_Avoid_: timeout means absent, exit zero means complete

**Recovery episode**:
Durable recovery state for one operation invariant, candidate epoch, and normalized evidence identity. It survives process restart and owns its treatment history.
_Avoid_: command retry loop, class-wide retry counter

**Strategy cursor**:
The monotonic position within a Recovery Episode's applicable treatments. Exhausting one treatment advances the cursor rather than ending lifecycle ownership.
_Avoid_: global retry budget

**Cooling**:
An owned state in which a supervised operation waits until its next eligible observation or wake event. It is not cancellation, human ownership, or terminal failure.
_Avoid_: recovery exhausted, stopped, abandoned

**External-condition wait**:
An owned wait on a named external condition with a live probe and a time- or event-based wake rule. It does not ask a human merely because the condition is currently false.
_Avoid_: needs-human, generic blocked

**Lifecycle projector**:
The sole mapper from durable Lifecycle State to compatibility labels, comments, diagnostics, and events. Those projections never become scheduler or authority truth.
_Avoid_: labels as state machine, setBlocked as lifecycle policy

**Operation disposition**:
The executable classification of a command form as read-only, bounded atomic administration, or supervised lifecycle, independent of its authority requirement.
_Avoid_: one mutatesGitHub boolean, top-level verb classification only

**Environment-auth**:
An operator or third-party credential failure (revoked token, login required). Not an engine defect.
_Avoid_: workflow-engine-defect, harness-contract (as the durable theme for a 401)

**capability-refusal**:
A typed, deterministic production-preflight outcome when the selected adapter lacks a required capability contract. The harness did not start, so this is not a harness crash, raw exit failure, workflow-engine defect, or environment-auth failure.
_Avoid_: exit -1, harness-failure, workflow-engine-defect, environment-auth

**Logical operation**:
One immutable root identity minted at public-command admission and retained across retries, restarts, reattachment, and nested work. It is the denominator for lifecycle reliability.
_Avoid_: process, attempt, wave, run ID, issue closure

**Execution attempt**:
One physical effort to advance a Logical Operation. Retries and resumed processes create evidence, not additional logical successes.
_Avoid_: logical operation, successful item

**Verified completion**:
Authoritative proof that the exact-candidate postcondition of a Logical Operation is satisfied. A terminal process or `run_complete` event is insufficient by itself.
_Avoid_: process exited zero, run ended

**Manual reinvocation**:
A new external admission used to continue unfinished work without a valid durable resume binding. Autonomous retry, cooling wake-up, host reattachment, and bound resume are not manual reinvocation.
_Avoid_: every fresh process, automatic resume

**False-human projection**:
A mechanical fault or unavailable system condition incorrectly represented as human ownership or as a typed request without a genuine matching condition.
_Avoid_: any legitimate Decision Request, Capability Request, or Authority Request

**Ownerless terminal**:
An admitted Logical Operation whose process or strategy ends without verified success, durable active or cooling ownership, an external-condition wait, a valid typed request, or explicit authenticated cancellation.
_Avoid_: legitimate wait, completed operation

**Exact-candidate recovery**:
Recovery that preserves and re-proves the candidate identity authorized for the operation rather than substituting a convenient checkout, pin, or artifact.
_Avoid_: PATH candidate, latest run, control HEAD

**Independent-sibling continuation**:
Continued progress for selected operations that do not transitively depend on a waiting or cooling peer.
_Avoid_: abandon the batch on first held item

### Ship path

**Candidate-engine root**:
The exact-SHA engine checkout selected for candidate work such as ship or factory evaluation.
_Avoid_: installed PATH engine, control checkout

**Candidate readiness**:
Engine-owned proof that a Candidate-engine root is runnable. The proof is a success record keyed by candidate SHA plus the nested `core/package-lock.json` digest, stored outside tracked files. A dependency directory alone is not proof.
_Avoid_: node_modules exists, global reinstall, operator attestation

**Resolve-and-prepare**:
The shared gate that selects a Candidate-engine root, proves Candidate readiness, revalidates identity and cleanliness, and only then permits candidate commands to spawn.
_Avoid_: leaf-command install, ship-only bootstrap, identity-only spawn

**Integration candidate**:
The exact repository, base, pull request, and head tuple eligible for one authorized merge claim.
_Avoid_: PR number alone, latest head

**Candidate lineage**:
The authenticated chain connecting the integrated source candidate to release, publication, promotion, and deployed artifact identities.
_Avoid_: one SHA across every release transformation, version string as identity

**Continuous shipment**:
A frozen batch whose terminal proof is exact-candidate integration into its configured base and which carries no implied SemVer release phases.
_Avoid_: fake patch version, release without a tag

**Liveness provider**:
A host-neutral mechanism that discovers and reattaches the existing durable supervisor on one machine. It restores workers but cannot choose recovery, answer requests, merge, or own a second ledger. A dead worker is lost physical liveness (`not-live`), not a logical terminal and not human authority. `pipeline doctor` reports continuous liveness as configured, available, active, or degraded/unavailable. Absence of a keep-alive adapter is a typed capability condition, not a human hold.
_Avoid_: second scheduler, host-specific lifecycle controller, worker death as needs-human

**Fault matrix**:
A versioned executable manifest mapping supervised operations, generic fault classes, public entrypoints, and host adapters to required recovery outcomes. Coverage has adapter-contract, installed-CLI, and host-conformance layers. Mechanical exhaustion is owned Cooling, not a human hold and not a command-local STOP.
_Avoid_: incident test list, optional coverage sample, helper-stamped lifecycle coverage

**Live ship**:
A detached `pipeline train --merge` for one milestone. That process is the ship.
_Avoid_: Buzz thread as the ship, playbook as the definition, `pipeline 702` / `single` lock as a live ship

**Live-ship probe**:
A live pid whose cmdline is that `train --merge` (or the tugboat that owns it). Only this may refuse a second detach.
_Avoid_: `playbook.pid` + `kill -0`, any issue lock

**Playbook**:
A launcher that detaches a live ship. Not the ship. Same detach path for Buzz and a TUI paste: live ship exists → status + notify; else detach once.
_Avoid_: live-ship probe, paste detector, second scheduler

**Ship origin**:
`REPO_DIR` resolved once at tugboat start from install/env. Paths matching `*factory-control*` are refused. Later session text cannot retarget.
_Avoid_: `env.example` factory-control default, mid-ship model override

**STOP**:
A compatibility train outcome indicating that no selected item can progress in the current pass. Underlying operations remain durably owned as cooling, external waits, typed requests, or cancellations, and independent siblings are not abandoned.
_Avoid_: terminal mechanical failure, park, blocked

**Park**:
The compatibility projection `pipeline:needs-human` for a current typed request. The label alone is not authority or scheduler truth.
_Avoid_: mechanical hold, STOP, blocked

**Blocked**:
A legacy compatibility label that must be reclassified through durable Lifecycle State. It is never lifecycle, scheduler, or authority truth by itself.
_Avoid_: parked, needs-human, recovery exhausted

**Hard wait**:
`Depends on: #N` or `blocked by #N` whose target is an open issue on this train selector. Only this may deadlock or hold the train.
_Avoid_: any `#N` under `## Dependencies`, Related, see-also, later-milestone prose

**Ignored dep**:
A `#N` that is closed, off-milestone, or not hard-wait grammar. Logged, not a wait.
_Avoid_: operator rewrite of the issue body

**Intake-ready**:
`pipeline:ready` — the issue may be picked up. Not finished.
_Avoid_: ready-to-deploy, done because a PR exists

**Ready-to-deploy**:
`pipeline:ready-to-deploy` — advance is finished. Merge is a separate authorized verb.
_Avoid_: `pipeline:ready`, `ready_label_present` meaning this label

**Advance-eligible**:
Not ready-to-deploy, and work remains (including an open PR in `pr_opened`). Dispatch is advance.
_Avoid_: supervisor_no_progress when `next_actions` is advance

**Docs-stale**:
`generate-docs --check` failed on generator-owned files. Regen-able. Not unknown CI.
_Avoid_: unknown, assertion, flake re-run

**Review-prompt-too-large**:
The assembled reviewer prompt exceeds the configured reviewer's declared maximum before spawn. Do not retry the same payload; change treatment or enter an owned wait without projecting human authority.
_Avoid_: transient timeout, setBlocked, skip-review-and-advance

**Freeze-eligible**:
Train membership only: open non-backlog pipeline issues plus closed issues labeled `pipeline:ready-to-deploy`. Not proof that the GitHub milestone has zero remaining open issues. Not authorization to start FRG pack, release, or promote.
_Avoid_: remaining-open set, FRG start condition, “all integrated so ship the milestone”

**Ship-end-open-issue-gate**:
Live GitHub remaining-open check immediately before every post-train FRG pack, FRG convergence, release, and `engine-promote` boundary. Counts every open milestoned issue. Pipeline labels do not exempt. Restart and resume re-observe. Fail closed when any remain or when observation cannot prove zero.
_Avoid_: freeze-eligible membership, train freeze snapshot, `--skip-frg` as a leftover-open waiver
