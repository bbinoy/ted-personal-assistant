import { readFileSync } from "node:fs";
import { startup, type SDKMessage, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { RunTimeout } from "./ceiling.ts";
import { forgetUnresumable, type Resume } from "./chatsession.ts";
import type { Conversation } from "./conversationmodel.ts";
import { userInput } from "./image.ts";
import { NOTES_DIR } from "./notes.ts";
import { approveIn } from "./permissions.ts";
import { buildOptions, consume, underCeiling, type AgentReply, type RunOptions } from "./agentrun.ts";
import { settings } from "./settings.ts";
import { firstWarm, SpareSlot } from "./warmslot.ts";

// --- warm processes for the next message ---
// Starting Claude Code (process, config, skills, connectors) takes ~3s before the model is even asked. After a reply the
// next process is started in the background, so the next message only waits for the model. It is used only if nothing it
// was built from has changed (session, prompt, memory index, a tenant's key and consent), and only while fresh; otherwise a normal start.
// One mechanism (SpareSlot, warmslot.ts), one keyed pool (WarmPool: the key is the conversation's key), one idle setting (WARM_IDLE_MINUTES), one
// switch (WARM): the owner's chat, the group that spoke last and the few tenants most recently active, plus the gate's Haiku spare (gate.ts).
// A process is built from its conversation's own options only (a group's: its notes folder, session, memory server, no connectors; a tenant's: also
// her key, which is in no other conversation's environment) and is handed to nobody else; the owner's has the owner's connectors and is never
// handed to a group or a tenant. Options (system prompt, tools, MCP servers, output schema) are fixed when a process starts, which is why a slot
// is keyed by them.
const idleMs = () => settings.warmIdleMinutes * 60_000;
const slotOptions = { maxAgeMs: idleMs(), idleMs }; // fresh while not idle-expired: a process that died meanwhile is detected on use (firstWarm) and replaced

type Kind = Conversation["kind"];
type Who = Pick<Conversation, "key" | "kind">;

// How many processes of a kind are kept: the owner's one, the latest group's one, the TENANT_WARM_MAX most recently active tenants' (0: none).
// A conversation of a kind that is full replaces the least recently used one of that kind, which is closed.
const capacity = (kind: Kind): number => (kind === "tenant" ? settings.tenantWarmMax : 1);

export class WarmPool {
  readonly #slots = new Map<string, { kind: Kind; slot: SpareSlot<WarmQuery> }>(); // least recently used first
  readonly #o: ConstructorParameters<typeof SpareSlot>[0];

  constructor(o: ConstructorParameters<typeof SpareSlot>[0]) {
    this.#o = o;
  }

  // The conversation's slot; made when `create` (and WARM is on and the kind has room at all). Asking for it makes it the most recently used.
  slot(conv: Who, create: boolean): SpareSlot<WarmQuery> | undefined {
    if (!settings.warm || capacity(conv.kind) <= 0) return undefined;
    let entry = this.#slots.get(conv.key);
    if (entry) this.#slots.delete(conv.key); // re-inserted last: the oldest entries are the ones to close
    else if (create) entry = { kind: conv.kind, slot: new SpareSlot<WarmQuery>(this.#o) };
    if (!entry) return undefined;
    this.#slots.set(conv.key, entry);
    const same = [...this.#slots].filter(([, e]) => e.kind === conv.kind);
    for (const [key, old] of same.slice(0, Math.max(0, same.length - capacity(conv.kind)))) {
      old.slot.drop();
      this.#slots.delete(key);
    }
    return entry.slot;
  }

  // Is there a fresh process for this conversation already? Is a renewal of it worth it (it has one, not idle-expired)?
  has = (conv: Pick<Who, "key">): boolean => this.#slots.get(conv.key)?.slot.has(conv.key) ?? false;
  wants = (conv: Pick<Who, "key">): boolean => this.#slots.get(conv.key)?.slot.wants(conv.key) ?? false;
  // The conversation is still active: its idle period starts over.
  touch = (conv: Pick<Who, "key">): void => this.#slots.get(conv.key)?.slot.touch(conv.key);

  // Close the conversation's process (it was removed or suspended).
  drop(key: string): void {
    this.#slots.get(key)?.slot.drop();
    this.#slots.delete(key);
  }

  holders = (): string[] => [...this.#slots].filter(([, e]) => e.slot.holder).map(([key]) => key); // (tests)
}
export const pool = new WarmPool(slotOptions);

const memoryIndex = (dir: string) => {
  try {
    return readFileSync(`${dir}/MEMORY.md`, "utf8");
  } catch {
    return "";
  }
};
const spareKey = (id: string, o: RunOptions, r: Resume) => JSON.stringify([id, r.resume ?? "", o.systemPrompt, o.memory?.dir ?? "", memoryIndex(o.memory?.dir ?? NOTES_DIR), ...(o.tenant ? [o.tenant.keyTag, o.tenant.consented] : [])]); // a tenant's process is also tied to her key (changed: not reused) and to her consent
const labelOf = (conv: Who) => (conv.kind === "owner" ? "chat" : conv.kind); // (for the log lines)

// Starts the next process for a conversation and keeps it as its spare (replacing, and closing, the previous one).
export function warmUp(conv: Who, o: RunOptions, r: Resume, start: typeof startup = startup, refresh = false): void {
  const slot = pool.slot(conv, true);
  if (!slot) return;
  const key = spareKey(conv.key, o, r);
  // A renewal of a spare that is built from exactly this and stays fresh until the next renewal changes nothing: no new process.
  if (refresh && slot.has(conv.key, key, settings.warmRefreshMinutes * 60_000)) return;
  const warm = start({ options: buildOptions(approveIn(conv.key), o, r.resume) });
  warm.catch((e) => console.error(`${labelOf(conv)} warm-up failed:`, (e as Error).message));
  slot.put(conv.key, key, warm, { refresh });
}

// One turn: on the conversation's warm process when it still fits, else a cold start. A warm process serves one query; one that no
// longer fits is closed. Fall back to a cold start if the warm process is dead or never came up (an idle process can die
// silently): once the turn has produced a message, an error is the turn's error, and running it again could repeat what it did.
export async function runWarmOrCold(conv: Who, o: RunOptions, r: Resume, input: ReturnType<typeof userInput>, cold: (abort: AbortController) => AsyncIterable<SDKMessage>): Promise<AgentReply> {
  const slot = pool.slot(conv, false);
  slot?.touch(conv.key); // in use: the idle period starts over
  const label = labelOf(conv);
  try {
    return await underCeiling(o.source, async (c) => {
      const warm = await slot?.take(conv.key, spareKey(conv.key, o, r))?.catch((e: Error) => console.error(`${label}: warm process unavailable, starting normally:`, e.message));
      // A warm process is stopped through its query: its abort controller was fixed when it started.
      const onWarm = () => {
        const q = warm!.query(input);
        c.signal.addEventListener("abort", () => q.close(), { once: true });
        return q;
      };
      return consume(warm ? firstWarm(onWarm, () => cold(c.controller), (e) => console.error(`${label}: warm process failed, starting normally:`, e.message)) : cold(c.controller), o, r.previousCost);
    });
  } catch (e) {
    if (e instanceof RunTimeout && slot?.holder === conv.key) slot.drop(); // after an abort the conversation gets no spare built meanwhile
    if (o.sessionFile) forgetUnresumable(o.sessionFile, e, o.source);
    throw e;
  }
}
