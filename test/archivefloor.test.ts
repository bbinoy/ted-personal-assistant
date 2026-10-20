import { test } from "node:test";
import assert from "node:assert/strict";
import { readAudit } from "../src/audit.ts";
import { buildOptions } from "../src/agentrun.ts";
import { heartbeatOptions } from "../src/agent.ts";
import { owner } from "../src/conversationmodel.ts";
import { LOGIN } from "../src/payer.ts";
import type { JudgeInput, Verdict } from "../src/approvals/autojudge.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { archivedId, createArchiveWatch, mailLinks, MAX_ARCHIVES_PER_RUN } from "../src/policy/archivefloor.ts";
import { isNeverAllowed } from "../src/policy/policy.ts";
import { settings } from "../src/settings.ts";

const MB = "mcp__mailbird__";
const GM = "mcp__claude_ai_Gmail__";
const signal = new AbortController().signal;
const opts = { signal, toolUseID: "u" } as never;
const mcp = (obj: unknown) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

test("which call is an archive, and of which mail", () => {
  assert.equal(archivedId(`${MB}archive_conversation`, { conversationId: "c-1" }), "c-1");
  const s = settings as unknown as Record<string, unknown>;
  const was = { mail: s.mail, mailProvider: s.mailProvider };
  Object.assign(s, { mail: true, mailProvider: "gmail" });
  try {
    assert.equal(archivedId(`${GM}unlabel_thread`, { threadId: "t-1", labelIds: ["INBOX"] }), "t-1");
    assert.equal(archivedId(`${GM}unlabel_thread`, { threadId: "t-1", labelIds: ["UNREAD"] }), undefined, "another label is not an archive");
  } finally {
    Object.assign(s, was);
  }
  assert.equal(archivedId(`${MB}archive_conversation`, {}), "", "an archive that names no mail is still an archive (never covered by a read)");
  for (const other of [`${MB}get_message`, `${MB}create_draft`, `${MB}move_conversation_to_inbox`, "WebSearch"]) assert.equal(archivedId(other, { conversationId: "c-1" }), undefined, other);
});

test("mail links: a message and its conversation are matched from any result shape", () => {
  assert.deepEqual(mailLinks(mcp({ conversationId: "c-1", messageId: 7, subject: "x" })), [{ conversation: "c-1", message: "7" }]);
  assert.deepEqual(mailLinks(mcp({ conversations: [{ conversationId: "c-1", lastMessageId: 7 }, { conversationId: "c-2", lastMessageId: 8 }] })).map((l) => `${l.conversation}:${l.message}`), ["c-1:7", "c-2:8"]);
  assert.deepEqual(mailLinks(mcp({ id: "m-1", threadId: "t-1", payload: "x" })), [{ conversation: "t-1", message: "m-1" }]);
  assert.deepEqual(mailLinks("not json"), []);
  assert.deepEqual(mailLinks(undefined), []);
});

test("the watch: an unread mail asks, a mail read in this run does not, the cap asks, only archives count", () => {
  const w = createArchiveWatch();
  const archive = (id: string) => ({ conversationId: id });
  assert.equal(w.ask(`${MB}archive_conversation`, archive("c-1")), "unread", "never opened in this run");
  // the list shows the mail's last message id, but listing is not reading
  w.seen(`${MB}list_conversations`, {}, mcp({ conversations: [{ conversationId: "c-1", lastMessageId: 7 }] }));
  assert.equal(w.ask(`${MB}archive_conversation`, archive("c-1")), "unread");
  // reading its message (by the message id, as the model does) marks the conversation read
  w.seen(`${MB}get_message`, { messageId: 7 }, mcp({ subject: "Weekly digest" }));
  assert.equal(w.ask(`${MB}archive_conversation`, archive("c-1")), undefined);
  assert.equal(w.ask(`${MB}archive_conversation`, archive("c-2")), "unread", "another mail is not covered");
  // a read by conversation id, and a Gmail thread read
  w.seen(`${MB}get_conversation`, { conversationId: "c-3" }, mcp({}));
  assert.equal(w.ask(`${MB}archive_conversation`, archive("c-3")), undefined);
  // the cap: the Nth archive is the last without a question
  for (let i = 0; i < MAX_ARCHIVES_PER_RUN; i++) {
    assert.equal(w.ask(`${MB}archive_conversation`, archive("c-3")), undefined, `archive ${i + 1}`);
    w.done(`${MB}archive_conversation`, archive("c-3"));
  }
  assert.equal(w.ask(`${MB}archive_conversation`, archive("c-3")), "cap");
  w.done(`${MB}get_message`, { messageId: 1 }); // not an archive: does not count
  assert.equal(w.ask(`${MB}get_message`, { messageId: 1 }), undefined, "only an archive is ever asked about");
});

// The run's closure with a fake judge that waves everything through, and an owner who says yes: what is asked is the floor's doing.
function rig() {
  const judged: JudgeInput[] = [];
  const asked: string[] = [];
  const archives = createArchiveWatch();
  const judge = async (i: JudgeInput): Promise<Verdict> => (judged.push(i), { decision: "auto", reason: "routine" });
  const can = makeCanUseTool(async (d) => (asked.push(d), { approved: true }), "background", undefined, judge, undefined, undefined, false, { provenance: () => ({ kind: "standing", task: "look" }), archives });
  return { judged, asked, archives, can };
}

test("the floor: an unread mail asks the owner and the judge is not consulted; a mail read in this run goes to the judge", async () => {
  const { judged, asked, archives, can } = rig();
  const r1 = await can(`${MB}archive_conversation`, { conversationId: "c-1" }, opts);
  assert.equal(r1?.behavior, "allow", "the owner said yes");
  assert.equal(judged.length, 0, "the judge never saw it");
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /did not open this mail in this run/);
  assert.ok(readAudit((e) => e.tool === `${MB}archive_conversation` && e.decision === "archive-ask" && e.meta?.why === "unread").length >= 1);
  // read it, and the same kind of call is the judge's (auto: no question)
  archives.seen(`${MB}get_message`, { messageId: 7 }, mcp({ conversationId: "c-2", messageId: 7 }));
  const r2 = await can(`${MB}archive_conversation`, { conversationId: "c-2" }, opts);
  assert.equal(r2?.behavior, "allow");
  assert.equal(judged.length, 1);
  assert.equal(asked.length, 1, "not asked: the judge waved it through");
});

test("the floor: after the cap the owner is asked for every further archive, and a no is a no", async () => {
  const { judged, asked, archives } = rig();
  let say = true;
  const can = makeCanUseTool(async (d) => (asked.push(d), { approved: say }), "background", undefined, async (i) => (judged.push(i), { decision: "auto", reason: "routine" }), undefined, undefined, false, { provenance: () => ({ kind: "standing", task: "look" }), archives });
  for (let i = 1; i <= MAX_ARCHIVES_PER_RUN + 1; i++) archives.seen(`${MB}get_conversation`, { conversationId: `cap-${i}` }, mcp({}));
  for (let i = 1; i <= MAX_ARCHIVES_PER_RUN; i++) assert.equal((await can(`${MB}archive_conversation`, { conversationId: `cap-${i}` }, opts))?.behavior, "allow", `archive ${i}`);
  assert.equal(judged.length, MAX_ARCHIVES_PER_RUN);
  assert.equal(asked.length, 0, "within the cap the judge decides");
  say = false;
  const over = await can(`${MB}archive_conversation`, { conversationId: `cap-${MAX_ARCHIVES_PER_RUN + 1}` }, opts);
  assert.equal(over?.behavior, "deny");
  assert.equal(judged.length, MAX_ARCHIVES_PER_RUN, "the judge was not asked about the sixth");
  assert.match(asked[0]!, /already archived 5 mails/);
  assert.ok(readAudit((e) => e.decision === "archive-ask" && e.meta?.why === "cap").length >= 1);
});

test("the floor changes nothing else: the never-allowed set is unchanged, a run without the watch (chat, groups) asks nothing extra", async () => {
  assert.ok(isNeverAllowed(`${MB}trash_conversation`) && isNeverAllowed(`${MB}delete_conversation_permanently`) && isNeverAllowed(`${GM}trash_thread`));
  const { archives } = rig();
  const can = makeCanUseTool(async () => ({ approved: false }), "background", undefined, undefined, undefined, undefined, false, { archives });
  assert.equal((await can(`${MB}delete_conversation_permanently`, { conversationId: "c-1" }, opts))?.behavior, "deny", "still denied outright, never asked");
  // the owner's chat and a group have no watch at all
  const refuse = async () => ({ approved: false }) as never;
  const chat = buildOptions(refuse, { source: "chat", systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1 } as never, undefined);
  const hb = buildOptions(refuse, heartbeatOptions(owner(), LOGIN), undefined);
  assert.ok(chat.canUseTool && hb.canUseTool);
  // the heartbeat run's closure: an unread archive reaches the owner (declined here), never the real judge
  const r = await hb.canUseTool!(`${MB}archive_conversation`, { conversationId: "c-77" }, opts);
  assert.equal(r?.behavior, "deny");
});
