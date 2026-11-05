import { test } from "node:test";
import assert from "node:assert/strict";
import { owner } from "../src/conversation/conversationmodel.ts";
import { createDreamer, dreamConversations, type Runner } from "../src/conversation/dream.ts";
import { dreamStateConv, readDream } from "../src/modules/memory/dreamscope.ts";
import { convDb } from "../src/core/convdb.ts";
import { OWNER_CONV } from "../src/core/convpaths.ts";
import { recordMessage } from "../src/core/messages.ts";
import { loginExpiryFact, refreshLoginExpiry, resetLoginExpiry } from "../src/core/loginwatch.ts";
import { AuthError } from "../src/tenants/errors.ts";

// The end of the Claude login is a fact under three days away; a dream refused by the API is retried, a crash is not.

test("the end of the login is a fact only under three days away, and an unreadable status gives none", async () => {
  const now = new Date("2026-10-14T10:00:00Z");
  const status = (days: number) => JSON.stringify({ loggedIn: true, loginExpiresAt: new Date(now.getTime() + days * 86_400_000).toISOString() });
  const fact = () => loginExpiryFact(now, "Europe/London", "Run `claude auth login`.");
  resetLoginExpiry();
  await refreshLoginExpiry(now, async () => status(10));
  assert.equal(fact(), "");
  resetLoginExpiry();
  await refreshLoginExpiry(now, async () => status(2));
  assert.match(fact(), /runs out on 2026-10-16/);
  assert.match(fact(), /claude auth login/);
  resetLoginExpiry();
  await refreshLoginExpiry(now, async () => "not json");
  assert.equal(fact(), "");
  resetLoginExpiry();
  await refreshLoginExpiry(now, async () => { throw new Error("no claude"); });
  assert.equal(fact(), "");
  resetLoginExpiry();
  await refreshLoginExpiry(now, async () => undefined);
  assert.equal(fact(), "");
});

test("the status is read at most once a day", async () => {
  resetLoginExpiry();
  let reads = 0;
  const read = async () => (reads++, undefined);
  await refreshLoginExpiry(new Date(2026, 9, 14, 8), read);
  await refreshLoginExpiry(new Date(2026, 9, 14, 20), read);
  assert.equal(reads, 1);
  await refreshLoginExpiry(new Date(2026, 9, 15, 8), read);
  assert.equal(reads, 2);
});

test("a dream the API refused keeps its day and is retried; a crash does not retry", async () => {
  convDb(OWNER_CONV).run("DELETE FROM dream");
  recordMessage("owner", 5, "I take my coffee black and I run on Sundays", new Date("2026-10-13T20:00:00Z"));
  const now = new Date("2026-10-14T07:00:00");
  let fail: Error | undefined = new AuthError("authentication_failed");
  let calls = 0;
  const run = (): Runner => async () => {
    calls++;
    if (fail) throw fail;
    return { ops: [] };
  };
  const d = createDreamer({ conversations: () => dreamConversations(["owner"]), run });
  await d.run(now);
  assert.equal(calls, 1);
  assert.notEqual(readDream(dreamStateConv(owner())).day, "2026-10-14", "the refused night is not used up");
  fail = undefined;
  await d.run(now);
  assert.equal(calls, 2, "after recovery the next tick dreams it");
  assert.equal(readDream(dreamStateConv(owner())).day, "2026-10-14");
  convDb(OWNER_CONV).run("DELETE FROM dream"); // a crash keeps the day: no retry on every tick
  fail = new Error("boom");
  calls = 0;
  await d.run(now);
  await d.run(now);
  assert.equal(calls, 1);
});
