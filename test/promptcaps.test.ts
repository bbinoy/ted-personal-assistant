import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The prompt promises what the run has: the flags of the group's and the friend's prompts come from the capability set the run's tools come from, and the
// voice rule is a template, not a string replaced in another prompt.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "promptcaps-"));
process.env.TENANT_ANTHROPIC_API_KEY = "instance-key-for-prompt-tests";

const { settings } = await import("../src/settings.ts");
const T = await import("../src/tenants/tenants.ts");
const { capabilitiesOf } = await import("../src/policy/capabilities.ts");
const { runOptionsFor } = await import("../src/runoptions.ts");
const { group, tenant } = await import("../src/conversation.ts");
const { groupSystem, tenantSystem } = await import("../src/persona.ts");

const on = settings as unknown as Record<string, unknown>;
on.tenants = true;
let n = 0;
function friend(name: string, config?: object) {
  const rec = T.redeemInvite(T.mintInvite("t")!.code, { aci: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name })!;
  T.provision(rec);
  T.recordConsent(T.tenantContext(rec), "Germany");
  if (config) writeFileSync(T.tenantContext(rec).configFile, JSON.stringify(config));
  return rec;
}
const promptOf = (id: string): string => runOptionsFor(tenant(id), { apiKey: "k" }).systemPrompt as string;

test("a friend whose tenant.json turns browsing off is not told she can browse; the others are, with weather and draw by capability", () => {
  const withBrowse = friend("Ada");
  const without = friend("Bo", { browse: false });
  assert.equal(capabilitiesOf({ kind: "tenant", tenantId: without.id }).has("browse"), false);
  assert.match(promptOf(withBrowse.id), /use the browse tool for things behind a web form/);
  assert.doesNotMatch(promptOf(without.id), /use the browse tool|browse tool for things/);
  for (const id of [withBrowse.id, without.id]) {
    assert.match(promptOf(id), /weather tools/);
    assert.match(promptOf(id), /draw tool/);
  }
  const was = settings.draw;
  on.draw = false;
  try {
    assert.doesNotMatch(promptOf(withBrowse.id), /simple picture with the draw tool/, "the instance switched drawing off: not mentioned");
  } finally {
    on.draw = was;
  }
});

test("a group's prompt follows its capability set too", () => {
  const caps = capabilitiesOf({ kind: "group" });
  assert.match(groupSystem({ caps }), /weather tools/);
  assert.match(groupSystem({ caps }), /draw tool/);
  const less = new Set([...caps].filter((c) => c !== "weather" && c !== "browse" && c !== "draw"));
  const text = groupSystem({ caps: less });
  assert.doesNotMatch(text, /weather tools|use the browse tool|simple picture with the draw tool/);
  assert.equal(runOptionsFor(group("g-caps"), {}).systemPrompt, groupSystem({ caps }), "the run builds it from the same set");
});

test("the voice rule is a template with the kind of conversation as flags, and only when the run has the voice tool", () => {
  const tts = settings.tts as unknown as { provider: string };
  const was = tts.provider;
  tts.provider = "qwen";
  try {
    const caps = capabilitiesOf({ kind: "group" });
    assert.match(groupSystem({ caps }), /sets your spoken voice for THIS group only \(a member asks you to talk as them, with their voice note or audio file, or one they reply to\); anyone can ask for the normal voice again\./);
    const f = friend("Cy");
    const hers = tenantSystem({ name: "Cy", consented: true, caps: capabilitiesOf({ kind: "tenant", tenantId: f.id }) });
    assert.match(hers, /sets your spoken voice for THIS chat only \(she asks you to talk as someone, with their voice note or audio file, or one they reply to\); she can ask for the normal voice again\./);
    const mute = friend("Di", { voice: false });
    assert.doesNotMatch(tenantSystem({ name: "Di", consented: true, caps: capabilitiesOf({ kind: "tenant", tenantId: mute.id }) }), /voice tool/);
  } finally {
    tts.provider = was;
  }
});
