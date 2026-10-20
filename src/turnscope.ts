import type { RunProvenance } from "./autojudge.ts";
import { LIMITS } from "./sanitize.ts";
import { OWNER_KEY } from "./ownerkey.ts";

// What a conversation's turn is known to have been asked, for the approval judge's provenance (autojudge.ts RunProvenance): the person's message that started the
// turn and the two before it (a send is judged against what was said about it, which may have been a message ago: "reply to Armon that Tuesday works" ... "send it"),
// what the assistant last told the owner in chat (so that a plain "yes, send" is read against it; never consent by itself), or, for an unattended turn of the
// conversation (a wake-up), the derived text it was given. One scope per conversation, owned by that conversation's turns: the code that starts a turn says what
// it is (say / derive) and when it ends (end); a run reads it (read) at every call, because a warm process is built before the message that uses it arrives. A run of
// another conversation, or a job, never reads it: it has its own provenance (RunOptions.provenance). The judge's prompt is written from this value in code.
//
// The owner's messages stay across turns (the recent ones are context for a short reply); a group member's or a tenant's message is forgotten when its turn ends, so a later
// wake-up of that conversation never reads an old one as its provenance.

const KEEP = 3;

export class TurnScope {
  readonly key: string;
  readonly member: boolean; // a group or a tenant: not the owner's chat
  #recent: string[] = [];
  #said = "";
  #derived: Extract<RunProvenance, { kind: "derived" }> | undefined;

  constructor(key: string) {
    this.key = key;
    this.member = key !== OWNER_KEY;
  }

  // A person's message starts a turn. `assistantSaid`: for a reaction, the message that was reacted to (what the owner was answering).
  say(text: string, assistantSaid?: string): void {
    this.#derived = undefined;
    this.#recent = [...this.#recent, text].slice(-KEEP);
    if (assistantSaid !== undefined) this.#said = assistantSaid.slice(0, LIMITS.quote);
  }

  // An unattended turn of this conversation: the text a gate or the assistant wrote for it. Not anybody's own words.
  derive(by: "gate" | "assistant", text: string): void {
    this.#derived = { kind: "derived", by, text };
  }

  // What the assistant last told the owner in chat (a draft it showed, a plan it announced).
  assistantSaid(text: string): void {
    this.#said = text.slice(0, LIMITS.quote);
  }

  // The turn is over.
  end(): void {
    this.#derived = undefined;
    if (this.member) this.#recent = [];
  }

  read = (): RunProvenance | undefined => {
    if (this.#derived) return this.#derived;
    const message = this.#recent.at(-1);
    if (message === undefined) return undefined;
    return this.member ? { kind: "member", message } : { kind: "owner", message, earlier: this.#recent.slice(0, -1), assistantSaid: this.#said || undefined };
  };
}

const scopes = new Map<string, TurnScope>();
export const scopeOf = (key: string): TurnScope => scopes.get(key) ?? scopes.set(key, new TurnScope(key)).get(key)!;

// Run `fn` as an unattended turn of the conversation with derived provenance (a wake-up: the gate's task).
export async function derivedTurn<T>(key: string, by: "gate" | "assistant", text: string, fn: () => Promise<T>): Promise<T> {
  const scope = scopeOf(key);
  scope.derive(by, text);
  try {
    return await fn();
  } finally {
    scope.end();
  }
}
