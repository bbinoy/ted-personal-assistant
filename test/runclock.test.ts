import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The clock is told by the one run path (agent.ts runTurn), not by each caller: every run gets exactly one CURRENT TIME line in the message (not the cached system prompt),
// in its conversation's own zone, taken when the run starts, and the experts it delegates to are told it too.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "runclock-"));

const { settings } = await import("../src/core/settings.ts");
const { clockLine } = await import("../src/core/brief.ts");
const { systemZone } = await import("../src/core/timezone.ts");
const { owner, group, tenant } = await import("../src/conversation/conversationmodel.ts");
const { runConversation, runLook } = await import("../src/run/agent.ts");
const { LOGIN } = await import("../src/tenants/payer.ts");
const T = await import("../src/tenants/tenants.ts");

(settings as unknown as { warm: boolean }).warm = false;

const AT = new Date("2026-10-20T23:30:00Z");
const prompts: string[] = [];
const textOf = async (p: any): Promise<string> => (typeof p === "string" ? p : String((await p[Symbol.asyncIterator]().next()).value.message.content)); // (the owner's prompt is a message stream)
const query = ((p: { prompt: unknown }) => (
  (async function* () {
    prompts.push(await textOf(p.prompt));
    yield { type: "result", subtype: "success", is_error: false, result: "[[silent]]", session_id: "s", total_cost_usd: 0, structured_output: { message: "[[silent]]", nextCheckMinutes: 30 } };
  })()
)) as never;
const facts = { blocks: [], status: [], untrusted: false, done: () => {}, onDelegate: () => {}, onTool: () => {}, routines: "" } as never;

test("owner, friend, group and look: exactly one CURRENT TIME line, in the conversation's zone", async () => {
  const rec = T.addTenant({ aci: "00000000-0000-4000-8000-0000000000bb", name: "Bea" })!;
  T.setTimeZone(rec.id, "Pacific/Auckland");
  const sys = systemZone();
  const runs: [string, () => Promise<unknown>, string][] = [
    ["owner", () => runConversation(owner(), { now: AT }, () => ({ prompt: "hi" }), undefined, { query }), sys],
    ["friend", () => runConversation(tenant(rec.id), { now: AT, apiKey: "test-key" }, () => ({ prompt: "hi" }), undefined, { query }), "Pacific/Auckland"],
    ["group", () => runConversation(group("g-clock"), { now: AT }, () => ({ prompt: "hi" }), undefined, { query }), sys],
    ["look", () => runLook(owner(), LOGIN, () => ({ prompt: "check" }), async () => ({ approved: false }), { facts }, { now: AT, io: { query } }), sys],
  ];
  for (const [name, run, zone] of runs) {
    prompts.length = 0;
    await run();
    const got = prompts[0]!.split("\n").filter((l) => l.startsWith("CURRENT TIME:"));
    assert.deepEqual(got, [clockLine(AT, zone)], `${name}: one clock line, in the conversation's zone`);
    assert.ok(prompts[0]!.indexOf("CURRENT TIME:") < prompts[0]!.lastIndexOf(name === "look" ? "check" : "hi"), `${name}: before the message`);
  }
});

test("the clock is taken as each run starts, not once", async () => {
  prompts.length = 0;
  await runConversation(owner(), { now: new Date("2026-10-20T10:00:00Z") }, () => ({ prompt: "a" }), undefined, { query });
  await runConversation(owner(), { now: new Date("2026-10-21T10:00:00Z") }, () => ({ prompt: "b" }), undefined, { query });
  assert.notEqual(prompts[0]!.match(/CURRENT TIME:[^\n]*/)![0], prompts[1]!.match(/CURRENT TIME:[^\n]*/)![0]);
});
