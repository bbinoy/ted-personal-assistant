// The fake web of the end-to-end eval: a browser server under the real name (`browser`, tools browser_navigate, browser_snapshot, browser_click, browser_type, ...) that serves a few made-up pages in the
// shape @playwright/mcp prints them, so the REAL browse worker, the REAL browse guard (browseguard.ts: commit steps, the card flow, the typed YES) and the REAL ledger run against it. The "pay" button of a fake
// checkout is the fake pay endpoint: money can only move through it, and it is recorded with what was typed. No network, no real shop, no real card (the card is the public test number).
import { z } from "zod";
import { fakeService, type FakeService, type Recorder } from "./fakeserver.ts";

const BROWSER_SERVER = "browser";

// A page: its address, a heading, static text lines, and the things on it. Each thing gets a ref (e1, e2, ...) in order of appearance.
export interface FakePage {
  url: string;
  heading: string;
  text?: string[];
  links?: { name: string; to: string }[];
  fields?: { name: string }[]; // text boxes, in order
  gate?: { code: string; to: string }; // a login page for a shared access code: typing the code with Enter opens `to`
  buttons?: { name: string; to?: string; pay?: boolean; submit?: boolean }[]; // `pay`: the payment is made by this click (the fake pay endpoint); `submit`: a form is sent by this click (a sign-up), recorded with what was typed
}

export interface FakeCard {
  pan: string;
  expiry: string; // 12/99
  cvc: string;
}

export interface Payment {
  page: string;
  button: string;
  amountText: string; // the amount on the button as the page shows it
  cardOk: boolean; // the real test card was typed completely (so money would have moved)
}

export class FakeBrowser {
  readonly service: FakeService;
  readonly payments: Payment[] = [];
  readonly payClicks: string[] = []; // every click on a pay button, whatever was typed
  readonly submissions: { page: string; button: string; values: Record<string, string> }[] = [];
  private current: FakePage | undefined;
  private values = new Map<string, string>(); // ref -> typed value
  private readonly pages: Record<string, FakePage>;
  private readonly card: FakeCard | undefined;

  constructor(rec: Recorder, pages: Record<string, FakePage>, card?: FakeCard) {
    this.pages = pages;
    this.card = card;
    const open = (url: string) => {
      const base = url.split("#")[0]!;
      const page = this.pages[base];
      if (!page) return void (this.current = undefined);
      this.current = page;
      this.values.clear();
    };
    const refs = (p: FakePage): { ref: string; kind: "link" | "field" | "button"; index: number }[] => {
      let n = 2; // e1 is the page, e2 the heading
      return [
        ...(p.links ?? []).map((_, index) => ({ ref: `e${++n}`, kind: "link" as const, index })),
        ...(p.fields ?? []).map((_, index) => ({ ref: `e${++n}`, kind: "field" as const, index })),
        ...(p.buttons ?? []).map((_, index) => ({ ref: `e${++n}`, kind: "button" as const, index })),
      ];
    };
    const view = (): string => {
      const p = this.current;
      if (!p) return "### Page\n- Page URL: about:blank\n### Snapshot\n```yaml\n- generic [ref=e1]: This page could not be loaded\n```";
      const lines = [`- generic [ref=e1]:`, `  - heading "${p.heading}" [ref=e2]`, ...(p.text ?? []).map((t) => `  - text: ${t}`)];
      for (const r of refs(p)) {
        if (r.kind === "link") lines.push(`  - link "${p.links![r.index]!.name}" [ref=${r.ref}]:`, `    - /url: ${p.links![r.index]!.to}`);
        else if (r.kind === "field") lines.push(`  - textbox "${p.fields![r.index]!.name}" [ref=${r.ref}]${this.values.has(r.ref) ? `: ${this.values.get(r.ref)}` : ""}`);
        else lines.push(`  - button "${p.buttons![r.index]!.name}" [ref=${r.ref}]`);
      }
      return `### Page\n- Page URL: ${p.url}\n### Snapshot\n\`\`\`yaml\n${lines.join("\n")}\n\`\`\``;
    };
    const target = (a: Record<string, any>): string => String(a.target);
    const digits = (s: string) => s.replace(/\D/g, "");
    const shape = { target: z.string(), element: z.string().optional() }; // as @playwright/mcp prints them: `target` is required, there is no `ref`

    this.service = fakeService(BROWSER_SERVER, rec, {
      browser_navigate: { description: "Open a page by its address.", shape: { url: z.string() }, run: (a) => (open(a.url), view()) },
      browser_snapshot: { description: "A snapshot of the current page.", shape: {}, run: () => view() },
      browser_wait_for: { description: "Wait for a moment or for text to appear; returns the page.", shape: { time: z.number().optional(), text: z.string().optional() }, run: () => view() },
      browser_navigate_back: { description: "Go back (the fake web has no history: the same page).", shape: {}, run: () => view() },
      browser_click: {
        description: "Click an element of the page by its ref.",
        shape,
        run: (a) => {
          const p = this.current;
          const hit = p && refs(p).find((r) => r.ref === target(a));
          if (!p || !hit) throw new Error(`Ref ${target(a)} not found in the current page snapshot. Try capturing new snapshot.`);
          if (hit.kind === "link") open(p.links![hit.index]!.to);
          else if (hit.kind === "button") {
            const b = p.buttons![hit.index]!;
            if (b.pay) {
              this.payClicks.push(p.url);
              const typed = (name: string) => (p.fields ?? []).flatMap((f, i) => (f.name === name ? [this.values.get(refs(p).find((r) => r.kind === "field" && r.index === i)!.ref) ?? ""] : []))[0] ?? "";
              const cardOk = !!this.card && digits(typed("Card number")) === this.card.pan && typed("Expiration date MM / YY") === this.card.expiry && typed("Security code") === this.card.cvc;
              this.payments.push({ page: p.url, button: b.name, amountText: b.name, cardOk });
            }
            if (b.submit) this.submissions.push({ page: p.url, button: b.name, values: Object.fromEntries((p.fields ?? []).map((f, i) => [f.name, this.values.get(refs(p).find((r) => r.kind === "field" && r.index === i)!.ref) ?? ""])) });
            if (b.to) open(b.to);
          }
          return view();
        },
      },
      browser_type: {
        description: "Type text into a text box by its ref.",
        shape: { ...shape, text: z.string(), submit: z.boolean().optional(), slowly: z.boolean().optional() },
        run: (a) => {
          const p = this.current;
          const hit = p && refs(p).find((r) => r.ref === target(a) && r.kind === "field");
          if (!p || !hit) throw new Error(`Ref ${target(a)} is not a text box in the current page snapshot.`);
          const name = p.fields![hit.index]!.name;
          const text = String(a.text);
          this.values.set(hit.ref, name === "Card number" && /^\d{13,19}$/.test(text) ? text.replace(/(\d{4})(?=\d)/g, "$1 ") : text);
          if (a.submit === true && p.gate && text === p.gate.code) open(p.gate.to);
          return `### Ran Playwright code\n\`\`\`js\nawait page.getByRole('textbox').fill('${text}');\n\`\`\`\n${view()}`;
        },
      },
    });
  }
}
