## 1. Persist-root fallback

- [x] 1.1 Restore `repoDir` as the default persist root when factory-control identity is unset
- [x] 1.2 Keep explicit empty/`null` overlay fail-closed
- [x] 1.3 Leave unique-operation collection dual-root resolution unchanged

## 2. Tests

- [x] 2.1 Product-repo `resolvePublicAdmissionPersistRoot` and `persistPublicEntrypointAdmission` without overlay
- [x] 2.2 Product-repo `train --merge` admits without a factory-control overlay
- [x] 2.3 Explicit empty overlay still refuses
