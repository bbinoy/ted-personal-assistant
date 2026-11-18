import { addrs } from "../../policy/mailview.ts";

// The person's own mail addresses as Mailbird reports them (list_accounts), read by code over its own connection: the recipient floor counts them as known (autojudge.ts).

// Pure: every plain address in the account rows' address fields (email, emailAddress, address, ...), lower case. Anything else in a row is ignored.
export function accountAddresses(list: unknown): string[] {
  const rows = Array.isArray(list) ? list : [];
  const found = rows.flatMap((r) => (r && typeof r === "object" ? Object.entries(r).filter(([k, v]) => /mail|address/i.test(k) && typeof v === "string").flatMap(([, v]) => addrs(v)) : []));
  return [...new Set(found.map((a) => a.toLowerCase()))];
}

// The accounts change rarely: one answer is kept for `ttlMs`. A failed read gives none (the floor then treats the address as outside) and is tried again at the next call.
export function cachedAccounts(read: () => Promise<unknown>, ttlMs: number, now: () => number = Date.now): () => Promise<readonly string[]> {
  let kept: { at: number; list: string[] } | undefined;
  return async () => {
    if (kept && now() - kept.at < ttlMs) return kept.list;
    try {
      kept = { at: now(), list: accountAddresses(await read()) };
      return kept.list;
    } catch {
      kept = undefined;
      return [];
    }
  };
}
