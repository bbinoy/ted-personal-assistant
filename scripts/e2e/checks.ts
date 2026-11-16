// Helpers the end-to-end cases share (scripts/e2e/cases*.ts).
import { inflateSync } from "node:zlib";
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
// A PDF's own text and object syntax with its flate streams opened (a tool that rewrites a PDF often compresses the page content and the object streams): for a check that looks for a page's words or counts its pages.
export function pdfInside(bytes: Buffer): string {
  const raw = bytes.toString("latin1");
  const parts = [raw];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const from = m.index + m[0].length;
    const to = raw.indexOf("endstream", from);
    if (to < 0) continue;
    try {
      parts.push(inflateSync(bytes.subarray(from, to)).toString("latin1"));
    } catch {
      // not a flate stream (a picture, a font)
    }
  }
  return parts.join("\n");
}
export const deletes =(o: Outcome): string[] => called(o, `${CAL}delete_event`).map(() => "a calendar event was deleted");
