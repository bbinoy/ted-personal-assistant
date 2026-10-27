import { test } from "node:test";
import assert from "node:assert/strict";
import { standing } from "./util.ts";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAudit } from "../src/core/audit.ts";
import { makeApprove } from "../src/approvals/approvalask.ts";
import type { Verdict } from "../src/approvals/autojudge.ts";
import { browse, browseSystem } from "../src/modules/browse/browse.ts";
import { BrowseGuard } from "../src/modules/browse/browseguard.ts";
import type { FrameProbe } from "../src/modules/browse/browsecdp.ts";
import { KillSwitch, openCardAccess, type CardAccess, type CardRecord } from "../src/modules/browse/card.ts";
import { Ledger } from "../src/modules/browse/payments.ts";
import { makeCanUseTool } from "../src/approvals/permissions.ts";
import { fakeCardStore } from "./fakebao.ts";
import { OWNER_KEY } from "../src/core/ownerkey.ts";
import { dataPath } from "../src/core/state.ts";
import { logPaths } from "../src/core/convpaths.ts";
import { scratch, scratchDb } from "./scratch.ts";
import { BROWSE_RUN } from "./runkinds.ts";

// Obviously fake: the public test card number, a made-up security code, a local fake checkout (`shop.test`, a hosted page on stripe.com) that exists
// only as page text in these tests. No real merchant, card or money.
const PAN = "4242424242424242";
const PAN_SPACED = "4242 4242 4242 4242";
const CVC = "0731";
const CARD: CardRecord = { pan: PAN, expMonth: 12, expYear: 2099, cvc: CVC, label: "Wise", last4: "4242", currency: "CHF", holder: "Annabelle Fakename" };
const EXPIRY = "12/99";
const B = "mcp__browser__browser_";
const opts = { signal: new AbortController().signal } as never;
const publicDns = async () => ["93.184.216.34"];
const SHOP = "https://shop.test/checkout";
const PSP = "https://checkout.stripe.com/c/pay/cs_test_fake";

let n = 0;
const unique = () => `${process.pid}-${++n}`;
const newStore = async (card: CardRecord = CARD) => {
  return fakeCardStore(card);
};
const newAccess = async (o: { card?: CardRecord; caps?: CardAccess["caps"]; kill?: KillSwitch; ledger?: Ledger } = {}) => {
  const kill = o.kill ?? new KillSwitch(scratch(`card-test-${unique()}.disabled`));
  const ledger = o.ledger ?? new Ledger(scratchDb(`payments-test-${unique()}`));
  const access = await openCardAccess({ store: await newStore(o.card), kill, ledger, caps: o.caps ?? { purchaseMinor: 2500 * 10, dayMinor: 5000 * 10 } });
  return { access: access!, kill, ledger };
};

// A page view in the shape the browser server prints it: the shop's cart and total, the card form, a pay button.
interface PageOpts { total?: string; cart?: string; button?: string; save?: boolean; values?: Record<string, string>; names?: Record<string, string>; extra?: string }
const page = (url: string, o: PageOpts = {}) => {
  const v = (ref: string) => (o.values?.[ref] !== undefined ? `: ${o.values[ref]}` : "");
  const name = (ref: string, d: string) => o.names?.[ref] ?? d;
  return `### Page
- Page URL: ${url}
### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - heading "Checkout" [ref=e2]
  - text: ${o.cart ?? "Ticket Zurich to Bern CHF 40.00"}
  - text: Shipping CHF 5.00
  - text: Total ${o.total ?? "CHF 45.00"}
  - link "Pay by card" [ref=e9]:
    - /url: ${PSP}
  - form "Payment" [ref=e3]:
    - textbox "${name("e4", "Card number")}" [ref=e4]${v("e4")}
    - textbox "${name("e5", "Expiration date MM / YY")}" [ref=e5]${v("e5")}
    - textbox "${name("e6", "Security code")}" [ref=e6]${v("e6")}
    - checkbox "Save my card for faster checkout" [ref=e7]${o.save ? " [checked]" : ""}
    ${o.extra ?? ""}
    - button "${o.button ?? "Pay CHF 45.00"}" [ref=e8]
\`\`\``;
};
// What @playwright/mcp prints after a type: the code it ran (with the value), and the page with the field's value in it.
const echo = (url: string, ref: string, value: string, o: PageOpts = {}) => `### Ran Playwright code\n\`\`\`js\nawait page.getByRole('textbox').fill('${value}');\n\`\`\`\n${page(url, { ...o, values: { ...o.values, [ref]: value } })}`;

interface Rig {
  g: BrowseGuard;
  asked: { description: string; input: Record<string, unknown>; typedYes?: boolean }[];
  answer: { approved: boolean };
  judged: number[];
  canUse: ReturnType<typeof makeCanUseTool>;
}
const rig = async (o: { access?: CardAccess; mode?: "owner" | "group"; frames?: FrameProbe; task?: string } = {}): Promise<Rig & { access: CardAccess; kill: KillSwitch; ledger: Ledger }> => {
  const made = o.access ? { access: o.access, kill: new KillSwitch(scratch(`card-test-${unique()}.disabled`)), ledger: o.access.ledger } : await newAccess();
  const g = new BrowseGuard({ mode: o.mode ?? "owner", task: o.task ?? "buy the 10:00 train ticket Zurich to Bern", outDir: join(tmpdir(), "nope"), resolver: publicDns, card: made.access, frames: o.frames });
  const asked: Rig["asked"] = [];
  const answer = { approved: true };
  const judged: number[] = [];
  const judge = async (): Promise<Verdict> => (judged.push(1), { decision: "auto", reason: "test" }); // a judge that says yes to everything
  const canUse = makeCanUseTool(async (description, call, _s, op) => (asked.push({ description, input: call.input, typedYes: op?.typedYes }), { ...answer }), BROWSE_RUN, undefined, judge, g, undefined, false, { provenance: standing("buy a ticket") });
  return { g, asked, answer, judged, canUse, ...made };
};

type Allowed = { behavior: "allow"; updatedInput: Record<string, unknown> };
type Denied = { behavior: "deny"; message: string };
// Runs one call through the whole permission path; when it is allowed it "runs" (the result text is shaped by the guard, as the hook does).
const step = async (r: Rig, name: string, input: Record<string, unknown>, result?: (ran: Record<string, unknown>) => string) => {
  const res = (await r.canUse(B + name, input, opts)) as Allowed | Denied;
  if (res.behavior === "deny") return { res, shown: undefined as string | undefined, ran: undefined };
  const shown = result ? r.g.shape(B + name, res.updatedInput, result(res.updatedInput)) : undefined;
  return { res, shown, ran: res.updatedInput };
};
const open = (r: Rig, url = SHOP) => r.g.shape(`${B}navigate`, { url }, page(url));
// The run came to the shop by its address, and followed the shop's page to the payment page.
const toPsp = async (r: Rig, o: PageOpts = {}) => {
  await r.g.decide(`${B}navigate`, { url: SHOP });
  r.g.shape(`${B}navigate`, { url: SHOP }, page(SHOP, o));
  r.g.shape(`${B}click`, { target: "e9" }, page(PSP, o));
  r.g.shape(`${B}snapshot`, {}, page(PSP, o));
};
const typeNumber = (r: Rig, url = PSP, o: PageOpts = {}) => step(r, "type", { target: "e4", text: "{{card:number}}" }, (ran) => echo(url, "e4", String(ran.text), o));
const typeRest = async (r: Rig, url = PSP, o: PageOpts = {}) => {
  const a = await step(r, "type", { target: "e5", text: "{{card:expiry}}" }, (ran) => echo(url, "e5", String(ran.text), { ...o, values: { e4: PAN_SPACED } }));
  const b = await step(r, "type", { target: "e6", text: "{{card:cvc}}" }, (ran) => echo(url, "e6", String(ran.text), { ...o, values: { e4: PAN_SPACED, e5: EXPIRY } }));
  return { a, b };
};
const fullPay = async (r: Rig, url = PSP, o: PageOpts = {}) => {
  await toPsp(r, o);
  const num = await typeNumber(r, url, o);
  const rest = await typeRest(r, url, o);
  r.g.shape(`${B}snapshot`, {}, page(url, { ...o, values: { e4: PAN_SPACED, e5: EXPIRY, e6: CVC } }));
  return { num, rest };
};

// ---- the happy path ----

test("pay: the number asks for a typed YES with merchant, host, total and last 4; the rest follow without a question; code types the real values; the click is allowed once", async () => {
  const r = await rig();
  await toPsp(r);
  const num = await typeNumber(r);
  assert.equal(r.asked.length, 1, "one question for the whole payment");
  assert.equal(r.asked[0]!.typedYes, true, "the approver is told this needs a typed yes");
  assert.equal(r.judged.length, 0, "the judge never decides a payment, although it would say auto");
  const q = r.asked[0]!.description;
  assert.match(q, /^💳 Card payment approval/);
  assert.match(q, /Merchant: shop\.test/);
  assert.match(q, /Card typed on: stripe\.com/);
  assert.match(q, /Total \(read from the page by code, not checked by the shop\): CHF 45\.00/);
  assert.match(q, /Card: Wise ••••4242 \(CHF\)/);
  assert.match(q, /Approval id: [0-9a-f]{8}/);
  assert.match(q, /Ticket Zurich to Bern CHF 40\.00/);
  assert.equal(num.ran?.text, PAN, "after the yes, the browser gets the real number");
  assert.equal(r.asked[0]!.input.text, "{{card:number}}", "the question and the approval call carry the placeholder");
  const { a, b } = await typeRest(r);
  assert.equal(r.asked.length, 1, "expiry and security code do not ask again");
  assert.equal(a.ran?.text, EXPIRY);
  assert.equal(b.ran?.text, CVC);
  r.g.shape(`${B}snapshot`, {}, page(PSP, { values: { e4: PAN_SPACED, e5: EXPIRY, e6: CVC } }));
  const click = await step(r, "click", { target: "e8" });
  assert.equal(click.res.behavior, "allow");
  assert.equal(r.asked.length, 1, "the click needs no second question: the yes covered it, the page is re-read");
  assert.equal(r.g.pay.attempted, true);
  const row = r.ledger.rows()[0]!;
  assert.deepEqual([row.merchant, row.totalMinor, row.currency, row.last4, row.status], ["shop.test", 4500, "CHF", "4242", "clicked"]);
  // the page then shows a confirmation
  r.g.shape(`${B}wait_for`, {}, page("https://checkout.stripe.com/c/pay/done").replace("Checkout", "Thank you for your order"));
  assert.equal(r.ledger.rows()[0]!.status, "confirmed");
  assert.match(r.g.finishPayment()!, /the page showed a confirmation/);
});

test("pay: a hosted payment page opened by its address (not reached from the shop), or with no shop in the run, is refused", async () => {
  const opened = await rig();
  await opened.g.decide(`${B}navigate`, { url: SHOP });
  opened.g.shape(`${B}navigate`, { url: SHOP }, page(SHOP));
  await opened.g.decide(`${B}navigate`, { url: PSP });
  opened.g.shape(`${B}navigate`, { url: PSP }, page(PSP));
  opened.g.shape(`${B}snapshot`, {}, page(PSP));
  const a = await typeNumber(opened);
  assert.match((a.res as Denied).message, /opened by its address/);
  const direct = await rig();
  await direct.g.decide(`${B}navigate`, { url: PSP });
  direct.g.shape(`${B}navigate`, { url: PSP }, page(PSP));
  direct.g.shape(`${B}snapshot`, {}, page(PSP));
  assert.match(((await typeNumber(direct)).res as Denied).message, /not reached from a shop/);
  assert.equal(opened.asked.length + direct.asked.length, 0, "no question was asked");
});

test("pay: the card is typed only on https, with a fresh snapshot, in an empty enabled field of the right kind, and in order", async () => {
  const deny = async (r: Rig, input: Record<string, unknown>, re: RegExp) => assert.match(((await step(r, "type", input)).res as Denied).message, re);
  const http = await rig();
  open(http, "http://shop.test/checkout");
  http.g.shape(`${B}snapshot`, {}, page("http://shop.test/checkout"));
  await deny(http, { target: "e4", text: "{{card:number}}" }, /only typed on https/);
  const stale = await rig();
  await toPsp(stale);
  stale.g.shape(`${B}click`, { target: "e8" }, "### Page\n- Page URL: https://checkout.stripe.com/c/pay/other\n### Result\nok");
  await deny(stale, { target: "e4", text: "{{card:number}}" }, /page changed since the last page view/);
  // a run that keeps being refused is stopped (six refusals), so each refusal gets a run of its own
  for (const [input, re] of [
    [{ target: "e5", text: "{{card:expiry}}" }, /Type the card number first/],
    [{ target: "e6", text: "{{card:cvc}}" }, /Type the card number first/],
    [{ target: "e4", text: "{{card:cvc}}" }, /not the card security code field/],
    [{ target: "e8", text: "{{card:number}}" }, /not a text field/],
    [{ target: "e4", text: "card {{card:number}}" }, /whole text/],
    [{ target: "e4", text: "{{card:number}}", submit: true }, /submit/],
    [{ target: "e4", text: "{{card:pin}}" }, /whole text/],
  ] as [Record<string, unknown>, RegExp][]) {
    const one = await rig();
    await toPsp(one);
    await deny(one, input, re);
    assert.equal(one.asked.length, 0);
  }
  // not empty, disabled, a split expiry
  const filled = await rig();
  await toPsp(filled, { values: { e4: "something" } });
  await deny(filled, { target: "e4", text: "{{card:number}}" }, /not empty/);
  const off = await rig();
  await toPsp(off);
  off.g.shape(`${B}snapshot`, {}, page(PSP).replace('textbox "Card number" [ref=e4]', 'textbox "Card number" [disabled] [ref=e4]'));
  await deny(off, { target: "e4", text: "{{card:number}}" }, /disabled or read-only/);
  const split = await rig();
  await toPsp(split, { names: { e5: "Expiry month" } });
  await typeNumber(split, PSP, { names: { e5: "Expiry month" } });
  await deny(split, { target: "e5", text: "{{card:expiry}}" }, /separate month and year/);
  // the security code only after the expiry; a field typed twice
  const order = await rig();
  await toPsp(order);
  await typeNumber(order);
  await deny(order, { target: "e6", text: "{{card:cvc}}" }, /expiry date before the security code/);
  await deny(order, { target: "e4", text: "{{card:number}}" }, /already typed|not empty/);
  // a card in fill_form is not typed
  const f = await order.g.decide(`${B}fill_form`, { fields: [{ target: "e5", name: "x", type: "textbox", value: "{{card:expiry}}" }] });
  assert.equal(f.kind, "deny");
});

// ---- the total, the cart, the caps ----

test("pay: no clear total, a price-only page, two different totals, another currency or a ticked save-the-card box: no question, nothing typed", async () => {
  const stops = async (o: PageOpts, re: RegExp) => {
    const r = await rig();
    await toPsp(r, o);
    const x = await typeNumber(r, PSP, o);
    assert.match((x.res as Denied).message, re);
    assert.equal(r.asked.length, 0);
    assert.equal(r.ledger.rows().length, 0);
  };
  await stops({ total: "45.00" }, /total to pay cannot be read/); // no currency
  await stops({ total: "(please wait)" }, /total to pay cannot be read/);
  await stops({ total: "CHF 45.00", extra: "- text: Total EUR 48.00" }, /more than one total/);
  await stops({ total: "EUR 45.00" }, /asks for EUR but the card is in CHF/);
  await stops({ save: true }, /box is ticked that saves the card/);
  const priceOnly = await rig();
  await toPsp(priceOnly);
  priceOnly.g.shape(`${B}snapshot`, {}, page(PSP).replace("Total CHF 45.00", "Price from CHF 45.00"));
  assert.match(((await typeNumber(priceOnly)).res as Denied).message, /total to pay cannot be read/);
  // no snapshot at all of this page: asked to take one
  const noSnap = await rig();
  await noSnap.g.decide(`${B}navigate`, { url: SHOP });
  noSnap.g.shape(`${B}navigate`, { url: SHOP }, page(SHOP));
  noSnap.g.shape(`${B}click`, { target: "e9" }, page(PSP));
  assert.match(((await typeNumber(noSnap)).res as Denied).message, /Take a browser_snapshot/);
});

test("caps: a payment above the cap for one payment, one that would pass the daily cap, and a cap of 0 are refused before any question", async () => {
  const over = await newAccess({ caps: { purchaseMinor: 4000, dayMinor: 100000 } });
  const r1 = await rig({ access: over.access });
  await toPsp(r1);
  assert.match(((await typeNumber(r1)).res as Denied).message, /cap for one payment/);
  const day = await newAccess({ caps: { purchaseMinor: 10000, dayMinor: 6000 } });
  day.ledger.add({ id: "bbbb0001", merchant: "other.test", totalMinor: 2000, currency: "CHF", last4: "4242", cartHash: "x", status: "confirmed" });
  const r2 = await rig({ access: day.access });
  await toPsp(r2);
  assert.match(((await typeNumber(r2)).res as Denied).message, /daily cap/);
  const ok = await newAccess({ caps: { purchaseMinor: 10000, dayMinor: 6500 } });
  ok.ledger.add({ id: "bbbb0002", merchant: "other.test", totalMinor: 2000, currency: "CHF", last4: "4242", cartHash: "x", status: "unconfirmed" });
  const r3 = await rig({ access: ok.access });
  await toPsp(r3);
  assert.equal((await typeNumber(r3)).res.behavior, "allow", "20 + 45 is within 65; an unconfirmed payment counted as spent");
  assert.equal(await openCardAccess({ store: await newStore(), kill: new KillSwitch(scratch(`card-test-${unique()}.disabled`)), caps: { purchaseMinor: 0, dayMinor: 5000 } }), undefined, "a cap of 0 gives the run no card");
  assert.equal(r1.asked.length + r2.asked.length, 0);
});

test("total mismatch: the total, the currency, the cart, the button's own amount or a ticked box changed after the yes abort the click; nothing is clicked", async () => {
  const mismatch = async (after: PageOpts, re: RegExp, label = "") => {
    const r = await rig();
    await toPsp(r);
    await typeNumber(r);
    await typeRest(r);
    r.g.shape(`${B}snapshot`, {}, page(PSP, { ...after, values: { e4: PAN_SPACED, e5: EXPIRY, e6: CVC } }));
    const c = await step(r, "click", { target: "e8" });
    assert.equal(c.res.behavior, "deny", label);
    assert.match((c.res as Denied).message, re, label);
    assert.match((c.res as Denied).message, /Nothing was clicked/);
    assert.equal(r.g.pay.attempted, false);
    assert.equal(r.ledger.rows()[0]!.status, "failed", "the approval is spent and marked failed");
    // the approval is void: another click, or the card typed again, finds nothing approved
    assert.equal(r.g.pay.approval, undefined);
    assert.equal((await step(r, "click", { target: "e8" })).res.behavior === "deny" || r.g.pay.active === false, true);
  };
  await mismatch({ total: "CHF 46.00", button: "Pay CHF 46.00" }, /the total is now CHF 46\.00, the owner approved CHF 45\.00/, "total");
  await mismatch({ total: "EUR 45.00", button: "Pay EUR 45.00" }, /the total is now EUR 45\.00/, "currency");
  await mismatch({ cart: "Ticket Zurich to Bern CHF 40.00 first class" }, /cart changed/, "cart");
  await mismatch({ button: "Pay CHF 9.00" }, /the button says CHF 9\.00/, "button");
  await mismatch({ save: true }, /box that saves the card/, "box");
  await mismatch({ total: "CHF 45.00", extra: "- text: Total CHF 450.00" }, /more than one total/, "two totals");
  // no snapshot since the last fill: asked to take one, nothing is voided yet
  const r = await rig();
  await toPsp(r);
  await typeNumber(r);
  await typeRest(r);
  const early = await step(r, "click", { target: "e8" });
  assert.match((early.res as Denied).message, /fresh browser_snapshot/);
  assert.ok(r.g.pay.approval, "still approved");
  r.g.shape(`${B}snapshot`, {}, page(PSP, { values: { e4: PAN_SPACED, e5: EXPIRY, e6: CVC } }));
  assert.equal((await step(r, "click", { target: "e8" })).res.behavior, "allow");
});

test("domain binding: another site or page after the yes voids the approval; a look-alike payment host is just another shop; the card never goes elsewhere", async () => {
  const r = await rig();
  await toPsp(r);
  await typeNumber(r);
  assert.ok(r.g.pay.approval);
  // the page goes to another shop: approval void, nothing more is typed
  r.g.shape(`${B}click`, { target: "e8" }, page("https://other.test/checkout"));
  assert.equal(r.g.pay.approval, undefined);
  r.g.shape(`${B}snapshot`, {}, page("https://other.test/checkout"));
  const again = await step(r, "type", { target: "e5", text: "{{card:expiry}}" });
  assert.match((again.res as Denied).message, /Type the card number first/);
  // a look-alike of the payment host is another shop: the question names it, never "stripe.com"
  const look = await rig();
  await look.g.decide(`${B}navigate`, { url: SHOP });
  look.g.shape(`${B}navigate`, { url: SHOP }, page(SHOP));
  const evil = "https://checkout.stripe.com.evil.test/pay";
  look.g.shape(`${B}click`, { target: "e9" }, page(evil));
  look.g.shape(`${B}snapshot`, {}, page(evil));
  const x = await typeNumber(look, evil);
  assert.equal(x.res.behavior, "allow");
  assert.match(look.asked[0]!.description, /Merchant: evil\.test/);
  assert.doesNotMatch(look.asked[0]!.description, /Merchant: stripe\.com|Card typed on: stripe\.com/);
  // the same approval does not carry to a different page of the same shop
  const moved = await rig();
  await toPsp(moved);
  await typeNumber(moved);
  moved.g.shape(`${B}snapshot`, {}, page("https://checkout.stripe.com/c/pay/cs_test_other"));
  assert.equal(moved.g.pay.approval, undefined, "a new page address: a new approval would be needed");
});

// ---- once ----

test("double click: two pay clicks at once click once; later clicks, retypes and other fields are locked; the same cart is refused in a new run", async () => {
  const r = await rig();
  await fullPay(r);
  const [c1, c2] = await Promise.all([r.canUse(`${B}click`, { target: "e8" }, opts), r.canUse(`${B}click`, { target: "e8" }, opts)]);
  const kinds = [c1, c2].map((x) => x!.behavior).sort();
  assert.deepEqual(kinds, ["allow", "deny"], "exactly one click gets through");
  assert.equal(r.ledger.rows().filter((x) => x.status === "clicked").length, 1);
  const third = await step(r, "click", { target: "e8" });
  assert.match((third.res as Denied).message, /already attempted/);
  assert.match(((await step(r, "type", { target: "e5", text: "{{card:expiry}}" })).res as Denied).message, /already attempted/);
  assert.match(((await step(r, "press_key", { key: "Enter" })).res as Denied).message, /already attempted/);
  assert.match(((await step(r, "fill_form", { fields: [{ target: "e4", name: "x", type: "textbox", value: "hello" }] })).res as Denied).message, /already attempted/);
  assert.equal((await step(r, "snapshot", {})).res.behavior, "allow", "reading the page is still fine");
  // a second run, the same cart: refused before any question, payment or typing
  const next = await rig({ access: r.access });
  await toPsp(next);
  const again = await typeNumber(next);
  assert.match((again.res as Denied).message, /looks already paid/);
  assert.equal(next.asked.length, 0);
  // and one payment per run even for another cart
  const second = await rig();
  await fullPay(second);
  await step(second, "click", { target: "e8" });
  second.g.shape(`${B}navigate`, { url: "https://shop.test/other" }, page("https://shop.test/other"));
  assert.match(((await step(second, "type", { target: "e4", text: "{{card:number}}" })).res as Denied).message, /already attempted/);
});

test("unconfirmed: a payment with no confirmation on the page is reported as unconfirmed, blocks a retry, and a crash leaves it unconfirmed too", async () => {
  const r = await rig();
  await fullPay(r);
  await step(r, "click", { target: "e8" });
  r.g.shape(`${B}wait_for`, {}, page(PSP).replace("Checkout", "Waiting for confirmation in your banking app"));
  const note = r.g.finishPayment()!;
  assert.match(note, /NOT confirmed on the page/);
  assert.match(note, /npm run card -- clear [0-9a-f]{8}/);
  assert.equal(r.ledger.rows()[0]!.status, "unconfirmed");
  assert.equal(r.g.finishPayment(), note, "once");
  assert.equal(r.ledger.rows().filter((x) => x.status === "unconfirmed").length, 1);
  const declined = await rig();
  await fullPay(declined);
  await step(declined, "click", { target: "e8" });
  declined.g.shape(`${B}snapshot`, {}, page(PSP).replace("Checkout", "Your card was declined. Payment failed"));
  assert.match(declined.g.finishPayment()!, /failed or was declined/);
  assert.equal(declined.ledger.rows()[0]!.status, "failed");
  // a click with no result at all (the process died)
  const crashed = await rig();
  await fullPay(crashed);
  await step(crashed, "click", { target: "e8" });
  assert.equal(crashed.ledger.rows()[0]!.status, "clicked");
  assert.equal(crashed.ledger.recover(), 1);
  assert.equal(crashed.ledger.rows()[0]!.status, "unconfirmed");
});

test("while a card is typed the keyboard cannot submit it, and nothing is typed with Enter", async () => {
  const r = await rig();
  await toPsp(r);
  await typeNumber(r);
  for (const key of ["Enter", "Space", "NumpadEnter"]) assert.match(((await step(r, "press_key", { key })).res as Denied).message, /pay button, not the keyboard/);
  assert.match(((await step(r, "type", { target: "e6", text: "123", submit: true })).res as Denied).message, /do not submit with Enter/);
  assert.equal((await step(r, "press_key", { key: "Tab" })).res.behavior, "allow");
});

// ---- the kill switch ----

test("kill switch: at the question, after the yes, and at the click; a run that starts with it on gets no card at all", async () => {
  const k1 = new KillSwitch(scratch(`card-test-${unique()}.disabled`));
  const a1 = await newAccess({ kill: k1 });
  const r1 = await rig({ access: a1.access });
  await toPsp(r1);
  k1.turnOff("chat");
  assert.match(((await typeNumber(r1)).res as Denied).message, /Card payments are switched off/);
  assert.equal(r1.asked.length, 0);
  // switched off while the owner was deciding
  const k2 = new KillSwitch(scratch(`card-test-${unique()}.disabled`));
  const a2 = await newAccess({ kill: k2 });
  const r2 = await rig({ access: a2.access });
  await toPsp(r2);
  const pending = r2.canUse(`${B}type`, { target: "e4", text: "{{card:number}}" }, opts);
  k2.turnOff("chat");
  const res = (await pending) as Denied;
  assert.equal(res.behavior, "deny");
  assert.match(res.message, /switched off/);
  assert.match(res.message, /Nothing was typed/);
  assert.equal(r2.g.pay.typed.size, 0);
  // switched off between the typing and the click
  const k3 = new KillSwitch(scratch(`card-test-${unique()}.disabled`));
  const a3 = await newAccess({ kill: k3 });
  const r3 = await rig({ access: a3.access });
  await fullPay(r3);
  k3.turnOff("terminal");
  const click = await step(r3, "click", { target: "e8" });
  assert.match((click.res as Denied).message, /Nothing was clicked: card payments are switched off/);
  assert.equal(r3.g.pay.attempted, false);
  // with it on at the start, the run has no card and says nothing of one
  const k4 = new KillSwitch(scratch(`card-test-${unique()}.disabled`));
  k4.turnOff("test");
  assert.equal(await openCardAccess({ store: await newStore(), kill: k4, ledger: new Ledger(scratchDb(`payments-test-${unique()}`)) }), undefined);
  k1.turnOn(); k2.turnOn(); k3.turnOn(); k4.turnOn();
});

// ---- groups, background, the worker's prompt ----

test("never offered in a group or a background run: no card in the guard, no card in the prompt, no payment in the tool text, and the owner-chat run is the only one that gets it", async () => {
  const READY = { ok: true as const, cli: "x", exe: "y" };
  const seen: Record<string, string | undefined> = {};
  const { access } = await newAccess();
  const ctx = (name: string, c: { mode: "owner" | "group"; key?: string }) => ({ ...c, run: async (_p: string, g: BrowseGuard) => ((seen[name] = g.cardInfo()?.last4), { text: "", structured: { status: "done", answer: "ok", sources: [] } }) });
  await browse(ctx("chat", { mode: "owner", key: OWNER_KEY }), "look up opening hours", { status: READY, card: access, profile: null });
  await browse(ctx("wake", { mode: "owner" }), "look up opening hours", { status: READY, card: access, profile: null });
  await browse(ctx("group", { mode: "group", key: "g1" }), "look up opening hours", { status: READY, card: access, profile: null });
  assert.equal(seen.chat, "4242");
  assert.equal(seen.wake, undefined, "a wake-up gets no card");
  assert.equal(seen.group, undefined, "a group gets no card");
  // a group's guard, handed a card anyway, ignores it and refuses the placeholder
  const g = await rig({ mode: "group" });
  await toPsp(g);
  assert.equal(g.g.cardInfo(), undefined);
  assert.match(((await typeNumber(g)).res as Denied).message, /No card is available/);
  assert.equal(g.asked.length, 0);
  // the prompt: no card, no placeholder; with a card, the steps and the last four only
  assert.ok(!/\{\{card:/.test(browseSystem("Alex", "off", [], undefined)));
  const prompt = browseSystem("Alex", "off", [], { last4: "4242", label: "Wise", currency: "CHF" });
  assert.match(prompt, /\{\{card:number\}\}/);
  assert.match(prompt, /Wise ••••4242/);
  assert.ok(![PAN, CVC, EXPIRY].some((v) => prompt.includes(v)));
  // the tool the chat model reads: payment is mentioned in the owner's chat only
  const { browseToolText } = await import("../src/modules/browse/browse.ts");
  assert.match(browseToolText({ mode: "owner", key: OWNER_KEY }), /saved payment card.*typed YES/);
  for (const c of [{ mode: "owner" as const }, { mode: "group" as const, key: "g1" }]) {
    assert.ok(!/payment card|YES/.test(browseToolText(c)), "a wake-up and a group are not told they can pay");
    assert.match(browseToolText(c), /never enters login details or card details/);
  }
});

// ---- nothing leaks ----

test("nothing leaks: no result, question, approval call, audit row, ledger row or final answer holds the number, the expiry or the security code", async () => {
  const r = await rig({ task: "buy the ticket" });
  const results: string[] = [];
  await toPsp(r);
  const n1 = await typeNumber(r);
  results.push(n1.shown ?? "");
  const { a, b } = await typeRest(r);
  results.push(a.shown ?? "", b.shown ?? "");
  // later page views the shop may echo the card in, in other spacings; a summary line; a Playwright error that echoes the value
  const grouped = PAN_SPACED;
  const dashed = "4242-4242-4242-4242";
  const view = page(PSP, { values: { e4: grouped, e5: EXPIRY, e6: CVC }, extra: `- text: Card ${dashed} ${PAN} expires 12 / 99 for Annabelle Fakename` });
  results.push(r.g.shape(`${B}snapshot`, {}, view) ?? "");
  results.push(r.g.shape(`${B}snapshot`, {}, view.replace(`[ref=e4]: ${grouped}`, `[ref=e4] [active]: ${grouped}`)) ?? "");
  const click = await step(r, "click", { target: "e8" }, () => `### Result\nClicked. The card ${PAN} was sent with ${EXPIRY}.\n${view}`);
  results.push(click.shown ?? "");
  for (const text of results) {
    for (const secret of [PAN, PAN_SPACED, dashed, EXPIRY, "12 / 99", "Annabelle Fakename"]) assert.ok(!text.includes(secret), `a result holds ${secret}`);
    assert.ok(!text.includes(CVC), "a result holds the security code");
    assert.ok(!/Ran Playwright code/.test(text), "the server's echo of the typed code is dropped");
  }
  assert.match(n1.shown!, /^Filled the card number from the saved card\./);
  assert.match(b.shown!, /\[ref=e6\]: \[filled\]/, "the security code is cut on its own field's line");
  // the question, the approval call
  for (const asked of r.asked) assert.ok(![PAN, EXPIRY, CVC, "Fakename"].some((v) => JSON.stringify(asked).includes(v)), "question or approval call");
  // the final answer from the worker: a repeated number is cut, then the code's note comes first
  const { sanitizeResult } = await import("../src/modules/browse/browse.ts");
  const said = sanitizeResult({ status: "done", answer: `Paid with ${PAN} exp ${EXPIRY} (${PAN_SPACED})`, sources: [] }, "", r.g);
  assert.ok(![PAN, PAN_SPACED, EXPIRY].some((v) => said.answer.includes(v)) && said.answer.includes("[card]"));
  assert.ok(!(r.g.finishPayment() ?? "").includes(PAN));
  // the audit log and the ledger
  const audit = readFileSync(dataPath(logPaths().audit), "utf8");
  for (const secret of [PAN, PAN_SPACED, "4242-4242", EXPIRY, `"${CVC}"`, `fill('${CVC}')`, "Fakename"]) assert.ok(!audit.includes(secret), `the audit log holds ${secret}`);
  assert.ok(!audit.match(/(^|[^\d])0731([^\d]|$)/m), "no security code in the audit log");
  const ledger = JSON.stringify(r.ledger.history());
  assert.ok(!ledger.includes(PAN) && !ledger.includes(CVC) && !ledger.includes(EXPIRY));
  // what the audit does say
  const rows = readAudit((e) => e.tool.startsWith("card_"));
  const kinds = rows.map((x) => `${x.tool}:${x.decision}`);
  for (const want of ["card_approval:asked", "card_approval:approved", "card_pay:clicked"]) assert.ok(kinds.includes(want), want);
  const ask = rows.find((x) => x.tool === "card_approval" && x.decision === "asked")!;
  assert.equal(ask.meta?.merchant, "shop.test");
  assert.equal(ask.meta?.last4, "4242");
  assert.equal(ask.meta?.total, "CHF 45.00");
  const steps = readAudit((e) => e.tool === "browse_step" && e.decision === "fill-card-run");
  assert.ok(steps.some((x) => x.meta?.cardKind === "number" && x.meta?.valueLength === 16));
});

// ---- frames ----

test("frames: a card goes into a payment frame only when the browser's frame list shows the shop, known payment providers and blank frames; else refused with a hand-over", async () => {
  const frames = (urls: string[], pageUrl = SHOP): FrameProbe => async () => [{ url: pageUrl }, ...urls.map((url) => ({ url }))];
  const framed = (ref: string) => `### Page\n- Page URL: ${SHOP}\n### Snapshot\n\`\`\`yaml\n- generic [ref=e1]:\n  - text: Total CHF 45.00\n  - iframe [ref=e2]:\n    - textbox "Card number" [ref=${ref}]\n    - textbox "Expiration date MM / YY" [ref=f1e5]\n    - textbox "Security code" [ref=f1e6]\n  - button "Pay CHF 45.00" [ref=e8]\n\`\`\``;
  const go = async (probe: FrameProbe | undefined) => {
    const r = await rig({ frames: probe });
    await r.g.decide(`${B}navigate`, { url: SHOP });
    r.g.shape(`${B}navigate`, { url: SHOP }, framed("f1e4"));
    r.g.shape(`${B}snapshot`, {}, framed("f1e4"));
    return { r, x: await step(r, "type", { target: "f1e4", text: "{{card:number}}" }, (ran) => `### Result\n${framed("f1e4").replace('"Card number" [ref=f1e4]', `"Card number" [ref=f1e4]: ${ran.text}`)}`) };
  };
  const ok = await go(frames(["https://js.stripe.com/v3/elements-inner-card.html", "https://js.stripe.com/v3/controller.html", "about:blank"]));
  assert.equal(ok.x.res.behavior, "allow");
  assert.equal(ok.x.ran?.text, PAN, "typed into the frame by ref");
  assert.match(ok.r.asked[0]!.description, /Card typed on: stripe\.com/);
  assert.match(ok.r.asked[0]!.description, /Merchant: shop\.test/);
  assert.ok(!ok.x.shown!.includes(PAN));
  const second = await step(ok.r, "type", { target: "f1e5", text: "{{card:expiry}}" }, () => framed("f1e4"));
  assert.equal(second.res.behavior, "allow", "the next frame field follows the approval");
  // another site's frame, even a hidden one, refuses; so does a frame list that cannot be read, or no probe at all
  const stranger = await go(frames(["https://js.stripe.com/v3/elements-inner-card.html", "https://ads.example.net/pixel"]));
  assert.match((stranger.x.res as Denied).message, /frame from example\.net/);
  assert.match((stranger.x.res as Denied).message, /needs_owner/);
  const broken = await go(async () => "the browser could not be reached");
  assert.match((broken.x.res as Denied).message, /cannot be checked/);
  const none = await go(undefined);
  assert.match((none.x.res as Denied).message, /cannot be listed/);
  const wrongPage = await go(frames(["https://js.stripe.com/x"], "https://shop.test/elsewhere"));
  assert.match((wrongPage.x.res as Denied).message, /not of this page/);
  const noPsp = await go(frames(["about:blank"]));
  assert.match((noPsp.x.res as Denied).message, /no frame from a known payment provider/);
  for (const bad of [stranger, broken, none, wrongPage, noPsp]) assert.equal(bad.r.asked.length, 0, "no question for a frame that cannot be checked");
  // a frame list that changed after the yes (a stranger's frame appeared) voids the click
  let evil = false;
  const live: FrameProbe = async () => [{ url: SHOP }, { url: "https://js.stripe.com/v3/a.html" }, ...(evil ? [{ url: "https://evil.example/f" }] : [])];
  const r = await rig({ frames: live });
  await r.g.decide(`${B}navigate`, { url: SHOP });
  r.g.shape(`${B}navigate`, { url: SHOP }, framed("f1e4"));
  r.g.shape(`${B}snapshot`, {}, framed("f1e4"));
  for (const [ref, text] of [["f1e4", "{{card:number}}"], ["f1e5", "{{card:expiry}}"], ["f1e6", "{{card:cvc}}"]]) await step(r, "type", { target: ref, text }, () => framed("f1e4"));
  r.g.shape(`${B}snapshot`, {}, framed("f1e4"));
  evil = true;
  assert.match(((await step(r, "click", { target: "e8" })).res as Denied).message, /Nothing was clicked: .*frame from evil\.example/);
});

test("the real asking path: the audited ask holds the placeholder and the code-written details, the approval call is the placeholder, and a model-written question must carry the facts", async () => {
  const { access } = await newAccess();
  const g = new BrowseGuard({ mode: "owner", task: "buy the ticket", outDir: join(tmpdir(), "nope"), resolver: publicDns, card: access });
  let typedYes: boolean | undefined;
  const approve = makeApprove(async () => 1, {
    scope: "owner", source: "chat", mayPay: true,
    request: (async (_send: unknown, _d: unknown, _call: unknown, _abort: unknown, o: { typedYes?: boolean; question?: string }) => ((typedYes = o.typedYes), { approved: true })) as never,
    compose: async (q) => ({ text: `Pay shop.test? ${q.details.includes("Card payment approval") ? "ok" : ""}`, ms: 1, by: "model" as const }),
  });
  const judge = async (): Promise<Verdict> => ({ decision: "auto", reason: "test" });
  const canUse = makeCanUseTool(approve, BROWSE_RUN, undefined, judge, g, undefined, false, { provenance: standing("buy") });
  const r = { g, canUse } as unknown as Rig;
  await toPsp(r);
  const res = (await canUse(`${B}type`, { target: "e4", text: "{{card:number}}" }, opts)) as Allowed;
  assert.equal(res.behavior, "allow");
  assert.equal(res.updatedInput.text, PAN);
  assert.equal(typedYes, true, "request() is told the question needs a typed yes");
  const asked = readAudit((e) => e.tool === `${B}type` && e.decision === "approval-asked").at(-1)!;
  assert.deepEqual(asked.meta?.args, { target: "e4", text: "{{card:number}}" });
  assert.match(String(asked.meta?.details), /Merchant: shop\.test/);
  assert.match(String(asked.meta?.details), /Total \(read from the page by code, not checked by the shop\): CHF 45\.00/);
  assert.ok(![PAN, EXPIRY, CVC].some((v) => JSON.stringify(asked).includes(v)));
  const outcome = readAudit((e) => e.tool === `${B}type` && e.decision === "approval-outcome").at(-1)!;
  assert.equal(outcome.meta?.argsEqual, true);
});

// ---- a payment in progress: nothing around the pay button ----

test("while a payment is open every other click, a dialog accept and a choice are refused; only a text field may be clicked into and the pay button goes to payClick", async () => {
  const r = await rig();
  await toPsp(r);
  await typeNumber(r);
  // approved, number typed: a link, the save-card checkbox and a point click are not free reads any more
  assert.match(((await step(r, "click", { target: "e9" })).res as Denied).message, /fresh browser_snapshot/, "a pay-like link is held to the pay-click checks");
  assert.match(((await step(r, "click", { target: "e7" })).res as Denied).message, /only click allowed is the page's pay button/);
  assert.match(((await step(r, "select_option", { target: "e5", values: ["12"] })).res as Denied).message, /choose nothing now/);
  assert.match(((await step(r, "handle_dialog", { accept: true })).res as Denied).message, /do not accept a dialog/);
  assert.equal((await step(r, "handle_dialog", { accept: false })).res.behavior, "allow", "dismissing a dialog is harmless");
  assert.equal((await step(r, "click", { target: "e5" })).res.behavior, "allow", "clicking into the next text field to type the card detail");
  await typeRest(r);
  r.g.shape(`${B}snapshot`, {}, page(PSP, { values: { e4: PAN_SPACED, e5: EXPIRY, e6: CVC } }));
  assert.equal((await step(r, "click", { target: "e8" })).res.behavior, "allow", "the pay button is still clicked, through the payment checks");
});

test("with no payment open clicks are as before; once the number is approved the same click is refused", async () => {
  const r = await rig();
  await toPsp(r);
  assert.equal((await step(r, "click", { target: "e7" })).res.behavior, "allow", "no payment open: an ordinary click");
  await typeNumber(r);
  assert.ok(r.g.pay.approval);
  assert.match(((await step(r, "click", { target: "e7" })).res as Denied).message, /payment is in progress/);
});

test("an approval dropped after card digits were typed marks the ledger row unconfirmed and the owner is told in the result", async () => {
  const r = await rig();
  await toPsp(r);
  const num = await typeNumber(r);
  assert.equal(num.res.behavior, "allow");
  const id = r.g.pay.approval!.id;
  const row = () => r.ledger.rows().find((x) => x.id === id);
  assert.equal(row()?.status, "approved");
  assert.ok(r.g.pay.typed.size > 0, "digits are in the page");
  r.g.shape(`${B}click`, { target: "e9" }, page("https://other.test/checkout")); // the page moved on
  assert.equal(r.g.pay.approval, undefined);
  assert.equal(row()?.status, "unconfirmed");
  assert.ok(r.ledger.duplicate("shop.test", row()!.cartHash), "it counts for the duplicate check and the caps");
  assert.match(r.g.finishPayment() ?? "", /card details were typed, then the payment was dropped.*npm run card -- clear/s);
  // no digits typed: nothing to report, the row stays as it was
  const q = await rig();
  await toPsp(q);
  await typeNumber(q);
  q.g.pay.typed.clear();
  q.g.shape(`${B}click`, { target: "e9" }, page("https://other.test/checkout"));
  assert.equal(q.ledger.rows().find((x) => x.status === "unconfirmed"), undefined);
  assert.equal(q.g.finishPayment(), undefined);
});
