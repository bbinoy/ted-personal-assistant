import { Limiter } from "./limiter.ts";
import { settings } from "./settings.ts";

// THE gate of model runs: every Claude Code process the assistant starts (a chat turn, a heartbeat look, a dream, a compaction, a small one-shot call) takes a place here, so a restart
// that finds every conversation due, or a night of dreams, cannot start dozens of processes (each with its MCP servers) at once. MAX_CONCURRENT_RUNS places; the order of the line:
//   chat   a turn someone is waiting for (and an urgent compaction inside it): never queues, so a long look or dream can never keep an answer waiting. It still takes a place.
//   helper a small bounded call a run waits on (the approval judge, the participation gate, a language check): never queues either, because the look that is waiting on its judge
//          holds a place itself and would otherwise deadlock when the places are all looks
//   look   a conversation's heartbeat look, then dream / quiet compaction: wait for a free place, the look ahead of the dreams
export const RUN = { chat: { urgent: true }, helper: { urgent: true }, look: { priority: 2 }, dream: { priority: 3 } } as const;
export type RunKind = keyof typeof RUN;

export const runGate = new Limiter(() => settings.maxConcurrentRuns);

// `job` with a place of the given kind. `signal`: called off while still waiting for a place (a look a chat message has overtaken).
export const gated = <T>(kind: RunKind, job: () => Promise<T>, signal?: AbortSignal): Promise<T> => runGate.run(job, { ...RUN[kind], signal });
