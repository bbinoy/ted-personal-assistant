import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATUS_PREFIX } from "../memory/notes.ts";

// Which notes the approval judge may not trust. A wake-up is selected by a scheduler from the conversation's own notes (autojudge.ts derived / gate), and the judge reads
// it "exactly as a chat message from the same person". A background look can write notes of its own (`origin: inferred`, memory/inferred.ts) after reading untrusted mail,
// and any note changed in the last day may have been shaped the same way before anyone confirmed it. Which note the scheduler used is not known here, so while ANY such
// note exists the wake-up's task is not taken as the person's word: the judge is not asked, the owner is. Pure but for the folder read; never throws (an unreadable folder has none).

export const FRESH_NOTE_MS = 24 * 3_600_000;

export function doubtfulNotes(dir: string | undefined, now = Date.now()): string[] {
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .filter((f) => {
        const path = join(dir, f);
        const inferred = /^---\n[\s\S]*?^\s*origin:\s*inferred\s*$/m.test(readFileSync(path, "utf8").replace(/\r\n/g, "\n").slice(0, 2000));
        return inferred || (!f.startsWith(STATUS_PREFIX) && now - statSync(path).mtimeMs < FRESH_NOTE_MS); // the assistant's own status records are not instructions
      });
  } catch {
    return [];
  }
}
