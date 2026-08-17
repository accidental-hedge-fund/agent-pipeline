## 1. Shared validator remediating message

- [ ] 1.1 In `validateFrgEvidenceFileForTag` (and therefore `--validate-tag`), make every fail-closed path name `.agent-pipeline/frg/<X.Y.Z>/latest.json` and name `factory-release prepare` or the Tugboat FRG pack phase
- [ ] 1.2 Do not say FRG is optional or advisory on the tag path. Do not add a second tag validator

## 2. Restore auto-tag FRG step

- [ ] 2.1 Restore the `Verify Factory Reliability Gate evidence` step in `.github/workflows/auto-tag-release.yml` after the existing-tag check and before notes resolution / tag create/push
- [ ] 2.2 Invoke the shared `--validate-tag` CLI for the detected version. Require `PIPELINE_FRG_ATTESTATION_KEY` for HMAC verification. Fail the job on non-zero and create or push no tag
- [ ] 2.3 Keep the step gated on a detected release merge with matching package version and `exists=false`. Non-release pushes stay successful no-ops without FRG
- [ ] 2.4 Remove the #962 “FRG is optional/advisory” comment

## 3. Tests

- [ ] 3.1 Flip `auto-tag-release workflow does not hard-gate tag create on FRG evidence` so it fails if the verify step is missing, runs after tag create/push, or no longer calls `--validate-tag`
- [ ] 3.2 Add a hermetic missing-`latest.json` case that fails closed and whose message names the path and the pack remediation
- [ ] 3.3 Add a hermetic `pass: false` / ineligible case that fails closed and does not create or push a tag
- [ ] 3.4 Add a hermetic release-eligible `pass: true` case that allows tag proceed (subject to existing notes / token rules)
- [ ] 3.5 Tests inject I/O or inspect the workflow and validator. They perform no real network, git, or tag push

## 4. Docs, mirror, gate

- [ ] 4.1 Align `docs/factory-reliability-gate-runbook.md` (and any leftover thin-ship “optional FRG on auto-tag” wording) so auto-tag fail-closes without a release-eligible `latest.json` and names `factory-release prepare` / Tugboat FRG pack as the remediation
- [ ] 4.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 4.3 Run `openspec validate auto-tag-requires-frg-latestjson` and `npm run ci` from the repo root. Fix failures until green
