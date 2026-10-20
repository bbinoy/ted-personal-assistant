import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptOwner } from "../src/conversation/guards.ts";
import { redact } from "../src/core/redact.ts";

const OWNER = "+15555550114";
const OWNER_ACI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRIEND_ACI = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// The registry as the guard sees it: records with a role, found by account id, else by number (tenants.ts resolveSender is the real one, tested in tenants.test.ts).
const records = [
  { role: "admin", status: "active", number: OWNER, aci: OWNER_ACI },
  { role: "member", status: "active", number: undefined, aci: FRIEND_ACI },
];
const resolve = (who: { number?: string; aci?: string }) => records.find((r) => !!who.aci && r.aci === who.aci) ?? records.find((r) => !!who.number && r.number === who.number);

test("allowlist: only the owner's own Note to Self is accepted (messages and reactions alike)", () => {
  assert.equal(acceptOwner({ from: OWNER, direct: true }, resolve), true);
  assert.equal(acceptOwner({ from: OWNER, direct: false }, resolve), false); // owner writing to someone else
  assert.equal(acceptOwner({ from: "+15555550105", direct: true }, resolve), false);
  assert.equal(acceptOwner({ from: "+15555550105", direct: false }, resolve), false); // a friend messaging the owner
  assert.equal(acceptOwner({ from: "", direct: true }, () => undefined), false); // no owner record: nothing is accepted
  assert.equal(acceptOwner({ from: "", direct: true }, resolve), false); // no number and no account id
});

test("allowlist: the account id identifies her when she has one; a member is never the admin; a suspended admin is nobody", () => {
  assert.equal(acceptOwner({ from: "", fromUuid: OWNER_ACI, direct: true }, resolve), true, "the number may be hidden: the account id is enough");
  assert.equal(acceptOwner({ from: "", fromUuid: FRIEND_ACI, direct: true }, resolve), false, "a member is not the admin");
  assert.equal(acceptOwner({ from: OWNER, fromUuid: FRIEND_ACI, direct: true }, resolve), false, "the account id decides first");
  assert.equal(acceptOwner({ from: OWNER, direct: true }, () => ({ role: "admin", status: "suspended" })), false);
});

test("redact: phone numbers and credentials never reach a log", () => {
  assert.equal(redact("dropped message from +15555550105"), "dropped message from +***05");
  assert.equal(redact("key sk-ant-api03-abcdefghijklmnop done"), "key sk-ant-*** done");
  assert.equal(redact("Authorization: Bearer abcDEF123456789xyz"), "Authorization: Bearer ***");
  assert.equal(redact("CLAUDE_CODE_OAUTH_TOKEN=supersecretvalue"), "CLAUDE_CODE_OAUTH_TOKEN=***");
  assert.equal(redact("plain text, 12 items"), "plain text, 12 items");
});

