import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The registration store on its own (src/tenants/registration.ts), the edges registration.test.ts does not walk: what an id may name, what approving and declining leave
// behind, the invited list, and the owner's fixed hello. A stranger's words are held as data and reach no model: nothing here has a model to call.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "registration-store-test-"));

const T = await import("../src/tenants/tenants.ts");
const Reg = await import("../src/tenants/registration.ts");
const { readAudit } = await import("../src/core/audit.ts");

const aci = (n: number, prefix = "cccccccc") => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.now();
const DAY = 24 * 3600_000;
const CANARY = "CANARY-HELD-TEXT-5521";
const file = () => readFileSync(Reg.FILE, "utf8");

beforeEach(() => rmSync(Reg.FILE, { force: true }));

test("a stranger's name is cleaned to a short plain label; her words are held (the last three, cut) and never in the pending list or the audit row", () => {
  const first = Reg.register({ aci: aci(1), name: "  Mal<script>\n\"ice\"  ".padEnd(80, "x"), text: CANARY, timestamp: 1 }, NOW);
  assert.equal(first.kind, "new");
  const r = (first as { request: import("../src/tenants/registration.ts").Request }).request;
  assert.match(r.name, /^[\p{L}\p{N} .'_-]{1,40}$/u);
  assert.ok(!r.name.includes("<") && !r.name.includes("\n"));
  assert.equal(Reg.cleanName(undefined), "unknown name");
  for (let i = 0; i < 5; i++) assert.equal(Reg.register({ aci: aci(1), text: `${CANARY}-${i}-${"y".repeat(5000)}`, timestamp: 10 + i }, NOW).kind, "held");
  const [open] = Reg.openRequests(NOW);
  assert.deepEqual(open!.held.map((h) => h.timestamp), [12, 13, 14], "the last three");
  assert.ok(open!.held.every((h) => h.text.length <= 2000));
  assert.ok(!Reg.describePending(NOW).join("\n").includes(CANARY));
  const rows = JSON.stringify(readAudit((e) => e.tool === "tenant_register"));
  assert.ok(!rows.includes(CANARY) && !rows.includes("Mal"), "the audit row has an id, not her name or text");
});

test("an id names one person: a short prefix, an unknown id, or a prefix two people share approves, declines and forgets nobody, and changes nothing", () => {
  Reg.register({ aci: aci(2, "dddddddd"), name: "Una", text: "a", timestamp: 1 }, NOW);
  Reg.register({ aci: aci(3, "dddddddd"), name: "Vic", text: "b", timestamp: 2 }, NOW + 1000);
  const before = file();
  for (const id of ["", "ddddd", "dddddd", "dddddddd", "eeeeeeee", "+10000000004"]) {
    assert.equal(Reg.approve(id, NOW + 2000), undefined, `approve ${id}`);
    assert.equal(Reg.decline(id, NOW + 2000), false, `decline ${id}`);
    assert.equal(Reg.forget(id, NOW + 2000), false, `forget ${id}`);
  }
  assert.equal(file(), before);
  assert.equal(T.tenantByAci(aci(2, "dddddddd")), undefined);
  // the whole account id is unique
  const done = Reg.approve(aci(2, "dddddddd"), NOW + 3000)!;
  assert.equal(done.tenant.name, "Una");
  assert.deepEqual(done.held.map((h) => h.text), ["a"]);
  assert.deepEqual(Reg.openRequests(NOW + 3000).map((r) => r.name), ["Vic"], "hers is gone, his is not");
});

test("approving or declining twice does nothing the second time, and a declined person approved later is let in with no held text", () => {
  Reg.register({ aci: aci(4), name: "Wes", text: CANARY, timestamp: 1 }, NOW);
  assert.equal(Reg.decline("cccccccc", NOW), true);
  assert.equal(Reg.decline("cccccccc", NOW), false);
  assert.ok(!file().includes(CANARY), "the held text went with the no");
  assert.deepEqual(Reg.register({ aci: aci(4), text: "please", timestamp: 2 }, NOW), { kind: "drop", why: "declined" });
  const late = Reg.approve("cccccccc", NOW)!;
  assert.deepEqual(late.held, []);
  assert.equal(late.request, undefined);
  assert.equal(Reg.approve("cccccccc", NOW), undefined);
  assert.equal(readAudit((e) => e.tool === "tenant_register" && e.decision === "approved").length >= 1, true);
});

test("an approval that cannot make a tenant (she already is one) leaves the request where it was", () => {
  const rec = T.addTenant({ aci: aci(5), name: "Xan" }, NOW)!;
  Reg.register({ aci: aci(5), name: "Xan", text: "hi", timestamp: 1 }, NOW);
  assert.equal(Reg.approve("cccccccc", NOW), undefined);
  assert.equal(Reg.openRequests(NOW).length, 1);
  assert.ok(T.tenantById(rec.id));
});

test("invited: one hello makes one reply a friend, by account id or by number, for a month; the list is bounded", () => {
  Reg.markInvited({ aci: aci(6).toUpperCase() }, NOW);
  assert.equal(Reg.takeInvited({ aci: aci(7) }, NOW), false, "somebody else");
  assert.equal(Reg.takeInvited({ aci: aci(6) }, NOW), true, "the account id, whatever its case");
  assert.equal(Reg.takeInvited({ aci: aci(6) }, NOW), false, "used up");
  Reg.markInvited({ number: "+10000000002" }, NOW);
  assert.equal(Reg.takeInvited({ aci: aci(8), number: "+10000000002" }, NOW), true, "by number, when the messenger gives it");
  Reg.markInvited({ aci: aci(9) }, NOW);
  assert.equal(Reg.takeInvited({ aci: aci(9) }, NOW + 31 * DAY), false, "a month later it has lapsed");
  for (let i = 0; i < 60; i++) Reg.markInvited({ aci: aci(100 + i) }, NOW);
  assert.equal(Reg.takeInvited({ aci: aci(100) }, NOW), false, "the oldest were dropped");
  assert.equal(Reg.takeInvited({ aci: aci(159) }, NOW), true);
});

test("the owner's hello: only a number or a username, only the fixed text, and only a reply from someone we can recognise is pre-approved", async () => {
  const sent = [] as { to: string; text: string }[];
  const send = (accountId?: string) => async (to: string, text: string) => (sent.push({ to, text }), { timestamp: 1, accountId });
  for (const bad of ["", "ann", "+0123", "15555550114", "ann.4 ; rm", "+1000000000599999999"]) {
    await assert.rejects(Reg.invitePerson(bad, send(), NOW), /phone number/, bad);
  }
  assert.equal(sent.length, 0, "nothing was sent to a recipient that is not one");
  assert.deepEqual(await Reg.invitePerson("ann.42", send(), NOW), { preapproved: false }); // (a username the messenger could not resolve: the ordinary request)
  assert.deepEqual(await Reg.invitePerson("ann.42", send(aci(10)), NOW), { preapproved: true });
  assert.deepEqual(await Reg.invitePerson("+10000000003", send(), NOW), { preapproved: true });
  assert.equal(sent.length, 3);
  assert.ok(sent.every((s) => s.text === Reg.helloText()), "the fixed hello and nothing else");
  assert.equal(Reg.takeInvited({ aci: aci(10) }, NOW), true);
  assert.equal(Reg.takeInvited({ aci: aci(11), number: "+10000000003" }, NOW), true);
  assert.equal(Reg.isRecipient("+10000000003") && Reg.isRecipient("ann.42") && !Reg.isRecipient("ann"), true);
});
