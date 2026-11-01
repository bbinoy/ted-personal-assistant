import { OWNER_CONV, convPaths } from "../core/convpaths.ts";
import { emit } from "../core/events.ts";
import { OWNER_KEY } from "../core/ownerkey.ts";
import { dayIn, systemZone, timeIn } from "../core/timezone.ts";
import type { Sent } from "../core/messages.ts";
import { archiveItems, journalCounts, journalSelect, splitJournal } from "../memory/journalread.ts";
import { dropItem, effectiveStatus, getItem, reopenItem, type Scope } from "../tasks/store.ts";
import { BASE_CSS, esc, navLink, type DonePage } from "../tasks/taskspage.ts";

// The second page of the owner's page server: what the assistant did on its own, from the owner's journal (the lines the `journal` tool and /today read), newest first, by day. An entry whose reversal code
// can do without a model gets an undo button: an archived mail goes back to the inbox (the same function as `npm run restore`), a completed or dropped task is reopened, a task it added is dropped. Every
// undo is a journal line of its own ("undone on the page"). The rest (a sent mail, an invite) says to ask. ONLY the owner's journal is read, never a friend's or a group's (CLAUDE.md §5).

const DAYS = 30;
const MAX_ENTRIES = 400;
const DAY = 86_400_000;
const WHY = { text: "undone on the page" };
const RESTORED = /^Restored mail to the inbox \(id (.+)\)$/;

type Undo = { kind: "restore"; ids: string[] } | { kind: "reopen" | "drop"; id: number };

interface Ctx {
  restored: ReadonlySet<string>;
  canRestore: boolean;
}

// Pure over the journal line and the task store: the reversal code can do alone, if the state still allows it.
function undoOf(m: Sent, ctx: Ctx): Undo | undefined {
  const p = splitJournal(m.text);
  if (m.cat === "archive") {
    const ids = archiveItems([m])[0]?.ids ?? [];
    return ctx.canRestore && ids.length && !ids.some((i) => ctx.restored.has(i)) ? { kind: "restore", ids } : undefined;
  }
  if (m.cat !== "task") return undefined;
  const id = Number(/task #(\d+)'$/.exec(p.undo)?.[1]);
  const it = Number.isInteger(id) ? getItem(OWNER_KEY, id) : undefined;
  if (!it) return undefined;
  const status = effectiveStatus(it, Date.now());
  if (/^say 'drop task #/.test(p.undo)) return status === "open" ? { kind: "drop", id } : undefined;
  return /^say 'reopen task #/.test(p.undo) && status !== "open" ? { kind: "reopen", id } : undefined;
}

const restoredIds = (lines: readonly Sent[]): Set<string> => new Set(lines.flatMap((m) => (m.cat === "archive" ? (RESTORED.exec(splitJournal(m.text).what)?.[1] ?? "").split(" ").filter(Boolean) : [])));

const labelOf = (m: Sent, what: string): string => (m.cat === "mail" ? (/^(Sent|Replied|Forwarded)/.test(what) ? "sent" : /draft/i.test(what) ? "draft" : "mail") : m.cat === "task" && /^Reminded/.test(what) ? "reminder" : m.cat === "archive" ? "archived" : (m.cat ?? "other"));

const SCRIPT = String.raw`(()=>{
const S=sessionStorage,K="done-page",k=(d)=>d.dataset.k;
const keep=()=>{try{const o={};document.querySelectorAll("details").forEach((d)=>{o[k(d)]=d.open});S.setItem(K,JSON.stringify({o,y:scrollY}))}catch(e){}};
try{const v=JSON.parse(S.getItem(K)||"null");S.removeItem(K);if(v){document.querySelectorAll("details").forEach((d)=>{if(k(d) in v.o)d.open=v.o[k(d)]});scrollTo(0,v.y)}}catch(e){}
setInterval(()=>{if(document.querySelector("form.busy"))return;keep();location.reload()},60000);
document.addEventListener("submit",async(e)=>{
const f=e.target;if(!f.classList||!f.classList.contains("undo"))return;
e.preventDefault();const b=f.querySelector("button");f.classList.add("busy");b.disabled=true;
try{const r=await fetch(f.action,{method:"POST",body:new URLSearchParams(new FormData(f)),redirect:"manual"});
if(!r.ok&&r.type!=="opaqueredirect")throw 0;
const s=document.createElement("span");s.className="m";s.textContent="undone";f.replaceWith(s);
}catch(x){f.classList.remove("busy");b.disabled=false;b.textContent="Could not undo, retry"}
});
})();`;

const dayTitle = (day: string, today: string, yesterday: string): string =>
  day === today ? "Today" : day === yesterday ? "Yesterday" : new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The page for the journal file `file` at `now` in `zone`. `token` is the undo forms' CSRF token (without it no button); `nonce` switches the one script on. */
export function donePage(file: string, now: number, zone: string, canRestore: boolean, token?: string, nonce?: string): string {
  const { lines } = journalSelect(file, { sinceHours: DAYS * 24 }, now, zone);
  const ctx: Ctx = { restored: restoredIds(lines), canRestore };
  const newest = [...lines].sort((a, b) => b.ts - a.ts).slice(0, MAX_ENTRIES); // (the log is in the order written; the page is in the order done)
  const today = dayIn(new Date(now), zone);
  const yesterday = dayIn(new Date(now - DAY), zone);
  const days = new Map<string, Sent[]>();
  for (const m of newest) {
    const d = dayIn(new Date(m.at), zone);
    days.set(d, [...(days.get(d) ?? []), m]);
  }
  const entry = (m: Sent): string => {
    const p = splitJournal(m.text);
    const u = undoOf(m, ctx);
    const done = m.cat === "archive" && !u && archiveItems([m])[0]?.ids.some((i) => ctx.restored.has(i));
    const act = u && token !== undefined ? `<form class="undo" method="post" action="/done/${m.ts}/undo"><input type="hidden" name="token" value="${esc(token)}"><button title="Undo this" aria-label="Undo: ${esc(p.what)}">Undo</button></form>` : done ? '<span class="m">undone</span>' : !u && p.undo ? '<span class="m">ask me to undo</span>' : "";
    return `<li><span class="tm">${esc(timeIn(new Date(m.at), zone))}</span><div class="b"><span class="c">${esc(labelOf(m, p.what))}</span> ${esc(p.what)}${p.why ? `<br><span class="m">${esc(p.why)}</span>` : ""}</div>${act}</li>`;
  };
  const sections = [...days].map(([day, list]) => {
    const counts = journalCounts(list).map(([k, n]) => `${n} ${k}`).join(", ");
    return `<details data-k="${esc(day)}"${day === today || day === yesterday ? " open" : ""}><summary>${esc(dayTitle(day, today, yesterday))} <span class="m">${esc(counts)}</span></summary><ul>${list.map(entry).join("")}</ul></details>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><noscript><meta http-equiv="refresh" content="60"></noscript><title>What was done</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
${BASE_CSS}
.h{color:#777;margin-bottom:1rem}summary{font-weight:600;margin:.8rem 0 .3rem}ul{list-style:none;padding:0;margin:0}summary .m{font-weight:400}
li{display:flex;gap:.6rem;align-items:center;padding:.45rem 0;border-top:1px solid #8884}.tm{color:#777;font-size:.85rem;min-width:2.8rem}.b{flex:1;min-width:0}form{margin:0}
.c{display:inline-block;font-size:.7rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;border:1px solid #8886;border-radius:4px;padding:0 .35rem;margin-right:.3rem;color:#777}
.m{color:#777;font-size:.85rem}button{font:inherit;min-height:2.4rem;padding:0 .8rem;border:1px solid #8886;border-radius:1.2rem;background:transparent;color:inherit;cursor:pointer}
button:hover,button:focus-visible{background:#2e7d6b26;border-color:#2e7d6b}button:focus-visible{outline:2px solid #2e7d6b;outline-offset:2px}
</style></head><body><h1>What was done</h1>${navLink("/tasks")}<div class="h">${lines.length} action${lines.length === 1 ? "" : "s"} in the last ${DAYS} days · updated ${esc(timeIn(new Date(now), zone))}</div>
${sections.join("") || "<p>Nothing done on my own yet.</p>"}${nonce ? `<script nonce="${nonce}">${SCRIPT}</script>` : ""}</body></html>`;
}

/** Undo the entry written at `at` (its timestamp), found again in the owner's journal and judged by the state now, never by what the page said. False when there is no such entry or nothing left to undo. */
async function undoAt(file: string, canRestore: boolean, restore: (id: string) => Promise<number>, at: number): Promise<boolean> {
  const { lines } = journalSelect(file, { sinceHours: DAYS * 24 }, Date.now(), systemZone());
  const m = lines.find((l) => l.ts === at);
  const u = m && undoOf(m, { restored: restoredIds(lines), canRestore });
  if (!u) return false;
  if (u.kind === "restore") {
    for (const id of u.ids) if ((await restore(id)) !== 0) throw new Error(`could not put ${id} back`);
    emit({ type: "done", tool: "done_page_undo", conv: OWNER_KEY, source: "handler", input: {}, what: `Restored mail to the inbox (id ${u.ids.join(" ")})`, cat: "archive", why: WHY });
    return true;
  }
  const scope: Scope = { key: OWNER_KEY, zone: systemZone(), by: "owner", origin: "owner", source: "chat", now: Date.now(), why: WHY };
  (u.kind === "drop" ? dropItem : reopenItem)(scope, u.id);
  return true;
}

/** The owner's page. `restore` puts one archived mail back (the mail provider's, as `npm run restore` does); without it (mail off) an archive has no button. */
export function ownerDonePage(restore?: (id: string) => Promise<number>): DonePage {
  const file = convPaths(OWNER_CONV).messages;
  return {
    read: (token, nonce) => donePage(file, Date.now(), systemZone(), !!restore, token, nonce),
    undo: (at) => undoAt(file, !!restore, restore ?? (async () => 1), at),
  };
}
