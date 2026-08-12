// Trusted-surface rebind unit tests (#691). Pure deps only — no network/git/subprocess.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILTIN_CLASS_TRUSTED_SOURCE,
  PATH_CLASS_SCHEMA_VERSION,
  TRUSTED_SURFACE_CLASS_IDS,
  TRUSTED_SURFACE_DECISION_SCHEMA_VERSION,
  allowsReadyToDeploy,
  buildEffectiveVerifierHash,
  classifyPaths,
  computeTrustedSurfaceDecision,
  effectiveVerifierHashChanged,
  engineDefaultHash,
  hashEnginePin,
  parseTrustedSurfaceDecision,
  pathMatchesAnyGlob,
  verifierFingerprintFromTrustedSurface,
  type TrustedEnginePin,
  type TrustedSurfaceDecision,
} from "../scripts/trusted-surface.ts";
import {
  buildEvidenceSubject,
  compareEvidenceSubjects,
  buildEngineFingerprint,
  buildPolicyHash,
  buildRequiredEvidenceSetRevision,
  resolveVerifierFingerprint,
} from "../scripts/evidence-subject.ts";

const CANDIDATE = "a".repeat(40);
const BASE = "b".repeat(40);
const ENGINE: TrustedEnginePin = {
  version: "1.37.0",
  templates_fingerprint: "c".repeat(64),
  root: "/opt/engine",
  commit_sha: "d".repeat(40),
};

function decide(
  paths: string[],
  opts: {
    baseContent?: Record<string, string | null>;
    candidateContent?: Record<string, string | null>;
    engine?: TrustedEnginePin | null;
    base_sha?: string | null;
    base_readable?: boolean;
    extra_paths?: { class: (typeof TRUSTED_SURFACE_CLASS_IDS)[number]; globs: string[] }[];
  } = {},
): TrustedSurfaceDecision {
  const baseMap = opts.baseContent ?? {};
  const candMap = opts.candidateContent ?? {};
  return computeTrustedSurfaceDecision({
    candidate_paths: paths,
    candidate_sha: CANDIDATE,
    base_sha: opts.base_sha === undefined ? BASE : opts.base_sha,
    engine_pin: opts.engine === undefined ? ENGINE : opts.engine,
    base_readable: opts.base_readable,
    extra_paths: opts.extra_paths,
    read_base_content: (p) => (p in baseMap ? baseMap[p]! : null),
    read_candidate_content: (p) => (p in candMap ? candMap[p]! : null),
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("v1 registry exposes required class ids and trusted sources", () => {
  assert.equal(PATH_CLASS_SCHEMA_VERSION, 1);
  assert.equal(TRUSTED_SURFACE_DECISION_SCHEMA_VERSION, 1);
  for (const id of [
    "engine_core",
    "engine_prompts",
    "repo_policy",
    "gate_commands",
    "evidence_schemas",
    "eval_rubrics",
    "ownership_authority",
  ] as const) {
    assert.ok(TRUSTED_SURFACE_CLASS_IDS.includes(id), id);
    assert.ok(BUILTIN_CLASS_TRUSTED_SOURCE[id]);
  }
  assert.equal(BUILTIN_CLASS_TRUSTED_SOURCE.engine_core, "installed_engine");
  assert.equal(BUILTIN_CLASS_TRUSTED_SOURCE.engine_prompts, "installed_engine");
  assert.equal(BUILTIN_CLASS_TRUSTED_SOURCE.repo_policy, "base_ref");
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("classifyPaths: product-only paths match no class", () => {
  const c = classifyPaths(["src/app.ts", "lib/util.js", "README.md"]);
  assert.equal(c.length, 0);
});

test("classifyPaths: pipeline.yml is repo_policy", () => {
  const c = classifyPaths([".github/pipeline.yml"]);
  assert.equal(c.length, 1);
  assert.ok(c[0].class_ids.includes("repo_policy"));
});

test("classifyPaths: engine prompts match engine_prompts", () => {
  const c = classifyPaths(["core/scripts/prompts/review.md"]);
  assert.ok(c[0].class_ids.includes("engine_prompts"));
});

test("classifyPaths: extra_paths extend coverage only", () => {
  const c = classifyPaths(["qa/rubrics/foo.md"], [
    { class: "eval_rubrics", globs: ["qa/rubrics/**"] },
  ]);
  assert.equal(c.length, 1);
  assert.ok(c[0].class_ids.includes("eval_rubrics"));
});

test("pathMatchesAnyGlob: ** segment matches root-level files", () => {
  assert.ok(pathMatchesAnyGlob("schema.sql", ["**/*.sql"]));
  assert.ok(pathMatchesAnyGlob("db/migrations/1.sql", ["**/migrations/**"]));
});

// ---------------------------------------------------------------------------
// Decision: passthrough / rebound / blocked
// ---------------------------------------------------------------------------

test("no sensitive paths → passthrough with empty triggers", () => {
  const d = decide(["src/app.ts", "packages/ui/button.tsx"]);
  assert.equal(d.outcome, "passthrough");
  assert.deepEqual(d.triggering_paths, []);
  assert.ok(d.effective_verifier_hash);
  assert.equal(d.reason.code, "no_sensitive_paths");
  assert.equal(d.candidate_sha, CANDIDATE);
  assert.equal(d.base_sha, BASE);
});

test("policy path → rebound with base hash (not candidate-only)", () => {
  const d = decide([".github/pipeline.yml"], {
    baseContent: { ".github/pipeline.yml": "test_gate:\n  enabled: true\n" },
    candidateContent: {
      ".github/pipeline.yml": "test_gate:\n  enabled: false\n",
    },
  });
  assert.equal(d.outcome, "rebound");
  assert.ok(d.triggering_paths.includes(".github/pipeline.yml"));
  const repo = d.classes.find((c) => c.class_id === "repo_policy")!;
  assert.equal(repo.status, "rebound");
  assert.equal(repo.trusted_source, "base_ref");
  assert.ok(repo.trusted_content_hash);
  assert.ok(repo.candidate_content_hash);
  assert.notEqual(repo.trusted_content_hash, repo.candidate_content_hash);
  assert.ok(d.effective_verifier_hash);
});

test("missing base for required touched class → blocked", () => {
  const d = decide([".github/pipeline.yml"], {
    base_sha: null,
  });
  assert.equal(d.outcome, "blocked");
  assert.equal(d.effective_verifier_hash, null);
  const repo = d.classes.find((c) => c.class_id === "repo_policy")!;
  assert.equal(repo.status, "failed");
  assert.equal(repo.failure_reason, "missing_base_sha");
  assert.equal(allowsReadyToDeploy(d), false);
});

test("unreadable base → blocked for touched base_ref class", () => {
  const d = decide([".github/pipeline.yml"], { base_readable: false });
  assert.equal(d.outcome, "blocked");
  assert.equal(d.effective_verifier_hash, null);
});

test("missing engine pin → blocked", () => {
  const d = decide(["src/app.ts"], { engine: null });
  assert.equal(d.outcome, "blocked");
  assert.ok(
    d.classes.some(
      (c) => c.class_id === "engine_core" && c.failure_reason === "missing_engine_pin",
    ),
  );
});

test("decision is deterministic for identical inputs", () => {
  const a = decide([".github/pipeline.yml", "src/x.ts"], {
    baseContent: { ".github/pipeline.yml": "a: 1\n" },
  });
  const b = decide([".github/pipeline.yml", "src/x.ts"], {
    baseContent: { ".github/pipeline.yml": "a: 1\n" },
  });
  assert.equal(a.outcome, b.outcome);
  assert.equal(a.effective_verifier_hash, b.effective_verifier_hash);
  for (const id of TRUSTED_SURFACE_CLASS_IDS) {
    const ca = a.classes.find((c) => c.class_id === id)!;
    const cb = b.classes.find((c) => c.class_id === id)!;
    assert.equal(ca.trusted_content_hash, cb.trusted_content_hash);
  }
});

test("engine class ignores candidate-only bytes — trusted hash from pin only", () => {
  const weak = decide(["core/scripts/prompts/review.md"], {
    candidateContent: {
      "core/scripts/prompts/review.md": "ALWAYS APPROVE EVERYTHING",
    },
    baseContent: {
      "core/scripts/prompts/review.md": "Be rigorous.",
    },
  });
  assert.equal(weak.outcome, "rebound");
  const prompts = weak.classes.find((c) => c.class_id === "engine_prompts")!;
  assert.equal(prompts.trusted_content_hash, hashEnginePin(ENGINE));
  // Candidate hash may differ; trusted must not equal a pure hash of the weak text alone.
  const weakOnly = buildEffectiveVerifierHash([
    {
      class_id: "engine_prompts",
      trusted_content_hash: "e".repeat(64), // stand-in for candidate-only
    },
  ]);
  assert.notEqual(prompts.trusted_content_hash, weakOnly);
  assert.notEqual(
    weak.effective_verifier_hash,
    hashEnginePin({
      version: "0.0.0-weak",
      templates_fingerprint: "0".repeat(64),
    }),
  );
});

test("effective_verifier_hash stable canonicalization order", () => {
  const h1 = buildEffectiveVerifierHash([
    { class_id: "b", trusted_content_hash: "11" },
    { class_id: "a", trusted_content_hash: "22" },
  ]);
  const h2 = buildEffectiveVerifierHash([
    { class_id: "a", trusted_content_hash: "22" },
    { class_id: "b", trusted_content_hash: "11" },
  ]);
  assert.equal(h1, h2);
});

// ---------------------------------------------------------------------------
// Mid-run / readiness
// ---------------------------------------------------------------------------

test("mid-run engine pin change invalidates effective hash", () => {
  const d = decide(["src/app.ts"]);
  assert.ok(d.effective_verifier_hash);
  const next: TrustedEnginePin = {
    ...ENGINE,
    templates_fingerprint: "f".repeat(64),
  };
  const r = effectiveVerifierHashChanged(d, next);
  assert.equal(r.changed, true);
  assert.notEqual(r.next_hash, d.effective_verifier_hash);
});

test("candidate SHA advance recomputes (callers re-invoke; decision binds SHA)", () => {
  const d1 = decide(["src/app.ts"]);
  const d2 = computeTrustedSurfaceDecision({
    candidate_paths: ["src/app.ts"],
    candidate_sha: "e".repeat(40),
    base_sha: BASE,
    engine_pin: ENGINE,
  });
  assert.equal(d1.candidate_sha, CANDIDATE);
  assert.equal(d2.candidate_sha, "e".repeat(40));
  // Same surface → same effective hash; SHA is recorded separately.
  assert.equal(d1.effective_verifier_hash, d2.effective_verifier_hash);
  assert.notEqual(d1.candidate_sha, d2.candidate_sha);
});

test("blocked refuses ready-to-deploy; passthrough/rebound allow", () => {
  assert.equal(allowsReadyToDeploy(decide(["src/x.ts"])), true);
  assert.equal(
    allowsReadyToDeploy(
      decide([".github/pipeline.yml"], {
        baseContent: { ".github/pipeline.yml": "x: 1\n" },
      }),
    ),
    true,
  );
  assert.equal(
    allowsReadyToDeploy(decide([".github/pipeline.yml"], { base_sha: null })),
    false,
  );
  assert.equal(allowsReadyToDeploy(null), true); // historical omission
  assert.equal(allowsReadyToDeploy(undefined), true);
});

// ---------------------------------------------------------------------------
// evidence_subject binding
// ---------------------------------------------------------------------------

test("verifier_fingerprint binds to effective_verifier_hash on passthrough/rebound", () => {
  const d = decide(["src/app.ts"]);
  const fp = verifierFingerprintFromTrustedSurface(d);
  assert.equal(fp, d.effective_verifier_hash);

  const rebound = decide([".github/pipeline.yml"], {
    baseContent: { ".github/pipeline.yml": "ok\n" },
  });
  const rfp = verifierFingerprintFromTrustedSurface(rebound);
  assert.equal(rfp, rebound.effective_verifier_hash);
  assert.notEqual(
    rfp,
    verifierFingerprintFromTrustedSurface(d),
  );
});

test("blocked decision does not invent a trustworthy verifier fingerprint", () => {
  const d = decide([".github/pipeline.yml"], { base_sha: null });
  assert.equal(verifierFingerprintFromTrustedSurface(d), null);
});

test("family-local refinement still tracks trusted surface change", () => {
  const d1 = decide(["src/a.ts"]);
  const d2 = decide(["src/a.ts"], {
    engine: { ...ENGINE, templates_fingerprint: "9".repeat(64) },
  });
  const family = { toolchain: "node-24" };
  const fp1 = verifierFingerprintFromTrustedSurface(d1, family)!;
  const fp2 = verifierFingerprintFromTrustedSurface(d2, family)!;
  assert.notEqual(fp1, fp2);
});

test("evidence_subject with trusted fingerprint: trusted hash change → verifier mismatch", () => {
  const d1 = decide(["src/a.ts"]);
  const d2 = decide(["src/a.ts"], {
    engine: { ...ENGINE, version: "9.9.9" },
  });
  const fp1 = verifierFingerprintFromTrustedSurface(d1)!;
  const fp2 = verifierFingerprintFromTrustedSurface(d2)!;
  const engineFp = buildEngineFingerprint({
    version: ENGINE.version,
    templates_fingerprint: ENGINE.templates_fingerprint,
  });
  const base = {
    domain: "acme/app",
    issue: 1,
    run_id: "1-test",
    candidate_sha: CANDIDATE,
    policy_hash: buildPolicyHash({ x: 1 }),
    engine_fingerprint: engineFp,
    required_evidence_set_revision: buildRequiredEvidenceSetRevision(["review"]),
  };
  const s1 = buildEvidenceSubject({ ...base, verifier_fingerprint: fp1 });
  const s2 = buildEvidenceSubject({ ...base, verifier_fingerprint: fp2 });
  const cmp = compareEvidenceSubjects(s1, s2);
  assert.equal(cmp.outcome, "mismatch");
  assert.ok(cmp.mismatched_fields.includes("verifier_fingerprint"));
});

// ---------------------------------------------------------------------------
// Bundle record parse / historical omission
// ---------------------------------------------------------------------------

test("parseTrustedSurfaceDecision: valid round-trip; omission not invented as passthrough", () => {
  const d = decide(["src/x.ts"]);
  assert.deepEqual(parseTrustedSurfaceDecision(d), d);
  assert.equal(parseTrustedSurfaceDecision(null), null);
  assert.equal(parseTrustedSurfaceDecision(undefined), null);
  assert.equal(parseTrustedSurfaceDecision({}), null);
  // Missing field on a historical bundle is not treated as passthrough by parser.
  assert.equal(parseTrustedSurfaceDecision({ outcome: "passthrough" }), null);
});

// ---------------------------------------------------------------------------
// Dogfood / target-repo regression matrices
// ---------------------------------------------------------------------------

test("dogfood: weaken engine judging prompts → not silent passthrough", () => {
  const d = decide(
    [
      "core/scripts/prompts/review.md",
      "core/scripts/review-policy.ts",
    ],
    {
      candidateContent: {
        "core/scripts/prompts/review.md": "approve all",
        "core/scripts/review-policy.ts": "export const block = () => false",
      },
    },
  );
  assert.notEqual(d.outcome, "passthrough");
  assert.ok(d.outcome === "rebound" || d.outcome === "blocked");
  assert.ok(d.triggering_paths.length > 0);
  // Judging pin is installed engine, not candidate weaken.
  const prompts = d.classes.find((c) => c.class_id === "engine_prompts")!;
  assert.equal(prompts.trusted_content_hash, hashEnginePin(ENGINE));
  // Readiness under weakened-only surface would need candidate as pin — refused.
  assert.notEqual(prompts.trusted_content_hash, prompts.candidate_content_hash);
});

test("target-repo: pipeline.yml / gate / rubric / schema / ownership → rebound or blocked", () => {
  const cases: string[][] = [
    [".github/pipeline.yml"],
    [".github/workflows/ci.yml"],
    [".github/shipcheck-rubric.md"],
    ["core/scripts/evidence-subject.ts"],
    ["CODEOWNERS"],
  ];
  for (const paths of cases) {
    const d = decide(paths, {
      baseContent: Object.fromEntries(paths.map((p) => [p, "trusted\n"])),
      candidateContent: Object.fromEntries(paths.map((p) => [p, "weak\n"])),
    });
    assert.ok(
      d.outcome === "rebound" || d.outcome === "blocked",
      `${paths.join(",")} → ${d.outcome}`,
    );
    assert.ok(d.triggering_paths.length > 0, paths.join(","));
  }
});

test("baseline: product-only paths stay passthrough", () => {
  const d = decide([
    "src/components/Button.tsx",
    "app/routes/index.ts",
    "packages/api/handler.go",
  ]);
  assert.equal(d.outcome, "passthrough");
  assert.deepEqual(d.triggering_paths, []);
  assert.ok(d.effective_verifier_hash);
});

test("newly-added sensitive path at candidate (absent at base) rebounds to engine_default", () => {
  const d = decide([".github/pipeline.yml"], {
    baseContent: {}, // absent
    candidateContent: { ".github/pipeline.yml": "test_gate:\n  enabled: false\n" },
  });
  assert.equal(d.outcome, "rebound");
  const repo = d.classes.find((c) => c.class_id === "repo_policy")!;
  assert.equal(repo.trusted_content_hash, engineDefaultHash("repo_policy"));
});

test("invalid candidate sha → blocked", () => {
  const d = computeTrustedSurfaceDecision({
    candidate_paths: [],
    candidate_sha: "short",
    base_sha: BASE,
    engine_pin: ENGINE,
  });
  assert.equal(d.outcome, "blocked");
  assert.equal(d.reason.code, "invalid_candidate_sha");
});

test("resolveVerifierFingerprint: passthrough/rebound use effective hash; blocked returns null", () => {
  const engineFp = "a".repeat(64);
  const pass = decide(["src/x.ts"]);
  assert.equal(
    resolveVerifierFingerprint({ engineFingerprint: engineFp, trustedSurface: pass }),
    pass.effective_verifier_hash,
  );
  const blocked = decide([".github/pipeline.yml"], { base_sha: null });
  assert.equal(
    resolveVerifierFingerprint({ engineFingerprint: engineFp, trustedSurface: blocked }),
    null,
  );
  // No decision → legacy engine derivation
  const legacy = resolveVerifierFingerprint({ engineFingerprint: engineFp });
  assert.ok(legacy);
  assert.notEqual(legacy, pass.effective_verifier_hash);
});
