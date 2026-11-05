import { execFile } from "node:child_process";
import { dayIn } from "./timezone.ts";

// The END of the Claude login (a 30-day limit): `claude auth status` prints loginExpiresAt. It is read at most once a day; a failure to read is no fact, silently. Under three days
// away it is a fact line for the owner's runs (CLAUDE.md §1: code computes the fact, the run decides what to say; heartbeat/facts.ts), and a warn line in `npm run doctor`.
const WARN_DAYS = 3;
const DAY = 86_400_000;

let expiresAt: number | undefined;
let readOn: string | undefined; // the local day of the last read

/** The login's end from the text `claude auth status` prints (JSON with loginExpiresAt), or undefined. */
export function parseLoginExpiry(text: string | undefined): number | undefined {
  try {
    const ms = Date.parse((JSON.parse(text ?? "") as { loginExpiresAt?: string }).loginExpiresAt ?? "");
    return Number.isNaN(ms) ? undefined : ms;
  } catch {
    return undefined;
  }
}
const readStatus = (): Promise<string | undefined> => new Promise((done) => execFile("claude", ["auth", "status"], { encoding: "utf8", timeout: 15_000 }, (err, out) => done(err ? undefined : out)));

/** Reads the login's end, at most once per local day (a failed read is no fact, silently). `read`: tests. */
export async function refreshLoginExpiry(now: Date, read: () => Promise<string | undefined> = readStatus): Promise<void> {
  const day = dayIn(now);
  if (readOn === day) return;
  readOn = day;
  expiresAt = parseLoginExpiry(await read().catch(() => undefined));
}
/** Forget what was read (tests). */
export function resetLoginExpiry(): void {
  expiresAt = readOn = undefined;
}

/** True when the login ends in under three days (or has). `at`: epoch ms, also for the doctor. */
export const loginEndsSoon = (at: number | undefined, now: number): boolean => at !== undefined && at - now < WARN_DAYS * DAY;

/** The fact line for the owner's runs, or "" while the login is far from its end or unread. `fix`: the one step. */
export function loginExpiryFact(now: Date, zone: string, fix: string): string {
  if (expiresAt === undefined || !loginEndsSoon(expiresAt, now.getTime())) return "";
  const on = dayIn(new Date(expiresAt), zone);
  return `The Claude login ${expiresAt <= now.getTime() ? "ran out" : "runs out"} on ${on}; after that every run fails until the owner renews it. ${fix} If it is still ahead, mention it in the daily brief.`;
}
