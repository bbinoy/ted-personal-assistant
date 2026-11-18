import { test } from "node:test";
import assert from "node:assert/strict";
import { accountAddresses, cachedAccounts } from "../src/modules/mailbird/accounts.ts";

test("accountAddresses reads the address fields of the account rows, lower case, and nothing else", () => {
  assert.deepEqual(accountAddresses([{ id: 1, name: "Work", email: "Me@Work.example.com" }, { id: 2, emailAddress: "me@home.example.net", displayName: "not an address" }, null]), ["me@work.example.com", "me@home.example.net"]);
  assert.deepEqual(accountAddresses("oops"), []);
  assert.deepEqual(accountAddresses(undefined), []);
});

test("cachedAccounts keeps an answer for the ttl, refreshes after it, and a failure gives none", async () => {
  let t = 0;
  let calls = 0;
  let fail = false;
  const get = cachedAccounts(async () => (calls++, fail ? Promise.reject(new Error("down")) : [{ email: "me@work.example.com" }]), 1000, () => t);
  assert.deepEqual(await get(), ["me@work.example.com"]);
  t = 999;
  await get();
  assert.equal(calls, 1);
  t = 1000;
  fail = true;
  assert.deepEqual(await get(), [], "an unconfirmed address stays outside");
  fail = false;
  assert.deepEqual(await get(), ["me@work.example.com"], "tried again at the next call");
});
