import { test } from "node:test";
import assert from "node:assert/strict";
import { PURPOSES, purposeAvailable } from "../src/intake/intakepurposes.ts";
import { purposesFor } from "../src/intake/intakelinks.ts";
import { settings } from "../src/core/settings.ts";
import { ITEM_KINDS } from "../src/secrets/secrets.ts";
import { CAPABILITIES } from "../src/tenants/tenants.ts";
import { googleProvider } from "../src/intake/googleoauth.ts";
import { notionProvider } from "../src/intake/notionoauth.ts";
import { connectionServices } from "../src/tenants/connections.ts";

// The purposes and the item kinds are two views of one table: a Purpose says its capability, the kind it writes, what it needs and (for a sign-in) its provider; everything else
// (the page's writer, the OpenBao policies, the doctor's probe, the admin's list) is derived.

test("purposes: every purpose writes a known kind and names a real capability, and every kind has a purpose that writes it", () => {
  for (const [id, p] of Object.entries(PURPOSES)) {
    assert.ok(ITEM_KINDS.includes(p.itemKind), `${id} writes ${p.itemKind}`);
    assert.ok((CAPABILITIES as readonly string[]).includes(p.capability), `${id} needs ${p.capability}`);
  }
  for (const kind of ITEM_KINDS) assert.ok(Object.values(PURPOSES).some((p) => p.itemKind === kind), `a purpose writes ${kind}`);
});

test("purposes: a sign-in purpose has a provider of the same id, which stores into the kind the purpose writes", () => {
  const providers = new Map([googleProvider(), notionProvider()].map((p) => [p.id, p]));
  for (const [id, p] of Object.entries(PURPOSES)) {
    if (!p.oauth) continue;
    assert.equal(p.oauth, id);
    assert.equal(providers.get(p.oauth)?.store.kind, p.itemKind, id);
  }
  assert.deepEqual(connectionServices(["google", "notion", "card", "profile"]).sort(), ["google", "notion"]);
  assert.deepEqual(connectionServices(["card"]), []);
});

test("purposes: one is offered only with its capability and only while its settings are there", () => {
  assert.deepEqual(purposesFor(["profile", "card"]).sort(), ["card", "profile"]);
  assert.deepEqual(purposesFor(["notion"]), ["notion"]);
  const g = settings.google as unknown as Record<string, unknown>;
  const was = { ...g };
  try {
    Object.assign(g, { clientId: undefined, clientSecret: "s" });
    assert.deepEqual(PURPOSES.google!.needs(), ["GOOGLE_OAUTH_CLIENT_ID"]);
    assert.deepEqual(purposesFor(["google"]), []);
    Object.assign(g, { clientId: "i", clientSecret: "s" });
    assert.deepEqual(PURPOSES.google!.needs(), []);
    assert.deepEqual(purposesFor(["google"]), ["google"]);
  } finally {
    Object.assign(g, was);
  }
  assert.equal(purposeAvailable(PURPOSES.notion!), true);
});
