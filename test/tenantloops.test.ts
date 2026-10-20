import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { scopeOf } from "../src/approvals/turnscope.ts";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The loops over every conversation (wake.ts, dream.ts): a tenant with the capabilities is looked in on by the gate, woken and dreamt like the
// owner and a group, on the instance key, with HER notes, log, session and cost file, her approvals and her chat only; one without them gets nothing;
// a suspended, cooling-down, over-budget or key-less one gets no model call; one tenant's failure leaves the others and the owner alone.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "tenant-loops-"));
process.env.CLAUDE_CODE_OAUTH_TOKEN = "owner-oauth-token"; // the instance's own login, which a tenant's call must never carry

const { settings } = await import("../src/settings.ts");
const T = await import("../src/tenants.ts");
const { createWakeups } = await import("../src/wake.ts");
const { createDreamer } = await import("../src/dream.ts");
const { createTenantRunner } = await import("../src/tenantrun.ts");
const { keyNotices } = await import("../src/keynotice.ts");
const { askGateWith, gateSystem, parseGate } = await import("../src/gate.ts");
const { owner, tenant } = await import("../src/conversation.ts");
const { allows } = await import("../src/policy/capabilities.ts");
const { hasPresets, onLogin } = await import("../src/conversationmodel.ts");
const { recordMessage } = await import("../src/messages.ts");
const { recordCost, spentToday } = await import("../src/budget.ts");
const { noteRateLimit, resetCooldown } = await import("../src/cooldown.ts");
const { NOTES_DIR } = await import("../src/notes.ts");
const { InstanceKeyError } = await import("../src/errors.ts");
const { INSTANCE_KEY_COOLDOWN } = await import("../src/payer.ts");

const on = settings as unknown as Record<string, unknown>;
on.briefBackstopHour = 24;
const KEY = "instance-key-for-the-loop-tests";
const NOON = new Date(2026, 9, 14, 12, 0, 0);
type Kind = Parameters<typeof recordMessage>[0];

let created: string[] = []; // the tenants of the test that is running (the data folder is shared by all)
beforeEach(() => {
  created = [];
  on.tenants = true;
  on.wakeups = true;
  on.dream = true;
  resetCooldown();
});

let n = 0;
// A tenant by the real path (invite, consent), with the given capabilities on top of the friend defaults.
function person(name: string, extra: (typeof T.CAPABILITIES)[number][] = ["wake"]): import("../src/tenants.ts").TenantRecord {
  const rec = T.redeemInvite(T.mintInvite("test")!.code, { aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name })!;
  T.provision(rec);
  T.recordConsent(T.tenantContext(rec), "Germany");
  for (const c of extra) T.grant(rec.id, c);
  created.push(rec.id);
  return T.tenantById(rec.id)!;
}
const said = (rec: { id: string }, text: string, at = NOON, kind: Kind = "owner") => recordMessage(kind, at.getTime() + ++n, text, at, T.tenantContext(T.tenantById(rec.id)!).logFile);

function rig(o: { key?: string | undefined; gate?: (c: import("../src/conversation.ts").Conversation) => unknown; run?: (c: import("../src/conversation.ts").Conversation) => string; ids?: string[]; now?: Date } = {}) {
  const alerts: string[] = [];
  const runner = createTenantRunner({ apiKey: () => ("key" in o ? o.key : KEY) });
  keyNotices.reset(); // (one notice for the owner about the shared key, whatever the run: keynotice.ts)
  keyNotices.sendTo((t) => void alerts.push(t));
  const seen = { provenance: [] as unknown[], gates: [] as { conv: import("../src/conversation.ts").Conversation; tenant?: unknown; tail: readonly string[] }[], runs: [] as { conv: import("../src/conversation.ts").Conversation; apiKey?: string; prompt: string }[], sent: [] as { conv: import("../src/conversation.ts").Conversation; text: string }[], profiles: [] as string[] };
  const now = o.now ?? NOON;
  const pipeline = {
    canSpeak: () => false,
    enqueue: <X>(_c: unknown, job: () => Promise<X>) => job(),
    record: (conv: import("../src/conversation.ts").Conversation, kind: Kind, ts: number, text: string) => recordMessage(kind, ts, text, now, conv.logFile),
    runTurn: async (conv: import("../src/conversation.ts").Conversation, turn: { run: (h: unknown) => Promise<{ text: string }> }) => {
      try {
        const { text } = await turn.run({ firstOutput() {} });
        if (text.trim() !== "[[silent]]") seen.sent.push({ conv, text });
        return { spoke: text.trim() !== "[[silent]]" };
      } catch (e) {
        return { spoke: false, error: e };
      }
    },
  };
  const wakeups = createWakeups({
    pipeline: pipeline as never,
    groupChats: true,
    vouch: async () => true,
    runProfile: async (profile) => (seen.profiles.push(profile), { text: "owner ran" }),
    runGroup: async (build, ctx) => {
      seen.runs.push({ conv: ctx.conv, apiKey: ctx.apiKey, prompt: build().prompt });
      seen.provenance.push(scopeOf(ctx.conv.key).read());
      return (o.run ?? (() => "Good morning! A reminder from me."))(ctx.conv);
    },
    gate: async (input) => {
      seen.gates.push({ conv: input.conv, tenant: input.payer, tail: input.tail });
      return parseGate(input.conv.tenantId ? (o.gate ?? (() => ({ act: true, instructions: "Remind her about her sister's birthday", nextCheckMinutes: 30 })))(input.conv) : { act: false, nextCheckMinutes: 30 });
    },
    groups: () => [],
    key: () => ("key" in o ? o.key : KEY),
    tenantIds: () => o.ids ?? created,
    notesChangedAt: () => 0,
    now: () => now,
    guards: { paused: () => false, budgetSpent: () => false },
  });
  return { wakeups, seen, alerts, runner };
}
const tenantGates = (r: ReturnType<typeof rig>) => r.seen.gates.filter((g) => g.conv.tenantId).map((g) => g.conv.tenantId);

test("a tenant with heartbeat and wake gets the gate's look and a wake-up, on the instance key, with her log and her chat only", async () => {
  const anna = person("Anna");
  const other = person("Bo", []); // the friend defaults: no wake
  said(anna, "remind me about my sister's birthday on Friday");
  said(other, "I am a secret of Bo");
  const r = rig();
  await r.wakeups.tick(NOON);
  assert.deepEqual(tenantGates(r), [anna.id], "the look: only hers; Bo has no wake");
  const g = r.seen.gates.find((x) => x.conv.tenantId === anna.id)!;
  assert.deepEqual(g.tenant, { kind: "instance", id: anna.id, apiKey: KEY, costFile: T.tenantContext(anna).costFile });
  assert.ok(g.tail.some((l) => /Anna: remind me about my sister's birthday/.test(l)), "her words, under her name");
  assert.ok(!g.tail.join("\n").includes("secret of Bo"));
  assert.equal(r.seen.runs.length, 1);
  assert.equal(r.seen.runs[0]!.conv.tenantId, anna.id, "the run is hers, in her conversation (her notes, session and approvals)");
  assert.equal(r.seen.runs[0]!.apiKey, KEY);
  assert.deepEqual(r.seen.provenance, [{ kind: "derived", by: "gate", of: "member", text: "Remind her about her sister's birthday" }], "the gate wrote the task: the judge is told it is derived, so it can decide (no question for every call)");
  assert.match(r.seen.runs[0]!.prompt, /Remind her about her sister's birthday/);
  assert.match(r.seen.runs[0]!.prompt, /Anna: remind me about my sister's birthday/);
  assert.doesNotMatch(r.seen.runs[0]!.prompt, /secret of Bo/);
  assert.deepEqual(r.seen.sent.map((s) => [s.conv.tenantId, s.conv.target]), [[anna.id, `to:${anna.acis[0]}`]], "delivered to her chat only");
  assert.deepEqual(r.seen.profiles, [], "the owner's background run never runs for her");
  assert.match(readFileSync(T.tenantContext(anna).logFile, "utf8"), /wake-up: Remind her/);
  assert.doesNotMatch(readFileSync(T.tenantContext(other).logFile, "utf8"), /wake-up/);
});

test("without the capability, with TENANTS off, or while not active: no look at all", async () => {
  const noWake = person("Cy", []);
  const noBeat = person("Di", ["wake"]);
  T.revoke(noBeat.id, "heartbeat");
  const susp = person("Ed");
  T.setStatus(susp.id, "suspended");
  const r = rig();
  await r.wakeups.tick(NOON);
  assert.ok(![noWake.id, noBeat.id, susp.id].some((id) => tenantGates(r).includes(id)));
  for (const id of [noWake.id, noBeat.id]) assert.equal(await r.wakeups.look(tenant(id), NOON), "not-allowed");
  const live = person("Flo");
  on.tenants = false;
  const off = rig();
  await off.wakeups.tick(NOON);
  assert.deepEqual(tenantGates(off), [], "TENANTS=off: nothing of hers is touched");
  assert.equal(allows({ kind: "tenant", tenantId: susp.id }, "heartbeat"), false);
  assert.equal(allows({ kind: "tenant", tenantId: live.id }, "wake"), true);
  assert.equal(allows({ kind: "tenant", tenantId: live.id }, "mail"), false, "not granted");
  T.grant(live.id, "mail");
  assert.equal(allows({ kind: "tenant", tenantId: live.id }, "mail"), false, "a connector is the owner's login's: granting it to a tenant changes nothing yet");
  assert.equal(hasPresets(tenant(live.id)) || onLogin(tenant(live.id)), false);
  assert.equal(hasPresets(owner()) && onLogin(owner()), true);
});

test("a tenant's suspension, cooldown, budget and a missing instance key each stop her look before any model call", async () => {
  const anna = person("Anna2");
  const sus = rig();
  T.setStatus(anna.id, "suspended");
  await sus.wakeups.tick(NOON);
  assert.deepEqual(tenantGates(sus), []);
  T.setStatus(anna.id, "active");
  noteRateLimit(Date.now(), INSTANCE_KEY_COOLDOWN); // the KEY is cooling down: for every friend
  const cool = rig();
  assert.equal(await cool.wakeups.look(tenant(anna.id), NOON), "cooldown");
  resetCooldown();
  recordCost(100, T.tenantContext(anna).costFile);
  const rich = rig();
  assert.equal(await rich.wakeups.look(tenant(anna.id), NOON), "blocked");
  assert.equal(rich.seen.gates.length, 0, "no gate call");
  // no instance key: no run, no gate call, one notice for the admin however many tenants and ticks
  const bea = person("Bea");
  const nokey = rig({ key: undefined });
  await nokey.wakeups.tick(NOON);
  await nokey.wakeups.tick(NOON);
  assert.deepEqual([nokey.seen.gates.filter((g) => g.conv.tenantId).length, nokey.seen.runs.length], [0, 0]);
  assert.equal(nokey.alerts.length, 1);
  assert.match(nokey.alerts[0]!, /TENANT_ANTHROPIC_API_KEY/);
  assert.equal(allows({ kind: "tenant", tenantId: bea.id }, "wake"), true);
});

test("quiet hours apply to a tenant's private chat like the owner's", async () => {
  const anna = person("Anna3");
  const night = new Date(2026, 9, 14, 3, 0, 0);
  const r = rig({ now: night });
  assert.equal(await r.wakeups.look(tenant(anna.id), night), "quiet-hours");
  assert.equal(r.seen.gates.length, 0);
});

test("one tenant's failing look or run does not stop the others or the owner", async () => {
  const bad = person("Gus");
  const good = person("Hal");
  const later = new Date(NOON.getTime() + 3 * 3600_000); // the owner's last look (an earlier test) has come due
  const r = rig({ now: later, gate: (c) => { if (c.tenantId === bad.id) throw new Error("model down"); return { act: true, instructions: "say hi", nextCheckMinutes: 20 }; } });
  await r.wakeups.tick(later);
  assert.deepEqual(r.seen.sent.map((s) => s.conv.tenantId), [good.id]);
  assert.ok(r.seen.gates.some((g) => !g.conv.tenantId), "the owner was looked at as well");
  const evening = new Date(NOON.getTime() + 6 * 3600_000);
  const crash = rig({ now: evening, run: (c) => { if (c.tenantId === bad.id) throw new Error("run crashed"); return "hi"; }, ids: [bad.id, good.id] });
  await crash.wakeups.tick(evening);
  assert.deepEqual(crash.seen.sent.map((s) => s.conv.tenantId), [good.id]);
  assert.match(readFileSync(T.tenantContext(bad).logFile, "utf8"), /→ failed/);
});

test("quiet-time compaction of a tenant needs heartbeat and her access; it is hers to pay", async () => {
  const anna = person("Ivy");
  const nobeat = person("Jo", []);
  T.revoke(nobeat.id, "heartbeat");
  const ran: string[] = [];
  const mk = (key: string | undefined) => {
    const w = createWakeups({
      pipeline: { canSpeak: () => false, enqueue: async (_c: unknown, j: () => Promise<unknown>) => j(), record: () => {}, runTurn: async () => ({ spoke: false }) } as never,
      groupChats: true,
      vouch: async () => true,
      runProfile: async () => ({ text: "" }),
      gate: async () => parseGate({ act: false }),
      groups: () => [],
      key: () => key,
      tenantIds: () => [anna.id, nobeat.id],
      compact: { due: () => true, run: async (c) => void ran.push(c.tenantId ?? c.kind) },
      notesChangedAt: () => 0,
      now: () => NOON,
      guards: { paused: () => false, budgetSpent: () => false },
    });
    return w;
  };
  const w = mk(KEY);
  await w.tick(NOON);
  await w.idle();
  assert.deepEqual(ran.sort(), [anna.id, "owner"].sort());
  ran.length = 0;
  const w2 = mk(undefined);
  await w2.tick(NOON);
  await w2.idle();
  assert.deepEqual(ran, ["owner"], "no instance key: hers does not run, the owner's does");
});

test("the gate's own call for a tenant is on the instance key and billed to her; a refusal is her cooldown only", async () => {
  const anna = person("Kim");
  const ctx = T.tenantContext(anna);
  let options: { env?: Record<string, string | undefined> } | undefined;
  const fake = (assistantError?: string) => ({
    query: ((a: { options: typeof options }) => {
      options = a.options;
      return Object.assign((async function* () {
        if (assistantError) yield { type: "assistant", error: assistantError, parent_tool_use_id: null, message: { usage: {} } };
        yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.25, duration_api_ms: 0, structured_output: { act: false, nextCheckMinutes: 30 } };
      })(), { close() {} });
    }) as never,
  });
  const before = spentToday();
  const input = { conv: tenant(anna.id), trigger: "clock" as const, now: NOON, tail: [], payer: { kind: "instance" as const, id: anna.id, apiKey: KEY, costFile: ctx.costFile } };
  await askGateWith(input, fake());
  assert.equal(options!.env!.ANTHROPIC_API_KEY, KEY);
  assert.equal(options!.env!.CLAUDE_CODE_OAUTH_TOKEN, undefined, "never the owner's login");
  assert.equal(spentToday(ctx.costFile), 0.25);
  assert.equal(spentToday(), before, "not the instance's own ledger");
  await assert.rejects(askGateWith(input, fake("rate_limit")), InstanceKeyError);
  const { coolingDown } = await import("../src/cooldown.ts");
  assert.equal(coolingDown(Date.now(), INSTANCE_KEY_COOLDOWN), true, "the key's refusal is the key's: one cooldown for every friend");
  assert.equal(coolingDown(Date.now(), ""), false, "the owner's login cooldown is untouched");
});

test("the gate's rules for a tenant's chat name her, have no brief or radar and nothing of the owner's", () => {
  const anna = person("Lea");
  const sys = gateSystem(tenant(anna.id), "clock", "");
  assert.match(sys, /Lea's private chat/);
  assert.match(sys, /Acting on your own/);
  assert.doesNotMatch(sys, /"brief"|"radar"/);
  assert.doesNotMatch(sys, new RegExp(settings.owner));
  assert.match(gateSystem(owner(), "clock", ""), /task "brief"/);
  assert.match(gateSystem(owner(), "clock", ""), new RegExp(`${settings.owner}'s private chat`));
});

// ---- the dream ----

const friends = (ids: () => string[]) => () => (settings.tenants ? ids().map((id) => tenant(id)) : []); // (dreamConversations(["tenant"]) for chosen friends)
const ownerNotesBefore = () => (existsSync(NOTES_DIR) ? readdirSync(NOTES_DIR).sort().join(",") : "");
const WRITE = (evidence: string) => ({ ops: [{ op: "write", file: "people-sister.md", description: "her sister", text: "Her sister Eve is vegetarian.", evidence }] });

test("the nightly dream tidies a tenant's notes from her words only, on her key; owner's and others' notes are untouched", async () => {
  const anna = person("Mia", ["dream"]);
  const bob = person("Ned", ["dream"]);
  const noDream = person("Oz", []);
  T.revoke(noDream.id, "dream");
  for (const p of [anna, bob, noDream]) said(p, p === anna ? "my sister Eve is vegetarian, please remember" : "this is the private matter of someone else");
  const before = ownerNotesBefore();
  const prompts: { prompt: string; system?: string; key: string }[] = [];
  const d = createDreamer({
    key: () => KEY,
    conversations: friends(() => created),
    run: (payer) => async (prompt, system) => (prompts.push({ prompt, system, key: (payer as { apiKey: string }).apiKey }), WRITE("my sister Eve is vegetarian")),
  });
  await d.run(NOON);
  assert.equal(prompts.length, 2, "Mia and Ned; not Oz");
  const mine = prompts.find((p) => /Mia/.test(p.prompt))!;
  assert.match(mine.prompt, /Mia: my sister Eve is vegetarian/);
  assert.doesNotMatch(mine.prompt, /someone else/);
  assert.equal(mine.key, KEY);
  assert.match(mine.system!, /Mia/);
  assert.doesNotMatch(mine.system!, new RegExp(`${settings.owner}'s memory`));
  const hers = T.tenantContext(anna);
  assert.match(readFileSync(join(hers.notesDir, "people-sister.md"), "utf8"), /vegetarian/);
  assert.ok(existsSync(hers.backupDir) && readdirSync(hers.backupDir).length > 0, "a snapshot in her folder");
  // she can undo it in her chat: her memory server has undo_dream, closed over HER scope (no `group` argument to name another)
  const { createMemoryServer } = await import("../src/memory-tools.ts");
  const { dreamScope } = await import("../src/dreamscope.ts");
  const mem = createMemoryServer({ notesDir: hers.notesDir, tenantLog: hers.logFile, dream: dreamScope(tenant(anna.id)), record() {} }) as unknown as { instance: { _registeredTools: Record<string, { handler: (a: object, x: object) => Promise<{ content: { text: string }[] }> }> } };
  assert.deepEqual(Object.keys(mem.instance._registeredTools).sort(), ["forget_note", "search_logs", "undo_dream"]);
  const undone = await mem.instance._registeredTools.undo_dream!.handler({}, {});
  assert.match(undone.content[0]!.text, /Restored \d+ notes/);
  assert.ok(!existsSync(join(hers.notesDir, "people-sister.md")), "her notes are back as before the dream");
  assert.equal(readdirSync(hers.backupDir).length, 0, "the snapshot is used up");
  writeFileSync(join(hers.notesDir, "people-sister.md"), "---\nname: sister\n---\n\nHer sister Eve is vegetarian.\n"); // (as the dream had left it, for the rest of this test)
  // Ned's evidence (her words) is not in his log: refused, so nothing of the quote lands in his notes
  assert.ok(!existsSync(join(T.tenantContext(bob).notesDir, "people-sister.md")));
  assert.ok(!existsSync(join(T.tenantContext(noDream).notesDir, "people-sister.md")));
  assert.equal(ownerNotesBefore(), before, "the owner's notes are untouched");
  // once a day
  prompts.length = 0;
  await d.run(NOON);
  assert.equal(prompts.length, 0);
});

test("a tenant's dream: nothing new said, suspended, cooling down, over budget, no key, TENANTS off; and one failing never stops the next", async () => {
  const quiet = person("Pia", ["dream"]);
  const sus = person("Quin", ["dream"]);
  const poor = person("Sol", ["dream"]);
  const fine = person("Tia", ["dream"]);
  const boom = person("Uma", ["dream"]);
  for (const p of [sus, poor, fine, boom]) said(p, `${p.name} says something worth keeping about her plans`);
  T.setStatus(sus.id, "suspended");
  recordCost(100, T.tenantContext(poor).costFile);
  const ran: string[] = [];
  const alerts: string[] = [];
  keyNotices.reset();
  keyNotices.sendTo((t) => void alerts.push(t));
  const mk = (key: string | undefined) => {
    return createDreamer({
      key: () => key,
      run: (_payer, conv) => async () => {
        ran.push(conv.tenantId!);
        if (conv.tenantId === boom.id) throw new Error("model down");
        return { ops: [] };
      },
      conversations: friends(() => [quiet.id, sus.id, poor.id, boom.id, fine.id]),
    });
  };
  await mk(KEY).run(NOON);
  assert.deepEqual(ran.sort(), [boom.id, fine.id].sort(), "the failing one is tried, the one after it still runs");
  ran.length = 0;
  noteRateLimit(Date.now(), INSTANCE_KEY_COOLDOWN); // the key is cooling down: it is the key's, so no friend's dream runs (the day stays open for each)
  await mk(KEY).run(new Date(NOON.getTime() + 86_400_000));
  assert.deepEqual(ran, [], "the key is cooling down");
  resetCooldown();
  on.tenants = false;
  await mk(KEY).run(new Date(NOON.getTime() + 2 * 86_400_000));
  assert.deepEqual(ran, [], "TENANTS=off");
  on.tenants = true;
  await mk(undefined).run(new Date(NOON.getTime() + 3 * 86_400_000));
  assert.deepEqual(ran, [], "no instance key: no run");
  assert.equal(alerts.length, 1, "and one notice for the admin");
});

test("her prompt says she can act later only when the loops will run for her", async () => {
  const { tenantSystem } = await import("../src/persona.ts");
  const { runOptionsFor } = await import("../src/runoptions.ts");
  assert.match(tenantSystem({ name: "Vi", consented: true, caps: new Set() }), /You cannot act on your own later/);
  assert.match(tenantSystem({ name: "Vi", consented: true, caps: new Set(), timed: true }), /You can act on your own at set times/);
  const plain = person("Wes", []);
  const timed = person("Xan");
  assert.match(runOptionsFor(tenant(plain.id), { apiKey: KEY }).systemPrompt as string, /You cannot act on your own later/);
  assert.match(runOptionsFor(tenant(timed.id), { apiKey: KEY }).systemPrompt as string, /You can act on your own at set times/);
});

test("capabilitiesOf is the one answer: instance switches, her own settings and what is set up reach the owner, a group and a friend alike", () => {
  const f = settings as unknown as { draw: boolean; dream: boolean; wakeups: boolean; google: { clientId?: string; clientSecret?: string } };
  const was = { draw: f.draw, dream: f.dream, wakeups: f.wakeups, google: { ...f.google } };
  try {
    const bea = person("Bea5", ["wake", "google", "mail"]);
    const her = { kind: "tenant", tenantId: bea.id } as const;
    f.google.clientId = f.google.clientSecret = undefined;
    assert.equal(allows(her, "mail"), false, "no OAuth client: no mail check, no Google tools (one readiness answer)");
    assert.equal(allows(her, "google"), false);
    f.google.clientId = "id";
    f.google.clientSecret = "secret";
    assert.equal(allows(her, "mail"), true);
    assert.equal(allows(owner(), "google"), true, "the owner's mail and calendar are her connectors: no OAuth client needed");
    // her own settings (tenant.json) reach the loops too, not only the tools
    assert.equal(allows(her, "voice"), true);
    writeFileSync(T.tenantContext(bea).configFile, JSON.stringify({ voice: false, browse: false }));
    assert.equal(allows(her, "voice"), false, "a spoken wake-up is never offered to a friend whose voice is off");
    assert.equal(allows(her, "browse"), false);
    // the instance's switches take away from everybody, the owner and groups included
    f.draw = false;
    assert.equal(allows({ kind: "group" }, "draw"), false);
    assert.equal(allows(her, "draw"), false);
    f.dream = false;
    assert.equal(allows({ kind: "group" }, "dream"), false);
    assert.equal(allows(owner(), "dream"), false);
    assert.equal(allows(her, "dream"), false);
    f.wakeups = false;
    assert.equal(allows(owner(), "wake"), false);
    assert.equal(allows(her, "wake"), false);
    // login-only: the owner has them, nobody else does, whatever a record lists
    T.grant(bea.id, "profile");
    T.grant(bea.id, "drive");
    assert.deepEqual([allows(owner(), "profile"), allows(owner(), "card"), allows(her, "profile"), allows(her, "drive"), allows({ kind: "group" }, "card")], [true, true, false, false, false]);
    T.setStatus(bea.id, "suspended");
    assert.equal(allows(her, "chat"), false, "not active: nothing");
  } finally {
    Object.assign(f, was);
  }
});
