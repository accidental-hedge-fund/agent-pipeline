// evidence_subject pure helpers (#692) — no network/git/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEngineFingerprint,
  buildEvidenceSubject,
  buildEvidenceSubjectDiagnostics,
  buildPolicyHash,
  buildRequiredEvidenceSetRevision,
  buildReviewPolicyHash,
  buildTesterPolicyHash,
  buildVerifierFingerprint,
  canonicalizeEvidenceSubject,
  CANDIDATE_CURRENCY_FIELDS,
  compareEvidenceSubjects,
  collectDiagnosticArtifactsFromBundle,
  DEFAULT_REQUIRED_EVIDENCE_KINDS,
  EVIDENCE_SUBJECT_SCHEMA_VERSION,
  parseEvidenceSubject,
  parseEvidenceSubjectDetailed,
  resolveRequiredEvidenceKinds,
  selectEvaluationPinSubject,
  serializeEvidenceSubjectCanonical,
  sha256Hex,
  stableStringify,
  subjectIsCurrentForFields,
  TESTER_CURRENCY_FIELDS,
  verifierFingerprintFromEngine,
  type EvidenceSubjectV1,
} from "../scripts/evidence-subject.ts";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_A_UPPER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const POLICY = buildPolicyHash({ block_threshold: "high", min_confidence: 0.7 });
const ENGINE = buildEngineFingerprint({
  version: "1.0.0",
  templates_fingerprint: "t".repeat(64),
});
const VERIFIER = verifierFingerprintFromEngine(ENGINE);
const REQ = buildRequiredEvidenceSetRevision(DEFAULT_REQUIRED_EVIDENCE_KINDS);

function sampleSubject(over: Partial<EvidenceSubjectV1> = {}): EvidenceSubjectV1 {
  return buildEvidenceSubject({
    domain: "owner/repo",
    issue: 692,
    pr: 100,
    run_id: "692/test-run",
    candidate_sha: SHA_A,
    diff_hash: "deadbeefcafebabe",
    policy_hash: POLICY,
    engine_fingerprint: ENGINE,
    verifier_fingerprint: VERIFIER,
    required_evidence_set_revision: REQ,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Build / canonicalize / serialize
// ---------------------------------------------------------------------------

test("schema_version 1 object carries the required field set", () => {
  const s = sampleSubject();
  assert.equal(s.schema_version, EVIDENCE_SUBJECT_SCHEMA_VERSION);
  assert.equal(s.domain, "owner/repo");
  assert.equal(s.issue, 692);
  assert.equal(s.pr, 100);
  assert.equal(s.run_id, "692/test-run");
  assert.equal(s.candidate_sha, SHA_A);
  assert.equal(s.diff_hash, "deadbeefcafebabe");
  assert.equal(typeof s.policy_hash, "string");
  assert.equal(typeof s.engine_fingerprint, "string");
  assert.equal(typeof s.verifier_fingerprint, "string");
  assert.equal(typeof s.required_evidence_set_revision, "string");
});

test("buildEvidenceSubject normalizes SHA case and rejects short SHA", () => {
  const s = sampleSubject({ candidate_sha: SHA_A_UPPER });
  assert.equal(s.candidate_sha, SHA_A);
  assert.throws(
    () => sampleSubject({ candidate_sha: "abc123" }),
    /candidate_sha/,
  );
});

test("buildEvidenceSubject fails closed on missing domain / digests", () => {
  assert.throws(() => sampleSubject({ domain: "  " } as Partial<EvidenceSubjectV1> & { domain: string }), /domain/);
  assert.throws(
    () =>
      buildEvidenceSubject({
        domain: "d",
        issue: 1,
        run_id: "r",
        candidate_sha: SHA_A,
        policy_hash: "",
        engine_fingerprint: ENGINE,
        verifier_fingerprint: VERIFIER,
        required_evidence_set_revision: REQ,
      }),
    /policy_hash/,
  );
});

test("canonical serialization is byte-stable for same logical inputs", () => {
  const a = sampleSubject({ candidate_sha: SHA_A_UPPER });
  const b = sampleSubject({ candidate_sha: SHA_A });
  assert.equal(serializeEvidenceSubjectCanonical(a), serializeEvidenceSubjectCanonical(b));
  assert.equal(
    serializeEvidenceSubjectCanonical(canonicalizeEvidenceSubject(a)),
    serializeEvidenceSubjectCanonical(a),
  );
});

test("null pr and null diff_hash are explicit in canonical form", () => {
  const s = sampleSubject({ pr: null, diff_hash: null });
  const json = serializeEvidenceSubjectCanonical(s);
  assert.match(json, /"pr":null/);
  assert.match(json, /"diff_hash":null/);
});

// ---------------------------------------------------------------------------
// Digest builders (documented folding)
// ---------------------------------------------------------------------------

test("policy_hash is deterministic over sorted-key policy slice", () => {
  const h1 = buildReviewPolicyHash({
    block_threshold: "high",
    min_confidence: 0.8,
    max_adversarial_rounds: 3,
  });
  const h2 = buildReviewPolicyHash({
    block_threshold: "high",
    min_confidence: 0.8,
    max_adversarial_rounds: 3,
  });
  assert.equal(h1, h2);
  const h3 = buildReviewPolicyHash({
    block_threshold: "medium",
    min_confidence: 0.8,
    max_adversarial_rounds: 3,
  });
  assert.notEqual(h1, h3);
});

test("tester policy_hash folds config_digest material", () => {
  const h = buildTesterPolicyHash({
    command_identity: "npm test",
    enabled: true,
    timeout: 300,
    max_output_chars: 4000,
  });
  assert.equal(h.length, 64);
  assert.equal(
    h,
    buildPolicyHash({
      command_identity: "npm test",
      "test_gate.enabled": true,
      "test_gate.timeout": 300,
      max_output_chars: 4000,
    }),
  );
});

test("engine_fingerprint includes commit_sha only when provided", () => {
  const without = buildEngineFingerprint({
    version: "1.0.0",
    templates_fingerprint: "ab",
  });
  const withSha = buildEngineFingerprint({
    version: "1.0.0",
    templates_fingerprint: "ab",
    commit_sha: SHA_A_UPPER,
  });
  assert.notEqual(without, withSha);
  assert.equal(
    withSha,
    sha256Hex(
      stableStringify({
        commit_sha: SHA_A,
        templates_fingerprint: "ab",
        version: "1.0.0",
      }),
    ),
  );
});

test("verifier_fingerprint may derive from engine when no distinct surface", () => {
  const v = verifierFingerprintFromEngine(ENGINE);
  assert.equal(v, buildVerifierFingerprint({ derived_from: "engine", engine_fingerprint: ENGINE }));
});

test("required_evidence_set_revision sorts and de-dupes kinds", () => {
  const a = buildRequiredEvidenceSetRevision(["tester", "review"]);
  const b = buildRequiredEvidenceSetRevision(["review", "tester", "REVIEW"]);
  assert.equal(a, b);
  const c = buildRequiredEvidenceSetRevision(["review", "tester", "eval"]);
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// Comparison outcomes
// ---------------------------------------------------------------------------

test("identical logical subjects compare as match (hex case)", () => {
  const pin = sampleSubject({ candidate_sha: SHA_A });
  const art = {
    ...sampleSubject({ candidate_sha: SHA_A_UPPER }),
    policy_hash: POLICY.toUpperCase(),
  };
  const cmp = compareEvidenceSubjects(art, pin);
  assert.equal(cmp.outcome, "match");
  assert.deepEqual(cmp.mismatched_fields, []);
  assert.equal(cmp.subject_present, true);
});

test("candidate SHA difference is a candidate mismatch", () => {
  const pin = sampleSubject({ candidate_sha: SHA_A });
  const art = sampleSubject({ candidate_sha: SHA_B });
  const cmp = compareEvidenceSubjects(art, pin);
  assert.equal(cmp.outcome, "mismatch");
  assert.ok(cmp.mismatched_fields.includes("candidate_sha"));
  assert.equal(cmp.mismatched_fields.length, 1);
  assert.equal(subjectIsCurrentForFields(cmp, CANDIDATE_CURRENCY_FIELDS), false);
});

test("diff hash difference is a diff mismatch", () => {
  const pin = sampleSubject({ diff_hash: "aaaa" });
  const art = sampleSubject({ diff_hash: "bbbb" });
  const cmp = compareEvidenceSubjects(art, pin);
  assert.equal(cmp.outcome, "mismatch");
  assert.deepEqual(cmp.mismatched_fields, ["diff_hash"]);
});

test("policy hash difference is a policy mismatch", () => {
  const pin = sampleSubject({ policy_hash: buildPolicyHash({ a: 1 }) });
  const art = sampleSubject({ policy_hash: buildPolicyHash({ a: 2 }) });
  const cmp = compareEvidenceSubjects(art, pin);
  assert.equal(cmp.outcome, "mismatch");
  assert.deepEqual(cmp.mismatched_fields, ["policy_hash"]);
  // Candidate identity remains equal
  assert.equal(art.candidate_sha, pin.candidate_sha);
});

test("verifier fingerprint difference is a verifier mismatch", () => {
  const pin = sampleSubject({ verifier_fingerprint: buildVerifierFingerprint({ v: 1 }) });
  const art = sampleSubject({ verifier_fingerprint: buildVerifierFingerprint({ v: 2 }) });
  const cmp = compareEvidenceSubjects(art, pin);
  assert.equal(cmp.outcome, "mismatch");
  assert.deepEqual(cmp.mismatched_fields, ["verifier_fingerprint"]);
});

test("required_evidence_set_revision mismatch surfaces in diagnostics", () => {
  const pin = sampleSubject({
    required_evidence_set_revision: buildRequiredEvidenceSetRevision(["review"]),
  });
  const art = sampleSubject({
    required_evidence_set_revision: buildRequiredEvidenceSetRevision([
      "review",
      "tester",
    ]),
  });
  const cmp = compareEvidenceSubjects(art, pin);
  assert.equal(cmp.outcome, "mismatch");
  assert.ok(cmp.mismatched_fields.includes("required_evidence_set_revision"));
});

test("malformed subject is not a match", () => {
  const pin = sampleSubject();
  assert.equal(compareEvidenceSubjects({ schema_version: 1 }, pin).outcome, "malformed");
  assert.equal(
    compareEvidenceSubjects({ schema_version: 1, candidate_sha: "x" }, pin).outcome,
    "malformed",
  );
  assert.equal(
    compareEvidenceSubjects(
      { ...sampleSubject(), schema_version: 99 },
      pin,
    ).outcome,
    "malformed",
  );
});

test("absent subject is legacy_unbound — never full match", () => {
  const pin = sampleSubject();
  const cmp = compareEvidenceSubjects(undefined, pin);
  assert.equal(cmp.outcome, "legacy_unbound");
  assert.equal(cmp.subject_present, false);
  assert.equal(subjectIsCurrentForFields(cmp), false);

  const cmp2 = compareEvidenceSubjects(null, pin);
  assert.equal(cmp2.outcome, "legacy_unbound");
});

test("unsupported schema_version is not a match", () => {
  const pin = sampleSubject();
  const raw = { ...sampleSubject(), schema_version: 2 };
  const cmp = compareEvidenceSubjects(raw, pin);
  assert.equal(cmp.outcome, "malformed");
  assert.equal(parseEvidenceSubjectDetailed(raw).status, "malformed");
});

test("omitted diff_hash key is malformed — not silently null match", () => {
  const pin = sampleSubject({ diff_hash: null });
  const raw = { ...sampleSubject({ diff_hash: null }) } as Record<string, unknown>;
  delete raw.diff_hash;
  const parsed = parseEvidenceSubjectDetailed(raw);
  assert.equal(parsed.status, "malformed");
  const cmp = compareEvidenceSubjects(raw, pin);
  assert.equal(cmp.outcome, "malformed");
  assert.notEqual(cmp.outcome, "match");
});

test("explicit null diff_hash is well-formed and can match", () => {
  const pin = sampleSubject({ diff_hash: null });
  const art = sampleSubject({ diff_hash: null });
  assert.equal(parseEvidenceSubjectDetailed(art).status, "ok");
  assert.equal(compareEvidenceSubjects(art, pin).outcome, "match");
});

test("resolveRequiredEvidenceKinds derives set from gate enablement", () => {
  assert.deepEqual(resolveRequiredEvidenceKinds({}), ["review", "tester"]);
  assert.deepEqual(
    resolveRequiredEvidenceKinds({ testGateEnabled: false }),
    ["review"],
  );
  assert.deepEqual(
    resolveRequiredEvidenceKinds({
      testGateEnabled: true,
      evalGateEnabled: true,
      visualGateEnabled: true,
      shipcheckGateEnabled: true,
    }),
    ["review", "tester", "eval", "visual", "shipcheck"],
  );
  const base = buildRequiredEvidenceSetRevision(["review", "tester"]);
  const withEval = buildRequiredEvidenceSetRevision([
    "review",
    "tester",
    "eval",
  ]);
  assert.notEqual(base, withEval);
});

test("run_id alone is not a complete subject match", () => {
  const pin = sampleSubject({ run_id: "run-1", candidate_sha: SHA_A });
  const art = sampleSubject({ run_id: "run-1", candidate_sha: SHA_B });
  const cmp = compareEvidenceSubjects(art, pin);
  assert.notEqual(cmp.outcome, "match");
  assert.ok(cmp.mismatched_fields.includes("candidate_sha"));
});

test("comparison is pure — only uses provided objects", () => {
  // No deps, no process.cwd side effects required.
  const pin = sampleSubject();
  const art = sampleSubject({ domain: "other/repo" });
  const cmp = compareEvidenceSubjects(art, pin);
  assert.equal(cmp.outcome, "mismatch");
  assert.deepEqual(cmp.mismatched_fields, ["domain"]);
});

// ---------------------------------------------------------------------------
// Post-fix invalidation / currency helpers
// ---------------------------------------------------------------------------

test("post-fix new candidate invalidates prior evidence currency", () => {
  const prior = sampleSubject({ candidate_sha: SHA_A });
  const pinAfterFix = sampleSubject({ candidate_sha: SHA_B });
  const cmp = compareEvidenceSubjects(prior, pinAfterFix);
  assert.equal(cmp.outcome, "mismatch");
  assert.ok(cmp.mismatched_fields.includes("candidate_sha"));
  assert.equal(subjectIsCurrentForFields(cmp, TESTER_CURRENCY_FIELDS), false);
});

test("policy-only change does not rewrite candidate SHA identity in diagnostic", () => {
  const pin = sampleSubject({ policy_hash: buildPolicyHash({ p: 1 }) });
  const art = sampleSubject({ policy_hash: buildPolicyHash({ p: 2 }) });
  const diags = buildEvidenceSubjectDiagnostics(pin, [
    { kind: "review", ref: "round:1", evidence_subject: art },
  ]);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].outcome, "mismatch");
  assert.deepEqual(diags[0].mismatched_fields, ["policy_hash"]);
  assert.equal(diags[0].artifact_subject?.candidate_sha, pin.candidate_sha);
  assert.equal(diags[0].pin_subject?.candidate_sha, pin.candidate_sha);
});

// ---------------------------------------------------------------------------
// Bundle diagnostics
// ---------------------------------------------------------------------------

test("finalize diagnostics: match for co-current evidence", () => {
  const pin = sampleSubject();
  const diags = buildEvidenceSubjectDiagnostics(pin, [
    { kind: "review", evidence_subject: pin },
    { kind: "tester", evidence_subject: { ...pin } },
  ]);
  assert.equal(diags.every((d) => d.outcome === "match"), true);
  assert.equal(diags.every((d) => d.mismatched_fields.length === 0), true);
});

test("finalize diagnostics: policy-only mismatch fields", () => {
  const pin = sampleSubject({ policy_hash: buildPolicyHash({ x: 1 }) });
  const art = sampleSubject({ policy_hash: buildPolicyHash({ x: 2 }) });
  const diags = buildEvidenceSubjectDiagnostics(pin, [
    { kind: "review", evidence_subject: art },
  ]);
  assert.equal(diags[0].outcome, "mismatch");
  assert.ok(diags[0].mismatched_fields.includes("policy_hash"));
});

test("finalize diagnostics: legacy_unbound labeling — never silent match", () => {
  const pin = sampleSubject();
  const diags = buildEvidenceSubjectDiagnostics(pin, [
    { kind: "tester", ref: "tester-evidence.json" },
    { kind: "review", evidence_subject: pin },
  ]);
  assert.equal(diags[0].outcome, "legacy_unbound");
  assert.equal(diags[0].subject_present, false);
  assert.equal(diags[1].outcome, "match");
});

test("partial legacy evidence in mixed bundle is labeled per-artifact", () => {
  const pin = sampleSubject();
  const arts = collectDiagnosticArtifactsFromBundle({
    reviews: [{ round: 1, sha: SHA_A, evidence_subject: pin }],
    overrides: [{ key: "finding:old" }],
    tester_evidence_subject: undefined,
    include_tester_row: true,
  });
  const diags = buildEvidenceSubjectDiagnostics(pin, arts);
  const byKind = Object.fromEntries(diags.map((d) => [d.kind + (d.ref ?? ""), d.outcome]));
  assert.equal(diags.find((d) => d.kind === "review")?.outcome, "match");
  assert.equal(diags.find((d) => d.kind === "override")?.outcome, "legacy_unbound");
  assert.equal(diags.find((d) => d.kind === "tester")?.outcome, "legacy_unbound");
  assert.ok(byKind);
});

test("diagnostics do not invent subjects for legacy_unbound", () => {
  const pin = sampleSubject();
  const diags = buildEvidenceSubjectDiagnostics(pin, [{ kind: "correction" }]);
  assert.equal(diags[0].artifact_subject, undefined);
  assert.equal(diags[0].outcome, "legacy_unbound");
});

test("selectEvaluationPinSubject prefers last well-formed subject", () => {
  const a = sampleSubject({ candidate_sha: SHA_A });
  const b = sampleSubject({ candidate_sha: SHA_B });
  const pin = selectEvaluationPinSubject([
    { kind: "review", evidence_subject: a },
    { kind: "tester", evidence_subject: b },
  ]);
  assert.equal(pin?.candidate_sha, SHA_B);
  assert.equal(selectEvaluationPinSubject([{ kind: "x" }]), null);
});

test("parseEvidenceSubject ignores unknown fields on ok path", () => {
  const raw = { ...sampleSubject(), extra_future: true };
  const parsed = parseEvidenceSubject(raw);
  assert.ok(parsed);
  assert.equal(parsed!.candidate_sha, SHA_A);
  assert.equal((parsed as EvidenceSubjectV1 & { extra_future?: boolean }).extra_future, undefined);
});
