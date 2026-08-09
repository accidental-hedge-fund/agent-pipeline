# Hermes/Buzz supervised factory plan

> **Startup architecture superseded (2026-08-09).**  
> Product direction is the [factory simplification plan](./factory-simplification-plan.md):  
> freeze growth of `ops/hermes-factory`, implement `pipeline train --merge` in agent-pipeline,  
> and keep Hermes as a thin Buzz adapter. This file remains as the **pilot design record**  
> and deployment history for the scoped grant wrapper. Do not extend it as the foundation  
> for the next factory release.

This file keeps its original name for link continuity. It describes the Hermes/Buzz **pilot** factory plan (scoped grant wrapper).

Use [the deployment runbook](runbooks/hermes-factory-deployment.md) for the exact
host commands, the accepted same-user trust boundary, calibration, and rollback.

The pilot factory is a disabled-by-default deployment wrapper for `agent-pipeline`. Hermes coordinates one exact release. Pipeline and GitHub remain the sources of truth. This plan does not add a Pipeline stage, scheduler, MCP server, public factory API, or `auto_merge` setting.

Until the scoped factory change is implemented, reviewed, and calibrated, the normal rule stays in force: `pipeline advance`, `pipeline single`, and `pipeline loop` stop at `pipeline:ready-to-deploy`, and an operator performs each merge.

## Operating roles

- Hermes owns the long-running session, the active grant, command order, restart reconciliation, and progress reports.
- Pipeline owns issue stages, worktrees, checks, review, fix rounds, evidence, and the ready-to-deploy result.
- GitHub owns pull-request, merge, tag, workflow, and release state.
- Grok does planning, implementation, and fixes with only `grok-4.5`. There is no Grok fallback.
- Codex is the independent reviewer.
- Buzz is the private control and progress channel. Buzz is not a state store and is not a Pipeline gate.

## Trust and authority boundary

The factory accepts an action only from one Buzz message context that the native
gateway observed for the configured operator and private `pipeline-factory`
stream. The message must mention the dedicated Hermes identity. The wrapper
checks the observed sender, channel, message, thread, and time fields. It does
not independently verify the Nostr signature. Hermes and the wrapper share the
same pilot user, so this handoff is an accepted pilot risk.

The immutable grant binds all of these values:

- schema version, nonce, issue time, expiry time, sender key, channel, and Buzz event ID;
- repository, base branch, release version, and ordered issue list;
- allowed actions, issue limit, time limit, and required model;
- issue advance, issue-PR merge, FRG, release preparation, exact release-PR merge, publication verification, pin promotion, exact-tag install, and rollback, when each action is explicitly present.

Hermes derives one stable grant fingerprint. A replay resumes that grant. A changed field, second active grant, expired grant, or sender/channel mismatch stops before the next mutation. A prompt, display name, repository file, or tool argument cannot widen the grant.

The pilot has a known weak boundary. Hermes runs as the `mcomardo` user and can reach that account's existing GitHub credential. The grant limits correct factory behavior, but it is not a strong credential boundary. The profile stays disabled when no grant is active. A later broker or separate account must provide stronger privilege isolation.

Secrets stay on the host in service-owned mode `0600` files or systemd credentials. Do not put the Buzz private key, GitHub token, FRG key, channel identifier, operator key, host address, secret values, raw prompts, or model output in the repository, journal, prompt, or Buzz message.

## Preflight and calibration

Before the first live grant:

1. Keep the factory disabled.
2. Resolve the stranded state for issue #891 before an install or roadmap action can affect it.
3. Install the approved pinned Hermes and Buzz artifacts. The current deployment targets Hermes v2026.8.3 and Buzz v0.5.2.
4. Use the exact installed Pipeline launcher and an explicit service `PATH`. Do not use the stale `/usr/local/bin/pipeline` link.
5. Prove DNS, TLS, NIP-42 authentication, private-stream membership, authorized send and receive, mention gating, and operator-key rejection.
6. Prove that every Grok role reports `grok-4.5` and that Codex is the reviewer. Stop if the provider omits or changes the effective model.
7. Run `pipeline doctor --json --harness-smoke` in the exact service environment.
8. Test status, stop, restart, notification redaction, and rollback with no GitHub mutation.
9. Put a canary in each secret input. Confirm that no Buzz message, journal record, service log, prompt, or committed file contains it.

## One-item integration waves

Do not start dependency-bearing work with one milestone-wide loop. Each issue must build from a base that contains all earlier granted work.

For each issue in the grant order:

1. Revalidate the grant and reconcile the local journal with live Pipeline, git, and GitHub state.
2. Fetch `origin/<base>`. Prove that every earlier pull request's observed merge-result commit is an ancestor of that fetched base.
3. Run `pipeline single <issue>` and follow its Pipeline event stream to a terminal result.
4. Stop on `pipeline:needs-human`, a blocker, a failed required gate, model drift, or an ambiguous result.
5. After `pipeline:ready-to-deploy`, resolve the one linked pull request and record its current head SHA.
6. Revalidate the grant, then invoke `pipeline merge <pr>`. Do not use raw GitHub merge, force merge, merge queue apply, or a merge inside the advance path for an issue pull request.
7. Read the merged pull request again. Require its merge-time head to equal the inspected head. Record that pull request's `mergeCommit.oid`.
8. Fetch the base again. For this frozen first train, require the `origin/<base>` tip to equal `mergeCommit.oid`. Stop if another commit advanced the base.
9. Start the next issue only after that proof passes.

For squash merges, the pull-request head proves candidate identity. The merge-result commit proves base containment. The candidate head does not have to be an ancestor of the base.

The first train uses the pinned v1.31.1 `pipeline merge` command. That command reads a fresh head and supplies it to `gh --match-head-commit`. The wrapper checks the same head immediately before the call and verifies the retained merge-time head after it. It cannot pass its earlier head into v1.31.1, so the first train has a small check-to-command race. This is an explicit pilot limit. Issue #900 owns the caller-bound replacement. Do not use unpassed candidate code for issue merges.

Issue #898 installs the disabled factory as part of v1.33.0. The first live
v1.33.0 grant then uses this exact order: #905, then #874, then #870. The #898
wrapper is the stable supervisor for later releases. Installing a new Pipeline
engine must not require a replacement wrapper or a manual release-identity
config edit.

## Fresh FRG and release

After all granted issue merges are contained in the base:

1. Fetch the base, record its exact final integrated commit, and create or verify a clean run-confined checkout at that commit. Keep this candidate identity separate from the deployed #898 wrapper commit.
2. Run a new representative FRG pack for the exact release version without giving candidate code the FRG signing key. For v1.33.0 only, use two fresh manifest issues and their exact Pipeline loop for live proof. Use only the closed manifest list of candidate-commit-bound Layer A probes for fault classes that the CLI cannot safely inject. Label those proofs `layer_a`; do not call them live injections. This exception ends after v1.33.0. Do not extend it when the later candidate interface is absent or fails.
3. Produce honest unsigned observations. Do not invent an observation, import a test override, use an open-soak-defect override, or reuse stale evidence. For v1.34.0 and later, the first `pipeline factory-release prepare --request <absolute-request.json> --json` call returns `awaiting_frg_attestation` with these artifact identities and digests.
4. Have the existing scorer unit run the fixed wrapper-local trusted attestor. It independently validates the unsigned artifacts and writes the attestation. For v1.33.0 it uses the pinned #898 policy snapshot. For later releases it uses the verified current production signer. Stop on an unsupported schema or policy.
5. For the v1.33.0 bootstrap only, run `pipeline release <version> --no-edit` from the clean candidate checkout after trusted attestation. For v1.34.0 and each later release, invoke the same candidate command with the unchanged request after attestation. It returns `complete` with one prepared release pull request. Both paths remain prepare-only. They do not merge, tag, or publish.
6. Resolve exactly one release pull request. Bind its repository, base, title version, package versions, FRG identity, allowed release-managed files, and exact head. Wait for clean mergeability and required checks.
7. Use the separate granted release finalizer to merge only that exact head. `pipeline merge` remains for issue pull requests and correctly rejects a release pull request with no linked ready-to-deploy issue.
8. On an ambiguous merge response, inspect live GitHub state. Do not retry until one safe result is proved.
9. Wait for the existing auto-tag and GitHub Release workflows. Require an annotated `vX.Y.Z` tag whose peeled commit equals the observed release merge commit. Require a published, non-draft GitHub Release for the same tag.
10. Only after publication proof, promote the production pin, install that exact tag on `agent-box`, and run `pipeline doctor --json --harness-smoke` in the service environment.
11. Record the pin, tag, release commit, installed version, and executable path. Confirm that the next factory run uses the new version.

A missing or stale FRG, changed head, extra file, failed check, waiver, tag conflict, version mismatch, draft or missing release, or publication mismatch stops the factory. The factory does not rewrite a tag or release to make evidence agree.

### FRG signing boundary

The factory does not place the FRG key or its path in the candidate
environment, inherited file descriptors, the candidate-action cgroup's
credential mount, a request, a result, an error, a log, or a notice. The
credential is available to the existing scorer unit. That unit runs a fixed
wrapper-local attestor. The attestor starts no child process, uses no network,
and does not import or execute candidate code or other request-selected code.

The pilot accepts that `mcomardo` and passwordless sudo have broad local
authority. A malicious same-user process can read or control local resources.
The #898 process split prevents automatic credential propagation and
candidate-selected attestor behavior. It does not provide privilege separation
from that account. Issues #618, #899, or later hardening own that boundary.

The attestation request contains only versioned identity fields, closed data
paths under fixed allowed roots, and expected digests. It contains no
executable path, module, command, network target, pass claim, or candidate
signer selection. The trusted attestor reads the evidence, verifies each
digest, computes the policy result, and returns only the bounded attestation.

The v1.33.0 scorer uses the policy snapshot pinned with #898. Each later
release uses the signer from the verified current production engine through a
wrapper-owned closed selection rule. An unsupported request schema, evidence
schema, signer, or policy stops before signing. A malicious candidate request
that names a key path, traversal, symlink escape, executable, import, command,
or network target must be denied without returning secret data.

## Self-build continuity

The temporary #898 hybrid can cut v1.33.0 only. The v1.34.0 train lands #890
and #891 before #908 and #909. Issue #908 supplies the exact candidate-native
interface:

```text
pipeline factory-release prepare --request <absolute-request.json> --json
```

For each release after v1.33.0, the stable wrapper must:

1. Prove that the installed Pipeline launcher, production pin, tag, and commit agree.
2. Fetch current `main` and derive the starting frontier from the verified pin plus that fresh base state.
3. Process the granted issue train and bind the final integrated candidate.
4. Invoke the exact candidate-native command from that candidate. Require `awaiting_frg_attestation` with unsigned artifact identities and digests. Do not use static `bootstrap_base_git_sha` or static `candidate_version` values as later release authority.
5. Attest the closed artifacts with the verified current production signer, then invoke the same command with the unchanged request. Require `complete` with one exact release pull request. Repeated calls must return the same checkpoint without duplicate mutations.
6. Complete the granted finalization, verify publication, promote the pin, install the exact tag, and pass doctor.
7. Start the next grant with the newly installed engine and the then-current `main`, without replacing the wrapper or editing release identity in its config.

A two-release integration test must start from the verified v1.33.0 pin,
exercise both #908 calls and the intervening trusted attestation, install
v1.34.0, and prove that the following grant uses v1.34.0 as its production
engine and starting base. It must also prove that the wrapper does not
automatically pass the key or key path through the candidate environment,
inherited file descriptors, candidate-action cgroup credential mount, request,
or result; that the attestor does not import or execute candidate code; and that
errors, logs, and notices redact the secret and its path.

## Monitoring through Buzz

Use one private `pipeline-factory` thread per run and one dedicated Hermes Nostr identity. The gateway accepts control only from the exact operator key and channel, and only when the Hermes identity is mentioned.

Send a short redacted update for these material events:

- run and issue start;
- Pipeline stage change;
- pull request ready;
- merge request and merge result;
- FRG result;
- release pull request, tag, and published release;
- pin promotion, install, doctor result, rollback, stop, and failure.

Send one bounded heartbeat only after the documented quiet interval has elapsed with no material event. Derive updates from Pipeline JSONL events, the shared material filter, GitHub observations, and service state. Do not send raw prompts, model output, environment values, credentials, or raw tool output.

Buzz delivery failure does not authorize, block, advance, or fail Pipeline. Local Pipeline evidence, the factory journal, `systemctl --user status`, `journalctl --user`, and direct SSH status remain the recovery sources.

## Stop, restart, and rollback

A valid stop or revoke event prevents every later forward mutation under the grant. Give the active subprocess a bounded graceful-stop interval, then terminate it if necessary. If pin promotion or installation already changed production state, permit only the granted rollback action that restores the stored prior pin and exact installed tag and runs doctor. Then stop. Report the last completed step and the first suppressed step.

Stop before the next mutation on any of these conditions:

- grant expiry, revocation, replay mismatch, or scope drift;
- repository, base, issue order, pull-request head, release, or model drift;
- unexpected pull request linked to the current issue or release, failed check, blocked state, or `pipeline:needs-human`;
- missing, stale, waived, unattested, or failed FRG evidence;
- ambiguous merge or release result;
- tag, GitHub Release, pin, installed-version, or executable-path mismatch;
- credential failure, failed doctor check, or unproved rollback.

An unrelated open pull request does not block the train. It grants no authority. If it or any other change reaches the base, the exact base-frontier check stops the factory.

The journal stores only the grant fingerprint, authenticated event identity, exact current target, Pipeline run identity, service unit, event cursor, action identity, and observed external result. It is a restart aid, not a second issue-stage ledger. After restart, reconcile every recorded step against live Pipeline, git, GitHub, release, pin, and installed-version state. Never repeat an ambiguous mutation until the first attempt's result is proved.

Rollback installs the last verified production pin and runs `pipeline doctor --json --harness-smoke` again. If rollback cannot be proved, remain stopped. Rollback does not revert merged issue work and does not rewrite GitHub history, tags, or releases. To disable the deployment, stop and disable the user services and revoke or remove the Hermes Buzz identity from the private stream.

## Release completion record

A factory release is complete only when the durable evidence identifies:

- the authenticated grant and exact ordered issue set;
- each inspected pull-request head, merge-result commit, and base-containment proof;
- the fresh FRG run and attestation;
- the exact release pull-request head and merge commit;
- the annotated tag, peeled commit, and published GitHub Release;
- the promoted pin, exact installed tag, executable path, and passing doctor result;
- proof that the next run starts with the new Pipeline version.
- proof that a second release can start without a wrapper or config replacement.
