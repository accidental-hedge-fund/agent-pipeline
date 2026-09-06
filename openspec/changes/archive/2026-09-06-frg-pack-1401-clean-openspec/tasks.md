## 1. Run-scoped fixture

- [x] 1.1 Add the clean-openspec JSON fixture with `release_version` set to
      `1.40.1`, and verify it parses as JSON.

## 2. Biting unit test

- [x] 2.1 Add a `node:test` that reads only the run-scoped fixture and asserts
      `release_version === "1.40.1"`; verify the focused test passes.

## 3. Validation

- [x] 3.1 Validate the OpenSpec change and run the full repository CI gate.
