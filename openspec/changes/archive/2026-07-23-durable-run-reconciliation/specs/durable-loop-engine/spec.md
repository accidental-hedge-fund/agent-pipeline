## REMOVED Requirements

### Requirement: Reconciliation SHALL record caller-observed truth and report drift without resolving it

**Reason**: Superseded by the new `durable-run-reconciliation` capability (goal-loop#3 / #511). The
#508 port deliberately took a first cut in which the engine accepted an observed-truth document
**supplied by the caller**, read no external system itself, and reported drift without resolving it.
That leaves a correctness hole for a durable, cross-engine, restart-surviving run: a caller-supplied
claim can drive a remote-proving transition it never actually proved. The replacement reads the live
GitHub / git / checks truth itself through an engine-owned injected seam, binds each item to a
structured external identity, classifies drift into a closed typed set, repairs benign forward
catch-up drift while surfacing every over-claim, and refuses any transition into a remote-proving
state that lacks a fresh verified identity.

**Migration**: The reconciliation behavior moves to the `durable-run-reconciliation` capability. The
ledger's existing reconciliation fields (`last_reconciliation`, `reconciliation_sequence`) are reused
and given a typed shape; the injected-seam, no-real-I/O **test** discipline is preserved (the live
read is an engine-owned seam, not a caller claim). The `durable-loop-engine` merge-barrier
requirement is unchanged — its clearing condition ("a reconciliation whose observed truth reports a
base commit and includes the barrier's merged SHA") is now satisfied by verified live truth rather
than a caller-supplied claim.
