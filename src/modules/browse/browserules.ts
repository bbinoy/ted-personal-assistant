import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { REBINDING_HOST } from "../../policy/webaddress.ts";

// The pure rules of the browse sub-task (browse.ts holds the state around them). Everything here is code, never the model:
// which addresses a page may be opened at, what a snapshot says about an element (its REAL role and name, read from the page
// text, not from the description the model wrote), which controls are payment or credential fields, and which clicks commit.

// ---- addresses ----

// The 16 bytes of an IPv6 address (zone id cut, a dotted IPv4 tail allowed), or undefined when it is not one.
function ipv6Bytes(raw: string): number[] | undefined {
  let s = raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!isIP(s) || !s.includes(":")) return undefined;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) s = s.slice(0, tail.index) + ((Number(tail[1]) << 8) | Number(tail[2])).toString(16) + ":" + ((Number(tail[3]) << 8) | Number(tail[4])).toString(16);
  const [head, rest, extra] = s.split("::");
  if (extra !== undefined) return undefined;
  const h = head ? head.split(":") : [];
  const t = rest ? rest.split(":") : [];
  const groups = rest === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8) return undefined;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}
const publicV4 = (a: number, b: number, c: number): boolean =>
  !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c <= 2) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));

// Pure. Is this IP literal (v4 or v6) a public, globally routable unicast address? The one rule of the network layer (browseproxy.ts) and of the DNS checks, so
// every range is in ONE place: 0/8, 10/8, 100.64/10 (CGNAT, Tailscale), 127/8, 169.254/16, 172.16/12, 192.0.0/24 and the documentation ranges, 192.168/16, 198.18/15,
// multicast and reserved; for IPv6 only 2000::/3 outside the protocol-assignment and documentation blocks, with IPv4-mapped (::ffff:), NAT64 (64:ff9b::/96) and 6to4
// (2002::/16) judged by the IPv4 address they carry, Teredo, ULA fc00::/7, link-local fe80::/10 and the rest refused. Anything that is not an IP literal is not public.
export function isPublicAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (v4) {
    const o = v4.slice(1).map(Number);
    return isIP(ip.trim()) === 4 && publicV4(o[0]!, o[1]!, o[2]!);
  }
  const b = ipv6Bytes(ip.trim());
  if (!b) return false;
  const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return publicV4(b[12]!, b[13]!, b[14]!); // ::ffff:a.b.c.d
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return publicV4(b[12]!, b[13]!, b[14]!); // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return publicV4(b[2]!, b[3]!, b[4]!); // 6to4: the IPv4 address inside
  if ((b[0]! & 0xe0) !== 0x20) return false; // not global unicast 2000::/3 (::, ::1, ::/96, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64, 64:ff9b:1::/48 ...)
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2]! < 2 || (b[2] === 0x0d && b[3] === 0xb8))) return false; // 2001::/23 (Teredo, ORCHID, protocol assignments), 2001:db8::/32
  if (b[0] === 0x3f && b[1] === 0xff && (b[2]! & 0xf0) === 0) return false; // 3fff::/20 documentation
  return true;
}
export const isPrivateAddress = (ip: string): boolean => !isPublicAddress(ip);

const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|corp|localdomain|intranet|private|home\.arpa)$/i;
export const ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443]; // the ports a page may be fetched from (the proxy enforces the same list)
const PORTS = new Set(["", ...ALLOWED_PORTS.map(String)]);

// Why this address may not be opened, or undefined. http and https only, no credentials, a named public host (no IP literal,
// local name or single-label host), a normal web port. A later DNS check (`resolvesPublic`) covers names that point inside.
export function addressProblem(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return "no address";
  if (raw.length > 2000) return "address too long";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a valid address";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `${u.protocol.replace(":", "")}: addresses are not allowed (http and https only)`;
  if (u.username || u.password) return "addresses with a login are not allowed";
  if (!PORTS.has(u.port)) return "that port is not allowed";
  const host = u.hostname.replace(/\.$/, "");
  if (host.startsWith("[") || host.includes(":")) return "IP addresses are not allowed";
  if (/^[\d.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return "IP addresses are not allowed";
  if (!host.includes(".") || LOCAL_NAME.test(host) || REBINDING_HOST.test(host)) return "local or private hosts are not allowed";
  return undefined;
}
export const hostOf = (raw: unknown): string => {
  try {
    return new URL(String(raw)).hostname;
  } catch {
    return "";
  }
};

// DNS check for navigation: a public-looking name must not resolve to a private address (a name pointing at 127.0.0.1).
// A lookup that fails is not a veto (the browser will fail the same way). A race between this check and the browser's own lookup
// remains (DNS rebinding); docs/SAFETY.md says so.
export type Resolver = (host: string) => Promise<string[]>;
export const dnsResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
export async function resolvesPublic(host: string, resolve: Resolver = dnsResolver): Promise<boolean> {
  try {
    return !(await resolve(host)).some(isPrivateAddress);
  } catch {
    return true;
  }
}

// `--blocked-origins` for the browser itself (a best-effort extra by NAME: the project says it is not a boundary and it ignores redirects; the real veto is the
// egress proxy, browseproxy.ts, which judges every connection by the address it resolves to). The private IPv4 ranges the name patterns can say, both schemes.
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const PRIVATE_V4_PREFIXES = ["10.", "192.168.", "169.254.", "127.", "0.", ...range(16, 31).map((n) => `172.${n}.`), ...range(64, 127).map((n) => `100.${n}.`)];
export const BLOCKED_ORIGINS = ["http://localhost:*", "https://localhost:*", "http://[::1]:*", "https://[::1]:*", "http://[::]:*", "http://[fc*", "http://[fd*", "http://[fe80*", "http://[::ffff:*", "https://[fc*", "https://[fd*", "https://[fe80*", "https://[::ffff:*", ...PRIVATE_V4_PREFIXES.flatMap((p) => [`http://${p}*`, `https://${p}*`]), "file://*"];

// ---- snapshots ----

export interface Node {
  ref: string;
  role: string;
  name: string;
  value?: string; // what the page shows in the field now (textbox, combobox)
  checked?: boolean;
  disabled?: boolean; // [disabled] or [readonly]: nothing can be typed into it
  inFrame?: boolean; // inside an embedded frame (an ancestor is an iframe). The ref's f-prefix says nothing about that: after a cross-site navigation the page's own fields are f1e..
  url?: string; // a link's target, from its "/url:" child line
  inForm: boolean;
  formName?: string;
}

const LINE = /^(\s*)- (?:(\/url): (.*)|([\w-]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::(?: (.*))?)?)$/;
const unquote = (s: string): string => {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
};

// The snapshot is YAML: a key with ": ", a quote or other special characters in its label is written wrapped, as
// - 'link "Zürich: Hauptbahnhof" [ref=e9]': or with double quotes. Unwrapped here so those elements (suggestion lists, dates,
// buttons with a colon in the label) are in the table too; without it their refs would be "not in the last page view".
function unwrapKey(line: string): string {
  const m = /^(\s*- )(['"])(.*)\2((?::(?: .*)?)?)$/.exec(line);
  if (!m) return line;
  let inner = m[3]!;
  if (m[2] === "'") inner = inner.replace(/''/g, "'");
  else {
    try {
      inner = JSON.parse(`"${inner}"`) as string;
    } catch {
      return line;
    }
  }
  return `${m[1]}${inner}${m[4]}`;
}

// Pure. The elements of a Playwright MCP aria snapshot ("- button "Book now" [ref=e12]"), keyed by ref. Lines that are not elements
// with a ref are skipped. `inForm`: some ancestor is a form.
export function parseSnapshot(text: string): Map<string, Node> {
  const out = new Map<string, Node>();
  const stack: { indent: number; role: string; name: string; ref?: string }[] = [];
  let last: Node | undefined;
  for (const raw of text.split("\n")) {
    const line = unwrapKey(raw);
    const m = LINE.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    if (m[2]) {
      if (last) last.url = unquote(m[3] ?? "");
      continue;
    }
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const role = m[4]!;
    const name = m[5] !== undefined ? unquote(`"${m[5]}"`) : "";
    const attrs = m[6] ?? "";
    const ref = /\[ref=([\w-]+)\]/.exec(attrs)?.[1];
    const form = [...stack].reverse().find((s) => s.role === "form") ?? (role === "form" ? { role, name } : undefined);
    const inFrame = stack.some((s) => s.role === "iframe" || s.role === "frame");
    stack.push({ indent, role, name, ref });
    if (!ref) continue;
    const value = m[7] !== undefined && m[7] !== "" ? unquote(m[7]) : undefined;
    const node: Node = { ref, role, name, inForm: !!form, ...(form?.name ? { formName: form.name } : {}), ...(value !== undefined ? { value } : {}), ...(/\[checked\]/.test(attrs) ? { checked: true } : {}), ...(/\[(disabled|readonly)\]/.test(attrs) ? { disabled: true } : {}), ...(inFrame ? { inFrame: true } : {}) };
    out.set(ref, node);
    last = node;
  }
  return out;
}

// Refs the tools accept: element references from a snapshot. (The tools also take "a unique element selector"; those are refused,
// because a selector cannot be looked up in what code read.)
export const isRef = (v: unknown): v is string => typeof v === "string" && /^(f\d+)?e\d+$/.test(v);

// ---- payment and credentials ----

const SENSITIVE_FIELD = /card\s*(number|no\b|#)|credit\s*card|debit\s*card|cc[\s-]?num|cvc|cvv|cid\b|security\s*code|expir|exp\.?\s*date|iban|bic\b|swift|account\s*(number|no\b)|routing|sort\s*code|pass(word|code|phrase)|\bpin\b|\botp\b|one[\s-]?time|2fa|two[\s-]?factor|verification\s*code|auth(entication)?\s*code|social\s*security|\bssn\b|tax\s*id|kreditkarte|kartennummer|prüfnummer|pr[üu]fziffer|passwort|kennwort|sicherheitscode|g[üu]ltig\s*bis|numéro de carte|mot de passe|contraseña|tarjeta/i;
export const sensitiveField = (name: string): boolean => SENSITIVE_FIELD.test(name);

// What KIND of value a payment or login field takes, in words for the owner's question (never the value). Undefined: not sensitive.
// `text` is what is about to be typed: a Luhn-valid number is a card number whatever the field is called.
const KINDS: [RegExp, string][] = [
  [/cvc|cvv|cid\b|security\s*code|sicherheitscode|prüfnummer|pr[üu]fziffer/i, "a card security code"],
  [/expir|exp\.?\s*date|g[üu]ltig\s*bis/i, "a card expiry date"],
  [/card\s*(number|no\b|#)|credit\s*card|debit\s*card|cc[\s-]?num|kreditkarte|kartennummer|numéro de carte|tarjeta/i, "a card number"],
  [/iban|bic\b|swift|account\s*(number|no\b)|routing|sort\s*code/i, "a bank account detail"],
  [/pass(word|code|phrase)|passwort|kennwort|mot de passe|contraseña/i, "a password"],
  [/\bpin\b/i, "a PIN"],
  [/\botp\b|one[\s-]?time|2fa|two[\s-]?factor|verification\s*code|auth(entication)?\s*code/i, "a one-time code"],
  [/social\s*security|\bssn\b|tax\s*id/i, "an identity number"],
];
export function sensitiveKind(name: string, text = ""): string | undefined {
  for (const [re, label] of KINDS) if (re.test(name)) return label;
  if (SENSITIVE_FIELD.test(name)) return "a payment or login detail";
  return looksLikeCardNumber(text) ? "a card number" : undefined;
}

// A number that passes the Luhn check (card numbers), 13 to 19 digits, possibly in groups of spaces or dashes.
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}
export function looksLikeCardNumber(text: string): boolean {
  for (const run of text.match(/\d(?:[\s-]?\d){12,18}/g) ?? []) if (luhnValid(run.replace(/\D/g, ""))) return true;
  return false;
}

// ---- the total on a page ----

export const CURRENCY = "(?:CHF|EUR|USD|GBP|SEK|NOK|DKK|PLN|CZK|Fr\\.|SFr\\.?|€|\\$|£)";
export const AMOUNT_NUM = "\\d{1,3}(?:[’'.,\\s]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
export const MONEY = new RegExp(`${CURRENCY}\\s?(?:${AMOUNT_NUM})(?![\\d])|(?<![\\d.,])(?:${AMOUNT_NUM})\\s?${CURRENCY}`, "i");
const TOTAL_WORD = /total|gesamt|summe|zu zahlen|to pay|amount due|grand|betrag|montant|à payer|a payer|importe/i;
const PRICE_WORD = /price|preis|prix|cost|fare|tarif|precio/i;

// Pure. The amount a page shows as its total ("Total CHF 45.00", "Zu zahlen: 45,00 €"), as it is written, or undefined when no line of the
// page view has a total word and an amount. A line with a price word is the second choice. This is only what the page SAYS; the shop's cart is not read.
export function findTotal(view: string): string | undefined {
  let strong: string | undefined;
  let weak: string | undefined;
  for (const line of view.split("\n")) {
    if (line.length > 300) continue;
    const m = MONEY.exec(line.replace(/\s+/g, " "));
    if (!m) continue;
    if (TOTAL_WORD.test(line)) strong = m[0].trim();
    else if (PRICE_WORD.test(line)) weak = m[0].trim();
  }
  return strong ?? weak;
}

// ---- commit steps ----

const NOT_A_BUTTON = new Set(["textbox", "searchbox", "checkbox", "radio", "combobox", "slider", "spinbutton", "switch", "option", "listbox", "tab", "heading", "paragraph", "text"]);
// Names of controls that make something happen for real: book, buy, pay, confirm, send, order, reserve, register, subscribe...
const COMMIT_NAME = /submit|\bbook(ing)?\b|\bbuy\b|purchase|\bpay(ment|\b)|\bconfirm|place\s+(the\s+)?order|\border\b|\bsend\b|reserve|reservation|register|sign\s*up|subscribe|check\s*out|checkout|\bcomplete\b|donate|\bapply\b(?!\s+filter)|finali[sz]e|\bpurchase|\bagree\b|\baccept\s+(and|&)|authori[sz]e|\bdelete\b|\bremove\b|cancel\s+(my\s+)?(booking|order|reservation|subscription)|buchen|kaufen|bezahlen|bestellen|bestätigen|senden|absenden|reservieren|anmelden|abonnieren|jetzt\s+buchen|zahlungspflichtig|kostenpflichtig|abschlie(ß|ss)en|r[ée]server|acheter|payer|commander|confirmer|envoyer|reservar|comprar|pagar|confirmar|enviar/i;
// Buttons inside a form that are routine navigation of the form, not its submission.
const ROUTINE_BUTTON = /^(search|find|filter|sort|show|hide|more|next|previous|prev|back|close|cancel|clear|reset|continue|weiter|zurück|suche|suchen|finden|schlie(ß|ss)en|mehr|zeige|anzeigen|check availability|view|select|choose|open|expand|collapse|toggle|add guest|plus|minus|\+|-|increase|decrease)\b/i;

export interface ClickClass {
  commit: boolean;
  why: string; // for the audit and for the approval
  node?: Node;
}

// Pure. Is this click a commit step? Decided from the element as the page's snapshot shows it. An element that is not in the last
// snapshot (a stale or invented ref) fails closed: it counts as a commit.
export function classifyClick(node: Node | undefined): ClickClass {
  if (!node) return { commit: true, why: "the element is not in the last page view" };
  if (NOT_A_BUTTON.has(node.role)) return { commit: false, why: "a field, not a button", node };
  const name = node.name.trim();
  if (COMMIT_NAME.test(name)) return { commit: true, why: `the label "${name}" looks like a commit`, node };
  // An unlabeled button outside a form (carousel arrow, icon button, menu) has no submit semantics: not a commit. Inside a form it stays one.
  if (node.role === "button" && !name) return node.inForm ? { commit: true, why: "a button with no label inside a form", node } : { commit: false, why: "an unlabeled button outside any form", node };
  if (node.role === "button" && node.inForm && !ROUTINE_BUTTON.test(name)) return { commit: true, why: "a button inside a form", node };
  if (node.role === "link" && node.url && /^(javascript|data|blob|mailto|tel):/i.test(node.url.trim())) return { commit: true, why: `a ${node.url.split(":")[0]}: link`, node };
  return { commit: false, why: "ordinary click", node };
}

// ---- the tools of the browser server ----

export const BROWSER_PREFIX = "mcp__browser__browser_";
// Everything else the server offers (evaluate, run_code_unsafe, file_upload, network_*, drop, drag, emulate, resize, close, screenshots,
// pdf, devtools...) is denied outright and hidden from the model.
export const ALLOWED_BROWSER_TOOLS = ["snapshot", "find", "navigate", "navigate_back", "click", "type", "fill_form", "select_option", "press_key", "hover", "handle_dialog", "wait_for", "tabs"] as const;
export const HIDDEN_BROWSER_TOOLS = ["close", "resize", "console_messages", "emulate_media", "evaluate", "file_upload", "drop", "network_requests", "network_request", "run_code_unsafe", "take_screenshot", "drag", "install", "pdf_save", "start_tracing", "stop_tracing"].map((n) => BROWSER_PREFIX + n);
// The vision experiment (browsevision.ts, BROWSE_VISION): off is today's behaviour. read adds the screenshot (the model sees it; clicks stay
// by ref). click adds clicking at a point, hovering at a point and the wheel; press-and-hold, release and drag stay hidden and denied.
export type VisionMode = "off" | "read" | "click";
export const VISION_TOOLS: Record<VisionMode, readonly string[]> = { off: [], read: ["take_screenshot"], click: ["take_screenshot", "mouse_click_xy", "mouse_move_xy", "mouse_wheel"] };
export const isAllowedBrowserTool = (tool: string, vision: VisionMode = "off"): boolean => {
  const n = tool.slice(BROWSER_PREFIX.length);
  return tool.startsWith(BROWSER_PREFIX) && ((ALLOWED_BROWSER_TOOLS as readonly string[]).includes(n) || VISION_TOOLS[vision].includes(n));
};
export const hiddenBrowserTools = (vision: VisionMode = "off"): string[] =>
  vision === "off" ? HIDDEN_BROWSER_TOOLS : [...HIDDEN_BROWSER_TOOLS.filter((t) => !VISION_TOOLS[vision].includes(t.slice(BROWSER_PREFIX.length))), ...(vision === "click" ? ["mouse_down", "mouse_up", "mouse_drag_xy"].map((n) => BROWSER_PREFIX + n) : [])];
