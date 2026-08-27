# Config sync infers harness roles from models, never from the host profile

Required `harnesses.implementer` / `harnesses.reviewer` is repository execution policy. `pipeline config sync` is the only verb allowed to add a missing required key it can supply. It infers a role only when existing `models:` (and `review_harness` if present) map unambiguously onto one registered adapter via the existing family detectors. It never fills a role from the host profile. Ambiguous or missing models: do not write; exit 2 and name the two keys. Every other verb stays fail-closed until the file is valid.

**Considered options:** fill from profile (rejected: profile is bootstrap, not live workers); append a commented `# harnesses:` block (rejected: comments are not policy once the keys are required); weaken `status`/`doctor` to load without harnesses (rejected: fail-closed stays).
