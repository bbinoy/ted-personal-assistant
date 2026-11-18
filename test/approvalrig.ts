import * as approvals from "../src/approvals/approvals.ts";

// The approvals API with the owner's chat filled in, for the tests that are about one conversation: a question belongs to the conversation
// it was asked in (approvals.ts), so a call that names none is the owner's. Tests about scoping name theirs.
export const OWNER = "owner";
const sourceOf = (scope: string) => (scope !== OWNER ? "group" : "chat");

export const request = (send: (text: string) => Promise<number>, description: string, call: { tool: string; input: Record<string, unknown> }, signal?: AbortSignal, o: { scope?: string; question?: string; typedYes?: boolean } = {}) =>
  approvals.request(send, description, call, signal, { ...o, scope: o.scope ?? OWNER, source: sourceOf(o.scope ?? OWNER) });
export const answer = (text: string, onJudging: () => void, quote?: { timestamp: number }, deps: approvals.AnswerDeps = {}, ctx: Partial<approvals.Ctx> = {}) => approvals.answer(text, onJudging, quote, { latest: () => undefined, ...deps }, { ...ctx, scope: ctx.scope ?? OWNER }); // (the tests' fake timestamps are no part of the chat log: nothing is "later" unless a test says so)
export const answerReaction = (emoji: string, ts: number, scope: string = OWNER, by?: string) => approvals.answerReaction(emoji, ts, scope, by);
