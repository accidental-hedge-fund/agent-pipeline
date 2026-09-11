# Factory simplification plan (approved)

**Status:** approved 2026-08-09  
**Product direction:** thin supervisors compose the Pipeline CLI; integrate trains live in agent-pipeline; no shipped Hermes/Buzz grant factory.

## Objective

| Objective | Pass condition |
|---|---|
| Describe work to a supervisor | Natural language: single issue, issue list, or milestone |
| Single issue | Call agent-pipeline only; models/effort from `.github/pipeline.yml` |
| Group / milestone | Dependency-ordered train |
| Integrate between items | Each issue → ready-to-deploy → merge → next builds on that base |
| Milestone complete | Use agent-pipeline release path |
| Status without prompting | Periodic supervisor posts from real run state |
| Prefer built-ins | Outer layer is thin; Pipeline owns truth |

Target shape:

```text
intent → thin supervisor → pipeline CLI (single / loop / merge / release)
```

## Removed from the product tree

The scoped Hermes/Buzz factory pilot under `ops/hermes-factory` was removed from
this repository. It was a second durable control plane (grant schema, journal,
systemd action bus, hybrid FRG attestor). That path is not the open-source
product surface.

Harvested invariants (still product goals):

- one-item integrate-then-merge waves for dependent work
- squash merge-result containment (merge commit, not PR head)
- advance never merges by default
- declared dependency discovery (#905)

## Authority boundary

- Default `advance` / `single` / `loop` stop at `pipeline:ready-to-deploy`.
- Merge is loop-isolated: `pipeline merge`, `pipeline merge-queue --apply`, and
  opt-in `pipeline train --merge`.
- No `auto_merge` config key. `.github/pipeline.yml` cannot authorize merges.
- External supervisors may call loop-isolated commands under operator authority.

## Phases

1. **Remove pilot tree** — done (#921).
2. **`pipeline train --merge`** — done (#922): `pipeline train --milestone <m>|--issues <n,n> [--merge] [--json]`.
3. **Thin multi-platform supervisor bootstrap** — done: [supervisor.md](./supervisor.md),
   [`examples/supervisor/`](../examples/supervisor/), Hermes production runbook
   [runbooks/hermes-supervisor-deployment.md](./runbooks/hermes-supervisor-deployment.md).
4. **Release finish (historical)** — `pipeline release finish <pr>` remains a
   metadata-PR merge helper (never tags; workflows tag/publish). It is not the
   live complete-release command. Direct-release is `pipeline release VERSION`.
5. **Self-host pin/install (historical as a ship tail)** — `pipeline engine-promote --for X.Y.Z`
   remains a separate operator command: verify GitHub Release, promote production
   pin, install exact tag, verify version. Generic install/verify failure does not
   roll the pin back; use `pipeline factory-pin rollback`. Live ship-final-delegation
   does not promote or install.

## What stays in core

- FRG / `factory-gate` / `factory-pin` CLI used for release quality of this repo
- Dependency discovery, loop engine, merge gates
- Grok `grok-4.6` model pins in `.github/pipeline.yml` when that is the configured profile

## Historical pilot docs

Older pilot design and host runbooks may remain as **historical** notes only.
They are not the install or startup path.

## Historical thin ship and optional-FRG (2026-08-10)

This 2026-08-10 sequence is **historical**. It is not the live procedure.
Historical milestone ship used `train --merge` → `release --skip-frg` →
`release finish` → `engine-promote --skip-frg`. Live ship-final-delegation is
`train --merge` then exactly one complete `pipeline release VERSION` call.
Direct-release is that same complete owner. Neither live path deploys, promotes,
or installs. Historical factory-pack FRG (`factory-gate` / durable
`factory-release prepare`) is not the live exact-candidate proof.
