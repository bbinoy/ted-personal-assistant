import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, splitSections } from "../src/markdown.ts";
import { toSignalStyles } from "@ted-personal-assistant/signal/messenger";

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

test("splitSections splits on headings only", () => {
  assert.deepEqual(splitSections("intro\n## A\nx\n## B\ny"), ["intro", "## A\nx", "## B\ny"]);
  const long = ("word ".repeat(100) + "\n\n").repeat(6);
  assert.equal(splitSections(long).length, 1);
});

test("brief on Signal: pep talk and focus only, then a pointer to the email", async () => {
  const { signalSummary, BRIEF_FOOTER } = await import("../src/markdown.ts");
  const brief = "## 💪 Pep talk\n\nBelieve, Ben.\n\n## 🎯 Focus\n\n- **Answer Quark**\n\n## 📥 Needs you\n\n- lots of detail\n\n## 🧹 Housekeeping\n\nArchived 3.";
  const s = signalSummary(brief);
  assert.match(s, /^## 💪 Pep talk\n\nBelieve, Ben\.\n\n## 🎯 Focus\n\n- \*\*Answer Quark\*\*\n\n📧 The full brief is in your email/);
  assert.ok(s.endsWith(BRIEF_FOOTER));
  assert.doesNotMatch(s, /lots of detail|Archived/);
  // no pep talk: focus alone
  assert.doesNotMatch(signalSummary("## 🎯 Focus\n\n- one\n\n## 📥 Needs you\n\n- x"), /Needs you/);
  // headings missing: the start of the brief, bounded
  assert.ok(signalSummary("x".repeat(3000)).length < 900);
});
