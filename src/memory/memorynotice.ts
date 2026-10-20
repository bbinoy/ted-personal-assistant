import { basename } from "node:path";
import { audit } from "../audit.ts";
import { isIndex, isNotePath, parseNote, STATUS_PREFIX } from "./notes.ts";
import { splitReaction } from "../reaction.ts";

// Note changes made during the current chat turn. They are announced ONCE, as one short
// message when the turn ends (announceMemoryChanges), not one per tool call. Chat is serial, so a
// module-level list is safe.
const memoryChanges: string[] = [];
export const recordMemoryChange = (line: string) => void memoryChanges.push(line);

// Pure: true when the reply has no words of its own, so a memory change would otherwise go unmentioned.
export const needsMemoryNotice = (reply: string) => splitReaction(reply).text.trim() === "";

// After a successful Write or Edit: if it touched a note (not the index), remember the change for the turn's notice.
export function noteWritten(tool: string, input: Record<string, unknown>): void {
  if (!((tool === "Write" || tool === "Edit") && isNotePath(input.file_path) && !isIndex(input.file_path))) return;
  const file = basename(input.file_path);
  if (file.startsWith(STATUS_PREFIX)) return; // the assistant's own records (a brief's state): not the owner's memory, no notice
  const written = String((tool === "Write" ? input.content : input.new_string) ?? "");
  const body = parseNote(file, written)?.text ?? written.trim();
  audit("memory_note", tool === "Write" ? "written" : "edited", "chat");
  // The note's own description says what it is; fall back to its first line.
  const described = /^description:\s*["']?(.+?)["']?\s*$/m.exec(written.split(/\n---\n/)[0] ?? "")?.[1];
  const gist = (described ?? body.split("\n")[0]!).slice(0, 160);
  memoryChanges.push(`${tool === "Write" ? "➕ saved" : "✏️ updated"} ${file}: ${gist}`);
}

// At the end of the turn: the assistant's own reply says what it saved or forgot, and that is the one message. Only if
// it answered with no words (a bare reaction, or nothing) is a short notice sent instead, so a change never goes unmentioned.
export function announceMemoryChanges(notify: (text: string) => Promise<void>, reply: string): void {
  if (!memoryChanges.length) return;
  const lines = memoryChanges.splice(0);
  if (needsMemoryNotice(reply)) void notify(`🧠 Memory\n${lines.join("\n")}\nWrong? Tell me to undo it.`).catch(() => {});
}
