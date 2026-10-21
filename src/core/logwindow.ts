// logs/agent.log lines carry a local time but no date ("14:03:22.123 ERR ..."; log.ts). To ask "how many errors in the last hour" without comparing clock text across midnight, the dates
// are rebuilt from the end: the last line cannot be newer than the file's modification time, and going backwards a line whose time of day is LATER than the line after it
// belongs to the day before. (A silence of more than a day inside the file would make older lines look newer; the heartbeat writes more often than that.) Pure; `mtimeMs` is the file's.

const STAMP = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\b/;

// The instants (epoch ms) of the lines of `text` that match `keep`, newest first, down to `sinceMs`.
export function stampedSince(text: string, mtimeMs: number, sinceMs: number, keep: (line: string) => boolean): number[] {
  const out: number[] = [];
  const lines = text.split("\n");
  let cursor = mtimeMs + 2000; // (the last line is written just before the file's time is taken; allow a little skew)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = STAMP.exec(lines[i]!);
    if (!m) continue; // a stack trace's continuation or a foreign line: it belongs to the stamped line above it
    const d = new Date(cursor);
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
    if (d.getTime() > cursor) d.setDate(d.getDate() - 1);
    cursor = d.getTime();
    if (cursor < sinceMs) break;
    if (keep(lines[i]!)) out.push(cursor);
  }
  return out;
}

export const errorLinesSince = (text: string, mtimeMs: number, sinceMs: number): number => stampedSince(text, mtimeMs, sinceMs, (l) => l.includes(" ERR ")).length;
