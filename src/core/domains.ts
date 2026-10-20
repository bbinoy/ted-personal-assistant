// The registered domain (eTLD+1) of a host: "www.sbb.ch" -> "sbb.ch", "shop.example.co.uk" -> "example.co.uk".
// Not the full public suffix list (a dependency for one comparison): a compact list of the multi-part suffixes of the countries people
// book in, plus hosting platforms where every customer is a subdomain of a shared name, so "evil.github.io" is its own registered domain
// and never counts as "github.io". A suffix missing here is treated as a single label ("a.b.xx" -> "b.xx"). Since a domain binding is a
// registered domain the owner typed, the failure mode is a fill that refuses, or (for an unlisted multi-part suffix) the whole suffix
// counting as one owner's domain: add the suffix here if you meet one. Pure.

const MULTI_PART = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz", "co.za", "org.za", "co.in", "net.in", "org.in", "co.jp", "or.jp", "ne.jp", "ac.jp",
  "com.br", "net.br", "org.br", "com.mx", "org.mx", "com.ar", "com.sg", "com.hk", "com.tr", "co.il", "co.kr", "or.kr", "com.cn", "net.cn", "org.cn", "com.tw", "com.my", "com.ph", "co.th", "com.vn", "com.ua", "com.pl", "com.pt", "com.es", "com.gr", "com.ru",
  // hosting platforms (the private section of the Public Suffix List that people actually meet)
  "github.io", "gitlab.io", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app", "firebaseapp.com", "appspot.com", "blogspot.com", "wordpress.com", "cloudfront.net", "azurewebsites.net", "azurestaticapps.net", "s3.amazonaws.com", "myshopify.com", "wixsite.com", "squarespace.com", "weebly.com", "repl.co", "glitch.me", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "onrender.com", "fly.dev", "surge.sh",
]);

export function registeredDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  return MULTI_PART.has(last2) ? parts.slice(-3).join(".") : last2;
}

// A domain the owner typed ("sbb.ch", "https://www.sbb.ch/en", ".SBB.ch") as the registered domain it binds, or undefined when it is no domain.
export function normalizeDomain(raw: string): string | undefined {
  let h = raw.trim().toLowerCase();
  if (!h) return undefined;
  try {
    if (/^[a-z]+:\/\//.test(h)) h = new URL(h).hostname;
  } catch {
    return undefined;
  }
  h = h.replace(/^\.+/, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || /^[\d.]+$/.test(h)) return undefined;
  return registeredDomain(h);
}

export const hostMatches = (host: string, domains: readonly string[]): boolean => domains.includes(registeredDomain(host));
