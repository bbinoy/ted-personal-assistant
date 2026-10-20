import { normalizeDomain } from "../../core/domains.ts";
import { BaoError } from "../../secrets/openbao.ts";
import { ownerSecrets, SecretsError, type TenantSecrets } from "../../secrets/secrets.ts";

// The owner's saved details (name, address, passport number, loyalty numbers...) for the browse worker. NOT secrets in the card-and-password
// sense (those are never stored, see browserules.ts), but private: they live in OpenBao (secrets.ts, openbao.ts) as one item per key at
// tenants/<tenant>/profile/<key>, reached with the app's own narrowly scoped token (kept in the macOS Keychain). The values are entered ONLY at
// a local terminal (profilecli.ts): never through the chat, which is logged and goes to the model. Code reads them to type into a page
// (browseguard.ts); the model sees key names, never values. Everything fails closed: OpenBao not running, sealed, a refused token or an
// item that is not a whole entry means "no profile", never a guess.

export type Kind = "name" | "email" | "phone" | "address" | "nationality" | "dob" | "id" | "other";
export const KINDS: readonly Kind[] = ["name", "email", "phone", "address", "nationality", "dob", "id", "other"];
export interface Entry {
  value: string;
  kind: Kind;
  domains: string[]; // registered domains this value may be typed on; empty: any https page (only allowed for kinds that are not sensitive)
  labels?: string[]; // words a field label may carry for this key (for kind "other", e.g. a loyalty number)
}
export type Entries = Record<string, Entry>;

// Sensitive: only on a domain the owner named, and only masked in the approval question. Everything but name, email, phone, address, nationality.
export const SENSITIVE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["dob", "id", "other"]);
export const isSensitive = (e: Pick<Entry, "kind">): boolean => SENSITIVE_KINDS.has(e.kind);
export const KEY_NAME = /^[a-z][a-z0-9._-]{0,39}$/;
export const MAX_VALUE = 200;

export class ProfileError extends Error {}

// What OpenBao gave for one key, checked: anything that is not a whole entry is no entry.
export function entryOf(key: string, raw: unknown): Entry | undefined {
  const e = raw as Partial<Entry> | null | undefined;
  if (!KEY_NAME.test(key) || !e || typeof e !== "object" || typeof e.value !== "string" || !KINDS.includes(e.kind as Kind)) return undefined;
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
  return { value: e.value, kind: e.kind as Kind, domains: strings(e.domains), ...(Array.isArray(e.labels) ? { labels: strings(e.labels).slice(0, 8) } : {}) };
}

// Runs `f` on the holder's tenant secrets. The connection is made on first use (the Keychain and the pinned certificate are read then), and
// every problem with it or with OpenBao is a ProfileError that says why and never holds a value.
export async function inTenant<T>(holder: { secrets?: TenantSecrets }, f: (s: TenantSecrets) => Promise<T>): Promise<T> {
  try {
    holder.secrets ??= ownerSecrets();
    return await f(holder.secrets);
  } catch (e) {
    if (e instanceof BaoError || e instanceof SecretsError) throw new ProfileError(e.message);
    throw e;
  }
}

// The store: the owner's profile items in OpenBao. Every call fails closed with a ProfileError that says why (never a value).
export class ProfileStore {
  secrets?: TenantSecrets;
  constructor(secrets?: TenantSecrets) {
    this.secrets = secrets;
  }
  private call<T>(f: (s: TenantSecrets) => Promise<T>): Promise<T> {
    return inTenant(this, f);
  }

  // All entries by key. A key that holds something that is not a whole entry is left out.
  async read(): Promise<Entries> {
    return this.call(async (s) => {
      const out: Entries = {};
      const items = await Promise.all((await s.names("profile")).map(async (k) => [k, await s.get("profile", k)] as const));
      for (const [k, raw] of items) {
        const e = entryOf(k, raw);
        if (e) out[k] = e;
      }
      return out;
    });
  }

  async get(key: string): Promise<Entry | undefined> {
    return this.call(async (s) => entryOf(key, await s.get("profile", key)));
  }

  async set(key: string, entry: Entry): Promise<void> {
    if (!KEY_NAME.test(key)) throw new ProfileError("not a valid key");
    await this.call((s) => s.put("profile", key, { value: entry.value, kind: entry.kind, domains: entry.domains, ...(entry.labels ? { labels: entry.labels } : {}) }));
  }

  async delete(key: string): Promise<boolean> {
    return this.call((s) => s.remove("profile", key));
  }
}

// ---- kinds, masks, which field a key may go into ----

// Pure. The kind a key name suggests (the owner can set it explicitly).
export function kindOfKey(key: string): Kind {
  const k = key.toLowerCase();
  if (/e-?mail/.test(k)) return "email";
  if (/phone|mobile|\btel|handy|natel/.test(k)) return "phone";
  if (/birth|dob|geburt/.test(k)) return "dob";
  if (/nationalit|citizen/.test(k)) return "nationality";
  if (/passport|passnummer|(^|[._-])id([._-]|$)|identity|licen[cs]e|ahv|ssn|national/.test(k)) return "id";
  if (/address|street|city|zip|postal|plz|country|town|adresse/.test(k)) return "address";
  if (/name/.test(k)) return "name";
  return "other";
}

// What a field's accessible name must look like for a key of this kind (English, German, French). "other" kinds are matched on the key's words.
const FIELD: Record<Exclude<Kind, "other">, RegExp> = {
  name: /name|vorname|nachname|surname|prénom|prenom|\bnom\b|given|family|first|last\b|anrede|title|salutation/i,
  email: /e-?mail|\bmail\b/i,
  phone: /phone|mobile|\btel\b|telefon|handy|natel|\bcell\b|portable/i,
  address: /address|adresse|street|stra(ß|ss)e|\bcity\b|\btown\b|\bort\b|stadt|\bzip\b|postal|\bplz\b|post\s*code|country|\bland\b|\bstate\b|province|\brue\b|ville|\bhouse\b/i,
  nationality: /nationalit|citizen|staatsang/i,
  dob: /birth|\bdob\b|geburt|naissance|\bborn\b/i,
  id: /passport|reisepass|passeport|identity|\bid\b|ausweis|identit|document\s*(number|no)|licen[cs]e|\bahv\b/i,
};
const NOT_A_PERSON_NAME = /user\s*name|benutzer|login|company|firma|card\s*holder|account\s*name/i;

// Pure. Does this field's accessible name plausibly ask for this key's value? (A card or login field never gets here: browseguard.ts refuses those first.)
export function fieldFitsKey(label: string, key: string, e: Pick<Entry, "kind" | "labels">): boolean {
  const l = label.trim();
  if (!l) return false;
  if (e.kind === "name" && NOT_A_PERSON_NAME.test(l)) return false;
  if (e.kind !== "other") return FIELD[e.kind].test(l);
  const words = [...(e.labels ?? []), ...key.split(/[._-]/)].map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
  return words.some((w) => l.toLowerCase().includes(w));
}

// Pure. A value as the owner's terminal and the approval question show it: a sensitive one only by its last four characters.
export function maskValue(value: string, sensitive: boolean): string {
  if (sensitive) return value.length >= 8 ? `••••${value.slice(-4)} (last 4)` : "••••";
  return value;
}
export const listMask = (e: Entry): string => (isSensitive(e) ? maskValue(e.value, true) : `${e.value.slice(0, 2)}•••`);

export function checkNewValue(value: string): string | undefined {
  if (!value.trim()) return "an empty value";
  if (value.length > MAX_VALUE) return `longer than ${MAX_VALUE} characters`;
  if (/[\r\n]/.test(value)) return "a value with a line break";
  return undefined;
}

export const cleanDomains = (list: string[]): { domains: string[]; bad: string[] } => {
  const domains: string[] = [];
  const bad: string[] = [];
  for (const raw of list) {
    const d = normalizeDomain(raw);
    if (d) domains.includes(d) || domains.push(d);
    else if (raw.trim()) bad.push(raw);
  }
  return { domains, bad };
};

// The run's view: the entries kept in memory for one browse run (the owner's chat only). Undefined when there is no profile or it cannot be read.
export interface Profile {
  entries: Entries;
}
export async function loadProfile(store: ProfileStore = new ProfileStore(), onProblem: (reason: string) => void = () => {}): Promise<Profile | undefined> {
  try {
    const entries = await store.read();
    return Object.keys(entries).length ? { entries } : undefined;
  } catch (e) {
    onProblem((e as Error).message);
    return undefined;
  }
}
