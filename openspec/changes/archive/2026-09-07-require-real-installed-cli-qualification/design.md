## Context

The matrix inventory is complete and commit-bound, but in-flight ship currently maps that declaration directly into `passed: true` executed rows. The nominal installed-CLI test does not spawn a CLI. Factory-release therefore reaches remote fixture creation before encountering process, linkage, lease, observer, and durable-state composition faults.

## Goals / Non-Goals

**Goals:**

- Make installed-CLI execution a machine-verifiable fact rather than a naming convention.
- Catch deterministic orchestration faults before GitHub fixture mutation.
- Feed the existing executed-row binder and RecoverySupervisor ownership model; add no second scheduler.
- Preserve one exact pack for remote canary replay.

**Non-Goals:**

- Simulating GitHub or model quality as part of deterministic qualification.
- Changing Grok/Codex routing, merge authority, or release authorization.
- Treating a local probe as the entire FRG; the remote pair remains a final canary.

## Decisions

1. Add a closed internal qualification probe accepted by the real CLI only with a versioned absolute fixture document. Each required command retains its real first positional route; the probe intercepts immediately before external dependencies and can only emit bounded output, exit abnormally, signal itself, or wait for the parent timeout. This exercises the packaged launcher, Node bootstrap, parser, and route selection without credentials or mutations. A direct simulator was rejected because that is the existing defect.
2. A trusted parent runner creates the fixture, spawns every required operation/fault route through the staged launcher, observes exit/signal/timeout/stdout, and validates structured state results. It also runs the staged candidate's complete core suite so command-specific adapters and supervisor behavior remain covered. The child never emits `passed: true`; any route or suite failure blocks qualification.
3. Qualification emits executed rows only for a closed representative equivalence set: one concretely observed fault for each lifecycle class at each required coverage layer. It does not manufacture operation-specific lifecycle rows from a common supervisor observation. The exhaustive operation/fault probes are blocking safety checks, while the representative rows are the narrower evidence credited by FRG.
4. Store `installed-cli-qualification.v1.json` beneath the control-host run store, keyed by exact candidate SHA and matrix version. Canonical JSON excluding the digest is SHA-256 hashed; consumers recalculate it and validate the complete route proofs, staged-suite proof, and representative row set before returning rows.
5. Keep static inventory as expectation data only. Delete the in-flight fallback that converts inventory rows to executed rows. Factory-gate consumes host-run rows plus validated qualification rows through the existing binder.
6. Factory-release prepare calls qualification before `generateUnsignedFrg`, the first path that can create fixtures. Tests inject the runner. Production uses the candidate invocation already bound by the ship request. A valid existing artifact is re-observed and reused.
7. Same-candidate failures retain the active version/pack checkpoint for replay rather than disposing it and minting a replacement. Even a changed request/action identifier cannot create a successor for the same candidate. Candidate movement preserves current supersession cleanup but gates the successor on new qualification.

## Risks / Trade-offs

- [The process matrix and complete staged suite add CI time] → Batch structured recovery cases, reserve separate processes for exit/signal/timeout observations, and run the remote canary only after deterministic qualification passes.
- [An internal probe could become an unsafe production backdoor] → It accepts only a closed schema, performs no external operation, requires an absolute fixture path, strips credentials, and is omitted from public help.
- [A launcher probe cannot prove live GitHub semantics] → Keep the existing one-pair remote canary after qualification.
- [Representative rows could be mistaken for exhaustive operation-specific execution] → Keep all operation/fault route probes blocking, require the complete staged core suite, and credit only the explicitly enumerated lifecycle/layer representatives.
- [Artifact forgery] → Bind exact candidate, complete route and suite proofs, the closed representative set, launcher identity, matrix version, canonical digest, and trusted control-host path; never accept candidate-authored `passed` booleans without parent process proof.

## Migration Plan

Ship producer and consumer together. Existing inventory-only fallback disappears immediately, so releases fail closed until qualification runs. Rollback restores the prior fallback but should be used only by reverting the complete change, never by an environment flag.
