import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A connector that is pending or failed when the first message is due is waited for or reconnected before the model is asked (connectorwait.ts); a run never fails because of it.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "connectorwait-"));
const { settleConnectors, afterConnectors } = await import("../src/run/connectorwait.ts");
const { missingTools } = await import("../src/run/agentrun.ts");
const { OWNER_CHAT, GROUP_CHAT } = await import("./runkinds.ts");

const fake = (steps: { name: string; status: string }[][]) => {
  const calls = { status: 0, reconnect: [] as string[] };
  return {
    calls,
    q: {
      mcpServerStatus: async () => steps[Math.min(calls.status++, steps.length - 1)]!,
      reconnectMcpServer: async (n: string) => void calls.reconnect.push(n),
    } as any,
  };
};
const cal = (status: string) => ({ name: "claude.ai Google Calendar", status });

test("connectors: all connected means no wait and no reconnect", async () => {
  const f = fake([[cal("connected"), { name: "send", status: "connected" }]]);
  await settleConnectors(f.q, 1000, () => {});
  assert.equal(f.calls.status, 1);
  assert.deepEqual(f.calls.reconnect, []);
});

test("connectors: a pending one is waited for; a failed one is reconnected once", async () => {
  const p = fake([[cal("pending")], [cal("pending")], [cal("connected")]]);
  await settleConnectors(p.q, 2000, () => {});
  assert.equal(p.calls.status, 3);
  assert.deepEqual(p.calls.reconnect, []);
  const f = fake([[cal("failed"), { name: "claude.ai Notion", status: "connected" }], [cal("failed"), { name: "claude.ai Notion", status: "connected" }], [cal("connected")]]);
  await settleConnectors(f.q, 2000, () => {});
  assert.deepEqual(f.calls.reconnect, [cal("failed").name]);
});

test("connectors: it gives up after the limit and says so; offline and a broken check never block", async () => {
  const lines: string[] = [];
  const stuck = fake([[cal("pending")]]);
  const t = Date.now();
  await settleConnectors(stuck.q, 600, (l) => lines.push(l));
  assert.ok(Date.now() - t < 2000);
  assert.match(lines.join("\n"), /still not connected.*Google Calendar=pending/);
  const off = fake([[cal("failed"), { name: "claude.ai Notion", status: "failed" }]]);
  await settleConnectors(off.q, 1000, () => {});
  assert.deepEqual(off.calls.reconnect, [], "no network: nothing to mend");
  const broken = { mcpServerStatus: async () => { throw new Error("gone"); }, reconnectMcpServer: async () => {} } as any;
  await settleConnectors(broken, 1000, (l) => lines.push(l));
  assert.match(lines.at(-1)!, /connector check failed: gone/);
});

test("connectors: the owner's prompt is held until the check is done, then goes through unchanged; other runs are untouched", async () => {
  const notion = { name: "claude.ai Notion", status: "connected" };
  const f = fake([[cal("failed"), notion], [cal("connected"), notion]]);
  const g = afterConnectors("hello", OWNER_CHAT);
  const sent = g.bind({ ...f.q, prompt: g.prompt }).prompt as AsyncIterable<any>;
  const got: any[] = [];
  for await (const m of sent) got.push(m);
  assert.equal(got[0].message.content, "hello");
  assert.deepEqual(f.calls.reconnect, [cal("failed").name]);
  const other = afterConnectors("hi", GROUP_CHAT);
  assert.equal(other.prompt, "hi");
});

test("connectors: every wait leaves one log line (which servers, how long); a ready start leaves none", async () => {
  const quiet: string[] = [];
  await settleConnectors(fake([[cal("connected")]]).q, 1000, (l) => quiet.push(l));
  assert.deepEqual(quiet, []);
  const lines: string[] = [];
  await settleConnectors(fake([[cal("pending"), { name: "mailbird", status: "pending" }], [cal("connected"), { name: "mailbird", status: "connected" }]]).q, 2000, (l) => lines.push(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /connectors ready after \d+ ms; had waited for .*mailbird=pending/);
  const silent = { mcpServerStatus: () => new Promise(() => {}), reconnectMcpServer: async () => {} } as any;
  await settleConnectors(silent, 200, (l) => lines.push(l));
  assert.match(lines.at(-1)!, /gave no answer after \d+ ms/, "a status call that never answers is no longer silent");
  const off = fake([[cal("failed"), { name: "claude.ai Notion", status: "failed" }]]);
  await settleConnectors(off.q, 1000, (l) => lines.push(l));
  assert.match(lines.at(-1)!, /no network/);
});

test("connectors: just after the Mac woke the first runs wait longer", async () => {
  const { noteSleep, recentlyWoke } = await import("../src/core/sleep.ts");
  const { connectWaitMs } = await import("../src/run/connectorwait.ts");
  assert.equal(connectWaitMs(), 6000, "no sleep seen: the normal wait");
  noteSleep();
  assert.equal(connectWaitMs(), 30_000, "woke just now: the longer wait");
  assert.ok(recentlyWoke(Date.now() + 9 * 60_000));
  assert.equal(connectWaitMs(Date.now() + 11 * 60_000), 6000, "ten minutes on, back to normal");
});

test("missingTools: names the tools a result says do not exist", () => {
  const content = [
    { type: "tool_result", is_error: true, content: "<tool_use_error>Error: No such tool available: mcp__claude_ai_Google_Calendar__update_event</tool_use_error>" },
    { type: "tool_result", is_error: false, content: "No such tool available: not_an_error" },
    { type: "tool_result", is_error: true, content: [{ type: "text", text: "No such tool available: mcp__x__y" }] },
  ];
  assert.deepEqual(missingTools(content), ["mcp__claude_ai_Google_Calendar__update_event", "mcp__x__y"]);
  assert.deepEqual(missingTools("text"), []);
});
