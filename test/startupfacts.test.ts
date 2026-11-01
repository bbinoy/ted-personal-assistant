import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Start-up problems (a damaged ledger, an unreadable friends list, strangers still waiting) are FACTS for the owner's next run, once a day while they last and not at every restart; never a code-written message (CLAUDE.md §4).
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "startupfacts-"));

const { holdStartupFact } = await import("../src/core/ownerfact.ts");
const { convDb } = await import("../src/core/convdb.ts");
const { OWNER_CONV } = await import("../src/core/convpaths.ts");
const Reg = await import("../src/tenants/registration.ts");
const { openRequestsFact, createRegistrar } = await import("../src/approvals/registerask.ts");
const R = await import("../src/tenants/tenantroute.ts");

const held = (): string[] => convDb(OWNER_CONV).all<{ text: string }>("SELECT text FROM held_posts ORDER BY seq").map((r) => r.text);
const DAY = 86_400_000;

test("a start-up problem becomes one held fact, not a message, and a restart does not add it again within the day", () => {
  const t0 = new Date("2026-10-22T10:00:00Z");
  assert.equal(holdStartupFact("ledger", "The ledger is damaged.", t0), true);
  assert.equal(holdStartupFact("ledger", "The ledger is damaged.", new Date(t0.getTime() + 3_600_000)), true, "the restart: told already");
  assert.equal(held().filter((h) => h.includes("The ledger is damaged.")).length, 1);
  assert.match(held()[0]!, /System status for .*: say it in one short line in your own words/);
  assert.equal(holdStartupFact("registry", "The friends list is unreadable.", t0), true, "another problem is its own fact");
  assert.equal(held().length, 2);
});

test("a registration request is a fact at restart (ids only, no name, no word of hers) and a restart sends no second card", async () => {
  const sent: string[] = [];
  const reg = createRegistrar({ send: async (t) => (sent.push(t), 1), joined: () => {}, request: (async () => new Promise(() => {})) as never });
  assert.equal(openRequestsFact(), undefined);
  R.admitStranger({ fromUuid: "bbbbbbbb-0000-4000-8000-000000000001", name: "Zed", text: "CANARY-WORDS" }, { reply: async () => {}, deliver: () => {}, requested: reg.ask }, Date.now());
  const fact = openRequestsFact()!;
  assert.match(fact, /1 person\(s\) who wrote to me are still waiting/);
  assert.doesNotMatch(fact, /Zed|CANARY/);
  assert.ok(!("askOpen" in reg), "no re-ask at start");
  assert.equal(Reg.openRequests().length, 1);
  holdStartupFact("registrations", fact, new Date(Date.now() + DAY));
  assert.ok(held().some((h) => h.includes("still waiting")));
});
