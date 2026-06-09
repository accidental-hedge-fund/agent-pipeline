// Unit tests for the last30days non-blocking setup hint (#34) — no skill /
// Python required. `gatherCarryForward` is exercised through an injected `run`
// stub so the two empty-brief branches and the disabled fast-path are covered
// deterministically (the repo's testgate.ts uses the same dependency-injection
// seam for external calls).

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  buildResearchTopic,
  buildSetupHint,
  formatHumanFeedback,
  gatherCarryForward,
  HUMAN_FEEDBACK_ACK_HEADER,
  revisedPlanHeader,
  sanitizeBodyForResearch,
  validateHumanFeedbackAck,
  type CarryForwardDeps,
} from "../scripts/stages/planning.ts";
import type { BriefResult } from "../scripts/last30days.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const enabledCfg = {
  last30days: { enabled: true, timeout: 600 },
} as unknown as PipelineConfig;

// Disabled is the default — gatherCarryForward returns before touching any deps.
const disabledCfg = {
  last30days: { enabled: false, timeout: 600 },
} as unknown as PipelineConfig;

/** A `run` stub that records its calls and resolves to a fixed BriefResult. */
function stubRun(result: BriefResult): { deps: CarryForwardDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      run: async (topic: string) => {
        calls.push(topic);
        return result;
      },
    },
  };
}

/** Capture console.log lines emitted during `fn`, restoring the original after. */
async function captureLogs(t: TestContext, fn: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  await fn();
  return logged;
}

// ---------------------------------------------------------------------------
// buildSetupHint — message content (keys, install, link)
// ---------------------------------------------------------------------------

test("buildSetupHint: unavailable mode names install command and data-source keys", () => {
  const hint = buildSetupHint(42, "unavailable");
  assert.match(hint, /#42/);
  assert.match(hint, /npx.*last30days/i);
  assert.match(hint, /data-source keys/i);
  assert.match(hint, /BRAVE_SEARCH_API_KEY/);
  assert.match(hint, /SCRAPECREATORS_API_KEY/);
  assert.match(hint, /last30days-skill/);
});

test("buildSetupHint: no-signal mode names both keys and links to skill setup", () => {
  const hint = buildSetupHint(99, "no-signal");
  assert.match(hint, /#99/);
  assert.match(hint, /BRAVE_SEARCH_API_KEY/);
  assert.match(hint, /SCRAPECREATORS_API_KEY/);
  assert.match(hint, /last30days-skill/);
});

// ---------------------------------------------------------------------------
// gatherCarryForward — branch behavior (4.1 / 4.2 / 4.3)
// ---------------------------------------------------------------------------

test("gatherCarryForward: hint emitted + '' returned when run() is unavailable", async (t) => {
  const { deps, calls } = stubRun({ brief: "", stats: "", success: false, unavailable: true });
  let result = "<unset>";
  const logged = await captureLogs(t, async () => {
    result = await gatherCarryForward(enabledCfg, 42, "test topic", undefined, deps);
  });

  assert.equal(result, "");
  assert.deepEqual(calls, ["test topic"], "run() should be called once with the topic");
  const hint = logged.find((m) => m.includes("last30days:"));
  assert.ok(hint, `expected a last30days hint, saw: ${logged.join(" | ")}`);
  assert.match(hint!, /not found/i);
  assert.match(hint!, /npx.*last30days/i);
});

test("gatherCarryForward: hint emitted + '' returned when run() yields no signal", async (t) => {
  // success: true but the brief has no cluster/### markers → hasSignal() is false.
  const { deps } = stubRun({
    brief: "Thin prose with no grouped findings or markdown headings.",
    stats: "",
    success: true,
    unavailable: false,
  });
  let result = "<unset>";
  const logged = await captureLogs(t, async () => {
    result = await gatherCarryForward(enabledCfg, 7, "topic", undefined, deps);
  });

  assert.equal(result, "");
  const hint = logged.find((m) => m.includes("last30days:"));
  assert.ok(hint, `expected a last30days hint, saw: ${logged.join(" | ")}`);
  assert.match(hint!, /no usable signal/i);
  assert.match(hint!, /BRAVE_SEARCH_API_KEY/);
});

test("gatherCarryForward: hint emitted + '' returned when run() fails (success: false)", async (t) => {
  const { deps } = stubRun({ brief: "", stats: "", success: false, unavailable: false });
  let result = "<unset>";
  const logged = await captureLogs(t, async () => {
    result = await gatherCarryForward(enabledCfg, 8, "topic", undefined, deps);
  });

  assert.equal(result, "");
  const hint = logged.find((m) => m.includes("last30days:") && /no usable signal/i.test(m));
  assert.ok(hint, `expected a no-signal hint, saw: ${logged.join(" | ")}`);
});

test("gatherCarryForward: no hint and run() never called when last30days disabled", async (t) => {
  const { deps, calls } = stubRun({ brief: "", stats: "", success: true, unavailable: false });
  let result = "<unset>";
  const logged = await captureLogs(t, async () => {
    result = await gatherCarryForward(disabledCfg, 42, "test topic", undefined, deps);
  });

  assert.equal(result, "");
  assert.deepEqual(calls, [], "run() must not be called when disabled");
  assert.ok(
    !logged.some((m) => m.includes("last30days:")),
    `expected no hint but saw: ${logged.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// buildResearchTopic — topic construction logic (#37)
// ---------------------------------------------------------------------------

// BODY_TOPIC_CAP in planning.ts — the body excerpt cap. Mirrored here so the
// boundary assertions below stay readable; keep in sync if the constant changes.
const BODY_TOPIC_CAP = 400;

test("buildResearchTopic: body absent returns title unchanged", () => {
  assert.equal(buildResearchTopic("My title"), "My title");
});

test("buildResearchTopic: empty body returns title unchanged", () => {
  assert.equal(buildResearchTopic("My title", ""), "My title");
});

test("buildResearchTopic: whitespace-only body returns title unchanged", () => {
  assert.equal(buildResearchTopic("My title", "   \n\t  "), "My title");
});

test("buildResearchTopic: short body appended verbatim", () => {
  const body = "A short description.";
  const result = buildResearchTopic("My title", body);
  assert.equal(result, `My title\n\n${body}`);
});

test("buildResearchTopic: body at exactly the cap is appended verbatim", () => {
  const body = "x".repeat(BODY_TOPIC_CAP);
  const result = buildResearchTopic("My title", body);
  assert.equal(result, `My title\n\n${body}`);
  assert.ok(!result.endsWith("…"), "body at the cap must not be truncated");
});

test("buildResearchTopic: long body is excerpted, bounded, and marked with an ellipsis", () => {
  const body = "word ".repeat(200).trim(); // ~999 chars, well over the cap
  const result = buildResearchTopic("My title", body);
  const prefix = "My title\n\n";
  assert.ok(result.startsWith(prefix), "title should come first");
  assert.ok(result.endsWith("…"), "long body should end with a truncation marker");
  // Excerpt (between the prefix and the trailing …) must be within the cap.
  const excerpt = result.slice(prefix.length, -1);
  assert.ok(excerpt.length <= BODY_TOPIC_CAP, `excerpt ${excerpt.length} must be ≤ ${BODY_TOPIC_CAP}`);
  assert.ok(result.length <= prefix.length + BODY_TOPIC_CAP + 1, "total length stays bounded");
});

test("buildResearchTopic: excerpt ends on a word boundary (no mid-word split, no trailing space)", () => {
  const body = "word ".repeat(200).trim();
  const result = buildResearchTopic("My title", body);
  const excerpt = result.slice("My title\n\n".length, -1); // strip trailing …
  assert.ok(!excerpt.endsWith(" "), "excerpt should not end with a trailing space");
  assert.ok(excerpt.endsWith("word"), "excerpt should end on a complete word");
});

// ---------------------------------------------------------------------------
// gatherCarryForward — body-aware topic (#37)
// ---------------------------------------------------------------------------

test("gatherCarryForward: run() receives title + body topic when body is provided", async (t) => {
  const body = "Detailed description here.";
  const { deps, calls } = stubRun({ brief: "", stats: "", success: false, unavailable: true });
  await captureLogs(t, async () => {
    await gatherCarryForward(enabledCfg, 1, "My issue", body, deps);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], buildResearchTopic("My issue", body));
  assert.ok(calls[0].includes("My issue") && calls[0].includes(body), "topic carries title and body");
});

test("gatherCarryForward: run() receives title-only when body is empty (no regression)", async (t) => {
  const { deps, calls } = stubRun({ brief: "", stats: "", success: false, unavailable: true });
  await captureLogs(t, async () => {
    await gatherCarryForward(enabledCfg, 2, "My issue", "", deps);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "My issue");
});

test("gatherCarryForward: run() receives title-only when body is omitted (no regression)", async (t) => {
  const { deps, calls } = stubRun({ brief: "", stats: "", success: false, unavailable: true });
  await captureLogs(t, async () => {
    await gatherCarryForward(enabledCfg, 3, "My issue", undefined, deps);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "My issue");
});

// ---------------------------------------------------------------------------
// sanitizeBodyForResearch — secret/PII redaction before external boundary (#37)
// ---------------------------------------------------------------------------

test("sanitizeBodyForResearch: plain text passes through unchanged", () => {
  const text = "We should add a feature to improve the dashboard loading speed.";
  assert.equal(sanitizeBodyForResearch(text), text);
});

test("sanitizeBodyForResearch: http URL is redacted", () => {
  const result = sanitizeBodyForResearch("See http://internal.corp/path?token=abc for details.");
  assert.ok(!result.includes("http://"), "URL must not appear in output");
  assert.ok(result.includes("[REDACTED]"), "placeholder must be present");
});

test("sanitizeBodyForResearch: https URL is redacted", () => {
  const result = sanitizeBodyForResearch("Docs: https://internal.corp/secret-page");
  assert.ok(!result.includes("https://"), "https URL must be redacted");
  assert.ok(result.includes("[REDACTED]"));
});

test("sanitizeBodyForResearch: email address is redacted", () => {
  const result = sanitizeBodyForResearch("Contact owner@company.com for access.");
  assert.ok(!result.includes("@company.com"), "email must be redacted");
  assert.ok(result.includes("[REDACTED]"));
});

test("sanitizeBodyForResearch: Bearer token is redacted", () => {
  const result = sanitizeBodyForResearch("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig");
  assert.ok(!result.includes("eyJhbGciOiJSUzI1NiJ9"), "Bearer token must be redacted");
  assert.ok(result.includes("[REDACTED]"));
});

test("sanitizeBodyForResearch: long hex string (API key / hash) is redacted", () => {
  const hexKey = "a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6";
  const result = sanitizeBodyForResearch(`API key: ${hexKey}`);
  assert.ok(!result.includes(hexKey), "hex key must be redacted");
  assert.ok(result.includes("[REDACTED]"));
});

test("sanitizeBodyForResearch: key=value assignment is redacted", () => {
  const result = sanitizeBodyForResearch("Set secret=mysupersecretvalue in your env.");
  assert.ok(!result.includes("mysupersecretvalue"), "secret value must be redacted");
  assert.ok(result.includes("[REDACTED]"));
});

test("sanitizeBodyForResearch: api_key assignment is redacted", () => {
  const result = sanitizeBodyForResearch("Use api_key=sk-abc123xyz for auth.");
  assert.ok(!result.includes("sk-abc123xyz"), "api key value must be redacted");
  assert.ok(result.includes("[REDACTED]"));
});

test("sanitizeBodyForResearch: body with only a URL becomes non-empty placeholder", () => {
  const result = sanitizeBodyForResearch("https://example.com/secret");
  assert.ok(!result.includes("https://"), "URL must be redacted");
  assert.ok(result.includes("[REDACTED]"));
});

test("buildResearchTopic: body containing a URL has URL redacted in output", () => {
  const body = "Reproduce at https://internal.corp/debug?token=secret every time.";
  const result = buildResearchTopic("My title", body);
  assert.ok(!result.includes("https://"), "URL must not appear in the research topic");
  assert.ok(result.includes("[REDACTED]"), "placeholder must appear");
  assert.ok(result.includes("My title"), "title must still be present");
});

test("buildResearchTopic: body containing an email has email redacted in output", () => {
  const body = "Reported by user@example.com — see attached logs.";
  const result = buildResearchTopic("Bug report", body);
  assert.ok(!result.includes("user@example.com"), "email must not appear in the research topic");
  assert.ok(result.includes("[REDACTED]"));
});

test("buildResearchTopic: body containing a hex API key has key redacted in output", () => {
  const hexKey = "deadbeefcafebabe1234567890abcdef";
  const body = `Set token=${hexKey} in your config.`;
  const result = buildResearchTopic("Setup issue", body);
  assert.ok(!result.includes(hexKey), "hex key must not appear in the research topic");
  assert.ok(result.includes("[REDACTED]"));
});

// ---------------------------------------------------------------------------
// Human plan feedback (#26) — formatHumanFeedback / revisedPlanHeader
// ---------------------------------------------------------------------------

test("formatHumanFeedback: undefined when there are no human comments", () => {
  assert.equal(formatHumanFeedback([]), undefined);
});

test("formatHumanFeedback: renders @login: body blocks separated by blank lines", () => {
  const out = formatHumanFeedback([
    { author: "alice", body: "use the existing helper" },
    { author: "bob", body: "handle the empty case too" },
  ]);
  assert.equal(out, "@alice: use the existing helper\n\n@bob: handle the empty case too");
});

test("revisedPlanHeader: includes **Human feedback from** line when humans commented", () => {
  const lines = revisedPlanHeader("claude", "codex", [{ author: "alice" }, { author: "bob" }]);
  assert.deepEqual(lines, [
    "**Updated by**: claude",
    "**Based on review by**: codex",
    "**Human feedback from**: @alice, @bob",
  ]);
});

test("revisedPlanHeader: dedupes repeat commenters", () => {
  const lines = revisedPlanHeader("claude", "codex", [{ author: "alice" }, { author: "alice" }]);
  assert.equal(lines[2], "**Human feedback from**: @alice");
});

test("revisedPlanHeader: header unchanged when no human comments", () => {
  const lines = revisedPlanHeader("claude", "codex", []);
  assert.deepEqual(lines, ["**Updated by**: claude", "**Based on review by**: codex"]);
});

// ---------------------------------------------------------------------------
// validateHumanFeedbackAck (#26) — acknowledgement guard
// ---------------------------------------------------------------------------

test("validateHumanFeedbackAck: passes when there are no human comments (no ack required)", () => {
  assert.equal(validateHumanFeedbackAck("Any revised plan content", []), true);
});

test("validateHumanFeedbackAck: passes when ack section is present and human comments exist", () => {
  const plan = `## My Plan\n\nDo the thing.\n\n${HUMAN_FEEDBACK_ACK_HEADER}\n\n- @alice: addressed — implemented as suggested`;
  assert.equal(validateHumanFeedbackAck(plan, [{ author: "alice" }]), true);
});

test("validateHumanFeedbackAck: fails when human comments exist but ack section is absent", () => {
  const plan = "## My Plan\n\nDo the thing.";
  assert.equal(validateHumanFeedbackAck(plan, [{ author: "alice" }]), false);
});

test("validateHumanFeedbackAck: fails when human comments exist and plan is empty", () => {
  assert.equal(validateHumanFeedbackAck("", [{ author: "alice" }]), false);
});

test("validateHumanFeedbackAck: fails when ack text is present but heading is not an exact match", () => {
  // Partial matches or alternate headings must not satisfy the guard.
  const plan = "## My Plan\n\nHuman Feedback Acknowledgement (inline, not a heading)";
  assert.equal(validateHumanFeedbackAck(plan, [{ author: "alice" }]), false);
});

test("validateHumanFeedbackAck: passes when there are multiple commenters and ack section is present", () => {
  const plan = `## Steps\n\n1. thing\n\n${HUMAN_FEEDBACK_ACK_HEADER}\n\n- @alice: addressed\n- @bob: declined — out of scope`;
  assert.equal(validateHumanFeedbackAck(plan, [{ author: "alice" }, { author: "bob" }]), true);
});
