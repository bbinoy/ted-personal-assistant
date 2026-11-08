import { isIP } from "node:net";
import { MAX_FILE_BYTES } from "@ted-assistant/messenger";
import { Agent, fetch as undiciFetch } from "undici";
import { publicAddresses } from "../browse/browseproxy.ts";
import { addressProblem, dnsResolver, type Resolver } from "../browse/browserules.ts";

// A file from the web for open_file, fetched by code (the model never gets the bytes through a tool result). The rules are the browse worker's, not new ones: https only, a
// named host with a normal port (addressProblem), every address the name resolves to public (publicAddresses: the egress proxy's check), and the same again at every redirect.
// The connection itself uses the addresses that were checked (no second lookup to rebind), the body is streamed and stopped at MAX_FILE_BYTES, and nothing is written to disk.

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60_000;

export type Fetch = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string>; dispatcher?: Agent }) => Promise<Response>;
export interface WebOptions {
  resolve?: Resolver;
  fetch?: Fetch;
}
export type WebSource = (url: string) => Promise<{ name: string; bytes: Buffer }>;

// Why this address may not be fetched, or undefined (pure apart from the lookup).
async function refusal(raw: string, resolve: Resolver): Promise<string | undefined> {
  const bad = addressProblem(raw);
  if (bad) return bad;
  const u = new URL(raw);
  if (u.protocol !== "https:") return "only https addresses are opened";
  const ips = await publicAddresses(u.hostname, resolve);
  return "problem" in ips ? ips.problem : undefined;
}

// An Agent whose connections go to the addresses the check saw, never to a second answer of the resolver.
const pinned = (resolve: Resolver): Agent =>
  new Agent({
    connect: {
      lookup: (host, opts, cb) => {
        publicAddresses(host, resolve).then(
          (ips) => {
            if (!Array.isArray(ips)) return cb(new Error(ips.problem), "", 4);
            const all = ips.map((address) => ({ address, family: isIP(address) }));
            return (opts as { all?: boolean }).all ? (cb as unknown as (e: null, a: typeof all) => void)(null, all) : cb(null, all[0]!.address, all[0]!.family);
          },
          (e) => cb(e as Error, "", 4),
        );
      },
    },
  });

const nameOf = (u: URL): string => {
  try {
    return decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "") || u.hostname;
  } catch {
    return u.hostname;
  }
};

// Fetches the address; throws a sentence the model can be told.
export async function fetchPublic(raw: string, o: WebOptions = {}): Promise<{ name: string; bytes: Buffer }> {
  const resolve = o.resolve ?? dnsResolver;
  const dispatcher = o.fetch ? undefined : pinned(resolve);
  const doFetch: Fetch = o.fetch ?? ((url, init) => undiciFetch(url, init as never) as unknown as Promise<Response>);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    let url = raw;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const why = await refusal(url, resolve);
      if (why) throw new Error(`Cannot open that address: ${why}.`);
      let res: Response;
      try {
        res = await doFetch(url, { redirect: "manual", signal, headers: { accept: "application/pdf,text/plain,image/*,*/*;q=0.5", "user-agent": "Mozilla/5.0 (compatible; assistant)" }, ...(dispatcher ? { dispatcher } : {}) });
      } catch {
        throw new Error("Could not fetch that address (no answer, or it refused).");
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        void res.body?.cancel();
        try {
          url = new URL(res.headers.get("location")!, url).toString();
        } catch {
          throw new Error("That address redirects somewhere that is not a valid address.");
        }
        continue;
      }
      if (!res.ok) throw new Error(`That address answered ${res.status}.`);
      const declared = Number(res.headers.get("content-length"));
      if (declared > MAX_FILE_BYTES) throw new Error(`That file is over ${MAX_FILE_BYTES / 1_000_000} MB, too big for me to open.`);
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      if (!reader) throw new Error("That address sent no file.");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_FILE_BYTES) {
          void reader.cancel();
          throw new Error(`That file is over ${MAX_FILE_BYTES / 1_000_000} MB, too big for me to open.`);
        }
        chunks.push(Buffer.from(value));
      }
      return { name: nameOf(new URL(url)), bytes: Buffer.concat(chunks) };
    }
    throw new Error("That address redirects too many times.");
  } finally {
    void dispatcher?.close();
  }
}
