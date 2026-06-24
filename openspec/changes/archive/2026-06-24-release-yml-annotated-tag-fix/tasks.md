## 1. Workflow fix

- [x] 1.1 In `.github/workflows/release.yml`, insert a new step immediately after `actions/checkout@v4` that runs `git fetch origin --force "refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"` with a descriptive `name` explaining why (checkout peels the tag to a commit).
- [x] 1.2 Verify the step order in the YAML: fetch step → version-match guard → annotated-tag guard → publish step.

## 2. Validation

- [ ] 2.1 Push a real annotated tag to a test branch (or re-run the workflow on a tag that previously failed) and confirm the workflow passes all guards and publishes a Release whose body equals the tag annotation.
- [ ] 2.2 Confirm that the lightweight-tag guard still rejects a lightweight tag (push `git tag v0.0.0-test` without `-a` and verify the job fails at the guard step).
- [ ] 2.3 Confirm that the empty-annotation guard still rejects a tag annotated with only whitespace.
- [x] 2.4 Run `npm run ci` to confirm no regressions in the TypeScript core (no TS changes, but gate must still pass).

## 3. OpenSpec archive

- [x] 3.1 Archive this change (`openspec archive release-yml-annotated-tag-fix`) and confirm `openspec validate --all` passes.
- [ ] 3.2 Commit the archived change with a reference to #289.
