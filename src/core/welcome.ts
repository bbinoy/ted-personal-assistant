import { ledgerEntries } from "./messages.ts";
import { convPaths, OWNER_CONV } from "./convpaths.ts";
import { instanceDb, kvGet, kvSet } from "./instancedb.ts";
import { settings } from "./settings.ts";

// The welcome: a FACT for the owner's first run (her first chat turn or first look) on a fresh data folder: "this is a fresh install, introduce yourself". The run writes the words, in its own voice. At most once
// ever: the decision is written down at the first start (the instance.db kv row "welcome": pending, told or skipped) and handed over once. An install that already has history, spend or looks, or whose data
// folder was moved to the current layout, is not new: it is marked skipped at once and never welcomed later, even if its history is deleted.

export const WELCOME_KEY = "welcome";

export interface WelcomeFacts {
  messages: number; // lines of the owner's conversation log that are conversation (not ledger)
  spend: number; // charged runs on record
  looks: number; // heartbeat looks on record
}

/** Pure: is this a data folder nobody has used? */
export const isFresh = (f: WelcomeFacts): boolean => f.messages === 0 && f.spend === 0 && f.looks === 0;

function welcomeFact(o: { owner: string; mail: boolean }): string {
  const watch = o.mail ? "mail, calendar and tasks" : "calendar and tasks";
  return `This is a fresh install and your first run with ${o.owner}: introduce yourself briefly, in your own voice. Say what you will do (keep an eye on their ${watch}, remind them of what is coming, message only when something needs them)${
    o.mail ? "; that you archive routine mail (newsletters, notifications) on your own as their notes say and that /today lists everything you did and why" : ""
  }. Name the commands /status (what you are up to), /pause 2h (stop all background work for two hours) and /today (what you did today, and why). Offer the setup skill: if they say "set up" you walk them through connecting their calendars and how they like to write. If they asked something in this run, answer that first.`;
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
  return { messages, spend: count("SELECT COUNT(*) FROM spend"), looks: count("SELECT COUNT(*) FROM looks") };
}

/** At the start: write down whether this data folder is fresh (pending) or not (skipped), once ever. */
export function welcomeStart(facts: () => WelcomeFacts = welcomeFacts, now: () => number = Date.now): void {
  if (!kvGet<{ state?: string } | null>(WELCOME_KEY, null)?.state) kvSet(WELCOME_KEY, { state: isFresh(facts()) ? "pending" : "skipped", at: now() });
}

/** The fact for the owner's first run, once ever (the row turns from pending to told as it is handed over); "" at every other time. */
export function takeWelcome(now: () => number = Date.now): string {
  if (kvGet<{ state?: string } | null>(WELCOME_KEY, null)?.state !== "pending") return "";
  kvSet(WELCOME_KEY, { state: "told", at: now() });
  return welcomeFact({ owner: settings.owner, mail: settings.mail });
}
