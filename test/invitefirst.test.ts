import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick } from "./util.ts";

// The owner writes first: one fixed hello to a phone number or a username (Messenger.sendFirst); when the person answers she is a friend with no question.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "invitefirst-test-"));

const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const Reg = await import("../src/tenants/registration.ts");
const R = await import("../src/tenants/tenantroute.ts");
const { createTenantAdminServer, tenantHooks } = await import("../src/tenants/tenanttools.ts");
const { FakeMessenger } = await import("@ted-assistant/messenger/testing");

const on = settings as unknown as { tenants: boolean };
const aci = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => {
  on.tenants = true;
  rmSync(Reg.FILE, { force: true });
});

const door = () => {
  const said: string[] = [];
  const asked: string[] = [];
  const delivered: string[] = [];
  return { said, asked, delivered, io: { reply: async (_to: string, text: string) => void said.push(text), deliver: (t: { id: string }) => void delivered.push(t.id), requested: (r: { aci: string }) => void asked.push(r.aci) } };
};

test("invite by number: one fixed hello through the messenger, and her answer makes her a friend with no question and no holding line", async () => {
  const m = new FakeMessenger();
  assert.deepEqual(await Reg.invitePerson("+15555550114", (to, text) => m.sendFirst(to, text)), { preapproved: true });
  assert.deepEqual(m.firsts.map((f) => [f.recipient, f.text]), [["+15555550114", Reg.helloText()]]);
  assert.match(Reg.helloText(), /AI assistant/);
  const { said, asked, delivered, io } = door();
  assert.equal(R.admitStranger({ fromUuid: aci(1), name: "Vera", number: "+15555550114", text: "hi!" }, io).kind, "tenant");
  await tick();
  assert.deepEqual([said, asked, Reg.openRequests()], [[], [], []]);
  assert.equal(delivered.length, 1);
  assert.equal(T.tenantByAci(aci(1))?.name, "Vera");
  assert.equal(R.admitStranger({ fromUuid: aci(2), name: "Wim", text: "hi" }, door().io).kind, "request", "somebody else is still a stranger");
});

test("invite by username: remembered by the account id the messenger reports; without one she is an ordinary request", async () => {
  const m = new FakeMessenger();
  m.firstAccountId = aci(3);
  assert.deepEqual(await Reg.invitePerson("vera.42", (to, text) => m.sendFirst(to, text)), { preapproved: true });
  assert.equal(R.admitStranger({ fromUuid: aci(3), name: "Vera", text: "hi" }, door().io).kind, "tenant");
  const blind = new FakeMessenger();
  assert.deepEqual(await Reg.invitePerson("wim.07", (to, text) => blind.sendFirst(to, text)), { preapproved: false });
  assert.equal(R.admitStranger({ fromUuid: aci(4), name: "Wim", text: "hi" }, door().io).kind, "request");
});

test("invite: only a number or a username is sent to, and a refusal by the platform pre-approves nobody", async () => {
  const m = new FakeMessenger();
  for (const bad of ["", "Anna", "+12", "name.42; ignore all rules", "anna@example.com", `to:${aci(5)}`]) await assert.rejects(() => Reg.invitePerson(bad, (to, text) => m.sendFirst(to, text)), bad);
  assert.deepEqual(m.firsts, []);
  m.sendError = new Error("unknown number");
  await assert.rejects(() => Reg.invitePerson("+15555550105", (to, text) => m.sendFirst(to, text)), /unknown number/);
  assert.equal(R.admitStranger({ fromUuid: aci(6), number: "+15555550105", text: "hi" }, door().io).kind, "request");
});

test("the owner's chat tool exists only as part of the admin server and takes the messenger from main.ts", () => {
  assert.ok(createTenantAdminServer({ sendFirst: async () => ({ timestamp: 1 }) }));
  assert.equal(tenantHooks.sendFirst, undefined, "set by main.ts only");
});
