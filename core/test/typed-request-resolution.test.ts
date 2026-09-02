// Shared recommend-and-commit classifier (#1326). Injected facts only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyHumanAsk,
  durableClassForTypedRequest,
  isCandidateBoundRequestStale,
  isProtectedAuthorityOperation,
  pauseKindToTypedRequest,
  resolveTypedRequest,
  shouldReleaseAutoSettleableHold,
  typedRequestToPauseKind,
  validateAuthorityRequest,
  validateCapabilityRequest,
  validateDecisionPackage,
} from "../scripts/typed-request-resolution.ts";
import {
  assertNewResolutionPackage,
  makeNode,
  parseDecisionsFromBody,
  writeDecisionResolution,
  embedDecisionsInBody,
  type DecisionsArtifact,
} from "../scripts/grill-decisions.ts";
import { buildGrillFingerprint } from "../scripts/grill-fingerprint.ts";
import { planningTreatmentFromConfig } from "../scripts/grill-issue.ts";
import { DEFAULT_CONFIG } from "../scripts/types.ts";
import { canCreateHandoff, validateHandoffResume } from "../scripts/human-question-handoff.ts";
import { projectPipelineReasonCode } from "../scripts/stage-diagnostic.ts";
import { COMMAND_REGISTRY } from "../scripts/command-registry.ts";
import { collectHumanAskWithoutClassifier } from "../scripts/fault-recovery-static-guards.ts";
import { settleFrontierNodes } from "../scripts/stages/grill.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function testFingerprint(spec: string): DecisionsArtifact["fingerprint"] {
  return buildGrillFingerprint({
    title: "T",
    appliedBody: spec,
    dependencyClosure: { ids: [], per_id: [], fact_codes: [] },
    integrationBaseSha: "abc123def456",
    contextMd: "**Grill**:\nA one-shot intake interview.\n",
    providerConfig: {
      implementer: "grok",
      reviewer: "codex",
      planning_model: "grok-4.6",
      planning_effort: "auto",
    },
    planningTreatment: planningTreatmentFromConfig(DEFAULT_CONFIG),
  });
}

test("1.1 five classifier cases at the shared seam", () => {
  const reversible = resolveTypedRequest({
    nodeClass: "interface-contract",
    recommendation: "REST",
    factText: "REST",
  });
  assert.equal(reversible.kind, "auto-settle");

  const contradictory = resolveTypedRequest({
    nodeClass: "interface-contract",
    recommendation: "A and not A",
    signals: { contradictory: true },
  });
  assert.equal(contradictory.kind, "DecisionRequest");
  if (contradictory.kind === "DecisionRequest") {
    assert.equal(contradictory.durable_class, "specification-decision");
    assert.equal(contradictory.pause_kind, "decision");
    assert.ok(contradictory.package.rationale);
    assert.ok(Array.isArray(contradictory.package.alternatives));
    assert.ok(contradictory.package.risk);
    assert.ok(contradictory.package.evidence.length > 0);
  }

  const missingInfo = resolveTypedRequest({
    nodeClass: "operational-default",
    recommendation: "need the staging hostname",
    signals: { missing_external: true },
    capability: {
      missing: "staging hostname",
      provider: "operator",
      live_probe: "issue body and CONTEXT.md hostname field",
      resume_condition: "operator supplies the staging hostname",
    },
  });
  assert.equal(missingInfo.kind, "CapabilityRequest");
  if (missingInfo.kind === "CapabilityRequest") {
    assert.equal(missingInfo.pause_kind, "answer");
    assert.equal(durableClassForTypedRequest("CapabilityRequest"), null);
  }

  const unavailableCap = resolveTypedRequest({
    nodeClass: "operational-default",
    recommendation: "need deploy token",
    signals: { missing_external: true },
    capability: {
      missing: "deploy token",
      provider: "github-actions",
      live_probe: "gh auth status --show-token",
      resume_condition: "credential is present and the live probe succeeds",
    },
  });
  assert.equal(unavailableCap.kind, "CapabilityRequest");

  const missingAuth = resolveTypedRequest({
    nodeClass: "merge-release",
    recommendation: "merge this PR",
    factText: "",
    category: "authority",
    tipPresent: true,
    candidateSha: "a".repeat(40),
    authority: {
      eligible_actor: "repo-admin",
      repository: "acme/widgets",
      operation: "merge",
      scope: "pr",
      candidate_epoch: "a".repeat(40),
      evidence: ["merge requires existing merge authority"],
      expiry: "2026-12-01T00:00:00Z",
    },
  });
  assert.equal(missingAuth.kind, "AuthorityRequest");
  if (missingAuth.kind === "AuthorityRequest") {
    assert.equal(missingAuth.durable_class, "missing-authority");
    assert.equal(missingAuth.record.grant, null);
    assert.equal(isProtectedAuthorityOperation(missingAuth.record.operation), true);
  }
});

test("1.2 unknown errors, low confidence, stale labels, and retry exhaustion do not manufacture human authority", () => {
  for (const source of ["unknown-error", "stale-label", "retry-exhaustion"] as const) {
    const out = resolveTypedRequest({
      nodeClass: "interface-contract",
      recommendation: "REST",
      factText: "REST",
      source,
    });
    assert.equal(out.kind, "engine-owned", source);
  }
  const low = resolveTypedRequest({
    nodeClass: "interface-contract",
    recommendation: "REST",
    factText: "REST",
    source: "low-confidence",
    signals: { confidence: "low" },
  });
  assert.equal(low.kind, "auto-settle");
});

test("1.3 external condition without input is a wait, not specification-decision", () => {
  const out = resolveTypedRequest({
    nodeClass: "docs-surface",
    recommendation: "docs PR on trusted base",
    externalConditionWithoutInput: true,
    capability: {
      missing: "docs PR merged to trusted base",
      provider: "github",
      live_probe: "gh pr view --json mergedAt",
      resume_condition: "docs PR is on the trusted base",
    },
  });
  assert.equal(out.kind, "external-condition-wait");
  assert.notEqual(out.kind, "CapabilityRequest");
  assert.notEqual(out.kind, "DecisionRequest");
  const projected = projectPipelineReasonCode("human-context-required");
  assert.notEqual(projected.blockerClass, "specification-decision");
  assert.notEqual(projected.blockerClass, "missing-authority");
});

test("2.1 new resolution records the package; existing bodies still parse", () => {
  const node = makeNode({
    id: "api",
    question: "Which API?",
    recommendation: "REST",
    class: "interface-contract",
  });
  const missing = writeDecisionResolution(node, {
    rationale: "",
    alternatives: [],
    risk: "low",
    evidence: ["REST"],
  });
  assert.equal(missing.ok, false);

  const written = writeDecisionResolution(node, {
    rationale: "reversible in-scope default",
    alternatives: ["GraphQL"],
    risk: "low",
    evidence: ["CONTEXT.md already names REST"],
  });
  assert.equal(written.ok, true);
  if (written.ok) {
    assert.equal(assertNewResolutionPackage(written.node).ok, true);
    assert.equal(written.node.input_digests.definition_sha256, node.input_digests.definition_sha256);
  }

  const spec = "Spec.";
  const art: DecisionsArtifact = {
    schema_version: "decisions.v1",
    nodes: [node],
    fingerprint: testFingerprint(spec),
    required_context: { terms: [], integration_base_sha: null, context_md_sha256: null },
    unresolved_facts: [],
    context_proposals: [],
  };
  const body = embedDecisionsInBody(spec, art);
  const parsed = parseDecisionsFromBody(body);
  assert.equal(parsed.ok, true);
});

test("2.2 incomplete CapabilityRequest fails closed", () => {
  const bad = validateCapabilityRequest({ missing: "token", provider: "gh" });
  assert.equal(bad.ok, false);
  const create = canCreateHandoff({
    domain: "pipeline",
    repo: "acme/widgets",
    issue_number: 1,
    blocked_stage: "triage",
    question: "Need token",
    reason: "missing credential",
    handoff_class: "missing_context",
    required_capability: ["missing_context"],
    resume_target: "triage",
    typed_request: "CapabilityRequest",
    capability_request: { missing: "token", provider: "gh", live_probe: "", resume_condition: "" },
  });
  assert.equal(create.ok, false);
  if (!create.ok) assert.equal(create.code, "incomplete_typed_request");
});

test("2.3 incomplete AuthorityRequest fails closed and never defaults a grant", () => {
  const bad = validateAuthorityRequest({
    eligible_actor: "",
    repository: "acme/widgets",
    operation: "merge",
    scope: "pr",
    candidate_epoch: "a".repeat(40),
    evidence: ["x"],
    expiry: "2026-12-01T00:00:00Z",
    grant: null,
  });
  assert.equal(bad.ok, false);
  const granted = validateAuthorityRequest({
    eligible_actor: "admin",
    repository: "acme/widgets",
    operation: "merge",
    scope: "pr",
    candidate_epoch: "a".repeat(40),
    evidence: ["x"],
    expiry: "2026-12-01T00:00:00Z",
    grant: "auto" as unknown as null,
  });
  assert.equal(granted.ok, false);
  const create = canCreateHandoff({
    domain: "pipeline",
    repo: "acme/widgets",
    issue_number: 1,
    blocked_stage: "merge",
    question: "Authorize merge",
    reason: "missing merge authority",
    handoff_class: "risk_authority",
    required_capability: ["authority"],
    resume_target: "merge",
    typed_request: "AuthorityRequest",
    tip_present: true,
    candidate_sha: "a".repeat(40),
    authority_request: {
      eligible_actor: "admin",
      repository: "acme/widgets",
      operation: "merge",
      scope: "pr",
      candidate_epoch: null,
      evidence: ["x"],
      expiry: "2026-12-01T00:00:00Z",
      grant: null,
    },
  });
  assert.equal(create.ok, false);
});

test("2.4 pause kinds map onto the public union; answer is not authority-grant", () => {
  assert.equal(pauseKindToTypedRequest("decision"), "DecisionRequest");
  assert.equal(pauseKindToTypedRequest("answer"), "CapabilityRequest");
  assert.equal(pauseKindToTypedRequest("authority-grant"), "AuthorityRequest");
  assert.equal(typedRequestToPauseKind("DecisionRequest"), "decision");
  assert.equal(typedRequestToPauseKind("CapabilityRequest"), "answer");
  assert.equal(typedRequestToPauseKind("AuthorityRequest"), "authority-grant");
  assert.notEqual(pauseKindToTypedRequest("decision"), "AuthorityRequest");
  assert.notEqual(durableClassForTypedRequest("DecisionRequest"), "missing-authority");
});

test("3.1 reversible authorized recommendation auto-settles instead of specification-decision", () => {
  const out = classifyHumanAsk({
    reasonCode: "human-decision-required",
    category: "product-decision",
    nodeClass: "interface-contract",
    recommendation: "REST",
    factText: "REST",
    source: "diagnostic",
  });
  assert.equal(out.kind, "auto-settle");
  assert.notEqual(out.kind, "DecisionRequest");
});

test("3.2 human-context-required is not specification-decision or missing-authority", () => {
  const projected = projectPipelineReasonCode("human-context-required");
  assert.notEqual(projected.blockerClass, "specification-decision");
  assert.notEqual(projected.blockerClass, "missing-authority");
  assert.equal(projected.disposition, "recover");
  const cap = classifyHumanAsk({
    reasonCode: "human-context-required",
    nodeClass: "operational-default",
    recommendation: "need the partner API url",
    capability: {
      missing: "partner API url",
      provider: "operator",
      live_probe: "issue body partner-url field",
      resume_condition: "operator supplies the partner API url",
    },
  });
  assert.equal(cap.kind, "CapabilityRequest");
});

test("3.3 contradictory requirements park as DecisionRequest with no retry recipe class", () => {
  const out = classifyHumanAsk({
    reasonCode: "human-decision-required",
    category: "product-decision",
    nodeClass: "scope",
    recommendation: "ship both A and not A",
    signals: { contradictory: true },
    source: "diagnostic",
  });
  assert.equal(out.kind, "DecisionRequest");
  if (out.kind === "DecisionRequest") {
    assert.equal(out.durable_class, "specification-decision");
  }
});

test("3.4 merge/release/deploy/secret/override never auto-settle", () => {
  for (const rec of ["merge this PR", "cut a release", "deploy to prod", "commit the secret", "override the gate"]) {
    const incomplete = resolveTypedRequest({
      nodeClass: "operational-default",
      recommendation: rec,
      factText: rec,
    });
    assert.notEqual(incomplete.kind, "auto-settle", rec);
    const out = resolveTypedRequest({
      nodeClass: "operational-default",
      recommendation: rec,
      factText: rec,
      tipPresent: true,
      candidateSha: "c".repeat(40),
      authority: {
        eligible_actor: "admin",
        repository: "acme/widgets",
        operation: rec.split(" ")[0]!,
        scope: "pr",
        candidate_epoch: "c".repeat(40),
        evidence: [rec],
        expiry: "2026-12-01T00:00:00Z",
      },
    });
    assert.equal(out.kind, "AuthorityRequest", rec);
  }
});

test("3.5 product DecisionRequest is not missing-authority", () => {
  const decision = resolveTypedRequest({
    nodeClass: "interface-contract",
    recommendation: "A and not A",
    signals: { contradictory: true },
  });
  const authority = resolveTypedRequest({
    nodeClass: "merge-release",
    recommendation: "merge this PR",
    category: "authority",
    tipPresent: true,
    candidateSha: "b".repeat(40),
    authority: {
      eligible_actor: "admin",
      repository: "acme/widgets",
      operation: "merge",
      scope: "pr",
      candidate_epoch: "b".repeat(40),
      evidence: ["merge"],
      expiry: "2026-12-01T00:00:00Z",
    },
  });
  assert.equal(decision.kind, "DecisionRequest");
  assert.equal(authority.kind, "AuthorityRequest");
  if (decision.kind === "DecisionRequest" && authority.kind === "AuthorityRequest") {
    assert.notEqual(decision.durable_class, authority.durable_class);
    assert.notEqual(decision.pause_kind, authority.pause_kind);
  }
});

test("4.1 candidate movement invalidates a bound request; leftover blocked label is not a grant", () => {
  assert.equal(
    isCandidateBoundRequestStale({
      boundSha: "a".repeat(40),
      currentSha: "b".repeat(40),
      leftoverBlockedLabel: true,
    }),
    true,
  );
  assert.equal(
    isCandidateBoundRequestStale({
      boundEpoch: "a".repeat(40),
      currentSha: "a".repeat(40),
      leftoverBlockedLabel: true,
    }),
    false,
  );
});

test("4.1 resume refuses a stale candidate-bound answer", async () => {
  const created = canCreateHandoff({
    domain: "pipeline",
    repo: "acme/widgets",
    issue_number: 12,
    blocked_stage: "merge",
    question: "Authorize merge",
    reason: "missing merge authority",
    handoff_class: "risk_authority",
    required_capability: ["authority"],
    resume_target: "merge",
    typed_request: "AuthorityRequest",
    tip_present: true,
    candidate_sha: "a".repeat(40),
    candidate_epoch: "a".repeat(40),
    human_decision_required: {
      finding_key: "deadbeef",
      finding_fingerprint: "0123456789abcdef",
      reviewed_sha: "a".repeat(40),
      category: "authority",
    },
    authority_request: {
      eligible_actor: "admin",
      repository: "acme/widgets",
      operation: "merge",
      scope: "pr",
      candidate_epoch: "a".repeat(40),
      evidence: ["merge requires authority"],
      expiry: "2026-12-01T00:00:00Z",
      grant: null,
    },
    resolution_evidence: {
      unresolved: false,
      eligible_actors: ["admin"],
      resolution_summary: "admin",
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const answered = {
    ...created.handoff,
    status: "answered" as const,
    answer: {
      decision: "answer" as const,
      responder: "admin",
      identity_source: "gh",
      answer_text: "yes",
      answered_at: "2026-09-02T00:00:00Z",
      payload_hash: "x",
    },
  };
  const stale = await validateHandoffResume(answered, { candidate_sha: "b".repeat(40), candidate_epoch: "b".repeat(40) });
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, "stale_sha");
    assert.equal(stale.advances_item, false);
  }
});

test("4.3 auto-settleable in-flight hold is released without a human answer", () => {
  assert.equal(
    shouldReleaseAutoSettleableHold({
      nodeClass: "interface-contract",
      recommendation: "REST",
      factText: "REST",
      category: "product-decision",
      source: "diagnostic",
    }),
    true,
  );
  assert.equal(
    shouldReleaseAutoSettleableHold({
      nodeClass: "interface-contract",
      recommendation: "A and not A",
      signals: { contradictory: true },
      category: "product-decision",
      source: "diagnostic",
    }),
    false,
  );
});

test("5.2 pipeline handoff remains the only answer surface", () => {
  const names = Object.keys(COMMAND_REGISTRY);
  assert.ok(names.includes("handoff"));
  assert.ok(!names.some((n) => /handoff-grant|typed-request-answer|decision-answer/.test(n)));
  const resume = readFileSync(join(__dirname, "../scripts/typed-request-resume.ts"), "utf8");
  assert.match(resume, /does not add a second answer/);
});

test("5.3 synthetic human-ask park without classifier fails the guard", () => {
  const synthetic = `await waitItem(deps, { request: { kind: "decision" } });\n`;
  const hits = collectHumanAskWithoutClassifier(synthetic, "fixture.ts");
  assert.ok(hits.some((h) => /without shared classifier/.test(h.reason)));
  const ok = `import { classifyHumanAsk } from "../typed-request-resolution.ts";\nawait waitItem(deps, { request: { kind: "decision" } });\n`;
  assert.equal(collectHumanAskWithoutClassifier(ok, "scripts/loop/supervisor.ts").length, 0);
});

test("grill settleFrontierNodes writes the resolution package", () => {
  const raw = [
    {
      ...makeNode({
        id: "api",
        question: "Which API?",
        recommendation: "REST",
        class: "interface-contract",
      }),
      signalsRaw: { reversible: true, in_scope: true, policy_consistent: true },
    },
  ];
  const nodes = settleFrontierNodes(raw, "REST");
  assert.equal(nodes[0]!.provenance.settled_by, "auto-accept");
  assert.equal(assertNewResolutionPackage(nodes[0]!).ok, true);
});

test("validateDecisionPackage rejects omitted rationale", () => {
  const bad = validateDecisionPackage({
    recommendation: "REST",
    alternatives: [],
    risk: "low",
    evidence: ["x"],
  });
  assert.equal(bad.ok, false);
});
