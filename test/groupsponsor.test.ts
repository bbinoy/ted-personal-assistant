import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// A group is accepted when its SPONSOR is a member: the owner, or an active friend whose capabilities allow groups (a friend owns her Ted). The sponsor is recorded when the group is first
// accepted and stays; a friend's group is billed to her on the instance key, has no more capabilities than she has, and is private to her like her own chat (CLAUDE.md §5).
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "groupsponsor-"));
process.env.CLAUDE_CODE_OAUTH_TOKEN = "owner-oauth-token"; // the owner's login, which a friend's group must never carry

const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { sponsorInGroup, sponsorOfMember } = await import("../src/conversation/group.ts");
const { group } = await import("../src/conversation/conversationmodel.ts");
const { listGroups, listOwnerGroups, recordGroup, sponsorOf } = await import("../src/conversation/groupstore.ts");
const { charge, isRefusal, mayRun } = await import("../src/tenants/payer.ts");
const { capabilitiesOf, groupCapabilities } = await import("../src/policy/capabilities.ts");
const { runFor } = await import("../src/run/runoptions.ts");
const { runConversation } = await import("../src/run/agent.ts");
const { spentToday } = await import("../src/core/budget.ts");
const { emit } = await import("../src/core/events.ts");
const { readAudit } = await import("../src/core/audit.ts");
const { createMemoryServer } = await import("../src/modules/memory/memory-tools.ts");
const { convPaths, groupConvId } = await import("../src/core/convpaths.ts");

const on = settings as unknown as Record<string, unknown>;
on.tenants = true;
on.warm = false;
const KEY = "instance-key-for-the-group-sponsor-tests";
const OWNER_NUMBER = "+15555550114";
const owner = T.ensureOwner({ number: OWNER_NUMBER, aci: undefined });
void owner;

let n = 0;
const friend = (name: string, created: string) => T.addTenant({ aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name }, Date.parse(created))!;
const ann = friend("Ann", "2026-02-01T00:00:00.000Z");
const bea = friend("Bea", "2026-01-01T00:00:00.000Z"); // approved before Ann
const aciOf = (r: { acis: string[] }) => r.acis[0]!;
const OWNER_M = { number: OWNER_NUMBER };
const ANN_M = { uuid: aciOf(ann) };
const BEA_M = { uuid: aciOf(bea) };
const STRANGER = { number: "+15555550105" };

const T0 = 1_000_000_000;
const lookupOf = (id: string, members: { number?: string; uuid?: string }[], name = "A group") => async () => [{ id, name, members }];
const decide = (id: string, members: { number?: string; uuid?: string }[], at = T0) => sponsorInGroup(id, lookupOf(id, members), sponsorOfMember, at);
const MIN = 6 * 60_000; // past the member cache

test("sponsor: a group the owner is in is the owner's, as ever (nothing recorded for a friend, the login pays)", async () => {
  assert.equal(await decide("g-owner", [OWNER_M, STRANGER]), true);
  assert.equal(sponsorOf("g-owner"), "owner");
  const conv = group("g-owner");
  assert.equal(conv.sponsor, undefined);
  assert.deepEqual(mayRun(conv, "t", { chat: true }), { kind: "login", group: "g-owner" });
  assert.deepEqual([...capabilitiesOf(conv)].sort(), [...groupCapabilities()].sort());
  // the owner outranks a friend who is in the group too
  assert.equal(await decide("g-both", [ANN_M, OWNER_M]), true);
  assert.equal(sponsorOf("g-both"), "owner");
});

test("sponsor: a group only a friend is in is accepted, sponsored by her, and billed to her on the instance key", async () => {
  assert.equal(await decide("g-ann", [ANN_M, STRANGER]), true);
  assert.equal(sponsorOf("g-ann"), ann.id);
  const conv = group("g-ann");
  assert.equal(conv.sponsor, ann.id);
  const payer = mayRun(conv, "chat", { chat: true, key: () => KEY });
  assert.ok(!isRefusal(payer) && payer.kind === "instance" && payer.apiKey === KEY && payer.ledger === `friend-${ann.id}`, JSON.stringify(payer));
  // no key set: it does not run (never the owner's login in her place)
  assert.deepEqual(mayRun(conv, "chat", { chat: true, key: () => undefined }), { refused: "no-key" });
  // suspended: nothing runs
  T.setStatus(ann.id, "suspended");
  assert.deepEqual(mayRun(conv, "chat", { chat: true, key: () => KEY }), { refused: "inactive" });
  assert.equal(capabilitiesOf(conv).size, 0);
  T.setStatus(ann.id, "active");
  // a run of the group: the instance key in its environment, no owner login, and the cost lands in HER ledger, not the login's day
  const before = { login: spentToday(), hers: spentToday(`friend-${ann.id}`) };
  let env: Record<string, string | undefined> | undefined;
  const query = ((p: { options: { env?: Record<string, string | undefined> } }) => (
    (async function* () {
      env = p.options.env;
      yield { type: "result", subtype: "success", is_error: false, result: "[[silent]]", session_id: "s", total_cost_usd: 0.25 };
    })()
  )) as never;
  await runConversation(conv, { apiKey: KEY }, () => ({ prompt: "hello" }), undefined, { query });
  assert.equal(env?.ANTHROPIC_API_KEY, KEY);
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in (env ?? {})), "the owner's login is not in a friend's group's environment");
  assert.equal(spentToday(`friend-${ann.id}`) - before.hers, 0.25);
  assert.equal(spentToday() - before.login, 0, "the owner's day is untouched");
  // a group run without the key does not start
  assert.throws(() => runFor(conv, "message"), /needs the instance API key/);
  // a bare charge on its payer lands in her ledger too
  const p2 = mayRun(conv, "chat", { chat: true, key: () => KEY });
  if (isRefusal(p2)) throw new Error("refused");
  charge(p2, 0.5);
  assert.equal(spentToday(`friend-${ann.id}`) - before.hers, 0.75);
});

test("sponsor: a group nobody trusted is a stranger's, ignored, and nothing about it is kept", async () => {
  assert.equal(await decide("g-stranger", [STRANGER, { number: "+10000000001" }]), false);
  assert.equal(sponsorOf("g-stranger"), undefined);
  assert.ok(!existsSync(convPaths(groupConvId("g-stranger")).dir), "no folder for a group we do not vouch for");
});

test("sponsor: the sponsor is recorded and stays; when she leaves the group is ignored and no other member takes it over", async () => {
  assert.equal(await decide("g-stay", [ANN_M, BEA_M]), true);
  assert.equal(sponsorOf("g-stay"), bea.id, "the earliest-approved friend sponsors when several are in");
  assert.equal(group("g-stay").sponsor, bea.id);
  // later: Bea left, Ann and the owner are in; the group is not handed to them
  assert.equal(await decide("g-stay", [ANN_M, OWNER_M], T0 + MIN), false);
  assert.equal(sponsorOf("g-stay"), bea.id);
  // she comes back: answered again
  assert.equal(await decide("g-stay", [ANN_M, BEA_M], T0 + 2 * MIN), true);
  // the membership is looked up again only after the cache expires
  let calls = 0;
  const counting = async () => (calls++, [{ id: "g-stay", name: "x", members: [BEA_M] }]);
  await sponsorInGroup("g-stay", counting, sponsorOfMember, T0 + 2 * MIN + 1000);
  assert.equal(calls, 0);
  // the sponsor suspended: ignored while she is
  T.setStatus(bea.id, "suspended");
  assert.equal(await decide("g-stay", [ANN_M, BEA_M], T0 + 10 * MIN), false);
  T.setStatus(bea.id, "active");
});

test("sponsor: a friend's group has no more capabilities than she has, and none of the owner's", () => {
  const conv = group("g-ann");
  const caps = capabilitiesOf(conv);
  for (const c of ["mail", "calendar", "notion", "profile", "card", "admin", "drive", "login", "google", "intake"] as const) assert.ok(!caps.has(c), c);
  assert.ok(caps.has("chat"));
  assert.ok([...caps].every((c) => capabilitiesOf({ kind: "tenant", tenantId: ann.id }).has(c)), "a subset of hers");
});

test("sponsor: a friend who switched groups off (tenant.json groups: false), or is suspended, does not make a group ours", async () => {
  const dee = friend("Dee", "2026-03-01T00:00:00.000Z");
  const m = { uuid: aciOf(dee) };
  assert.ok(sponsorOfMember(m), "groups are on by default for an active friend");
  writeFileSync(T.tenantContext(dee).configFile, JSON.stringify({ groups: false }));
  assert.equal(sponsorOfMember(m), undefined);
  assert.equal(await decide("g-dee", [m, STRANGER]), false);
  assert.equal(sponsorOf("g-dee"), undefined);
  writeFileSync(T.tenantContext(dee).configFile, "{}");
  T.setStatus(dee.id, "suspended");
  assert.equal(sponsorOfMember(m), undefined);
});

test("privacy: a friend's group's audit rows carry no words, and the owner cannot list or search it", async () => {
  const conv = group("g-ann");
  emit({ type: "tool", tool: "mcp__send__send", decision: "allowed", source: "group", conv: conv.key, meta: { reason: "SECRET-WORDS-OF-THE-FRIEND" } });
  emit({ type: "tool", tool: "mcp__send__send", decision: "allowed", source: "group", conv: "g-owner", meta: { reason: "OWNER-GROUP-WORDS" } });
  const rows = readAudit((e) => e.tool === "mcp__send__send");
  const hers = rows.find((r) => r.meta && "reasonChars" in r.meta);
  assert.ok(hers, "wordless: the words became a count");
  assert.ok(!JSON.stringify(rows).includes("SECRET-WORDS-OF-THE-FRIEND"));
  assert.ok(JSON.stringify(rows).includes("OWNER-GROUP-WORDS"), "the owner's own groups are audited as before");
  // her words are in her group's folder, which the owner's listings and her search_logs do not reach
  recordGroup("g-ann", "member", 1, "Bea: friend-group-needle", undefined);
  assert.ok(listGroups().some((g) => g.id === "g-ann"));
  assert.ok(!listOwnerGroups().some((g) => g.id === "g-ann"), "not in the owner's group list");
  assert.ok(listOwnerGroups().some((g) => g.id === "g-owner"));
  const { NOTES_DIR } = await import("../src/memory/notes.ts");
  const server = createMemoryServer({ notesDir: NOTES_DIR, source: "chat", offers: () => true } as never) as unknown as { instance: { connect(t: unknown): Promise<void> } };
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await server.instance.connect(b);
  await client.connect(a);
  for (const file of ["A group", groupConvId("g-ann")]) {
    const r = JSON.stringify(await client.callTool({ name: "search_logs", arguments: { query: "friend-group-needle", file } }));
    assert.ok(!r.includes("friend-group-needle"), `owner search_logs file=${file}: ${r.slice(0, 120)}`);
  }
  await client.close();
});
