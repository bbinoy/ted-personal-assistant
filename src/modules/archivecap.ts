import { settings } from "../core/settings.ts";

// The archive cap: at most ARCHIVE_MAX_PER_RUN messages or conversations archived in one run (one heartbeat look, one chat turn's run), whichever mail the tool
// belongs to. An archive is reversible (`npm run restore`), but a confused or steered run must not be able to empty an inbox in one look; the rest waits for the
// next look. The mail modules hand `archiveGate` to their floor (ModuleFloor.perRun); permissions.ts makes one gate per run and asks it before a call proceeds.
// Nothing here knows a provider except the shapes of the archive calls below.

const ID_KEYS = /^(conversation|thread|message)_?ids?$/i;

const asList = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);

// Every conversation, thread or message id a call names (a single id or a batch, camelCase or snake_case), so a batch counts each one.
export function idsNamed(input: Record<string, unknown>): string[] {
  return Object.entries(input).flatMap(([k, v]) => (ID_KEYS.test(k) ? asList(v) : []));
}

// The labels a label call takes off (an unlabel call's labelIds IS the list removed).
const removed = (input: Record<string, unknown>): string[] => Object.entries(input).flatMap(([k, v]) => (/^(remove_?label_?ids|label_?ids)$/i.test(k) ? asList(v) : []));

// The ids this call archives, or undefined when it is no archive: Mailbird's archive_conversation, or a Gmail label call (the connector's or a friend's) that takes INBOX off.
// An archive that names no id still counts as one (the empty string).
export function archivedBy(tool: string, input: Record<string, unknown>): string[] | undefined {
  const name = tool.split("__").pop() ?? tool;
  const isArchive = name === "archive_conversation" || (/^(unlabel_|modify_|update_)/.test(name) && /label/.test(name) && removed(input).some((l) => l.toUpperCase() === "INBOX"));
  if (!isArchive) return undefined;
  const ids = idsNamed(input);
  return ids.length ? ids : [""];
}

// An archive call as ONE call per mail, for the gentle first week (approvals/shadow.ts): a proposal is answered mail by mail ("3,5 keep"), so a batch call is split into calls that each name one id and
// keep every other argument as the model made it (the exact-args replay then runs each as recorded). A call naming several ids under different keys, or an id-less one, is left whole (id: all its ids joined).
export function splitArchive(tool: string, input: Record<string, unknown>): { input: Record<string, unknown>; id: string }[] {
  const ids = archivedBy(tool, input);
  if (!ids) return [];
  const keys = Object.keys(input).filter((k) => ID_KEYS.test(k) && asList(input[k]).length > 0);
  if (keys.length === 1 && Array.isArray(input[keys[0]!]) && ids.length > 1) {
    const k = keys[0]!;
    return [...new Set(ids)].map((id) => ({ input: { ...input, [k]: [id] }, id }));
  }
  return [{ input: structuredClone(input), id: ids.join(",") }];
}

export const capReached = (cap: number) => `Archive cap reached for this look (${cap} per look): the rest waits for the next one. Do not look for another way to archive; say in your own words what is left.`;

// One gate per run: it remembers the ids it let through. A call that would take the run past the cap is refused with a message for the model; an id already archived
// in this run is not counted twice. It counts the calls it lets through, so an archive the owner then declines still used its place (the cap bounds attempts, not results).
export function archiveGate(cap: () => number = () => settings.archiveMaxPerRun): (tool: string, input: Record<string, unknown>) => string | undefined {
  const seen = new Set<string>();
  let anonymous = 0;
  return (tool, input) => {
    const ids = archivedBy(tool, input);
    if (!ids) return undefined;
    const fresh = ids.filter((i, k) => (i === "" || !seen.has(i)) && (i === "" || ids.indexOf(i) === k));
    if (seen.size + anonymous + fresh.length > cap()) return capReached(cap());
    for (const i of fresh) i === "" ? anonymous++ : seen.add(i);
    return undefined;
  };
}
