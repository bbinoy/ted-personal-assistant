import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { emitRecord } from "../../core/events.ts";
import { liveConvDb } from "../../core/convdb.ts";
import { convIdOfKey } from "../../core/convpaths.ts";
import { settings } from "../../core/settings.ts";
import { cleanMeeting, HORIZON_MS, MAX_ATTENDEES, MAX_MEETINGS, recordMeetings, type Meeting, type RawMeeting } from "../../tasks/meetings.ts";

// note_upcoming_meetings: the heartbeat look tells code which meetings are coming up (tasks/meetings.ts says what is kept and what the rules are). ONE server per run, closed over ONE
// conversation (its key is never a parameter): the call writes the `meetings` table of THAT conversation's assistant.db and nothing else, so a friend's look cannot reach the owner's rows
// or the other way round (test/meetingprep.test.ts). Own data, nothing to approve. Code validates every field; a meeting it cannot keep is named in the answer so the model can fix the call.

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

export interface MeetingsRun {
  key: string; // the conversation's key: "owner" or "tenant:<id>"
  now?: () => number;
}

/** The call's work, apart from the SDK (the tests call it directly). */
export function noteMeetings(run: MeetingsRun, raw: RawMeeting[]): { text: string; isError?: boolean } {
  const now = run.now?.() ?? Date.now();
  if (settings.prepMinutes <= 0) return { text: "Meeting prep is switched off, so nothing was recorded." };
  const kept: Meeting[] = [];
  const problems: string[] = [];
  for (const r of raw.slice(0, MAX_MEETINGS)) {
    const c = cleanMeeting(r, now);
    if ("error" in c) problems.push(c.error);
    else if (!kept.some((k) => k.eventId === c.meeting.eventId && k.startMs === c.meeting.startMs)) kept.push(c.meeting);
  }
  if (raw.length > MAX_MEETINGS) problems.push(`only the first ${MAX_MEETINGS} meetings are taken`);
  const db = liveConvDb(convIdOfKey(run.key));
  if (!db) return { text: "Could not record the meetings (this conversation's database is not available now). Nothing was changed.", isError: true };
  try {
    const r = recordMeetings(db, kept, now);
    emitRecord("note_upcoming_meetings", "recorded", run.key === "owner" ? "background" : "group", { stored: r.stored, removed: r.removed, refused: problems.length });
    return { text: `Recorded ${r.stored} upcoming meeting(s)${r.removed ? `, replacing ${r.removed} earlier one(s)` : ""}.${problems.length ? `\nNot recorded:\n- ${problems.join("\n- ")}` : ""}` };
  } catch (e) {
    console.error(`meetings: could not record (${(e as Error)?.message ?? "error"})`);
    return { text: "Could not record the meetings (an internal error, logged). Nothing was changed.", isError: true };
  }
}

export function createMeetingsServer(run: MeetingsRun) {
  return createSdkMcpServer({
    name: "meetings",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        "note_upcoming_meetings",
        `Tell code which meetings are coming up, so it can have a short prep message written shortly before each one. Call it ONCE per look, after you have read the calendar for the next ${HORIZON_MS / 3_600_000} hours (a few more is fine, up to 36), with EVERY event in that window that is not all-day: this list REPLACES what was recorded for the window, so an event you leave out is forgotten (a cancelled or moved one disappears) and an empty list means "nothing is coming up". Do NOT call it if you could not read the calendar. Pass the facts exactly as the calendar gave them; code decides which meetings get a prep (declined, private, all-day and meetings with nobody else are skipped by code, not by you). Times are full ISO WITH the UTC offset.`,
        {
          meetings: z
            .array(
              z.object({
                eventId: z.string().min(1).max(200).describe("The calendar's id for the event, exactly as the calendar tool returned it"),
                start: z.string().min(10).max(40).describe("Start as a full ISO time WITH its UTC offset, e.g. 2026-10-22T14:00:00+02:00"),
                end: z.string().min(10).max(40).optional().describe("End, same format"),
                title: z.string().max(300).describe("The event's title; \"(no title)\" if it has none"),
                attendees: z
                  .array(z.object({ name: z.string().max(120).optional(), email: z.string().max(254).optional(), self: z.boolean().optional().describe("true for the owner's own entry") }))
                  .max(MAX_ATTENDEES)
                  .optional()
                  .describe("Everyone on the invite including the owner (mark her entry self: true); names and e-mail addresses as the calendar shows them"),
                link: z.string().max(500).optional().describe("The video-call link (Meet, Zoom, Teams) if the event has one"),
                allDay: z.boolean().optional().describe("true for an all-day event"),
                response: z.string().max(20).optional().describe("The owner's own answer to the invite: accepted, tentative, needsAction or declined"),
                private: z.boolean().optional().describe("true when the calendar marks the event private or confidential"),
              }),
            )
            .max(MAX_MEETINGS),
        },
        async ({ meetings }) => {
          const r = noteMeetings(run, meetings);
          return reply(r.text, r.isError);
        },
        { alwaysLoad: true },
      ),
    ],
  });
}
