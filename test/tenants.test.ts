import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tenancy: the registry, invitations, routing of unknown senders, the gates of a tenant's turn, per-tenant cooldown and budget.
// Its own data folder (before anything reads the settings), because the registry is a file.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "tenants-test-"));

const { settings } = await import("../src/settings.ts");
const T = await import("../src/tenants.ts");
const R = await import("../src/tenantroute.ts");
const { createTenantRunner } = await import("../src/tenantrun.ts");
const { coolingDown, cooldownUntil, noteRateLimit, resetCooldown } = await import("../src/cooldown.ts");
const { failure, TenantKeyError, RateLimitError } = await import("../src/errors.ts");
const { recordCost, spentToday, tenantOverBudget } = await import("../src/budget.ts");
const { tenant } = await import("../src/conversationmodel.ts");
const { OneTimeCodes, CODE_PATTERN } = await import("../src/onetime.ts");
const { looksLikeApiKey } = await import("../src/secrets.ts");
const { describeTenants } = await import("../src/tenanttools.ts");
const { NOTES_DIR } = await import("../src/notes.ts");
const { FILE: OWNER_LOG } = await import("../src/messages.ts");
const { OWNER_SESSION_FILE } = await import("../src/session.ts");
const { acceptOwner } = await import("../src/guards.ts");

const on = settings as unknown as { tenants: boolean; tenantNoticeMinutes: number };
const ACI_A = "11111111-1111-4111-8111-111111111111";
const ACI_B = "22222222-2222-4222-8222-222222222222";
const ACI_C = "33333333-3333-4333-8333-333333333333";
const KEY_A = "sk-" + "ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";

beforeEach(() => {
  on.tenants = true;
  R.forgetRouting();
  resetCooldown();
});

let n = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
// A new tenant by the real path: an invite code, redeemed.
function join_(name = "Anna", aci = fresh()): import("../src/tenants.ts").TenantRecord {
  const made = T.mintInvite("test")!;
  const rec = T.redeemInvite(made.code, { aci, name });
  assert.ok(rec);
  return rec;
}

test("config: a tenant.json is checked, never trusted; connectors are only an extension point", () => {
  const ok = T.parseTenantConfig({ language: "German", persona: "short and dry", dailyBudgetUsd: 3, maxTurns: 6, browse: false, timezone: "Europe/Berlin" });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.config.dailyBudgetUsd, 3);
  const bad = T.parseTenantConfig({ dailyBudgetUsd: -1, maxTurns: "many", browse: "yes", timezone: "Mars/Base", color: "red", connectors: ["gmail"] });
  assert.deepEqual(bad.config, {});
  assert.equal(bad.problems.length, 6);
  assert.deepEqual(T.parseTenantConfig(undefined), { config: {}, problems: [] });
  assert.equal(T.parseTenantConfig([]).problems.length, 1);
  assert.deepEqual([...T.connectorTools({ config: { connectors: ["gmail"] } })], []); // nothing is granted by listing it
});

test("invites: single use, expire, hashed at rest, forgiving about case and dashes", () => {
  const made = T.mintInvite("for Anna", 1_000_000)!;
  assert.match(made.code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.ok(!readFileSync(join(settings.dataDir, T.INVITES), "utf8").includes(made.code), "only the hash is stored");
  assert.equal(T.redeemInvite(made.code.toLowerCase().replaceAll("-", " "), { aci: "not-an-aci" }, 1_000_001), undefined);
  const first = T.redeemInvite(made.code.toLowerCase().replaceAll("-", ""), { aci: ACI_A, name: "Anna" }, 1_000_001);
  assert.ok(first);
  assert.equal(first.status, "invited");
  assert.equal(T.redeemInvite(made.code, { aci: ACI_B }, 1_000_002), undefined, "used up");
  const late = T.mintInvite(undefined, 5_000_000)!;
  assert.equal(T.redeemInvite(late.code, { aci: ACI_B }, 5_000_000 + settings.inviteTtlHours * 3600_000 + 1), undefined, "expired");
  const live = T.mintInvite(undefined, 5_000_000)!;
  assert.equal(T.redeemInvite(live.code, { aci: ACI_A }, 5_000_001), undefined, "someone who already is a tenant cannot join twice");
  assert.ok(T.redeemInvite(live.code, { aci: ACI_B, name: "Bo" }, 5_000_002), "and the code was not spent by that");
});

test("invites: a code carried in a sentence is found, and the code space is bounded", () => {
  assert.equal(CODE_PATTERN.exec("hi! my code is abcd-2345-wxyz, thanks")?.[0], "abcd-2345-wxyz");
  assert.equal(CODE_PATTERN.exec("just a normal sentence about 2025-10-17"), null);
  const codes = new OneTimeCodes<number>("state/test-codes.json");
  for (let i = 0; i < 200; i++) assert.ok(codes.mint(i, 60_000));
  assert.equal(codes.mint(201, 60_000), undefined, "at most 200 open at once");
});

test("a redeemed invite provisions the tenant: owner-only folders, notes, a tenant.json, a member with the friend capabilities and no key anywhere", () => {
  const rec = join_("Anna");
  const ctx = T.tenantContext(rec);
  for (const d of [ctx.dir, ctx.notesDir, ctx.backupDir]) assert.equal(statSync(d).mode & 0o077, 0, d);
  assert.ok(existsSync(ctx.configFile));
  assert.equal(rec.role, "member");
  assert.deepEqual(rec.capabilities, ["chat", "browse", "voice", "heartbeat", "dream"], "every other capability is off for a new tenant");
  assert.equal(rec.credential, "instance-key");
  assert.ok(!readFileSync(join(settings.dataDir, T.REGISTRY), "utf8").match(/sk-ant|"key"/));
  assert.equal(T.tenantByAci(rec.acis[0]!.toUpperCase())?.id, rec.id, "the account id is matched without regard to case");
  assert.equal(ctx.target, `to:${rec.acis[0]}`);
  assert.ok(ctx.dir.startsWith(settings.tenantsDir) && !ctx.dir.startsWith(settings.memoryDir) && !ctx.dir.startsWith(settings.logsDir) && !ctx.dir.startsWith(settings.stateDir));
  assert.equal(tenant(rec.id).direct, true);
});

test("a hand-edited registry cannot make a bad id, an unknown capability or an unknown role load; an old record gets the safe defaults", () => {
  const rec = join_("Bo");
  const file = join(settings.dataDir, T.REGISTRY);
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
  assert.ok(!T.people().some((r) => ["../escape", "odd-role", "odd-cap"].includes(r.id)));
  const old = T.tenantById("old-one")!;
  assert.deepEqual([old.role, old.credential, old.capabilities], ["member", "instance-key", [...T.FRIEND_DEFAULTS]], "omitted fields never make an admin");
  assert.ok(!("keyRef" in old));
  assert.ok(T.tenantById(rec.id));
  writeFileSync(file, JSON.stringify({ tenants: reg.tenants.filter((t: { id: string }) => t.id !== "owner" && !t.id.startsWith("odd") && t.id !== "old-one" && t.id !== "../escape") }));
});

test("routing: with TENANTS off nothing is answered, as today", () => {
  on.tenants = false;
  assert.deepEqual(R.routeSender({ aci: ACI_C, text: "hello" }), { kind: "ignore", why: "tenants are off" });
  assert.deepEqual(R.routeSender({ aci: ACI_A, text: "hello" }).kind, "ignore", "not even a known tenant");
});

test("routing: an unknown sender gets the fixed invitation, with no model call, and not twice in a row", () => {
  const delivered: string[] = [];
  const said: { to: string; text: string }[] = [];
  const io = { reply: async (to: string, text: string) => void said.push({ to, text }), deliver: (t: { id: string }) => void delivered.push(t.id) };
  const a = R.admitStranger({ fromUuid: ACI_C, name: "Stranger", text: "hello, can you help me?" }, io, 1_000);
  assert.equal(a.kind, "reply");
  assert.deepEqual(said, [{ to: `to:${ACI_C}`, text: R.invitationReply() }]);
  assert.deepEqual(delivered, []);
  const again = R.admitStranger({ fromUuid: ACI_C, text: "hello?" }, io, 2_000);
  assert.deepEqual(again, { kind: "ignore", why: "already answered" });
  assert.equal(said.length, 1);
  R.admitStranger({ fromUuid: ACI_C, text: "still there?" }, io, 1_000 + on.tenantNoticeMinutes * 60_000 + 1);
  assert.equal(said.length, 2, "the next one only after the notice interval");
  assert.deepEqual(R.admitStranger({ text: "no account id" }, io, 9_000_000), { kind: "ignore", why: "no account id" });
  assert.equal(said.length, 2);
});

test("routing: strangers together get at most a few fixed replies an hour, and wrong codes are limited per person", () => {
  const io = { reply: async () => {}, deliver: () => {} };
  let replies = 0;
  for (let i = 0; i < 40; i++) {
    const aci = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`;
    if (R.admitStranger({ fromUuid: aci, text: "hi" }, io, 10_000 + i).kind === "reply") replies++;
  }
  assert.equal(replies, 20);
  R.forgetRouting();
  const outcomes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const d = R.admitStranger({ fromUuid: ACI_C, text: "ABCD-2345-WXYZ" }, io, 100_000 + i * 1000);
    outcomes.push(d.kind === "ignore" ? d.why : d.kind);
  }
  assert.deepEqual(outcomes, ["reply", ...Array(4).fill("already answered"), ...Array(3).fill("too many wrong codes")]);
  const real = T.mintInvite("brute force")!;
  assert.deepEqual(R.admitStranger({ fromUuid: ACI_C, text: real.code }, io, 110_000), { kind: "ignore", why: "too many wrong codes" }, "a guesser cannot go on to the real one");
});

test("routing: a valid code welcomes her (fixed, with the AI line); she is a tenant from then on; a suspended tenant gets nothing", () => {
  const made = T.mintInvite("for Carl")!;
  const welcomed: string[] = [];
  const said: string[] = [];
  const io = { reply: async (_to: string, text: string) => void said.push(text), deliver: () => {}, welcomed: (t: { id: string }) => void welcomed.push(t.id) };
  const joined = R.admitStranger({ fromUuid: ACI_C, name: "Carl", text: `my code: ${made.code}` }, io);
  assert.equal(joined.kind, "reply");
  assert.equal(welcomed.length, 1);
  assert.ok(said[0]!.startsWith(R.DISCLOSURE) && /age and region/.test(said[0]!) && /Welcome, Carl/.test(said[0]!));
  assert.ok(!/API key/.test(said[0]!), "a friend is no longer asked for a key of her own");
  const delivered: string[] = [];
  const next = R.admitStranger({ fromUuid: ACI_C, text: "hello" }, { ...io, deliver: (t) => void delivered.push(t.id) });
  assert.equal(next.kind, "tenant");
  assert.deepEqual(delivered, welcomed);
  T.setStatus(welcomed[0]!, "suspended");
  assert.deepEqual(R.admitStranger({ fromUuid: ACI_C, text: "hello?" }, io), { kind: "ignore", why: "suspended" });
  assert.equal(R.activeTenant(ACI_C), undefined);
  assert.equal(said.length, 1, "nothing was said to a suspended tenant");
});

test("consent: a one-time record; recording it makes an invited tenant active", () => {
  const rec = join_("Dora");
  const ctx = T.tenantContext(rec);
  assert.equal(T.readConsent(ctx), undefined);
  T.recordConsent(ctx, "  Germany \n");
  assert.equal(T.readConsent(ctx)?.region, "Germany");
  assert.equal(T.readConsent(ctx)?.ageConfirmed, true);
  assert.equal(T.tenantById(rec.id)!.status, "active");
});

// ---- a tenant's turn ----

function runner(over: { key?: string | undefined; ask?: (key: string) => Promise<{ text: string; costUsd: number }>; now?: () => number } = {}) {
  const asked: { id: string; key: string; prompt: string }[] = [];
  const alerts: string[] = [];
  const r = createTenantRunner({
    apiKey: () => over.key,
    alertAdmin: (t) => void alerts.push(t),
    ask: (async (ctx: { id: string }, key: string, prompt: string) => (asked.push({ id: ctx.id, key, prompt }), (over.ask ?? (async () => ({ text: "hello there", costUsd: 0.01 })))(key))) as never,
    now: over.now,
  });
  return { r, asked, alerts };
}

test("disclosure: plainly an AI, her notes private from other users AND from the admin through it, and the host's own access said honestly; short", () => {
  assert.match(R.DISCLOSURE, /\bAI\b/);
  assert.match(R.DISCLOSURE, /private from other users and from the admin/);
  assert.match(R.DISCLOSURE, /runs this computer could still technically read the files/);
  assert.ok(R.DISCLOSURE.length < 320, "short");
  assert.ok(R.welcomeReply("Carl").startsWith(R.DISCLOSURE));
});

test("turn: no instance key means a plain 'not set up for friends' with the AI line, a notice for the admin, no model call and never the owner's login", async () => {
  const rec = join_("Eve");
  const { r, asked, alerts } = runner({ key: undefined });
  const first = await r.run(tenant(rec.id), "hello");
  assert.ok(first.text.startsWith(R.DISCLOSURE) && first.text.includes(R.notSetUpReply()));
  assert.deepEqual(asked, []);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /TENANT_ANTHROPIC_API_KEY is not set/);
  const second = await r.run(tenant(rec.id), "hello?");
  assert.equal(second.text, "[[silent]]", "the notice is not repeated every message");
  assert.equal(alerts.length, 1, "nor the admin's");
  assert.deepEqual(asked, []);
});

test("turn: the run gets the instance key, and the first reply carries the AI line exactly once", async () => {
  const rec = join_("Finn");
  const { r, asked } = runner({ key: KEY_A });
  const one = await r.run(tenant(rec.id), "hi");
  const two = await r.run(tenant(rec.id), "and again");
  assert.deepEqual(asked.map((a) => a.key), [KEY_A, KEY_A]);
  assert.equal(one.text, `${R.DISCLOSURE}\n\nhello there`);
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

test("cooldown: one tenant's limit, 400 or 429 pauses only her", async () => {
  const a = join_("Ann");
  const b = join_("Bea");
  const now = Date.now();
  assert.ok(failure("rate_limit", "error", a.id) instanceof TenantKeyError);
  assert.ok(failure("invalid_request", "error", b.id) instanceof TenantKeyError); // HTTP 400 on her key
  resetCooldown(b.id);
  assert.equal(coolingDown(now + 1000, a.id), true);
  assert.equal(coolingDown(now + 1000, b.id), false);
  assert.equal(coolingDown(now + 1000), false, "the instance's own cooldown (background jobs, the owner) is untouched");
  assert.ok(failure("rate_limit", "error") instanceof RateLimitError, "without a tenant it is the old behaviour");
  assert.equal(coolingDown(now + 1000), true);
  resetCooldown();
  noteRateLimit(now, a.id);
  const { r, asked } = runner({ key: KEY_A });
  const paused = await r.run(tenant(a.id), "hi");
  assert.match(paused.text, /paused/);
  const fine = await r.run(tenant(b.id), "hi");
  assert.match(fine.text, /hello there/);
  assert.deepEqual(asked.map((x) => x.id), [b.id], "only Bea's run was made");
  assert.ok(cooldownUntil(a.id) !== undefined);
  assert.equal(cooldownUntil(b.id), undefined);
  assert.equal(failure("authentication_failed", "e", a.id) instanceof TenantKeyError, true, "her refused key is hers to fix, not the owner's login");
  assert.equal(failure("server_error", "e", a.id) instanceof TenantKeyError, false);
});

test("budget: her day is her own ledger against her own limit; the instance's ledger is not touched either way", async () => {
  const rec = join_("Cy");
  const ctx = T.tenantContext(rec);
  const owner0 = spentToday();
  recordCost(0.5, ctx.costFile);
  assert.equal(spentToday(ctx.costFile), 0.5);
  assert.equal(spentToday(), owner0);
  assert.equal(tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd), false);
  recordCost(ctx.dailyBudgetUsd, ctx.costFile);
  assert.equal(tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd), true);
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
  T.recordConsent(ctx, "Germany");
  recordCost(0.25, ctx.costFile);
  T.setPaused(ctx, Date.now() + 3600_000);
  assert.ok(looksLikeApiKey(KEY_A) && !looksLikeApiKey("sk-ant-short") && !looksLikeApiKey("hello"));
  tenantCheck(line, { on: true, key: KEY_A });
  const mine = lines.find((l) => l.includes(`tenant ${rec.id}`))!;
  assert.match(mine, /^warn /);
  assert.match(mine, /active; today \$0\.25 of \$2; paused until [\d-]+ \d\d:\d\d/);
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
  assert.deepEqual([...rec.capabilities].sort(), [...T.CAPABILITIES].sort());
  assert.equal(rec.capabilities.length, 13);
  const paths = T.pathsOf(rec);
  assert.deepEqual(paths, { root: settings.dataDir, notesDir: NOTES_DIR, logFile: OWNER_LOG, sessionFile: OWNER_SESSION_FILE, costFile: "state/cost.json" }, "no file moved");
  assert.equal(T.ensureOwner({ number: "+15555550105", aci: ACI_A }).number, OWNER_NUMBER, "seeding twice changes nothing");
  assert.equal(T.people().filter((r) => r.id === "owner").length, 1);
  assert.ok(!T.listTenants().some((r) => r.id === "owner"), "the owner is not a tenant: invites, suspension and removal never reach her");
  assert.equal(T.setStatus("owner", "suspended"), undefined);
  const friend = join_("Fred");
  assert.equal(T.people().find((r) => r.id === "owner")!.role, "admin", "a new tenant changes nobody's role");
  assert.deepEqual([friend.role, T.pathsOf(friend).root.startsWith(settings.tenantsDir)], ["member", true]);
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
  const { interpretEnvelope } = await import("@ted-personal-assistant/signal");
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
    const imports = [...readFileSync(f, "utf8").matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"\.\/tenants\.ts"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim().split(/\s+as\s+/)[0]!));
    return imports.some((x) => ["setAdmin", "grant", "revoke"].includes(x));
  });
  assert.deepEqual(importing, [], "no module under src/ can change the admin role or a capability");
  assert.match(readFileSync(new URL("../scripts/tenants.ts", import.meta.url), "utf8"), /set-admin/, "the CLI is where it lives");
});

test("grant and revoke: one capability at a time, on a real record, no duplicates; the tool set follows", () => {
  const rec = join_("Ida");
  assert.ok(!rec.capabilities.includes("mail"));
  assert.deepEqual(T.grant(rec.id, "mail")!.capabilities.filter((c) => c === "mail"), ["mail"]);
  assert.deepEqual(T.grant(rec.id, "mail")!.capabilities.filter((c) => c === "mail"), ["mail"], "granting twice changes nothing");
  assert.ok(T.tenantById(rec.id)!.capabilities.includes("mail"), "stored");
  assert.ok(!T.revoke(rec.id, "mail")!.capabilities.includes("mail"));
  assert.equal(T.grant("nobody", "mail"), undefined);
  assert.equal(T.isCapability("everything"), false);
  const ctx = () => T.tenantContext(T.tenantById(rec.id)!);
  assert.ok(T.toolsFor(ctx()).has("mcp__voice__voice"));
  T.revoke(rec.id, "voice");
  assert.ok(!T.toolsFor(ctx()).has("mcp__voice__voice"), "without the capability the tool is not there");
  assert.deepEqual(ctx().capabilities, T.tenantById(rec.id)!.capabilities);
  const lines = describeTenants().filter((l) => l.startsWith(rec.id));
  assert.match(lines[0]!, /capabilities chat, browse, heartbeat, dream/);
  assert.match(describeTenants()[0]!, /^owner \(.*\): admin; capabilities chat, browse, voice, heartbeat, dream, wake, mail, calendar, notion, profile, card, notes/);
});

test("the per-tenant key plumbing is gone: no set-key, forget-key, KeyStore, intake or setup-incomplete state", () => {
  const cli = readFileSync(new URL("../scripts/tenants.ts", import.meta.url), "utf8");
  assert.ok(!/set-key|forget-key|tenantKeys|localIntake/.test(cli));
  assert.equal(existsSync(new URL("../src/intake.ts", import.meta.url)), false);
  assert.equal((R as Record<string, unknown>).setupIncompleteReply, undefined);
  assert.ok(!/anthropic_api_key|keyRef/.test(readFileSync(new URL("../src/tenants.ts", import.meta.url), "utf8")));
});
