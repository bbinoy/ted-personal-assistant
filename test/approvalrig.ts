import * as approvals from "../src/approvals.ts";

// The approvals API with the owner's chat filled in, for the tests that are about one conversation: a question belongs to the conversation
// it was asked in (approvals.ts), so a call that names none is the owner's. Tests about scoping name theirs.
export const OWNER = "owner";
const sourceOf = (scope: string, background?: boolean) => (scope !== OWNER ? "group" : background ? "background" : "chat");

export const request = (send: (text: string) => Promise<number>, description: string, call: { tool: string; input: Record<string, unknown> }, signal?: AbortSignal, o: { scope?: string; background?: boolean; question?: string; typedYes?: boolean } = {}) =>
  approvals.request(send, description, call, signal, { ...o, scope: o.scope ?? OWNER, source: sourceOf(o.scope ?? OWNER, o.background) });
export const answer = (text: string, onJudging: () => void, quote?: { timestamp: number }, deps: approvals.AnswerDeps = {}, ctx: Partial<approvals.Ctx> = {}) => approvals.answer(text, onJudging, quote, deps, { ...ctx, scope: ctx.scope ?? OWNER });
export const answerReaction = (emoji: string, ts: number, scope: string = OWNER, by?: string) => approvals.answerReaction(emoji, ts, scope, by);
