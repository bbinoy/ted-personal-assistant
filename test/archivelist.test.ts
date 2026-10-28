import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { noteDone } from "../src/approvals/journalrender.ts";
import { forgetSeen, rememberNames } from "../src/approvals/seennames.ts";
import { forgetArmed } from "../src/core/sinks/journalsink.ts";
import { makeCanUseTool, UNATTENDED_SKIP } from "../src/approvals/permissions.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { convIdOfKey, convPaths } from "../src/core/convpaths.ts";
import { ledgerEntries } from "../src/core/messages.ts";
import { settings } from "../src/core/settings.ts";
import { archiveItems, readJournal } from "../src/memory/journalread.ts";
import { restoredBy } from "../src/modules/archivecap.ts";
import { OWNER_CHAT, OWNER_LOOK } from "./runkinds.ts";

// Archiving in an unattended run (the owner, 22 Oct): judged like every call; the judge's auto archives and the journal names the mail (subject, sender, id), so the next brief lists it
// numbered and "restore 3" brings it back; the judge's ask leaves the mail in the inbox, silently. In the owner's chat, putting mail back in the inbox needs no judge.

const MB = "mcp__mailbird__";
const GM = "mcp__claude_ai_Gmail__";
const opts = { signal: new AbortController().signal } as never;
(settings as unknown as { autoApprove: string }).autoApprove = "auto";
const says = (decision: Verdict["decision"]) => async (): Promise<Verdict> => ({ decision, reason: "test" });
const never = async (): Promise<Verdict> => assert.fail("the judge must not be called");
let n = 0;
const owner = () => `owner`;
const journal = (key: string) => ledgerEntries(convPaths(convIdOfKey(key)).messages).filter((m) => m.kind === "journal");
const look = (key: string, decision: Verdict["decision"], asked: string[]) =>
  makeCanUseTool(async (d) => (asked.push(d), { approved: true }), OWNER_LOOK, undefined, says(decision), undefined, undefined, false, { provenance: () => ({ kind: "standing", task: "the look" }), conversation: key, run: `run-${++n}` });

test("an unattended look archives what the judge is sure about: run, journaled with subject, sender and id; the brief's list numbers it by sender with the restore hint", async () => {
  forgetArmed();
  forgetSeen();
  const key = owner();
  const before = journal(key).length;
  const since = new Date(Date.now() - 1000).toISOString().slice(0, 16);
  rememberNames(key, JSON.stringify({ conversations: [
    { conversationId: "a-1", subject: "Your order shipped", from: { name: "Digitec" } },
    { conversationId: "a-2", subject: "Weekly digest", sender: "LinkedIn" },
    { conversationId: "a-3", subject: "Delivered", from: "Digitec" },
  ] }));
  const asked: string[] = [];
  const can = look(key, "auto", asked);
  for (const id of ["a-1", "a-2", "a-3"]) {
    const input = { conversationId: id };
    assert.equal(((await can(`${MB}archive_conversation`, input, opts)) as { behavior: string }).behavior, "allow", id);
    await noteDone({ conv: key, source: "background", tool: `${MB}archive_conversation`, input });
  }
  assert.deepEqual(asked, [], "nobody was asked");
  const lines = journal(key).slice(before);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!.text, /^Archived “Your order shipped” from Digitec\. Why: .*Undo: npm run restore a-1, or say 'restore that'\.$/);
  const items = archiveItems(lines);
  assert.deepEqual(items.map((i) => [i.n, i.subject, i.from, i.ids]), [[1, "Your order shipped", "Digitec", ["a-1"]], [2, "Weekly digest", "LinkedIn", ["a-2"]], [3, "Delivered", "Digitec", ["a-3"]]]);
  const text = readJournal(convPaths(convIdOfKey(key)).messages, { kind: "archive", since });
  assert.match(text, new RegExp(`^3 mails archived since ${since} \\(times in .+\\), by sender:\\n`));
  assert.match(text, /\nDigitec \(2\): 1\. “Your order shipped” \(\d\d-\d\d \d\d:\d\d, id a-1\); 3\. “Delivered” \(.*id a-3\)\n/, "grouped by sender, numbered in the order archived");
  assert.match(text, /\nLinkedIn \(1\): 2\. “Weekly digest”/);
  assert.match(text, /To bring one back: reply 'restore N' \(or 'restore 2,5'\) with the numbers of this list, or run npm run restore <id>\.$/);
});

test("an archive of several mails at once keeps every id, so one number restores them all", async () => {
  const lines = [{ ts: 1, at: "2026-10-22T08:00:00Z", kind: "journal" as const, cat: "archive", text: "Archived “A” from X and “B” from Y. Why: your note triage. Undo: npm run restore <id> for each of b-1 b-2, or say 'restore that'." }];
  assert.deepEqual(archiveItems(lines).map((i) => [i.n, i.ids, i.subject]), [[1, ["b-1", "b-2"], undefined]]);
});

test("an unattended look's archive the judge is not sure about is left in the inbox: skipped, no journal line, nobody asked", async () => {
  forgetArmed();
  const key = owner();
  const before = journal(key).length;
  const asked: string[] = [];
  const r = (await look(key, "ask", asked)(`${MB}archive_conversation`, { conversationId: "a-9" }, opts)) as { behavior: string; message?: string };
  assert.deepEqual([r.behavior, r.message], ["deny", UNATTENDED_SKIP]);
  assert.deepEqual(asked, []);
  assert.equal(journal(key).length, before);
});

test("bringing mail back: free in the owner's own chat (Mailbird to inbox, Gmail INBOX label), judged anywhere else; trash and spam stay refused", async () => {
  assert.deepEqual(restoredBy(`${MB}move_conversation_to_inbox`, { conversationId: "a-1" }), ["a-1"]);
  assert.deepEqual(restoredBy(`${GM}label_thread`, { threadId: "t-1", labelIds: ["INBOX"] }), ["t-1"]);
  assert.deepEqual(restoredBy("mcp__google__modify_gmail_message_labels", { message_id: "m-1", add_label_ids: ["INBOX"] }), ["m-1"]);
  assert.equal(restoredBy(`${GM}label_thread`, { threadId: "t-1", labelIds: ["Receipts"] }), undefined);
  assert.equal(restoredBy(`${GM}unlabel_thread`, { threadId: "t-1", labelIds: ["INBOX"] }), undefined, "that is an archive");
  assert.equal(restoredBy(`${MB}archive_conversation`, { conversationId: "a-1" }), undefined);
  const chat = makeCanUseTool(async () => assert.fail("not asked"), OWNER_CHAT, undefined, never, undefined, undefined, false, { conversation: "owner", restoreFree: true });
  assert.equal(((await chat(`${MB}move_conversation_to_inbox`, { conversationId: "a-1" }, opts)) as { behavior: string }).behavior, "allow");
  assert.equal(((await chat(`${GM}label_thread`, { threadId: "t-1", labelIds: ["INBOX"] }, opts)) as { behavior: string }).behavior, "allow");
  assert.equal(((await chat(`${MB}trash_conversation`, { conversationId: "a-1" }, opts)) as { behavior: string }).behavior, "deny", "the never-allowed set");
  let judged = 0;
  const bg = makeCanUseTool(async () => ({ approved: false }), OWNER_LOOK, undefined, async () => (judged++, { decision: "ask", reason: "t" }), undefined, undefined, false, { provenance: () => ({ kind: "standing", task: "x" }), conversation: "owner" });
  assert.equal(((await bg(`${MB}move_conversation_to_inbox`, { conversationId: "a-1" }, opts)) as { behavior: string }).behavior, "deny");
  assert.equal(judged, 1, "outside the owner's chat a restore is judged like any call");
});

test("the daily brief lists the archived mail from the numbered list, and its chat line says how to bring one back", () => {
  const skill = readFileSync("plugin/skills/daily-brief/SKILL.md", "utf8");
  assert.match(skill, /## 🧹 Archived/);
  assert.match(skill, /One line of counts by kind[\s\S]*journal number[\s\S]*never renumbered[\s\S]*Reply 'archived' for the full numbered list/);
  assert.match(skill, /🧹 Archived N since <since> \(list in the email; reply 'restore N' to bring one back\)/);
  assert.match(skill, /once with `kind` `archive`/);
});
