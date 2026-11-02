import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// A chat turn that a newer message of its conversation may cut short. A message that arrives while a turn runs waits for the next turn (queue.ts); to make that wait short, the running turn
// is asked to stop at its next SAFE POINT: the moment the model asks to run its next tool. That call is denied (it has not executed) with our own wording, and so is every call after it, which ends the turn with a closing text that is dropped. The SDK's `interrupt` flag is not used:
// the CLI then discards our message and writes "the user doesn't want to proceed" into the history, which the next turn read as the person declining. Until then nothing is touched: a model that is writing its final answer is not cut, the answer is delivered and the message is the next turn as it always was. The cut is made
// only when no other call is in flight (so no approval question, payment or browse step is open: those are calls that have not returned) and only for the main loop's own calls.
// The session keeps everything done so far, and the message becomes the next turn on it, told by one code fact that the turn before was cut short (agent.ts). The message itself never
// enters the running turn, so it cannot be lost or answered twice. A turn is cut at most once, and a turn that began because of a cut is not cut again, so a stream of messages
// cannot keep a task from ever finishing. A look is never registered here (its own preempt logic, queue.ts lease).

export const CUT_FACT = "Fact from code: your previous turn in this conversation was interrupted at a step boundary by the message below, which arrived while you were working. What you already did stands and its results are in your history. Carry on with the task taking the message into account, or stop if it says so.";
export const CUT_DENIED = "Not run, and not declined: a new message from the person arrived while you were working and your session continues with it next. Call nothing else and write no reply now. If this call still fits after you read the new message, make it again.";

const SETTLE_MS = 250;

type Block = { type: string; id?: string; tool_use_id?: string; text?: string };

export class TurnWatch {
  readonly #key: string;
  readonly #settleMs: number;
  readonly #canCut: boolean;
  #open = new Set<string>(); // tool calls of the main loop that have not returned (a subagent's own calls are inside one of them)
  #asker?: number;
  #decided = false; // we denied a call to cut the turn: from then on every call is denied

  constructor(key: string, canCut = true, settleMs = SETTLE_MS) {
    this.#key = key;
    this.#canCut = canCut;
    this.#settleMs = settleMs;
  }

  // Every message of the turn's stream: which calls are in flight.
  see(m: SDKMessage): void {
    if ((m.type !== "assistant" && m.type !== "user") || m.parent_tool_use_id) return;
    const blocks = Array.isArray(m.message.content) ? (m.message.content as Block[]) : [];
    for (const b of blocks) {
      if (b.type === "tool_use" && b.id) this.#open.add(b.id);
      if (b.type === "tool_result" && b.tool_use_id) this.#open.delete(b.tool_use_id);
    }
  }

  // A newer message (stamped `ts`) wants the turn: it is cut at the next tool call the model asks for.
  ask(ts: number): void {
    if (this.#canCut) this.#asker ??= ts;
  }

  // The message that asked is gone before the cut was made (deleted or replaced): nobody is waiting for it any more.
  withdraw(stamps: readonly number[]): void {
    if (!this.#decided && this.#asker !== undefined && stamps.includes(this.#asker)) this.#asker = undefined;
  }

  // The model asks to run a tool: should the turn be cut here instead? (canUseTool, agentrun.ts)
  async cutAt(toolUseID: string, agentID?: string): Promise<boolean> {
    if (agentID) return false;
    if (this.#decided) return true; // the turn is being cut: the model is closing it, whatever it asks for is not run
    if (this.#asker === undefined) return false;
    await new Promise<void>((r) => setTimeout(r, this.#settleMs)); // a parallel call named in the same step has come into the stream by now
    if ([...this.#open].some((id) => id !== toolUseID)) return false; // another call is in flight: let this one run, the next call is the cut
    this.#decided = true;
    return true;
  }

  // We denied a call to cut this turn: its result, however it ends, is the cut.
  get landed(): boolean {
    return this.#decided;
  }
  cut(): void {
    cutShort.set(this.#key, this.#asker!);
  }

  end(): void {
    if (live.get(this.#key) === this) live.delete(this.#key);
  }
}

const live = new Map<string, TurnWatch>(); // conversation key to its running chat turn
const cutShort = new Map<string, number>(); // conversations whose last turn was cut short, with the stamp of the message that did it; the next turn has not been told yet

// `canCut` false: a turn that began because of a cut is not cut again.
export function watchTurn(key: string, canCut = true, settleMs?: number): TurnWatch {
  const w = new TurnWatch(key, canCut, settleMs);
  live.set(key, w);
  return w;
}

// A message (stamp `ts`) for this conversation has passed the intake and will be answered: ask the running chat turn, if any, to stop at its next tool call.
export const interruptTurn = (key: string, ts: number): void => live.get(key)?.ask(ts);

// Was the conversation's last turn cut short? Asked once, by the turn that follows.
export const takeCutShort = (key: string): boolean => cutShort.delete(key);

// The message that cut the turn is gone (deleted or replaced before its turn), or the next turn has no real message: nothing is told.
export const forgetCutShort = (key: string, stamps?: readonly number[]): void => {
  if (stamps) live.get(key)?.withdraw(stamps);
  const ts = cutShort.get(key);
  if (ts !== undefined && (!stamps || stamps.includes(ts))) cutShort.delete(key);
};

// canUseTool, for the conversation's running chat turn if it has one: should this call be cut instead of run?
export const cutBefore = (key: string, toolUseID: string, agentID?: string): Promise<boolean> => live.get(key)?.cutAt(toolUseID, agentID) ?? Promise.resolve(false);
