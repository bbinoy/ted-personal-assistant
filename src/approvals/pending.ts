import { createHash } from "node:crypto";
import type { Source } from "../core/audit.ts";
import { OWNER_KEY } from "../core/ownerkey.ts";
import { settings } from "../core/settings.ts";
import { readJson, writeJson } from "../core/state.ts";
import { callKey } from "./permissions.ts";

// The approval inbox's STATE: the calls an unattended run wanted to make that need the owner's yes, parked instead of blocking the run (pendingflow.ts says how they are asked,
// answered and run). One small atomic file per conversation (state/pending-<owner|hash of the key>.json, written with writeJson = writeFileAtomic), so a restart loses nothing.
// A pending action is the EXACT call (tool name and arguments as the run made them), the code-rendered label and footer, the model's one-line question and where it came from;
// it is never rebuilt from words. Numbers (#N) are per conversation, only ever count up and are never reused, so "2" in an old message cannot mean a newer item.

export interface Pending {
  n: number;
  tool: string;
  input: Record<string, unknown>; // exactly as the run called it: what runs on a yes
  label: string; // the first line of the code-built details ("✉️ Reply to ..."), never model text
  question: string; // the model's one-line question (validated against the arguments, approvalmodel.ts)
  footer: string; // code-rendered from the details (questionfooter.ts), one line
  scope: string; // the conversation (Conversation.key): only an answer there applies
  source: Source;
  createdAt: number;
  urgent?: boolean; // the run marked it time-critical: sent at once, even in quiet hours (nothing sets it yet)
  sent?: { at: number; ts?: number; held?: true }; // asked in a batch: when, and the batch message's timestamp (absent when it was held for quiet hours and went out with the morning release)
}

export interface Dropped {
  n: number;
  label: string;
}

interface PendingFile {
  next: number; // the next number to hand out
  items: Pending[];
  expired: Dropped[]; // dropped on expiry and not yet told to the owner
}

const MAX_ITEMS = 40; // a flood is refused, not queued without end

export const pendingFileOf = (scope: string): string => `state/pending-${scope === OWNER_KEY ? "owner" : createHash("sha256").update(scope).digest("hex").slice(0, 16)}.json`;

function load(scope: string): PendingFile {
  const raw = readJson<Partial<PendingFile>>(pendingFileOf(scope), {});
  return {
    next: typeof raw.next === "number" && raw.next >= 1 ? raw.next : 1,
    items: Array.isArray(raw.items) ? raw.items.filter((p): p is Pending => !!p && typeof p.n === "number" && typeof p.tool === "string" && !!p.input && typeof p.input === "object") : [],
    expired: Array.isArray(raw.expired) ? raw.expired.filter((d): d is Dropped => !!d && typeof d.n === "number") : [],
  };
}
const save = (scope: string, f: PendingFile): void => writeJson(pendingFileOf(scope), f);

// Pure: which items are older than `days` at `now`?
export function splitExpired(items: readonly Pending[], now: number, days: number): { keep: Pending[]; dropped: Pending[] } {
  const keep: Pending[] = [];
  const dropped: Pending[] = [];
  for (const p of items) (now - p.createdAt >= days * 86_400_000 ? dropped : keep).push(p);
  return { keep, dropped };
}

// Drop what has waited past PENDING_ACTION_DAYS; the drops are remembered until told (takeExpired), so an expiry is never silent.
export function sweepExpired(scope: string, now: number): Pending[] {
  const f = load(scope);
  const { keep, dropped } = splitExpired(f.items, now, settings.pendingActionDays);
  if (dropped.length === 0) return [];
  f.items = keep;
  f.expired.push(...dropped.map((p) => ({ n: p.n, label: p.label })));
  save(scope, f);
  return dropped;
}
export const takeExpired = (scope: string): Dropped[] => {
  const f = load(scope);
  const out = f.expired;
  if (out.length) save(scope, { ...f, expired: [] });
  return out;
};

// Put back what could not be told (the chat was down): the next flush says it.
export function addExpired(scope: string, told: readonly Dropped[]): void {
  const f = load(scope);
  f.expired.push(...told);
  save(scope, f);
}

export const openItems = (scope: string): Pending[] => load(scope).items;

// Park a call. The same call (tool and arguments) already parked keeps its number: a run that asks twice does not make two items.
export function addPending(scope: string, p: Omit<Pending, "n" | "createdAt" | "scope" | "sent">, now: number): { n: number; duplicate: boolean } | { full: true } {
  const f = load(scope);
  const key = callKey(p.tool, p.input);
  const same = f.items.find((x) => callKey(x.tool, x.input) === key);
  if (same) return { n: same.n, duplicate: true };
  if (f.items.length >= MAX_ITEMS) return { full: true };
  const n = f.next++;
  f.items.push({ ...p, n, scope, createdAt: now });
  save(scope, f);
  return { n, duplicate: false };
}

export function markSent(scope: string, ns: readonly number[], sent: NonNullable<Pending["sent"]>): void {
  const f = load(scope);
  for (const p of f.items) if (ns.includes(p.n) && !p.sent) p.sent = sent;
  save(scope, f);
}

// Remove and return the items with these numbers (answered).
export function takeItems(scope: string, ns: readonly number[]): Pending[] {
  const f = load(scope);
  const taken = f.items.filter((p) => ns.includes(p.n));
  if (taken.length === 0) return [];
  f.items = f.items.filter((p) => !ns.includes(p.n));
  save(scope, f);
  return taken;
}

export const clearPending = (scope: string): Pending[] => takeItems(scope, openItems(scope).map((p) => p.n));
