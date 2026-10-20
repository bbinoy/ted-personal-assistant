// A tiny stdio MCP server standing in for the pinned Google server (taylorwilsdon/google_workspace_mcp, src/modules/google/googlemcp.ts) in tests. It reads the account's
// credentials the way the real one does in single-user mode (<WORKSPACE_MCP_CREDENTIALS_DIR>/<USER_GOOGLE_EMAIL>.json), answers the Gmail and Calendar tools with the
// same kind of plain text, and keeps each account's mailbox in a JSON file (FAKE_GOOGLE_STATE: {"<email>": {"messages": [...]}}) so a test can add mail and see an
// archive. FAKE_GOOGLE_LOG: every call is appended there as one JSON line (tool, arguments, the email it ran as, whether the credentials file held a refresh token).
// Nothing here talks to the network. The tokens in the tests are obviously fake strings.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

interface Msg {
  id: string;
  thread?: string;
  from: string;
  to?: string;
  subject: string;
  date: string;
  body: string;
  labels: string[];
}

const dir = process.env.WORKSPACE_MCP_CREDENTIALS_DIR ?? "";
const email = process.env.USER_GOOGLE_EMAIL ?? "";
const files = dir && existsSync(dir) ? readdirSync(dir) : [];
const creds = files.length ? (JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as Record<string, unknown>) : undefined;
const log = (o: Record<string, unknown>) => process.env.FAKE_GOOGLE_LOG && appendFileSync(process.env.FAKE_GOOGLE_LOG, `${JSON.stringify({ email, pid: process.pid, refresh: creds?.refresh_token, file: files[0], client: process.env.GOOGLE_OAUTH_CLIENT_ID, ...o })}\n`);

const state = (): Record<string, { messages: Msg[] }> => {
  try {
    return JSON.parse(readFileSync(process.env.FAKE_GOOGLE_STATE!, "utf8"));
  } catch {
    return {};
  }
};
const save = (s: ReturnType<typeof state>) => writeFileSync(process.env.FAKE_GOOGLE_STATE!, JSON.stringify(s));
const mine = (): Msg[] => state()[email]?.messages ?? [];

const str = { type: "string" };
const tool = (name: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({ name, description: `fake ${name}`, inputSchema: { type: "object", properties, required } });
const TOOLS = [
  tool("search_gmail_messages", { query: str, page_size: { type: "integer" }, include_headers: { type: "boolean" } }, ["query"]),
  tool("get_gmail_message_content", { message_id: str, full: { type: "boolean" }, body_format: str }, ["message_id"]),
  tool("get_gmail_messages_content_batch", { message_ids: { type: "array" } }),
  tool("get_gmail_thread_content", { thread_id: str }),
  tool("get_gmail_threads_content_batch", { thread_ids: { type: "array" } }),
  tool("list_gmail_labels"),
  tool("draft_gmail_message", { to: str, subject: str, body: str, attachments: { type: "array" } }),
  tool("send_gmail_message", { to: str, subject: str, body: str, thread_id: str, forward_message_id: str, attachments: { type: "array" } }),
  tool("modify_gmail_message_labels", { message_id: str, add_label_ids: { type: "array" }, remove_label_ids: { type: "array" } }, ["message_id"]),
  tool("get_gmail_attachment_content", { message_id: str, attachment_id: str }),
  tool("manage_gmail_filter", { action: str }),
  tool("start_google_auth", { user_google_email: str }),
  tool("list_calendars"),
  tool("get_events", { time_min: str, time_max: str }),
  tool("query_freebusy"),
  tool("manage_event", { action: str, summary: str, start_time: str, end_time: str, attendees: { type: "array" } }, ["action"]),
  tool("_probe"), // not a tool of the real server: shows the test what reached this process
];

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

function call(name: string, a: Record<string, any>) {
  switch (name) {
    case "_probe":
      return ok(JSON.stringify({ email, pid: process.pid, refresh: creds?.refresh_token, client: process.env.GOOGLE_OAUTH_CLIENT_ID, secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, single: process.env.MCP_SINGLE_USER_MODE, hasOpenAi: Object.keys(process.env).filter((k) => /ANTHROPIC|CLAUDE|TENANT/.test(k)) }));
    case "search_gmail_messages": {
      const inbox = /in:inbox/.test(String(a.query));
      const hits = mine().filter((m) => !inbox || m.labels.includes("INBOX"));
      if (!hits.length) return ok(`No messages found for query: '${a.query}'`);
      const lines = [`Found ${hits.length} messages matching '${a.query}':`, "", "📧 MESSAGES:"];
      hits.forEach((m, i) => lines.push(`  ${i + 1}. Message ID: ${m.id}`, `     Subject: ${m.subject}`, `     From: ${m.from}`, `     Date: ${m.date}`, `     Web Link: https://mail.google.com/mail/u/0/#all/${m.id}`, `     Thread ID: ${m.thread ?? m.id}`, ""));
      return ok(lines.join("\n"));
    }
    case "get_gmail_message_content": {
      const m = mine().find((x) => x.id === a.message_id);
      if (!m) return { ...ok(`Message ${a.message_id} not found`), isError: true };
      return ok([`Subject: ${m.subject}`, `From: ${m.from}`, `Date: ${m.date}`, `To: ${m.to ?? email}`, "Cc: [not present in Gmail response]", "", "--- BODY ---", m.body].join("\n"));
    }
    case "modify_gmail_message_labels": {
      const s = state();
      const m = s[email]?.messages.find((x) => x.id === a.message_id);
      if (!m) return { ...ok("no such message"), isError: true };
      m.labels = [...new Set([...m.labels.filter((l) => !(a.remove_label_ids ?? []).includes(l)), ...(a.add_label_ids ?? [])])];
      save(s);
      return ok(`Updated labels of ${m.id}: ${m.labels.join(", ")}`);
    }
    case "send_gmail_message":
      return ok(`Email sent to ${a.to}! Message ID: sent-1`);
    case "draft_gmail_message":
      return ok(`Draft created! Draft ID: draft-1`);
    case "manage_event":
      return ok(`Event ${a.action}d: ${a.summary ?? a.event_id ?? ""}`);
    case "get_events":
      return ok(`Successfully retrieved 1 events for ${email}:\n- "Dentist" Starting 2026-10-21T10:00:00Z, Ending 2026-10-21T11:00:00Z`);
    case "list_calendars":
      return ok(`${email} (primary)`);
    default:
      return ok(`${name}: ok`);
  }
}

const server = new Server({ name: "fake-google", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = (req.params.arguments ?? {}) as Record<string, any>;
  log({ tool: req.params.name, args: req.params.name === "_probe" ? undefined : a });
  return call(req.params.name, a);
});
await server.connect(new StdioServerTransport());
