import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tenancy: the registry, routing of unknown senders, the gates of a tenant's turn, per-tenant cooldown and budget.
// Its own data folder (before anything reads the settings), because the registry is a file.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "tenants-test-"));

const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { capabilitiesOfRecord, resolveCapabilities, toolsFor: toolsForCaps } = await import("../src/policy/capabilities.ts");
const tenantCapabilities = (ctx: { config: any }) => resolveCapabilities(T.FRIEND_CAPABILITIES, { own: ctx.config }); // (a context not in the registry: the pure step of capabilitiesOf)
const tenantTools = (ctx: { config: any }) => toolsForCaps(tenantCapabilities(ctx));
const R = await import("../src/tenants/tenantroute.ts");
const { reportKeyProblem } = await import("../src/tenants/keynotice.ts");
const { ownerNotices } = await import("../src/heartbeat/notices.ts");
const { refusal } = await import("../src/tenants/errors.ts");
const { createTenantRunner } = await import("../src/conversation/tenantrun.ts");
const { ownerFacts, resetOwnerFacts } = await import("./ownerfacts.ts");
const { coolingDown, cooldownUntil, noteRateLimit, resetCooldown } = await import("../src/core/cooldown.ts");
const { failure, InstanceKeyError, RateLimitError } = await import("../src/tenants/errors.ts");
const { INSTANCE_KEY_COOLDOWN } = await import("../src/tenants/payer.ts");
const PAYER = (id: string) => ({ kind: "instance" as const, id, apiKey: "instance-key-not-real", ledger: "unused.json" }); // (who a call is for: its failure feeds the key's cooldown)
const { recordCost, spentToday, tenantOverBudget } = await import("../src/core/budget.ts");
const { tenant } = await import("../src/conversation/conversationmodel.ts");
const { looksLikeApiKey } = await import("../src/secrets/secrets.ts");
const { describeTenants } = await import("../src/tenants/tenanttools.ts");
const { NOTES_DIR } = await import("../src/memory/notes.ts");
const { convPaths, conversationsDir, friendConvId, instancePaths, OWNER_CONV } = await import("../src/core/convpaths.ts");
const { FILE: OWNER_LOG } = await import("../src/core/messages.ts");
const { acceptOwner } = await import("../src/conversation/guards.ts");

const on = settings as unknown as { tenants: boolean };
const ACI_A = "11111111-1111-4111-8111-111111111111";
const ACI_C = "33333333-3333-4333-8333-333333333333";
const KEY_A = "sk-" + "ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";

beforeEach(() => {
  on.tenants = true;
  resetCooldown();
});

let n = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
// A new tenant by the real path (the owner said yes: registration.ts).
function join_(name = "Anna", aci = fresh()): import("../src/tenants/tenants.ts").TenantRecord {
  const rec = T.addTenant({ aci, name });
  assert.ok(rec);
  return rec;
}

test("config: a tenant.json is checked, never trusted; the old lower-case timezone and connectors settings are unknown now", () => {
  const ok = T.parseTenantConfig({ language: "German", persona: "short and dry", dailyBudgetUsd: 3, maxTurns: 6, browse: false, timeZone: "Europe/Lisbon" });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.config.dailyBudgetUsd, 3);
  assert.equal(ok.config.timeZone, "Europe/Lisbon");
  assert.deepEqual(T.parseTenantConfig({ timeZone: "Mars/Olympus" }), { config: {}, problems: ["timeZone must be a time zone like Europe/Lisbon"] });
  const bad = T.parseTenantConfig({ dailyBudgetUsd: -1, maxTurns: "many", browse: "yes", timezone: "Europe/Berlin", color: "red", connectors: ["gmail"] });
  assert.deepEqual(bad.config, {});
  assert.equal(bad.problems.length, 6); // three bad values, three unknown names (timezone and connectors were dead and are gone)
  assert.deepEqual(T.parseTenantConfig(undefined), { config: {}, problems: [] });
  assert.equal(T.parseTenantConfig([]).problems.length, 1);
});

test("an approved friend is provisioned as the tenant: owner-only folders, notes, a tenant.json, a member and no key anywhere", () => {
  const rec = join_("Anna");
  const ctx = T.tenantContext(rec);
  for (const d of [ctx.dir, ctx.notesDir, ctx.backupDir]) assert.equal(statSync(d).mode & 0o077, 0, d);
  assert.ok(existsSync(ctx.configFile));
  assert.equal(rec.role, "member");
  assert.ok(!("capabilities" in rec), "her capabilities are derived (capabilities.ts), never stored");
  assert.equal(rec.credential, "instance-key");
  assert.ok(!readFileSync(T.REGISTRY, "utf8").match(/sk-ant|"key"/));
  assert.equal(T.tenantByAci(rec.acis[0]!.toUpperCase())?.id, rec.id, "the account id is matched without regard to case");
  assert.equal(ctx.target, `to:${rec.acis[0]}`);
  assert.equal(ctx.dir, convPaths(friendConvId(rec.id)).dir);
  assert.ok(ctx.dir.startsWith(conversationsDir()) && !ctx.dir.startsWith(convPaths(OWNER_CONV).dir) && !ctx.dir.startsWith(settings.logsDir) && !ctx.dir.startsWith(instancePaths().dir));
  assert.equal(tenant(rec.id).direct, true);
});

test("a hand-edited registry cannot make a bad id, or an unknown role load; an old record gets the safe defaults", () => {
  const rec = join_("Bo");
  const file = T.REGISTRY;
  const reg = JSON.parse(readFileSync(file, "utf8"));
  reg.tenants.push(
    { id: "../escape", name: "x", acis: [ACI_C], status: "active", created: "now" },
    { id: "owner", name: "x", acis: [ACI_C], status: "active", created: "now" },
    { id: "odd-role", name: "x", acis: [], role: "root", status: "active", created: "now" },
    { id: "odd-cap", name: "x", acis: [], capabilities: ["chat", "everything"], status: "active", created: "now" },
    { id: "old-one", name: "Old", acis: [], status: "active", created: "now", keyRef: "tenants/owner/profile/email" },
  );
  writeFileSync(file, JSON.stringify(reg));
  assert.equal(T.tenantByAci(ACI_C), undefined, "an invalid id never loads, and 'owner' is never a tenant");
  assert.ok(!T.people().some((r) => ["../escape", "odd-role"].includes(r.id)));
  assert.ok(T.tenantById("odd-cap") && !("capabilities" in T.tenantById("odd-cap")!), "a stored capability list is ignored, whatever it holds");
  const old = T.tenantById("old-one")!;
  assert.deepEqual([old.role, old.credential], ["member", "instance-key"], "omitted fields never make an admin");
  assert.ok(!("keyRef" in old));
  assert.ok(T.tenantById(rec.id));
  writeFileSync(file, JSON.stringify({ tenants: reg.tenants.filter((t: { id: string }) => t.id !== "owner" && !t.id.startsWith("odd") && t.id !== "old-one" && t.id !== "../escape") }));
});

test("routing: with TENANTS off nothing is answered, as today", () => {
  on.tenants = false;
  assert.deepEqual(R.routeSender({ aci: ACI_C, text: "hello" }), { kind: "ignore", why: "tenants are off" });
  assert.deepEqual(R.routeSender({ aci: ACI_A, text: "hello" }).kind, "ignore", "not even a known tenant");
});

// ---- a tenant's turn ----

function runner(over: { key?: string | undefined; ask?: (key: string) => Promise<{ text: string; costUsd: number }>; now?: () => number } = {}) {
  const asked: { id: string; key: string; prompt: string }[] = [];
  const alerts = ownerFacts();
  resetOwnerFacts();
  const r = createTenantRunner({
    apiKey: () => over.key,
    ask: (async (ctx: { id: string }, key: string, prompt: string) => (asked.push({ id: ctx.id, key, prompt }), (over.ask ?? (async () => ({ text: "hello there", costUsd: 0.01 })))(key))) as never,
    now: over.now,
  });
  return { r, asked, alerts };
}

test("turn: no instance key means a plain 'not set up for friends', a notice for the admin, no model call and never the owner's login", async () => {
  const rec = join_("Eve");
  const { r, asked, alerts } = runner({ key: undefined });
  const first = await r.run(tenant(rec.id), "hello");
  assert.equal(first.text, refusal("no-key", "friend"));
  assert.deepEqual(asked, []);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /TENANT_ANTHROPIC_API_KEY is not set/);
  const second = await r.run(tenant(rec.id), "hello?");
  assert.equal(second.text, "[[silent]]", "the notice is not repeated every message");
  assert.equal(alerts.length, 1, "nor the admin's");
  assert.deepEqual(asked, []);
});

test("turn: a refused instance key tells the owner's chat once, not once per tenant, in words that hold nothing of the friends", async () => {
  const [a, b] = [join_("Gus"), join_("Ivy")];
  // The failure is made where every run on the key makes it (errors.ts failure), which is what reports it: the same for a chat turn and for any unattended run.
  const { r, alerts } = runner({ key: KEY_A, ask: async () => Promise.reject(failure("authentication_failed", "error_during_execution", PAYER("gus"))) });
  await assert.rejects(r.run(tenant(a.id), "hi"), InstanceKeyError); // her own run still fails as it did (her notice is the error path's)
  assert.match((await r.run(tenant(b.id), "hi")).text, /paused/, "another friend, the same key: it is cooling down for everybody, no second call is made"); // (a fixed notice)
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /The shared API key was refused .*check TENANT_ANTHROPIC_API_KEY/);
  assert.ok(!alerts[0]!.includes(KEY_A), "never the key");
  assert.ok(!/Gus|Ivy/.test(alerts[0]!), "no word and no name of a friend");
  resetCooldown();
  const quiet = runner({ key: KEY_A, ask: async () => Promise.reject(new Error("a plain failure")) });
  await assert.rejects(quiet.r.run(tenant(a.id), "hi"), /plain failure/);
  assert.deepEqual(quiet.alerts, [], "only a refused key is the owner's business");
  resetCooldown();
  const busy = runner({ key: KEY_A, ask: async () => Promise.reject(failure("overloaded", "error_during_execution", PAYER("gus"))) });
  await assert.rejects(busy.r.run(tenant(a.id), "hi"), InstanceKeyError);
  assert.deepEqual(busy.alerts, [], "an overloaded API is not the key's fault");
});

test("key notice: a refused or missing shared key is a fact for the owner's next run, once per problem per interval, and never a fixed chat line", () => {
  resetOwnerFacts();
  const chat: string[] = [];
  ownerNotices.sendTo((t) => void chat.push(t)); // (the one fixed-text channel to the owner: the daily budget only)
  const facts = ownerFacts();
  const every = 3 * 3600_000; // the key notice interval, three hours
  assert.equal(reportKeyProblem("refused", 1000), true);
  assert.equal(reportKeyProblem("refused", 1000 + 2 * 3600_000), false, "within the interval");
  assert.equal(reportKeyProblem("missing", 1000 + 2 * 3600_000), true, "another problem is another notice");
  assert.equal(reportKeyProblem("refused", 1000 + every), true, "and again after the interval");
  assert.equal(facts.length, 2, "the same fact still waiting is held once");
  assert.match(facts[0]!, /^System status for .*in your own words/);
  assert.deepEqual(chat, [], "the chat never gets a code-written line about it");
  ownerNotices.sendTo(undefined);
  assert.doesNotThrow(() => reportKeyProblem("missing", 1000 + 9 * 3600_000));
});

test("key notice: a failure on the key from an unattended run, a mail loop or the dream reaches the same notice as a chat turn (they all end in failure())", () => {
  const alerts = ownerFacts();
  resetOwnerFacts();
  for (const source of ["gus", "ivy", "gus"]) {
    const e = failure("billing_error", "error_during_execution", PAYER(source));
    assert.ok(e instanceof InstanceKeyError && e.why === "billing");
  }
  assert.equal(alerts.length, 1, "three runs of two friends, one notice");
  assert.equal(failure("rate_limit", "error", undefined) instanceof RateLimitError, true, "the owner's own limit is not the friends' key");
  assert.equal(alerts.length, 1);
});

test("turn: the run gets the instance key, and her first reply is her model reply, unchanged (the greeting is the model's: persona.ts FIRST_CONTACT)", async () => {
  const rec = join_("Finn");
  const { r, asked } = runner({ key: KEY_A });
  const one = await r.run(tenant(rec.id), "hi");
  const two = await r.run(tenant(rec.id), "and again");
  assert.deepEqual(asked.map((a) => a.key), [KEY_A, KEY_A]);
  assert.equal(one.text, "hello there");
  assert.ok(T.wasDisclosed(T.tenantContext(rec)), "marked once she has had her first reply");
  assert.equal(two.text, "hello there");
});

test("turn: a suspended tenant (even mid-flight) gets nothing and costs nothing", async () => {
  const rec = join_("Hal");
  const conv = tenant(rec.id);
  T.setStatus(rec.id, "suspended");
  const { r, asked } = runner({ key: KEY_A });
  assert.equal((await r.run(conv, "hi")).text, "[[silent]]");
  assert.deepEqual(asked, []);
});

test("cooldown: a limit, 400 or 429 on the shared key pauses every friend (it is the key's), never the owner's login", async () => {
  const a = join_("Ann");
  const b = join_("Bea");
  const now = Date.now();
  assert.ok(failure("rate_limit", "error", PAYER(a.id)) instanceof InstanceKeyError);
  assert.ok(failure("invalid_request", "error", PAYER(b.id)) instanceof InstanceKeyError); // HTTP 400 on the key
  assert.equal(coolingDown(now + 1000, INSTANCE_KEY_COOLDOWN), true);
  assert.equal(coolingDown(now + 1000), false, "the owner's own cooldown (background jobs, the owner) is untouched");
  assert.ok(failure("rate_limit", "error") instanceof RateLimitError, "without a friend it is the old behaviour");
  assert.equal(coolingDown(now + 1000), true);
  resetCooldown();
  noteRateLimit(now, INSTANCE_KEY_COOLDOWN);
  const { r, asked } = runner({ key: KEY_A });
  assert.match((await r.run(tenant(a.id), "hi")).text, /paused/);
  assert.match((await r.run(tenant(b.id), "hi")).text, /paused/);
  assert.deepEqual(asked, [], "no call is made while the key is cooling down");
  assert.ok(cooldownUntil(INSTANCE_KEY_COOLDOWN) !== undefined);
  assert.equal(cooldownUntil(""), undefined);
  assert.equal(failure("authentication_failed", "e", PAYER(a.id)) instanceof InstanceKeyError, true, "a refused key is the instance's to fix, not a login error");
  assert.equal(failure("server_error", "e", PAYER(a.id)) instanceof InstanceKeyError, false);
});

test("budget: her day is her own ledger against her own limit; the instance's ledger is not touched either way", async () => {
  const rec = join_("Cy");
  const ctx = T.tenantContext(rec);
  const owner0 = spentToday();
  recordCost(0.5, ctx.ledger);
  assert.equal(spentToday(ctx.ledger), 0.5);
  assert.equal(spentToday(), owner0);
  assert.equal(tenantOverBudget(ctx.ledger, ctx.dailyBudgetUsd), false);
  recordCost(ctx.dailyBudgetUsd, ctx.ledger);
  assert.equal(tenantOverBudget(ctx.ledger, ctx.dailyBudgetUsd), true);
  const { r, asked } = runner({ key: KEY_A });
  const out = await r.run(tenant(rec.id), "hi");
  assert.match(out.text, /daily limit/);
  assert.deepEqual(asked, []);
  writeFileSync(ctx.configFile, JSON.stringify({ dailyBudgetUsd: 1000 }));
  assert.equal(T.tenantContext(rec).dailyBudgetUsd, 1000, "her tenant.json can raise or lower it");
});

test("delete: her folder and her registry entry go; the others, the owner's record included, stay", () => {
  const gone = join_("Dee");
  const stay = join_("Eli");
  const ctx = T.tenantContext(gone);
  writeFileSync(join(ctx.notesDir, "people-x.md"), "x");
  T.ensureOwner({ number: "+15555550114" });
  const calls: string[] = [];
  assert.equal(T.deleteTenant(gone.id, { drop: (id) => void calls.push(`drop:${id}`) }), true);
  assert.deepEqual(calls, [`drop:${gone.id}`]);
  assert.ok(T.people().some((r) => r.id === "owner"));
  assert.equal(T.deleteTenant("owner"), false, "the owner is not a tenant: she cannot be deleted");
  assert.equal(existsSync(ctx.dir), false);
  assert.equal(T.tenantById(gone.id), undefined);
  assert.ok(T.tenantById(stay.id) && existsSync(T.tenantContext(stay).dir));
  assert.equal(T.deleteTenant(gone.id), false);
});

test("doctor: shows the instance key (set or not, never its value) and each tenant with status, budget and a pause; says nothing when TENANTS is off", async () => {
  const { tenantCheck } = await import("../src/doctor.ts");
  const lines: string[] = [];
  const line = (ok: boolean | "warn", what: string, detail = "") => void lines.push(`${ok === true ? "ok" : ok === "warn" ? "warn" : "FAIL"} ${what} ${detail}`);
  tenantCheck(line, { on: false });
  assert.deepEqual(lines, ["ok tenants: off TENANTS=off: one person, as always"]);
  lines.length = 0;
  const rec = join_("Doc");
  const ctx = T.tenantContext(rec);
  recordCost(0.25, ctx.ledger);
  T.setPaused(ctx, Date.now() + 3600_000);
  assert.ok(looksLikeApiKey(KEY_A) && !looksLikeApiKey("sk-ant-short") && !looksLikeApiKey("hello"));
  tenantCheck(line, { on: true, key: KEY_A });
  const mine = lines.find((l) => l.includes(`tenant ${rec.id}`))!;
  assert.match(mine, /^warn /);
  assert.match(mine, /active; capabilities [^;]+; today \$0\.25 of \$2; paused until [\d-]+ \d\d:\d\d/);
  assert.ok(!mine.includes(KEY_A));
  assert.match(lines.find((l) => l.includes("tenant API key"))!, /^ok tenant API key .*separate Console workspace key with a spend limit/);
  assert.ok(!lines.join("\n").includes(KEY_A));
  assert.ok(lines.some((l) => /^ok tenants \d+ \(/.test(l)));
  T.setPaused(ctx, undefined);
  assert.equal(T.pausedUntil(ctx), undefined);
  lines.length = 0;
  tenantCheck(line, { on: true, key: undefined });
  assert.match(lines.find((l) => l.includes("tenant API key"))!, /^warn tenant API key TENANT_ANTHROPIC_API_KEY is not set: friends are told the assistant is not set up/);
});

// ---- one record per person: the owner, the guard, the admin role, capabilities ----

const OWNER_NUMBER = "+15555550114";
const OWNER_ACI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("registry: the owner is seeded from the number as an admin with every capability, pointing at the files the instance has always used", () => {
  const rec = T.ensureOwner({ number: OWNER_NUMBER });
  assert.deepEqual([rec.id, rec.role, rec.status, rec.credential, rec.number, rec.acis], ["owner", "admin", "active", "login", OWNER_NUMBER, []]);
  assert.ok(!("capabilities" in rec), "the owner has every capability by being the owner (capabilities.ts), not by a stored list");
  assert.deepEqual([...capabilitiesOfRecord(rec)].filter((c) => c !== "intake").sort(), T.CAPABILITIES.filter((c) => c !== "intake").sort());
  const paths = T.pathsOf(rec);
  assert.deepEqual(paths, { root: settings.dataDir, notesDir: NOTES_DIR, logFile: OWNER_LOG, ledger: OWNER_CONV }, "the owner's own folder");
  assert.equal(T.ensureOwner({ number: "+15555550105", aci: ACI_A }).number, OWNER_NUMBER, "seeding twice changes nothing");
  assert.equal(T.people().filter((r) => r.id === "owner").length, 1);
  assert.ok(!T.listTenants().some((r) => r.id === "owner"), "the owner is not a tenant: invites, suspension and removal never reach her");
  assert.equal(T.setStatus("owner", "suspended"), undefined);
  const friend = join_("Fred");
  assert.equal(T.people().find((r) => r.id === "owner")!.role, "admin", "a new tenant changes nobody's role");
  assert.deepEqual([friend.role, T.pathsOf(friend).root.startsWith(conversationsDir())], ["member", true]);
});

test("guard: the owner is whoever resolves to the admin record: by number first, by account id once it is learned; a tenant never is", () => {
  const friend = join_("Gil");
  const accept = (m: { from: string; fromUuid?: string; direct?: boolean }) => acceptOwner({ direct: true, ...m }, T.resolveSender);
  assert.equal(accept({ from: OWNER_NUMBER }), true);
  assert.equal(accept({ from: OWNER_NUMBER, direct: false }), false);
  assert.equal(accept({ from: "+15555550105" }), false);
  assert.equal(accept({ from: "", fromUuid: friend.acis[0] }), false, "a tenant is a member");
  assert.equal(accept({ from: "", fromUuid: ACI_C }), false, "unknown");
  assert.equal(accept({ from: "", fromUuid: OWNER_ACI }), false, "her account id is not known yet");
  assert.equal(T.resolveSender({ aci: friend.acis[0]!.toUpperCase() })?.id, friend.id);
});

test("ACI learning: the first message from the owner's number carries her account id; the pair is recorded once, logged, and later matched by the id", () => {
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    assert.equal(T.learnOwnerAci({ number: "+15555550105", aci: OWNER_ACI }), false, "not her number");
    assert.equal(T.learnOwnerAci({ number: OWNER_NUMBER }), false, "no account id in the envelope: stays on the number");
    assert.equal(T.learnOwnerAci({ number: OWNER_NUMBER, aci: "not-an-aci" }), false);
    assert.equal(T.learnOwnerAci({ number: OWNER_NUMBER, aci: T.listTenants()[0]!.acis[0] }), false, "an id that is a tenant's is never the owner's");
    assert.equal(T.learnOwnerAci({ number: OWNER_NUMBER, aci: OWNER_ACI }), true);
    assert.equal(T.learnOwnerAci({ number: OWNER_NUMBER, aci: ACI_C }), false, "learned once, never replaced by a message");
  } finally {
    console.log = log;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /account id \(aaaaaaaa\.\.\.\) was learned/);
  assert.ok(!logged[0]!.includes(OWNER_ACI), "not the whole id, not the number");
  assert.ok(!logged[0]!.includes(OWNER_NUMBER));
  assert.deepEqual(T.people().find((r) => r.id === "owner")!.acis, [OWNER_ACI]);
  assert.equal(acceptOwner({ from: "", fromUuid: OWNER_ACI, direct: true }, T.resolveSender), true, "the number may now be hidden");
  assert.equal(acceptOwner({ from: OWNER_NUMBER, direct: true }, T.resolveSender), true, "and the number still works when the envelope has no id");
  assert.equal(T.tenantByAci(OWNER_ACI), undefined, "a tenant lookup never finds the owner");
});

test("envelope: the owner's own messages carry her account id (Note to Self and own-account mode), so there is something to learn", async () => {
  const { interpretEnvelope } = await import("@ted-assistant/signal");
  const self = interpretEnvelope({ sourceNumber: OWNER_NUMBER, sourceUuid: OWNER_ACI, syncMessage: { sentMessage: { destinationNumber: OWNER_NUMBER, message: "hi", timestamp: 5 } } }, { account: OWNER_NUMBER });
  assert.equal(self.message?.direct, true);
  assert.equal(self.message?.fromUuid, OWNER_ACI);
  const peer = interpretEnvelope({ sourceNumber: OWNER_NUMBER, sourceUuid: OWNER_ACI, dataMessage: { message: "hi", timestamp: 6 } }, { account: "+15555550105", peer: OWNER_NUMBER });
  assert.deepEqual([peer.message?.direct, peer.message?.from, peer.message?.fromUuid], [true, OWNER_NUMBER, OWNER_ACI]);
  const none = interpretEnvelope({ sourceNumber: OWNER_NUMBER, dataMessage: { message: "hi", timestamp: 7 } }, { account: "+15555550105", peer: OWNER_NUMBER });
  assert.equal("fromUuid" in none.message!, false, "no id in the envelope: nothing is invented");
});

test("set-admin: the role moves to one record and only the local CLI does it; no tool, chat path or other module can", async () => {
  const friend = join_("Hana");
  const rec = T.setAdmin(friend.id)!;
  assert.equal(rec.role, "admin");
  assert.deepEqual(T.people().filter((r) => r.role === "admin").map((r) => r.id), [friend.id], "exactly one admin: the previous one is a member now");
  assert.equal(acceptOwner({ from: OWNER_NUMBER, direct: true }, T.resolveSender), false, "the former admin is no longer one");
  assert.equal(T.setAdmin("owner")!.role, "admin", "lock-out recovery: the CLI puts the role back");
  assert.equal(T.people().find((r) => r.id === friend.id)!.role, "member");
  assert.equal(T.setAdmin("nobody"), undefined);
  assert.equal(acceptOwner({ from: OWNER_NUMBER, direct: true }, T.resolveSender), true);

  // Nothing but scripts/tenants.ts (and tenants.ts itself) may import the functions that change a role or a capability: so no tool, no hook and no
  // module the model can reach is able to call them. (A tool that existed would have to import one of these names.)
  const { readdirSync } = await import("node:fs");
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  const importing = files(new URL("../src", import.meta.url).pathname).filter((f) => !f.endsWith("/tenants.ts")).filter((f) => {
    const imports = [...readFileSync(f, "utf8").matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(?:\.\.?\/)+(?:tenants\/)?tenants\.ts"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim().split(/\s+as\s+/)[0]!));
    return imports.some((x) => ["setAdmin"].includes(x));
  });
  assert.deepEqual(importing, [], "no module under src/ can change the admin role");
  assert.match(readFileSync(new URL("../scripts/tenants.ts", import.meta.url), "utf8"), /set-admin/, "the CLI is where it lives");
});

test("the CLI has no grant or revoke: nothing about a friend's tools is stored, and to stop a friend the admin suspends or removes her", () => {
  const cli = readFileSync(new URL("../scripts/tenants.ts", import.meta.url), "utf8");
  assert.ok(!/\bgrant\b|\brevoke\b/.test(cli));
  assert.equal((T as Record<string, unknown>).grant, undefined);
  assert.equal((T as Record<string, unknown>).revoke, undefined);
  assert.equal((T as Record<string, unknown>).FRIEND_DEFAULTS, undefined);
  const rec = join_("Ida");
  assert.ok(tenantTools(T.tenantContext(rec)).has("mcp__voice__voice"));
  writeFileSync(T.tenantContext(rec).configFile, JSON.stringify({ voice: false }));
  assert.ok(!tenantTools(T.tenantContext(T.tenantById(rec.id)!)).has("mcp__voice__voice"), "her own switch in tenant.json still takes a tool away");
  const lines = describeTenants().filter((l) => l.startsWith(rec.id));
  assert.match(lines[0]!, /capabilities chat, browse, heartbeat, dream, wake, notes, weather, draw, tasks;/, "the effective set: voice is off by her own switch, and Google, Notion and the setup page are not set up on this instance");
  assert.doesNotMatch(lines[0]!, /\b(admin|profile|card|drive)\b/, "the owner's own are not hers");
  assert.match(describeTenants()[0]!, /^owner \(.*\): admin; capabilities .*admin/);
});

test("the per-tenant key plumbing is gone: no set-key, forget-key, KeyStore, intake or setup-incomplete state", () => {
  const cli = readFileSync(new URL("../scripts/tenants.ts", import.meta.url), "utf8");
  assert.ok(!/set-key|forget-key|tenantKeys|localIntake/.test(cli));
  assert.equal(existsSync(new URL("../src/intake.ts", import.meta.url)), false);
  assert.equal((R as Record<string, unknown>).setupIncompleteReply, undefined);
  assert.ok(!/anthropic_api_key|keyRef/.test(readFileSync(new URL("../src/tenants/tenants.ts", import.meta.url), "utf8")));
});

test("registry cache: read again only when the file changed (stat), at once after this process's own write, and a change by another process is seen", () => {
  const rec = join_("Cache");
  const path = T.REGISTRY;
  assert.equal(T.tenantById(rec.id)!.name, "Cache");
  // unchanged file: the cached parse serves, whatever is asked
  const reads = T.registryReads();
  for (let i = 0; i < 5; i++) (T.tenantById(rec.id), T.tenantByAci(rec.acis[0]), T.listTenants());
  assert.equal(T.registryReads(), reads, "no read of an unchanged file");
  // this process's own write is seen at once
  T.setStatus(rec.id, "suspended");
  assert.equal(T.tenantById(rec.id)!.status, "suspended");
  // another process (the CLI) replaces the file: a rename, a new inode
  const other = JSON.parse(readFileSync(path, "utf8"));
  other.tenants.find((t: any) => t.id === rec.id).status = "active";
  writeFileSync(`${path}.other`, JSON.stringify(other));
  renameSync(`${path}.other`, path);
  assert.equal(T.tenantById(rec.id)!.status, "active");
  // the records are new objects each time: a caller changing one does not change the next answer
  T.tenantById(rec.id)!.acis.push("x");
  assert.ok(!T.tenantById(rec.id)!.acis.includes("x"));
});
