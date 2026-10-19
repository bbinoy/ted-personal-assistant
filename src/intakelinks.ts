import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";
import type { Capability } from "./tenants.ts";

// The setup links of the intake page (intakeserver.ts): a single-use code in a URL, minted by the chat tool or the local CLI, redeemed by the page.
// Like the invites (onetime.ts) a code is shown once and only its hash is kept, with an expiry and a payload (WHO it is for and WHICH purpose).
// But two processes use these, the agent that mints and the page that redeems, so the state cannot be one file that both read and write back: a
// code is a file of its own, named by its hash, and using it is a rename, which only one caller can win.
//   <hash>.json     an open link
//   <hash>.claimed  a link whose form is being stored right now: burnt when the store worked, put back when it failed

export interface LinkPayload {
  tenant: string;
  purpose: string;
}
interface Stored {
  expires: number; // epoch ms
  created: number;
  payload: LinkPayload;
}

// The purposes of a link and the capability a person needs for each. EXTENSION POINT: `google`, `notion` and `cvc` are added here and in
// intakepurposes.ts when they are built; nothing else needs to know a purpose by name.
export const PURPOSE_CAPABILITY: Readonly<Record<string, Capability>> = { profile: "profile", card: "card", google: "google" };
// `google` is offered only while the instance's OAuth client is set up (settings.google): without it there is nothing to sign in with.
const purposeAvailable = (purpose: string): boolean => purpose !== "google" || (!!settings.google.clientId && !!settings.google.clientSecret);
export const purposesFor = (capabilities: readonly Capability[]): string[] => Object.entries(PURPOSE_CAPABILITY).filter(([p, c]) => capabilities.includes(c) && purposeAvailable(p)).map(([p]) => p);

export const INTAKE_LINK_TOOL = "mcp__intake__get_setup_link";
export const INTAKE_STATUS_TOOL = "mcp__intake__setup_status";
// The tools of a tenant's run for the intake page: only with a usable INTAKE_BASE_URL, the `intake` capability and at least one purpose she holds the capability for.
// `intake` is off by default (tenants.ts FRIEND_DEFAULTS); the admin grants it with the purpose's capability (npm run tenants -- grant <id> intake).
export const intakeToolsFor = (capabilities: readonly Capability[]): string[] =>
  capabilities.includes("intake") && purposesFor(capabilities).length && !baseUrlProblem() ? [INTAKE_LINK_TOOL, INTAKE_STATUS_TOOL] : [];

export const LINK_CODE = /^[A-Za-z0-9_-]{22}$/; // 128 random bits as base64url
const MAX_OPEN = 200; // open links at once: a bound on the folder, and on how much guessing a code is worth
const hashOf = (code: string): string => createHash("sha256").update(code).digest("hex");

export interface Claim {
  payload: LinkPayload;
  burn(): void; // the form was stored: the link is gone for good
  release(): void; // it was not: the same link can be tried again (until it expires)
}

export class LinkStore {
  readonly dir: string;
  constructor(dir: string = settings.intake.dir) {
    this.dir = dir;
  }

  private entries(now: number): { hash: string; file: string; stored: Stored; claimed: boolean }[] {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const out: { hash: string; file: string; stored: Stored; claimed: boolean }[] = [];
    for (const name of readdirSync(this.dir)) {
      const m = /^([0-9a-f]{64})\.(json|claimed)$/.exec(name);
      if (!m) continue;
      const file = join(this.dir, name);
      let stored: Stored | undefined;
      try {
        stored = JSON.parse(readFileSync(file, "utf8")) as Stored;
      } catch {
        /* torn or foreign: dropped below */
      }
      if (!stored || typeof stored.expires !== "number" || stored.expires <= now || typeof stored.payload?.tenant !== "string" || typeof stored.payload?.purpose !== "string") {
        rmSync(file, { force: true }); // an expired link is gone for good
        continue;
      }
      out.push({ hash: m[1]!, file, stored, claimed: m[2] === "claimed" });
    }
    return out;
  }

  // The new code (shown once; only its hash is stored). A person has one open link per purpose: a new one replaces the old. Undefined: too many are open.
  mint(payload: LinkPayload, ttlMs: number, now = Date.now()): string | undefined {
    const mine = (e: { claimed: boolean; stored: Stored }) => !e.claimed && e.stored.payload.tenant === payload.tenant && e.stored.payload.purpose === payload.purpose;
    const open = this.entries(now);
    for (const e of open) if (mine(e)) rmSync(e.file, { force: true });
    if (open.filter((e) => !mine(e)).length >= MAX_OPEN) return undefined;
    const code = randomBytes(16).toString("base64url");
    writeFileSync(join(this.dir, `${hashOf(code)}.json`), JSON.stringify({ expires: now + ttlMs, created: now, payload } satisfies Stored), { mode: 0o600, flag: "wx" });
    return code;
  }

  // The open link a code is, compared in constant time against every open link (no early exit), or undefined.
  private find(code: string, now: number): { file: string; hash: string; stored: Stored } | undefined {
    if (!LINK_CODE.test(code)) return undefined;
    const want = Buffer.from(hashOf(code));
    let hit: { file: string; hash: string; stored: Stored } | undefined;
    for (const e of this.entries(now)) if (!e.claimed && timingSafeEqual(Buffer.from(e.hash), want)) hit = e;
    return hit;
  }

  // The payload of a valid link, which stays valid (the form is shown with this).
  peek(code: string, now = Date.now()): LinkPayload | undefined {
    return this.find(code, now)?.stored.payload;
  }

  // Takes the link for the store step: exactly one caller can, however many arrive at the same moment (replay, double submit).
  claim(code: string, now = Date.now()): Claim | undefined {
    const hit = this.find(code, now);
    if (!hit) return undefined;
    const claimed = join(this.dir, `${hit.hash}.claimed`);
    try {
      renameSync(hit.file, claimed);
    } catch {
      return undefined; // somebody else got there first
    }
    return { payload: hit.stored.payload, burn: () => rmSync(claimed, { force: true }), release: () => renameSync(claimed, hit.file) };
  }

  // Is a link for this person and purpose open (minted, not yet used or expired)?
  isOpen(payload: LinkPayload, now = Date.now()): boolean {
    return this.entries(now).some((e) => !e.claimed && e.stored.payload.tenant === payload.tenant && e.stored.payload.purpose === payload.purpose);
  }

  count(now = Date.now()): number {
    return this.entries(now).length;
  }
}

// ---- what a minted link looks like ----

// Why no link can be offered, or undefined when links can be. INTAKE_BASE_URL must be https (the tunnel's address); an http one is allowed only for a
// loopback address and only with INTAKE_ALLOW_HTTP_LOOPBACK (tests). Without INTAKE_BASE_URL there is no page to send anybody to.
export function baseUrlProblem(cfg: Pick<typeof settings.intake, "baseUrl" | "allowHttpLoopback"> = settings.intake): string | undefined {
  if (!cfg.baseUrl) return "setup link not available yet (INTAKE_BASE_URL is not set)";
  let u: URL;
  try {
    u = new URL(cfg.baseUrl);
  } catch {
    return "INTAKE_BASE_URL is not an address";
  }
  if (u.protocol === "https:") return undefined;
  if (u.protocol === "http:" && cfg.allowHttpLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return undefined;
  return "INTAKE_BASE_URL must be an https:// address (a tunnel terminates TLS)";
}

export const linkUrl = (base: string, code: string): string => `${base.replace(/\/+$/, "")}/i/${code}`;

// ---- what was stored, for the model: names and lengths, never a value ----

export const STATUS_FILE = "state/intake-status.json";
export interface Done {
  at: string; // ISO time
  stored: { name: string; chars: number }[];
}
type StatusFile = Record<string, Record<string, Done>>; // tenant -> purpose -> the last completed form

export const readDone = (tenant: string, purpose: string): Done | undefined => readJson<StatusFile>(STATUS_FILE, {})[tenant]?.[purpose];
// Written by the intake page only (one writer).
export function recordDone(tenant: string, purpose: string, stored: Done["stored"], now = new Date()): void {
  const all = readJson<StatusFile>(STATUS_FILE, {});
  writeJson(STATUS_FILE, { ...all, [tenant]: { ...all[tenant], [purpose]: { at: now.toISOString(), stored } } });
}
