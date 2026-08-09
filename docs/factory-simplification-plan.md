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
- Merge is loop-isolated: `pipeline merge`, `pipeline merge-queue --apply`.
- A future `pipeline train --merge` is the planned integrate-train surface.
- No `auto_merge` config key. `.github/pipeline.yml` cannot authorize merges.
- External supervisors may call loop-isolated commands under operator authority.

## Phases

1. **Remove pilot tree** (this cleanup) — drop `ops/`, CI coupling, grant-centric docs.
2. **`pipeline train --merge`** — integrate between issues in agent-pipeline (OpenSpec: integrated train mode).
3. **Thin supervisor skill** — Buzz/Hermes (or any host) parses intent and invokes CLI only.
4. **Release finish** — authorized completion after prepare-only `pipeline release` (optional).
5. **Self-host pin/install** — optional later; not required for ordinary trains.

## What stays in core

- FRG / `factory-gate` / `factory-pin` CLI used for release quality of this repo
- Dependency discovery, loop engine, merge gates
- Grok `grok-4.5` model pins in `.github/pipeline.yml` when that is the configured profile

## Historical pilot docs

Older pilot design and host runbooks may remain as **historical** notes only.
They are not the install or startup path.
