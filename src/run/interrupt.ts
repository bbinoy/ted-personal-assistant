import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// A chat turn that a newer message of its conversation may cut short. A message that arrives while a turn runs waits for the next turn (queue.ts); to make that wait short, the running turn
// is asked to stop at its next SAFE POINT: a tool boundary, where every call it made has returned (so nothing is half done, no approval question is open and no guarded step such as a
// payment or a browse run is in progress: those are calls that have not returned) and the model is about to be asked what to do next. The SDK's interrupt() ends the turn there; the session
// keeps everything done so far, and the message becomes the next turn on the same session, told by one code fact that the turn before was cut short (agent.ts). Probed on the real prompt and
// model: the earlier tool results stay in the history and the model carries on with the message in mind (or stops when it says so). The message itself never enters the interrupted turn, so it
// cannot be lost or answered twice: if the turn ends first, the message simply forms the next turn as it always did. A look is never registered here (its own preempt logic, queue.ts lease).

export const CUT_FACT = "Fact from code: your previous turn in this conversation was interrupted at a step boundary by the message below, which arrived while you were working. What you already did stands and its results are in your history. Carry on with the task taking the message into account, or stop if it says so.";

const SETTLE_MS = 250;
type Interruptible = { interrupt(): Promise<unknown> };

export class TurnWatch {
  readonly #key: string;
  readonly #settleMs: number;
  #timer?: ReturnType<typeof setTimeout>;
  #query?: Interruptible;
  #open = new Set<string>(); // tool calls of the main loop that have not returned (a subagent's own calls are inside one of them)
  #boundary = false; // the last thing seen was a tool result and nothing is open: the model is about to be asked again
  #wanted = false;
  #landed = false;
  constructor(key: string, settleMs = SETTLE_MS) {
    this.#key = key;
    this.#settleMs = settleMs;
  }

  // The turn's Query, once there is one (a cold start or a warm process).
  attach(q: Interruptible): void {
    this.#query = q;
  }

  // Every message of the turn's stream: keeps track of the calls in flight and interrupts at the first safe point after a request.
  see(m: SDKMessage): void {
    if ((m.type !== "assistant" && m.type !== "user") || m.parent_tool_use_id) return;
    const blocks = Array.isArray(m.message.content) ? (m.message.content as { type: string; id?: string; tool_use_id?: string }[]) : [];
    for (const b of blocks) {
      if (b.type === "tool_use" && b.id) this.#open.add(b.id);
      if (b.type === "tool_result" && b.tool_use_id) this.#open.delete(b.tool_use_id);
    }
    this.#boundary = m.type === "user" && this.#open.size === 0;
    this.#check();
  }

  // A newer message wants the turn: stops it now if it is at a safe point, else at the next one.
  ask(): void {
    this.#wanted = true;
    this.#check();
  }

  // Only after a short pause in which nothing new started: the SDK may report the result of one call before the message that names a parallel call has come in.
  #check(): void {
    if (!this.#wanted || this.#landed || !this.#boundary || !this.#query || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#landed || !this.#boundary) return;
      this.#landed = true;
      void this.#query!.interrupt().catch((e: Error) => console.error("run: interrupt failed:", e.message));
    }, this.#settleMs);
  }

  // The turn's result came back as cut short by our interrupt: the conversation's next turn is told.
  get landed(): boolean {
    return this.#landed;
  }
  cut(): void {
    cutShort.add(this.#key);
  }

  end(): void {
    clearTimeout(this.#timer);
    if (live.get(this.#key) === this) live.delete(this.#key);
  }
}

const live = new Map<string, TurnWatch>(); // conversation key to its running chat turn
const cutShort = new Set<string>(); // conversations whose last turn was cut short and whose next turn has not been told yet

export function watchTurn(key: string, settleMs?: number): TurnWatch {
  const w = new TurnWatch(key, settleMs);
  live.set(key, w);
  return w;
}

// A message for this conversation has passed the intake and waits for its turn: ask the running chat turn, if any, to stop at its next safe point.
export const interruptTurn = (key: string): void => live.get(key)?.ask();

// Was the conversation's last turn cut short? Asked once, by the turn that follows.
export const takeCutShort = (key: string): boolean => cutShort.delete(key);
