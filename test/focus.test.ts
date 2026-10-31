import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Focus today: a task carries the local day it is a focus item for; it is "focus today" only on that day in the conversation's zone (src/tasks/store.ts, render.ts, the page and /tasks).
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "focus-test-"));

const S = await import("../src/tasks/store.ts");
const { groupOpen, tasksText } = await import("../src/tasks/render.ts");
const { tasksPage } = await import("../src/tasks/taskspage.ts");
const { createTasksServer } = await import("../src/modules/tasks/tasktools.ts");

const ZONE = "Europe/Berlin";
const NOW = Date.parse("2026-10-22T10:00:00Z"); // Thu 22 Oct 12:00 in Berlin
const DAY = 86_400_000;
let n = 0;
const fresh = () => `focus-conv-${++n}`;
const scope = (key: string, now = NOW, zone = ZONE): import("../src/tasks/store.ts").Scope => ({ key, zone, by: "owner", origin: "owner", source: "chat", now });
const add = (key: string, title: string, o: Partial<import("../src/tasks/store.ts").NewItem> = {}) => S.addItem(scope(key), { kind: "task", title, ...o }).item.id;

test("a focus item shows first, not under Today, in time order; the other groups are unchanged", () => {
  const k = fresh();
  const late = add(k, "Send invoice", { due: "2026-10-22T16:00" });
  const early = add(k, "Call Sam", { due: "2026-10-22T09:00" });
  add(k, "Water plants", { due: "2026-10-22" });
  const open = add(k, "Read paper");
  S.editItem(scope(k), late, { focus: true });
  S.editItem(scope(k), early, { focus: true });
  S.editItem(scope(k), open, { focus: true });
  const g = groupOpen(S.listItems(k, { limit: 50 }, NOW, ZONE), NOW, ZONE);
  assert.deepEqual(g["🎯 Focus today"].map((i) => i.title), ["Call Sam", "Send invoice", "Read paper"]);
  assert.deepEqual(g.Today.map((i) => i.title), ["Water plants"]);
  assert.deepEqual(g["No date"], []);
});

test("a focus mark from yesterday is not focus today, with no cleanup", () => {
  const k = fresh();
  const id = add(k, "Old focus", { due: "2026-10-22" });
  S.editItem(scope(k, NOW - DAY), id, { focus: true });
  const g = groupOpen(S.listItems(k, {}, NOW, ZONE), NOW, ZONE);
  assert.deepEqual([g["🎯 Focus today"].length, g.Today.length], [0, 1]);
  assert.ok(!tasksText(k, NOW, ZONE).includes("Focus today"));
});

test("at most five focus items a day; the sixth is refused with a message to act on", () => {
  const k = fresh();
  const ids = Array.from({ length: 6 }, (_, i) => add(k, `Item ${i}`));
  for (const id of ids.slice(0, 5)) S.editItem(scope(k), id, { focus: true });
  assert.throws(() => S.editItem(scope(k), ids[5]!, { focus: true }), /Focus today is full \(5 items\).*focus false/);
  S.editItem(scope(k), ids[5]!, { title: "Item 5 renamed" }); // (other edits are fine)
  S.editItem(scope(k), ids[0]!, { focus: true }); // (already in: not a sixth)
  S.editItem(scope(k), ids[0]!, { focus: false });
  S.editItem(scope(k), ids[5]!, { focus: true });
  S.completeItem(scope(k), ids[1]!); // (a done item frees a place)
  assert.equal(S.getItem(k, ids[5]!)!.focusOn, "2026-10-22");
  assert.equal(S.getItem(k, ids[0]!)!.focusOn, undefined);
  // yesterday's five do not count today
  const j = fresh();
  const old = Array.from({ length: 5 }, (_, i) => add(j, `Old ${i}`));
  for (const id of old) S.editItem(scope(j, NOW - DAY), id, { focus: true });
  S.editItem(scope(j), add(j, "New"), { focus: true });
});

test("the day is the conversation's: late evening where UTC is already tomorrow", () => {
  const LA = "America/Los_Angeles";
  const late = Date.parse("2026-10-23T03:00:00Z"); // Thu 22 Oct 20:00 in Los Angeles, Fri 23 Oct in UTC
  const k = fresh();
  const id = S.addItem(scope(k, late, LA), { kind: "task", title: "Pack bags" }).item.id;
  S.editItem(scope(k, late, LA), id, { focus: true });
  assert.equal(S.getItem(k, id)!.focusOn, "2026-10-22");
  assert.equal(groupOpen(S.listItems(k, {}, late, LA), late, LA)["🎯 Focus today"].length, 1);
  const morning = Date.parse("2026-10-23T08:00:00Z"); // Fri 23 Oct 01:00 there
  assert.equal(groupOpen(S.listItems(k, {}, morning, LA), morning, LA)["🎯 Focus today"].length, 0);
});

test("the page and /tasks show the same focus list first", () => {
  const k = fresh();
  const a = add(k, "Call Sam", { due: "2026-10-22T15:00" });
  const b = add(k, "Book flights", { due: "2026-10-30" });
  add(k, "Water plants", { due: "2026-10-22" });
  S.editItem(scope(k), a, { focus: true });
  S.editItem(scope(k), b, { focus: true });
  const text = tasksText(k, NOW, ZONE);
  assert.match(text, /^Tasks: 3 open\n\n🎯 Focus today \(2\)\n• Call Sam · 15:00\n• Book flights · Fri 30 Oct\n\nToday \(1\)\n• Water plants/);
  const html = tasksPage(k, NOW, ZONE);
  const at = ["🎯 Focus today (2)", "Today (1)"].map((h) => html.indexOf(h));
  assert.ok(at[0]! > 0 && at[0]! < at[1]!);
  assert.match(html, /<details open class="focus"><summary>🎯 Focus today \(2\)<\/summary>/);
  assert.ok(html.indexOf("Call Sam") < html.indexOf("Book flights") && html.indexOf("Book flights") < at[1]!);
  assert.match(html, /details\.focus\{background:#2e7d6b1f/); // (the accent; the page colours read on light and dark)
});

test("the tool sets and clears focus, says when it is full, and list_tasks shows it", async () => {
  const k = fresh();
  const t = createTasksServer({ key: k, source: "group", unattended: false, zone: () => ZONE, now: () => NOW }) as unknown as {
    instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }> };
  };
  const tools = t.instance._registeredTools;
  const ids = Array.from({ length: 6 }, (_, i) => add(k, `Task ${i}`));
  const r = await tools.update_task!.handler({ id: ids[0], focus: true });
  assert.match(r.content[0]!.text, /^Edited task #\d+ 'Task 0' \(changed focus\)/);
  assert.match((await tools.list_tasks!.handler({})).content[0]!.text, /#\d+ \[task\] Task 0 \| focus today/);
  for (const id of ids.slice(1, 5)) await tools.update_task!.handler({ id, focus: true });
  const full = await tools.update_task!.handler({ id: ids[5], focus: true });
  assert.equal(full.isError, true);
  assert.match(full.content[0]!.text, /Focus today is full/);
  assert.equal((await tools.update_task!.handler({ id: ids[0], focus: false })).isError, undefined);
  assert.doesNotMatch((await tools.list_tasks!.handler({})).content[0]!.text, /Task 0 \| focus today/);
});
