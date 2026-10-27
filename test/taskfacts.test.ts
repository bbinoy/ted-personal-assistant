import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_CHAT } from "./runkinds.ts";

// The owner's tasks live in the assistant's own task list (src/tasks/store.ts), not in Notion (22 Oct): the task tools are own data and never judged, finishing or dropping keeps the row and
// can be undone; after the import a Notion edit of the old task table is told to the judge by a code line (its rule: fix, use the task tools); before it, nothing changes; and the owner's chat
// is told once to offer the import while the list is (almost) empty.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "taskfacts-test-"));

const S = await import("../src/tasks/store.ts");
const { tasksNote } = await import("../src/modules/tasks/taskfacts.ts");
const { makeCanUseTool } = await import("../src/approvals/permissions.ts");
const { SYSTEM } = await import("../src/approvals/approvaljudge.ts");

const ZONE = "Europe/Berlin";
const NOW = Date.parse("2026-10-22T10:00:00Z");
const NOTION = "mcp__claude_ai_Notion__notion-update-page";
let n = 0;
const fresh = () => `facts-conv-${++n}`;
const scope = (key: string): import("../src/tasks/store.ts").Scope => ({ key, zone: ZONE, by: "owner", origin: "owner", source: "chat", now: NOW });
// (the owner's 28 tasks were brought over by the one-time import, now gone: those rows carry source_kind import)
const imported = (k: string, title: string) => S.addItem(scope(k), { title, sourceKind: "import", sourceRef: `https://notion.so/${title}` });
const opts = { signal: new AbortController().signal } as never;

test("the owner's own task actions are free in chat: no judge, no question, for add, update, complete, snooze and drop", async () => {
  const can = makeCanUseTool(async () => assert.fail("not asked"), OWNER_CHAT, undefined, async () => assert.fail("not judged"), undefined, undefined, false, { conversation: "owner" });
  for (const t of ["add_task", "update_task", "complete_task", "snooze_task", "drop_task", "list_tasks"]) assert.equal(((await can(`mcp__tasks__${t}`, { id: 1, title: "x" }, opts)) as { behavior: string }).behavior, "allow", t);
});

test("finishing or dropping a task keeps the row with its status, and it can be reopened", () => {
  const k = fresh();
  const a = S.addItem(scope(k), { title: "Call Sam" }).item;
  const b = S.addItem(scope(k), { title: "Pay rent" }).item;
  assert.equal(S.completeItem(scope(k), a.id).item.status, "done");
  assert.equal(S.dropItem(scope(k), b.id).item.status, "dropped");
  assert.deepEqual(S.storeFacts(k), { items: 2, imported: 0 }, "nothing was deleted");
  assert.equal(S.reopenItem(scope(k), a.id).item.status, "open");
  assert.equal(S.reopenItem(scope(k), b.id).item.status, "open");
});

test("the judge is told the tasks moved out of Notion only after the import; before it a Notion edit is judged as today", () => {
  const k = fresh();
  assert.equal(tasksNote(NOTION, k), "", "nothing imported yet: no line");
  S.addItem(scope(k), { title: "Own item" });
  assert.equal(tasksNote(NOTION, k), "", "an item of its own is no import");
  imported(k, "Old Notion task");
  const line = tasksNote(NOTION, k);
  assert.match(line, /^\nTasks: this conversation's tasks live in the assistant's own task list \(2 items, 1 imported from Notion\)/);
  assert.match(line, /should be done with the task tools instead/);
  assert.equal(tasksNote("mcp__claude_ai_Notion__notion-fetch", k), "", "a read is no edit");
  assert.equal(tasksNote("mcp__claude_ai_Google_Calendar__create_event", k), "");
  assert.match(SYSTEM, /carries a "Tasks:" line written by code, the tasks have been moved out of Notion/);
  assert.match(SYSTEM, /choose fix with the reason "the tasks live in the task tools now/);
  assert.match(SYSTEM, /Without that line, judge a Notion edit as usual/);
});

test("the Tasks line reaches the judge with the Notion edit", async () => {
  const k = fresh();
  imported(k, "Imported");
  const seen: string[] = [];
  const can = makeCanUseTool(async () => ({ approved: false }), OWNER_CHAT, undefined, async (i) => (seen.push(i.description), { decision: "fix", reason: "use the task tools" }), undefined, undefined, false, { conversation: k, provenance: () => ({ kind: "owner", message: "tick off the dentist" }) as never });
  const r = (await can(NOTION, { page_id: "tasks", command: "replace_content_range", new_str: "- [x] Dentist" }, opts)) as { behavior: string; message?: string };
  assert.equal(r.behavior, "deny");
  assert.match(r.message ?? "", /use the task tools/);
  assert.match(seen[0]!, /\nTasks: this conversation's tasks live/);
});
