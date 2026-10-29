import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { offline } from "../modules/connectors.ts";
import { runCapabilities } from "../policy/capabilities.ts";
import type { RunKind } from "../core/runkind.ts";

// A connector (claude.ai Calendar, Notion, ...) that was not connected when a process started has no tools in it, and a tool the model calls then is "No such tool available"
// without ever reaching canUseTool. MCP_CONNECTION_NONBLOCKING=false makes the CLI wait for each connector's first dial, but a dial that fails (3 quick retries) or times out leaves
// the server "failed" for the rest of that process. So the first message is held back (the prompt is a generator) until every server is connected: a pending one is waited for, a failed
// one is reconnected (`reconnectMcpServer`), both for at most `ms`. "needs-auth" and "disabled" cannot be mended here. With no network at all (every claude.ai server failed) nothing
// is retried. A run never fails because of this: after the limit the message goes through as before. The same for every server and every run that has connectors.
const CONNECT_WAIT_MS = 6000;
const POLL_MS = 250;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const BAD = new Set(["pending", "failed"]);

export async function settleConnectors(q: Pick<Query, "mcpServerStatus" | "reconnectMcpServer">, ms = CONNECT_WAIT_MS, log: (line: string) => void = console.error): Promise<void> {
  const until = Date.now() + ms;
  const retried = new Set<string>();
  try {
    for (;;) {
      const servers = await Promise.race([q.mcpServerStatus(), sleep(Math.max(0, until - Date.now())).then(() => undefined)]);
      if (!servers || offline(servers)) return;
      const open = servers.filter((s) => BAD.has(s.status));
      if (!open.length) return;
      for (const s of open) {
        if (s.status !== "failed" || retried.has(s.name)) continue;
        retried.add(s.name);
        void q.reconnectMcpServer(s.name).catch((e: Error) => log(`run: reconnecting ${s.name} failed: ${e.message}`));
      }
      if (Date.now() >= until) return log(`run: still not connected after ${ms} ms: ${open.map((s) => `${s.name}=${s.status}`).join(", ")}`);
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
