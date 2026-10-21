import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataPath, readJson, writeFileAtomic, writeJson, writeText } from "../src/core/state.ts";
import { applyPlan, baseOf, upsertIndex } from "../src/memory/dreamapply.ts";
import { forgetNote } from "../src/memory/notes.ts";
import { writeInferredNote } from "../src/memory/inferred.ts";
import { dreamOver, readNoteFiles } from "../src/conversation/dream.ts";
import { classifySendError, createOutbound } from "../src/conversation/outbound.ts";
import { actedSince, replayPrompt, replayUnanswered, SORRY, unansweredSince } from "../src/conversation/replay.ts";
import type { AuditEntry } from "../src/core/audit.ts";
import type { Sent } from "../src/core/messages.ts";
import { FakeMessenger } from "@ted-assistant/messenger/testing";
import { scratch } from "./scratch.ts";

// Persistence and delivery durability: atomic fsynced writes, a corrupt file kept not erased, a dream that does not overwrite a note edited meanwhile,
// a send that is retried, and a start that answers what a restart lost.

// ---- state ----

test("state: a write leaves no temp file, is owner-only", () => {
  writeText(scratch("durable-a.json"), "one");
  writeText(scratch("durable-a.json"), "two");
  assert.equal(readFileSync(dataPath(scratch("durable-a.json")), "utf8"), "two");
  assert.equal(statSync(dataPath(scratch("durable-a.json"))).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(dataPath(scratch("durable-a.json")), "..")).filter((f) => f.endsWith(".tmp")), []);
});

test("state: a corrupt JSON file is moved aside (not lost) and the fallback returned", () => {
  const path = dataPath(scratch("durable-b.json"));
  writeText(scratch("durable-b.json"), "{ not json");
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    assert.deepEqual(readJson(scratch("durable-b.json"), { fresh: true }), { fresh: true });
  } finally {
    console.error = orig;
  }
  assert.ok(!existsSync(path), "the bad file is out of the way");
  const kept = readdirSync(join(path, "..")).filter((f) => f.startsWith("durable-b.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(path, "..", kept[0]!), "utf8"), "{ not json", "kept for a human, byte for byte");
  assert.match(errors.join("\n"), /durable-b\.json is unreadable.*moved aside/);
  writeJson(scratch("durable-b.json"), { ok: 1 });
  assert.deepEqual(readJson(scratch("durable-b.json"), {}), { ok: 1 });
});

// ---- notes ----

const scopeIn = () => ({ notesDir: mkdtempSync(join(tmpdir(), "dn-")), backupsDir: mkdtempSync(join(tmpdir(), "db-")), categories: ["people"], index: true, maxNotes: 100 });
const add = (file: string, content: string) => ({ kind: "add" as const, file, description: "d", content, merged: [] as string[] });

test("notes: every note and index write is atomic, owner-only (inferred, index, forget)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dn-"));
  const r = writeInferredNote({ file: "people-eve.md", text: "Eve moved to Oslo", description: "Eve in Oslo" }, { dir, categories: ["people"], maxNotes: 10 });
  assert.ok(r.ok);
  assert.equal(statSync(join(dir, "people-eve.md")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "MEMORY.md")).mode & 0o777, 0o600);
  upsertIndex("people-bob.md", "Bob", { notesDir: dir } as never);
  assert.ok(forgetNote("people-eve.md", dir).ok);
  assert.equal(statSync(join(dir, "MEMORY.md")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  assert.ok(!/people-eve/.test(readFileSync(join(dir, "MEMORY.md"), "utf8")));
});

test("dream: a note edited between the read and the apply survives; an untouched one is written", () => {
  const scope = scopeIn();
  writeFileSync(join(scope.notesDir, "people-anna.md"), "Anna is my sister\n");
  writeFileSync(join(scope.notesDir, "people-bob.md"), "Bob likes tea\n");
  const base = baseOf(readNoteFiles(scope.notesDir));
  // meanwhile (the model is thinking): chat auto-memory edits anna, and a brand-new note appears
  writeFileSync(join(scope.notesDir, "people-anna.md"), "Anna is my sister and lives in Oslo\n");
  writeFileSync(join(scope.notesDir, "people-new.md"), "typed by the owner meanwhile\n");
  const plan = {
    actions: [
      { kind: "update" as const, file: "people-anna.md", description: "d", content: "dream's version of anna\n", merged: [] },
      { kind: "update" as const, file: "people-bob.md", description: "d", content: "dream's version of bob\n", merged: [] },
      add("people-new.md", "dream's competing new note\n"),
      { kind: "delete" as const, file: "people-anna.md", why: "x" },
    ],
    rejected: [],
  };
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    assert.ok(applyPlan(plan, new Date("2026-10-14T04:00:00"), scope, base));
  } finally {
    console.log = orig;
  }
  assert.equal(readFileSync(join(scope.notesDir, "people-anna.md"), "utf8"), "Anna is my sister and lives in Oslo\n", "edit survived, even the delete of it");
  assert.equal(readFileSync(join(scope.notesDir, "people-new.md"), "utf8"), "typed by the owner meanwhile\n", "a note that appeared meanwhile is not overwritten");
  assert.equal(readFileSync(join(scope.notesDir, "people-bob.md"), "utf8"), "dream's version of bob\n");
  assert.equal(logs.filter((l) => /skipped .* changed while the dream was running/.test(l)).length, 3);
});

test("dream: a merge whose source changed is not written and its sources are not deleted", () => {
  const scope = scopeIn();
  writeFileSync(join(scope.notesDir, "people-a.md"), "A\n");
  writeFileSync(join(scope.notesDir, "people-b.md"), "B\n");
  const base = baseOf(readNoteFiles(scope.notesDir));
  writeFileSync(join(scope.notesDir, "people-b.md"), "B, edited\n");
  const plan = {
    actions: [
      { kind: "merge" as const, file: "people-ab.md", description: "d", content: "A and B\n", merged: ["people-a.md", "people-b.md"] },
      { kind: "delete" as const, file: "people-a.md", why: "merged into people-ab.md" },
      { kind: "delete" as const, file: "people-b.md", why: "merged into people-ab.md" },
    ],
    rejected: [],
  };
  applyPlan(plan, new Date("2026-10-14T04:00:00"), scope, base);
  assert.deepEqual(readdirSync(scope.notesDir).filter((f) => f.endsWith(".md")).sort(), ["people-a.md", "people-b.md"]);
});

test("dream: the index is merged, not overwritten: a line added meanwhile stays", async () => {
  const scope = scopeIn();
  writeFileSync(join(scope.notesDir, "people-anna.md"), "Anna is my sister\n");
  writeFileSync(join(scope.notesDir, "MEMORY.md"), "- [Anna](people-anna.md) - sister\n");
  const run = async () => {
    // while the model runs, the chat saves a note and its index line
    writeFileSync(join(scope.notesDir, "people-zed.md"), "Zed\n");
    writeFileSync(join(scope.notesDir, "MEMORY.md"), "- [Anna](people-anna.md) - sister\n- [Zed](people-zed.md) - chat made this\n");
    return { ops: [{ op: "write", file: "people-eve.md", description: "Eve", text: "Eve is a friend", evidence: "Eve is a friend of mine, said so today" }] };
  };
  const { plan } = await dreamOver(scope as never, "p", "s", "Eve is a friend of mine, said so today", new Date("2026-10-14T04:00:00"), run);
  assert.equal(plan.actions.length, 1);
  const index = readFileSync(join(scope.notesDir, "MEMORY.md"), "utf8");
  assert.match(index, /people-zed\.md/);
  assert.match(index, /people-eve\.md/);
  assert.match(index, /people-anna\.md/);
});

test("writeFileAtomic: failure leaves the old content and no temp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-"));
  writeFileAtomic(join(dir, "f.md"), "old");
  mkdirSync(join(dir, "dir.md"));
  assert.throws(() => writeFileAtomic(join(dir, "dir.md"), "x")); // rename onto a directory fails
  assert.equal(readFileSync(join(dir, "f.md"), "utf8"), "old");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

// ---- outbound retry ----

const fake = () => new FakeMessenger({});
const noWait = () => ({ backoffMs: [2000, 6000], sleep: async (ms: number) => void waited.push(ms) });
let waited: number[] = [];

test("outbound: classification of send errors", () => {
  assert.equal(classifySendError(new Error("SignalClient is not connected: call connect() first")), "refused");
  assert.equal(classifySendError(new Error("signal send timed out after 30s")), "unsure");
  assert.equal(classifySendError(new Error("socket closed")), "unsure");
  assert.equal(classifySendError(new Error("attachment not found")), "permanent");
});

test("outbound: a send that was refused is retried twice (2 s, 6 s) and then succeeds", async () => {
  waited = [];
  const m = fake();
  const real = m.send.bind(m);
  let calls = 0;
  m.send = async (t, msg) => (++calls < 3 ? Promise.reject(new Error("SignalClient is not connected")) : real(t, msg));
  const silence = console.error;
  console.error = () => {};
  try {
    await createOutbound(m, undefined, noWait()).reply("hello");
  } finally {
    console.error = silence;
  }
  assert.equal(calls, 3);
  assert.deepEqual(waited, [2000, 6000]);
  assert.equal(m.sent.length, 1);
});

test("outbound: a timeout is ambiguous, so it is retried once only (a rare duplicate is accepted)", async () => {
  waited = [];
  const m = fake();
  let calls = 0;
  m.send = async () => (++calls, Promise.reject(new Error("signal send timed out after 30s")));
  const silence = console.error;
  console.error = () => {};
  try {
    await assert.rejects(createOutbound(m, undefined, noWait()).reply("hello"), /timed out/);
  } finally {
    console.error = silence;
  }
  assert.equal(calls, 2);
  assert.deepEqual(waited, [2000]);
});

test("outbound: a permanent refusal is not retried", async () => {
  waited = [];
  const m = fake();
  let calls = 0;
  m.send = async () => (++calls, Promise.reject(new Error("unknown group")));
  await assert.rejects(createOutbound(m, undefined, noWait()).reply("hello"), /unknown group/);
  assert.equal(calls, 1);
  assert.deepEqual(waited, []);
});

// ---- replay ----

const NOW = Date.parse("2026-10-14T12:00:00Z");
const line = (minAgo: number, kind: Sent["kind"], text: string, extra: Partial<Sent> = {}): Sent => {
  const ts = NOW - minAgo * 60_000;
  return { ts, at: new Date(ts).toISOString(), kind, text, ...extra };
};

test("unansweredSince: owner lines after the last reply, younger than the window", () => {
  const log = [line(50, "owner", "too old"), line(20, "owner", "a"), line(19, "chat", "answer to a"), line(10, "owner", "b"), line(5, "owner", "c")];
  assert.deepEqual(unansweredSince(log, NOW).map((m) => m.text), ["b", "c"]);
  assert.deepEqual(unansweredSince(log, NOW, 7 * 60_000).map((m) => m.text), ["c"], "the window is a parameter");
  assert.deepEqual(unansweredSince(log, NOW, 0), [], "0 turns it off");
});

test("unansweredSince: answered, old, unprompted notices, reactions and the ledger", () => {
  assert.deepEqual(unansweredSince([line(5, "owner", "hi"), line(4, "chat", "hello")], NOW), []);
  assert.deepEqual(unansweredSince([line(40, "owner", "hi")], NOW), []);
  assert.deepEqual(unansweredSince([line(10, "owner", "hi"), line(5, "notice", "mail came")], NOW).map((m) => m.text), ["hi"], "a notice is not an answer");
  assert.deepEqual(unansweredSince([line(10, "owner", "hi"), line(5, "reaction", "👍 on x"), line(4, "wake", "later"), line(3, "action", "silent")], NOW).map((m) => m.text), ["hi"]);
  assert.deepEqual(unansweredSince([line(10, "owner", "hi"), line(4, "other", "something went wrong")], NOW), [], "a failure notice was an answer of sorts");
  assert.deepEqual(unansweredSince([], NOW), []);
});

test("unansweredSince: an approval answer, a deleted message and an edit are not replayed as new requests", () => {
  const approval = [line(10, "approval", "Send this email?"), line(9, "owner", "yes"), line(5, "owner", "and then book a table")];
  assert.deepEqual(unansweredSince(approval, NOW).map((m) => m.text), ["and then book a table"], "only the line right after the question is its answer");
  const deleted = [line(10, "owner", "oops", { ts: 111 }), line(9, "delete", "[deleted]", { of: 111 })];
  assert.deepEqual(unansweredSince(deleted, NOW), []);
  const edited = [line(10, "owner", "tea at 5", { ts: 222 }), line(9, "edit", "tea at 6", { of: 222, ts: 223 })];
  const got = unansweredSince(edited, NOW);
  assert.equal(got.length, 1, "once, not twice");
  assert.equal(got[0]!.text, "tea at 6", "in its newest version");
});

test("replayPrompt says the messages are late, in order", () => {
  const p = replayPrompt([line(10, "owner", "first"), line(5, "owner", "second")]);
  assert.match(p, /shortly before the assistant restarted/);
  assert.ok(p.indexOf("first") < p.indexOf("second"));
});

test("replayUnanswered: one queued turn per chat with unanswered lines, none for the rest", async () => {
  const turns: { conv: string; prompt: string }[] = [];
  const convs = [{ key: "owner", kind: "owner", source: "chat" }, { key: "t1", kind: "tenant", tenantId: "t1", source: "group" }, { key: "t2", kind: "tenant", tenantId: "t2", source: "group" }] as never[];
  const logs: Record<string, Sent[]> = { owner: [line(5, "owner", "where is my 3pm?", { by: "+1555" })], t1: [line(5, "owner", "hi"), line(4, "chat", "hello")], t2: [] };
  const pipeline = {
    enqueue: (_c: never, job: () => Promise<unknown>) => job(),
    runTurn: async (c: { key: string }, turn: { run: (h: never) => Promise<unknown>; announce: boolean; target?: { author: string; timestamp: number } }) => {
      await turn.run({} as never);
      assert.equal(turn.announce, true);
      assert.equal(turn.target?.author, "+1555");
      return { spoke: true };
    },
  };
  const silence = console.log;
  console.log = () => {};
  let n: number;
  try {
    n = replayUnanswered({
      pipeline: pipeline as never,
      conversations: () => convs,
      now: () => NOW,
      read: (c) => logs[(c as { key: string }).key]!,
      audit: () => [],
      tell: async () => assert.fail("nothing acted: the request is re-run, not apologised for"),
      run: async (c, prompt) => (turns.push({ conv: (c as { key: string }).key, prompt }), { text: "ok" }),
    });
    await new Promise((r) => setImmediate(r));
  } finally {
    console.log = silence;
  }
  assert.equal(n, 1);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.conv, "owner");
  assert.match(turns[0]!.prompt, /where is my 3pm\?/);
});

const row = (minAgo: number, tool: string, decision: string, source: AuditEntry["source"] = "chat"): AuditEntry => ({ ts: new Date(NOW - minAgo * 60_000).toISOString(), source, tool, decision });

test("actedSince: writes that went through count; reads, denials, old rows and other sources do not", () => {
  const since = NOW - 10 * 60_000;
  assert.equal(actedSince([row(5, "mcp__calendar__create_event", "allow")], "chat", since), true);
  assert.equal(actedSince([row(5, "mcp__x__send", "ask-approved")], "chat", since), true);
  assert.equal(actedSince([row(5, "mcp__x__send", "ask-declined"), row(5, "mcp__x__send", "deny-policy")], "chat", since), false);
  assert.equal(actedSince([row(20, "mcp__calendar__create_event", "allow")], "chat", since), false, "before the oldest unanswered line");
  assert.equal(actedSince([row(5, "mcp__calendar__create_event", "allow", "group")], "chat", since), false);
  assert.equal(actedSince([row(5, "Read", "allow")], "chat", since), false, "a read is not a side effect");
});

test("replayUnanswered: if the run acted before it died, the request is NOT re-run; one short line is sent instead", async () => {
  const told: string[] = [];
  let ran = 0;
  const silence = console.log;
  console.log = () => {};
  let n: number;
  try {
    n = replayUnanswered({
      pipeline: { enqueue: (_c: never, job: () => Promise<unknown>) => (ran++, job()), runTurn: async () => (ran++, { spoke: true }) } as never,
      conversations: () => [{ key: "owner", kind: "owner", source: "chat" }] as never[],
      now: () => NOW,
      read: () => [line(5, "owner", "put dinner in my calendar")],
      audit: () => [row(4, "mcp__calendar__create_event", "allow")],
      tell: async (_c, text) => void told.push(text),
      run: async () => (ran++, { text: "" }),
    });
    await new Promise((r) => setImmediate(r));
  } finally {
    console.log = silence;
  }
  assert.equal(n, 1);
  assert.equal(ran, 0, "nothing was run again");
  assert.deepEqual(told, [SORRY]);
  assert.match(replayPrompt([line(5, "owner", "x")]), /check whether it was already done/);
});

// ---- a group's meta.json ----

test("groupstore: a torn meta.json is moved aside and the group goes on with defaults (no throw on every message)", async () => {
  const { groupDir } = await import("../src/conversation/groupstore.ts");
  const dir = groupDir("group-corrupt-1", "Book club");
  const meta = join(dir, "meta.json");
  writeFileSync(meta, '{"id":"group-corrupt-1","na');
  const silence = console.error;
  console.error = () => {};
  try {
    assert.equal(groupDir("group-corrupt-1", "Book club 2"), dir); // a different name bypasses the in-memory cache
  } finally {
    console.error = silence;
  }
  assert.deepEqual(JSON.parse(readFileSync(meta, "utf8")), { id: "group-corrupt-1", name: "Book club 2" });
  assert.equal(readdirSync(dir).filter((f) => f.startsWith("meta.json.corrupt-")).length, 1);
});
