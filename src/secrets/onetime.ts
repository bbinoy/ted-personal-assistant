import { createHash, randomInt } from "node:crypto";
import { readJson, writeJson } from "../state.ts";

// One-time codes: an invitation to a friend, or, later, the ticket of a one-time link. A code is shown once, to whoever minted it;
// only its hash is kept, with an expiry and a small payload. Redeeming one removes it in the same synchronous step that finds it
// (state.ts: a read-modify-write cannot interleave), so a code works exactly once, even if two messages carry it at the same moment.

// 12 characters from 31 (no 0/O/1/I/L), shown as XXXX-XXXX-XXXX: about 59 bits.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_PATTERN = /\b[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}\b/i;
const MAX_OPEN = 200; // open codes at once: a bound on the file, and on how much guessing a code is worth

interface Entry<P> {
  hash: string;
  expires: number; // epoch ms
  created: number;
  payload: P;
}

const hashOf = (code: string): string => createHash("sha256").update(normalise(code)).digest("hex");
// Case and the dashes do not matter when a person types or pastes a code.
export const normalise = (code: string): string => code.toUpperCase().replace(/[^2-9A-HJKMNP-Z]/g, "");

export function newCode(): string {
  const c = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

export class OneTimeCodes<P> {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  private read(now: number): Entry<P>[] {
    return readJson<{ codes?: Entry<P>[] }>(this.file, {}).codes?.filter((e) => e.expires > now) ?? []; // an expired code is gone for good
  }
  // The new code (shown once; only its hash is stored). Undefined: too many are open.
  mint(payload: P, ttlMs: number, now = Date.now()): string | undefined {
    const open = this.read(now);
    if (open.length >= MAX_OPEN) return undefined;
    const code = newCode();
    open.push({ hash: hashOf(code), expires: now + ttlMs, created: now, payload });
    writeJson(this.file, { codes: open });
    return code;
  }
  // The payload of a valid code, which is used up now; undefined for an unknown, expired or already used one.
  redeem(code: string, now = Date.now()): P | undefined {
    const open = this.read(now);
    const h = hashOf(code);
    const at = open.findIndex((e) => e.hash === h);
    if (at < 0) return undefined;
    const [hit] = open.splice(at, 1);
    writeJson(this.file, { codes: open });
    return hit!.payload;
  }
  count(now = Date.now()): number {
    return this.read(now).length;
  }
}
