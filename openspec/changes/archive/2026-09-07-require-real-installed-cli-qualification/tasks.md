## 1. Qualification protocol

- [x] 1.1 Implement the closed qualification fixture/probe protocol and verify malformed, non-absolute, credential-bearing, or non-qualification invocations fail before external effects
- [x] 1.2 Implement the parent installed-launcher runner for every required operation × fault route plus the complete staged core suite, and verify exit, signal, timeout, malformed output, and durable-state cases are parent-observed
- [x] 1.3 Implement canonical candidate-bound artifact hashing/parsing for the complete route/suite proofs and closed lifecycle/layer representative set; verify stale, partial, unsuccessful, duplicate, foreign-row, and digest-mismatched artifacts are rejected in full

## 2. Matrix and release integration

- [x] 2.1 Replace inventory-to-executed-row fallback with validated qualification rows and verify a complete static inventory alone fails installed-CLI coverage
- [x] 2.2 Run/re-observe qualification before factory-release fixture creation and verify qualification failure causes zero create/dispatch calls
- [x] 2.3 Make same-candidate canary retries reuse persisted pack identity/artifacts and verify unchanged-candidate failures cannot create a successor pair

## 3. Product gates

- [x] 3.1 Wire deterministic qualification into normal CI and verify the staged installed launcher is actually spawned
- [x] 3.2 Regenerate host skills and verify `node scripts/build.mjs --check`, strict OpenSpec validation, and `CI=1 npm run ci` pass
- [x] 3.3 Run independent standards/spec review, address findings, and archive the completed OpenSpec change before merge
