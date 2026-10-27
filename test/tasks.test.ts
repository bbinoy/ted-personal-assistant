import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BROWSE_RUN, GROUP_CHAT, GROUP_LOOK, OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";

// Tasks (src/tasks, src/modules/tasks): the store over a conversation's assistant.db, its history, the strict validation, the tools and what each kind of run may do with them, the permission
// floor, the /tasks command, the journal lines and the audit rows, one conversation never seeing another's list, and the list going with the conversation when it is forgotten.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "tasks-test-"));

const S = await import("../src/tasks/store.ts");
const { itemLine, tasksText } = await import("../src/tasks/render.ts");
const { createTasksServer } = await import("../src/modules/tasks/tasktools.ts");
const { classify } = await import("../src/policy/policy.ts");
const { allows, groupCapabilities, groupTools, toolsFor, capabilitiesOf } = await import("../src/policy/capabilities.ts");
const { buildOptions } = await import("../src/run/agentrun.ts");
const { commandReply, parseCommand } = await import("../src/conversation/ownercommands.ts");
const { noteDone } = await import("../src/approvals/journalrender.ts");
const { convDb, hasConvDb, peekConvDb } = await import("../src/core/convdb.ts");
const { convIdOfKey, convPaths, friendConvId, groupConvId } = await import("../src/core/convpaths.ts");
const { ledgerEntries } = await import("../src/core/messages.ts");
const { readAudit } = await import("../src/core/audit.ts");
const { forgetFriend, forgetGroup } = await import("../src/conversation/forget.ts");
const { groupDir, recordGroup } = await import("../src/conversation/groupstore.ts");
const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { askingIn, setAsking } = await import("../src/modules/voice/voicenote.ts");

const ZONE = "Europe/Berlin"; // CEST until 25 Oct 2026
const NOW = Date.parse("2026-10-22T10:00:00Z"); // Thu 22 Oct 12:00 in Berlin
let n = 0;
const fresh = () => `tasks-conv-${++n}`; // a group key: its own conversation, its own database
const scope = (key: string, o: Partial<import("../src/tasks/store.ts").Scope> = {}): import("../src/tasks/store.ts").Scope => ({ key, zone: ZONE, by: "owner", origin: "owner", source: "chat", now: NOW, ...o });
const events = (key: string) => peekConvDb(convIdOfKey(key))!.all<{ id: number; item_id: number; at: number; by: string; action: string; before: string | null; after: string | null }>("SELECT * FROM task_events ORDER BY id");
const journalOf = (key: string) => ledgerEntries(convPaths(convIdOfKey(key)).messages).filter((m) => m.kind === "journal").map((m) => m.text);

type Tools = Record<string, { handler: (a: unknown, extra?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>; inputSchema: { safeParse: (v: unknown) => { success: boolean } } }>;
const toolsOf = (run: Parameters<typeof createTasksServer>[0]) => (createTasksServer(run) as unknown as { instance: { _registeredTools: Tools } }).instance._registeredTools;
const chat = (key: string, o: Partial<Parameters<typeof createTasksServer>[0]> = {}) => toolsOf({ key, source: "group", unattended: false, zone: () => ZONE, now: () => NOW, ...o });
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

test("tasks: add, edit, complete, reopen, snooze, drop: each is one history row with the fields that changed, and numbers are never reused", () => {
  const k = fresh();
  const a = S.addItem(scope(k), { title: "Call Sam", due: "2026-10-24T14:30", person: "Sam", details: "about the invoice" });
  assert.equal(a.item.id, 1);
  assert.equal(a.line, "Added task #1 'Call Sam' (due Sat 24 Oct 14:30, with Sam)");
  assert.deepEqual([a.item.status, a.item.sourceKind, a.item.dueZone], ["open", "message", ZONE]);
  const e = S.editItem(scope(k, { now: NOW + 1000 }), 1, { due: "2026-10-26", details: null });
  assert.equal(e.line, "Edited task #1 'Call Sam' (changed details, due)");
  assert.equal(e.item.details, undefined);
  const d = S.completeItem(scope(k, { now: NOW + 2000 }), 1);
  assert.deepEqual([d.item.status, d.item.doneAt], ["done", NOW + 2000]);
  assert.equal(d.line, "Completed task #1 'Call Sam'");
  assert.throws(() => S.completeItem(scope(k), 1), /already done/);
  assert.throws(() => S.editItem(scope(k), 1, { title: "x" }), /is done; reopen it/);
  const r = S.reopenItem(scope(k, { now: NOW + 3000 }), 1);
  assert.deepEqual([r.item.status, r.item.doneAt], ["open", undefined]);
  const z = S.snoozeItem(scope(k, { now: NOW + 4000 }), 1, NOW + 86_400_000);
  assert.equal(z.item.status, "snoozed");
  assert.match(z.line, /^Snoozed task #1 'Call Sam' \(until Fri 23 Oct 12:00\)$/);
  assert.throws(() => S.snoozeItem(scope(k), 1, NOW - 1), /future/);
  const x = S.dropItem(scope(k, { now: NOW + 5000 }), 1);
  assert.equal(x.item.status, "dropped");
  assert.throws(() => S.dropItem(scope(k), 1), /already dropped/);
  S.reopenItem(scope(k, { now: NOW + 6000 }), 1);
  const b = S.addItem(scope(k), { title: "Second" });
  assert.equal(b.item.id, 2, "numbered on");
  const rows = events(k);
  assert.deepEqual(rows.map((r) => r.action), ["added", "edited", "done", "reopened", "snoozed", "dropped", "reopened", "added"]);
  assert.deepEqual({ ...rows[1] }, { id: rows[1]!.id, item_id: 1, at: NOW + 1000, by: "owner", action: "edited", before: JSON.stringify({ details: "about the invoice", due: "2026-10-24T14:30" }), after: JSON.stringify({ details: null, due: "2026-10-26" }) } as never, "before and after hold only what changed");
  assert.deepEqual(S.eventsOf(k, 1).map((x) => x.action), ["added", "edited", "done", "reopened", "snoozed", "dropped", "reopened"]);
  assert.equal(JSON.parse(rows[2]!.after!).status, "done");
  assert.equal(JSON.parse(rows[2]!.before!).status, "open");
});

test("tasks: nothing is deleted anywhere: the store has no such path, the code has none, and the database refuses it", () => {
  const exported = Object.keys(S);
  assert.deepEqual(exported.filter((x) => /delete|remove|purge|destroy|erase|forget/i.test(x)), [], "the store exports no deleting function");
  // no source file deletes from or drops the task tables (the one place tables go is deleting a whole conversation's folder)
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  const src = resolve(import.meta.dirname, "../src");
  for (const f of walk(src)) {
    const t = readFileSync(f, "utf8");
    if (f.endsWith("core/convdb.ts")) continue; // (the migration itself: its triggers name DELETE to refuse it)
    assert.doesNotMatch(t, /DELETE\s+FROM\s+(items|task_events)\b/i, f);
    assert.doesNotMatch(t, /DROP\s+(TABLE|TRIGGER)\s+(IF EXISTS\s+)?(items|task_events|items_no_delete|task_events_no_)/i, f);
    assert.doesNotMatch(t, /UPDATE\s+task_events\b/i, f);
  }
  // and the database says no by itself, whatever code tried
  const k = fresh();
  S.addItem(scope(k), { title: "Keep me" });
  const db = convDb(convIdOfKey(k));
  assert.throws(() => db.run("DELETE FROM items WHERE id = 1"), /never deleted/);
  assert.throws(() => db.run("DELETE FROM task_events"), /append-only/);
  assert.throws(() => db.run("UPDATE task_events SET by = 'x'"), /append-only/);
  assert.equal(S.getItem(k, 1)?.title, "Keep me");
  assert.equal(events(k).length, 1);
});

test("tasks: a repeating item is not finished, it moves to its next due (and keeps its reminder's distance); one with only a reminder moves the reminder", () => {
  const k = fresh();
  const r = S.addItem(scope(k), { title: "Water plants", due: "2026-10-19T09:00", repeat: "Every  Monday at 9", remindAt: Date.parse("2026-10-19T06:30:00Z") });
  assert.equal(r.item.repeat, "every monday at 09:00", "stored in the canonical form");
  const done = S.completeItem(scope(k), r.item.id);
  assert.equal(done.next, "2026-10-26T09:00");
  assert.deepEqual([done.item.status, done.item.due, done.item.doneAt], ["open", "2026-10-26T09:00", NOW]);
  assert.equal(done.line, "Completed task #1 'Water plants' (next: Mon 26 Oct 09:00)");
  assert.equal(done.item.remindAt, Date.parse("2026-10-26T07:30:00Z"), "half an hour before 09:00 local on the 26th, in the new (winter) offset");
  assert.equal(S.eventsOf(k, 1).at(-1)!.action, "done");
  const k2 = fresh();
  const rem = S.addItem(scope(k2), { title: "Stretch", remindAt: Date.parse("2026-10-22T07:00:00Z"), repeat: "every day at 09:00" });
  const next = S.completeItem(scope(k2), rem.item.id);
  assert.equal(next.item.remindAt, Date.parse("2026-10-23T07:00:00Z"));
  assert.throws(() => S.addItem(scope(k2), { title: "No start", repeat: "every day" }), /needs a due date or a reminder/);
  assert.throws(() => S.editItem(scope(k2), 1, { remindAt: null }), /needs a due date or a reminder/);
});

test("tasks: what a look adds is an ordinary open item with its source; the same mail, or the same words, are not added twice; a look changes, finishes, snoozes and drops like a chat (journalled), but adds at most 10 a day", () => {
  const k = fresh();
  S.addItem(scope(k), { title: "Mine" });
  const bg = scope(k, { by: S.LOOK_BY, unattended: true, source: "background" });
  const s = S.addItem(bg, { title: "Reply to the landlord", sourceKind: "mail", sourceRef: "m-17" });
  assert.deepEqual([s.item.status, s.item.sourceKind, s.item.sourceRef], ["open", "mail", "m-17"]);
  assert.equal(s.line, "Added task #2 'Reply to the landlord'");
  assert.equal(S.addItem(bg, { title: "Reply to the landlord again", sourceKind: "mail", sourceRef: "m-17" }).duplicate, true, "the same mail is not added twice");
  assert.equal(S.addItem(bg, { title: "reply  to the LANDLORD" }).duplicate, true, "nor the same words");
  assert.equal(S.editItem(bg, 1, { title: "Mine, edited" }).item.title, "Mine, edited");
  assert.equal(S.snoozeItem(bg, 1, NOW + 1e6).item.status, "snoozed");
  assert.equal(S.reopenItem(bg, 1).item.status, "open");
  assert.equal(S.completeItem(bg, 1).item.status, "done");
  assert.equal(S.dropItem(bg, 2).item.status, "dropped", "dropped, not deleted");
  assert.deepEqual(S.eventsOf(k, 1).map((e) => [e.action, e.by]), [["added", "owner"], ["edited", S.LOOK_BY], ["snoozed", S.LOOK_BY], ["reopened", S.LOOK_BY], ["done", S.LOOK_BY]]);
  assert.equal(S.reopenItem(bg, 2).item.status, "open", "and undone with reopen");
  for (let i = 0; i < S.LIMITS.addedByLooksPerDay - 1; i++) S.addItem(bg, { title: `Idea ${i}` });
  assert.throws(() => S.addItem(bg, { title: "One too many" }), /10 tasks were already added on your own today/);
  assert.equal(S.addItem(scope(k), { title: "The person can still add" }).item.status, "open");
});

test("tasks: lists, filters and counts: overdue, today, upcoming, no date, snoozes that have run out, kinds, people, text", () => {
  const k = fresh();
  const add = (title: string, o: Partial<import("../src/tasks/store.ts").NewItem> = {}) => S.addItem(scope(k), { title, ...o }).item;
  add("Overdue day", { due: "2026-10-21" });
  add("Overdue time", { due: "2026-10-22T11:00" });
  add("Today day", { due: "2026-10-22" });
  add("Today later", { due: "2026-10-22T15:00" });
  add("Upcoming", { due: "2026-10-25" });
  add("No date");
  add("Send photos", { kind: "i_owe", person: "Lena", due: "2026-10-30" });
  add("Contract back", { kind: "owed_to_me", person: "Anna Berg" });
  const snooze = add("Snoozed");
  S.snoozeItem(scope(k), snooze.id, NOW + 3_600_000);
  const done = add("Finished");
  S.completeItem(scope(k), done.id);
  const titles = (f: import("../src/tasks/store.ts").Filter) => S.listItems(k, f, NOW, ZONE).map((i) => i.title);
  assert.deepEqual(titles({}), ["Overdue day", "Overdue time", "Today later", "Today day", "Upcoming", "Send photos", "No date", "Contract back"], "open, soonest due first (an all-day due after the timed ones of its day), no date last");
  assert.deepEqual(titles({ overdue: true }), ["Overdue day", "Overdue time"]);
  assert.deepEqual(titles({ noDate: true }), ["No date", "Contract back"]);
  assert.deepEqual(titles({ kind: "i_owe" }), ["Send photos"]);
  assert.deepEqual(titles({ person: "anna" }), ["Contract back"]);
  assert.deepEqual(titles({ q: "photos anna" }), [], "every word must be there");
  assert.deepEqual(titles({ q: "contract anna" }), ["Contract back"], "the person counts as text");
  assert.deepEqual(titles({ dueFrom: "2026-10-22", dueTo: "2026-10-25" }), ["Overdue time", "Today later", "Today day", "Upcoming"]);
  assert.deepEqual(titles({ status: "done" }), ["Finished"]);
  assert.deepEqual(titles({ status: "snoozed" }), ["Snoozed"]);
  assert.deepEqual(titles({ limit: 2 }), ["Overdue day", "Overdue time"]);
  assert.deepEqual(S.counts(k, NOW, ZONE), { open: 8, overdue: 2, today: 2, upcoming: 2, noDate: 2, waiting: 1, owe: 1, snoozed: 1, done: 1, dropped: 0 });
  // two hours later the snooze has run out: it is open again for every reader, and wakeSnoozed writes it down
  const later = NOW + 2 * 3_600_000;
  assert.ok(S.listItems(k, {}, later, ZONE).some((i) => i.title === "Snoozed"));
  const woke = S.wakeSnoozed(scope(k, { now: later, by: "system" }));
  assert.deepEqual(woke.map((i) => [i.title, i.status]), [["Snoozed", "open"]]);
  assert.equal(S.eventsOf(k, snooze.id).at(-1)!.by, "system");
  assert.equal(S.dueClass(S.getItem(k, 2)!, NOW, ZONE), "overdue");
  assert.equal(S.dueClass(S.getItem(k, 4)!, NOW, ZONE), "today");
});

test("tasks: strict validation, in words the model can act on", () => {
  const k = fresh();
  const bad = (n: Partial<import("../src/tasks/store.ts").NewItem>, re: RegExp) => assert.throws(() => S.addItem(scope(k), { title: "t", ...n }), re);
  bad({ title: "" }, /title is empty/);
  bad({ title: "word ".repeat(41) }, /too long/);
  bad({ due: "tomorrow" }, /not a local date: write YYYY-MM-DD/);
  bad({ due: "2026-02-30" }, /not a local date/);
  bad({ due: "2026-10-24T25:00" }, /not a local date/);
  bad({ due: "2026-10-24T10:00:00Z" }, /not a local date/);
  bad({ due: "24/10/2026" }, /not a local date/);
  bad({ repeat: "sometimes", due: "2026-10-24" }, /Cannot read the repeat rule/);
  bad({ kind: "chore" as never }, /kind must be one of/);
  bad({ sourceKind: "dream" as never }, /source_kind must be one of/);
  bad({ remindAt: 5 }, /not a sensible time/);
  bad({ details: "lorem ipsum ".repeat(200) }, /details is too long/);
  assert.throws(() => S.editItem(scope(k), 1, {}), /no item #1/);
  S.addItem(scope(k), { title: "ok" });
  assert.throws(() => S.editItem(scope(k), 1, {}), /Nothing to change/);
  assert.throws(() => S.editItem(scope(k), 1, { kind: "x" as never }), /kind must be one of/);
  assert.throws(() => S.addItem({ ...scope(k), zone: "Mars/Olympus" }, { title: "x" }), /time zone/);
  assert.equal(S.addItem(scope(k), { title: "  tidy\n  spaces  \u0000 " }).item.title, "tidy spaces", "one clean line");
  assert.equal(S.getItem(k, 2)?.title, "tidy spaces");
  assert.equal(S.counts(k, NOW, ZONE).open, 2, "nothing refused was stored");
});

test("tasks: one conversation never sees another's list: each has its own file, and a key names only its own", () => {
  const [a, b] = [fresh(), fresh()];
  S.addItem(scope(a), { title: "Alpha secret" });
  S.addItem(scope(b), { title: "Beta secret" });
  assert.deepEqual(S.listItems(a, { status: ["open", "done", "dropped", "snoozed"] }, NOW, ZONE).map((i) => i.title), ["Alpha secret"]);
  assert.deepEqual(S.listItems(b, {}, NOW, ZONE).map((i) => i.title), ["Beta secret"]);
  assert.equal(S.getItem(a, 1)?.title, "Alpha secret");
  assert.equal(S.getItem(b, 1)?.title, "Beta secret");
  assert.notEqual(convPaths(convIdOfKey(a)).db, convPaths(convIdOfKey(b)).db);
  // through the tools: a run is closed over its key, there is no parameter to name another conversation
  void chat(a).add_task!.handler({ title: "Gamma", conv: b, key: b });
  assert.equal(S.listItems(b, {}, NOW, ZONE).some((i) => i.title === "Gamma"), false, "no argument names another conversation");
  // an unknown conversation has no list and reading it makes no folder
  const ghost = fresh();
  assert.deepEqual(S.listItems(ghost, {}, NOW, ZONE), []);
  assert.equal(S.counts(ghost, NOW, ZONE).open, 0);
  assert.equal(hasConvDb(convIdOfKey(ghost)), false, "a read never makes a database");
  // the owner's list and a friend's key and a group's are three different files
  assert.equal(new Set(["owner", "tenant:ida", "grp"].map((x) => convPaths(convIdOfKey(x)).db)).size, 3);
});

test("tasks: the tools, in the person's clock: a reply echoes what was understood, and the model fixes what it got wrong", async () => {
  const k = fresh();
  const t = chat(k);
  const added = await t.add_task!.handler({ title: "Call Sam", due: "2026-10-24T14:30", remind: "2026-10-24T09:00", person: "Sam" });
  assert.equal(added.isError, undefined);
  assert.equal(text(added).replace(/\. This is .*'s first reminder here[^\n]*/, "."), "Added task #1 'Call Sam' (due Sat 24 Oct 14:30, with Sam, for a member).\nDue: Sat 24 Oct 14:30 (2026-10-24T14:30, Europe/Berlin)\nReminder: Sat 24 Oct 09:00 (Europe/Berlin)");
  assert.equal(S.getItem(k, 1)!.remindAt, Date.parse("2026-10-24T07:00:00Z"), "09:00 in Berlin is 07:00 UTC (summer time)");
  const bare = await t.add_task!.handler({ title: "Bare day reminder", remind: "2026-11-02" });
  assert.match(text(bare), /Reminder: Mon 2 Nov 09:00 \(Europe\/Berlin\)/, "a bare day means 09:00");
  assert.equal(S.getItem(k, 2)!.remindAt, Date.parse("2026-11-02T08:00:00Z"), "winter time by then");
  const fix = await t.update_task!.handler({ id: 1, due: "2026-10-25T14:30" });
  assert.match(text(fix), /^Edited task #1 'Call Sam' \(changed due\)\.\nDue: Sun 25 Oct 14:30/);
  const clear = await t.update_task!.handler({ id: 1, remind: null, person: "" });
  assert.match(text(clear), /changed reminder, person/);
  assert.deepEqual([S.getItem(k, 1)!.remindAt, S.getItem(k, 1)!.person], [undefined, undefined]);
  const rep = await t.add_task!.handler({ title: "Standup", due: "2026-10-26T09:30", repeat: "every weekday at 9:30" });
  assert.match(text(rep), /Repeats: every weekday at 09:30/);
  const dup = await t.add_task!.handler({ title: "call sam", due: "2026-10-25T14:30" });
  assert.equal(dup.isError, true);
  assert.match(text(dup), /Nothing added: Already on the list: #1 'Call Sam' \(open\)/);
  // wrong input comes back as words, never a throw
  for (const [tool, args, re] of [
    ["add_task", { title: "x", due: "next friday" }, /not a local date/],
    ["add_task", { title: "x", remind: "tomorrow 9am" }, /not a local time/],
    ["add_task", { title: "x", repeat: "whenever" }, /Cannot read the repeat rule/],
    ["update_task", { id: 99, title: "x" }, /no item #99/],
    ["update_task", { id: 1 }, /Nothing to change/],
    ["complete_task", { id: 99 }, /no item #99/],
    ["snooze_task", { id: 1, until: "2020-01-01" }, /future/],
    ["snooze_task", { id: 1, until: "soon" }, /not a local time/],
  ] as const) {
    const r = await t[tool]!.handler(args);
    assert.equal(r.isError, true, tool);
    assert.match(text(r), re, tool);
  }
  const snz = await t.snooze_task!.handler({ id: 1, until: "2026-10-23" });
  assert.match(text(snz), /Snoozed task #1 'Call Sam' \(until Fri 23 Oct 09:00\)\.\nDue: .*\nSnoozed until: Fri 23 Oct 09:00 \(Europe\/Berlin\)/);
  assert.match(text(await t.update_task!.handler({ id: 1, reopen: true })), /^Reopened task #1 'Call Sam'/);
  assert.match(text(await t.complete_task!.handler({ id: 1 })), /^Completed task #1 'Call Sam'/);
  assert.match(text(await t.update_task!.handler({ id: 1, reopen: true, title: "Call Sam back" })), /^Edited task #1 'Call Sam back'/);
  assert.match(text(await t.drop_task!.handler({ id: 1 })), /^Dropped task #1 'Call Sam back'/);
  const list = text(await t.list_tasks!.handler({}));
  assert.match(list, /^<tasks>\nToday is Thu 22 Oct \(2026-10-22\), time zone Europe\/Berlin\. 2 items shown \(2 open, 0 overdue\)\./, "fenced as data, with today's date and the zone");
  assert.match(list, /#2 \[task\] Bare day reminder \| for a member \| remind Mon 2 Nov 09:00/);
  assert.match(list, /#3 \[task\] Standup \| due Mon 26 Oct 09:30 \| repeats every weekday at 09:30/);
  assert.match(text(await t.list_tasks!.handler({ status: "dropped" })), /#1 \[task\] Call Sam back \| .*dropped/);
  assert.match(text(await t.list_tasks!.handler({ due_from: "26.10." })), /due_from must be a day/);
});

test("tasks: the tools' schemas reject what they should before the handler sees it", () => {
  const t = chat(fresh());
  const ok = (tool: string, v: unknown) => t[tool]!.inputSchema.safeParse(v).success;
  assert.equal(ok("add_task", { title: "x" }), true);
  assert.equal(ok("add_task", {}), false, "a title is required");
  assert.equal(ok("add_task", { title: "" }), false);
  assert.equal(ok("add_task", { title: "x".repeat(201) }), false);
  assert.equal(ok("add_task", { title: "x", kind: "chore" }), false);
  assert.equal(ok("add_task", { title: "x", kind: "owed_to_me", person: "Anna" }), true);
  assert.equal(ok("add_task", { title: "x", source_kind: "import" }), false, "import is for code");
  assert.equal(ok("add_task", { title: "x", source_kind: "mail", source_ref: "m1" }), true);
  assert.equal(ok("update_task", { id: 0 }), false);
  assert.equal(ok("update_task", { id: 1.5 }), false);
  assert.equal(ok("update_task", { id: 1, due: null }), true, "null clears");
  assert.equal(ok("complete_task", { id: "4" }), false, "the number is a number");
  assert.equal(ok("snooze_task", { id: 1 }), false, "until is required");
  assert.equal(ok("list_tasks", { status: "all", limit: 100 }), true);
  assert.equal(ok("list_tasks", { limit: 101 }), false);
  assert.equal(ok("list_tasks", { status: "deleted" }), false);
  // the descriptions carry the date rules the model needs
  const run = createTasksServer({ key: "g", source: "group", unattended: false, zone: () => ZONE }) as unknown as { instance: { _registeredTools: Record<string, { description: string }> } };
  for (const name of ["add_task", "update_task", "snooze_task"]) assert.match(run.instance._registeredTools[name]!.description, /YYYY-MM-DDTHH:MM.*\n?.*|YYYY-MM-DDTHH:MM/s, name);
  assert.match(run.instance._registeredTools.add_task!.description, /Work out words like 'tomorrow'.*YOURSELF/s);
  assert.match(run.instance._registeredTools.add_task!.description, /every monday at 09:00|every weekday/);
});

test("tasks: who acted and where it came from: the owner, a friend, a group member, and an unattended look", async () => {
  const k = fresh();
  const own = toolsOf({ key: "owner", source: "chat", unattended: false, zone: () => ZONE, now: () => NOW });
  await own.add_task!.handler({ title: "Owner's" });
  assert.deepEqual(events("owner").slice(-1).map((e) => e.by), ["owner"]);
  const origin = (key: string, id: number) => peekConvDb(convIdOfKey(key))!.get<{ origin: string }>("SELECT origin FROM items WHERE id = ?", id)!.origin;
  assert.equal(origin("owner", S.listItems("owner", {}, NOW, ZONE).find((i) => i.title === "Owner's")!.id), "owner");
  setAsking(k, { owner: false, author: "+49170", authorName: "Mia" });
  await chat(k).add_task!.handler({ title: "Bring cake", assignee: "Ben" });
  setAsking(k, undefined);
  assert.equal(askingIn(k), undefined);
  assert.deepEqual([origin(k, 1), events(k)[0]!.by, S.getItem(k, 1)!.assignee], ["member", "Mia", "Ben"]);
  await chat(k).complete_task!.handler({ id: 1 }); // any member may finish it
  assert.equal(S.getItem(k, 1)!.status, "done");
  const friendKey = "tenant:ida";
  await toolsOf({ key: friendKey, source: "group", unattended: false, zone: () => ZONE, now: () => NOW }).add_task!.handler({ title: "Hers" });
  assert.deepEqual([origin(friendKey, 1), events(friendKey)[0]!.by], ["friend", "friend"]);
});

test("tasks: an unattended run has the chat's task tools (not the import); what it adds is open, attributed to the look, with its mail as the source", async () => {
  const k = fresh();
  const bg = toolsOf({ key: k, source: "background", unattended: true, zone: () => ZONE, now: () => NOW });
  assert.deepEqual(Object.keys(bg).sort(), ["add_task", "complete_task", "drop_task", "list_tasks", "snooze_task", "update_task"]);
  const r = await bg.add_task!.handler({ title: "Pay the invoice", source_kind: "mail", source_ref: "mail-9", due: "2026-10-30" });
  assert.match(text(r), /^Added task #1 'Pay the invoice' \(due Fri 30 Oct\)/);
  const it = S.getItem(k, 1)!;
  assert.deepEqual([it.status, it.sourceKind, it.sourceRef], ["open", "mail", "mail-9"]);
  assert.equal(events(k)[0]!.by, "assistant (look)");
  assert.equal(events(k)[0]!.action, "added");
  assert.match(text(await bg.list_tasks!.handler({})), /#1 \[task\] Pay the invoice \| due Fri 30 Oct \| from mail/, "it can list (a read) to avoid adding twice");
});

test("tasks: the permission floor: own-data writes are free in chat and in a look; the import stays a chat's; nothing else reaches the tools", () => {
  const MUTATORS = ["update_task", "complete_task", "drop_task", "snooze_task"].map((x) => `mcp__tasks__${x}`);
  const READ = "mcp__tasks__list_tasks";
  const ADD = "mcp__tasks__add_task";
  for (const tool of [READ, ADD, ...MUTATORS]) {
    assert.equal(classify(tool, { id: 1 }, OWNER_CHAT), "allow", `${tool}: no approval for the owner's own list`);
    assert.equal(classify(tool, { id: 1 }, GROUP_CHAT, undefined, groupTools()), "allow", `${tool}: in a group or a friend's chat too`);
    assert.equal(classify(tool, { id: 1 }, OWNER_LOOK), "allow", `${tool}: a look of the owner's too`);
  }
  // a friend's or a group's own look has the same tools
  const look = groupTools(GROUP_LOOK);
  for (const tool of [READ, ADD, ...MUTATORS]) {
    assert.ok(look.has(tool), tool);
    assert.equal(classify(tool, { id: 1 }, GROUP_LOOK, undefined, look), "allow", `${tool}: a look of a friend or a group`);
  }
  for (const tool of ["mcp__tasks__import_tasks_preview", "mcp__tasks__import_tasks_commit"]) assert.equal(look.has(tool), false, `${tool}: the import is a confirm-the-preview flow, attended`);
  // unknown names under the server are denied for isolated runs and not free
  assert.equal(classify("mcp__tasks__tidy_task", { id: 1 }, GROUP_CHAT, undefined, groupTools()), "deny");
  assert.equal(classify("mcp__tasks__tidy_task", { id: 1 }, OWNER_CHAT), "ask", "a name the manifest does not know is never free");
});

test("tasks: the capability: on for the owner, every friend and every group, and a tool only with it", () => {
  assert.ok(T.CAPABILITIES.includes("tasks"));
  assert.ok(T.FRIEND_CAPABILITIES.includes("tasks"), "a friend has it without anyone granting it");
  assert.ok(!T.OWNER_ONLY.includes("tasks"));
  assert.ok(groupCapabilities().has("tasks"));
  assert.ok(allows({ kind: "group" }, "tasks"));
  assert.ok(capabilitiesOf({ kind: "owner" }).has("tasks"));
  assert.ok(toolsFor(groupCapabilities()).has("mcp__tasks__add_task"));
  assert.equal(toolsFor(new Set(["chat"] as const)).has("mcp__tasks__add_task"), false);
});

test("tasks: the server is built per run: the owner's chat, a group, a friend and the owner's look have it; the browse run, and a run with no conversation, do not", () => {
  const base = { systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1 };
  const servers = (o: Parameters<typeof buildOptions>[1]) => buildOptions(async () => ({ approved: true }), o, undefined).mcpServers ?? {};
  const toolNames = (o: Parameters<typeof buildOptions>[1]) => Object.keys(((servers(o) as Record<string, { instance?: { _registeredTools: object } }>).tasks?.instance?._registeredTools ?? {}) as object);
  assert.equal(toolNames({ ...base, kind: OWNER_CHAT, memory: { dir: "/tmp/n" } }).length, 8) // (the owner's chat also has the two import tools);
  assert.equal(toolNames({ ...base, kind: GROUP_CHAT, memory: { dir: "/tmp/n", groupId: "g" }, groupId: "g" }).length, 6);
  assert.deepEqual(toolNames({ ...base, kind: OWNER_LOOK }).sort(), ["add_task", "complete_task", "drop_task", "list_tasks", "snooze_task", "update_task"], "the owner's look");
  assert.deepEqual(toolNames({ ...base, kind: GROUP_LOOK, groupId: "g", tools: groupTools(GROUP_LOOK) }).sort(), ["add_task", "complete_task", "drop_task", "list_tasks", "snooze_task", "update_task"], "a group's look has no chat memory");
  assert.equal("tasks" in servers({ ...base, kind: BROWSE_RUN }), false);
  assert.equal("tasks" in servers({ ...base, kind: GROUP_CHAT }), false, "an isolated run with no conversation gets no list (not the owner's)");
});

test("tasks: /tasks in the owner's chat and a friend's own chat, phone-sized, grouped; a group has the same command", () => {
  assert.deepEqual(parseCommand("/tasks"), { kind: "tasks" });
  for (const t of ["tasks", "/tasks please", "show /tasks", "/task", "/tasks suggestions"]) assert.equal(parseCommand(t), undefined, t);
  const k = fresh();
  assert.equal(tasksText(k, NOW, ZONE), "Nothing open.\nTell me what to add.");
  const add = (title: string, o: Partial<import("../src/tasks/store.ts").NewItem> = {}) => S.addItem(scope(k), { title, ...o });
  add("Overdue thing", { due: "2026-10-20" });
  add("Send invoice", { due: "2026-10-22T15:00" });
  add("Dentist", { due: "2026-10-27T10:00" });
  add("Someday", {});
  add("Contract back", { kind: "owed_to_me", person: "Anna", due: "2026-10-28" });
  add("Send photos", { kind: "i_owe", person: "Lena" });
  add("Water plants", { due: "2026-10-23", repeat: "every day" });
  S.addItem(scope(k, { unattended: true, by: S.LOOK_BY }), { title: "Maybe reply to Bo", sourceKind: "mail", sourceRef: "m1" });
  S.addItem(scope(k, { unattended: true, by: S.LOOK_BY }), { title: "Maybe call Cy", sourceKind: "mail", sourceRef: "m2" });
  assert.equal(
    tasksText(k, NOW, ZONE),
    [
      "Tasks: 9 open, 1 overdue",
      "",
      "Overdue (1)",
      "• #1 Overdue thing · Tue 20 Oct",
      "",
      "Today (1)",
      "• #2 Send invoice · 15:00",
      "",
      "Upcoming (2)",
      "• #7 Water plants · Fri 23 Oct ↻",
      "• #3 Dentist · Tue 27 Oct 10:00",
      "",
      "No date (3)",
      "• #4 Someday",
      "• #8 Maybe reply to Bo",
      "• #9 Maybe call Cy",
      "",
      "Waiting on (1)",
      "• #5 Contract back · Wed 28 Oct · Anna",
      "",
      "I owe (1)",
      "• #6 Send photos · Lena",
    ].join("\n"),
  );
  assert.ok(tasksText(k, NOW, ZONE).split("\n").every((l) => l.length <= 60), "phone width");
  // more than eight in a section are counted, not all listed
  const many = fresh();
  for (let i = 0; i < 11; i++) S.addItem(scope(many), { title: `Item ${i}`, due: "2026-11-01" });
  assert.match(tasksText(many, NOW, ZONE), /Upcoming \(11\)\n(• .*\n){8}… and 3 more/);
  // the command, through the same door as /status
  const now = new Date(NOW);
  const owner = { kind: "owner" as const, key: k, convId: "owner" };
  assert.match(commandReply(owner, "/tasks", { now: () => now, tasks: (c) => `T ${c.key}` })!, new RegExp(`^T ${k}$`));
  const group = { kind: "group" as const, key: k, convId: convIdOfKey(k) };
  assert.equal(commandReply(group, "/tasks", { now: () => now, tasks: (c) => `T ${c.key}` }), `T ${k}`, "a group has the capability too: the same command, its own list");
});

test("tasks: /tasks for a friend answers from HER list in her clock, and not for a friend without the capability", () => {
  (settings as { tenants: boolean }).tenants = true;
  const rec = T.addTenant({ aci: "11111111-2222-4333-8444-555555555555", name: "Ida" })!;
  const key = `tenant:${rec.id}`;
  const her = { kind: "tenant" as const, key, convId: friendConvId(rec.id), tenantId: rec.id };
  S.addItem(scope(key, { origin: "friend", by: "friend" }), { title: "Her dentist", due: "2999-01-01" });
  S.addItem(scope("owner", { now: NOW }), { title: "Owner-only secret" });
  const out = commandReply(her, "/tasks")!;
  assert.match(out, /Tasks: 1 open/);
  assert.match(out, /Her dentist/);
  assert.doesNotMatch(out, /Owner-only/);
  assert.equal(commandReply({ ...her, tenantId: "nobody" }, "/tasks"), undefined, "no record, no capability: the message goes on as a message");
});

test("tasks: the journal: a line per change with what happened, the why and how to undo; the tool's own line is the call's, a command's has its own why", async () => {
  const k = fresh();
  const t = chat(k);
  const r = await t.add_task!.handler({ title: "Call Sam", due: "2026-10-24T14:30" });
  assert.deepEqual(journalOf(k), [], "a tool call's line waits for its success (the done event), it is not written twice");
  await noteDone({ conv: k, run: "run-1", source: "group", tool: "mcp__tasks__add_task", input: { title: "Call Sam" }, response: r });
  assert.deepEqual(journalOf(k), ["Added task #1 'Call Sam' (due Sat 24 Oct 14:30). Why: no reason was recorded for this call. Undo: say 'drop task #1'."]);
  const c = await t.complete_task!.handler({ id: 1 });
  await noteDone({ conv: k, run: "run-1", source: "group", tool: "mcp__tasks__complete_task", input: { id: 1 }, response: c });
  assert.match(journalOf(k).at(-1)!, /^Completed task #1 'Call Sam'\. Why: .* Undo: say 'reopen task #1'\.$/);
  const before = journalOf(k).length;
  await noteDone({ conv: k, source: "group", tool: "mcp__tasks__list_tasks", input: {}, response: await t.list_tasks!.handler({}) });
  assert.equal(journalOf(k).length, before, "a read has no line");
  // not through a tool: the line is told at once, with the why the caller gives
  S.addItem(scope(k, { source: "chat", viaTool: false, why: { text: "your message at 09:12" } }), { title: "From a command", due: "2026-10-23" });
  assert.equal(journalOf(k).at(-1), "Added task #2 'From a command' (due Fri 23 Oct). Why: your message at 09:12.");
  // the journal tool's category
  const entry = ledgerEntries(convPaths(convIdOfKey(k)).messages).find((m) => m.kind === "journal");
  assert.equal((entry as { cat?: string }).cat, "task");
  // an error leaves no line (the call failed)
  const none = journalOf(k).length;
  const bad = await t.complete_task!.handler({ id: 77 });
  assert.equal(bad.isError, true);
  assert.equal(journalOf(k).length, none);
  // a friend's lines are in HER log
  const fk = "tenant:ida2";
  S.addItem(scope(fk, { origin: "friend", by: "friend", why: { text: "your message" } }), { title: "Hers" });
  assert.equal(journalOf(fk).length, 1);
  assert.equal(journalOf(k).some((l) => /Hers/.test(l)), false);
});

test("tasks: the audit log gets a wordless row per change (id and state, never the title)", () => {
  const k = fresh();
  S.addItem(scope(k, { source: "chat" }), { title: "Secret plan with a long title" });
  S.completeItem(scope(k, { source: "chat" }), 1);
  const rows = readAudit((e) => e.tool === "task" && (e.meta as { id?: string } | undefined)?.id === "1");
  assert.ok(rows.length >= 2);
  assert.deepEqual(rows.slice(-2).map((r) => r.decision), ["added", "done"]);
  assert.doesNotMatch(JSON.stringify(rows), /Secret plan/);
  // a friend's rows carry no words at all
  const fk = "tenant:ida3";
  S.addItem(scope(fk, { origin: "friend", source: "group" }), { title: "Hers" });
  const hers = readAudit((e) => e.tool === "task" && e.source === "group");
  assert.ok(hers.length >= 1);
});

test("tasks: forgetting a group or a friend deletes the folder, and the list goes with it", async () => {
  const GID = "dGFza3MtZ3JvdXA=";
  const attachments = mkdtempSync(join(tmpdir(), "tasks-att-"));
  groupDir(GID, "Tasks Family");
  recordGroup(GID, "member", NOW, "hello");
  const gk = GID; // a group's key is its id
  S.addItem(scope(gk, { origin: "member", by: "Mia" }), { title: "Group chore" });
  S.completeItem(scope(gk), 1);
  const dbFile = convPaths(groupConvId(GID)).db;
  assert.equal(existsSync(dbFile), true);
  assert.equal(S.counts(gk, NOW, ZONE).done, 1);
  const r = forgetGroup("Tasks Family", { attachmentsDir: attachments });
  assert.ok(!("error" in r));
  assert.equal(existsSync(dbFile), false, "the file, with its items and their history");
  assert.equal(existsSync(convPaths(groupConvId(GID)).dir), false);
  assert.equal(hasConvDb(groupConvId(GID)), false);
  assert.deepEqual(S.listItems(gk, { status: ["open", "done", "dropped", "snoozed"] }, NOW, ZONE), []);
  assert.equal(statSafe(dbFile), false);
  (settings as { tenants: boolean }).tenants = true;
  const rec = T.addTenant({ aci: "22222222-3333-4444-8555-666666666666", name: "Kai" })!;
  const fk = `tenant:${rec.id}`;
  S.addItem(scope(fk, { origin: "friend", by: "friend" }), { title: "Her list" });
  const fdb = convPaths(friendConvId(rec.id)).db;
  assert.equal(existsSync(fdb), true);
  const gone = await forgetFriend(rec.id, { attachmentsDir: attachments, secrets: [async () => 0] });
  assert.ok(gone?.registry);
  assert.equal(existsSync(fdb), false);
  assert.equal(existsSync(convPaths(friendConvId(rec.id)).dir), false);
  assert.deepEqual(S.listItems(fk, { status: ["open", "done", "dropped", "snoozed"] }, NOW, ZONE), []);
  // and the list of another conversation is untouched
  const other = fresh();
  S.addItem(scope(other), { title: "Stays" });
  assert.equal(S.getItem(other, 1)?.title, "Stays");
});

const statSafe = (p: string): boolean => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

test("tasks: itemLine shows kind, due (overdue marked), who, reminder, repeat and status in the conversation's clock", () => {
  const k = fresh();
  const it = S.addItem(scope(k), { title: "Pay rent", kind: "i_owe", person: "Landlord", due: "2026-10-21", remindAt: Date.parse("2026-10-22T13:00:00Z"), repeat: "every month on the 1st" }).item;
  assert.equal(itemLine(it, NOW, ZONE), "#1 [i_owe] Pay rent | due Wed 21 Oct (overdue) | owed to Landlord | remind Thu 22 Oct 15:00 | repeats every month on the 1st");
});
