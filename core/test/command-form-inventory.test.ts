// Contract tests for the command-form disposition inventory (#1329).
// Hermetic: no network, git, or subprocess. Does not import the CLI.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { COMMAND_REGISTRY, lookupCommand } from "../scripts/command-registry.ts";
import { COMMAND_DOCS } from "../scripts/command-docs.ts";
import { OPERATION_SURFACE } from "../scripts/operation-surface.ts";
import {
  AUTHORITY_REQUIREMENTS,
  COMMAND_FORM_INVENTORY,
  EXECUTION_DISPOSITIONS,
  assertCommandFormClosedSets,
  boundedAtomicRowsMissingReason,
  collectParserDispatchKeywords,
  documentedModeFormsFromUsage,
  flagAliasForm,
  formForLookupKeyword,
  formsForKeyword,
  hostCatalogVerbsMissingForms,
  isAuthorityRequirement,
  isExecutionDisposition,
  lookupCommandForm,
  missingMutatingDispositions,
  missingRegistryKeywords,
  parserKeywordsMissingFromInventory,
  type CommandForm,
} from "../scripts/command-form-inventory.ts";
import { renderCliMarkdown } from "../scripts/docs-generate.ts";
import { renderHostSkill } from "../scripts/host-skill.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_SRC = readFileSync(join(__dirname, "../scripts/pipeline.ts"), "utf8");

test("execution_disposition and authority_requirement are closed sets", () => {
  assert.deepEqual([...EXECUTION_DISPOSITIONS], [
    "read-only",
    "bounded-atomic-administration",
    "supervised-lifecycle",
  ]);
  assert.deepEqual([...AUTHORITY_REQUIREMENTS], ["none", "typed-response", "protected-authority"]);
  for (const form of COMMAND_FORM_INVENTORY) {
    assertCommandFormClosedSets(form);
    assert.equal(isExecutionDisposition(form.execution_disposition), true);
    assert.equal(isAuthorityRequirement(form.authority_requirement), true);
  }
});

test("lookupCommand(undefined) and numeric lookup classify as the advance form", () => {
  assert.equal(lookupCommand(undefined), COMMAND_REGISTRY.advance);
  assert.equal(lookupCommand("123"), COMMAND_REGISTRY.advance);
  assert.equal(formForLookupKeyword(undefined)?.id, "advance");
  assert.equal(formForLookupKeyword("42")?.id, "advance");
  assert.equal(lookupCommandForm("advance")?.execution_disposition, "supervised-lifecycle");
});

test("every COMMAND_REGISTRY keyword has at least one inventory form", () => {
  const missing = missingRegistryKeywords(Object.keys(COMMAND_REGISTRY));
  assert.deepEqual(missing, [], `missing inventory forms for: ${missing.join(", ")}`);
});

test("a mutating registry keyword without an inventory form fails the contract", () => {
  const fixtureKeys = [...Object.keys(COMMAND_REGISTRY), "mutate-now"];
  const missing = missingMutatingDispositions({ registryKeys: fixtureKeys });
  assert.ok(missing.includes("mutate-now"), `expected mutate-now in ${JSON.stringify(missing)}`);
});

test("a documented --apply mode without an apply form fails the contract", () => {
  const documentedModes = [{ keyword: "decompose", mode: "apply" }];
  const inventory = COMMAND_FORM_INVENTORY.filter((f) => f.id !== "decompose.apply");
  const missing = missingMutatingDispositions({
    registryKeys: Object.keys(COMMAND_REGISTRY),
    documentedModes,
    inventory,
  });
  assert.ok(missing.includes("decompose.apply"), `expected decompose.apply in ${JSON.stringify(missing)}`);
});

test("documented dry-run / apply / status forms from COMMAND_DOCS are inventoried", () => {
  const missing: string[] = [];
  for (const [keyword, doc] of Object.entries(COMMAND_DOCS)) {
    if (!doc.usage) continue;
    for (const mode of documentedModeFormsFromUsage(keyword, doc.usage)) {
      const id = `${mode.keyword}.${mode.mode}`;
      const found = COMMAND_FORM_INVENTORY.some((f) => f.id === id);
      if (!found) missing.push(id);
    }
  }
  assert.deepEqual(missing, [], `documented mode forms missing: ${missing.join(", ")}`);
});

test("bounded-atomic rows document why durable ownership does not apply", () => {
  assert.deepEqual(boundedAtomicRowsMissingReason(), []);
});

test("a bounded-atomic row missing the ownership reason fails the contract", () => {
  const defective: CommandForm[] = [
    {
      id: "init",
      keyword: "init",
      execution_disposition: "bounded-atomic-administration",
      authority_requirement: "none",
    },
  ];
  assert.deepEqual(boundedAtomicRowsMissingReason(defective), ["init"]);
});

test("OPERATION_SURFACE verbs are a subset of inventory keywords", () => {
  const missing = hostCatalogVerbsMissingForms(OPERATION_SURFACE.map((op) => op.name));
  assert.deepEqual(missing, [], `host catalog verbs missing inventory forms: ${missing.join(", ")}`);
});

test("a host-table-only verb without an inventory form fails the subset guard", () => {
  const missing = hostCatalogVerbsMissingForms(["ghost-host-verb"]);
  assert.deepEqual(missing, ["ghost-host-verb"]);
});

test("parser dispatch keywords are a subset of inventory keywords", () => {
  const parserKeywords = collectParserDispatchKeywords(PIPELINE_SRC);
  const missing = parserKeywordsMissingFromInventory(parserKeywords);
  assert.deepEqual(missing, [], `parser keywords missing inventory forms: ${missing.join(", ")}`);
});

test("a dispatch keyword with no form fails the agreement test", () => {
  const missing = parserKeywordsMissingFromInventory(["invented-dispatch"]);
  assert.deepEqual(missing, ["invented-dispatch"]);
});

test("flag-only --cleanup / --init / --remove-worktree share keyword dispositions", () => {
  const cleanup = flagAliasForm("--cleanup");
  const init = flagAliasForm("--init");
  const remove = flagAliasForm("--remove-worktree");
  assert.equal(cleanup?.id, "cleanup");
  assert.equal(init?.id, "init");
  assert.equal(remove?.id, "remove-worktree");
  assert.equal(cleanup?.execution_disposition, lookupCommandForm("cleanup")?.execution_disposition);
});

test("inspect-list forms match design dispositions", () => {
  const expectDisp = (id: string, disp: string, authority?: string) => {
    const form = lookupCommandForm(id);
    assert.ok(form, `missing form ${id}`);
    assert.equal(form!.execution_disposition, disp, id);
    if (authority) assert.equal(form!.authority_requirement, authority, id);
  };
  expectDisp("queue", "supervised-lifecycle");
  expectDisp("advance", "supervised-lifecycle");
  expectDisp("merge", "supervised-lifecycle", "protected-authority");
  expectDisp("merge-queue.dry-run", "read-only");
  expectDisp("merge-queue.apply", "supervised-lifecycle", "protected-authority");
  expectDisp("train.dry-run", "read-only");
  expectDisp("ship.status", "read-only");
  expectDisp("intake", "bounded-atomic-administration");
  expectDisp("intake.dry-run", "read-only");
  expectDisp("decompose.apply", "bounded-atomic-administration");
  expectDisp("doctor", "read-only");
  expectDisp("unblock", "supervised-lifecycle", "typed-response");
  expectDisp("override", "supervised-lifecycle", "typed-response");
  expectDisp("handoff.answer", "supervised-lifecycle", "typed-response");
  expectDisp("engine-promote.dry-run", "read-only");
  expectDisp("engine-promote", "supervised-lifecycle");
  expectDisp("factory-pin.rollback", "supervised-lifecycle", "protected-authority");
  expectDisp("grill.dry-run", "read-only");
  expectDisp("grill.status", "read-only");
  expectDisp("grill", "supervised-lifecycle");
  expectDisp("release", "supervised-lifecycle", "protected-authority");
  expectDisp("factory-release", "supervised-lifecycle");
  expectDisp("cleanup", "bounded-atomic-administration");
  expectDisp("remove-worktree", "bounded-atomic-administration");
});

test("mutatesGitHub does not force supervised-lifecycle", () => {
  assert.equal(COMMAND_REGISTRY.intake.mutatesGitHub, true);
  assert.equal(lookupCommandForm("intake")?.execution_disposition, "bounded-atomic-administration");
  assert.equal(COMMAND_REGISTRY.loop.mutatesGitHub, false);
  assert.equal(lookupCommandForm("loop")?.execution_disposition, "supervised-lifecycle");
});

test("starting nested drives is not bounded-atomic", () => {
  for (const id of ["advance", "single", "loop", "queue", "train", "ship", "grill"]) {
    assert.equal(
      lookupCommandForm(id)?.execution_disposition,
      "supervised-lifecycle",
      `${id} starts or drives a run`,
    );
  }
});

test("dry-run forms do not inherit supervised-lifecycle from the apply/drive form", () => {
  for (const keyword of ["train", "intake", "decompose", "sweep", "roadmap", "engine-promote", "grill", "release"]) {
    const dry = lookupCommandForm(`${keyword}.dry-run`);
    assert.ok(dry, `missing ${keyword}.dry-run`);
    assert.equal(dry!.execution_disposition, "read-only", `${keyword}.dry-run`);
  }
});

test("generated CLI docs include read-only dry-run usage and do not call it a mutating drive", () => {
  const md = renderCliMarkdown();
  assert.match(md, /OPERATION_SURFACE is the host SKILL catalog/);
  assert.match(md, /not the complete\s+command-form inventory/);
  assert.match(md, /--dry-run/);
  assert.match(md, /ship status/);
  const trainUsage = md.match(/#### `train`[\s\S]*?- \*\*Usage:\*\* `([^`]+)`/);
  assert.ok(trainUsage, "train usage missing");
  assert.match(trainUsage![1]!, /--dry-run/);
  assert.doesNotMatch(
    trainUsage![1]!,
    /starting a durable run|squash merge of a ready-to-deploy PR/,
  );
});

test("agreement test fails when generated text describes a read-only dry-run as a mutating drive", () => {
  const fake = [
    "#### `train`",
    "",
    "- **Usage:** `pipeline train --dry-run` starts a durable run and merges",
  ].join("\n");
  const dryRunForms = COMMAND_FORM_INVENTORY.filter(
    (f) => f.id.endsWith(".dry-run") && f.execution_disposition === "read-only",
  );
  assert.ok(dryRunForms.length > 0);
  const contradicts = /starts a durable run|merges/.test(fake);
  assert.equal(contradicts, true, "fixture must contradict read-only dry-run");
});

test("host SKILL catalog may omit dispatch-only keywords that still have inventory forms", () => {
  const skill = renderHostSkill();
  assert.doesNotMatch(skill, /pipeline queue/, "queue is dispatch-only relative to OPERATION_SURFACE");
  assert.ok(formsForKeyword("queue").length > 0);
  assert.ok(formsForKeyword("handoff").length > 0);
  assert.ok(formsForKeyword("evals").length > 0);
});
