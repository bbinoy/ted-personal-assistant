import { test } from "node:test";
import assert from "node:assert/strict";
import { accountAddresses, cachedAccounts } from "../src/modules/mailbird/accounts.ts";

test("accountAddresses reads the address fields of the account rows, lower case, and nothing else", () => {
  assert.deepEqual(accountAddresses([{ id: 1, name: "Work", email: "Me@Work.example.com" }, { id: 2, emailAddress: "me@home.example.net", displayName: "not an address" }, null]), ["me@work.example.com", "me@home.example.net"]);
  assert.deepEqual(accountAddresses("oops"), []);
  assert.deepEqual(accountAddresses(undefined), []);
});

test("cachedAccounts keeps a non-empty answer for the ttl; an empty or failed read gives none, is not kept, and waits before the next try", async () => {
  let t = 0;
  let calls = 0;
  let mode: "ok" | "fail" | "empty" = "ok";
  const get = cachedAccounts(async () => (calls++, mode === "fail" ? Promise.reject(new Error("down")) : mode === "empty" ? "error text" : [{ email: "me@work.example.com" }]), 1000, () => t, 100);
  assert.deepEqual(await get(), ["me@work.example.com"]);
  t = 999;
  await get();
  assert.equal(calls, 1);
  t = 1000;
  mode = "fail";
  assert.deepEqual(await get(), [], "an unconfirmed address stays outside");
  t = 1050;
  mode = "ok";
  assert.deepEqual(await get(), [], "within the retry wait: none, and no call");
  assert.equal(calls, 2);
  t = 1100;
  assert.deepEqual(await get(), ["me@work.example.com"], "tried again after the wait");
  t = 2200;
  mode = "empty";
  assert.deepEqual(await get(), [], "a reply with no addresses gives none");
  t = 2300;
  mode = "ok";
  assert.deepEqual(await get(), ["me@work.example.com"], "and is not kept for the ttl");
});
