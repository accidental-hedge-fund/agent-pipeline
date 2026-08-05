// Unit tests for the universal stage-output contract layer (#777).
// Pure validators + shared format-repair + golden fixtures — no network/git/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FORMAT_REPAIR_BUDGET,
  REQUIRED_STAGE_OUTPUT_CONTRACT_IDS,
  STAGE_OUTPUT_CONTRACT_FOLLOW_UPS,
  STAGE_OUTPUT_LAYERING,
  buildHarnessContractDiagnostic,
  evaluateGoldenFixture,
  getStageOutputContract,
  listGoldenFixtures,
  listStageOutputContracts,
  registerGoldenFixture,
  resetGoldenFixturesForTests,
  runFormatRepairLoop,
  validateOpenspecChangeSingular,
  validatePlanRevisionAck,
  validateReviewVerdict,
  validateStageOutput,
} from "../scripts/stage-output-contract.ts";
import { projectStageDiagnostic } from "../scripts/stage-diagnostic.ts";
import { readFileSync as readSrc } from "node:fs";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "stage-output-contract",
);

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

// ---------------------------------------------------------------------------
// Registry completeness
// ---------------------------------------------------------------------------

test("registry contains the minimum in-scope contract ids (#777)", () => {
  const ids = new Set(listStageOutputContracts().map((c) => c.id));
  for (const required of REQUIRED_STAGE_OUTPUT_CONTRACT_IDS) {
    assert.ok(ids.has(required), `missing required contract ${required}`);
    const c = getStageOutputContract(required)!;
    assert.ok(c.id.includes("@"), "id must include version");
    assert.equal(typeof c.validate, "function");
    assert.ok(c.version >= 1);
    assert.ok(c.sideEffectGate.length > 0);
  }
});

test("each registered contract id includes an explicit version component", () => {
  for (const c of listStageOutputContracts()) {
    assert.match(c.id, /@\d+$/, `${c.id} must end with @N`);
  }
});

test("follow-up registration list is pinned and cannot grow silently", () => {
  // Prefer registering low-cost schema stages rather than extending this list.
  assert.equal(
    STAGE_OUTPUT_CONTRACT_FOLLOW_UPS.length,
    3,
    "update this assertion only when deliberately adding a tracked follow-up with an issue link",
  );
  for (const f of STAGE_OUTPUT_CONTRACT_FOLLOW_UPS) {
    assert.ok(f.id.length > 0);
    assert.ok(f.issue.length > 0);
    assert.ok(f.note.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Pure validators
// ---------------------------------------------------------------------------

test("plan-revision.ack@1 accepts mid-line Grok-shaped acknowledgement", () => {
  const stdout = loadFixture("grok-midline-ack.stdout.txt");
  const result = validateStageOutput("plan-revision.ack@1", { stdout });
  assert.equal(result.ok, true);
});

test("plan-revision.ack@1 accepts line-start Claude acknowledgement", () => {
  const stdout = loadFixture("claude-line-start-ack.stdout.txt");
  const result = validatePlanRevisionAck({ stdout });
  assert.equal(result.ok, true);
});

test("plan-revision.ack@1 rejects missing section", () => {
  const result = validatePlanRevisionAck({ stdout: "## Revised Plan\n\nNo ack." });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /Feedback Incorporated/);
  }
});

test("openspec.change-singular@1 rejects multi-change fixture", () => {
  const input = JSON.parse(loadFixture("openspec-multi-change.json")) as {
    fresh: string[];
    all: string[];
  };
  const result = validateOpenspecChangeSingular(input);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /2 new changes/);
  }
});

test("openspec.change-singular@1 accepts exactly one fresh change", () => {
  const result = validateOpenspecChangeSingular({
    fresh: ["only-one"],
    all: ["only-one"],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value?.changeId, "only-one");
  }
});

test("review.verdict@1 accepts fenced JSON verdict", () => {
  const stdout = loadFixture("review-fenced-verdict.stdout.txt");
  const result = validateReviewVerdict(stdout);
  assert.equal(result.ok, true);
});

test("review.verdict@1 accepts empty findings (valid product shape, not unparseable)", () => {
  const stdout = JSON.stringify({
    verdict: "approve",
    summary: "LGTM",
    findings: [],
    next_steps: [],
  });
  const result = validateReviewVerdict(stdout);
  assert.equal(result.ok, true, "empty findings array is valid schema shape");
});

test("review.verdict@1 rejects prose-only unparseable shape", () => {
  const result = validateReviewVerdict("Looks fine to me, ship it.");
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Shared format-repair policy
// ---------------------------------------------------------------------------

test("format-repair: first failure triggers exactly one repair re-prompt", async () => {
  let invokes = 0;
  const result = await runFormatRepairLoop({
    validate: (s: string) =>
      s.includes("OK") ? { ok: true } : { ok: false, reason: "not OK" },
    initialOutput: "bad",
    repairInvoke: async () => {
      invokes++;
      return { success: true, output: "OK fixed" };
    },
  });
  assert.equal(invokes, 1);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.repaired, true);
    assert.equal(result.attempts, 2);
  }
});

test("format-repair: default budget does not perform a second automatic repair", async () => {
  let invokes = 0;
  const result = await runFormatRepairLoop({
    validate: () => ({ ok: false, reason: "always bad" }),
    initialOutput: "bad",
    repairInvoke: async () => {
      invokes++;
      return { success: true, output: `attempt-${invokes}` };
    },
  });
  assert.equal(DEFAULT_FORMAT_REPAIR_BUDGET, 1);
  assert.equal(invokes, 1, "only one repair under default budget");
  assert.equal(result.status, "contract-exhausted");
  if (result.status === "contract-exhausted") {
    assert.equal(result.attempts, 2);
    assert.equal(result.reason, "always bad");
  }
});

test("format-repair: invoke failure during repair returns invoke-failed", async () => {
  const result = await runFormatRepairLoop({
    validate: () => ({ ok: false, reason: "shape" }),
    initialOutput: "bad",
    repairInvoke: async () => ({ success: false, reason: "timed out" }),
  });
  assert.equal(result.status, "invoke-failed");
  if (result.status === "invoke-failed") {
    assert.equal(result.reason, "timed out");
  }
});

test("format-repair: ok on first attempt does not call repairInvoke", async () => {
  let invokes = 0;
  const result = await runFormatRepairLoop({
    validate: () => ({ ok: true }),
    initialOutput: "good",
    repairInvoke: async () => {
      invokes++;
      return { success: true, output: "x" };
    },
  });
  assert.equal(invokes, 0);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.repaired, false);
    assert.equal(result.attempts, 1);
  }
});

// ---------------------------------------------------------------------------
// Terminal harness-contract diagnostics
// ---------------------------------------------------------------------------

test("exhausted pure shape failure diagnostic is harness-contract and engine-owned", () => {
  const diagnostic = buildHarnessContractDiagnostic({
    reason: "Plan revision output is missing required ## Feedback Incorporated section",
    stage: "plan-review",
  });
  assert.equal(diagnostic.schema, "pipeline/stage-diagnostic@1");
  assert.equal(diagnostic.reason_code, "harness-contract");
  assert.equal(diagnostic.detail.blocker_kind, "harness-failure");
  const projection = projectStageDiagnostic(diagnostic);
  assert.equal(projection.disposition, "recover");
  assert.notEqual(projection.disposition, "human_authority");
  assert.equal(projection.blockerClass, "workflow-engine-defect");
});

// ---------------------------------------------------------------------------
// Golden fixtures + extension hook
// ---------------------------------------------------------------------------

test("built-in golden fixtures pass through central validate (catalog adapter only)", () => {
  resetGoldenFixturesForTests();
  registerGoldenFixture({
    id: "grok-midline-ack",
    adapter: "grok",
    contractId: "plan-revision.ack@1",
    input: { stdout: loadFixture("grok-midline-ack.stdout.txt") },
    expectOk: true,
    description: "#622 Grok mid-line ## Feedback Incorporated",
  });
  registerGoldenFixture({
    id: "claude-line-start-ack",
    adapter: "claude",
    contractId: "plan-revision.ack@1",
    input: { stdout: loadFixture("claude-line-start-ack.stdout.txt") },
    expectOk: true,
  });
  registerGoldenFixture({
    id: "review-fenced-verdict",
    adapter: "codex",
    contractId: "review.verdict@1",
    input: loadFixture("review-fenced-verdict.stdout.txt"),
    expectOk: true,
  });
  registerGoldenFixture({
    id: "openspec-multi-change",
    adapter: "claude",
    contractId: "openspec.change-singular@1",
    input: JSON.parse(loadFixture("openspec-multi-change.json")),
    expectOk: false,
  });

  for (const fixture of listGoldenFixtures()) {
    const result = evaluateGoldenFixture(fixture);
    assert.equal(
      result.ok,
      fixture.expectOk,
      `${fixture.id}: expected ok=${fixture.expectOk}, got ${JSON.stringify(result)}`,
    );
  }
});

test("extension adapter golden fixture uses the same central validate path", () => {
  resetGoldenFixturesForTests();
  registerGoldenFixture({
    id: "extension-ack-ok",
    adapter: "pi-extension",
    contractId: "plan-revision.ack@1",
    input: {
      stdout: "## Feedback Incorporated\n\n- [ADDRESSED] ext\n",
    },
    expectOk: true,
  });
  const [fixture] = listGoldenFixtures();
  assert.equal(fixture.adapter, "pi-extension");
  const result = evaluateGoldenFixture(fixture);
  assert.equal(result.ok, true);
  // And direct validate matches
  assert.equal(
    validateStageOutput(fixture.contractId, fixture.input).ok,
    result.ok,
  );
});

// ---------------------------------------------------------------------------
// Layering / no provider-name branch in validation path
// ---------------------------------------------------------------------------

test("stage-output validation modules do not branch acceptance on harness/provider name", () => {
  const modulePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../scripts/stage-output-contract.ts",
  );
  const src = readSrc(modulePath, "utf8");
  // Strip comments and string literals that mention adapter names as catalog metadata.
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    // Drop golden-fixture adapter catalog strings and docs.
    .replace(/adapter:\s*["'`][^"'`]+["'`]/g, "adapter: __CATALOG__")
    .replace(/registerGoldenFixture[\s\S]*?^\s*\}/gm, "");

  const forbidden = [
    /if\s*\(\s*(?:harness|provider|adapter(?:Name)?)\s*===/,
    /switch\s*\(\s*(?:harness|provider|adapter(?:Name)?)\s*\)/,
    /harness\s*===\s*["'`]grok["'`]/,
    /provider\s*===\s*["'`]claude["'`]/,
    /adapter\s*===\s*["'`]codex["'`]/,
  ];
  for (const re of forbidden) {
    assert.equal(
      re.test(codeOnly),
      false,
      `forbidden provider-branch pattern ${re} found in stage-output-contract.ts`,
    );
  }
  assert.equal(STAGE_OUTPUT_LAYERING.providerBranchForbidden, true);
  assert.deepEqual(STAGE_OUTPUT_LAYERING.order, [
    "adapter-envelope-normalization",
    "stage-output-contract-validate",
  ]);
});

test("plan-revision private full repair loop is not reintroduced in planning.ts", () => {
  const planningPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../scripts/stages/planning.ts",
  );
  const src = readSrc(planningPath, "utf8");
  // Must use shared helper; must not re-embed a private multi-attempt while loop for ack.
  assert.match(src, /runContractWithFormatRepair/);
  assert.match(src, /plan-revision\.ack@1/);
  // The old private pattern re-assigned ackCheck after a single inline repair without the shared helper.
  // Guard: PLAN_REVISION_FORMAT_REPAIR_ADDENDUM must be a thin re-export, not a second copy of the loop.
  // Prefer pure `export { X as Y } from` (avoids circular-import TDZ); still accept the older assignment form.
  assert.match(
    src,
    /export\s*\{\s*PLAN_REVISION_ACK_REPAIR_ADDENDUM\s+as\s+PLAN_REVISION_FORMAT_REPAIR_ADDENDUM\s*\}\s*from\s*["'][^"']*stage-output-contract\.ts["']|PLAN_REVISION_FORMAT_REPAIR_ADDENDUM\s*=\s*PLAN_REVISION_ACK_REPAIR_ADDENDUM/,
  );
});

test("shared format-repair budget constant is single-sourced at 1", () => {
  assert.equal(DEFAULT_FORMAT_REPAIR_BUDGET, 1);
});
