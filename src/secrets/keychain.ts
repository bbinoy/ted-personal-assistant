import { execFile } from "node:child_process";

// The macOS Keychain through the `security` tool, called with arguments (never through a shell). It holds the two things that must not
// sit in a file: OpenBao's tenant token (the app's only credential) and this Mac's unseal shares. Values go in through the tool's own stdin
// (interactive mode), so they never show in the process list. Everything throws a plain message that never holds a value.

export interface Keychain {
  get(service: string): Promise<string | undefined>; // undefined: there is no such item. Throws when the Keychain cannot be read
  set(service: string, value: string): Promise<void>;
  remove(service: string): Promise<boolean>; // false: there was none
}

const ACCOUNT = "ted";
const SAFE = /^[A-Za-z0-9._-]{1,80}$/;
const VALUE = /^[A-Za-z0-9+/=._-]{1,500}$/; // tokens and base64 shares: no quote, no space, no line break for the stdin command

const run = (args: string[], stdin?: string): Promise<{ code: number; out: string }> =>
  new Promise((resolve, reject) => {
    const child = execFile("security", args, { timeout: 15_000, encoding: "utf8" }, (err, stdout) => {
      if (!err) return resolve({ code: 0, out: stdout });
      const code = (err as { code?: unknown }).code;
      if (typeof code === "number") return resolve({ code, out: stdout });
      reject(new Error("the macOS Keychain could not be used (is this a Mac with the `security` tool?)"));
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

export const macKeychain: Keychain = {
  async get(service) {
    if (!SAFE.test(service)) throw new Error("not a Keychain service name");
    const r = await run(["find-generic-password", "-s", service, "-a", ACCOUNT, "-w"]);
    if (r.code === 44) return undefined; // errSecItemNotFound
    if (r.code !== 0) throw new Error(`the Keychain refused to give an item (security exit ${r.code})`);
    return r.out.trim();
  },
  async set(service, value) {
    if (!SAFE.test(service) || !VALUE.test(value)) throw new Error("not a storable Keychain item");
    const r = await run(["-i"], `add-generic-password -s ${service} -a ${ACCOUNT} -w ${value} -U\n`);
    if (r.code !== 0) throw new Error(`the Keychain refused to store an item (security exit ${r.code})`);
    if ((await this.get(service)) !== value) throw new Error("the item was not stored in the Keychain");
  },
  async remove(service) {
    if (!SAFE.test(service)) throw new Error("not a Keychain service name");
    const r = await run(["delete-generic-password", "-s", service, "-a", ACCOUNT]);
    if (r.code === 44) return false;
    if (r.code !== 0) throw new Error(`the Keychain refused to remove an item (security exit ${r.code})`);
    return true;
  },
};
