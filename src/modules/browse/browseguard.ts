import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { addressProblem, BROWSER_PREFIX, classifyClick, dnsResolver, findTotal, hostOf, isAllowedBrowserTool, isRef, parseSnapshot, resolvesPublic, sensitiveKind, type Node, type Resolver } from "./browserules.ts";
import { hostMatches, registeredDomain } from "../../core/domains.ts";
import { fieldFitsKey, isSensitive, maskValue, type Profile } from "./profile.ts";
import { APPROVAL_MINUTES, payDetails, PayRun, secretVariants } from "./browsecard.ts";
import type { FrameProbe, Probe } from "./browsecdp.ts";
import { expiryText, type CardAccess, type CardInfo } from "./card.ts";
import { capProblem } from "./payments.ts";
import { approvalId, CARD_PLACEHOLDER, cartHash, cartLines, expirySplit, findPayableTotal, formatMoney, frameVerdict, HAS_CARD_PLACEHOLDER, isPsp, kindOfFieldName, parseMoney, paymentOutcome, PSP_HOSTS, riskyBoxes, sameMoney, WORDS, type FieldKind, type Money } from "./paymentrules.ts";
import { dayIn } from "../../core/timezone.ts";
import { clickProblem, MAX_POINT_CLICKS, MAX_SHOTS, nodeOfPoint, screenshotInput, validPoint } from "./browsevision.ts";
import { emit } from "../../core/events.ts";
import { OWNER_KEY } from "../../core/ownerkey.ts";
import { isPlainWebAddress } from "../../policy/webaddress.ts";
import type { CarriedApproval } from "../../approvals/autojudge.ts";
import { clip, cleanText, LIMITS } from "../../core/sanitize.ts";
import { isJpeg, MAX_PICTURE_BYTES } from "../send/shots.ts";
import { settings } from "../../core/settings.ts";

// The guard of a browse run: it decides every call the browsing model makes (browserules.ts has the pure rules). One per run.

export type BrowseMode = "owner" | "group";

// ---- the guard: one per browse run ----

export interface Decision {
  kind: "deny" | "allow" | "ask" | "defer"; // defer: the manifest and the approval judge decide (policy.ts, permissions.ts)
  reason?: string; // deny: what the model is told
  description?: string; // ask, and what the judge reads: built by code from the real element
  once?: boolean; // an approved call is not repeated (a commit)
  judge?: boolean; // ask: the approval judge decides whether the owner is asked (every commit step); anything but its "auto" asks the owner
  redacted?: Record<string, unknown>; // ask: the call as the owner's question and the audit may see it (typed secrets cut to a length)
  facts?: Record<string, unknown>; // ask: host, role and name of the element, added to the judge's audit row
  input?: Record<string, unknown>; // the call as it must run, when code narrowed it (a screenshot: jpeg, viewport only)
  payment?: boolean; // ask: a card payment, approved only by the owner's typed yes (permissions.ts, approvals.ts)
  carried?: CarriedApproval; // ask + judge: the plan the owner approved earlier in this run, when the rules below allow offering it (see offer)
  approved?: (question: string) => void; // ask: the owner approved this question (as shown to them): kept for the later steps of this run
  allowed?: (by: "judge" | "owner") => void; // defer: this very call was let through by the judge's auto or the owner's yes (a navigate: the site is accepted for this run)
  skipped?: { reason: string; host: string }; // allow: the judge was skipped on purpose (permissions.ts records judge-skipped)
  resolve?: () => Promise<Record<string, unknown> | string>; // the call as it must run, built after it is allowed (a card typed by code); a string: refused with that reason
}

export interface GuardOptions {
  mode: BrowseMode;
  task: string;
  outDir: string;
  maxCommits?: number;
  resolver?: Resolver;
  probe?: Probe; // click mode: what is under a point of the page, looked up by code (browsecdp.ts)
  cdpPort?: number; // click mode: the browser's debugging port on loopback (browseserver.ts starts the browser with it)
  proxyPort?: number; // the run's egress proxy on loopback (browseproxy.ts): the browser is started with it (browseserver.ts); the guard only carries the number
  shotsDir?: string; // where each screenshot is kept as a small jpeg, for the chat to pass on (shots.ts)
  profile?: Profile; // the owner's saved details (profile.ts): the owner's chat run only, a group's guard ignores it
  card?: CardAccess; // the owner's payment card (card.ts): the owner's chat run only, a group's guard ignores it
  frames?: FrameProbe; // the browser's own list of the page's frames (browsecdp.ts); without it a card is never typed into a frame
  tenant?: boolean; // the run is a tenant's: its audit rows carry no words (the sites she visits, the controls she meets, her task), only how big (audit.ts wordless)
}

// A saved detail typed by code: the model names a key, never sees the value.
const WHOLE_PLACEHOLDER = /^\{\{profile:([a-z][a-z0-9._-]*)\}\}$/i;
const HAS_PLACEHOLDER = /\{\{\s*profile:/i;
const FIELD_ROLES = /^(textbox|searchbox|combobox|spinbutton)$/;
interface FillIntent { ref: string; label: string; key: string; shown: string; sensitive: boolean }
export interface FilledField { host: string; label: string; key: string; shown: string; sensitive: boolean }
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const bare = (u: string) => u.split("#")[0]!;
const HAND = " Stop with status needs_owner and give handoffUrl.";
const SNAPSHOT_CAP = LIMITS.pageView; // bigger page views are cut with a visible marker
const MAX_DENIED = 6;
const AUTOFILL_SENSITIVE = /\b(cc-[a-z-]+|current-password|new-password|one-time-code)\b/i; // autocomplete tokens of card and login fields
const nolabel = (s: string) => s.replace(/\s*:\s*$/, ""); // "Customer name:" as the page labels it
const HIDDEN = "(hidden: payment or login detail)";
// An approved plan carries forward to later steps of the same run for this long, on the same site only, never to a payment.
export const CARRY_MS = 10 * 60_000;
// How many navigates of one run may skip the judge for a site it was already cleared for; the rest are judged.
export const FAST_NAVIGATIONS = 30;
const PAYISH = /\b(pay(ment|ing)?|buy|purchase|check\s*out|checkout|place\s+(the\s+)?order|donate|kaufen|bezahlen|zahlungspflichtig|kostenpflichtig|acheter|payer|comprar|pagar)\b/i;
const short = (tool: string) => tool.slice(BROWSER_PREFIX.length);

export class BrowseGuard {
  readonly mode: BrowseMode;
  private readonly tenant: boolean;
  readonly task: string;
  readonly outDir: string;
  nodes = new Map<string, Node>(); // the elements of the last page view
  typed = new Map<string, { label: string; value: string }>(); // what was typed since the page last changed
  url = "";
  commits = 0;
  denied = 0;
  steps = 0;
  private readonly maxCommits: number;
  private readonly resolver: Resolver;
  readonly cdpPort?: number;
  readonly proxyPort?: number;
  private readonly probe?: Probe;
  private shots = 0;
  readonly shotsDir?: string;
  kept: { id: string; file: string; size: number }[] = []; // the screenshots kept for the chat, in order
  private pointClicks = 0;
  private approvedPlan?: CarriedApproval; // the owner's last approved browser question of this run (memory only; cleared when the site changes or the run ends)
  private approvedCount = 0;
  private readonly accepted = new Set<string>(); // the sites (host names) this run was cleared for: a navigate to one was judged auto, or the owner said yes to it
  private readonly autoCalls = new Set<string>(); // the navigates the judge already passed in this run, exactly (no second judge call for the same call)
  private fastPath = 0; // navigates that skipped the judge so far
  private readonly runId = Math.random().toString(36).slice(2, 8);
  private pending?: string; // the commit call that was asked about: counted when that very call succeeds
  private readonly profile?: Profile;
  private readonly secrets = new Set<string>(); // values typed from the profile: cut from everything the model reads, for the rest of the run
  private readonly fillRefs = new Set<string>(); // the refs they went into: the page view shows the value on those lines
  private readonly intents = new Map<string, FillIntent>(); // decided to fill, not yet confirmed done
  private justFilled = new Set<string>();
  filled: FilledField[] = []; // what was typed from the profile in this run (labels, keys, masked values), for the final approval
  private viewUrl = ""; // the address of the page view the refs come from
  private view = ""; // the last full page view, as the model reads it (for the total)
  // A card payment (browsecard.ts, paymentrules.ts): the owner's card, only in the owner's chat run, only ever typed by code after a typed yes.
  private readonly card?: CardAccess;
  private readonly frames?: FrameProbe;
  readonly pay = new PayRun();
  private chain: { domain: string; by: "navigate" | "follow" }[] = []; // the sites the run has been on, in order; how each was entered
  private navNext = false; // the next page change is the worker opening an address
  private fullView = ""; // the last browser_snapshot (a whole page view, never a part): what a payment is read from
  private fullUrl = "";
  private fullSeq = 0;
  private readonly cardIntents = new Map<string, FieldKind>(); // decided to type, not yet confirmed done
  private payNote?: string; // the result of the payment for the owner, once the run is over ("" none)
  private readonly pageChecks = new Map<string, { done?: boolean; wait: Promise<void> }>(); // host of a page that loaded -> does its name resolve to public addresses (checked after the load, in the background; the next call awaits it only if it is still out)
  private cardCvc?: string; // kept (not in `secrets`: three digits cut everywhere would wreck a page) to cut it where a page puts it in an address
  private readonly cardSecrets = new Set<string>(); // the card's forms a page may echo: cut from the worker's final answer too

  constructor(o: GuardOptions) {
    this.mode = o.mode;
    this.tenant = !!o.tenant;
    this.task = o.task;
    this.outDir = o.outDir;
    this.maxCommits = o.maxCommits ?? settings.browseMaxCommits;
    this.resolver = o.resolver ?? dnsResolver;
    this.probe = o.probe;
    this.cdpPort = o.cdpPort;
    this.proxyPort = o.proxyPort;
    this.shotsDir = o.shotsDir;
    this.profile = o.mode === "owner" ? o.profile : undefined;
    this.card = o.mode === "owner" ? o.card : undefined;
    this.frames = o.frames;
  }

  // What the judge and the owner read for typing saved details: label, key and site, never the value.
  private fillDescription(list: FillIntent[]): string {
    return `⌨️ Browser: type saved details from the owner's profile (the value is typed by code and not shown)\nSite: ${clip(hostOf(this.url), 100)}\n${list.map((i) => `• “${clip(i.label, 80)}” ← ${i.key}`).join("\n")}`;
  }

  // The saved keys (never values) the worker may name, for its prompt.
  profileKeys(): { key: string; kind: string }[] {
    return Object.entries(this.profile?.entries ?? {}).map(([key, e]) => ({ key, kind: e.kind })).sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  // Why the saved detail `text` ("{{profile:KEY}}") may not go into this field, or the value and what to remember about it. Everything here is code.
  private fillFrom(n: Node, text: string): { value: string; intent: FillIntent } | string {
    const m = WHOLE_PLACEHOLDER.exec(text.trim());
    if (!m) return "A saved detail is typed as the whole text, exactly {{profile:KEY}}, nothing around it.";
    if (!this.profile) return "No saved details are available in this run. Use only what the task gives you, or stop with status needs_owner.";
    const key = m[1]!.toLowerCase();
    const e = this.profile.entries[key];
    if (!e) return `There is no saved detail called ${clip(key, 40)}. The keys are: ${this.profileKeys().map((k) => k.key).join(", ")}.`;
    if (n.inFrame) return "That field is inside an embedded frame whose content and origin cannot be checked, so a saved detail is not typed there. Stop with status needs_owner and give handoffUrl.";
    let u: URL;
    try {
      u = new URL(this.url);
    } catch {
      return "No page is open. Navigate first.";
    }
    if (u.protocol !== "https:") return "Saved details are only typed on https pages.";
    if (!this.viewUrl || this.viewUrl !== this.url) return "The page changed since the last page view. Take a fresh browser_snapshot and use a ref from it.";
    if (!FIELD_ROLES.test(n.role)) return `${n.ref} is a ${n.role}, not a text field.`;
    if (sensitiveKind(n.name)) return "That is a payment or login field: saved details are never typed there. Stop with status needs_owner and give handoffUrl.";
    if (!fieldFitsKey(n.name, key, e)) return `The field “${clip(n.name || n.ref, 60)}” does not look like the place for ${key}.`;
    if (e.domains.length) {
      if (!hostMatches(u.hostname, e.domains)) return `${key} is not allowed on ${clip(u.hostname, 60)}.`;
    } else if (isSensitive(e)) return `${key} is a sensitive detail and the owner has not named a site for it yet, so it is not typed anywhere.`;
    this.secrets.add(e.value);
    return { value: e.value, intent: { ref: n.ref, label: n.name || n.ref, key, shown: maskValue(e.value, isSensitive(e)), sensitive: isSensitive(e) } };
  }

  // Saved details were typed by this call: remembered for the final approval.
  private doneFills(name: string, input: Record<string, unknown>): FillIntent[] {
    const refs = name === "type" ? [String(input.target)] : name === "fill_form" && Array.isArray(input.fields) ? (input.fields as Record<string, unknown>[]).map((f) => String(f.target)) : [];
    const done: FillIntent[] = [];
    for (const r of refs) {
      const it = this.intents.get(r);
      if (!it) continue;
      this.intents.delete(r);
      done.push(it);
      this.fillRefs.add(r);
      this.justFilled.add(r);
      this.typed.set(r, { label: it.label, value: it.shown });
      const host = hostOf(this.url);
      if (!this.filled.some((f) => f.host === host && f.key === it.key && f.label === it.label)) this.filled.push({ host, label: it.label, key: it.key, shown: it.shown, sensitive: it.sensitive });
    }
    return done;
  }

  // The model never reads a saved value: it is cut from every result (the echo of the typed code, the field in a later page view, a summary on the page).
  private redact(text: string): string {
    if (!this.secrets.size) return text;
    let out = text;
    for (const ref of this.fillRefs) out = out.replace(new RegExp(`(\\[ref=${escapeRe(ref)}\\](?: \\[[^\\]]*\\])*):[ \\t].*$`, "gm"), "$1: [filled]");
    // The security code, where a (bad) form put it in the address: a query value that is exactly the code.
    if (this.cardCvc) out = out.replace(new RegExp(`([?&][^=&\\s"']+=)${escapeRe(this.cardCvc)}(?![\\p{L}\\p{N}])`, "gu"), "$1[filled]");
    for (const v of [...this.secrets].sort((a, b) => b.length - a.length)) {
      if (v.length < 3) continue;
      for (const variant of new Set([v, JSON.stringify(v).slice(1, -1), v.replace(/'/g, "\\'"), v.replace(/\s+/g, " ")])) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(variant)}(?![\\p{L}\\p{N}])`, "gu"), "[filled]");
    }
    return out;
  }

  // The names of the buttons, links and fields of the last page view (cheap context for the judge when a point could not be resolved).
  private controlsSeen(): string {
    const names = [...this.nodes.values()].filter((n) => n.name && /^(button|link|textbox|searchbox|combobox|checkbox|radio|menuitem|tab|switch)$/.test(n.role)).slice(0, 15).map((n) => `${n.role} “${clip(n.name, 40)}”`);
    return names.length ? `Controls on the page: ${names.join(", ")}` : "Controls on the page: none listed";
  }

  // After a screenshot call succeeded: keeps its picture as a jpeg file (only real jpeg bytes, a size limit, a name code chooses) and returns its id.
  keepShot(response: unknown): string | undefined {
    if (!this.shotsDir) return undefined;
    const bytes = imageBytes(response);
    if (!bytes || bytes.length > MAX_PICTURE_BYTES || !isJpeg(bytes)) return undefined;
    const id = `shot${this.kept.length + 1}`;
    const file = join(this.shotsDir, `${id}.jpg`);
    try {
      writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    } catch {
      return undefined;
    }
    this.kept.push({ id, file, size: bytes.length });
    return id;
  }

  // Every audit row of the guard goes through here: a tenant's carry no words (the audit log is the admin's).
  private record(tool: string, decision: string, source: "browse", meta?: Record<string, unknown>): void {
    emit({ type: "tool", tool, decision, source, friend: !!this.tenant, meta });
  }
  // A card payment changed status: the journal line of money moving, in the owner's log (only the owner's own chat ever pays: approvals.ts typed yes). The ledger is the record of the payment itself.
  private paid(status: string, a: NonNullable<PayRun["approval"]>): void {
    emit({ type: "payment", status, conv: OWNER_KEY, source: "browse", text: `${formatMoney(a.money)} at ${a.merchant} (card ••••${a.last4})` });
  }
  private log(tool: string, verdict: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    // Typed values are logged as a length, never as text.
    const lens = typeof input.text === "string" ? { textLength: input.text.length } : Array.isArray(input.fields) ? { fieldLengths: (input.fields as { value?: unknown }[]).map((f) => String(f?.value ?? "").length) } : {};
    this.record("browse_step", verdict, "browse", { mode: this.mode, tool: short(tool), host: hostOf(typeof input.url === "string" ? input.url : this.url), ...lens, ...extra });
  }
  private deny(tool: string, input: Record<string, unknown>, reason: string, extra: Record<string, unknown> = {}): Decision {
    this.denied++;
    this.log(tool, "deny", input, { reason: reason.slice(0, LIMITS.reason), ...extra });
    return { kind: "deny", reason };
  }
  private refNode(ref: unknown): Node | string {
    if (!isRef(ref)) return "Use an element ref from a page view (like e12), not a selector or a description.";
    return this.nodes.get(ref) ?? `${String(ref)} is not in the last page view. Take a fresh browser_snapshot and use a ref from it.`;
  }

  // The page address without query or fragment (a query can be long and carry data; the host and path say where the owner is).
  private where(): string {
    try {
      const u = new URL(this.url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return "(unknown)";
    }
  }

  // What the owner and the judge read before a commit step: the page, the real control, and what has been entered, all from code.
  // A payment or login value that is on the page or was typed is never repeated here.
  private commitText(control: string, why: string, extraValues: [string, string][] = [], form?: string): string {
    const rows = new Map<string, string>();
    for (const n of this.nodes.values()) if ((n.value || n.checked) && n.role !== "link") rows.set(n.ref, `${nolabel(n.name) || n.role}: ${n.value && sensitiveKind(n.name, n.value) ? HIDDEN : (n.value ?? (n.checked ? "ticked" : ""))}`);
    for (const [ref, t] of this.typed) rows.set(ref, `${nolabel(t.label) || ref}: ${t.value}`);
    for (const [label, value] of extraValues) rows.set(`x${label}`, `${nolabel(label)}: ${value}`);
    const values = [...rows.values()].slice(0, 30).map((r) => `• ${clip(r, LIMITS.gist)}`);
    const here = hostOf(this.url);
    // Saved details typed in this run: field label, the key it came from, and the value (masked to its last 4 characters for a sensitive key).
    const profile = this.filled.length
      ? [
          "Profile fields filled in this run (typed by code; the assistant never saw the values):",
          ...this.filled.slice(-12).map((f) => `• ${clip(nolabel(f.label) || "(no label)", 60)} ← ${f.key}: ${f.shown}${f.host !== here ? ` (on ${f.host})` : ""}`),
          this.totalLine(),
        ]
      : [];
    return [
      "🛒 Browser: confirm this step",
      `Site: ${clip(here || "(unknown)", 100)}`,
      `Address: ${clip(this.where(), 300)}`,
      control,
      ...(form ? [`Form: ${clip(form, 100)}`] : []),
      `Why you are asked: ${why}`,
      values.length ? `Entered so far:\n${values.join("\n")}` : "Entered so far: nothing visible",
      ...profile,
      `Task: ${clip(this.task, 300)}`,
      "Approve only if this is exactly what you want done.",
    ].join("\n");
  }

  // The total as code reads it from the last page view, or says there is none. The shop's own figure: nothing here checks it.
  private totalLine(): string {
    const t = findTotal(this.view);
    return t ? `Total (read from the page by code, not checked by the shop): ${t}` : "Total: none found on the page";
  }

  // Every step the classifier takes for a commit goes to the approval judge with this text; the judge (or, failing that, the owner) decides.
  // `judge` false: the owner is asked directly. After saved details were typed in this run the owner is ALWAYS asked, whatever the judge would say.
  private commit(tool: string, input: Record<string, unknown>, node: Node | undefined, why: string, control: string, extraValues: [string, string][] = [], judge = true): Decision {
    if (this.commits >= this.maxCommits) return this.deny(tool, input, `This run already took its ${this.maxCommits} confirmed step(s). Stop and report what is left for the owner.`, { commit: true, cap: true });
    if (this.filled.length) (judge = false), (why = `${why}; details from your saved profile were typed in this run, so you always confirm`);
    this.log(tool, judge ? "judge" : "ask-owner", input, { commit: true, why, role: node?.role, name: node?.name?.slice(0, LIMITS.control), ...(this.filled.length ? { profileKeys: this.filled.map((f) => f.key) } : {}) });
    this.pending = tool + JSON.stringify(input);
    const host = hostOf(this.url);
    const label = node?.name?.slice(0, LIMITS.control) ?? control.slice(0, LIMITS.control);
    return {
      kind: "ask", description: this.commitText(control, why, extraValues, node?.formName), once: true, judge,
      facts: { host, role: node?.role, name: node?.name?.slice(0, LIMITS.control), step: short(tool) },
      ...(judge ? { carried: this.offer(label) } : {}),
      approved: (question) => void (this.approvedPlan = { id: `${this.runId}-${++this.approvedCount}`, at: Date.now(), host, step: short(tool), label, question }),
    };
  }

  // Whether the plan the owner approved earlier may be shown to the judge for this step: code decides, the judge only reads it. The same
  // run (this guard) and conversation (its approver), the same site, not expired, and never anything that could be a payment: a card in
  // progress, a pay-like control, or a page that states a total or price. Anything else is judged as before.
  private offer(label: string, now = Date.now()): CarriedApproval | undefined {
    const a = this.approvedPlan;
    if (!a || !a.host || now - a.at >= CARRY_MS || a.host !== hostOf(this.url)) return undefined;
    if (this.pay.active || this.pay.approval || PAYISH.test(label) || findTotal(this.view)) return undefined;
    return a;
  }

  // The end of the run: an approval carried in memory goes with it.
  endRun() {
    this.approvedPlan = undefined;
  }

  // Payment and login fields: the owner is ALWAYS asked (no judge, no cap, no skipping). The question names the page, the field and the kind of
  // value, never the value; the typed text goes only to the browser. `redacted` is the call as the question and the audit see it.
  private sensitive(tool: string, input: Record<string, unknown>, fields: { name: string; kind: string }[]): Decision {
    this.log(tool, "ask-sensitive", input, { sensitive: true, kinds: fields.map((f) => f.kind) });
    const redacted: Record<string, unknown> = { ...input };
    if (typeof input.text === "string") redacted.text = `[${input.text.length} characters, not shown]`;
    if (Array.isArray(input.fields)) redacted.fields = (input.fields as Record<string, unknown>[]).map((f) => ({ ...f, value: `[${String(f?.value ?? "").length} characters, not shown]` }));
    const list = fields.map((f) => `• ${clip(nolabel(f.name) || "(no label)", 80)}: ${f.kind}`);
    return {
      kind: "ask",
      once: true,
      redacted,
      description: ["🔐 Browser: a payment or login detail", `Site: ${clip(hostOf(this.url) || "(unknown)", 100)}`, `Address: ${clip(this.where(), 300)}`, `Field${fields.length > 1 ? "s" : ""}:\n${list.join("\n")}`, "The value is typed into the page by the browser and is not shown here or logged.", `Task: ${clip(this.task, 300)}`, "Approve only if you want this entered."].join("\n"),
    };
  }

  // ---- paying with the owner's card ----

  // What the worker's prompt may say of the card: its label, last four and currency. Undefined: no card in this run (a group, a wake-up, none
  // saved, switched off).
  cardInfo(): CardInfo | undefined {
    return this.card && !this.card.off() ? this.card.info : undefined;
  }

  private payDeny(tool: string, input: Record<string, unknown>, reason: string, extra: Record<string, unknown> = {}): Decision {
    this.record("card_blocked", "deny", "browse", { reason: reason.slice(0, LIMITS.reason), host: hostOf(this.url), ...extra });
    return this.deny(tool, input, reason, { card: true, ...extra });
  }

  // A payment is in progress: approved by the owner and not yet clicked. From the approval to the pay click (or the end of the run), the ONLY click that may happen
  // is the pay button, checked by payClick; everything else that can press, accept or choose is refused (a click, a dialog, a choice, the keyboard).
  private get payOpen(): boolean {
    return !!this.pay.approval && !this.pay.attempted;
  }

  // A payment whose card details were typed is dropped (the page, the shop or the approval changed): the typed digits are on a page that may still submit, so the
  // ledger row becomes `unconfirmed` (it counts against the caps and the duplicate check) and the owner is told in the run's result, like any unconfirmed payment.
  private voidPay(why: string): void {
    const a = this.pay.approval;
    if (a && !this.pay.attempted && this.pay.typed.size > 0 && this.payNote === undefined) {
      this.card?.ledger.setStatus(a.id, "unconfirmed");
      this.record("card_pay", "unconfirmed", "browse", { id: a.id, merchant: a.merchant, last4: a.last4, reason: why.slice(0, LIMITS.reason) });
      this.payNote = `Card payment of ${formatMoney(a.money)} at ${a.merchant} (card ••••${a.last4}): card details were typed, then the payment was dropped before the pay click (${why}). Check the card app and your e-mail before doing anything; it will not be paid again until you clear it (npm run card -- clear ${a.id}).`;
    }
    this.pay.invalidate();
  }

  // After the pay click nothing is typed or clicked again; while a payment is open, nothing around it can press or submit it.
  private payLock(tool: string, input: Record<string, unknown>, name: string): Decision | undefined {
    if (this.pay.attempted && /^(type|fill_form|select_option|press_key|handle_dialog|click|mouse_click_xy)$/.test(name)) return this.payDeny(tool, input, "A payment was already attempted in this run. Do not type or click again: read the page (browser_snapshot, browser_wait_for) and report exactly what it says.", { locked: true });
    if (this.payOpen && name === "press_key" && /^(Enter|NumpadEnter|Space| )$/.test(String(input.key ?? ""))) return this.payDeny(tool, input, "A card is typed: use the page's pay button, not the keyboard.");
    if (this.payOpen && name === "mouse_click_xy") return this.payDeny(tool, input, "A card is typed: click the pay button by its ref, not at a point.");
    if (this.payOpen && name === "type" && input.submit === true) return this.payDeny(tool, { target: input.target }, "A card is typed: do not submit with Enter, use the page's pay button.");
    if (this.payOpen && name === "select_option") return this.payDeny(tool, input, "A payment is in progress: choose nothing now. Click the page's pay button, or stop.");
    if (this.payOpen && name === "handle_dialog" && input.accept === true) return this.payDeny(tool, input, "A payment is in progress: do not accept a dialog. Click the page's pay button, or stop.");
    return undefined;
  }

  // The shop and the payment hosts for a card typed on this page, or why not. The shop is the site the run came to; a payment provider's own
  // page counts only when the run got there by following the shop's page, not by opening its address. A card is typed into an embedded frame
  // only when the browser's own frame list shows nothing but the shop, known payment providers and blank frames.
  private async payTarget(frame: boolean): Promise<{ merchant: string; psp: string[] } | string> {
    const top = registeredDomain(hostOf(this.url));
    let merchant = top;
    let psp = [top];
    if (isPsp(top)) {
      const shop = [...this.chain].reverse().find((c) => !PSP_HOSTS.has(c.domain));
      if (!shop) return "This payment page was not reached from a shop in this run.";
      if (this.chain[this.chain.length - 1]?.by === "navigate") return "This payment page was opened by its address, not reached from the shop's own checkout.";
      merchant = shop.domain;
    }
    if (frame) {
      if (!this.frames) return "The frames of this page cannot be listed in this run, so a card is not typed into one.";
      const fr = await this.frames(this.url);
      if (typeof fr === "string") return `The frames of this page cannot be checked (${fr}), so a card is not typed into one.`;
      const v = frameVerdict(fr, this.url, merchant);
      if (typeof v === "string") return `A card is not typed into an embedded frame here: ${v}.`;
      psp = v.psp;
    }
    return { merchant, psp };
  }

  // A card detail: the worker names a placeholder ({{card:number}}, {{card:expiry}}, {{card:cvc}}) and never sees a digit. The number is the
  // first and asks the owner (a typed YES); the rest follow without a new question, bound to that approval.
  private async cardField(tool: string, n: Node, text: string, input: Record<string, unknown>): Promise<Decision> {
    const logged = { target: input.target };
    const stop = (reason: string, extra?: Record<string, unknown>) => this.payDeny(tool, logged, `${reason}${HAND}`, extra);
    const fix = (reason: string, extra?: Record<string, unknown>) => this.payDeny(tool, logged, reason, extra);
    const m = CARD_PLACEHOLDER.exec(text.trim());
    if (!m) return fix("A card detail is typed as the whole text, exactly {{card:number}}, {{card:expiry}} or {{card:cvc}}, nothing around it.");
    const kind = m[1]!.toLowerCase() as FieldKind;
    if (input.submit === true) return fix("Do not submit while typing a card detail. Type it, then use the page's pay button.");
    const card = this.card;
    if (!card) return stop("No card is available in this run.");
    const off = card.off();
    if (off) return stop(`Card payments are ${off}.`);
    let u: URL;
    try {
      u = new URL(this.url);
    } catch {
      return fix("No page is open. Navigate first.");
    }
    if (u.protocol !== "https:") return stop("A card is only typed on https pages.");
    if (!this.viewUrl || this.viewUrl !== this.url) return fix("The page changed since the last page view. Take a fresh browser_snapshot and use a ref from it.");
    if (!FIELD_ROLES.test(n.role)) return fix(`${n.ref} is a ${n.role}, not a text field.`);
    if (n.disabled) return fix(`${n.ref} cannot be typed into (disabled or read-only).`);
    if (n.value) return fix("That field is not empty. A card detail is typed only into an empty field.");
    if (kindOfFieldName(n.name) !== kind) return fix(`The field “${clip(n.name || n.ref, LIMITS.control)}” is not the ${WORDS[kind]} field.`);
    if (kind === "expiry" && expirySplit(n.name)) return stop("The expiry date is asked in separate month and year fields, which are not supported.");
    if (this.pay.typed.has(kind)) return fix(`The ${WORDS[kind]} is already typed.`);
    if (kind !== "number" && !this.pay.approval) return fix("Type the card number first: that asks the owner to approve the payment.");
    if (kind === "cvc" && !this.pay.typed.has("expiry")) return fix("Type the expiry date before the security code.");
    const frame = !!n.inFrame; // by the page's structure: the ref prefix is not a sign of it (after a cross-site navigation the page's own fields are f1e..)
    const target = await this.payTarget(frame);
    if (typeof target === "string") return stop(target);
    const a = this.pay.approval;
    if (!a) return this.payAsk(tool, n, input, target, frame, stop, fix);
    // later details of an approved payment: nothing may have changed since the yes
    const gone = (why: string) => (this.voidPay(why), stop(`${why} Nothing more is typed; a new approval would be needed.`, { changed: true }));
    if (Date.now() > a.expiresAt) return gone("The payment approval ran out (it lasts ten minutes).");
    if (bare(this.url) !== a.url) return gone("The page address changed since the owner approved.");
    if (target.merchant !== a.merchant || target.psp.some((h) => !a.psp.includes(h))) return gone("The shop or the payment provider changed since the owner approved.");
    this.log(tool, "fill-card", logged, { role: n.role, name: n.name.slice(0, LIMITS.control), cardKind: kind });
    return { kind: "allow", resolve: async () => this.cardInput(tool, kind, n.ref, input) };
  }

  // The first card detail of a payment: everything the owner is asked about is read here, by code, from the page and the ledger. Any doubt
  // (no clear total, another currency, a cap, a cart that looks paid, a ticked save-the-card box) is no question and no payment.
  private payAsk(tool: string, n: Node, input: Record<string, unknown>, target: { merchant: string; psp: string[] }, frame: boolean, stop: (r: string, e?: Record<string, unknown>) => Decision, fix: (r: string, e?: Record<string, unknown>) => Decision): Decision {
    const card = this.card!;
    const max = settings.browseMaxPayments;
    if (max <= 0) return stop("Card payments are switched off for browse runs (settings.ts).");
    if (this.pay.approved >= max) return stop(`This run already started its ${max} card payment(s).`);
    if (this.pay.asks > max) return stop("The owner was asked about this payment already.");
    if (this.fullUrl !== this.url) return fix("Take a browser_snapshot of this payment page first (a whole page view), then type the card number.");
    const total = findPayableTotal(this.fullView);
    if ("problem" in total) return stop(`The total to pay cannot be read: ${total.problem}.`);
    if (total.money.currency !== card.info.currency) return stop(`The page asks for ${total.money.currency} but the card is in ${card.info.currency}.`);
    const boxes = riskyBoxes(this.nodes.values());
    if (boxes.length) return fix(`A box is ticked that saves the card or signs up for something (“${clip(boxes[0]!, LIMITS.control)}”). Untick it and take a new browser_snapshot, or stop with status needs_owner and give handoffUrl.`);
    const lines = cartLines(this.fullView);
    const hash = cartHash(target.merchant, total.money, lines);
    const dup = card.ledger.duplicate(target.merchant, hash);
    if (dup) return stop(`This cart looks already paid (payment ${dup.id} is ${dup.status}). Check the card app and the e-mail; nothing is paid twice.`, { duplicate: dup.id });
    const capped = capProblem(total.money.minor, card.caps, card.ledger.spentToday(card.info.currency));
    if (capped) return stop(`The payment is refused by the card caps: ${capped}.`, { cap: true });
    this.pay.asks++;
    const id = approvalId([dayIn(new Date()), target.merchant, target.psp, total.money.minor, total.money.currency, hash, card.info.last4]);
    const prior = card.ledger.rows().filter((r) => r.merchant === target.merchant && r.cartHash === hash && r.id !== id).map((r) => `${r.id} ${r.status}`);
    const description = payDetails({ ...target, money: total.money, card: card.info, id, cart: lines, task: this.task, prior });
    const meta = { id, merchant: target.merchant, pspHost: target.psp.join(","), total: formatMoney(total.money), currency: total.money.currency, last4: card.info.last4, cartHash: hash };
    this.log(tool, "ask-pay", { target: input.target }, { role: n.role, step: "pay", ...meta });
    this.record("card_approval", "asked", "browse", meta);
    const url = bare(this.url);
    return {
      kind: "ask",
      judge: false,
      payment: true,
      description,
      facts: { host: hostOf(this.url), step: "pay", merchant: target.merchant },
      redacted: { target: input.target, text: "{{card:number}}" },
      resolve: () => this.payApproved(tool, n, input, { ...meta, ...target, money: total.money, url, frame }),
    };
  }

  // The owner said yes. Only now is the card opened (and checked against the one the run started with), and only if nothing changed meanwhile.
  private async payApproved(tool: string, n: Node, input: Record<string, unknown>, a: { id: string; merchant: string; psp: string[]; money: Money; cartHash: string; url: string; frame: boolean; last4: string }): Promise<Record<string, unknown> | string> {
    const card = this.card!;
    const refuse = (why: string) => (this.record("card_blocked", "deny", "browse", { reason: why, id: a.id, afterYes: true }), `${why} Nothing was typed.${HAND}`);
    const off = card.off();
    if (off) return refuse(`Card payments are ${off}.`);
    if (bare(this.url) !== a.url) return refuse("The page changed while the owner was deciding.");
    const total = findPayableTotal(this.fullView);
    if (!("money" in total) || !sameMoney(total.money, a.money) || this.fullUrl !== this.url) return refuse("The total changed while the owner was deciding.");
    const loaded = await card.load();
    if (typeof loaded === "string") return refuse(`The card could not be opened (${loaded}).`);
    this.pay.card = loaded;
    for (const v of secretVariants(loaded)) (this.secrets.add(v), this.cardSecrets.add(v));
    this.cardCvc = loaded.cvc;
    this.pay.approval = { id: a.id, merchant: a.merchant, psp: a.psp, url: a.url, money: a.money, cartHash: a.cartHash, frames: a.frame, last4: a.last4, expiresAt: Date.now() + APPROVAL_MINUTES * 60_000 };
    this.pay.approved++;
    card.ledger.add({ id: a.id, merchant: a.merchant, totalMinor: a.money.minor, currency: a.money.currency, last4: a.last4, cartHash: a.cartHash, status: "approved" });
    this.record("card_approval", "approved", "browse", { id: a.id, merchant: a.merchant, pspHost: a.psp.join(","), total: formatMoney(a.money), currency: a.money.currency, last4: a.last4, cartHash: a.cartHash });
    return this.cardInput(tool, "number", n.ref, input);
  }

  // The call as it runs: the card detail typed by code. Everything the model, the audit and the question see is the placeholder and a length.
  private cardInput(tool: string, kind: FieldKind, ref: string, input: Record<string, unknown>): Record<string, unknown> | string {
    const c = this.pay.card;
    if (!c || !this.pay.approval) return `The card is not open. Nothing was typed.${HAND}`;
    const value = kind === "number" ? c.pan : kind === "expiry" ? expiryText(c) : kind === "cvc" ? c.cvc : c.holder;
    if (!value) return "No cardholder name is saved for this card, so that field is not filled. Stop with status needs_owner and give handoffUrl.";
    this.cardIntents.set(ref, kind);
    this.log(tool, "fill-card-run", { target: ref }, { cardKind: kind, valueLength: value.length });
    return { ...input, text: value };
  }

  // The click that could submit the typed card. Everything is read again from the page as it is now; one mismatch and nothing is clicked.
  private async payClick(tool: string, input: Record<string, unknown>, n: Node): Promise<Decision> {
    const card = this.card!;
    const a = this.pay.approval!;
    const gone = (why: string) => {
      this.pay.invalidate();
      card.ledger.setStatus(a.id, "failed");
      this.record("card_pay", "aborted", "browse", { id: a.id, merchant: a.merchant, reason: why.slice(0, LIMITS.reason) });
      return this.payDeny(tool, input, `Nothing was clicked: ${why} Do not try again: the order needs a new approval in a new run.${HAND}`, { changed: true });
    };
    if (Date.now() > a.expiresAt) return gone("the payment approval ran out (it lasts ten minutes).");
    const off = card.off();
    if (off) return gone(`card payments are ${off}.`);
    if (bare(this.url) !== a.url) return gone("the page address changed since the owner approved.");
    if (this.fullUrl !== this.url || this.fullSeq <= this.pay.lastFillSeq) return this.payDeny(tool, input, "Take a fresh browser_snapshot of this page, then click the pay button: the total is read again from it before the click.");
    const target = await this.payTarget(a.frames);
    if (typeof target === "string") return gone(target);
    if (target.merchant !== a.merchant || target.psp.some((h) => !a.psp.includes(h))) return gone("the shop or the payment provider changed since the owner approved.");
    // From here to the end of this method there is no await: two clicks at once cannot both pass.
    const total = findPayableTotal(this.fullView);
    if ("problem" in total) return gone(`the total cannot be read any more (${total.problem}).`);
    if (!sameMoney(total.money, a.money)) return gone(`the total is now ${formatMoney(total.money)}, the owner approved ${formatMoney(a.money)}.`);
    const label = parseMoney(n.name);
    if (label && !sameMoney(label, a.money)) return gone(`the button says ${formatMoney(label)}, the owner approved ${formatMoney(a.money)}.`);
    if (cartHash(a.merchant, total.money, cartLines(this.fullView)) !== a.cartHash) return gone("the cart changed since the owner approved.");
    if (riskyBoxes(this.nodes.values()).length) return gone("a box that saves the card or signs up for something is ticked.");
    const capped = capProblem(a.money.minor, card.caps, card.ledger.spentToday(a.money.currency));
    if (capped) return gone(`the card caps: ${capped}.`);
    if (this.pay.attempted || !this.pay.approval) return this.payDeny(tool, input, "A payment was already attempted in this run. Do not click again.", { locked: true });
    this.pay.attempted = true; // before the click runs: a second click, a retry or a rephrased call finds it set
    this.pay.card = undefined;
    card.ledger.setStatus(a.id, "clicked");
    this.log(tool, "pay-click", input, { role: n.role, name: n.name.slice(0, LIMITS.control), commit: true });
    this.record("card_pay", "clicked", "browse", { id: a.id, merchant: a.merchant, pspHost: a.psp.join(","), total: formatMoney(a.money), last4: a.last4, host: hostOf(this.url) });
    return { kind: "allow" };
  }

  // The card details typed by this call are remembered; their field lines and any echo of them are cut from what the model reads.
  private doneCard(name: string, input: Record<string, unknown>): FieldKind[] {
    const kinds: FieldKind[] = [];
    if (name !== "type") return kinds;
    const ref = String(input.target);
    const kind = this.cardIntents.get(ref);
    if (!kind) return kinds;
    this.cardIntents.delete(ref);
    this.fillRefs.add(ref);
    this.justFilled.add(ref);
    this.typed.set(ref, { label: this.nodes.get(ref)?.name ?? "", value: HIDDEN });
    this.pay.typed.add(kind);
    kinds.push(kind);
    return kinds;
  }

  // The end of the run: the card is dropped, and what the owner should be told about the payment (undefined: none was attempted).
  finishPayment(): string | undefined {
    this.pay.card = undefined;
    if (this.payNote !== undefined) return this.payNote || undefined; // once: the ledger and the audit get one result
    const a = this.pay.approval;
    if (!a || !this.pay.attempted) return undefined;
    return (this.payNote = this.paymentNote(a)) || undefined;
  }
  private paymentNote(a: NonNullable<PayRun["approval"]>): string {
    const what = `${formatMoney(a.money)} at ${a.merchant} (card ••••${a.last4})`;
    if (this.pay.settled === "confirmed") return `Card payment of ${what}: the page showed a confirmation. Check the amount in the card app too.`;
    if (this.pay.settled === "failed") return `Card payment of ${what}: the page showed that it failed or was declined. Nothing is retried automatically.`;
    this.card?.ledger.setStatus(a.id, "unconfirmed");
    this.record("card_pay", "unconfirmed", "browse", { id: a.id, merchant: a.merchant, last4: a.last4 });
    this.paid("unconfirmed", a);
    return `Card payment of ${what} was started but NOT confirmed on the page. Check the card app and your e-mail before doing anything; it will not be paid again until you clear it (npm run card -- clear ${a.id}).`;
  }

  // Any trace of the card in a text the owner will read (the worker's final answer): cut.
  scrub(text: string): string {
    let out = text;
    for (const v of [...this.cardSecrets].sort((a, b) => b.length - a.length)) if (v.length >= 3) out = out.split(v).join("[card]");
    return out;
  }

  async decide(toolName: string, input: Record<string, unknown>): Promise<Decision> {
    this.steps++;
    if (this.denied >= MAX_DENIED) return this.deny(toolName, input, "Too many refused calls in this run. Stop now and report what you have.");
    if (toolName === "WebSearch") return { kind: "defer" };
    if (!toolName.startsWith("mcp__browser__")) return this.deny(toolName, input, `${toolName} is not available in a browse run.`);
    if (!isAllowedBrowserTool(toolName)) return this.deny(toolName, input, `${short(toolName)} is not available.`);
    const name = short(toolName);
    // The page that loaded is checked again by what its name resolves to (shape starts it, a model step later it has long answered): a redirect onto a name that points inside is withheld. The egress proxy already
    // refuses the connection itself; this stops the run from working on whatever got through some other way.
    const loaded = this.pageChecks.get(hostOf(this.url));
    if (this.url && loaded && loaded.done === false && !(name === "navigate" || (name === "tabs" && typeof input.url === "string"))) {
      this.nodes.clear();
      this.url = "";
      return this.deny(toolName, input, "The page you are on has a name that points to a private address; its content is withheld. Go back or stop.");
    }
    const locked = this.payLock(toolName, input, name);
    if (locked) return locked;
    switch (name) {
      case "navigate":
      case "tabs": {
        if (name === "tabs" && typeof input.url !== "string") return { kind: "defer" };
        const bad = addressProblem(input.url);
        if (bad) return this.deny(toolName, input, `Cannot open that address: ${bad}.`, { address: clip(String(input.url ?? ""), 80) });
        if (!(await resolvesPublic(hostOf(input.url), this.resolver))) return this.deny(toolName, input, "Cannot open that address: the name points to a private address.");
        this.navNext = true;
        this.log(toolName, "nav", input);
        // The fast path (after the address floor and the DNS check above, which always run): the judge has already decided in THIS run that this site fits the task.
        // Only a plain address (https, no port, no login, no fragment, a short query: webaddress.ts) to a site the run was cleared for, and only so many times;
        // typing, forms and every new site are judged as ever. A redirect clears nothing: only the address asked for counts.
        const url = String(input.url);
        const host = hostOf(url).toLowerCase();
        const key = JSON.stringify([name, input.url, input.action ?? null]);
        if (settings.autoApprove !== "off") {
          if (this.autoCalls.has(key)) return { kind: "allow", skipped: { reason: "same-call", host } };
          if (this.accepted.has(host) && isPlainWebAddress(url) && this.fastPath < FAST_NAVIGATIONS) {
            this.fastPath++;
            return { kind: "allow", skipped: { reason: "same-host", host } };
          }
        }
        return {
          kind: "defer",
          description: `🌐 Browser: open a page\nAddress: ${clip(url, 300)}`,
          allowed: (by) => {
            this.accepted.add(host);
            if (by === "judge") this.autoCalls.add(key);
          },
        };
      }
      case "type": {
        const n = this.refNode(input.target);
        if (typeof n === "string") return this.deny(toolName, input, n);
        const text = String(input.text ?? "");
        this.intents.delete(n.ref);
        this.cardIntents.delete(n.ref);
        if (HAS_CARD_PLACEHOLDER.test(text)) return this.cardField(toolName, n, text, input);
        if (HAS_PLACEHOLDER.test(text)) {
          // A saved detail: code checks the field, the page and the site, then types the real value. The model, the question and the audit see the key.
          const logged = { target: input.target };
          if (input.submit === true) return this.deny(toolName, logged, "Do not submit while typing a saved detail. Type it, then use the page's own button.");
          const r = this.fillFrom(n, text);
          if (typeof r === "string") return this.deny(toolName, logged, r, { profile: true });
          this.intents.set(n.ref, r.intent);
          this.log(toolName, "fill-profile", logged, { role: n.role, name: n.name.slice(0, LIMITS.control), profileKey: r.intent.key, valueLength: r.value.length });
          return { kind: "defer", input: { ...input, text: r.value }, description: this.fillDescription([r.intent]) };
        }
        const kind = sensitiveKind(n.name, text);
        if (kind) return this.sensitive(toolName, input, [{ name: n.name, kind }]);
        if (input.submit === true) return this.commit(toolName, input, n, "typing with Enter would submit the form", `Typing into “${clip(n.name || n.ref, 120)}” (${n.role}) and pressing Enter`, [[n.name || n.ref, text]]);
        this.log(toolName, "type", input, { role: n.role, name: n.name.slice(0, LIMITS.control) });
        return { kind: "defer", description: `⌨️ Browser: type into “${clip(n.name || n.ref, 80)}” (${n.role})\nSite: ${clip(hostOf(this.url), 100)}\nText: ${clip(text, 200)}` };
      }
      case "fill_form": {
        const fields = Array.isArray(input.fields) ? (input.fields as Record<string, unknown>[]) : [];
        const lines: string[] = [];
        const secret: { name: string; kind: string }[] = [];
        const real: Record<string, unknown>[] = [];
        const mine: FillIntent[] = [];
        for (const f of fields) {
          const n = this.refNode(f.target);
          if (typeof n === "string") return this.deny(toolName, input, n);
          if (HAS_CARD_PLACEHOLDER.test(String(f.value ?? ""))) return this.payDeny(toolName, { target: f.target }, "A card detail is typed with browser_type, one call per field, not with browser_fill_form.");
          this.intents.delete(n.ref);
          if (HAS_PLACEHOLDER.test(String(f.value ?? ""))) {
            const logged = { target: f.target };
            const r = this.fillFrom(n, String(f.value));
            if (typeof r === "string") return this.deny(toolName, logged, r, { profile: true });
            mine.push(r.intent);
            real.push({ ...f, value: r.value });
            continue;
          }
          real.push(f);
          const kind = sensitiveKind(n.name, String(f.value ?? "")) ?? sensitiveKind(String(f.name ?? ""));
          if (kind) {
            secret.push({ name: n.name || String(f.name ?? ""), kind });
            continue;
          }
          lines.push(`• ${clip(n.name || n.ref, 80)}: ${clip(String(f.value ?? ""), 160)}`);
        }
        if (secret.length) return this.sensitive(toolName, input, secret);
        if (mine.length) {
          for (const it of mine) this.intents.set(it.ref, it);
          this.log(toolName, "fill-profile", { fields: fields.map((f) => ({ value: HAS_PLACEHOLDER.test(String(f.value ?? "")) ? "" : f.value })) }, { profileKeys: mine.map((m) => m.key) });
          return { kind: "defer", input: { ...input, fields: real }, description: `${this.fillDescription(mine)}${lines.length ? `\n${lines.join("\n")}` : ""}` };
        }
        this.log(toolName, "fill", input);
        return { kind: "defer", description: `⌨️ Browser: fill in a form\nSite: ${clip(hostOf(this.url), 100)}\n${lines.join("\n")}` };
      }
      case "select_option": {
        const n = this.refNode(input.target);
        if (typeof n === "string") return this.deny(toolName, input, n);
        this.log(toolName, "select", input, { role: n.role });
        return { kind: "defer", description: `⌨️ Browser: choose “${clip(Array.isArray(input.values) ? input.values.join(", ") : "", 120)}” in “${clip(n.name || n.ref, 80)}”\nSite: ${clip(hostOf(this.url), 100)}` };
      }
      case "press_key": {
        // Enter or Space on a focused control can submit a form or press a button: after typing, that is treated as a commit step.
        if (/^(Enter|NumpadEnter|Space| )$/.test(String(input.key ?? "")) && this.typed.size > 0) return this.commit(toolName, input, undefined, `pressing ${String(input.key)} after typing can submit the form`, `Key press: ${String(input.key)} (on the control that has focus)`);
        return { kind: "defer" };
      }
      case "handle_dialog":
        return input.accept === true ? this.commit(toolName, input, undefined, "accepting a page dialog", "Page dialog: accept it") : { kind: "defer" };
      case "click": {
        const n = this.refNode(input.target);
        if (typeof n === "string") {
          // A stale or unknown ref is not a reason to ask the owner: the call is refused and the worker told to look again. Never clicked unseen.
          if (!isRef(input.target)) return this.deny(toolName, input, n);
          this.log(toolName, "deny", input, { reason: "stale ref", stale: true }); // not counted toward the run's refusals: it is the page moving, not a misstep
          return { kind: "deny", reason: `${String(input.target)} is not in the last page view (the page changed, or the ref is old). Take a fresh browser_snapshot and click a ref from it.` };
        }
        if (n.url) {
          let abs = n.url;
          try {
            abs = new URL(n.url, this.url || "https://invalid.invalid/").toString();
          } catch {
            // a link that is not an address at all: addressProblem says so
          }
          const bad = /^#/.test(n.url) ? undefined : addressProblem(abs);
          if (bad) return this.deny(toolName, input, `That link is not allowed: ${bad}.`, { role: n.role });
          if (!/^#/.test(n.url) && !(await resolvesPublic(hostOf(abs), this.resolver))) return this.deny(toolName, input, "That link is not allowed: the name points to a private address.", { role: n.role });
        }
        const c = classifyClick(n);
        // With a card typed for an approved payment, the next button that could submit it IS the pay click: checked again from the page, once. Any other click
        // while a payment is open (a link, a toggle, a button elsewhere) is refused: only a text field may be clicked into (to type the next card detail).
        if (this.pay.active && (c.commit || (n.role === "button" && n.inForm))) return this.payClick(toolName, input, n);
        if (this.payOpen && (!FIELD_ROLES.test(n.role) || n.url)) return this.payDeny(toolName, input, "A payment is in progress: the only click allowed is the page's pay button (after the card details are typed and a fresh browser_snapshot). Stop otherwise.");
        this.log(toolName, c.commit ? "commit-check" : "click", input, { role: n.role, name: n.name.slice(0, LIMITS.control), commit: c.commit });
        if (c.commit) return this.commit(toolName, input, n, c.why, `Button: “${clip(n.name || "(no label)", 120)}” (${n.role})`);
        return { kind: "defer", description: `🖱️ Browser: click “${clip(n.name || n.ref, 80)}” (${n.role})` };
      }
      case "take_screenshot": {
        if (this.shots >= MAX_SHOTS) return this.deny(toolName, input, `This run already took ${MAX_SHOTS} screenshots. Work from the page views, or stop and report.`);
        const r = screenshotInput(input);
        if ("deny" in r) return this.deny(toolName, input, r.deny);
        this.shots++;
        this.log(toolName, "shot", input);
        return { kind: "defer", input: r.input };
      }
      case "mouse_move_xy": {
        const p = validPoint(input.x, input.y);
        if (typeof p === "string") return this.deny(toolName, input, p);
        this.log(toolName, "hover-point", input);
        return { kind: "defer" };
      }
      case "mouse_wheel": {
        const ok = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 5000);
        if (!ok(input.deltaX) || !ok(input.deltaY)) return this.deny(toolName, input, "The scroll amount must be a number up to 5000.");
        return { kind: "defer" };
      }
      case "mouse_click_xy":
        return this.clickAt(toolName, input);
      default:
        return { kind: "defer" }; // snapshot, find, navigate_back, hover, wait_for: reads
    }
  }

  // A click at a point (browsevision.ts). The model's idea of what is there counts for nothing: code asks the browser what the click
  // would hit (browsecdp.ts), turns that into a Node and decides it as it decides a ref click. What it cannot resolve goes to the judge;
  // payment and login fields always ask; a link must pass the address check.
  private async clickAt(tool: string, input: Record<string, unknown>): Promise<Decision> {
    const bad = clickProblem(input);
    if (bad) return this.deny(tool, input, bad);
    const pt = validPoint(input.x, input.y);
    if (typeof pt === "string") return this.deny(tool, input, pt);
    if (!this.probe) return this.deny(tool, input, "Clicking at a point is not available in this run. Click by ref.");
    if (++this.pointClicks > MAX_POINT_CLICKS) return this.deny(tool, input, `This run already made ${MAX_POINT_CLICKS} clicks at points. Stop and report.`);
    const at = `(${Math.round(pt.x)}, ${Math.round(pt.y)})`;
    const where = this.url || undefined;
    let info = await this.probe(pt.x, pt.y, where);
    if (typeof info === "string") info = await this.probe(pt.x, pt.y, where); // one retry: a lookup can fail once while the page settles
    // What code cannot resolve goes to the approval judge (the point, why, the task and the controls the page shows), not to the owner directly;
    // a judge that asks or fails asks the owner. Payment and login fields are not this path: they always ask.
    const unknown = (why: string) => this.commit(tool, input, undefined, `the element at the point could not be identified: ${why}`, `Click at ${at} on something code could not identify\n${this.controlsSeen()}`);
    if (typeof info === "string") return unknown(info);
    if (!this.url || info.pageUrl !== this.url) return unknown("the page is not the one in the last page view");
    if (info.opaque) { // an embedded frame can hold a payment or login widget that code cannot read: the owner is asked, not the judge
      const d = unknown(info.opaque);
      return d.kind === "ask" ? { ...d, judge: false } : d;
    }
    if (info.href && info.href.split("#")[0] !== this.url.split("#")[0]) {
      const badLink = addressProblem(info.href);
      if (badLink) return this.deny(tool, input, `That link is not allowed: ${badLink}.`, { role: info.role });
      if (!(await resolvesPublic(hostOf(info.href), this.resolver))) return this.deny(tool, input, "That link is not allowed: the name points to a private address.", { role: info.role });
    }
    const kind = info.password ? "a password" : sensitiveKind(`${info.hints} ${info.name}`) ?? (AUTOFILL_SENSITIVE.test(info.hints) ? "a payment or login detail" : undefined);
    if (kind) return this.sensitive(tool, input, [{ name: info.name || info.hints || `the field at ${at}`, kind }]);
    const node = nodeOfPoint(info, pt.x, pt.y);
    const c = classifyClick(node);
    // An empty area, or a canvas/svg/map surface with no link, button, field or form around it, is a plain click: logged with what was hit.
    this.log(tool, c.commit ? "commit-check" : "click", input, { role: node.role, name: node.name.slice(0, LIMITS.control), commit: c.commit, point: true, tag: info.tag, ...(info.nothing ? { hit: "nothing" } : {}) });
    if (c.commit) return this.commit(tool, input, node, c.why, `Click at ${at}: “${clip(node.name || "(no label)", 120)}” (${node.role})`);
    return { kind: "defer", description: `🖱️ Browser: click at ${at}: “${clip(node.name || node.role, 80)}” (${node.role})` };
  }

  // After a call succeeded: what the model will read (a linked snapshot file read in, a page view cut to size), and what code remembers.
  // Returns the new text, or undefined to leave the result as it is.
  shape(toolName: string, input: Record<string, unknown>, text: string): string | undefined {
    let out = text;
    const link = /^- \[Snapshot\]\(([^)]+)\)\s*$/m.exec(out);
    if (link) {
      const path = resolve(link[1]!);
      if (path.startsWith(resolve(this.outDir) + sep)) {
        try {
          out = out.replace(link[0], "```yaml\n" + readFileSync(path, "utf8") + "\n```");
        } catch {
          // the file is gone: the model can ask for a snapshot
        }
      }
    }
    const seen = /Page URL: (\S+)/.exec(out)?.[1];
    if (seen && addressProblem(seen)) {
      this.nodes.clear();
      this.url = "";
      return `### Page\nThe page went to an address that is not allowed (${addressProblem(seen)}); its content is withheld. Go back or stop.`;
    }
    if (seen && !this.pageChecks.has(hostOf(seen))) {
      const check: { done?: boolean; wait: Promise<void> } = { wait: Promise.resolve() };
      check.wait = resolvesPublic(hostOf(seen), this.resolver).then((ok) => void (check.done = ok));
      this.pageChecks.set(hostOf(seen), check);
    }
    const cardDone = this.doneCard(short(toolName), input);
    if (cardDone.length) {
      out = out.replace(/### Ran Playwright code[\s\S]*?(?=\n### |$)/, "").replace(/\n{3,}/g, "\n\n");
      out = `Filled the ${cardDone.map((k) => WORDS[k]).join(", ")} from the saved card.\n${out}`;
    }
    const done = this.doneFills(short(toolName), input);
    if (done.length) {
      // Saved details were typed: the server's echo of the typed code is dropped, the model is told only which fields were filled.
      out = out.replace(/### Ran Playwright code[\s\S]*?(?=\n### |$)/, "").replace(/\n{3,}/g, "\n\n");
      out = `Filled ${done.map((d) => `“${clip(d.label, 60)}”`).join(", ")} from the saved profile.\n${out}`;
    }
    out = cleanText(out).text; // refs and names are remembered as the model will read them, hidden characters out
    out = this.redact(out);
    if (out.length > SNAPSHOT_CAP) out = `${out.slice(0, SNAPSHOT_CAP)}\n[... ${out.length - SNAPSHOT_CAP} characters of the page view cut: use browser_find for what you need, or a narrower page]`;
    if (/\[ref=|### Snapshot|Page URL/.test(out)) this.record("browse_view", "page", "browse", { tool: short(toolName), chars: out.length, cut: out.length > SNAPSHOT_CAP, fromFile: !!link });
    if (short(toolName) === "take_screenshot") this.record("browse_view", "screenshot", "browse", { tool: short(toolName), chars: out.length });
    this.remember(toolName, input, out, seen);
    if (cardDone.length) this.pay.lastFillSeq = this.fullSeq; // a whole page view (browser_snapshot) taken after this fill is needed before the click
    if (this.pay.attempted && !this.pay.settled && this.pay.approval) this.afterClick(out);
    this.justFilled.clear();
    return out === text ? undefined : out;
  }

  // Page views after the pay click: a confirmation or a decline, in the page's own words, is noted; nothing else is concluded.
  private afterClick(view: string) {
    const o = paymentOutcome(view);
    const a = this.pay.approval!;
    if (!o) return;
    this.pay.settled = o;
    this.card?.ledger.setStatus(a.id, o);
    this.record("card_pay", o, "browse", { id: a.id, merchant: a.merchant, last4: a.last4 });
    this.paid(o, a);
  }

  remember(toolName: string, input: Record<string, unknown>, text: string, seen: string | undefined) {
    const name = short(toolName);
    if (seen && seen !== this.url) {
      this.typed.clear();
      this.url = seen;
      if (this.approvedPlan && this.approvedPlan.host !== hostOf(seen)) this.approvedPlan = undefined; // another site: nothing carries over
      const domain = registeredDomain(hostOf(seen));
      if (domain && this.chain[this.chain.length - 1]?.domain !== domain) this.chain.push({ domain, by: this.navNext ? "navigate" : "follow" });
      // A typed card belongs to the page it was approved on: another page, and the approval is void.
      if (this.pay.approval && !this.pay.attempted && bare(seen) !== this.pay.approval.url) this.voidPay("the page changed");
    }
    this.navNext = false;
    if (name === "snapshot" && /\[ref=/.test(text)) (this.fullView = text), (this.fullUrl = this.url), this.fullSeq++;
    if (name === "navigate" || name === "navigate_back") this.typed.clear();
    if (/\[ref=/.test(text)) {
      const fresh = parseSnapshot(text);
      if (name === "find") for (const [k, v] of fresh) this.nodes.set(k, v);
      else (this.nodes = fresh, (this.viewUrl = this.url), (this.view = text));
    }
    if (name === "type" && isRef(input.target) && !this.justFilled.has(String(input.target))) {
      const label = this.nodes.get(String(input.target))?.name ?? "";
      this.typed.set(String(input.target), { label, value: sensitiveKind(label, String(input.text ?? "")) ? HIDDEN : String(input.text ?? "") });
    }
    if (name === "fill_form" && Array.isArray(input.fields)) for (const f of input.fields as Record<string, unknown>[]) if (isRef(f.target) && !this.justFilled.has(String(f.target))) {
      const label = String(f.name ?? this.nodes.get(String(f.target))?.name ?? "");
      this.typed.set(String(f.target), { label, value: sensitiveKind(label, String(f.value ?? "")) || sensitiveKind(this.nodes.get(String(f.target))?.name ?? "") ? HIDDEN : String(f.value ?? "") });
    }
    if (this.pending !== undefined && this.pending === toolName + JSON.stringify(input)) {
      this.commits++;
      this.pending = undefined;
    }
  }
}

// The text of a tool result, whatever its shape (a string, {content: [...]}, or the blocks themselves), and the same result with new text.
type Block = { type?: string; text?: string; data?: string; source?: { data?: string } };
const blocksOf = (r: unknown): Block[] | undefined => (Array.isArray(r) ? (r as Block[]) : r && typeof r === "object" && Array.isArray((r as { content?: unknown }).content) ? (r as { content: Block[] }).content : undefined);
// The bytes of the first image of a tool result (base64 in the block), if any.
export function imageBytes(r: unknown): Buffer | undefined {
  const img = blocksOf(r)?.find((x) => x?.type === "image");
  const data = img?.source?.data ?? img?.data;
  return typeof data === "string" && data ? Buffer.from(data, "base64") : undefined;
}
export function resultText(r: unknown): string {
  if (typeof r === "string") return r;
  const b = blocksOf(r);
  return b ? b.filter((x) => x?.type === "text" && typeof x.text === "string").map((x) => x.text).join("\n") : "";
}
export function withText(r: unknown, text: string): unknown {
  if (typeof r === "string") return text;
  const b = blocksOf(r);
  if (!b) return r;
  let put = false;
  const next = b.flatMap((x) => (x?.type === "text" ? (put ? [] : ((put = true), [{ ...x, text }])) : [x]));
  return Array.isArray(r) ? next : { ...(r as object), content: next };
}
