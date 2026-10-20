import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/conversation/markdown.ts";
import { toSignalStyles } from "@ted-assistant/signal/messenger";

// Helper: the text each style range covers, to assert offsets land on the right characters.
const covered = (md: string) => {
  const r = renderMarkdown(md);
  return { text: r.text, spans: r.styles.map((s) => `${s.style}:${r.text.slice(s.start, s.start + s.length)}`) };
};

test("bold and italic", () => {
  const r = covered("Hello **world** and *there*");
  assert.equal(r.text, "Hello world and there");
  assert.deepEqual(r.spans, ["BOLD:world", "ITALIC:there"]);
});

test("nested italic inside bold", () => {
  const r = covered("**very *nice* day**");
  assert.equal(r.text, "very nice day");
  assert.deepEqual(r.spans.sort(), ["BOLD:very nice day", "ITALIC:nice"].sort());
});

test("headings become bold lines, bullets become dots", () => {
  const r = covered("## Focus\n- one\n* two **x**");
  assert.equal(r.text, "Focus\n• one\n• two x");
  assert.deepEqual(r.spans.sort(), ["BOLD:Focus", "BOLD:x"].sort());
});

test("code spans and fences are monospace; markers inside are literal", () => {
  const r = covered("run `a*b*c` now\n```\nx **y**\n```");
  assert.equal(r.text, "run a*b*c now\nx **y**");
  assert.deepEqual(r.spans, ["MONOSPACE:a*b*c", "MONOSPACE:x **y**"]);
});

test("snake_case and math stars are left alone", () => {
  const r = covered("use some_var_name and 2 * 3 * 4");
  assert.equal(r.text, "use some_var_name and 2 * 3 * 4");
  assert.deepEqual(r.spans, []);
});

test("links keep the url visible", () => {
  const r = covered("see [the doc](https://example.com/a) ok");
  assert.equal(r.text, "see the doc (https://example.com/a) ok");
});

test("offsets are UTF-16: emoji before bold", () => {
  const r = renderMarkdown("📅 **Mon 12 Oct**");
  const s = r.styles[0]!;
  assert.equal(r.text.slice(s.start, s.start + s.length), "Mon 12 Oct");
  assert.equal(toSignalStyles(r.styles)[0], `${s.start}:${s.length}:BOLD`);
});

test("horizontal rules dropped, blank runs squeezed", () => {
  assert.equal(renderMarkdown("a\n\n\n\n---\n\nb").text, "a\n\nb");
});

