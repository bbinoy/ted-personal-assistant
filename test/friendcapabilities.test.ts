import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRIEND_CHAT } from "./runkinds.ts";

// What a friend may use is derived, never stored: every capability but the owner's own (tenants.ts OWNER_ONLY), then what is not set up, what the instance switched off and
// what her tenant.json turned off (capabilities.ts). A new capability therefore reaches every friend by being added to CAPABILITIES, and the owner's own ones never do.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "friendcaps-"));
process.env.GOOGLE_OAUTH_CLIENT_ID = "fake-client-id.example";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "fake-client-secret-not-real";
process.env.INTAKE_BASE_URL = "https://ted.example.test";
process.env.TENANT_ANTHROPIC_API_KEY = "sk-" + "ant-api03-INSTANCEINSTANCEINSTANCE";
for (const name of ["BROWSE", "WEATHER", "DRAW", "DREAM", "WAKEUPS"]) process.env[name] = "on";

const { settings } = await import("../src/core/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { capabilitiesOf, capabilitiesOfRecord, resolveCapabilities, toolsFor } = await import("../src/policy/capabilities.ts");
const { allRows } = await import("../src/policy/toolmanifest.ts");
const { skillsFor } = await import("../src/modules/skills.ts");
const { runFor } = await import("../src/run/runoptions.ts");
const { tenant } = await import("../src/conversation/conversationmodel.ts");

T.ensureOwner({ number: "+15555550114" });
let n = 0;
const friend = () => T.addTenant({ aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name: `Friend${n}` })!;
const registryFile = T.REGISTRY;
const her = (id: string) => capabilitiesOf({ kind: "tenant", tenantId: id });
const ownerOnly = new Set<string>(T.OWNER_ONLY);

test("owner-only is exactly what the login alone gives: admin, profile, card, drive, login", () => {
  assert.deepEqual([...T.OWNER_ONLY].sort(), ["admin", "card", "drive", "login", "profile"]);
  assert.ok(T.OWNER_ONLY.every((c) => T.CAPABILITIES.includes(c)));
  assert.deepEqual(T.FRIEND_CAPABILITIES, T.CAPABILITIES.filter((c) => !ownerOnly.has(c)));
});

test("every capability that is not owner-only is in a friend's effective set (a new capability reaches friends by itself)", () => {
  const set = her(friend().id);
  for (const c of T.CAPABILITIES) if (!ownerOnly.has(c)) assert.ok(set.has(c), `${c} reaches a friend`);
  assert.deepEqual([...set].sort(), T.CAPABILITIES.filter((c) => !ownerOnly.has(c)).sort());
});

test("the owner-only capabilities are never in a friend's set, however the set is built, and the owner has all of hers", () => {
  const rec = friend();
  for (const c of T.OWNER_ONLY) assert.ok(!her(rec.id).has(c), c);
  for (const c of T.OWNER_ONLY) assert.ok(!capabilitiesOfRecord(rec).has(c), c);
  for (const c of T.OWNER_ONLY) assert.ok(!resolveCapabilities(T.CAPABILITIES, { own: {} }).has(c), `${c}: not even when something lists it`);
  const tools = toolsFor(her(rec.id), FRIEND_CHAT);
  for (const row of allRows()) if (ownerOnly.has(row.cap)) assert.ok(!tools.has(row.tool), `${row.tool} (${row.cap}) is not hers`);
  const owner = capabilitiesOf({ kind: "owner" });
  for (const c of T.OWNER_ONLY) assert.ok(owner.has(c), `the owner has ${c}`);
});

test("nothing about a friend's capabilities is stored; a list in an old tenant.json registry is ignored and gone with the next write", () => {
  const rec = friend();
  assert.ok(!("capabilities" in rec));
  const reg = JSON.parse(readFileSync(registryFile, "utf8"));
  reg.tenants.find((t: { id: string }) => t.id === rec.id).capabilities = ["chat", "admin", "card"]; // (what an older version wrote, and a hand edit could add)
  writeFileSync(registryFile, JSON.stringify(reg));
  const set = her(rec.id);
  assert.ok(set.has("mail") && set.has("notion") && !set.has("admin") && !set.has("card"), "the old list neither narrows nor widens");
  T.setStatus(rec.id, "active"); // any write
  assert.ok(!readFileSync(registryFile, "utf8").includes('"capabilities"'), "dropped on the next write");
  assert.ok(!("capabilities" in (T.people().find((r) => r.id === "owner") ?? {})), "the owner's record does not store them either: hers are all of them");
});

test("not set up means nothing: no google, mail, calendar, notion or intake capability, tool, skill, prompt text or connect link", () => {
  const rec = friend();
  const g = settings.google as { clientId?: string; clientSecret?: string };
  const was = { ...g, base: settings.intake.baseUrl };
  const gated = ["google", "mail", "calendar", "notion", "intake"] as const;
  const apiKey = settings.tenantApiKey!;
  try {
    for (const c of gated) assert.ok(her(rec.id).has(c), `${c} is on when set up`);
    assert.ok(toolsFor(her(rec.id), FRIEND_CHAT).has("mcp__google__search_gmail_messages"));
    assert.match(runFor(tenant(rec.id), "message", { apiKey }).systemPrompt as string, /Gmail/);

    g.clientId = undefined; // no OAuth client
    (settings.intake as { baseUrl?: string }).baseUrl = undefined; // and no sign-in page
    const set = her(rec.id);
    for (const c of gated) assert.ok(!set.has(c), `${c} is off when not set up`);
    const tools = [...toolsFor(set, FRIEND_CHAT)];
    assert.deepEqual(tools.filter((t) => /^mcp__(google|notion|intake)__/.test(t)), [], "no tool, so no connect link either");
    assert.deepEqual(skillsFor(set).filter((s) => /mail|calendar|notion|setup/.test(s)), []);
    const o = runFor(tenant(rec.id), "message", { apiKey });
    assert.doesNotMatch((o.systemPrompt as string).replace(/Google Maps|https:\/\/www\.google\.com\/maps\/\S*/g, ""), /Gmail|Google|Notion|setup link/i); // (the shared map-link rule is no connector)
    assert.ok(!(o.tools as ReadonlySet<string>).has("mcp__intake__get_setup_link"));
    assert.ok(her(rec.id).has("chat") && her(rec.id).has("browse"), "everything else is still hers");
  } finally {
    Object.assign(g, was);
    (settings.intake as { baseUrl?: string }).baseUrl = was.base;
  }
});

test("only readiness, the instance switches, her tenant.json and her status narrow it", () => {
  const rec = friend();
  const ctx = T.tenantContext(rec);
  writeFileSync(ctx.configFile, JSON.stringify({ voice: false, browse: false }));
  const set = her(rec.id);
  assert.ok(!set.has("voice") && !set.has("browse") && set.has("mail"));
  writeFileSync(ctx.configFile, "{}");
  T.setStatus(rec.id, "suspended");
  assert.equal(her(rec.id).size, 0, "to stop a friend: suspend her");
  T.setStatus(rec.id, "active");
  assert.ok(her(rec.id).has("mail"));
});

test("the real data is covered: a record written by the older version with a short list now gets the whole set", () => {
  const rec = friend();
  const reg = JSON.parse(readFileSync(registryFile, "utf8"));
  const stored = reg.tenants.find((t: { id: string }) => t.id === rec.id);
  stored.capabilities = ["chat", "browse", "voice", "heartbeat", "dream", "wake", "weather", "draw"];
  writeFileSync(registryFile, JSON.stringify(reg));
  for (const c of T.FRIEND_CAPABILITIES) assert.ok(her(rec.id).has(c), c);
});
