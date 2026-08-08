## Why

Agent Pipeline can implement and review its own work, but the documented operator flow stops before integration, release publication, and installation of the new engine. A private Hermes supervisor needs one bounded authority grant so it can finish an exact release without requiring the operator to watch every pull request.

## What Changes

- Add a disabled-by-default, deployment-scoped factory profile for Hermes on `agent-box` with Buzz access, one active release scope, and an explicit issue order.
- Define a signed operator grant as the authority for exact issue merges, one exact release-PR merge, release verification, production-pin promotion, exact-tag installation, and rollback.
- Keep ordinary Pipeline commands and the advance state machine unchanged: they still stop at `pipeline:ready-to-deploy`, and `pipeline merge` remains the only issue-PR merge surface.
- Drive dependency-bearing work as one-item waves. Require verified merge-result containment in the configured base before the next item starts.
- Automate the representative FRG, release preparation, tag and GitHub Release verification, and two-track engine promotion without adding an MCP server or a new Pipeline telemetry service. For the v1.33.0 pilot only, unsafe fault classes use candidate-commit-bound Layer A probes while fresh issues and their exact Pipeline loop provide the live proof. Issue #908 replaces this temporary hybrid in v1.34.0 after #890 and #891.
- Ship #898 as the stable bootstrap wrapper in v1.33.0. After the first install, the same wrapper derives each release from the verified installed production pin and fresh `main`, then invokes the exact candidate-native `pipeline factory-release prepare --request <absolute-request.json> --json` interface as an idempotent two-call protocol. The first call returns `awaiting_frg_attestation` with unsigned artifact identities, the wrapper attests through trusted production code, and the second call returns the complete release pull request. A release install must leave the next release runnable without a manual wrapper or config replacement.
- Do not automatically pass the FRG key or its path to candidate code through its environment, inherited file descriptors, candidate-action credential mount, request, result, log, or notice. The existing scorer unit runs a fixed wrapper-local attestor with no child process, candidate import or execution, request-selected import, or network access. It uses the pinned #898 policy snapshot for v1.33.0 and the verified current production signer for later releases. This process split is not privilege separation from `mcomardo` or passwordless sudo; #618, #899, or later hardening owns that boundary.
- Send material existing Pipeline events and bounded heartbeats to one private Buzz thread per run.
- Document the pilot trust boundary, stop rules, secret handling, rollback, and later privilege-isolation work.

## Capabilities

### New Capabilities

- `scoped-autonomous-factory-operations`: Defines the signed release scope, one-item integration loop, FRG and release finalization, Buzz monitoring, exact-tag self-update, and rollback behavior for the disabled factory profile.

### Modified Capabilities

- `merge-authority-boundary`: Recognizes an authenticated, immutable, expiring operator grant as explicit authority for the exact factory mutations named by that grant, while preserving the operator-only default.
- `merge-sub-command`: Treats a scoped factory delegate as an authorized operator caller while keeping the command separate from `advance`.
- `pipeline-state-machine`: Preserves the ready-to-deploy terminal stage and permits a separate granted supervisor to invoke merge after that terminal state.
- `pipeline-configuration`: Keeps `auto_merge` invalid and makes clear that deployment-scoped authority is not repository configuration.
- `release-sub-command`: Keeps release preparation prepare-only, defines the candidate-native handoff that #908 adds in v1.34.0, and allows a separate granted finalizer to merge the exact prepared release PR.
- `release-auto-tag-on-merge`: Treats either a direct maintainer merge or a valid scoped factory grant as release-merge authority.
- `merge-queue-release-when-complete`: Keeps this command prepare-only while allowing a separate granted finalizer to continue from the open release PR.
- `factory-reliability-gate`: Preserves label or milestone selector provenance through native loop compilation, adds a fresh versioned pack definition, and defines the narrow v1.33.0 hybrid proof rule.
- `plan-review-authority-boundary`: Distinguishes a signed operator delegation from plan-review evidence and records it as the human approval for the named later mutations.
- `readme-user-clarity`: Distinguishes default stop-at-ready behavior from the opt-in scoped factory deployment.

## Impact

- Repository policy and operator documentation: `AGENTS.md`, `CLAUDE.md`, `README.md`, `ROADMAP.md`, and factory runbooks.
- New deployment assets and runbooks for Hermes, Buzz, systemd user services, monitoring, FRG, release finalization, engine promotion, and rollback.
- GitHub milestones, issue metadata, and future roadmap issues.
- Live `agent-box` and Buzz configuration. The v1.33.0 bootstrap introduces no new public Pipeline command, wire protocol, MCP server, or default auto-merge setting. Issue #908 later adds only the narrow candidate-native prepare command defined above.
