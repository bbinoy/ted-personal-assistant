import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Keychain } from "./keychain.ts";
import { BaoError, OpenBao } from "./openbao.ts";
import { keychainNames } from "./secrets.ts";

// Installing, starting, initialising, unsealing and configuring the OpenBao server that holds this app's secrets. Used by
// `npm run openbao` (scripts/openbao.ts) and by the tests. The app itself (openbao.ts, secrets.ts) never needs anything here.
//
// The shape of it, and the honest trade-off (docs/SAFETY.md, docs/SETUP.md):
// - One server on this Mac, listening on 127.0.0.1 only, TLS with a self-signed certificate that the app pins. Integrated Raft storage.
// - Shamir 2 of 3. The Mac's Keychain holds shares 1 and 2, so the keeper job can unseal after a reboot with nobody present (the login is
//   what releases the Keychain). All three are shown ONCE to the owner to record offline, any two unseal: that is the way back if the
//   Mac or its Keychain is lost. Anyone who can use this Mac's Keychain can therefore unseal; sealing protects the data directory, a
//   backup or a stolen disk, not a logged-in attacker.
// - The root token exists only in memory during setup (init or a root regenerated from the shares) and is revoked at the end.
// - The app's token has one policy, limited to tenants/<id>/*, and lives in the Keychain.
// - The intake page (intakeserver.ts) has a token of its own with a WRITE-ONLY policy: it can create and update profile and card items of any
//   tenant and can neither read, list nor delete anything, so the web-facing process holds nothing that can leak a stored value.

// ---- the pinned release ----

// The official release for Apple silicon, pinned. The checksum is the one in the release's checksums.txt (fetched over TLS from github.com on
// 2026-10-17 and equal to the checksum of the file that was downloaded and run); the release also carries a GPG and a sigstore signature of
// that file, which `npm run openbao -- install` does not check (no cosign on this Mac).
export const PIN = {
  version: "2.7.1",
  file: "openbao_2.7.1_darwin_arm64.tar.gz",
  url: "https://github.com/openbao/openbao/releases/download/v2.7.1/openbao_2.7.1_darwin_arm64.tar.gz",
  sha256: "15625b5f69aee5bb4578b4e76e856a2141647342b0f8e5969a8875b44e0fbf91",
} as const;

export interface Layout {
  dir: string;
  bin: string;
  config: string;
  data: string;
  auditDir: string;
  audit: string;
  logs: string;
  tlsDir: string;
  cert: string;
  key: string;
  backups: string;
}
export const layoutOf = (dir: string): Layout => ({
  dir,
  bin: join(dir, "bin/bao"),
  config: join(dir, "config.hcl"),
  data: join(dir, "data"),
  auditDir: join(dir, "audit"),
  audit: join(dir, "audit/audit.log"),
  logs: join(dir, "logs"),
  tlsDir: join(dir, "tls"),
  cert: join(dir, "tls/cert.pem"),
  key: join(dir, "tls/key.pem"),
  backups: join(dir, "backup"),
});

const run = (cmd: string, args: string[], o: { env?: Record<string, string>; timeout?: number } = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout: o.timeout ?? 60_000, ...(o.env ? { env: { ...process.env, ...o.env } } : {}) }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${(stderr || err.message).split("\n")[0]!.slice(0, 160)}`));
      resolve(stdout);
    });
  });

export function ensureDirs(l: Layout): void {
  for (const d of [l.dir, l.data, l.auditDir, l.logs, l.tlsDir, l.backups, join(l.dir, "bin")]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
}

// Downloads the pinned release, checks its SHA-256 and puts `bao` in the layout. Does nothing when that version is already there.
export async function installBinary(l: Layout, o: { download?: (url: string) => Promise<Buffer>; out?: (line: string) => void } = {}): Promise<"installed" | "present"> {
  ensureDirs(l);
  if (existsSync(l.bin)) {
    const v = await run(l.bin, ["version"]).catch(() => "");
    if (v.includes(`v${PIN.version} `)) return "present";
  }
  const download =
    o.download ??
    (async (url: string) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!r.ok) throw new Error(`the download failed (status ${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    });
  o.out?.(`Downloading OpenBao ${PIN.version} (${PIN.file})`);
  const bytes = await download(PIN.url);
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== PIN.sha256) throw new Error("the download does not match the pinned checksum: nothing was installed");
  const tmp = join(l.dir, "dl");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  writeFileSync(join(tmp, PIN.file), bytes, { mode: 0o600 });
  await run("/usr/bin/tar", ["-xzf", join(tmp, PIN.file), "-C", tmp, "bao"]);
  chmodSync(join(tmp, "bao"), 0o700);
  renameSync(join(tmp, "bao"), l.bin);
  rmSync(tmp, { recursive: true, force: true });
  const v = await run(l.bin, ["version"]);
  if (!v.includes(`v${PIN.version} `)) throw new Error("the installed binary is not the pinned version");
  return "installed";
}

// ---- the certificate and the config ----

// A self-signed certificate for 127.0.0.1 (the system's own openssl; RSA because its EC keys are not read by OpenBao). The app trusts this one
// file and nothing else, so no other certificate, however it was issued, is accepted for OpenBao.
export async function ensureCert(l: Layout): Promise<"made" | "present"> {
  if (existsSync(l.cert) && existsSync(l.key)) return "present";
  ensureDirs(l);
  await run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-keyout", l.key, "-out", l.cert, "-days", "3650", "-subj", "/CN=ted-openbao", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-addext", "basicConstraints=critical,CA:FALSE"]);
  chmodSync(l.key, 0o600);
  chmodSync(l.cert, 0o644);
  return "made";
}

export function configHcl(l: Layout, addr: string): string {
  const u = new URL(addr);
  const port = Number(u.port || 8200);
  return `# Written by npm run openbao -- setup; safe to regenerate. One node, Raft storage, loopback only.
ui = false
log_level = "warn"
api_addr = "${u.origin}"
cluster_addr = "https://127.0.0.1:${port + 1}"

storage "raft" {
  path    = "${l.data}"
  node_id = "ted"
}

listener "tcp" {
  address         = "127.0.0.1:${port}"
  cluster_address = "127.0.0.1:${port + 1}"
  tls_cert_file   = "${l.cert}"
  tls_key_file    = "${l.key}"
  tls_min_version = "tls13"
}

# Every request and answer is written here with its string values hashed (HMAC-SHA256), never in the clear.
audit "file" "file" {
  description = "Ted audit log"
  options {
    file_path = "${l.audit}"
    mode      = "0600"
  }
}
`;
}

export function writeConfig(l: Layout, addr: string): void {
  ensureDirs(l);
  writeFileSync(l.config, configHcl(l, addr), { mode: 0o600 });
  chmodSync(l.config, 0o600);
}

// ---- the policy ----

export const policyHcl = (mount: string, tenant: string): string => `# The app's token for tenant "${tenant}": its own folder and nothing else.
path "${mount}/data/tenants/${tenant}/*" {
  capabilities = ["create", "read", "update", "delete"]
}
path "${mount}/metadata/tenants/${tenant}/*" {
  capabilities = ["list", "read", "delete"]
}
# A friend's Google grant (the intake page writes it, the process that starts her Google server reads it): read only, nothing else of hers.
path "${mount}/data/tenants/+/google/*" {
  capabilities = ["read"]
}
`;

// The setup tool's own token. It can only ask for a root token (which also needs the unseal shares) and take a snapshot; it reads no secret.
// OpenBao 2.7 turns the unauthenticated root-generation endpoints off, so something must hold this much to repair or rotate later.
export const OPERATOR_POLICY = `path "sys/generate-root-token/*" {
  capabilities = ["create", "read", "update", "delete"]
}
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
`;
export const OPERATOR_ROLE = "ted-operator";

// The intake page's token: create and update on profile and card items (`+` is any one tenant id). No read, no list, no delete, no metadata, no other kind.
export const INTAKE_ROLE = "ted-intake";
export const intakePolicyHcl = (mount: string): string => `# The intake page's token: write-only.
path "${mount}/data/tenants/+/profile/*" {
  capabilities = ["create", "update"]
}
path "${mount}/data/tenants/+/card/*" {
  capabilities = ["create", "update"]
}
path "${mount}/data/tenants/+/google/*" {
  capabilities = ["create", "update"]
}
`;

// ---- the admin ----

export interface AdminOptions {
  layout: Layout;
  addr: string;
  mount: string;
  role: string; // the policy and the token role of the owner's tenant
  tenant: string;
  prefix: string; // Keychain item prefix
  keychain: Keychain;
}

export interface SetupIo {
  out: (line: string) => void;
  // Shows the three recovery shares once; true when the owner confirmed having recorded them (false: they did not manage to, and setup
  // finishes anyway, so a mistyped confirmation never leaves OpenBao half set up). They never go anywhere else.
  showShares: (shares: string[]) => Promise<boolean | void>;
}

// the authenticated endpoints wrap their answer in "data"
const unwrap = (r: any): any => (r && typeof r === "object" && r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : r);
const SHARES = 3;
const THRESHOLD = 2;

export class Admin {
  readonly o: AdminOptions;
  constructor(o: AdminOptions) {
    this.o = o;
  }

  private api(token = ""): OpenBao {
    const caPem = existsSync(this.o.layout.cert) ? readFileSync(this.o.layout.cert, "utf8") : undefined;
    return new OpenBao({ addr: this.o.addr, mount: this.o.mount, token: async () => token, ...(caPem ? { caPem } : {}), timeoutMs: 20_000 });
  }

  health() {
    return this.api().health();
  }

  // Waits until the server answers (it was just started).
  async waitUp(seconds = 30): Promise<void> {
    const until = Date.now() + seconds * 1000;
    for (;;) {
      try {
        await this.health();
        return;
      } catch (e) {
        if (Date.now() > until) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  private async operatorApi(): Promise<OpenBao> {
    const t = await this.o.keychain.get(keychainNames(this.o.prefix).operator);
    if (!t) throw new Error("this Mac's Keychain has no operator token (setup made it); without it only OpenBao's recovery mode can issue a root token, see docs/SETUP.md");
    return this.api(t);
  }

  private async savedShares(): Promise<string[]> {
    const n = keychainNames(this.o.prefix);
    const out: string[] = [];
    for (let i = 1; i <= THRESHOLD; i++) {
      const s = await this.o.keychain.get(n.share(i));
      if (s) out.push(s);
    }
    return out;
  }

  private async saveShares(shares: string[]): Promise<void> {
    const n = keychainNames(this.o.prefix);
    for (let i = 1; i <= THRESHOLD; i++) await this.o.keychain.set(n.share(i), shares[i - 1]!);
  }

  // Unseals with the given shares. True when it is unsealed afterwards (and this node is the active one: a fresh node needs a moment).
  async unsealWith(shares: string[]): Promise<boolean> {
    const api = this.api();
    let open = false;
    for (const key of shares) {
      const r = await api.raw("PUT", "sys/unseal", { key }, { auth: false });
      if (r?.sealed === false) {
        open = true;
        break;
      }
    }
    if (!open && (await this.health()).sealed !== false) return false;
    for (let i = 0; i < 60; i++) {
      if ((await api.raw("GET", "sys/leader", undefined, { auth: false }).catch(() => undefined))?.is_self === true) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  // What the keeper job does: unseal from this Mac's Keychain when sealed. Says what it did.
  async unsealFromKeychain(): Promise<"unsealed" | "already unsealed" | "not initialised"> {
    const h = await this.health();
    if (!h.initialized) return "not initialised";
    if (!h.sealed) return "already unsealed";
    const shares = await this.savedShares();
    if (shares.length < THRESHOLD) throw new Error("this Mac's Keychain does not hold enough unseal shares: unseal with the recovery shares (npm run openbao -- unseal --recovery)");
    if (!(await this.unsealWith(shares))) throw new Error("the Keychain shares did not unseal OpenBao");
    return "unsealed";
  }

  // A root token from the shares, only in memory (the caller revokes it).
  async generateRoot(shares: string[]): Promise<string> {
    const api = await this.operatorApi();
    const a = unwrap(await api.raw("PUT", "sys/generate-root-token/attempt", {}));
    if (typeof a?.nonce !== "string" || typeof a?.otp !== "string") throw new BaoError("OpenBao gave a root-token answer we do not understand");
    let done: { complete?: boolean; encoded_token?: string } | undefined;
    for (const key of shares) {
      done = unwrap(await api.raw("PUT", "sys/generate-root-token/update", { key, nonce: a.nonce }));
      if (done?.complete) break;
    }
    if (!done?.complete || typeof done.encoded_token !== "string") throw new BaoError("the shares did not produce a root token");
    const enc = Buffer.from(done.encoded_token, "base64");
    const otp = Buffer.from(a.otp, "utf8");
    if (enc.length !== otp.length) throw new BaoError("a root token could not be decoded");
    return Buffer.from(enc.map((b, i) => b ^ otp[i]!)).toString("utf8");
  }

  // The state the app needs: the KV mount, the audit device (declared in the config), the owner's policy, the token role, and a fresh token in the Keychain.
  async configure(root: string, out: (line: string) => void): Promise<void> {
    const api = this.api(root);
    const { mount, role, tenant } = this.o;
    const mounts = await api.raw("GET", "sys/mounts");
    const have = mounts?.[`${mount}/`] ?? mounts?.data?.[`${mount}/`];
    if (!have) {
      await api.raw("POST", `sys/mounts/${mount}`, { type: "kv", options: { version: "2" }, description: "Ted secrets, one folder per tenant" });
      out(`Mounted the key-value store (version 2) at ${mount}/`);
    } else if (have.options?.version !== "2") throw new Error(`${mount}/ exists but is not a key-value version 2 store`);
    // a store just mounted is "upgrading" for a moment and answers 400 until it is ready
    for (let i = 0; ; i++) {
      try {
        await api.raw("POST", `${mount}/config`, { max_versions: 5 });
        break;
      } catch (e) {
        if (i >= 30 || !(e instanceof BaoError) || e.status !== 400) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const audits = await api.raw("GET", "sys/audit");
    const devices = Object.values((audits?.data ?? audits ?? {}) as Record<string, { type?: string }>).filter((d) => d && typeof d === "object" && d.type === "file");
    if (!devices.length) throw new Error(`no file audit device is enabled (the config should declare one; see ${this.o.layout.config})`);
    await api.raw("PUT", `sys/policies/acl/${role}`, { policy: policyHcl(mount, tenant) });
    await api.raw("POST", `auth/token/roles/${role}`, { allowed_policies: [role], orphan: true, period: "768h", renewable: true });
    await api.raw("PUT", `sys/policies/acl/${OPERATOR_ROLE}`, { policy: OPERATOR_POLICY });
    await api.raw("POST", `auth/token/roles/${OPERATOR_ROLE}`, { allowed_policies: [OPERATOR_ROLE], orphan: true, period: "768h", renewable: true });
    await api.raw("PUT", `sys/policies/acl/${INTAKE_ROLE}`, { policy: intakePolicyHcl(mount) });
    await api.raw("POST", `auth/token/roles/${INTAKE_ROLE}`, { allowed_policies: [INTAKE_ROLE], orphan: true, period: "768h", renewable: true });
    const names = keychainNames(this.o.prefix);
    for (const [service, r, label] of [[names.token, role, `ted-${tenant}`], [names.operator, OPERATOR_ROLE, "ted-operator"], [names.intake, INTAKE_ROLE, "ted-intake"]] as const) {
      const old = await this.o.keychain.get(service).catch(() => undefined);
      const created = await api.raw("POST", `auth/token/create/${r}`, { display_name: label });
      const token = created?.auth?.client_token;
      if (typeof token !== "string") throw new BaoError("OpenBao gave a token answer we do not understand");
      await this.o.keychain.set(service, token);
      if (old && old !== token) await api.raw("POST", "auth/token/revoke", { token: old }).catch(() => undefined);
    }
    out(`The app's token (policy ${role}: only tenants/${tenant}/), the setup tool's token (policy ${OPERATOR_ROLE}) and the intake page's write-only token (policy ${INTAKE_ROLE}) are in the Keychain.`);
  }

  private async revoke(root: string): Promise<void> {
    await this.api(root).raw("POST", "auth/token/revoke-self", {}).catch(() => undefined);
  }

  // First run: init, keep shares 1 and 2 in the Keychain, show all three once, unseal, configure, drop the root token.
  // Later runs: unseal from the Keychain if needed, regenerate a root from the Keychain shares, configure again (repair), drop the root.
  // Returns false when the owner did not confirm the recovery shares (OpenBao is set up and works all the same).
  async setup(io: SetupIo): Promise<boolean> {
    await this.waitUp();
    let confirmed = true;
    const h = await this.health();
    let root: string;
    if (!h.initialized) {
      const r = await this.api().raw("POST", "sys/init", { secret_shares: SHARES, secret_threshold: THRESHOLD }, { auth: false });
      const shares: unknown = r?.keys;
      if (!Array.isArray(shares) || shares.length !== SHARES || typeof r?.root_token !== "string") throw new BaoError("OpenBao gave an init answer we do not understand");
      const keys = shares as string[];
      await this.saveShares(keys); // before they are shown: if this fails, nothing was lost that the server cannot be re-initialised from (it is empty)
      io.out("OpenBao is initialised. The Mac keeps two of the three unseal shares in its Keychain (for the automatic unseal).");
      confirmed = (await io.showShares(keys)) !== false;
      if (!(await this.unsealWith(keys.slice(0, THRESHOLD)))) throw new Error("OpenBao did not unseal after init");
      root = r.root_token as string;
    } else {
      if (h.sealed) io.out(`OpenBao was ${await this.unsealFromKeychain()}.`);
      const shares = await this.savedShares();
      if (shares.length < THRESHOLD) throw new Error("OpenBao is already initialised but this Mac's Keychain has no unseal shares: record them again with the recovery shares (npm run openbao -- unseal --recovery) or start over with an empty data directory");
      root = await this.generateRoot(shares);
    }
    try {
      await this.configure(root, io.out);
    } finally {
      await this.revoke(root);
    }
    io.out("The root token was revoked; it was never written anywhere.");
    return confirmed;
  }

  // A Raft snapshot (encrypted by OpenBao itself; useless without the unseal shares), written 0600, with the operator token.
  async backup(): Promise<string> {
    const token = await this.o.keychain.get(keychainNames(this.o.prefix).operator);
    if (!token) throw new Error("this Mac's Keychain has no operator token");
    const file = join(this.o.layout.backups, `raft-${new Date().toISOString().replace(/[:.]/g, "-")}.snap`);
    await run(this.o.layout.bin, ["operator", "raft", "snapshot", "save", file], { env: { BAO_ADDR: this.o.addr, BAO_TOKEN: token, BAO_CACERT: this.o.layout.cert } });
    chmodSync(file, 0o600);
    return file;
  }

  // The keeper's second job: the tokens are periodic and must be renewed before they lapse.
  async renewTokens(): Promise<"renewed" | "not due" | "no token"> {
    const names = keychainNames(this.o.prefix);
    let did: "renewed" | "not due" | "no token" = "not due";
    for (const service of [names.token, names.operator, names.intake]) {
      const token = await this.o.keychain.get(service);
      if (!token) {
        did = "no token";
        continue;
      }
      const api = this.api(token);
      if ((await api.lookupSelf()).ttlSeconds > 16 * 86_400) continue;
      await api.renewSelf();
      if (did === "not due") did = "renewed";
    }
    return did;
  }
}
