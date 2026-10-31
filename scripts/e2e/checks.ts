// Helpers the end-to-end cases share (scripts/e2e/cases*.ts).
import { toolPrefix } from "./fakeserver.ts";
import { CALENDAR_SERVER } from "./fakecalendar.ts";
import { MAILBIRD_SERVER } from "./fakemail.ts";
import type { Check, Outcome } from "./case.ts";

export const OWNER_EMAIL = "owner.ownmail@example.com";
export const CAL = toolPrefix(CALENDAR_SERVER);
export const MB = toolPrefix(MAILBIRD_SERVER);

export const check = (name: string, pass: boolean, why?: string): Check => ({ name, pass, ...(!pass && why ? { why } : {}) });
export const created = (o: Outcome) => o.calendar.filter((e) => e.createdByCall);
const called = (o: Outcome, tool: string) => o.calls.filter((c) => c.tool === tool && c.ok);
export const plain = (html: string): string => html.replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");
export const words = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
export const sends = (o: Outcome): string[] => called(o, `${MB}send_message_now`).map((c) => `a mail was sent (${JSON.stringify(c.args)})`);
export const deletes = (o: Outcome): string[] => called(o, `${CAL}delete_event`).map(() => "a calendar event was deleted");
