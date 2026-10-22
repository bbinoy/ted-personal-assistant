import { loaded, registered } from "./index.ts";
import { kvGet, kvSet } from "../core/instancedb.ts";
import { settings } from "../core/settings.ts";

// Which connectors the last run could actually see. Notion and Google Calendar come through the
// owner's Claude account (settings, then connectors); if one is not connected its tools simply do
// not exist. Knowing that lets the prompts and the brief say "Notion isn't connected" instead of
// the misleading "tasks are not set up", and stops the agent asking the owner to type in what the
// connector would have told it.
//
// Which connectors there are is the tool modules' business (src/modules): each one with a connector connection and a `key` is recorded under that key; one that also says
// what the owner calls it (`label`) and what is lost without it (`skipped`) is reported while it is down. Adding a connector module adds it here, to the prompts, the brief
// and the doctor, with no edit in this file.

const KEY = "connectors"; // (the kv row of instance.db)

// A connector's `key` -> whether the last run saw it; `at` is when.
export type Connectors = { at: string } & { [key: string]: boolean | string | undefined };

export type Connector = string; // a connection.key: "notion", "calendar", "gmail", ...

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
  return { at: at.toISOString(), ...Object.fromEntries(seen) };
}

const SEEN = "connectors-seen"; // (the kv row of the keys of connectors some run has seen working: an optional connector is only ever "down" after that)
export const readSeen = (): string[] => kvGet<string[]>(SEEN, []);
export function recordConnectors(tools: readonly string[], servers?: readonly ServerStatus[]): void {
  const now = detect(tools, servers);
  kvSet(KEY, now);
  const seen = readSeen();
  const added = Object.keys(now).filter((k) => now[k] === true && !seen.includes(k));
  if (added.length) kvSet(SEEN, [...seen, ...added]);
}
export const readConnectors = (): Connectors | undefined => kvGet<Connectors | undefined>(KEY, undefined);

// Did the last run see this connector? Undefined: no run has recorded it yet.
export const connected = (c: Connectors | undefined, key: string): boolean | undefined => (typeof c?.[key] === "boolean" ? (c[key] as boolean) : undefined);

export interface Reported {
  key: string;
  label: string;
  skipped: string;
  optional: boolean; // an extra (Drive, Docs): never reported down unless a run has seen it working (readSeen); the doctor lists it as optional
  mail: boolean; // the mail provider's own connector: the mail checks (runtime.ts) already say whether it is there
}

// The order the owner has always been told them in; connectors not named here follow in module order.
const ORDER = ["notion", "calendar"];

// The connectors worth reporting while they are down: those of the LOADED modules (Gmail only while MAIL_PROVIDER=gmail) that say what they are called and what is lost, and that
// the model is meant to see (a connector hidden by HIDDEN_CONNECTORS, like IBKR by default, is no outage to talk about; the mail provider's is always in use).
export function reportable(): Reported[] {
  const out = loaded().flatMap((m): Reported[] => {
    const c = m.connection;
    if (c.kind !== "connector" || !c.key || !c.skipped) return [];
    if (m.slot !== "mail" && settings.hiddenConnectors.some((h) => c.prefix.startsWith(h))) return [];
    return [{ key: c.key, label: c.label ?? c.key, skipped: c.skipped, optional: !!c.optional, mail: m.slot === "mail" }];
  });
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  return out.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r.key) - rank(b.r.key) || a.i - b.i).map(({ r }) => r);
}

// What the owner calls a connector, and what is lost without it, by its key (the prompts' words). Computed from the modules when read.
const byKey = (field: "label" | "skipped"): Record<string, string> =>
  new Proxy({} as Record<string, string>, {
    get: (_, key) => (typeof key === "string" ? (registered().flatMap((m) => (m.connection.kind === "connector" && m.connection.key === key ? [m.connection[field]] : [])).find(Boolean) ?? key) : undefined),
  });
export const NAMES = byKey("label");
export const SKIPPED = byKey("skipped");

// Pure: connectors that were missing in the last run. Unknown (no run yet) counts as fine, and so does a connector the last run did not record (a module added since).
// An optional connector the owner never connected is silently absent: it is down only if some run saw it working before (`seen`).
export const disconnected = (c: Connectors | undefined, seen: readonly string[] = readSeen()): Connector[] => (c ? reportable().filter((r) => c[r.key] === false && (!r.optional || seen.includes(r.key))).map((r) => r.key) : []);
