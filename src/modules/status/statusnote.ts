import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "node:fs";
import { writeFileAtomic } from "../../core/state.ts";
import { join } from "node:path";
import { z } from "zod";
import { audit } from "../../core/audit.ts";
import { MAX_STATUS_CHARS, NOTES_DIR, STATUS_PREFIX } from "../../memory/notes.ts";
import { localDay } from "../../core/pause.ts";

// The assistant's own state, as memory: status-<name>.md in the notes folder (category `status`, assistant-written records such as status-brief: whether today's daily
// brief went out). The heartbeat run and its experts have NO note tools (their notes are injected as data); this one tool is the only note write they have, and it is
// narrow by construction: a name from a short pattern, so the file is always status-<name>.md in the owner's notes folder, at most one note's worth of text, and an
// `expires:` of tomorrow so a record never outlives the day after. The dream never touches the category (preset notes.dream) and a write raises no memory notice.

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type StatusResult = { ok: true; file: string } | { ok: false; error: string };

// Pure but for the file: writes status-<name>.md. `dir`: tests.
export function writeStatusNote(name: string, text: string, now: Date = new Date(), dir: string = NOTES_DIR): StatusResult {
  if (!NAME.test(name)) return { ok: false, error: "the name is lower-case words with dashes, like brief (the file becomes status-brief.md)" };
  const body = text.replace(/[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029]/g, "").trim();
  if (!body) return { ok: false, error: "the note is empty" };
  if (body.length > MAX_STATUS_CHARS) return { ok: false, error: `too long (${body.length} characters, the most is ${MAX_STATUS_CHARS}): keep the date, the status and the headlines only` };
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const file = `${STATUS_PREFIX}${name}.md`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dir, file), `---\nexpires: ${localDay(tomorrow)}\n---\n${body}\n`);
  return { ok: true, file };
}

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

// The in-process server of a heartbeat run (modules/status.ts says who has it).
export function createStatusServer(dir: string = NOTES_DIR) {
  return createSdkMcpServer({
    name: "status",
    version: "1.0.0",
    tools: [
      tool(
        "write_status_note",
        "Write your own record of what you did, as a status note that your later looks read in their notes (for example name 'brief' to record the daily brief: today's date, started/delivered/failed, the headlines). It replaces the note of that name. Keep it short (1200 characters at most); it expires after tomorrow.",
        { name: z.string().describe("Lower-case words with dashes, like brief; the note is saved as status-<name>.md"), text: z.string().describe("The note: the date, the status and the few facts a later look needs") },
        async ({ name, text }) => {
          const r = writeStatusNote(name, text, new Date(), dir);
          audit("status_note", r.ok ? "written" : "refused", "background", { name: String(name).slice(0, 40) });
          return r.ok ? reply(`Saved ${r.file}.`) : reply(r.error, true);
        },
      ),
    ],
  });
}
