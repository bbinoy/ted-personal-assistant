import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { layout, isConvId, dataRoot, type Layout } from "../core/convpaths.ts";
import { registerRetention, type RetentionResult, type RetentionRule } from "../core/retention.ts";
import { copyTruncateIfOver } from "../core/rotate.ts";
import { settings } from "../core/settings.ts";
import { writeFileAtomic } from "../core/state.ts";
import { dayAt } from "../core/timezone.ts";
import { layoutOf as openbaoLayout } from "../secrets/openbaoadmin.ts";
import { snapshotsOf } from "../memory/dreamapply.ts";
import { forgetNote } from "../memory/notes.ts";
import { MAX_AGE_MS as VOICE_SOURCE_WINDOW_MS } from "../modules/voice/voicenote.ts";

// The file-based retention rules (core/retention.ts says how they run). Each is a factory over a data layout and its window, so a test gives a temp folder and a fake clock; `fileRules()` is the set
// the application registers, built from the settings. What every rule shares: it only looks at the folder it owns, never follows a link, counts what it removes in files and bytes, and in a dry run
// removes nothing. What NO rule touches (a test pins each): the current audit file, the kill-switch files (instance/paused, card.disabled), the payments ledger, the migration backups and
// orphans (those only get a warning from the doctor), a conversation's live notes (only the expired ones, and into notes-backup/ first), signal-cli's keys and config.

const DAY = 86_400_000;
const HOUR = 3_600_000;

type Dry = { dryRun: boolean };
const sizeOf = (path: string): number => {
  try {
    const st = lstatSync(path);
    if (!st.isDirectory()) return st.size;
    return readdirSync(path).reduce((n, f) => n + sizeOf(join(path, f)), 0);
  } catch {
    return 0;
  }
};
const names = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return []; // not there: nothing to do
  }
};
const mtimeOf = (path: string): number => {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY; // gone meanwhile: never old
  }
};
/** Removes one file or folder (or, in a dry run, only counts it). Returns the bytes. */
function drop(path: string, o: Dry): number {
  const bytes = sizeOf(path);
  if (!o.dryRun) rmSync(path, { recursive: true, force: true });
  return bytes;
}
const total = (r: RetentionResult[]): RetentionResult => ({ removed: r.reduce((n, x) => n + x.removed, 0), freedBytes: r.reduce((n, x) => n + x.freedBytes, 0) });

// ---- logs/audit.jsonl.<n>: the rotated generations, by the age of their lines ----

const tsOf = (line: string): string | undefined => /^\{"ts":"([^"]+)"/.exec(line)?.[1];

/** Pure: the lines of one audit generation that are within the window, and how many were dropped. A line with no readable time follows the line before it (a damaged line is not dated). */
export function pruneAuditText(text: string, cutoffIso: string): { kept: string; dropped: number } {
  const keep: string[] = [];
  let dropped = 0;
  let verdict = true;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const ts = tsOf(line);
    if (ts !== undefined) verdict = ts >= cutoffIso;
    if (verdict) keep.push(line);
    else dropped++;
  }
  return { kept: keep.length ? keep.join("\n") + "\n" : "", dropped };
}

export function auditRule(L: () => Layout, days: () => number): RetentionRule {
  return {
    name: "audit",
    everyHours: 24,
    run(now, o) {
      const cutoff = new Date(now.getTime() - days() * DAY).toISOString();
      const current = L().logs.audit;
      const results: RetentionResult[] = [];
      for (const f of names(L().logs.dir)) {
        const path = join(L().logs.dir, f);
        if (path === current || !f.startsWith(`${basename(current)}.`) || !/\.\d+$/.test(f)) continue; // ONLY the numbered generations; the live file is never touched
        let text: string;
        try {
          text = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        const { kept, dropped } = pruneAuditText(text, cutoff);
        if (dropped === 0) continue;
        if (kept === "") results.push({ removed: dropped, freedBytes: drop(path, o) });
        else {
          if (!o.dryRun) writeFileAtomic(path, kept, 0o600); // (atomic: temp file, fsync, rename)
          results.push({ removed: dropped, freedBytes: Buffer.byteLength(text) - Buffer.byteLength(kept) });
        }
      }
      return { ...total(results), notes: `audit lines older than ${days()} days from rotated generations` };
    },
  };
}

// ---- signal-cli's saved attachments ----

/** The attachment file names something still needs: a voice note or audio file in any conversation's voices/sources.json inside its own look-back, and any name mentioned in a pending approval. */
export function neededAttachments(L: Layout, now: number, candidates: ReadonlySet<string>): Set<string> {
  const needed = new Set<string>();
  for (const conv of names(L.conversations)) {
    if (!isConvId(conv)) continue;
    const p = L.conv(conv);
    try {
      const raw = JSON.parse(readFileSync(p.voiceSources, "utf8")) as { notes?: { id?: unknown; ts?: unknown }[] };
      for (const n of raw.notes ?? []) if (typeof n.id === "string" && (typeof n.ts !== "number" || now - n.ts < VOICE_SOURCE_WINDOW_MS)) needed.add(n.id);
    } catch { /* none, or damaged: nothing named */ }
    try {
      const pending = readFileSync(p.pending, "utf8");
      for (const c of candidates) if (pending.includes(c)) needed.add(c); // (the whole file as text: whatever shape an item has, a mention keeps the file)
    } catch { /* none */ }
  }
  return needed;
}

export function signalAttachmentRule(L: () => Layout, dir: () => string, days: () => number): RetentionRule {
  return {
    name: "signal-attachments",
    everyHours: 24,
    run(now, o) {
      const d = dir();
      if (days() <= 0) return { removed: 0, freedBytes: 0, notes: "off (SIGNAL_ATTACHMENT_DAYS=0)" };
      if (basename(d) !== "attachments" || !existsSync(d)) return { removed: 0, freedBytes: 0, notes: "signal-cli's attachments folder not found: skipped" }; // (the keys and config are in the folders next to it, never here)
      const old = names(d).filter((f) => !f.startsWith(".") && /^[\w.-]{1,100}$/.test(f)).filter((f) => {
        try {
          const st = lstatSync(join(d, f));
          return st.isFile() && now.getTime() - st.mtimeMs > days() * DAY; // a plain file only: a link or a folder is not what signal-cli writes
        } catch {
          return false;
        }
      });
      const needed = neededAttachments(L(), now.getTime(), new Set(old));
      const results = old.filter((f) => !needed.has(f)).map((f) => ({ removed: 1, freedBytes: drop(join(d, f), o) }));
      return { ...total(results), notes: `attachments older than ${days()} days not needed by a voice note or a pending item${needed.size ? ` (${old.filter((f) => needed.has(f)).length} kept)` : ""}` };
    },
  };
}

// ---- expired notes, and the dream's snapshots ----

const EXPIRES = /^---\n([\s\S]*?)\n---/;
/** Pure: the `expires: YYYY-MM-DD` of a note's front matter, whatever its category. */
export const expiryOf = (raw: string): string | undefined => {
  const m = EXPIRES.exec(raw.replace(/\r\n/g, "\n"));
  return m ? /^\s*expires:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m.exec(m[1]!)?.[1] : undefined;
};
export const EXPIRED_DIR = "expired";

export function expiredNotesRule(L: () => Layout, deleteDays: () => number): RetentionRule {
  return {
    name: "expired-notes",
    everyHours: 24,
    run(now, o) {
      const today = dayAt(now, 0).date;
      const deleteBefore = dayAt(now, -deleteDays()).date; // expired longer ago than this: gone for good
      const results: RetentionResult[] = [];
      let moved = 0;
      for (const conv of names(L().conversations)) {
        if (!isConvId(conv)) continue;
        const p = L().conv(conv);
        const holding = join(p.notesBackup, EXPIRED_DIR);
        for (const f of names(p.notes)) {
          if (!f.endsWith(".md") || f === "MEMORY.md" || !/^[\w.-]+\.md$/.test(f)) continue;
          const path = join(p.notes, f);
          let raw: string;
          try {
            if (!lstatSync(path).isFile()) continue;
            raw = readFileSync(path, "utf8");
          } catch {
            continue;
          }
          const expires = expiryOf(raw);
          if (!expires || expires >= today) continue; // no expiry, or still good today
          const bytes = Buffer.byteLength(raw);
          if (!o.dryRun) {
            if (expires >= deleteBefore) {
              mkdirSync(holding, { recursive: true, mode: 0o700 });
              cpSync(path, join(holding, `${expires}-${f}`)); // (dated by its expiry: two days' status-brief.md do not collide, and the age is in the name)
              moved++;
            }
            forgetNote(f, p.notes); // the file and its line in MEMORY.md (the dream's own helper), after the copy
          } else if (expires >= deleteBefore) moved++;
          results.push({ removed: 1, freedBytes: expires >= deleteBefore ? 0 : bytes }); // (a moved note frees nothing yet)
        }
        for (const f of names(holding)) {
          const date = /^(\d{4}-\d{2}-\d{2})-/.exec(f)?.[1];
          if (date && date < deleteBefore) results.push({ removed: 1, freedBytes: drop(join(holding, f), o) });
        }
      }
      return { ...total(results), notes: `${moved} expired note(s) set aside in the notes-backup folder's ${EXPIRED_DIR}/, older than ${deleteDays()} days past expiry deleted` };
    },
  };
}

export function notesBackupRule(L: () => Layout, keep: () => number): RetentionRule {
  return {
    name: "note-snapshots",
    everyHours: 24,
    run(_now, o) {
      const results: RetentionResult[] = [];
      for (const conv of names(L().conversations)) {
        if (!isConvId(conv)) continue;
        const dir = L().conv(conv).notesBackup;
        for (const old of snapshotsOf(dir).slice(0, -keep())) results.push({ removed: 1, freedBytes: drop(join(dir, old), o) }); // (the dream prunes after each snapshot too; this catches a conversation that has stopped dreaming)
      }
      return { ...total(results), notes: `dream snapshots beyond the newest ${keep()} per conversation` };
    },
  };
}

// ---- OpenBao: logs and raft snapshots (state/openbao) ----

export function openbaoRule(L: () => Layout, logMb: () => number, keepBackups: () => number): RetentionRule {
  return {
    name: "openbao",
    everyHours: 24,
    run(_now, o) {
      const bao = openbaoLayout(L().instance.openbao);
      if (!existsSync(bao.dir)) return { removed: 0, freedBytes: 0, notes: "OpenBao is not installed here: skipped" };
      const max = logMb() * 1_048_576;
      const results: RetentionResult[] = [];
      let rotated = 0;
      // The server holds these open in append mode (the audit device, launchd's stdout), so a file is copied to .1 and cut to nothing in place (rotate.ts), 2 generations kept: the third is what goes.
      for (const f of [bao.audit, join(bao.logs, "server.log"), join(bao.logs, "keeper.log")]) {
        let size = 0;
        try {
          size = statSync(f).size;
        } catch {
          continue;
        }
        if (size <= max) continue;
        const dropped = sizeOf(`${f}.2`);
        if (!o.dryRun && !copyTruncateIfOver(f, max, 2)) continue;
        rotated++;
        results.push({ removed: dropped ? 1 : 0, freedBytes: dropped });
      }
      const snaps = names(bao.backups).filter((n) => /^raft-.*\.snap$/.test(n)).sort(); // (named by their ISO time: the newest sort last)
      for (const old of snaps.slice(0, -keepBackups())) results.push({ removed: 1, freedBytes: drop(join(bao.backups, old), o) });
      return { ...total(results), notes: `${rotated} log(s) over ${logMb()} MB rotated; raft snapshots beyond the newest ${keepBackups()}` };
    },
  };
}

// ---- instance/shore: the map cache ----

export function shoreRule(L: () => Layout, keep: () => number): RetentionRule {
  return {
    name: "shore-cache",
    everyHours: 24,
    run(_now, o) {
      const dir = L().instance.shore;
      const files = names(dir).filter((f) => f.endsWith(".json")).map((f) => ({ f, at: mtimeOf(join(dir, f)) })).sort((a, b) => b.at - a.at); // newest first (a spot is refetched if it was dropped: the cache is only a cache)
      return { ...total(files.slice(keep()).map((x) => ({ removed: 1, freedBytes: drop(join(dir, x.f), o) }))), notes: `shore outlines beyond the newest ${keep()}` };
    },
  };
}

// ---- the temporary folders of picture, voice and Google work ----

// The folders the app makes in the system temp folder with mkdtemp (a random suffix): run/image.ts picture-, packages/speech voiceclip-, speech-, voice-, modules/google/googlemcp.ts ted-google- (a refresh token lives in those).
const TMP_NAMES = /^(?:(?:picture|voiceclip|speech|voice)-[A-Za-z0-9]{6}|ted-google-[A-Za-z0-9]{6})$/;

export function tmpRule(root: () => string, hours: () => number): RetentionRule {
  return {
    name: "tmp-leftovers",
    everyHours: 24,
    run(now, o) {
      const results: RetentionResult[] = [];
      for (const f of names(root())) {
        if (!TMP_NAMES.test(f)) continue;
        const path = join(root(), f);
        try {
          const st = lstatSync(path);
          if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) continue; // a real folder of ours: not a link, not another user's
          if (now.getTime() - st.mtimeMs < hours() * HOUR) continue;
        } catch {
          continue;
        }
        results.push({ removed: 1, freedBytes: drop(path, o) });
      }
      return { ...total(results), notes: `temporary folders older than ${hours()} h` };
    },
  };
}

// ---- for the doctor: what only a person may delete ----

/** The entries of instance/migration-backup and migration-orphans older than `days`: never removed by the job, named by the doctor ("review and delete"). */
export function staleForReview(L: Layout, now: Date, days: number): { dir: string; name: string; ageDays: number }[] {
  const out: { dir: string; name: string; ageDays: number }[] = [];
  for (const dir of [L.instance.migrationBackup, L.instance.migrationOrphans]) {
    for (const name of names(dir)) {
      const age = (now.getTime() - mtimeOf(join(dir, name))) / DAY;
      if (age > days) out.push({ dir, name, ageDays: Math.floor(age) });
    }
  }
  return out;
}

/** The set the application runs, from the settings and the process's data folder. Called once by main.ts and by `npm run retention`; other stores register their own rules next to these. */
export function registerFileRules(): void {
  const L = () => layout(dataRoot());
  for (const r of [
    auditRule(L, () => settings.auditRetentionDays),
    signalAttachmentRule(L, () => settings.signalAttachmentsDir, () => settings.signalAttachmentDays),
    expiredNotesRule(L, () => settings.expiredNoteDeleteDays),
    notesBackupRule(L, () => settings.notesBackupKeep),
    openbaoRule(L, () => settings.openbaoLogMb, () => settings.openbaoBackupKeep),
    shoreRule(L, () => settings.shoreCacheKeep),
    tmpRule(() => tmpdir(), () => settings.tmpSweepHours),
  ]) registerRetention(r);
}
