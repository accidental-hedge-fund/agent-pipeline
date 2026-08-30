#!/usr/bin/env node
// Fixture provider for tests. Production planning-facts.ts does not import this.
import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "alembic", "versions");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".py")).sort();
let head = "";
for (const file of files) {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  const m = text.match(/^revision\s*=\s*"([^"]+)"/m);
  if (m) head = m[1];
}
process.stdout.write(JSON.stringify({ schema_version: 1, facts: { alembic_head: head } }));
