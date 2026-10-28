import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The guard for a class of silent failure: a routine note whose `when:` line cannot be read never runs. Every repeat rule shown as an example in the plugin skills, the persona, the docs and the README, and
// every form the live notes were written with, must be readable by the parser (src/tasks/repeat.ts).

const { parseRepeat } = await import("../src/tasks/repeat.ts");

test("every repeat example in the docs and skills parses", () => {
  const files: string[] = ["README.md"];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(md|txt)$/.test(e.name)) files.push(f);
    }
  };
  for (const d of ["plugin", "assistants/ted/persona", "docs"]) walk(d);
  const day = "(?:day|weekday|weekend|mon|tue|wed|thu|fri|sat|sun)[a-z]*";
  const found = new Set<string>(["every fri at 16:30", "every mon and thu at 09:00", "every weekday at 18:30", "every day at 08:00 Europe/Zurich", "every year on 28 nov at 19:00"]);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/`((?:every|daily|weekly|monthly|yearly|weekdays)(?: [^`\n]*)?)`/gi)) found.add(m[1]!);
    for (const m of text.matchAll(/when:\s*`?((?:every|daily|weekly|monthly|yearly|weekdays)\b[^`\n"]*)/gi)) found.add(m[1]!.trim());
    for (const m of text.matchAll(new RegExp(`["“](every ${day}(?:, ${day})*(?: and ${day})? at \\d{1,2}(?::\\d{2})?(?:\\s?[ap]m)?)`, "gi"))) found.add(m[1]!);
  }
  assert.ok(found.size > 5);
  for (const rule of found) assert.ok(parseRepeat(rule).ok, `"${rule}" is shown as an example but does not parse`);
});
