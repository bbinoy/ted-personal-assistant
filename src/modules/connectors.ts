import { registered } from "./index.ts";
import { readJson, writeJson } from "../core/state.ts";

// Which connectors the last run could actually see. Notion and Google Calendar come through the
// owner's Claude account (settings, then connectors); if one is not connected its tools simply do
// not exist. Knowing that lets the prompts and the brief say "Notion isn't connected" instead of
// the misleading "tasks are not set up", and stops the agent asking the owner to type in what the
// connector would have told it.

const FILE = "state/connectors.json";

interface Connectors {
  at: string;
  notion: boolean;
  calendar: boolean;
  mail: boolean;
  gmail?: boolean; // the claude.ai Gmail connector (MAIL_PROVIDER=gmail)
}

export type Connector = "notion" | "calendar";

export const NAMES: Record<Connector, string> = { notion: "Notion", calendar: "Google Calendar" };
// What the owner loses while a connector is down, in plain words.
export const SKIPPED: Record<Connector, string> = { notion: "tasks and meeting prep pages", calendar: "the calendar review and the meeting list" };

interface ServerStatus {
  name: string;
  status: string;
}

// Pure. A connector is DOWN only when the run's start-up message says so: its server is not
// listed at all (never added to the account), or failed, needs sign-in, or is disabled. Merely
// "pending" is not down: slow servers (Mailbird through npx, a cold connector) are still
// connecting and their tools appear a moment later. Without server info (an older SDK), fall
// back to whether any of its tools were given.
// Which connectors there are, under which name they are recorded, which server name they show up as and which tool prefix they have: each tool module's
// `connection` (src/modules). Notion and Calendar are recorded as "notion" and "calendar", Mailbird as "mail", the Gmail connector as "gmail".
export function detect(tools: readonly string[], servers?: readonly ServerStatus[], at = new Date()): Connectors {
  const hasTool = (prefix: string) => tools.some((t) => t.startsWith(prefix));
  const up = (match: RegExp, toolPrefix: string): boolean => {
    if (!servers) return hasTool(toolPrefix);
    const s = servers.find((x) => match.test(x.name.replace(/^claude\.ai\s+/i, "")));
    return !!s && !["failed", "needs-auth", "disabled"].includes(s.status);
  };
  const seen = registered().flatMap((m) => (m.connection.kind === "connector" && m.connection.key ? [[m.connection.key, up(m.connection.server, m.connection.prefix)] as const] : []));
  return { at: at.toISOString(), ...Object.fromEntries(seen) } as unknown as Connectors;
}

export const recordConnectors = (tools: readonly string[], servers?: readonly ServerStatus[]) => writeJson(FILE, detect(tools, servers));
export const readConnectors = (): Connectors | undefined => readJson<Connectors | undefined>(FILE, undefined);

// Pure: connectors that were missing in the last run. Unknown (no run yet) counts as fine.
export const disconnected = (c: Connectors | undefined): Connector[] => (c ? (["notion", "calendar"] as const).filter((k) => !c[k]) : []);
