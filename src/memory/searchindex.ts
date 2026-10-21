import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, fstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dataPath } from "../core/state.ts";
import { settings } from "../core/settings.ts";
import { stems } from "./searchtext.ts";

// The search index of ONE conversation (its own file, in that conversation's folder; never shared, so a group or a friend can only ever
// search itself). Why SQLite FTS5 and not a hand-written inverted index: Node 24's node:sqlite ships SQLite 3.50 with FTS5 compiled in (checked:
// `create virtual table t using fts5(x)` works), so the postings, their compression and the candidate lookup are a dependency we already
// have; it is a rebuildable CACHE of the log, nothing in it is the only copy. FTS5 only finds and orders candidates; the final BM25 with
// term weights, the phrase/near bonus and the recency boost are done in TypeScript on the few hundred candidates (search.ts), because FTS5
// cannot weight one query term against another. Text is stored already normalised and stemmed (searchtext.ts), so FTS5 needs no tokenizer
// of its own. Without FTS5 the same interface could sit on a cached in-memory index; it is not needed here and not built.
//
// Kept up to date from the log by offset: the log is append-only (compaction writes a NEW file), so the index remembers the inode, the
// first bytes' hash and how far it has read, reads only what was appended, and starts over when the file is another one, shorter, or begins
// differently. A file that is missing, from another version or does not open or answer is deleted and built again.

const VERSION = 1;
const NOT_SPOKEN: ReadonlySet<string> = new Set(["reaction", "approval", "action", "wake"]); // reactions, approvals and the gate's ledger are no conversation: not indexed
const isSearchable = (kind: string) => !!kind && !NOT_SPOKEN.has(kind) && kind !== "delete"; // a deletion marker is kept (not searchable) so a deleted message is left out of results
const MAX_NOTE_BYTES = 20_000;

export interface Doc {
  id: number;
  src: "m" | "n"; // a log line, a memory note
  t: number; // ms since epoch (a note: its file's mtime)
  ts: number; // a message's Signal timestamp (0 for a note)
  kind: string;
  by: string;
  of: number; // an edit or deletion: the message it concerns
  name: string; // a note: its file name
  text: string;
  au: string; // lower-case author labels the `who` filter looks in
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
export function authorLabels(kind: string, by: string, text: string): string {
  const who = kind === "member" || kind === "edit" ? speakerOf(text) : ""; // a group's line starts with the speaker's name
  const role = kind === "owner" ? "owner user me" : kind === "chat" ? `assistant ${settings.assistant}` : kind === "member" || kind === "edit" ? "member" : kind === "summary" ? "summary" : `assistant ${settings.assistant} ${kind}`;
  return `${role} ${by} ${who}`.toLowerCase();
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const quote = (w: string) => `"${w.replace(/"/g, "")}"`;
export const orExpr = (words: readonly string[]): string => words.map(quote).join(" OR ");
export const phraseExpr = (words: readonly string[]): string => quote(words.join(" ")); // an FTS5 phrase: these stems next to each other

export class SearchIndex {
  #db: DatabaseSync;
  #stmts = new Map<string, StatementSync>();
  readonly path: string;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
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
          create table if not exists docs(id integer primary key, src text not null, t integer not null, ts integer not null, kind text not null, wr text not null, au text not null, ofts integer not null, name text not null, ntok integer not null);
          create table if not exists bodies(id integer primary key, text text not null);
          create index if not exists docs_ts on docs(ts) where src='m';
          create index if not exists docs_edit on docs(kind) where kind in ('edit','delete');
          create virtual table if not exists f using fts5(s, tokenize='unicode61');`);
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
  #tx(fn: () => void) {
    this.#db.exec("begin");
    try {
      fn();
      this.#db.exec("commit");
    } catch (e) {
      try { this.#db.exec("rollback"); } catch { /* already rolled back */ }
      throw e;
    }
  }
  #insert(d: Omit<Doc, "id" | "au"> & { searchable: boolean; extra?: string }): void {
    const au = authorLabels(d.kind, d.by, d.text);
    const toks = d.searchable ? stems(`${d.extra ?? ""} ${d.text}`) : [];
    const r = this.#q("insert into docs(src,t,ts,kind,wr,au,ofts,name,ntok) values(?,?,?,?,?,?,?,?,?)").run(d.src, d.t, d.ts, d.kind, d.by, au, d.of, d.name, toks.length);
    const id = Number(r.lastInsertRowid);
    this.#q("insert into bodies(id,text) values(?,?)").run(id, d.text);
    if (toks.length) this.#q("insert into f(rowid,s) values(?,?)").run(id, toks.join(" "));
  }
  #clear(src: "m" | "n") {
    this.#db.exec(`delete from f where rowid in (select id from docs where src='${src}'); delete from bodies where id in (select id from docs where src='${src}'); delete from docs where src='${src}'`);
  }

  // Brings the message part up to date with the log (a path as messages.ts takes it). Returns how many lines it added.
  syncLog(logFile: string): number {
    let path: string;
    try { path = dataPath(logFile); } catch { return 0; }
    if (!existsSync(path)) {
      if (this.#meta("log")) this.#tx(() => { this.#clear("m"); this.#setMeta("log", ""); this.#setMeta("offset", 0); });
      return 0;
    }
    const fd = openSync(path, "r");
    try {
      const st = fstatSync(fd);
      const head = Buffer.alloc(Math.min(256, st.size));
      readSync(fd, head, 0, head.length, 0);
      const sig = `${st.ino}:${createHash("sha1").update(head).digest("hex")}`;
      let offset = Number(this.#meta("offset") ?? 0);
      if (this.#meta("log") !== sig || st.size < offset) {
        this.#tx(() => { this.#clear("m"); this.#setMeta("log", sig); this.#setMeta("offset", 0); });
        offset = 0;
      }
      if (st.size === offset) return 0;
      const buf = Buffer.alloc(st.size - offset);
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, offset + got);
        if (n <= 0) break;
        got += n;
      }
      const end = buf.subarray(0, got).lastIndexOf(10); // only whole lines: a half-written last line waits for the next sync
      if (end < 0) return 0;
      let added = 0;
      this.#tx(() => {
        for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
          if (!line) continue;
          let e: { ts?: unknown; at?: unknown; kind?: unknown; text?: unknown; by?: unknown; of?: unknown };
          try { e = JSON.parse(line); } catch { continue; }
          const kind = typeof e.kind === "string" ? e.kind : "";
          if (typeof e.text !== "string" || !kind || NOT_SPOKEN.has(kind)) continue;
          const t = Date.parse(String(e.at));
          this.#insert({ src: "m", t: Number.isFinite(t) ? t : 0, ts: typeof e.ts === "number" ? e.ts : 0, kind, by: typeof e.by === "string" ? e.by : "", of: typeof e.of === "number" ? e.of : 0, name: "", text: e.text, searchable: isSearchable(kind) });
          added++;
        }
        this.#setMeta("offset", offset + end + 1);
      });
      return added;
    } finally {
      closeSync(fd);
    }
  }

  // Brings the notes part up to date with the folder: the notes are few, so a change to any of them (name, size, mtime, or the day passing an `expires:`) replaces all.
  syncNotes(dir: string, today: string): number {
    let files: { f: string; mtime: number; size: number }[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && !f.startsWith(".")).sort().flatMap((f) => {
        try { const s = statSync(`${dir}/${f}`); return s.isFile() && s.size <= MAX_NOTE_BYTES * 4 ? [{ f, mtime: s.mtimeMs, size: s.size }] : []; } catch { return []; }
      });
    } catch { /* no folder: no notes */ }
    const sig = createHash("sha1").update(`${today}\n${files.map((x) => `${x.f}:${x.size}:${x.mtime}`).join("\n")}`).digest("hex");
    if (this.#meta("notes") === sig) return 0;
    let n = 0;
    this.#tx(() => {
      this.#clear("n");
      for (const { f, mtime } of files) {
        let raw: string;
        try { raw = readFileSync(`${dir}/${f}`, "utf8"); } catch { continue; }
        let body = raw.replace(/\r\n/g, "\n");
        const m = /^---\n([\s\S]*?)\n---\n?/.exec(body);
        if (m) {
          const exp = /^\s*expires:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m.exec(m[1]!)?.[1];
          if (exp && today > exp) continue; // an expired note is no longer shown, so it is not found either
          body = body.slice(m[0].length);
        }
        body = body.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim().slice(0, MAX_NOTE_BYTES);
        if (!body) continue;
        this.#insert({ src: "n", t: Math.floor(mtime), ts: 0, kind: "note", by: "", of: 0, name: f, text: body, searchable: true, extra: f.replace(/\.md$/, "").replace(/[-_]/g, " ") });
        n++;
      }
      this.#setMeta("notes", sig);
    });
    return n;
  }

  // Corpus numbers for BM25 (searchable documents and their average length).
  stats(): { n: number; avgdl: number } {
    const r = this.#q("select count(*) n, coalesce(sum(ntok),0) s from docs where ntok>0").get() as { n: number; s: number };
    return { n: r.n, avgdl: r.n ? r.s / r.n : 1 };
  }
  df(word: string): number {
    return (this.#q("select count(*) c from f where f match ?").get(`"${word.replace(/"/g, "")}"`) as { c: number }).c;
  }

  #where(f: Filters): { sql: string; args: (string | number)[] } {
    const parts = [`d.src in (${f.sources.map(() => "?").join(",") || "''"})`];
    const args: (string | number)[] = [...f.sources];
    if (f.from !== undefined) { parts.push("(d.src='n' or d.t>=?)"); args.push(f.from); }
    if (f.to !== undefined) { parts.push("(d.src='n' or d.t<=?)"); args.push(f.to); }
    if (f.who) { parts.push("d.au like ? escape '\\'"); args.push(`%${likeEscape(f.who.toLowerCase().trim())}%`); }
    return { sql: parts.join(" and "), args };
  }
  #docs(sql: string, args: (string | number)[]): Doc[] {
    return (this.#q(sql).all(...args) as Record<string, unknown>[]).map((r) => ({ id: r.id as number, src: r.src as "m" | "n", t: r.t as number, ts: r.ts as number, kind: r.kind as string, by: r.by as string, of: r.of as number, name: r.name as string, text: r.text as string, au: r.au as string }));
  }
  static COLS = "d.id id, d.src src, d.t t, d.ts ts, d.kind kind, d.wr by, d.ofts of, d.name name, d.au au, b.text text";

  // The best `limit` documents by FTS5's own ranking for an FTS5 expression (orExpr, phraseExpr, joined with AND).
  candidates(expr: string, f: Filters, limit: number): Doc[] {
    const w = this.#where(f);
    return this.#docs(`select ${SearchIndex.COLS} from f join docs d on d.id=f.rowid join bodies b on b.id=d.id where f match ? and ${w.sql} order by f.rank limit ?`, [expr, ...w.args, limit]);
  }
  // The newest `limit` documents that pass the filters (a search with no words).
  latest(f: Filters, limit: number): Doc[] {
    const w = this.#where(f);
    return this.#docs(`select ${SearchIndex.COLS} from docs d join bodies b on b.id=d.id where d.ntok>0 and ${w.sql} order by d.t desc, d.id desc limit ?`, [...w.args, limit]);
  }
  // Every edit and deletion marker, and the messages with these timestamps (what they point at).
  edits(): Doc[] {
    return this.#docs(`select ${SearchIndex.COLS} from docs d join bodies b on b.id=d.id where d.kind in ('edit','delete')`, []);
  }
  byTs(stamps: readonly number[]): Doc[] {
    const out: Doc[] = [];
    for (let i = 0; i < stamps.length; i += 400) {
      const part = stamps.slice(i, i + 400);
      out.push(...this.#docs(`select ${SearchIndex.COLS} from docs d join bodies b on b.id=d.id where d.src='m' and d.ts in (${part.map(() => "?").join(",")})`, part));
    }
    return out;
  }
}
