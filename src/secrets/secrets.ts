import { readFileSync } from "node:fs";
import { macKeychain, type Keychain } from "./keychain.ts";
import { BaoError, OpenBao, type Data } from "./openbao.ts";
import { settings } from "../core/settings.ts";

// The tenant layer over the OpenBao client. Every secret item of the app lives at <mount>/tenants/<tenant>/<kind>/<name>, and a TenantSecrets
// can reach only its own tenant's folder (and the tenant's token policy says the same in OpenBao: defence in depth). Code uses this, never the
// model. Today there is one tenant, "owner"; a later multi-user setup adds tenants without moving anything.

export const OWNER = "owner";
export const TENANT_ID = /^[a-z][a-z0-9_-]{0,31}$/;
export const ITEM_NAME = /^[a-z][a-z0-9._-]{0,39}$/;

// The kinds of item. A card is the owner's own, dedicated card and nobody else's: a friend's card verification code must never be stored
// (PCI DSS forbids keeping it after authorisation, and it is no help to anyone but a thief). Enforced here, whatever the caller asks.
// `google`: a friend's Google OAuth grant (tenants/<id>/google/oauth: her refresh token and her address), written by the intake page's callback (googleoauth.ts),
// read only by the process that starts her Google server (googlemcp.ts). Her own folder like any other kind.
// `notion`: the same for her Notion grant (tenants/<id>/notion/oauth: access token, ROTATING refresh token, the client id they were issued to), written by the
// callback and by the refresh (notionoauth.ts), read only by the process that calls the hosted Notion server (notionmcp.ts).
//
// THE one list of kinds (a new kind is one entry here and its Purpose in intakepurposes.ts): the intake page's writer (intakestore.ts), the doctor's probe of the intake token
// and BOTH OpenBao policies (openbaoadmin.ts policyHcl, intakePolicyHcl) are derived from it. `app`: what the app's own token may do with this kind in ANY tenant's folder
// (beyond its own tenant's folder, which it has in full): the process that serves a friend reads her grant, never her profile or card.
export interface ItemKindRule {
  app?: { capabilities: readonly string[]; comment: string };
}
const RULES = {
  profile: {},
  card: {},
  google: { app: { capabilities: ["read"], comment: "A friend's Google grant (the intake page writes it, the process that starts her Google server reads it): read only, nothing else of hers." } },
  notion: { app: { capabilities: ["read", "create", "update"], comment: "A friend's Notion grant: read, and create and update, because Notion's refresh tokens rotate and the new one is written back before it is used (notionoauth.ts). No delete, no list." } },
} as const satisfies Record<string, ItemKindRule>;
export type ItemKind = keyof typeof RULES;
export const ITEM_KINDS: readonly ItemKind[] = Object.keys(RULES) as ItemKind[];
export const itemKindRule = (kind: ItemKind): ItemKindRule => RULES[kind];
export const GOOGLE_ITEM = "oauth";
export const NOTION_ITEM = "oauth";
export const CARD_TENANTS: ReadonlySet<string> = new Set([OWNER]);

// The same rule for what the intake page writes (intakestore.ts): a card record of anyone but the owner has no security code in it, under any name.
const CVC_FIELD = /^(cvc|cvv|cvn|csc|cid|cvc2|cvv2|security[_ -]?code)$/i;
export const cvcProblem = (tenant: string, data: Data): string | undefined =>
  !CARD_TENANTS.has(tenant) && Object.keys(data).some((k) => CVC_FIELD.test(k)) ? "a card's security code is never stored for this tenant" : undefined;

export class SecretsError extends Error {}

export class TenantSecrets {
  readonly bao: OpenBao;
  readonly tenant: string;
  constructor(bao: OpenBao, tenant: string = OWNER) {
    if (!TENANT_ID.test(tenant)) throw new SecretsError("not a tenant id");
    this.bao = bao;
    this.tenant = tenant;
  }

  private folder(kind: ItemKind): string {
    if (!ITEM_KINDS.includes(kind)) throw new SecretsError("not a kind of secret item");
    if (kind === "card" && !CARD_TENANTS.has(this.tenant)) throw new SecretsError("a card is never stored for this tenant (only the owner's own card; a friend's security code is never kept)");
    return `tenants/${this.tenant}/${kind}`;
  }
  private path(kind: ItemKind, name: string): string {
    const folder = this.folder(kind);
    if (!ITEM_NAME.test(name)) throw new SecretsError("not a valid item name");
    return `${folder}/${name}`;
  }

  async get(kind: ItemKind, name: string, o: { cache?: boolean } = {}): Promise<Data | undefined> {
    return this.bao.read(this.path(kind, name), o);
  }
  async put(kind: ItemKind, name: string, data: Data): Promise<void> {
    return this.bao.write(this.path(kind, name), data);
  }
  async remove(kind: ItemKind, name: string): Promise<boolean> {
    return this.bao.delete(this.path(kind, name));
  }
  // The item names of a kind, sorted (folders left out).
  async names(kind: ItemKind, o: { cache?: boolean } = {}): Promise<string[]> {
    return (await this.bao.list(this.folder(kind), o)).filter((n) => !n.endsWith("/")).sort();
  }
}

// ---- the app's own connection ----

// Service names of this Mac's Keychain items, from OPENBAO_KEYCHAIN_PREFIX.
export const keychainNames = (prefix: string = settings.openbao.keychainPrefix) => ({
  token: `${prefix}-token`, // the app's own token (policy: tenants/owner/ only)
  intake: `${prefix}-intake`, // the intake page's token (policy: create and update of profile and card items, nothing else: no read, no list, no delete)
  operator: `${prefix}-operator`, // the setup tool's token (policy: root generation, rekey, snapshot; no secrets)
  share: (n: number) => `${prefix}-unseal-${n}`,
});

export function caPemOf(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// The app's OpenBao client: the token comes from the Keychain (kept in memory once read, never written anywhere else). `as: "intake"` is the intake
// page's own write-only token; everything else uses the app's.
export function appBao(o: { keychain?: Keychain; cfg?: typeof settings.openbao; as?: "app" | "intake"; cacheMs?: number } = {}): OpenBao {
  const cfg = o.cfg ?? settings.openbao;
  const keychain = o.keychain ?? macKeychain;
  let token: { v: string; at: number } | undefined; // kept in memory for a few minutes, so a token replaced by a new setup is picked up without a restart
  const caPem = caPemOf(cfg.caCert);
  if (!caPem && cfg.addr.startsWith("https:")) throw new BaoError(`the pinned certificate ${cfg.caCert} is missing (npm run openbao -- setup)`);
  return new OpenBao({
    addr: cfg.addr,
    mount: cfg.mount,
    ...(caPem ? { caPem } : {}),
    timeoutMs: 5000,
    cacheMs: o.cacheMs ?? 30_000, // how long profile reads may be served from memory (the card is never cached); a test passes 0
    token: async () => {
      if (!token || Date.now() - token.at > 300_000) {
        const names = keychainNames(cfg.keychainPrefix);
        const v = await keychain.get(o.as === "intake" ? names.intake : names.token);
        if (!v) throw new BaoError("no token");
        token = { v, at: Date.now() };
      }
      return token.v;
    },
  });
}

let shared: TenantSecrets | undefined;
// The owner's secrets, built on first use. Throws a BaoError (a plain reason) when the connection cannot be set up.
export function ownerSecrets(): TenantSecrets {
  return (shared ??= new TenantSecrets(appBao(), OWNER));
}

// ---- the instance key ----

// Tenants have no keys of their own: they run on TENANT_ANTHROPIC_API_KEY (settings.tenantApiKey). This is only the shape check the doctor uses.
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{16,300}$/;
export const looksLikeApiKey = (v: unknown): v is string => typeof v === "string" && KEY_SHAPE.test(v);

// ---- removing a friend ----

// Every item under tenants/<tenant>/ (all kinds), for good. How many were there. The app's own token may delete only the owner's folder (the store's policy,
// openbaoadmin.ts): for a friend this is for the admin's root token (npm run openbao -- forget-tenant <id>); the app's call is refused with a BaoError 403.
export async function deleteTenantItems(bao: OpenBao, tenant: string): Promise<number> {
  if (!TENANT_ID.test(tenant) || tenant === OWNER) throw new SecretsError("not a friend's tenant id");
  let n = 0;
  for (const kind of ITEM_KINDS) {
    for (const name of await bao.list(`tenants/${tenant}/${kind}`, { cache: false })) {
      if (name.endsWith("/")) continue; // (items are flat today)
      if (await bao.delete(`tenants/${tenant}/${kind}/${name}`)) n++;
    }
  }
  return n;
}
