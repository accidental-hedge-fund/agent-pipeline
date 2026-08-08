## Context

Agent Pipeline already provides the implementation, review, merge, FRG, release-preparation, tag, GitHub Release, and production-pin commands that this factory needs. The missing part is an operator-facing supervisor that composes those commands for one exact release and remains reachable while the work runs.

The first deployment runs Hermes on `agent-box`. Hermes uses the native Buzz gateway and the private `pipeline-factory` stream. The operator sends a Buzz message that names one repository, base branch, release version, ordered issue list, expiry, and allowed mutations. The pinned gateway supplies the relay-observed sender and message context to the same-user wrapper. The wrapper validates that context and scope but does not independently verify the Nostr signature. Hermes uses the installed Pipeline CLI and existing GitHub CLI. Grok performs planning, implementation, and fixes with `grok-4.5`. Codex performs review.

The pilot accepts that the existing `mcomardo` host account and passwordless sudo have broad local authority. A malicious same-user process can read or control local resources. The profile is disabled by default, but #898 does not claim that a prompt, file permission, process split, or cgroup creates privilege separation from that account. Its narrower control prevents automatic FRG credential propagation to a candidate action and keeps candidate code out of the trusted attestor. Issues #618, #899, or later hardening own a stronger privilege boundary.

## Goals / Non-Goals

**Goals:**

- Let one operator grant start and finish one exact release without a merge-by-merge wait.
- Use existing Pipeline CLI surfaces for the v1.33.0 bootstrap. Do not add an MCP server or general public factory API. Keep #908's later candidate-native command narrow and prepare-only.
- Keep `pipeline advance` and `pipeline loop` terminal at `pipeline:ready-to-deploy`.
- Make dependent work see all required earlier merges by running one item, merging it, proving base containment, and then starting the next item.
- Run the full FRG outcome, prepare and merge the exact release PR, verify the tag and GitHub Release, promote the production pin, and install the exact new tag on `agent-box`.
- Keep the #898 wrapper usable across releases. After each verified install, derive the next release from the installed production pin and fresh `main` without a manual wrapper or config replacement.
- Send useful progress to Buzz from existing event streams and service logs.
- Stop safely on ambiguity, scope drift, failed gates, expired authority, or a stop message.

**Non-Goals:**

- A new v1.33.0 Pipeline state machine, scheduler, command, wire protocol, MCP server, or telemetry service. The narrow #908 candidate handoff is later v1.34.0 work.
- A general unattended-merge configuration key.
- Multi-repository or multi-release concurrent execution.
- Strong credential isolation from the accepted pilot host account.
- Automatic disposition of `pipeline:needs-human`, release waivers, or failed FRG evidence.

## Decisions

### 1. Hermes is the operator delegate, not a second Pipeline engine

Hermes owns the long-lived conversation, the active grant, command sequencing, and progress summaries. Each issue still moves through Agent Pipeline. Pipeline and GitHub remain the sources of truth for issue stages, pull requests, checks, FRG evidence, tags, releases, and pins.

The deployment stores a small local journal under `~/.local/state/hermes-factory/`. The journal stores the grant hash, Buzz event identity, current step, command result, and observed GitHub identities. It is a restart aid, not a second issue or stage ledger. On restart, Hermes reads live Pipeline, git, and GitHub state before it continues.

### 2. Relay-observed Buzz context grants a closed release scope

The Buzz relay accepts signed Nostr events, and the native Hermes Buzz gateway filters the configured operator public key and private stream. The pinned gateway passes the sender, channel, message, thread, and creation identities to the Hermes turn. The deployment wrapper validates those exact context fields and the grant scope, but it does not independently verify the Nostr signature. Because Hermes and the wrapper run as the same pilot user, this context handoff is part of the accepted same-user trust boundary. The grant contains:

- schema version and nonce;
- repository identity and base branch;
- exact release version and ordered issue numbers;
- allowed actions: issue advance, issue-PR merge, FRG, release prepare, exact release-PR merge, release verification, pin promotion, exact-tag install, and rollback;
- `grok-4.5` as the required Grok model;
- issue and time limits;
- issue time, expiry time, Buzz channel, sender key, and event ID.

The factory derives a stable grant ID from the relay-observed message ID and canonical grant content. A replay resumes the same scope. A different active grant, a changed field, an expired grant, or a sender/channel mismatch stops the run. The wrapper rejects scope that is absent from the grant. This pilot does not claim that its in-process model-to-wrapper handoff is a cryptographic or OS privilege boundary.

### 3. The issue train uses one-item integration waves

The factory does not use one milestone-wide `pipeline loop` for dependency-bearing startup work. For each issue in the grant order it:

1. confirms that all prior issues in the grant are merged and that their observed merge-result commits are contained in a freshly fetched `origin/<base>`;
2. invokes the installed Pipeline command for that single issue and follows its existing event stream until a terminal result;
3. stops on `pipeline:needs-human`, a blocker, a failed required gate, or any ambiguous result;
4. resolves the linked PR and records the inspected PR head;
5. invokes `pipeline merge <pr>` only after the issue reaches `pipeline:ready-to-deploy`;
6. reads the merged PR again, confirms that its merge-time head equals the inspected head, records `mergeCommit.oid`, fetches the base, and proves that the fetched base tip equals that merge result for this frozen train;
7. starts the next issue only after that proof passes.

For a squash merge, the candidate head is identity evidence and `mergeCommit.oid` is containment evidence. The design does not require the candidate head itself to be an ancestor of the base.

### 4. The ordinary Pipeline safety boundary remains the default

The factory does not add an `auto_merge` configuration key and does not call merge from an advance stage. `pipeline advance`, `pipeline single`, and `pipeline loop` still stop at ready-to-deploy. `pipeline merge` remains the issue-PR merge primitive and keeps its existing clean-state, check, stage, and exact-head gates.

The signed grant is an explicit operator authorization for a separate deployment profile. Repository users who do not install and enable that profile keep the current operator-invoked behavior.

### 5. Release finalization composes the existing release system

For v1.33.0 only, the stable #898 wrapper uses the temporary hybrid FRG and the existing prepare-only release command. After all granted issues are contained in the base, the factory:

1. runs the representative FRG for the exact release version without giving candidate code the FRG attestation secret, then has the fixed trusted attestor validate and sign the result;
2. prepares the release with `pipeline release <version> --no-edit` from a clean, current checkout of the configured base;
3. resolves the one release PR, binds its repository, base, title version, package version, FRG identity, and exact head, and waits for clean mergeability and required checks;
4. merges that exact head with GitHub's exact-head guard because `pipeline merge` correctly requires a linked ready-to-deploy issue and therefore does not accept a release PR;
5. waits for the existing auto-tag and release workflows;
6. proves that the annotated tag peels to the release merge commit and that a non-draft GitHub Release exists for the same tag;
7. promotes the verified version to the production pin, installs the exact tag on `agent-box`, and runs `pipeline doctor` in the same service environment;
8. records the installed version and executable path so the next run uses the new Pipeline build.

The release prepare command stays prepare-only. The factory finalizer is a separate consumer of the signed grant. A release with an FRG waiver, open soak-defect override, tag conflict, version mismatch, changed head, failed check, or ambiguous merge result stops for the operator.

The #898 wrapper is not a one-release script. For each release after v1.33.0, it first proves that the installed Pipeline launcher, production pin, tag, and commit agree. It then fetches current `main` and derives the starting frontier and final integrated candidate from that fresh state. It SHALL NOT reuse a static `bootstrap_base_git_sha` or static `candidate_version` as authority for a later release.

Issue #908 ships in v1.34.0 after #890 and #891. It exposes this exact candidate-native command from the integrated candidate checkout:

```text
pipeline factory-release prepare --request <absolute-request.json> --json
```

The stable wrapper supplies a versioned, secret-free request that binds the active grant, verified production pin, current base, exact integrated candidate, and release scope. The command is an idempotent two-call protocol. The first call runs without the FRG signing credential and returns `awaiting_frg_attestation` with the unsigned artifact identities and digests. It SHALL NOT open the release pull request at this point. The wrapper then sends a closed attestation request to the existing scorer unit. After the wrapper stores the verified attestation, a second call with the unchanged request prepares or reconciles one release pull request and returns `complete` with its exact identity and head. Repeated calls at either checkpoint return the same proved state and do not create another pack, attestation, branch, or pull request.

The scorer unit loads the FRG credential and runs only a fixed wrapper-local trusted attestor. That attestor SHALL NOT start a child process, use the network, or import code selected by the request. The request contains only its versioned identity fields, wrapper-approved closed data paths, and expected digests. It contains no executable path, module name, command, or caller-authored pass claim. The attestor reads and scores the bound artifacts itself. For v1.33.0 it uses the pinned #898 policy snapshot. For each later release it uses only the signer from the verified current production engine through a wrapper-owned closed selection rule. An unsupported request schema, evidence schema, or policy stops before signing.

The factory does not place the FRG key or its path in the candidate environment, inherited file descriptors, the candidate-action cgroup's credential mount, a request, a result, an error, a log, or a notice. The trusted attestor does not import or execute candidate code, accept request-selected imports, start child processes, or use the network. These controls prevent automatic propagation and candidate-selected attestor behavior. They do not stop a malicious process with the accepted `mcomardo` or passwordless-sudo authority from reading or controlling local resources. The candidate command owns fresh FRG production and prepare-only release work, but it does not gain attestation, release-PR merge, publication, pin, install, or rollback authority. The wrapper keeps those actions under the grant. Issue #909 also ships in v1.34.0 after #890 and #891. Installing a verified release updates the Pipeline engine and trusted production signer used by the next run, but does not require an operator to replace the stable wrapper or edit its release identity.

### 6. Buzz is the access and progress surface

Hermes uses its native Buzz gateway on `agent-box` and a dedicated Nostr identity. The gateway watches only `pipeline-factory`, requires a mention, and accepts control messages only from the configured operator public key. The deployment pins Hermes and the Buzz CLI.

The factory sends run start, issue start, stage change, PR ready, merge result, FRG result, release PR, tag, release, install, rollback, stop, and failure messages. It also sends a bounded heartbeat while a command has no material event. Existing Pipeline JSONL events, the shared material filter, and `journald` provide the source data. Notification failure does not change Pipeline state or authorize an action.

### 7. Stops, restart, and rollback are explicit

A signed stop or revoke message prevents every new forward mutation. The current subprocess receives a bounded graceful-stop interval and is then terminated if needed. If pin promotion or installation already changed production state, the wrapper may use only the grant's rollback action to restore the stored prior pin and exact tag and to run doctor. It then stops. The factory stops on expired authority, model drift, repository/base drift, issue-set drift, an unexpected pull request linked to the current issue or release, failed checks, `needs-human`, FRG failure, release mismatch, credential failure, or an unverified result. An unrelated open pull request does not widen the grant and does not block the frozen train; any unrelated merge still fails the exact base-frontier check.

On restart, the factory replays its local journal, then reconciles each recorded command against GitHub, git, Pipeline run evidence, and installed-version evidence. It never repeats an ambiguous mutation until it proves whether the first attempt completed.

Rollback installs the last verified production pin and re-runs doctor. It does not rewrite published tags or releases and does not undo merged issue work.

### 8. The deployment is reproducible but machine secrets stay local

The repository contains version-pinned examples, systemd user-unit templates, a factory skill/runbook, grant examples, and validation scripts. It does not contain the Buzz private key, GitHub token, FRG attestation key, channel identifier, operator public key, or local host addresses. Secret files use service-owned mode `0600` or systemd credentials.

The service command uses the exact installed Pipeline launcher. It does not use the known stale `/usr/local/bin/pipeline` link. The service environment sets an explicit PATH that contains Grok, Codex, Node, GitHub CLI, Hermes, and the Buzz CLI.

## Risks / Trade-offs

- **Same-user privilege:** Hermes can reach the pilot account's GitHub credential, and `mcomardo` has broad local authority through passwordless sudo. Prompt limits, file modes, cgroups, and the Buzz context handoff are not a cryptographic or OS security boundary. The pilot accepts that a malicious same-user process can read or control local resources. #898 prevents automatic FRG credential propagation and keeps candidate code out of the attestor; it does not prove same-user confidentiality. Issues #618, #899, or later hardening must provide stronger privilege separation.
- **Buzz outage:** The operator may lose chat progress while the factory still runs. `journald`, local run state, and direct SSH status remain available. A Buzz delivery error never implies a Pipeline failure.
- **Release-path ambiguity:** The v1.33.0 bootstrap release preparation is not a durable native controller. The local journal and live reconciliation reduce duplicate actions, but the factory stops instead of guessing after an ambiguous release mutation. Starting with v1.34.0, #908 owns the candidate-native durable FRG and prepare phase.
- **Candidate evidence is untrusted:** A candidate can produce malformed or hostile evidence. The wrapper-owned attestor treats every candidate field as data, accepts only closed paths and digests, recomputes the policy result, and never exposes the signing key or a code-loading surface.
- **One-item throughput:** Sequential waves are slower than a milestone-wide loop. They give each dependent issue a base that contains all prior granted work.
- **External deployment drift:** Hermes and Buzz interfaces can change. Exact artifact pins and a live calibration test limit this risk.
- **Bootstrap merge binding:** The pinned v1.31.1 `pipeline merge` command fetches a fresh head and passes that value to `gh --match-head-commit`. The wrapper checks the same head immediately before the call and verifies the retained merge-time head after it. The command cannot accept the wrapper's earlier candidate as an input, so a small check-to-command race remains for the first train. The pilot records this limit. Issue #900 owns one caller-bound exact-head mutation path. The factory must not switch issue merges to unpassed candidate code to hide this gap.

## Migration Plan

1. Land the policy, OpenSpec, deployment files, and runbook with the factory disabled.
2. Rebase every open GitHub issue into one strict SemVer release milestone. Keep theme labels only as secondary scope labels.
3. Create the private `pipeline-factory` Buzz stream and a dedicated Hermes Nostr identity.
4. Fix agent-box split DNS for the Buzz host and install the pinned Hermes and Buzz CLI artifacts.
5. Install and enable the user services, then run status-only and stop/restart calibration.
6. Keep the existing v1.31.1 production pin for the first live grant. Do not promote v1.32.0 because its committed FRG notes disclose test-only overrides. Use the clean v1.32.0 `main` checkout as the code base for v1.33.0 work.
7. Land the disabled #898 factory capability, then accept one scoped grant for the ordered `v1.33.0` issue train.
8. Run the train, FRG, release finalization, pin promotion, exact-tag installation, and doctor smoke.
9. Prove that the stable wrapper can start from the verified v1.33.0 production pin and fresh `main` without a wrapper or config replacement.
10. In v1.34.0, land #890 and #891 before #908 and #909. Require #908 to expose the exact two-call candidate-native prepare command, preserve the production-owned signing boundary, and pass the two-release continuity test.
11. Prepare and install v1.34.0 through that candidate command, then prove that the next grant uses v1.34.0 as its production engine and starting base.
12. Disable the factory and revoke its Buzz identity if calibration or a live run violates any stop rule.

Rollback disables the user services, removes the Nostr identity from the channel, restores the prior pinned Hermes image/config, and reinstalls the last verified Pipeline production pin. Published GitHub history is not rewritten.

## Resolved Deployment Details

- The current native loop compiler loses label and milestone selector provenance, and the existing FRG has no production observation collector. This change fixes selector preservation and adds a versioned fresh pack plus an evidence-derived collector. The pilot SHALL NOT reuse v1.32.0's test-only override path.
- The shipped CLI has no safe production fault seam for process death, forge 5xx, CI red-to-green, stale pull requests, or forced recoverable outcomes. The v1.33.0 pilot therefore uses a narrow hybrid proof. Two fresh manifest issues and their exact candidate Pipeline loop provide live issue, throughput, taxonomy, pull-request, check, and OpenSpec proof. A closed manifest list of exact candidate-commit-bound Layer A tests provides the unsafe fault proofs. The producer labels each proof source and binds the candidate commit, manifest, loop, issue set, and proof digests into the FRG attestation. This exception applies only to v1.33.0 and expires into #908. It does not claim that a Layer A probe is a live fault injection.
- The #908 replacement ships in v1.34.0 after #890 and #891 and is invoked twice as needed with the unchanged `pipeline factory-release prepare --request <absolute-request.json> --json` request from the exact integrated candidate. The first proved result is `awaiting_frg_attestation`; only the post-attestation call may return a complete release pull request. The wrapper SHALL NOT extend the v1.33.0 hybrid when the candidate command is missing or fails.
- The factory SHALL NOT place the FRG signing credential or its path in the candidate environment, inherited file descriptors, the candidate-action cgroup's credential mount, request, result, log, or notice. The existing scorer unit SHALL run a fixed wrapper-local attestor without child-process, network, candidate import or execution, or request-selected import capability. The v1.33.0 attestor uses the pinned #898 policy snapshot. Later attestations use the verified current production signer, selected independently of candidate input, and reject an unsupported schema or policy. Attestation requests contain only closed data paths and digests, never executable paths or pass claims. This is a non-propagation control, not privilege separation from the accepted `mcomardo` and passwordless-sudo authority; #618, #899, or later hardening owns that boundary.
- Hermes v2026.8.3 does not provide a durable inbound Buzz cursor across a full gateway restart. A grant or control command is accepted only after the factory posts a threaded receipt that names its stable action identity. No receipt means the operator resends the same signed command; idempotent reconciliation handles duplicates.
- `AGENT_PIPELINE_PRODUCTION_PIN` SHALL point to `/home/mcomardo/.local/state/hermes-factory/production-engine-pin.json` for the pilot. The factory SHALL record and use that exact external path. It SHALL not rely on an unrelated checkout's implicit pin file.
- The wrapper artifact commit and the release-candidate commit are different identities. The wrapper commit is the exact merged #898 source used for the deployed service. The candidate commit is not known at grant admission. After the last granted issue merge, the factory SHALL fetch the base, record its exact integrated commit, create or verify a clean run-confined checkout at that commit, and use that checkout for FRG and release preparation. No receipt may label later integrated code with the older wrapper commit.
- The #898 wrapper commit remains the stable deployment wrapper after v1.33.0. Each later run derives its starting base from the verified installed production pin plus freshly fetched `main`; static bootstrap-base and candidate-version values SHALL NOT select later release identity. A verified install must leave the next release runnable without replacing the wrapper or editing its config.
