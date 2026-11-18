import { addrs } from "../../policy/mailview.ts";

// The person's own mail addresses as Mailbird reports them (list_accounts), read by code over its own connection: the recipient floor counts them as known (autojudge.ts).

// Pure: every plain address in the account rows' address fields (email, emailAddress, address, ...), lower case. Anything else in a row is ignored.
export function accountAddresses(list: unknown): string[] {
  const rows = Array.isArray(list) ? list : [];
  const found = rows.flatMap((r) => (r && typeof r === "object" ? Object.entries(r).filter(([k, v]) => /mail|address/i.test(k) && typeof v === "string").flatMap(([, v]) => addrs(v)) : []));
  return [...new Set(found.map((a) => a.toLowerCase()))];
}

// The accounts change rarely: a non-empty answer is kept for `ttlMs`. An empty or failed read gives none (the floor then treats the address as outside) and is not
// kept; after a failure the next `retryMs` give none at once, so a hung client does not hold up every send.
export function cachedAccounts(read: () => Promise<unknown>, ttlMs: number, now: () => number = Date.now, retryMs = 60_000): () => Promise<readonly string[]> {
  let kept: { at: number; list: string[] } | undefined;
  let failedAt: number | undefined;
  return async () => {
    if (kept && now() - kept.at < ttlMs) return kept.list;
    if (failedAt !== undefined && now() - failedAt < retryMs) return [];
    try {
      const list = accountAddresses(await read());
      kept = list.length ? { at: now(), list } : undefined;
      failedAt = list.length ? undefined : now();
      return list;
    } catch {
      kept = undefined;
      failedAt = now();
      return [];
    }
  };
}
