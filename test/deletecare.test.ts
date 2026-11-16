import { test } from "node:test";
import { rememberNames } from "../src/approvals/seennames.ts";
import assert from "node:assert/strict";
import { isJudgeable, mayFix, notifyNote, type Verdict } from "../src/approvals/autojudge.ts";
import { SYSTEM } from "../src/approvals/approvaljudge.ts";
import { createdLabel, forgetCreated, idsInCall, idsInResult, noteCreated } from "../src/approvals/created.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { classify } from "../src/policy/policy.ts";
import { settings } from "../src/core/settings.ts";
import { createsOf } from "../src/policy/toolmanifest.ts";
import { OWNER_CHAT } from "./runkinds.ts";

// The five destructive actions (a draft, a calendar event, a Notion page and a Drive file to the bin) are allowed, judged with care: the judge is told by code whether the
// delete goes to a bin or is permanent, and a delete is never fixed.

const MB = "mcp__mailbird__";
const CAL = "mcp__claude_ai_Google_Calendar__";
const N = "mcp__claude_ai_Notion__";
const opts = { signal: new AbortController().signal } as never;
const setAuto = () => void ((settings as { autoApprove: string }).autoApprove = "auto");

test("created.ts: ids come from the assistant's own create results, per conversation, for 24 hours", () => {
  forgetCreated();
  const t0 = 1_000_000;
  // the shapes a tool result takes: text content holding JSON, a plain object, a Notion address
  assert.deepEqual(idsInResult({ content: [{ type: "text", text: JSON.stringify({ id: "AbC123", summary: "x" }) }] }), ["abc123"]);
  assert.deepEqual(idsInResult({ eventId: "ev9" }), ["ev9"]);
  assert.deepEqual(idsInResult("saved draft {\"messageId\": 26305}"), ["26305"]);
  assert.deepEqual(idsInResult({ pages: [{ url: "https://www.notion.so/Trip-0123456789abcdef0123456789abcdef" }] }), ["0123456789abcdef0123456789abcdef"]);
  assert.deepEqual(idsInResult("nothing here"), []);
  assert.deepEqual(idsInCall({ page_id: ["01234567", "89ab", "cdef", "0123", "456789abcdef"].join("-"), note: "x" }), ["0123456789abcdef0123456789abcdef"]);
  assert.deepEqual(idsInCall({ messageId: 26305 }), ["26305"]);
  assert.deepEqual(idsInCall({ summary: "no id" }), []);
  noteCreated("owner", ["26305", "ev9"], t0, "“Draft”");
  assert.equal(createdLabel("owner", { messageId: 26305 }, t0 + 1000), "“Draft”");
  assert.equal(createdLabel("owner", { messageId: 111 }, t0 + 1000), undefined);
  assert.equal(createdLabel("tenant:mara", { messageId: 26305 }, t0 + 1000), undefined, "another conversation's ids tell nothing");
  assert.equal(createdLabel("owner", { messageId: 26305 }, t0 + 24 * 3_600_000 + 1), undefined, "older than 24 hours");
  forgetCreated();
});

test("which calls count as creating something: a draft, an event, a page; not an update, and not a friend's non-create", () => {
  assert.equal(createsOf(`${MB}create_draft`, {}), true);
  assert.equal(createsOf(`${MB}reply_to_conversation`, {}), true);
  assert.equal(createsOf(`${MB}update_draft`, {}), false);
  assert.equal(createsOf(`${CAL}create_event`, {}), true);
  assert.equal(createsOf(`${CAL}update_event`, {}), false);
  assert.equal(createsOf(`${N}notion-create-pages`, {}), true);
  assert.equal(createsOf(`${N}notion-update-page`, {}), false);
  assert.equal(createsOf("mcp__google__manage_event", { action: "create" }), true);
  assert.equal(createsOf("mcp__google__manage_event", { action: "update" }), false);
  assert.equal(createsOf("mcp__claude_ai_Gmail__create_draft", {}), true);
});

test("the judge is told by code, for a delete only, whether it goes to a bin or is permanent", () => {
  assert.match(notifyNote(`${N}notion-update-page`, { page_id: "p", in_trash: true }), /\nDelete: goes to the bin, restorable for about 30 days/);
  assert.equal(notifyNote(`${N}notion-update-page`, { page_id: "p" }), "");
  assert.match(notifyNote(`${MB}discard_draft`, { messageId: 1 }), /\nDelete: permanent, not known to go to a bin/);
  assert.match(notifyNote(`${CAL}delete_event`, { eventId: "e" }), /Notifies: this call names no guests[\s\S]*\nDelete: permanent/);
  assert.equal(notifyNote(`${MB}archive_conversation`, { conversationId: "c" }), "");
});

test("through the permission path: classify asks, the judge sees the care line, the owner's yes or the judge's auto decides, a fix is never taken", async () => {
  setAuto();
  forgetCreated();
  rememberNames("c-owner", JSON.stringify([{ id: 26305, subject: "Mine" }, { id: 99, subject: "Old" }, { id: 100, subject: "Older" }, { id: "e1", summary: "Dinner" }, { id: "p", title: "Notes" }])); // (read by the run: an unseen delete is first sent back to look it up)
  const seen: string[] = [];
  const mk = (decision: Verdict["decision"], conv: string) => {
    const asked: string[] = [];
    const can = makeCanUseTool(async (d) => (asked.push(d), { approved: false }), OWNER_CHAT, undefined, (async (i: { description: string }) => (seen.push(i.description), { decision, reason: "r" })) as never, undefined, undefined, false, { provenance: () => ({ kind: "owner", message: "delete that draft" }), conversation: conv });
    return { asked, can: async (t: string, i: Record<string, unknown>) => ((await can(t, i, opts)) as { behavior: string; message?: string }) };
  };
  assert.equal(classify(`${MB}discard_draft`, { messageId: 26305 }, OWNER_CHAT), "ask");
  assert.equal(isJudgeable(`${MB}discard_draft`, { messageId: 26305 }), true);
  assert.equal(mayFix(`${MB}discard_draft`, { input: { messageId: 26305 } }), false);
  // auto: nobody is asked
  let r = mk("auto", "c-owner");
  assert.equal((await r.can(`${MB}discard_draft`, { messageId: 26305 })).behavior, "allow");
  assert.equal(r.asked.length, 0);
  assert.match(seen.at(-1)!, /\nDelete: permanent/);
  // ask: the owner is asked, with the title and the id
  r = mk("ask", "c-owner");
  assert.equal((await r.can(`${MB}discard_draft`, { messageId: 99 })).behavior, "deny");
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0]!, /Delete draft[\s\S]*99/);
  // fix: never taken for a delete: the owner is asked instead of the call being bounced to the model
  r = mk("fix", "c-owner");
  await r.can(`${MB}discard_draft`, { messageId: 100 });
  assert.equal(r.asked.length, 1);
  // a calendar delete that names guests, or a Notion page: guests are never judged, a page is
  r = mk("auto", "c-owner");
  await r.can(`${CAL}delete_event`, { eventId: "e1", attendees: [{ email: "a@example.org" }] });
  assert.equal(r.asked.length, 1);
  const n = seen.length;
  await r.can(`${N}notion-update-page`, { page_id: "p", in_trash: true });
  assert.equal(seen.length, n + 1);
  assert.match(seen.at(-1)!, /\nDelete: goes to the bin/);
  forgetCreated();
});

test("the judge's prompt: a delete is judged by bin and reach, not by who made it; never fix", () => {
  assert.match(SYSTEM, /Deleting is judged by reversibility and reach, not by who made the thing/);
  assert.match(SYSTEM, /"Delete:" line written by code/);
  assert.match(SYSTEM, /A permanent delete is ask, even a draft nobody has seen/);
  assert.match(SYSTEM, /Never choose fix for a delete\./);
  assert.ok(!/Created by the assistant/.test(SYSTEM));
});

test("the journal line of a delete to the bin says it can be restored; a permanent one does not", async () => {
  const { noteDone } = await import("../src/approvals/journalrender.ts");
  const { ledgerEntries } = await import("../src/core/messages.ts");
  const { convIdOfKey, convPaths } = await import("../src/core/convpaths.ts");
  const key = "owner";
  const lines = () => ledgerEntries(convPaths(convIdOfKey(key)).messages).filter((m) => m.kind === "journal").map((m) => m.text);
  const before = lines().length;
  await noteDone({ conv: key, source: "chat", tool: `${N}notion-update-page`, input: { page_id: "p9", in_trash: true }, response: "ok" });
  await noteDone({ conv: key, source: "chat", tool: `${MB}discard_draft`, input: { messageId: 5 }, response: "ok" });
  const added = lines().slice(before);
  assert.equal(added.length, 2);
  assert.match(added[0]!, /restorable from the bin for about 30 days/);
  assert.doesNotMatch(added[1]!, /restorable/);
});
