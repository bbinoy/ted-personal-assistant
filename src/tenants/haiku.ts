import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { gated } from "../core/rungate.ts";
import { failure, isApiRefusal } from "./errors.ts";
import { charge, envFor, observe, succeeded, type Payer } from "./payer.ts";

// The base of every small one-shot model call (triage, notices, the gate, the approval judges, the log summary): Haiku with no tools, no user
// settings and no memory. `tools: []` does NOT stop MCP servers from loading: the owner's claude.ai connectors (109 tools, ~133k tokens)
// came along into every classification, costing $0.16 per cold call instead of $0.0002. Strict MCP mode with no servers keeps the context at
// a few hundred tokens.
export const haikuOptions = (systemPrompt: string, extra: Omit<Options, "model" | "systemPrompt"> = {}): Options => ({
  model: "haiku",
  systemPrompt,
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  mcpServers: {},
  settings: { autoMemoryEnabled: false },
  ...extra,
});

// Resolves to undefined when nothing came in time. Fail closed: the callers read that as "other" / "ask".
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))]);
  } finally {
    clearTimeout(timer); // an answer that comes in time must not leave a 20 s timer behind
  }
}

export interface OneShot {
  system: string;
  prompt: string;
  payer: Payer; // who pays (payer.ts): its environment, its ledger, its cooldown
  schema?: Options["outputFormat"]; // constrained JSON output
  options?: Omit<Options, "model" | "systemPrompt" | "env" | "outputFormat">; // maxTurns, maxBudgetUsd, effort, thinking ...
  model?: string; // default haiku
  timeoutMs?: number; // no answer in time: ok false, timedOut true (and the process is closed)
  run?: typeof query; // tests
  // A warm process to try first (the gate's and the approval judge's spares): it gets the prompt and the cold start to fall back on, and `track` for a query it starts
  // itself, so that oneShot closes it too.
  spare?: (prompt: string, cold: () => Query, track: (q: Query) => Query) => Promise<AsyncIterable<SDKMessage>>;
  onMessage?: (m: SDKMessage) => void; // every message of the stream (the gate's timing)
  gate?: "helper" | "dream"; // its place in the run gate (rungate.ts): a helper (default) is a small call somebody waits on and never queues; a dream waits behind looks
}

export interface OneShotResult {
  ok: boolean; // a success result
  output?: unknown; // its constrained JSON output
  text: string; // its text result
  costUsd?: number;
  apiMs?: number;
  subtype: string;
  timedOut?: boolean;
  error?: Error; // not ok: why (errors.ts failure)
}

// ONE small model call, for every payer: the environment of the payer, the cost recorded to its ledger, the rate-limit reset time observed, the failure classified
// (errors.ts failure: the cooldown noted, the owner told of a refused instance key), the cooldown cleared on success, and the process closed.
// Throws only an answer of the API that says "not now" (AuthError, RateLimitError, InstanceKeyError); any other failure is `ok: false`.
export async function oneShot(o: OneShot): Promise<OneShotResult> {
  const started: Query[] = [];
  const track = (q: Query): Query => (started.push(q), q);
  const options: Options = {
    ...haikuOptions(o.system, { ...o.options, ...(o.schema ? { outputFormat: o.schema } : {}), ...(o.payer.kind === "instance" ? { env: envFor(o.payer, { ...process.env }) } : {}) }),
    ...(o.model ? { model: o.model } : {}),
  };
  const cold = () => track((o.run ?? query)({ prompt: o.prompt, options }));
  async function read(): Promise<OneShotResult> {
    let lastError: string | undefined; // the SDK reports a refused call (usage limit, expired login, refused key) as an assistant error code, even when the result says "success"
    // Not `for await ... break`: leaving that loop waits ~0.8 s for the process to wind down, on the critical path.
    const it = (o.spare ? await o.spare(o.prompt, cold, track) : cold())[Symbol.asyncIterator]();
    for (let n = await it.next(); !n.done; n = await it.next()) {
      const m = n.value;
      observe(o.payer, m);
      o.onMessage?.(m);
      if (m.type === "assistant" && m.error) lastError = m.error;
      if (m.type !== "result") continue;
      charge(o.payer, m.total_cost_usd, o.gate ?? "helper");
      const refused = failure(lastError, m.subtype, o.payer);
      if (isApiRefusal(refused)) throw refused;
      const ok = m.subtype === "success" && !m.is_error;
      if (ok && !lastError) succeeded(o.payer);
      return { ok, output: ok ? m.structured_output : undefined, text: ok ? m.result : "", costUsd: m.total_cost_usd, apiMs: m.duration_api_ms, subtype: m.subtype, ...(ok ? {} : { error: refused }) };
    }
    return { ok: false, text: "", subtype: "no_result", error: new Error("no result") };
  }
  try {
    return await gated(o.gate ?? "helper", async () => {
      if (!o.timeoutMs) return read();
      return (await withTimeout(read(), o.timeoutMs)) ?? { ok: false, text: "", subtype: "timeout", timedOut: true, error: new Error("timed out") };
    });
  } finally {
    for (const q of started) (q as { close?: () => void }).close?.(); // the answer is in, it failed, or it timed out
  }
}
