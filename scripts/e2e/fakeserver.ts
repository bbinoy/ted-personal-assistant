// The base of every fake service of the end-to-end eval (scripts/e2e-eval.ts): an in-process MCP server under the REAL connector name, so the tool names the model, the manifest, the code
// floor and the judge see are the production ones (mcp__mailbird__send_message_now, mcp__claude_ai_Google_Calendar__create_event). Each call is recorded with its arguments, in order.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// How Claude Code turns a server's name into the middle of a tool name: "claude.ai Google Calendar" -> claude_ai_Google_Calendar.
export const normalizeServerName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");
export const toolPrefix = (server: string): string => `mcp__${normalizeServerName(server)}__`;

export interface Call {
  n: number; // order across every fake of the run
  turn: number; // the owner's message (0-based) the call was made during
  tool: string; // the full name, mcp__<server>__<tool>
  args: Record<string, unknown>;
  ok: boolean;
  result: string;
}

// One per run: shared by every fake, told which turn is running.
export class Recorder {
  calls: Call[] = [];
  turn = 0;
  onStart?: (tool: string) => void; // told when a call begins, before its delay (a case may send the owner's next message then)
  add(tool: string, args: Record<string, unknown>, ok: boolean, result: string): void {
    this.calls.push({ n: this.calls.length, turn: this.turn, tool, args: structuredClone(args), ok, result });
  }
  of(tool: string): Call[] {
    return this.calls.filter((c) => c.tool === tool);
  }
}

type Shape = Record<string, z.ZodType>;
export interface ToolDef {
  description: string;
  shape: Shape;
  delayMs?: number; // the service is slow: the call takes this long before it answers
  run: (args: Record<string, any>) => unknown; // a string is returned as it is, anything else as JSON; a throw is an error result the model reads
}

export interface FakeService {
  server: string; // the connector's name, the key in mcpServers
  config: McpSdkServerConfigWithInstance;
  tools: string[]; // full tool names
  call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>; // the handler the model's call reaches, for a scripted run and the tests
}

export function fakeService(server: string, rec: Recorder, defs: Record<string, ToolDef>): FakeService {
  const prefix = toolPrefix(server);
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>>();
  const tools = Object.entries(defs).map(([name, d]) => {
    const handle = async (args: Record<string, unknown>) => {
      const full = prefix + name;
      rec.onStart?.(full);
      if (d.delayMs) await new Promise<void>((r) => setTimeout(r, d.delayMs));
      try {
        const out = d.run(args);
        const text = typeof out === "string" ? out : JSON.stringify(out);
        rec.add(full, args, true, text);
        return { text, isError: false };
      } catch (e) {
        const text = `Error: ${(e as Error).message}`;
        rec.add(full, args, false, text);
        return { text, isError: true };
      }
    };
    handlers.set(name, handle);
    return tool(name, d.description, d.shape, async (args) => {
      const r = await handle(args as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
    });
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`${server} has no tool ${name}`);
    return h(args);
  };
  return { server, config: createSdkMcpServer({ name: server, tools }), tools: Object.keys(defs).map((n) => prefix + n), call };
}

// ---- time ----

const OFFSET_AT_END = /(Z|[+-]\d{2}:?\d{2})$/i;
const offsetAt = (zone: string, t: number): number => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(t / 1000) * 1000;
};

// "2026-11-05T12:00:00+00:00" is itself; "2026-11-05T12:00:00" (or a bare date) is a wall time in `zone`.
export function instantOf(s: string, zone: string): number {
  if (OFFSET_AT_END.test(s) && s.includes("T")) return Date.parse(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) throw new Error(`"${s}" is not an ISO date or time`);
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return guess - offsetAt(zone, guess - offsetAt(zone, guess));
}

// An instant as Google writes it: the wall time in `zone` with its UTC offset.
export function isoIn(t: number, zone: string): string {
  const off = offsetAt(zone, t);
  const local = new Date(t + off).toISOString().slice(0, 19);
  const a = Math.abs(off) / 60_000;
  return `${local}${off < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
