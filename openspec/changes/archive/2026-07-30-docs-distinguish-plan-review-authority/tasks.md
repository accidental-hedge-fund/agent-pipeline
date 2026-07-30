## 1. Audit current authority language

- [x] 1.1 Search operator surfaces for claims that equate plan-review with human sign-off / human approval (`README.md`, `hosts/*/SKILL.md`, CLI help/status prose, architecture blurbs)
- [x] 1.2 Search engine comments and adjacent test comments for the "human-judgment checkpoint" / "a human must review the plan" myth around plan-review
- [x] 1.3 Record the hit list (path + phrase) in the PR description or a short note under the change so the rewrite is complete and reviewable

## 2. Apply closed vocabulary to operator docs

- [x] 2.1 Rewrite the README Lifecycle band so plan-review is independent agent plan review plus an optional human feedback window (remove "human sign-off")
- [x] 2.2 Align the README `steps.plan_review` / human-comments section with the four terms and explicit no-human-input expiry semantics
- [x] 2.3 Update host skill copy (`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`) only where it asserts plan-review authority; keep stage names otherwise
- [x] 2.4 Correct any status/CLI help prose that describes plan-review as human approval
- [x] 2.5 Ensure examples touched in the audit show: agent review when enabled, optional human feedback, human merge separate at `ready-to-deploy`

## 3. Align engine comments (no behavior change)

- [x] 3.1 Rewrite `pipeline-run.ts` auto-loop comments so plan-review is not called a human-judgment checkpoint that requires a human to review the plan
- [x] 3.2 Update matching test comments if they copy the same incorrect reason
- [x] 3.3 Confirm auto-loop eligibility return values and tests remain unchanged unless a pure wording bug is found (file separately if real behavior drift exists)

## 4. Drift-guard regression check

- [x] 4.1 Add a `core/test/` unit test that fails when high-traffic operator copy re-equates plan-review with human sign-off (at minimum `README.md`)
- [x] 4.2 Allow explicit negation / distinction sentences so correct docs do not false-positive
- [x] 4.3 Prove the guard bites: temporarily restore the bad README phrase, confirm the test fails, then restore the fix

## 5. Packaging and verification

- [x] 5.1 If host skill sources changed, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [x] 5.2 Run `openspec validate docs-distinguish-plan-review-authority` (and `openspec validate --all` if required by local workflow)
- [x] 5.3 Run `npm run ci` from the repo root and fix failures
- [x] 5.4 Re-run the audit grep and confirm acceptance criteria from `proposal.md` are all checkable as done
