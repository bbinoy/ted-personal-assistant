import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchLog } from "./scratch.ts";
import { OWNER_CONV } from "../src/core/convpaths.ts";

// Mail decisions (src/tasks/maildecisions.ts): the looks' last decision per inbox mail, kept per conversation in a bounded table and handed to EVERY run of a conversation with mail as a fact
// (heartbeat/facts.ts). A mail that is not in the block is new; nothing is hidden. Nothing about the mailbox or the provider is known to code.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "maildecisions-test-"));

const { createTriage, decisionsBlock, inboxBlock, ageText, MAX_DECISIONS } = await import("../src/tasks/maildecisions.ts");
const { createHeartbeatLook } = await import("../src/heartbeat/look.ts");
const { factsFor } = await import("../src/heartbeat/facts.ts");
const { owner, tenant } = await import("../src/conversation/conversation.ts");
const { LOGIN } = await import("../src/tenants/payer.ts");
const T = await import("../src/tenants/tenants.ts");
const { instanceDb } = await import("../src/core/instancedb.ts");
const { convDb } = await import("../src/core/convdb.ts");
const { groupConvId } = await import("../src/core/convpaths.ts");
const { recordMessage } = await import("../src/core/messages.ts");

const file = (n: string) => groupConvId(`maildec-${n}`); // (a conversation of its own per test: its decisions are a table of its own assistant.db)
const ids = (f: string): string[] => convDb(f).all<{ id: string }>("SELECT id FROM mail_decisions ORDER BY seq").map((r) => r.id);
const row = (id: string, decision: "archive" | "keep" | "task" | "draft" = "keep", reason = "r", from = "", subject = "") => ({ id, decision, reason, from, subject });
const HOUR = 3_600_000;
const NOW = 100 * HOUR;

test("record keeps the last decision per mail; it is read back as the block, newest first, with the age", () => {
  const f = file("a");
  const triage = createTriage(f);
  assert.equal(inboxBlock(f, NOW), "", "no decisions: every mail is new");
  triage.record([row("c-1", "keep", "needs the owner's answer", "Philip", "Thanksgiving"), row("18f3a", "archive", "newsletter", "News", "Weekly")], NOW - 5 * HOUR);
  triage.record([row("c-2", "draft", "reply overdue", "Eve", "Friday")], NOW - 3 * HOUR);
  const text = inboxBlock(f, NOW);
  assert.match(text, /A mail you find in the inbox that is not listed here is new/);
  assert.match(text, /c-2 \| drafted a reply 3 h ago: “Friday” from Eve, reply overdue\n/);
  assert.match(text, /c-1 \| kept 5 h ago: “Thanksgiving” from Philip, needs the owner's answer/);
  assert.match(text, /18f3a \| archive not done yet 5 h ago/, "an archive that did not go through is still in the inbox");
  assert.ok(text.indexOf("c-2 |") < text.indexOf("c-1 |"), "newest first");
  triage.record([row("c-1", "task", "task added")], NOW - HOUR);
  assert.match(inboxBlock(f, NOW), /c-1 \| made a task 1 h ago/, "a changed decision replaces the old one");
  assert.equal(ids(f).filter((i) => i === "c-1").length, 1);
});

test("an archive the code allowed leaves the inbox, so its row goes; one the judge skipped stays and is shown", () => {
  const f = file("gone");
  const triage = createTriage(f);
  triage.record([row("k"), row("a1"), row("a2")], NOW - 4 * HOUR);
  triage.judged(["a1"], "allowed", "newsletter");
  triage.judged(["a2"], "skipped", "unsure");
  triage.record([row("a1", "archive", "promo"), row("a2", "archive", "promo")], NOW - HOUR);
  const text = inboxBlock(f, NOW);
  assert.doesNotMatch(text, /a1 \|/, "archived mails drop out");
  assert.match(text, /a2 \| archive not done yet 1 h ago/);
  assert.match(text, /k \| kept 4 h ago/);
  assert.deepEqual(triage.verdict("a2"), { outcome: "skipped", reason: "unsure" });
});

test("an unchanged mail keeps its age: only the rows a look reports are touched; old decisions and a long block are bounded", () => {
  const f = file("age");
  const triage = createTriage(f);
  triage.record([row("a"), row("b")], NOW - 6 * HOUR);
  triage.record([row("b", "task")], NOW - HOUR);
  const text = inboxBlock(f, NOW);
  assert.match(text, /a \| kept 6 h ago/);
  assert.match(text, /b \| made a task 1 h ago/);
  assert.doesNotMatch(inboxBlock(f, NOW + 20 * 24 * HOUR), /a \|/, "a decision older than 14 days is not shown");
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `x${i}`, decision: "keep", reason: "", sender: "", subject: "", at: NOW - i * 1000 }));
  assert.equal(decisionsBlock(many, NOW).split("\n").filter((l) => /^x\d+ \|/.test(l)).length, 40, "at most 40 lines");
  assert.equal(decisionsBlock([], NOW), "");
  assert.equal(ageText(5 * 60_000), "5 min ago");
  assert.equal(ageText(30 * HOUR), "30 h ago");
  assert.equal(ageText(72 * HOUR), "3 d ago");
});

test("the table is bounded: the newest MAX_DECISIONS rows stay, the oldest are forgotten", () => {
  const f = file("c");
  const triage = createTriage(f, 5);
  triage.record(["a", "b", "c", "d"].map((i) => row(i)), 1);
  triage.record(["e", "f", "g"].map((i) => row(i)), 2);
  assert.deepEqual(ids(f), ["c", "d", "e", "f", "g"]);
  assert.equal(MAX_DECISIONS, 2000);
});

test("per conversation: the owner's table, each friend's in her own folder; one never shows the other", () => {
  const rec = T.addTenant({ aci: "00000000-0000-4000-8000-0000000000c1", name: "Ana" })!;
  const rec2 = T.addTenant({ aci: "00000000-0000-4000-8000-0000000000c2", name: "Bo" })!;
  assert.equal(owner().convId, OWNER_CONV);
  assert.notEqual(tenant(rec.id).convId, tenant(rec2.id).convId);
  createTriage(tenant(rec.id).convId).record([row("same-id", "keep", "r", "", "Hello")], Date.now());
  assert.match(inboxBlock(tenant(rec.id).convId, Date.now()), /same-id/);
  assert.equal(inboxBlock(tenant(rec2.id).convId, Date.now()), "", "Bo has no decision of Ana's");
});

test("every run of a conversation with mail gets the block as a fact, whatever started it: a chat turn and a look alike", () => {
  const conv = owner();
  createTriage(conv.convId).record([row("m-1", "keep", "Eve waits for an answer", "Eve", "Friday")], Date.now() - 2 * HOUR);
  const chat = factsFor(conv, new Date(), true);
  const look = factsFor(conv, new Date(), false);
  for (const facts of [chat, look]) assert.ok(facts.status.some((s) => /m-1 \| kept 2 h ago: “Friday” from Eve, Eve waits for an answer/.test(s)), "in the status facts");
  chat.done({ ended: true, said: false, abandoned: false });
  look.done({ ended: true, said: false, abandoned: false });
});

// ---- the look records its decisions ----

function look(run: () => Promise<{ text: string; structured?: unknown }>) {
  const conv = { ...owner(), logFile: scratchLog(`dec-look-${Math.random().toString(36).slice(2)}.jsonl`) };
  const pipeline = {
    enqueue: <X>(_c: unknown, job: () => Promise<X>) => job(),
    record: () => {},
    busy: () => false, sendWhile: async (_c: unknown, r: () => Promise<unknown>) => r(),
    runTurn: async (_c: unknown, turn: { run: () => Promise<unknown> }) => (await turn.run(), { spoke: true }),
  };
  const hb = createHeartbeatLook({ pipeline: pipeline as never, run: (async () => run()) as never, may: () => LOGIN, why: () => "x", notesChangedAt: () => 0 });
  recordMessage("owner", Date.now(), "hi", new Date(), conv.logFile);
  return { hb, conv };
}

test("a look that answers records its decisions for the next run; a look that fails records none", async () => {
  const triage = [row("look-1", "keep", "Eve waits", "Eve", "Friday"), row("look-2", "archive", "promo")];
  const err = console.error;
  console.error = () => {};
  const before = ids(OWNER_CONV);
  try {
    const bad = look(async () => {
      throw new Error("boom");
    });
    assert.equal(await bad.hb.look(bad.conv, {} as never, new Date()), "failed");
    assert.deepEqual(ids(OWNER_CONV), before, "failed: nothing decided");
    const good = look(async () => ({ text: "", structured: { message: "[[silent]]", nextCheckMinutes: 30, triage } }));
    assert.equal(await good.hb.look(good.conv, {} as never, new Date()), "silent");
    assert.deepEqual(ids(OWNER_CONV).slice(before.length), ["look-1", "look-2"], "silent but fine: decided from now on");
  } finally {
    console.error = err;
  }
  assert.match(inboxBlock(OWNER_CONV, Date.now()), /look-1 \| kept/);
  assert.ok(instanceDb().num("SELECT COUNT(*) FROM looks") >= 2);
});
