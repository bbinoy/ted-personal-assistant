import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { offline } from "../modules/connectors.ts";
import { runCapabilities } from "../policy/capabilities.ts";
import type { RunKind } from "../core/runkind.ts";
import { recentlyWoke } from "../core/sleep.ts";

// A connector (claude.ai Calendar, Notion, ...) that was not connected when a process started has no tools in it, and a tool the model calls then is "No such tool available"
// without ever reaching canUseTool. MCP_CONNECTION_NONBLOCKING=false makes the CLI wait for each connector's first dial, but a dial that fails (3 quick retries) or times out leaves
// the server "failed" for the rest of that process. So the first message is held back (the prompt is a generator) until every server is connected: a pending one is waited for, a failed
// one is reconnected (`reconnectMcpServer`), both for at most `ms`. "needs-auth" and "disabled" cannot be mended here. With no network at all (every claude.ai server failed) nothing
// is retried. A run never fails because of this: after the limit the message goes through as before. The same for every server and every run that has connectors.
// Just after the Mac woke (core/sleep.ts) the network and the local servers come back slowly, so the first runs wait longer.
// What the SDK promises: `mcpServerStatus` reports "pending" and nothing more; the tool list of a query is fixed when its CLI process starts, and nothing says a server that connects later adds tools to the query or to the subagents it spawns
// (and a run whose server was pending then did not get it: the 30 Oct brief expert had no mailbird tool). So the first message, and with it every subagent, is held back until the servers are settled (afterConnectors), never mended later.
const CONNECT_WAIT_MS = 6000;
const WAKE_CONNECT_WAIT_MS = 30_000;
const POLL_MS = 250;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const BAD = new Set(["pending", "failed"]);
const names = (servers: readonly { name: string; status: string }[]): string => servers.map((s) => `${s.name}=${s.status}`).join(", ");

export const connectWaitMs = (now: number = Date.now()): number => (recentlyWoke(now) ? WAKE_CONNECT_WAIT_MS : CONNECT_WAIT_MS);

// Every wait leaves one log line (which servers, how long, how it ended), so a run that started before its servers did can be seen in the log.
export async function settleConnectors(q: Pick<Query, "mcpServerStatus" | "reconnectMcpServer">, ms = connectWaitMs(), log: (line: string) => void = console.error): Promise<void> {
  const t0 = Date.now();
  const until = t0 + ms;
  const retried = new Set<string>();
  let waitedFor: { name: string; status: string }[] = [];
  const took = () => `${Date.now() - t0} ms`;
  try {
    for (;;) {
      const servers = await Promise.race([q.mcpServerStatus(), sleep(Math.max(0, until - Date.now())).then(() => undefined)]);
      if (!servers) return log(`run: connector status gave no answer after ${took()}${waitedFor.length ? `; waited for ${names(waitedFor)}` : ""}`);
      if (offline(servers)) return log(`run: no network for the claude.ai connectors (${names(servers)}); not retried`);
      const open = servers.filter((s) => BAD.has(s.status));
      if (!open.length) return waitedFor.length ? log(`run: connectors ready after ${took()}; had waited for ${names(waitedFor)}`) : undefined;
      waitedFor = open;
      for (const s of open) {
        if (s.status !== "failed" || retried.has(s.name)) continue;
        retried.add(s.name);
        void q.reconnectMcpServer(s.name).catch((e: Error) => log(`run: reconnecting ${s.name} failed: ${e.message}`));
      }
      if (Date.now() >= until) return log(`run: still not connected after ${ms} ms: ${names(open)}`);
      await sleep(POLL_MS);
    }
  } catch (e) {
    log(`run: connector check failed: ${(e as Error).message}`); // (never fatal: the message goes through)
  }
}

// The prompt of a run that has connectors, held until they are settled; `bind` gives it the run's Query (the generator is only pulled once the SDK has started it).
export function afterConnectors(prompt: string | AsyncIterable<SDKUserMessage>, kind: RunKind): { prompt: string | AsyncIterable<SDKUserMessage>; bind: <T>(q: T) => T } {
  if (!runCapabilities(kind).has("login")) return { prompt, bind: (q) => q }; // (only the owner's run has connectors)
  let query: Query | undefined;
  const held = (async function* (): AsyncGenerator<SDKUserMessage> {
    await sleep(0); // (after `bind`)
    if (typeof query?.mcpServerStatus === "function") await settleConnectors(query);
    if (typeof prompt === "string") yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: prompt } };
    else yield* prompt;
  })();
  return { prompt: held, bind: (q) => ((query = q as unknown as Query), q) };
}
