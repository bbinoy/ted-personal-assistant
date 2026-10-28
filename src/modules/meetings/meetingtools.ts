import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Source } from "../../core/audit.ts";
import { emitRecord } from "../../core/events.ts";
import { liveConvDb } from "../../core/convdb.ts";
import { convIdOfKey } from "../../core/convpaths.ts";
import { settings } from "../../core/settings.ts";
import { cleanMeeting, HORIZON_MS, MAX_ATTENDEES, MAX_MEETINGS, recordMeetings, type Meeting, type RawMeeting } from "../../tasks/meetings.ts";

// note_upcoming_meetings: any run that read the calendar tells code which meetings are coming up (tasks/meetings.ts says what is kept and what the rules are). ONE server per run, closed over ONE
// conversation (its key is never a parameter): the call writes the `meetings` table of THAT conversation's assistant.db and nothing else, so a friend's look cannot reach the owner's rows
// or the other way round (test/meetingprep.test.ts). Own data, nothing to approve. Code validates every field; a meeting it cannot keep is named in the answer so the model can fix the call.

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

export interface MeetingsRun {
  key: string; // the conversation's key: "owner" or "tenant:<id>"
  source: Source; // the audit label of the run (chat, background, group)
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
    emitRecord("note_upcoming_meetings", "recorded", run.source, { stored: r.stored, removed: r.removed, refused: problems.length });
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
    tools: [
      tool(
        "note_upcoming_meetings",
        `Record the upcoming meetings so a short prep is written before each: every event of the next ${HORIZON_MS / 3_600_000} hours that is not all-day (up to 36 is fine), as the calendar gave it; the list replaces what was recorded. How to use it: the meeting-prep skill.`,
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
      ),
    ],
  });
}
