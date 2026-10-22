import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The one-time import of the owner's Notion tasks (src/tasks/import.ts, the two import_tasks_* tools): the preview that checks, dedupes and sets aside, the commit that is atomic and idempotent,
// who may call it, the journal line, and the skills that no longer write tasks to Notion.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "taskimport-test-"));

const S = await import("../src/tasks/store.ts");
const I = await import("../src/tasks/import.ts");
const { createTasksServer } = await import("../src/modules/tasks/tasktools.ts");
const { unattendedTools } = await import("../src/run/scope.ts");
const { noteDone } = await import("../src/approvals/journalrender.ts");
const { peekConvDb } = await import("../src/core/convdb.ts");
const { convIdOfKey, convPaths } = await import("../src/core/convpaths.ts");
const { ledgerEntries } = await import("../src/core/messages.ts");
const { entryFor } = await import("../src/policy/toolmanifest.ts");

const ZONE = "Europe/Berlin";
const NOW = Date.parse("2026-10-22T10:00:00Z");
let n = 0;
const fresh = () => `import-conv-${++n}`;
const scope = (key: string): import("../src/tasks/store.ts").Scope => ({ key, zone: ZONE, by: "owner", origin: "owner", source: "chat", now: NOW });
const ALL = ["suggested", "open", "snoozed", "done", "dropped"] as never;
const row = (i: number, o: Record<string, unknown> = {}) => ({ title: `Task ${i}`, source_ref: `https://notion.so/p${i}`, ...o });
const journalOf = (key: string) => ledgerEntries(convPaths(convIdOfKey(key)).messages).filter((m) => m.kind === "journal").map((m) => m.text);
const events = (key: string) => peekConvDb(convIdOfKey(key))!.all<{ item_id: number; action: string; by: string }>("SELECT item_id, action, by FROM task_events ORDER BY id");

type Tools = Record<string, { handler: (a: unknown, extra?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }>;
const toolsOf = (run: Parameters<typeof createTasksServer>[0]) => (createTasksServer(run) as unknown as { instance: { _registeredTools: Tools } }).instance._registeredTools;
const ownerTools = (o: Partial<Parameters<typeof createTasksServer>[0]> = {}) => toolsOf({ key: "owner", source: "chat", unattended: false, zone: () => ZONE, now: () => NOW, ...o });

test("import preview: validates every row, rejects with reasons, dedupes within the batch, counts by kind and status, writes nothing to the list", () => {
  const k = fresh();
  const p = I.previewImport(scope(k), {
    rows: [
      row(1, { due: "2026-10-25", kind: "owed_to_me", person: "Sam" }),
      row(2, { kind: "i_owe", person: "Ida", status: "done", done_on: "2026-10-20" }),
      { title: "", source_ref: "x" },
      { title: "No ref" },
      row(5, { due: "next friday" }),
      row(6, { kind: "chore" }),
      row(7, { status: "waiting" }),
      row(1, { title: "Task 1 again" }),
      row(9, { title: "word ".repeat(50) }),
    ],
  });
  assert.equal(p.summary.total, 2);
  assert.deepEqual([p.summary.open, p.summary.done, p.summary.byKind], [1, 1, { owed_to_me: 1, i_owe: 1 }]);
  assert.deepEqual(p.summary.rejected.map((r) => r.n), [3, 4, 5, 6, 7, 8, 9]);
  assert.match(p.summary.rejected.find((r) => r.n === 8)!.reason, /twice/);
  assert.match(p.summary.rejected.find((r) => r.n === 5)!.reason, /not a local date/);
  assert.match(p.summary.rejected.find((r) => r.n === 6)!.reason, /kind must be/);
  assert.match(p.text, new RegExp(`Import preview ${p.batchId} from Notion: 2 items to import \\(1 open, 1 done; 1 owed to me, 1 i owe\\)`));
  assert.match(p.text, /Rejected \(7\)/);
  assert.match(p.text, /Nothing has been imported yet/);
  assert.equal(S.listItems(k, { status: ALL }, NOW, ZONE).length, 0, "a preview adds nothing");
  assert.equal(I.pendingImport(k)?.batchId, p.batchId);
});

test("import preview: the preview names the first 15 rows and counts the rest; a newer preview replaces the older one", () => {
  const k = fresh();
  const p = I.previewImport(scope(k), { rows: Array.from({ length: 20 }, (_, i) => row(i + 1)) });
  assert.equal(p.text.split("\n").filter((l) => l.startsWith("- ")).length, 15);
  assert.match(p.text, /\.\.\. and 5 more/);
  const q = I.previewImport(scope(k), { rows: [row(1)] });
  assert.throws(() => I.commitImport(scope(k), p.batchId), /replaced by a newer one/);
  assert.equal(I.commitImport(scope(k), q.batchId).imported.length, 1);
  assert.throws(() => I.previewImport(scope(k), { rows: [] }), /no rows/);
  assert.throws(() => I.previewImport(scope(k), { rows: Array.from({ length: 501 }, (_, i) => row(i)) }), /more than one import takes/);
});

test("import preview: finished rows older than 30 days (or undated) are left out by default; done=all keeps the history, done=none only the open", () => {
  const k = fresh();
  const rows = [row(1), row(2, { status: "done", done_on: "2026-10-01" }), row(3, { status: "done", done_on: "2026-08-01" }), row(4, { status: "done" })];
  const d = I.previewImport(scope(k), { rows });
  assert.deepEqual([d.summary.total, d.summary.skippedDone], [2, 2]);
  assert.match(d.text, /Finished rows left out: 2 .*done=all/);
  const none = I.previewImport(scope(k), { rows, done: "none" });
  assert.deepEqual([none.summary.total, none.summary.skippedDone], [1, 3]);
  const all = I.previewImport(scope(k), { rows, done: "all" });
  assert.deepEqual([all.summary.total, all.summary.done], [4, 3]);
  const c = I.commitImport(scope(k), all.batchId);
  const done = c.imported.filter((i) => i.status === "done");
  assert.equal(done.length, 3);
  assert.equal(done.find((i) => i.title === "Task 2")!.doneAt, Date.parse("2026-10-01T10:00:00Z"), "done on the day the table says (noon, local)");
});

test("import commit: inserts as the owner's, source import, one added history row each; the second commit and a re-run add nothing (idempotent by source_ref)", () => {
  const k = fresh();
  const p = I.previewImport(scope(k), { rows: [row(1, { due: "2026-10-25", details: "Area: Work" }), row(2, { kind: "owed_to_me", person: "Sam" })] });
  const c = I.commitImport(scope(k), p.batchId);
  assert.equal(c.line, "Imported 2 tasks from Notion");
  const items = S.listItems(k, {}, NOW, ZONE);
  assert.deepEqual(items.map((i) => [i.origin, i.sourceKind, i.status, i.sourceRef]), [["owner", "import", "open", "https://notion.so/p1"], ["owner", "import", "open", "https://notion.so/p2"]]);
  assert.equal(items[0]!.details, "Area: Work");
  assert.equal(items[0]!.dueZone, ZONE);
  assert.deepEqual(events(k).map((e) => e.action), ["added", "added"]);
  const again = I.commitImport(scope(k), p.batchId);
  assert.equal(again.already, true);
  assert.equal(S.listItems(k, { status: ALL }, NOW, ZONE).length, 2);
  // the same table again, plus one new row: only the new one comes
  const p2 = I.previewImport(scope(k), { rows: [row(1), row(2), row(3)] });
  assert.equal(p2.summary.alreadyImported, 2);
  assert.match(p2.text, /Already imported earlier, left out: 2/);
  assert.equal(I.commitImport(scope(k), p2.batchId).imported.length, 1);
  assert.equal(S.listItems(k, { status: ALL }, NOW, ZONE).length, 3);
  // a ref imported between preview and commit is skipped at commit
  const p3 = I.previewImport(scope(k), { rows: [row(4)] });
  S.addItem(scope(k), { title: "Task 4 by hand", sourceKind: "import", sourceRef: "https://notion.so/p4" });
  const c3 = I.commitImport(scope(k), p3.batchId);
  assert.equal(c3.imported.length, 0);
  assert.equal(c3.line, "Imported 0 tasks from Notion");
});

test("import commit: a stale or unknown preview is refused, and the list's size limit stops it whole (nothing half-imported)", () => {
  const k = fresh();
  assert.throws(() => I.commitImport(scope(k), "imp-nope"), /no import preview/);
  const p = I.previewImport(scope(k), { rows: [row(1)] });
  assert.throws(() => I.commitImport({ ...scope(k), now: NOW + 49 * 3_600_000 }, p.batchId), /too old/);
  const db = peekConvDb(convIdOfKey(k))!;
  for (let i = 0; i < S.LIMITS.open - 1; i++) db.run("INSERT INTO items (title, created_at, updated_at) VALUES (?, 1, 1)", `f${i}`);
  const q = I.previewImport(scope(k), { rows: [row(1), row(2)] });
  assert.match(q.text, /Too many/);
  assert.throws(() => I.commitImport(scope(k), q.batchId), /open items at most/);
  assert.equal(db.num("SELECT COUNT(*) FROM items WHERE source_kind = 'import'"), 0);
});

test("import tools: owner chat only: a friend, a group, an unattended run and a non-chat source never get them", () => {
  const names = (t: Tools) => Object.keys(t).filter((x) => x.startsWith("import_tasks"));
  assert.deepEqual(names(ownerTools()).sort(), ["import_tasks_commit", "import_tasks_preview"]);
  assert.deepEqual(names(toolsOf({ key: "tenant:ida", source: "chat", unattended: false, zone: () => ZONE })), [], "a friend's own chat");
  assert.deepEqual(names(toolsOf({ key: "grp", source: "group", unattended: false, zone: () => ZONE })), []);
  assert.deepEqual(names(ownerTools({ unattended: true })), []);
  assert.deepEqual(names(ownerTools({ source: "background" })), []);
  for (const t of ["import_tasks_preview", "import_tasks_commit"]) {
    assert.equal(entryFor(`mcp__tasks__${t}`)?.action, "task-import");
    assert.deepEqual(entryFor(`mcp__tasks__${t}`)?.only, ["chat"]);
    assert.equal(unattendedTools(new Set([`mcp__tasks__${t}`, "mcp__tasks__list_tasks"])).has(`mcp__tasks__${t}`), false, "an unattended tool set loses them");
  }
});

test("import tools: preview then commit through the tools; the journal gets ONE line for the whole batch, the items only the audit log", async () => {
  const t = ownerTools();
  await peek();
  const r = await t.import_tasks_preview!.handler({ rows: [row(1), row(2, { status: "done", done_on: "2026-10-21" }), row(3, { kind: "i_owe", person: "Ida" })] });
  assert.ok(!r.isError, r.content[0]!.text);
  const id = /imp-[0-9a-f]{6}/.exec(r.content[0]!.text)![0];
  assert.match(r.content[0]!.text, /3 items to import/);
  const bad = await t.import_tasks_commit!.handler({ batch_id: "imp-000000" });
  assert.equal(bad.isError, true);
  const c = await t.import_tasks_commit!.handler({ batch_id: id });
  assert.ok(!c.isError, c.content[0]!.text);
  assert.match(c.content[0]!.text, /^Imported 3 tasks from Notion\./);
  await noteDone({ conv: "owner", run: "run-1", source: "chat", tool: "mcp__tasks__import_tasks_commit", input: { batch_id: id }, response: c });
  const lines = journalOf("owner").filter((l) => /Imported/.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^Imported 3 tasks from Notion\./);
  assert.equal(journalOf("owner").filter((l) => /^Added task/.test(l)).length, 0, "no flood of one line per item");
  const bad2 = await t.import_tasks_preview!.handler({ rows: [{ title: "x" }] });
  assert.match(bad2.content[0]!.text, /Rejected \(1\)/, "a bad row is a rejection in the preview, not a failed call");
});

async function peek() {
  /* the owner's database is made at first use */
  S.listItems("owner", {}, NOW, ZONE);
}

test("skills: tasks live in Ted; no skill tells Ted to write tasks to Notion; the import skill exists and names both tools", () => {
  const dir = new URL("../plugin/skills/", import.meta.url);
  const read = (s: string) => readFileSync(new URL(`${s}/SKILL.md`, dir), "utf8");
  assert.ok(readdirSync(dir).includes("task-import"));
  const imp = read("task-import");
  assert.match(imp, /^---\nname: task-import\n/);
  for (const w of ["import_tasks_preview", "import_tasks_commit", "source_ref", "setup-tasks"]) assert.ok(imp.includes(w), w);
  const brief = read("daily-brief");
  for (const w of ["list_tasks", "add_task"]) assert.ok(brief.includes(w), w);
  assert.doesNotMatch(brief, /notion-tasks/);
  assert.match(brief, /suggestion/i);
  const pointer = read("notion-tasks");
  assert.match(pointer, /list_tasks/);
  assert.doesNotMatch(pointer, /notion-update-page|notion-create-pages/, "the pointer carries no Notion write instructions");
  const setup = read("setup");
  assert.doesNotMatch(setup, /notion-create-pages/);
  assert.doesNotMatch(setup, /setup-tasks`? note.*save/i);
});
