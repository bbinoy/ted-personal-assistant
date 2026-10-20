// Opening a web page. Either way the judge never sees mail or page text, only the owner's words, a member's words or the job's instructions. The floor is
// about what the ADDRESS can carry out: a fetched URL is also a way to send data away in its query string. So: https, no credentials, a named public
// host (no IP address, localhost or local name), a short address and a short query, no fragment. Whether the page is related to the request is the
// judge's call; whether the address is safe to even consider is code's. (The builtin tool module hands this check to the floor, src/modules/builtin.ts.)
const LOCAL_HOST = /(^|\.)(localhost|local|internal|lan|home|corp|test|invalid|example|localdomain|intranet|private)$/i;
// Public names that resolve to a private or loopback address anyway (127.0.0.1.nip.io, 192-168-1-5.sslip.io, localtest.me), so a
// "named public host" can still point inside this machine's network.
export const REBINDING_HOST = /(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me|lacolhost\.com|traefik\.me)$|(^|[.-])\d{1,3}([.-])\d{1,3}\2\d{1,3}\2\d{1,3}($|[.-])/i;
export function isPlainWebAddress(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 300) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname;
  return (
    u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash &&
    u.search.length <= 120 && host.includes(".") && !LOCAL_HOST.test(host) && !REBINDING_HOST.test(host) && !/^[\d.]+$/.test(host) && !host.includes(":") && !host.startsWith("[")
  );
}
