## 1. Contract and policy

- [x] 1.1 Update AGENTS.md, CLAUDE.md, openspec/project.md, README, and concept docs so ordinary advance still stops at ready-to-deploy and the disabled scoped grant is the only factory exception.
- [x] 1.2 Update command and config source copy, host skill copy, and policy drift tests without adding an `auto_merge` key or merge stage.
- [x] 1.3 Write the concise factory plan, trust boundary, release procedure, monitoring procedure, and rollback runbook.

## 2. Fixed FRG correctness

- [x] 2.1 Preserve normalized label and milestone selector provenance through fresh loop compilation while keeping explicit work lists unchanged.
- [x] 2.2 Add regression tests that prove fresh fixed-pack selectors pass FRG contract validation and ad-hoc work lists remain rejected.
- [x] 2.3 Add a versioned representative pack manifest, deterministic synthetic issue templates, fault recipes, and evidence collector that cannot use test-only overrides or caller-authored pass receipts.
- [x] 2.4 Add unit tests for manifest binding, fresh-instance checks, missing evidence refusal, deterministic observation output, exact candidate-bound probes, provenance-bound attestation, and forbidden override imports.
- [x] 2.5 Implement and document the v1.33.0-only hybrid proof boundary. Require live fresh-issue proof for safe outcomes, candidate-bound Layer A proof for the closed unsafe-fault list, and automatic expiry into #908.

## 3. Scoped factory wrapper

- [x] 3.1 Add the disabled deployment layout, pinned artifact manifest, machine-local config examples, secret placeholders, and exact installed Pipeline launcher.
- [x] 3.2 Implement the grant parser and validator for signer, channel, repository, base, release, ordered issues, actions, model, issue limits, expiry, replay, stop, and revocation.
- [x] 3.3 Implement the minimal restart journal and idempotent action records without duplicating Pipeline issue or stage state.
- [x] 3.4 Implement one-item Pipeline drive, exact linked-PR resolution, `pipeline merge`, squash-aware merge-result containment, and base refresh before the next issue.
- [x] 3.5 Implement the v1.33.0-only hybrid FRG and release path, exact release-PR finalization, tag and GitHub Release verification, pin promotion, exact-tag install, doctor smoke, and rollback. Keep #898 stable across later releases: derive later starts from the verified installed pin plus fresh `main`, and invoke `pipeline factory-release prepare --request <absolute-request.json> --json` from the exact integrated candidate as an idempotent two-call protocol when #908 is present. Do not place the FRG key or its path in the candidate environment, inherited file descriptors, or candidate-action cgroup credential mount. Use the fixed wrapper-local attestor, with no candidate import or execution, child process, or network, with the pinned #898 policy for v1.33.0 and the verified current production signer later. Treat same-user privilege separation as #618, #899, or later hardening.
- [x] 3.6 Implement redacted material-event and bounded-heartbeat delivery to the active Buzz thread without gating Pipeline.
- [x] 3.7 Add unit and integration tests for grant denial, replay, stop, issue ordering, head drift, containment, release identity, publication proof, install, rollback, and secret canaries. Add a two-release continuity test that starts from the verified v1.33.0 pin, prepares and installs v1.34.0 through the two-call candidate-native #908 interface, and proves that the next grant uses v1.34.0 without a wrapper or config replacement. Test idempotent calls before and after attestation, unsupported schema and policy refusal, no automatic key or key-path propagation through candidate environment, inherited file descriptors, candidate-action cgroup credential mounts, requests, or results, no candidate import or execution by the attestor, request-selected import and network denial, and secret redaction in errors, logs, and notices.

## 4. Deployment packaging

- [x] 4.1 Add pinned Hermes v2026.8.3 and Buzz v0.5.2 install instructions and checksums or source-revision receipts.
- [x] 4.2 Add native Buzz gateway configuration for xAI OAuth, only `grok-4.5`, the private `pipeline-factory` stream, exact operator allowlist, mention gating, and no Grok fallback.
- [x] 4.3 Add persistent user-systemd service templates, transient Pipeline unit guidance, explicit PATH, linger setup, health checks, stop, restart, and log commands.
- [x] 4.4 Add calibration checks for split DNS, TLS, NIP-42, profile, membership, send, receive, model identity, tool scope, secret redaction, and rollback.

## 5. Roadmap and issue hygiene

- [x] 5.1 Replace ROADMAP.md with a strict SemVer plan that assigns every open issue to one release milestone and keeps theme labels only as secondary scope labels.
- [x] 5.2 Apply the reviewed live-state-guarded GitHub migration for every planned release milestone, issue assignment, description, and corrected roadmap issue.
- [x] 5.3 Verify every open issue has exactly one release milestone, no open issue is unmilestoned, and the live milestone issue sets match ROADMAP.md exactly.

## 6. Build and repository verification

- [x] 6.1 Regenerate generated docs and the plugin mirror after source changes.
- [x] 6.2 Run strict OpenSpec validation, focused tests, `npm run ci`, and secret/path drift checks.
- [ ] 6.3 Run an adversarial review, fix all valid findings, open a pull request, and prove required CI is green.

## 7. Live factory calibration and first release

- [x] 7.1 Preserve and resolve the stranded #891 state before any install or roadmap action can affect it.
- [ ] 7.2 Create the private `pipeline-factory` Buzz stream, provision dedicated identities, fix agent-box split DNS, install pinned artifacts, and keep the factory disabled.
- [ ] 7.3 Keep the current v1.31.1 production pin, use v1.32.0 `main` as the code base, run doctor in the service environment, and complete status-only, stop, restart, and notification calibration.
- [ ] 7.4 Accept the scoped v1.33.0 grant and process #905, #874, and #870 as merge-contained one-item waves.
- [ ] 7.5 Run fresh full FRG, prepare and merge the exact release PR, verify publication, promote and install v1.33.0, run doctor, and record that the next run uses v1.33.0.
