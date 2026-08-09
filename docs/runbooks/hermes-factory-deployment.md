# Historical: Hermes factory deployment runbook

> **Removed from the product tree (2026-08-09).**  
> The repository no longer ships `ops/hermes-factory`, systemd unit templates,
> grant envelopes, or the hybrid FRG attestor package.

If a host still has a local install under
`~/.local/lib/hermes-factory` or user-systemd units named `hermes-factory*`,
that is machine-local leftover from the pilot. Disable those units for new work.
Do not re-copy them from this repository — the sources are gone.

Product direction: [factory-simplification-plan.md](../factory-simplification-plan.md).
