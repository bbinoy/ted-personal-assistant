import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The mail heartbeat for friends: the SAME check, triage and handler as the owner's (heartbeat.ts createMailCheck, triage.ts, handler.ts), run per friend with her own
// Google server (a fake stdio server, test/fakegoogle.ts), her folder, her notes, her cost guard and her chat. Fake small model, fake handler run; nothing talks to Google.
const dir = mkdtempSync(join(tmpdir(), "google-loops-"));
process.env.HARNESS_DATA_DIR = dir;
process.env.GOOGLE_OAUTH_CLIENT_ID = "fake-client-id.example";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "fake-client-secret-not-real";
process.env.CLAUDE_CODE_OAUTH_TOKEN = "owner-oauth-token";
process.env.TENANTS = "on";

const { settings } = await import("../src/settings.ts");
const T = await import("../src/tenants.ts");
const L = await import("../src/intakelinks.ts");
const { GoogleHub, GoogleSession } = await import("../src/googlemcp.ts");
const { GoogleMail } = await import("../src/googlemail.ts");
const { createTenantMailLoops } = await import("../src/mailloops.ts");
const { mailFiles, mailDigest } = await import("../src/tenantmail.ts");
const { readAudit } = await import("../src/audit.ts");
const { readTriageSince } = await import("../src/digest.ts");
const { tenantHandlerOptions } = await import("../src/agent.ts");
const { buildOptions } = await import("../src/agentrun.ts");
const { tenant } = await import("../src/conversation.ts");
const { resetCooldown } = await import("../src/cooldown.ts");
const { dataPath } = await import("../src/state.ts");
const { handlerTask } = await import("../src/handler.ts");

const FAKE = new URL("./fakegoogle.ts", import.meta.url).pathname;
const STATE = join(dir, "mailboxes.json");
const on = settings as unknown as Record<string, unknown>;
Object.assign(on, { tenants: true, quietStartHour: 0, quietEndHour: 0, heartbeatLive: true });
const google = settings.google as unknown as Record<string, unknown>;

const TOKENS: Record<string, string> = {};
const EMAILS: Record<string, string> = {};
const TMP = mkdtempSync(join(dir, "tmp-")); // her credentials folders go here, not into the shared temp folder (other test files run at the same time)
const hub = new GoogleHub((id) => new GoogleSession(id, () => ({ command: process.execPath, args: [FAKE], clientId: settings.google.clientId, clientSecret: settings.google.clientSecret, tokenUrl: "https://token.invalid/token", scopes: ["s"], idleMs: 60_000, callMs: 20_000, tmpRoot: TMP, env: { FAKE_GOOGLE_STATE: STATE, FAKE_GOOGLE_LOG: join(dir, "calls.log") } }), async (t) => (TOKENS[t] ? { refreshToken: TOKENS[t]!, email: EMAILS[t]! } : undefined)));
after(() => hub.closeAll());

interface Msg { id: string; from: string; subject: string; date: string; body: string; labels: string[] }
const mailboxes: Record<string, { messages: Msg[] }> = {};
const save = () => writeFileSync(STATE, JSON.stringify(mailboxes));
let seq = 0;
const mail = (email: string, from: string, subject: string, body = "Body text."): Msg => ({ id: `m${++seq}`, from, subject, date: "Tue, 20 Oct 2026 08:00:00 +0000", body, labels: ["INBOX"] });
const deliver = (id: string, ...msgs: Msg[]) => {
  mailboxes[EMAILS[id]!]!.messages.push(...msgs);
  save();
};

let n = 0;
function friend(name: string, extra: (typeof T.CAPABILITIES)[number][] = ["google", "mail", "calendar"]) {
  const rec = T.redeemInvite(T.mintInvite("t")!.code, { aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name })!;
  T.provision(rec);
  T.recordConsent(T.tenantContext(rec), "Germany");
  for (const c of extra) T.grant(rec.id, c);
  TOKENS[rec.id] = `fake-refresh-token-${rec.id}-not-real`;
  EMAILS[rec.id] = `${name.toLowerCase()}@example.com`;
  mailboxes[EMAILS[rec.id]!] = { messages: [] };
  save();
  L.recordDone(rec.id, "google", [{ name: "google connection", chars: 10 }]);
  return rec.id;
}

// the fakes around the loop
const notices: { id: string; text: string }[] = [];
const triaged: { id: string; subjects: string[] }[] = [];
const handled: { id: string; prompt: string; task: string }[] = [];
const blocked = new Set<string>(); // friends whose access is gone (here: the instance key is not set; the cooldown and budget cases are in tenantloops.test.ts)
const cost = new Map<string, number>();
const label = (subject: string) => (/URGENT/.test(subject) ? "act_now" : /Newsletter/.test(subject) ? "archive" : /Meeting/.test(subject) ? "handle" : "read_later");
function loops(extra: Partial<Parameters<typeof createTenantMailLoops>[0]> = {}) {
  return createTenantMailLoops({
    key: () => (blocked.size ? undefined : "instance-key-not-real"),
    notify: async (id, text) => void notices.push({ id, text }),
    approve: () => async () => ({ approved: false }),
    source: (id) => new GoogleMail(hub.session(id)),
    triage: (id) => async (mails) => {
      triaged.push({ id, subjects: mails.map((m) => m.subject) });
      cost.set(id, (cost.get(id) ?? 0) + 1);
      return mails.map((m) => ({ label: label(m.subject), kind: /Newsletter/.test(m.subject) ? "newsletter" : "personal_or_work", reason: "r", protected: false }) as never);
    },
    handlerRun: (id) => async (prompt, _approve, _tool, task) => {
      handled.push({ id, prompt, task });
      return { text: "Carl: saved a draft reply for Thursday", costUsd: 0.01 };
    },
    ...extra,
  });
}
const inbox = (id: string) => mailboxes[EMAILS[id]!]!.messages;
const reread = () => Object.assign(mailboxes, JSON.parse(readFileSync(STATE, "utf8")));

beforeEach(() => {
  notices.length = 0;
  triaged.length = 0;
  handled.length = 0;
  blocked.clear();
  cost.clear();
  resetCooldown();
  google.archiveLive = false;
});

test("a friend's mail check: the first look only records the inbox; new mail is triaged once, alerts and handler reports go to HER chat, in her folder, and the owner's files are untouched", async () => {
  const anna = friend("Anna");
  const bea = friend("Bea");
  deliver(anna, mail("", "Old <old@example.org>", "Old news"));
  deliver(bea, mail("", "Dora <dora@example.org>", "Invoice 4711", "Bea's private invoice"));
  const l = loops();
  await l.tick();
  assert.equal(triaged.length, 0, "the baseline: nothing is triaged, nothing is spent");
  assert.ok(existsSync(mailFiles(T.tenantContext(T.tenantById(anna)!)).seen), "her seen-mail memory is in her folder");
  assert.equal(existsSync(dataPath("state/seen.json")), false, "the owner's seen-mail memory is not touched");
  assert.notEqual(hub.session(anna).starts, 0);
  // new mail for Anna only
  deliver(anna, mail("", "Boss <boss@example.org>", "URGENT: contract"), mail("", "Shop <shop@example.org>", "Newsletter: deals"), mail("", "Carl <carl@example.org>", "Meeting Thursday?"), mail("", "Eve <eve@example.org>", "Hello again"));
  await l.tick();
  await l.idle();
  assert.deepEqual(triaged.map((t) => t.id), [anna], "one small-model batch, for her alone");
  assert.deepEqual(triaged[0]!.subjects.sort(), ["Hello again", "Meeting Thursday?", "Newsletter: deals", "URGENT: contract"]);
  assert.ok(triaged.every((t) => t.subjects.every((s) => !/Invoice/.test(s))), "Bea's mail never reaches Anna's triage, and none of hers reached the model at all");
  // the alert and the handler's report: her chat, nobody else's
  assert.ok(notices.length >= 2);
  assert.ok(notices.every((x) => x.id === anna), "every notice went to Anna");
  assert.ok(notices.some((x) => /URGENT: contract/.test(x.text)), "the act_now mail is alerted");
  assert.ok(notices.some((x) => /Handled 1/.test(x.text)), "the handler's report");
  // the handler ran for her, with her name in a standing task that holds no mail
  assert.equal(handled.length, 1);
  assert.equal(handled[0]!.id, anna);
  assert.match(handled[0]!.task, /for Anna\b/);
  assert.doesNotMatch(handled[0]!.task, /Carl|Meeting|boss@/);
  assert.match(handled[0]!.prompt, /from="Carl"/);
  assert.notEqual(handled[0]!.task, handlerTask(), "her tools, not the owner's");
  // archive is log-only until switched on: the newsletter stays in the inbox
  reread();
  assert.ok(inbox(anna).find((m) => /Newsletter/.test(m.subject))!.labels.includes("INBOX"));
  // her record: her file has the words, the admin's audit log has none
  const triageFile = readFileSync(mailFiles(T.tenantContext(T.tenantById(anna)!)).triage, "utf8");
  assert.match(triageFile, /URGENT: contract/);
  assert.match(triageFile, /would-archive/);
  const rows = readAudit((e) => e.tool === "tenant_heartbeat_triage");
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.meta?.tenant === anna), "tagged with her id");
  assert.doesNotMatch(JSON.stringify(rows), /URGENT|Newsletter|boss@|Carl|contract/, "no sender, subject or reason in the audit log");
  assert.equal(readTriageSince("1970-01-01T00:00:00.000Z").length, 0, "the owner's brief never sees a friend's mail");
  assert.ok(existsSync(mailFiles(T.tenantContext(T.tenantById(anna)!)).queue) === false || JSON.parse(readFileSync(mailFiles(T.tenantContext(T.tenantById(anna)!)).queue, "utf8")).length === 0, "her handler queue is emptied");
  // the brief entry: what the check did, as data for her chat
  const digest = mailDigest(T.tenantContext(T.tenantById(anna)!));
  assert.match(digest, /Boss: URGENT: contract \[act_now/);
  assert.match(digest, /Meeting Thursday\?/);
  assert.doesNotMatch(digest, /Newsletter/, "mail it would only archive is not news");
  // nothing new: no model call, no notice
  const calls = triaged.length;
  const noticed = notices.length;
  await l.tick();
  assert.equal(triaged.length, calls);
  assert.equal(notices.length, noticed);
  // Bea's own turn: her mail is hers
  deliver(bea, mail("", "Dora <dora@example.org>", "URGENT: payment"));
  await l.tick();
  await l.idle();
  assert.deepEqual(triaged.at(-1), { id: bea, subjects: ["URGENT: payment"] });
  assert.ok(notices.filter((x) => x.id === bea).length === 1 && notices.filter((x) => x.id === anna).length === noticed);
});

test("two friends run two Google server processes and never see each other's token or mail", async () => {
  const a = friend("Ann2");
  const b = friend("Bob2");
  deliver(a, mail("", "X <x@example.org>", "secret-subject-of-ann"));
  deliver(b, mail("", "Y <y@example.org>", "secret-subject-of-bob"));
  const l = loops();
  await l.tick();
  assert.equal(hub.session(a).running && hub.session(b).running, true);
  const pa = JSON.parse((await hub.session(a).call("_probe", {})).text);
  const pb = JSON.parse((await hub.session(b).call("_probe", {})).text);
  assert.notEqual(pa.pid, pb.pid);
  assert.equal(pa.refresh, TOKENS[a]);
  assert.equal(pb.refresh, TOKENS[b]);
  assert.notEqual(pa.refresh, pb.refresh);
  const mine = (await hub.session(a).call("search_gmail_messages", { query: "in:inbox" })).text;
  assert.match(mine, /secret-subject-of-ann/);
  assert.doesNotMatch(mine, /secret-subject-of-bob/);
});

test("one friend failing affects nobody else: her server is gone, her check logs once, the others are looked at as usual", async () => {
  const good = friend("Gina");
  const bad = friend("Bart");
  const errors: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const l = loops({
      source: (id) => (id === bad ? ({ inboxes: async () => Promise.reject(new Error("her server did not start")), call: async () => assert.fail("not reached"), close: async () => {} } as never) : new GoogleMail(hub.session(id))),
    });
    await l.tick();
    deliver(good, mail("", "Z <z@example.org>", "URGENT: for Gina"));
    await l.tick();
    await l.tick();
    await l.idle();
    assert.ok(notices.some((x) => x.id === good && /URGENT: for Gina/.test(x.text)), "the other friend was served");
    assert.equal(notices.some((x) => x.id === bad), false);
    assert.equal(errors.filter((e) => /heartbeat error/.test(e)).length, 1, "reported once per outage");
  } finally {
    console.error = was;
  }
});

test("the cost guard: with no access (her cooldown, day's budget, suspension or key) nothing is classified and the mail waits unseen; archive stays log-only until switched on", async () => {
  const id = friend("Cora");
  const l = loops();
  await l.tick(); // baseline
  deliver(id, mail("", "S <s@example.org>", "Newsletter: weekly"));
  blocked.add(id);
  await l.tick();
  await l.tick();
  assert.equal(triaged.length, 0, "no model call while she has no access");
  blocked.delete(id);
  google.archiveLive = true;
  await l.tick();
  await l.idle();
  assert.equal(triaged.length, 1, "the mail was still unseen: it is classified now, once");
  reread();
  assert.equal(inbox(id).find((m) => /Newsletter/.test(m.subject))!.labels.includes("INBOX"), false, "archived (INBOX label off) once GOOGLE_ARCHIVE_LIVE is on");
  const rows = readAudit((e) => e.tool === "tenant_heartbeat_triage" && e.meta?.tenant === id);
  assert.equal(rows.at(-1)!.decision, "archived");
});

test("eligibility: no capability, no connection, a suspended friend, Google not configured: no check, no Google process", async () => {
  const plain = friend("Pia", []);
  const unconnected = friend("Uli");
  const suspended = friend("Sam");
  T.setStatus(suspended, "suspended");
  // Uli never connected
  const ctxU = T.tenantContext(T.tenantById(unconnected)!);
  const fs = await import("node:fs");
  fs.rmSync(dataPath("state/intake-status.json"), { force: true });
  L.recordDone(plain, "google", [{ name: "x", chars: 1 }]);
  L.recordDone(suspended, "google", [{ name: "x", chars: 1 }]);
  deliver(plain, mail("", "A <a@example.org>", "URGENT: x"));
  const l = loops();
  await l.tick();
  assert.deepEqual(l.loops(), [], "nobody is eligible");
  assert.equal(hub.session(plain).running || hub.session(unconnected).running || hub.session(suspended).running, false);
  assert.equal(existsSync(mailFiles(ctxU).seen), false);
  // and with the instance's Google client missing
  const keep = google.clientId;
  google.clientId = undefined;
  L.recordDone(unconnected, "google", [{ name: "x", chars: 1 }]);
  await loops().tick();
  assert.equal(triaged.length, 0);
  google.clientId = keep;
});

test("the handler's run is hers: only her Google tools, her notes, the instance key, her chat's approver; a send asks HER; the owner's login is not in its environment", async () => {
  const id = friend("Hana");
  const conv = tenant(id);
  const asked: string[] = [];
  const opts = tenantHandlerOptions(conv, { apiKey: "instance-key-not-real" }, undefined, "TASK");
  const o = buildOptions(async (d) => (asked.push(d), { approved: false }), opts, undefined);
  const tools = [...(opts.tools ?? [])];
  assert.ok(tools.length > 0 && tools.every((t) => t.startsWith("mcp__google__")), "her Google tools and nothing else");
  assert.equal((o.mcpServers as Record<string, { type: string }>).google?.type, "sdk");
  assert.deepEqual(Object.keys(o.mcpServers as object), ["google"]);
  assert.match(String((o.systemPrompt as { prompt: string }).prompt), /for Hana\b|Hana's/);
  assert.doesNotMatch(String((o.systemPrompt as { prompt: string }).prompt), new RegExp(settings.owner));
  const env = o.env as Record<string, string | undefined>;
  assert.equal(env.ANTHROPIC_API_KEY, "instance-key-not-real");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "never the owner's login");
  assert.equal(o.persistSession, undefined);
  assert.equal(opts.judgeContext, "TASK");
  assert.equal(opts.untrusted, true);
  assert.equal(opts.sessionFile, undefined);
  // a send from the handler is asked in her chat (autoApprove off: nothing is judged)
  const was = settings.autoApprove;
  on.autoApprove = "off";
  try {
    const can = o.canUseTool! as unknown as (tool: string, input: Record<string, unknown>, opts: unknown) => Promise<{ behavior: string }>;
    const send = await can("mcp__google__send_gmail_message", { to: "carl@example.org", subject: "s", body: "b", in_reply_to: "<x@y>" }, { signal: new AbortController().signal } as never);
    assert.equal(send.behavior, "deny", "she declined in this stub");
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /carl@example\.org/);
    assert.equal((await can("mcp__mailbird__send_message_now", {}, { signal: new AbortController().signal } as never)).behavior, "deny", "not a tool of hers");
    assert.equal((await can("mcp__google__modify_gmail_message_labels", { message_id: "m", add_label_ids: ["TRASH"] }, { signal: new AbortController().signal } as never)).behavior, "deny");
  } finally {
    on.autoApprove = was;
  }
});
