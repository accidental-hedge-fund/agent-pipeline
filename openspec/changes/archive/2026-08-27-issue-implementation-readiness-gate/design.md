## Context

See proposal.md for motivation.

Pickup of a `pipeline:ready` issue currently goes to `dispatch("ready")`, which claims the live-planning marker and calls `planningAdvance`. That path creates a worktree and invokes the planning authoring harness. Queue, loop, train, and ship all reach that dispatch for ready items.

Thin-issue cleanup already exists as two other surfaces and MUST stay distinct:

- `pipeline sweep` classifies by structural heuristics and may rewrite bodies with `--apply`.
- `pipeline refine-spec` is a non-mutating preview. It requires canonical headings.

This gate is semantic admission. Canonical headings are not required to pass. The gate never edits the issue body.

Existing specs say ready dispatch transitions `ready → planning` before any harness invocation. That rule targets the planning *authoring* harness. This change adds a prior admission evaluation that uses the Implementer planning treatment while the issue is still on `ready`. Those two specs MUST be updated so archive does not leave a contradiction.

This is a class-level admission gate, not a path-local mole. One shared function, one label, one config block, one owned comment. The next thin `pipeline:ready` issue hits the same gate without a new issue.

## Goals / Non-Goals

**Goals:**

- One shared gate function used by every pickup path before worktree create or delivery harness invoke.
- Default-off behavior that is byte-compatible with current pickup when `enabled` is false or the block is absent.
- GitHub-durable verdict reuse bound to title, body, and resolved planning treatment.
- Fail closed on provider/harness/timeout/schema failure with no fallback.

**Non-Goals:**

- A new delivery stage that advances toward `ready-to-deploy`.
- Running the gate on mid-flight stages (`planning` and later).
- Putting the gate inside `pipeline triage` (triage stays deterministic).
- Replacing sweep or refine-spec.
- Cross-host locks. Verdict reuse lives in the owned GitHub comment so two hosts see the same record.

## Decisions

### Decision 1 — The gate is a function, not a STAGES member; `needs-spec` is the only new stage

`needs-spec` sits in `STAGES` after `backlog` and before `ready`. It is a pre-delivery admission hold, same class as `backlog`: dispatch does not start work; schedulers treat it as ineligible. It is not in `TERMINAL_STAGES`.

The evaluation itself is not a stage. Putting it in `STAGES` would make every disabled-config repo traverse a new no-op stage and would confuse lifecycle metrics.

Alternative considered: a `pipeline:needs-spec` label outside `STAGES`. `desiredPipelineLabels()` is derived from `STAGES`, and `pickStage` returns null for unknown suffixes. That would look unlabeled and would skip managed label setup. Rejected.

### Decision 2 — One production seam: ready admission before planningAdvance

Call the shared gate from `dispatch("ready")` *before* the live-planning marker and `planningAdvance`. Direct advance/single, queue item runs, loop/supervisor redispatch, train, and ship already reach that case for `pipeline:ready` items.

The function is also the test seam. Each coordinator path MUST call it (directly or by entering ready dispatch) so a missing call site fails a unit test.

Do not evaluate at queue *inventory* time. Inventory can be stale. Re-fetch title, body, and labels immediately before evaluation.

Skip the gate when the observed stage is not `ready` (mid-flight redispatch, `backlog`, `needs-spec`, terminal). `needs-spec` dispatch is a waiting no-op like `backlog`.

Alternative considered: copy the gate into queue, loop, train, and ship. That would drift. Rejected.

### Decision 3 — Config is a small default-off block

```yaml
issue_readiness:
  enabled: false
  timeout: 600
```

- `enabled` defaults false. Absent block equals disabled.
- `timeout` is seconds for the admission harness call. Default 600, same family as intake/sweep.
- No per-gate model or effort keys. Treatment is `harnesses.implementer` + `models.planning` + `effort.planning`, including `auto` expansion through the existing `planning` routing stage.
- Unknown keys fail strict schema validation.
- Add `issue_readiness.enabled` to `RIGOR_GATING_PATHS` because it changes paid-call volume.
- This repository sets `enabled: true`. Other repositories stay off unless they opt in.

Alternative considered: reuse `plan_review_timeout` or `implementation_timeout`. Those cap different work. A dedicated timeout keeps a hung admission call from inheriting a 40-minute implementation budget.

### Decision 4 — Semantic verdict, structured JSON, no heading requirement for admission

The Implementer returns JSON with `verdict: "ready" | "needs_spec"`. On `needs_spec` it also returns concrete `deficiencies` and a `proposed_body`.

Admission (`ready`) requires all of:

- a clear problem/outcome
- observable acceptance criteria
- scope constraints or non-goals
- no unresolved contradiction

Canonical headings (Summary, User story, Acceptance criteria, Out of scope, Open questions) improve the drafted revision. They are not required to admit. A well-specified issue without those headings is `ready`. Sweep's structural heuristic is not this gate.

Malformed JSON, missing `verdict`, or an unknown verdict value is `gate-unavailable`, not `needs_spec`. Do not coerce a schema failure into a spec-quality rejection.

Single-source the verdict schema (same pattern as `review-schema.ts`) and inject it into the prompt. Drift-guard with a test.

### Decision 5 — One owned GitHub comment records both verdicts

Identity is an HTML comment marker owned by this gate, including:

- title/body hash
- resolved planning treatment (implementer harness, resolved planning model, resolved planning effort)
- verdict

Hash is SHA-256 over a canonical encoding of title, body, and treatment. Any of those changing invalidates the record.

Find the existing Pipeline-authored comment with this marker. Update it in place. If none exists, create one. Never create a second owned comment.

Record both `ready` and `needs_spec` in that comment so reuse is GitHub-durable and cross-host. On `ready` the visible body MAY be a short admission record. On `needs_spec` it MUST list deficiencies and the proposed revised body that preserves author intent and follows the five-section contract.

Reuse: if the freshly fetched title, body, and treatment match the marker, do not call the model and do not post another comment. Apply the recorded verdict (including re-asserting `pipeline:needs-spec` when a still-thin issue was triaged back to `ready`).

Alternative considered: persist only `needs_spec` comments and re-evaluate every `ready` admission. Crash recovery rolls issues back to `ready` and would re-spend a planning-treatment call every time. Rejected.

### Decision 6 — Write surface is the owned comment plus the needs-spec label

On `needs_spec` the gate:

1. writes or updates the owned comment
2. transitions `pipeline:ready` → `pipeline:needs-spec` (add target first, then remove `ready`, same ordering as triage)

It SHALL NOT edit the issue body, milestone, project files, or unrelated labels.

On `ready` it may update the owned comment with the bound admission record. It SHALL NOT change stage labels beyond leaving the issue on `pipeline:ready` for the existing planning transition.

On `gate-unavailable` the gate writes no GitHub mutation. Direct single invocation fails visibly (non-zero exit). Multi-item runs record a typed hold for that issue and for selected dependents of that issue. Independent selected issues continue. The issue stays on `pipeline:ready` so a later run can retry. Do not move it to `needs-spec` (that would fake a spec-quality verdict). Do not fall back to the Reviewer, a structural heuristic, another provider, or another model.

The owned comment and the `ready` → `needs-spec` labels are a verified write sequence. After a write failure the gate re-fetches. If the desired comment and labels already hold, it returns `needs_spec`. If the issue is still on `ready`, it retries remaining writes. `gate-unavailable` is only for attempts with no remaining GitHub mutation. A write that cannot be completed or compensated is typed `mutation-failed`: it fences delivery and does not start planning.

`pipeline triage <N> --stage ready` stays a deterministic label write. It is the re-admission *request*. The next pickup re-fetches and must pass the gate. Unchanged thin text reuses `needs_spec` and moves the issue back to `needs-spec` with no extra model call.

### Decision 7 — `needs_spec` is human-authority, not engine recovery

Applying the proposed body is an author action. The engine MUST NOT edit the body or auto-triage back to `ready`. That matches the issue out-of-scope list and the ship-path rule that true product judgment stays parked.

`gate-unavailable` is mechanical. It is engine-owned: typed, fail closed, retryable on a later run. It is not `needs-human` and not a janitor wait.

### Decision 8 — Tests inject GitHub, time, and harness I/O

A `Deps` seam supplies fetch-issue, list/post/update comment, label add/remove, clock, and implementer invoke. Unit tests perform no real network, git, or subprocess calls.

Cover at least: enabled vs disabled on each pickup path; fresh fetch vs stale inventory; planning-treatment propagation including `auto`; semantic ready vs needs_spec; heading-optional admission; comment provenance and idempotency; label transition; triage re-admission; hash/treatment invalidation; gate-unavailable plus selected dependents; no worktree and no delivery harness on rejection.

## Risks / Trade-offs

- **Admission adds a planning-treatment call on every new ready issue.** → Mitigation: default off; dogfood only this repo; reuse bound verdicts; timeout 600s.
- **Ready-dispatch harness-timing specs currently forbid any harness on `ready`.** → Mitigation: modify those requirements so only the admission evaluation may run on `ready`; authoring still follows `ready → planning` first.
- **False `needs_spec` on a good issue.** → Mitigation: semantic rubric, not heading checks; author applies the draft and re-admits; reuse avoids comment spam on unchanged text.
- **False `ready` on a thin issue.** → Mitigation: four semantic conditions; dogfood in this repo; no fallback that admits on schema failure.
- **`gate-unavailable` retry loops in a durable run.** → Mitigation: typed hold for this run; dependents held; later run may retry; no tight inner retry.
- **Two hosts evaluate the same issue concurrently.** → Mitigation: host-local issue-run lock still serializes one host; the owned GitHub comment is the cross-host record; last writer updates the same comment. Duplicate model calls across hosts are possible and acceptable; duplicate owned comments are not.

## Migration Plan

1. Ship with `DEFAULT_CONFIG.issue_readiness.enabled === false`. Repos that omit the block do not change behavior.
2. Enable `issue_readiness.enabled: true` in this repository's `.github/pipeline.yml`.
3. `pipeline init` / `ensurePipelineLabels` create `pipeline:needs-spec`.
4. Rollback: set `enabled: false` or revert the engine. Existing `pipeline:needs-spec` labels remain; operators triage those issues to `ready` or `backlog`.

## Open Questions

None. Admission vs delivery harness timing, write surface, and `gate-unavailable` dependency behavior are decided above.
