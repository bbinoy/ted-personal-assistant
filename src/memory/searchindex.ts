import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dataPath } from "../core/state.ts";
import { settings } from "../core/settings.ts";
import { SEARCHED_KINDS, searchOf } from "../core/messages.ts";
import { stems } from "./searchtext.ts";

// The search index of ONE conversation (its own file, in that conversation's folder; never shared, so a group or a friend can only ever
// search itself). Why SQLite FTS5 and not a hand-written inverted index: Node 24's node:sqlite ships SQLite 3.50 with FTS5 compiled in (checked:
// `create virtual table t using fts5(x)` works), so the postings, their compression and the candidate lookup are a dependency we already
// have; it is a rebuildable CACHE of the log, nothing in it is the only copy. FTS5 only finds and orders candidates; the final BM25 with
// term weights, the phrase/near bonus and the recency boost are done in TypeScript on the few hundred candidates (search.ts), because FTS5
// cannot weight one query term against another. Text is tokenised and stemmed by us (searchtext.ts), so FTS5 needs no tokenizer of its own.
// Without FTS5 the same interface could sit on a cached in-memory index; it is not needed here and not built.
//
// The index holds NO text: the FTS5 table is contentless (postings only) and each document row keeps just the line's byte offset and length in
// the log (or the note's file name), so the words of a hit are read back from the log or the note itself. That halves the file against copying
// the log into it. Because the log is append-only and the index is synced from it at the start of every search, offsets always point at the
// line they were made for; a line that cannot be read back is simply left out of that answer.
//
// Kept up to date from the log by offset: the index remembers the inode, the first bytes' hash and how far it has read, reads only what was
// appended, and starts over when the file is another one (compaction writes a new file), shorter, or begins differently. The work is done in
// slices of about SLICE_MS that give the event loop back in between (a first build of a big log must not stop Signal handling), each slice its
// own transaction with the offset saved, so a crash or a restart resumes. A file that is missing, from another version or does not open or
// answer is deleted and built again.

const VERSION = 2;
const SLICE_MS = 8;
const SEGMENT = 4 << 20;
// How a kind is indexed comes from the table of kinds (core/messages.ts): reactions, approvals and the gate's ledger are no conversation (not indexed); a deletion marker is kept but never a hit, so a deleted message is left out of results.
const isSearchable = (kind: string) => !!kind && !["none", "marker"].includes(searchOf(kind));
const MAX_NOTE_BYTES = 20_000;

const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface Doc {
  id: number;
  src: "m" | "n"; // a log line, a memory note
  t: number; // ms since epoch (a note: its file's mtime)
  ts: number; // a message's Signal timestamp (0 for a note)
  kind: string;
  by: string;
  of: number; // an edit or deletion: the message it concerns
  name: string; // a note: its file name
  text: string; // read back from the log or the note
}

export interface Filters {
  sources: readonly ("m" | "n")[];
  from?: number; // ms
  to?: number;
  who?: string;
}

// Who wrote a line, for the `who` filter and for showing: the role, the account id and the "Name: " a group's line starts with.
export function speakerOf(text: string): string {
  const m = /^([^:\n]{1,40}):\s/.exec(text);
  return m ? m[1]! : "";
}
const ROLES = { owner: "owner user me", member: "member", summary: "summary", marker: "", none: "" } as const;
const roleOf = (kind: string): string => {
  const s = searchOf(kind);
  return (s === "assistant" ? `assistant ${settings.assistant}${kind === "chat" ? "" : ` ${kind}`}` : ROLES[s]).toLowerCase();
};
const speakerKey = (kind: string, text: string) => (searchOf(kind) === "member" ? speakerOf(text).toLowerCase() : ""); // a group's line starts with the speaker's name
export const authorLabels = (kind: string, by: string, text: string): string => `${roleOf(kind)} ${by.toLowerCase()} ${speakerKey(kind, text)}`;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const quote = (w: string) => `"${w.replace(/"/g, "")}"`;
export const orExpr = (words: readonly string[]): string => words.map(quote).join(" OR ");
export const phraseExpr = (words: readonly string[]): string => quote(words.join(" ")); // an FTS5 phrase: these stems next to each other

// A note's text as the index sees it: front matter out (and the `expires:` day), control characters out. Undefined: expired or empty.
function noteBody(raw: string, today: string): string | undefined {
  let body = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (m) {
    const exp = /^\s*expires:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m.exec(m[1]!)?.[1];
    if (exp && today > exp) return undefined; // an expired note is no longer shown, so it is not found either
    body = body.slice(m[0].length);
  }
  body = body.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim().slice(0, MAX_NOTE_BYTES);
  return body || undefined;
}

export class SearchIndex {
  #db: DatabaseSync;
  #stmts = new Map<string, StatementSync>();
  #n = 0; // searchable documents and their words, kept as we go (BM25 needs them on every search)
  #tok = 0;
  #logPath = "";
  #notesDir = "";
  #today = "";
  #fd: number | undefined;
  readonly path: string;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
    this.#n = Number(this.#meta("n") ?? 0);
    this.#tok = Number(this.#meta("tok") ?? 0);
  }

  // Opens (creating if need be) the conversation's index; anything wrong with the file means it is thrown away and built again.
  static open(path: string): SearchIndex {
    const attempt = (): SearchIndex => {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(path);
      try {
        db.exec("pragma synchronous=off; pragma journal_mode=delete; pragma temp_store=memory;");
        const v = (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
        if (v !== 0 && v !== VERSION) throw new Error("index from another version");
        db.exec(`create table if not exists meta(k text primary key, v text);
          create table if not exists docs(id integer primary key, src text not null, t integer not null, ts integer not null, kind text not null, wr text not null, sp text not null, ofts integer not null, name text not null, ntok integer not null, off integer not null, len integer not null);
          create index if not exists docs_ts on docs(ts) where src='m';
          create index if not exists docs_edit on docs(kind) where kind in ('edit','delete');
          create virtual table if not exists f using fts5(s, content='', contentless_delete=1, tokenize='unicode61');`);
        db.exec(`pragma user_version=${VERSION}`);
        db.prepare("select count(*) c from docs").get(); // touches the pages: a damaged file throws here
        db.prepare("select rowid from f limit 1").get();
        if (path !== ":memory:") try { chmodSync(path, 0o600); } catch { /* best effort */ }
        return new SearchIndex(path, db);
      } catch (e) {
        try { db.close(); } catch { /* already unusable */ }
        throw e;
      }
    };
    try {
      return attempt();
    } catch {
      if (path === ":memory:") throw new Error("search index cannot be created");
      SearchIndex.remove(path);
      return attempt();
    }
  }

  static remove(path: string): void {
    for (const p of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) try { rmSync(p, { force: true }); } catch { /* nothing to do */ }
  }

  close(): void {
    this.#stmts.clear();
    if (this.#fd !== undefined) try { closeSync(this.#fd); } catch { /* closed */ }
    this.#fd = undefined;
    try { this.#db.close(); } catch { /* closed */ }
  }

  #q(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (!s) this.#stmts.set(sql, (s = this.#db.prepare(sql)));
    return s;
  }
  #meta(k: string): string | undefined {
    return (this.#q("select v from meta where k=?").get(k) as { v: string } | undefined)?.v;
  }
  #setMeta(k: string, v: string | number) {
    this.#q("insert into meta(k,v) values(?,?) on conflict(k) do update set v=excluded.v").run(k, String(v));
  }
  #begin() { this.#db.exec("begin"); }
  #commit() {
    this.#setMeta("n", this.#n);
    this.#setMeta("tok", this.#tok);
    this.#db.exec("commit");
  }
  #rollback() {
    try { this.#db.exec("rollback"); } catch { /* already rolled back */ }
  }
  #insert(d: { src: "m" | "n"; t: number; ts: number; kind: string; by: string; of: number; name: string; text: string; off: number; len: number; extra?: string }): void {
    const searchable = d.src === "n" || isSearchable(d.kind);
    const toks = searchable ? stems(`${d.extra ?? ""} ${d.text}`) : [];
    const r = this.#q("insert into docs(src,t,ts,kind,wr,sp,ofts,name,ntok,off,len) values(?,?,?,?,?,?,?,?,?,?,?)").run(d.src, d.t, d.ts, d.kind, d.by.toLowerCase(), speakerKey(d.kind, d.text), d.of, d.name, toks.length, d.off, d.len);
    if (toks.length) {
      this.#q("insert into f(rowid,s) values(?,?)").run(Number(r.lastInsertRowid), toks.join(" "));
      this.#n++;
      this.#tok += toks.length;
    }
  }
  #clear(src: "m" | "n") {
    const s = this.#db.prepare("select count(*) n, coalesce(sum(ntok),0) k from docs where src=? and ntok>0").get(src) as { n: number; k: number };
    this.#n -= s.n;
    this.#tok -= s.k;
    this.#db.prepare("delete from f where rowid in (select id from docs where src=?)").run(src);
    this.#db.prepare("delete from docs where src=?").run(src);
  }

  // Brings the message part up to date with the log (a path as messages.ts takes it), in slices that let the event loop run. Returns how many lines it added.
  async syncLog(logFile: string): Promise<number> {
    let path: string;
    try { path = dataPath(logFile); } catch { return 0; }
    this.#logPath = path;
    if (!existsSync(path)) {
      if (this.#meta("log")) {
        this.#begin();
        try { this.#clear("m"); this.#setMeta("log", ""); this.#setMeta("offset", 0); this.#commit(); } catch (e) { this.#rollback(); throw e; }
      }
      return 0;
    }
    const fd = openSync(path, "r");
    let added = 0;
    try {
      const st = fstatSync(fd);
      const head = Buffer.alloc(Math.min(256, st.size));
      readSync(fd, head, 0, head.length, 0);
      const sig = `${st.ino}:${createHash("sha1").update(head).digest("hex")}`;
      let offset = Number(this.#meta("offset") ?? 0);
      if (this.#meta("log") !== sig || st.size < offset) {
        this.#begin();
        try { this.#clear("m"); this.#setMeta("log", sig); this.#setMeta("offset", 0); this.#commit(); } catch (e) { this.#rollback(); throw e; }
        offset = 0;
      }
      while (offset < st.size) {
        let want = Math.min(SEGMENT, st.size - offset);
        let buf: Buffer;
        let end: number;
        for (;;) { // a segment of whole lines (a longer line than the segment widens it); a half-written last line waits for the next sync
          buf = Buffer.alloc(want);
          let got = 0;
          while (got < want) {
            const n = readSync(fd, buf, got, want - got, offset + got);
            if (n <= 0) break;
            got += n;
          }
          buf = buf.subarray(0, got);
          end = buf.lastIndexOf(10);
          if (end >= 0 || offset + want >= st.size) break;
          want = Math.min(want * 2, st.size - offset);
        }
        if (end < 0) break;
        let pos = 0;
        while (pos <= end) {
          const t0 = performance.now();
          this.#begin();
          try {
            for (let k = 0; pos <= end; k++) {
              if (k % 16 === 15 && performance.now() - t0 > SLICE_MS) break;
              const nl = buf.indexOf(10, pos);
              if (nl > pos && this.#addLine(buf, pos, nl, offset + pos)) added++;
              pos = nl + 1;
            }
            this.#setMeta("offset", offset + pos);
            this.#commit();
          } catch (e) { this.#rollback(); throw e; }
          await yieldLoop();
        }
        offset += end + 1;
      }
    } finally {
      closeSync(fd);
    }
    return added;
  }
  #addLine(buf: Buffer, from: number, to: number, off: number): boolean {
    let e: { ts?: unknown; at?: unknown; kind?: unknown; text?: unknown; by?: unknown; of?: unknown };
    try { e = JSON.parse(buf.toString("utf8", from, to)); } catch { return false; }
    const kind = typeof e.kind === "string" ? e.kind : "";
    if (typeof e.text !== "string" || !kind || searchOf(kind) === "none") return false;
    const t = Date.parse(String(e.at));
    this.#insert({ src: "m", t: Number.isFinite(t) ? t : 0, ts: typeof e.ts === "number" ? e.ts : 0, kind, by: typeof e.by === "string" ? e.by : "", of: typeof e.of === "number" ? e.of : 0, name: "", text: e.text, off, len: to - from });
    return true;
  }

  // Brings the notes part up to date with the folder: the notes are few, so a change to any of them (name, size, mtime, or the day passing an `expires:`) replaces all.
  async syncNotes(dir: string, today: string): Promise<number> {
    this.#notesDir = dir;
    this.#today = today;
    let files: { f: string; mtime: number; size: number }[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && !f.startsWith(".")).sort().flatMap((f) => {
        try { const s = statSync(join(dir, f)); return s.isFile() && s.size <= MAX_NOTE_BYTES * 4 ? [{ f, mtime: s.mtimeMs, size: s.size }] : []; } catch { return []; }
      });
    } catch { /* no folder: no notes */ }
    const sig = createHash("sha1").update(`${today}\n${files.map((x) => `${x.f}:${x.size}:${x.mtime}`).join("\n")}`).digest("hex");
    if (this.#meta("notes") === sig) return 0;
    let n = 0;
    let t0 = performance.now();
    this.#begin();
    try {
      this.#clear("n");
      for (const { f, mtime } of files) {
        let raw: string;
        try { raw = readFileSync(join(dir, f), "utf8"); } catch { continue; }
        const body = noteBody(raw, today);
        if (!body) continue;
        this.#insert({ src: "n", t: Math.floor(mtime), ts: 0, kind: "note", by: "", of: 0, name: f, text: body, off: 0, len: 0, extra: f.replace(/\.md$/, "").replace(/[-_]/g, " ") });
        n++;
        if (performance.now() - t0 > SLICE_MS) { await yieldLoop(); t0 = performance.now(); } // (the one transaction stays open; nothing else uses this connection)
      }
      this.#setMeta("notes", sig);
      this.#commit();
    } catch (e) { this.#rollback(); throw e; }
    return n;
  }

  // Corpus numbers for BM25 (searchable documents and their average length).
  stats(): { n: number; avgdl: number } {
    return { n: this.#n, avgdl: this.#n ? this.#tok / this.#n : 1 };
  }
  df(word: string): number {
    return (this.#q("select count(*) c from f where f match ?").get(quote(word)) as { c: number }).c;
  }

  // The text of the documents, read back from the log (by offset) or the note; one that cannot be read back is dropped.
  #hydrate(rows: Record<string, unknown>[]): Doc[] {
    const out: Doc[] = [];
    for (const r of rows) {
      const src = r.src as "m" | "n";
      let text: string | undefined;
      try {
        if (src === "n") text = noteBody(readFileSync(join(this.#notesDir, r.name as string), "utf8"), this.#today);
        else {
          this.#fd ??= openSync(this.#logPath, "r");
          const len = r.len as number;
          const b = Buffer.alloc(len);
          if (readSync(this.#fd, b, 0, len, r.off as number) === len) {
            const e = JSON.parse(b.toString("utf8")) as { text?: unknown; ts?: unknown };
            if (typeof e.text === "string" && (e.ts ?? 0) === (r.ts as number)) text = e.text; // (the timestamp must be the one indexed: the line is the line we meant)
          }
        }
      } catch { /* unreadable: left out */ }
      if (text !== undefined) out.push({ id: r.id as number, src, t: r.t as number, ts: r.ts as number, kind: r.kind as string, by: r.wr as string, of: r.ofts as number, name: r.name as string, text });
    }
    return out;
  }
  #docs(sql: string, args: (string | number)[]): Doc[] {
    return this.#hydrate(this.#q(sql).all(...args) as Record<string, unknown>[]);
  }
  static COLS = "d.id id, d.src src, d.t t, d.ts ts, d.kind kind, d.wr wr, d.ofts ofts, d.name name, d.off off, d.len len";

  #where(f: Filters): { sql: string; args: (string | number)[] } {
    const parts = [`d.src in (${f.sources.map(() => "?").join(",") || "''"})`];
    const args: (string | number)[] = [...f.sources];
    if (f.from !== undefined) { parts.push("(d.src='n' or d.t>=?)"); args.push(f.from); }
    if (f.to !== undefined) { parts.push("(d.src='n' or d.t<=?)"); args.push(f.to); }
    if (f.who) {
      const w = f.who.toLowerCase().trim();
      const roles = SEARCHED_KINDS.filter((k) => roleOf(k).includes(w));
      parts.push(`((d.wr || ' ' || d.sp) like ? escape '\\'${roles.length ? ` or d.kind in (${roles.map(() => "?").join(",")})` : ""})`);
      args.push(`%${likeEscape(w)}%`, ...roles);
    }
    return { sql: parts.join(" and "), args };
  }

  // The best `limit` documents by FTS5's own ranking for an FTS5 expression (orExpr, phraseExpr, joined with AND).
  candidates(expr: string, f: Filters, limit: number): Doc[] {
    const w = this.#where(f);
    return this.#docs(`select ${SearchIndex.COLS} from f join docs d on d.id=f.rowid where f match ? and ${w.sql} order by f.rank limit ?`, [expr, ...w.args, limit]);
  }
  // The newest `limit` documents that pass the filters (a search with no words).
  latest(f: Filters, limit: number): Doc[] {
    const w = this.#where(f);
    return this.#docs(`select ${SearchIndex.COLS} from docs d where d.ntok>0 and ${w.sql} order by d.t desc, d.id desc limit ?`, [...w.args, limit]);
  }
  // Every edit and deletion marker.
  edits(): Doc[] {
    return this.#docs(`select ${SearchIndex.COLS} from docs d where d.kind in ('edit','delete')`, []);
  }
  // The messages with these timestamps (what an edit or a deletion points at).
  byTs(stamps: readonly number[]): Doc[] {
    const out: Doc[] = [];
    for (let i = 0; i < stamps.length; i += 400) {
      const part = stamps.slice(i, i + 400);
      out.push(...this.#docs(`select ${SearchIndex.COLS} from docs d where d.src='m' and d.ts in (${part.map(() => "?").join(",")})`, part));
    }
    return out;
  }
}
