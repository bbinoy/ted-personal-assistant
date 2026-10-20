import { looksLikeCardNumber, sensitiveKind } from "./browserules.ts";
import { checkNewValue, cleanDomains, isSensitive, KEY_NAME, KINDS, kindOfKey, listMask, ProfileError, ProfileStore, type Entry, type Kind } from "./profile.ts";

// The owner's local command for the saved profile: npm run profile -- set|list|domains|delete. The value is typed at a hidden terminal
// prompt, never given as an argument (shell history, process list) and never through the chat (logged, goes to the model).

export interface CliDeps {
  store: ProfileStore;
  readHidden: (prompt: string) => Promise<string>;
  out: (line: string) => void;
}

const USAGE = [
  "usage: npm run profile -- <command>",
  "  set <key> [--kind name|email|phone|address|nationality|dob|id|other] [--domains sbb.ch,trainline.com] [--labels word,word]",
  "      asks for the value at a hidden prompt. Keys are lowercase words like first_name, email, passport, loyalty.sbb",
  "  domains <key> [sbb.ch,trainline.com]   restrict where a value may be typed (no list: any https page, only for name, email, phone, address, nationality)",
  "  list                                   keys, kinds and domains, values masked",
  "  delete <key>",
];

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const csv = (s: string | undefined): string[] => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// Returns the exit code.
export async function profileCli(argv: string[], d: CliDeps): Promise<number> {
  const [cmd, key, ...rest] = argv;
  try {
    if (cmd === "list") {
      const entries = await d.store.read();
      const keys = Object.keys(entries).sort();
      if (!keys.length) d.out("The profile is empty. Add a value with: npm run profile -- set <key>");
      for (const k of keys) {
        const e = entries[k]!;
        const where = e.domains.length ? e.domains.join(", ") : isSensitive(e) ? "NO DOMAIN SET: will not be filled anywhere" : "any https page";
        d.out(`${k.padEnd(22)} ${e.kind.padEnd(12)} ${listMask(e).padEnd(18)} ${where}`);
      }
      return 0;
    }
    if (cmd === "set" && key) {
      if (!KEY_NAME.test(key)) return fail(d, "A key is lowercase letters, digits, dot, dash or underscore, starting with a letter (like first_name or loyalty.sbb).");
      const kind = (flag(rest, "kind") as Kind | undefined) ?? kindOfKey(key);
      if (!KINDS.includes(kind)) return fail(d, `Unknown kind. Use one of: ${KINDS.join(", ")}.`);
      const { domains, bad } = cleanDomains(csv(flag(rest, "domains")));
      if (bad.length) return fail(d, `Not a domain: ${bad.join(", ")}`);
      const value = (await d.readHidden(`Value for ${key} (hidden): `)).trim();
      const problem = checkNewValue(value);
      if (problem) return fail(d, `Not saved: ${problem}.`);
      // This is not a vault for card numbers or passwords: those are never typed by the assistant.
      if (looksLikeCardNumber(value) || sensitiveKind(key, value)) return fail(d, "Not saved: that looks like a card number, a password or a bank detail. Those are never stored and never typed by the assistant.");
      const old = await d.store.get(key);
      const entry: Entry = { value, kind, domains: domains.length ? domains : old?.domains ?? [], ...(csv(flag(rest, "labels")).length ? { labels: csv(flag(rest, "labels")) } : old?.labels ? { labels: old.labels } : {}) };
      await d.store.set(key, entry);
      d.out(`Saved ${key} (${kind}, ${value.length} characters).`);
      if (isSensitive(entry) && !entry.domains.length) d.out(`It will not be filled anywhere until you name the sites: npm run profile -- domains ${key} sbb.ch,trainline.com`);
      return 0;
    }
    if (cmd === "domains" && key) {
      const e = await d.store.get(key);
      if (!e) return fail(d, `No key ${key}.`);
      const { domains, bad } = cleanDomains(csv(rest[0]));
      if (bad.length) return fail(d, `Not a domain: ${bad.join(", ")}`);
      e.domains = domains;
      await d.store.set(key, e);
      d.out(domains.length ? `${key} may be typed on: ${domains.join(", ")} (and their subdomains).` : isSensitive(e) ? `${key} now has no domain: it will not be filled anywhere.` : `${key} may be typed on any https page.`);
      return 0;
    }
    if (cmd === "delete" && key) {
      if (!(await d.store.delete(key))) return fail(d, `No key ${key}.`);
      d.out(`Deleted ${key}.`);
      return 0;
    }
  } catch (e) {
    if (e instanceof ProfileError) return fail(d, e.message);
    throw e;
  }
  USAGE.forEach(d.out);
  return cmd ? 1 : 0;
}

const fail = (d: CliDeps, msg: string): number => (d.out(msg), 1);

// A prompt that does not echo what is typed. A terminal is required: a piped value would sit in a script or shell history.
export function readHiddenFromTerminal(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error("This needs a terminal (the value is typed at a hidden prompt)."));
    process.stdout.write(prompt);
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          return reject(new Error("Cancelled."));
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}
