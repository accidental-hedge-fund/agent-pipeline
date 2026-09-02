import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStageDiagnostic,
  lastStageDiagnosticFromEventsJsonl,
  projectPipelineReasonCode,
  projectStageDiagnostic,
  stageDiagnosticFromBlockerSet,
} from "../scripts/stage-diagnostic.ts";
import { BLOCKER_KINDS } from "../scripts/types.ts";
import { normalizeLoopOutcome } from "../scripts/loop-execution-contract.ts";

const AUTHORITY_EVIDENCE = [{
  category: "product-decision" as const,
  finding_key: "deadbeef",
  finding_fingerprint: "0123456789abcdef",
  reviewed_sha: "abc1234",
}];

test("loop execution contract accepts blocked_recoverable as a closed terminal outcome", () => {
  assert.equal(normalizeLoopOutcome("blocked_recoverable"), "blocked_recoverable");
});

test("closed blocker taxonomy: only explicit human-decision-required grants human authority", () => {
  for (const blockerKind of BLOCKER_KINDS) {
    const diagnostic = buildStageDiagnostic({
      blockerKind,
      reason: `structured ${blockerKind}`,
      ...(blockerKind === "human-decision-required" ? { authorityEvidence: AUTHORITY_EVIDENCE } : {}),
    });
    const projected = projectStageDiagnostic(diagnostic);
    if (blockerKind === "human-decision-required") {
      assert.deepEqual(projected, {
        blockerClass: "specification-decision",
        disposition: "human_authority",
      });
    } else if (blockerKind === "worktree-capacity") {
      assert.equal(projected.disposition, "capacity");
    } else {
      assert.equal(projected.disposition, "recover", blockerKind);
    }
  }
});

test("human-context-required is not specification-decision or missing-authority", () => {
  const projected = projectPipelineReasonCode("human-context-required");
  assert.notEqual(projected.blockerClass, "specification-decision");
  assert.notEqual(projected.blockerClass, "missing-authority");
  assert.equal(projected.disposition, "recover");
});

test("generic needs-human and delta-review are mechanical without explicit authority", () => {
  const generic = buildStageDiagnostic({ blockerKind: "needs-human", reason: "free-form says human" });
  assert.equal(projectStageDiagnostic(generic).disposition, "recover");

  // Pre-merge delta-review / round-ceiling path tags project to engine-owned
  // review-findings recovery — not a human-authority default (#814 / #760).
  const delta = buildStageDiagnostic({
    blockerKind: "review-findings",
    reason: "blocking review finding remains",
    stage: "pre-merge",
    offrampClass: "delta-review",
  });
  assert.equal(projectStageDiagnostic(delta).disposition, "recover");
  assert.equal(delta.reason_code, "review-findings");
  assert.equal(projectStageDiagnostic(delta).blockerClass, "review-findings");
});

test("review findings project to a repair-first durable class", () => {
  const diagnostic = buildStageDiagnostic({
    blockerKind: "review-findings",
    reason: "blocking adversarial finding survived a verified repair cycle",
    stage: "review-2",
  });
  assert.equal(diagnostic.reason_code, "review-findings");
  assert.deepEqual(projectStageDiagnostic(diagnostic), {
    blockerClass: "review-findings",
    disposition: "recover",
  });
});

test("explicit human authority cannot be downgraded by a mechanical path tag", () => {
  for (const offrampClass of ["delta-review", "merge-conflict", "openspec-invalid"] as const) {
    const diagnostic = buildStageDiagnostic({
      blockerKind: "human-decision-required",
      reason: "choose the product contract",
      stage: "pre-merge",
      offrampClass,
      authorityEvidence: AUTHORITY_EVIDENCE,
    });
    assert.equal(diagnostic.reason_code, "human-decision-required");
    assert.equal(projectStageDiagnostic(diagnostic).disposition, "human_authority");
  }
});

test("diagnostic policy is adapter-neutral by construction", () => {
  const source = buildStageDiagnostic({
    blockerKind: "harness-failure",
    reason: "adapter returned no structured result",
    stage: "review-1",
  });
  for (const adapter of ["claude", "codex", "grok", "extension-adapter"]) {
    const projected = projectStageDiagnostic({ ...source, detail: { ...source.detail } });
    assert.equal(projected.disposition, "recover", adapter);
    assert.equal(projected.blockerClass, "workflow-engine-defect", adapter);
  }
});

test("environment authentication is a typed recoverable class, not a human-authority inference", () => {
  const diagnostic = buildStageDiagnostic({
    reasonCode: "environment-auth",
    blockerKind: "harness-failure",
    reason: "configured forge credentials are unavailable",
  });
  assert.deepEqual(projectStageDiagnostic(diagnostic), {
    blockerClass: "environment-auth",
    disposition: "recover",
  });
});

test("producer evidence key is preserved and fallback evidence ignores free-form prose", () => {
  const supplied = buildStageDiagnostic({
    reasonCode: "openspec-archive-apply-conflict",
    evidenceKey: "openspec:change-42:archive-conflict",
    blockerKind: "openspec-invalid",
    reason: "cli prose one",
    stage: "pre-merge",
    offrampClass: "openspec-invalid",
  });
  assert.equal(supplied.evidence_key, "openspec:change-42:archive-conflict");
  assert.equal(projectStageDiagnostic(supplied).disposition, "recover");

  const a = buildStageDiagnostic({ blockerKind: "merge-conflict", reason: "first wording", stage: "pre-merge" });
  const b = buildStageDiagnostic({ blockerKind: "merge-conflict", reason: "different wording", stage: "pre-merge" });
  assert.equal(a.evidence_key, b.evidence_key);
});

test("exact OpenSpec reason cannot downgrade an unrelated human decision", () => {
  const human = buildStageDiagnostic({
    blockerKind: "human-decision-required",
    reason: "choose API",
    authorityEvidence: AUTHORITY_EVIDENCE,
  });
  const malformed = { ...human, reason_code: "openspec-archive-apply-conflict" };
  assert.equal(projectStageDiagnostic(malformed).disposition, "protocol_failure");
});

test("final blocker_set prefers exact producer diagnostic and rejects envelope mismatch", () => {
  const diagnostic = buildStageDiagnostic({
    reasonCode: "openspec-generated-delta-invalid",
    evidenceKey: "openspec:change-755:generated-delta",
    blockerKind: "openspec-invalid",
    reason: "SHALL clause is structurally invalid",
    stage: "plan-review",
  });
  const event = {
    type: "blocker_set",
    reason: diagnostic.detail.reason,
    stage: diagnostic.detail.stage,
    blocker_kind: diagnostic.detail.blocker_kind,
    diagnostic,
  };
  const exact = lastStageDiagnosticFromEventsJsonl(`${JSON.stringify(event)}\n`);
  assert.equal(exact.diagnostic?.reason_code, "openspec-generated-delta-invalid");
  assert.equal(exact.diagnostic?.evidence_key, "openspec:change-755:generated-delta");

  const mismatch = stageDiagnosticFromBlockerSet({ ...event, reason: "different outer reason" });
  assert.equal(mismatch.disposition, "protocol_failure");
  assert.equal(mismatch.diagnostic, null);
});

test("missing, malformed, and unknown diagnostics are protocol failures", () => {
  assert.equal(projectStageDiagnostic(null).disposition, "protocol_failure");
  assert.equal(projectPipelineReasonCode("future-v2-reason").disposition, "protocol_failure");
  assert.equal(lastStageDiagnosticFromEventsJsonl("").disposition, "protocol_failure");
  assert.equal(
    lastStageDiagnosticFromEventsJsonl(JSON.stringify({ type: "blocker_set", reason: "prose only" })).disposition,
    "protocol_failure",
  );
});

test("the final blocker_set controls classification; malformed final event does not fall back", () => {
  const text = [
    JSON.stringify({ type: "blocker_set", blocker_kind: "merge-conflict", reason: "conflict" }),
    JSON.stringify({ type: "blocker_set", blocker_kind: "future-kind", reason: "unknown" }),
  ].join("\n");
  const resolution = lastStageDiagnosticFromEventsJsonl(text);
  assert.equal(resolution.disposition, "protocol_failure");
  assert.equal(resolution.diagnostic, null);
});

// ---------------------------------------------------------------------------
// Write-health fail-safe (#633)
// ---------------------------------------------------------------------------

test("missing blocker_set with elevated write-health is workflow-engine-defect, not human hold (#633)", () => {
  const resolution = lastStageDiagnosticFromEventsJsonl("", {
    failure_count: 1,
    worst_criticality: "control-critical",
    last_error: "ENOSPC",
    last_event_type: "blocker_set",
  });
  assert.equal(resolution.disposition, "protocol_failure");
  assert.equal(resolution.blockerClass, "workflow-engine-defect");
  assert.equal(resolution.diagnostic, null);
  assert.match(resolution.protocolError ?? "", /event-stream write failure/);
  assert.match(resolution.protocolError ?? "", /control-critical/);
  // Must not invent human authority from missing evidence.
  assert.notEqual(resolution.disposition, "human_authority");
});

test("missing blocker_set without write-health keeps the classic protocol error (#633)", () => {
  const resolution = lastStageDiagnosticFromEventsJsonl("");
  assert.equal(resolution.disposition, "protocol_failure");
  assert.equal(resolution.protocolError, "blocked item has no final blocker_set diagnostic");
});

// Regression (#633 review 2): unreadable write-health (elevated fail-safe) must
// surface the persistence-failure protocol path — not the ordinary missing
// evidence message that recovery would get if unreadable collapsed to absent.
test("missing blocker_set with unreadable write-health surfaces event-stream write failure (#633)", () => {
  const resolution = lastStageDiagnosticFromEventsJsonl("", {
    failure_count: 1,
    worst_criticality: "control-critical",
    last_error: "write-health.json unreadable or corrupt",
    last_event_type: null,
  });
  assert.equal(resolution.disposition, "protocol_failure");
  assert.equal(resolution.blockerClass, "workflow-engine-defect");
  assert.match(resolution.protocolError ?? "", /event-stream write failure/);
  assert.notEqual(
    resolution.protocolError,
    "blocked item has no final blocker_set diagnostic",
  );
});

test("partial events with elevated write-health still use the final valid blocker_set when present (#633)", () => {
  const text = [
    JSON.stringify({
      type: "blocker_set",
      blocker_kind: "merge-conflict",
      reason: "conflict on main",
    }),
    "{partial",
  ].join("\n");
  const resolution = lastStageDiagnosticFromEventsJsonl(text, {
    failure_count: 1,
    worst_criticality: "best-effort",
    last_error: "truncated",
  });
  // A valid final blocker_set still classifies — write-health does not invent a
  // different class when the control record is present.
  assert.equal(resolution.blockerClass, "workflow-state");
  assert.equal(resolution.disposition, "recover");
  assert.ok(resolution.diagnostic);
});
