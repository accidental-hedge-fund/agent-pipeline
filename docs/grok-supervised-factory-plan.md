# Historical: Hermes/Buzz scoped factory pilot

> **Removed from the product tree (2026-08-09).**  
> The `ops/hermes-factory` deployment profile is no longer shipped.  
> See [factory-simplification-plan.md](./factory-simplification-plan.md).

This filename is kept for link continuity. The pilot used a private Buzz channel,
a Hermes gateway, and a machine-local grant wrapper that sequenced
`pipeline single`, `pipeline merge`, FRG, and release for one self-hosted train.

Do not reintroduce that outer control plane as the open-source factory path.
Compose the Pipeline CLI instead, and implement integrate trains in
agent-pipeline (`pipeline train --merge` direction).
