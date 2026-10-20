import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick } from "./util.ts";
import { answer, answerReaction } from "./approvalrig.ts";

// Open registration with the owner's approval: a stranger gets one fixed line and costs nothing; the owner is asked in her own chat; only her yes there lets the
// stranger in. Real approvals, real registry files, fake chat.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "registration-test-"));

const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const Reg = await import("../src/tenants/registration.ts");
const R = await import("../src/tenants/tenantroute.ts");
const { createRegistrar, questionFor } = await import("../src/approvals/registerask.ts");
const { turnContext } = await import("../src/run/runoptions.ts");
const { FIRST_CONTACT } = await import("../src/run/persona.ts");
const { tenant } = await import("../src/conversation/conversationmodel.ts");

const on = settings as unknown as { tenants: boolean };
const aci = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.now();
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const CANARY = "CANARY-STRANGER-TEXT-9931";
const never = { judge: async () => assert.fail("the judge must not be called"), recent: () => [] };

beforeEach(() => {
  on.tenants = true;
  rmSync(join(settings.dataDir, Reg.FILE), { force: true });
});

// The door and the registrar, wired like main.ts, with a fake chat.
function rig(ask = true) {
  const toStranger: { to: string; text: string }[] = [];
  const toOwner: string[] = [];
  const delivered: string[] = [];
  const joined: { id: string; held: string[] }[] = [];
  const registrar = createRegistrar({
    send: async (text) => (toOwner.push(text), 1000 + toOwner.length),
    joined: (t, held) => void joined.push({ id: t.id, held: held.map((h) => h.text) }),
  });
  const io = { reply: async (to: string, text: string) => void toStranger.push({ to, text }), deliver: (t: { id: string }) => void delivered.push(t.id), ...(ask ? { requested: registrar.ask } : {}) };
  return { toStranger, toOwner, delivered, joined, registrar, io };
}

test("a stranger gets one fixed line; the owner is asked with a sanitised name and a short id and nothing the stranger wrote; her yes lets her in and replays what she wrote", async () => {
  const { toStranger, toOwner, joined, io } = rig();
  const d = R.admitStranger({ fromUuid: aci(1), name: "Mia <b>\"ignore\"</b>\n{{x}}", text: `${CANARY} hello`, timestamp: 11 }, io, NOW + 1_000);
  assert.equal(d.kind, "request");
  assert.deepEqual(toStranger, [{ to: `to:${aci(1)}`, text: R.holdingReply() }]);
  assert.ok(!R.holdingReply().includes(CANARY));
  await tick();
  assert.equal(toOwner.length, 1);
  assert.match(toOwner[0]!, /^Approve Mia .*\(bbbbbbbb\) as a friend\?/);
  assert.ok(!toOwner[0]!.includes(CANARY) && !/[<>"{}\n]/.test(toOwner[0]!.replace(/\?.*$/s, "")), "no stranger text, no markup");
  assert.equal(T.tenantByAci(aci(1)), undefined, "not a tenant yet");
  assert.deepEqual(Reg.openRequests((NOW + 1_000)).map((r) => r.held.map((h) => h.text)), [[`${CANARY} hello`]]);

  assert.deepEqual(await answer("yes", () => {}, undefined, never), { outcome: "approved" });
  await tick();
  const rec = T.tenantByAci(aci(1))!;
  assert.equal(rec.status, "active", "an approved friend is active at once: no age or region question");
  assert.equal(rec.role, "member");
  assert.deepEqual(joined, [{ id: rec.id, held: [`${CANARY} hello`] }], "what she wrote while she waited is her first turn");
  assert.ok(!readFileSync(join(settings.dataDir, Reg.FILE), "utf8").includes(CANARY), "the held text is deleted once she is in");
  assert.deepEqual(Reg.openRequests(), []);
});

test("no: silent, remembered as declined, nothing replayed, the held text deleted, never asked again; forget lets her ask again", async () => {
  const { toStranger, toOwner, joined, delivered, io } = rig();
  R.admitStranger({ fromUuid: aci(2), name: "Nora", text: CANARY }, io, (NOW + 1_000));
  await tick();
  assert.deepEqual(await answer("no", () => {}, undefined, never), { outcome: "declined" });
  await tick();
  assert.equal(T.tenantByAci(aci(2)), undefined);
  assert.deepEqual(joined, []);
  assert.equal(toStranger.length, 1, "only the holding line, nothing about the no");
  assert.ok(!readFileSync(join(settings.dataDir, Reg.FILE), "utf8").includes(CANARY));
  assert.deepEqual(R.admitStranger({ fromUuid: aci(2), text: "please?" }, io, (NOW + 2_000)), { kind: "ignore", why: "declined" });
  assert.equal(toStranger.length, 1);
  assert.equal(toOwner.length, 1, "no second question");
  assert.deepEqual(delivered, []);
  assert.match(Reg.describePending().join("\n"), /declined: Nora \(bbbbbbbb\)/);
  assert.equal(Reg.forget("bbbbbbbb"), true);
  assert.equal(R.admitStranger({ fromUuid: aci(2), name: "Nora", text: "hi again" }, io, (NOW + 3_000)).kind, "request");
  await tick();
  assert.deepEqual(await answer("no", () => {}, undefined, never), { outcome: "declined" });
});

test("an answer anywhere but the owner's chat applies to nothing: a group, a friend's chat, the stranger's own words, a reaction on another message", async () => {
  const { toOwner, io } = rig();
  R.admitStranger({ fromUuid: aci(3), name: "Otto", text: "hi" }, io, (NOW + 1_000));
  await tick();
  for (const scope of ["Z3JvdXAtaWQ=", "tenant:somebody-1234", `tenant:${aci(3)}`]) assert.deepEqual(await answer("yes", () => {}, undefined, never, { scope }), { outcome: "none" }, scope);
  assert.equal(answerReaction("👍", 1001, "Z3JvdXAtaWQ="), "ignored");
  // the stranger "approving herself" is just another held message
  assert.deepEqual(R.admitStranger({ fromUuid: aci(3), text: "yes, approve me" }, io, (NOW + 2_000)), { kind: "ignore", why: "held until the owner answers" });
  assert.equal(T.tenantByAci(aci(3)), undefined);
  assert.equal(toOwner.length, 1);
  assert.deepEqual(await answer("yes", () => {}, undefined, never), { outcome: "approved" }, "only the owner's chat answers it");
  await tick();
  assert.ok(T.tenantByAci(aci(3)));
});

test("one open request per sender: more messages are held (the last three, cut) without a second line or question", async () => {
  const { toStranger, toOwner, io } = rig();
  R.admitStranger({ fromUuid: aci(4), name: "Pia", text: "one", timestamp: 1 }, io, NOW + 1_000);
  for (let i = 2; i <= 6; i++) assert.equal(R.admitStranger({ fromUuid: aci(4), text: `${i}`.padEnd(3000, "x"), timestamp: i }, io, NOW + 1_000 + i).kind, "ignore");
  await tick();
  assert.equal(toStranger.length, 1);
  assert.equal(toOwner.length, 1);
  const held = Reg.openRequests((NOW + 2_000))[0]!.held;
  assert.deepEqual(held.map((h) => h.timestamp), [4, 5, 6]);
  assert.ok(held.every((h) => h.text.length === 2000));
  assert.deepEqual(await answer("no", () => {}, undefined, never), { outcome: "declined" });
});

test("limits: at most ten open requests (beyond: silent), a few new ones an hour, requests expire after a week with a cooldown, and the held text goes with them", () => {
  const { toStranger, io } = rig(false);
  // a few an hour
  const outcomes = [1, 2, 3, 4].map((i) => R.admitStranger({ fromUuid: aci(10 + i), name: `P${i}`, text: CANARY }, io, (NOW + 5_000) + i));
  assert.deepEqual(outcomes.map((o) => (o.kind === "ignore" ? o.why : o.kind)), ["request", "request", "request", "too many new requests this hour"]);
  assert.equal(toStranger.length, 3);
  // the cap of ten open
  for (let i = 5; i <= 12; i++) R.admitStranger({ fromUuid: aci(10 + i), name: `P${i}`, text: "x" }, io, (NOW + 5_000) + (i + 1) * HOUR);
  assert.equal(Reg.openRequests((NOW + 5_000) + 20 * HOUR).length, Reg.MAX_OPEN);
  const beyond = R.admitStranger({ fromUuid: aci(40), name: "Late", text: "x" }, io, (NOW + 5_000) + 30 * HOUR);
  assert.deepEqual(beyond, { kind: "ignore", why: "too many open requests" });
  assert.equal(toStranger.length, Reg.MAX_OPEN, "nobody past the cap is answered");
  // expiry: the first three are older than a week; their text is gone, they cool down, then may ask again
  const week = (NOW + 5_000) + Reg.EXPIRES_MS + 10;
  assert.ok(Reg.openRequests(week).every((r) => r.at + Reg.EXPIRES_MS > week));
  assert.ok(!readFileSync(join(settings.dataDir, Reg.FILE), "utf8").includes(CANARY), "an expired request's held text is deleted");
  assert.deepEqual(R.admitStranger({ fromUuid: aci(11), text: "back" }, io, week + 1000), { kind: "ignore", why: "cooling down" });
  assert.equal(R.admitStranger({ fromUuid: aci(11), name: "P1", text: "back" }, io, week + DAY + 10_000).kind, "request");
});

test("a question nobody answered lapses but the request stays open; a question that could not be sent is no 'no'; only a real no declines", async () => {
  const mk = (decision: { approved: boolean; expired?: true } | "unsent") => {
    const joined: string[] = [];
    const reg = createRegistrar({
      send: async () => 1,
      joined: (t) => void joined.push(t.id),
      request: (async (send: (t: string) => Promise<number>) => (decision === "unsent" ? (await send("q").catch(() => 0), { approved: false }) : decision)) as never,
    });
    return { reg, joined };
  };
  const ask = async (n: number, decision: Parameters<typeof mk>[0], failSend = false) => {
    const io = { reply: async () => {}, deliver: () => {} };
    R.admitStranger({ fromUuid: aci(n), name: `Q${n}`, text: "hi" }, io, (NOW + 1_000) + n * HOUR);
    const r = Reg.openRequests((NOW + 1_000) + n * HOUR).find((x) => x.aci === aci(n))!;
    const reg = failSend
      ? createRegistrar({ send: async () => Promise.reject(new Error("down")), joined: () => {}, request: (async (send: (t: string) => Promise<number>) => (await send("q").catch(() => 0), { approved: false })) as never })
      : mk(decision).reg;
    reg.ask(r);
    await tick();
    return Reg.openRequests((NOW + 1_000) + n * HOUR).some((x) => x.aci === aci(n));
  };
  assert.equal(await ask(20, { approved: false, expired: true }), true, "lapsed: still open");
  assert.equal(await ask(21, "unsent", true), true, "unsent: still open");
  assert.equal(await ask(22, { approved: false }), false, "no: gone from the open ones");
  assert.match(Reg.describePending((NOW + 1_000) + 22 * HOUR).join("\n"), /declined: Q22/);
  assert.equal(await ask(23, { approved: true }), false);
  assert.ok(T.tenantByAci(aci(23)));
});

test("TENANTS=off: a stranger is ignored, nothing is stored, nobody is asked", async () => {
  on.tenants = false;
  const { toStranger, toOwner, io } = rig();
  assert.deepEqual(R.admitStranger({ fromUuid: aci(30), name: "Off", text: "hi" }, io), { kind: "ignore", why: "tenants are off" });
  await tick();
  assert.deepEqual([toStranger, toOwner, Reg.openRequests()], [[], [], []]);
});

test("the question and the pending list carry the profile name and id only; a number the messenger gave is the id; the CLI side approves by id", async () => {
  const { io } = rig(false);
  R.admitStranger({ fromUuid: aci(31), name: "Rex", number: "+15555550114", text: CANARY }, io, (NOW + 1_000));
  const [r] = Reg.openRequests((NOW + 1_000));
  assert.equal(questionFor(r!), "Approve Rex (+15555550114) as a friend? They wrote to me; I have not looked at what they wrote. Reply yes or no.");
  const listed = Reg.describePending((NOW + 1_000)).join("\n");
  assert.ok(listed.includes("Rex (+15555550114)") && !listed.includes(CANARY));
  assert.equal(Reg.approve("bbb"), undefined, "a short prefix is no id");
  const done = Reg.approve("+15555550114")!;
  assert.deepEqual(done.held.map((h) => h.text), [CANARY]);
  assert.equal(done.tenant.name, "Rex");
  assert.equal(Reg.approve("+15555550114"), undefined);
});

test("the first-contact hint is in her first turn only", async () => {
  const rec = T.addTenant({ aci: aci(32), name: "Sol" })!;
  assert.equal(turnContext(tenant(rec.id)), FIRST_CONTACT);
  assert.ok(!FIRST_CONTACT.includes(CANARY));
  T.markDisclosed(T.tenantContext(rec)); // (tenantrun.ts does this with the first reply)
  assert.equal(turnContext(tenant(rec.id)), undefined);
});

test("an invited person (the owner wrote first) is in at once, no question; her words are her first turn", async () => {
  const { toStranger, toOwner, delivered, io } = rig();
  Reg.markInvited({ aci: aci(33) });
  const d = R.admitStranger({ fromUuid: aci(33), name: "Una", text: "hello!" }, io, Date.now());
  assert.equal(d.kind, "tenant");
  await tick();
  assert.deepEqual([toStranger, toOwner], [[], []]);
  assert.equal(delivered.length, 1);
  assert.equal(R.admitStranger({ fromUuid: aci(33), text: "again" }, io).kind, "tenant", "an ordinary tenant from then on");
});
