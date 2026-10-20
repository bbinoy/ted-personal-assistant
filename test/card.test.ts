import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cardCommand, CardStore, KillSwitch, openCardAccess, parseExpiry, type CardRecord } from "../src/modules/browse/card.ts";
import { cardCli } from "../src/modules/browse/cardcli.ts";
import { capProblem, Ledger } from "../src/modules/browse/payments.ts";
import { approvalId, cartHash, cartLines, findPayableTotal, frameVerdict, isTypedYes, kindOfFieldName, expirySplit, parseAmount, parseMoney, paymentOutcome, riskyBoxes } from "../src/modules/browse/paymentrules.ts";
import { ProfileStore, type Entries } from "../src/modules/browse/profile.ts";
import { TenantSecrets } from "../src/secrets.ts";
import { fakeCardStore, startFakeBao } from "./fakebao.ts";

// Obviously fake values only: the public test card number of the card networks (a Luhn-valid number that belongs to nobody), a made-up security code,
// a local fake checkout. No test touches the real OpenBao or Keychain (the store talks to an in-process fake, fakebao.ts) or a real merchant.
const PAN = "4242424242424242";
const PAN_SPACED = "4242 4242 4242 4242";
const CVC = "737";
const CARD: CardRecord = { pan: PAN, expMonth: 12, expYear: 2099, cvc: CVC, label: "Wise", last4: "4242", currency: "CHF" };
const ENTRIES: Entries = { email: { value: "annabelle.fake@example.com", kind: "email", domains: [] } };

// ---- the card entry command ----

const cli = async (argv: string[], inputs: string[], o: { store?: CardStore; kill?: KillSwitch; ledger?: Ledger } = {}) => {
  const lines: string[] = [];
  const asked: string[] = [];
  const queue = [...inputs];
  const store = o.store ?? (await fakeCardStore());
  const code = await cardCli(argv, {
    store,
    kill: o.kill ?? new KillSwitch("state/card-test-cli.disabled"),
    ledger: o.ledger ?? new Ledger("state/payments-test-cli.jsonl"),
    readHidden: async (p) => (asked.push(p), queue.shift() ?? ""),
    out: (l) => lines.push(l),
    now: new Date("2026-10-17T10:00:00Z"),
  });
  return { code, lines, asked, store, out: lines.join("\n") };
};

test("card entry: set asks at hidden prompts, saves the card in OpenBao, and prints nothing beyond the last four digits", async () => {
  const r = await cli(["set", "--currency", "chf", "--label", "Wise"], [PAN_SPACED, "12/99", CVC, "A Fake"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.asked.map((p) => /hidden/.test(p)), [true, true, true, true], "every prompt is hidden");
  assert.match(r.out, /Saved Wise ••••4242 \(CHF/);
  for (const secret of [PAN, PAN_SPACED, CVC, "12/99", "A Fake"]) assert.ok(!r.out.includes(secret), `output must not hold ${secret}`);
  const card = await r.store.load();
  assert.equal(card?.pan, PAN);
  assert.equal(card?.cvc, CVC);
  assert.equal(card?.currency, "CHF");
  const listed = await cli(["list"], [], { store: r.store });
  assert.match(listed.out, /Wise ••••4242 {2}CHF {2}expires 12\/99/);
  assert.ok(![PAN, CVC].some((s) => listed.out.includes(s)));
});

test("card entry: a bad number, an expired card, a bad security code and a bad expiry save nothing; a value is never an argument", async () => {
  const bad = async (inputs: string[], re: RegExp) => {
    const r = await cli(["set"], inputs);
    assert.equal(r.code, 1, inputs.join("|"));
    assert.match(r.out, re);
    assert.equal(await r.store.load(), undefined);
    assert.ok(![PAN, CVC].some((s) => r.out.includes(s)));
  };
  await bad(["4242424242424243", "12/99", CVC, ""], /not a valid card number/);
  await bad(["not a number", "12/99", CVC, ""], /digits only/);
  await bad([PAN, "12/20", CVC, ""], /expired/);
  await bad([PAN, "soon", CVC, ""], /month and year/);
  await bad([PAN, "12/99", "12", ""], /3 or 4 digits/);
  assert.equal((await cli(["nonsense"], [])).code, 1);
  assert.equal(parseExpiry("1/9")?.expYear, undefined);
  assert.deepEqual(parseExpiry("12 / 2031"), { expMonth: 12, expYear: 2031 });
});

test("card entry: it needs a terminal (a piped value is refused by the prompt) and a store it cannot open is an error", async () => {
  const { readHiddenFromTerminal } = await import("../src/modules/browse/profilecli.ts");
  await assert.rejects(readHiddenFromTerminal("x"), /needs a terminal/);
  const store = await fakeCardStore(CARD);
  store.fake.mode.sealed = true;
  const r = await cli(["list"], [], { store });
  assert.equal(r.code, 1, "a sealed store is an error, not an empty list");
  assert.match(r.out, /sealed/);
  assert.ok(!r.out.includes(PAN) && !r.out.includes(CVC));
});

// ---- the store ----

test("store: the card is its own item at tenants/owner/card/primary; the profile readers never return it; nothing about it travels in a URL", async () => {
  const fake = await startFakeBao();
  const profile = new ProfileStore(fake.secrets());
  await profile.set("email", ENTRIES.email!);
  const store = new CardStore(fake.secrets());
  await store.save(CARD);
  assert.deepEqual([...fake.store.keys()].sort(), ["tenants/owner/card/primary", "tenants/owner/profile/email"]);
  assert.deepEqual(Object.keys(await profile.read()), ["email"], "the profile sees its own entries only");
  assert.ok(!JSON.stringify(await profile.read()).includes(PAN));
  assert.equal((await store.load())?.pan, PAN);
  assert.ok(fake.requests.every((r) => ![PAN, CVC].some((v) => r.path.includes(v))));
  // saving a profile key keeps the card; deleting the card keeps the profile
  await profile.set("phone", { value: "0790000000", kind: "phone", domains: [] });
  assert.equal((await store.load())?.cvc, CVC);
  assert.equal(await store.remove(), true);
  assert.equal(await store.remove(), false);
  assert.equal(await store.load(), undefined);
  assert.deepEqual(Object.keys(await profile.read()).sort(), ["email", "phone"]);
  // what a run may know: the last four, the label and the currency
  await store.save(CARD);
  assert.deepEqual(await store.peek(), { last4: "4242", label: "Wise", currency: "CHF" });
  await fake.close();
});

test("store: the card is never served from the client's cache (every payment reads it fresh); a damaged item is no card", async () => {
  const fake = await startFakeBao();
  const store = new CardStore(fake.secrets("owner", { cacheMs: 60_000 }));
  await store.save(CARD);
  await store.load();
  const n = fake.requests.length;
  await store.load();
  assert.equal(fake.requests.length, n + 1, "a second load asked OpenBao again");
  fake.store.set("tenants/owner/card/primary", { ...CARD, pan: "4242424242424243" }); // fails the Luhn check
  assert.equal(await store.load(), undefined);
  fake.store.set("tenants/owner/card/primary", { pan: PAN });
  assert.equal(await store.load(), undefined);
  await fake.close();
});

test("a friend's card is refused in code: no card item for any tenant but the owner, however it is asked for", async () => {
  const fake = await startFakeBao();
  const friend = fake.secrets("friend");
  // the tenant layer
  await assert.rejects(friend.put("card", "primary", { ...CARD }), /never stored/);
  await assert.rejects(friend.get("card", "primary"), /never stored/);
  await assert.rejects(friend.names("card"), /never stored/);
  await assert.rejects(friend.remove("card", "primary"), /never stored/);
  assert.throws(() => new CardStore(friend), /never stored/);
  // a made-up tenant name that merely looks like the owner
  for (const t of ["owner2", "owner-x", "friend", "admin"]) await assert.rejects(fake.secrets(t).put("card", "primary", { ...CARD }), /never stored/, t);
  // and the card store of the owner writes into the owner's folder only
  await new CardStore(fake.secrets("owner")).save(CARD);
  assert.deepEqual([...fake.store.keys()], ["tenants/owner/card/primary"]);
  // nothing reached OpenBao for the refused tenants (the refusal is before the request)
  assert.ok(fake.requests.filter((r) => /friend|owner2|owner-x|admin/.test(r.path)).length === 0);
  void TenantSecrets;
  await fake.close();
});

// ---- the kill switch ----

test("kill switch: /card off from the owner's chat switches card use off, the chat cannot switch it on, the terminal can", async () => {
  const kill = new KillSwitch("state/card-test-kill.disabled");
  kill.turnOn();
  assert.equal(kill.off(), undefined);
  assert.equal(cardCommand("hello", kill), undefined, "an ordinary message is not a command");
  assert.equal(cardCommand("please turn the card off", kill), undefined);
  assert.match(cardCommand("/card status", kill)!, /are on/);
  assert.match(cardCommand("/card off", kill)!, /off/);
  assert.match(kill.off()!, /from the chat/);
  assert.match(cardCommand("/card on", kill)!, /only possible at the terminal/);
  assert.ok(kill.off(), "still off after /card on");
  assert.match(cardCommand("/card enable", kill)!, /only possible at the terminal/);
  assert.ok(kill.off());
  // an open access is not given while it is off, even if the card is fine
  const store = await fakeCardStore(CARD);
  assert.equal(await openCardAccess({ store, kill, ledger: new Ledger("state/payments-test-kill.jsonl") }), undefined);
  const r = await cli(["enable"], [], { kill });
  assert.match(r.out, /on again/);
  assert.equal(kill.off(), undefined);
  assert.ok(await openCardAccess({ store, kill, ledger: new Ledger("state/payments-test-kill.jsonl") }));
  assert.equal((await cli(["disable"], [], { kill })).code, 0);
  assert.match(kill.off()!, /at the terminal/);
  kill.turnOn();
});

test("kill switch: it works with no card at all, and a store that cannot be opened is no access", async () => {
  const kill = new KillSwitch("state/card-test-kill2.disabled");
  kill.turnOff("test");
  assert.ok(kill.off());
  kill.turnOn();
  const problems: string[] = [];
  const sealed = await fakeCardStore(CARD);
  sealed.fake.mode.sealed = true;
  assert.equal(await openCardAccess({ store: sealed, kill, onProblem: (r) => problems.push(r) }), undefined);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /sealed/);
  assert.equal(await openCardAccess({ store: await fakeCardStore(), kill }), undefined, "no card item: no card");
});

// ---- the ledger and the caps ----

test("ledger: rows hold no card data; a clicked payment counts as spent; a duplicate cart is refused; a crash becomes unconfirmed; clear releases it", () => {
  const ledger = new Ledger("state/payments-test-ledger.jsonl");
  const now = new Date("2026-10-17T10:00:00Z");
  const base = { merchant: "shop.test", totalMinor: 4500, currency: "CHF", last4: "4242", cartHash: "h1" };
  ledger.add({ ...base, id: "aaaa0001", status: "approved" }, now);
  assert.equal(ledger.spentToday("CHF", now), 0, "an approval alone spends nothing");
  assert.equal(ledger.duplicate("shop.test", "h1", now), undefined);
  ledger.setStatus("aaaa0001", "clicked", now);
  assert.equal(ledger.spentToday("CHF", now), 4500);
  assert.equal(ledger.spentToday("EUR", now), 0, "per currency");
  assert.equal(ledger.duplicate("shop.test", "h1", now)?.id, "aaaa0001");
  assert.equal(ledger.duplicate("shop.test", "h2", now), undefined, "another cart is another payment");
  assert.equal(ledger.duplicate("other.test", "h1", now), undefined);
  assert.equal(ledger.duplicate("shop.test", "h1", new Date("2026-10-18T11:00:00Z")), undefined, "after a day it can be asked again");
  assert.equal(ledger.recover(now), 1, "a clicked payment with no result is unconfirmed");
  assert.equal(ledger.rows().find((r) => r.id === "aaaa0001")?.status, "unconfirmed");
  assert.equal(ledger.spentToday("CHF", now), 4500, "unconfirmed still counts");
  assert.ok(ledger.duplicate("shop.test", "h1", now), "and blocks a retry");
  ledger.setStatus("aaaa0001", "cleared", now);
  assert.equal(ledger.spentToday("CHF", now), 0);
  assert.equal(ledger.duplicate("shop.test", "h1", now), undefined);
  const file = readFileSync(join(process.env.HARNESS_DATA_DIR!, "state/payments-test-ledger.jsonl"), "utf8");
  assert.ok(!file.includes(PAN) && !/pan|cvc/i.test(file));
  assert.equal(statSync(join(process.env.HARNESS_DATA_DIR!, "state/payments-test-ledger.jsonl")).mode & 0o777, 0o600);
});

test("caps: per payment and per day, in minor units; 0 switches payments off", () => {
  const caps = { purchaseMinor: 2500, dayMinor: 5000 };
  assert.equal(capProblem(2500, caps, 0), undefined);
  assert.match(capProblem(2501, caps, 0)!, /cap for one payment/);
  assert.equal(capProblem(2500, caps, 2500), undefined);
  assert.match(capProblem(2500, caps, 2501)!, /daily cap/);
  assert.match(capProblem(100, { purchaseMinor: 0, dayMinor: 5000 }, 0)!, /switched off/);
  assert.match(capProblem(100, { purchaseMinor: 2500, dayMinor: 0 }, 0)!, /switched off/);
});

// ---- the rules ----

test("money: amounts as pages write them, with an explicit currency; subtotals, ambiguity and a missing currency are not a total", () => {
  assert.equal(parseAmount("45.00"), 4500);
  assert.equal(parseAmount("45,00"), 4500);
  assert.equal(parseAmount("1'245.50"), 124550);
  assert.equal(parseAmount("1’245.50"), 124550);
  assert.equal(parseAmount("1.245,50"), 124550);
  assert.equal(parseAmount("1,245.50"), 124550);
  assert.equal(parseAmount("1,245"), 124500);
  assert.equal(parseAmount("45.5"), 4550);
  assert.equal(parseAmount("1,234.567"), undefined);
  assert.deepEqual(parseMoney("Total CHF 45.00"), { minor: 4500, currency: "CHF" });
  assert.deepEqual(parseMoney("Zu zahlen: 1’245.50 €"), { minor: 124550, currency: "EUR" });
  assert.deepEqual(parseMoney("Fr. 12.90"), { minor: 1290, currency: "CHF" });
  assert.deepEqual(parseMoney("$9.99"), { minor: 999, currency: "USD" });
  assert.equal(parseMoney("Total 45.00"), undefined);
  const view = (...lines: string[]) => lines.map((l) => `- text: ${l}`).join("\n");
  assert.deepEqual((findPayableTotal(view("Subtotal CHF 40.00", "Shipping CHF 5.00", "Total CHF 45.00")) as { money: unknown }).money, { minor: 4500, currency: "CHF" });
  assert.ok("money" in findPayableTotal(view("Total CHF 45.00", "Amount due: CHF 45.00")), "the same figure twice is fine");
  assert.match((findPayableTotal(view("Total CHF 45.00", "Total EUR 48.00")) as { problem: string }).problem, /more than one total/);
  assert.match((findPayableTotal(view("Price from 12.90 CHF")) as { problem: string }).problem, /no total/, "a price line is not a total");
  assert.match((findPayableTotal(view("Total 45.00")) as { problem: string }).problem, /no total/, "no currency, no total");
  assert.ok("money" in findPayableTotal(view("Total VAT CHF 3.20", "Total CHF 45.00")), "a tax total line is skipped");
});

test("cart: the lines with an amount, normalised; the hash changes with the merchant, the total and any line", () => {
  const v = (extra = "") => `- heading "Order"\n- listitem [ref=e3]: Ticket Zurich to Bern CHF 40.00\n${extra}- text: Total CHF 45.00\n- button "Pay CHF 45.00" [ref=e9]`;
  const lines = cartLines(v());
  assert.deepEqual(lines, ["Ticket Zurich to Bern CHF 40.00", "Total CHF 45.00", "Pay CHF 45.00"]);
  const m = { minor: 4500, currency: "CHF" };
  const h = cartHash("shop.test", m, lines);
  assert.equal(cartHash("shop.test", m, cartLines(v())), h, "stable");
  assert.notEqual(cartHash("other.test", m, lines), h);
  assert.notEqual(cartHash("shop.test", { ...m, minor: 4501 }, lines), h);
  assert.notEqual(cartHash("shop.test", m, cartLines(v("- listitem: Seat reservation CHF 5.00\n"))), h, "an added line");
  assert.match(approvalId([h, "x"]), /^[0-9a-f]{8}$/);
  assert.deepEqual(riskyBoxes([{ role: "checkbox", name: "Save my card for next time", checked: true }, { role: "checkbox", name: "Save my card", checked: false }, { role: "checkbox", name: "I agree", checked: true }]), ["Save my card for next time"]);
});

test("fields: a card field is told by its name, in this order; a split expiry is recognised", () => {
  assert.equal(kindOfFieldName("Card number"), "number");
  assert.equal(kindOfFieldName("Expiration date MM / YY"), "expiry");
  assert.equal(kindOfFieldName("Security code"), "cvc");
  assert.equal(kindOfFieldName("Card security code"), "cvc");
  assert.equal(kindOfFieldName("Name on card"), "holder");
  assert.equal(kindOfFieldName("Kartennummer"), "number");
  assert.equal(kindOfFieldName("E-mail"), undefined);
  assert.ok(expirySplit("Expiry month") && expirySplit("Ablaufjahr") && !expirySplit("Expiry date MM / YY"));
});

test("frames: only blank, the shop's own, known payment and quiet Google frames; any other site's frame, plain http or no payment frame refuses", () => {
  const top = "https://shop.test/checkout";
  const f = (...urls: string[]) => [{ url: top }, ...urls.map((url) => ({ url }))];
  assert.deepEqual(frameVerdict(f("https://js.stripe.com/v3/elements-inner.html", "https://js.stripe.com/v3/controller.html", "about:blank", "https://www.googletagmanager.com/ns.html"), top, "shop.test"), { psp: ["stripe.com"] });
  assert.deepEqual(frameVerdict(f("https://pay.shop.test/x", "https://pay.datatrans.com/f"), top, "shop.test"), { psp: ["datatrans.com"] });
  assert.match(frameVerdict(f("https://js.stripe.com/a", "https://ads.example.net/b"), top, "shop.test") as string, /frame from example\.net/);
  assert.match(frameVerdict(f("https://stripe.com.evil.example/a"), top, "shop.test") as string, /frame from evil\.example/, "a look-alike is another site");
  assert.match(frameVerdict(f("http://js.stripe.com/a"), top, "shop.test") as string, /not https/);
  assert.match(frameVerdict(f("about:blank"), top, "shop.test") as string, /no frame from a known payment provider/);
  assert.match(frameVerdict(f("https://js.stripe.com/a"), "https://shop.test/other", "shop.test") as string, /not of this page/);
  assert.match(frameVerdict([], top, "shop.test") as string, /not of this page/);
  assert.match(frameVerdict(f("chrome-error://chromewebdata/"), top, "shop.test") as string, /cannot be read|not https/);
});

test("the typed yes: the word yes (ja, oui), alone or with one plain word; not an emoji, ok, sure, a question or a sentence", () => {
  for (const yes of ["yes", "YES", "Yes!", "yes please", "Yes, pay", "yes go ahead", "ja", "Ja bitte", "oui", "yes I approve"]) assert.ok(isTypedYes(yes), yes);
  for (const no of ["👍", "✅", "ok", "okay", "sure", "y", "yep", "go ahead", "approve", "yes?", "yes but only CHF 20", "yes if it is cheaper", "no", "yes and also book the hotel", "yesterday", "", "I guess yes"]) assert.ok(!isTypedYes(no), no);
});

test("what the page says after the click: a confirmation, a decline, or nothing certain", () => {
  assert.equal(paymentOutcome("- heading \"Thank you for your order\""), "confirmed");
  assert.equal(paymentOutcome("Payment successful"), "confirmed");
  assert.equal(paymentOutcome("Your card was declined. Payment failed"), "failed");
  assert.equal(paymentOutcome("Waiting for confirmation in your banking app"), undefined);
});
