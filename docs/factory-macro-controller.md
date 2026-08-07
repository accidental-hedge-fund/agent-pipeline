# Factory macro-controller

Opt-in Pipeline-owned controller for **coarse factory lifecycle** (intake →
execution-contract adoption → multi-item loop execution → operator merge/release
preparation → engine observe). Issue #890.

## Default: off

The macro-controller is **disabled by default**. Ordinary commands are
unchanged and do **not** create factory-run state:

- `pipeline <N>` / `pipeline single` / `pipeline loop`
- `pipeline merge` / `pipeline merge-queue`
- `pipeline release`

Enable only when you want Pipeline to own repository-level factory phase:

```yaml
# .github/pipeline.yml
factory:
  macro_controller:
    enabled: true
```

Or for the dedicated CLI only: `PIPELINE_FACTORY_MACRO=1`.

There is **no `auto_merge` key**. Merge and release remain operator-gated
(`pipeline merge`, `merge-queue --apply`, operator release).

## Sole Pipeline authority

When enabled, a factory run has exactly one:

| Artifact | Role |
| --- | --- |
| Execution-contract revisions | Immutable, canonically hashed intent |
| Current revision pointer | Monotonic CAS pointer |
| Factory lock | Host-local PID lock (single-host scope) |
| Coarse-action claims | Claim-before-side-effect, at-most-once |

Outer host sessions, Hermes (or other external) databases, and agent chat are
**not** authoritative schedulers or stores. Restart reconstructs phase and next
action from durable factory state + live GitHub/git/config/child observations.

## Identities (five distinct slots)

Each accepted revision and coarse-action evidence record keeps these separate:

1. **service_controller** — e.g. `factory-macro@1` (never a host adapter id)
2. **outer_host** — session host (#784 registry)
3. **implementer_treatment** — stage adapter for implementation
4. **reviewer_treatment** — stage adapter for review
5. **privileged_mutation_actor** — operator-bound privileged mutations

A non-Claude controller is never silently recorded as Codex. Outer-host id is
never rewritten to equal the service controller.

## Immutable contracts and CAS replan

- Accepted revision bodies are write-once.
- Replan creates a **new** retained revision with a `live_state_reason` and
  advances the current pointer via compare-and-set on the expected revision.
- Stale expected revision or changed live repository identity fails closed with
  no partial current-contract mutation.

Canonical hash covers repository/base SHA, selector, issue/PR ids, milestones,
dependency edges, linked loop/advance run ids, controller + identities,
fingerprints, coarse phase, completion policy, and next action.

## Coarse actions and evidence

Before starting/resuming a child durable loop (or whole-issue advance), the
controller creates a durable **claim**. Duplicate ticks observe the claim and
dispatch at most once.

Every claim and terminal outcome records **service controller identity** and
**contract revision** so consumers can answer which controller revision owned
each coarse action without chat logs.

## Delegation only

The controller starts/resumes/observes **whole** durable loop (or advance) runs.
It does **not**:

- apply pipeline stage labels for item work
- select model/effort per stage
- replace the independent scheduler or recovery controller
- raise concurrency budgets above the linked loop contract policy
- squash-merge PRs or finalize releases unattended

Default active-item behavior remains **one**; proven-independence rules stay
with the loop independent scheduler.

## CLI (opt-in)

```text
pipeline factory status --run-id <factory-run-id> [--json]
pipeline factory tick   --run-id <factory-run-id> [--json]
```

Adoption/replan of full contract bodies is available via the library API
(`adoptFactoryContract` in `core/scripts/factory/`). Full CLI body adoption may
grow later; library APIs are the stable surface for tests and automation.

## Storage layout

Under the factory state home (default
`~/.local/state/agent-pipeline/factory`, override
`AGENT_PIPELINE_FACTORY_STATE_HOME`):

```text
runs/<factory-run-id>/
  current.json
  lock.json
  revisions/<N>.json
  claims/<action-id>.json
  claims/<action-id>.dispatch
  events.jsonl
```

Linked durable loop runs keep their existing store under the loop state home
and remain the sole item-ledger authority.

## Locks (single-host)

Factory locks are host-local (same disposition as issue-run and loop locks).
Two hosts can still race on GitHub labels; this controller does not provide a
distributed multi-host lock.
