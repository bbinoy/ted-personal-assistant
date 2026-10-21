import { test } from "node:test";
import assert from "node:assert/strict";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { readAudit } from "../src/core/audit.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { createSeenMail } from "../src/modules/seenmail/seenmail.ts";
import { archiveGate, archivedBy } from "../src/modules/archivecap.ts";
import { loadSettings, settings } from "../src/core/settings.ts";

// The archive cap: at most ARCHIVE_MAX_PER_RUN archives per run, for every mail provider, each message of a batch counted.

const MB = "mcp__mailbird__";
const GM = "mcp__claude_ai_Gmail__";
const GG = "mcp__google__";
const opts = { signal: new AbortController().signal } as never;
type Out = { behavior: string; message?: string };
const autoJudge = async (): Promise<Verdict> => ({ decision: "auto", reason: "test" });

async function withCap<T>(cap: number, over: Record<string, unknown>, f: () => Promise<T>): Promise<T> {
  const s = settings as unknown as Record<string, unknown>;
  const keys = ["archiveMaxPerRun", ...Object.keys(over)];
  const was = Object.fromEntries(keys.map((k) => [k, s[k]]));
  Object.assign(s, { archiveMaxPerRun: cap, autoApprove: "auto" }, over);
  try {
    return await f();
  } finally {
    Object.assign(s, was);
  }
}

test("setting: ARCHIVE_MAX_PER_RUN defaults to 25 and is validated", () => {
  assert.equal(loadSettings({}).archiveMaxPerRun, 25);
  assert.equal(loadSettings({ ARCHIVE_MAX_PER_RUN: "3" }).archiveMaxPerRun, 3);
  assert.throws(() => loadSettings({ ARCHIVE_MAX_PER_RUN: "0" }), /ARCHIVE_MAX_PER_RUN/);
});

test("which calls are archives, and how many messages each one counts", () => {
  assert.deepEqual(archivedBy(`${MB}archive_conversation`, { conversationId: "c1" }), ["c1"]);
  assert.deepEqual(archivedBy(`${MB}archive_conversation`, { conversationIds: ["a", "b", "c"] }), ["a", "b", "c"], "a batch counts each message");
  assert.deepEqual(archivedBy(`${GM}unlabel_thread`, { threadId: "t1", labelIds: ["INBOX"] }), ["t1"]);
  assert.deepEqual(archivedBy(`${GM}unlabel_message`, { messageId: "m1", labelIds: ["inbox"] }), ["m1"]);
  assert.deepEqual(archivedBy(`${GM}update_message_labels`, { messageId: "m1", removeLabelIds: ["INBOX"] }), ["m1"]);
  assert.deepEqual(archivedBy(`${GG}modify_gmail_message_labels`, { message_id: "g1", remove_label_ids: ["INBOX"] }), ["g1"]);
  assert.equal(archivedBy(`${GG}modify_gmail_message_labels`, { message_id: "g1", add_label_ids: ["INBOX"] }), undefined, "adding INBOX is a restore");
  assert.equal(archivedBy(`${GM}unlabel_thread`, { threadId: "t1", labelIds: ["UNREAD"] }), undefined);
  assert.equal(archivedBy(`${MB}get_message`, { messageId: 1 }), undefined);
  assert.deepEqual(archivedBy(`${MB}archive_conversation`, {}), [""], "an archive naming no id still counts as one");
});

test("the gate: the same id is counted once, a batch past the cap is refused whole, and a refused call uses nothing", () => {
  const gate = archiveGate(() => 3);
  assert.equal(gate(`${MB}archive_conversation`, { conversationId: "a" }), undefined);
  assert.equal(gate(`${MB}archive_conversation`, { conversationId: "a" }), undefined, "the same conversation again is not a new archive");
  assert.match(gate(`${MB}archive_conversation`, { conversationIds: ["b", "c", "d"] }) ?? "", /archive cap reached for this look/i);
  assert.equal(gate(`${MB}archive_conversation`, { conversationIds: ["b", "c"] }), undefined, "the refused batch used none of the places");
  assert.match(gate(`${MB}archive_conversation`, { conversationId: "e" }) ?? "", /the rest waits for the next one/);
  assert.equal(gate(`${MB}get_message`, { messageId: 1 }), undefined, "only archives are counted");
});

const sequence = async (tool: string, key: (n: number) => Record<string, unknown>, source: "chat" | "background" | "group" = "background", tools?: ReadonlySet<string>) => {
  const can = makeCanUseTool(async () => ({ approved: true }), source, undefined, autoJudge, undefined, tools, false, { provenance: () => ({ kind: "owner-words", text: "tidy the inbox" }) as never });
  const out: Out[] = [];
  for (let n = 0; n < 4; n++) out.push((await can(tool, key(n), opts)) as Out);
  return out;
};

test("Mailbird: the fourth archive of a run with a cap of three is refused and audited; a batch counts each message", async () => {
  await withCap(3, {}, async () => {
    const start = new Date().toISOString();
    const out = await sequence(`${MB}archive_conversation`, (n) => ({ conversationId: `cap-mb-${n}` }));
    assert.deepEqual(out.map((o) => o.behavior), ["allow", "allow", "allow", "deny"]);
    assert.match(out[3]!.message ?? "", /archive cap reached for this look/i);
    assert.ok(readAudit((e) => e.decision === "deny-run-cap" && e.ts >= start).length >= 1, "the refusal is in the audit log");
    const can = makeCanUseTool(async () => ({ approved: true }), "background", undefined, autoJudge, undefined, undefined, false, { provenance: () => ({ kind: "owner-words", text: "tidy" }) as never });
    assert.equal(((await can(`${MB}archive_conversation`, { conversationIds: ["x1", "x2", "x3", "x4"] }, opts)) as Out).behavior, "deny", "four messages in one call are four archives");
    assert.equal(((await can(`${MB}archive_conversation`, { conversationId: "x1" }, opts)) as Out).behavior, "allow", "each run has its own count");
  });
});

test("Gmail: removing INBOX counts the same way, other label changes do not", async () => {
  await withCap(2, { mail: true, mailProvider: "gmail" }, async () => {
    const out = await sequence(`${GM}unlabel_thread`, (n) => ({ threadId: `cap-gm-${n}`, labelIds: ["INBOX"] }));
    assert.deepEqual(out.map((o) => o.behavior), ["allow", "allow", "deny", "deny"]);
    assert.match(out[2]!.message ?? "", /archive cap reached/i);
    const can = makeCanUseTool(async () => ({ approved: true }), "background", undefined, autoJudge, undefined, undefined, false, { provenance: () => ({ kind: "owner-words", text: "tidy" }) as never });
    for (let n = 0; n < 4; n++) assert.doesNotMatch(((await can(`${GM}label_thread`, { threadId: `l${n}`, labelIds: ["STARRED"] }, opts)) as Out).message ?? "", /cap reached/, "a label that is no archive is no part of the cap");
  });
});

test("a friend's Google: removing INBOX with modify_gmail_message_labels counts too", async () => {
  await withCap(2, {}, async () => {
    const tool = `${GG}modify_gmail_message_labels`;
    const out = await sequence(tool, (n) => ({ message_id: `cap-gg-${n}`, remove_label_ids: ["INBOX"] }), "group", new Set([tool]));
    assert.equal(out.filter((o) => /archive cap reached/i.test(o.message ?? "")).length, 2, "the third and fourth are refused by the cap");
  });
});

test("seen mail: ids an archive the run cap refused named are forgotten, so the next look raises them again; the others commit", async () => {
  const file = `state/seen-forget-${Math.random().toString(36).slice(2)}.json`;
  await withCap(1, {}, async () => {
    const seen = createSeenMail(file);
    assert.deepEqual(seen.unseen(["a", "b", "c"]), ["a", "b", "c"]);
    const can = makeCanUseTool(async () => ({ approved: true }), "background", undefined, autoJudge, undefined, undefined, false, { provenance: () => ({ kind: "owner-words", text: "tidy" }) as never, seenMail: seen });
    assert.equal(((await can(`${MB}archive_conversation`, { conversationId: "a" }, opts)) as Out).behavior, "allow");
    assert.equal(((await can(`${MB}archive_conversation`, { conversationIds: ["b", "c"] }, opts)) as Out).behavior, "deny", "past the cap");
    seen.commit();
    assert.deepEqual(createSeenMail(file).unseen(["a", "b", "c"]), ["b", "c"], "the refused ones come back");
  });
});
