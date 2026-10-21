import { test } from "node:test";
import assert from "node:assert/strict";
import { capTotal, cleanToolOutput } from "../src/core/toolclean.ts";
import { loadSettings } from "../src/core/settings.ts";

// A tool result is capped in total (TOOL_OUTPUT_MAX_CHARS), whichever tool made it: an MCP connector's answer goes through the same PostToolUse clean (agentrun.ts).

const filler = (n: number): string => Array.from({ length: n }, (_, i) => ((i + 1) * 7919).toString(36)).join(" ").slice(0, n); // (no long runs of one character: the sanitiser collapses those on its own)
const mcp = (text: string) => ({ content: [{ type: "text", text }] });
const text = (r: { output: unknown } | undefined) => ((r!.output as ReturnType<typeof mcp>).content[0] as { text: string }).text;

test("setting: TOOL_OUTPUT_MAX_CHARS defaults to 60000 and is validated", () => {
  assert.equal(loadSettings({}).toolOutputMaxChars, 60_000);
  assert.equal(loadSettings({ TOOL_OUTPUT_MAX_CHARS: "5000" }).toolOutputMaxChars, 5000);
  assert.throws(() => loadSettings({ TOOL_OUTPUT_MAX_CHARS: "10" }), /TOOL_OUTPUT_MAX_CHARS/);
});

test("a result over the cap keeps its start and ends with how much was cut and what to do", () => {
  const r = cleanToolOutput("mcp__claude_ai_Notion__notion-fetch", mcp(filler(1000)), 400);
  assert.ok(r);
  assert.equal(r.cut, 600);
  const out = text(r);
  assert.ok(out.startsWith(filler(1000).slice(0, 400)));
  assert.match(out, /\n\[\.\.\. 600 characters cut: narrow the query or use page_token\]$/);
  assert.equal(out.length, 400 + out.slice(400).length);
});

test("a result under the cap is untouched (and a result nothing needed to clean is left as it is)", () => {
  assert.equal(cleanToolOutput("mcp__x__y", mcp("short"), 400), undefined);
  assert.equal(cleanToolOutput("mcp__x__y", mcp(filler(400)), 400), undefined, "exactly at the cap");
});

test("the cap is on the whole result: many strings share the budget in reading order, the note is on the last one, binary fields do not count", () => {
  const big = filler(300);
  const result = { content: [{ type: "text", text: big }, { type: "text", text: big }, { type: "image", data: "B".repeat(5000), mimeType: "image/png" }, { type: "text", text: big }], meta: { data: "C".repeat(9000) } };
  const r = cleanToolOutput("mcp__x__list", result, 500)!;
  const o = r.output as typeof result;
  assert.equal(o.content[0]!.text, big, "the first is whole");
  assert.equal(o.content[1]!.text!.length, 200, "the second takes what is left");
  assert.match(o.content[3]!.text!, /^\n\[\.\.\. 400 characters cut/, "the third is empty but for the note");
  assert.equal((o.content[2] as { data: string }).data.length, 5000, "an image is left alone");
  assert.equal(o.meta.data.length, 9000, "so is a data field");
});

test("capTotal: a JSON string is capped as text too, a surrogate pair is not split, and no cap means whole", () => {
  assert.equal(capTotal({ a: "ok" }, 100).cut, 0);
  const emoji = "😀".repeat(10); // 20 UTF-16 units
  const kept = (capTotal(emoji, 5).value as string).split("\n")[0]!;
  assert.equal(kept, "😀😀", "5 units would end inside the third pair: the half is dropped");
  const r = cleanToolOutput("mcp__x__y", mcp(JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, name: filler(20 + i) })) })), 1000)!;
  assert.ok(text(r).length < 1200 && /characters cut/.test(text(r)));
});
