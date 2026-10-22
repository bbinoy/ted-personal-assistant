import { existsSync } from "node:fs";
import { ledgerEntries } from "./messages.ts";
import { convPaths, instancePaths, OWNER_CONV } from "./convpaths.ts";
import { instanceDb, kvGet, kvSet } from "./instancedb.ts";
import { settings } from "./settings.ts";

// The welcome: the first thing a new owner hears, once, when a FRESH data folder starts for the first time. Written by code (the persona's name and the owner's, no model), short: what it will do, that it
// starts gently, the three commands worth knowing, and the offer of the setup skill. At most once ever: the decision is written down (the instance.db kv row "welcome") whichever way it went. An install
// that already has history, spend or looks, or whose data folder was moved to the current layout, is not new: it is marked skipped at once and never welcomed later, even if its history is deleted.

export const WELCOME_KEY = "welcome";

export interface WelcomeFacts {
  messages: number; // lines of the owner's conversation log that are conversation (not ledger)
  spend: number; // charged runs on record
  looks: number; // heartbeat looks on record
  migrated: boolean; // the data folder was moved from an older layout (a migration plan exists)
}

/** Pure: is this a data folder nobody has used? */
export const isFresh = (f: WelcomeFacts): boolean => f.messages === 0 && f.spend === 0 && f.looks === 0 && !f.migrated;

export function welcomeText(o: { assistant: string; owner: string; mail: boolean; shadow?: boolean }): string {
  const watch = o.mail ? "your mail, your calendar and your tasks" : "your calendar and your tasks";
  return [
    `Hi${o.owner && o.owner !== "the owner" ? ` ${o.owner}` : ""}, I'm ${o.assistant}. I'm up and running.`,
    `I'll keep an eye on ${watch}, remind you of what's coming and message you only when something needs you.`,
    o.mail && !o.shadow
      ? "I archive newsletters and notifications on my own as your notes say; /today lists everything I did and why."
      : o.mail
      ? "I'm starting gently: for the first days I won't archive anything on my own. I'll show you what I would archive and you tap 👍 (or tell me which to keep), and I learn from that."
      : "I'm starting gently: I'll tell you what I notice and do nothing without your say-so.",
    "Three commands worth knowing:",
    "/status: what I'm up to right now",
    "/pause 2h: stop all my background work for two hours",
    "/today: what I did today, and why",
    "If you'd like, say \"set up\" and I'll walk you through connecting your calendars and how you like to write; it takes a few minutes in this chat.",
  ].join("\n");
}

export function welcomeFacts(): WelcomeFacts {
  const count = (sql: string): number => {
    try {
      return instanceDb().num(sql);
    } catch {
      return 1; // (unreadable: not provably fresh, so not welcomed)
    }
  };
  let messages = 0;
  try {
    messages = ledgerEntries(convPaths(OWNER_CONV).messages).filter((e) => e.kind !== "action" && e.kind !== "wake" && e.kind !== "journal").length;
  } catch {
    messages = 1;
  }
  return { messages, spend: count("SELECT COUNT(*) FROM spend"), looks: count("SELECT COUNT(*) FROM looks"), migrated: existsSync(instancePaths().migrationPlan) };
}

/**
 * Welcome the owner if this is a fresh data folder's first start, once ever. `send` posts to her chat. Returns what happened: "sent", "skipped" (not a fresh folder; written down so it never is), "already" (done
 * before) or "failed" (the send failed: nothing is written down, the next start tries again while the folder is still fresh).
 */
export async function welcomeOnce(send: (text: string) => Promise<unknown>, facts: () => WelcomeFacts = welcomeFacts, now: () => number = Date.now): Promise<"sent" | "skipped" | "already" | "failed"> {
  if (kvGet<{ state?: string } | null>(WELCOME_KEY, null)?.state) return "already";
  if (!isFresh(facts())) return kvSet(WELCOME_KEY, { state: "skipped", at: now() }), "skipped";
  try {
    await send(welcomeText({ assistant: settings.assistant, owner: settings.owner, mail: settings.mail, shadow: settings.shadowMode !== "off" }));
  } catch (e) {
    console.error("welcome: could not be sent:", (e as Error).message);
    return "failed";
  }
  kvSet(WELCOME_KEY, { state: "sent", at: now() });
  return "sent";
}
